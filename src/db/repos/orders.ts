/**
 * Репозиторий заказов/поставок (§9, §10, §11, §18 ТЗ).
 *
 * Жизненный цикл: draft → approved → preparing → in_transit → partial → completed; cancel.
 *  - Утверждение создаёт НЕИЗМЕНЯЕМЫЙ снимок (snapshot): цены, ступени, кратности, курсы, СДП,
 *    остатки, учтённые поставки. Последующие изменения живой поставки не перезаписывают снимок.
 *  - После оформления заказ учитывается как ожидаемое поступление РОВНО ОДИН РАЗ (статусы не дублируют).
 *  - Поступление отмечается ТОЛЬКО целиком по филиалу; полученная часть блокируется для правки.
 *  - Qобщ = QВЛК + QМСК; при изменении одного филиала второй пересчитывается; некратность — ошибка подтверждения.
 */
import { db } from '../database';
import type { PurchaseOrderRow, OrderLineRow, BranchAllocationRow, ProductRow } from '../schema';
import { newId, nowISO, writeAudit, localTodayISO } from '../util';
import {
  BRANCHES, calcLine, convertTotals, decimalCmp, decFromString, decAdd, decToString, computeOrderDates,
  type ApprovedSnapshot, type Branch, type Currency, type ExchangeRates, type Product,
} from '../../core/types';

export interface CreateDraftInput {
  brandId: string;
  issueDate?: string; // по умолчанию сегодня
  exitDate?: string;
  vlkDate?: string;
  mskDate?: string;
  currency: Currency;
  number?: string;
}

const toCoreProduct = (row: ProductRow): Product => ({ ...row });

export const ordersRepo = {
  async createDraft(inp: CreateDraftInput, actor = 'оператор'): Promise<PurchaseOrderRow> {
    const brand = await db.brands.get(inp.brandId);
    if (!brand) throw new Error('Бренд не найден');
    if (brand.archived) throw new Error('Нельзя создавать заказ по архивному бренду');
    const settings = await db.brandSettings.get(inp.brandId);
    const lt = settings?.leadTimes ?? { prepDays: 30, toVLKDays: 60, vlkToMSKDays: 20 };
    const issueDate = inp.issueDate ?? localTodayISO();
    const dates = computeOrderDates(issueDate, lt, {
      exitDate: inp.exitDate, vlkDate: inp.vlkDate, mskDate: inp.mskDate,
    });
    const number = inp.number ?? `З-${issueDate.replaceAll('-', '')}-${newId().slice(0, 4)}`;
    const row: PurchaseOrderRow = {
      id: newId('ord'), brandId: inp.brandId, number, status: 'draft',
      issueDate, exitDate: dates.exitDate, vlkDate: dates.vlkDate, mskDate: dates.mskDate,
      leadTimesOverride: null, currency: inp.currency, ratesAtApproval: null,
      lines: [], allocations: {}, snapshot: null, actualExitConfirmedAt: null,
      copiedFromOrderId: null, createdAt: nowISO(), updatedAt: nowISO(), updatedBy: actor,
    };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.add(row);
      await writeAudit(db, { brandId: inp.brandId, entity: 'order', entityId: row.id, action: 'create', details: `Создан черновик заказа ${number}`, after: row });
    });
    return row;
  },

  async get(id: string): Promise<PurchaseOrderRow | undefined> {
    return db.orders.get(id);
  },

  async listByBrand(brandId: string): Promise<PurchaseOrderRow[]> {
    const rows = await db.orders.where('brandId').equals(brandId).toArray();
    return rows.sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1));
  },

  /** Все заказы бренда в статусах «ожидается поступление» (учёт ровно один раз, §9). */
  async expectedArrivals(brandId: string): Promise<PurchaseOrderRow[]> {
    const rows = await db.orders.where('brandId').equals(brandId).toArray();
    return rows.filter((o) => ['approved', 'preparing', 'in_transit', 'partial'].includes(o.status));
  },

  async updateDates(id: string, patch: Partial<{ issueDate: string; exitDate: string; vlkDate: string; mskDate: string }>, actor = 'оператор'): Promise<PurchaseOrderRow> {
    const before = await this.mustGet(id);
    if (before.snapshot && before.status !== 'draft') {
      // изменение дат утверждённой/живой поставки — отдельная записываемая корректировка (§10, §18)
if (before.status === 'completed' || before.status === 'cancelled') {
  throw new Error('Дата закрытой/отменённой поставки менять нельзя — создайте корректировку новым документом');
}
    }
    const after: PurchaseOrderRow = { ...before, ...patch, updatedAt: nowISO(), updatedBy: actor };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.put(after);
      await writeAudit(db, { brandId: before.brandId, entity: 'shipment', entityId: id, action: 'correct-dates', details: `Изменены даты заказа ${before.number}: ${JSON.stringify(patch)}`, before: { issueDate: before.issueDate, exitDate: before.exitDate, vlkDate: before.vlkDate, mskDate: before.mskDate }, after: { issueDate: after.issueDate, exitDate: after.exitDate, vlkDate: after.vlkDate, mskDate: after.mskDate } });
    });
    return after;
  },

  /**
   * Установка/изменение позиции и распределения (ручной ввод QВЛК/QМСК в единицах товара).
   * Черновик — свободно. Утверждённый заказ (approved/preparing) — свободное редактирование
   * живой копии (снимок-эталон в snapshot остаётся неизменным, изменения пишутся в аудит, §5/§18).
   * Отправленная поставка (in_transit/partial/completed) правится ТОЛЬКО через корректировки:
   * reallocate с причиной или correctQuantity с причиной (§10).
   */
  async setLine(
    orderId: string, productId: string,
    qtyVLK: number, qtyMSK: number, actor = 'оператор',
  ): Promise<PurchaseOrderRow> {
    const order = await this.mustGet(orderId);
    if (['in_transit', 'partial', 'completed'].includes(order.status)) {
      throw new Error('Отправленная поставка неизменяема напрямую. Используйте корректировку (reallocate / correctQuantity с причиной).');
    }
    return this.setLineImpl(orderId, productId, qtyVLK, qtyMSK, actor);
  },

  /** Контролируемая корректировка количества отправленной поставки (причина обязательна, §10). */
  async correctQuantity(orderId: string, productId: string, qtyVLK: number, qtyMSK: number, reason: string, actor = 'оператор'): Promise<PurchaseOrderRow> {
    if (!reason.trim()) throw new Error('Причина корректировки количества обязательна (аудит)');
    const order = await this.mustGet(orderId);
    if (!['in_transit', 'partial'].includes(order.status)) {
      throw new Error('Корректировка с причиной предназначена для отправленных поставок; для черновика/подготовки используйте обычное редактирование');
    }
    return this.setLineImpl(orderId, productId, qtyVLK, qtyMSK, actor, reason);
  },

  async setLineImpl(orderId: string, productId: string, qtyVLK: number, qtyMSK: number, actor: string, correctionReason?: string): Promise<PurchaseOrderRow> {
    const order = await this.mustGet(orderId);
    if (order.status === 'completed' || order.status === 'cancelled') throw new Error('Закрытый/отменённый заказ редактировать нельзя');
    if (qtyVLK < 0 || qtyMSK < 0) throw new Error('Количество не может быть отрицательным');
    const prod = await db.products.get(productId);
    if (!prod) throw new Error('Товар не найден');
    if (prod.brandId !== order.brandId) throw new Error('Товар принадлежит другому бренду (изоляция данных)');

    // Защита полученной филиальной части — при ЛЮБОМ изменении, включая документируемые
    // корректировки (§10): «после подтверждения поступления филиала его полученная часть
    // заблокирована для обычного редактирования». Если перенос количества между филиалами
    // невозможен без изменения уже полученного — требуется отдельная документируемая
    // корректировка новым документом; здесь мы такую попытку отсекаем.
    const prevAlloc = order.allocations[productId];
    if (prevAlloc) {
      for (const br of BRANCHES) {
        if (prevAlloc[br].received && prevAlloc[br].qty !== (br === 'VLK' ? qtyVLK : qtyMSK)) {
          throw new Error(`Часть ${br} уже получена (${prevAlloc[br].qty}) — изменение полученной части невозможно даже корректировкой; оформьте отдельный корректирующий документ`);
        }
      }
    }

    const calc = calcLine(toCoreProduct(prod), qtyVLK, qtyMSK);
    const line: OrderLineRow = {
      productId, barcode: prod.barcode, name: prod.name,
      qtyVLK, qtyMSK, packSize: prod.packSize,
      unitPrice: calc.pricePerUnit ?? '0',
      priceTierUsed: calc.tier, currency: prod.currency,
    };
    const lines = [...order.lines.filter((l) => l.productId !== productId), line];
    const allocations: Record<string, Record<Branch, BranchAllocationRow>> = {
      ...order.allocations,
      [productId]: {
        VLK: { ...(prevAlloc?.VLK ?? { qty: 0, received: false, actualArrivalDate: null, expectedArrivalDate: null }), qty: qtyVLK },
        MSK: { ...(prevAlloc?.MSK ?? { qty: 0, received: false, actualArrivalDate: null, expectedArrivalDate: null }), qty: qtyMSK },
      },
    };
    const after = { ...order, lines, allocations, updatedAt: nowISO(), updatedBy: actor };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.put(after);
      await writeAudit(db, { brandId: order.brandId, entity: 'order', entityId: orderId, action: correctionReason ? 'correct-qty' : 'set-line', details: `${correctionReason ? `КОРРЕКТИРОВКА (${correctionReason}): ` : ''}Позиция ${prod.barcode}: ВЛК=${qtyVLK}, МСК=${qtyMSK}${calc.priceError ? `; ОШИБКА ЦЕНЫ: ${calc.priceError}` : ''}`, before: order, after });
    });
    return after;
  },

  async removeLine(orderId: string, productId: string, actor = 'оператор'): Promise<PurchaseOrderRow> {
    const order = await this.mustGet(orderId);
    if (order.snapshot) throw new Error('Утверждённый заказ неизменяем — требуется корректировка');
    const alloc = order.allocations[productId];
    if (alloc && (alloc.VLK.received || alloc.MSK.received)) throw new Error('Нельзя удалить позицию с уже полученной частью филиала');
    const after: PurchaseOrderRow = {
      ...order,
      lines: order.lines.filter((l) => l.productId !== productId),
      allocations: Object.fromEntries(Object.entries(order.allocations).filter(([pid]) => pid !== productId)),
      updatedAt: nowISO(), updatedBy: actor,
    };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.put(after);
      await writeAudit(db, { brandId: order.brandId, entity: 'order', entityId: orderId, action: 'remove-line', details: `Удалена позиция ${productId}`, before: order, after });
    });
    return after;
  },

  /** Перераспределение между филиалами без изменения Qобщ (§10). Полученные части не трогаем. */
  async reallocate(orderId: string, productId: string, newQtyVLK: number, reason: string, actor = 'оператор'): Promise<PurchaseOrderRow> {
    if (!reason.trim()) throw new Error('Причина перераспределения обязательна (аудит)');
    const order = await this.mustGet(orderId);
    if (!['in_transit', 'partial'].includes(order.status)) {
      throw new Error('Перераспределение с причиной предназначено для отправленных поставок; для черновика/подготовки используйте обычное редактирование');
    }
    const line = order.lines.find((l) => l.productId === productId);
    if (!line) throw new Error('Позиция не найдена');
    const total = line.qtyVLK + line.qtyMSK;
    if (newQtyVLK < 0 || newQtyVLK > total) throw new Error('Перераспределение не должно давать отрицательное количество и превышать общее');
    const alloc = order.allocations[productId];
    if (alloc?.VLK.received && newQtyVLK !== alloc.VLK.qty) throw new Error('Часть ВЛК получена — перенос невозможен без корректировки');
    if (alloc?.MSK.received && total - newQtyVLK !== alloc.MSK.qty) throw new Error('Часть МСК получена — перенос невозможен без корректировки');
    return this.setLineImpl(orderId, productId, newQtyVLK, total - newQtyVLK, actor, `перераспределение: ${reason}`);
  },

  /**
   * Утверждение заказа (§18): проверяет валидность (кратность, цены, ступени), создаёт снимок,
   * фиксирует курсы. Блокируется при любой ошибке позиций.
   */
  async approve(orderId: string, rates: ExchangeRates, adsMap: ApprovedSnapshot['ads'], stockMap: ApprovedSnapshot['stock'], expectedShipments: ApprovedSnapshot['expectedShipments'], actor = 'оператор'): Promise<PurchaseOrderRow> {
    const order = await this.mustGet(orderId);
    if (order.status !== 'draft') throw new Error(`Утверждать можно только черновик (сейчас: ${order.status})`);
    if (!order.lines.length) throw new Error('Заказ пуст — добавьте позиции');
    if (decimalCmp(rates.usdRub, '0') <= 0 || decimalCmp(rates.krwRub, '0') <= 0) throw new Error('Курсы валют должны быть > 0');

    const errors: string[] = [];
    const snapLines: ApprovedSnapshot['lines'] = [];
    let primaryAcc = decFromString('0');
    for (const l of order.lines) {
      const prod = await db.products.get(l.productId);
      if (!prod) { errors.push(`Товар ${l.barcode} не найден`); continue; }
      const calc = calcLine(toCoreProduct(prod), l.qtyVLK, l.qtyMSK);
      if (!calc.packOk) errors.push(`${l.barcode}: количества не кратны коробке (${prod.packSize})`);
      if (calc.priceError) errors.push(`${l.barcode}: ${calc.priceError}`);
      if (prod.currency !== order.currency) errors.push(`${l.barcode}: валюта товара ${prod.currency} ≠ валюта заказа ${order.currency}`);
      primaryAcc = decAdd(primaryAcc, decFromString(calc.sumTotal));
      snapLines.push({
        productId: l.productId, barcode: l.barcode, article: prod.article, name: l.name,
        qtyVLK: l.qtyVLK, qtyMSK: l.qtyMSK, boxesVLK: calc.boxesVLK, boxesMSK: calc.boxesMSK,
        packSize: l.packSize, unitPrice: calc.pricePerUnit ?? '0', priceMode: prod.priceMode,
        tiers: prod.tiers, lineTotal: calc.sumTotal,
      });
    }
    if (errors.length) throw new Error('Утверждение заблокировано: ' + errors.join(' | '));

    const totals = convertTotals(decToString(primaryAcc), order.currency, rates);
    const snapshot: ApprovedSnapshot = {
      takenAt: nowISO(), brandId: order.brandId, issueDate: order.issueDate,
      exitDate: order.exitDate, vlkDate: order.vlkDate, mskDate: order.mskDate,
      leadTimes: (await db.brandSettings.get(order.brandId))?.leadTimes ?? { prepDays: 30, toVLKDays: 60, vlkToMSKDays: 20 },
      currency: order.currency, rates: { ...rates }, lines: snapLines,
      ads: adsMap, stock: stockMap, expectedShipments, totals,
    };
    const after: PurchaseOrderRow = { ...order, status: 'approved', ratesAtApproval: { ...rates }, snapshot, updatedAt: nowISO(), updatedBy: actor };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.put(after);
      await writeAudit(db, { brandId: order.brandId, entity: 'order', entityId: orderId, action: 'approve', details: `Заказ ${order.number} утверждён. Сумма ${totals.primary} ${order.currency} (${totals.rub} RUB)`, after: snapshot });
    });
    return after;
  },

  /** Черновик → на подготовке (или сразу из approved). */
  async setStatusPreparing(orderId: string, actor = 'оператор'): Promise<PurchaseOrderRow> {
    return this.transition(orderId, ['approved'], 'preparing', 'Заказ передан на подготовку', actor);
  },

  /** Подтверждение выхода из Кореи → «в пути» (смена статуса/связи, НЕ второе поступление, §9). */
  async confirmExit(orderId: string, actualExitDate: string, actor = 'оператор'): Promise<PurchaseOrderRow> {
    const order = await this.mustGet(orderId);
    if (!['approved', 'preparing'].includes(order.status)) throw new Error(`Подтвердить выход можно из статусов approved/preparing (сейчас ${order.status})`);
    const after: PurchaseOrderRow = { ...order, status: 'in_transit', actualExitConfirmedAt: nowISO(), exitDate: actualExitDate, updatedAt: nowISO(), updatedBy: actor };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.put(after);
      await writeAudit(db, { brandId: order.brandId, entity: 'shipment', entityId: orderId, action: 'confirm-exit', details: `Подтверждён выход из Кореи ${actualExitDate}; заказ ${order.number} → в пути`, before: order, after });
    });
    return after;
  },

  /**
   * Отметка поступления ТОЛЬКО целиком по филиалу (§11). Сохраняется фактическая дата;
   * филиальная часть исключается из ожидаемых; ФАКТИЧЕСКИЕ ОСТАТКИ НЕ УВЕЛИЧИВАЮТСЯ.
   */
  async markBranchReceived(orderId: string, branch: Branch, actualDate: string, actor = 'оператор'): Promise<PurchaseOrderRow> {
    const order = await this.mustGet(orderId);
    if (!['in_transit', 'partial'].includes(order.status)) throw new Error(`Поступление отмечается для поставок в пути/частично поступивших (сейчас ${order.status})`);
    const allocs = order.allocations;
    for (const l of order.lines) {
      const a = allocs[l.productId]?.[branch];
      if (!a) continue;
      if (a.received) throw new Error(`Филиал ${branch} уже отмечен поступившим по SKU ${l.barcode} — двойное поступление невозможно`);
    }
    const newAllocs: Record<string, Record<Branch, BranchAllocationRow>> = {};
    for (const [pid, pair] of Object.entries(allocs)) {
      newAllocs[pid] = {
        VLK: branch === 'VLK' ? { ...pair.VLK, received: true, actualArrivalDate: actualDate } : pair.VLK,
        MSK: branch === 'MSK' ? { ...pair.MSK, received: true, actualArrivalDate: actualDate } : pair.MSK,
      };
    }
    const other: Branch = branch === 'VLK' ? 'MSK' : 'VLK';
    const otherHasPending = order.lines.some((l) => {
      const a = newAllocs[l.productId]?.[other];
      return a && a.qty > 0 && !a.received;
    });
    const allReceived = order.lines.every((l) => newAllocs[l.productId]?.VLK.received && newAllocs[l.productId]?.MSK.received);
    const status = allReceived ? 'completed' : otherHasPending ? 'partial' : 'completed';
    const after: PurchaseOrderRow = { ...order, allocations: newAllocs, status, updatedAt: nowISO(), updatedBy: actor };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.put(after);
      await writeAudit(db, { brandId: order.brandId, entity: 'shipment', entityId: orderId, action: 'receive-branch', details: `Отмечено поступление ${branch} от ${actualDate} (заказ ${order.number}); статус → ${status}. Фактические остатки НЕ изменялись — ожидается обновление из 1С`, before: order, after });
    });
    return after;
  },

  /** Отмена контролируемой операцией с сохранением истории (§9). */
  async cancel(orderId: string, reason: string, actor = 'оператор'): Promise<PurchaseOrderRow> {
    if (!reason.trim()) throw new Error('Причина отмены обязательна');
    const order = await this.mustGet(orderId);
    if (order.status === 'completed') throw new Error('Завершённую поставку отменить нельзя — используйте корректировку');
    const anyReceived = Object.values(order.allocations).some((p) => p.VLK.received || p.MSK.received);
    if (anyReceived) throw new Error('Есть полученные филиальные части — отмена невозможна, требуется корректировка');
    const after: PurchaseOrderRow = { ...order, status: 'cancelled', updatedAt: nowISO(), updatedBy: actor };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.put(after);
      await writeAudit(db, { brandId: order.brandId, entity: 'order', entityId: orderId, action: 'cancel', details: `Заказ ${order.number} отменён: ${reason}`, before: order });
    });
    return after;
  },

  /** Новый черновик копированием предыдущего заказа (§18). */
  async copyAsDraft(orderId: string, actor = 'оператор'): Promise<PurchaseOrderRow> {
    const src = await this.mustGet(orderId);
    const copy = await this.createDraft({ brandId: src.brandId, currency: src.currency }, actor);
    let result = copy;
    for (const l of src.lines) {
      const prod = await db.products.get(l.productId);
      if (!prod || prod.archived) continue; // архивные не копируем автоматически
      result = await this.setLineImpl(result.id, l.productId, l.qtyVLK, l.qtyMSK, actor);
    }
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.update(result.id, { copiedFromOrderId: src.id });
      await writeAudit(db, { brandId: src.brandId, entity: 'order', entityId: result.id, action: 'copy', details: `Черновик создан копированием заказа ${src.number}`, before: src });
    });
    return (await this.mustGet(result.id));
  },

  /** Итоги заказа по текущим ценам (для предпросмотра до утверждения). */
  async computeTotals(orderId: string, rates: ExchangeRates): Promise<{ totals: ReturnType<typeof convertTotals>; errors: string[] }> {
    const order = await this.mustGet(orderId);
    const errors: string[] = [];
    let acc = decFromString('0');
    for (const l of order.lines) {
      const prod = await db.products.get(l.productId);
      if (!prod) { errors.push(`Товар ${l.barcode} не найден`); continue; }
      const calc = calcLine(toCoreProduct(prod), l.qtyVLK, l.qtyMSK);
      if (calc.priceError) errors.push(`${l.barcode}: ${calc.priceError}`);
      else acc = decAdd(acc, decFromString(calc.sumTotal));
    }
    return { totals: convertTotals(decToString(acc), order.currency, rates), errors };
  },

  async mustGet(id: string): Promise<PurchaseOrderRow> {
    const o = await db.orders.get(id);
    if (!o) throw new Error('Заказ не найден');
    return o;
  },

  async transition(orderId: string, from: string[], to: PurchaseOrderRow['status'], details: string, actor: string): Promise<PurchaseOrderRow> {
    const order = await this.mustGet(orderId);
    if (!from.includes(order.status)) throw new Error(`Недопустимый переход ${order.status} → ${to}`);
    const after = { ...order, status: to, updatedAt: nowISO(), updatedBy: actor };
    await db.transaction('rw', db.orders, db.audit, async () => {
      await db.orders.put(after);
      await writeAudit(db, { brandId: order.brandId, entity: 'order', entityId: orderId, action: `status:${to}`, details, before: order, after });
    });
    return after;
  },
};


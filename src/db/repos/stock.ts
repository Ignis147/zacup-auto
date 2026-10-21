/**
 * Репозиторий фактических остатков из 1С (§7, §11 ТЗ).
 *
 *  - История снимков хранится полностью; текущий = последний по asOf.
 *  - Система НИКОГДА не прибавляет поступления к фактическому остатку автоматически.
 *  - Новый снимок должен быть датирован НЕ РАНЬШЕ последнего подтверждённого поступления филиала —
 *    иначе приход «потеряется»; это проверяется при записи и через статус актуальности.
 */
import { db } from '../database';
import type { StockRow } from '../schema';
import { newId, nowISO, writeAudit } from '../util';
import { toDateOnly, BRANCHES, type Branch } from '../../core/types';

export const stockRepo = {
  /** Загрузка нового снимка остатка (вручную или вставкой из Excel/1С). */
  async setSnapshot(
    productId: string, brandId: string, branch: Branch, qty: number, asOf: string,
    source: StockRow['source'] = 'manual', actor = 'оператор',
  ): Promise<StockRow> {
    if (!Number.isFinite(qty) || qty < 0) throw new Error('Остаток не может быть отрицательным');
    if (Number.isNaN(toDateOnly(asOf).getTime())) throw new Error(`Некорректная дата снимка: ${asOf}`);
    // §11: снимок не может быть датирован раньше последнего подтверждённого поступления
    const lastReceived = await lastConfirmedArrivalDate(productId, branch);
    if (lastReceived && toDateOnly(asOf).getTime() < toDateOnly(lastReceived).getTime()) {
      throw new Error(`Дата снимка (${asOf}) раньше подтверждённого поступления (${lastReceived}) — приход будет потерян. Укажите дату не раньше поступления.`);
    }
    const row: StockRow = {
      id: newId('stk'), productId, brandId, branch, qty, asOf, source,
      createdAt: nowISO(), createdBy: actor,
    };
    const prev = await lastSnapshot(productId, branch);
    await db.transaction('rw', db.stock, db.audit, async () => {
      await db.stock.add(row);
      await writeAudit(db, { brandId, entity: 'stock', entityId: `${productId}|${branch}`, action: 'snapshot', details: `Снимок остатка ${branch}: ${prev?.qty ?? '∅'} → ${qty} (от ${asOf}, ${source})`, before: prev, after: row });
    });
    return row;
  },

  /** Текущий (последний по дате актуальности) остаток товара по филиалу. */
  async getCurrent(productId: string, branch: Branch): Promise<StockRow | undefined> {
    return lastSnapshot(productId, branch);
  },

  /** Вся история снимков товара/филиала. */
  async history(productId: string, branch: Branch): Promise<StockRow[]> {
    const rows = await db.stock.where('productId').equals(productId).toArray();
    return rows.filter((r) => r.branch === branch).sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
  },

  /** Текущие остатки всех товаров бренда по обоим филиалам (для рабочего экрана). */
  async currentForBrand(brandId: string): Promise<Map<string, Record<Branch, StockRow | undefined>>> {
    const rows = await db.stock.where('brandId').equals(brandId).toArray();
    const latest = new Map<string, { VLK?: StockRow; MSK?: StockRow }>();
    for (const r of rows) {
      const cur = latest.get(r.productId) ?? {};
      const key = r.branch;
      if (!cur[key] || cur[key]!.asOf <= r.asOf) cur[key] = r;
      latest.set(r.productId, cur);
    }
    return latest as Map<string, Record<Branch, StockRow | undefined>>;
  },
};

/** Последняя запись снимка по товару/филиалу (по дате актуальности asOf). */
async function lastSnapshot(productId: string, branch: Branch): Promise<StockRow | undefined> {
  const rows = await db.stock.where('productId').equals(productId).toArray();
  const forBranch = rows.filter((r) => r.branch === branch);
  if (!forBranch.length) return undefined;
  return forBranch.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0))[forBranch.length - 1];
}

/** Последняя подтверждённая фактическая дата прибытия по SKU/филиалу (из заказов). */
async function lastConfirmedArrivalDate(productId: string, branch: Branch): Promise<string | null> {
  const orders = await db.orders.toArray();
  let best: string | null = null;
  for (const o of orders) {
    const alloc = o.allocations[productId]?.[branch];
    if (alloc?.received && alloc.actualArrivalDate) {
      if (!best || alloc.actualArrivalDate > best) best = alloc.actualArrivalDate;
    }
  }
  return best;
}

/**
 * Статус актуальности остатков филиала (§11): если есть подтверждённое поступление позже даты
 * снимка — остатки из 1С ещё не отражают приход → прогноз неактуален, утверждение заказа блокируется.
 */
export async function isStockStale(productId: string, branch: Branch): Promise<{ stale: boolean; arrivalAfterSnapshot: string | null }> {
  const snap = await stockRepo.getCurrent(productId, branch);
  const arr = await lastConfirmedArrivalDate(productId, branch);
  if (!arr) return { stale: false, arrivalAfterSnapshot: null };
  if (!snap) return { stale: true, arrivalAfterSnapshot: arr };
  return { stale: snap.asOf.slice(0, 10) < arr, arrivalAfterSnapshot: arr };
}

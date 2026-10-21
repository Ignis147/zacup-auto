/**
 * Репозиторий продаж по месяцам и закрытия месяцев (§6 ТЗ).
 *
 *  - Одна запись SalesRow на (товар, филиал, год-месяц) — уникальный индекс [productId+branch+ym].
 *  - Пустая ячейка = qty:null, confirmed:false → в СДП НЕ участвует (не подменяется нулём).
 *  - Подтверждённый ноль закрытого месяца = qty:0, confirmed:true → участвует в среднем.
 *  - Закрытие месяца требует явного подтверждения заполненности/нулей; открытие — с журналом.
 */
import { db } from '../database';
import type { SalesRow } from '../schema';
import { nowISO, writeAudit } from '../util';
import { BRANCHES, parseYearMonth, ymCompare, type Branch, type YearMonth } from '../../core/types';

const salesId = (productId: string, branch: Branch, ym: YearMonth) => `${productId}|${branch}|${ym}`;

export const salesRepo = {
  /** Прямая правка значения за месяц (открытый месяц). qty=null — «пусто». */
  async setValue(productId: string, brandId: string, branch: Branch, ym: YearMonth, qty: number | null, actor = 'оператор'): Promise<SalesRow> {
    parseYearMonth(ym); // валидация формата
    if (qty !== null && (!Number.isInteger(qty) || qty < 0)) throw new Error('Продажи — неотрицательное целое число');
    const id = salesId(productId, branch, ym);
    const before = await db.sales.get(id);
    const row: SalesRow = {
      id, productId, brandId, branch, ym,
      qty,
      status: before?.status ?? 'open',
      confirmed: false, // любая правка снимает подтверждение — закрытие требуется заново
      updatedAt: nowISO(), updatedBy: actor,
    };
    await db.transaction('rw', db.sales, db.audit, async () => {
      await db.sales.put(row);
      await writeAudit(db, { brandId, entity: 'sales', entityId: id, action: before ? 'update' : 'create', details: `Продажи ${branch} ${ym}: ${before?.qty ?? '∅'} → ${qty ?? '∅'}`, before, after: row });
    });
    return row;
  },

  /**
   * Закрытие месяца (§6): требует явного подтверждения. Если some rows пусты и allowEmpty=false — ошибка.
   * Пустые при allowEmpty=true остаются пустыми (в СДП не участвуют), но месяц закрывается
   * только если оператор подтвердил неполноту.
   */
  async closeMonth(brandId: string, ym: YearMonth, opts: { confirmZeroOnly?: boolean; allowIncomplete?: boolean; actor?: string } = {}): Promise<{ closed: number; emptyCount: number }> {
    const actor = opts.actor ?? 'оператор';
    const products = await db.products.where('brandId').equals(brandId).toArray();
    const ids = products.map((p) => p.id);
    let closed = 0;
    let emptyCount = 0;
    const updates: SalesRow[] = [];
    for (const pid of ids) {
      for (const br of BRANCHES) {
        const id = salesId(pid, br, ym);
        const rec = await db.sales.get(id);
        if (!rec) {
          if (!opts.allowIncomplete) throw new Error(`Нет данных продаж за ${ym} (${br}, товар ${pid}). Закройте месяц с подтверждением неполноты или заполните данные.`);
          emptyCount++;
          continue;
        }
        if (rec.qty === null) {
          if (!opts.allowIncomplete) throw new Error(`Пустой месяц ${ym} (${br}, товар ${pid}) — подтвердите неполноту (allowIncomplete) или заполните значение. Пустое НЕ заменяется нулём.`);
          emptyCount++;
          updates.push({ ...rec, status: 'closed', confirmed: true, updatedAt: nowISO(), updatedBy: actor });
        } else {
          if (rec.qty === 0 && !opts.confirmZeroOnly) {
            throw new Error(`Нулевые продажи ${ym} (${br}, товар ${pid}) требуют явного подтверждения (confirmZeroOnly)`);
          }
          updates.push({ ...rec, status: 'closed', confirmed: true, updatedAt: nowISO(), updatedBy: actor });
        }
        closed++;
      }
    }
    await db.transaction('rw', db.sales, db.audit, async () => {
      for (const u of updates) await db.sales.put(u);
      await writeAudit(db, { brandId, entity: 'sales-month', entityId: `${brandId}|${ym}`, action: 'close-month', details: `Закрыт месяц ${ym}: записей=${closed}, пустых=${emptyCount}` });
    });
    return { closed, emptyCount };
  },

  /** Открытие закрытого месяца для корректировки — с журналом изменений (§6). */
  async openMonth(brandId: string, ym: YearMonth, reason: string, actor = 'оператор'): Promise<number> {
    if (!reason.trim()) throw new Error('Укажите причину открытия закрытого месяца (журнал изменений обязателен)');
    const rows = await db.sales.where('[brandId+ym]').equals([brandId, ym]).toArray();
    await db.transaction('rw', db.sales, db.audit, async () => {
      for (const r of rows) {
        await db.sales.update(r.id, { status: 'open', confirmed: false, updatedAt: nowISO(), updatedBy: actor });
      }
      await writeAudit(db, { brandId, entity: 'sales-month', entityId: `${brandId}|${ym}`, action: 'open-month', details: `Открыт месяц ${ym} для корректировки: ${reason}; записей=${rows.length}` });
    });
    return rows.length;
  },

  async listByProduct(productId: string): Promise<SalesRow[]> {
    const rows = await db.sales.where('productId').equals(productId).toArray();
    return rows.sort((a, b) => (a.ym === b.ym ? a.branch.localeCompare(b.branch) : ymCompare(a.ym, b.ym)));
  },

  async listByBrandPeriods(brandId: string, months: YearMonth[]): Promise<SalesRow[]> {
    const set = new Set(months);
    const all = await db.sales.where('brandId').equals(brandId).toArray();
    return all.filter((r) => set.has(r.ym));
  },

  async getOne(productId: string, branch: Branch, ym: YearMonth): Promise<SalesRow | undefined> {
    return db.sales.get(salesId(productId, branch, ym));
  },
};

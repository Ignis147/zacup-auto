/**
 * Репозиторий товарной матрицы + истории цен (§4, §5 ТЗ).
 *
 *  - Штрихкод — строка (ведущие нули сохраняются), уникален внутри бренда ([brandId+barcode]).
 *  - Артикул вычисляется автоматически = последние 6 символов штрихкода; при длине < 6 — ошибка.
 *  - Любое изменение цены создаёт НОВУЮ версию прайса (PriceVersion) с previousVersionId;
 *    утверждённые заказы не изменяются (у них собственный снимок).
 *  - Кратность версионируется: каждое изменение packSize пишется в аудит (before/after).
 */
import Dexie from 'dexie';
import { db } from '../database';
import type { ProductRow, PriceVersionRow } from '../schema';
import { newId, nowISO, writeAudit } from '../util';
import { computeArticle, validateTiers, decimalCmp, type Currency, type PriceMode, type PriceTier } from '../../core/types';

export interface ProductInput {
  brandId: string;
  barcode: string;
  name: string;
  packSize: number;
  priceMode: PriceMode;
  fixedPrice: string | null;
  tiers: PriceTier[];
  currency: Currency;
}

function validateProductInput(inp: ProductInput): void {
  if (!inp.brandId) throw new Error('Товар должен принадлежать бренду');
  if (!inp.barcode.trim()) throw new Error('Штрихкод обязателен');
  const art = computeArticle(inp.barcode);
  if (art.error) throw new Error(art.error);
  if (!Number.isInteger(inp.packSize) || inp.packSize <= 0) {
    throw new Error('Кратность должна быть положительным целым числом');
  }
  if (!inp.name.trim()) throw new Error('Наименование обязательно');
  if (inp.priceMode === 'fixed') {
    if (!inp.fixedPrice || decimalCmp(inp.fixedPrice, '0') <= 0) {
      throw new Error('Фиксированная цена должна быть > 0');
    }
  } else {
    const errs = validateTiers(inp.tiers);
    if (errs.length) throw new Error(errs.join('; '));
  }
}

const priceSig = (mode: PriceMode, fixed: string | null, tiers: PriceTier[], currency: Currency): string =>
  JSON.stringify([mode, fixed, [...tiers].sort((a, b) => a.minBoxes - b.minBoxes), currency]);

export const productsRepo = {
  async create(inp: ProductInput, actor = 'оператор'): Promise<ProductRow> {
    validateProductInput(inp);
    const barcode = inp.barcode.trim(); // сохраняем как строку, без Number()!
    const dup = await db.products.where('[brandId+barcode]').equals([inp.brandId, barcode]).first();
    if (dup) throw new Error(`Дубликат штрихкода «${barcode}» в бренде`);
    const article = computeArticle(barcode).article!;
    const row: ProductRow = {
      id: newId('prd'),
      brandId: inp.brandId,
      barcode, article,
      name: inp.name.trim(),
      packSize: inp.packSize,
      priceMode: inp.priceMode,
      fixedPrice: inp.priceMode === 'fixed' ? inp.fixedPrice : null,
      tiers: inp.priceMode === 'tiers' ? inp.tiers : [],
      currency: inp.currency,
      archived: false,
      createdAt: nowISO(), updatedAt: nowISO(), updatedBy: actor,
    };
    const pv: PriceVersionRow = {
      id: newId('pv'), productId: row.id, brandId: row.brandId,
      effectiveDate: nowISO().slice(0, 10), currency: row.currency,
      priceMode: row.priceMode, fixedPrice: row.fixedPrice, tiers: row.tiers,
      recordedAt: nowISO(), previousVersionId: null,
    };
    await db.transaction('rw', db.products, db.priceVersions, db.audit, async () => {
      await db.products.add(row);
      await db.priceVersions.add(pv);
      await writeAudit(db, { brandId: row.brandId, entity: 'product', entityId: row.id, action: 'create', details: `Добавлен товар ${barcode} «${row.name}»`, after: row });
    });
    return row;
  },

  /**
   * Обновление товара. Если изменились цена/ступени/валюта — создаётся новая версия прайса.
   * Изменение текущего прайса НЕ затрагивает утверждённые заказы (§5).
   */
  async update(id: string, patch: Partial<ProductInput>, actor = 'оператор'): Promise<ProductRow> {
    const before = await db.products.get(id);
    if (!before) throw new Error('Товар не найден');
    const merged: ProductInput = {
      brandId: patch.brandId ?? before.brandId,
      barcode: patch.barcode ?? before.barcode,
      name: patch.name ?? before.name,
      packSize: patch.packSize ?? before.packSize,
      priceMode: patch.priceMode ?? before.priceMode,
      fixedPrice: patch.priceMode !== undefined && patch.priceMode !== before.priceMode
        ? (patch.fixedPrice ?? null)
        : (patch.fixedPrice !== undefined ? patch.fixedPrice : before.fixedPrice),
      tiers: patch.tiers ?? before.tiers,
      currency: patch.currency ?? before.currency,
    };
    validateProductInput(merged);

    const barcode = merged.barcode.trim();
    const article = computeArticle(barcode).article!;
    if (barcode !== before.barcode) {
      const dup = await db.products.where('[brandId+barcode]').equals([merged.brandId, barcode]).first();
      if (dup && dup.id !== id) throw new Error(`Дубликат штрихкода «${barcode}» в бренде`);
    }

    const priceChanged =
      priceSig(merged.priceMode, merged.fixedPrice, merged.tiers, merged.currency) !==
      priceSig(before.priceMode, before.fixedPrice, before.tiers, before.currency);
    const packChanged = merged.packSize !== before.packSize;

    const after: ProductRow = {
      ...before,
      barcode, article,
      name: merged.name.trim(),
      packSize: merged.packSize,
      priceMode: merged.priceMode,
      fixedPrice: merged.priceMode === 'fixed' ? merged.fixedPrice : null,
      tiers: merged.priceMode === 'tiers' ? merged.tiers : [],
      currency: merged.currency,
      updatedAt: nowISO(), updatedBy: actor,
    };

    let pv: PriceVersionRow | null = null;
    if (priceChanged) {
      const prev = await db.priceVersions.where('[productId+effectiveDate]').between([id, DexieMin], [id, DexieMax]).last();
      pv = {
        id: newId('pv'), productId: id, brandId: after.brandId,
        effectiveDate: nowISO().slice(0, 10), currency: after.currency,
        priceMode: after.priceMode, fixedPrice: after.fixedPrice, tiers: after.tiers,
        recordedAt: nowISO(), previousVersionId: prev?.id ?? null,
      };
    }

    await db.transaction('rw', db.products, db.priceVersions, db.audit, async () => {
      await db.products.put(after);
      if (pv) await db.priceVersions.add(pv);
      const parts: string[] = [];
      if (before.barcode !== after.barcode) parts.push(`штрихкод ${before.barcode} → ${after.barcode}`);
      if (before.name !== after.name) parts.push(`название → «${after.name}»`);
      if (packChanged) parts.push(`кратность ${before.packSize} → ${after.packSize}`);
      if (priceChanged) parts.push('прайс изменён (создана новая версия)');
      await writeAudit(db, {
        brandId: after.brandId, entity: 'product', entityId: id, action: 'update',
        details: parts.length ? parts.join('; ') : 'Изменений нет', before, after,
      });
    });
    return after;
  },

  async setArchived(id: string, archived: boolean, actor = 'оператор'): Promise<void> {
    const before = await db.products.get(id);
    if (!before) throw new Error('Товар не найден');
    await db.transaction('rw', db.products, db.audit, async () => {
      await db.products.update(id, { archived, updatedAt: nowISO(), updatedBy: actor });
      await writeAudit(db, { brandId: before.brandId, entity: 'product', entityId: id, action: archived ? 'archive' : 'unarchive', details: `${archived ? 'Архивирован' : 'Восстановлен'} товар ${before.barcode}`, before, after: { ...before, archived } });
    });
    // исторические продажи и заказы НЕ удаляются (§4)
  },

  async get(id: string): Promise<ProductRow | undefined> {
    return db.products.get(id);
  },

  async listByBrand(brandId: string, includeArchived = false): Promise<ProductRow[]> {
    const all = await db.products.where('brandId').equals(brandId).toArray();
    return (includeArchived ? all : all.filter((p) => !p.archived)).sort((a, b) => a.barcode.localeCompare(b.barcode));
  },

  /** Массовый импорт (§4): пропуск дублей с журналом ошибок, атомарная запись валидных строк. */
  async bulkImport(brandId: string, items: ProductInput[], actor = 'оператор'): Promise<{ created: ProductRow[]; errors: Array<{ barcode: string; error: string }> }> {
    const created: ProductRow[] = [];
    const errors: Array<{ barcode: string; error: string }> = [];
    const seenBarcodes = new Set<string>();
    for (const it of items) {
      try {
        const bc = it.barcode.trim();
        if (seenBarcodes.has(bc)) throw new Error(`Дубликат штрихкода «${bc}» внутри импорта`);
        seenBarcodes.add(bc);
        const p = await this.create({ ...it, brandId }, actor);
        created.push(p);
      } catch (e) {
        errors.push({ barcode: it.barcode, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { created, errors };
  },

  /** Поиск по штрихкоду / артикулу / наименованию (подстрока, регистронезависимо). */
  async search(brandId: string, query: string): Promise<ProductRow[]> {
    const q = query.trim().toLowerCase();
    const all = await db.products.where('brandId').equals(brandId).toArray();
    if (!q) return all;
    return all.filter((p) => p.barcode.toLowerCase().includes(q) || p.article.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  },

  // ── История цен ──
  async priceHistory(productId: string): Promise<PriceVersionRow[]> {
    const rows = await db.priceVersions.where('productId').equals(productId).toArray();
    return rows.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
  },
};

// границы для between по составному индексу — Dexie.minKey/maxKey (см. импорт выше)
const DexieMin = Dexie.minKey as unknown as string;
const DexieMax = Dexie.maxKey as unknown as string;

/**
 * Репозиторий брендов и настроек бренда (сроки логистики, нормативы ТЗ).
 * Операции: создание / чтение / изменение / архивирование. Все изменения — с аудитом в транзакции.
 */
import { db } from '../database';
import type { BrandRow, BrandSettingsRow } from '../schema';
import { newId, nowISO, writeAudit } from '../util';
import { DEFAULT_BRAND_SETTINGS, DEFAULT_LEAD_TIMES } from '../../core/types';

export const brandsRepo = {
  async create(name: string, actor = 'оператор'): Promise<BrandRow> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Название бренда не может быть пустым');
    const existing = await db.brands.filter((b) => b.name.toLowerCase() === trimmed.toLowerCase()).toArray();
    if (existing.length > 0) throw new Error(`Бренд «${trimmed}» уже существует`);
    const row: BrandRow = {
      id: newId('brd'), name: trimmed, archived: false,
      createdAt: nowISO(), updatedAt: nowISO(), updatedBy: actor,
    };
    const settings: BrandSettingsRow = {
      id: row.id, name: row.name,
      leadTimes: { ...DEFAULT_LEAD_TIMES },
      tzMinMonths: DEFAULT_BRAND_SETTINGS.tzMinMonths,
      tzMaxMonths: DEFAULT_BRAND_SETTINGS.tzMaxMonths,
      targetTZMonths: DEFAULT_BRAND_SETTINGS.targetTZMonths,
    };
    await db.transaction('rw', db.brands, db.brandSettings, db.audit, async () => {
      await db.brands.add(row);
      await db.brandSettings.add(settings);
      await writeAudit(db, { brandId: row.id, entity: 'brand', entityId: row.id, action: 'create', details: `Создан бренд «${row.name}»`, after: row });
    });
    return row;
  },

  async list(includeArchived = true): Promise<BrandRow[]> {
    const all = await db.brands.toArray();
    return (includeArchived ? all : all.filter((b) => !b.archived)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  },

  async get(id: string): Promise<BrandRow | undefined> {
    return db.brands.get(id);
  },

  async rename(id: string, name: string, actor = 'оператор'): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Название бренда не может быть пустым');
    const before = await db.brands.get(id);
    if (!before) throw new Error('Бренд не найден');
    await db.transaction('rw', db.brands, db.brandSettings, db.audit, async () => {
      await db.brands.update(id, { name: trimmed, updatedAt: nowISO(), updatedBy: actor });
      await db.brandSettings.update(id, { name: trimmed });
      await writeAudit(db, { brandId: id, entity: 'brand', entityId: id, action: 'update', details: `Переименован бренд: «${before.name}» → «${trimmed}»`, before, after: { ...before, name: trimmed } });
    });
  },

  /** Архивирование без потери исторических данных (§4 ТЗ): продажи/заказы остаются. */
  async setArchived(id: string, archived: boolean, actor = 'оператор'): Promise<void> {
    const before = await db.brands.get(id);
    if (!before) throw new Error('Бренд не найден');
    await db.transaction('rw', db.brands, db.audit, async () => {
      await db.brands.update(id, { archived, updatedAt: nowISO(), updatedBy: actor });
      await writeAudit(db, { brandId: id, entity: 'brand', entityId: id, action: archived ? 'archive' : 'unarchive', details: `${archived ? 'Архивирован' : 'Восстановлен из архива'} бренд «${before.name}»`, before, after: { ...before, archived } });
    });
  },

  async delete(id: string, actor = 'оператор'): Promise<void> {
    const before = await db.brands.get(id);
    if (!before) return;
    await db.transaction('rw', db.brands, db.brandSettings, db.products, db.priceVersions, db.sales, db.stock, db.orders, db.audit, async () => {
      await db.brands.delete(id);
      await db.brandSettings.delete(id);
      await db.products.where('brandId').equals(id).delete();
      await db.priceVersions.where('brandId').equals(id).delete();
      await db.sales.where('brandId').equals(id).delete();
      await db.stock.where('brandId').equals(id).delete();
      await db.orders.where('brandId').equals(id).delete();
      await writeAudit(db, { brandId: null, entity: 'brand', entityId: id, action: 'delete', details: `Удалён бренд «${before.name}» со всеми данными`, before });
    });
    void actor;
  },
};

export const brandSettingsRepo = {
  async get(brandId: string): Promise<BrandSettingsRow> {
    const found = await db.brandSettings.get(brandId);
    if (found) return found;
    // самовосстановление настроек при отсутствии записи
    const row: BrandSettingsRow = {
      id: brandId, name: '', leadTimes: { ...DEFAULT_LEAD_TIMES },
      tzMinMonths: DEFAULT_BRAND_SETTINGS.tzMinMonths,
      tzMaxMonths: DEFAULT_BRAND_SETTINGS.tzMaxMonths,
      targetTZMonths: DEFAULT_BRAND_SETTINGS.targetTZMonths,
    };
    await db.brandSettings.add(row);
    return row;
  },

  async update(brandId: string, patch: Partial<Omit<BrandSettingsRow, 'id' | 'name'>>, actor = 'оператор'): Promise<BrandSettingsRow> {
    const before = await this.get(brandId);
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'leadTimes') continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new Error(`Некорректное значение настройки «${k}»: должно быть > 0`);
      }
    }
    if (patch.tzMinMonths !== undefined && patch.tzMaxMonths !== undefined && patch.tzMinMonths > patch.tzMaxMonths) {
      throw new Error('Нижняя граница норматива ТЗ не может быть выше верхней');
    }
    if (patch.leadTimes) {
      const lt = patch.leadTimes;
      for (const d of [lt.prepDays, lt.toVLKDays, lt.vlkToMSKDays]) {
        if (d !== undefined && (!Number.isInteger(d) || d < 0)) throw new Error('Сроки логистики — целые неотрицательные дни');
      }
    }
    const after: BrandSettingsRow = {
      ...before,
      ...patch,
      leadTimes: { ...before.leadTimes, ...(patch.leadTimes ?? {}) },
    };
    await db.transaction('rw', db.brandSettings, db.audit, async () => {
      await db.brandSettings.put(after);
      await writeAudit(db, { brandId, entity: 'brandSettings', entityId: brandId, action: 'update', details: 'Изменены настройки бренда (сроки/нормативы ТЗ)', before, after });
    });
    void actor;
    return after;
  },
};

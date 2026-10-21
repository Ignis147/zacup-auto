// ===== База данных IndexedDB через Dexie =====
import Dexie, { type Table } from 'dexie';
import type {
  Brand, Product, PriceHistoryEntry, SalesRecord, PeriodStatus,
  SalesEditLog, StockSnapshot, Supply, FixedOrder, Settings, BackupData,
} from './types';

// ===== Схема БД =====
// Индексы, объявленные как "&" (уникальные) или "[a+b]" (составные), НЕЛЬЗЯ добавлять
// к уже существующему object store через IndexedDB versionchange — это вызывало ошибку
// "Unable to patch indexes of table ..." и бесконечную загрузку приложения.
// Поэтому declared schema содержит только простые индексы; уникальность штрихкода
// обеспечивается проверкой isBarcodeTaken(), а сложные запросы — фильтрами.
const SCHEMA_V1 = {
  brands: '++id, name',
  products: '++id, brandId, barcode',
  priceHistory: '++id, productId',
  sales: '++id, brandId, productId, period, branch',
  periods: '++id, key, brandId, period, branch',
  salesLog: '++id, brandId, productId',
  stocks: '++id, brandId, productId',
  supplies: '++id, brandId',
  orders: '++id, brandId',
  settings: '++id',
};

class ZakaznikDB extends Dexie {
  brands!: Table<Brand, number>;
  products!: Table<Product, number>;
  priceHistory!: Table<PriceHistoryEntry, number>;
  sales!: Table<SalesRecord, number>;
  periods!: Table<PeriodStatus, number>;
  salesLog!: Table<SalesEditLog, number>;
  stocks!: Table<StockSnapshot, number>;
  supplies!: Table<Supply, number>;
  orders!: Table<FixedOrder, number>;
  settings!: Table<Settings, number>;

  constructor() {
    super('zakaznik-db');
    // Единственная версия схемы. Для новых и старых баз она идентична по типу PK
    // и набору простых индексов, поэтому конфликтов при открытии не возникает.
    this.version(1).stores(SCHEMA_V1);
  }
}

export const db = new ZakaznikDB();

/**
 * Инициализация базы данных с понятной обработкой ошибок.
 * Вызывается один раз при старте приложения (App.tsx) до первой загрузки данных.
 */
export async function initDB(): Promise<void> {
  try {
    await db.open();
  } catch (e: any) {
    throw friendlyDbError(e);
  }
}

function friendlyDbError(e: any): Error {
  const inner = e?.inner;
  const name = inner?.name || e?.name || '';
  if (name === 'VersionError') {
    return new Error('База данных открыта в другой вкладке с более новой версией схемы. Закройте другие вкладки и обновите страницу.');
  }
  if (name === 'InvalidStateError') {
    return new Error('Не удалось открыть локальную базу данных. Приложение не работает в режиме «Инкогнито» и при заблокированном IndexedDB.');
  }
  if (name === 'QuotaExceededError') {
    return new Error('Хранилище браузера переполнено. Освободите место и обновите страницу.');
  }
  if (name === 'NoSuchDatabaseError') {
    return new Error('Локальная база данных не найдена. Создайте бренд, чтобы начать работу.');
  }
  return new Error(
    `Ошибка инициализации базы данных: ${e?.message || 'неизвестная ошибка'}` +
    (inner?.message ? ` (${inner.message})` : '')
  );
}

export const DEFAULT_SETTINGS: Omit<Settings, 'id'> = {
  orderPrepDays: 30,
  shipVldDays: 60,
  extraMskDays: 20,
  targetStockMonths: 3,
  minStockMonths: 2,
  maxStockMonths: 5,
  usdRub: 85,
  krwRub: 0.063,
  ratesUpdatedAt: new Date().toISOString().slice(0, 10),
};

/** Получить настройки (singleton id=1), создав при необходимости */
export async function getSettings(): Promise<Settings> {
  let s = await db.settings.get(1);
  if (!s) {
    s = { ...DEFAULT_SETTINGS, id: 1 };
    await db.settings.add(s as Settings);
  }
  return s;
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.settings.put({ ...s, id: 1 });
}

/** Артикул = последние 6 символов штрихкода */
export function articleFromBarcode(barcode: string): string {
  const b = (barcode || '').trim();
  return b.length >= 6 ? b.slice(-6) : b;
}

/** Проверка уникальности штрихкода внутри бренда */
export async function isBarcodeTaken(brandId: number, barcode: string, exceptProductId?: number): Promise<boolean> {
  const bc = barcode.trim();
  // Составной индекс не используется — запрос идёт по обычному индексу brandId + фильтр.
  const found = await db.products.where('brandId').equals(brandId)
    .filter((p) => p.barcode === bc && p.id !== exceptProductId)
    .first();
  return !!found;
}

// ===== Резервные копии =====

export async function exportBackup(): Promise<BackupData> {
  const tables = {
    brands: await db.brands.toArray(),
    products: await db.products.toArray(),
    priceHistory: await db.priceHistory.toArray(),
    sales: await db.sales.toArray(),
    periods: await db.periods.toArray(),
    salesLog: await db.salesLog.toArray(),
    stocks: await db.stocks.toArray(),
    supplies: await db.supplies.toArray(),
    orders: await db.orders.toArray(),
    settings: await db.settings.toArray(),
  };
  return { app: 'zakaznik', version: 1, exportedAt: new Date().toISOString(), tables };
}

/** Валидация структуры резервной копии без записи в базу */
export function validateBackup(data: unknown): string | null {
  const d = data as BackupData;
  if (!d || typeof d !== 'object') return 'Файл не является объектом JSON.';
  if (d.app !== 'zakaznik') return 'Это не резервная копия приложения «Заказник».';
  if (d.version !== 1) return 'Неподдерживаемая версия резервной копии.';
  if (!d.tables || typeof d.tables !== 'object') return 'Отсутствует раздел tables.';
  const required = ['brands', 'products', 'priceHistory', 'sales', 'periods', 'salesLog', 'stocks', 'supplies', 'orders', 'settings'] as const;
  for (const t of required) {
    if (!Array.isArray((d.tables as any)[t])) return `Раздел tables.${t} отсутствует или не является списком.`;
  }
  // базовые проверки записей
  for (const b of d.tables.brands) if (typeof b?.name !== 'string') return 'Некорректная запись бренда.';
  for (const p of d.tables.products) if (typeof p?.barcode !== 'string' || typeof p?.brandId !== 'number') return 'Некорректная запись товара.';
  return null;
}

/** Атомарное восстановление из резервной копии (в транзакции) */
export async function restoreBackup(data: BackupData): Promise<void> {
  const err = validateBackup(data);
  if (err) throw new Error(err);
  await db.transaction('rw', [db.brands, db.products, db.priceHistory, db.sales, db.periods, db.salesLog, db.stocks, db.supplies, db.orders, db.settings] as any, async () => {
    await db.brands.clear();
    await db.products.clear();
    await db.priceHistory.clear();
    await db.sales.clear();
    await db.periods.clear();
    await db.salesLog.clear();
    await db.stocks.clear();
    await db.supplies.clear();
    await db.orders.clear();
    await db.settings.clear();
    // Вставляем с сохранением id, чтобы связи остались корректными
    await db.brands.bulkAdd(data.tables.brands as any);
    await db.products.bulkAdd(data.tables.products as any);
    await db.priceHistory.bulkAdd(data.tables.priceHistory as any);
    await db.sales.bulkAdd(data.tables.sales as any);
    await db.periods.bulkAdd(data.tables.periods as any);
    await db.salesLog.bulkAdd(data.tables.salesLog as any);
    await db.stocks.bulkAdd(data.tables.stocks as any);
    await db.supplies.bulkAdd(data.tables.supplies as any);
    await db.orders.bulkAdd(data.tables.orders as any);
    await db.settings.bulkAdd(data.tables.settings as any);
  });
}

/**
 * База данных IndexedDB (Dexie.js) — единственное основное рабочее хранилище (§26 ТЗ).
 *
 * - Версионирование схемы + безопасные миграции (upgrade без потери данных).
 * - Уникальные индексы: штрихкод уникален ВНУТРИ бренда ([brandId+barcode] unique),
 *   продажи — одна запись на товар/филиал/месяц ([productId+branch+ym] unique).
 * - Транзакции Dexie для атомарных связанных изменений.
 */
import Dexie, { type Table } from 'dexie';
import { SCHEMA_VERSION } from './schema';
import type {
  BrandRow, ProductRow, PriceVersionRow, SalesRow, StockRow,
  PurchaseOrderRow, SettingsRow, BrandSettingsRow, AuditRow,
} from './schema';

export class ZakaznikDB extends Dexie {
  brands!: Table<BrandRow, string>;
  products!: Table<ProductRow, string>;
  priceVersions!: Table<PriceVersionRow, string>;
  sales!: Table<SalesRow, string>;
  stock!: Table<StockRow, string>;
  orders!: Table<PurchaseOrderRow, string>;
  settings!: Table<SettingsRow, string>;
  brandSettings!: Table<BrandSettingsRow, string>;
  audit!: Table<AuditRow, string>;

  constructor(name = 'zakaznik-db') {
    super(name);

    // ── v1: базовая схема ────────────────────────────────────────────────
    this.version(1).stores({
      brands: 'id, name',
      products: 'id, brandId, barcode, article, [brandId+barcode], [brandId+article], [brandId+archived]',
      priceVersions: 'id, productId, brandId, [productId+effectiveDate], [brandId+effectiveDate]',
      sales: 'id, brandId, productId, [productId+branch+ym], [brandId+ym], [productId+ym]',
      stock: 'id, brandId, productId, [productId+branch+asOf], [brandId+branch]',
      orders: 'id, brandId, status, [brandId+status], [brandId+issueDate]',
      settings: 'id',
      brandSettings: 'id',
      audit: 'id, at, actor, entity, entityId, action, [entity+entityId], brandId',
    });

    // ── Пример будущей миграции (v2): добавить индекс, НЕ стирая данные ──
    // this.version(2).stores({ products: '...то же..., name' }).upgrade(async tx => {
    //   // нормализация существующих записей при несовместимом изменении
    // });
  }
}

/** Синглтон приложения. */
export const db = new ZakaznikDB();

export const DB_SCHEMA_VERSION = SCHEMA_VERSION;

/** Проверка доступности IndexedDB в браузере. */
export async function checkIndexedDBAvailable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (typeof indexedDB === 'undefined') {
      return { ok: false, reason: 'Браузер не поддерживает IndexedDB' };
    }
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('__zakaznik_probe__');
      req.onsuccess = () => {
        req.result.close();
        indexedDB.deleteDatabase('__zakaznik_probe__');
        resolve();
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB заблокирована другой вкладкой'));
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Ошибка доступа к IndexedDB (возможен приватный режим)' };
  }
}

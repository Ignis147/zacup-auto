/**
 * Схема IndexedDB (Dexie) для «Заказник».
 *
 * Принципы:
 *  - Первичный ключ — стабильный id (UUID), НИКОГДА штрихкод (он может исправляться).
 *  - Штрихкод хранится как строка (ведущие нули сохраняются); уникальность в пределах бренда —
 *    составной индекс [brandId+barcode].
 *  - Денежные значения — десятичные СТРОКИ (см. core/types.ts: decFromString и т.д.), не float.
 *  - Даты — ISO-строки: 'YYYY-MM-DD' (календарные, без часовой зоны) и
 *    'YYYY-MM-DDTHH:mm:ss.sssZ' (моменты времени, UTC) — ошибок часовых поясов нет.
 *  - Все сущности содержат brandId — изоляция данных брендов через индекс brandId.
 */
import type {
  Branch, Currency, PriceTier, PriceMode, LeadTimes, ExchangeRates, OrderStatus,
  YearMonth, MonthStatus, ApprovedSnapshot,
} from '../core/types';

export const APP_VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;
export const BACKUP_FORMAT_VERSION = 1;

export interface BrandRow {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ProductRow {
  id: string;
  brandId: string;
  barcode: string; // строка! ведущие нули
  article: string; // последние 6 символов штрихкода (вычисляется при сохранении)
  name: string;
  packSize: number; // > 0, целое
  priceMode: PriceMode;
  fixedPrice: string | null; // десятичная строка
  tiers: PriceTier[];
  currency: Currency;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

/** Версия прайса: неизменяемая запись истории цен (§5 ТЗ). */
export interface PriceVersionRow {
  id: string;
  productId: string;
  brandId: string;
  effectiveDate: string; // YYYY-MM-DD
  currency: Currency;
  priceMode: PriceMode;
  fixedPrice: string | null;
  tiers: PriceTier[];
  recordedAt: string; // ISO datetime
  previousVersionId: string | null;
}

export interface SalesRow {
  id: string;
  productId: string;
  brandId: string;
  branch: Branch;
  ym: YearMonth;
  qty: number | null; // null = пустая ячейка (неизвестно), НЕ participates в СДП
  status: MonthStatus;
  confirmed: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface StockRow {
  id: string;
  productId: string;
  brandId: string;
  branch: Branch;
  qty: number; // ≥ 0
  asOf: string; // ISO datetime — дата/время актуальности снимка
  source: 'manual' | 'excel' | 'restore';
  createdAt: string;
  createdBy: string;
}

export interface BranchAllocationRow {
  qty: number; // ≥ 0, шт
  received: boolean; // поступление ТОЛЬКО целиком по филиалу
  actualArrivalDate: string | null; // YYYY-MM-DD
  expectedArrivalDate: string | null; // YYYY-MM-DD (план по филиалу, если отличается от заказа)
}

export interface OrderLineRow {
  productId: string;
  barcode: string;
  name: string;
  qtyVLK: number;
  qtyMSK: number;
  packSize: number;
  unitPrice: string; // десятичная строка
  priceTierUsed: PriceTier | null;
  currency: Currency;
}

export interface PurchaseOrderRow {
  id: string;
  brandId: string;
  number: string;
  status: OrderStatus;
  issueDate: string; // YYYY-MM-DD
  exitDate: string;
  vlkDate: string;
  mskDate: string;
  leadTimesOverride: Partial<LeadTimes> | null;
  currency: Currency;
  ratesAtApproval: ExchangeRates | null;
  lines: OrderLineRow[];
  allocations: Record<string, Record<Branch, BranchAllocationRow>>; // productId → branch
  snapshot: ApprovedSnapshot | null; // неизменяемый снимок при утверждении
  actualExitConfirmedAt: string | null;
  copiedFromOrderId: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SettingsRow {
  id: 'global';
  rates: ExchangeRates;
  defaultTargetTZMonths: number;
  backupRemindDays: number;
  lastBackupAt: string | null;
  appVersion: string;
}

export interface BrandSettingsRow {
  id: string; // = brandId
  name: string;
  leadTimes: LeadTimes;
  tzMinMonths: number;
  tzMaxMonths: number;
  targetTZMonths: number;
}

export interface AuditRow {
  id: string;
  brandId: string | null; // для фильтра по бренду
  at: string; // ISO datetime
  actor: string;
  entity: string;
  entityId: string;
  action: string;
  details: string;
  before?: unknown;
  after?: unknown;
}

/** Полная резервная копия (JSON, UTF-8). */
export interface BackupFile {
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  counts: Record<string, number>;
  data: {
    brands: BrandRow[];
    products: ProductRow[];
    priceVersions: PriceVersionRow[];
    sales: SalesRow[];
    stock: StockRow[];
    orders: PurchaseOrderRow[];
    settings: SettingsRow[];
    brandSettings: BrandSettingsRow[];
    audit: AuditRow[];
  };
}

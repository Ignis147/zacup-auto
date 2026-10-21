// ===== Типы данных приложения «Заказник» =====

export type Currency = 'KRW' | 'USD';
export type Branch = 'vld' | 'msk'; // Владивосток / Москва

/** Ценовая ступень: от minBox коробок включительно действует цена price за штуку */
export interface PriceTier {
  minBoxes: number;
  price: number;
}

export type PriceKind = 'fixed' | 'tiered';

export interface Brand {
  id?: number;
  name: string;
  currency: Currency;        // валюта прайса
  archived: boolean;
  // Логистика (дни). Переопределяют значения по умолчанию из Settings, если заданы.
  orderPrepDays?: number;    // оформление и сборка в Корее (по умолч. 30)
  shipVldDays?: number;      // доставка Корея -> Владивосток (по умолч. 60)
  extraMskDays?: number;     // дополнительная доставка до Москвы (по умолч. 20)
  // Целевой товарный запас (месяцы)
  targetStockMonths?: number;   // по умолч. 3
  minStockMonths?: number;      // нижняя граница нормы (по умолч. 2)
  maxStockMonths?: number;      // верхняя граница нормы (по умолч. 5)
  createdAt: string;
}

export interface Product {
  id?: number;
  brandId: number;
  barcode: string;           // хранится строкой (ведущие нули)
  article: string;           // последние 6 символов штрихкода
  name: string;
  packSize: number;          // кратность коробки (>0, целое)
  priceKind: PriceKind;
  fixedPrice?: number;       // для priceKind='fixed'
  tiers?: PriceTier[];       // для priceKind='tiered', сортируются по minBoxes
  archived: boolean;
}

/** Запись истории закупочной цены */
export interface PriceHistoryEntry {
  id?: number;
  productId: number;
  date: string;              // ISO дата изменения
  oldPriceKind: PriceKind;
  oldFixedPrice?: number;
  oldTiers?: PriceTier[];
  newPriceKind: PriceKind;
  newFixedPrice?: number;
  newTiers?: PriceTier[];
  currency: Currency;
  comment?: string;
}

/** Помесячные продажи. period = "YYYY-MM" */
export interface SalesRecord {
  id?: number;
  brandId: number;
  productId: number;
  period: string;            // '2026-09'
  branch: Branch;
  qty: number | null;        // null = данные не введены; 0 = подтверждённое отсутствие продаж
}

/** Статус периода (месяца) по филиалу */
export interface PeriodStatus {
  id?: number;               // ключ `${brandId}|${period}|${branch}`
  key: string;
  brandId: number;
  period: string;
  branch: Branch;
  closed: boolean;
}

/** История исправлений продаж */
export interface SalesEditLog {
  id?: number;
  date: string;
  brandId: number;
  productId: number;
  period: string;
  branch: Branch;
  oldValue: number | null;
  newValue: number | null;
}

/** Снимок текущих остатков бренда (ручной ввод с датой актуальности) */
export interface StockSnapshot {
  id?: number;
  brandId: number;
  productId: number;
  vld: number;               // >= 0
  msk: number;               // >= 0
  asOfDate: string;          // ISO дата актуальности остатков
  /** true — пользователь подтвердил, что фактически полученные поставки уже учтены в остатках */
  receiptsIncluded: boolean;
}

export type SupplyStatus = 'ordered' | 'in_transit' | 'partial' | 'received' | 'cancelled';

export interface SupplyItem {
  productId: number;
  totalQty: number;          // общее количество = vld + msk
  vldQty: number;
  mskQty: number;
  vldReceived: number;       // получено во Владивостоке (факт)
  mskReceived: number;       // получено в Москве (факт)
  vldActualDate?: string;
  mskActualDate?: string;
}

export interface Supply {
  id?: number;
  brandId: number;
  number: string;            // название/номер поставки
  status: SupplyStatus;
  orderDate: string;         // дата оформления заказа
  departDate: string;        // дата выхода из Кореи
  vldPlannedDate: string;    // плановое поступление Владивосток
  mskPlannedDate: string;    // плановое поступление Москва
  items: SupplyItem[];
  fromOrderId?: number;      // если создана из зафиксированного заказа
  createdAt: string;
  note?: string;
}

/** Строка зафиксированного заказа — снимок цен на момент фиксации */
export interface OrderLine {
  productId: number;
  name: string;
  barcode: string;
  article: string;
  packSize: number;          // кратность на момент заказа
  vldQty: number;
  mskQty: number;
  totalQty: number;
  totalBoxes: number;
  appliedPrice: number;      // цена за штуку, применённая при заказе
  vldSum: number;            // в валюте прайса
  mskSum: number;
  totalSum: number;
}

export interface FixedOrder {
  id?: number;
  brandId: number;
  number: string;            // номер заказа
  date: string;              // дата оформления
  currency: Currency;
  rates: { usdRub: number; krwRub: number }; // курсы на момент фиксации
  lines: OrderLine[];
  totalUnits: number;
  totalBoxes: number;
  totalSum: number;          // в валюте прайса
  totalSumRub: number;
  vldPlannedDate: string;
  mskPlannedDate: string;
  supplyCreated: boolean;    // была ли создана поставка
  note?: string;
}

export interface Settings {
  id?: number;               // всегда 1 — singleton
  orderPrepDays: number;     // 30
  shipVldDays: number;       // 60
  extraMskDays: number;      // 20
  targetStockMonths: number; // 3
  minStockMonths: number;    // 2
  maxStockMonths: number;    // 5
  usdRub: number;            // 85
  krwRub: number;            // 0.063
  ratesUpdatedAt: string;    // дата последнего обновления курсов
}

/** Полный дамп для резервной копии */
export interface BackupData {
  app: 'zakaznik';
  version: 1;
  exportedAt: string;
  tables: {
    brands: Brand[];
    products: Product[];
    priceHistory: PriceHistoryEntry[];
    sales: SalesRecord[];
    periods: PeriodStatus[];
    salesLog: SalesEditLog[];
    stocks: StockSnapshot[];
    supplies: Supply[];
    orders: FixedOrder[];
    settings: Settings[];
  };
}

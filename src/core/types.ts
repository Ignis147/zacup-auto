/**
 * Расчётное ядро «Заказник» — доменные типы.
 * Модуль не зависит от React и IndexedDB: чистые типы и функции.
 */

export type Branch = 'VLK' | 'MSK';

export const BRANCHES: Branch[] = ['VLK', 'MSK'];

export const BRANCH_LABEL: Record<Branch, string> = {
  VLK: 'Владивосток (ВЛК)',
  MSK: 'Москва (МСК)',
};

export const BRANCH_SHORT: Record<Branch, string> = { VLK: 'ВЛК', MSK: 'МСК' };

export type Currency = 'KRW' | 'USD';

export const CURRENCIES: Currency[] = ['KRW', 'USD'];

/** Ключ «год-месяц», напр. '2026-03'. Месяц 1..12. */
export type YearMonth = string;

export function makeYearMonth(year: number, month: number): YearMonth {
  if (month < 1 || month > 12) throw new Error(`Некорректный месяц: ${month}`);
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parseYearMonth(ym: YearMonth): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) throw new Error(`Некорректный период: ${ym}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function ymCompare(a: YearMonth, b: YearMonth): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Последние n закрытых календарных месяцев относительно currentDate (текущий незакрытый не включается). */
export function lastMonthsWindow(currentDate: Date, count = 12): YearMonth[] {
  const res: YearMonth[] = [];
  let y = currentDate.getFullYear();
  let m = currentDate.getMonth() + 1; // 1..12 текущего месяца
  m -= 1; // окно — месяцы строго до текущего
  if (m === 0) { m = 12; y -= 1; }
  for (let i = 0; i < count; i++) {
    res.push(makeYearMonth(y, m));
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return res.sort(ymCompare);
}

// ────────────────────────── Номенклатура ──────────────────────────

export interface PriceTier {
  minBoxes: number; // включительно
  maxBoxes: number | null; // включительно; null = открытый верхний предел
  pricePerUnit: string; // десятичная строка, цена за ЕДИНИЦУ товара
}

export type PriceMode = 'fixed' | 'tiers';

export interface Product {
  id: string;
  brandId: string;
  barcode: string; // строка — сохраняет ведущие нули
  name: string;
  packSize: number; // кратность: единиц в транспортной коробке (>0)
  priceMode: PriceMode;
  fixedPrice: string | null; // десятичная строка (за единицу), при priceMode='fixed'
  tiers: PriceTier[]; // при priceMode='tiers'; диапазоны по коробкам SKU ВЛК+МСК, не пересекаются
  currency: Currency;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string; // источник изменения («оператор»)
}

/** Артикул — последние 6 символов штрихкода. При длине < 6 — ошибка. */
export function computeArticle(barcode: string): { article?: string; error?: string } {
  const trimmed = barcode.trim();
  if (trimmed.length < 6) {
    return { error: 'Штрихкод короче 6 символов — артикул не может быть вычислен' };
  }
  return { article: trimmed.slice(-6) };
}

/** Валидация ступенчатой цены: положительность цен, отсутствие пересечений. */
export function validateTiers(tiers: PriceTier[]): string[] {
  const errors: string[] = [];
  if (tiers.length === 0) {
    errors.push('Не задано ни одной ценовой ступени');
    return errors;
  }
  const sorted = [...tiers].sort((a, b) => a.minBoxes - b.minBoxes);
  for (const t of sorted) {
    if (t.minBoxes < 1) errors.push(`Ступень от ${t.minBoxes} коробок: минимум 1 коробка`);
    if (t.maxBoxes !== null && t.maxBoxes < t.minBoxes) {
      errors.push(`Ступень ${t.minBoxes}–${t.maxBoxes}: верхняя граница ниже нижней`);
    }
    if (decimalCmp(t.pricePerUnit, '0') <= 0) errors.push('Цена ступени должна быть > 0');
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.maxBoxes !== null && cur.minBoxes <= prev.maxBoxes) {
      errors.push(`Ступени пересекаются: ${prev.minBoxes}–${prev.maxBoxes ?? '∞'} и ${cur.minBoxes}–${cur.maxBoxes ?? '∞'}`);
    }
  }
  return errors;
}

/** Выбор ступени по общему числу коробок SKU (ВЛК+МСК). null — подходящей ступени нет. */
export function pickTier(tiers: PriceTier[], totalBoxes: number): PriceTier | null {
  for (const t of tiers) {
    if (totalBoxes >= t.minBoxes && (t.maxBoxes === null || totalBoxes <= t.maxBoxes)) return t;
  }
  return null;
}

// ────────────────────────── Прайс-версии / история цен ──────────────────────────

export interface PriceVersion {
  id: string;
  productId: string;
  brandId: string;
  effectiveDate: string; // ISO date — дата действия
  currency: Currency;
  priceMode: PriceMode;
  fixedPrice: string | null;
  tiers: PriceTier[];
  recordedAt: string; // дата записи
  previousVersionId: string | null;
}

// ────────────────────────── Продажи и закрытие месяцев ──────────────────────────

export type MonthStatus = 'open' | 'closed';

/**
 * Запись продаж товара в филиале за год-месяц.
 * confirmed=false, qty=null → пустая ячейка (неизвестные данные, в СДП не участвует).
 * confirmed=true, qty=0 → подтверждённые нулевые продажи (участвуют в среднем).
 */
export interface SalesRecord {
  id: string;
  productId: string;
  brandId: string;
  branch: Branch;
  ym: YearMonth;
  qty: number | null;
  status: MonthStatus;
  confirmed: boolean;
  updatedAt: string;
  updatedBy: string;
}

/** Средние дневные продажи (СДП). unknown ≠ 0. */
export interface AvgDailySales {
  known: boolean;
  value: number | null; // шт/день
  monthsCounted: number;
  monthsTotal: number; // сколько месяцев в окне (обычно 12)
  sumQty: number;
}

/**
 * СДП = (сумма продаж по учтённым закрытым подтверждённым месяцам окна / количество учтённых месяцев) / 30.
 * Ноль в закрытом месяце участвует; пустая (неподтверждённая) — нет.
 */
export function calcADS(
  records: SalesRecord[],
  windowMonths: YearMonth[],
): AvgDailySales {
  const win = new Set(windowMonths);
  let sum = 0;
  let counted = 0;
  for (const r of records) {
    if (!win.has(r.ym)) continue;
    if (r.status !== 'closed' || !r.confirmed) continue;
    if (r.qty === null) continue; // пустая ячейка — неизвестные данные
    sum += r.qty;
    counted++;
  }
  if (counted === 0) {
    return { known: false, value: null, monthsCounted: 0, monthsTotal: windowMonths.length, sumQty: 0 };
  }
  return {
    known: true,
    value: sum / counted / 30,
    monthsCounted: counted,
    monthsTotal: windowMonths.length,
    sumQty: sum,
  };
}

// ────────────────────────── Остатки из 1С ──────────────────────────

/**
 * Фактический остаток — снимок из 1С. Система НИКОГДА не прибавляет поступления к фактическому остатку автоматически.
 */
export interface StockSnapshot {
  id: string;
  productId: string;
  brandId: string;
  branch: Branch;
  qty: number; // ≥ 0
  asOf: string; // ISO datetime — дата/время актуальности
  source: 'manual' | 'excel' | 'restore';
  createdAt: string;
  createdBy: string;
}

// ────────────────────────── Логистика / даты ──────────────────────────

/** Базовые сроки логистического цикла (календарных дней), редактируются глобально для бренда. */
export interface LeadTimes {
  prepDays: number; // подготовка/сборка: выход = оформление + 30
  toVLKDays: number; // Корея → Владивосток: ВЛК = выход + 60
  vlkToMSKDays: number; // ВЛК → Москва: МСК = ВЛК + 20
}

export const DEFAULT_LEAD_TIMES: LeadTimes = { prepDays: 30, toVLKDays: 60, vlkToMSKDays: 20 };

export const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  const d = new Date(toDateOnly(iso).getTime() + days * DAY_MS);
  return toDateISO(d);
}

/** Нормализация даты к полуночи локального времени (работа только с календарными днями). */
export function toDateOnly(iso: string): Date {
  const s = iso.length <= 10 ? `${iso}T00:00:00` : iso;
  const d = new Date(s);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function toDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO(): string {
  return toDateISO(new Date());
}

/** Целое число календарных дней from→to (может быть отрицательным). */
export function diffDays(fromIso: string, toIso: string): number {
  return Math.round((toDateOnly(toIso).getTime() - toDateOnly(fromIso).getTime()) / DAY_MS);
}

/** Плановые даты заказа по срокам (с индивидуальными переопределениями). */
export function computeOrderDates(
  issueDate: string,
  lt: LeadTimes,
  overrides: Partial<{ exitDate: string; vlkDate: string; mskDate: string }>,
): { exitDate: string; vlkDate: string; mskDate: string } {
  const exit = overrides.exitDate ?? addDays(issueDate, lt.prepDays);
  const vlk = overrides.vlkDate ?? addDays(exit, lt.toVLKDays);
  const msk = overrides.mskDate ?? addDays(vlk, lt.vlkToMSKDays);
  return { exitDate: exit, vlkDate: vlk, mskDate: msk };
}

// ────────────────────────── Заказы и поставки ──────────────────────────

export type OrderStatus =
  | 'draft' // черновик
  | 'approved' // оформлен/утверждён
  | 'preparing' // на подготовке
  | 'in_transit' // в пути (после подтверждения выхода из Кореи)
  | 'partial' // частично поступила (целиком по одному филиалу)
  | 'completed' // полностью поступила
  | 'cancelled'; // отменён

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  draft: 'Черновик',
  approved: 'Оформлен / утверждён',
  preparing: 'На подготовке',
  in_transit: 'В пути',
  partial: 'Частично поступила',
  completed: 'Полностью поступила',
  cancelled: 'Отменён',
};

export interface BranchAllocation {
  qty: number; // шт (≥0)
  received: boolean; // поступление отмечается ТОЛЬКО целиком по филиалу
  actualArrivalDate: string | null; // фактическая дата прибытия филиала
}

export interface OrderLine {
  productId: string;
  barcode: string;
  name: string;
  qtyVLK: number; // ручной ввод в единицах товара
  qtyMSK: number;
  packSize: number; // кратность на момент расчёта
  unitPrice: string; // применяемая цена за единицу (десятичная строка)
  priceTierUsed: PriceTier | null;
  currency: Currency;
}

/** Неизменяемый снимок, создаваемый при утверждении заказа. */
export interface ApprovedSnapshot {
  takenAt: string;
  brandId: string;
  issueDate: string;
  exitDate: string;
  vlkDate: string;
  mskDate: string;
  leadTimes: LeadTimes;
  currency: Currency;
  rates: ExchangeRates;
  lines: Array<{
    productId: string;
    barcode: string;
    article: string;
    name: string;
    qtyVLK: number;
    qtyMSK: number;
    boxesVLK: number;
    boxesMSK: number;
    packSize: number;
    unitPrice: string;
    priceMode: PriceMode;
    tiers: PriceTier[];
    lineTotal: string;
  }>;
  ads: Record<string, Record<Branch, number | null>>; // productId → branch → СДП
  stock: Record<string, Record<Branch, { qty: number; asOf: string }>>; // productId → branch → остаток и его дата
  expectedShipments: Array<{ orderId: string; label: string; vlkDate: string; mskDate: string }>;
  totals: { primary: string; rub: string; usd: string; krw: string };
}

export interface PurchaseOrder {
  id: string;
  brandId: string;
  number: string;
  status: OrderStatus;
  issueDate: string; // дата оформления
  exitDate: string; // плановая дата выхода из Кореи (едина для всей поставки)
  vlkDate: string; // плановая дата прибытия ВЛК
  mskDate: string; // плановая дата прибытия МСК
  leadTimesOverride: Partial<LeadTimes> | null; // индивидуальные сроки для заказа
  currency: Currency;
  ratesAtApproval: ExchangeRates | null;
  lines: OrderLine[];
  allocations: Record<string, Record<Branch, BranchAllocation>>; // productId → branch
  snapshot: ApprovedSnapshot | null;
  actualExitConfirmedAt: string | null; // подтверждение выхода из Кореи
  copiedFromOrderId: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export const orderTotalQty = (line: OrderLine): number => line.qtyVLK + line.qtyMSK;

export const boxesFor = (qty: number, packSize: number): number =>
  packSize > 0 ? qty / packSize : 0;

export function isPackMultiple(qty: number, packSize: number): boolean {
  if (packSize <= 0) return false;
  return Math.abs(qty % packSize) < 1e-9;
}

// ────────────────────────── Валюты / настройки ──────────────────────────

export interface ExchangeRates {
  usdRub: string; // 1 USD = 85 RUB (по умолчанию)
  krwRub: string; // 1 KRW = 0.063 RUB (по умолчанию)
}

export const DEFAULT_RATES: ExchangeRates = { usdRub: '85', krwRub: '0.063' };

export interface Settings {
  id: 'global';
  rates: ExchangeRates;
  defaultTargetTZMonths: number; // целевой ТЗ в месяцах (по умолчанию 3)
  backupRemindDays: number; // напоминание о бэкапе (7 дней)
  lastBackupAt: string | null;
  appVersion: string;
}

export interface BrandSettings {
  id: string; // = brandId
  name: string;
  leadTimes: LeadTimes;
  tzMinMonths: number; // норматив ТЗ: 2
  tzMaxMonths: number; // 5
  targetTZMonths: number; // рекомендация: 3
}

export const DEFAULT_BRAND_SETTINGS: Omit<BrandSettings, 'id' | 'name'> = {
  leadTimes: DEFAULT_LEAD_TIMES,
  tzMinMonths: 2,
  tzMaxMonths: 5,
  targetTZMonths: 3,
};

export interface AuditEntry {
  id: string;
  at: string; // ISO datetime
  actor: string; // «оператор»
  entity: string; // 'product' | 'sales' | 'stock' | 'order' | 'shipment' | 'settings' | ...
  entityId: string;
  action: string; // 'create' | 'update' | 'close-month' | 'open-month' | 'approve' | 'receive' | 'correct' | ...
  details: string;
  before?: unknown;
  after?: unknown;
}

// ────────────────────────── Десятичная арифметика денег ──────────────────────────
// Денежные суммы хранятся как десятичные СТРОКИ; арифметика — через целые числа мантисс,
// без накопления ошибок float.

export interface Dec {
  m: bigint; // мантисса
  e: number; // экспонента: значение = m * 10^(-e), e ≥ 0
}

export function decFromString(s: string): Dec {
  const str = s.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) throw new Error(`Некорректное десятичное число: "${s}"`);
  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = match[2];
  const fracPart = match[3] ?? '';
  const m = sign * BigInt(intPart + fracPart);
  return { m, e: fracPart.length };
}

function decAlign(a: Dec, b: Dec): [bigint, bigint, number] {
  const e = Math.max(a.e, b.e);
  const am = a.m * 10n ** BigInt(e - a.e);
  const bm = b.m * 10n ** BigInt(e - b.e);
  return [am, bm, e];
}

export function decAdd(a: Dec, b: Dec): Dec {
  const [am, bm, e] = decAlign(a, b);
  return { m: am + bm, e };
}

export function decMul(a: Dec, b: Dec): Dec {
  return { m: a.m * b.m, e: a.e + b.e };
}

/** Деление с округлением до `scale` знаков после запятой (banker rounding не требуется — half-up). */
export function decDiv(a: Dec, b: Dec, scale = 6): Dec {
  if (b.m === 0n) throw new Error('Деление на ноль');
  const num = a.m * 10n ** BigInt(scale + b.e);
  const den = b.m * 10n ** BigInt(a.e);
  let q = num / den;
  const r = num % den;
  // half-up по модулю остатка
  if (den !== 0n && (r < 0n ? -r : r) * 2n >= (den < 0n ? -den : den)) {
    q += q < 0n ? -1n : 1n;
  }
  return { m: q, e: scale };
}

export function decRound(a: Dec, scale: number): Dec {
  if (a.e <= scale) {
    return { m: a.m * 10n ** BigInt(scale - a.e), e: scale };
  }
  return decDiv(a, { m: 1n, e: 0 }, scale);
}

export function decToString(a: Dec, scale?: number): string {
  if (scale !== undefined) {
    const x = decRound(a, scale);
    return formatDec(x.m, x.e); // с фиксированным числом знаков, без нормализации
  }
  const x = normalizeDec(a);
  return formatDec(x.m, x.e);
}

function formatDec(m: bigint, e: number): string {
  const neg = m < 0n;
  let digits = (neg ? -m : m).toString();
  if (e === 0) return `${neg ? '-' : ''}${digits}`;
  while (digits.length <= e) digits = '0' + digits;
  const intPart = digits.slice(0, digits.length - e);
  const fracPart = digits.slice(digits.length - e);
  return `${neg ? '-' : ''}${intPart}.${fracPart}`;
}

function normalizeDec(a: Dec): Dec {
  let m = a.m;
  let e = a.e;
  while (e > 0 && m % 10n === 0n) {
    m /= 10n;
    e--;
  }
  return { m, e };
}

export function decimalCmp(a: string, b: string): number {
  const da = decFromString(a);
  const db = decFromString(b);
  const [am, bm] = decAlign(da, db);
  return am < bm ? -1 : am > bm ? 1 : 0;
}

/** Округление ВВЕРХ до целого (для коробок). */
export function ceilNum(x: number): number {
  return Math.ceil(x - 1e-9);
}

// ────────────────────────── Расчёт сумм позиции/заказа ──────────────────────────

export interface LineCalc {
  productId: string;
  qtyVLK: number;
  qtyMSK: number;
  qtyTotal: number;
  boxesVLK: number;
  boxesMSK: number;
  boxesTotal: number;
  packOk: boolean; // обе части кратны коробке
  pricePerUnit: string | null;
  priceError: string | null; // напр. «нет подходящей ступени»
  tier: PriceTier | null;
  sumVLK: string; // в валюте прайса
  sumMSK: string;
  sumTotal: string;
}

export function calcLine(product: Product, qtyVLK: number, qtyMSK: number): LineCalc {
  const base: LineCalc = {
    productId: product.id,
    qtyVLK,
    qtyMSK,
    qtyTotal: qtyVLK + qtyMSK,
    boxesVLK: boxesFor(qtyVLK, product.packSize),
    boxesMSK: boxesFor(qtyMSK, product.packSize),
    boxesTotal: 0,
    packOk: true,
    pricePerUnit: null,
    priceError: null,
    tier: null,
    sumVLK: '0',
    sumMSK: '0',
    sumTotal: '0',
  };
  base.boxesTotal = base.boxesVLK + base.boxesMSK;
  base.packOk = isPackMultiple(qtyVLK, product.packSize) && isPackMultiple(qtyMSK, product.packSize);

  let price: string | null = null;
  let tier: PriceTier | null = null;
  if (product.priceMode === 'fixed') {
    if (!product.fixedPrice || decimalCmp(product.fixedPrice, '0') <= 0) {
      base.priceError = 'Не задана фиксированная цена (> 0)';
    } else price = product.fixedPrice;
  } else {
    if (qtyVLK + qtyMSK > 0) {
      if (!base.packOk || !Number.isInteger(base.boxesTotal)) {
        base.priceError = 'Количество не кратно коробке — нельзя определить общее число коробок для ступени';
      } else {
        const t = pickTier(product.tiers, base.boxesTotal);
        if (!t) {
          base.priceError = `Нет подходящей ценовой ступени для ${base.boxesTotal} коробок`;
        } else {
          tier = t;
          price = t.pricePerUnit;
        }
      }
    } else {
      price = '0';
    }
  }
  base.pricePerUnit = price;
  base.tier = tier;
  if (price !== null) {
    const p = decFromString(price);
    base.sumVLK = decToString(decMul(p, decFromString(String(qtyVLK))), 2);
    base.sumMSK = decToString(decMul(p, decFromString(String(qtyMSK))), 2);
    base.sumTotal = decToString(
      decAdd(decFromString(base.sumVLK), decFromString(base.sumMSK)),
      2,
    );
  }
  return base;
}

export interface OrderTotals {
  currency: Currency;
  primary: string; // сумма в валюте прайса
  rub: string;
  usd: string;
  krw: string;
}

/** Конвертация основной суммы в RUB/USD/KRW согласно правилам валют. */
export function convertTotals(primary: string, currency: Currency, rates: ExchangeRates): OrderTotals {
  const usdRub = decFromString(rates.usdRub);
  const krwRub = decFromString(rates.krwRub);
  const p = decFromString(primary);
  let rub: Dec;
  let usd: Dec;
  let krw: Dec;
  if (currency === 'KRW') {
    rub = decMul(p, krwRub);
    usd = decDiv(rub, usdRub, 4);
    krw = p;
  } else {
    rub = decMul(p, usdRub);
    krw = decDiv(rub, krwRub, 4);
    usd = p;
  }
  return {
    currency,
    primary: decToString(p, 2),
    rub: decToString(rub, 2),
    usd: decToString(usd, 2),
    krw: decToString(krw, 2),
  };
}

export function calcOrderTotals(
  lines: LineCalc[],
  currency: Currency,
  rates: ExchangeRates,
): OrderTotals {
  let acc = decFromString('0');
  for (const l of lines) {
    if (l.priceError) continue; // позиция с ошибкой цены не участвует (блокирует утверждение)
    acc = decAdd(acc, decFromString(l.sumTotal));
  }
  return convertTotals(decToString(acc), currency, rates);
}

// ────────────────────────── Хронологический прогноз ──────────────────────────

export type Reliability = 'ok' | 'no_ads' | 'stale_stock' | 'overdue_arrival';

export interface ForecastEvent {
  date: string; // ISO — дата события (прибытие)
  qty: number; // суммарное поступление в этот день
  orders: string[]; // id заказов/поставок
  overdue: boolean; // дата прошла без подтверждения прибытия
}

export interface ForecastSegment {
  from: string;
  to: string;
  startStock: number; // остаток ПОСЛЕ предыдущего события (или фактический)
  consumed: number; // min(startStock, ADS*Δ)
  endBeforeArrival: number; // MAX(0; start − ADS*Δ)
  arrival: number; // qty события
  endAfterArrival: number; // endBefore + arrival
  deficitStart: string | null; // дата достижения нуля внутри интервала
  gapDays: number; // дней отсутствия товара до прихода
}

export interface Arrival {
  date: string; // дата прибытия данного филиала (план или факт ещё ожидаемых)
  qty: number;
  orderId: string;
  includeInForecast: boolean;
  received: boolean;
  dueBefore?: string; // учитывать только события ДО этой даты (для планирования нового заказа)
}

export interface ForecastResult {
  ok: boolean;
  reliability: Reliability;
  messages: string[];
  adsKnown: boolean;
  ads: number | null;
  startStock: number;
  startStockDate: string | null;
  horizonEnd: string;
  segments: ForecastSegment[];
  firstDeficitDate: string | null;
  currentStockAfterAll: number;
  overdueOrders: string[];
}

/**
 * Хронологический расчёт прогноза по филиалу:
 *  - старт от последнего АКТУАЛЬНОГО фактического остатка и его даты;
 *  - все ещё ожидаемые поступления (включая заказы на подготовке), сортировка по дате прибытия филиала;
 *  - несколько поступлений в один день суммируются;
 *  - на каждом интервале Δ: ОстатокДО = MAX(0; ОстатокПОСЛЕпредыдущего − СДП×Δ); ОстатокПОСЛЕ = ДО + поступление;
 *  - отрицательные значения не сохраняются, неудовлетворённый спрос НЕ переносится.
 */
export function buildForecast(params: {
  ads: AvgDailySales;
  stockQty: number | null;
  stockAsOf: string | null;
  stockStale: boolean; // есть подтверждённое поступление позже даты снимка → остатки из 1С не обновлены
  arrivals: Arrival[];
  now: string; // текущая дата (ISO)
  horizonDays?: number;
}): ForecastResult {
  const horizonDays = params.horizonDays ?? 365;
  const messages: string[] = [];
  const adsKnown = params.ads.known;
  const adsVal = params.ads.value;

  if (params.stockQty === null || params.stockAsOf === null) {
    return {
      ok: false, reliability: 'stale_stock', messages: ['Нет данных об остатках из 1С'],
      adsKnown, ads: adsVal, startStock: 0, startStockDate: null,
      horizonEnd: addDays(params.now, horizonDays), segments: [], firstDeficitDate: null,
      currentStockAfterAll: 0, overdueOrders: [],
    };
  }
  if (params.stockStale) {
    messages.push('Ожидается обновление остатков из 1С — прогноз неактуален, утверждение заказа заблокировано');
  }
  if (!adsKnown) {
    messages.push('СДП неизвестна (нет подтверждённых закрытых месяцев) — прогноз нерассчитываем');
  }

  // группировка поступлений по датам
  // Правила:
  //  - поступления, уже отмеченные «получено» по филиалу, НЕ прибавляются к фактическому остатку
  //    автоматически; они отражаются только через новый снимок 1С (stockStale блокирует утверждение).
  //  - просроченные (дата прошла без подтверждения) не считаются полученными; прогноз требует актуализации.
  //  - dueBefore: для планирования нового заказа учитываются только события СТРОГО РАНЬШЕ даты его прихода.
  const byDate = new Map<string, { qty: number; orders: string[]; overdue: boolean }>();
  const overdueOrders: string[] = [];
  for (const a of params.arrivals) {
    if (!a.includeInForecast || a.received) continue;
    // «только события ДО соответствующей даты»: поступление позже или одновременно с приходом
    // планируемого заказа не учитывается в прогнозе ДО этого заказа
    if (a.dueBefore && diffDays(a.dueBefore, a.date) > 0) continue;
    const overdue = diffDays(params.now, a.date) < 0; // дата прошла без подтверждения прибытия
    if (overdue) {
      if (!overdueOrders.includes(a.orderId)) {
        overdueOrders.push(a.orderId);
        messages.push(`Поставка ${a.orderId}: дата прибытия ${a.date} просрочена — уточните дату или отметьте прибытие`);
      }
      continue; // просроченное не считается полученным и не участвует в достоверном прогнозе
    }
    const cur = byDate.get(a.date) ?? { qty: 0, orders: [], overdue: false };
    cur.qty += a.qty;
    if (!cur.orders.includes(a.orderId)) cur.orders.push(a.orderId);
    byDate.set(a.date, cur);
  }

  const events: ForecastEvent[] = [...byDate.entries()]
    .map(([date, v]) => ({ date, qty: v.qty, orders: v.orders, overdue: v.overdue }))
    .filter((e) => diffDays(params.stockAsOf!, e.date) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const horizonEnd = addDays(maxISO(params.stockAsOf, params.now), horizonDays);
  // Горизонт расчёта не должен «перескакивать» учтённые события — иначе они потеряются:
  // расширяем горизонт до последнего события.
  if (events.length) {
    const lastEvent = events[events.length - 1].date;
    if (diffDays(horizonEnd, lastEvent) >= 0) {
      return buildForecast({ ...params, horizonDays: diffDays(maxISO(params.stockAsOf, params.now), lastEvent) + horizonDays });
    }
  }

  const segments: ForecastSegment[] = [];
  let stock = params.stockQty;
  let cursor = params.stockAsOf;
  let firstDeficit: string | null = null;

  const step = (to: string, arrival: number, eventId: string[]) => {
    const delta = Math.max(0, diffDays(cursor, to));
    let endBefore = stock;
    let deficitStart: string | null = null;
    let gapDays = 0;
    if (adsKnown && adsVal !== null && adsVal > 0) {
      // время исчерпания = доступный остаток / СДП; дата достижения нуля
      const depletionDays = stock / adsVal;
      const wholeDays = Math.floor(depletionDays + 1e-9);
      const zeroDate = addDays(cursor, wholeDays);
      if (depletionDays <= delta + 1e-9) {
        endBefore = 0;
        deficitStart = zeroDate; // если остаток уже ноль — дефицит с даты начала интервала
        if (arrival > 0) gapDays = Math.max(0, diffDays(zeroDate, to));
        if (firstDeficit === null) firstDeficit = zeroDate;
      } else {
        endBefore = stock - adsVal * delta;
      }
    } else if (!adsKnown) {
      endBefore = stock; // нерассчитываемый прогноз: потребление неизвестно
    }
    const consumed = stock - endBefore;
    const endAfter = endBefore + arrival;
    segments.push({
      from: cursor, to, startStock: stock, consumed, endBeforeArrival: endBefore,
      arrival, endAfterArrival: endAfter, deficitStart, gapDays,
    });
    stock = endAfter;
    cursor = to;
    void eventId;
  };

  for (const e of events) step(e.date, e.qty, e.orders);
  step(horizonEnd, 0, []);

  const reliability: Reliability = params.stockStale
    ? 'stale_stock'
    : !adsKnown
      ? 'no_ads'
      : overdueOrders.length > 0
        ? 'overdue_arrival'
        : 'ok';

  return {
    ok: reliability === 'ok',
    reliability,
    messages,
    adsKnown,
    ads: adsVal,
    startStock: params.stockQty,
    startStockDate: params.stockAsOf,
    horizonEnd,
    segments,
    firstDeficitDate: firstDeficit,
    currentStockAfterAll: stock,
    overdueOrders,
  };
}

function isFuture(dateIso: string, nowIso: string): boolean {
  return diffDays(nowIso, dateIso) >= 0;
}

function maxISO(a: string, b: string): string {
  return toDateOnly(a).getTime() >= toDateOnly(b).getTime() ? toDateISO(toDateOnly(a)) : toDateISO(toDateOnly(b));
}

// ────────────────────────── Текущий ТЗ и планирование ──────────────────────────

/**
 * Текущий ТЗ в месяцах = фактический остаток / СДП / 30.
 * СДП=0 (подтверждена) → 'none' («нет потребления»); неизвестна → 'unknown' («нет данных»). На ноль не делим.
 */
export type CoverageValue =
  | { kind: 'months'; months: number }
  | { kind: 'none' }
  | { kind: 'unknown' };

export function coverageMonths(stock: number | null, ads: AvgDailySales): CoverageValue {
  if (stock === null) return { kind: 'unknown' };
  if (!ads.known) return { kind: 'unknown' };
  if (ads.value === 0) return { kind: 'none' };
  return { kind: 'months', months: stock / ads.value / 30 };
}

export type TZLevel = 'red' | 'orange' | 'green' | 'gray';

export function tzLevel(cov: CoverageValue, min: number, max: number): TZLevel {
  if (cov.kind !== 'months') return 'gray';
  if (cov.months < min) return 'red';
  if (cov.months > max) return 'orange';
  return 'green';
}

/**
 * Рекомендуемый объём для целевого ТЗ: MAX(0; целевойТЗ × СДП × 30 − прогнозДО), округлить ВВЕРХ до полной коробки.
 * forecastBefore — прогноз непосредственно перед приходом нового заказа (без собственного поступления).
 */
export function recommendOrderQty(
  forecastBefore: number,
  ads: AvgDailySales,
  targetMonths: number,
  packSize: number,
): number | null {
  if (!ads.known || packSize <= 0) return null;
  const need = targetMonths * (ads.value ?? 0) * 30 - forecastBefore;
  if (need <= 0) return 0;
  return ceilNum(need / packSize) * packSize;
}

/**
 * Прогноз после заказа по филиалу = прогноз непосредственно перед приходом + ручное количество заказа.
 * Новый черновик НЕ удваивает собственное поступление.
 */
export function coverageAfterOrder(forecastBefore: number, orderQty: number, ads: AvgDailySales): CoverageValue {
  return coverageMonths(forecastBefore + orderQty, ads);
}

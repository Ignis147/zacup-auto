// ===== Единое расчётное ядро приложения «Заказник» =====
// Все формулы бизнес-логики находятся только здесь. Компоненты интерфейса
// не должны дублировать расчёты.

import type {
  Branch, Brand, Settings, Product, SalesRecord, PeriodStatus,
  StockSnapshot, Supply, PriceTier, Currency,
} from './types';

export const BRANCHES: Branch[] = ['vld', 'msk'];
export const BRANCH_NAMES: Record<Branch, string> = { vld: 'Владивосток', msk: 'Москва' };

const DAY_MS = 86400000;

// ---------- Даты ----------

/** ISO yyyy-mm-dd из Date (локальное время) */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Целое число дней от даты a до даты b (b - a). Может быть отрицательным. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / DAY_MS);
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function todayISO(): string {
  return toISODate(new Date());
}

/** Период "YYYY-MM" для даты */
export function periodOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Рабочее окно анализа — последние N календарных месяцев (включая текущий), от новых к старым */
export function lastPeriods(count: number, refDate?: string): string[] {
  const ref = refDate ? parseISODate(refDate) : new Date();
  const res: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
    res.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return res;
}

/** Число дней в месяце периода */
export function daysInPeriod(period: string): number {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// ---------- Логистика ----------

export interface LogisticsDays {
  orderPrep: number; // оформление и сборка в Корее
  shipVld: number;   // Корея -> Владивосток
  extraMsk: number;  // дополнительная доставка до Москвы
}

/** Эффективные сроки логистики: значения бренда переопределяют общие настройки */
export function effectiveLogistics(brand: Brand | null, settings: Settings): LogisticsDays {
  return {
    orderPrep: brand?.orderPrepDays ?? settings.orderPrepDays,
    shipVld: brand?.shipVldDays ?? settings.shipVldDays,
    extraMsk: brand?.extraMskDays ?? settings.extraMskDays,
  };
}

export interface PlannedDates {
  departDate: string;
  vldDate: string;
  mskDate: string;
}

/** Плановые даты поставки от даты оформления */
export function plannedDatesFromOrder(orderDate: string, lg: LogisticsDays): PlannedDates {
  const depart = addDays(orderDate, lg.orderPrep);
  return {
    departDate: depart,
    vldDate: addDays(depart, lg.shipVld),
    mskDate: addDays(depart, lg.shipVld + lg.extraMsk),
  };
}

/** Полные сроки от оформления до филиала (дней) */
export function totalLeadDays(lg: LogisticsDays): { vld: number; msk: number } {
  return { vld: lg.orderPrep + lg.shipVld, msk: lg.orderPrep + lg.shipVld + lg.extraMsk };
}

// ---------- СДП (средняя дневная потребность) ----------

export type SdpResult =
  | { kind: 'nodata' }                    // нет ни одного достоверного закрытого периода
  | { kind: 'value'; sdp: number; monthsUsed: number; avgMonthly: number };

/**
 * СДП = среднее арифметическое продаж по ЗАКРЫТЫМ месяцам с введёнными данными / 30.
 * Текущий незакрытый месяц не используется. Пустые ячейки (null) игнорируются,
 * подтверждённые нули учитываются.
 */
export function calcSdp(
  sales: SalesRecord[],
  closedPeriodsByBranch: Record<Branch, Set<string>>,
  productId: number,
  branch: Branch,
): SdpResult {
  const closed = closedPeriodsByBranch[branch];
  const vals: number[] = [];
  for (const s of sales) {
    if (s.productId === productId && s.branch === branch && s.qty !== null && closed.has(s.period)) {
      vals.push(s.qty);
    }
  }
  if (vals.length === 0) return { kind: 'nodata' };
  const sum = vals.reduce((a, b) => a + b, 0);
  const avgMonthly = sum / vals.length;
  return { kind: 'value', sdp: avgMonthly / 30, monthsUsed: vals.length, avgMonthly };
}

/** Карта закрытых периодов по филиалам для бренда */
export function buildClosedMap(periods: PeriodStatus[], brandId: number): Record<Branch, Set<string>> {
  const map: Record<Branch, Set<string>> = { vld: new Set(), msk: new Set() };
  for (const p of periods) {
    if (p.brandId === brandId && p.closed) map[p.branch].add(p.period);
  }
  return map;
}

// ---------- Товарный запас ----------

export type StockMonthsResult =
  | { kind: 'nodata' }       // «Нет данных» — СДП неизвестна
  | { kind: 'noconsumption' } // «Нет расхода» — СДП = 0
  | { kind: 'value'; months: number };

/** ТЗ = остаток / СДП / 30 (месяцы). Деления на ноль нет. */
export function calcStockMonths(stock: number, sdp: number | null): StockMonthsResult {
  if (sdp === null) return { kind: 'nodata' };
  if (sdp === 0) return { kind: 'noconsumption' };
  return { kind: 'value', months: stock / sdp / 30 };
}

export function formatStockMonths(r: StockMonthsResult): string {
  if (r.kind === 'nodata') return 'Нет данных';
  if (r.kind === 'noconsumption') return 'Нет расхода';
  return fmtNum(r.months, 1);
}

// ---------- Кратность и коробки ----------

export function boxesFor(qty: number, packSize: number): number {
  if (!packSize || packSize <= 0) return NaN;
  return qty / packSize;
}

/** true — количество кратно packSize */
export function isMultiple(qty: number, packSize: number): boolean {
  if (!Number.isFinite(qty) || !Number.isFinite(packSize) || packSize <= 0) return false;
  return Math.abs(qty % packSize) < 1e-9;
}

/** Округление вверх до целого числа коробок */
export function roundUpToPack(qty: number, packSize: number): number {
  if (!packSize || packSize <= 0) return qty;
  return Math.ceil(qty / packSize) * packSize;
}

// ---------- Цены ----------

/** Применяемая цена за штуку при общем количестве коробок товара (оба филиала вместе) */
export function appliedPrice(product: Product, totalBoxes: number): number | null {
  if (product.priceKind === 'fixed') {
    return typeof product.fixedPrice === 'number' ? product.fixedPrice : null;
  }
  const tiers = [...(product.tiers || [])].sort((a, b) => a.minBoxes - b.minBoxes);
  if (tiers.length === 0) return null;
  let best: PriceTier | null = null;
  for (const t of tiers) {
    if (totalBoxes >= t.minBoxes) best = t;
  }
  // Если меньше первой ступени — применяем первую (от 1 коробки)
  return best ? best.price : tiers[0].minBoxes <= 1 ? tiers[0].price : null;
}

/** Изменение цены в процентах между двумя простыми ценами */
export function priceChangePct(oldPrice: number | undefined | null, newPrice: number | undefined | null): number | null {
  if (typeof oldPrice !== 'number' || typeof newPrice !== 'number' || oldPrice === 0) return null;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

// ---------- Валюты ----------

export interface Rates { usdRub: number; krwRub: number }

/** Пересчёт суммы из валюты прайса в RUB и USD */
export function convert(sum: number, currency: Currency, rates: Rates): { rub: number; usd: number; krw: number } {
  let rub: number;
  if (currency === 'KRW') rub = sum * rates.krwRub;
  else rub = sum * rates.usdRub; // USD
  const usd = rub / rates.usdRub;
  const krw = rub / rates.krwRub;
  return { rub, usd, krw };
}

// ---------- Форматирование ----------

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

// ---------- Прогноз остатков ----------

export interface ReceiptEvent {
  date: string;        // дата поступления (факт или план)
  qty: number;         // количество
  supplyId: number;
  supplyNumber: string;
  productId: number;   // товар события
  overdue: boolean;    // плановая дата в прошлом и факт не подтверждён
}

export interface ForecastPoint {
  date: string;
  beforeReceipt: number; // остаток перед поступлением (>= 0)
  receiptQty: number;
  afterReceipt: number;  // остаток после поступления
  depletedBefore: boolean; // товар закончился до этого поступления
  stockoutDays: number;    // дней без товара на этом интервале
}

export interface ForecastResult {
  startStock: number;
  startSdp: number | null;    // null = нет данных
  points: ForecastPoint[];
  depletionDate: string | null; // предполагаемая дата исчерпания (если до первого поступления)
  minStock: number;             // минимальный прогнозный остаток
  hasShortage: boolean;         // был ли дефицит хотя бы на одном интервале
  totalStockoutDays: number;
  /** Остаток непосредственно перед заданной датой (дата прибытия нового заказа) */
  stockAtDate: (date: string) => number;
  /** Прогнозный остаток сразу после указанной даты поступления (с учётом событий до неё включительно) */
  stockAfterIncoming: number;
}

/**
 * Построение прогнозного остатка по филиалу.
 *
 * @param asOfDate   дата снимка остатков (отправная точка прогноза)
 * @param startStock остаток на дату asOfDate
 * @param sdp        средняя дневная потребность (null = нет данных → прогноз не строится)
 * @param receipts   события поступления (уже отсортированные по дате; см. collectReceipts)
 * @param horizonEnd конечная дата горизонта прогноза
 *
 * Формула: MAX(0, предыдущий остаток − СДП × дни) + поступившее количество.
 * Отрицательных остатков нет; упущенные продажи не переносятся в будущее.
 */
export function buildForecast(
  asOfDate: string,
  startStock: number,
  sdp: number | null,
  receipts: ReceiptEvent[],
  horizonEnd: string,
): ForecastResult {
  const sorted = [...receipts].filter((r) => r.date >= asOfDate && r.qty > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const points: ForecastPoint[] = [];
  let stock = Math.max(0, startStock);
  let depletionDate: string | null = null;
  let minStock = stock;
  let hasShortage = false;
  let totalStockoutDays = 0;
  const effSdp = sdp ?? 0;

  let prevDate = asOfDate;
  for (const r of sorted) {
    const days = Math.max(0, daysBetween(prevDate, r.date));
    const consumed = effSdp * days;
    const before = Math.max(0, stock - consumed);
    const depleted = stock - consumed < -1e-9;
    if (depleted) {
      hasShortage = true;
      const daysWithStock = stock / (effSdp || 1);
      const stockoutDays = Math.max(0, days - daysWithStock);
      totalStockoutDays += stockoutDays;
      if (!depletionDate) depletionDate = addDays(prevDate, Math.floor(daysWithStock));
    }
    const after = before + r.qty;
    points.push({
      date: r.date, beforeReceipt: before, receiptQty: r.qty, afterReceipt: after,
      depletedBefore: depleted, stockoutDays: depleted ? Math.round(days - stock / (effSdp || 1)) : 0,
    });
    stock = after;
    minStock = Math.min(minStock, before);
    prevDate = r.date;
  }
  // хвостовой интервал до конца горизонта
  {
    const days = Math.max(0, daysBetween(prevDate, horizonEnd));
    const consumed = effSdp * days;
    if (stock - consumed < -1e-9 && days > 0) {
      hasShortage = true;
      const daysWithStock = stock / (effSdp || 1);
      totalStockoutDays += Math.max(0, days - daysWithStock);
      if (!depletionDate) depletionDate = addDays(prevDate, Math.floor(daysWithStock));
    }
  }

  const stockAtDate = (date: string): number => {
    // остаток непосредственно перед поступлениями этой даты, с учётом всех событий раньше
    let s = Math.max(0, startStock);
    let prev = asOfDate;
    for (const r of sorted) {
      if (r.date >= date) break;
      const days = Math.max(0, daysBetween(prev, r.date));
      s = Math.max(0, s - effSdp * days) + r.qty;
      prev = r.date;
    }
    if (prev < date) {
      const days = Math.max(0, daysBetween(prev, date));
      s = Math.max(0, s - effSdp * days);
    }
    return s;
  };

  // остаток сразу после всех поступлений, прибывающих НЕ ПОЗЖЕ horizonEnd
  const lastPoint = points.length ? points[points.length - 1] : null;
  let stockAfterIncoming: number;
  if (lastPoint && lastPoint.date <= horizonEnd) {
    // если после последней точки до horizonEnd есть интервал — учтём потребление? Нет:
    // «прогноз перед новым поступлением» = остаток непосредственно перед датой нового заказа.
    stockAfterIncoming = stockAtDate(horizonEnd);
    // но если поступления ровно на horizonEnd — они ещё не применены в stockAtDate (строго <), добавим их
    const sameDayQty = sorted.filter((r) => r.date === horizonEnd).reduce((a, r) => a + r.qty, 0);
    // stockAtDate(horizonEnd) уже включает все поступления с датой < horizonEnd.
    // Для планирования нового заказа нужно: остатки до НОВОГО заказа = поступления строго раньше.
    void sameDayQty;
  } else {
    stockAfterIncoming = stockAtDate(horizonEnd);
  }

  return {
    startStock: Math.max(0, startStock),
    startSdp: sdp,
    points, depletionDate, minStock, hasShortage, totalStockoutDays,
    stockAtDate, stockAfterIncoming,
  };
}

/**
 * Сбор событий поступлений по филиалу с защитой от двойного учёта.
 *
 * @param supplies        активные поставки бренда
 * @param branch          филиал
 * @param snapshotDate    дата снимка остатков
 * @param receiptsIncluded подтверждено ли, что полученные поставки уже учтены в остатках
 *
 * Правила:
 * - Полученная часть (receivedQty) исключается из ожидаемого поступления всегда.
 * - Если receiptsIncluded=true, полностью полученные ДО даты снимка поставки не учитываются
 *   (они уже в остатке). Если false — факт поступления отражён отдельно, и в прогноз
 *   попадает только неожидаемая часть; уже полученные количества в прогноз не включаются.
 * - Просроченные (план в прошлом, факт не подтверждён) помечаются overdue и показываются отдельно.
 */
export function collectReceipts(supplies: Supply[], branch: Branch, snapshotDate: string, receiptsIncluded: boolean): ReceiptEvent[] {
  const events: ReceiptEvent[] = [];
  for (const sup of supplies) {
    if (sup.status === 'cancelled') continue;
    for (const it of sup.items) {
      const expected = branch === 'vld' ? it.vldQty : it.mskQty;
      const received = branch === 'vld' ? it.vldReceived : it.mskReceived;
      const actualDate = branch === 'vld' ? it.vldActualDate : it.mskActualDate;
      const plannedDate = branch === 'vld' ? sup.vldPlannedDate : sup.mskPlannedDate;
      const remaining = Math.max(0, expected - received);
      if (remaining <= 0) {
        // полностью получено: учитываем как поступление только если оно НЕ отражено в снимке остатков
        if (!receiptsIncluded && actualDate && actualDate > snapshotDate) {
          events.push({ date: actualDate, qty: received, supplyId: sup.id!, supplyNumber: sup.number, productId: it.productId, overdue: false });
        }
        continue;
      }
      if (actualDate && received > 0) {
        // частичное поступление: оставшаяся часть идёт по плану
        events.push({ date: plannedDate, qty: remaining, supplyId: sup.id!, supplyNumber: sup.number, productId: it.productId, overdue: plannedDate < todayISO() });
      } else {
        events.push({ date: plannedDate, qty: remaining, supplyId: sup.id!, supplyNumber: sup.number, productId: it.productId, overdue: plannedDate < todayISO() });
      }
    }
  }
  // суммируем поступления с одинаковой датой (хронологический порядок задаёт buildForecast)
  const byDate = new Map<string, ReceiptEvent>();
  for (const e of events) {
    const ex = byDate.get(e.date);
    if (ex) {
      ex.qty += e.qty;
      ex.overdue = ex.overdue || e.overdue;
    } else {
      byDate.set(e.date, { ...e });
    }
  }
  return [...byDate.values()];
}

// ---------- Распределение между филиалами ----------

/**
 * Перераспределение: при изменении одного филиала второй автоматически уменьшается,
 * общее количество сохраняется. Значения не могут выйти за [0, total].
 */
export function redistribute(total: number, vld: number, msk: number, changedBranch: Branch, newValue: number): { vld: number; msk: number } {
  const nv = Math.max(0, Math.min(total, Math.round(newValue)));
  if (changedBranch === 'vld') return { vld: nv, msk: total - nv };
  return { vld: total - nv, msk: nv };
}

// ---------- Планирование нового заказа ----------

export interface OrderPlanInput {
  sdp: number | null;
  forecastStockBefore: number;   // прогнозный остаток перед новым поступлением (из buildForecast.stockAtDate)
  packSize: number;
  targetMonths: number;          // целевой запас (месяцы)
}

export interface OrderPlanResult {
  needed: number | null;         // необходимое количество единиц (без округления), null если данных нет
  recommended: number | null;    // округлённое вверх до коробок
  reason?: 'nodata' | 'noconsumption';
}

/**
 * Рекомендуемое количество = MAX(0, целевой запас × 30 × СДП − прогноз перед поступлением),
 * округляется вверх до целого числа коробок. Отдельно для каждого филиала.
 */
export function recommendOrder(inp: OrderPlanInput): OrderPlanResult {
  if (inp.sdp === null) return { needed: null, recommended: null, reason: 'nodata' };
  if (inp.sdp === 0) return { needed: null, recommended: null, reason: 'noconsumption' };
  const need = Math.max(0, inp.targetMonths * 30 * inp.sdp - inp.forecastStockBefore);
  if (need <= 1e-9) return { needed: 0, recommended: 0 };
  return { needed: need, recommended: roundUpToPack(need, inp.packSize) };
}

/** Статус товарного запаса относительно границ нормы */
export type StockZone = 'red' | 'ok' | 'orange' | 'nodata' | 'noconsumption';

export function stockZone(months: StockMonthsResult, minM: number, maxM: number): StockZone {
  if (months.kind === 'nodata') return 'nodata';
  if (months.kind === 'noconsumption') return 'noconsumption';
  const v = months.months;
  if (v < minM) return 'red';
  if (v > maxM) return 'orange';
  return 'ok';
}

// ---------- Стоимость строк заказа ----------

export interface LineCalc {
  totalQty: number;
  totalBoxes: number;
  vldBoxes: number;
  mskBoxes: number;
  appliedPrice: number | null;
  vldSum: number;
  mskSum: number;
  totalSum: number;
  packOk: boolean;               // общее количество кратно
  vldPackOk: boolean;
  mskPackOk: boolean;
}

/** Расчёт коробок/цен/сумм для строки плана заказа */
export function calcOrderLine(product: Product, vldQty: number, mskQty: number): LineCalc {
  const totalQty = vldQty + mskQty;
  const ps = product.packSize > 0 ? product.packSize : 1;
  const totalBoxes = boxesFor(totalQty, product.packSize);
  const price = totalQty > 0 ? appliedPrice(product, Math.floor(totalBoxes + 1e-9)) : appliedPrice(product, 0);
  const vldSum = vldQty * (price ?? 0);
  const mskSum = mskQty * (price ?? 0);
  return {
    totalQty,
    totalBoxes,
    vldBoxes: boxesFor(vldQty, product.packSize),
    mskBoxes: boxesFor(mskQty, product.packSize),
    appliedPrice: price,
    vldSum, mskSum, totalSum: vldSum + mskSum,
    packOk: totalQty === 0 || isMultiple(totalQty, product.packSize),
    vldPackOk: vldQty === 0 || isMultiple(vldQty, product.packSize),
    mskPackOk: mskQty === 0 || isMultiple(mskQty, product.packSize),
  };
}

// ---------- Помощь с остатками ----------

export function stockValue(stocks: Map<number, StockSnapshot>, productId: number, branch: Branch): { qty: number | null; asOfDate: string | null } {
  const s = stocks.get(productId);
  if (!s) return { qty: null, asOfDate: null };
  return { qty: branch === 'vld' ? s.vld : s.msk, asOfDate: s.asOfDate };
}

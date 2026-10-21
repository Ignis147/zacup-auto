/**
 * Сервис сборки данных для расчётного ядра (мост «IndexedDB → core»).
 * UI-слой и планирование используют ТОЛЬКО эти интерфейсы доступа к данным.
 */
import { db } from '../db/database';
import type { ProductRow, PurchaseOrderRow, SalesRow, StockRow } from '../db/schema';
import { isStockStale } from '../db/repos/stock';
import {
  BRANCHES, calcADS, lastMonthsWindow, buildForecast,
  type Arrival, type AvgDailySales, type Branch, type ForecastResult, type YearMonth,
} from '../core/types';

export interface ProductBundle {
  product: ProductRow;
  sales: SalesRow[];
  stock: Record<Branch, StockRow | undefined>;
  ads: Record<Branch, AvgDailySales>;
  stale: Record<Branch, boolean>;
}

/** Собрать по бренду всё необходимое для расчётов одним вызовом. */
export async function loadBrandBundle(brandId: string, asOfDate: Date = new Date(), monthsWindow = 12): Promise<ProductBundle[]> {
  const products = await db.products.where('brandId').equals(brandId).toArray();
  const [salesAll, stockAll] = await Promise.all([
    db.sales.where('brandId').equals(brandId).toArray(),
    db.stock.where('brandId').equals(brandId).toArray(),
  ]);
  const window = lastMonthsWindow(asOfDate, monthsWindow);
  const out: ProductBundle[] = [];
  for (const p of products) {
    const sales = salesAll.filter((s) => s.productId === p.id);
    const stock = {} as Record<Branch, StockRow | undefined>;
    const ads = {} as Record<Branch, AvgDailySales>;
    const stale = {} as Record<Branch, boolean>;
    for (const br of BRANCHES) {
      const rows = stockAll.filter((s) => s.productId === p.id && s.branch === br).sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
      stock[br] = rows[rows.length - 1];
      ads[br] = calcADS(sales.filter((s) => s.branch === br), window);
      stale[br] = (await isStockStale(p.id, br)).stale;
    }
    out.push({ product: p, sales, stock, ads, stale });
  }
  return out;
}

/**
 * Ожидаемые поступления филиала из всех активных заказов бренда (§9: каждый оформленный заказ — ровно один раз).
 *  - approved/preparing/in_transit/partial учитываются; completed/cancelled/draft — нет;
 *  - полученные филиальные части исключаются из ожидаемых (§11);
 *  - дата прибытия филиала: план заказа (или override по поставке).
 */
export function arrivalsFromOrders(orders: PurchaseOrderRow[], branch: Branch, excludeOrderId?: string): Arrival[] {
  const res: Arrival[] = [];
  for (const o of orders) {
    if (!['approved', 'preparing', 'in_transit', 'partial'].includes(o.status)) continue;
    if (o.id === excludeOrderId) continue; // новый черновик не удваивает собственное поступление (§14)
    for (const l of o.lines) {
      const a = o.allocations[l.productId]?.[branch];
      if (!a || a.qty <= 0 || a.received) continue;
      res.push({
        date: a.expectedArrivalDate ?? (branch === 'VLK' ? o.vlkDate : o.mskDate),
        qty: a.qty,
        orderId: o.id,
        includeInForecast: true,
        received: false,
      });
    }
  }
  return res;
}

/** Прогноз по товару/филиалу с актуальными данными из базы. */
export async function forecastForProduct(
  productId: string, branch: Branch, opts: { now?: string; excludeOrderId?: string; dueBefore?: string } = {},
): Promise<ForecastResult> {
  const p = await db.products.get(productId);
  if (!p) throw new Error('Товар не найден');
  const now = opts.now ?? new Date().toISOString().slice(0, 10);
  const [sales, orders] = await Promise.all([
    db.sales.where('productId').equals(productId).toArray(),
    db.orders.where('brandId').equals(p.brandId).toArray(),
  ]);
  const ads = calcADS(sales.filter((s) => s.branch === branch), lastMonthsWindow(new Date(now)));
  const stockRows = (await db.stock.where('productId').equals(productId).toArray())
    .filter((s) => s.branch === branch).sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
  const snap = stockRows[stockRows.length - 1];
  const { stale } = await isStockStale(productId, branch);
  const arrivals = arrivalsFromOrders(orders, branch, opts.excludeOrderId);
  if (opts.dueBefore) for (const a of arrivals) a.dueBefore = opts.dueBefore;
  return buildForecast({
    ads,
    stockQty: snap?.qty ?? null,
    stockAsOf: snap ? snap.asOf.slice(0, 10) : null,
    stockStale: stale,
    arrivals,
    now,
  });
}

/** Окно закрытых месяцев для отображения в таблице (последние N летних месяцев от даты). */
export function displayMonths(now: Date, count = 12): YearMonth[] {
  return lastMonthsWindow(now, count);
}

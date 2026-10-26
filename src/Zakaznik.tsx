// ===== Главный экран «Заказник»: товарная матрица, остатки, прогноз, планирование заказа =====
import { useMemo, useState } from 'react';
import type {
  Brand, Product, SalesRecord, PeriodStatus, StockSnapshot, Supply, Settings,
  PriceHistoryEntry, FixedOrder, OrderLine, Branch, PriceTier,
} from './types';
import { db, articleFromBarcode, isBarcodeTaken } from './db';
import {
  BRANCHES, calcSdp, buildClosedMap, calcStockMonths, formatStockMonths,
  collectReceipts, buildForecast, calcOrderLine, recommendOrder, stockZone, convert,
  fmtNum, fmtMoney, fmtDate, todayISO, addDays, effectiveLogistics, lastPeriods,
  priceChangePct, type ReceiptEvent, type SdpResult, type ForecastResult, type StockMonthsResult,
} from './calc';
import { NumCell, TextCell } from './ui';
import { parseClipboard, parseCellNumber } from './io';

export interface RowData {
  product: Product;
  sdpVld: SdpResult;
  sdpMsk: SdpResult;
  stock: StockSnapshot | undefined;
  receiptsVld: ReceiptEvent[];
  receiptsMsk: ReceiptEvent[];
  forecastVld: ForecastResult;
  forecastMsk: ForecastResult;
  tzVld: StockMonthsResult;
  tzMsk: StockMonthsResult;
  overdueVld: number; // единиц просрочено
  overdueMsk: number;
  incomingVld: number; // в пути (ожидаемые, не просроченные)
  incomingMsk: number;
  nearestVld: string | null;
  nearestMsk: string | null;
}

export function ZakaznikPage({
  brand, products, sales, periods, stocks, supplies, orders, settings, onChanged, onOpenProduct,
}: {
  brand: Brand;
  products: Product[];
  sales: SalesRecord[];
  periods: PeriodStatus[];
  stocks: StockSnapshot[];
  supplies: Supply[];
  orders: FixedOrder[];
  settings: Settings;
  onChanged: () => void;
  onOpenProduct: (productId: number) => void;
}) {
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sortKey, setSortKey] = useState<'name' | 'article' | 'tzVld' | 'tzMsk'>('name');
  const [groups, setGroups] = useState({ price: true, sales: true, stock: true, supply: true, order: true });
  const [orderDate, setOrderDate] = useState(todayISO());
  const [plan, setPlan] = useState<Record<number, { vld: number | null; msk: number | null }>>({});
  const [receiptsIncluded, setReceiptsIncluded] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const lg = effectiveLogistics(brand, settings);
  const minM = brand.minStockMonths ?? settings.minStockMonths;
  const maxM = brand.maxStockMonths ?? settings.maxStockMonths;
  const targetM = brand.targetStockMonths ?? settings.targetStockMonths;

  const closedMap = useMemo(() => buildClosedMap(periods, brand.id!), [periods, brand.id]);
  const brandSales = useMemo(() => sales.filter((s) => s.brandId === brand.id), [sales, brand.id]);
  const stockMap = useMemo(() => new Map(stocks.filter((s) => s.brandId === brand.id).map((s) => [s.productId, s])), [stocks, brand.id]);
  const brandSupplies = useMemo(
    () => supplies.filter((s) => s.brandId === brand.id && s.status !== 'cancelled'),
    [supplies, brand.id],
  );

  // Дата прибытия нового заказа
  const newVldDate = addDays(orderDate, lg.orderPrep + lg.shipVld);
  const newMskDate = addDays(orderDate, lg.orderPrep + lg.shipVld + lg.extraMsk);

  const rows: RowData[] = useMemo(() => {
    const list = products.filter((p) => !p.archived || showArchived);
    // Привязка строк поставки к товарам строго по productId (внутренний id товара бренда).
    // Дополнительно проверяем принадлежность строки бренду — quantities чужих товаров игнорируются.
    const validProductIds = new Set(list.map((p) => p.id!));
    const scopedSupplies: Supply[] = brandSupplies.map((sup) => ({
      ...sup,
      items: sup.items.filter((it) => typeof it.productId === 'number' && validProductIds.has(it.productId)),
    }));
    return list.map((p) => {
      const sdpVld = calcSdp(brandSales, closedMap, p.id!, 'vld');
      const sdpMsk = calcSdp(brandSales, closedMap, p.id!, 'msk');
      const st = stockMap.get(p.id!);
      const asOf = st?.asOfDate ?? todayISO();
      const startVld = st?.vld ?? 0;
      const startMsk = st?.msk ?? 0;
      // Учитываем ИСКЛЮЧИТЕЛЬНО количество товара с соответствующим productId:
      // ни весь бренд, ни вся поставка целиком в строку не суммируются.
      const rv = collectReceipts(scopedSupplies, 'vld', asOf, receiptsIncluded, p.id!);
      const rm = collectReceipts(scopedSupplies, 'msk', asOf, receiptsIncluded, p.id!);
      // Горизонт — дата нового заказа (или последняя поставка, если она позже)
      const horizonVld = maxDate(newVldDate, lastDate(rv));
      const horizonMsk = maxDate(newMskDate, lastDate(rm));
      const fVld = buildForecast(asOf, startVld, sdpVld.kind === 'value' ? sdpVld.sdp : null, rv, horizonVld);
      const fMsk = buildForecast(asOf, startMsk, sdpMsk.kind === 'value' ? sdpMsk.sdp : null, rm, horizonMsk);
      const tzVld = st ? calcStockMonths(startVld, sdpVld.kind === 'value' ? sdpVld.sdp : null) : { kind: 'nodata' as const };
      const tzMsk = st ? calcStockMonths(startMsk, sdpMsk.kind === 'value' ? sdpMsk.sdp : null) : { kind: 'nodata' as const };
      const t = todayISO();
      const overdueVld = rv.filter((e) => e.overdue).reduce((a, e) => a + e.qty, 0);
      const overdueMsk = rm.filter((e) => e.overdue).reduce((a, e) => a + e.qty, 0);
      const incomingVld = rv.filter((e) => !e.overdue && e.date >= t).reduce((a, e) => a + e.qty, 0);
      const incomingMsk = rm.filter((e) => !e.overdue && e.date >= t).reduce((a, e) => a + e.qty, 0);
      const nearestVld = [...rv].filter((e) => e.date >= asOf).sort((a, b) => (a.date < b.date ? -1 : 1))[0]?.date ?? null;
      const nearestMsk = [...rm].filter((e) => e.date >= asOf).sort((a, b) => (a.date < b.date ? -1 : 1))[0]?.date ?? null;
      return { product: p, sdpVld, sdpMsk, stock: st, receiptsVld: rv, receiptsMsk: rm, forecastVld: fVld, forecastMsk: fMsk, tzVld, tzMsk, overdueVld, overdueMsk, incomingVld, incomingMsk, nearestVld, nearestMsk };
    });
  }, [products, showArchived, brandSales, closedMap, stockMap, brandSupplies, receiptsIncluded, newVldDate, newMskDate]);

  // Итоги «в пути» по бренду: сумма строго по строкам товаров (каждый productId учтён один раз).
  const incomingTotals = useMemo(() => {
    let vld = 0, msk = 0;
    for (const r of rows) { vld += r.incomingVld; msk += r.incomingMsk; }
    return { vld, msk };
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rs = rows;
    if (q) rs = rs.filter((r) => r.product.name.toLowerCase().includes(q) || r.product.barcode.includes(q) || r.product.article.toLowerCase().includes(q));
    const tzVal = (x: StockMonthsResult) => x.kind === 'value' ? x.months : -1;
    rs = [...rs].sort((a, b) => {
      switch (sortKey) {
        case 'article': return a.product.article.localeCompare(b.product.article);
        case 'tzVld': return tzVal(b.tzVld) - tzVal(a.tzVld);
        case 'tzMsk': return tzVal(b.tzMsk) - tzVal(a.tzMsk);
        default: return a.product.name.localeCompare(b.product.name, 'ru');
      }
    });
    return rs;
  }, [rows, search, sortKey]);

  // ===== Изменения данных =====

  async function patchProduct(id: number, patch: Partial<Product>, priceNote?: string) {
    const old = products.find((p) => p.id === id);
    if (!old) return;
    if (patch.packSize !== undefined) {
      const ps = Math.max(1, Math.round(patch.packSize ?? 1));
      patch.packSize = ps;
    }
    // история цен при изменении цены
    const priceChanged =
      (patch.priceKind !== undefined && patch.priceKind !== old.priceKind) ||
      (patch.fixedPrice !== undefined && patch.fixedPrice !== old.fixedPrice) ||
      (patch.tiers !== undefined && JSON.stringify(patch.tiers) !== JSON.stringify(old.tiers));
    if (priceChanged) {
      const entry: PriceHistoryEntry = {
        productId: id, date: new Date().toISOString(),
        oldPriceKind: old.priceKind, oldFixedPrice: old.fixedPrice, oldTiers: old.tiers,
        newPriceKind: patch.priceKind ?? old.priceKind,
        newFixedPrice: patch.fixedPrice !== undefined ? patch.fixedPrice : old.fixedPrice,
        newTiers: patch.tiers !== undefined ? patch.tiers : old.tiers,
        currency: brand.currency, comment: priceNote,
      };
      await db.priceHistory.add(entry);
    }
    if (patch.barcode !== undefined) patch.article = articleFromBarcode(patch.barcode);
    if (patch.barcode !== undefined && patch.barcode.trim() !== old.barcode.trim()) {
      if (await isBarcodeTaken(brand.id!, patch.barcode, id)) {
        setMsg(`Штрихкод ${patch.barcode} уже есть в этом бренде — изменение отменено.`);
        return;
      }
    }
    await db.products.update(id, patch);
    onChanged();
  }

  async function setStock(productId: number, branch: Branch, qty: number | null) {
    const st = stockMap.get(productId);
    const v = Math.max(0, Math.round(qty ?? 0)); // остатки не могут быть отрицательными
    if (st) {
      await db.stocks.update(st.id!, branch === 'vld' ? { vld: v } : { msk: v });
    } else {
      await db.stocks.add({ brandId: brand.id!, productId, vld: branch === 'vld' ? v : 0, msk: branch === 'msk' ? v : 0, asOfDate: todayISO(), receiptsIncluded: true });
    }
    onChanged();
  }

  async function setAsOfDate(productId: number, date: string) {
    const st = stockMap.get(productId);
    if (st) await db.stocks.update(st.id!, { asOfDate: date });
    else await db.stocks.add({ brandId: brand.id!, productId, vld: 0, msk: 0, asOfDate: date, receiptsIncluded: true });
    onChanged();
  }

  /** Массовая вставка остатков/цен: колонки: штрихкод|ВЛД|МСК */
  async function handlePasteStocks(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const grid = parseClipboard(text);
    let n = 0;
    for (const r of grid) {
      const key = (r[0] || '').trim();
      const prod = products.find((p) => p.barcode === key || p.article.toLowerCase() === key.toLowerCase());
      if (!prod) continue;
      const v = parseCellNumber(r[1]); const m = parseCellNumber(r[2]);
      if (v !== null || m !== null) {
        const st = stockMap.get(prod.id!);
        const nv = v !== null ? Math.max(0, Math.round(v)) : (st?.vld ?? 0);
        const nm = m !== null ? Math.max(0, Math.round(m)) : (st?.msk ?? 0);
        if (st) await db.stocks.update(st.id!, { vld: nv, msk: nm, asOfDate: todayISO() });
        else await db.stocks.add({ brandId: brand.id!, productId: prod.id!, vld: nv, msk: nm, asOfDate: todayISO(), receiptsIncluded: true });
        n++;
      }
    }
    setMsg(n > 0 ? `Обновлено остатков: ${n}. Дата актуальности выставлена на сегодня.` : 'Совпадений по штрихкоду/артикулу не найдено.');
    onChanged();
  }

  // ===== План заказа =====

  function planFor(r: RowData) {
    const p = plan[r.product.id!] ?? { vld: null, msk: null };
    return p;
  }

  const planCalcs = useMemo(() => {
    const res: Record<number, ReturnType<typeof calcOrderLine> & { recVld: number | null; recMsk: number | null; fcBeforeVld: number; fcBeforeMsk: number; afterVld: StockMonthsResult; afterMsk: StockMonthsResult }> = {};
    for (const r of rows) {
      const pl = planFor(r);
      const vldQty = Math.max(0, Math.round(pl.vld ?? 0));
      const mskQty = Math.max(0, Math.round(pl.msk ?? 0));
      const c = calcOrderLine(r.product, vldQty, mskQty);
      const sdpV = r.sdpVld.kind === 'value' ? r.sdpVld.sdp : null;
      const sdpM = r.sdpMsk.kind === 'value' ? r.sdpMsk.sdp : null;
      const fcBeforeVld = r.forecastVld.stockAtDate(newVldDate);
      const fcBeforeMsk = r.forecastMsk.stockAtDate(newMskDate);
      const recV = recommendOrder({ sdp: sdpV, forecastStockBefore: fcBeforeVld, packSize: r.product.packSize, targetMonths: targetM }).recommended;
      const recM = recommendOrder({ sdp: sdpM, forecastStockBefore: fcBeforeMsk, packSize: r.product.packSize, targetMonths: targetM }).recommended;
      // прогноз после нового заказа + последующие поставки (перетарка/дефицит предупреждения)
      const afterVld = calcStockMonths(fcBeforeVld + vldQty, sdpV);
      const afterMsk = calcStockMonths(fcBeforeMsk + mskQty, sdpM);
      res[r.product.id!] = { ...c, recVld: recV, recMsk: recM, fcBeforeVld, fcBeforeMsk, afterVld, afterMsk };
    }
    return res;
  }, [rows, plan, targetM, newVldDate, newMskDate]);

  const totals = useMemo(() => {
    let vldSum = 0, mskSum = 0, totalSum = 0, units = 0, boxes = 0;
    for (const r of rows) {
      const c = planCalcs[r.product.id!];
      if (!c) continue;
      vldSum += c.vldSum; mskSum += c.mskSum; totalSum += c.totalSum;
      units += c.totalQty; boxes += Number.isFinite(c.totalBoxes) ? Math.floor(c.totalBoxes + 1e-9) : 0;
    }
    const conv = convert(totalSum, brand.currency, { usdRub: settings.usdRub, krwRub: settings.krwRub });
    return { vldSum, mskSum, totalSum, units, boxes, conv };
  }, [rows, planCalcs, brand.currency, settings]);

  const hasPackErrors = rows.some((r) => { const c = planCalcs[r.product.id!]; return c && (!c.packOk || !c.vldPackOk || !c.mskPackOk) && c.totalQty > 0; });
  const hasPricesMissing = rows.some((r) => { const c = planCalcs[r.product.id!]; return c && c.totalQty > 0 && c.appliedPrice === null; });

  function applyAllRecommendations() {
    const next: typeof plan = {};
    for (const r of rows) {
      const c = planCalcs[r.product.id!];
      if (!c) continue;
      next[r.product.id!] = { vld: c.recVld ?? planFor(r).vld, msk: c.recMsk ?? planFor(r).msk };
    }
    setPlan(next);
  }

  async function fixOrder() {
    const lines: OrderLine[] = [];
    for (const r of rows) {
      const c = planCalcs[r.product.id!];
      if (!c || c.totalQty === 0) continue;
      if (!c.packOk) { alert(`Нарушение кратности у «${r.product.name}». Исправьте перед фиксацией.`); return; }
      if (c.appliedPrice === null) { alert(`У товара «${r.product.name}» не задана цена.`); return; }
      lines.push({
        productId: r.product.id!, name: r.product.name, barcode: r.product.barcode, article: r.product.article,
        packSize: r.product.packSize, vldQty: c.totalQty ? Math.round(planFor(r).vld ?? 0) : 0, mskQty: Math.round(planFor(r).msk ?? 0),
        totalQty: c.totalQty, totalBoxes: Math.floor(c.totalBoxes), appliedPrice: c.appliedPrice,
        vldSum: c.vldSum, mskSum: c.mskSum, totalSum: c.totalSum,
      });
    }
    if (lines.length === 0) { alert('План заказа пуст: введите количества Владивостока и/или Москвы.'); return; }
    const num = `${(brand.id ?? 0)}-${String(orders.filter((o) => o.brandId === brand.id).length + 1).padStart(3, '0')}`;
    const totalSum = lines.reduce((a, l) => a + l.totalSum, 0);
    const conv = convert(totalSum, brand.currency, { usdRub: settings.usdRub, krwRub: settings.krwRub });
    const order: FixedOrder = {
      brandId: brand.id!, number: num, date: orderDate, currency: brand.currency,
      rates: { usdRub: settings.usdRub, krwRub: settings.krwRub },
      lines,
      totalUnits: lines.reduce((a, l) => a + l.totalQty, 0),
      totalBoxes: lines.reduce((a, l) => a + l.totalBoxes, 0),
      totalSum, totalSumRub: conv.rub,
      vldPlannedDate: newVldDate, mskPlannedDate: newMskDate,
      supplyCreated: false,
    };
    await db.orders.add(order);
    setMsg(`Заказ №${num} зафиксирован. Цены и курсы сохранены навсегда. Создайте поставку из него на экране «Поставки».`);
    setPlan({});
    onChanged();
  }

  // ===== Рендер =====

  const colSpan = 4 + (groups.price ? 3 : 0) + (groups.sales ? 4 : 0) + (groups.stock ? 5 : 0) + (groups.supply ? 6 : 0) + (groups.order ? 9 : 0);

  return (
    <div className="page zak-page">
      <div className="card zak-toolbar">
        <div className="row zak-toolbar-row">
          <button className="btn primary" onClick={() => setAddOpen(true)}>＋ Товар</button>
          <div className="field grow zak-search">
            <input placeholder="Поиск: название / штрихкод / артикул" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="field zak-sort">
            <label>Сортировка</label>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as any)}>
              <option value="name">По названию</option>
              <option value="article">По артикулу</option>
              <option value="tzVld">ТЗ ВЛД ↓</option>
              <option value="tzMsk">ТЗ МСК ↓</option>
            </select>
          </div>
          <label className="small zak-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> архив</label>
          <span className="zak-divider" aria-hidden="true" />
          <span className="zak-group-label">Группы колонок:</span>
          {(Object.keys(groups) as (keyof typeof groups)[]).map((g) => (
            <label key={g} className="small zak-chip">
              <input type="checkbox" checked={groups[g]} onChange={(e) => setGroups({ ...groups, [g]: e.target.checked })} />{' '}
              {{ price: 'Цены', sales: 'Продажи', stock: 'Остатки', supply: 'Поставки', order: 'Заказ' }[g]}
            </label>
          ))}
        </div>
        <div className="row zak-toolbar-row">
          <div className="field zak-order-date">
            <label>Дата оформления нового заказа</label>
            <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
          </div>
          <span className="small muted zak-hint">Прибытие: ВЛД {fmtDate(newVldDate)} ({lg.orderPrep + lg.shipVld} дн.) · МСК {fmtDate(newMskDate)} ({lg.orderPrep + lg.shipVld + lg.extraMsk} дн.). Норма ТЗ: {minM}–{maxM} мес., цель {targetM} мес.</span>
          <span className="grow" />
          <label className="small tooltip zak-check">
            <input type="checkbox" checked={receiptsIncluded} onChange={(e) => setReceiptsIncluded(e.target.checked)} /> полученные поставки уже учтены в остатках
            <span className="tip">Снимите flag, если обновили остатки ДО включения в них прибывших поставок — иначе грозит двойной учёт.</span>
          </label>
          <button className="btn" onClick={applyAllRecommendations} title="Заполнить план рекомендованными количествами">Применить рекомендации</button>
          <button className="btn primary" onClick={fixOrder}>📌 Зафиксировать заказ</button>
        </div>
        {msg && <div className="small ok-soft zak-msg">{msg} <button className="btn small" onClick={() => setMsg(null)}>×</button></div>}
        {hasPackErrors && <div className="err small zak-msg">⚠ Есть нарушения кратности (красные ячейки). quantities не будут исправлены автоматически — исправьте вручную.</div>}
        {hasPricesMissing && <div className="err small zak-msg">⚠ У товаров с ненулевым заказом отсутствует цена — фиксация невозможна до заполнения.</div>}
      </div>

      <div className="tbl-scroll zak-scroll" onPaste={handlePasteStocks}>
        <table className="grid zak-table">
          <thead>
            <tr className="zak-group-row">
              <th colSpan={4} className="colgroup zak-gn zak-f1">Номенклатура</th>
              {groups.price && <th colSpan={3} className="colgroup zak-gp zak-f4">Закупочная цена</th>}
              {groups.sales && <th colSpan={4} className="colgroup zak-gs">Продажи и СДП</th>}
              {groups.stock && <th colSpan={5} className="colgroup zak-gt">Остатки и ТЗ</th>}
              {groups.supply && <th colSpan={6} className="colgroup zak-gt2">Поставки в пути</th>}
              {groups.order && <th colSpan={9} className="colgroup zak-go">Планируемый заказ</th>}
            </tr>
            <tr className="zak-head-row">
              <th className="zak-f1 zak-sticky-col">Штрихкод</th><th className="zak-f2 zak-sticky-col">Артикул</th><th className="zak-f3 zak-sticky-col zak-th-name">Наименование</th><th className="zak-f4 zak-sticky-col zak-th-pack">Кратность</th>
              {groups.price && <><th>Тип</th><th>Цена/ступени</th><th className="num">Примен. цена</th></>}
              {groups.sales && <><th className="num">СДП ВЛД</th><th className="num">мес. ВЛД</th><th className="num">СДП МСК</th><th className="num">мес. МСК</th></>}
              {groups.stock && <><th className="num">Ост. ВЛД</th><th className="num">Ост. МСК</th><th>Дата</th><th className="num">ТЗ ВЛД</th><th className="num">ТЗ МСК</th></>}
              {groups.supply && <><th className="num">В пути ВЛД</th><th>Ближ. ВЛД</th><th className="num">В пути МСК</th><th>Ближ. МСК</th><th className="num">Прогноз ВЛД к дате заказа</th><th className="num">Прогноз МСК к дате заказа</th></>}
              {groups.order && <><th className="num">Заказ ВЛД</th><th className="num">Корп. ВЛД</th><th className="num">Сумма ВЛД</th><th className="num">Заказ МСК</th><th className="num">Корп. МСК</th><th className="num">Сумма МСК</th><th className="num">Всего</th><th className="num">ТЗ после ВЛД / МСК</th><th className="num">Рекоменд.</th></>}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => {
              const p = r.product;
              const c = planCalcs[p.id!];
              const pl = planFor(r);
              const zoneV = stockZone(r.tzVld, minM, maxM);
              const zoneM = stockZone(r.tzMsk, minM, maxM);
              const afterZoneV = c ? stockZone(c.afterVld, minM, maxM) : 'nodata';
              const afterZoneM = c ? stockZone(c.afterMsk, minM, maxM) : 'nodata';
              const shortageV = r.forecastVld.hasShortage || (c ? c.fcBeforeVld <= 0 && (pl.vld ?? 0) === 0 && r.sdpVld.kind === 'value' && r.sdpVld.sdp > 0 : false);
              const shortageM = r.forecastMsk.hasShortage;
              const priceLabel = p.priceKind === 'fixed'
                ? `${fmtNum(p.fixedPrice ?? null)} ${brand.currency}/шт`
                : (p.tiers ?? []).map((t) => `от ${t.minBoxes}кор → ${fmtNum(t.price)}`).join(' · ') || '—';
              return (
                <tr key={p.id} className={p.archived ? 'zak-archived' : undefined}>
                  <td className="sticky-col zak-sticky-col zak-f1">{p.barcode}</td>
                  <td className="zak-sticky-col zak-f2 zak-art">{p.article}</td>
                  <td className="zak-sticky-col zak-f3 zak-name">
                    <a href="#" onClick={(e) => { e.preventDefault(); onOpenProduct(p.id!); }} title="Открыть карточку: продажи по месяцам, история цен, участие в поставках">
                      {p.name}{p.archived && <span className="badge archived"> архив</span>}
                    </a>
                  </td>
                  <td className="num zak-f4" style={{ width: 60 }}><NumCell value={p.packSize} onCommit={(v) => patchProduct(p.id!, { packSize: v ?? 1 })} min={1} /></td>

                  {groups.price && <>
                    <td className="small">{p.priceKind === 'fixed' ? 'Фикс.' : 'Ступенч.'}
                      <button className="btn small" style={{ marginLeft: 4 }} onClick={() => onOpenProduct(p.id!)} title="Настроить тип и ступени цены">✎</button>
                    </td>
                    <td className="small" title={priceLabel}>{priceLabel.length > 30 ? priceLabel.slice(0, 28) + '…' : priceLabel}</td>
                    <td className="num">{c && c.totalQty > 0 ? `${fmtNum(c.appliedPrice)} ${brand.currency}` : (p.priceKind === 'fixed' ? `${fmtNum(p.fixedPrice ?? null)}` : '—')}</td>
                  </>}

                  {groups.sales && <>
                    <td className="num">{r.sdpVld.kind === 'value' ? fmtNum(r.sdpVld.sdp, 2) : <span className="warn-nodata">Нет данных</span>}</td>
                    <td className="num small">{r.sdpVld.kind === 'value' ? r.sdpVld.monthsUsed : '—'}</td>
                    <td className="num">{r.sdpMsk.kind === 'value' ? fmtNum(r.sdpMsk.sdp, 2) : <span className="warn-nodata">Нет данных</span>}</td>
                    <td className="num small">{r.sdpMsk.kind === 'value' ? r.sdpMsk.monthsUsed : '—'}</td>
                  </>}

                  {groups.stock && <>
                    <td className="num" style={{ width: 70 }}><NumCell value={r.stock?.vld ?? null} onCommit={(v) => setStock(p.id!, 'vld', v)} min={0} placeholder="—" /></td>
                    <td className="num" style={{ width: 70 }}><NumCell value={r.stock?.msk ?? null} onCommit={(v) => setStock(p.id!, 'msk', v)} min={0} placeholder="—" /></td>
                    <td className="small" style={{ width: 100 }}>
                      <input type="date" value={r.stock?.asOfDate ?? ''} onChange={(e) => setAsOfDate(p.id!, e.target.value)} style={{ width: '100%', border: '1px solid transparent', background: 'transparent', font: 'inherit' }} />
                    </td>
                    <td className={`num ${zoneClass(zoneV)}`} title={zoneTitle(zoneV, minM, maxM)}>{formatStockMonths(r.tzVld)}</td>
                    <td className={`num ${zoneClass(zoneM)}`} title={zoneTitle(zoneM, minM, maxM)}>{formatStockMonths(r.tzMsk)}</td>
                  </>}

                  {groups.supply && <>
                    <td className={`num ${r.overdueVld > 0 ? 'warn-cell' : ''}`}>{fmtNum(r.incomingVld)}{r.overdueVld > 0 && <div className="small overdue">просрочено {fmtNum(r.overdueVld)}</div>}</td>
                    <td className="small">{r.nearestVld ? fmtDate(r.nearestVld) : '—'}</td>
                    <td className={`num ${r.overdueMsk > 0 ? 'warn-cell' : ''}`}>{fmtNum(r.incomingMsk)}{r.overdueMsk > 0 && <div className="small overdue">просрочено {fmtNum(r.overdueMsk)}</div>}</td>
                    <td className="small">{r.nearestMsk ? fmtDate(r.nearestMsk) : '—'}</td>
                    <td className={`num ${shortageV ? 'warn-cell' : ''}`} title={r.forecastVld.depletionDate ? `Исчерпание: ${fmtDate(r.forecastVld.depletionDate)}${r.forecastVld.totalStockoutDays > 0 ? ` · ${Math.round(r.forecastVld.totalStockoutDays)} дн. без товара` : ''}` : undefined}>
                      {r.sdpVld.kind === 'nodata' ? 'Нет данных' : fmtNum(Math.round(r.forecastVld.stockAtDate(newVldDate)))}
                      {shortageV && <div className="small overdue">⚠ дефицит</div>}
                    </td>
                    <td className={`num ${shortageM ? 'warn-cell' : ''}`} title={r.forecastMsk.depletionDate ? `Исчерпание: ${fmtDate(r.forecastMsk.depletionDate)}` : undefined}>
                      {r.sdpMsk.kind === 'nodata' ? 'Нет данных' : fmtNum(Math.round(r.forecastMsk.stockAtDate(newMskDate)))}
                      {shortageM && <div className="small overdue">⚠ дефицит</div>}
                    </td>
                  </>}

                  {groups.order && <>
                    <td className={`num ${c && (pl.vld ?? 0) > 0 && !c.vldPackOk ? 'warn-cell' : ''}`} style={{ width: 74 }} title={c && (pl.vld ?? 0) > 0 && !c.vldPackOk ? `Не кратно ${p.packSize}` : `Рекоменд.: ${c?.recVld ?? '—'}`}>
                      <NumCell value={pl.vld} onCommit={(v) => setPlan({ ...plan, [p.id!]: { ...pl, vld: v } })} min={0} />
                    </td>
                    <td className="num small">{c && (pl.vld ?? 0) > 0 ? fmtNum(c.vldBoxes, Number.isInteger(c.vldBoxes) ? 0 : 2) : '—'}</td>
                    <td className="num small">{c && c.vldSum > 0 ? fmtNum(c.vldSum) : '—'}</td>
                    <td className={`num ${c && (pl.msk ?? 0) > 0 && !c.mskPackOk ? 'warn-cell' : ''}`} style={{ width: 74 }} title={c && (pl.msk ?? 0) > 0 && !c.mskPackOk ? `Не кратно ${p.packSize}` : `Рекоменд.: ${c?.recMsk ?? '—'}`}>
                      <NumCell value={pl.msk} onCommit={(v) => setPlan({ ...plan, [p.id!]: { ...pl, msk: v } })} min={0} />
                    </td>
                    <td className="num small">{c && (pl.msk ?? 0) > 0 ? fmtNum(c.mskBoxes, Number.isInteger(c.mskBoxes) ? 0 : 2) : '—'}</td>
                    <td className="num small">{c && c.mskSum > 0 ? fmtNum(c.mskSum) : '—'}</td>
                    <td className={`num ${c && c.totalQty > 0 && !c.packOk ? 'warn-cell' : ''}`} title={c && c.totalQty > 0 && !c.packOk ? `Общее количество ${c.totalQty} не кратно ${p.packSize}. Автокоррекция не выполняется.` : undefined}>
                      {c ? fmtNum(c.totalQty) : '—'}
                      {c && c.totalBoxes > 0 && <span className="small muted"> ({fmtNum(c.totalBoxes, Number.isInteger(c.totalBoxes) ? 0 : 2)} кор.)</span>}
                    </td>
                    <td className={`num small ${afterZoneV !== 'ok' && afterZoneV !== 'nodata' && (pl.vld ?? 0) > 0 ? zoneClass(afterZoneV) : ''} ${(afterZoneM !== 'ok' && afterZoneM !== 'nodata' && (pl.msk ?? 0) > 0) ? zoneClass(afterZoneM) : ''}`}>
                      {(pl.vld ?? 0) > 0 || (pl.msk ?? 0) > 0 ? `${formatStockMonths(c!.afterVld)} / ${formatStockMonths(c!.afterMsk)}` : '—'}
                    </td>
                    <td className="num small">{c && (c.recVld || c.recMsk) ? `${c.recVld || 0} / ${c.recMsk || 0}` : (r.sdpVld.kind === 'nodata' && r.sdpMsk.kind === 'nodata' ? 'нет данных' : '0 / 0')}</td>
                  </>}
                </tr>
              );
            })}
            {filteredRows.length === 0 && <tr><td colSpan={colSpan} className="muted">Нет товаров. Добавьте номенклатуру кнопкой «＋ Товар».</td></tr>}
          </tbody>
          <tfoot>
            <tr className="zak-total-row">
              <td colSpan={4 + (groups.price ? 3 : 0) + (groups.sales ? 4 : 0) + (groups.stock ? 5 : 0)} className="num zak-totals-label"><b>ИТОГО</b></td>
              {groups.supply && <>
                <td className="num"><b>{fmtNum(incomingTotals.vld)}</b></td>
                <td className="num"></td>
                <td className="num"><b>{fmtNum(incomingTotals.msk)}</b></td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num"></td>
              </>}
              {groups.order && <>
                <td className="num"><b>{fmtNum(rows.reduce((a, r) => a + Math.max(0, Math.round(planFor(r).vld ?? 0)), 0))}</b></td>
                <td className="num"></td>
                <td className="num"><b>{fmtNum(totals.vldSum)}</b></td>
                <td className="num"><b>{fmtNum(rows.reduce((a, r) => a + Math.max(0, Math.round(planFor(r).msk ?? 0)), 0))}</b></td>
                <td className="num"></td>
                <td className="num"><b>{fmtNum(totals.mskSum)}</b></td>
                <td className="num"><b>{fmtNum(totals.units)} шт · {fmtNum(totals.boxes)} кор.</b></td>
                <td className="num"><b>{fmtNum(totals.totalSum)} {brand.currency}</b></td>
                <td className="num small">≈ {fmtMoney(totals.conv.rub)} ₽ · {fmtMoney(brand.currency === 'KRW' ? totals.conv.usd : totals.conv.krw)} {brand.currency === 'KRW' ? 'USD' : 'KRW'}</td>
              </>}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="small muted zak-footer-note" style={{ marginTop: 6 }}>
        Курсы: 1 USD = {settings.usdRub} ₽, 1 KRW = {settings.krwRub} ₽ (обновлены {fmtDate(settings.ratesUpdatedAt)}).
        Клик по названию товара открывает карточку: продажи по месяцам обоих филиалов, история цен, участие в поставках.
        Ctrl+V в таблице — массовая вставка остатков: колонки «штрихкод · ВЛД · МСК».
      </div>

      {addOpen && <AddProductDialog brandId={brand.id!} onClose={() => setAddOpen(false)} onDone={onChanged} />}
    </div>
  );
}

function zoneClass(z: string): string {
  switch (z) {
    case 'red': return 'warn-cell';
    case 'orange': return 'warn-orange';
    case 'ok': return 'warn-ok';
    case 'nodata': return 'warn-nodata';
    default: return '';
  }
}

function zoneTitle(z: string, minM: number, maxM: number): string {
  switch (z) {
    case 'red': return `Ниже нормы (< ${minM} мес.)`;
    case 'orange': return `Выше нормы (> ${maxM} мес.)`;
    case 'ok': return `В норме (${minM}–${maxM} мес.)`;
    case 'nodata': return 'Недостаточно данных для расчёта';
    case 'noconsumption': return 'Нет расхода (СДП = 0)';
    default: return '';
  }
}

function maxDate(a: string, b: string | null): string {
  if (!b) return a;
  return a > b ? a : b;
}
function lastDate(events: ReceiptEvent[]): string | null {
  if (!events.length) return null;
  return events.map((e) => e.date).sort()[events.length - 1];
}

// ===== Диалог добавления товара (+ массовая вставка) =====

function AddProductDialog({ brandId, onClose, onDone }: { brandId: number; onClose: () => void; onDone: () => void }) {
  const [barcode, setBarcode] = useState('');
  const [name, setName] = useState('');
  const [packSize, setPackSize] = useState('24');
  const [price, setPrice] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [err, setErr] = useState('');

  async function addOne() {
    setErr('');
    const bc = barcode.trim();
    if (!bc) { setErr('Укажите штрихкод'); return; }
    if (!/^\d+$/.test(bc)) { setErr('Штрихкод должен содержать только цифры (хранится как строка, ведущие нули сохраняются)'); return; }
    const ps = parseInt(packSize, 10);
    if (!(ps > 0)) { setErr('Кратность должна быть положительным целым числом'); return; }
    if (await isBarcodeTaken(brandId, bc)) { setErr('Такой штрихкод уже есть в бренде'); return; }
    const pr = price.trim() === '' ? undefined : Number(price.replace(',', '.'));
    await db.products.add({
      brandId, barcode: bc, article: articleFromBarcode(bc), name: name.trim() || bc,
      packSize: ps, priceKind: 'fixed', fixedPrice: pr, archived: false,
    });
    setBarcode(''); setName(''); setPrice('');
    onDone();
  }

  async function addBulk() {
    setErr('');
    const grid = parseClipboard(bulkText);
    if (grid.length === 0) { setErr('Вставьте данные из Excel: штрихкод · наименование · кратность · цена'); return; }
    let added = 0, skipped: string[] = [];
    for (const r of grid) {
      const bc = (r[0] || '').trim();
      if (!bc || !/^\d+$/.test(bc)) { skipped.push(`строка «${r[0] ?? ''}» — некорректный штрихкод`); continue; }
      const ps = Math.max(1, parseInt(r[2] || '1', 10) || 1);
      const pr = r[3] !== undefined && r[3].trim() !== '' ? parseCellNumber(r[3]) : null;
      if (await isBarcodeTaken(brandId, bc)) { skipped.push(`${bc} — уже существует`); continue; }
      await db.products.add({
        brandId, barcode: bc, article: articleFromBarcode(bc), name: (r[1] || '').trim() || bc,
        packSize: ps, priceKind: 'fixed', fixedPrice: pr ?? undefined, archived: false,
      });
      added++;
    }
    setErr(skipped.length ? `Добавлено ${added}, пропущено: ${skipped.join('; ')}` : '');
    if (added) { setBulkText(''); onDone(); }
  }

  return (
    <dialog open>
      <h3>Добавить товар</h3>
      <div className="row">
        <div className="field"><label>Штрихкод *</label><input value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="например 0880123456789" /></div>
        <div className="field grow"><label>Наименование</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field" style={{ width: 90 }}><label>Кратность *</label><input type="number" min={1} value={packSize} onChange={(e) => setPackSize(e.target.value)} /></div>
        <div className="field" style={{ width: 120 }}><label>Цена, {`KRW/USD`}</label><input value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        <button className="btn primary" onClick={addOne} style={{ alignSelf: 'flex-end' }}>Добавить</button>
      </div>
      <div className="small muted">Артикул рассчитается автоматически: последние 6 символов штрихкода → <b>{articleFromBarcode(barcode) || '——————'}</b></div>

      <h3 style={{ marginTop: 14 }}>Массовая вставка из Excel</h3>
      <textarea rows={5} style={{ width: '100%' }} placeholder={'Штрихкод\tНаименование\tКратность\tЦена\n8801234567890\tКрем\t24\t1200'}
        value={bulkText} onChange={(e) => setBulkText(e.target.value)} />
      <div className="row" style={{ marginTop: 6 }}>
        <span className="small muted">Колонки: штрихкод, наименование, кратность, цена. Лишние колонки игнорируются.</span>
        <span className="grow" />
        <button className="btn" onClick={addBulk} disabled={!bulkText.trim()}>Добавить список</button>
      </div>

      {err && <div className="err small" style={{ marginTop: 6 }}>⚠ {err}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Готово</button>
      </div>
    </dialog>
  );
}

// ===== Карточка товара (история продаж, цены, поставки) =====

export function ProductDetail({
  product, brand, sales, periods, priceHistory, supplies, products, settings, onClose, onChanged,
}: {
  product: Product;
  brand: Brand;
  sales: SalesRecord[];
  periods: PeriodStatus[];
  priceHistory: PriceHistoryEntry[];
  supplies: Supply[];
  products: Product[];
  settings: Settings;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'sales' | 'price' | 'supplies'>('sales');
  const closedMap = useMemo(() => buildClosedMap(periods, brand.id!), [periods, brand.id]);
  const win = useMemo(() => lastPeriods(18), []);
  const prodSales = useMemo(() => sales.filter((s) => s.productId === product.id), [sales, product.id]);

  async function editField(patch: Partial<Product>) {
    if (patch.barcode !== undefined) {
      if (await isBarcodeTaken(brand.id!, patch.barcode, product.id)) { alert('Штрихкод уже используется в этом бренде'); return; }
      patch.article = articleFromBarcode(patch.barcode);
    }
    await db.products.update(product.id!, patch);
    onChanged();
  }

  async function savePrice(kind: 'fixed' | 'tiered', fixedPrice?: number, tiers?: PriceTier[], comment?: string) {
    await patchProductWithHistory(product, kind, brand.currency, fixedPrice, tiers, comment);
    onChanged();
  }

  return (
    <dialog open>
      <h3>{product.name} <span className="muted small">арт. {product.article}</span></h3>
      <div className="row">
        <div className="field"><label>Штрихкод</label><TextCell value={product.barcode} onCommit={(v) => editField({ barcode: v })} /></div>
        <div className="field"><label>Артикул (авто)</label><input value={product.article} disabled style={{ background: '#eef1f5' }} /></div>
        <div className="field grow"><label>Наименование</label><TextCell value={product.name} onCommit={(v) => editField({ name: v })} /></div>
        <div className="field" style={{ width: 90 }}><label>Кратность</label><NumCell value={product.packSize} onCommit={(v) => editField({ packSize: v ?? 1 })} min={1} /></div>
        <label className="small"><input type="checkbox" checked={product.archived} onChange={async (e) => { await db.products.update(product.id!, { archived: e.target.checked }); onChanged(); }} /> в архиве (продажи, цены и старые поставки сохраняются)</label>
      </div>

      <div className="tabs-sub">
        <button className={tab === 'sales' ? 'active' : ''} onClick={() => setTab('sales')}>Продажи по месяцам</button>
        <button className={tab === 'price' ? 'active' : ''} onClick={() => setTab('price')}>Цена и история цен</button>
        <button className={tab === 'supplies' ? 'active' : ''} onClick={() => setTab('supplies')}>Участие в поставках</button>
      </div>

      {tab === 'sales' && (
        <div className="tbl-scroll" style={{ maxHeight: '50vh' }}>
          <table className="grid">
            <thead>
              <tr><th>Период</th><th>Статус ВЛД</th><th>Продажи ВЛД</th><th>Статус МСК</th><th>Продажи МСК</th></tr>
            </thead>
            <tbody>
              {win.map((per) => {
                const rv = prodSales.find((s) => s.period === per && s.branch === 'vld');
                const rm = prodSales.find((s) => s.period === per && s.branch === 'msk');
                const cv = closedMap.vld.has(per), cm = closedMap.msk.has(per);
                return (
                  <tr key={per}>
                    <td>{per}</td>
                    <td className="small">{cv ? <span className="badge received">закрыт</span> : <span className="badge ordered">открыт</span>}</td>
                    <td className="num"><NumCell value={rv?.qty ?? null} disabled={cv} onCommit={async (v) => {
                      const val = v === null ? null : Math.max(0, Math.round(v));
                      if (rv) { await db.sales.update(rv.id!, { qty: val }); }
                      else if (val !== null) await db.sales.add({ brandId: brand.id!, productId: product.id!, period: per, branch: 'vld', qty: val });
                      await db.salesLog.add({ date: new Date().toISOString(), brandId: brand.id!, productId: product.id!, period: per, branch: 'vld', oldValue: rv?.qty ?? null, newValue: val });
                      onChanged();
                    }} /></td>
                    <td className="small">{cm ? <span className="badge received">закрыт</span> : <span className="badge ordered">открыт</span>}</td>
                    <td className="num"><NumCell value={rm?.qty ?? null} disabled={cm} onCommit={async (v) => {
                      const val = v === null ? null : Math.max(0, Math.round(v));
                      if (rm) { await db.sales.update(rm.id!, { qty: val }); }
                      else if (val !== null) await db.sales.add({ brandId: brand.id!, productId: product.id!, period: per, branch: 'msk', qty: val });
                      await db.salesLog.add({ date: new Date().toISOString(), brandId: brand.id!, productId: product.id!, period: per, branch: 'msk', oldValue: rm?.qty ?? null, newValue: val });
                      onChanged();
                    }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="small muted" style={{ padding: 6 }}>Закрытие/открытие периодов — на экране «История продаж». Закрытые периоды защищены от случайного изменения; повторно откройте месяц, чтобы исправить данные — прогнозы пересчитаются автоматически.</div>
        </div>
      )}

      {tab === 'price' && <PriceEditor product={product} currency={brand.currency} history={priceHistory.filter((h) => h.productId === product.id)} onSave={savePrice} />}

      {tab === 'supplies' && (
        <div className="tbl-scroll" style={{ maxHeight: '50vh' }}>
          <table className="grid">
            <thead><tr><th>Поставка</th><th>Статус</th><th>Оформление</th><th>ВЛД план/факт</th><th>МСК план/факт</th></tr></thead>
            <tbody>
              {supplies.filter((s) => s.brandId === brand.id && s.items.some((i) => i.productId === product.id)).map((s) => {
                const it = s.items.find((i) => i.productId === product.id)!;
                return (
                  <tr key={s.id}>
                    <td>{s.number}</td>
                    <td><span className={`badge ${s.status}`}>{s.status}</span></td>
                    <td>{fmtDate(s.orderDate)}</td>
                    <td className="num">{it.vldQty} / {it.vldReceived}{it.vldActualDate ? ` (${fmtDate(it.vldActualDate)})` : ''}</td>
                    <td className="num">{it.mskQty} / {it.mskReceived}{it.mskActualDate ? ` (${fmtDate(it.mskActualDate)})` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="dialog-actions"><button className="btn" onClick={onClose}>Закрыть</button></div>
    </dialog>
  );
}

async function patchProductWithHistory(product: Product, kind: 'fixed' | 'tiered', currency: 'KRW' | 'USD', fixedPrice?: number, tiers?: PriceTier[], comment?: string) {
  const changed = kind !== product.priceKind ||
    (kind === 'fixed' && fixedPrice !== product.fixedPrice) ||
    (kind === 'tiered' && JSON.stringify(tiers) !== JSON.stringify(product.tiers));
  await db.products.update(product.id!, { priceKind: kind, fixedPrice: kind === 'fixed' ? fixedPrice : undefined, tiers: kind === 'tiered' ? tiers : undefined });
  if (changed) {
    await db.priceHistory.add({
      productId: product.id!, date: new Date().toISOString(),
      oldPriceKind: product.priceKind, oldFixedPrice: product.fixedPrice, oldTiers: product.tiers,
      newPriceKind: kind, newFixedPrice: kind === 'fixed' ? fixedPrice : undefined,
      newTiers: kind === 'tiered' ? tiers : undefined,
      currency,
      comment: comment?.trim() ? comment.trim() : undefined,
    });
  }
}

function PriceEditor({
  product, currency, history, onSave,
}: {
  product: Product;
  currency: 'KRW' | 'USD';
  history: PriceHistoryEntry[];
  onSave: (kind: 'fixed' | 'tiered', fixedPrice?: number, tiers?: PriceTier[], comment?: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<'fixed' | 'tiered'>(product.priceKind);
  const [fixedPrice, setFixedPrice] = useState<number | null>(product.fixedPrice ?? null);
  const [tiers, setTiers] = useState<PriceTier[]>((product.tiers ?? [{ minBoxes: 1, price: product.fixedPrice ?? 0 }]).slice().sort((a, b) => a.minBoxes - b.minBoxes));
  const [comment, setComment] = useState('');

  return (
    <div>
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="fixed">Фиксированная цена</option>
          <option value="tiered">Ступенчатая цена</option>
        </select>
        <span className="small muted">Ступень выбирается по общему числу коробок товара на оба филиала. Цена применяется ко всему количеству.</span>
      </div>
      {kind === 'fixed' ? (
        <div className="row" style={{ marginTop: 8 }}>
          <div className="field" style={{ width: 160 }}><label>Цена за штуку, {currency}</label>
            <NumCell value={fixedPrice} onCommit={setFixedPrice} min={0} /></div>
        </div>
      ) : (
        <table className="grid" style={{ marginTop: 8 }}>
          <thead><tr><th>От коробок (вкл.)</th><th>Цена за штуку, {currency}</th><th></th></tr></thead>
          <tbody>
            {tiers.map((t, idx) => (
              <tr key={idx}>
                <td className="num" style={{ width: 120 }}><NumCell value={t.minBoxes} onCommit={(v) => { const nt = [...tiers]; nt[idx] = { ...t, minBoxes: Math.max(1, Math.round(v ?? 1)) }; setTiers(nt); }} min={1} /></td>
                <td className="num" style={{ width: 140 }}><NumCell value={t.price} onCommit={(v) => { const nt = [...tiers]; nt[idx] = { ...t, price: Math.max(0, v ?? 0) }; setTiers(nt); }} min={0} /></td>
                <td><button className="btn small danger" onClick={() => setTiers(tiers.filter((_, i) => i !== idx))}>Удалить</button></td>
              </tr>
            ))}
            <tr><td colSpan={3}><button className="btn small" onClick={() => setTiers([...tiers, { minBoxes: (tiers[tiers.length - 1]?.minBoxes ?? 0) + 10, price: tiers[tiers.length - 1]?.price ?? 0 }])}>＋ Добавить ступень</button></td></tr>
          </tbody>
        </table>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <div className="field grow"><label>Комментарий к изменению цены (сохранится в истории)</label>
          <input value={comment} onChange={(e) => setComment(e.target.value)} /></div>
        <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={async () => {
          await onSave(kind, kind === 'fixed' ? (fixedPrice ?? undefined) : undefined, kind === 'tiered' ? [...tiers].sort((a, b) => a.minBoxes - b.minBoxes) : undefined, comment);
          setComment('');
        }}>Сохранить цену (с записью в историю)</button>
      </div>

      <h3 style={{ marginTop: 14 }} className="small">История изменения закупочной цены</h3>
      <table className="grid">
        <thead><tr><th>Дата</th><th>Было</th><th>Стало</th><th>Δ</th><th>Валюта</th><th>Коммент.</th></tr></thead>
        <tbody>
          {[...history].reverse().map((h) => {
            const oldSimple = h.oldPriceKind === 'fixed' ? h.oldFixedPrice : h.oldTiers?.[0]?.price;
            const newSimple = h.newPriceKind === 'fixed' ? h.newFixedPrice : h.newTiers?.[0]?.price;
            const pct = priceChangePct(oldSimple, newSimple);
            const desc = (kind: string, fp?: number, ts?: { minBoxes: number; price: number }[]) =>
              kind === 'fixed' ? `${fmtNum(fp ?? null)} ${h.currency}` : (ts ?? []).map((t) => `от ${t.minBoxes}к: ${fmtNum(t.price)}`).join(', ');
            return (
              <tr key={h.id}>
                <td>{new Date(h.date).toLocaleString('ru-RU')}</td>
                <td className="small">{desc(h.oldPriceKind, h.oldFixedPrice, h.oldTiers)}</td>
                <td className="small">{desc(h.newPriceKind, h.newFixedPrice, h.newTiers)}</td>
                <td className={`num small ${pct && pct > 0 ? 'err' : 'ok-soft'}`}>{pct !== null ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}</td>
                <td>{h.currency}</td>
                <td className="small">{h.comment ?? ''}</td>
              </tr>
            );
          })}
          {history.length === 0 && <tr><td colSpan={6} className="muted small">Изменений цен пока нет.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

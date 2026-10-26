// ===== Раздел «Поставки» =====
import { useMemo, useRef, useState } from 'react';
import type { Brand, Product, Supply, SupplyItem, Settings, SupplyStatus, FixedOrder } from './types';
import { db } from './db';
import {
  fmtDate, fmtNum, fmtMoney, plannedDatesFromOrder, effectiveLogistics,
  redistribute, isMultiple, todayISO, addDays, convert, boxesFor, appliedPrice,
  supplyItemUnitPrice, supplyItemSum, supplyTotalCost, fillSupplyPricesFromMatrix,
} from './calc';
import { NumCell } from './ui';

const CURRENCY_SYMBOL: Record<string, string> = { KRW: '₩', USD: '$' };

export const SUPPLY_STATUS_NAMES: Record<SupplyStatus, string> = {
  ordered: 'Оформлена',
  in_transit: 'В пути',
  partial: 'Частично получена',
  received: 'Получена полностью',
  cancelled: 'Отменена',
};

/** Автоопределение статуса по фактам поступления */
export function deriveStatus(sup: Supply): SupplyStatus {
  if (sup.status === 'cancelled') return 'cancelled';
  let all = true, any = false;
  for (const it of sup.items) {
    const expV = it.vldQty, expM = it.mskQty;
    const gotV = it.vldReceived >= expV, gotM = it.mskReceived >= expM;
    if (gotV && gotM) any = true; else all = false;
    if ((it.vldReceived > 0 && it.vldReceived < expV) || (it.mskReceived > 0 && it.mskReceived < expM)) any = true;
  }
  if (all && sup.items.length > 0) return 'received';
  if (any) return 'partial';
  if (sup.departDate <= todayISO()) return 'in_transit';
  return 'ordered';
}

export function SuppliesPage({
  brand, products, supplies, orders, settings, onChanged,
}: {
  brand: Brand;
  products: Product[];
  supplies: Supply[];
  orders: FixedOrder[];
  settings: Settings;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [createFromOrderId, setCreateFromOrderId] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const brandSupplies = useMemo(
    () => supplies.filter((s) => s.brandId === brand.id).sort((a, b) => (a.orderDate < b.orderDate ? 1 : -1)),
    [supplies, brand.id],
  );
  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return brandSupplies;
    return brandSupplies.filter((s) => s.number.toLowerCase().includes(q));
  }, [brandSupplies, search]);

  const editing = editingId !== null ? brandSupplies.find((s) => s.id === editingId) ?? null : null;

  async function saveSupply(sup: Supply) {
    const status = deriveStatus(sup);
    // Сохраняем поставку как есть: цены, введённые пользователем (или перенесённые из заказа),
    // не перезаписываются. Пустые/некорректные значения unitPrice не сохраняются.
    const items = sup.items.map((it) => {
      const price = supplyItemUnitPrice(it);
      const copy: SupplyItem = { ...it };
      if (price === undefined) delete copy.unitPrice;
      else copy.unitPrice = price;
      return copy;
    });
    const toSave = { ...sup, status, items };
    if (sup.id) await db.supplies.put(toSave);
    else await db.supplies.add(toSave);
    // если поставка создана из заказа — отмечаем заказ
    if (sup.fromOrderId) await db.orders.update(sup.fromOrderId, { supplyCreated: true });
    onChanged();
  }

  async function cancelSupply(sup: Supply) {
    if (!confirm(`Отменить поставку «${sup.number}»? История сохранится.`)) return;
    await db.supplies.update(sup.id!, { status: 'cancelled' });
    onChanged();
  }

  return (
    <div className="page">
      <div className="card">
        <div className="row">
          <button className="btn primary" onClick={() => { setCreating(true); setCreateFromOrderId(null); }}>＋ Новая поставка</button>
          {orders.filter((o) => o.brandId === brand.id && !o.supplyCreated).map((o) => (
            <button key={o.id} className="btn" onClick={() => { setCreating(true); setCreateFromOrderId(o.id!); }}>
              Создать поставку из заказа №{o.number}
            </button>
          ))}
          <span className="grow" />
          <input placeholder="Поиск по номеру поставки" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '5px 8px', border: '1px solid #bcccdc', borderRadius: 5 }} />
        </div>
      </div>

      <div className="tbl-scroll" style={{ maxHeight: editing ? '40vh' : undefined }}>
        <table className="grid">
          <thead>
            <tr>
              <th>Номер</th><th>Статус</th><th>Оформление</th><th>Выход из Кореи</th>
              <th>План ВЛД</th><th>План МСК</th><th>Факт ВЛД</th><th>Факт МСК</th>
              <th>Товаров</th><th>Единиц</th><th>Стоимость</th><th></th>
            </tr>
          </thead>
          <tbody>
            {filteredList.map((s) => {
              const facts = branchFacts(s);
              const units = s.items.reduce((a, i) => a + i.totalQty, 0);
              const st = deriveStatus(s);
              const cost = supplyTotalCost(s);
              const costRub = convert(cost.totalSum, brand.currency, { usdRub: settings.usdRub, krwRub: settings.krwRub }).rub;
              return (
                <tr key={s.id}>
                  <td><b>{s.number}</b>{s.fromOrderId ? <span className="small muted"> (из заказа)</span> : null}</td>
                  <td><span className={`badge ${st}`}>{SUPPLY_STATUS_NAMES[st]}</span>
                    {isOverdue(s) && <div className="small overdue">⚠ Просрочена</div>}</td>
                  <td>{fmtDate(s.orderDate)}</td>
                  <td>{fmtDate(s.departDate)}</td>
                  <td>{fmtDate(s.vldPlannedDate)}</td>
                  <td>{fmtDate(s.mskPlannedDate)}</td>
                  <td>{facts.vldDate ? `${fmtDate(facts.vldDate)} · ${fmtNum(facts.vldReceived)}/${fmtNum(sumExp(s, 'vld'))}` : `— / ${fmtNum(sumExp(s, 'vld'))}`}</td>
                  <td>{facts.mskDate ? `${fmtDate(facts.mskDate)} · ${fmtNum(facts.mskReceived)}/${fmtNum(sumExp(s, 'msk'))}` : `— / ${fmtNum(sumExp(s, 'msk'))}`}</td>
                  <td className="num">{s.items.length}</td>
                  <td className="num">{fmtNum(units)}</td>
                  <td className="num" title={cost.known ? undefined : `Цены не заданы для позиций: ${cost.missingCount}. Откройте поставку и сохраните цены.`}>
                    {cost.missingCount > 0 && cost.totalSum === 0 && !cost.known
                      ? <span className="muted">нет цен</span>
                      : <>{CURRENCY_SYMBOL[brand.currency]}{fmtNum(cost.totalSum)}
                          {!cost.known && <span className="small muted"> +{cost.missingCount} без цены</span>}
                          <div className="small muted">≈ {fmtNum(costRub)} ₽</div></>}
                  </td>
                  <td><button className="btn small" onClick={() => setEditingId(s.id!)}>Открыть</button></td>
                </tr>
              );
            })}
            {filteredList.length === 0 && <tr><td colSpan={12} className="muted">Поставок нет.</td></tr>}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <SupplyEditor
          brand={brand} products={products} settings={settings}
          supply={editing ?? undefined}
          fromOrder={createFromOrderId ? orders.find((o) => o.id === createFromOrderId) : undefined}
          onClose={() => { setCreating(false); setEditingId(null); setCreateFromOrderId(null); }}
          onSave={saveSupply}
          onCancelSupply={editing && editing.status !== 'cancelled' ? () => cancelSupply(editing) : undefined}
        />
      )}
    </div>
  );
}

function sumExp(s: Supply, br: 'vld' | 'msk'): number {
  return s.items.reduce((a, i) => a + (br === 'vld' ? i.vldQty : i.mskQty), 0);
}

function branchFacts(s: Supply) {
  let vldDate: string | undefined, mskDate: string | undefined;
  let vldReceived = 0, mskReceived = 0;
  for (const i of s.items) {
    vldReceived += i.vldReceived; mskReceived += i.mskReceived;
    if (i.vldActualDate) vldDate = vldDate ? (vldDate < i.vldActualDate ? i.vldActualDate : vldDate) : i.vldActualDate;
    if (i.mskActualDate) mskDate = mskDate ? (mskDate < i.mskActualDate ? i.mskActualDate : mskDate) : i.mskActualDate;
  }
  return { vldDate, mskDate, vldReceived, mskReceived };
}

/** Есть ли части, у которых плановая дата прошла, а факт не подтверждён */
export function isOverdue(s: Supply): boolean {
  if (s.status === 'cancelled' || s.status === 'received') return false;
  const t = todayISO();
  return s.items.some((i) =>
    (i.vldQty > i.vldReceived && s.vldPlannedDate < t) ||
    (i.mskQty > i.mskReceived && s.mskPlannedDate < t));
}

// ================= Редактор поставки =================

function SupplyEditor({
  brand, products, settings, supply, fromOrder, onClose, onSave, onCancelSupply,
}: {
  brand: Brand;
  products: Product[];
  settings: Settings;
  supply?: Supply;
  fromOrder?: FixedOrder;
  onClose: () => void;
  onSave: (s: Supply) => void;
  onCancelSupply?: () => void;
}) {
  const lg = effectiveLogistics(brand, settings);
  const isNew = !supply;

  const initItems: SupplyItem[] = useMemo(() => {
    if (supply) return supply.items.map((i) => ({ ...i }));
    if (fromOrder) {
      // Поставка из зафиксированного заказа: переносим цены, сохранённые при фиксации заказа.
      return fromOrder.lines.map((l) => ({
        productId: l.productId, totalQty: l.totalQty, vldQty: l.vldQty, mskQty: l.mskQty,
        vldReceived: 0, mskReceived: 0, unitPrice: l.appliedPrice,
      }));
    }
    return [];
  }, [supply, fromOrder]);

  // Для новых поставок (не из заказа) автозаполняем цены из товарной матрицы.
  const [items, setItems] = useState<SupplyItem[]>(() =>
    isNew && !fromOrder ? fillSupplyPricesFromMatrix(initItems, products) : initItems);
  const [number, setNumber] = useState(supply?.number ?? `Поставка ${todayISO()}`);
  const [orderDate, setOrderDate] = useState(supply?.orderDate ?? todayISO());
  const [departDate, setDepartDate] = useState(supply?.departDate ?? addDays(fromOrder?.date ?? todayISO(), lg.orderPrep));
  const [vldDate, setVldDate] = useState(supply?.vldPlannedDate ?? addDays(fromOrder?.date ?? todayISO(), lg.orderPrep + lg.shipVld));
  const [mskDate, setMskDate] = useState(supply?.mskPlannedDate ?? addDays(fromOrder?.date ?? todayISO(), lg.orderPrep + lg.shipVld + lg.extraMsk));
  const [datesTouched, setDatesTouched] = useState(!isNew);
  const [addError, setAddError] = useState('');
  // позиции, цену которых пользователь изменил вручную в этой сессии редактирования.
  // Заполнение при открытии карточки: если у поставки уже сохранены цены для ВСЕХ
  // непустых позиций — считаем их зафиксированными (ручными или из заказа) и при
  // изменении количества не пересчитываем автоматически. Если же хотя бы у одной
  // позиции цены нет — это поставка из товарной матрицы (или legacy-поставка без
  // цен): пустые цены автозаполняются из прайса по новым коробкам, а уже сохранённые
  // значения остаются неприкосновенными (см. autoPrice).
  const priceEditedRef = useRef<Set<number>>(new Set(
    (supply?.items ?? [])
      .filter((i) => i.totalQty > 0 && supplyItemUnitPrice(i) !== undefined)
      .map((i) => i.productId),
  ));

  function recalcDates(newOrderDate: string) {
    setOrderDate(newOrderDate);
    if (!datesTouched) {
      const p = plannedDatesFromOrder(newOrderDate, lg);
      setDepartDate(p.departDate); setVldDate(p.vldDate); setMskDate(p.mskDate);
    }
  }

  function patchItem(pid: number, patch: Partial<SupplyItem>) {
    setItems((prev) => prev.map((i) => (i.productId === pid ? { ...i, ...patch } : i)));
  }

  /** Ручное изменение закупочной цены в поставке (не влияет на товарную матрицу) */
  function changePrice(pid: number, v: number | null) {
    priceEditedRef.current.add(pid);
    const price = v === null || !Number.isFinite(v) || v < 0 ? undefined : v;
    setItems((prev) => prev.map((i) => (i.productId === pid ? { ...i, unitPrice: price } : i)));
  }

  /** Автоподстановка цены из матрицы при изменении количества (пока цену не меняли вручную) */
  function autoPrice(i: SupplyItem, newTotal: number): number | undefined {
    if (priceEditedRef.current.has(i.productId)) return i.unitPrice;
    const p = products.find((x) => x.id === i.productId);
    if (!p) return i.unitPrice;
    const boxes = newTotal > 0 ? Math.floor(boxesFor(newTotal, p.packSize) + 1e-9) : 0;
    const price = appliedPrice(p, boxes);
    return price === null ? i.unitPrice : price;
  }

  function changeTotal(pid: number, total: number | null) {
    const t = Math.max(0, Math.round(total ?? 0));
    setItems((prev) => prev.map((i) => {
      if (i.productId !== pid) return i;
      // сохраняем полученные факты: перераспределяем только нераспределённую часть
      const keptV = Math.min(i.vldReceived, t);
      const keptM = Math.min(i.mskReceived, Math.max(0, t - keptV));
      const restV = Math.max(0, i.vldQty - i.vldReceived);
      const restM = Math.max(0, i.mskQty - i.mskReceived);
      const restTotal = Math.max(0, t - keptV - keptM);
      let nv = keptV, nm = keptM;
      if (restV + restM > 0) {
        const share = restV / (restV + restM);
        nv += Math.round(restTotal * share);
        nm += restTotal - (nv - keptV);
      } else {
        nv += restTotal;
      }
      // цена автоподставляется из матрицы по новым коробкам, пока не редактировалась вручную
      return { ...i, totalQty: t, vldQty: nv, mskQty: nm, unitPrice: autoPrice(i, t) };
    }));
  }

  function changeBranch(pid: number, br: 'vld' | 'msk', val: number | null) {
    setItems((prev) => prev.map((i) => {
      if (i.productId !== pid) return i;
      const r = redistribute(i.totalQty, i.vldQty, i.mskQty, br, val ?? 0);
      // нельзя уменьшить распределение ниже уже полученного факта
      const recvV = i.vldReceived, recvM = i.mskReceived;
      let vld = Math.max(r.vld, recvV), msk = Math.max(r.msk, recvM);
      if (vld + msk > i.totalQty) {
        // подгоняем, чтобы сумма равнялась total при уважении фактов
        if (br === 'vld') vld = Math.min(i.totalQty - recvM, Math.max(recvV, r.vld));
        else msk = Math.min(i.totalQty - recvV, Math.max(recvM, r.msk));
      }
      return { ...i, vldQty: vld, mskQty: i.totalQty - vld };
    }));
  }

  function markReceived(pid: number, br: 'vld' | 'msk') {
    const it = items.find((i) => i.productId === pid);
    if (!it) return;
    const expected = br === 'vld' ? it.vldQty : it.mskQty;
    patchItem(pid, br === 'vld'
      ? { vldReceived: expected, vldActualDate: todayISO() }
      : { mskReceived: expected, mskActualDate: todayISO() });
  }

  function addProduct(pid: number) {
    const p = products.find((x) => x.id === Number(pid));
    if (!p) { setAddError('Выберите товар'); return; }
    if (items.some((i) => i.productId === p.id)) { setAddError('Товар уже в поставке'); return; }
    setAddError('');
    // автоподстановка закупочной цены из матрицы (fixed / ступенчатая от текущих коробок)
    const price = appliedPrice(p, 0);
    setItems((prev) => [...prev, { productId: p.id!, totalQty: 0, vldQty: 0, mskQty: 0, vldReceived: 0, mskReceived: 0, unitPrice: price ?? undefined }]);
  }

  function removeItem(pid: number) {
    const it = items.find((i) => i.productId === pid);
    if (!it) return;
    if (it.vldReceived > 0 || it.mskReceived > 0) {
      if (!confirm('У товара есть фактические поступления. Убрать его из поставки? Факт поступления будет потерян для этой поставки.')) return;
    }
    setItems((prev) => prev.filter((i) => i.productId !== pid));
  }

  const validation = useMemo(() => {
    const errs: string[] = [];
    for (const i of items) {
      const p = products.find((x) => x.id === i.productId);
      if (!p) continue;
      if (i.vldQty + i.mskQty !== i.totalQty) errs.push(`${p.name}: распределение ≠ общему количеству`);
      if (i.vldQty < i.vldReceived || i.mskQty < i.mskReceived) errs.push(`${p.name}: распределение меньше уже полученного количества`);
    }
    return errs;
  }, [items, products]);

  function save() {
    const cleaned = items.filter((i) => i.totalQty > 0 || i.vldReceived > 0 || i.mskReceived > 0);
    if (cleaned.length === 0) { alert('Добавьте хотя бы один товар с количеством.'); return; }
    if (validation.length) { alert('Исправьте ошибки:\n' + validation.join('\n')); return; }
    onSave({
      id: supply?.id,
      brandId: brand.id!,
      number: number.trim() || 'Без номера',
      status: supply?.status ?? 'ordered',
      orderDate, departDate,
      vldPlannedDate: vldDate, mskPlannedDate: mskDate,
      items: cleaned,
      fromOrderId: supply?.fromOrderId ?? fromOrder?.id,
      createdAt: supply?.createdAt ?? new Date().toISOString(),
      note: supply?.note,
    });
    onClose();
  }

  const cur = CURRENCY_SYMBOL[brand.currency] ?? brand.currency;
  const missingPrices = items.some((i) => i.totalQty > 0 && supplyItemUnitPrice(i) === undefined);
  const costTotals = useMemo(() => {
    let sum = 0;
    for (const i of items) sum += supplyItemSum(i) ?? 0;
    const rub = convert(sum, brand.currency, { usdRub: settings.usdRub, krwRub: settings.krwRub }).rub;
    return { sum, rub };
  }, [items, brand.currency, settings]);

  function fillMissingPrices() {
    setItems((prev) => prev.map((i) => {
      if (supplyItemUnitPrice(i) !== undefined) return i; // сохранённые цены не перезаписываем
      const p = products.find((x) => x.id === i.productId);
      if (!p) return i;
      const boxes = i.totalQty > 0 ? Math.floor(boxesFor(i.totalQty, p.packSize) + 1e-9) : 0;
      const price = appliedPrice(p, boxes);
      return price === null ? i : { ...i, unitPrice: price };
    }));
  }

  return (
    <dialog open className="supply-dialog">
      <div className="supply-body">
      <h3 className="supply-title">{isNew ? 'Новая поставка' : `Поставка: ${supply!.number}`}</h3>
      {fromOrder && !supply && <div className="small muted">Создаётся из зафиксированного заказа №{fromOrder.number}. Номенклатура, количества и цены заказа перенесены.</div>}
      <div className="supply-form-grid">
        <div className="field grow"><label>Название / номер поставки</label>
          <input value={number} onChange={(e) => setNumber(e.target.value)} /></div>
        <div className="field"><label>Дата оформления</label>
          <input type="date" value={orderDate} onChange={(e) => recalcDates(e.target.value)} /></div>
        <div className="field"><label>Выход из Кореи</label>
          <input type="date" value={departDate} onChange={(e) => { setDatesTouched(true); setDepartDate(e.target.value); }} /></div>
        <div className="field"><label>План · Владивосток</label>
          <input type="date" value={vldDate} onChange={(e) => { setDatesTouched(true); setVldDate(e.target.value); }} /></div>
        <div className="field"><label>План · Москва</label>
          <input type="date" value={mskDate} onChange={(e) => { setDatesTouched(true); setMskDate(e.target.value); }} /></div>
      </div>
      <div className="supply-hint small">Даты рассчитаны автоматически ({lg.orderPrep}+{lg.shipVld} / +{lg.extraMsk} дней) и могут быть изменены вручную.</div>

      <div className="tbl-scroll supply-table-scroll">
        <table className="grid supply-table">
          <thead>
            <tr>
              <th>Артикул</th><th>Наименование</th><th>Кратность</th>
              <th>Общее кол-во</th><th>Владивосток</th><th>Москва</th>
              <th>Получено ВЛД</th><th>Получено МСК</th>
              <th>Цена за шт.</th><th>Сумма</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const p = products.find((x) => x.id === i.productId);
              if (!p) return null;
              const vldPackBad = i.vldQty > 0 && !isMultiple(i.vldQty, p.packSize);
              const mskPackBad = i.mskQty > 0 && !isMultiple(i.mskQty, p.packSize);
              const overdueV = i.vldQty > i.vldReceived && vldDate < todayISO();
              const overdueM = i.mskQty > i.mskReceived && mskDate < todayISO();
              const itemSum = supplyItemSum(i);
              return (
                <tr key={i.productId}>
                  <td className="supply-art">{p.article}</td>
                  <td className="supply-name" title={p.name}>{p.name}</td>
                  <td className="num supply-pack">{p.packSize}</td>
                  <td className="num cell-qty">
                    <NumCell value={i.totalQty} onCommit={(v) => changeTotal(i.productId!, v)} min={0} step={p.packSize} />
                  </td>
                  <td className={`num cell-qty ${vldPackBad ? 'warn-cell' : ''}`} title={vldPackBad ? `Не кратно ${p.packSize}` : 'При увеличении ВЛД Москва уменьшается автоматически'}>
                    <NumCell value={i.vldQty} onCommit={(v) => changeBranch(i.productId!, 'vld', v)} min={i.vldReceived} />
                  </td>
                  <td className={`num cell-qty ${mskPackBad ? 'warn-cell' : ''}`} title={mskPackBad ? `Не кратно ${p.packSize}` : 'При увеличении Москвы ВЛД уменьшается автоматически'}>
                    <NumCell value={i.mskQty} onCommit={(v) => changeBranch(i.productId!, 'msk', v)} min={i.mskReceived} />
                  </td>
                  <td className="num cell-receive">
                    <div className="receive-line">
                      <NumCell value={i.vldReceived} onCommit={(v) => patchItem(i.productId!, { vldReceived: Math.max(0, Math.round(v ?? 0)), vldActualDate: (v ?? 0) > 0 ? (i.vldActualDate ?? todayISO()) : undefined })} min={0} />
                      <button className="btn confirm-btn" title="Отметить полное поступление во Владивосток сегодня" onClick={() => markReceived(i.productId!, 'vld')}>✓</button>
                    </div>
                    {overdueV && <span className="small overdue">просрочена</span>}
                  </td>
                  <td className="num cell-receive">
                    <div className="receive-line">
                      <NumCell value={i.mskReceived} onCommit={(v) => patchItem(i.productId!, { mskReceived: Math.max(0, Math.round(v ?? 0)), mskActualDate: (v ?? 0) > 0 ? (i.mskActualDate ?? todayISO()) : undefined })} min={0} />
                      <button className="btn confirm-btn" title="Отметить полное поступление в Москву сегодня" onClick={() => markReceived(i.productId!, 'msk')}>✓</button>
                    </div>
                    {overdueM && <span className="small overdue">просрочена</span>}
                  </td>
                  <td className="num cell-price" title={`Закупочная цена за штуку, ${brand.currency}. Можно изменить вручную — цена в товарной матрице не изменится.`}>
                    <NumCell value={supplyItemUnitPrice(i)} onCommit={(v) => changePrice(i.productId, v)} min={0} />
                  </td>
                  <td className="num cell-sum" title="Сумма позиции = общее количество × цена за штуку">
                    {itemSum === null ? <span className="muted small">нет цены</span> : fmtMoney(itemSum)}
                  </td>
                  <td className="cell-remove"><button className="btn remove-btn" onClick={() => removeItem(i.productId!)}>Убрать</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row supply-add-row">
        <select className="supply-add-select" onChange={(e) => { if (e.target.value) addProduct(Number(e.target.value)); e.target.value = ''; }} defaultValue="">
          <option value="" disabled>＋ Добавить товар…</option>
          {products.filter((p) => !p.archived && !items.some((i) => i.productId === p.id)).map((p) => (
            <option key={p.id} value={p.id}>{p.article} · {p.name}</option>
          ))}
        </select>
        {addError && <span className="err small">{addError}</span>}
      </div>

      {validation.length > 0 && (
        <div className="err small supply-validation">
          {validation.map((e, k) => <div key={k}>⚠ {e}</div>)}
          <div>Подтверждение поставки с некорректным распределением невозможно.</div>
        </div>
      )}

      {/* Итоговая стоимость поставки */}
      <div className="supply-total">
        <div className="supply-total-label">Итого по поставке</div>
        <div className="supply-total-main">{cur} {fmtMoney(costTotals.sum)}</div>
        <div className="supply-total-rub">≈ {fmtNum(costTotals.rub)} ₽</div>
      </div>
      {missingPrices && (
        <div className="row supply-missing-prices">
          <span className="overdue small">⚠ Не для всех товаров задана закупочная цена — итог неполный.</span>
          <button className="btn small" onClick={fillMissingPrices}>Заполнить цены из матрицы</button>
        </div>
      )}

      <div className="dialog-actions supply-actions">
        {onCancelSupply && <button className="btn danger-ghost" onClick={() => { onCancelSupply(); onClose(); }}>Отменить поставку</button>}
        <span className="grow" />
        <button className="btn neutral" onClick={onClose}>Закрыть</button>
        <button className="btn primary" onClick={save} disabled={validation.length > 0}>Сохранить поставку</button>
      </div>
      </div>
    </dialog>
  );
}

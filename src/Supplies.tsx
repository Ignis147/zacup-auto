// ===== Раздел «Поставки» =====
import { useMemo, useState } from 'react';
import type { Brand, Product, Supply, SupplyItem, Settings, SupplyStatus, FixedOrder } from './types';
import { db } from './db';
import {
  fmtDate, fmtNum, plannedDatesFromOrder, effectiveLogistics,
  redistribute, isMultiple, todayISO, addDays,
} from './calc';
import { NumCell } from './ui';

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
    if (sup.id) await db.supplies.put({ ...sup, status });
    else await db.supplies.add({ ...sup, status });
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
              <th>Товаров</th><th>Единиц</th><th></th>
            </tr>
          </thead>
          <tbody>
            {filteredList.map((s) => {
              const facts = branchFacts(s);
              const units = s.items.reduce((a, i) => a + i.totalQty, 0);
              const st = deriveStatus(s);
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
                  <td><button className="btn small" onClick={() => setEditingId(s.id!)}>Открыть</button></td>
                </tr>
              );
            })}
            {filteredList.length === 0 && <tr><td colSpan={11} className="muted">Поставок нет.</td></tr>}
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
      return fromOrder.lines.map((l) => ({
        productId: l.productId, totalQty: l.totalQty, vldQty: l.vldQty, mskQty: l.mskQty,
        vldReceived: 0, mskReceived: 0,
      }));
    }
    return [];
  }, [supply, fromOrder]);

  const [number, setNumber] = useState(supply?.number ?? `Поставка ${todayISO()}`);
  const [orderDate, setOrderDate] = useState(supply?.orderDate ?? todayISO());
  const [departDate, setDepartDate] = useState(supply?.departDate ?? addDays(fromOrder?.date ?? todayISO(), lg.orderPrep));
  const [vldDate, setVldDate] = useState(supply?.vldPlannedDate ?? addDays(fromOrder?.date ?? todayISO(), lg.orderPrep + lg.shipVld));
  const [mskDate, setMskDate] = useState(supply?.mskPlannedDate ?? addDays(fromOrder?.date ?? todayISO(), lg.orderPrep + lg.shipVld + lg.extraMsk));
  const [items, setItems] = useState<SupplyItem[]>(initItems);
  const [datesTouched, setDatesTouched] = useState(!isNew);
  const [addError, setAddError] = useState('');

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
      return { ...i, totalQty: t, vldQty: nv, mskQty: nm };
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
    setItems((prev) => [...prev, { productId: p.id!, totalQty: 0, vldQty: 0, mskQty: 0, vldReceived: 0, mskReceived: 0 }]);
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

  return (
    <dialog open>
      <h3>{isNew ? 'Новая поставка' : `Поставка: ${supply!.number}`}</h3>
      {fromOrder && !supply && <div className="small muted">Создаётся из зафиксированного заказа №{fromOrder.number}. Номенклатура и количества перенесены.</div>}
      <div className="row">
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
      <div className="small muted">Даты рассчитаны автоматически ({lg.orderPrep}+{lg.shipVld} / +{lg.extraMsk} дней) и могут быть изменены вручную.</div>

      <div className="tbl-scroll" style={{ maxHeight: '45vh', marginTop: 10 }}>
        <table className="grid">
          <thead>
            <tr>
              <th>Артикул</th><th>Наименование</th><th>Кратность</th>
              <th>Общее кол-во</th><th>Владивосток</th><th>Москва</th>
              <th>Получено ВЛД</th><th>Получено МСК</th><th></th>
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
              return (
                <tr key={i.productId}>
                  <td>{p.article}</td>
                  <td>{p.name}</td>
                  <td className="num">{p.packSize}</td>
                  <td className="num" style={{ width: 90 }}>
                    <NumCell value={i.totalQty} onCommit={(v) => changeTotal(i.productId!, v)} min={0} step={p.packSize} />
                  </td>
                  <td className={`num ${vldPackBad ? 'warn-cell' : ''}`} style={{ width: 90 }} title={vldPackBad ? `Не кратно ${p.packSize}` : 'При увеличении ВЛД Москва уменьшается автоматически'}>
                    <NumCell value={i.vldQty} onCommit={(v) => changeBranch(i.productId!, 'vld', v)} min={i.vldReceived} />
                  </td>
                  <td className={`num ${mskPackBad ? 'warn-cell' : ''}`} style={{ width: 90 }} title={mskPackBad ? `Не кратно ${p.packSize}` : 'При увеличении Москвы ВЛД уменьшается автоматически'}>
                    <NumCell value={i.mskQty} onCommit={(v) => changeBranch(i.productId!, 'msk', v)} min={i.mskReceived} />
                  </td>
                  <td className="num" style={{ width: 130 }}>
                    <div className="row" style={{ gap: 2 }}>
                      <NumCell value={i.vldReceived} onCommit={(v) => patchItem(i.productId!, { vldReceived: Math.max(0, Math.round(v ?? 0)), vldActualDate: (v ?? 0) > 0 ? (i.vldActualDate ?? todayISO()) : undefined })} min={0} />
                      <button className="btn small" title="Отметить полное поступление во Владивосток сегодня" onClick={() => markReceived(i.productId!, 'vld')}>✓</button>
                    </div>
                    {overdueV && <span className="small overdue">просрочена</span>}
                  </td>
                  <td className="num" style={{ width: 130 }}>
                    <div className="row" style={{ gap: 2 }}>
                      <NumCell value={i.mskReceived} onCommit={(v) => patchItem(i.productId!, { mskReceived: Math.max(0, Math.round(v ?? 0)), mskActualDate: (v ?? 0) > 0 ? (i.mskActualDate ?? todayISO()) : undefined })} min={0} />
                      <button className="btn small" title="Отметить полное поступление в Москву сегодня" onClick={() => markReceived(i.productId!, 'msk')}>✓</button>
                    </div>
                    {overdueM && <span className="small overdue">просрочена</span>}
                  </td>
                  <td><button className="btn small danger" onClick={() => removeItem(i.productId!)}>Убрать</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <select onChange={(e) => { if (e.target.value) addProduct(Number(e.target.value)); e.target.value = ''; }} defaultValue="">
          <option value="" disabled>＋ Добавить товар…</option>
          {products.filter((p) => !p.archived && !items.some((i) => i.productId === p.id)).map((p) => (
            <option key={p.id} value={p.id}>{p.article} · {p.name}</option>
          ))}
        </select>
        {addError && <span className="err small">{addError}</span>}
      </div>

      {validation.length > 0 && (
        <div className="err small" style={{ marginTop: 6 }}>
          {validation.map((e, k) => <div key={k}>⚠ {e}</div>)}
          <div>Подтверждение поставки с некорректным распределением невозможно.</div>
        </div>
      )}

      <div className="dialog-actions">
        {onCancelSupply && <button className="btn danger" onClick={() => { onCancelSupply(); onClose(); }}>Отменить поставку</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Закрыть</button>
        <button className="btn primary" onClick={save} disabled={validation.length > 0}>Сохранить поставку</button>
      </div>
    </dialog>
  );
}

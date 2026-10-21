// ===== Раздел «История продаж» =====
import { useMemo, useState } from 'react';
import type { Brand, SalesRecord, PeriodStatus, Branch, Product, SalesEditLog } from './types';
import { db } from './db';
import { BRANCHES, BRANCH_NAMES, lastPeriods, calcSdp, buildClosedMap, fmtNum, periodOf, todayISO } from './calc';
import { NumCell } from './ui';
import { parseClipboard, parseCellNumber } from './io';

export function SalesPage({
  brand, products, sales, periods, salesLogs, onChanged,
}: {
  brand: Brand;
  products: Product[];
  sales: SalesRecord[];
  periods: PeriodStatus[];
  salesLogs: SalesEditLog[];
  onChanged: () => void;
}) {
  const [period, setPeriod] = useState<string>(periodOf(todayISO())); // редактируем всегда текущий или выбранный
  const [branch, setBranch] = useState<Branch>('vld');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const window12 = useMemo(() => lastPeriods(12), []);
  const allPeriods = useMemo(() => {
    // все периоды: окно 12 месяцев + исторические, в которых есть данные
    const set = new Set<string>(window12);
    for (const s of sales) if (s.brandId === brand.id) set.add(s.period);
    return [...set].sort().reverse();
  }, [sales, window12, brand.id]);

  const activeProducts = useMemo(
    () => products.filter((p) => !p.archived || showArchived),
    [products, showArchived],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeProducts;
    return activeProducts.filter((p) =>
      p.name.toLowerCase().includes(q) || p.barcode.includes(q) || p.article.toLowerCase().includes(q));
  }, [activeProducts, search]);

  const closedMap = useMemo(() => buildClosedMap(periods, brand.id!), [periods, brand.id]);
  const isClosed = closedMap[branch].has(period);
  const isCurrentPeriod = period === periodOf(todayISO());

  const salesByKey = useMemo(() => {
    const m = new Map<string, SalesRecord>();
    for (const s of sales) m.set(`${s.productId}|${s.period}|${s.branch}`, s);
    return m;
  }, [sales]);

  async function setQty(productId: number, qty: number | null) {
    const existing = salesByKey.get(`${productId}|${period}|${branch}`);
    const clamped = qty === null ? null : Math.max(0, Math.round(qty));
    if (existing) {
      if (existing.qty === clamped) return;
      await db.sales.update(existing.id!, { qty: clamped });
      const log: SalesEditLog = {
        date: new Date().toISOString(), brandId: brand.id!, productId, period, branch,
        oldValue: existing.qty, newValue: clamped,
      };
      await db.salesLog.add(log);
    } else {
      if (clamped === null) return;
      await db.sales.add({ brandId: brand.id!, productId, period, branch, qty: clamped });
      const log: SalesEditLog = {
        date: new Date().toISOString(), brandId: brand.id!, productId, period, branch,
        oldValue: null, newValue: clamped,
      };
      await db.salesLog.add(log);
    }
    onChanged();
  }

  /** Массовая вставка из Excel: строки соответствуют товару по артикулу/штрихкоду в первой колонке */
  async function handlePaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const rows = parseClipboard(text);
    let applied = 0;
    for (const r of rows) {
      const key = (r[0] || '').trim();
      if (!key) continue;
      const prod = products.find((p) => p.barcode === key || p.article.toLowerCase() === key.toLowerCase());
      if (!prod) continue;
      const qty = parseCellNumber(r[1]);
      await setQty(prod.id!, qty);
      applied++;
    }
    if (applied > 0) alert(`Внесено значений: ${applied}. Пустая ячейка = данные не введены (не затирает ноль).`);
  }

  async function closePeriod() {
    // проверка корректности: хотя бы одно введённое значение
    const anyEntered = filtered.some((p) => salesByKey.get(`${p.id}|${period}|${branch}`)?.qty !== undefined && salesByKey.get(`${p.id}|${period}|${branch}`)?.qty !== null);
    if (!anyEntered) {
      if (!confirm('Ни у одного товара не введено продаж за этот период. Закрыть период как «нет продаж» нельзя — закрытие возможно только при наличии данных. Продолжить и закрыть пустой период?')) return;
    }
    const key = `${brand.id}|${period}|${branch}`;
    const ex = periods.find((p) => p.key === key);
    if (ex) await db.periods.update(ex.id!, { closed: true });
    else await db.periods.add({ key, brandId: brand.id!, period, branch, closed: true });
    onChanged();
  }

  async function reopenPeriod() {
    const key = `${brand.id}|${period}|${branch}`;
    const ex = periods.find((p) => p.key === key);
    if (ex) await db.periods.update(ex.id!, { closed: false });
    onChanged();
  }

  // СДП-справка по всем периодам для текущего выбора
  const sdpInfo = useMemo(() => {
    const map: Record<number, { vld: string; msk: string }> = {};
    for (const p of activeProducts) {
      const row: any = {};
      for (const br of BRANCHES) {
        const res = calcSdp(sales.filter((s) => s.brandId === brand.id), closedMap, p.id!, br);
        row[br] = res.kind === 'value' ? fmtNum(res.sdp, 2) : 'Нет данных';
      }
      map[p.id!] = { vld: row.vld, msk: row.msk };
    }
    return map;
  }, [activeProducts, sales, closedMap, brand.id]);

  const editLogs = useMemo(
    () => salesLogs.filter((l) => l.brandId === brand.id && l.period === period && l.branch === branch),
    [salesLogs, brand.id, period, branch],
  );

  return (
    <div className="page">
      <div className="card">
        <div className="row">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Месяц</label>
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {allPeriods.map((p) => <option key={p} value={p}>{p}{window12.includes(p) ? '' : ' (архив)'}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Филиал</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value as Branch)}>
              {BRANCHES.map((b) => <option key={b} value={b}>{BRANCH_NAMES[b]}</option>)}
            </select>
          </div>
          <div className="field grow" style={{ marginBottom: 0 }}>
            <label>Поиск (название / штрихкод / артикул)</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <label className="small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> показывать архивные товары</label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {isClosed
            ? <>
              <span className="badge received">Период закрыт ({BRANCH_NAMES[branch]})</span>
              <button className="btn" onClick={reopenPeriod}>Повторно открыть период</button>
            </>
            : <>
              <span className="badge ordered">Период открыт{isCurrentPeriod ? ' (текущий месяц)' : ''}</span>
              <button className="btn primary" onClick={closePeriod} disabled={isCurrentPeriod && false}>Закрыть период</button>
              {isCurrentPeriod && <span className="small muted">Текущий месяц можно закрыть досрочно; после закрытия он войдёт в расчёт СДП.</span>}
            </>}
          <span className="grow" />
          <span className="small muted">Совет: вставляйте столбцы из Excel (Ctrl+V в таблице): 1-я колонка — штрихкод или артикул, 2-я — продажи.</span>
        </div>
      </div>

      <div className="tbl-scroll" onPaste={handlePaste}>
        <table className="grid">
          <thead>
            <tr>
              <th>Штрихкод</th><th>Артикул</th><th>Наименование</th>
              <th>Продажи {BRANCH_NAMES[branch]}, {period}</th>
              <th title="СДП Владивосток (по закрытым периодам)">СДП ВЛД</th>
              <th title="СДП Москва (по закрытым периодам)">СДП МСК</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const rec = salesByKey.get(`${p.id}|${period}|${branch}`);
              const entered = rec !== undefined;
              return (
                <tr key={p.id} style={p.archived ? { opacity: 0.55 } : undefined}>
                  <td>{p.barcode}</td>
                  <td>{p.article}</td>
                  <td>{p.name}{p.archived && <span className="badge archived"> архив</span>}</td>
                  <td className="num" style={{ minWidth: 90 }}>
                    <NumCell
                      value={entered ? (rec!.qty ?? null) : null}
                      onCommit={(v) => setQty(p.id!, v)}
                      placeholder="—"
                      title="Пусто = данные не введены; 0 = подтверждённое отсутствие продаж"
                    />
                  </td>
                  <td className="num">{sdpInfo[p.id!]?.vld}</td>
                  <td className="num">{sdpInfo[p.id!]?.msk}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={6} className="muted">Нет товаров. Добавьте номенклатуру на экране «Заказник».</td></tr>}
          </tbody>
        </table>
      </div>

      {editLogs.length > 0 && (
        <div className="card">
          <h3 className="small">История исправлений за {period} · {BRANCH_NAMES[branch]}</h3>
          <table className="grid">
            <thead><tr><th>Дата</th><th>Товар</th><th>Было</th><th>Стало</th></tr></thead>
            <tbody>
              {editLogs.slice(-50).reverse().map((l) => {
                const p = products.find((x) => x.id === l.productId);
                return <tr key={l.id}>
                  <td>{new Date(l.date).toLocaleString('ru-RU')}</td>
                  <td>{p?.name ?? l.productId}</td>
                  <td className="num">{l.oldValue === null ? 'не введено' : l.oldValue}</td>
                  <td className="num">{l.newValue === null ? 'не введено' : l.newValue}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

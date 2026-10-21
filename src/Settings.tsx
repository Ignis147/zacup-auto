// ===== Раздел «Настройки и резервные копии» =====
import { useRef, useState } from 'react';
import type { Settings, FixedOrder, Brand } from './types';
import { db, saveSettings, exportBackup, restoreBackup, validateBackup } from './db';
import { downloadJson, readFileAsText, exportOrderToExcel } from './io';
import { fmtDate, fmtMoney } from './calc';

export function SettingsPage({
  settings, onSettingsChanged, onDataRestored, orders, brands,
}: {
  settings: Settings;
  onSettingsChanged: () => void;
  onDataRestored: () => void;
  orders: FixedOrder[];
  brands: Brand[];
}) {
  const [s, setS] = useState<Settings>({ ...settings });
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const set = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }));

  async function save() {
    await saveSettings(s);
    onSettingsChanged();
    setMsg({ kind: 'ok', text: 'Настройки сохранены.' });
  }

  async function doBackup() {
    const data = await exportBackup();
    downloadJson(data, `zakaznik-backup-${new Date().toISOString().slice(0, 10)}.json`);
    setMsg({ kind: 'ok', text: 'Резервная копия скачана.' });
  }

  async function onRestoreFile(f: File) {
    setMsg(null);
    try {
      const text = await readFileAsText(f);
      const parsed = JSON.parse(text);
      const err = validateBackup(parsed);
      if (err) { setMsg({ kind: 'err', text: 'Файл не прошёл проверку: ' + err + ' Текущие данные не изменены.' }); return; }
      if (!confirm('Внимание: восстановление ЗАМЕНИТ все текущие данные содержимым файла. Продолжить?')) return;
      await restoreBackup(parsed);
      setMsg({ kind: 'ok', text: 'Данные восстановлены из резервной копии.' });
      onDataRestored();
    } catch (e: any) {
      setMsg({ kind: 'err', text: 'Ошибка восстановления: ' + (e?.message ?? e) + '. Текущие данные не изменены.' });
    }
  }

  return (
    <div className="page">
      {msg && <div className={`card ${msg.kind === 'err' ? 'err' : 'ok-soft'}`}>{msg.text}</div>}

      <div className="card">
        <h3>Логистика по умолчанию (дни)</h3>
        <div className="row">
          <div className="field"><label>Оформление и сборка в Корее</label>
            <input type="number" min={0} value={s.orderPrepDays} onChange={(e) => set({ orderPrepDays: Number(e.target.value) })} /></div>
          <div className="field"><label>Доставка Корея → Владивосток</label>
            <input type="number" min={0} value={s.shipVldDays} onChange={(e) => set({ shipVldDays: Number(e.target.value) })} /></div>
          <div className="field"><label>Доп. доставка до Москвы</label>
            <input type="number" min={0} value={s.extraMskDays} onChange={(e) => set({ extraMskDays: Number(e.target.value) })} /></div>
        </div>
        <div className="small muted">Итого от оформления: Владивосток — {s.orderPrepDays + s.shipVldDays} дн., Москва — {s.orderPrepDays + s.shipVldDays + s.extraMskDays} дн. Для отдельного бренда значения можно переопределить на экране «Бренды».</div>
      </div>

      <div className="card">
        <h3>Товарный запас по умолчанию (месяцы)</h3>
        <div className="row">
          <div className="field"><label>Целевой запас</label>
            <input type="number" min={0} step="0.5" value={s.targetStockMonths} onChange={(e) => set({ targetStockMonths: Number(e.target.value) })} /></div>
          <div className="field"><label>Нижняя граница нормы (красный ниже)</label>
            <input type="number" min={0} step="0.5" value={s.minStockMonths} onChange={(e) => set({ minStockMonths: Number(e.target.value) })} /></div>
          <div className="field"><label>Верхняя граница нормы (оранжевый выше)</label>
            <input type="number" min={0} step="0.5" value={s.maxStockMonths} onChange={(e) => set({ maxStockMonths: Number(e.target.value) })} /></div>
        </div>
      </div>

      <div className="card">
        <h3>Курсы валют</h3>
        <div className="row">
          <div className="field"><label>USD → RUB</label>
            <input type="number" min={0} step="0.0001" value={s.usdRub} onChange={(e) => set({ usdRub: Number(e.target.value) })} /></div>
          <div className="field"><label>KRW → RUB</label>
            <input type="number" min={0} step="0.0001" value={s.krwRub} onChange={(e) => set({ krwRub: Number(e.target.value) })} /></div>
          <div className="field"><label>Дата обновления курсов</label>
            <input type="date" value={s.ratesUpdatedAt} onChange={(e) => set({ ratesUpdatedAt: e.target.value })} /></div>
        </div>
      </div>

      <div className="row">
        <button className="btn primary" onClick={save}>Сохранить настройки</button>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Резервные копии</h3>
        <div className="row">
          <button className="btn" onClick={doBackup}>⬇ Скачать резервную копию (JSON)</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>⬆ Восстановить из резервной копии</button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onRestoreFile(f); e.target.value = ''; }} />
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          Приложение работает без сервера: данные хранятся в IndexedDB конкретного браузера на этом устройстве.
          GitHub Pages не хранит пользовательскую базу и не синхронизирует данные между компьютерами —
          для переноса используйте резервную копию.
        </div>
      </div>

      <div className="card">
        <h3>Зафиксированные заказы (история)</h3>
        <table className="grid">
          <thead>
            <tr><th>№</th><th>Бренд</th><th>Дата</th><th>Позиций</th><th>Сумма (прайс)</th><th>Сумма, ₽ (на момент фиксации)</th><th>Поставка</th><th></th></tr>
          </thead>
          <tbody>
            {[...orders].sort((a, b) => (a.date < b.date ? 1 : -1)).map((o) => {
              const br = brands.find((b) => b.id === o.brandId);
              return (
                <tr key={o.id}>
                  <td><b>{o.number}</b></td>
                  <td>{br?.name ?? '—'}</td>
                  <td>{fmtDate(o.date)}</td>
                  <td className="num">{o.lines.length}</td>
                  <td className="num">{fmtMoney(o.totalSum)} {o.currency}</td>
                  <td className="num">{fmtMoney(o.totalSumRub)} ₽</td>
                  <td>{o.supplyCreated ? <span className="badge received">создана</span> : <span className="badge ordered">не создана</span>}</td>
                  <td><button className="btn small" disabled={!br} onClick={() => br && exportOrderToExcel(o, br, settings)}>Экспорт Excel</button></td>
                </tr>
              );
            })}
            {orders.length === 0 && <tr><td colSpan={8} className="muted">Зафиксированных заказов пока нет.</td></tr>}
          </tbody>
        </table>
        <div className="small muted">Заказы сохраняют цены и курсы на момент фиксации. Изменение прайса или курса не меняет историю.</div>
      </div>
    </div>
  );
}

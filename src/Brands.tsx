// ===== Раздел «Бренды» =====
import { useState } from 'react';
import type { Brand, Settings } from './types';
import { db } from './db';
import { fmtDate, totalLeadDays, effectiveLogistics } from './calc';

export function BrandsPage({
  brands, settings, onChanged, onOpenBrand,
}: {
  brands: Brand[];
  settings: Settings;
  onChanged: () => void;
  onOpenBrand: (brandId: number) => void;
}) {
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<Brand | null>(null);
  const error = '';

  async function createBrand() {
    const name = newName.trim();
    if (!name) return;
    await db.brands.add({
      name, currency: 'KRW', archived: false, createdAt: new Date().toISOString(),
    });
    setNewName('');
    onChanged();
  }

  async function saveEdit(b: Brand) {
    await db.brands.put({ ...b });
    setEditing(null);
    onChanged();
  }

  async function toggleArchive(b: Brand) {
    await db.brands.update(b.id!, { archived: !b.archived });
    onChanged();
  }

  return (
    <div className="page">
      <div className="card">
        <h3>Создать бренд</h3>
        <div className="row">
          <input style={{ padding: '5px 8px', border: '1px solid #bcccdc', borderRadius: 5 }}
            placeholder="Название бренда" value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createBrand()} />
          <button className="btn primary" onClick={createBrand}>Создать</button>
          {error && <span className="err">{error}</span>}
        </div>
      </div>

      <div className="card">
        <h3>Список брендов</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>Название</th><th>Валюта прайса</th><th>Логистика (дни)</th>
              <th>Целевой ТЗ, мес.</th><th>Норма ТЗ, мес.</th><th>Создан</th><th>Статус</th><th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => {
              const lg = effectiveLogistics(b, settings);
              const lead = totalLeadDays(lg);
              return (
                <tr key={b.id}>
                  <td><b>{b.name}</b></td>
                  <td>{b.currency}</td>
                  <td className="small">сборка {lg.orderPrep} · ВЛД {lead.vld} · МСК {lead.msk} от оформления</td>
                  <td className="num">{b.targetStockMonths ?? settings.targetStockMonths}</td>
                  <td className="num">{b.minStockMonths ?? settings.minStockMonths}–{b.maxStockMonths ?? settings.maxStockMonths}</td>
                  <td>{fmtDate(b.createdAt)}</td>
                  <td>{b.archived ? <span className="badge archived">Архив</span> : <span className="ok-soft">Рабочий</span>}</td>
                  <td className="row" style={{ gap: 4 }}>
                    <button className="btn small primary" onClick={() => onOpenBrand(b.id!)}>Открыть заказник</button>
                    <button className="btn small" onClick={() => setEditing({ ...b })}>Изменить</button>
                    <button className="btn small" onClick={() => toggleArchive(b)}>{b.archived ? 'Вернуть из архива' : 'Архивировать'}</button>
                  </td>
                </tr>
              );
            })}
            {brands.length === 0 && <tr><td colSpan={8} className="muted">Брендов пока нет. Создайте первый бренд выше.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <BrandDialog brand={editing} settings={settings} onClose={() => setEditing(null)} onSave={saveEdit} />
      )}
    </div>
  );
}

function BrandDialog({ brand, settings, onClose, onSave }: { brand: Brand; settings: Settings; onClose: () => void; onSave: (b: Brand) => void }) {
  const [b, setB] = useState<Brand>({ ...brand });
  const set = (patch: Partial<Brand>) => setB((prev) => ({ ...prev, ...patch }));
  const numOpt = (v: string | undefined) => (v === '' || v === undefined ? undefined : Number(v));

  return (
    <dialog open>
      <h3>Бренд: {brand.name}</h3>
      <div className="row">
        <div className="field" style={{ flex: 2 }}>
          <label>Название</label>
          <input value={b.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label>Валюта прайса</label>
          <select value={b.currency} onChange={(e) => set({ currency: e.target.value as any })}>
            <option value="KRW">KRW (воны)</option>
            <option value="USD">USD (доллары)</option>
          </select>
        </div>
      </div>
      <fieldset style={{ border: '1px solid #d3dae3', borderRadius: 6 }}>
        <legend className="small muted">Сроки логистики, дней (пусто — использовать общие настройки)</legend>
        <div className="row">
          <div className="field"><label>Оформление и сборка в Корее</label>
            <input type="number" min={0} placeholder={String(settings.orderPrepDays)}
              defaultValue={b.orderPrepDays ?? ''} onChange={(e) => set({ orderPrepDays: numOpt(e.target.value) })} /></div>
          <div className="field"><label>Доставка Корея → Владивосток</label>
            <input type="number" min={0} placeholder={String(settings.shipVldDays)}
              defaultValue={b.shipVldDays ?? ''} onChange={(e) => set({ shipVldDays: numOpt(e.target.value) })} /></div>
          <div className="field"><label>Доп. доставка до Москвы</label>
            <input type="number" min={0} placeholder={String(settings.extraMskDays)}
              defaultValue={b.extraMskDays ?? ''} onChange={(e) => set({ extraMskDays: numOpt(e.target.value) })} /></div>
        </div>
      </fieldset>
      <fieldset style={{ border: '1px solid #d3dae3', borderRadius: 6 }}>
        <legend className="small muted">Товарный запас (месяцы). Пусто — общие настройки.</legend>
        <div className="row">
          <div className="field"><label>Целевой запас</label>
            <input type="number" min={0} step="0.5" placeholder={String(settings.targetStockMonths)}
              defaultValue={b.targetStockMonths ?? ''} onChange={(e) => set({ targetStockMonths: numOpt(e.target.value) })} /></div>
          <div className="field"><label>Минимум нормы (красный ниже)</label>
            <input type="number" min={0} step="0.5" placeholder={String(settings.minStockMonths)}
              defaultValue={b.minStockMonths ?? ''} onChange={(e) => set({ minStockMonths: numOpt(e.target.value) })} /></div>
          <div className="field"><label>Максимум нормы (оранжевый выше)</label>
            <input type="number" min={0} step="0.5" placeholder={String(settings.maxStockMonths)}
              defaultValue={b.maxStockMonths ?? ''} onChange={(e) => set({ maxStockMonths: numOpt(e.target.value) })} /></div>
        </div>
      </fieldset>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!b.name.trim()} onClick={() => onSave({ ...b, name: b.name.trim() })}>Сохранить</button>
      </div>
    </dialog>
  );
}

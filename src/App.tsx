// ===== Корневой компонент приложения «Заказник» =====
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Brand, Product, SalesRecord, PeriodStatus, StockSnapshot, Supply, FixedOrder, Settings, PriceHistoryEntry, SalesEditLog } from './types';
import { db, getSettings, initDB } from './db';
import { BrandsPage } from './Brands';
import { ZakaznikPage, ProductDetail } from './Zakaznik';
import { SuppliesPage } from './Supplies';
import { SalesPage } from './Sales';
import { SettingsPage } from './Settings';

type Tab = 'brands' | 'zakaz' | 'supplies' | 'sales' | 'settings';

interface Data {
  brands: Brand[];
  products: Product[];
  sales: SalesRecord[];
  periods: PeriodStatus[];
  stocks: StockSnapshot[];
  supplies: Supply[];
  orders: FixedOrder[];
  priceHistory: PriceHistoryEntry[];
  salesLogs: SalesEditLog[];
}

const EMPTY: Data = { brands: [], products: [], sales: [], periods: [], stocks: [], supplies: [], orders: [], priceHistory: [], salesLogs: [] };

export default function App() {
  const [tab, setTab] = useState<Tab>('brands');
  const [data, setData] = useState<Data>(EMPTY);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [brandId, setBrandId] = useState<number | null>(null);
  const [detailProductId, setDetailProductId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      await initDB();
      const [brands, products, sales, periods, stocks, supplies, orders, priceHistory, salesLogs, s] = await Promise.all([
        db.brands.toArray(), db.products.toArray(), db.sales.toArray(), db.periods.toArray(),
        db.stocks.toArray(), db.supplies.toArray(), db.orders.toArray(), db.priceHistory.toArray(),
        db.salesLog.toArray(), getSettings(),
      ]);
      setData({ brands, products, sales, periods, stocks, supplies, orders, priceHistory, salesLogs });
      setSettings(s);
      setDbError(null);
    } catch (e: any) {
      setDbError(e?.message || 'Не удалось открыть локальную базу данных.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const brand = useMemo(() => data.brands.find((b) => b.id === brandId) ?? null, [data.brands, brandId]);
  const detailProduct = useMemo(() => data.products.find((p) => p.id === detailProductId) ?? null, [data.products, detailProductId]);

  if (loading) return <div className="page">Загрузка данных…</div>;

  if (dbError || !settings) {
    return (
      <div className="page">
        <div className="card" style={{ borderColor: '#c0392b' }}>
          <h3 style={{ color: '#c0392b', marginTop: 0 }}>Ошибка загрузки данных</h3>
          <p>{dbError || 'Не удалось получить настройки из базы данных.'}</p>
          <p className="muted">Проверьте, что браузер разрешает сайту хранить локальные данные (IndexedDB), и что это не режим «Инкогнито». После исправления обновите страницу.</p>
          <button onClick={() => window.location.reload()}>Обновить страницу</button>
        </div>
      </div>
    );
  }

  const needBrand = tab !== 'brands' && tab !== 'settings';

  return (
    <>
      <header className="app-header">
        <span className="logo">📦 Заказник</span>
        {([['brands', 'Бренды'], ['zakaz', 'Заказник'], ['supplies', 'Поставки'], ['sales', 'История продаж'], ['settings', 'Настройки и копии']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{label}</button>
        ))}
        <div className="brand-select">
          {data.brands.length > 0 && (
            <select value={brandId ?? ''} onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)}>
              <option value="" disabled>— выберите бренд —</option>
              {data.brands.map((b) => <option key={b.id} value={b.id}>{b.name}{b.archived ? ' (архив)' : ''}</option>)}
            </select>
          )}
        </div>
      </header>

      {needBrand && !brand ? (
        <div className="page"><div className="card muted">
          Выберите бренд в правом верхнем углу{data.brands.length === 0 ? ' или создайте его на вкладке «Бренды»' : ''}.
        </div></div>
      ) : tab === 'brands' ? (
        <BrandsPage brands={data.brands} settings={settings} onChanged={reload}
          onOpenBrand={(id) => { setBrandId(id); setTab('zakaz'); }} />
      ) : tab === 'zakaz' && brand ? (
        <ZakaznikPage brand={brand} products={data.products.filter((p) => p.brandId === brand.id)}
          sales={data.sales} periods={data.periods} stocks={data.stocks} supplies={data.supplies}
          orders={data.orders} settings={settings} onChanged={reload} onOpenProduct={setDetailProductId} />
      ) : tab === 'supplies' && brand ? (
        <SuppliesPage brand={brand} products={data.products.filter((p) => p.brandId === brand.id)}
          supplies={data.supplies} orders={data.orders} settings={settings} onChanged={reload} />
      ) : tab === 'sales' && brand ? (
        <SalesPage brand={brand} products={data.products.filter((p) => p.brandId === brand.id)}
          sales={data.sales} periods={data.periods} salesLogs={data.salesLogs} onChanged={reload} />
      ) : tab === 'settings' ? (
        <SettingsPage settings={settings} onSettingsChanged={reload} onDataRestored={() => { setBrandId(null); reload(); }}
          orders={data.orders} brands={data.brands} />
      ) : null}

      {detailProduct && brand && (
        <ProductDetail
          product={detailProduct} brand={brand}
          sales={data.sales} periods={data.periods} priceHistory={data.priceHistory}
          supplies={data.supplies} products={data.products} settings={settings}
          onClose={() => setDetailProductId(null)} onChanged={reload} />
      )}
    </>
  );
}

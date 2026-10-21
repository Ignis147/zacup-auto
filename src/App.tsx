/**
 * Минимальный стартовый экран «Заказник».
 * Полноценный рабочий экран-заказник (§17 ТЗ) — в разработке.
 * Здесь только проверка, что приложение собирается, запускается на GitHub Pages
 * и слой хранения (IndexedDB/Dexie) реально доступен.
 */
import { useEffect, useState } from 'react';
import { db } from './db/database';
import { APP_VERSION, SCHEMA_VERSION } from './db/schema';

type DbStatus = 'checking' | 'ok' | 'error';

export default function App() {
  const [dbStatus, setDbStatus] = useState<DbStatus>('checking');
  const [dbError, setDbError] = useState<string | null>(null);
  const [brandCount, setBrandCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await db.open();
        const n = await db.brands.count();
        if (!cancelled) {
          setBrandCount(n);
          setDbStatus('ok');
        }
      } catch (e) {
        if (!cancelled) {
          setDbError(e instanceof Error ? e.message : String(e));
          setDbStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <h1 className="text-2xl font-bold">Заказник</h1>
          <p className="mt-1 text-sm text-slate-300">
            Товарные матрицы брендов · продажи ВЛК/МСК · остатки из 1С · поставки · прогнозы и заказы
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-5">
          <h2 className="text-lg font-semibold text-amber-800">Интерфейс пока в разработке</h2>
          <p className="mt-2 text-sm text-amber-800">
            Единый рабочий экран «Заказник» (§17 ТЗ), импорт/экспорт XLSX и резервные копии будут
            добавлены в следующих этапах. Уже готовы и протестированы: расчётное ядро и слой
            постоянного хранения данных (Dexie.js + IndexedDB).
          </p>
        </div>

        <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="font-semibold">Состояние системы</h3>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
              Расчётное ядро (СДП, прогнозы, коробки, ценовые ступени, валюты) — реализовано, тесты проходят
            </li>
            <li className="flex items-center gap-2">
              <span
                className={
                  'inline-block h-2.5 w-2.5 rounded-full ' +
                  (dbStatus === 'ok'
                    ? 'bg-emerald-500'
                    : dbStatus === 'error'
                      ? 'bg-red-500'
                      : 'bg-slate-300')
                }
              />
              Хранилище IndexedDB:{' '}
              {dbStatus === 'checking' && 'проверка…'}
              {dbStatus === 'ok' && (
                <>
                  доступно (схема v{SCHEMA_VERSION}, брендов в базе: {brandCount ?? 0})
                </>
              )}
              {dbStatus === 'error' && <>ошибка: {dbError}</>}
            </li>
            <li className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-300" />
              Рабочий экран «Заказник», XLSX импорт/экспорт, UI резервных копий — в разработке
            </li>
          </ul>
        </section>

        <section className="mt-6 rounded-lg border border-sky-200 bg-sky-50 p-5 text-sm text-sky-900">
          <h3 className="font-semibold">Важно о хранении данных (§26 ТЗ)</h3>
          <p className="mt-2">
            Все данные хранятся локально в IndexedDB этого браузера и доступны только из того же
            профиля и по тому же адресу сайта. Очистка данных сайта, приватный режим или другой
            браузер приведут к недоступности базы. Регулярно выгружайте полную резервную копию
            (кнопка появится в настройках).
          </p>
        </section>

        <footer className="mt-8 text-center text-xs text-slate-400">
          Заказник v{APP_VERSION} · статическое SPA без сервера · schema v{SCHEMA_VERSION}
        </footer>
      </main>
    </div>
  );
}

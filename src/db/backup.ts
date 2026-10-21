/**
 * Полная резервная копия JSON и атомарное восстановление (§27 ТЗ).
 *
 *  - Экспорт: все таблицы + formatVersion/schemaVersion/appVersion/exportedAt/counts.
 *  - Импорт: проверка формата, версий и связей (сироты → отказ), предпросмотр итогов,
 *    АТОМАРНАЯ замена в одной транзакции — при ошибке текущая база НЕ портится.
 */
import { db } from './database';
import { APP_VERSION, BACKUP_FORMAT_VERSION, SCHEMA_VERSION, type BackupFile } from './schema';
import { nowISO } from './util';

export async function exportBackup(): Promise<BackupFile> {
  const [brands, products, priceVersions, sales, stock, orders, settings, brandSettings, audit] = await Promise.all([
    db.brands.toArray(), db.products.toArray(), db.priceVersions.toArray(),
    db.sales.toArray(), db.stock.toArray(), db.orders.toArray(),
    db.settings.toArray(), db.brandSettings.toArray(), db.audit.toArray(),
  ]);
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: nowISO(),
    counts: {
      brands: brands.length, products: products.length, priceVersions: priceVersions.length,
      sales: sales.length, stock: stock.length, orders: orders.length,
      settings: settings.length, brandSettings: brandSettings.length, audit: audit.length,
    },
    data: { brands, products, priceVersions, sales, stock, orders, settings, brandSettings, audit },
  };
}

/** Имя файла по формату ТЗ: zakaznik-backup-YYYY-MM-DD-HHMM.json */
export function backupFileName(d = new Date()): string {
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `zakaznik-backup-${date}-${time}.json`;
}

export interface RestoreSummary {
  brands: number; products: number; orders: number; sales: number; stock: number;
}

/** Валидация структуры, версий и связей. Бросает Error с конкретной причиной. */
export function validateBackup(raw: unknown): BackupFile {
  if (typeof raw !== 'object' || raw === null) throw new Error('Файл не является объектом JSON');
  const b = raw as BackupFile;
  if (b.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Несовместимый формат копии: formatVersion=${String(b.formatVersion)} (ожидается ${BACKUP_FORMAT_VERSION}). Перед продолжением сохраните текущую базу.`);
  }
  if (typeof b.schemaVersion !== 'number' || b.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Копия создана более новой версией схемы (schemaVersion=${String(b.schemaVersion)} > ${SCHEMA_VERSION}) — обновите приложение`);
  }
  if (!b.data || typeof b.data !== 'object') throw new Error('В копии отсутствует блок data');
  const need: Array<keyof BackupFile['data']> = ['brands', 'products', 'priceVersions', 'sales', 'stock', 'orders', 'settings', 'brandSettings', 'audit'];
  for (const k of need) {
    if (!Array.isArray(b.data[k])) throw new Error(`В копии отсутствует или повреждён массив «${k}»`);
  }
  // Проверка целостности связей (§27/§28: битый JSON не должен испортить базу)
  const brandIds = new Set(b.data.brands.map((x) => x.id));
  const productIds = new Set(b.data.products.map((x) => x.id));
  for (const p of b.data.products) if (!brandIds.has(p.brandId)) throw new Error(`Товар ${p.barcode} ссылается на несуществующий бренд ${p.brandId}`);
  for (const pv of b.data.priceVersions) if (!productIds.has(pv.productId)) throw new Error(`Версия цены ${pv.id} ссылается на несуществующий товар`);
  for (const s of b.data.sales) if (!productIds.has(s.productId)) throw new Error(`Запись продаж ${s.id} ссылается на несуществующий товар`);
  for (const s of b.data.stock) if (!productIds.has(s.productId)) throw new Error(`Снимок остатка ${s.id} ссылается на несуществующий товар`);
  for (const o of b.data.orders) {
    if (!brandIds.has(o.brandId)) throw new Error(`Заказ ${o.number} ссылается на несуществующий бренд`);
    for (const l of o.lines) if (!productIds.has(l.productId)) throw new Error(`Позиция заказа ${o.number} ссылается на несуществующий товар ${l.barcode}`);
  }
  // дубликаты id
  const dupCheck = <T extends { id: string }>(arr: T[], name: string) => {
    const seen = new Set<string>();
    for (const x of arr) {
      if (seen.has(x.id)) throw new Error(`Дубликат id «${x.id}» в таблице ${name} — копия повреждена`);
      seen.add(x.id);
    }
  };
  dupCheck(b.data.brands, 'brands');
  dupCheck(b.data.products, 'products');
  dupCheck(b.data.orders, 'orders');
  return b;
}

export function summarizeBackup(b: BackupFile): RestoreSummary {
  return {
    brands: b.data.brands.length, products: b.data.products.length,
    orders: b.data.orders.length, sales: b.data.sales.length, stock: b.data.stock.length,
  };
}

/**
 * Атомарное восстановление: clear + bulkPut в ОДНОЙ транзакции.
 * При любой ошибке транзакция откатывается — старая база остаётся нетронутой (§28).
 */
export async function restoreBackup(backup: BackupFile): Promise<void> {
  const validated = validateBackup(backup);
  await db.transaction(
    'rw',
    db.brands, db.products, db.priceVersions, db.sales, db.stock, db.orders, db.settings, db.brandSettings, db.audit,
    async () => {
      await Promise.all([
        db.brands.clear(), db.products.clear(), db.priceVersions.clear(), db.sales.clear(),
        db.stock.clear(), db.orders.clear(), db.settings.clear(), db.brandSettings.clear(), db.audit.clear(),
      ]);
      await Promise.all([
        db.brands.bulkAdd(validated.data.brands),
        db.products.bulkAdd(validated.data.products),
        db.priceVersions.bulkAdd(validated.data.priceVersions),
        db.sales.bulkAdd(validated.data.sales),
        db.stock.bulkAdd(validated.data.stock),
        db.orders.bulkAdd(validated.data.orders),
        db.settings.bulkAdd(validated.data.settings),
        db.brandSettings.bulkAdd(validated.data.brandSettings),
        db.audit.bulkAdd(validated.data.audit),
      ]);
      await db.audit.add({
        id: `aud_restore_${Date.now()}`, brandId: null, at: nowISO(), actor: 'оператор',
        entity: 'database', entityId: 'all', action: 'restore',
        details: `Восстановлена база из копии (экспорт ${validated.exportedAt}, v${validated.appVersion})`,
      });
    },
  );
}

/** Разбор JSON-текста с понятной ошибкой. */
export function parseBackupJson(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Файл не является корректным JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateBackup(raw);
}

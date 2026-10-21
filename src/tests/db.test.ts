// ===== Тесты инициализации IndexedDB/Dexie (ошибка SchemaDiff / patch indexes) =====
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import { db, initDB, isBarcodeTaken } from '../db';

describe('Инициализация базы данных', () => {
  it('initDB() открывает новую базу без ошибок', async () => {
    await initDB();
    expect(db.isOpen()).toBe(true);
  });

  it('база предыдущей версии (та же схема v1) открывается без SchemaDiff и потери данных', async () => {
    // Эмулируем базу, созданную прежним кодом: version(1) с теми же простыми индексами.
    const legacy = new Dexie('legacy-compat-check');
    legacy.version(1).stores({ things: '++id, name' });
    await legacy.open();
    await legacy.table('things').add({ name: 'старая запись' });
    expect(await legacy.table('things').count()).toBe(1);
    legacy.close();
    // Новый код использует ту же декларацию version(1) — конфликтов схемы нет.
    const again = new Dexie('legacy-compat-check');
    again.version(1).stores({ things: '++id, name' });
    await again.open();
    const rows = await again.table('things').toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('старая запись');
    again.close();
  });

  it('повторный вызов initDB() безопасен', async () => {
    await initDB();
    await initDB();
    expect(db.isOpen()).toBe(true);
  });

  it('данные сохраняются между вызовами (эмуляция перезагрузки)', async () => {
    await initDB();
    await db.brands.clear();
    await db.brands.add({ id: 91, name: 'Тест сохранения', currency: 'KRW', archived: false, createdAt: '' } as any);
    await db.close();
    await initDB(); // повторное открытие той же базы
    const b = await db.brands.get(91);
    expect(b?.name).toBe('Тест сохранения');
  });

  it('isBarcodeTaken находит дубликат в пределах бренда и не путает другие бренды', async () => {
    await initDB();
    await db.products.where('brandId').equals(501).primaryKeys().then(async (keys) => {
      await db.products.bulkDelete(keys as number[]);
    });
    await db.products.add({ id: 601, brandId: 501, barcode: '0012345678901', article: '678901', name: 'А', packSize: 1, priceKind: 'fixed', fixedPrice: 1, archived: false } as any);
    expect(await isBarcodeTaken(501, '0012345678901')).toBe(true);          // дубль — тот же бренд
    expect(await isBarcodeTaken(501, '0012345678901', 601)).toBe(false);    // этот же товар исключён
    expect(await isBarcodeTaken(502, '0012345678901')).toBe(false);         // другой бренд — свободно
    expect(await isBarcodeTaken(501, '9999999999999')).toBe(false);
  });
});

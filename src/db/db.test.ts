/**
 * Интеграционные тесты слоя хранения (IndexedDB через fake-indexeddb).
 * Покрывают приёмочные сценарии §21/§28, относящиеся к данным:
 * сохранение между «перезапусками», изоляция брендов, штрихкоды-строки, десятичные цены,
 * история цен, закрытие месяцев, атомарность восстановления, защита утверждённых снимков.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { ZakaznikDB } from '../db/database';
import { db } from '../db/database';
import { brandsRepo, brandSettingsRepo } from '../db/repos/brands';
import { productsRepo } from '../db/repos/products';
import { salesRepo } from '../db/repos/sales';
import { stockRepo, isStockStale } from '../db/repos/stock';
import { ordersRepo } from '../db/repos/orders';
import { settingsRepo } from '../db/repos/settings';
import { exportBackup, restoreBackup, parseBackupJson, validateBackup } from '../db/backup';
import { loadBrandBundle, arrivalsFromOrders, forecastForProduct } from '../services/dataServices';
import { DEFAULT_RATES, type ExchangeRates } from '../core/types';

let counter = 0;
function freshDb(): ZakaznikDB {
  // каждый тест — новая база (эмуляция перезапуска браузера с новой БД)
  const d = new ZakaznikDB(`test-db-${++counter}`);
  return d;
}

/** Подменяем синглтон db для репозиториев: репозитории импортируют db из модуля —
 *  поэтому переопределим через vi.mock на уровне импорта нельзя (статический импорт),
 *  используем прямую замену внутреннего объекта через dynamic re-import. */
import * as databaseModule from '../db/database';
import * as backupModule from '../db/backup';

async function useDb(d: ZakaznikDB) {
  // Заменяем синглтон во всех модулях слоя данных
  Object.defineProperty(databaseModule, 'db', { value: d, configurable: true, writable: true });
  // backup.ts импортирует db статически — его функции используют binding из ESM;
  // в Vitest ESM-привязки live, поэтому замена работает через defineProperty выше.
  void backupModule;
  await d.open();
}

beforeEach(async () => {
  const d = freshDb();
  await useDb(d);
});

const rates: ExchangeRates = { ...DEFAULT_RATES };

describe('Бренды', () => {
  it('создание, чтение, переименование, архивирование; дубликат имени запрещён', async () => {
    const b = await brandsRepo.create('Alpha');
    expect(b.id).toBeTruthy();
    await expect(brandsRepo.create('alpha')).rejects.toThrow(/уже существует/i);
    await brandsRepo.rename(b.id, 'Alpha2');
    expect((await brandsRepo.get(b.id))!.name).toBe('Alpha2');
    await brandsRepo.setArchived(b.id, true);
    expect((await brandsRepo.list(false)).length).toBe(0);
    expect((await brandsRepo.list(true)).length).toBe(1);
  });

  it('настройки бренда по умолчанию 30+60+20 и ТЗ 2–5, редактирование с валидацией', async () => {
    const b = await brandsRepo.create('Beta');
    const s = await brandSettingsRepo.get(b.id);
    expect(s.leadTimes).toEqual({ prepDays: 30, toVLKDays: 60, vlkToMSKDays: 20 });
    expect([s.tzMinMonths, s.tzMaxMonths, s.targetTZMonths]).toEqual([2, 5, 3]);
    const upd = await brandSettingsRepo.update(b.id, { leadTimes: { prepDays: 25, toVLKDays: 60, vlkToMSKDays: 20 }, tzMinMonths: 3 });
    expect(upd.leadTimes.prepDays).toBe(25);
    await expect(brandSettingsRepo.update(b.id, { tzMinMonths: -1 })).rejects.toThrow();
    await expect(brandSettingsRepo.update(b.id, { tzMinMonths: 6, tzMaxMonths: 5 })).rejects.toThrow(/ниже верхней|выше/);
  });
});

describe('Товарная матрица', () => {
  it('штрихкод хранится строкой с ведущими нулями; артикул авто; дубль в бренде запрещён', async () => {
    const b = await brandsRepo.create('KrA');
    const p = await productsRepo.create({
      brandId: b.id, barcode: '0001234567890', name: 'Товар А', packSize: 40,
      priceMode: 'fixed', fixedPrice: '12760', tiers: [], currency: 'KRW',
    });
    expect(p.barcode).toBe('0001234567890');
    expect(p.article).toBe('567890');
    await expect(productsRepo.create({
      brandId: b.id, barcode: '0001234567890', name: 'Дубль', packSize: 10,
      priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW',
    })).rejects.toThrow(/Дубликат/);
    // тот же штрихкод в ДРУГОМ бренде разрешён (изоляция)
    const b2 = await brandsRepo.create('KrB');
    const p2 = await productsRepo.create({
      brandId: b2.id, barcode: '0001234567890', name: 'Тот же код, другой бренд', packSize: 10,
      priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW',
    });
    expect(p2.id).toBeTruthy();
  });

  it('валидация: штрихкод <6 символов, некратная кратность, неверные ступени — ошибки', async () => {
    const b = await brandsRepo.create('Val');
    const base = { brandId: b.id, name: 'X', packSize: 40, priceMode: 'fixed' as const, fixedPrice: '10', tiers: [], currency: 'KRW' as const };
    await expect(productsRepo.create({ ...base, barcode: '12345' })).rejects.toThrow(/короче 6/);
    await expect(productsRepo.create({ ...base, barcode: '123456', packSize: 0 })).rejects.toThrow(/Кратность/);
    await expect(productsRepo.create({
      ...base, barcode: '123456', priceMode: 'tiers', fixedPrice: null,
      tiers: [{ minBoxes: 1, maxBoxes: 10, pricePerUnit: '5' }, { minBoxes: 5, maxBoxes: null, pricePerUnit: '4' }],
    })).rejects.toThrow(/пересека/);
  });

  it('изменение цены создаёт новую версию прайса с previousVersionId; история сохраняется', async () => {
    const b = await brandsRepo.create('Pric');
    const p = await productsRepo.create({
      brandId: b.id, barcode: '2000000000001', name: 'Прайс', packSize: 40,
      priceMode: 'fixed', fixedPrice: '1000', tiers: [], currency: 'KRW',
    });
    let hist = await productsRepo.priceHistory(p.id);
    expect(hist.length).toBe(1);
    await productsRepo.update(p.id, { fixedPrice: '1100' });
    hist = await productsRepo.priceHistory(p.id);
    expect(hist.length).toBe(2);
    expect(hist[1].previousVersionId).toBe(hist[0].id);
    expect(hist[1].fixedPrice).toBe('1100');
    // цена как десятичная СТРОКА
    expect(typeof hist[1].fixedPrice).toBe('string');
    // изменение без изменения цены — новой версии нет
    await productsRepo.update(p.id, { name: 'Переименован' });
    expect((await productsRepo.priceHistory(p.id)).length).toBe(2);
  });

  it('архивирование товара не удаляет исторические продажи', async () => {
    const b = await brandsRepo.create('Arch');
    const p = await productsRepo.create({ brandId: b.id, barcode: '3000000000010', name: 'Арх', packSize: 10, priceMode: 'fixed', fixedPrice: '5', tiers: [], currency: 'KRW' });
    await salesRepo.setValue(p.id, b.id, 'VLK', '2025-01', 100);
    await productsRepo.setArchived(p.id, true);
    expect(await productsRepo.listByBrand(b.id)).toHaveLength(0);
    expect(await productsRepo.listByBrand(b.id, true)).toHaveLength(1);
    expect((await salesRepo.listByProduct(p.id))).toHaveLength(1);
  });

  it('поиск по штрихкоду/артикулу/названию и массовый импорт с журналом ошибок', async () => {
    const b = await brandsRepo.create('Srch');
    const res = await productsRepo.bulkImport(b.id, [
      { brandId: b.id, barcode: '4000000000011', name: 'Первый', packSize: 10, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW' },
      { brandId: b.id, barcode: '4000000000011', name: 'Дубль', packSize: 10, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW' },
      { brandId: b.id, barcode: '4000000000022', name: 'Второй Special', packSize: 10, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW' },
    ]);
    expect(res.created.length).toBe(2);
    expect(res.errors.length).toBe(1);
    expect((await productsRepo.search(b.id, 'special')).length).toBe(1);
    expect((await productsRepo.search(b.id, '000022')).length).toBe(1);
    expect((await productsRepo.search(b.id, '000022'))[0].article).toBe('000022');
  });
});

describe('Продажи и закрытие месяцев (§6)', () => {
  it('пустое значение не подменяется нулём; правка снимает подтверждение', async () => {
    const b = await brandsRepo.create('Sale');
    const p = await productsRepo.create({ brandId: b.id, barcode: '5000000000013', name: 'С', packSize: 10, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW' });
    await salesRepo.setValue(p.id, b.id, 'VLK', '2025-01', null);
    const r = await salesRepo.getOne(p.id, 'VLK', '2025-01');
    expect(r!.qty).toBeNull();
    expect(r!.confirmed).toBe(false);
    await salesRepo.setValue(p.id, b.id, 'VLK', '2025-01', 50);
    expect((await salesRepo.getOne(p.id, 'VLK', '2025-01'))!.qty).toBe(50);
    await expect(salesRepo.setValue(p.id, b.id, 'VLK', '2025-01', -5)).rejects.toThrow(/отрицатель/);
  });

  it('закрытие требует подтверждения нулей; открытие закрытого месяца — с причиной и журналом', async () => {
    const b = await brandsRepo.create('Clos');
    const p = await productsRepo.create({ brandId: b.id, barcode: '5000000000024', name: 'Ц', packSize: 10, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW' });
    for (const br of ['VLK', 'MSK'] as const) await salesRepo.setValue(p.id, b.id, br, '2025-03', 0);
    await expect(salesRepo.closeMonth(b.id, '2025-03')).rejects.toThrow(/подтверждения/);
    const res = await salesRepo.closeMonth(b.id, '2025-03', { confirmZeroOnly: true, allowIncomplete: false });
    expect(res.closed).toBe(2);
    expect((await salesRepo.getOne(p.id, 'VLK', '2025-03'))!.status).toBe('closed');
    await expect(salesRepo.openMonth(b.id, '2025-03', '')).rejects.toThrow(/причину/);
    await salesRepo.openMonth(b.id, '2025-03', 'Ошибка ввода');
    expect((await salesRepo.getOne(p.id, 'VLK', '2025-03'))!.status).toBe('open');
    const audit = await databaseModule.db.audit.where('action').equals('open-month').toArray();
    expect(audit.length).toBe(1);
  });
});

describe('Остатки из 1С (§7, §11)', () => {
  it('история снимков; снимок раньше подтверждённого поступления запрещён; статус stale', async () => {
    const b = await brandsRepo.create('Stk');
    const p = await productsRepo.create({ brandId: b.id, barcode: '6000000000015', name: 'Ост', packSize: 10, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW' });
    await stockRepo.setSnapshot(p.id, b.id, 'VLK', 100, '2026-10-01T10:00:00.000Z');
    await stockRepo.setSnapshot(p.id, b.id, 'VLK', 150, '2026-10-10T10:00:00.000Z');
    expect((await stockRepo.getCurrent(p.id, 'VLK'))!.qty).toBe(150);
    expect((await stockRepo.history(p.id, 'VLK')).length).toBe(2);
    await expect(stockRepo.setSnapshot(p.id, b.id, 'VLK', -1, '2026-10-11T10:00:00.000Z')).rejects.toThrow(/отрицатель/);

    // создадим поставку и отметим поступление ВЛК 2026-10-15
    const o = await ordersRepo.createDraft({ brandId: b.id, currency: 'KRW' });
    await ordersRepo.setLine(o.id, p.id, 100, 0);
    await ordersRepo.approve(o.id, rates, {}, {}, []);
    await ordersRepo.setStatusPreparing(o.id);
    await ordersRepo.confirmExit(o.id, '2026-10-12');
    await ordersRepo.markBranchReceived(o.id, 'VLK', '2026-10-15');

    // остаток не изменился автоматически!
    expect((await stockRepo.getCurrent(p.id, 'VLK'))!.qty).toBe(150);
    // прогноз неактуален до обновления 1С
    const st = await isStockStale(p.id, 'VLK');
    expect(st.stale).toBe(true);
    // снимок раньше поступления — отказ
    await expect(stockRepo.setSnapshot(p.id, b.id, 'VLK', 250, '2026-10-14T10:00:00.000Z')).rejects.toThrow(/раньше подтверждённого/);
    // корректный снимок — stale снимается
    await stockRepo.setSnapshot(p.id, b.id, 'VLK', 250, '2026-10-16T10:00:00.000Z');
    expect((await isStockStale(p.id, 'VLK')).stale).toBe(false);
  });
});

describe('Заказы и поставки (§9, §10, §18)', () => {
  async function orderFixture() {
    const b = await brandsRepo.create('Ord');
    const p = await productsRepo.create({ brandId: b.id, barcode: '7000000000016', name: 'Заказ', packSize: 40, priceMode: 'fixed', fixedPrice: '12760', tiers: [], currency: 'KRW' });
    const o = await ordersRepo.createDraft({ brandId: b.id, issueDate: '2026-10-21', currency: 'KRW' });
    return { b, p, o };
  }

  it('даты по умолчанию 30+60+20 от даты оформления', async () => {
    const { o } = await orderFixture();
    expect(o.exitDate).toBe('2026-11-20');
    expect(o.vlkDate).toBe('2027-01-19');
    expect(o.mskDate).toBe('2027-02-08');
  });

  it('распределение Qобщ=QВЛК+QМСК; отрицательные запрещены; чужой бренд запрещён', async () => {
    const { o, p } = await orderFixture();
    const upd = await ordersRepo.setLine(o.id, p.id, 800, 1600);
    expect(upd.lines[0].qtyVLK + upd.lines[0].qtyMSK).toBe(2400);
    await expect(ordersRepo.setLine(o.id, p.id, -40, 100)).rejects.toThrow(/отрицатель/);
    const b2 = await brandsRepo.create('Other');
    const p2 = await productsRepo.create({ brandId: b2.id, barcode: '7000000000099', name: 'Чужой', packSize: 10, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW' });
    await expect(ordersRepo.setLine(o.id, p2.id, 10, 0)).rejects.toThrow(/другому бренду/);
  });

  it('утверждение блокируется при некратных количествах; снимок фиксирует цену и курсы', async () => {
    const { o, p } = await orderFixture();
    await ordersRepo.setLine(o.id, p.id, 810, 1600); // 810 не кратно 40
    await expect(ordersRepo.approve(o.id, rates, {}, {}, [])).rejects.toThrow(/кратн/);
    await ordersRepo.setLine(o.id, p.id, 800, 1600);
    const approved = await ordersRepo.approve(o.id, { usdRub: '85', krwRub: '0.063' }, {}, {}, []);
    expect(approved.status).toBe('approved');
    expect(approved.snapshot!.lines[0].unitPrice).toBe('12760');
    expect(approved.snapshot!.rates.krwRub).toBe('0.063');
    expect(approved.snapshot!.totals.primary).toBe('30624000.00');
    expect(approved.snapshot!.totals.rub).toBe('1929312.00');
    // неизменяемость утверждённого заказа
    await expect(ordersRepo.setLine(o.id, p.id, 400, 400)).rejects.toThrow(/неизменяем/);
    // изменение текущего прайса НЕ трогает снимок
    await productsRepo.update(p.id, { fixedPrice: '99999' });
    expect((await ordersRepo.mustGet(o.id)).snapshot!.lines[0].unitPrice).toBe('12760');
  });

  it('полный цикл: подготовка → выход → поступление ВЛК (частично) → МСК (полностью); двойное поступление запрещено', async () => {
    const { o, p } = await orderFixture();
    await ordersRepo.setLine(o.id, p.id, 800, 1600);
    await ordersRepo.approve(o.id, rates, {}, {}, []);
    await ordersRepo.setStatusPreparing(o.id);
    const transit = await ordersRepo.confirmExit(o.id, '2026-12-05');
    expect(transit.status).toBe('in_transit');
    const vlk = await ordersRepo.markBranchReceived(o.id, 'VLK', '2027-02-03');
    expect(vlk.status).toBe('partial'); // МСК ещё ожидается
    expect(vlk.allocations[p.id].VLK.received).toBe(true);
    expect(vlk.allocations[p.id].MSK.received).toBe(false);
    await expect(ordersRepo.markBranchReceived(o.id, 'VLK', '2027-02-04')).rejects.toThrow(/двойное/);
    // полученная часть заблокирована для обычного редактирования
    await expect(ordersRepo.setLine(o.id, p.id, 400, 2000)).rejects.toThrow(/уже получена/);
    // отправленная поставка без причины не правится вообще
    await expect(ordersRepo.setLine(o.id, p.id, 800, 1600)).rejects.toThrow(/неизменяема напрямую/);
    // непоступившую часть менять можно, но reallocate без причины запрещён
    await expect(ordersRepo.reallocate(o.id, p.id, 400, '')).rejects.toThrow(/Причина/);
    // ...а с причиной — можно: меняется только непоступившая МСК-часть, ВЛК остаётся 800
    const realloc = await ordersRepo.reallocate(o.id, p.id, 800, 'перераспределение из-за недогруза');
    expect(realloc.lines[0].qtyMSK).toBe(1600);
    expect(realloc.allocations[p.id].VLK.qty).toBe(800);
    expect(realloc.allocations[p.id].VLK.received).toBe(true);
    // контролируемая корректировка количества тоже требует причины и не трогает полученную часть
    await expect(ordersRepo.correctQuantity(o.id, p.id, 400, 1600, '')).rejects.toThrow(/Причина/);
    await expect(ordersRepo.correctQuantity(o.id, p.id, 400, 1600, 'ошибка ввода')).rejects.toThrow(/уже получена/);
    const msk = await ordersRepo.markBranchReceived(o.id, 'MSK', '2027-02-23');
    expect(msk.status).toBe('completed');
    // после закрытия нельзя править даже с причиной
    await expect(ordersRepo.correctQuantity(o.id, p.id, 400, 400, 'после закрытия')).rejects.toThrow(/Закрытый/);
  });

  it('правка живой поставки на подготовке: текущие данные меняются, утверждённый снимок — нет (§5, §18)', async () => {
    const { o, p } = await orderFixture();
    await ordersRepo.setLine(o.id, p.id, 800, 1600);
    const approved = await ordersRepo.approve(o.id, rates, {}, {}, []);
    await ordersRepo.setStatusPreparing(o.id);
    // свободная правка до отправки
    const upd = await ordersRepo.setLine(o.id, p.id, 400, 400);
    expect(upd.lines[0].qtyVLK).toBe(400);
    // исходный снимок сохранён без изменений
    const fresh = await ordersRepo.mustGet(o.id);
    expect(fresh.snapshot!.lines[0].qtyVLK).toBe(800);
    expect(fresh.snapshot!.lines[0].lineTotal).toBe(approved.snapshot!.lines[0].lineTotal);
    // изменения зафиксированы в аудите
    const audit = await db.audit.where('entityId').equals(o.id).toArray();
    expect(audit.some((a) => a.action === 'set-line')).toBe(true);
  });

  it('учёт ожидаемых поступлений ровно один раз; черновик не учитывается; свой заказ исключается', async () => {
    const { o, p } = await orderFixture();
    await ordersRepo.setLine(o.id, p.id, 400, 400);
    // draft — не поступает в ожидаемые
    let orders = await ordersRepo.expectedArrivals(o.brandId);
    expect(arrivalsFromOrders(orders, 'VLK').length).toBe(0);
    await ordersRepo.approve(o.id, rates, {}, {}, []);
    orders = await ordersRepo.expectedArrivals(o.brandId);
    const arr = arrivalsFromOrders(orders, 'VLK');
    expect(arr.length).toBe(1);
    expect(arr[0].qty).toBe(400);
    // excludeOrderId — прогноз ДО нового заказа не удваивает собственное поступление
    expect(arrivalsFromOrders(orders, 'VLK', o.id).length).toBe(0);
  });

  it('копирование заказа в новый черновик', async () => {
    const { o, p } = await orderFixture();
    await ordersRepo.setLine(o.id, p.id, 800, 1600);
    await ordersRepo.approve(o.id, rates, {}, {}, []);
    const copy = await ordersRepo.copyAsDraft(o.id);
    expect(copy.status).toBe('draft');
    expect(copy.copiedFromOrderId).toBe(o.id);
    expect(copy.lines[0].qtyVLK).toBe(800);
    expect(copy.snapshot).toBeNull();
    void p;
  });

  it('отмена с сохранением истории; отмена с полученной частью запрещена', async () => {
    const { o, p } = await orderFixture();
    await ordersRepo.setLine(o.id, p.id, 400, 400);
    await expect(ordersRepo.cancel(o.id, '')).rejects.toThrow(/Причина/);
    const c = await ordersRepo.cancel(o.id, 'Ошибка ввода');
    expect(c.status).toBe('cancelled');
    expect((await databaseModule.db.audit.where('action').equals('cancel').toArray()).length).toBe(1);

    const o2 = await ordersRepo.createDraft({ brandId: o.brandId, currency: 'KRW' });
    await ordersRepo.setLine(o2.id, p.id, 400, 400);
    await ordersRepo.approve(o2.id, rates, {}, {}, []);
    await ordersRepo.setStatusPreparing(o2.id);
    await ordersRepo.confirmExit(o2.id, '2026-12-01');
    await ordersRepo.markBranchReceived(o2.id, 'VLK', '2027-01-30');
    await expect(ordersRepo.cancel(o2.id, 'x')).rejects.toThrow(/полученные/);
  });
});

describe('Настройки и курсы (§16)', () => {
  it('курсы по умолчанию, валидация > 0', async () => {
    const s = await settingsRepo.get();
    expect(s.rates).toEqual({ usdRub: '85', krwRub: '0.063' });
    await settingsRepo.setRates({ usdRub: '90', krwRub: '0.07' });
    expect((await settingsRepo.get()).rates.usdRub).toBe('90');
    await expect(settingsRepo.setRates({ usdRub: '0', krwRub: '0.063' })).rejects.toThrow(/должен быть > 0/);
    await expect(settingsRepo.setRates({ usdRub: '-1', krwRub: '0.063' })).rejects.toThrow();
    await expect(settingsRepo.setRates({ usdRub: 'abc', krwRub: '0.063' })).rejects.toThrow();
  });
});

describe('Резервные копии (§27, §28)', () => {
  it('экспорт → изменение данных → восстановление: всё возвращается без потерь и дублей', async () => {
    const b = await brandsRepo.create('Bkp');
    const p = await productsRepo.create({ brandId: b.id, barcode: '8000000000017', name: 'Копия', packSize: 40, priceMode: 'fixed', fixedPrice: '12760', tiers: [], currency: 'KRW' });
    const o = await ordersRepo.createDraft({ brandId: b.id, issueDate: '2026-10-21', currency: 'KRW' });
    await ordersRepo.setLine(o.id, p.id, 800, 1600);
    await ordersRepo.approve(o.id, rates, {}, {}, []);
    await salesRepo.setValue(p.id, b.id, 'VLK', '2025-01', 300);
    await stockRepo.setSnapshot(p.id, b.id, 'VLK', 100, '2026-10-01T10:00:00.000Z');

    const backup = await exportBackup();
    const json = JSON.stringify(backup);
    expect(backup.formatVersion).toBe(1);
    expect(backup.counts.products).toBe(1);

    // изменяем данные после экспорта
    await productsRepo.update(p.id, { fixedPrice: '99999', name: 'Изменён' });
    await brandsRepo.create('NewAfter');

    // восстанавливаем в ЧИСТУЮ базу (эмуляция другой машины)
    const clean = freshDb();
    Object.defineProperty(databaseModule, 'db', { value: clean, configurable: true, writable: true });
    await clean.open();
    await restoreBackup(parseBackupJson(json));
    expect(await clean.brands.count()).toBe(1);
    const pr = (await clean.products.toArray())[0];
    expect(pr.fixedPrice).toBe('12760');
    expect(pr.name).toBe('Копия');
    expect(pr.barcode).toBe('8000000000017');
    const or = (await clean.orders.toArray())[0];
    expect(or.snapshot!.totals.primary).toBe('30624000.00');
    expect(or.status).toBe('approved');
    expect(await clean.sales.count()).toBe(1);
    expect(await clean.stock.count()).toBe(1);
    expect(await clean.priceVersions.count()).toBe(1);
  });

  it('повреждённый/несовместимый JSON отвергается БЕЗ порчи текущей базы', async () => {
    const b = await brandsRepo.create('Keep');
    await productsRepo.create({ brandId: b.id, barcode: '9000000000018', name: 'Цел', packSize: 10, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW' });

    // битый JSON
    expect(() => parseBackupJson('{not json')).toThrow(/JSON/);
    // несовместимый formatVersion
    expect(() => validateBackup({ formatVersion: 99, schemaVersion: 1, data: {} })).toThrow(/Несовместимый формат/);
    // сирота: товар на несуществующий бренд
    expect(() =>
      validateBackup({
        formatVersion: 1, schemaVersion: 1, appVersion: 'x', exportedAt: '', counts: {},
        data: {
          brands: [], products: [{ id: 'p', brandId: 'nope', barcode: '123456', article: '123456', name: 'x', packSize: 1, priceMode: 'fixed', fixedPrice: '1', tiers: [], currency: 'KRW', archived: false, createdAt: '', updatedAt: '', updatedBy: '' }],
          priceVersions: [], sales: [], stock: [], orders: [], settings: [], brandSettings: [], audit: [],
        },
      }),
    ).toThrow(/несуществующий бренд/);

    // база не тронута
    expect(await databaseModule.db.brands.count()).toBe(1);
    expect(await databaseModule.db.products.count()).toBe(1);
  });
});

describe('Сохранение между перезагрузками (эмуляция повторного открытия той же БД)', () => {
  it('данные остаются после закрытия и повторного открытия базы', async () => {
    const name = `persist-${++counter}`;
    const d1 = new ZakaznikDB(name);
    Object.defineProperty(databaseModule, 'db', { value: d1, configurable: true, writable: true });
    await d1.open();
    const b = await brandsRepo.create('Persist');
    await productsRepo.create({ brandId: b.id, barcode: '1110000000019', name: 'После перезагрузки', packSize: 10, priceMode: 'fixed', fixedPrice: '100.50', tiers: [], currency: 'USD' });
    d1.close();

    const d2 = new ZakaznikDB(name);
    Object.defineProperty(databaseModule, 'db', { value: d2, configurable: true, writable: true });
    await d2.open();
    const prods = await productsRepo.listByBrand(b.id);
    expect(prods.length).toBe(1);
    expect(prods[0].fixedPrice).toBe('100.50');
    expect(prods[0].currency).toBe('USD');
  });
});

describe('Миграции схемы', () => {
  it('повторное открытие базы той же версии не стирает данные', async () => {
    const name = `mig-${++counter}`;
    const d1 = new ZakaznikDB(name);
    Object.defineProperty(databaseModule, 'db', { value: d1, configurable: true, writable: true });
    await d1.open();
    await brandsRepo.create('Mig');
    d1.close();
    const d2 = new ZakaznikDB(name);
    Object.defineProperty(databaseModule, 'db', { value: d2, configurable: true, writable: true });
    await d2.open();
    expect(await d2.brands.count()).toBe(1);
  });
});

describe('Мост к расчётному ядру (dataServices)', () => {
  it('bundle: СДП, остатки, актуальность; прогноз с ожидаемыми поставками', async () => {
    const b = await brandsRepo.create('Core');
    const p = await productsRepo.create({ brandId: b.id, barcode: '1210000000020', name: 'Ядро', packSize: 40, priceMode: 'fixed', fixedPrice: '12760', tiers: [], currency: 'KRW' });
    // закроем 2 месяца продаж VLK: 300 и 300 → среднемесячно 300 → СДП 10/день
    // (месяцы должны попасть в 12-месячное окно относительно даты расчёта 2026-10)
    await salesRepo.setValue(p.id, b.id, 'VLK', '2026-08', 300);
    await salesRepo.setValue(p.id, b.id, 'VLK', '2026-09', 300);
    await salesRepo.closeMonth(b.id, '2026-08', { allowIncomplete: true });
    await salesRepo.closeMonth(b.id, '2026-09', { allowIncomplete: true });
    await stockRepo.setSnapshot(p.id, b.id, 'VLK', 100, '2026-10-01T10:00:00.000Z');

    const bundle = await loadBrandBundle(b.id, new Date('2026-10-21T12:00:00Z'));
    const item = bundle.find((x) => x.product.id === p.id)!;
    expect(item.ads.VLK.known).toBe(true);
    expect(item.ads.VLK.value).toBeCloseTo(10, 6);
    expect(item.ads.MSK.known).toBe(false); // нет подтверждённых месяцев → unknown, не 0
    expect(item.stock.VLK!.qty).toBe(100);

    // Снимок 1С датирован 2026-10-01 → прогноз стартует от даты снимка: 100 / 10 = дефицит с 2026-10-11
    const f = await forecastForProduct(p.id, 'VLK', { now: '2026-10-05' });
    expect(f.ok).toBe(true);
    expect(f.startStock).toBe(100);
    expect(f.firstDeficitDate).toBe('2026-10-11'); // 100 / 10 = 10 дней от 01.10.2026

    // оформленный заказ добавляет ожидаемое поступление в прогноз ровно один раз
    const o = await ordersRepo.createDraft({ brandId: b.id, issueDate: '2026-10-21', currency: 'KRW' });
    await ordersRepo.setLine(o.id, p.id, 0, 800);
    await ordersRepo.setLine(o.id, p.id, 400, 400);
    await ordersRepo.approve(o.id, rates, {}, {}, []);
    const f2 = await forecastForProduct(p.id, 'VLK', { now: '2026-10-05' });
    const arrivalsTotal = f2.segments.reduce((s, seg) => s + seg.arrival, 0);
    expect(arrivalsTotal).toBe(400); // одно поступление, не два
    // прогноз ДО собственного будущего заказа (dueBefore)
    const f3 = await forecastForProduct(p.id, 'VLK', { now: '2026-10-05', dueBefore: '2026-10-30' });
    expect(f3.segments.reduce((s, seg) => s + seg.arrival, 0)).toBe(0);
  });
});

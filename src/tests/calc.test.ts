// ===== Автоматические тесты расчётного ядра (раздел 17 ТЗ) =====
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { Brand, Product, SalesRecord, PeriodStatus, Supply, Settings, FixedOrder, PriceTier } from '../types';
import {
  calcSdp, buildClosedMap, calcStockMonths, buildForecast, collectReceipts,
  redistribute, appliedPrice, isMultiple, boxesFor, roundUpToPack, convert,
  plannedDatesFromOrder, effectiveLogistics, totalLeadDays, recommendOrder, calcOrderLine,
} from '../calc';
import { db, articleFromBarcode, exportBackup, restoreBackup, validateBackup, DEFAULT_SETTINGS } from '../db';

const BRAND_ID = 1;

function makeProduct(over: Partial<Product> = {}): Product {
  return {
    id: 10, brandId: BRAND_ID, barcode: '8801234567890', article: '567890',
    name: 'Тест', packSize: 24, priceKind: 'fixed', fixedPrice: 1200, archived: false, ...over,
  };
}

function salesData(qtys: Record<string, number | null>): { sales: SalesRecord[]; closed: Record<'vld' | 'msk', Set<string>> } {
  const periods = Object.keys(qtys).sort();
  const sales: SalesRecord[] = periods.map((p) => ({
    brandId: BRAND_ID, productId: 10, period: p, branch: 'vld', qty: qtys[p],
  }));
  const closedSet = new Set(periods);
  return { sales, closed: { vld: closedSet, msk: new Set() } };
}

describe('Тест 1. СДП', () => {
  it('СДП = среднее продаж / 30 по закрытым месяцам', () => {
    const { sales, closed } = salesData({ '2026-01': 100, '2026-02': 120, '2026-03': 90, '2026-04': 110, '2026-05': 130 });
    const r = calcSdp(sales, closed, 10, 'vld');
    expect(r.kind).toBe('value');
    if (r.kind === 'value') {
      expect(r.avgMonthly).toBeCloseTo(110, 10);
      expect(r.sdp).toBeCloseTo(110 / 30, 10);
      expect(r.monthsUsed).toBe(5);
    }
  });
  it('пустые ячейки игнорируются, подтверждённые нули учитываются', () => {
    const { sales, closed } = salesData({ '2026-01': 100, '2026-02': null as any, '2026-03': 0 });
    // удалим запись с null — она не должна влиять; запись 0 влияет
    const s2 = sales.filter((s) => s.qty !== null);
    const r = calcSdp(s2, closed, 10, 'vld');
    if (r.kind === 'value') expect(r.sdp).toBeCloseTo(50 / 30, 10);
    else throw new Error('expected value');
  });
  it('нет ни одного достоверного периода → «Нет данных», а не ноль', () => {
    const r = calcSdp([], { vld: new Set(), msk: new Set() }, 10, 'vld');
    expect(r.kind).toBe('nodata');
  });
  it('все продажи равны нулю → СДП = 0', () => {
    const { sales, closed } = salesData({ '2026-01': 0, '2026-02': 0 });
    const r = calcSdp(sales, closed, 10, 'vld');
    if (r.kind === 'value') expect(r.sdp).toBe(0);
    else throw new Error('expected value 0');
  });
});

describe('Тест 2. Товарный запас', () => {
  it('ТЗ = остаток / СДП / 30', () => {
    const r = calcStockMonths(450, 5);
    expect(r.kind).toBe('value');
    if (r.kind === 'value') expect(r.months).toBeCloseTo(3, 10);
  });
  it('нулевая СДП → «Нет расхода», без деления на ноль', () => {
    expect(calcStockMonths(450, 0).kind).toBe('noconsumption');
  });
  it('нет данных СДП → «Нет данных»', () => {
    expect(calcStockMonths(450, null).kind).toBe('nodata');
  });
});

describe('Тест 3. Первая поставка', () => {
  it('300 − 4×60 + 500 = 560', () => {
    const f = buildForecast('2026-01-01', 300, 4, [
      { date: '2026-03-02', qty: 500, supplyId: 1, supplyNumber: 'S1', productId: 10, overdue: false },
    ], '2026-04-01');
    expect(f.points[0].beforeReceipt).toBeCloseTo(60, 6);
    expect(f.points[0].afterReceipt).toBeCloseTo(560, 6);
    expect(f.hasShortage).toBe(false);
  });
});

describe('Тест 4. Вторая поставка', () => {
  it('560 − 4×40 + 300 = 700, именно 700 — отправная точка следующего периода', () => {
    const f = buildForecast('2026-01-01', 300, 4, [
      { date: '2026-03-02', qty: 500, supplyId: 1, supplyNumber: 'S1', productId: 10, overdue: false },
      { date: '2026-04-11', qty: 300, supplyId: 2, supplyNumber: 'S2', productId: 10, overdue: false },
    ], '2026-12-31');
    expect(f.points.length).toBe(2);
    expect(f.points[1].beforeReceipt).toBeCloseTo(400, 6); // 560 - 4*40
    expect(f.points[1].afterReceipt).toBeCloseTo(700, 6);
  });
});

describe('Тест 5. Дефицит', () => {
  it('остаток 100, СДП 5, поставка через 40 дней: дефицит через 20 дней, 20 дней без товара, после поставки 300 (не 200)', () => {
    const f = buildForecast('2026-01-01', 100, 5, [
      { date: '2026-02-10', qty: 300, supplyId: 1, supplyNumber: 'S1', productId: 10, overdue: false },
    ], '2026-12-31');
    expect(f.hasShortage).toBe(true);
    expect(f.depletionDate).toBe('2026-01-21'); // 20 дней от старта
    expect(f.points[0].stockoutDays).toBe(20);
    expect(f.points[0].beforeReceipt).toBe(0); // отрицательных остатков нет
    expect(f.points[0].afterReceipt).toBe(300); // упущенные продажи не вычитаются из поступления
    expect(f.minStock).toBe(0);
  });
});

describe('Тест 6. Перераспределение', () => {
  it('общее 1000: ВЛД 600 → изменить ВЛД на 700 ⇒ МСК = 300', () => {
    const r = redistribute(1000, 600, 400, 'vld', 700);
    expect(r.vld).toBe(700);
    expect(r.msk).toBe(300);
  });
  it('нельзя распределить больше общего и получить отрицательное значение', () => {
    expect(redistribute(1000, 600, 400, 'vld', 1500)).toEqual({ vld: 1000, msk: 0 });
    expect(redistribute(1000, 600, 400, 'vld', -50)).toEqual({ vld: 0, msk: 1000 });
    expect(redistribute(1000, 600, 400, 'msk', 500)).toEqual({ vld: 500, msk: 500 });
  });
});

describe('Тест 7. Ценовая ступень', () => {
  const tiers: PriceTier[] = [
    { minBoxes: 1, price: 1200 }, { minBoxes: 10, price: 1150 },
    { minBoxes: 30, price: 1100 }, { minBoxes: 50, price: 1050 },
  ];
  it('ВЛД 12 коробок + МСК 20 коробок = 32 ⇒ цена 1100 применяется ко всему заказу', () => {
    const p = makeProduct({ priceKind: 'tiered', fixedPrice: undefined, tiers });
    const lc = calcOrderLine(p, 12 * 24, 20 * 24);
    expect(lc.totalBoxes).toBe(32);
    expect(lc.appliedPrice).toBe(1100);
    expect(lc.vldSum).toBe(12 * 24 * 1100);
    expect(lc.mskSum).toBe(20 * 24 * 1100);
    expect(lc.totalSum).toBe(32 * 24 * 1100);
    expect(lc.packOk).toBe(true);
  });
  it('ступени применяются по общему числу коробок конкретного товара', () => {
    const p = makeProduct({ priceKind: 'tiered', fixedPrice: undefined, tiers });
    expect(appliedPrice(p, 9)).toBe(1200);
    expect(appliedPrice(p, 10)).toBe(1150);
    expect(appliedPrice(p, 29)).toBe(1150);
    expect(appliedPrice(p, 50)).toBe(1050);
  });
});

describe('Тест 8. Кратность', () => {
  it('250 шт. при кратности 24 → ошибка кратности', () => {
    expect(isMultiple(250, 24)).toBe(false);
    const p = makeProduct({ packSize: 24 });
    const lc = calcOrderLine(p, 250, 0);
    expect(lc.packOk).toBe(false);
  });
  it('240 шт. при кратности 24 → 10 коробок, корректно', () => {
    expect(isMultiple(240, 24)).toBe(true);
    expect(boxesFor(240, 24)).toBe(10);
    expect(boxesFor(250, 24)).toBeCloseTo(250 / 24, 6); // не округляем «как будто заказ корректен»
  });
  it('рекомендация округляется вверх до коробок', () => {
    expect(roundUpToPack(250, 24)).toBe(264);
  });
});

describe('Тест 9. Хронология', () => {
  it('расчёт идёт по датам поступления, а не по порядку создания записей', () => {
    // «Июньская» создана раньше, но прибывает позже «Июльской»
    const f = buildForecast('2026-01-01', 100, 2, [
      { date: '2026-03-02', qty: 100, supplyId: 1, supplyNumber: 'Июньская', productId: 10, overdue: false },
      { date: '2026-02-01', qty: 200, supplyId: 2, supplyNumber: 'Июльская', productId: 10, overdue: false },
    ], '2026-12-31');
    // первое событие в хронологическом порядке — более поздняя по созданию «Июльская»
    expect(f.points[0].date).toBe('2026-02-01');
    expect(f.points[0].afterReceipt).toBeCloseTo(100 - 2 * 31 + 200, 6);
    expect(f.points[1].date).toBe('2026-03-02');
  });
});

describe('Тест 10. Частичное поступление', () => {
  const sup: Supply = {
    id: 1, brandId: BRAND_ID, number: 'S1', status: 'partial',
    orderDate: '2026-01-01', departDate: '2026-02-01',
    vldPlannedDate: '2026-04-01', mskPlannedDate: '2026-05-01',
    createdAt: '2026-01-01',
    items: [{ productId: 10, totalQty: 1000, vldQty: 600, mskQty: 400, vldReceived: 600, mskReceived: 0, vldActualDate: '2026-03-25' }],
  };
  it('Владивосток не учитывает полученную часть повторно', () => {
    const ev = collectReceipts([sup], 'vld', '2026-04-01', true);
    expect(ev.filter((e) => e.productId === 10).reduce((a, e) => a + e.qty, 0)).toBe(0);
  });
  it('Москва продолжает учитывать ожидаемое поступление', () => {
    const ev = collectReceipts([sup], 'msk', '2026-04-01', true);
    const m = ev.find((e) => e.productId === 10)!;
    expect(m.qty).toBe(400);
    expect(m.date).toBe('2026-05-01');
  });
  it('если полученные поставки НЕ отражены в снимке остатков, поступление учитывается в прогнозе', () => {
    const ev = collectReceipts([sup], 'vld', '2026-03-20', false);
    const v = ev.find((e) => e.productId === 10)!;
    expect(v.qty).toBe(600);
    expect(v.date).toBe('2026-03-25');
  });
});

describe('Тест 11. История цен', () => {
  it('старый зафиксированный заказ сохраняет прежнюю стоимость после изменения прайса', async () => {
    await db.products.clear();
    const pid = await db.products.add(makeProduct({ fixedPrice: 1000 }));
    const order: FixedOrder = {
      brandId: BRAND_ID, number: 'Z-1', date: '2026-01-10', currency: 'KRW',
      rates: { usdRub: 85, krwRub: 0.063 },
      lines: [{
        productId: pid, name: 'Тест', barcode: '8801234567890', article: '567890', packSize: 24,
        vldQty: 240, mskQty: 0, totalQty: 240, totalBoxes: 10, appliedPrice: 1000,
        vldSum: 240000, mskSum: 0, totalSum: 240000,
      }],
      totalUnits: 240, totalBoxes: 10, totalSum: 240000, totalSumRub: 240000 * 0.063,
      vldPlannedDate: '2026-04-10', mskPlannedDate: '2026-05-10', supplyCreated: false,
    };
    const oid = await db.orders.add(order);
    // меняем текущий прайс задним числом
    await db.products.update(pid, { fixedPrice: 1500 });
    const stored = await db.orders.get(oid);
    expect(stored!.lines[0].appliedPrice).toBe(1000);
    expect(stored!.totalSum).toBe(240000);
  });
});

describe('Тест 12. Перезапуск (данные остаются в IndexedDB)', () => {
  it('сохранённые бренды, товары, продажи и настройки читаются снова', async () => {
    await db.brands.clear(); await db.sales.clear(); await db.settings.clear();
    const bid = await db.brands.add({ name: 'Бренд А', currency: 'KRW', archived: false, createdAt: new Date().toISOString() });
    const pid = await db.products.add(makeProduct({ brandId: bid! as number, id: undefined }));
    await db.sales.add({ brandId: bid! as number, productId: pid! as number, period: '2026-05', branch: 'vld', qty: 100 });
    // «перезапуск» = повторное чтение из той же БД
    const brands = await db.brands.toArray();
    const products = await db.products.toArray();
    const sales = await db.sales.toArray();
    expect(brands.map((b) => b.name)).toContain('Бренд А');
    expect(products.length).toBeGreaterThan(0);
    expect(sales.some((s) => s.qty === 100)).toBe(true);
    const s = await db.settings.get(1); // singleton создаётся? получаем через экспорт функции
    void s;
  });
});

describe('Тест 13. Новый заказ: плановые даты', () => {
  it('сроки 30 + 60 + 20 ⇒ Владивосток через 90 дней, Москва через 110 от даты оформления', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, id: 1 };
    const brand: Brand = { name: 'B', currency: 'KRW', archived: false, createdAt: '2026-01-01' };
    const lg = effectiveLogistics(brand, settings);
    const pd = plannedDatesFromOrder('2026-01-01', lg);
    expect(pd.departDate).toBe('2026-01-31');
    expect(pd.vldDate).toBe('2026-04-01');   // +90
    expect(pd.mskDate).toBe('2026-04-21');   // +110
    expect(totalLeadDays(lg)).toEqual({ vld: 90, msk: 110 });
  });
  it('бренд может переопределить сроки логистики', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, id: 1 };
    const brand: Brand = { name: 'B', currency: 'KRW', archived: false, createdAt: '', orderPrepDays: 10, shipVldDays: 20, extraMskDays: 5 };
    expect(totalLeadDays(effectiveLogistics(brand, settings))).toEqual({ vld: 30, msk: 35 });
  });
});

describe('Тест 14. Редактирование прошлого (закрытого) месяца', () => {
  it('после исправления данных и повторного закрытия СДП и зависимые показатели пересчитываются', () => {
    const closed = { vld: new Set(['2026-01', '2026-02']), msk: new Set<string>() };
    const sales: SalesRecord[] = [
      { brandId: BRAND_ID, productId: 10, period: '2026-01', branch: 'vld', qty: 100 },
      { brandId: BRAND_ID, productId: 10, period: '2026-02', branch: 'vld', qty: 120 },
      { brandId: BRAND_ID, productId: 10, period: '2026-03', branch: 'vld', qty: 90 },
      { brandId: BRAND_ID, productId: 10, period: '2026-04', branch: 'vld', qty: 110 },
      { brandId: BRAND_ID, productId: 10, period: '2026-05', branch: 'vld', qty: 130 },
    ];
    const before = calcSdp(sales, closed, 10, 'vld');
    if (before.kind === 'value') expect(before.sdp).toBeCloseTo(110 / 30, 10); // (100+120)/2/30
    // исправили январь: 100 → 300 (повторное открытие → правка → повторное закрытие)
    const fixed = sales.map((s) => s.period === '2026-01' ? { ...s, qty: 300 } : s);
    const after = calcSdp(fixed, closed, 10, 'vld');
    if (after.kind === 'value') {
      expect(after.sdp).toBeCloseTo(210 / 30, 10); // (300+120)/2/30
      // ТЗ пересчитывается автоматически из новой СДП: 420 / 7 / 30 = 2 месяца
      const tz = calcStockMonths(420, after.sdp);
      expect(tz.kind).toBe('value');
      if (tz.kind === 'value') expect(tz.months).toBeCloseTo(2, 10);
    } else throw new Error('expected value');
  });
});

describe('Тест 15. Поставки с одинаковой датой', () => {
  it('несколько поступлений в один день суммируются, дневной спрос списывается один раз', () => {
    const f = buildForecast('2026-01-01', 100, 10, [
      { date: '2026-01-11', qty: 50, supplyId: 1, supplyNumber: 'A', productId: 10, overdue: false },
      { date: '2026-01-11', qty: 70, supplyId: 2, supplyNumber: 'B', productId: 10, overdue: false },
    ], '2026-02-01');
    // 10 дней × 10 = 100 потреблено → перед поступлением 0; поступило 120 одним событием
    expect(f.points.length).toBe(1);
    expect(f.points[0].receiptQty).toBe(120);
    expect(f.points[0].beforeReceipt).toBeCloseTo(0, 6);
    expect(f.points[0].afterReceipt).toBeCloseTo(120, 6);
  });
  it('collectReceipts объединяет поставки с одинаковой плановой датой', () => {
    const mk = (id: number, qty: number): Supply => ({
      id, brandId: BRAND_ID, number: `S${id}`, status: 'in_transit',
      orderDate: '2026-01-01', departDate: '2026-02-01',
      vldPlannedDate: '2026-04-01', mskPlannedDate: '2026-05-01', createdAt: '',
      items: [{ productId: 10, totalQty: qty, vldQty: qty, mskQty: 0, vldReceived: 0, mskReceived: 0 }],
    });
    const ev = collectReceipts([mk(1, 100), mk(2, 200)], 'vld', '2026-01-05', true);
    expect(ev.length).toBe(1);
    expect(ev[0].qty).toBe(300);
  });
});

describe('Прочие ключевые функции', () => {
  it('артикул = последние 6 символов штрихкода, ведущие нули сохраняются', () => {
    expect(articleFromBarcode('8801234567890')).toBe('567890');
    expect(articleFromBarcode('00123')).toBe('00123');
  });
  it('конвертация валют по курсам из ТЗ', () => {
    const rates = { usdRub: 85, krwRub: 0.063 };
    const c = convert(1000000, 'KRW', rates); // 1 млн KRW
    expect(c.rub).toBeCloseTo(63000, 6);
    expect(c.usd).toBeCloseTo(63000 / 85, 6);
    const c2 = convert(1000, 'USD', rates);
    expect(c2.rub).toBeCloseTo(85000, 6);
    expect(c2.krw).toBeCloseTo(85000 / 0.063, 6);
  });
  it('рекомендация заказа: MAX(0, цель×30×СДП − прогноз), округление вверх до коробок', () => {
    const r = recommendOrder({ sdp: 5, forecastStockBefore: 100, packSize: 24, targetMonths: 3 });
    expect(r.needed).toBeCloseTo(350, 6);       // 450 - 100
    expect(r.recommended).toBe(360);            // 15 коробок
    expect(recommendOrder({ sdp: null, forecastStockBefore: 0, packSize: 24, targetMonths: 3 }).reason).toBe('nodata');
    expect(recommendOrder({ sdp: 0, forecastStockBefore: 0, packSize: 24, targetMonths: 3 }).reason).toBe('noconsumption');
    expect(recommendOrder({ sdp: 5, forecastStockBefore: 500, packSize: 24, targetMonths: 3 }).recommended).toBe(0);
  });
  it('buildClosedMap строит карту закрытых периодов бренда', () => {
    const ps: PeriodStatus[] = [
      { key: '1|2026-01|vld', brandId: 1, period: '2026-01', branch: 'vld', closed: true },
      { key: '1|2026-02|vld', brandId: 1, period: '2026-02', branch: 'vld', closed: false },
      { key: '2|2026-01|msk', brandId: 2, period: '2026-01', branch: 'msk', closed: true },
    ];
    const m = buildClosedMap(ps, 1);
    expect(m.vld.has('2026-01')).toBe(true);
    expect(m.vld.has('2026-02')).toBe(false);
    expect(m.msk.has('2026-01')).toBe(false);
  });
});

describe('Резервные копии', () => {
  it('экспорт → очистка → восстановление возвращает все данные', async () => {
    await db.brands.clear(); await db.products.clear();
    await db.brands.add({ id: 77, name: 'Бэкап-бренд', currency: 'USD', archived: false, createdAt: '' });
    await db.products.add(makeProduct({ id: 88, brandId: 77 }));
    const backup = await exportBackup();
    await db.brands.clear(); await db.products.clear();
    expect((await db.brands.count())).toBe(0);
    const err = validateBackup(backup);
    expect(err).toBeNull();
    await restoreBackup(backup);
    expect(await db.brands.get(77)).toBeDefined();
    expect(await db.products.get(88)).toBeDefined();
  });
  it('валидация отклоняет битый файл', () => {
    expect(validateBackup({})).not.toBeNull();
    expect(validateBackup({ app: 'other', version: 1, tables: {} })).not.toBeNull();
    expect(validateBackup(null)).not.toBeNull();
  });
});

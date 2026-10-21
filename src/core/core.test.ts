/**
 * Тесты расчётного ядра — покрывают приёмочные сценарии §21 и §28.
 */
import { describe, it, expect } from 'vitest';
import {
  computeArticle, validateTiers, pickTier, calcADS, lastMonthsWindow, makeYearMonth,
  addDays, diffDays, computeOrderDates, DEFAULT_LEAD_TIMES,
  buildForecast, coverageMonths, tzLevel, recommendOrderQty, coverageAfterOrder,
  calcLine, calcOrderTotals, convertTotals, isPackMultiple,
  decFromString, decAdd, decMul, decToString, decRound, decimalCmp,
  type Product, type SalesRecord, type PriceTier, type Arrival,
} from './types';

const P = (o: Partial<Product>): Product => ({
  id: 'p1', brandId: 'b1', barcode: '0012345678901', name: 'Тест', packSize: 40,
  priceMode: 'fixed', fixedPrice: '100', tiers: [], currency: 'KRW', archived: false,
  createdAt: '', updatedAt: '', updatedBy: '', ...o,
});

const S = (ym: string, qty: number | null, closed = true, confirmed = true): SalesRecord => ({
  id: ym, productId: 'p1', brandId: 'b1', branch: 'VLK', ym, qty,
  status: closed ? 'closed' : 'open', confirmed, updatedAt: '', updatedBy: '',
});

describe('Номенклатура', () => {
  it('§21.1 артикул = последние 6 символов штрихкода, ведущие нули сохранены', () => {
    expect(computeArticle('0012345678901').article).toBe('678901');
    expect(computeArticle('000001').article).toBe('000001'); // ведущие нули
    expect(computeArticle('12345').error).toBeTruthy(); // < 6 символов — ошибка
  });

  it('ступени цены: пересечения запрещены, выбор по коробкам SKU', () => {
    const tiers: PriceTier[] = [
      { minBoxes: 1, maxBoxes: 19, pricePerUnit: '13000' },
      { minBoxes: 20, maxBoxes: 59, pricePerUnit: '12760' },
      { minBoxes: 60, maxBoxes: null, pricePerUnit: '12000' },
    ];
    expect(validateTiers(tiers)).toEqual([]);
    expect(validateTiers([{ minBoxes: 1, maxBoxes: 20, pricePerUnit: '1' }, { minBoxes: 15, maxBoxes: null, pricePerUnit: '1' }]).length)
      .toBeGreaterThan(0);
    expect(pickTier(tiers, 20)?.pricePerUnit).toBe('12760');
    expect(pickTier(tiers, 60)?.pricePerUnit).toBe('12000');
    expect(pickTier(tiers, 1000)?.minBoxes).toBe(60); // открытый верхний предел
    expect(pickTier([{ minBoxes: 10, maxBoxes: 20, pricePerUnit: '5' }], 5)).toBeNull(); // нет ступени → не угадывать
  });
});

describe('Продажи и СДП', () => {
  it('§21.2 закрытые нули участвуют, пустые — нет; пример из ТЗ: 300/600/0/пусто → 300, СДП=10', () => {
    const win = ['2025-01', '2025-02', '2025-03', '2025-04'].map((m) => m);
    const recs = [
      S('2025-01', 300), S('2025-02', 600), S('2025-03', 0), // подтверждённый ноль
      S('2025-04', null, true, false), // пустая ячейка апрель — не участвует
    ];
    const ads = calcADS(recs, win);
    expect(ads.known).toBe(true);
    expect(ads.monthsCounted).toBe(3);
    expect(ads.sumQty / ads.monthsCounted).toBe(300); // среднемесячно 300
    expect(ads.value).toBeCloseTo(10); // СДП = 10 шт/день
  });

  it('нет подтверждённых месяцев → СДП неизвестна, не ноль', () => {
    const ads = calcADS([S('2025-01', null, false, false)], ['2025-01']);
    expect(ads.known).toBe(false);
    expect(ads.value).toBeNull();
  });

  it('окно 12 месяцев исключает текущий незакрытый месяц', () => {
    const win = lastMonthsWindow(new Date(2026, 9, 21), 12); // октябрь 2026 — текущий
    expect(win).toContain(makeYearMonth(2025, 10));
    expect(win).toContain(makeYearMonth(2026, 9));
    expect(win).not.toContain(makeYearMonth(2026, 10));
    expect(win.length).toBe(12);
  });
});

describe('Логистика', () => {
  it('§21.3 цикл 30+60+20: ВЛК = +90 от оформления, МСК = +110', () => {
    const d = computeOrderDates('2026-01-01', DEFAULT_LEAD_TIMES, {});
    expect(d.exitDate).toBe('2026-01-31');
    expect(d.vlkDate).toBe('2026-04-01');
    expect(d.mskDate).toBe('2026-04-21');
    expect(diffDays('2026-01-01', d.vlkDate)).toBe(90);
    expect(diffDays('2026-01-01', d.mskDate)).toBe(110);
  });

  it('индивидуальные переопределения дат', () => {
    const d = computeOrderDates('2026-01-01', DEFAULT_LEAD_TIMES, { exitDate: '2026-02-15' });
    expect(d.exitDate).toBe('2026-02-15');
    expect(d.vlkDate).toBe('2026-04-16'); // выход + 60
  });

  it('addDays/diffDays корректны через границы месяцев', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(diffDays('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('Хронологический прогноз', () => {
  const adsKnown = (v: number) => ({ known: true, value: v, monthsCounted: 12, monthsTotal: 12, sumQty: v * 360 });

  it('§21.5 остаток ограничен нулём, неудовлетворённый спрос НЕ переносится (пример ТЗ)', () => {
    // 100 шт, СДП 10/день, приход 300 через 20 дней → до прихода MAX(0;100−200)=0, после 300 (НЕ 200)
    const f = buildForecast({
      ads: adsKnown(10), stockQty: 100, stockAsOf: '2026-01-01', stockStale: false,
      arrivals: [{ date: '2026-01-21', qty: 300, orderId: 'o1', includeInForecast: true, received: false }],
      now: '2026-01-01', horizonDays: 100,
    });
    expect(f.segments[0].endBeforeArrival).toBe(0);
    expect(f.segments[0].endAfterArrival).toBe(300); // следующая поставка использует 300 как исходное
    expect(f.segments.every((s) => s.endBeforeArrival >= 0 && s.endAfterArrival >= 0)).toBe(true);
  });

  it('§21.4 несколько приходов в один день суммируются; порядок ввода не важен', () => {
    const arr: Arrival[] = [
      { date: '2026-03-01', qty: 100, orderId: 'a', includeInForecast: true, received: false },
      { date: '2026-01-15', qty: 50, orderId: 'b', includeInForecast: true, received: false },
      { date: '2026-03-01', qty: 70, orderId: 'c', includeInForecast: true, received: false },
    ];
    const f = buildForecast({ ads: adsKnown(1), stockQty: 10, stockAsOf: '2026-01-01', stockStale: false, arrivals: arr, now: '2026-01-01', horizonDays: 200 });
    const mar = f.segments.find((s) => s.to === '2026-03-01')!;
    expect(mar.arrival).toBe(170);
  });

  it('§21.6 дата первого дефицита и длительность отсутствия', () => {
    const f = buildForecast({
      ads: adsKnown(10), stockQty: 100, stockAsOf: '2026-01-01', stockStale: false,
      arrivals: [{ date: '2026-01-31', qty: 500, orderId: 'o1', includeInForecast: true, received: false }],
      now: '2026-01-01', horizonDays: 120,
    });
    expect(f.firstDeficitDate).toBe('2026-01-11'); // 100/10 = 10 дней
    const seg = f.segments[0];
    expect(seg.deficitStart).toBe('2026-01-11');
    expect(seg.gapDays).toBe(20);
  });

  it('остаток уже ноль → дефицит с даты начала интервала', () => {
    const f = buildForecast({
      ads: adsKnown(5), stockQty: 0, stockAsOf: '2026-01-01', stockStale: false,
      arrivals: [{ date: '2026-01-11', qty: 100, orderId: 'o', includeInForecast: true, received: false }],
      now: '2026-01-01', horizonDays: 60,
    });
    expect(f.firstDeficitDate).toBe('2026-01-01');
  });

  it('просроченное поступление без подтверждения: «просрочено», не считается полученным', () => {
    const f = buildForecast({
      ads: adsKnown(1), stockQty: 100, stockAsOf: '2026-01-01', stockStale: false,
      arrivals: [{ date: '2026-01-05', qty: 1000, orderId: 'late', includeInForecast: true, received: false }],
      now: '2026-02-01', horizonDays: 60,
    });
    expect(f.reliability).toBe('overdue_arrival');
    expect(f.overdueOrders).toContain('late');
    expect(f.currentStockAfterAll).toBeLessThanOrEqual(100);
  });

  it('СДП неизвестна → прогноз нерассчитываем, не принят за нулевое потребление', () => {
    const f = buildForecast({
      ads: { known: false, value: null, monthsCounted: 0, monthsTotal: 12, sumQty: 0 },
      stockQty: 50, stockAsOf: '2026-01-01', stockStale: false, arrivals: [], now: '2026-01-01', horizonDays: 30,
    });
    expect(f.reliability).toBe('no_ads');
    expect(f.ok).toBe(false);
  });

  it('§21.9 подтверждённый приход НЕ прибавляется к фактическому остатку; до обновления 1С прогноз неактуален', () => {
    const f = buildForecast({
      ads: adsKnown(1), stockQty: 10, stockAsOf: '2026-01-01', stockStale: true,
      arrivals: [{ date: '2026-01-20', qty: 1000, orderId: 'recvd', includeInForecast: true, received: true }],
      now: '2026-01-01', horizonDays: 60,
    });
    expect(f.reliability).toBe('stale_stock');
    expect(f.messages.join()).toContain('Ожидается обновление остатков из 1С');
    // received=true arrival исключён — двойного учёта нет
    expect(f.segments.reduce((s, x) => s + x.arrival, 0)).toBe(0);
  });

  it('§21.12 новый черновик не удваивает собственное поступление; учитываются только события ДО его прихода', () => {
    // Прогноз ДО прихода нового заказа (vlk 2026-05-01): событие o1 (2026-03-01) учитывается,
    // событие o2 (2026-06-01, позже) — нет; собственный приход new — нет (не передаётся).
    const f = buildForecast({
      ads: adsKnown(10), stockQty: 100, stockAsOf: '2026-01-01', stockStale: false,
      arrivals: [
        { date: '2026-03-01', qty: 200, orderId: 'o1', includeInForecast: true, received: false, dueBefore: '2026-05-01' },
        { date: '2026-06-01', qty: 900, orderId: 'o2', includeInForecast: true, received: false, dueBefore: '2026-05-01' },
      ],
      now: '2026-01-01', horizonDays: 30,
    });
    const totalArrivals = f.segments.reduce((s, x) => s + x.arrival, 0);
    expect(totalArrivals).toBe(200); // только o1
  });
});

describe('ТЗ и планирование', () => {
  const ads = (v: number | null, known = true) => ({ known, value: v, monthsCounted: 12, monthsTotal: 12, sumQty: 0 });

  it('текущий ТЗ: остаток/СДП/30; СДП=0 → «нет потребления»; неизвестна → «нет данных»', () => {
    expect(coverageMonths(600, ads(10))).toEqual({ kind: 'months', months: 2 });
    expect(coverageMonths(600, ads(0)).kind).toBe('none');
    expect(coverageMonths(600, ads(null, false)).kind).toBe('unknown');
    expect(coverageMonths(null, ads(10)).kind).toBe('unknown');
  });

  it('норматив ТЗ 2–5: <2 красный, >5 оранжевый, 2–5 зелёный, неопределённость серый', () => {
    expect(tzLevel({ kind: 'months', months: 1.9 }, 2, 5)).toBe('red');
    expect(tzLevel({ kind: 'months', months: 2 }, 2, 5)).toBe('green');
    expect(tzLevel({ kind: 'months', months: 5 }, 2, 5)).toBe('green');
    expect(tzLevel({ kind: 'months', months: 5.1 }, 2, 5)).toBe('orange');
    expect(tzLevel({ kind: 'unknown' }, 2, 5)).toBe('gray');
  });

  it('рекомендация: MAX(0; цель×СДП×30 − прогнозДО), округление ВВЕРХ до коробки', () => {
    // цель 3 мес × 10/день × 30 = 900; прогнозДО 400 → need 500 → вверх до коробки 40 → 520
    expect(recommendOrderQty(400, ads(10), 3, 40)).toBe(520);
    expect(recommendOrderQty(1000, ads(10), 3, 40)).toBe(0);
    expect(recommendOrderQty(400, ads(null, false), 3, 40)).toBeNull();
  });

  it('прогноз после заказа = перед приходом + ручное количество', () => {
    const cov = coverageAfterOrder(150, 400, ads(10));
    expect(cov.kind === 'months' && cov.months).toBeCloseTo((150 + 400) / 10 / 30);
  });
});

describe('Коробки, цена, суммы (§15)', () => {
  it('пример ТЗ: кратность 40, ВЛК 800 (20 кор.), МСК 1600 (40 кор.) → 60 кор., цена 12760 → 30 624 000 KRW', () => {
    const prod = P({
      priceMode: 'tiers', fixedPrice: null,
      tiers: [
        { minBoxes: 1, maxBoxes: 19, pricePerUnit: '13000' },
        { minBoxes: 20, maxBoxes: 59, pricePerUnit: '12760' },
        { minBoxes: 60, maxBoxes: null, pricePerUnit: '12760' },
      ],
    });
    const c = calcLine(prod, 800, 1600);
    expect(c.boxesVLK).toBe(20);
    expect(c.boxesMSK).toBe(40);
    expect(c.boxesTotal).toBe(60);
    expect(c.pricePerUnit).toBe('12760');
    expect(c.sumTotal).toBe('30624000.00');
    expect(c.sumVLK).toBe('10208000.00');
    expect(c.sumMSK).toBe('20416000.00');
  });

  it('§21.12 ступень зависит от суммарных коробок обоих филиалов; пересчёт при изменении Q', () => {
    const prod = P({
      priceMode: 'tiers', fixedPrice: null,
      tiers: [{ minBoxes: 1, maxBoxes: 29, pricePerUnit: '13000' }, { minBoxes: 30, maxBoxes: null, pricePerUnit: '12000' }],
    });
    expect(calcLine(prod, 400, 800).pricePerUnit).toBe('12000'); // 10+20=30 кор.
    const changed = calcLine(prod, 400, 400); // 10+10=20 кор. → другая ступень
    expect(changed.pricePerUnit).toBe('13000');
    expect(changed.sumTotal).toBe('10400000.00');
  });

  it('некратность подсвечивается, цена по ступеням недоступна, утверждение блокируется', () => {
    const prod = P({ packSize: 40, priceMode: 'tiers', fixedPrice: null, tiers: [{ minBoxes: 1, maxBoxes: null, pricePerUnit: '100' }] });
    const c = calcLine(prod, 810, 400);
    expect(c.packOk).toBe(false);
    expect(isPackMultiple(810, 40)).toBe(false);
    expect(c.priceError).toBeTruthy();
  });

  it('отсутствие подходящей ступени — ошибка, цена не угадывается', () => {
    const prod = P({ priceMode: 'tiers', fixedPrice: null, tiers: [{ minBoxes: 10, maxBoxes: 20, pricePerUnit: '100' }] });
    const c = calcLine(prod, 40, 40); // 2 коробки
    expect(c.pricePerUnit).toBeNull();
    expect(c.priceError).toContain('Нет подходящей ценовой ступени');
  });

  it('валидация ступеней ловит пересечения', () => {
    expect(validateTiers([{ minBoxes: 1, maxBoxes: 10, pricePerUnit: '1' }, { minBoxes: 10, maxBoxes: null, pricePerUnit: '1' }]).length).toBeGreaterThan(0);
  });
});

describe('Валюты (§16) и десятичная арифметика', () => {
  it('курсы по умолчанию 85 и 0.063; KRW→RUB→USD', () => {
    const t = convertTotals('30624000', 'KRW', { usdRub: '85', krwRub: '0.063' });
    expect(t.rub).toBe('1929312.00');
    expect(t.usd).toBe('22697.79');
    expect(t.krw).toBe('30624000.00');
  });

  it('USD→RUB→KRW', () => {
    const t = convertTotals('1000', 'USD', { usdRub: '85', krwRub: '0.063' });
    expect(t.rub).toBe('85000.00');
    expect(t.krw).toBe('1349206.35');
  });

  it('десятичная арифметика без float-ошибок', () => {
    // 0.1 + 0.2 ≠ 0.3 во float; в dec — ровно 0.3
    const s = decAdd(decFromString('0.1'), decFromString('0.2'));
    expect(decToString(s)).toBe('0.3');
    expect(decimalCmp('0.30', '0.3')).toBe(0);
    const m = decMul(decFromString('12760'), decFromString('2400'));
    expect(decToString(m)).toBe('30624000');
    expect(decToString(decRound(decFromString('123.456'), 2))).toBe('123.46');
    expect(() => decFromString('abc')).toThrow();
  });

  it('итог заказа = сумма позиций; позиции с ошибкой цены блокируют (не входят)', () => {
    const prod = P({ priceMode: 'fixed', fixedPrice: '100.5' });
    const totals = calcOrderTotals([calcLine(prod, 10, 10)], 'KRW', { usdRub: '85', krwRub: '0.063' });
    expect(totals.primary).toBe('2010.00');
    expect(totals.rub).toBe('126.63');
  });
});

// ===== Импорт/экспорт: Excel и JSON =====
import * as XLSX from 'xlsx';
import type { FixedOrder, Brand, Settings, Currency } from './types';
import { convert } from './calc';

function download(blobParts: BlobPart[], filename: string, mime: string) {
  const blob = new Blob(blobParts, { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Экспорт зафиксированного заказа в .xlsx */
export function exportOrderToExcel(order: FixedOrder, brand: Brand, settings: Settings) {
  const rates = { usdRub: settings.usdRub, krwRub: settings.krwRub };
  const cur = order.currency;
  const thirdCur: Currency = cur === 'KRW' ? 'USD' : 'KRW';

  const header = [
    ['Заказ', order.number],
    ['Бренд', brand.name],
    ['Дата оформления', order.date],
    ['Валюта прайса', cur],
    ['Курс USD/RUB (на момент фиксации)', order.rates.usdRub],
    ['Курс KRW/RUB (на момент фиксации)', order.rates.krwRub],
    [],
    ['Штрихкод', 'Артикул', 'Наименование', 'Кратность',
      'Кол-во ВЛД', 'Коробки ВЛД', 'Сумма ВЛД (' + cur + ')',
      'Кол-во МСК', 'Коробки МСК', 'Сумма МСК (' + cur + ')',
      'Общее кол-во', 'Общие коробки', 'Цена (' + cur + '/шт)',
      'Итого (' + cur + ')', 'Итого (RUB)', 'Итого (' + thirdCur + ')'],
  ];

  const rows: (string | number)[][] = [];
  for (const l of order.lines) {
    const conv = convert(l.totalSum, order.currency, order.rates);
    rows.push([
      l.barcode, l.article, l.name, l.packSize,
      l.vldQty, l.vldQty / l.packSize, round2(l.vldSum),
      l.mskQty, l.mskQty / l.packSize, round2(l.mskSum),
      l.totalQty, l.totalBoxes, l.appliedPrice ?? '',
      round2(l.totalSum), round2(conv.rub), round2(thirdCur === 'USD' ? conv.usd : conv.krw),
    ]);
  }
  const totConv = convert(order.totalSum, order.currency, order.rates);
  rows.push(['', '', 'ИТОГО', '',
    order.lines.reduce((a, l) => a + l.vldQty, 0), '', round2(order.lines.reduce((a, l) => a + l.vldSum, 0)),
    order.lines.reduce((a, l) => a + l.mskQty, 0), '', round2(order.lines.reduce((a, l) => a + l.mskSum, 0)),
    order.totalUnits, order.totalBoxes, '',
    round2(order.totalSum), round2(totConv.rub), round2(thirdCur === 'USD' ? totConv.usd : totConv.krw),
  ]);

  const ws = XLSX.utils.aoa_to_sheet([...header, ...rows]);
  ws['!cols'] = [{ wch: 15 }, { wch: 10 }, { wch: 35 }, { wch: 9 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Заказ');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download([out], `zakaz-${order.number}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Разбор вставленного из Excel текста (TSV/CSV) в матрицу ячеек */
export function parseClipboard(text: string): string[][] {
  const lines = text.replace(/\r/g, '').split('\n');
  // убираем полностью пустую последнюю строку
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map((l) => l.split('\t'));
}

/** Числовое значение из ячейки вставки; пустая строка => null (не введено) */
export function parseCellNumber(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim().replace(/\s|\u00A0/g, '').replace(',', '.');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** Скачать JSON резервной копии */
export function downloadJson(data: unknown, filename: string) {
  download([JSON.stringify(data, null, 2)], filename, 'application/json');
}

/** Прочитать файл как текст */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('Не удалось прочитать файл'));
    r.readAsText(file);
  });
}

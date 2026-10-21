/**
 * Глобальные настройки: курсы валют, напоминания о резервных копиях (§16, §27 ТЗ).
 */
import { db } from '../database';
import type { SettingsRow } from '../schema';
import { nowISO, writeAudit } from '../util';
import { DEFAULT_RATES, decimalCmp, type ExchangeRates } from '../../core/types';
import { APP_VERSION } from '../schema';

export const settingsRepo = {
  async get(): Promise<SettingsRow> {
    const found = await db.settings.get('global');
    if (found) return found;
    const row: SettingsRow = {
      id: 'global',
      rates: { ...DEFAULT_RATES },
      defaultTargetTZMonths: 3,
      backupRemindDays: 7,
      lastBackupAt: null,
      appVersion: APP_VERSION,
    };
    await db.settings.add(row);
    return row;
  },

  /** Курсы > 0 — иначе ошибка (§16). */
  async setRates(rates: ExchangeRates, actor = 'оператор'): Promise<SettingsRow> {
    if (decimalCmp(rates.usdRub, '0') <= 0) throw new Error('Курс USD/RUB должен быть > 0');
    if (decimalCmp(rates.krwRub, '0') <= 0) throw new Error('Курс KRW/RUB должен быть > 0');
    // валидность формата десятичных строк (выбросит при мусоре)
    const { decFromString } = await import('../../core/types');
    decFromString(rates.usdRub);
    decFromString(rates.krwRub);
    const before = await this.get();
    const after: SettingsRow = { ...before, rates: { ...rates }, appVersion: APP_VERSION };
    await db.transaction('rw', db.settings, db.audit, async () => {
      await db.settings.put(after);
      await writeAudit(db, { entity: 'settings', entityId: 'global', action: 'set-rates', details: `Курсы: USD=${rates.usdRub}, KRW=${rates.krwRub}`, before, after, actor });
    });
    return after;
  },

  async markBackupDone(actor = 'оператор'): Promise<SettingsRow> {
    const before = await this.get();
    const after: SettingsRow = { ...before, lastBackupAt: nowISO() };
    await db.transaction('rw', db.settings, db.audit, async () => {
      await db.settings.put(after);
      await writeAudit(db, { entity: 'settings', entityId: 'global', action: 'backup-exported', details: 'Скачана полная резервная копия', actor });
    });
    return after;
  },

  async update(patch: Partial<Omit<SettingsRow, 'id' | 'rates'>>, actor = 'оператор'): Promise<SettingsRow> {
    const before = await this.get();
    const after: SettingsRow = { ...before, ...patch };
    await db.transaction('rw', db.settings, db.audit, async () => {
      await db.settings.put(after);
      await writeAudit(db, { entity: 'settings', entityId: 'global', action: 'update', details: 'Изменены глобальные настройки', before, after, actor });
    });
    return after;
  },
};

/** Нужен ли сигнал о резервном копировании (§27): изменения позже последнего бэкапа или прошло N дней. */
export async function backupReminderDue(now = new Date()): Promise<{ due: boolean; reason: string | null }> {
  const s = await settingsRepo.get();
  if (!s.lastBackupAt) return { due: true, reason: 'Резервная копия ещё не создавалась' };
  const daysSince = (now.getTime() - new Date(s.lastBackupAt).getTime()) / 86_400_000;
  if (daysSince >= s.backupRemindDays) return { due: true, reason: `Прошло ${Math.floor(daysSince)} дн. с последней копии` };
  const lastChange = await db.audit.orderBy('at').last();
  if (lastChange && new Date(lastChange.at).getTime() > new Date(s.lastBackupAt).getTime()) {
    return { due: true, reason: 'Есть изменения после последней резервной копии' };
  }
  return { due: false, reason: null };
}

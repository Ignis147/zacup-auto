/**
 * Утилиты слоя данных: генерация id, временные метки, журнал изменений (audit).
 */
import { db } from './database';
import type { AuditRow } from './schema';

/** Стабильный уникальный id (не зависит от штрихкода — §3 ТЗ). */
export function newId(prefix = ''): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

/** Момент времени — ISO UTC (часовые пояса не влияют). */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Календарная дата YYYY-MM-DD в ЛОКАЛЬНОЙ зоне без смещения (для полей типа issueDate). */
export function localTodayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface AuditInput {
  brandId?: string | null;
  entity: string;
  entityId: string;
  action: string;
  details: string;
  before?: unknown;
  after?: unknown;
  actor?: string;
}

/**
 * Запись в журнал изменений. Вызывается ВНУТРИ транзакций репозиториев,
 * чтобы изменение и его история были атомарными (§3, §20 ТЗ).
 */
export async function writeAudit(tx: { audit: { add(row: AuditRow): Promise<unknown> } }, input: AuditInput): Promise<void> {
  await tx.audit.add({
    id: newId('aud'),
    brandId: input.brandId ?? null,
    at: nowISO(),
    actor: input.actor ?? 'оператор',
    entity: input.entity,
    entityId: input.entityId,
    action: input.action,
    details: input.details,
    before: input.before,
    after: input.after,
  });
}

/** Отдельная (вне транзакции) запись аудита — для системных событий. */
export async function logAudit(input: AuditInput): Promise<string> {
  const id = newId('aud');
  await db.audit.add({
    id,
    brandId: input.brandId ?? null,
    at: nowISO(),
    actor: input.actor ?? 'оператор',
    entity: input.entity,
    entityId: input.entityId,
    action: input.action,
    details: input.details,
    before: input.before,
    after: input.after,
  });
  return id;
}

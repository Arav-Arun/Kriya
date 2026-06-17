// Inbound Hyperface event webhooks. Validates custom auth headers and routes proactive alerts.
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../core/env.ts';
import { hyperfaceProvider } from './hyperface.ts';
import type { ProviderResult } from './types.ts';

export const WEBHOOK_SECRET_HEADER = 'x-kriya-webhook-secret';

// Compare delivered webhook secret against config.
export function verifyWebhookSecret(presented: string | undefined): boolean {
  const expected = config.hyperface.webhookSecret;
  if (!expected) return false; // not configured ⇒ reject (fail closed)
  const a = Buffer.from(String(presented ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface HyperfaceEvent {
  /** e.g. "TRANSACTION_POSTED", "PAYMENT_RECEIVED", "CARD_HOTLISTED". */
  eventType: string;
  /** "ACCOUNT" | "CARD" | "CUSTOMER" — what scopeId identifies. */
  scope: string;
  /** The provider id the event is about (accountId / cardId / customerId). */
  scopeId: string;
  eventId: string;
  data: Record<string, unknown>;
  raw: unknown;
}

// Generate a deterministic synthetic ID for events lacking a provider event ID.
function syntheticEventId(eventType: string, scopeId: string, data: Record<string, unknown>): string {
  const stableKey =
    data.txnId ?? data.transactionId ?? data.paymentId ?? data.referenceId ??
    data.extRefId ?? data.extTxnRefId ?? data.id ?? null;
  let fingerprint: string;
  if (stableKey != null && String(stableKey).trim()) {
    fingerprint = String(stableKey).trim();
  } else {
    // Canonicalize keys to match reordered JSON across retries.
    try {
      const sorted = Object.keys(data).sort().map((k) => `${k}=${JSON.stringify(data[k])}`).join('&');
      fingerprint = sorted;
    } catch {
      fingerprint = String(data);
    }
  }
  const hash = createHash('sha256').update(`${eventType} ${scopeId} ${fingerprint}`).digest('hex').slice(0, 32);
  return `syn-${hash}`;
}

// Normalize delivery body; returns null if unrecognized.
export function parseHyperfaceEvent(body: any): HyperfaceEvent | null {
  if (!body || typeof body !== 'object') return null;
  const eventType = String(body.eventType ?? body.type ?? body.event ?? '').trim();
  if (!eventType) return null;
  const scope = String(body.scope ?? body.resourceType ?? 'ACCOUNT').toUpperCase();
  const scopeId = String(
    body.scopeId ?? body.resourceId ?? body.accountId ?? body.cardId ?? body.customerId ?? '',
  ).trim();
  const data = (body.data ?? body.payload ?? body) as Record<string, unknown>;
  const eventId = String(body.eventId ?? body.id ?? syntheticEventId(eventType, scopeId, data));
  return { eventType, scope, scopeId, eventId, data, raw: body };
}

// Events that trigger proactive customer notifications.
const NOTIFY_EVENTS = new Set([
  'TRANSACTION_POSTED', 'TRANSACTION_DECLINED', 'PAYMENT_RECEIVED',
  'CARD_HOTLISTED', 'CARD_LOCKED', 'FRAUD_ALERT', 'STATEMENT_GENERATED',
]);

export function shouldNotify(eventType: string): boolean {
  return NOTIFY_EVENTS.has(eventType.toUpperCase());
}

// Deduplicate webhook retries (bounded LRU map).
const SEEN_EVENT_CAP = 5000;
const seenEventIds = new Map<string, true>();
export function alreadySeenEvent(eventId: string): boolean {
  if (seenEventIds.has(eventId)) {
    // Touch: move to most-recently-used so it survives the next eviction.
    seenEventIds.delete(eventId);
    seenEventIds.set(eventId, true);
    return true;
  }
  seenEventIds.set(eventId, true);
  while (seenEventIds.size > SEEN_EVENT_CAP) {
    const oldest = seenEventIds.keys().next().value;
    if (oldest === undefined) break;
    seenEventIds.delete(oldest);
  }
  return false;
}

// Map a provider accountId to the cardholder's mobile number (calls GET /accounts/{id}/summary).
export async function mobileForAccount(accountId: string): Promise<string | null> {
  const res: ProviderResult<any> = await hyperfaceProvider.accountSummary(accountId);
  if (!res.ok) return null;
  const mobile = res.data?.account?.customer?.mobileNumber;
  return mobile ? String(mobile) : null;
}

// Generate human-friendly notification copy.
export function notificationText(ev: HyperfaceEvent): string {
  const amount = ev.data?.amount != null ? `₹${Number(ev.data.amount).toLocaleString('en-IN')}` : null;
  const merchant = ev.data?.merchant ? String(ev.data.merchant) : null;
  switch (ev.eventType.toUpperCase()) {
    case 'TRANSACTION_POSTED':
      return `Kriya alert: a charge${amount ? ` of ${amount}` : ''}${merchant ? ` at ${merchant}` : ''} was just posted to your card. Reply here if you don't recognise it.`;
    case 'TRANSACTION_DECLINED':
      return `Kriya alert: a transaction${amount ? ` of ${amount}` : ''}${merchant ? ` at ${merchant}` : ''} on your card was declined. Reply here if you'd like help.`;
    case 'PAYMENT_RECEIVED':
      return `Kriya: we've received your card payment${amount ? ` of ${amount}` : ''}. Thank you!`;
    case 'CARD_HOTLISTED':
      return `Kriya: your card has been hotlisted (blocked permanently). Reply here to arrange a replacement.`;
    case 'CARD_LOCKED':
      return `Kriya: your card has been locked. Reply here if you'd like to unlock it (we'll verify it's you first).`;
    case 'FRAUD_ALERT':
      return `Kriya security alert: unusual activity was flagged on your card. Reply here right away if this wasn't you.`;
    case 'STATEMENT_GENERATED':
      return `Kriya: your new card statement is ready. Ask me for your due date, minimum due, or a breakdown anytime.`;
    default:
      return `Kriya: there's an update on your card account.`;
  }
}

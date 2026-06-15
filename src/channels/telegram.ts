// Telegram Bot API adapter for the Hermes channel layer.
//
// Telegram is the zero-cost, no-extra-number channel: create a bot with
// @BotFather, register the webhook (see DEPLOY.md), and any customer can reach
// Kriya from a t.me link. Configured from env (see src/config/env.ts):
//   TELEGRAM_BOT_TOKEN       bot token from @BotFather (enables the adapter)
//   TELEGRAM_WEBHOOK_SECRET  optional secret echoed by Telegram in the
//                            X-Telegram-Bot-Api-Secret-Token header; we set it
//                            at setWebhook time and verify it on every delivery
//
// Identity bridge: Hermes is phone-keyed — it matches customers by registered
// mobile number and routes replies by phone — but Telegram identifies users by
// a numeric chat id and never reveals a phone unless the user *shares their
// contact*. So the adapter:
//   - asks an unrecognised chat to tap "Share my number" (request_contact),
//   - records the phone <-> chat_id mapping when the contact arrives (a
//     possession factor: the number is vouched for by Telegram, not typed),
//   - resolves phone -> chat_id on outbound send.
// The mapping is in-memory/best-effort, matching the rest of the channel
// layer's proactive-routing posture: after a restart a user is re-linked the
// next time they message (we re-prompt for the contact, which is one tap).
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.ts';
import { phoneKey } from './types.ts';
import type { ChannelAdapter, OutboundDelivery } from './types.ts';

const API_BASE = 'https://api.telegram.org';
const MAX_LEN = 4000; // Telegram's hard limit is 4096 chars; stay under it.

// phone(last-10) <-> chat_id, learned from contact shares. In-memory/best-effort;
// the durable copy lives in channel_messages.meta (see hermes) and is rehydrated
// on the next outbound send after a restart.
const chatIdByPhone = new Map<string, string>();
const phoneByChatId = new Map<string, string>();

// Re-prompt throttle: never re-send the request_contact keyboard to an unlinked
// chat more than once per window — a user may fire several texts before tapping.
const PROMPT_THROTTLE_MS = 5 * 60_000;
const lastPromptByChatId = new Map<string, number>();

// Soft cap on the in-memory maps' growth, mirroring hermes' seenProviderIds.
// A clear is recoverable: the binding is re-learned (inbound) or rehydrated from
// channel_messages (outbound), so bounded memory beats an unbounded leak.
const MAX_BINDINGS = 10_000;

/** Bind phone <-> chat_id, audit a rebind (last-4 only, no PII), and bound the
 *  maps' growth. A rebind is a Telegram-vouched move of a number to a new chat. */
function bindContact(phone: string, chatId: string): void {
  const prev = chatIdByPhone.get(phone);
  if (prev && prev !== chatId) {
    console.warn(`[telegram] rebinding ${phone.slice(-4).padStart(10, '*')} to a new chat`);
    phoneByChatId.delete(prev); // drop the now-stale reverse entry
  }
  if (chatIdByPhone.size > MAX_BINDINGS) { chatIdByPhone.clear(); phoneByChatId.clear(); }
  chatIdByPhone.set(phone, chatId);
  phoneByChatId.set(chatId, phone);
}

function api(method: string): string {
  return `${API_BASE}/bot${config.telegram.botToken}/${method}`;
}

/** Constant-time check of the X-Telegram-Bot-Api-Secret-Token delivery header.
 *  Fails CLOSED in deployed mode when no secret is configured: the webhook URL
 *  is the only thing standing between the internet and the phone-keyed identity
 *  bridge, so an unauthenticated delivery must not be trusted in production. In
 *  local dev (not deployed) it passes so the webhook is easy to exercise.
 *  (enforceHostedGuardrails also refuses to *start* a deployed bot without it.) */
export function verifyTelegramSecret(header: string | undefined): boolean {
  const expected = config.telegram.webhookSecret;
  if (!expected) return !config.deployed;
  const a = Buffer.from(String(header ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type TelegramInbound =
  | { kind: 'text'; chatId: string; text: string; from: string; profileName?: string; messageId: string; timestamp: string; identified: boolean }
  | { kind: 'contact'; chatId: string; phone: string; profileName?: string }
  | null;

/** Pull a clean 10-digit Indian mobile number out of free text — "8668670352",
 *  "+91 8668670352", or "check this number: +91 8668670352" all yield
 *  "8668670352". Used only for the UAT typed-identity affordance below. Returns
 *  null when the text has no phone-shaped token, so a normal question ("what's my
 *  balance") is never mistaken for a number. */
function extractIndianMobile(text: string): string | null {
  for (const raw of text.match(/\+?\d[\d\s-]{8,}\d/g) ?? []) {
    const digits = raw.replace(/\D/g, '');
    const core = digits.length > 10 && /^(0|91)/.test(digits) ? digits.slice(-10) : digits;
    if (core.length === 10 && /^[6-9]/.test(core)) return core;
  }
  return null;
}

/** Normalize a Telegram Update into a contact share or a text message,
 *  resolving identity from the learned phone <-> chat_id map. */
export function parseTelegramUpdate(body: any): TelegramInbound {
  // Telegram delivers user edits as `edited_message` (same shape + edit_date).
  // Handle them too so a corrected message ("block my crd" -> "card") isn't
  // silently dropped; the edit_date is folded into the dedupe key below so a
  // genuine edit is processed while a webhook retry of it is still deduped.
  const m = body?.message ?? body?.edited_message;
  if (!m) return null;
  // Only serve 1:1 private chats. A group/channel message must never bind or
  // act on a card account — anyone in the group could drive a member's account.
  if (m.chat?.type && m.chat.type !== 'private') return null;
  const chatId = String(m.chat?.id ?? m.from?.id ?? '');
  if (!chatId) return null;
  const profileName =
    [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ').trim()
    || (m.from?.username ? String(m.from.username) : undefined);

  // A shared contact carries the Telegram-verified phone number — but only
  // trust it when the sender shared it about THEMSELVES via the request_contact
  // button, where Telegram sets contact.user_id to the sender's own id. A
  // manually-forwarded third-party contact (user_id absent or different) must
  // NOT be trusted as a possession factor: it would let someone bind their chat
  // to another cardholder's number and read that account.
  const contact = m.contact;
  const senderId = m.from?.id;
  if (contact?.phone_number && senderId != null && String(contact.user_id ?? '') === String(senderId)) {
    const phone = phoneKey(String(contact.phone_number));
    if (phone.length === 10) {
      bindContact(phone, chatId);
      return { kind: 'contact', chatId, phone, profileName };
    }
  }

  const text = String(m.text ?? '').trim();
  if (!text) return null;
  const phone = phoneByChatId.get(chatId);

  // UAT TEST AFFORDANCE: a chat may identify (or switch accounts) by TYPING a
  // registered mobile number — e.g. a Hyperface UAT directory number — instead of
  // tapping "Share my number". A typed number is NOT vouched for by Telegram, so
  // this is gated to the UAT provider mode: in production the contact share is the
  // only identity path, because it proves the sender owns the number (otherwise
  // anyone could type a cardholder's number and read their account, as reads are
  // ungated). Treated exactly like a contact share: bind + welcome, then the next
  // message is identified and runs the normal pipeline.
  //   - Not yet linked: accept a number even inside a sentence ("check this: …").
  //   - Already linked: only re-link when the message is JUST a number (no
  //     letters), so a normal question that happens to contain digits never
  //     silently switches the account.
  if (config.providerMode === 'hyperface_uat' && (!phone || !/[a-z]/i.test(text))) {
    const typed = extractIndianMobile(text);
    if (typed && typed !== phone) {
      bindContact(typed, chatId);
      return { kind: 'contact', chatId, phone: typed, profileName };
    }
  }

  return {
    kind: 'text',
    chatId,
    text, // full message; recordMessage caps the persisted body at 4000 itself
    from: phone ?? chatId, // a phone once we know it; the chat id until then
    profileName,
    // message_id is unique only within a chat, so namespace dedupe by chat. An
    // edit reuses the original message_id, so suffix edit_date to let the edit
    // through while still deduping a retry of that same edit.
    messageId: `${chatId}:${m.message_id ?? m.date ?? Date.now()}${m.edit_date ? `:e${m.edit_date}` : ''}`,
    timestamp: m.date ? new Date(Number(m.date) * 1000).toISOString() : new Date().toISOString(),
    identified: Boolean(phone),
  };
}

/** Record a phone <-> chat_id binding (e.g. re-link after a restart). */
export function rememberContact(phone: string, chatId: string): void {
  const key = phoneKey(phone);
  if (key.length === 10) bindContact(key, chatId);
}

async function callTelegram(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!config.telegram.configured) return { ok: false, error: 'Telegram is not configured (TELEGRAM_BOT_TOKEN).' };
  try {
    const res = await fetch(api(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({})) as any;
    if (!res.ok || !data?.ok) {
      return { ok: false, error: `Telegram ${method} failed (${res.status}): ${data?.description ?? 'unknown error'}` };
    }
    return { ok: true, messageId: data?.result?.message_id != null ? String(data.result.message_id) : undefined };
  } catch (err) {
    // Scrub the bot token in case it surfaces in a fetch error string.
    const msg = String((err as Error)?.message ?? err);
    const safe = config.telegram.botToken ? msg.split(config.telegram.botToken).join('<token>') : msg;
    return { ok: false, error: safe.slice(0, 200) };
  }
}

/** Prompt an unrecognised chat to share its registered number. */
export async function requestContact(chatId: string): Promise<OutboundDelivery> {
  // Throttle so an unlinked chat can't be spammed with the keyboard on every
  // message (and so a webhook retry doesn't re-prompt). Treat a throttled
  // prompt as a no-op success.
  const last = lastPromptByChatId.get(chatId);
  if (last && Date.now() - last < PROMPT_THROTTLE_MS) return { ok: true };
  if (lastPromptByChatId.size > MAX_BINDINGS) lastPromptByChatId.clear();
  lastPromptByChatId.set(chatId, Date.now());
  // In UAT, we ask for a typed mobile number and clear any Telegram custom keyboard
  // so the user can easily type a test/sample number (like a Hyperface UAT directory number).
  const isUat = config.providerMode === 'hyperface_uat';
  const text = isUat
    ? "Namaste! I'm Kriya, your card assistant. To pull up your card account, please reply with your registered 10-digit mobile number (e.g. 9876543210)."
    : "Namaste! I'm Kriya, your card assistant. To pull up your account, please share your registered mobile number using the button below.";
  const payload: Record<string, any> = {
    chat_id: chatId,
    text,
  };
  if (isUat) {
    payload.reply_markup = {
      remove_keyboard: true,
    };
  } else {
    payload.reply_markup = {
      keyboard: [[{ text: '📱 Share my number', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    };
  }
  const r = await callTelegram('sendMessage', payload);
  return { ok: r.ok, providerMessageId: r.messageId, error: r.error };
}

class TelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;

  get configured(): boolean {
    return config.telegram.configured;
  }

  /** `to` is a registered phone (the Hermes peer). Resolves to the linked
   *  chat id; fails gracefully if this number hasn't shared a contact yet. */
  async sendText(to: string, text: string): Promise<OutboundDelivery> {
    if (!this.configured) return { ok: false, error: 'Telegram is not configured (TELEGRAM_BOT_TOKEN).' };
    const chatId = chatIdByPhone.get(phoneKey(to));
    if (!chatId) {
      return { ok: false, error: 'No Telegram chat is linked to this number yet (the customer must share their contact first).' };
    }
    let lastId: string | undefined;
    for (const chunk of splitMessage(text, MAX_LEN)) {
      const r = await callTelegram('sendMessage', { chat_id: chatId, text: chunk });
      if (!r.ok) return { ok: false, error: r.error };
      lastId = r.messageId;
    }
    return { ok: true, providerMessageId: lastId };
  }
}

function splitMessage(text: string, max: number): string[] {
  const clean = String(text ?? '').trim();
  if (clean.length <= max) return [clean];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const slice = rest.slice(0, max);
    const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
    let at = cut > max * 0.5 ? cut + 1 : max;
    // Never cut between a UTF-16 surrogate pair, or we'd emit a broken glyph
    // (the welcome copy and Hinglish replies carry emoji/astral chars).
    const prevCode = rest.charCodeAt(at - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) at -= 1;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

export const telegramAdapter = new TelegramAdapter();

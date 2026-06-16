// Telegram Bot API adapter for the Hermes channel layer.
// Handles inbound webhook verification, phone number binding, and outbound messaging.
// Calls: POST https://api.telegram.org/bot<token>/sendMessage
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.ts';
import { phoneKey } from './types.ts';
import type { ChannelAdapter, OutboundDelivery } from './types.ts';

const API_BASE = 'https://api.telegram.org';
const MAX_LEN = 4000; // Telegram's hard limit is 4096 chars; stay under it.

// Capability overview shown for /start and /help (identified users). Mirrors the
// full live feature set so Telegram stays consistent with the web copilot.
export const KRIYA_TELEGRAM_HELP =
  "**Kriya — your card copilot**\n"
  + "I work on your real card account, live. Just ask in plain language:\n\n"
  + "• **Balance & limits** — \"what's my outstanding?\", \"how much credit is left?\"\n"
  + "• **Spending** — \"where did my money go this month?\" for a category breakdown\n"
  + "• **Transactions** — \"show my recent transactions\", or ask about one charge\n"
  + "• **Statements & bills** — \"send my last statement\", \"what's my next bill?\"\n"
  + "• **EMI** — \"what are my EMI options?\", convert a purchase or your outstanding\n"
  + "• **Card controls** — block/unblock, and online/contactless/ATM/international toggles\n"
  + "• **Disputes & refunds** — flag a wrong or duplicate charge\n"
  + "• **Subscriptions** — list autopays/mandates and cancel one\n\n"
  + "Lost your card? Just say \"block my card\" — I do it instantly, no questions first.";

// Render assistant markdown as Telegram-safe HTML: escape the markup-significant
// characters, then re-introduce only the tags Telegram's HTML parse_mode allows
// (<b>, <i>, <code>). Markdown tables can't render on Telegram, so their pipes
// just survive as plain text. Bullets are normalised to "• ".
function toTelegramHtml(s: string): string {
  let t = String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/^[\t ]*[-•]\s+/gm, '• ');
  return t;
}

// In-memory phone <-> chat_id bindings.
const chatIdByPhone = new Map<string, string>();
const phoneByChatId = new Map<string, string>();

// Cooldown to throttle request_contact keyboard prompts.
const PROMPT_THROTTLE_MS = 5 * 60_000;
const lastPromptByChatId = new Map<string, number>();

// Bounded size to prevent memory leaks.
const MAX_BINDINGS = 10_000;

// Bind phone <-> chat_id, tracking changes and bounding memory growth.
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

// Verify Telegram webhook secret header (constant-time comparison).
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

// Extract 10-digit Indian mobile number from text.
function extractIndianMobile(text: string): string | null {
  for (const raw of text.match(/\+?\d[\d\s-]{8,}\d/g) ?? []) {
    const digits = raw.replace(/\D/g, '');
    const core = digits.length > 10 && /^(0|91)/.test(digits) ? digits.slice(-10) : digits;
    if (core.length === 10 && /^[6-9]/.test(core)) return core;
  }
  return null;
}

// Parse Telegram webhook updates into normalized inbound text or contact events.
export function parseTelegramUpdate(body: any): TelegramInbound {
  const m = body?.message ?? body?.edited_message;
  if (!m) return null;
  if (m.chat?.type && m.chat.type !== 'private') return null;
  const chatId = String(m.chat?.id ?? m.from?.id ?? '');
  if (!chatId) return null;
  const profileName =
    [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ').trim()
    || (m.from?.username ? String(m.from.username) : undefined);

  // Validate and bind Telegram-verified contact share.
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

  // Fallback: allow identity binding by typing a number instead of sharing a contact.
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
    text,
    from: phone ?? chatId,
    profileName,
    messageId: `${chatId}:${m.message_id ?? m.date ?? Date.now()}${m.edit_date ? `:e${m.edit_date}` : ''}`,
    timestamp: m.date ? new Date(Number(m.date) * 1000).toISOString() : new Date().toISOString(),
    identified: Boolean(phone),
  };
}

// Persist the phone <-> chat_id binding in memory.
export function rememberContact(phone: string, chatId: string): void {
  const key = phoneKey(phone);
  if (key.length === 10) bindContact(key, chatId);
}

// Calls Telegram Bot API methods (POST https://api.telegram.org/bot<token>/<method>)
async function callTelegram(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!config.telegram.configured) return { ok: false, error: 'Telegram is not configured.' };
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
    const msg = String((err as Error)?.message ?? err);
    const safe = config.telegram.botToken ? msg.split(config.telegram.botToken).join('<token>') : msg;
    return { ok: false, error: safe.slice(0, 200) };
  }
}

// Request mobile number sharing (keyboard markup or plain text instructions).
export async function requestContact(chatId: string): Promise<OutboundDelivery> {
  const last = lastPromptByChatId.get(chatId);
  if (last && Date.now() - last < PROMPT_THROTTLE_MS) return { ok: true };
  if (lastPromptByChatId.size > MAX_BINDINGS) lastPromptByChatId.clear();
  lastPromptByChatId.set(chatId, Date.now());
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

  // Send text to registered phone by resolving its Telegram chat ID.
  async sendText(to: string, text: string): Promise<OutboundDelivery> {
    if (!this.configured) return { ok: false, error: 'Telegram is not configured (TELEGRAM_BOT_TOKEN).' };
    const chatId = chatIdByPhone.get(phoneKey(to));
    if (!chatId) {
      return { ok: false, error: 'No Telegram chat is linked to this number yet (the customer must share their contact first).' };
    }
    let lastId: string | undefined;
    for (const chunk of splitMessage(text, MAX_LEN)) {
      // Prefer HTML so **bold** and amounts render; if Telegram rejects the
      // formatted body (rare parse edge case), retry the same chunk as plain text.
      let r = await callTelegram('sendMessage', {
        chat_id: chatId,
        text: toTelegramHtml(chunk),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      if (!r.ok) r = await callTelegram('sendMessage', { chat_id: chatId, text: chunk });
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

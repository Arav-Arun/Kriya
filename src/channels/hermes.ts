// Hermes: the Kriya channel agent. Takes a normalized inbound message from
// any channel adapter, matches the sender to a card customer, runs the same
// durable chat-turn workflow the web copilot uses, and delivers the reply
// back on the channel. Every exchange is recorded (channel_messages table
// when present, in-memory otherwise) and deduplicated by provider message id
// so webhook retries never run the pipeline twice.
import { supabase } from '../database/client.ts';
import { config } from '../config/env.ts';
import { createCustomerFromLive, ProvisioningError } from '../database/queries.ts';
import { hyperfaceProvider } from '../providers/hyperface.ts';
import { invalidateLiveBinding } from '../services/provider-tools.ts';
import { phoneKey } from './types.ts';
import type { ChannelAdapter, ChannelKind, InboundChannelMessage } from './types.ts';
import { telegramAdapter, rememberContact as rememberTelegramBinding } from './telegram.ts';

/** Outbound adapter registry for proactive (provider-event) delivery. */
const ADAPTERS: Partial<Record<ChannelKind, ChannelAdapter>> = {
  telegram: telegramAdapter,
};

interface MatchedCustomer {
  id: number;
  name: string;
  phone: string;
  card_number_last4: string;
}

// ── Customer matching (last-10-digit phone key, 60s cache) ───────────
let phoneCache: { at: number; byKey: Map<string, MatchedCustomer> } | null = null;

async function customerByPhone(raw: string): Promise<MatchedCustomer | null> {
  const key = phoneKey(raw);
  if (key.length < 10) return null;
  if (!phoneCache || Date.now() - phoneCache.at > 60_000) {
    const { data, error } = await supabase.from('customers').select('id,name,phone,card_number_last4');
    if (error) throw error;
    const byKey = new Map<string, MatchedCustomer>();
    for (const c of (data ?? []) as MatchedCustomer[]) {
      const k = phoneKey(c.phone ?? '');
      if (k.length === 10) byKey.set(k, c);
    }
    phoneCache = { at: Date.now(), byKey };
  }
  return phoneCache.byKey.get(key) ?? null;
}

/** Resolve a registered mobile number to a Kriya customer id (provider webhook
 *  routing). Shares the same last-10-digit cache as inbound matching. */
export async function customerIdByPhone(raw: string): Promise<number | null> {
  const match = await customerByPhone(raw);
  return match?.id ?? null;
}

/**
 * Web sign-in: match a mobile number to a Kriya customer, provisioning one from
 * the live card provider on first contact — the exact identity path an inbound
 * channel message takes. Returns null when the provider has no card account on
 * this number (or live mode is off), which the API surfaces as "not found".
 */
export async function identifyByPhone(raw: string): Promise<MatchedCustomer | null> {
  return (await customerByPhone(raw)) ?? (await provisionFromLive(raw));
}

/**
 * Identity from the API: when an unknown number messages in, look it up in the
 * card provider (POST /customers/lookup) and provision a customer row from the
 * live account — name, email, card last-4 and figures all come from the system
 * of record. The row anchors chat memory/audit; the live binding (phone_lookup)
 * then serves all account data API-first. Returns null when the provider has
 * no account on this number (genuine stranger) or live mode is off.
 */
async function provisionFromLive(raw: string): Promise<MatchedCustomer | null> {
  if (config.providerMode !== 'hyperface_uat' || !hyperfaceProvider.configured) return null;
  const key = phoneKey(raw);
  if (key.length < 10) return null;

  let match: any = null;
  const lookup = await hyperfaceProvider.lookupCustomer({ mobileNumber: key });
  if (lookup.ok && lookup.data.length > 0) {
    match = lookup.data[0];
  } else {
    const issuerRes = await hyperfaceProvider.fetchIssuerCustomer({ mobileNumber: key });
    if (issuerRes.ok && issuerRes.data) {
      const data = issuerRes.data as any;
      const customer = Array.isArray(data) ? data[0] : data;
      if (customer && (customer.customerId || customer.id)) {
        match = {
          customerId: customer.customerId || customer.id,
          accounts: customer.accounts || [],
        };
      }
    }
  }

  if (!match) return null;
  const account = match.accounts.find((a: any) => a.status === 'ACTIVE') ?? match.accounts[0];
  if (!account) return null;

  const summary = await hyperfaceProvider.accountSummary(account.id);
  const liveCustomer = summary.ok ? summary.data.account?.customer : undefined;
  const primaryCard = summary.ok ? summary.data.primaryCard : undefined;
  const name = [liveCustomer?.firstName, liveCustomer?.lastName]
    .filter(Boolean).join(' ').trim() || 'Card Customer';
  const cardLast4 = (primaryCard?.maskedCardNumber ?? '').replace(/\D/g, '').slice(-4)
    || account.cards[0]?.cardLast4 || '';

  const id = await createCustomerFromLive({
    name,
    phone: key,
    email: liveCustomer?.emailAddress ?? null,
    card_last4: cardLast4,
    card_status: primaryCard?.isHotlisted ? 'hotlisted'
      : primaryCard?.isLocked ? 'blocked'
      : String(primaryCard?.cardStatus ?? 'active').toLowerCase(),
    credit_limit: summary.ok ? summary.data.account.approvedCreditLimit : undefined,
    available_limit: summary.ok ? summary.data.account.availableCreditLimit : undefined,
    outstanding_total: summary.ok ? Math.max(0, -summary.data.account.currentBalance) : undefined,
  });
  if (!id) return null;

  invalidateLiveBinding(id);
  const created: MatchedCustomer = { id, name, phone: key, card_number_last4: cardLast4 };
  phoneCache?.byKey.set(key, created);
  console.log(`[hermes] provisioned customer ${id} (${name}) from live provider for ${key.slice(-4).padStart(10, '*')}`);
  return created;
}

// ── Conversation continuity + message persistence ─────────────────────
// channel_messages columns (see db/migrations): channel, direction, peer,
// customer_id, conversation_id, provider_message_id, body, meta, created_at.
const seenProviderIds = new Set<string>();
const conversationByPeer = new Map<string, number>();
// Where each customer last reached us, so proactive provider-event alerts go
// back on the same surface. Survives only in-process (best-effort routing);
// the durable record is channel_messages.
const lastChannelByCustomer = new Map<number, { channel: ChannelKind; peer: string }>();
let channelTableMissing = false;

async function alreadyProcessed(msg: InboundChannelMessage): Promise<boolean> {
  const memoryKey = `${msg.channel}:${msg.providerMessageId}`;
  if (seenProviderIds.has(memoryKey)) return true;
  if (!channelTableMissing) {
    const { data, error } = await supabase.from('channel_messages')
      .select('id').eq('channel', msg.channel).eq('provider_message_id', msg.providerMessageId).limit(1);
    if (error) channelTableMissing = true; // table not migrated yet — in-memory dedupe only
    else if ((data ?? []).length > 0) return true;
  }
  seenProviderIds.add(memoryKey);
  if (seenProviderIds.size > 5000) seenProviderIds.clear();
  return false;
}

async function recordMessage(input: {
  channel: string; direction: 'inbound' | 'outbound'; peer: string;
  customerId: number | null; conversationId: number | null;
  providerMessageId: string | null; body: string; meta?: unknown;
}): Promise<void> {
  if (channelTableMissing) return;
  const { error } = await supabase.from('channel_messages').insert({
    channel: input.channel,
    direction: input.direction,
    peer: phoneKey(input.peer) || input.peer,
    customer_id: input.customerId,
    conversation_id: input.conversationId,
    provider_message_id: input.providerMessageId,
    body: input.body.slice(0, 4000),
    meta: input.meta == null ? null : JSON.stringify(input.meta),
    created_at: new Date().toISOString(),
  });
  if (error) channelTableMissing = true;
}

async function lastConversationFor(channel: string, peer: string): Promise<number | null> {
  const key = `${channel}:${phoneKey(peer)}`;
  if (conversationByPeer.has(key)) return conversationByPeer.get(key)!;
  if (channelTableMissing) return null;
  const { data, error } = await supabase.from('channel_messages')
    .select('conversation_id').eq('channel', channel).eq('peer', phoneKey(peer))
    .not('conversation_id', 'is', null)
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (error) { channelTableMissing = true; return null; }
  const id = data?.conversation_id == null ? null : Number(data.conversation_id);
  if (id) conversationByPeer.set(key, id);
  return id;
}

// ── Pipeline dispatch (same durable workflow as the web copilot) ─────
interface TurnResult {
  reply: string;
  conversation_id?: number;
  actions?: unknown[];
  status?: string;
}

async function runChatTurn(
  customerId: number,
  conversationId: number | null,
  message: string,
  channel: { kind: string; peer: string; trusted: boolean },
): Promise<TurnResult> {
  const res = await fetch(`${config.appBaseUrl}/workflows/chat-turn?wait=result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId,
      conversation_id: conversationId ?? undefined,
      message,
      channel,
    }),
  });
  if (!res.ok) throw new Error(`chat-turn dispatch failed: HTTP ${res.status}`);
  const body = await res.json() as { result: TurnResult | null };
  if (!body.result?.reply) throw new Error('chat-turn returned no reply');
  return body.result;
}

const UNMATCHED_REPLY =
  'Namaste! This is Kriya, your card assistant. I could not match this number to a card account. '
  + 'Please message from your registered mobile number, or contact your bank to update your contact details.';

// Distinct from UNMATCHED_REPLY: the card account WAS found, but provisioning the
// local profile failed (e.g. a pending DB migration). Never tell a real customer
// their number isn't registered when the account actually exists.
const SETUP_FAILED_REPLY =
  'Namaste! I found your card account but could not finish setting up your profile just now. '
  + 'This is a temporary issue on our side — please try again in a few minutes.';

export interface HermesOutcome {
  matched: boolean;
  deduped?: boolean;
  customer_id?: number;
  customer_name?: string;
  conversation_id?: number;
  reply: string;
  actions?: unknown[];
  status?: string;
  delivery?: { ok: boolean; error?: string };
}

/**
 * Handle one inbound channel message end-to-end. `deliver=false` lets the
 * simulator render the reply itself instead of sending through the adapter.
 */
export async function handleInbound(
  msg: InboundChannelMessage,
  adapter: ChannelAdapter | null,
): Promise<HermesOutcome> {
  if (await alreadyProcessed(msg)) {
    return { matched: false, deduped: true, reply: '' };
  }

  // Records on file first (cheap), then the provider API: an unknown number
  // with a live card account gets provisioned on the spot.
  let customer: MatchedCustomer | null;
  try {
    customer = await customerByPhone(msg.from) ?? await provisionFromLive(msg.from);
  } catch (err) {
    if (!(err instanceof ProvisioningError)) throw err;
    // Account exists but local setup failed — surface a setup error, not "unmatched".
    console.error(`[hermes] provisioning failed for ${msg.channel} ${phoneKey(msg.from).slice(-4)}:`, err.message);
    await recordMessage({
      channel: msg.channel, direction: 'inbound', peer: msg.from,
      customerId: null, conversationId: null,
      providerMessageId: msg.providerMessageId, body: msg.text,
      meta: { profile_name: msg.profileName, matched: false, provisioning_error: err.message },
    });
    const delivery = adapter ? await adapter.sendText(msg.from, SETUP_FAILED_REPLY) : undefined;
    return { matched: false, reply: SETUP_FAILED_REPLY, delivery };
  }

  if (!customer) {
    await recordMessage({
      channel: msg.channel, direction: 'inbound', peer: msg.from,
      customerId: null, conversationId: null,
      providerMessageId: msg.providerMessageId, body: msg.text,
      meta: { profile_name: msg.profileName, matched: false },
    });
    const delivery = adapter ? await adapter.sendText(msg.from, UNMATCHED_REPLY) : undefined;
    return { matched: false, reply: UNMATCHED_REPLY, delivery };
  }

  const conversationId = await lastConversationFor(msg.channel, msg.from);
  lastChannelByCustomer.set(customer.id, { channel: msg.channel, peer: phoneKey(msg.from) || msg.from });
  await recordMessage({
    channel: msg.channel, direction: 'inbound', peer: msg.from,
    customerId: customer.id, conversationId,
    providerMessageId: msg.providerMessageId, body: msg.text,
    meta: { profile_name: msg.profileName },
  });

  // Possession factor: a real adapter means the message arrived through a
  // verified provider webhook bound to the registered number. The simulator
  // (adapter=null) simulates that trust for dev flows.
  const turn = await runChatTurn(customer.id, conversationId, msg.text, {
    kind: msg.channel,
    peer: phoneKey(msg.from),
    trusted: true,
  });
  const newConversationId = turn.conversation_id ?? conversationId ?? null;
  if (newConversationId) {
    conversationByPeer.set(`${msg.channel}:${phoneKey(msg.from)}`, newConversationId);
  }

  const delivery = adapter ? await adapter.sendText(msg.from, turn.reply) : undefined;
  await recordMessage({
    channel: msg.channel, direction: 'outbound', peer: msg.from,
    customerId: customer.id, conversationId: newConversationId,
    providerMessageId: delivery?.providerMessageId ?? null, body: turn.reply,
    meta: { actions: turn.actions ?? [], status: turn.status, delivered: delivery?.ok ?? null },
  });

  return {
    matched: true,
    customer_id: customer.id,
    customer_name: customer.name,
    conversation_id: newConversationId ?? undefined,
    reply: turn.reply,
    actions: turn.actions,
    status: turn.status,
    delivery,
  };
}

// ── Telegram durable binding (survives restart) ───────────────────────
// The Telegram adapter learns phone<->chat_id from a contact share, but that map
// is in-memory. Proactive alerts route by phone from the durable channel_messages
// table, so after a restart the chat_id is gone and a fraud/transaction alert
// would silently fail to deliver. We persist the chat_id in channel_messages.meta
// on the contact share and rehydrate the map before a proactive Telegram send.

/** Persist a Telegram phone<->chat_id binding (called on contact share) so the
 *  in-memory map can be rebuilt after a restart. Best-effort, never throws. */
export async function rememberTelegramContact(
  phone: string,
  chatId: string,
  profileName?: string,
): Promise<void> {
  rememberTelegramBinding(phone, chatId); // bind in-memory now
  const customer = await customerByPhone(phone).catch(() => null);
  await recordMessage({
    channel: 'telegram', direction: 'inbound', peer: phone,
    customerId: customer?.id ?? null, conversationId: null,
    providerMessageId: null, body: '',
    meta: { event: 'contact', telegram_chat_id: chatId, profile_name: profileName },
  });
}

/** Rebuild the in-memory Telegram chat_id for a phone from the most recent
 *  persisted contact binding, so proactive sends work after a restart. */
async function rehydrateTelegramBinding(peer: string): Promise<void> {
  if (channelTableMissing) return;
  const { data, error } = await supabase.from('channel_messages')
    .select('meta').eq('channel', 'telegram').eq('peer', phoneKey(peer))
    .order('id', { ascending: false }).limit(25);
  if (error) { channelTableMissing = true; return; }
  for (const row of (data ?? []) as { meta: unknown }[]) {
    let chatId: unknown;
    try {
      const m = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta;
      chatId = m?.telegram_chat_id;
    } catch { /* ignore malformed meta */ }
    if (chatId) { rememberTelegramBinding(peer, String(chatId)); return; }
  }
}

// ── Proactive outbound (provider events → customer's channel) ──────────

/** Resolve the channel + peer to reach a customer on: in-memory last channel
 *  first, then the most recent inbound row in channel_messages. */
async function routeFor(customerId: number): Promise<{ channel: ChannelKind; peer: string } | null> {
  const cached = lastChannelByCustomer.get(customerId);
  if (cached) return cached;
  if (channelTableMissing) return null;
  const { data, error } = await supabase.from('channel_messages')
    .select('channel,peer').eq('customer_id', customerId).eq('direction', 'inbound')
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (error) { channelTableMissing = true; return null; }
  if (!data?.channel || !data?.peer) return null;
  const route = { channel: data.channel as ChannelKind, peer: String(data.peer) };
  lastChannelByCustomer.set(customerId, route);
  return route;
}

export interface NotifyOutcome {
  delivered: boolean;
  channel?: ChannelKind;
  reason?: string;
}

/**
 * Send a proactive message to a customer on their last-used channel. Used by
 * the provider webhook receiver to push transaction/fraud/payment alerts.
 * No-op (delivered=false) when we don't know where to reach them or the
 * channel's adapter isn't configured — never throws into the webhook path.
 */
export async function notifyCustomer(
  customerId: number,
  text: string,
  meta?: Record<string, unknown>,
): Promise<NotifyOutcome> {
  const route = await routeFor(customerId);
  if (!route) return { delivered: false, reason: 'No known channel for this customer.' };
  const adapter = ADAPTERS[route.channel];
  if (!adapter || !adapter.configured) {
    return { delivered: false, channel: route.channel, reason: `Channel ${route.channel} has no configured outbound adapter.` };
  }
  // Telegram routes by phone but sends by chat_id; rebuild the binding from the
  // durable store in case this process restarted since the customer linked.
  if (route.channel === 'telegram') await rehydrateTelegramBinding(route.peer);
  const delivery = await adapter.sendText(route.peer, text);
  await recordMessage({
    channel: route.channel, direction: 'outbound', peer: route.peer,
    customerId, conversationId: null,
    providerMessageId: delivery.providerMessageId ?? null, body: text,
    meta: { proactive: true, ...meta, delivered: delivery.ok, error: delivery.error },
  });
  return { delivered: delivery.ok, channel: route.channel, reason: delivery.error };
}

// Hermes dispatcher: maps inbound channel messages to the Flue workflow, persists messages, and routes replies.
import { supabase } from '../database/client.ts';
import { config } from '../config/env.ts';
import { createCustomerFromLive, ProvisioningError } from '../database/queries.ts';
import { hyperfaceProvider } from '../providers/hyperface.ts';
import { invalidateLiveBinding } from '../services/provider-tools.ts';
import { phoneKey } from './types.ts';
import type { ChannelAdapter, ChannelKind, InboundChannelMessage } from './types.ts';
import { telegramAdapter, rememberContact as rememberTelegramBinding } from './telegram.ts';

// Outbound adapter registry for proactive delivery.
const ADAPTERS: Partial<Record<ChannelKind, ChannelAdapter>> = {
  telegram: telegramAdapter,
};

interface MatchedCustomer {
  id: number;
  name: string;
  phone: string;
  card_number_last4: string;
}

// Match customer by last 10 digits of phone (60s in-memory cache).
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

// Resolve registered mobile to customer ID (calls local database).
export async function customerIdByPhone(raw: string): Promise<number | null> {
  const match = await customerByPhone(raw);
  return match?.id ?? null;
}

// Web sign-in identity matching. Matches or provisions customer.
export async function identifyByPhone(raw: string): Promise<MatchedCustomer | null> {
  return (await customerByPhone(raw)) ?? (await provisionFromLive(raw));
}

// Provision local customer profile from live Hyperface provider if found.
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

// Message history and database persistence.
const seenProviderIds = new Set<string>();
const conversationByPeer = new Map<string, number>();
const lastChannelByCustomer = new Map<number, { channel: ChannelKind; peer: string }>();
let channelTableMissing = false;

// Check if message was already processed (in-memory & db deduplication).
async function alreadyProcessed(msg: InboundChannelMessage): Promise<boolean> {
  const memoryKey = `${msg.channel}:${msg.providerMessageId}`;
  if (seenProviderIds.has(memoryKey)) return true;
  if (!channelTableMissing) {
    const { data, error } = await supabase.from('channel_messages')
      .select('id').eq('channel', msg.channel).eq('provider_message_id', msg.providerMessageId).limit(1);
    if (error) channelTableMissing = true;
    else if ((data ?? []).length > 0) return true;
  }
  seenProviderIds.add(memoryKey);
  if (seenProviderIds.size > 5000) seenProviderIds.clear();
  return false;
}

// Log message to database.
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

// Get the last active conversation ID for a peer.
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

// Dispatch request to Flue workflow (calls POST /workflows/chat-turn?wait=result).
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

// Fallback response for database failures during provisioning.
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

// Process inbound messages end-to-end.
export async function handleInbound(
  msg: InboundChannelMessage,
  adapter: ChannelAdapter | null,
): Promise<HermesOutcome> {
  if (await alreadyProcessed(msg)) {
    return { matched: false, deduped: true, reply: '' };
  }

  // Lookup in database first, then fall back to live Hyperface provider.
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

/** Persist Telegram binding for rehydration */
export async function rememberTelegramContact(
  phone: string,
  chatId: string,
  profileName?: string,
): Promise<void> {
  rememberTelegramBinding(phone, chatId);
  const customer = await customerByPhone(phone).catch(() => null);
  await recordMessage({
    channel: 'telegram', direction: 'inbound', peer: phone,
    customerId: customer?.id ?? null, conversationId: null,
    providerMessageId: null, body: '',
    meta: { event: 'contact', telegram_chat_id: chatId, profile_name: profileName },
  });
}

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
    } catch { /* ignore */ }
    if (chatId) { rememberTelegramBinding(peer, String(chatId)); return; }
  }
}

// Route proactive alerts to customer channel
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

// Send a proactive message (transaction, payment, fraud alerts) to the customer on their last-used channel.
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
  // Re-learn Telegram chat ID binding if process restarted.
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

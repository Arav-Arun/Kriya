// Kriya HTTP surface: the Connect page, the web chat, the chat business API,
// the channel webhooks (WhatsApp / Telegram / OpenClaw / Hyperface), voice (Sarvam), and
// the Flue mount (workflow dispatch + run event streams). Routing only — all
// analysis lives in the agents/services. Customer data goes through
// src/database/queries.ts (Supabase) and, for phone-linked customers, live
// through the card provider (src/providers/hyperface.ts).
import { Hono } from 'hono';
import { flue } from '@flue/runtime/routing';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCustomer, getPaymentSummary,
  createConversation, listConversations, getConversation, getMessages, addMessage,
  renameConversation, deleteConversation, addAttachment,
  listCustomerEscalations, getDisputes, getTransactions, getFeesAndCharges,
  getSubscriptions, setCardControl, setAutopay, toggleInternational,
  logAction, getCustomerActionsLog,
} from './database/queries.ts';
import {
  SUPPORTED_UPLOAD_MIMES, normalizeMimeType, analyzeUpload,
} from './services/attachments.ts';
import { evidenceStorage } from './services/storage.ts';
import { config, enforceHostedGuardrails, updateTelegramConfig } from './config/env.ts';
import { transcribe, synthesize, voiceEnabled } from './services/voice.ts';
import { telegramAdapter, verifyTelegramSecret, parseTelegramUpdate, requestContact } from './channels/telegram.ts';
import { handleInbound, notifyCustomer, customerIdByPhone, identifyByPhone, rememberTelegramContact } from './channels/hermes.ts';
import { hyperfaceProvider } from './providers/hyperface.ts';
import { linkedLiveSummary } from './services/provider-tools.ts';
import {
  WEBHOOK_SECRET_HEADER, verifyWebhookSecret, parseHyperfaceEvent, alreadySeenEvent,
  shouldNotify, mobileForAccount, notificationText,
} from './providers/hyperface-webhooks.ts';

enforceHostedGuardrails();

import type { Customer } from './database/queries.ts';

const app = new Hono();
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui');
const ROOT = process.cwd();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function serveFile(file: string) {
  const full = path.join(UI_DIR, file);
  if (!full.startsWith(UI_DIR)) return null;
  try {
    const body = readFileSync(full);
    return new Response(new Uint8Array(body), {
      headers: { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' },
    });
  } catch {
    return null;
  }
}

// ── Pages ─────────────────────────────────────────────────────────────
// The Connect page (how to add Kriya to channels) and the web chat. That's
// the whole front end: everything else is API.
app.get('/', (c) => serveFile('start.html') ?? c.notFound());
app.get('/chat', (c) => serveFile('portal/chat.html') ?? c.notFound());

app.get('/assets/*', (c) => {
  const filePath = c.req.path.replace(/^\/assets\//, '');
  return serveFile(filePath) ?? c.notFound();
});

let cachedBotUsername: string | null = null;

async function getTelegramBotUsername(): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  if (!config.telegram.botToken) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getMe`);
    const data = await res.json() as any;
    if (data?.ok && data?.result?.username) {
      cachedBotUsername = data.result.username;
      return cachedBotUsername;
    }
  } catch (err) {
    console.error('[telegram] failed to fetch bot info:', err);
  }
  return null;
}

// Public config for the web surfaces: which channels are live, the demo
// sign-in number (if any), and whether voice is available.
app.get('/api/web/config', async (c) => c.json({
  app_base_url: config.appBaseUrl,
  demo_phone: config.demoPhone ?? null,
  voice_enabled: voiceEnabled(),
  channels: {
    telegram: telegramAdapter.configured,
    hyperface: config.providerMode === 'hyperface_uat' && hyperfaceProvider.configured,
  },
  telegram_username: await getTelegramBotUsername(),
}));

// ── Customers ─────────────────────────────────────────────────────────
function publicCustomer(c: Customer) {
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone,
    card_last4: c.card_number_last4,
    card_status: c.card_status, cibil_score: c.cibil_score,
    outstanding_total: c.outstanding_total,
  };
}

// Web chat sign-in: identify the caller by their registered mobile number,
// provisioning a live-linked customer from the card provider on first contact.
// No segment picker, no seed customers — the account is real (or it 404s).
app.post('/api/identify', async (c) => {
  const body = await c.req.json().catch(() => null) as { phone?: string } | null;
  const phone = String(body?.phone ?? '').replace(/\D/g, '');
  if (phone.length < 10) return c.json({ error: 'Enter a valid mobile number.' }, 400);
  const match = await identifyByPhone(phone);
  if (!match) {
    return c.json({
      error: "We couldn't find a card account for this number. Use the mobile number registered with your card.",
    }, 404);
  }
  const customer = await getCustomer(match.id);
  return customer ? c.json(publicCustomer(customer)) : c.json({ error: 'Account lookup failed.' }, 500);
});

app.get('/api/customer/:id/profile', async (c) => {
  const customer = await getCustomer(Number(c.req.param('id')));
  if (!customer) return c.json({ error: 'Not found' }, 404);
  // Phone-linked customers read balance/limits/card status straight from the
  // card system of record; everyone else stays on records on file.
  const live = await linkedLiveSummary(customer.id);
  return c.json({
    id: customer.id, name: customer.name,
    source: live ? 'live_provider' : 'records_on_file',
    card_status: live
      ? (live.primaryCard?.isHotlisted ? 'hotlisted'
        : live.primaryCard?.isLocked ? 'blocked'
        : String(live.primaryCard?.cardStatus ?? customer.card_status).toLowerCase())
      : customer.card_status,
    card_last4: customer.card_number_last4,
    card_variant: customer.card_variant,
    credit_limit: live ? live.account.approvedCreditLimit : customer.credit_limit,
    available_limit: live ? live.account.availableCreditLimit : customer.available_limit,
    outstanding_total: live ? live.account.currentBalance : customer.outstanding_total,
    minimum_due: customer.minimum_due,
    due_date: customer.due_date, reward_points: customer.reward_points_balance,
    cibil_score: customer.cibil_score, kyc_status: customer.kyc_status,
    international_enabled: customer.international_enabled === 1,
    online_enabled: customer.online_enabled === 1,
    pos_enabled: customer.pos_enabled === 1,
    contactless_enabled: customer.contactless_enabled === 1,
    atm_enabled: customer.atm_enabled === 1,
    autopay_enabled: customer.autopay_enabled === 1,
    autopay_mode: customer.autopay_mode,
    payment_summary: await getPaymentSummary(customer.id),
  });
});

app.get('/api/customer/:id/transactions', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await getTransactions(customerId, { limit: 40 }));
});

app.get('/api/customer/:id/fees', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await getFeesAndCharges(customerId, 40));
});

app.get('/api/customer/:id/subscriptions', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await getSubscriptions(customerId));
});

app.get('/api/customer/:id/actions', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await getCustomerActionsLog(customerId));
});

app.get('/api/customer/:id/escalations', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await listCustomerEscalations(customerId));
});

app.post('/api/customer/:id/controls', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => null) as { control: string; enabled: boolean; mode?: string } | null;
  if (!body) return c.json({ error: 'Body required' }, 400);

  const { control, enabled, mode } = body;
  if (control === 'international') {
    await toggleInternational(customerId, enabled);
    await logAction({
      customer_id: customerId,
      action_type: 'international_toggled',
      action_detail: { enabled },
      policy_reference: 'Card Controls Config'
    });
  } else if (control === 'autopay') {
    await setAutopay(customerId, enabled, mode || 'total_due');
    await logAction({
      customer_id: customerId,
      action_type: 'autopay_updated',
      action_detail: { enabled, mode: mode || 'total_due' },
      policy_reference: 'Autopay Settings'
    });
  } else {
    const ok = await setCardControl(customerId, control, enabled);
    if (!ok) return c.json({ error: 'Invalid control' }, 400);
    await logAction({
      customer_id: customerId,
      action_type: 'card_control_updated',
      action_detail: { control, enabled },
      policy_reference: 'Card Controls Config'
    });
  }
  return c.json({ success: true });
});

// ── Resolution records (disputes / chargebacks) ───────────────────────
app.get('/api/customer/:id/disputes', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await getDisputes(customerId, 20));
});

// ── Conversations ─────────────────────────────────────────────────────
app.get('/api/customer/:id/conversations', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await listConversations(customerId, 60));
});

app.post('/api/customer/:id/conversations', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await createConversation(customerId));
});

app.patch('/api/customer/:id/conversations/:conversationId', async (c) => {
  const customerId = Number(c.req.param('id'));
  const conversationId = Number(c.req.param('conversationId'));
  if (!(await getConversation(customerId, conversationId))) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => null) as { title?: string } | null;
  if (!(await renameConversation(customerId, conversationId, String(body?.title ?? '')))) {
    return c.json({ error: 'Title required' }, 400);
  }
  return c.json(await getConversation(customerId, conversationId));
});

app.delete('/api/customer/:id/conversations/:conversationId', async (c) => {
  const customerId = Number(c.req.param('id'));
  const conversationId = Number(c.req.param('conversationId'));
  return (await deleteConversation(customerId, conversationId))
    ? c.json({ deleted: true })
    : c.json({ error: 'Not found' }, 404);
});

app.get('/api/customer/:id/conversations/:conversationId/messages', async (c) => {
  const customerId = Number(c.req.param('id'));
  const conversationId = Number(c.req.param('conversationId'));
  if (!(await getConversation(customerId, conversationId))) return c.json({ error: 'Not found' }, 404);
  const rows = await getMessages(customerId, 300, conversationId) as any[];
  return c.json(rows.map((m) => ({
    role: m.role,
    content: m.content,
    meta: m.meta ? JSON.parse(m.meta) : null,
    created_at: m.created_at,
  })));
});

app.post('/api/customer/:id/conversations/:conversationId/messages', async (c) => {
  const customerId = Number(c.req.param('id'));
  const conversationId = Number(c.req.param('conversationId'));
  if (!(await getConversation(customerId, conversationId))) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => null) as { content?: string } | null;
  if (!body?.content) return c.json({ error: 'Content required' }, 400);

  const meta = { source: 'operator' };
  const activeConversationId = await addMessage(customerId, 'assistant', String(body.content), meta, conversationId);
  return c.json({ success: true, conversation_id: activeConversationId });
});

// ── Uploads (statements and evidence) ─────────────────────────────────
app.post('/api/customer/:id/attachments', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const filename = String(body?.filename ?? 'upload').trim().slice(0, 120) || 'upload';
  const dataUrl = String(body?.data_url ?? '');
  const match = dataUrl.match(/^data:([^;,]*)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) return c.json({ error: 'Upload a PDF, CSV, TXT, PNG, JPG, or WEBP file.' }, 400);

  const mimeType = normalizeMimeType(match[1] || String(body?.mime_type ?? ''), filename);
  if (!SUPPORTED_UPLOAD_MIMES.has(mimeType)) {
    return c.json({ error: 'Upload a statement or evidence file: PDF, CSV, TXT, PNG, JPG, or WEBP.' }, 400);
  }
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (bytes.length > 10 * 1024 * 1024) return c.json({ error: 'File must be under 10 MB.' }, 400);

  const { storagePath } = await evidenceStorage(ROOT).put(filename, mimeType, bytes);
  const { attachmentType, analysis } = await analyzeUpload(dataUrl, filename, mimeType, bytes);
  const id = await addAttachment({
    customer_id: customerId, filename, mime_type: mimeType,
    byte_size: bytes.length, storage_path: storagePath,
    attachment_type: attachmentType, analysis,
  });

  const label = attachmentType === 'statement' ? 'statement' : 'evidence';
  await addMessage(
    customerId, 'user',
    `Uploaded ${label}: ${filename}\nWhat it shows: ${analysis}`,
    { attachment_id: id, attachment_type: attachmentType, filename },
    Number(body?.conversation_id ?? 0) || undefined,
  );

  return c.json({ id, filename, attachment_type: attachmentType, analysis });
});

// ── Voice (Sarvam STT/TTS) — the chat's voice mode ────────────────────
// Transcribe a recorded clip → text the chat sends as a turn.
app.post('/api/voice/transcribe', async (c) => {
  if (!voiceEnabled()) return c.json({ error: 'Voice is not configured.' }, 503);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('audio');
  if (!(file instanceof File)) return c.json({ error: 'audio file required' }, 400);
  if (file.size === 0) return c.json({ error: 'Empty recording.' }, 400);
  if (file.size > 12 * 1024 * 1024) return c.json({ error: 'Recording too large.' }, 413);
  try {
    const { transcript, languageCode } = await transcribe(file, file.name || 'audio.webm');
    return c.json({ transcript, language_code: languageCode });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[voice] transcribe failed:', msg);
    // Surface a short, safe reason so a recurring failure is diagnosable from
    // the UI instead of a blank "could not transcribe". voice.ts throws
    // "Sarvam STT <status>: <detail>" on a non-2xx response.
    const status = msg.match(/Sarvam STT (\d{3})/)?.[1];
    const hint = status === '401' || status === '403'
      ? 'the voice service rejected the request (check SARVAM_API_KEY)'
      : status === '400'
        ? 'the voice service rejected the audio (format or model)'
        : status
          ? `the voice service returned an error (${status})`
          : 'could not reach the voice service';
    return c.json({ error: `Could not transcribe the recording — ${hint}.` }, 502);
  }
});

// Synthesize an assistant reply → base64 WAV clips the chat plays back.
app.post('/api/voice/speak', async (c) => {
  if (!voiceEnabled()) return c.json({ error: 'Voice is not configured.' }, 503);
  const body = await c.req.json().catch(() => null) as { text?: string; language_code?: string } | null;
  const text = String(body?.text ?? '').trim();
  if (!text) return c.json({ error: 'text required' }, 400);
  try {
    const audios = await synthesize(text.slice(0, 6000), body?.language_code);
    return c.json({ audios });
  } catch (err) {
    console.error('[voice] speak failed:', err);
    return c.json({ error: 'Could not synthesize speech.' }, 502);
  }
});

// ── Channel webhooks (Hermes) ─────────────────────────────────────────


// Telegram Bot API: a single webhook receives every Update. Auth is the secret
// token echoed in the X-Telegram-Bot-Api-Secret-Token header (set at
// setWebhook time). ACK fast; Hermes processes text asynchronously. An
// unrecognised chat is first asked to share its registered number — Hermes is
// phone-keyed, so identity comes from the (Telegram-verified) shared contact.
app.post('/api/channels/telegram/webhook', async (c) => {
  if (!telegramAdapter.configured) return c.json({ ok: true }); // ignore until configured
  if (!verifyTelegramSecret(c.req.header('x-telegram-bot-api-secret-token'))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = body ? parseTelegramUpdate(body) : null;
  if (!parsed) return c.json({ ok: true }); // non-text/non-contact update — ACK

  if (parsed.kind === 'contact') {
    // Persist the binding so proactive alerts survive a restart, then welcome.
    // Both are fire-and-forget so a slow Telegram API call can't delay the ACK
    // and trigger a webhook retry.
    void rememberTelegramContact(parsed.phone, parsed.chatId, parsed.profileName)
      .catch((err) => console.error('[telegram] persist contact failed:', err));
    void telegramAdapter.sendText(
      parsed.phone,
      "Thanks — you're connected. Ask me anything about your card: balance, transactions, EMIs, rewards, or blocking your card if it's lost.",
    ).catch((err) => console.error('[telegram] welcome failed:', err));
    return c.json({ ok: true });
  }

  if (!parsed.identified) {
    // Fire-and-forget (requestContact self-throttles) so the ACK is immediate.
    void requestContact(parsed.chatId).catch((err) => console.error('[telegram] contact prompt failed:', err));
    return c.json({ ok: true });
  }

  handleInbound(
    {
      channel: 'telegram',
      from: parsed.from,
      text: parsed.text,
      profileName: parsed.profileName,
      providerMessageId: parsed.messageId,
      timestamp: parsed.timestamp,
    },
    telegramAdapter,
  ).catch((err) => console.error('[hermes] telegram inbound processing failed:', err));
  return c.json({ ok: true });
});

app.post('/api/channels/telegram/setup', async (c) => {
  const body = await c.req.json().catch(() => null) as { bot_token?: string } | null;
  const botToken = String(body?.bot_token ?? '').trim();
  if (!botToken) {
    return c.json({ error: 'Please enter a valid Telegram Bot Token.' }, 400);
  }

  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = await meRes.json() as any;
    if (!meRes.ok || !meData?.ok || !meData?.result?.username) {
      return c.json({ error: `Invalid Bot Token: ${meData?.description ?? 'Connection failed'}` }, 400);
    }
    const username = meData.result.username;

    // Use existing webhook secret or generate one
    const webhookSecret = config.telegram.webhookSecret || crypto.randomUUID().replace(/-/g, '');

    // Register Webhook URL with Telegram
    const webhookUrl = `${config.appBaseUrl}/api/channels/telegram/webhook`;
    const whRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
      }),
    });
    const whData = await whRes.json() as any;
    if (!whRes.ok || !whData?.ok) {
      return c.json({ error: `Failed to set webhook: ${whData?.description ?? 'Telegram API error'}` }, 400);
    }

    // Persist to env and update memory
    updateTelegramConfig(botToken, webhookSecret);
    cachedBotUsername = username;

    return c.json({ ok: true, username });
  } catch (err: any) {
    return c.json({ error: `Setup failed: ${err.message || err}` }, 500);
  }
});


// ── Hyperface provider event webhooks ─────────────────────────────────
// Inbound provider events (transaction posted, payment received, fraud flag).
// Auth is the custom secret header we registered at subscribe time — Hyperface
// ships no built-in signature. ACK fast; resolve + notify asynchronously.
async function processHyperfaceEvent(raw: unknown): Promise<void> {
  const ev = parseHyperfaceEvent(raw);
  if (!ev) return;
  if (alreadySeenEvent(ev.eventId)) return;

  // Route ACCOUNT-scoped events to a Kriya customer via the registered mobile
  // number on the account (accountSummary is a permitted live read today).
  let customerId: number | null = null;
  if (ev.scope === 'ACCOUNT' && ev.scopeId) {
    const mobile = await mobileForAccount(ev.scopeId);
    if (mobile) customerId = await customerIdByPhone(mobile);
  }

  if (customerId) {
    await logAction({
      customer_id: customerId,
      action_type: 'provider_event',
      action_detail: { event_type: ev.eventType, scope: ev.scope, scope_id: ev.scopeId, event_id: ev.eventId },
      policy_reference: 'Hyperface webhook',
    });
    if (shouldNotify(ev.eventType)) {
      const outcome = await notifyCustomer(customerId, notificationText(ev), {
        event_type: ev.eventType, event_id: ev.eventId,
      });
      if (!outcome.delivered) {
        console.warn(`[hyperface-webhook] ${ev.eventType} not delivered to customer ${customerId}: ${outcome.reason ?? ''}`);
      }
    }
  } else {
    console.log(`[hyperface-webhook] ${ev.eventType} (${ev.scope}:${ev.scopeId}) — no matching Kriya customer`);
  }
}

app.post('/api/providers/hyperface/webhook', async (c) => {
  if (!verifyWebhookSecret(c.req.header(WEBHOOK_SECRET_HEADER))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const raw = await c.req.text();
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  // Process in the background so provider retries see a fast 2xx ACK.
  processHyperfaceEvent(body).catch((err) => {
    console.error('[hyperface-webhook] processing failed:', err);
  });
  return c.json({ received: true });
});

// Subscribe Kriya's webhook receiver to a provider event, registering our
// shared secret as the delivery-auth header. scope_id is the account/card id.
app.post('/api/providers/hyperface/webhook/subscribe', async (c) => {
  if (config.providerMode !== 'hyperface_uat' || !hyperfaceProvider.configured) {
    return c.json({ error: 'Hyperface provider mode is not enabled.' }, 503);
  }
  if (!config.hyperface.webhookSecret) {
    return c.json({ error: 'Set HYPERFACE_WEBHOOK_SECRET before subscribing (it authenticates deliveries).' }, 400);
  }
  const body = await c.req.json().catch(() => null) as
    { event_type?: string; scope?: string; scope_id?: string; endpoint?: string } | null;
  if (!body?.event_type || !body?.scope_id) {
    return c.json({ error: 'event_type and scope_id are required' }, 400);
  }
  const endpoint = body.endpoint || `${config.appBaseUrl}/api/providers/hyperface/webhook`;
  const res = await hyperfaceProvider.webhookSubscribe({
    eventType: String(body.event_type),
    scope: String(body.scope ?? 'ACCOUNT').toUpperCase(),
    scopeId: String(body.scope_id),
    endpoint,
    headers: { [WEBHOOK_SECRET_HEADER]: config.hyperface.webhookSecret },
  });
  return res.ok
    ? c.json({ subscribed: true, endpoint, data: res.data })
    : c.json({ subscribed: false, code: res.code, message: res.message }, 502);
});

app.get('/api/providers/hyperface/webhook/subscriptions', async (c) => {
  if (config.providerMode !== 'hyperface_uat' || !hyperfaceProvider.configured) {
    return c.json({ error: 'Hyperface provider mode is not enabled.' }, 503);
  }
  const scope = String(c.req.query('scope') ?? 'ACCOUNT').toUpperCase();
  const scopeId = String(c.req.query('scope_id') ?? '');
  if (!scopeId) return c.json({ error: 'scope_id query param is required' }, 400);
  const res = await hyperfaceProvider.webhookFetchSubscriptions({ scope, scopeId });
  return res.ok ? c.json(res.data) : c.json({ code: res.code, message: res.message }, 502);
});

// ── Flue (workflow dispatch + durable run streams) ────────────────────
app.route('/', flue());

export default app;

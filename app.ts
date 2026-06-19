// Kriya HTTP surface: the Connect page, the web chat, the chat business API,
// the channel webhooks (Telegram / Hyperface), voice (Sarvam), and
// the Flue mount (workflow dispatch + run event streams). Routing only — all
// analysis lives in the agents/services. Customer data goes through
// database/queries.ts (Supabase) and, for phone-linked customers, live
// through the card provider (providers/hyperface.ts).
import { Hono } from 'hono';
import { flue } from '@flue/runtime/routing';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// imports from core/queries.ts
import {
  getCustomer,
  createConversation, listConversations, getConversation, getMessages,
  renameConversation, deleteConversation,
  getDisputes, getTransactions,
  getCustomerActionsLog, ProvisioningError,
  resolveEscalation,
} from './core/queries.ts';

// app.ts pulls in the DB layer, the env config, voice, both channel adapters, and the card provider. That's literally every subsystem, because app.ts is where they all connect to the outside world."
import { supabase } from './core/supabase.ts';
import { config, enforceHostedGuardrails, updateTelegramConfig } from './core/env.ts';
import { transcribe, synthesize, voiceEnabled } from './services/voice.ts';
import { telegramAdapter, verifyTelegramSecret, parseTelegramUpdate, requestContact, KRIYA_TELEGRAM_HELP } from './channels/telegram.ts';
import { handleInbound, identifyByPhone, rememberTelegramContact } from './channels/hermes.ts';
import { hyperfaceProvider } from './providers/hyperface.ts';

enforceHostedGuardrails();

import type { Customer } from './core/queries.ts';

const app = new Hono();
const UI_DIR = (() => {
  const localUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), './ui');
  if (existsSync(localUi)) return localUi;
  return path.resolve(process.cwd(), './ui');
})();

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
app.get('/chat', (c) => serveFile('chat.html') ?? c.notFound());
app.get('/tickets', (c) => serveFile('tickets.html') ?? c.notFound());

app.get('/assets/*', (c) => {
  const filePath = c.req.path.replace(/^\/assets\//, '');
  return serveFile(filePath) ?? c.notFound();
});

const TELEGRAM_BOT_USERNAME = 'kriya_copilot_bot';

// Public config for the web surfaces: which channels are live, the demo
// sign-in number (if any), and whether voice is available.
app.get('/api/web/config', (c) => c.json({
  app_base_url: config.appBaseUrl,
  demo_phone: config.demoPhone ?? null,
  voice_enabled: voiceEnabled(),
  channels: {
    telegram: telegramAdapter.configured,
    hyperface: config.providerMode === 'hyperface_uat' && hyperfaceProvider.configured,
  },
  telegram_username: TELEGRAM_BOT_USERNAME,
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
  let match;
  try {
    match = await identifyByPhone(phone);
  } catch (err) {
    // The card account exists but local provisioning failed (e.g. pending DB
    // migration). Surface a setup error — never the misleading "not found".
    if (err instanceof ProvisioningError) {
      console.error('[identify] provisioning failed:', err.message);
      return c.json({
        error: "We found your card account but couldn't finish setting up your profile. "
          + "This is a setup issue on our side, not a problem with your number — please try again shortly.",
      }, 502);
    }
    throw err;
  }
  if (!match) {
    return c.json({
      error: "We couldn't find a card account for this number. Use the mobile number registered with your card.",
    }, 404);
  }
  const customer = await getCustomer(match.id);
  return customer ? c.json(publicCustomer(customer)) : c.json({ error: 'Account lookup failed.' }, 500);
});

app.get('/api/customer/:id/transactions', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await getTransactions(customerId, { limit: 40 }));
});

app.get('/api/customer/:id/actions', async (c) => {
  const customerId = Number(c.req.param('id'));
  if (!(await getCustomer(customerId))) return c.json({ error: 'Not found' }, 404);
  return c.json(await getCustomerActionsLog(customerId));
});

app.get('/api/escalations', async (c) => {
  try {
    const { data, error } = await supabase
      .from('escalations')
      .select(`
        *,
        customers (
          id,
          name,
          email,
          phone,
          card_number_last4,
          card_variant,
          card_status,
          credit_limit,
          available_limit,
          outstanding_total,
          minimum_due,
          due_date,
          cibil_score,
          kyc_status
        )
      `)
      .order('created_at', { ascending: false });
    if (error) {
      return c.json({ error: error.message }, 500);
    }
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/escalations/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { resolved_by?: string; notes?: string } | null;
  const resolvedBy = body?.resolved_by || 'Operator';
  const notes = body?.notes || '';
  
  try {
    const success = await resolveEscalation(id, resolvedBy, notes);
    if (!success) {
      return c.json({ error: 'Escalation not found or already resolved' }, 404);
    }
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
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


// Telegram Bot API: a single webhook receives every Update. Auth is the shared
// secret token Telegram echoes in the X-Telegram-Bot-Api-Secret-Token header
// (registered at setWebhook time); verifyTelegramSecret compares it in constant
// time. When no secret is configured the webhook is open in local dev but
// rejected once deployed — and enforceHostedGuardrails refuses to boot a
// deployed instance without one. ACK fast; Hermes processes text asynchronously.
// An unrecognised chat is first asked to share its registered number — Hermes is
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
    // Record the shared contact, then welcome. Both are fire-and-forget so a
    // slow Telegram API call can't delay the ACK and trigger a webhook retry.
    void rememberTelegramContact(parsed.phone, parsed.chatId, parsed.profileName)
      .catch((err) => console.error('[telegram] persist contact failed:', err));
    void telegramAdapter.sendText(
      parsed.phone,
      "Thanks — you're connected. Ask me anything about your card: balance, spending, transactions, statements, EMIs, or block your card instantly if it's lost. Type /help to see everything I can do.",
    ).catch((err) => console.error('[telegram] welcome failed:', err));
    return c.json({ ok: true });
  }

  if (!parsed.identified) {
    // Fire-and-forget (requestContact self-throttles) so the ACK is immediate.
    void requestContact(parsed.chatId).catch((err) => console.error('[telegram] contact prompt failed:', err));
    return c.json({ ok: true });
  }

  // /start and /help: answer with the capability overview directly (skip the
  // agent) so the bot has a crisp, instant command experience.
  const cmd = parsed.text.trim().toLowerCase();
  if (cmd === '/start' || cmd === '/help' || cmd === 'help') {
    void telegramAdapter.sendText(parsed.from, KRIYA_TELEGRAM_HELP)
      .catch((err) => console.error('[telegram] help reply failed:', err));
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

    // Persist to env
    updateTelegramConfig(botToken, webhookSecret);

    return c.json({ ok: true, username });
  } catch (err: any) {
    return c.json({ error: `Setup failed: ${err.message || err}` }, 500);
  }
});


// ── Flue (workflow dispatch + durable run streams) ────────────────────
app.route('/', flue());

export default app;

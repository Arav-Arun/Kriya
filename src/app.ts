// Sentinel HTTP surface: customer portal pages, the business API, and the
// Flue mount (workflow dispatch + run event streams). All analysis logic
// lives in the agents and src/lib — this file is routing only. Data access
// goes through src/lib/sentinel-db.ts, which reads/writes Supabase (async).
import { Hono } from 'hono';
import { flue } from '@flue/runtime/routing';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findCustomersForLookup, listDemoCustomers, getCustomer, getPaymentSummary,
  createConversation, listConversations, getConversation, getMessages, addMessage,
  renameConversation, deleteConversation, addAttachment,
  listEscalations, listCustomerEscalations, getEscalation, resolveEscalation,
  getDisputes, getPortfolioAnalytics, getTransactions, getFeesAndCharges,
  getSubscriptions, setCardControl, setAutopay, toggleInternational,
  logAction, getCustomerActionsLog,
} from './lib/sentinel-db.ts';
import {
  SUPPORTED_UPLOAD_MIMES, normalizeMimeType, storeUpload, analyzeUpload,
} from './lib/attachments.ts';

import type { Customer } from './lib/sentinel-db.ts';

const app = new Hono();
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui');
const ROOT = process.cwd();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
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
app.get('/', (c) => serveFile('start.html') ?? c.notFound());
app.get('/chat', (c) => serveFile('chat.html') ?? c.notFound());
app.get('/dashboard', (c) => serveFile('dashboard.html') ?? c.notFound());

app.get('/assets/:file', (c) => serveFile(c.req.param('file')) ?? c.notFound());

// ── Customers ─────────────────────────────────────────────────────────
function publicCustomer(c: Customer) {
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone,
    card_last4: c.card_number_last4, card_variant: c.card_variant,
    card_status: c.card_status, cibil_score: c.cibil_score,
    outstanding_total: c.outstanding_total,
  };
}

app.get('/api/customers/demo', async (c) => c.json((await listDemoCustomers(8)).map(publicCustomer)));

app.get('/api/customers/search', async (c) =>
  c.json((await findCustomersForLookup(c.req.query('q') ?? '', 10)).map(publicCustomer)));

app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => null) as { customer_id?: number } | null;
  const customer = await getCustomer(Number(body?.customer_id ?? 0));
  return customer ? c.json(publicCustomer(customer)) : c.json({ error: 'Customer not found' }, 404);
});

app.get('/api/customer/:id/profile', async (c) => {
  const customer = await getCustomer(Number(c.req.param('id')));
  if (!customer) return c.json({ error: 'Not found' }, 404);
  return c.json({
    id: customer.id, name: customer.name, card_variant: customer.card_variant,
    card_status: customer.card_status, card_last4: customer.card_number_last4,
    credit_limit: customer.credit_limit, available_limit: customer.available_limit,
    outstanding_total: customer.outstanding_total, minimum_due: customer.minimum_due,
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

  const storagePath = storeUpload(ROOT, filename, mimeType, bytes);
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

// ── Analytics (internal operations dashboard) ─────────────────────────
// One server-side RPC computes every figure from the database. The UI
// renders it directly — nothing is baked into the front-end.
app.get('/api/analytics', async (c) => c.json(await getPortfolioAnalytics()));

// ── Escalations (internal dashboard) ──────────────────────────────────
app.get('/api/escalations', async (c) => c.json(await listEscalations()));

app.get('/api/escalations/:id', async (c) => {
  const row = await getEscalation(c.req.param('id'));
  return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
});

app.post('/api/escalations/:id/resolve', async (c) => {
  const { resolved_by, notes } = await c.req.json();
  const ok = await resolveEscalation(c.req.param('id'), String(resolved_by ?? 'Agent'), String(notes ?? ''));
  return ok ? c.json({ status: 'resolved' }) : c.json({ error: 'Not found or already resolved' }, 404);
});



// ── Flue (workflow dispatch + durable run streams) ────────────────────
app.route('/', flue());

export default app;

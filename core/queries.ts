// All Kriya app state lives in Supabase Postgres. Every function here
// reads/writes through the supabase-js client (service role). Portfolio
// analytics, customer search, and the conversation list are server-side RPC
// functions (see migrations); the rest use the query builder, with small
// per-customer aggregations computed in JS.
import { supabase } from './supabase.ts';

// ── Small helpers ─────────────────────────────────────────────────────
async function rows<T = Record<string, unknown>>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

/**
 * Recompute the balance columns after `amount` is credited back to a customer
 * (fee waiver, refund). Returns only the figures we can honestly derive —
 * outstanding_total, outstanding_billed and available_limit move by the credited
 * amount, clamped to sane bounds. minimum_due is deliberately NOT touched here:
 * we no longer synthesise a `max(500, outstanding*5%)` placeholder for it, so it
 * keeps whatever value (including null) the row already holds.
 */
function recomputeBalanceAfterCredit(
  customer: Pick<Customer, 'outstanding_total' | 'outstanding_billed' | 'available_limit' | 'credit_limit'>,
  amount: number,
): { outstanding_total: number; outstanding_billed: number; available_limit: number } {
  const credit = Math.max(0, Math.round(Number(amount) || 0));
  const prevOutstanding = Number(customer.outstanding_total ?? 0);
  const prevAvailable = Number(customer.available_limit ?? 0);
  const prevBilled = Number(customer.outstanding_billed ?? prevOutstanding);
  return {
    outstanding_total: Math.max(prevOutstanding - credit, 0),
    outstanding_billed: Math.max(prevBilled - credit, 0),
    available_limit: Math.min(Number(customer.credit_limit ?? 0), prevAvailable + credit),
  };
}

// ── Interfaces ────────────────────────────────────────────────────────
export interface Customer {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  card_number_last4: string;
  card_variant: string;
  card_status: string;
  // No live source for the columns marked `| null`: a live-linked row stores
  // null for them rather than a fabricated placeholder (see THE NULLABLE
  // CONTRACT). Genuinely-live fields and app-state toggles stay non-null.
  card_issued_on: string | null;
  credit_limit: number;
  available_limit: number;
  outstanding_total: number;
  outstanding_billed: number;
  minimum_due: number | null;
  due_date: string | null;
  billing_cycle_day: number | null;
  cibil_score: number | null;
  risk_score: number | null;
  reward_points_balance: number | null;
  international_enabled: number;
  annual_fee: number | null;
  kyc_status: string | null;
  kyc_expiry: string | null;
  card_network: string | null;
  upi_linked: number;
  online_enabled: number;
  pos_enabled: number;
  contactless_enabled: number;
  atm_enabled: number;
  per_txn_limit: number | null;
  lounge_visits_remaining: number | null;
  lounge_visits_total: number | null;
  fuel_surcharge_waiver: number | null;
  autopay_enabled: number;
  autopay_mode: string;
}

export interface Conversation {
  id: number;
  customer_id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message?: string | null;
}

// ── Customer queries ──────────────────────────────────────────────────
export async function getCustomer(id: number): Promise<Customer | undefined> {
  const { data, error } = await supabase.from('customers').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data ?? undefined) as Customer | undefined;
}

/**
 * Raised when a customer WAS found in the live card provider but the local
 * provisioning insert failed (e.g. a schema/NOT NULL constraint, a pending
 * migration). This is deliberately distinct from "no account on this number":
 * the live account exists, so callers must surface a setup error and never the
 * misleading "we couldn't find a card account".
 */
export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

/**
 * Provision a customer row from the live card provider (identity sourced from
 * the API; the row is the chat/audit anchor, not the data source). Returns the
 * new id. Throws {@link ProvisioningError} when the insert fails (e.g. schema
 * constraint / pending migration) — the live account exists, so callers must
 * NOT treat this as "no match".
 */
export async function createCustomerFromLive(input: {
  name: string;
  phone: string;
  email?: string | null;
  card_last4?: string;
  card_status?: string;
  credit_limit?: number;
  available_limit?: number;
  outstanding_total?: number;
}): Promise<number> {
  // The seeded table has no id sequence — ids were inserted explicitly — so
  // allocate the next one ourselves (single-writer demo scale).
  const { data: maxRow, error: maxErr } = await supabase.from('customers')
    .select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  if (maxErr) {
    console.error('[queries] createCustomerFromLive failed (id allocation):', maxErr.message);
    throw new ProvisioningError(`could not allocate customer id: ${maxErr.message}`);
  }
  const nextId = Number(maxRow?.id ?? 0) + 1;
  // The Hyperface API only sources the eight live fields below (identity +
  // balances). Every other account fact (statement dates, CIBIL/risk scores,
  // rewards, KYC, card network, fee/limit config, lounge benefits) has NO live
  // source, so it is written as `null` — never a fabricated placeholder. The
  // 15 null columns require the DROP NOT NULL migration
  // (20260615120000_nullable_provisioned_columns.sql) before this insert
  // succeeds against the seed schema. The app-state toggles (controls/autopay/
  // upi) keep their off defaults; they are genuine local state, not card data.
  const { data, error } = await supabase.from('customers').insert({
    id: nextId,
    name: input.name,
    phone: input.phone,
    email: input.email ?? null,
    card_number_last4: input.card_last4 ?? '',
    card_variant: 'live-linked',
    card_status: input.card_status ?? 'active',
    card_issued_on: null,
    // Money columns are integers; live figures can be fractional.
    credit_limit: Math.round(input.credit_limit ?? 0),
    available_limit: Math.round(input.available_limit ?? 0),
    outstanding_total: Math.round(input.outstanding_total ?? 0),
    outstanding_billed: 0,
    minimum_due: null,
    due_date: null,
    billing_cycle_day: null,
    cibil_score: null,
    risk_score: null,
    reward_points_balance: null,
    international_enabled: 0,
    annual_fee: null,
    kyc_status: null,
    kyc_expiry: null,
    card_network: null,
    upi_linked: 0,
    online_enabled: 1,
    pos_enabled: 1,
    contactless_enabled: 1,
    atm_enabled: 1,
    per_txn_limit: null,
    lounge_visits_remaining: null,
    lounge_visits_total: null,
    fuel_surcharge_waiver: null,
    autopay_enabled: 0,
    autopay_mode: 'total_due',
  }).select('id').single();
  if (error) {
    console.error('[queries] createCustomerFromLive failed (insert):', error.message);
    throw new ProvisioningError(`insert failed: ${error.message}`);
  }
  return Number((data as { id: number }).id);
}

// ── Transaction queries ───────────────────────────────────────────────
export async function getTransactions(customerId: number, opts: { merchant?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  let q = supabase.from('transactions').select('*').eq('customer_id', customerId);
  if (opts.merchant) q = q.ilike('merchant', `%${opts.merchant}%`);
  return rows(q.order('timestamp', { ascending: false }).limit(limit));
}

export async function createCustomerTransaction(input: {
  customer_id: number;
  merchant: string;
  amount: number;
  timestamp?: string;
  category?: string;
  channel?: string;
  location?: string;
  status?: string;
  decline_reason?: string | null;
}) {
  const customer = await getCustomer(input.customer_id);
  if (!customer) return null;

  const merchant = String(input.merchant ?? '').trim().slice(0, 120);
  const amount = Math.round(Number(input.amount));
  if (!merchant || !Number.isFinite(amount) || amount <= 0) return null;

  const { data: maxRow } = await supabase
    .from('transactions').select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  const maxN = maxRow ? (parseInt(String(maxRow.id).slice(4), 10) || 0) : 0;
  const id = `TXN-${String(maxN + 1).padStart(6, '0')}`;
  const date = String(input.timestamp ?? '').trim();
  const parsedDate = date ? new Date(date) : null;
  const timestamp = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? parsedDate.toISOString()
    : new Date().toISOString();
  // This row records a charge the customer DESCRIBED in chat — it is not a
  // settled transaction from the ledger. Never mark it SUCCESS and never mint a
  // bank reference number: there is no real settlement behind it. The
  // REPORTED_BY_CUSTOMER status + source flag let dispute/refund/EMI tools
  // refuse to act on an unverified claim. Category is left null rather than
  // fabricated; channel/location keep honest neutral defaults.
  const status = String(input.status ?? 'REPORTED_BY_CUSTOMER').trim().toUpperCase().slice(0, 24)
    || 'REPORTED_BY_CUSTOMER';
  const categoryRaw = String(input.category ?? '').trim().slice(0, 80);
  const category = categoryRaw || null;
  const channel = String(input.channel ?? 'ONLINE').trim().slice(0, 40) || 'ONLINE';
  const location = String(input.location ?? 'ONLINE').trim().slice(0, 120) || 'ONLINE';

  const { error } = await supabase.from('transactions').insert({
    id, customer_id: input.customer_id, timestamp, merchant, category,
    amount, currency: 'INR', channel, location, status,
    decline_reason: input.decline_reason ? String(input.decline_reason).trim().slice(0, 160) : null,
    reference_no: null,
    source: 'customer_provided',
  });
  if (error) throw error;

  return {
    id, customer_id: input.customer_id, timestamp, merchant, category,
    amount, currency: 'INR', channel, location, status,
    decline_reason: input.decline_reason ?? null,
    source: 'customer_provided' as const,
  };
}

// ── Payment queries ───────────────────────────────────────────────────
export async function getPaymentHistory(customerId: number, limit = 18) {
  return rows(supabase.from('payments').select('*').eq('customer_id', customerId)
    .order('billing_month', { ascending: false }).limit(limit));
}

export async function getPaymentSummary(customerId: number) {
  const all = await rows<{ payment_status: string }>(
    supabase.from('payments').select('payment_status').eq('customer_id', customerId),
  );
  const total = all.length;
  const count = (s: string) => all.filter((r) => r.payment_status === s).length;
  const onTime = count('on_time');
  return {
    total, on_time: onTime, late: count('late'), missed: count('missed'), partial: count('partial'),
    on_time_pct: total > 0 ? Math.round((onTime / total) * 100) : 0,
  };
}

// ── Fee queries & mutations ───────────────────────────────────────────
export async function getFeesAndCharges(customerId: number, limit = 20) {
  return rows(supabase.from('fees').select('*').eq('customer_id', customerId)
    .order('charged_on', { ascending: false }).limit(limit));
}

export async function getUnwaivedFees(customerId: number) {
  return rows(supabase.from('fees').select('*').eq('customer_id', customerId).eq('waived', 0)
    .order('charged_on', { ascending: false }));
}

export async function getRecentWaivers(customerId: number, monthsBack = 12) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  return rows(supabase.from('fees').select('*').eq('customer_id', customerId).eq('waived', 1)
    .gte('waived_on', cutoff.toISOString().split('T')[0]).order('waived_on', { ascending: false }));
}

export async function waiveFee(feeId: number, reason: string) {
  const { data: fee } = await supabase.from('fees').select('*').eq('id', feeId).eq('waived', 0).maybeSingle();
  if (!fee) return { success: false, reason: 'Fee not found or already waived' };

  const customer = await getCustomer(fee.customer_id as number);
  if (!customer) return { success: false, reason: 'Customer not found' };

  const amount = Math.max(0, Math.round(Number(fee.amount ?? 0)));
  const previousOutstanding = Number(customer.outstanding_total ?? 0);
  const previousAvailable = Number(customer.available_limit ?? 0);
  const balances = recomputeBalanceAfterCredit(customer, amount);

  const { data: upd, error } = await supabase.from('fees')
    .update({ waived: 1, waived_on: new Date().toISOString(), waiver_reason: reason })
    .eq('id', feeId).eq('waived', 0).select();
  if (error) throw error;
  if (!upd || upd.length === 0) return { success: false, reason: 'Fee not found or already waived' };

  // minimum_due is intentionally left untouched — we no longer synthesise it.
  await supabase.from('customers').update(balances).eq('id', fee.customer_id);

  return {
    success: true,
    fee_id: fee.id, amount, fee_type: fee.fee_type, customer_id: fee.customer_id,
    previous_outstanding_total: previousOutstanding, new_outstanding_total: balances.outstanding_total,
    previous_available_limit: previousAvailable, new_available_limit: balances.available_limit,
  };
}

export async function updateCustomerContext(input: {
  customer_id: number;
  card_status?: string;
  international_enabled?: boolean;
  credit_limit?: number;
  available_limit?: number;
  outstanding_total?: number;
  minimum_due?: number;
  due_date?: string;
  reward_points?: number;
  cibil_score?: number;
  on_time_payments?: number;
  late_payments?: number;
  late_fee_amount?: number;
  days_late?: number;
}) {
  const customer = await getCustomer(input.customer_id);
  if (!customer) return false;

  // Everything passed here is an UNVERIFIED claim the customer made in chat, so
  // we never write it into the account-fact columns that the rest of the app
  // reads back as system-of-record truth (credit_limit, available_limit,
  // outstanding_total, minimum_due, due_date, reward_points_balance,
  // cibil_score). Doing so would let a chat claim masquerade as real data and,
  // worse, satisfy policy gates. The claim itself is preserved by the caller in
  // the audit log (action_type 'context_recorded', flagged unverified).
  //
  // We previously also (a) deleted every payment row and regenerated a synthetic
  // on-time/late history using the current outstanding as every statement
  // amount, and (b) synthesised a late-fee row. Both fabricated authoritative
  // data from chat input and have been removed — real payment/fee rows are left
  // untouched.
  //
  // The only genuine app-state toggles we still persist are card_status and
  // international_enabled (the customer turning a control on/off), which are
  // local switches rather than card-account facts.
  const upd: Record<string, string | number> = {};
  const cardStatus = String(input.card_status ?? '').trim();
  if (cardStatus) upd.card_status = cardStatus.slice(0, 120);
  if (typeof input.international_enabled === 'boolean') upd.international_enabled = input.international_enabled ? 1 : 0;

  if (Object.keys(upd).length > 0) {
    const { error } = await supabase.from('customers').update(upd).eq('id', input.customer_id);
    if (error) throw error;
  }

  return true;
}

// ── EMI queries & mutations ───────────────────────────────────────────
export async function getActiveEmis(customerId: number) {
  return rows(supabase.from('emis').select('*').eq('customer_id', customerId).eq('status', 'active')
    .order('created_on', { ascending: false }));
}

export async function foreclosEmi(emiId: string): Promise<boolean> {
  const { data, error } = await supabase.from('emis').update({ status: 'foreclosed' })
    .eq('id', emiId).eq('status', 'active').select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function createEmi(e: {
  customer_id: number; transaction_id: string; merchant: string;
  principal_amount: number; tenure_months: number; interest_rate: number;
  monthly_installment: number; processing_fee: number;
}): Promise<string> {
  const { data: maxRow } = await supabase.from('emis').select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  const maxN = maxRow ? (parseInt(String(maxRow.id).slice(4), 10) || 0) : 0;
  const id = `EMI-${String(maxN + 1).padStart(4, '0')}`;
  const { error } = await supabase.from('emis').insert({
    id, customer_id: e.customer_id, transaction_id: e.transaction_id, merchant: e.merchant,
    principal_amount: e.principal_amount, tenure_months: e.tenure_months, interest_rate: e.interest_rate,
    monthly_installment: e.monthly_installment, remaining_installments: e.tenure_months,
    processing_fee: e.processing_fee, foreclosure_charge_pct: 3, status: 'active',
    created_on: new Date().toISOString().split('T')[0],
  });
  if (error) throw error;
  return id;
}

// ── Card actions ──────────────────────────────────────────────────────
export async function updateCardStatus(customerId: number, status: string): Promise<boolean> {
  const { data, error } = await supabase.from('customers').update({ card_status: status }).eq('id', customerId).select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function toggleInternational(customerId: number, enabled: boolean): Promise<boolean> {
  const { data, error } = await supabase.from('customers').update({ international_enabled: enabled ? 1 : 0 })
    .eq('id', customerId).select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function adjustCreditLimit(customerId: number, newLimit: number): Promise<boolean> {
  const cust = await getCustomer(customerId);
  if (!cust) return false;
  const newAvailable = Math.max(newLimit - cust.outstanding_total, 0);
  const { data, error } = await supabase.from('customers').update({ credit_limit: newLimit, available_limit: newAvailable })
    .eq('id', customerId).select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}


// ── Refunds ───────────────────────────────────────────────────────────
export async function initiateRefund(transactionId: string): Promise<boolean> {
  const { data: txn } = await supabase.from('transactions').select('*').eq('id', transactionId).maybeSingle();
  if (!txn || txn.status !== 'SUCCESS') return false;
  await supabase.from('transactions').update({ status: 'REFUNDED' }).eq('id', transactionId);
  if (typeof txn.customer_id === 'number' && typeof txn.amount === 'number') {
    const c = await getCustomer(txn.customer_id);
    if (c) {
      // minimum_due is intentionally left untouched — we no longer synthesise it.
      const balances = recomputeBalanceAfterCredit(c, txn.amount as number);
      await supabase.from('customers').update(balances).eq('id', txn.customer_id);
    }
  }
  return true;
}

// ── Escalations ───────────────────────────────────────────────────────
export async function createEscalation(e: {
  customer_id: number | null;
  category: string;
  priority: string;
  assigned_team: string;
  summary: string;
  investigation: string;
  recommended_action: string;
}): Promise<string> {
  const existing = await rows<{ id: string }>(supabase.from('escalations').select('id'));
  let maxN = 999;
  for (const r of existing) {
    const n = parseInt(String(r.id).slice(4), 10);
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }
  const id = `ESC-${maxN + 1}`;
  const { error } = await supabase.from('escalations').insert({
    id, customer_id: e.customer_id, category: e.category, priority: e.priority,
    assigned_team: e.assigned_team, summary: e.summary, investigation: e.investigation,
    recommended_action: e.recommended_action, status: 'open', created_at: new Date().toISOString(),
  });
  if (error) throw error;
  return id;
}

export async function listCustomerEscalations(customerId: number) {
  return rows(supabase.from('escalations')
    .select('id,category,priority,assigned_team,summary,status,created_at,resolved_at,resolution_notes')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false }));
}

export async function resolveEscalation(id: string, resolvedBy: string, notes: string): Promise<boolean> {
  const { data, error } = await supabase.from('escalations')
    .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: resolvedBy, resolution_notes: notes })
    .eq('id', id).select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ── Actions log (audit trail) ─────────────────────────────────────────
export async function logAction(a: {
  customer_id: number;
  action_type: string;
  action_detail: unknown;
  policy_reference?: string;
}) {
  const { error } = await supabase.from('actions_log').insert({
    customer_id: a.customer_id, action_type: a.action_type,
    action_detail: a.action_detail == null ? null : JSON.stringify(a.action_detail),
    policy_reference: a.policy_reference ?? null, performed_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function getActionsSince(customerId: number, sinceIso: string) {
  return rows(supabase.from('actions_log').select('*').eq('customer_id', customerId)
    .gte('performed_at', sinceIso).order('performed_at', { ascending: true }));
}

export async function getCustomerActionsLog(customerId: number, limit = 50) {
  return rows(supabase.from('actions_log').select('*').eq('customer_id', customerId)
    .order('performed_at', { ascending: false }).limit(limit));
}

// ── Conversations and chat messages ──────────────────────────────────
function titleFromMessage(content: string) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  return (text || 'New chat').slice(0, 58);
}

export async function createConversation(customerId: number, title = 'New chat'): Promise<Conversation> {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('conversations')
    .insert({ customer_id: customerId, title: title.slice(0, 80), created_at: now, updated_at: now })
    .select().single();
  if (error) throw error;
  return data as Conversation;
}

export async function getConversation(customerId: number, conversationId: number): Promise<Conversation | undefined> {
  const { data, error } = await supabase.from('conversations').select('*')
    .eq('id', conversationId).eq('customer_id', customerId).maybeSingle();
  if (error) throw error;
  return (data ?? undefined) as Conversation | undefined;
}

export async function listConversations(customerId: number, limit = 40): Promise<Conversation[]> {
  const { data, error } = await supabase.rpc('list_conversations', { p_customer_id: customerId, lim: limit });
  if (error) throw error;
  return (data ?? []) as Conversation[];
}

export async function renameConversation(customerId: number, conversationId: number, title: string): Promise<boolean> {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return false;
  const { data, error } = await supabase.from('conversations').update({ title: clean })
    .eq('id', conversationId).eq('customer_id', customerId).select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function deleteConversation(customerId: number, conversationId: number): Promise<boolean> {
  if (!(await getConversation(customerId, conversationId))) return false;
  await supabase.from('messages').delete().eq('conversation_id', conversationId).eq('customer_id', customerId);
  const { data, error } = await supabase.from('conversations').delete()
    .eq('id', conversationId).eq('customer_id', customerId).select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function addMessage(customerId: number, role: string, content: string, meta: unknown, conversationId?: number) {
  let conversation = conversationId ? await getConversation(customerId, conversationId) : undefined;
  if (!conversation) conversation = await createConversation(customerId, role === 'user' ? titleFromMessage(content) : 'New chat');
  const createdAt = new Date().toISOString();
  await supabase.from('messages').insert({
    customer_id: customerId, conversation_id: conversation.id, role, content,
    meta: meta == null ? null : JSON.stringify(meta), created_at: createdAt,
  });
  const shouldTitle = role === 'user' && (!conversation.title || conversation.title === 'New chat');
  await supabase.from('conversations')
    .update({ title: shouldTitle ? titleFromMessage(content) : conversation.title, updated_at: createdAt })
    .eq('id', conversation.id);
  return conversation.id;
}

export async function getMessages(customerId: number, limit = 200, conversationId?: number) {
  let q = supabase.from('messages').select('*').eq('customer_id', customerId);
  if (conversationId) q = q.eq('conversation_id', conversationId);
  return rows(q.order('id', { ascending: true }).limit(limit));
}

export async function getRecentMessages(customerId: number, limit = 6, conversationId?: number) {
  let q = supabase.from('messages').select('role,content').eq('customer_id', customerId);
  if (conversationId) q = q.eq('conversation_id', conversationId);
  const result = await rows<{ role: string; content: string }>(q.order('id', { ascending: false }).limit(limit));
  return result.reverse();
}

export async function getLastAssistantMessage(customerId: number, conversationId: number): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.from('messages')
    .select('*')
    .eq('customer_id', customerId)
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as Record<string, unknown> | null;
}


// ── Statements, subscriptions, controls ───────────────────────────────
export async function getStatements(customerId: number, limit = 12) {
  return rows(supabase.from('statements').select('*').eq('customer_id', customerId)
    .order('statement_month', { ascending: false }).limit(limit));
}

export async function getSubscriptions(customerId: number) {
  const data = await rows<Record<string, unknown>>(
    supabase.from('subscriptions').select('*').eq('customer_id', customerId),
  );
  return data.sort((a, b) => {
    const sa = a.status === 'active' ? 0 : 1;
    const sb = b.status === 'active' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return Number(b.amount) - Number(a.amount);
  });
}

export async function cancelSubscription(customerId: number, subscriptionId: string) {
  const { data: sub } = await supabase.from('subscriptions').select('*')
    .eq('id', String(subscriptionId)).eq('customer_id', customerId).maybeSingle();
  if (!sub) return { success: false as const, reason: 'Subscription not found on this card' };
  if (sub.status !== 'active') return { success: false as const, reason: 'This subscription is already cancelled' };
  await supabase.from('subscriptions')
    .update({ status: 'cancelled', cancelled_on: new Date().toISOString().split('T')[0], next_charge_on: null })
    .eq('id', String(subscriptionId));
  return {
    success: true as const,
    subscription_id: String(sub.id), merchant: String(sub.merchant), plan: String(sub.plan),
    amount: Number(sub.amount), billing_cycle: String(sub.billing_cycle),
    next_charge_avoided: sub.next_charge_on ? String(sub.next_charge_on) : null,
  };
}

// ── Disputes / chargebacks ────────────────────────────────────────────
export async function getDisputes(customerId: number, limit = 20) {
  return rows(supabase.from('disputes').select('*').eq('customer_id', customerId)
    .order('raised_on', { ascending: false }).limit(limit));
}

export async function createDispute(input: {
  customer_id: number;
  transaction_id: string;
  merchant: string;
  amount: number;
  reason: string;
}): Promise<string> {
  const { data: maxRow } = await supabase.from('disputes').select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  const maxN = maxRow ? (parseInt(String(maxRow.id).slice(4), 10) || 0) : 0;
  const id = `DSP-${String(maxN + 1).padStart(4, '0')}`;
  const { error } = await supabase.from('disputes').insert({
    id, customer_id: input.customer_id, transaction_id: input.transaction_id, merchant: input.merchant,
    amount: input.amount, reason: input.reason, status: 'under_review',
    raised_on: new Date().toISOString().split('T')[0], resolved_on: null,
    provisional_credit: 0, resolution_note: 'Under review with the disputes team.',
  });
  if (error) throw error;
  return id;
}

const CONTROL_COLUMNS = new Set([
  'online_enabled', 'pos_enabled', 'contactless_enabled', 'atm_enabled', 'international_enabled',
]);

export async function setCardControl(customerId: number, control: string, enabled: boolean): Promise<boolean> {
  if (!CONTROL_COLUMNS.has(control)) return false;
  const { data, error } = await supabase.from('customers').update({ [control]: enabled ? 1 : 0 })
    .eq('id', customerId).select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function setAutopay(customerId: number, enabled: boolean, mode: string): Promise<boolean> {
  const cleanMode = mode === 'total_due' ? 'total_due' : 'minimum_due';
  const { data, error } = await supabase.from('customers')
    .update({ autopay_enabled: enabled ? 1 : 0, autopay_mode: cleanMode }).eq('id', customerId).select();
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ── Utilities ─────────────────────────────────────────────────────────
export function tokenize(text: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'was', 'were', 'this', 'that',
    'customer', 'reports', 'says', 'their', 'have', 'has', 'been', 'from', 'card',
  ]);
  return [...new Set(
    text.toLowerCase().split(/[^a-z0-9₹]+/).filter((t) => t.length > 2 && !stop.has(t)),
  )];
}

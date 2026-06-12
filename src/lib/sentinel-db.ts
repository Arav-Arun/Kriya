// All Sentinel business data lives in Supabase Postgres. Every function here
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

// ── Interfaces ────────────────────────────────────────────────────────
export interface Customer {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  card_number_last4: string;
  card_variant: string;
  card_status: string;
  card_issued_on: string;
  credit_limit: number;
  available_limit: number;
  outstanding_total: number;
  outstanding_billed: number;
  minimum_due: number;
  due_date: string;
  billing_cycle_day: number;
  cibil_score: number;
  risk_score: number;
  reward_points_balance: number;
  international_enabled: number;
  annual_fee: number;
  kyc_status: string;
  kyc_expiry: string;
  card_network: string;
  upi_linked: number;
  online_enabled: number;
  pos_enabled: number;
  contactless_enabled: number;
  atm_enabled: number;
  per_txn_limit: number;
  lounge_visits_remaining: number;
  lounge_visits_total: number;
  fuel_surcharge_waiver: number;
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

export async function findCustomersForLookup(query: string, limit = 10): Promise<Customer[]> {
  const raw = String(query ?? '').trim();
  if (!raw) return [];
  const { data, error } = await supabase.rpc('search_customers', { q: raw, lim: limit });
  if (error) throw error;
  return (data ?? []) as Customer[];
}

export async function listDemoCustomers(limit = 8): Promise<Customer[]> {
  const priorityIds = [1234, 1110, 1543, 1006];
  const [{ data: pri }, { data: rest }] = await Promise.all([
    supabase.from('customers').select('*').in('id', priorityIds),
    supabase.from('customers').select('*').order('id', { ascending: true }).limit(limit + priorityIds.length),
  ]);
  const priById = new Map((pri ?? []).map((c) => [c.id, c as Customer]));
  const result: Customer[] = [];
  const seen = new Set<number>();
  for (const id of priorityIds) {
    const c = priById.get(id);
    if (c && !seen.has(c.id)) { seen.add(c.id); result.push(c); }
  }
  for (const c of (rest ?? []) as Customer[]) {
    if (result.length >= limit) break;
    if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
  }
  return result.slice(0, limit);
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
  const status = String(input.status ?? 'SUCCESS').trim().toUpperCase().slice(0, 24) || 'SUCCESS';
  const category = String(input.category ?? 'Customer provided').trim().slice(0, 80) || 'Customer provided';
  const channel = String(input.channel ?? 'ONLINE').trim().slice(0, 40) || 'ONLINE';
  const location = String(input.location ?? 'Customer provided').trim().slice(0, 120) || 'Customer provided';
  const referenceNo = String(Math.floor(100000000000 + Math.random() * 900000000000));

  const { error } = await supabase.from('transactions').insert({
    id, customer_id: input.customer_id, timestamp, merchant, category,
    amount, currency: 'INR', channel, location, status,
    decline_reason: input.decline_reason ? String(input.decline_reason).trim().slice(0, 160) : null,
    reference_no: referenceNo,
  });
  if (error) throw error;

  return {
    id, customer_id: input.customer_id, timestamp, merchant, category,
    amount, currency: 'INR', channel, location, status,
    decline_reason: input.decline_reason ?? null,
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
  const previousMinimumDue = Number(customer.minimum_due ?? 0);
  const previousBilled = Number(customer.outstanding_billed ?? previousOutstanding);
  const newOutstanding = Math.max(previousOutstanding - amount, 0);
  const newBilled = Math.max(previousBilled - amount, 0);
  const newAvailable = Math.min(Number(customer.credit_limit ?? 0), previousAvailable + amount);
  const newMinimumDue = newOutstanding === 0 ? 0 : Math.max(500, Math.round((newOutstanding * 0.05) / 100) * 100);

  const { data: upd, error } = await supabase.from('fees')
    .update({ waived: 1, waived_on: new Date().toISOString(), waiver_reason: reason })
    .eq('id', feeId).eq('waived', 0).select();
  if (error) throw error;
  if (!upd || upd.length === 0) return { success: false, reason: 'Fee not found or already waived' };

  await supabase.from('customers').update({
    outstanding_total: newOutstanding, outstanding_billed: newBilled,
    available_limit: newAvailable, minimum_due: newMinimumDue,
  }).eq('id', fee.customer_id);

  return {
    success: true,
    fee_id: fee.id, amount, fee_type: fee.fee_type, customer_id: fee.customer_id,
    previous_outstanding_total: previousOutstanding, new_outstanding_total: newOutstanding,
    previous_available_limit: previousAvailable, new_available_limit: newAvailable,
    previous_minimum_due: previousMinimumDue, new_minimum_due: newMinimumDue,
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

  const upd: Record<string, string | number> = {};
  const setNumber = (field: string, value: number | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) upd[field] = Math.round(value);
  };
  const setText = (field: string, value: string | undefined) => {
    const text = String(value ?? '').trim();
    if (text) upd[field] = text.slice(0, 120);
  };

  setText('card_status', input.card_status);
  if (typeof input.international_enabled === 'boolean') upd.international_enabled = input.international_enabled ? 1 : 0;
  setNumber('credit_limit', input.credit_limit);
  setNumber('available_limit', input.available_limit);
  setNumber('outstanding_total', input.outstanding_total);
  setNumber('outstanding_billed', input.outstanding_total);
  setNumber('minimum_due', input.minimum_due);
  setText('due_date', input.due_date);
  setNumber('reward_points_balance', input.reward_points);
  setNumber('cibil_score', input.cibil_score);

  if (Object.keys(upd).length > 0) {
    const { error } = await supabase.from('customers').update(upd).eq('id', input.customer_id);
    if (error) throw error;
  }

  const onTime = Math.max(0, Math.round(input.on_time_payments ?? -1));
  const late = Math.max(0, Math.round(input.late_payments ?? -1));
  if (onTime >= 0 && late >= 0 && (input.on_time_payments !== undefined || input.late_payments !== undefined)) {
    const latest = (await getCustomer(input.customer_id)) ?? customer;
    await supabase.from('payments').delete().eq('customer_id', input.customer_id);
    const dueBase = latest.due_date ? new Date(`${latest.due_date}T00:00:00`) : new Date();
    const amount = latest.outstanding_total ?? 0;
    const minimum = latest.minimum_due ?? 0;
    const daysLate = Math.max(0, Math.round(input.days_late ?? 1));
    const total = onTime + late;
    const records = [];
    for (let i = 0; i < total; i++) {
      const due = new Date(dueBase);
      due.setMonth(due.getMonth() - i);
      const paid = new Date(due);
      const isLate = i < late;
      paid.setDate(paid.getDate() + (isLate ? daysLate : 0));
      records.push({
        customer_id: input.customer_id,
        billing_month: due.toISOString().slice(0, 7),
        statement_amount: amount, minimum_due: minimum, amount_paid: amount,
        paid_on: paid.toISOString().split('T')[0], due_date: due.toISOString().split('T')[0],
        days_late: isLate ? daysLate : 0, payment_status: isLate ? 'late' : 'on_time',
      });
    }
    if (records.length > 0) {
      const { error } = await supabase.from('payments').insert(records);
      if (error) throw error;
    }
  }

  if (typeof input.late_fee_amount === 'number' && Number.isFinite(input.late_fee_amount) && input.late_fee_amount > 0) {
    const latest = (await getCustomer(input.customer_id)) ?? customer;
    await supabase.from('fees').insert({
      customer_id: input.customer_id, fee_type: 'late_payment',
      amount: Math.round(input.late_fee_amount), charged_on: latest.due_date || new Date().toISOString().split('T')[0],
      waived: 0, statement_month: (latest.due_date || new Date().toISOString()).slice(0, 7),
    });
  }
  return true;
}

// ── EMI queries & mutations ───────────────────────────────────────────
export async function getActiveEmis(customerId: number) {
  return rows(supabase.from('emis').select('*').eq('customer_id', customerId).eq('status', 'active')
    .order('created_on', { ascending: false }));
}

export async function getEmi(emiId: string) {
  const { data, error } = await supabase.from('emis').select('*').eq('id', emiId).maybeSingle();
  if (error) throw error;
  return data ?? undefined;
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

export async function redeemRewards(customerId: number, points: number): Promise<boolean> {
  const cust = await getCustomer(customerId);
  if (!cust || cust.reward_points_balance < points) return false;
  const { data, error } = await supabase.from('customers')
    .update({ reward_points_balance: cust.reward_points_balance - points })
    .eq('id', customerId).gte('reward_points_balance', points).select();
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
      const amt = txn.amount as number;
      const newOutstanding = Math.max(c.outstanding_total - amt, 0);
      const newBilled = Math.max((c.outstanding_billed ?? 0) - amt, 0);
      const newAvailable = Math.min(c.credit_limit, c.available_limit + amt);
      const newMin = newOutstanding === 0 ? 0 : Math.max(500, Math.round((newOutstanding * 0.05) / 100) * 100);
      await supabase.from('customers').update({
        outstanding_total: newOutstanding, outstanding_billed: newBilled,
        available_limit: newAvailable, minimum_due: newMin,
      }).eq('id', txn.customer_id);
    }
  }
  return true;
}

// ── Case queries (historical, carried forward) ────────────────────────
export async function searchCases(query: string, opts: { category?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
  let q = supabase.from('cases').select('*');
  if (opts.category) q = q.ilike('category', `%${opts.category}%`);
  const allRows = await rows<Record<string, unknown>>(q);

  const tokens = tokenize(query);
  const scored = allRows.map((row) => {
    const haystack = `${row.category} ${row.customer_complaint} ${row.investigation_findings} ${row.resolution}`.toLowerCase();
    let score = 0;
    for (const tok of tokens) if (haystack.includes(tok)) score += tok.length > 4 ? 2 : 1;
    return { row, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.row);
}

export async function listCases() {
  return rows(supabase.from('cases')
    .select('case_id,category,priority,assigned_team,resolution_time,resolved_on')
    .order('case_id', { ascending: true }));
}

export async function getCase(caseId: string) {
  const { data, error } = await supabase.from('cases').select('*').eq('case_id', caseId).maybeSingle();
  if (error) throw error;
  return data ?? undefined;
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

export async function listEscalations() {
  return rows(supabase.from('escalations')
    .select('id,customer_id,category,priority,assigned_team,summary,status,created_at')
    .order('created_at', { ascending: false }));
}

export async function listCustomerEscalations(customerId: number) {
  return rows(supabase.from('escalations')
    .select('id,category,priority,assigned_team,summary,status,created_at,resolved_at,resolution_notes')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false }));
}

export async function getEscalation(id: string) {
  const { data, error } = await supabase.from('escalations').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ?? undefined;
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

export async function getLastAssistantMessage(customerId: number, conversationId: number): Promise<any | null> {
  const { data, error } = await supabase.from('messages')
    .select('*')
    .eq('customer_id', customerId)
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ── Evidence attachments ─────────────────────────────────────────────
export async function addAttachment(input: {
  customer_id: number;
  filename: string;
  mime_type: string;
  byte_size: number;
  storage_path: string;
  attachment_type?: string;
  analysis?: string;
}) {
  const { data, error } = await supabase.from('attachments').insert({
    customer_id: input.customer_id, filename: input.filename, mime_type: input.mime_type,
    byte_size: input.byte_size, storage_path: input.storage_path,
    attachment_type: input.attachment_type ?? 'evidence', analysis: input.analysis ?? null,
    created_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw error;
  return Number(data.id);
}

export async function getRecentAttachments(customerId: number, limit = 5) {
  return rows(supabase.from('attachments')
    .select('id,filename,mime_type,byte_size,attachment_type,analysis,created_at')
    .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(limit));
}

// ── Statements, offers, rewards, controls ─────────────────────────────
export async function getStatements(customerId: number, limit = 12) {
  return rows(supabase.from('statements').select('*').eq('customer_id', customerId)
    .order('statement_month', { ascending: false }).limit(limit));
}

export async function getStatement(customerId: number, month: string) {
  const { data, error } = await supabase.from('statements').select('*')
    .eq('customer_id', customerId).eq('statement_month', month).maybeSingle();
  if (error) throw error;
  return data ?? undefined;
}

const VARIANT_RANK: Record<string, number> = { Classic: 0, Gold: 1, Platinum: 2, Signature: 3 };

export async function getOffersFor(customer: Customer) {
  const all = await rows<Record<string, unknown>>(
    supabase.from('offers').select('*').order('valid_till', { ascending: true }),
  );
  return all.map((o) => ({
    ...o,
    eligible: (VARIANT_RANK[customer.card_variant] ?? 0) >= (VARIANT_RANK[String(o.min_variant)] ?? 0)
      && (String(o.promo_code) !== 'RUPAY-ONLY' || customer.upi_linked === 1 || customer.card_network === 'RuPay'),
  }));
}

export async function getRewardsLedger(customerId: number, limit = 24) {
  return rows(supabase.from('rewards_ledger').select('*').eq('customer_id', customerId)
    .order('entry_date', { ascending: false }).limit(limit));
}

export async function getExpiringPoints(customerId: number, withinDays = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const data = await rows<{ points: number; expiry_date: string | null }>(
    supabase.from('rewards_ledger').select('points,expiry_date')
      .eq('customer_id', customerId).eq('entry_type', 'earned')
      .not('expiry_date', 'is', null).lte('expiry_date', cutoffStr),
  );
  let points = 0;
  let earliest: string | null = null;
  for (const r of data) {
    points += Number(r.points);
    if (r.expiry_date && (!earliest || r.expiry_date < earliest)) earliest = r.expiry_date;
  }
  return { points, earliest };
}

export async function getSpendSummary(customerId: number, months = 3) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const data = await rows<{ category: string; amount: number; reward_points: number }>(
    supabase.from('transactions').select('category,amount,reward_points')
      .eq('customer_id', customerId).eq('status', 'SUCCESS').gte('timestamp', cutoff.toISOString()),
  );
  const map = new Map<string, { category: string; txn_count: number; total: number; points: number }>();
  for (const t of data) {
    const m = map.get(t.category) ?? { category: t.category, txn_count: 0, total: 0, points: 0 };
    m.txn_count += 1;
    m.total += Number(t.amount);
    m.points += Number(t.reward_points ?? 0);
    map.set(t.category, m);
  }
  return [...map.values()].map((m) => ({ ...m, total: Math.round(m.total) })).sort((a, b) => b.total - a.total);
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

// ── CIBIL history, milestones, lounge visits, redemption catalog ──────
export async function getCibilHistory(customerId: number, months = 12) {
  const data = await rows(supabase.from('cibil_history').select('month,score')
    .eq('customer_id', customerId).order('month', { ascending: false }).limit(months));
  return data.reverse();
}

export async function getMilestones(customerId: number) {
  return rows(supabase.from('milestones').select('*').eq('customer_id', customerId)
    .order('period_end', { ascending: true }));
}

export async function getLoungeVisits(customerId: number, limit = 12) {
  return rows(supabase.from('lounge_visits').select('*').eq('customer_id', customerId)
    .order('visit_date', { ascending: false }).limit(limit));
}

export async function getRedemptionCatalog(customer: Customer) {
  const all = await rows<Record<string, unknown>>(
    supabase.from('redemption_catalog').select('*').order('points_required', { ascending: true }),
  );
  return all.map((r) => ({
    ...r,
    eligible: (VARIANT_RANK[customer.card_variant] ?? 0) >= (VARIANT_RANK[String(r.min_variant)] ?? 0),
    affordable: customer.reward_points_balance >= Number(r.points_required),
  }));
}

export async function getMonthlySpendTrend(customerId: number, months = 6) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const data = await rows<{ timestamp: string; amount: number; reward_points: number }>(
    supabase.from('transactions').select('timestamp,amount,reward_points')
      .eq('customer_id', customerId).eq('status', 'SUCCESS').gte('timestamp', cutoff.toISOString()),
  );
  const map = new Map<string, { month: string; total: number; txn_count: number; points: number }>();
  for (const t of data) {
    const month = String(t.timestamp).slice(0, 7);
    const m = map.get(month) ?? { month, total: 0, txn_count: 0, points: 0 };
    m.total += Number(t.amount);
    m.txn_count += 1;
    m.points += Number(t.reward_points ?? 0);
    map.set(month, m);
  }
  return [...map.values()].map((m) => ({ ...m, total: Math.round(m.total) })).sort((a, b) => a.month.localeCompare(b.month));
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

// ── Portfolio analytics (internal operations dashboard) ───────────────
// Single server-side RPC returns the full analytics payload (overview,
// monthly_spend, category_spend, top_merchants, txn_status, payment_health,
// cibil_distribution, variant_mix, dispute_breakdown, fee_revenue).
export async function getPortfolioAnalytics() {
  const { data, error } = await supabase.rpc('portfolio_analytics');
  if (error) throw error;
  return data;
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

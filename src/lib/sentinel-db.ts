// Business database for Sentinel: customers, transactions, historical cases,
// and tickets.  Backed by Supabase (PostgreSQL) via @supabase/supabase-js.
// Migrated from the original node:sqlite DatabaseSync implementation.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    'Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env',
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------- queries

export interface Customer {
  id: number;
  name: string;
  card_status: string;
  risk_score: number;
}

export async function getCustomer(id: number): Promise<Customer | undefined> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getCustomer: ${error.message}`);
  return data ?? undefined;
}

export async function getTransactions(
  customerId: number,
  opts: { merchant?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  let query = supabase
    .from('transactions')
    .select('*')
    .eq('customer_id', customerId)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (opts.merchant) {
    query = query.ilike('merchant', `%${opts.merchant}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getTransactions: ${error.message}`);
  return data ?? [];
}

export async function searchCases(
  query: string,
  opts: { category?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);

  let q = supabase.from('cases').select('*');
  if (opts.category) {
    q = q.ilike('category', `%${opts.category}%`);
  }

  const { data: rows, error } = await q;
  if (error) throw new Error(`searchCases: ${error.message}`);
  if (!rows) return [];

  // In-memory fuzzy scoring (same approach as original SQLite version).
  const tokens = tokenize(query);
  const scored = rows.map((row: Record<string, unknown>) => {
    const haystack =
      `${row.category} ${row.customer_complaint} ${row.investigation_findings} ${row.resolution}`.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (haystack.includes(tok)) score += tok.length > 4 ? 2 : 1;
    }
    return { row, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.row);
}

export async function listCases() {
  const { data, error } = await supabase
    .from('cases')
    .select('case_id, category, priority, assigned_team, resolution_time, resolved_on')
    .order('case_id');
  if (error) throw new Error(`listCases: ${error.message}`);
  return data ?? [];
}

export async function getCase(caseId: string) {
  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .eq('case_id', caseId)
    .maybeSingle();
  if (error) throw new Error(`getCase: ${error.message}`);
  return data ?? undefined;
}

export interface NewTicket {
  category: string;
  priority: string;
  customer_id: number | null;
  customer_name: string | null;
  assigned_team: string;
  summary: string;
  complaint: string;
  evidence: string;
  policy_reference: string;
  sla: string;
  similar_case_ids: string;
  recommendation: string;
}

export async function createTicket(t: NewTicket): Promise<string> {
  // Get the current max ticket number to generate the next ID.
  const { data: maxRow, error: maxErr } = await supabase
    .from('tickets')
    .select('id')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) throw new Error(`createTicket (max): ${maxErr.message}`);

  let nextNum = 1024;
  if (maxRow?.id) {
    const match = String(maxRow.id).match(/^TKT-(\d+)$/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }
  const id = `TKT-${nextNum}`;

  const { error } = await supabase.from('tickets').insert({
    id,
    created_at: new Date().toISOString(),
    status: 'OPEN',
    category: t.category,
    priority: t.priority,
    customer_id: t.customer_id,
    customer_name: t.customer_name,
    assigned_team: t.assigned_team,
    summary: t.summary,
    complaint: t.complaint,
    evidence: t.evidence,
    policy_reference: t.policy_reference,
    sla: t.sla,
    similar_case_ids: t.similar_case_ids,
    recommendation: t.recommendation,
  });
  if (error) throw new Error(`createTicket (insert): ${error.message}`);
  return id;
}

export async function attachAnalysis(ticketId: string, analysis: unknown) {
  const { error } = await supabase
    .from('tickets')
    .update({ analysis: analysis == null ? null : analysis })
    .eq('id', ticketId);
  if (error) throw new Error(`attachAnalysis: ${error.message}`);
}

export async function getTicket(id: string) {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getTicket: ${error.message}`);
  return data ?? undefined;
}

export async function listTickets() {
  const { data, error } = await supabase
    .from('tickets')
    .select(
      'id, created_at, status, category, priority, customer_id, customer_name, assigned_team, summary',
    )
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listTickets: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------- utilities

export function tokenize(text: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'was', 'were', 'this', 'that',
    'customer', 'reports', 'says', 'their', 'have', 'has', 'been', 'from', 'card',
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9₹]+/)
        .filter((t) => t.length > 2 && !stop.has(t)),
    ),
  ];
}

// One-time seed: load all local JSON datasets into the Supabase Postgres
// database. Run with:  node --env-file=.env scripts/seed-supabase.mjs
//
// Idempotent: each table is cleared before insert, so re-running re-seeds
// cleanly. Uses the service-role key (server-side, bypasses RLS).
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const readJson = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const pick = (row, cols) => {
  const out = {};
  for (const c of cols) if (row[c] !== undefined) out[c] = row[c];
  return out;
};

// table -> [jsonPath, columns]. Order respects FK dependencies (customers first).
const TABLES = [
  ['customers', 'data/customers.json', [
    'id', 'name', 'email', 'phone', 'card_number_last4', 'card_variant', 'card_status',
    'card_issued_on', 'credit_limit', 'available_limit', 'outstanding_total', 'outstanding_billed',
    'minimum_due', 'due_date', 'billing_cycle_day', 'cibil_score', 'risk_score', 'reward_points_balance',
    'international_enabled', 'annual_fee', 'kyc_status', 'kyc_expiry', 'card_network', 'upi_linked',
    'online_enabled', 'pos_enabled', 'contactless_enabled', 'atm_enabled', 'per_txn_limit',
    'lounge_visits_remaining', 'lounge_visits_total', 'fuel_surcharge_waiver', 'autopay_enabled', 'autopay_mode',
  ]],
  ['cases', 'knowledge/historical_cases/cases.json', [
    'case_id', 'category', 'priority', 'customer_complaint', 'investigation_findings',
    'resolution', 'assigned_team', 'policy_reference', 'resolution_time', 'resolved_on',
  ]],
  ['transactions', 'data/transactions.json', [
    'id', 'customer_id', 'timestamp', 'merchant', 'category', 'amount', 'currency',
    'channel', 'location', 'status', 'decline_reason', 'reward_points', 'mcc', 'reference_no',
  ]],
  ['payments', 'data/payments.json', [
    'id', 'customer_id', 'billing_month', 'statement_amount', 'minimum_due', 'amount_paid',
    'paid_on', 'due_date', 'days_late', 'payment_status',
  ]],
  ['fees', 'data/fees.json', [
    'id', 'customer_id', 'fee_type', 'amount', 'charged_on', 'waived', 'waived_on',
    'waiver_reason', 'related_transaction_id', 'statement_month', 'gst',
  ]],
  ['disputes', 'data/disputes.json', [
    'id', 'customer_id', 'transaction_id', 'merchant', 'amount', 'reason', 'status',
    'raised_on', 'resolved_on', 'provisional_credit', 'resolution_note',
  ]],
  ['cibil_history', 'data/cibil_history.json', ['customer_id', 'month', 'score']],
  ['milestones', 'data/milestones.json', [
    'id', 'customer_id', 'title', 'description', 'target_amount', 'achieved_amount',
    'reward', 'period_end', 'status',
  ]],
  ['lounge_visits', 'data/lounge_visits.json', ['id', 'customer_id', 'lounge', 'visit_date', 'guests']],
  ['redemption_catalog', 'data/redemption_catalog.json', [
    'id', 'title', 'brand', 'category', 'points_required', 'value_inr', 'min_variant', 'kind', 'note',
  ]],
  ['emis', 'data/emis.json', [
    'id', 'customer_id', 'transaction_id', 'merchant', 'principal_amount', 'tenure_months',
    'interest_rate', 'monthly_installment', 'remaining_installments', 'processing_fee',
    'foreclosure_charge_pct', 'status', 'created_on',
  ]],
  ['statements', 'data/statements.json', [
    'id', 'customer_id', 'statement_month', 'statement_date', 'period_start', 'period_end',
    'due_date', 'purchases', 'fees_charged', 'finance_charges', 'gst', 'total_due',
    'minimum_due', 'reward_points_earned', 'payment_status', 'paid_on', 'amount_paid',
  ]],
  ['offers', 'data/offers.json', [
    'id', 'title', 'description', 'merchant', 'category', 'min_variant', 'valid_till', 'promo_code',
  ]],
  ['rewards_ledger', 'data/rewards_ledger.json', [
    'id', 'customer_id', 'entry_type', 'points', 'description', 'entry_date', 'expiry_date',
  ]],
  ['subscriptions', 'data/subscriptions.json', [
    'id', 'customer_id', 'merchant', 'plan', 'category', 'amount', 'billing_cycle',
    'started_on', 'last_charged_on', 'next_charge_on', 'status', 'cancelled_on',
  ]],
];

const BATCH = 500;

async function seedTable(table, jsonPath, cols) {
  let rows;
  try {
    rows = readJson(jsonPath);
  } catch {
    console.log(`${table.padEnd(20)} (skipped — ${jsonPath} not found)`);
    return;
  }
  // Clear existing rows so re-runs are clean.
  const del = await supabase.from(table).delete().not('id', 'is', null);
  if (del.error && !/has no column|does not exist/.test(del.error.message)) {
    // cibil_history has no single id column; clear by a always-true filter.
    await supabase.from(table).delete().neq('month', '___never___');
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => pick(r, cols));
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`${table} [rows ${i}-${i + batch.length}]: ${error.message}`);
  }
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table} count: ${error.message}`);
  console.log(`${table.padEnd(20)} ${count}`);
}

for (const [table, jsonPath, cols] of TABLES) {
  await seedTable(table, jsonPath, cols);
}

console.log('\nSeed complete.');

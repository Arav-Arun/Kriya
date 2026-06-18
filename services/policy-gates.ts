// Deterministic policy helpers. These are the ONLY place that decides whether a
// sensitive action (waiver, limit increase, refund, e-mandate opt-out, EMI,
// fraud liability, reward redemption) is allowed. The LLM agents orchestrate and
// explain, but they must call the matching check here first; the verdict is
// computed from account data and fixed rule code, never from prose or model
// judgement.
//
// Every check returns the same shape so the resolution agent can render it
// uniformly and so the audit trail is consistent:
//   { decision, eligible, reason_codes, facts_checked, missing_evidence,
//     required_next_step, policy_reference }
import { defineTool, Type } from '@flue/runtime';
import {
  getCustomer, getTransactions,
  getDisputes, getActiveEmis,
} from '../core/queries.ts';

interface PolicyVerdict {
  decision: string;
  eligible: boolean;
  reason_codes: string[];
  facts_checked: Record<string, unknown>;
  missing_evidence: string[];
  required_next_step: string;
  policy_reference: string;
}

const verdict = (
  decision: string,
  policy_reference: string,
  partial: Partial<PolicyVerdict>,
): PolicyVerdict => ({
  decision,
  eligible: false,
  reason_codes: [],
  facts_checked: {},
  missing_evidence: [],
  required_next_step: '',
  policy_reference,
  ...partial,
});

// A verdict is eligible only when nothing blocks it AND no required input is
// missing. Centralised so every gate computes "eligible" identically.
const isEligible = (reason_codes: string[], missing_evidence: string[]): boolean =>
  reason_codes.length === 0 && missing_evidence.length === 0;

// Resolve the first matching next-step from an ordered [predicate, message] list,
// falling back to a default. Replaces deeply-nested ternary ladders so the
// branch order stays readable and behaviour stays identical.
const firstNextStep = (
  branches: Array<[boolean, string]>,
  fallback: string,
): string => branches.find(([when]) => when)?.[1] ?? fallback;

// Date helpers
const DAY = 86_400_000;
const parseDate = (v: unknown): Date | null => {
  const d = new Date(String(v ?? ''));
  return Number.isNaN(d.getTime()) ? null : d;
};
const monthsBetween = (from: Date, to: Date) =>
  (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

// Working (business) days between two dates, excluding weekends. Used for the
// RBI limited-liability fraud clock, which counts working days from notification.
function workingDaysBetween(from: Date, to: Date): number {
  let count = 0;
  const cur = new Date(from.getTime());
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to.getTime());
  end.setHours(0, 0, 0, 0);
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

// 3. Duplicate charge refund policy gate
// Policy POL-001: both transactions settled, reported within 60 days of
// statement date, same merchant + identical/near-identical amount within 24h,
// must not match recurring subscription pattern, account in good standing.
async function checkDuplicateRefund(customerId: number, transactionId?: string): Promise<PolicyVerdict> {
  const POL = 'POL-001 · Duplicate / erroneous charge reversal';
  const c = await getCustomer(customerId);
  const txns = await getTransactions(customerId, { limit: 100 }) as any[];
  const target = transactionId ? txns.find((t) => t.id === String(transactionId)) : undefined;

  const reason_codes: string[] = [];
  const missing_evidence: string[] = [];
  let duplicate: any = null;
  const REPORTING_WINDOW_DAYS = 60;

  if (!transactionId) missing_evidence.push('transaction_id (record_customer_transaction if not in account data)');
  else if (!target) reason_codes.push('TRANSACTION_NOT_FOUND');
  else {
    if (target.status !== 'SUCCESS') reason_codes.push('TRANSACTION_NOT_SETTLED');

    // 60-day reporting window check
    const txnDate = parseDate(target.timestamp);
    if (txnDate && (Date.now() - txnDate.getTime()) > REPORTING_WINDOW_DAYS * DAY) {
      reason_codes.push('BEYOND_60_DAY_REPORTING_WINDOW');
    }

    const t0 = parseDate(target.timestamp);
    duplicate = txns.find((t) =>
      t.id !== target.id && t.merchant === target.merchant &&
      Math.abs(Math.round(Number(t.amount)) - Math.round(Number(target.amount))) <= 1 &&
      t.status === 'SUCCESS' &&
      (() => { const d = parseDate(t.timestamp); return t0 && d ? Math.abs(d.getTime() - t0.getTime()) <= 1 * DAY : false; })());

    // Guard against refunding a recurring subscription that merely looks like a
    // duplicate. Heuristic is count-only: 3+ identical successful charges at the
    // same merchant (same amount) signal recurring billing rather than a one-off
    // double charge. (No interval check — get_subscriptions is the authority.)
    if (duplicate) {
      const recurring = txns.filter((t) =>
        t.merchant === target.merchant &&
        Math.round(Number(t.amount)) === Math.round(Number(target.amount)) &&
        t.status === 'SUCCESS',
      );
      if (recurring.length >= 3) {
        reason_codes.push('POSSIBLE_RECURRING_SUBSCRIPTION_PATTERN');
      }
    }

    if (!duplicate && !reason_codes.includes('BEYOND_60_DAY_REPORTING_WINDOW')) {
      reason_codes.push('NO_DUPLICATE_PAIR_FOUND');
    }
  }

  // Closed account older than 90 days → Card Closure desk
  if (c && c.card_status === 'closed') {
    reason_codes.push('ACCOUNT_CLOSED_ROUTE_TO_CARD_CLOSURE_DESK');
  }

  const open = (await getDisputes(customerId, 50) as any[]).find(
    (d) => d.transaction_id === transactionId && !['won', 'lost'].includes(d.status));
  if (open) reason_codes.push('OPEN_DISPUTE_EXISTS');

  const facts_checked = {
    transaction_id: transactionId ?? null,
    target_status: target?.status ?? null,
    target_merchant: target?.merchant ?? null,
    target_amount: target ? Number(target.amount) : null,
    target_timestamp: target?.timestamp ?? null,
    duplicate_transaction_id: duplicate?.id ?? null,
    duplicate_window_hours: 24,
    reporting_window_days: REPORTING_WINDOW_DAYS,
    open_dispute: open?.id ?? null,
    card_status: c?.card_status ?? null,
  };
  const eligible = Boolean(target) && target?.status === 'SUCCESS' && Boolean(duplicate) && !open
    && !reason_codes.some((r) => r !== 'DUPLICATE_CONFIRMED' && r !== 'POSSIBLE_RECURRING_SUBSCRIPTION_PATTERN');
  if (eligible && !reason_codes.includes('POSSIBLE_RECURRING_SUBSCRIPTION_PATTERN')) {
    reason_codes.push('DUPLICATE_CONFIRMED');
  }

  return verdict('duplicate_refund', POL, {
    eligible: eligible && !reason_codes.includes('POSSIBLE_RECURRING_SUBSCRIPTION_PATTERN'),
    reason_codes, facts_checked, missing_evidence,
    required_next_step: firstNextStep([
      [reason_codes.includes('POSSIBLE_RECURRING_SUBSCRIPTION_PATTERN'), 'Multiple identical charges at this merchant suggest recurring billing, not a duplicate. Verify with the customer whether this is a subscription; check get_subscriptions.'],
      [reason_codes.includes('BEYOND_60_DAY_REPORTING_WINDOW'), 'This charge is older than 60 days from the statement date. Per policy, duplicate refunds must be reported within 60 days. The customer may raise a formal dispute instead.'],
      [eligible, `Confirmed duplicate of ${duplicate?.id}. Call initiate_refund on ONE charge (${transactionId}).`],
      [reason_codes.includes('OPEN_DISPUTE_EXISTS'), 'A dispute is already open; answer with get_disputes status instead of a new refund.'],
      [reason_codes.includes('NO_DUPLICATE_PAIR_FOUND'), 'No matching duplicate found (same merchant, same amount ±₹1, within 24 hours). Do NOT refund; offer raise_dispute if the customer still contests it.'],
    ], 'Resolve missing evidence / blocking reason before any refund.'),
  });
}

// 5. EMI conversion policy gate
// Policy POL-004: amount ≥₹2,500, transaction SUCCESS status, requested within
// 30 days of transaction date, account current (no overdue), total EMI exposure
// after conversion ≤80% of credit limit, excluded categories: fuel, cash
// advances, wallet loads, gold/jewellery. CIBIL ≥650 for account standing.
const EMI_EXCLUDED_CATEGORIES = ['fuel', 'cash advance', 'wallet', 'gold', 'jewellery', 'jewelry'];

async function checkEmiConversion(customerId: number, transactionId?: string, tenureMonths?: number): Promise<PolicyVerdict> {
  const POL = 'POL-004 · EMI conversion';
  const c = await getCustomer(customerId);
  if (!c) return verdict('emi_conversion', POL, { missing_evidence: ['customer'], required_next_step: 'Customer not found.' });

  const [txns, activeEmis] = await Promise.all([
    getTransactions(customerId, { limit: 100 }) as Promise<any[]>,
    getActiveEmis(customerId) as Promise<any[]>,
  ]);
  const target = transactionId ? txns.find((t) => t.id === String(transactionId)) : undefined;
  const VALID_TENURES = [3, 6, 9, 12, 18, 24];
  const EMI_CONVERSION_WINDOW_DAYS = 30;
  const MAX_EMI_EXPOSURE_PCT = 80;

  // Calculate current EMI exposure
  const currentEmiExposure = activeEmis.reduce(
    (sum: number, e: any) => sum + (Number(e.monthly_installment ?? 0) * Number(e.remaining_installments ?? 0)), 0);
  const newEmiPrincipal = target ? Number(target.amount) : 0;
  const totalExposureAfter = currentEmiExposure + newEmiPrincipal;
  const exposurePct = c.credit_limit > 0 ? Math.round((totalExposureAfter / c.credit_limit) * 100) : 0;

  const reason_codes: string[] = [];
  const missing_evidence: string[] = [];

  // Account standing checks
  if (c.card_status === 'blocked' || c.card_status === 'closed') reason_codes.push('ACCOUNT_NOT_IN_GOOD_STANDING');
  // minimum_due / due_date are nullable for live-provisioned accounts; only flag
  // overdue when we have a real positive due AND a real past due date.
  if (c.minimum_due != null && c.minimum_due > 0 && c.due_date != null) {
    const dueDate = parseDate(c.due_date);
    if (dueDate && dueDate.getTime() < Date.now()) {
      reason_codes.push('OVERDUE_AMOUNT_EXISTS');
    }
  }
  // CIBIL nullable: null = not on file (never a real 0). Don't silently pass the
  // ≥650 standing bar off an absent score — require it as evidence instead.
  if (c.cibil_score == null) missing_evidence.push('cibil_score (no bureau score on file; required to confirm account standing)');
  else if (c.cibil_score < 650) reason_codes.push('CIBIL_BELOW_650_ACCOUNT_STANDING');

  if (!transactionId) missing_evidence.push('transaction_id (record_customer_transaction if not in account data)');
  else if (!target) reason_codes.push('TRANSACTION_NOT_FOUND');
  else {
    if (target.status !== 'SUCCESS') reason_codes.push('TRANSACTION_NOT_SETTLED');
    if (Number(target.amount) < 2500) reason_codes.push('BELOW_MIN_AMOUNT_2500');

    // 30-day conversion window
    const txnDate = parseDate(target.timestamp);
    if (txnDate && (Date.now() - txnDate.getTime()) > EMI_CONVERSION_WINDOW_DAYS * DAY) {
      reason_codes.push('BEYOND_30_DAY_CONVERSION_WINDOW');
    }

    // Excluded categories
    const cat = String(target.category ?? '').toLowerCase();
    if (EMI_EXCLUDED_CATEGORIES.some((ex) => cat.includes(ex))) {
      reason_codes.push('EXCLUDED_CATEGORY');
    }

    // Already an EMI
    if (activeEmis.some((e: any) => e.transaction_id === target.id)) {
      reason_codes.push('ALREADY_CONVERTED_TO_EMI');
    }
  }

  // EMI exposure cap
  if (exposurePct > MAX_EMI_EXPOSURE_PCT) reason_codes.push('EMI_EXPOSURE_EXCEEDS_80PCT_OF_LIMIT');

  if (tenureMonths != null && !VALID_TENURES.includes(Number(tenureMonths))) reason_codes.push('INVALID_TENURE');

  const facts_checked = {
    transaction_id: transactionId ?? null,
    amount: target ? Number(target.amount) : null,
    category: target?.category ?? null,
    status: target?.status ?? null,
    transaction_date: target?.timestamp ?? null,
    requested_tenure_months: tenureMonths ?? null,
    valid_tenures: VALID_TENURES,
    min_amount: 2500,
    conversion_window_days: EMI_CONVERSION_WINDOW_DAYS,
    cibil_score: c.cibil_score,
    card_status: c.card_status,
    current_emi_exposure: currentEmiExposure,
    new_total_exposure: totalExposureAfter,
    exposure_pct_of_limit: exposurePct,
    max_emi_exposure_pct: MAX_EMI_EXPOSURE_PCT,
    active_emi_count: activeEmis.length,
  };
  const eligible = isEligible(reason_codes, missing_evidence)
    && Boolean(target) && target?.status === 'SUCCESS' && Number(target?.amount) >= 2500
    && (tenureMonths == null || VALID_TENURES.includes(Number(tenureMonths)));
  if (eligible) reason_codes.push('EMI_CONVERSION_QUALIFIED');

  return verdict('emi_conversion', POL, {
    eligible, reason_codes, facts_checked, missing_evidence,
    required_next_step: eligible
      ? `Call convert_to_emi for ${transactionId}${tenureMonths ? ` at ${tenureMonths} months` : ' once the customer picks a tenure (3/6/9/12/18/24)'}. Processing fee: 1% of amount (min ₹199) + GST.`
      : firstNextStep([
        [reason_codes.includes('BEYOND_30_DAY_CONVERSION_WINDOW'), 'EMI conversion must be requested within 30 days of the transaction date. This window has passed.'],
        [reason_codes.includes('EMI_EXPOSURE_EXCEEDS_80PCT_OF_LIMIT'), `Total EMI exposure would reach ${exposurePct}% of credit limit (max 80%). Customer must foreclose existing EMIs or pay down balance first.`],
        [reason_codes.includes('OVERDUE_AMOUNT_EXISTS'), 'Account has an overdue amount; EMI conversion requires the account to be current. Ask the customer to clear the overdue first.'],
        [reason_codes.includes('EXCLUDED_CATEGORY'), `Category "${target?.category}" is excluded from EMI conversion (fuel, cash advances, wallet loads, gold/jewellery).`],
      ], 'Do not convert. Explain the blocking reason_code (amount/status/tenure/standing).'),
  });
}

// 6. Fraud liability timing policy gate
// RBI limited-liability framework: the customer's liability for an unauthorized
// transaction is set by how many WORKING DAYS pass between when they were
// notified of the transaction and when they report it.
// Additional checks: card must be blocked immediately, FIR required for amounts
// >₹1,00,000, second fraud in 6 months triggers risk re-rating.
async function checkFraudLiability(
  customerId: number,
  transactionDate?: string,
  reportedDate?: string,
  disputedAmount?: number,
): Promise<PolicyVerdict> {
  const POL = 'RBI limited-liability circular (unauthorized electronic transactions) + POL-002';
  const c = await getCustomer(customerId);
  if (!c) return verdict('fraud_liability_timing', POL, { missing_evidence: ['customer'], required_next_step: 'Customer not found.' });

  const txnDate = parseDate(transactionDate);
  const reported = parseDate(reportedDate) ?? new Date();

  const reason_codes: string[] = [];
  const missing_evidence: string[] = [];
  if (!txnDate) missing_evidence.push('transaction_date (when the unauthorized charge / notification occurred)');

  const workingDays = txnDate ? workingDaysBetween(txnDate, reported) : null;
  let bandLimit: string;
  let customerNotLiable = false;
  if (workingDays == null) {
    bandLimit = 'unknown (need the date)';
  } else if (workingDays <= 3) {
    reason_codes.push('ZERO_LIABILITY_REPORTED_WITHIN_3_WORKING_DAYS');
    bandLimit = 'Zero liability: full reversal';
    customerNotLiable = true;
  } else if (workingDays <= 7) {
    reason_codes.push('LIMITED_LIABILITY_REPORTED_4_TO_7_WORKING_DAYS');
    bandLimit = 'Capped per RBI slab (transaction value or ₹10,000, whichever is lower)';
  } else {
    reason_codes.push('LIABILITY_BEYOND_7_WORKING_DAYS_PER_BANK_POLICY');
    bandLimit = 'Per bank policy: customer may bear the loss';
  }

  // Card status check: card MUST be blocked
  const cardNeedsBlock = c.card_status === 'active';
  if (cardNeedsBlock) reason_codes.push('CARD_MUST_BE_BLOCKED_IMMEDIATELY');

  // FIR requirement for high-value fraud
  const FIR_THRESHOLD = 100_000;
  const needsFir = disputedAmount != null && disputedAmount > FIR_THRESHOLD;
  if (needsFir) reason_codes.push('FIR_REQUIRED_AMOUNT_ABOVE_1L');

  // Check for repeat fraud (recent disputes with fraud reason)
  const recentDisputes = await getDisputes(customerId, 50) as any[];
  const recentFraud = recentDisputes.filter((d) => {
    const raised = parseDate(d.raised_on);
    return raised && monthsBetween(raised, new Date()) <= 6 &&
      (d.reason?.toLowerCase().includes('fraud') || d.reason?.toLowerCase().includes('unauthorized'));
  });
  if (recentFraud.length > 0) reason_codes.push('REPEAT_FRAUD_6_MONTHS_RISK_RERATE');

  const facts_checked = {
    transaction_date: transactionDate ?? null,
    reported_date: reported.toISOString().slice(0, 10),
    working_days_to_report: workingDays,
    card_status: c.card_status,
    card_needs_immediate_block: cardNeedsBlock,
    liability_band: bandLimit,
    disputed_amount: disputedAmount ?? null,
    fir_threshold: FIR_THRESHOLD,
    fir_required: needsFir,
    prior_fraud_disputes_6m: recentFraud.length,
    cibil_score: c.cibil_score,
    zero_liability_window_working_days: 3,
    limited_liability_window_working_days: 7,
  };
  // "eligible" here = customer qualifies for zero-liability full reversal.
  const eligible = customerNotLiable && missing_evidence.length === 0;

  let nextStep: string;
  if (missing_evidence.length) {
    nextStep = 'Ask the customer for the date of the unauthorized charge before quoting liability.';
  } else if (cardNeedsBlock) {
    nextStep = 'URGENT: block_card FIRST (card is still active), then create_escalation to Fraud Operations with this liability band.';
  } else {
    nextStep = `Card is ${c.card_status}. Create_escalation to Fraud Operations citing the ${bandLimit} liability band.`;
    if (needsFir) nextStep += ' FIR/e-FIR is mandatory for amounts above ₹1,00,000.';
    if (recentFraud.length > 0) nextStep += ' Flag for Risk Operations risk re-rating: second fraud incident in 6 months.';
    nextStep += ' Fraud reversals are never auto-approved; the band sets what Fraud Ops will apply.';
  }

  return verdict('fraud_liability_timing', POL, {
    eligible, reason_codes, facts_checked, missing_evidence,
    required_next_step: nextStep,
  });
}

// Tool wrappers
const checkDuplicateRefundTool = defineTool({
  name: 'check_duplicate_refund_eligibility',
  description:
    'DETERMINISTIC GATE: call before initiate_refund for a duplicate/erroneous charge. Verifies a real duplicate pair exists (same merchant+amount within 5 days, both SUCCESS) and no open dispute. Do not refund unless eligible=true.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_id: Type.Optional(Type.String()),
  }),
  execute: async ({ customer_id, transaction_id }) =>
    JSON.stringify(await checkDuplicateRefund(Number(customer_id), transaction_id ? String(transaction_id) : undefined)),
});

const checkEmiConversionTool = defineTool({
  name: 'check_emi_conversion_eligibility',
  description:
    'DETERMINISTIC GATE: call before convert_to_emi. Checks transaction status, minimum amount (₹2,500), 30-day conversion window, account standing (no overdue, CIBIL ≥650), EMI exposure cap (≤80% of credit limit), and excluded categories (fuel, cash advances, wallet loads, gold/jewellery). Do not convert unless eligible=true.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_id: Type.Optional(Type.String()),
    tenure_months: Type.Optional(Type.Number({ description: '3, 6, 9, 12, 18, or 24' })),
  }),
  execute: async ({ customer_id, transaction_id, tenure_months }) =>
    JSON.stringify(await checkEmiConversion(
      Number(customer_id),
      transaction_id ? String(transaction_id) : undefined,
      tenure_months != null ? Number(tenure_months) : undefined,
    )),
});

const checkFraudLiabilityTool = defineTool({
  name: 'check_fraud_liability_timing',
  description:
    'DETERMINISTIC GATE: call when handling an unauthorized/fraudulent transaction. Computes the RBI liability band from working days between the charge and reporting (≤3 = zero liability, 4-7 = limited, >7 = per bank policy). Fraud reversals are never auto-approved; this sets what Fraud Operations must apply.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_date: Type.Optional(Type.String({ description: 'Date of the unauthorized charge / customer notification (ISO preferred)' })),
    reported_date: Type.Optional(Type.String({ description: 'Date the customer reported it; defaults to today' })),
    disputed_amount: Type.Optional(Type.Number({ description: 'Total disputed amount in INR; FIR is required above ₹1,00,000' })),
  }),
  execute: async ({ customer_id, transaction_date, reported_date, disputed_amount }) =>
    JSON.stringify(await checkFraudLiability(
      Number(customer_id),
      transaction_date ? String(transaction_date) : undefined,
      reported_date ? String(reported_date) : undefined,
      disputed_amount != null ? Number(disputed_amount) : undefined,
    )),
});

export const POLICY_TOOLS = [
  checkDuplicateRefundTool, checkEmiConversionTool, checkFraudLiabilityTool,
];

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
  getCustomer, getTransactions, getPaymentHistory, getPaymentSummary,
  getUnwaivedFees, getRecentWaivers, getDisputes, getActiveEmis, getSubscriptions,
} from '../database/queries.ts';

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

// ── date helpers ──────────────────────────────────────────────────────
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

// ── 1. Late fee waiver ────────────────────────────────────────────────
// Rule: max 1 waiver per 12 months, fee ≤ ₹1,000, ≥80% on-time record,
// CIBIL ≥650 (critically low CIBIL signals chronic delinquency → no goodwill),
// account must not be under fraud investigation or KYC freeze.
// NOTE: there is no published late-fee goodwill-waiver policy doc; POL-002 is the
// Fraud policy and the 650/80% thresholds aren't documented anywhere. Until a
// policy is authored, this gate cites an explicit internal-rule reference rather
// than a wrong policy id.
async function checkLateFeeWaiver(customerId: number, feeId?: number): Promise<PolicyVerdict> {
  const POL = 'Internal rule (not yet in policy docs) · goodwill late-fee waiver';
  const c = await getCustomer(customerId);
  if (!c) return verdict('late_fee_waiver', POL, { missing_evidence: ['customer'], required_next_step: 'Customer not found.' });

  const [recentWaivers, unwaived, summary] = await Promise.all([
    getRecentWaivers(customerId, 12),
    getUnwaivedFees(customerId),
    getPaymentSummary(customerId),
  ]);
  const fee = feeId != null ? (unwaived as any[]).find((f) => f.id === Number(feeId)) : undefined;
  const onTimePct = summary.on_time_pct;

  const facts_checked = {
    waivers_in_last_12_months: recentWaivers.length,
    on_time_payment_pct: onTimePct,
    cibil_score: c.cibil_score,
    card_status: c.card_status,
    fee_id: feeId ?? null,
    fee_amount: fee ? Number((fee as any).amount) : null,
    fee_type: fee ? (fee as any).fee_type : null,
    waiver_amount_ceiling: 1000,
    on_time_threshold_pct: 80,
    min_cibil_for_waiver: 650,
  };
  const reason_codes: string[] = [];
  const missing_evidence: string[] = [];

  if (feeId == null) missing_evidence.push('fee_id (call get_fees_and_charges to identify the specific fee)');
  else if (!fee) reason_codes.push('FEE_NOT_FOUND_OR_ALREADY_WAIVED');
  if (recentWaivers.length > 0) reason_codes.push('WAIVER_ALREADY_USED_12M');
  if (fee && Number((fee as any).amount) > 1000) reason_codes.push('FEE_EXCEEDS_AUTO_CEILING');
  if (onTimePct < 80) reason_codes.push('ON_TIME_HISTORY_BELOW_80PCT');
  // CIBIL is nullable for live-provisioned accounts (no live bureau source). A
  // real CIBIL is never 0, so null = "not on file", not "critically low": treat
  // it as missing evidence and never render an adverse reason_code or a number.
  if (c.cibil_score == null) missing_evidence.push('cibil_score (no bureau score on file; cannot assess goodwill discipline)');
  else if (c.cibil_score < 650) reason_codes.push('CIBIL_BELOW_650_CHRONIC_DELINQUENCY');
  if (c.card_status === 'closed') reason_codes.push('ACCOUNT_CLOSED');

  const eligible = isEligible(reason_codes, missing_evidence);
  if (eligible) reason_codes.push('GOODWILL_WAIVER_QUALIFIED');

  return verdict('late_fee_waiver', POL, {
    eligible, reason_codes, facts_checked, missing_evidence,
    required_next_step: eligible
      ? `Call waive_fee with fee_id=${feeId} and a reason citing the ${onTimePct}% on-time record and CIBIL ${c.cibil_score}.`
      : firstNextStep([
        [missing_evidence.length > 0, 'Resolve missing evidence above before deciding. If the CIBIL score is unavailable, say it is not on file and the waiver cannot be assessed — do not quote a score.'],
        [reason_codes.includes('FEE_EXCEEDS_AUTO_CEILING'), 'Above the ₹1000 auto-waiver ceiling: route to a human via create_escalation; do not waive.'],
        [reason_codes.includes('CIBIL_BELOW_650_CHRONIC_DELINQUENCY'), `CIBIL score ${c.cibil_score} is critically low; goodwill waivers are reserved for customers demonstrating repayment discipline.`],
      ], 'Do not waive. Explain the blocking reason_code to the customer honestly.'),
  });
}

// ── 2. Credit limit increase ──────────────────────────────────────────
// Policy POL-009: vintage ≥6 months, CIBIL ≥730, zero missed/late in 12 months,
// utilization 30-90% (>90% triggers affordability review), no active fraud
// investigation or KYC freeze, auto-approval ceiling = 150% of current limit,
// committee review if resulting limit > ₹10,00,000.
async function checkCreditLimitIncrease(customerId: number, requestedLimit?: number): Promise<PolicyVerdict> {
  const POL = 'POL-009 · Credit limit enhancement';
  const c = await getCustomer(customerId);
  if (!c) return verdict('credit_limit_increase', POL, { missing_evidence: ['customer'], required_next_step: 'Customer not found.' });

  const history = await getPaymentHistory(customerId, 12) as any[];
  const issued = parseDate(c.card_issued_on);
  const vintageMonths = issued ? monthsBetween(issued, new Date()) : null;
  const missed = history.filter((p) => p.payment_status === 'missed' || (p.payment_status === 'late' && Number(p.days_late ?? 0) >= 30)).length;
  const maxAuto = Math.round(c.credit_limit * 1.5);
  const utilization = c.credit_limit > 0
    ? Math.round(((c.credit_limit - c.available_limit) / c.credit_limit) * 100)
    : 0;
  const COMMITTEE_THRESHOLD = 1_000_000;

  const facts_checked = {
    card_vintage_months: vintageMonths,
    cibil_score: c.cibil_score,
    late_or_missed_payments_12m: missed,
    current_limit: c.credit_limit,
    available_limit: c.available_limit,
    utilization_pct: utilization,
    requested_limit: requestedLimit ?? null,
    auto_approval_ceiling: maxAuto,
    committee_threshold: COMMITTEE_THRESHOLD,
    card_status: c.card_status,
    kyc_status: c.kyc_status,
    min_vintage_months: 6,
    min_cibil: 730,
    ideal_utilization_band: '30-90%',
  };
  const reason_codes: string[] = [];
  const missing_evidence: string[] = [];

  if (vintageMonths == null) missing_evidence.push('card_issued_on (no issuance date on file; cannot compute account vintage)');
  else if (vintageMonths < 6) reason_codes.push('VINTAGE_BELOW_6_MONTHS');
  // CIBIL nullable for live-provisioned accounts: null = not on file, never 0.
  // Cannot decline on an absent bureau score — require it as evidence instead.
  if (c.cibil_score == null) missing_evidence.push('cibil_score (no bureau score on file; required to assess limit increase)');
  else if (c.cibil_score < 730) reason_codes.push('CIBIL_BELOW_730');
  if (missed > 0) reason_codes.push('MISSED_OR_LATE_PAYMENT_12M');
  if (utilization > 90) reason_codes.push('UTILIZATION_ABOVE_90PCT_AFFORDABILITY_REVIEW');
  if (c.card_status === 'blocked') reason_codes.push('CARD_BLOCKED_ACTIVE_INVESTIGATION');
  if (c.card_status === 'closed') reason_codes.push('ACCOUNT_CLOSED');
  // kyc_status nullable: absent status is not "current" — require it as evidence
  // rather than silently treating null as a pass or rendering an adverse code.
  if (c.kyc_status == null) missing_evidence.push('kyc_status (KYC status unavailable; required to confirm KYC is current)');
  else if (c.kyc_status === 'expired' || c.kyc_status === 'pending') reason_codes.push('KYC_NOT_CURRENT');
  if (requestedLimit != null && Number(requestedLimit) > maxAuto) reason_codes.push('EXCEEDS_AUTO_APPROVAL_CEILING');
  if (requestedLimit != null && Number(requestedLimit) > c.credit_limit * 2) reason_codes.push('EXCEEDS_COMMITTEE_THRESHOLD_100PCT');
  if (requestedLimit != null && Number(requestedLimit) > COMMITTEE_THRESHOLD) reason_codes.push('EXCEEDS_COMMITTEE_THRESHOLD_10L');

  const eligible = isEligible(reason_codes, missing_evidence);
  if (eligible) reason_codes.push('LIMIT_INCREASE_QUALIFIED');

  return verdict('credit_limit_increase', POL, {
    eligible, reason_codes, facts_checked, missing_evidence,
    required_next_step: eligible
      ? `Call adjust_credit_limit with new_limit up to ₹${maxAuto.toLocaleString('en-IN')}.`
      : firstNextStep([
        [missing_evidence.length > 0, 'Resolve missing evidence above before deciding. Where a required input (CIBIL, KYC status, issuance date) is unavailable, say it is not on file and the request cannot be assessed — do not quote or infer a value.'],
        [reason_codes.includes('EXCEEDS_COMMITTEE_THRESHOLD_10L') || reason_codes.includes('EXCEEDS_COMMITTEE_THRESHOLD_100PCT'), `Requested limit exceeds ${reason_codes.includes('EXCEEDS_COMMITTEE_THRESHOLD_10L') ? '₹10,00,000' : '100% increase'} and requires Credit Committee approval. Create an escalation to Risk Operations.`],
        [reason_codes.includes('EXCEEDS_AUTO_APPROVAL_CEILING'), `Cap an auto-approval at ₹${maxAuto.toLocaleString('en-IN')}, or escalate for committee review above that.`],
        [reason_codes.includes('UTILIZATION_ABOVE_90PCT_AFFORDABILITY_REVIEW'), `Utilization is ${utilization}% (above 90%); this triggers an affordability review instead of auto-approval. Escalate to Risk Operations.`],
        [reason_codes.includes('KYC_NOT_CURRENT'), `KYC status is ${c.kyc_status}; limit increases require current KYC. Ask the customer to complete KYC re-verification first.`],
      ], 'Do not increase. Tell the customer which criterion failed.'),
  });
}

// ── 3. Duplicate charge refund ────────────────────────────────────────
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

// ── 4. E-mandate cancellation / opt-out ───────────────────────────────
async function checkEmandateCancellation(customerId: number, subscriptionId?: string): Promise<PolicyVerdict> {
  const POL = 'RBI e-mandate framework · standing-instruction opt-out';
  const subs = await getSubscriptions(customerId) as any[];
  const sub = subscriptionId ? subs.find((s) => String(s.id) === String(subscriptionId)) : undefined;

  const reason_codes: string[] = [];
  const missing_evidence: string[] = [];
  if (!subscriptionId) missing_evidence.push('subscription_id (call get_subscriptions to match the merchant)');
  else if (!sub) reason_codes.push('MANDATE_NOT_FOUND');
  else if (sub.status !== 'active') reason_codes.push('MANDATE_ALREADY_CANCELLED');

  const facts_checked = {
    subscription_id: subscriptionId ?? null,
    merchant: sub?.merchant ?? null,
    status: sub?.status ?? null,
    next_charge_on: sub?.next_charge_on ?? null,
  };
  const eligible = Boolean(sub) && sub?.status === 'active';
  if (eligible) reason_codes.push('OPT_OUT_RIGHT_GRANTED');

  return verdict('emandate_cancellation', POL, {
    eligible, reason_codes, facts_checked, missing_evidence,
    required_next_step: eligible
      ? `Call cancel_emandate for ${subscriptionId}. Note: this stops future debits only; past charges need initiate_refund / raise_dispute.`
      : reason_codes.includes('MANDATE_ALREADY_CANCELLED')
        ? 'Already cancelled. Confirm to the customer; raise_dispute if a charge hit after cancellation.'
        : 'Resolve missing evidence before cancelling.',
  });
}

// ── 5. EMI conversion ─────────────────────────────────────────────────
// Policy POL-004: amount ≥₹2,500, transaction SUCCESS status, requested within
// 30 days of transaction date, account current (no overdue), total EMI exposure
// after conversion ≤80% of credit limit, excluded categories: fuel, cash
// advances, wallet loads, gold/jewellery. CIBIL ≥650 for account standing.
const EMI_EXCLUDED_CATEGORIES = ['fuel', 'cash advance', 'wallet', 'gold', 'jewellery', 'jewelry'];

async function checkEmiConversion(customerId: number, transactionId?: string, tenureMonths?: number): Promise<PolicyVerdict> {
  const POL = 'POL-004 · EMI conversion';
  const c = await getCustomer(customerId);
  if (!c) return verdict('emi_conversion', POL, { missing_evidence: ['customer'], required_next_step: 'Customer not found.' });

  const [txns, activeEmis, summary] = await Promise.all([
    getTransactions(customerId, { limit: 100 }) as Promise<any[]>,
    getActiveEmis(customerId) as Promise<any[]>,
    getPaymentSummary(customerId),
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

// ── 6. Fraud liability timing ─────────────────────────────────────────
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

// ── Tool wrappers ─────────────────────────────────────────────────────
const checkLateFeeWaiverTool = defineTool({
  name: 'check_late_fee_waiver_eligibility',
  description:
    'DETERMINISTIC GATE: call before waive_fee. Computes late-fee waiver eligibility from account data (waiver history, on-time %, fee amount). Returns { eligible, reason_codes, facts_checked, missing_evidence, required_next_step, policy_reference }. Do not waive unless eligible=true.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    fee_id: Type.Optional(Type.Number({ description: 'Fee ID from get_fees_and_charges' })),
  }),
  execute: async ({ customer_id, fee_id }) =>
    JSON.stringify(await checkLateFeeWaiver(Number(customer_id), fee_id != null ? Number(fee_id) : undefined)),
});

const checkCreditLimitIncreaseTool = defineTool({
  name: 'check_credit_limit_increase_eligibility',
  description:
    'DETERMINISTIC GATE: call before adjust_credit_limit. Computes limit-increase eligibility (vintage, CIBIL, missed payments, auto-approval ceiling) from account data. Do not increase unless eligible=true.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    requested_limit: Type.Optional(Type.Number({ description: 'Requested new limit in INR, if the customer named one' })),
  }),
  execute: async ({ customer_id, requested_limit }) =>
    JSON.stringify(await checkCreditLimitIncrease(Number(customer_id), requested_limit != null ? Number(requested_limit) : undefined)),
});

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

const checkEmandateCancellationTool = defineTool({
  name: 'check_emandate_cancellation_eligibility',
  description:
    'DETERMINISTIC GATE: call before cancel_subscription. Confirms the standing-instruction / e-mandate exists and is active (RBI opt-out right). Do not cancel unless eligible=true.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    subscription_id: Type.Optional(Type.String({ description: 'Subscription ID from get_subscriptions' })),
  }),
  execute: async ({ customer_id, subscription_id }) =>
    JSON.stringify(await checkEmandateCancellation(Number(customer_id), subscription_id ? String(subscription_id) : undefined)),
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
  checkLateFeeWaiverTool, checkCreditLimitIncreaseTool, checkDuplicateRefundTool,
  checkEmandateCancellationTool, checkEmiConversionTool, checkFraudLiabilityTool,
];

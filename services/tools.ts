import { defineTool, Type } from '@flue/runtime';
import {
  getCustomer, getPaymentHistory, getPaymentSummary,
  getFeesAndCharges, getUnwaivedFees, getRecentWaivers, waiveFee,
  updateCustomerContext, createCustomerTransaction,
  getActiveEmis, foreclosEmi, createEmi,
  updateCardStatus, adjustCreditLimit,
  initiateRefund, createEscalation, logAction,
  setAutopay, toggleInternational, setCardControl,
  getDisputes, createDispute, getSubscriptions, cancelSubscription,
} from '../core/queries.ts';
import { supabase } from '../core/supabase.ts';
import { searchPolicies } from './knowledge.ts';
import {
  toEMandate, buildCancellationReceipt,
  AFA_FREE_LIMIT_GENERAL_INR, AFA_FREE_LIMIT_HIGH_INR,
} from './emandates.ts';
import { assertActionAllowed } from './verify.ts';
import { tryLinkedRead, linkedLiveSummary } from './provider-tools.ts';
import { hyperfaceProvider } from '../providers/hyperface.ts';

// Policy & pricing constants
// Single source of truth for every magic literal that is enforced in code
// AND quoted in a tool description, so the number can't drift between the two.
// EMI pricing
const EMI_ALLOWED_TENURES = [3, 6, 9, 12, 18, 24] as const;
const EMI_RATE_SHORT_PCT = 14;              // annual rate for tenure <= 6 months
const EMI_RATE_LONG_PCT = 16;               // annual rate for tenure > 6 months
const EMI_SHORT_TENURE_MAX = 6;             // boundary for the short-tenure rate band
const EMI_PROCESSING_FEE_PCT = 1;           // processing fee as % of principal
const EMI_MIN_AMOUNT_INR = 2500;            // minimum transaction amount for EMI conversion
const EMI_FORECLOSURE_PCT = 3;              // foreclosure fee % (also set in queries.createEmi)
// Fee waiver policy
const WAIVER_MAX_AMOUNT_INR = 1000;         // max single fee auto-waivable
const WAIVER_WINDOW_MONTHS = 12;            // one waiver per rolling window
// Credit limit policy
const CREDIT_LIMIT_CIBIL_FLOOR = 730;       // minimum CIBIL for a limit increase
const CREDIT_LIMIT_AUTO_APPROVE_MULTIPLIER = 1.5; // max auto-approved limit vs current
// Dispute / chargeback SLA (RBI timelines)
const DISPUTE_PROVISIONAL_CREDIT_SLA = '7 working days';
const DISPUTE_RESOLUTION_SLA = '30-45 days';

// Label for any figure read from DB rows that are app/seed state with no live
// feed behind them — must never be presented as the customer's real account data.
const SOURCE_RECORDS_ON_FILE = 'records_on_file';

/**
 * Strict-live policy: customer account data comes only from the Hyperface
 * system of record. When a live read is unavailable — no phone-linked account,
 * the provider feed is not enabled (403), or the provider is down — return an
 * explicit "unavailable" rather than a records-on-file snapshot presented as
 * the customer's real data. `note` carries the live reason
 * (PERMISSION_PENDING / provider message) when known.
 */
function liveUnavailable(feed: string, note?: string): string {
  return JSON.stringify({
    source: 'live_unavailable',
    available: false,
    feed,
    reason: note ?? "No live card account is linked to this customer's registered mobile number.",
    note: `Live ${feed} could not be retrieved from the card system of record. Tell the customer this isn't available from the live system right now — do NOT invent, estimate, or read it from any other source.`,
  });
}

/**
 * The transactions endpoint requires a {from,to} window and caps it at 90 days;
 * with no window it returns the current cycle only (empty for any account whose
 * activity predates it). Default to the last 89 days (yyyy-MM-dd, safely under
 * the cap). When only `to` is given, `from` is 89 days before it, so the agent
 * can pull an older 90-day slice by passing just an end date.
 */
function transactionWindow(from?: string, to?: string): { from: string; to: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 89 * 86_400_000);
  return { from: fmt(fromDate), to: fmt(toDate) };
}

/**
 * Deterministic identity gate for sensitive actions. Returns null when the
 * session is sufficiently verified; otherwise a ready-to-return JSON failure
 * instructing the agent to run the verification flow and retry.
 */
async function requireVerified(customerId: number, actionType: string): Promise<string | null> {
  const verdict = await assertActionAllowed(customerId, actionType);
  if (verdict.allowed) return null;
  return JSON.stringify({
    success: false,
    requires_verification: true,
    needed: verdict.needed,
    reason: verdict.reason,
  });
}

/**
 * Look up a single transaction by id, scoped to the customer. Used by
 * raise_dispute / convert_to_emi / initiate_refund so they all resolve a txn
 * the same way — by primary key, not by scanning a capped recent-rows page
 * (which silently misses anything older than the page). Returns the row or null.
 */
async function findCustomerTransaction(customerId: number, transactionId: string): Promise<Record<string, any> | null> {
  const { data, error } = await supabase.from('transactions').select('*')
    .eq('id', String(transactionId)).eq('customer_id', customerId).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Record<string, any> | null;
}

// Read-only tools

export const getCustomerProfileTool = defineTool({
  name: 'get_customer_profile',
  description:
    'Get the full profile of the currently authenticated customer: name, card details, credit limit, outstanding balance, CIBIL score, reward points, KYC status, and a payment behavior summary. For customers linked to a live provider account, balance/limits/card status come from the card system of record (source: "live_provider"); otherwise from records on file. Fields with no live source are marked "unavailable" — never treat "unavailable" as a real figure (e.g. do not read it as a zero balance or a passing CIBIL).',
  parameters: Type.Object({
    customer_id: Type.Number(),
  }),
  execute: async ({ customer_id }) => {
    const c = await getCustomer(Number(customer_id));
    if (!c) return JSON.stringify({ error: 'Customer not found' });
    const summary = await getPaymentSummary(c.id);
    // Identity is always the record on file; figures come from the card
    // system of record when this customer's number is linked to a live account.
    const live = await linkedLiveSummary(c.id);
    const figures = live
      ? {
          source: 'live_provider',
          card_status: live.primaryCard?.isHotlisted ? 'hotlisted'
            : live.primaryCard?.isLocked ? 'blocked'
            : String(live.primaryCard?.cardStatus ?? c.card_status).toLowerCase(),
          credit_limit: live.account.approvedCreditLimit,
          available_limit: live.account.availableCreditLimit,
          outstanding_total: Math.max(0, -live.account.currentBalance),
          currency: live.account.currency ?? 'INR',
          source_note: 'balance/limits/card status are live from the card system of record; due date, CIBIL, risk, reward points and KYC have no live source and are shown only when on file (else "unavailable")',
        }
      : {
          // Strict-live: no phone-linked account → account FIGURES are
          // unavailable, never the records-on-file snapshot. Identity (name/email
          // below) is the chat anchor and stays; figures must be live or nothing.
          source: 'live_unavailable',
          card_status: 'unavailable',
          credit_limit: 'unavailable',
          available_limit: 'unavailable',
          outstanding_total: 'unavailable',
          figures_note: 'No live card account is linked to this customer, so balance/limits/card status are unavailable — do not state any figure.',
        };
    // Fields with no live source: present the genuine on-file value when present,
    // otherwise "unavailable" — never emit a 0/placeholder under a live response.
    const orUnavailable = (v: unknown) => (v == null ? 'unavailable' : v);
    return JSON.stringify({
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      card_last4: c.card_number_last4, card_variant: c.card_variant,
      card_issued_on: orUnavailable(c.card_issued_on),
      ...figures,
      minimum_due: orUnavailable(c.minimum_due),
      due_date: orUnavailable(c.due_date),
      cibil_score: orUnavailable(c.cibil_score),
      risk_score: orUnavailable(c.risk_score),
      reward_points: orUnavailable(c.reward_points_balance),
      international_enabled: c.international_enabled === 1,
      kyc_status: orUnavailable(c.kyc_status),
      kyc_expiry: orUnavailable(c.kyc_expiry),
      payment_summary: summary,
    });
  },
});

export const getTransactionsTool = defineTool({
  name: 'get_transactions',
  description:
    'Fetch the customer\'s card transactions (newest first). Defaults to the last 90 days; to look further back (e.g. a customer asking about an older charge), pass from/to as yyyy-MM-dd — the window must span at most 90 days. Optionally filter by merchant name. Each row has id, timestamp, merchant, category, amount, currency, channel, location, status, decline_reason.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    merchant: Type.Optional(Type.String()),
    from: Type.Optional(Type.String({ description: 'Window start yyyy-MM-dd (defaults to 90 days before "to")' })),
    to: Type.Optional(Type.String({ description: 'Window end yyyy-MM-dd (defaults to today)' })),
    limit: Type.Optional(Type.Number({ description: 'Max rows, default 30, max 100' })),
  }),
  execute: async ({ customer_id, merchant, from, to, limit }) => {
    const cid = Number(customer_id);
    // The provider returns NOTHING without a date window (it falls back to the
    // current cycle, which is empty for any account whose activity predates it),
    // so always send one. Default to the last ~90 days — the widest span the
    // transactions endpoint accepts in a single call.
    const window = transactionWindow(from, to);
    const live = await tryLinkedRead(cid, (b) => hyperfaceProvider.transactions(b.accountId, {
      ...window,
      count: limit ? Number(limit) : 30,
      offset: 0,
    }));
    if (live.live) {
      return JSON.stringify({ source: 'live_provider', window, transactions: live.data });
    }
    return liveUnavailable('transactions', live.note);
  },
});

export const getPaymentHistoryTool = defineTool({
  name: 'get_payment_history',
  description:
    'Get the customer\'s monthly payment history (up to 18 months). Each record shows billing_month, statement_amount, amount_paid, due_date, paid_on, days_late, and payment_status (on_time/late/missed/partial). Use this to assess payment behavior for fee waiver eligibility.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    limit: Type.Optional(Type.Number({ description: 'Max months, default 18' })),
  }),
  execute: async ({ customer_id, limit }) => {
    const rows = await getPaymentHistory(Number(customer_id), limit ? Number(limit) : 18);
    return JSON.stringify({
      source: SOURCE_RECORDS_ON_FILE,
      source_note: 'from records on file (no live payments feed connected)',
      count: rows.length,
      payments: rows,
    });
  },
});

export const getOutstandingBalanceTool = defineTool({
  name: 'get_outstanding_balance',
  description:
    'Get the customer\'s current outstanding balance, minimum due, due date, credit limit, and available limit.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const c = await getCustomer(Number(customer_id));
    if (!c) return JSON.stringify({ error: 'Customer not found' });
    const live = await linkedLiveSummary(c.id);
    if (live) {
      // No live API for due dates yet — only surface minimum due / due date when
      // genuinely on file; never present null as a real figure under a live response.
      return JSON.stringify({
        source: 'live_provider',
        outstanding_total: Math.max(0, -live.account.currentBalance),
        credit_limit: live.account.approvedCreditLimit,
        available_limit: live.account.availableCreditLimit,
        currency: live.account.currency ?? 'INR',
        ...(c.minimum_due != null ? { minimum_due: c.minimum_due } : { minimum_due: 'unavailable' }),
        ...(c.due_date != null ? { due_date: c.due_date } : { due_date: 'unavailable' }),
        source_note: 'balance/limits are live from the card system of record; minimum due and due date are records on file (shown only when available)',
      });
    }
    return liveUnavailable('balance and limits');
  },
});

export const getActiveEmisTool = defineTool({
  name: 'get_active_emis',
  description: 'Get all active EMI plans for the customer, including merchant, amount, tenure, monthly installment, remaining installments, and foreclosure terms.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const cid = Number(customer_id);
    const live = await tryLinkedRead(cid, (b) => hyperfaceProvider.emiList(b.accountId));
    if (live.live) {
      return JSON.stringify({ source: 'live_provider', emis: live.data });
    }
    return liveUnavailable('EMIs', live.note);
  },
});

export const getFeesAndChargesTool = defineTool({
  name: 'get_fees_and_charges',
  description:
    'Get recent fees and charges for the customer (late_payment, annual, finance_charge, etc.). Shows amount, date, whether it was waived, and waiver reason. Use this to find fees the customer is complaining about.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    limit: Type.Optional(Type.Number({ description: 'Max records, default 20' })),
  }),
  execute: async ({ customer_id, limit }) => {
    const rows = await getFeesAndCharges(Number(customer_id), limit ? Number(limit) : 20);
    return JSON.stringify({
      source: SOURCE_RECORDS_ON_FILE,
      source_note: 'from records on file (no live fees/charges feed connected)',
      count: rows.length,
      fees: rows,
    });
  },
});

export const searchPolicyTool = defineTool({
  name: 'search_policy',
  description:
    'Search the bank\'s internal policy documents by keywords. Returns the full text of matching policies including eligibility rules, required documents, SLA, escalation conditions, and resolution procedure.',
  parameters: Type.Object({
    query: Type.String({ description: 'Keywords describing the issue' }),
  }),
  execute: async ({ query }) => {
    const docs = searchPolicies(String(query));
    if (docs.length === 0) return JSON.stringify({ error: 'No matching policies' });
    return docs.map((d) => `=== ${d.title} (${d.slug}) ===\n${d.content}`).join('\n\n');
  },
});

export const recordCustomerContextTool = defineTool({
  name: 'record_customer_context',
  description:
    'Save account context the CUSTOMER CLAIMED in chat (statement amounts, payment record, late fee amount, days late, card status, reward points, international usage). Use this only when required data was missing and the customer supplies it, then continue resolving the issue. CRITICAL: everything recorded here is UNVERIFIED customer input, not a verified account fact. Never cite a value recorded here as the customer\'s real CIBIL, balance, limit, or account figure, and never let a recorded value satisfy a policy gate (e.g. the CIBIL floor for a credit-limit increase) — those gates require verified system-of-record data. cibil_score in particular must be treated as an unverified claim for context only.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    card_status: Type.Optional(Type.String()),
    international_enabled: Type.Optional(Type.Boolean()),
    credit_limit: Type.Optional(Type.Number()),
    available_limit: Type.Optional(Type.Number()),
    outstanding_total: Type.Optional(Type.Number()),
    minimum_due: Type.Optional(Type.Number()),
    due_date: Type.Optional(Type.String()),
    reward_points: Type.Optional(Type.Number()),
    cibil_score: Type.Optional(Type.Number()),
    on_time_payments: Type.Optional(Type.Number()),
    late_payments: Type.Optional(Type.Number()),
    late_fee_amount: Type.Optional(Type.Number()),
    days_late: Type.Optional(Type.Number()),
    note: Type.Optional(Type.String({ description: 'Short description of what the customer provided' })),
  }),
  execute: async (args) => {
    const cid = Number(args.customer_id);
    // Do NOT forward cibil_score into the verified customers.cibil_score column:
    // a customer-claimed CIBIL must never satisfy the credit-limit policy gate,
    // which reads that column as system-of-record truth. We keep the claim only
    // in the audit note below, clearly labelled as unverified.
    const ok = await updateCustomerContext({
      customer_id: cid,
      card_status: args.card_status ? String(args.card_status) : undefined,
      international_enabled: args.international_enabled,
      credit_limit: args.credit_limit,
      available_limit: args.available_limit,
      outstanding_total: args.outstanding_total,
      minimum_due: args.minimum_due,
      due_date: args.due_date ? String(args.due_date) : undefined,
      reward_points: args.reward_points,
      on_time_payments: args.on_time_payments,
      late_payments: args.late_payments,
      late_fee_amount: args.late_fee_amount,
      days_late: args.days_late,
    });
    if (ok) {
      await logAction({
        customer_id: cid,
        action_type: 'context_recorded',
        action_detail: {
          source: 'customer_provided',
          unverified: true,
          note: args.note ?? 'Customer-provided account context recorded (unverified claim)',
          ...(args.cibil_score != null
            ? { claimed_cibil_score: args.cibil_score, claimed_cibil_note: 'unverified customer claim; not stored as account CIBIL and not usable for policy gates' }
            : {}),
        },
      });
    }
    return JSON.stringify({
      success: ok,
      source: 'customer_provided',
      unverified: true,
      note: 'Recorded as unverified customer-provided context. Do not cite these values as the customer\'s real account data, and do not use them to satisfy policy gates (e.g. CIBIL/limit checks).',
      ...(args.cibil_score != null
        ? { cibil_score_not_stored: 'A claimed CIBIL was provided but is NOT stored as account CIBIL; verified CIBIL is required for any limit decision.' }
        : {}),
    });
  },
});

export const recordCustomerTransactionTool = defineTool({
  name: 'record_customer_transaction',
  description:
    'Save a transaction the CUSTOMER CLAIMED in chat. Use this when a fresh customer has no transaction history and gives the merchant, amount, date/time, or status needed for a refund, dispute, fraud report, or EMI conversion. This creates a local record tagged source="customer_provided" so other action tools can reference it. CRITICAL: this is an UNVERIFIED customer claim, NOT a settled transaction — it is not stored as SUCCESS. Do not describe it to the customer as a confirmed/settled charge, and remember that downstream action tools require genuine SUCCESS-status transactions, so a recorded claim will not, by itself, clear those eligibility checks.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    merchant: Type.String(),
    amount: Type.Number(),
    timestamp: Type.Optional(Type.String({ description: 'Transaction date/time. ISO date preferred; natural date is accepted if parseable.' })),
    category: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String({ description: 'ONLINE | POS | ATM | UPI | OTHER' })),
    location: Type.Optional(Type.String()),
    status: Type.Optional(Type.String({ description: 'SUCCESS | PENDING | DECLINED' })),
    decline_reason: Type.Optional(Type.String()),
    note: Type.Optional(Type.String({ description: 'Short description of why this transaction was recorded' })),
  }),
  execute: async (args) => {
    const cid = Number(args.customer_id);
    const txn = await createCustomerTransaction({
      customer_id: cid,
      merchant: String(args.merchant),
      amount: Number(args.amount),
      timestamp: args.timestamp ? String(args.timestamp) : undefined,
      category: args.category ? String(args.category) : undefined,
      channel: args.channel ? String(args.channel) : undefined,
      location: args.location ? String(args.location) : undefined,
      status: args.status ? String(args.status) : undefined,
      decline_reason: args.decline_reason ? String(args.decline_reason) : null,
    });
    if (txn) {
      await logAction({
        customer_id: cid,
        action_type: 'transaction_recorded',
        action_detail: {
          source: 'customer_provided',
          unverified: true,
          transaction_id: txn.id,
          merchant: txn.merchant,
          amount: txn.amount,
          status: txn.status,
          note: args.note ?? 'Customer-provided transaction recorded (unverified claim)',
        },
      });
    }
    return JSON.stringify({
      success: Boolean(txn),
      source: 'customer_provided',
      unverified: true,
      note: 'Recorded as an unverified customer-provided claim, not a settled transaction. Do not present it as a confirmed charge.',
      transaction: txn,
    });
  },
});

export const getDisputesTool = defineTool({
  name: 'get_disputes',
  description:
    'Get the customer\'s dispute/chargeback history and status. Each dispute shows the transaction, merchant, amount, reason, status (under_review/provisional_credit/won/lost), whether provisional credit was issued, and the resolution note. Use for "what happened to my dispute" questions and to avoid raising a duplicate dispute.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const rows = await getDisputes(Number(customer_id), 20) as any[];
    return JSON.stringify({
      source: SOURCE_RECORDS_ON_FILE,
      source_note: 'from dispute records on file (no live chargeback registry feed connected); these include disputes raised in-app and any pre-existing seeded records',
      count: rows.length,
      disputes: rows,
    });
  },
});


// Action tools

export const raiseDisputeTool = defineTool({
  name: 'raise_dispute',
  description:
    `Raise a formal dispute/chargeback on a transaction when an instant refund is not possible (merchant dispute, goods not received, amount mismatch, unauthorized charge already reported). The transaction must be SUCCESS status and not already disputed. Per RBI timelines, provisional credit is assessed within ${DISPUTE_PROVISIONAL_CREDIT_SLA} and resolution within ${DISPUTE_RESOLUTION_SLA}. Returns the dispute reference ID.`,
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_id: Type.String(),
    reason: Type.String({ description: 'e.g. Unauthorized transaction | Duplicate processing | Goods or services not received | Amount differs from receipt | Cancelled subscription still charged' }),
  }),
  execute: async ({ customer_id, transaction_id, reason }) => {
    const cid = Number(customer_id);
    const txn = await findCustomerTransaction(cid, String(transaction_id));
    if (!txn) return JSON.stringify({ success: false, reason: 'Transaction not found in this customer account' });
    if (txn.status !== 'SUCCESS') {
      return JSON.stringify({ success: false, reason: `Transaction status is ${txn.status}; only settled successful charges can be disputed` });
    }
    const existing = await getDisputes(cid, 50) as any[];
    if (existing.some((d) => d.transaction_id === txn.id && !['won', 'lost'].includes(d.status))) {
      return JSON.stringify({ success: false, reason: 'An open dispute already exists for this transaction' });
    }
    const id = await createDispute({
      customer_id: cid, transaction_id: txn.id, merchant: txn.merchant,
      amount: txn.amount, reason: String(reason),
    });
    await logAction({
      customer_id: cid,
      action_type: 'dispute_raised',
      action_detail: { dispute_id: id, transaction_id: txn.id, merchant: txn.merchant, amount: txn.amount, reason },
      policy_reference: 'POL-001',
    });
    return JSON.stringify({
      success: true, dispute_id: id, merchant: txn.merchant, amount: txn.amount,
      status: 'under_review',
      message: `Dispute ${id} raised. Provisional credit is assessed within ${DISPUTE_PROVISIONAL_CREDIT_SLA}; final resolution within ${DISPUTE_RESOLUTION_SLA} per RBI guidelines.`,
    });
  },
});

export const waiveFeeTool = defineTool({
  name: 'waive_fee',
  description:
    `Waive a specific fee for the customer. Policy guard: max 1 waiver per ${WAIVER_WINDOW_MONTHS} months, max INR ${WAIVER_MAX_AMOUNT_INR}. Provide the fee ID from get_fees_and_charges. Returns success/failure with reason.`,
  parameters: Type.Object({
    customer_id: Type.Number(),
    fee_id: Type.Number({ description: 'The fee ID from get_fees_and_charges' }),
    reason: Type.String({ description: 'Why the fee is being waived' }),
  }),
  execute: async ({ customer_id, fee_id, reason }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'waive_fee');
    if (verificationBlock) return verificationBlock;
    const recentWaivers = await getRecentWaivers(cid, WAIVER_WINDOW_MONTHS);
    if (recentWaivers.length > 0) {
      return JSON.stringify({ success: false, reason: `Customer already received a fee waiver in the last ${WAIVER_WINDOW_MONTHS} months` });
    }
    const unwaivedFees = await getUnwaivedFees(cid);
    const fee = unwaivedFees.find((f: any) => f.id === Number(fee_id));
    if (!fee) {
      return JSON.stringify({ success: false, reason: 'Fee not found or already waived' });
    }
    if ((fee as any).amount > WAIVER_MAX_AMOUNT_INR) {
      return JSON.stringify({ success: false, reason: `Fee amount INR ${(fee as any).amount} exceeds the INR ${WAIVER_MAX_AMOUNT_INR} auto-waiver limit` });
    }
    const result = await waiveFee(Number(fee_id), String(reason));
    if (result.success) {
      await logAction({
        customer_id: cid,
        action_type: 'fee_waived',
        action_detail: {
          fee_id,
          amount: result.amount,
          fee_type: result.fee_type,
          reason,
          previous_available_limit: result.previous_available_limit,
          new_available_limit: result.new_available_limit,
          previous_outstanding_total: result.previous_outstanding_total,
          new_outstanding_total: result.new_outstanding_total,
        },
        policy_reference: 'Goodwill waiver policy',
      });
    }
    return JSON.stringify(result);
  },
});

export const blockCardTool = defineTool({
  name: 'block_card',
  description: 'Temporarily freeze/block the customer\'s card. This is reversible via unblock_card.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, reason }) => {
    const cid = Number(customer_id);
    const ok = await updateCardStatus(cid, 'blocked');
    if (ok) await logAction({ customer_id: cid, action_type: 'card_blocked', action_detail: { reason } });
    return JSON.stringify({ success: ok, new_status: 'blocked' });
  },
});

export const unblockCardTool = defineTool({
  name: 'unblock_card',
  description: 'Remove the temporary block on the customer\'s card, restoring it to active status.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, reason }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'unblock_card');
    if (verificationBlock) return verificationBlock;
    const ok = await updateCardStatus(cid, 'active');
    if (ok) await logAction({ customer_id: cid, action_type: 'card_unblocked', action_detail: { reason } });
    return JSON.stringify({ success: ok, new_status: 'active' });
  },
});

export const hotlistCardTool = defineTool({
  name: 'hotlist_card',
  description: 'Permanently disable the customer\'s card (hotlist). This is IRREVERSIBLE; use only for lost/stolen cards after confirming with the customer.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, reason }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'hotlist_card');
    if (verificationBlock) return verificationBlock;
    const ok = await updateCardStatus(cid, 'closed');
    if (ok) await logAction({ customer_id: cid, action_type: 'card_hotlisted', action_detail: { reason }, policy_reference: 'POL-007' });
    return JSON.stringify({ success: ok, new_status: 'closed', warning: 'Card permanently disabled' });
  },
});

export const toggleInternationalTool = defineTool({
  name: 'toggle_international',
  description: 'Enable or disable international transactions on the customer\'s card.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    enabled: Type.Boolean({ description: 'true to enable, false to disable' }),
  }),
  execute: async ({ customer_id, enabled }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'toggle_international');
    if (verificationBlock) return verificationBlock;
    const ok = await toggleInternational(cid, Boolean(enabled));
    if (ok) await logAction({ customer_id: cid, action_type: 'international_toggled', action_detail: { enabled } });
    return JSON.stringify({ success: ok, international_enabled: enabled });
  },
});

export const convertToEmiTool = defineTool({
  name: 'convert_to_emi',
  description:
    `Convert a transaction to EMI. Requires transaction_id, desired tenure (${EMI_ALLOWED_TENURES.join('/')} months). Checks eligibility: amount >= INR ${EMI_MIN_AMOUNT_INR}, transaction must be SUCCESS status. Interest is ${EMI_RATE_SHORT_PCT}% p.a. for tenures up to ${EMI_SHORT_TENURE_MAX} months and ${EMI_RATE_LONG_PCT}% p.a. beyond that, plus a ${EMI_PROCESSING_FEE_PCT}% processing fee. Returns the new EMI details.`,
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_id: Type.String(),
    tenure_months: Type.Number({ description: `One of: ${EMI_ALLOWED_TENURES.join(', ')}` }),
  }),
  execute: async ({ customer_id, transaction_id, tenure_months }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'convert_to_emi');
    if (verificationBlock) return verificationBlock;

    const tenure = Number(tenure_months);
    if (!(EMI_ALLOWED_TENURES as readonly number[]).includes(tenure)) {
      return JSON.stringify({ success: false, reason: `Tenure must be one of ${EMI_ALLOWED_TENURES.join(', ')} months` });
    }
    const txn = await findCustomerTransaction(cid, String(transaction_id));
    if (!txn) return JSON.stringify({ success: false, reason: 'Transaction not found' });
    if (txn.status !== 'SUCCESS') return JSON.stringify({ success: false, reason: 'Only successful transactions can be converted to EMI' });
    if (txn.amount < EMI_MIN_AMOUNT_INR) return JSON.stringify({ success: false, reason: `Minimum amount for EMI conversion is INR ${EMI_MIN_AMOUNT_INR.toLocaleString('en-IN')}` });

    const rate = tenure <= EMI_SHORT_TENURE_MAX ? EMI_RATE_SHORT_PCT : EMI_RATE_LONG_PCT;
    const monthlyRate = rate / 12 / 100;
    const emi = Math.round((txn.amount * monthlyRate * Math.pow(1 + monthlyRate, tenure)) / (Math.pow(1 + monthlyRate, tenure) - 1));
    const processingFee = Math.round(txn.amount * (EMI_PROCESSING_FEE_PCT / 100));

    const emiId = await createEmi({
      customer_id: cid, transaction_id: txn.id, merchant: txn.merchant,
      principal_amount: txn.amount, tenure_months: tenure, interest_rate: rate,
      monthly_installment: emi, processing_fee: processingFee,
    });
    await logAction({ customer_id: cid, action_type: 'emi_converted', action_detail: { emi_id: emiId, transaction_id: txn.id, amount: txn.amount, tenure, emi_amount: emi }, policy_reference: 'POL-004' });
    return JSON.stringify({ success: true, emi_id: emiId, principal: txn.amount, tenure, monthly_installment: emi, interest_rate: rate, processing_fee: processingFee });
  },
});

export const forecloseEmiTool = defineTool({
  name: 'foreclose_emi',
  description: `Close an active EMI early. Charges a ${EMI_FORECLOSURE_PCT}% foreclosure fee on the remaining principal. Provide the EMI ID from get_active_emis.`,
  parameters: Type.Object({
    customer_id: Type.Number(),
    emi_id: Type.String(),
  }),
  execute: async ({ customer_id, emi_id }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'foreclose_emi');
    if (verificationBlock) return verificationBlock;

    const emi = (await getActiveEmis(cid)).find((e: any) => e.id === String(emi_id)) as any;
    if (!emi) return JSON.stringify({ success: false, reason: 'Active EMI not found' });
    const remainingPrincipal = emi.monthly_installment * emi.remaining_installments;
    const foreclosureCharge = Math.round(remainingPrincipal * (emi.foreclosure_charge_pct / 100));
    const ok = await foreclosEmi(String(emi_id));
    if (ok) await logAction({ customer_id: cid, action_type: 'emi_foreclosed', action_detail: { emi_id, remaining_principal: remainingPrincipal, foreclosure_charge: foreclosureCharge }, policy_reference: 'POL-004' });
    return JSON.stringify({ success: ok, emi_id, remaining_principal: remainingPrincipal, foreclosure_charge: foreclosureCharge, total_payable: remainingPrincipal + foreclosureCharge });
  },
});

export const initiateRefundTool = defineTool({
  name: 'initiate_refund',
  description: 'Initiate a refund/reversal for a specific transaction. The transaction must be in SUCCESS status. The refund amount is credited back to the customer\'s available limit.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_id: Type.String(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, transaction_id, reason }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'initiate_refund');
    if (verificationBlock) return verificationBlock;
    const txn = await findCustomerTransaction(cid, String(transaction_id));
    const reject = async (rejectionReason: string) => {
      await logAction({
        customer_id: cid,
        action_type: 'refund_rejected',
        action_detail: {
          transaction_id,
          merchant: txn?.merchant,
          amount: txn?.amount,
          reason: rejectionReason,
        },
        policy_reference: 'POL-001',
      });
      return JSON.stringify({ success: false, transaction_id, reason: rejectionReason });
    };

    if (!txn) return reject('Transaction was not found in this customer account.');
    if (txn.status !== 'SUCCESS') {
      return reject(`Transaction status is ${txn.status}; only successful unsettled charges can be refunded automatically.`);
    }

    const before = await getCustomer(cid);
    const ok = await initiateRefund(String(transaction_id));
    const after = await getCustomer(cid);
    if (!ok) return reject('Refund could not be applied because the transaction was already refunded or no longer eligible.');

    await logAction({
      customer_id: cid,
      action_type: 'refund_initiated',
      action_detail: {
        transaction_id,
        merchant: txn.merchant,
        amount: txn.amount,
        reason,
        previous_available_limit: before?.available_limit,
        new_available_limit: after?.available_limit,
        previous_outstanding_total: before?.outstanding_total,
        new_outstanding_total: after?.outstanding_total,
      },
      policy_reference: 'POL-001',
    });
    return JSON.stringify({
      success: true,
      transaction_id,
      merchant: txn.merchant,
      amount_credited: txn.amount,
      status: 'REFUNDED',
      reason,
      previous_available_limit: before?.available_limit,
      new_available_limit: after?.available_limit,
      previous_outstanding_total: before?.outstanding_total,
      new_outstanding_total: after?.outstanding_total,
      message: `Refund credited immediately for INR ${txn.amount}.`,
    });
  },
});

export const adjustCreditLimitTool = defineTool({
  name: 'adjust_credit_limit',
  description:
    `Increase the customer's credit limit. Policy: customer must have 6+ months vintage, CIBIL ${CREDIT_LIMIT_CIBIL_FLOOR}+, no missed payments in 12 months. Max auto-approved limit is ${CREDIT_LIMIT_AUTO_APPROVE_MULTIPLIER}x the current limit. Requires a VERIFIED CIBIL on the system of record; if none is on file the increase cannot be auto-approved.`,
  parameters: Type.Object({
    customer_id: Type.Number(),
    new_limit: Type.Number({ description: 'The new credit limit in INR' }),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, new_limit, reason }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'adjust_credit_limit');
    if (verificationBlock) return verificationBlock;

    const c = await getCustomer(cid);
    if (!c) return JSON.stringify({ success: false, reason: 'Customer not found' });
    const nl = Number(new_limit);
    const maxAutoApproval = Math.round(c.credit_limit * CREDIT_LIMIT_AUTO_APPROVE_MULTIPLIER);
    if (nl > maxAutoApproval) {
      return JSON.stringify({ success: false, reason: `Requested limit INR ${nl} exceeds auto-approval ceiling of INR ${maxAutoApproval}. Needs committee review.` });
    }
    // Fail closed: a missing (null) CIBIL is "unverified", not "passing".
    if (c.cibil_score == null) {
      return JSON.stringify({ success: false, reason: `No verified CIBIL score is on file; a verified CIBIL of ${CREDIT_LIMIT_CIBIL_FLOOR}+ is required for an auto-approved limit increase. Needs committee review.` });
    }
    if (c.cibil_score < CREDIT_LIMIT_CIBIL_FLOOR) {
      return JSON.stringify({ success: false, reason: `CIBIL score ${c.cibil_score} is below the ${CREDIT_LIMIT_CIBIL_FLOOR} minimum for limit increase` });
    }
    const ok = await adjustCreditLimit(cid, nl);
    if (ok) await logAction({ customer_id: cid, action_type: 'credit_limit_adjusted', action_detail: { old_limit: c.credit_limit, new_limit: nl, reason }, policy_reference: 'POL-009' });
    return JSON.stringify({ success: ok, old_limit: c.credit_limit, new_limit: nl });
  },
});

export const initiateCardClosureTool = defineTool({
  name: 'initiate_card_closure',
  description:
    'Begin the card closure process. This is IRREVERSIBLE. Checks for outstanding balance, active EMIs, and unredeemed rewards before proceeding. RBI mandates closure within 7 working days.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    confirmation: Type.String({ description: 'Must be "CONFIRMED" to proceed' }),
  }),
  execute: async ({ customer_id, confirmation }) => {
    if (String(confirmation) !== 'CONFIRMED') {
      return JSON.stringify({ success: false, reason: 'Customer must confirm closure. Set confirmation to "CONFIRMED".' });
    }
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'initiate_card_closure');
    if (verificationBlock) return verificationBlock;
    const c = await getCustomer(cid);
    if (!c) return JSON.stringify({ success: false, reason: 'Customer not found' });
    const activeEmis = await getActiveEmis(cid);
    if ((activeEmis as any[]).length > 0) {
      return JSON.stringify({ success: false, reason: `Cannot close card: ${(activeEmis as any[]).length} active EMI(s) must be foreclosed first`, active_emis: activeEmis });
    }
    if (c.outstanding_total > 0) {
      return JSON.stringify({ success: false, reason: `Cannot close card: outstanding balance of INR ${c.outstanding_total} must be cleared first` });
    }
    const ok = await updateCardStatus(cid, 'closed');
    if (ok) await logAction({ customer_id: cid, action_type: 'card_closure_initiated', action_detail: { reward_points_forfeited: c.reward_points_balance }, policy_reference: 'POL-010' });
    return JSON.stringify({ success: ok, message: 'Card closure initiated. Confirmation will be sent within 7 working days per RBI mandate.' });
  },
});

export const createEscalationTool = defineTool({
  name: 'create_escalation',
  description:
    'Escalate an issue to the internal human agent dashboard. Use this only when the issue cannot be resolved by AI (fraud investigation, chargebacks, complex disputes). Returns the escalation reference number.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    category: Type.String(),
    priority: Type.String({ description: 'Low | Medium | High | Critical' }),
    assigned_team: Type.String({ description: 'Disputes Operations | Fraud Operations | Card Operations | Customer Service | Risk Operations' }),
    summary: Type.String({ description: 'Brief summary of the issue' }),
    investigation: Type.String({ description: 'What was investigated and found' }),
    recommended_action: Type.String({ description: 'What the human agent should do' }),
  }),
  execute: async (args) => {
    const id = await createEscalation({
      customer_id: Number(args.customer_id),
      category: String(args.category),
      priority: String(args.priority),
      assigned_team: String(args.assigned_team),
      summary: String(args.summary),
      investigation: String(args.investigation),
      recommended_action: String(args.recommended_action),
    });
    await logAction({
      customer_id: Number(args.customer_id),
      action_type: 'escalation_created',
      action_detail: { escalation_id: id, category: args.category, team: args.assigned_team },
    });
    return JSON.stringify({ escalation_id: id, status: 'open', message: `Issue escalated to ${args.assigned_team}. Reference: ${id}` });
  },
});

export const getStatementsTool = defineTool({
  name: 'get_statements',
  description:
    'Get the customer\'s monthly card statements (newest first). Each shows the billing period, purchases, fees, finance charges, GST, total due, minimum due, due date, reward points earned, and whether/when it was paid.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    limit: Type.Optional(Type.Number({ description: 'Max statements, default 6' })),
  }),
  execute: async ({ customer_id, limit }) => {
    const cid = Number(customer_id);
    const live = await tryLinkedRead(cid, (b) => hyperfaceProvider.statements(b.accountId));
    if (live.live) {
      return JSON.stringify({ source: 'live_provider', statements: live.data });
    }
    return liveUnavailable('statements', live.note);
  },
});

export const setCardControlTool = defineTool({
  name: 'set_card_control',
  description:
    'Enable or disable a card usage channel: online_enabled, pos_enabled, contactless_enabled, atm_enabled, or international_enabled. Takes effect immediately.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    control: Type.String({ description: 'online_enabled | pos_enabled | contactless_enabled | atm_enabled | international_enabled' }),
    enabled: Type.Boolean(),
  }),
  execute: async ({ customer_id, control, enabled }) => {
    const cid = Number(customer_id);
    const ok = await setCardControl(cid, String(control), Boolean(enabled));
    if (!ok) return JSON.stringify({ success: false, reason: `Unknown control "${control}"` });
    await logAction({
      customer_id: cid,
      action_type: 'card_control_updated',
      action_detail: { control: String(control), enabled: Boolean(enabled) },
    });
    return JSON.stringify({ success: true, control, enabled });
  },
});

export const setAutopayTool = defineTool({
  name: 'set_autopay',
  description:
    'Enable or disable autopay on the card, and choose the mode: "minimum_due" (pay minimum automatically) or "total_due" (pay full statement automatically). Debits the registered bank account on the due date.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    enabled: Type.Boolean(),
    mode: Type.Optional(Type.String({ description: 'minimum_due | total_due' })),
  }),
  execute: async ({ customer_id, enabled, mode }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'set_autopay');
    if (verificationBlock) return verificationBlock;

    const cleanMode = String(mode ?? 'minimum_due');
    const ok = await setAutopay(cid, Boolean(enabled), cleanMode);
    if (ok) {
      await logAction({
        customer_id: cid,
        action_type: 'autopay_updated',
        action_detail: { enabled: Boolean(enabled), mode: cleanMode },
      });
    }
    return JSON.stringify({ success: ok, enabled, mode: cleanMode });
  },
});

export const getSubscriptionsTool = defineTool({
  name: 'get_subscriptions',
  description:
    'List the customer\'s subscriptions and recurring payments running on card autopay (e-mandates / standing instructions). Each shows merchant, plan, amount, billing cycle, next charge date, and status (active/cancelled), plus the approximate monthly total. Use for "what subscriptions am I paying for" questions and to find the right mandate before cancelling one.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const rows = await getSubscriptions(Number(customer_id)) as any[];
    const active = rows.filter((s) => s.status === 'active');
    const monthlyTotal = active.reduce(
      (sum, s) => sum + (s.billing_cycle === 'annual' ? Math.round(s.amount / 12) : s.amount), 0,
    );
    return JSON.stringify({
      source: SOURCE_RECORDS_ON_FILE,
      source_note: 'from records on file (no live mandate/standing-instruction feed connected)',
      count: rows.length,
      active_count: active.length,
      approx_monthly_total_inr: monthlyTotal,
      subscriptions: rows,
    });
  },
});

export const cancelSubscriptionTool = defineTool({
  name: 'cancel_subscription',
  description:
    'Cancel a subscription\'s recurring autopay mandate on the card so it is never charged again. Provide the subscription ID from get_subscriptions. Effective immediately per the RBI e-mandate framework; any already-paid period stays usable until it ends. This does NOT refund past charges; use initiate_refund or raise_dispute ("Cancelled subscription still charged") for those.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    subscription_id: Type.String({ description: 'The subscription ID from get_subscriptions, e.g. SUB-0012' }),
    reason: Type.String({ description: 'Why the customer is cancelling' }),
  }),
  execute: async ({ customer_id, subscription_id, reason }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'cancel_subscription');
    if (verificationBlock) return verificationBlock;
    const result = await cancelSubscription(cid, String(subscription_id));
    if (result.success) {
      await logAction({
        customer_id: cid,
        action_type: 'subscription_cancelled',
        action_detail: {
          subscription_id: result.subscription_id,
          merchant: result.merchant,
          plan: result.plan,
          amount: result.amount,
          billing_cycle: result.billing_cycle,
          reason,
        },
        policy_reference: 'RBI e-mandate framework',
      });
    }
    return JSON.stringify(result);
  },
});

export const getEmandatesTool = defineTool({
  name: 'get_active_emandates',
  description:
    'List the customer\'s card e-mandates (recurring standing instructions / autopays) as mandate-shaped objects, not plain subscriptions. Built from the real subscription state Kriya holds (merchant, amount, billing cycle, next charge, cancellation). Fields Kriya does NOT have a source for — the registered mandate_cap_inr, afa_status, registered validity end, and pre-debit notification specifics — are returned as null/"unknown" and must NOT be presented as verified registered terms. The mandate_id is an internal Kriya reference, not a registry id. A separate rbi_policy block carries GENERAL RBI policy (AFA-free limits, no-customer-fee rule) that applies generally, not this mandate\'s verified terms. Use this for "what autopays/mandates are active?" and before cancelling one.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const subs = await getSubscriptions(Number(customer_id)) as any[];
    const mandates = subs.map(toEMandate);
    const active = mandates.filter((m) => m.cancellation_status === 'active');
    const monthly = active.reduce((s, m) => s + (m.billing_cycle === 'annual' ? Math.round(m.amount / 12) : m.amount), 0);
    return JSON.stringify({
      source: SOURCE_RECORDS_ON_FILE,
      source_note: 'mandates are built from subscription records on file (no live mandate-registry feed connected); fields shown as null/"unknown" are not held by Kriya and are not verified registered terms',
      count: mandates.length,
      active_count: active.length,
      approx_monthly_total_inr: monthly,
      // General RBI policy reference — applies generally, NOT this mandate's verified registered terms.
      rbi_policy: {
        note: 'General RBI e-mandate policy for reference only; these are NOT the verified registered terms of the mandates above.',
        afa_free_recurring_limit_inr: {
          general: AFA_FREE_LIMIT_GENERAL_INR,
          insurance_mutualfund_creditcardbill: AFA_FREE_LIMIT_HIGH_INR,
        },
        customer_fee_policy: 'No customer fee for e-mandate setup, debit, or cancellation (RBI).',
      },
      mandates,
    });
  },
});

export const cancelEmandateTool = defineTool({
  name: 'cancel_emandate',
  description:
    'Cancel / opt out of a card e-mandate (RBI standing instruction) by its subscription_id from get_active_emandates. Revokes all future auto-debits immediately, charges the customer no fee, records a mandate cancellation event, and returns a structured cancellation_receipt. Does NOT refund past charges; use initiate_refund or raise_dispute for those. Run check_emandate_cancellation_eligibility first.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    subscription_id: Type.String({ description: 'The subscription_id / mandate from get_active_emandates, e.g. SUB-0012' }),
    reason: Type.String({ description: 'Why the customer is cancelling' }),
  }),
  execute: async ({ customer_id, subscription_id, reason }) => {
    const cid = Number(customer_id);
    const verificationBlock = await requireVerified(cid, 'cancel_emandate');
    if (verificationBlock) return verificationBlock;
    // Snapshot the live mandate first so the receipt reflects pre-cancel state.
    const subs = await getSubscriptions(cid) as any[];
    const sub = subs.find((s) => String(s.id) === String(subscription_id));
    if (!sub) return JSON.stringify({ success: false, reason: 'Mandate not found on this card' });
    const mandate = toEMandate(sub);
    const result = await cancelSubscription(cid, String(subscription_id));
    if (!result.success) return JSON.stringify({ success: false, reason: result.reason });

    const receipt = buildCancellationReceipt(mandate, result.next_charge_avoided ?? null);
    await logAction({
      customer_id: cid,
      action_type: 'subscription_cancelled',
      action_detail: {
        mandate_event: 'mandate_cancelled',
        internal_mandate_reference: mandate.mandate_id,
        subscription_id: result.subscription_id,
        merchant: result.merchant,
        merchant_category: mandate.merchant_category,
        plan: result.plan,
        amount: result.amount,
        billing_cycle: result.billing_cycle,
        next_debit_cancelled: receipt.next_debit_cancelled,
        cancellation_internal_reference: receipt.internal_reference,
        customer_fee_inr: 0,
        reason,
      },
      policy_reference: 'RBI e-mandate framework (recurring standing instructions)',
    });
    return JSON.stringify({
      success: true,
      internal_mandate_reference: mandate.mandate_id,
      cancellation_status: 'cancelled',
      cancellation_receipt: receipt,
    });
  },
});

export const setConversationStateTool = defineTool({
  name: 'set_conversation_state',
  description:
    'Explicitly declare the wait state of the conversation. Call this when you are asking the customer for confirmation of an action (e.g. fee waiver, card block, card closure) or asking them to select/provide an EMI tenure, so the system can set the next turn context appropriately.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    state: Type.String({ description: 'The current wait state. Allowed values: "waiting_for_confirmation", "waiting_for_emi_tenure", "none"' }),
  }),
  execute: async ({ customer_id, state }) => {
    const cid = Number(customer_id);
    await logAction({
      customer_id: cid,
      action_type: 'conversation_state_updated',
      action_detail: { state },
    });
    return JSON.stringify({ success: true, state });
  },
});


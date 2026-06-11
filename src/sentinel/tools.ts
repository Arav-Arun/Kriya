import { defineTool, Type } from '@flue/runtime';
import {
  getCustomer, getTransactions, getPaymentHistory, getPaymentSummary,
  getFeesAndCharges, getUnwaivedFees, getRecentWaivers, waiveFee,
  updateCustomerContext, createCustomerTransaction,
  getActiveEmis, foreclosEmi, createEmi,
  updateCardStatus, toggleInternational, adjustCreditLimit, redeemRewards,
  initiateRefund, searchCases, createEscalation, logAction,
  getStatements, setCardControl, setAutopay,
  getDisputes, createDispute, getSubscriptions, cancelSubscription,
} from '../lib/sentinel-db.ts';
import { searchPolicies, TEAM_BY_CATEGORY } from '../lib/knowledge.ts';
import { POLICY_TOOLS } from './policy.ts';
import { toEMandate, buildCancellationReceipt } from '../lib/emandates.ts';

// ── Read-only tools ───────────────────────────────────────────────────

export const getCustomerProfileTool = defineTool({
  name: 'get_customer_profile',
  description:
    'Get the full profile of the currently authenticated customer: name, card details, credit limit, outstanding balance, CIBIL score, reward points, KYC status, and a payment behavior summary.',
  parameters: Type.Object({
    customer_id: Type.Number(),
  }),
  execute: async ({ customer_id }) => {
    const c = await getCustomer(Number(customer_id));
    if (!c) return JSON.stringify({ error: 'Customer not found' });
    const summary = await getPaymentSummary(c.id);
    return JSON.stringify({
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      card_last4: c.card_number_last4, card_variant: c.card_variant,
      card_status: c.card_status, card_issued_on: c.card_issued_on,
      credit_limit: c.credit_limit, available_limit: c.available_limit,
      outstanding_total: c.outstanding_total, minimum_due: c.minimum_due,
      due_date: c.due_date, cibil_score: c.cibil_score, risk_score: c.risk_score,
      reward_points: c.reward_points_balance,
      international_enabled: c.international_enabled === 1,
      kyc_status: c.kyc_status, kyc_expiry: c.kyc_expiry,
      payment_summary: summary,
    });
  },
});

export const getTransactionsTool = defineTool({
  name: 'get_transactions',
  description:
    'Fetch the customer\'s most recent card transactions (newest first). Optionally filter by merchant name. Each row has id, timestamp, merchant, category, amount, currency, channel, location, status, decline_reason.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    merchant: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number({ description: 'Max rows, default 30, max 100' })),
  }),
  execute: async ({ customer_id, merchant, limit }) => {
    const rows = await getTransactions(Number(customer_id), {
      merchant: merchant ? String(merchant) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return JSON.stringify({ count: rows.length, transactions: rows });
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
    return JSON.stringify({ count: rows.length, payments: rows });
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
    return JSON.stringify({
      outstanding_total: c.outstanding_total,
      outstanding_billed: c.outstanding_billed,
      minimum_due: c.minimum_due,
      due_date: c.due_date,
      credit_limit: c.credit_limit,
      available_limit: c.available_limit,
    });
  },
});

export const getRewardPointsTool = defineTool({
  name: 'get_reward_points',
  description: 'Get the customer\'s current reward points balance. Points can be redeemed as statement credit at 1 point = INR 0.25.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const c = await getCustomer(Number(customer_id));
    if (!c) return JSON.stringify({ error: 'Customer not found' });
    return JSON.stringify({
      balance: c.reward_points_balance,
      value_inr: Math.round(c.reward_points_balance * 0.25),
    });
  },
});

export const getActiveEmisTool = defineTool({
  name: 'get_active_emis',
  description: 'Get all active EMI plans for the customer, including merchant, amount, tenure, monthly installment, remaining installments, and foreclosure terms.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const rows = await getActiveEmis(Number(customer_id));
    return JSON.stringify({ count: rows.length, emis: rows });
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
    return JSON.stringify({ count: rows.length, fees: rows });
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

export const searchSimilarCasesTool = defineTool({
  name: 'search_similar_cases',
  description:
    'Search 100 resolved historical cases by keywords. Returns matching cases with complaint, investigation findings, resolution, team, and resolution time.',
  parameters: Type.Object({
    query: Type.String(),
    category: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number({ description: 'Max cases, default 5' })),
  }),
  execute: async ({ query, category, limit }) => {
    const rows = await searchCases(String(query), {
      category: category ? String(category) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return JSON.stringify({ count: rows.length, cases: rows });
  },
});

export const recordCustomerContextTool = defineTool({
  name: 'record_customer_context',
  description:
    'Save account context the customer provided in chat, such as statement amounts, payment record, late fee amount, days late, card status, reward points, or international usage. Use this whenever required data was missing and the customer supplies it in the conversation, then continue resolving the issue.',
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
      cibil_score: args.cibil_score,
      on_time_payments: args.on_time_payments,
      late_payments: args.late_payments,
      late_fee_amount: args.late_fee_amount,
      days_late: args.days_late,
    });
    if (ok) {
      await logAction({
        customer_id: cid,
        action_type: 'context_recorded',
        action_detail: { note: args.note ?? 'Customer-provided account context recorded' },
      });
    }
    return JSON.stringify({ success: ok });
  },
});

export const recordCustomerTransactionTool = defineTool({
  name: 'record_customer_transaction',
  description:
    'Save a transaction the customer provided in chat. Use this when a fresh customer has no transaction history and gives the merchant, amount, date/time, or status needed for a refund, dispute, fraud report, or EMI conversion. This creates a local transaction record so other action tools can operate on it.',
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
          transaction_id: txn.id,
          merchant: txn.merchant,
          amount: txn.amount,
          status: txn.status,
          note: args.note ?? 'Customer-provided transaction recorded',
        },
      });
    }
    return JSON.stringify({ success: Boolean(txn), transaction: txn });
  },
});

export const getDisputesTool = defineTool({
  name: 'get_disputes',
  description:
    'Get the customer\'s dispute/chargeback history and status. Each dispute shows the transaction, merchant, amount, reason, status (under_review/provisional_credit/won/lost), whether provisional credit was issued, and the resolution note. Use for "what happened to my dispute" questions and to avoid raising a duplicate dispute.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const rows = await getDisputes(Number(customer_id), 20);
    return JSON.stringify({ count: rows.length, disputes: rows });
  },
});


// ── Action tools ──────────────────────────────────────────────────────

export const raiseDisputeTool = defineTool({
  name: 'raise_dispute',
  description:
    'Raise a formal dispute/chargeback on a transaction when an instant refund is not possible (merchant dispute, goods not received, amount mismatch, unauthorized charge already reported). The transaction must be SUCCESS status and not already disputed. Per RBI timelines, provisional credit is assessed within 7 working days and resolution within 30-45 days. Returns the dispute reference ID.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_id: Type.String(),
    reason: Type.String({ description: 'e.g. Unauthorized transaction | Duplicate processing | Goods or services not received | Amount differs from receipt | Cancelled subscription still charged' }),
  }),
  execute: async ({ customer_id, transaction_id, reason }) => {
    const cid = Number(customer_id);
    const txns = await getTransactions(cid, { limit: 100 }) as any[];
    const txn = txns.find((t) => t.id === String(transaction_id));
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
      message: `Dispute ${id} raised. Provisional credit is assessed within 7 working days; final resolution within 30-45 days per RBI guidelines.`,
    });
  },
});

export const waiveFeeTool = defineTool({
  name: 'waive_fee',
  description:
    'Waive a specific fee for the customer. Policy guard: max 1 waiver per 12 months, max INR 1000. Provide the fee ID from get_fees_and_charges. Returns success/failure with reason.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    fee_id: Type.Number({ description: 'The fee ID from get_fees_and_charges' }),
    reason: Type.String({ description: 'Why the fee is being waived' }),
  }),
  execute: async ({ customer_id, fee_id, reason }) => {
    const cid = Number(customer_id);
    const recentWaivers = await getRecentWaivers(cid, 12);
    if (recentWaivers.length > 0) {
      return JSON.stringify({ success: false, reason: 'Customer already received a fee waiver in the last 12 months' });
    }
    const unwaivedFees = await getUnwaivedFees(cid);
    const fee = unwaivedFees.find((f: any) => f.id === Number(fee_id));
    if (!fee) {
      return JSON.stringify({ success: false, reason: 'Fee not found or already waived' });
    }
    if ((fee as any).amount > 1000) {
      return JSON.stringify({ success: false, reason: `Fee amount INR ${(fee as any).amount} exceeds the INR 1000 auto-waiver limit` });
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
          previous_minimum_due: result.previous_minimum_due,
          new_minimum_due: result.new_minimum_due,
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
    const ok = await updateCardStatus(cid, 'active');
    if (ok) await logAction({ customer_id: cid, action_type: 'card_unblocked', action_detail: { reason } });
    return JSON.stringify({ success: ok, new_status: 'active' });
  },
});

export const hotlistCardTool = defineTool({
  name: 'hotlist_card',
  description: 'Permanently disable the customer\'s card (hotlist). This is IRREVERSIBLE — use only for lost/stolen cards after confirming with the customer.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, reason }) => {
    const cid = Number(customer_id);
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
    const ok = await toggleInternational(cid, Boolean(enabled));
    if (ok) await logAction({ customer_id: cid, action_type: 'international_toggled', action_detail: { enabled } });
    return JSON.stringify({ success: ok, international_enabled: enabled });
  },
});

export const convertToEmiTool = defineTool({
  name: 'convert_to_emi',
  description:
    'Convert a transaction to EMI. Requires transaction_id, desired tenure (3/6/9/12 months). Checks eligibility: amount >= 2500 INR, transaction must be SUCCESS status. Returns the new EMI details.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_id: Type.String(),
    tenure_months: Type.Number({ description: '3, 6, 9, or 12' }),
  }),
  execute: async ({ customer_id, transaction_id, tenure_months }) => {
    const cid = Number(customer_id);
    const tenure = Number(tenure_months);
    if (![3, 6, 9, 12].includes(tenure)) {
      return JSON.stringify({ success: false, reason: 'Tenure must be 3, 6, 9, or 12 months' });
    }
    const txns = await getTransactions(cid, { limit: 100 });
    const txn = (txns as any[]).find((t) => t.id === String(transaction_id));
    if (!txn) return JSON.stringify({ success: false, reason: 'Transaction not found' });
    if (txn.status !== 'SUCCESS') return JSON.stringify({ success: false, reason: 'Only successful transactions can be converted to EMI' });
    if (txn.amount < 2500) return JSON.stringify({ success: false, reason: 'Minimum amount for EMI conversion is INR 2,500' });

    const rate = tenure <= 6 ? 14 : 16;
    const monthlyRate = rate / 12 / 100;
    const emi = Math.round((txn.amount * monthlyRate * Math.pow(1 + monthlyRate, tenure)) / (Math.pow(1 + monthlyRate, tenure) - 1));
    const processingFee = Math.round(txn.amount * 0.01);

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
  description: 'Close an active EMI early. Charges a 3% foreclosure fee on the remaining principal. Provide the EMI ID from get_active_emis.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    emi_id: Type.String(),
  }),
  execute: async ({ customer_id, emi_id }) => {
    const cid = Number(customer_id);
    const emi = (await getActiveEmis(cid)).find((e: any) => e.id === String(emi_id)) as any;
    if (!emi) return JSON.stringify({ success: false, reason: 'Active EMI not found' });
    const remainingPrincipal = emi.monthly_installment * emi.remaining_installments;
    const foreclosureCharge = Math.round(remainingPrincipal * (emi.foreclosure_charge_pct / 100));
    const ok = await foreclosEmi(String(emi_id));
    if (ok) await logAction({ customer_id: cid, action_type: 'emi_foreclosed', action_detail: { emi_id, remaining_principal: remainingPrincipal, foreclosure_charge: foreclosureCharge }, policy_reference: 'POL-004' });
    return JSON.stringify({ success: ok, emi_id, remaining_principal: remainingPrincipal, foreclosure_charge: foreclosureCharge, total_payable: remainingPrincipal + foreclosureCharge });
  },
});

export const redeemRewardsTool = defineTool({
  name: 'redeem_rewards',
  description: 'Redeem reward points as statement credit. 1 point = INR 0.25. Minimum redemption: 500 points.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    points: Type.Number({ description: 'Number of points to redeem' }),
  }),
  execute: async ({ customer_id, points }) => {
    const cid = Number(customer_id);
    const pts = Number(points);
    if (pts < 500) return JSON.stringify({ success: false, reason: 'Minimum redemption is 500 points' });
    const ok = await redeemRewards(cid, pts);
    if (!ok) return JSON.stringify({ success: false, reason: 'Insufficient points balance' });
    const value = Math.round(pts * 0.25);
    await logAction({ customer_id: cid, action_type: 'rewards_redeemed', action_detail: { points: pts, value_inr: value } });
    return JSON.stringify({ success: true, points_redeemed: pts, credit_amount_inr: value });
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
    const txns = await getTransactions(cid, { limit: 100 }) as any[];
    const txn = txns.find((t) => t.id === String(transaction_id));
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
    'Increase the customer\'s credit limit. Policy: customer must have 6+ months vintage, CIBIL 730+, no missed payments in 12 months. Max increase is 50% of current limit for auto-approval.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    new_limit: Type.Number({ description: 'The new credit limit in INR' }),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, new_limit, reason }) => {
    const cid = Number(customer_id);
    const c = await getCustomer(cid);
    if (!c) return JSON.stringify({ success: false, reason: 'Customer not found' });
    const nl = Number(new_limit);
    const maxAutoApproval = Math.round(c.credit_limit * 1.5);
    if (nl > maxAutoApproval) {
      return JSON.stringify({ success: false, reason: `Requested limit INR ${nl} exceeds auto-approval ceiling of INR ${maxAutoApproval}. Needs committee review.` });
    }
    if (c.cibil_score < 730) {
      return JSON.stringify({ success: false, reason: `CIBIL score ${c.cibil_score} is below the 730 minimum for limit increase` });
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
    const rows = await getStatements(Number(customer_id), limit ? Number(limit) : 6);
    return JSON.stringify({ count: rows.length, statements: rows });
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
    'Cancel a subscription\'s recurring autopay mandate on the card so it is never charged again. Provide the subscription ID from get_subscriptions. Effective immediately per the RBI e-mandate framework; any already-paid period stays usable until it ends. This does NOT refund past charges — use initiate_refund or raise_dispute ("Cancelled subscription still charged") for those.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    subscription_id: Type.String({ description: 'The subscription ID from get_subscriptions, e.g. SUB-0012' }),
    reason: Type.String({ description: 'Why the customer is cancelling' }),
  }),
  execute: async ({ customer_id, subscription_id, reason }) => {
    const cid = Number(customer_id);
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
    'List the customer\'s card e-mandates (RBI recurring standing instructions / autopays) as full mandate objects, not plain subscriptions. Each includes mandate_id, merchant_category, mandate_cap_inr, afa_status, afa_free_recurring_limit_inr (₹15,000 generally, ₹1,00,000 for insurance/mutual funds/credit-card bills), validity_period, next_debit (with afa_required), the 24-hour pre_debit_notification, opt_out rights, cancellation_status, and customer_fee_inr (always 0). Use this for "what autopays/mandates are active?" and before cancelling one.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const subs = await getSubscriptions(Number(customer_id)) as any[];
    const mandates = subs.map(toEMandate);
    const active = mandates.filter((m) => m.cancellation_status === 'active');
    const monthly = active.reduce((s, m) => s + (m.billing_cycle === 'annual' ? Math.round(m.amount / 12) : m.amount), 0);
    return JSON.stringify({
      count: mandates.length,
      active_count: active.length,
      approx_monthly_total_inr: monthly,
      afa_free_recurring_limit_inr: { general: 15000, insurance_mutualfund_creditcardbill: 100000 },
      customer_fee_policy: 'No customer fee for e-mandate setup, debit, or cancellation (RBI).',
      mandates,
    });
  },
});

export const cancelEmandateTool = defineTool({
  name: 'cancel_emandate',
  description:
    'Cancel / opt out of a card e-mandate (RBI standing instruction) by its subscription_id from get_active_emandates. Revokes all future auto-debits immediately, charges the customer no fee, records a mandate cancellation event, and returns a structured cancellation_receipt. Does NOT refund past charges — use initiate_refund or raise_dispute for those. Run check_emandate_cancellation_eligibility first.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    subscription_id: Type.String({ description: 'The subscription_id / mandate from get_active_emandates, e.g. SUB-0012' }),
    reason: Type.String({ description: 'Why the customer is cancelling' }),
  }),
  execute: async ({ customer_id, subscription_id, reason }) => {
    const cid = Number(customer_id);
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
        mandate_id: mandate.mandate_id,
        subscription_id: result.subscription_id,
        merchant: result.merchant,
        merchant_category: mandate.merchant_category,
        plan: result.plan,
        amount: result.amount,
        billing_cycle: result.billing_cycle,
        next_debit_cancelled: receipt.next_debit_cancelled,
        cancellation_receipt: receipt.receipt_id,
        customer_fee_inr: 0,
        reason,
      },
      policy_reference: 'RBI e-mandate framework (recurring standing instructions)',
    });
    return JSON.stringify({ success: true, mandate_id: mandate.mandate_id, cancellation_status: 'cancelled', cancellation_receipt: receipt });
  },
});

export const ALL_TOOLS = [
  getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
  getOutstandingBalanceTool, getRewardPointsTool, getActiveEmisTool,
  getFeesAndChargesTool, searchPolicyTool, searchSimilarCasesTool,
  recordCustomerContextTool, recordCustomerTransactionTool,
  getStatementsTool, getDisputesTool, getSubscriptionsTool,
  getEmandatesTool, cancelEmandateTool,
  waiveFeeTool, blockCardTool, unblockCardTool, hotlistCardTool,
  toggleInternationalTool, setCardControlTool, setAutopayTool,
  convertToEmiTool, forecloseEmiTool, raiseDisputeTool,
  redeemRewardsTool, initiateRefundTool, adjustCreditLimitTool,
  initiateCardClosureTool, createEscalationTool, cancelSubscriptionTool,
  // Deterministic policy gates — the LLM must call these before sensitive actions.
  ...POLICY_TOOLS,
];

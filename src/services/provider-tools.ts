// Live card-provider tools (Hyperface UAT). These sit beside the synthetic
// data tools in tools.ts: the agent uses live tools when the provider is
// enabled and falls back to account records on file when a feed is pending
// bank-side enablement (PERMISSION_PENDING) or the provider is down.
//
// Binding: a Kriya customer is linked to a live Hyperface account ONLY by
// looking up their registered mobile number in the provider
// (POST /customers/lookup; via:'phone_lookup'). HYPERFACE_TEST_ACCOUNT_ID (a
// known UAT sample account) may also produce a binding (via:'demo_env'), but
// that shared account is NEVER served through customer-facing reads — doing so
// would present one test account's real balance/limits/transactions as the
// asking customer's own data. The demo binding exists only so that binding
// *inspection* (get_live_account_link) can report "no real match" without the
// provider lookup, and is otherwise inert for reads.
import { defineTool, Type } from '@flue/runtime';
import { config } from '../config/env.ts';
import { hyperfaceProvider } from '../providers/hyperface.ts';
import type { ProviderResult } from '../providers/types.ts';
import { getCustomer, logAction } from '../database/queries.ts';
import { phoneKey } from '../channels/types.ts';
import { assertActionAllowed } from './verify.ts';

const liveEnabled = () => config.providerMode === 'hyperface_uat' && hyperfaceProvider.configured;

// Customer to live account binding

export interface LiveBinding {
  /** Provider customer id. Null for a demo_env binding when no test customer id
   *  is configured — fetchCustomer-based tools must short-circuit, never call
   *  the provider with a synthesized id. */
  hyperfaceCustomerId: string | null;
  accountId: string;
  cardId: string | null;
  via: 'phone_lookup' | 'demo_env';
  demo: boolean;
}

const bindingCache = new Map<number, { at: number; binding: LiveBinding | null }>();
const BINDING_TTL_MS = 10 * 60_000;

export async function resolveLiveBinding(customerId: number): Promise<LiveBinding | null> {
  if (!liveEnabled()) return null;
  const cached = bindingCache.get(customerId);
  if (cached && Date.now() - cached.at < BINDING_TTL_MS) return cached.binding;

  let binding: LiveBinding | null = null;
  const customer = await getCustomer(customerId);
  const phone = phoneKey(String(customer?.phone ?? ''));
  if (phone.length === 10) {
    let match: any = null;
    const res = await hyperfaceProvider.lookupCustomer({ mobileNumber: phone });
    if (res.ok && res.data.length > 0) {
      match = res.data[0];
    } else {
      const issuerRes = await hyperfaceProvider.fetchIssuerCustomer({ mobileNumber: phone });
      if (issuerRes.ok && issuerRes.data) {
        const data = issuerRes.data as any;
        const customer = Array.isArray(data) ? data[0] : data;
        if (customer && (customer.customerId || customer.id)) {
          match = {
            customerId: customer.customerId || customer.id,
            accounts: customer.accounts || [],
          };
        }
      }
    }

    if (match) {
      const account = match.accounts.find((a: any) => a.status === 'ACTIVE') ?? match.accounts[0];
      if (account) {
        binding = {
          hyperfaceCustomerId: match.customerId,
          accountId: account.id,
          cardId: account.cards[0]?.id ?? null,
          via: 'phone_lookup',
          demo: false,
        };
      }
    }
  }
  if (!binding && config.hyperface.testAccountId) {
    binding = {
      // Leave null when no test customer id is configured. Tools must never
      // call fetchCustomer with a fabricated id.
      hyperfaceCustomerId: config.hyperface.testCustomerId ?? null,
      accountId: config.hyperface.testAccountId,
      cardId: config.hyperface.testCardId ?? null,
      via: 'demo_env',
      demo: true,
    };
  }
  bindingCache.set(customerId, { at: Date.now(), binding });
  return binding;
}

/** Drop the cached binding (after provisioning or re-linking a customer). */
export function invalidateLiveBinding(customerId: number): void {
  bindingCache.delete(customerId);
}

/**
 * A binding is usable for serving real customer-facing data ONLY when it came
 * from a phone-number match. The shared demo_env account must never surface as
 * the asking customer's balance/limits/transactions/profile, so every
 * customer-facing read funnels through this single check. A newly-added
 * get_live_* tool that uses withBinding/tryLinkedRead inherits the guard and
 * cannot silently re-introduce the cross-customer leak.
 */
function isServableBinding(binding: LiveBinding | null | undefined, customerPhone?: string | null): boolean {
  if (!binding) return false;
  if (binding.via === 'phone_lookup') return true;
  if (binding.via === 'demo_env' && customerPhone && config.demoPhone) {
    return phoneKey(customerPhone) === phoneKey(config.demoPhone);
  }
  return false;
}

// Centralized response copy
// Named constants for the scattered fallback/disabled messages so wording is
// consistent and reviewable in one place.

const MSG = {
  /** Live mode is off entirely. */
  DISABLED:
    'Live provider mode is off (KRIYA_PROVIDER_MODE=synthetic). Use the account records on file.',
  /** No phone-matched live account for this customer. */
  NO_BINDING:
    "No live card account is linked to this customer's registered mobile number.",
  /** Provider feed exists but the bank has not enabled it yet. */
  PERMISSION_PENDING_FALLBACK:
    'This live feed is pending bank-side enablement. Answer from the account records on file (get_* tools) and tell the customer the live sync is being enabled.',
  /** Provider feed exists but the bank has not enabled it yet (terse, for tryLinkedRead notes). */
  PERMISSION_PENDING_NOTE:
    'Live feed pending bank-side enablement; figures below are records on file.',
  /** Provider test environment is unreachable. */
  PROVIDER_DOWN_FALLBACK:
    'The provider test environment is temporarily down. Answer from the account records on file and avoid promising live figures.',
  /** Card writes are off. Must NOT imply the real card account was changed. */
  MUTATIONS_DISABLED_CARD:
    'Live card writes are disabled until the bank confirms a mutation-safe test program, so this was NOT executed on the card system of record — nothing changed on the customer\'s actual card. The request was only recorded in Kriya app state. Use the records-on-file action (block_card/unblock_card/hotlist_card) and tell the customer the live change has not yet been applied.',
  /** Account writes are off. Must NOT imply the real card account was changed. */
  MUTATIONS_DISABLED_ACCOUNT:
    'Live account writes are disabled until the bank confirms a mutation-safe test program, so this was NOT executed on the card system of record — nothing changed on the customer\'s actual account. The request was only recorded in Kriya app state. Use the records-on-file action and tell the customer the live change has not yet been applied.',
} as const;

// Live-first reads for core records tools
// The provider API is the primary data source for any customer whose
// registered mobile number matches a real provider account (phone_lookup).
// The shared demo binding is deliberately excluded from ALL customer-facing
// reads (both these core reads and the explicit get_live_* tools): it is one
// test account, and serving its figures as the asking customer's data would
// be a cross-customer leak. Every customer-facing read uses isServableBinding,
// so a demo_env-only binding behaves exactly like "not linked".

export type LinkedRead =
  | { live: true; data: unknown }
  | { live: false; note?: string };

export async function tryLinkedRead(
  customerId: number,
  fn: (b: LiveBinding) => Promise<ProviderResult<unknown>>,
): Promise<LinkedRead> {
  if (!liveEnabled()) return { live: false };
  const customer = await getCustomer(customerId);
  const binding = await resolveLiveBinding(customerId);
  if (!isServableBinding(binding, customer?.phone)) return { live: false };
  const res = await fn(binding!);
  if (res.ok) return { live: true, data: res.data };
  return {
    live: false,
    note: res.code === 'PERMISSION_PENDING'
      ? MSG.PERMISSION_PENDING_NOTE
      : res.message,
  };
}

/** Live account summary for a phone-linked customer, or null. */
export async function linkedLiveSummary(customerId: number): Promise<import('../providers/types.ts').LiveAccountSummary | null> {
  const r = await tryLinkedRead(customerId, (b) => hyperfaceProvider.accountSummary(b.accountId));
  return r.live ? (r.data as import('../providers/types.ts').LiveAccountSummary) : null;
}

// Result shaping

function disabledJson(): string {
  return JSON.stringify({ live: false, code: 'DISABLED', message: MSG.DISABLED });
}

function noBindingJson(): string {
  return JSON.stringify({ live: false, code: 'NO_BINDING', message: MSG.NO_BINDING });
}

function shape(res: ProviderResult<unknown>, binding?: LiveBinding | null): string {
  if (res.ok) {
    return JSON.stringify({
      live: true,
      source: 'hyperface_uat',
      demo_binding: binding?.demo ?? false,
      data: res.data,
    });
  }
  const fallback = res.code === 'PERMISSION_PENDING'
    ? MSG.PERMISSION_PENDING_FALLBACK
    : res.code === 'PROVIDER_DOWN'
      ? MSG.PROVIDER_DOWN_FALLBACK
      : undefined;
  return JSON.stringify({ live: false, code: res.code, message: res.message, correlation_id: res.correlationId, fallback });
}

/**
 * Customer-facing live read wrapper. Serves provider data ONLY for a
 * phone-matched (servable) binding. A demo_env-only binding is treated exactly
 * like "no link" — it returns NO_BINDING and never reaches the provider — so
 * the shared test account can never be served as the asking customer's data.
 */
async function withBinding(
  customerId: number,
  fn: (b: LiveBinding) => Promise<ProviderResult<unknown>>,
): Promise<string> {
  if (!liveEnabled()) return disabledJson();
  const customer = await getCustomer(customerId);
  const binding = await resolveLiveBinding(customerId);
  if (!isServableBinding(binding, customer?.phone)) return noBindingJson();
  return shape(await fn(binding!), binding);
}

// Read tools

export const getLiveBindingTool = defineTool({
  name: 'get_live_account_link',
  description:
    'Show which live card-provider account this customer is linked to (matched by their registered mobile number). Returns the provider customer/account/card ids. Reports NO_BINDING when no real phone match exists; the shared demo account is never reported as the customer\'s link.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    if (!liveEnabled()) return disabledJson();
    const customer = await getCustomer(Number(customer_id));
    const b = await resolveLiveBinding(Number(customer_id));
    // Only a phone-matched binding is a real link for this customer. A
    // demo_env binding is not this customer's account, so it is not reported.
    return JSON.stringify(isServableBinding(b, customer?.phone) ? { live: true, binding: b } : { live: false, code: 'NO_BINDING', message: MSG.NO_BINDING });
  },
});

export const getLiveAccountOverviewTool = defineTool({
  name: 'get_live_account_overview',
  description:
    'LIVE provider data: full account summary from the card system of record — current balance, approved/available credit limit, cash limit, currency, primary card (masked number, status, locked/hotlisted flags, network) and the registered customer profile. Prefer this over records on file for balance/limit/card-status questions when live mode is on.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.accountSummary(b.accountId)),
});

export const getLiveCardDetailsTool = defineTool({
  name: 'get_live_card_details',
  description: 'LIVE provider data: card detail from the system of record — status, locked/hotlisted flags, expiry, network, issuance state.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) =>
      b.cardId ? hyperfaceProvider.cardDetails(b.cardId)
        : Promise.resolve({ ok: false as const, code: 'NOT_FOUND' as const, message: 'No live card on the linked account.', source: 'hyperface' as const })),
});

export const getLiveCashbackTool = defineTool({
  name: 'get_live_cashback',
  description:
    'LIVE provider data: cashback summary and recent cashback ledger entries for the account within a date range (yyyy-mm-dd). Use for "why didn\'t I get cashback for this transaction" questions.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    start_date: Type.Optional(Type.String({ description: 'yyyy-mm-dd' })),
    end_date: Type.Optional(Type.String({ description: 'yyyy-mm-dd' })),
  }),
  execute: async ({ customer_id, start_date, end_date }) =>
    withBinding(Number(customer_id), async (b) => {
      const range = {
        startDate: start_date ? String(start_date) : undefined,
        endDate: end_date ? String(end_date) : undefined,
      };
      const [summary, txns] = await Promise.all([
        hyperfaceProvider.cashbackSummary(b.accountId, range),
        hyperfaceProvider.cashbackTransactions(b.accountId, range),
      ]);
      if (!summary.ok && !txns.ok) return summary;
      return {
        ok: true as const,
        data: {
          summary: summary.ok ? summary.data : { unavailable: summary.message },
          transactions: txns.ok ? txns.data : { unavailable: txns.message },
        },
        source: 'hyperface' as const,
      };
    }),
});

export const getLiveAccountDetailsTool = defineTool({
  name: 'get_live_account_details',
  description:
    'LIVE provider data: the full account record from the card system of record (product, billing cycle, status, dates) — more detail than the summary. Use when the summary is not enough (billing-cycle/dates/product questions).',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.accountDetails(b.accountId)),
});

export const getLiveUnbilledTool = defineTool({
  name: 'get_live_unbilled',
  description:
    'LIVE provider data: transactions posted but not yet billed in the current cycle (the amount building toward the next statement). Use for "what have I spent this cycle / what will my next bill be" questions.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.unbilledTransactions(b.accountId)),
});

export const getLiveCardControlsTool = defineTool({
  name: 'get_live_card_controls',
  description:
    'LIVE provider data: the current card-control state in the system of record — which usage channels (online/POS/contactless/ATM/international) are enabled and their per-channel limits. Read this before changing controls so you report and toggle from real state.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) =>
      b.cardId ? hyperfaceProvider.cardControls(b.cardId)
        : Promise.resolve({ ok: false as const, code: 'NOT_FOUND' as const, message: 'No live card on the linked account.', source: 'hyperface' as const })),
});

export const getLiveEmiOfferTool = defineTool({
  name: 'get_live_emi_offer',
  description:
    'LIVE provider data: the EMI conversion offer for a purchase — available tenures, interest rate, processing fee and the resulting monthly installment, computed by the card system of record. Call this to quote real EMI terms before live_create_emi. Provide the amount, or the transaction ref id to convert.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    amount: Type.Optional(Type.Number({ description: 'Purchase amount to convert to EMI (pass this OR txn_ref_id)' })),
    txn_ref_id: Type.Optional(Type.String({ description: 'Provider transaction ref id to convert (pass this OR amount)' })),
    emi_type: Type.Optional(Type.String({ description: 'TOTAL_OUTSTANDING or LAST_BILLED_OUTSTANDING — for converting outstanding (not a single purchase) to EMI' })),
  }),
  execute: async ({ customer_id, amount, txn_ref_id, emi_type }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.emiConfig(b.accountId, {
      amount: amount != null ? Number(amount) : undefined,
      txnRefId: txn_ref_id ? String(txn_ref_id) : undefined,
      emiType: emi_type === 'TOTAL_OUTSTANDING' || emi_type === 'LAST_BILLED_OUTSTANDING' ? emi_type : undefined,
    })),
});

export const getLiveRewardsLedgerTool = defineTool({
  name: 'get_live_rewards_ledger',
  description:
    'LIVE provider data: the reward-points ledger — per-entry earn/redeem/expiry lines behind the balance. Use for "why didn\'t I get points for this transaction / where did my points go" questions.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.rewardsLedger(b.accountId)),
});

export const inquireLiveTransactionTool = defineTool({
  name: 'inquire_live_transaction',
  description:
    'LIVE provider data: look up one specific transaction in the card system of record by its provider id or your external reference id. Use to confirm the exact status/amount of a single charge before disputing or refunding it.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    transaction_id: Type.Optional(Type.String({ description: 'Provider transaction id' })),
    external_ref_id: Type.Optional(Type.String({ description: 'External reference id you assigned' })),
  }),
  execute: async ({ customer_id, transaction_id, external_ref_id }) =>
    withBinding(Number(customer_id), () => hyperfaceProvider.transactionInquiry({
      id: transaction_id ? String(transaction_id) : undefined,
      extTxnRefId: external_ref_id ? String(external_ref_id) : undefined,
    })),
});

// Action tools (verification-gated, audited, idempotent)

type LiveCardActionType =
  | 'live_lock_card' | 'live_unlock_card' | 'live_hotlist_card'
  | 'live_replace_card' | 'live_set_card_controls';

async function gatedCardAction(
  customerId: number,
  action: LiveCardActionType,
  reason: string,
  exec: (cardId: string) => Promise<ProviderResult<unknown>>,
  /** Extra normalized fields to record in the audit log (never raw caller input). */
  detail?: Record<string, unknown>,
): Promise<string> {
  if (!liveEnabled()) return disabledJson();
  if (!config.hyperface.allowMutations) {
    return JSON.stringify({
      success: false,
      code: 'MUTATIONS_DISABLED',
      message: MSG.MUTATIONS_DISABLED_CARD,
    });
  }
  const verdict = await assertActionAllowed(customerId, action);
  if (!verdict.allowed) {
    return JSON.stringify({
      success: false,
      requires_verification: true,
      needed: verdict.needed,
      reason: verdict.reason,
    });
  }
  const binding = await resolveLiveBinding(customerId);
  if (!binding?.cardId) {
    return JSON.stringify({ success: false, reason: 'No live card is linked to this customer.' });
  }
  const res = await exec(binding.cardId);
  await logAction({
    customer_id: customerId,
    action_type: action,
    action_detail: {
      card_id: binding.cardId,
      demo_binding: binding.demo,
      provider_ok: res.ok,
      provider_code: res.ok ? null : res.code,
      verification_level: verdict.level,
      reason,
      ...(detail ?? {}),
    },
    policy_reference: 'Live provider card action',
  });
  if (!res.ok) return shape(res, binding);
  return JSON.stringify({ success: true, live: true, card_id: binding.cardId, demo_binding: binding.demo, data: res.data });
}

export const liveLockCardTool = defineTool({
  name: 'live_lock_card',
  description:
    'LIVE action: lock (freeze) the customer\'s card in the card system of record. Reversible via live_unlock_card. Protective action — do it immediately on request or fraud suspicion.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, reason }) =>
    gatedCardAction(Number(customer_id), 'live_lock_card', String(reason),
      (cardId) => hyperfaceProvider.lockCard(cardId)),
});

export const liveUnlockCardTool = defineTool({
  name: 'live_unlock_card',
  description:
    'LIVE action: unlock the customer\'s card in the card system of record. SENSITIVE — requires two-factor verification; if the tool returns requires_verification=true, run the verification flow and retry.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, reason }) =>
    gatedCardAction(Number(customer_id), 'live_unlock_card', String(reason),
      (cardId) => hyperfaceProvider.unlockCard(cardId)),
});

export const liveHotlistCardTool = defineTool({
  name: 'live_hotlist_card',
  description:
    'LIVE action: permanently hotlist (kill) the card in the card system of record for loss/theft. IRREVERSIBLE and SENSITIVE — requires two-factor verification AND explicit customer confirmation first.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, reason }) =>
    gatedCardAction(Number(customer_id), 'live_hotlist_card', String(reason),
      (cardId) => hyperfaceProvider.hotlistCard(cardId, String(reason))),
});

export const liveReplaceCardTool = defineTool({
  name: 'live_replace_card',
  description:
    'LIVE action: order a replacement card in the card system of record (for a damaged/lost card after hotlisting). CRITICAL and SENSITIVE — needs identity verification (the customer types their card last-4); if the tool returns requires_verification=true, verify and retry.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, reason }) =>
    gatedCardAction(Number(customer_id), 'live_replace_card', String(reason),
      (cardId) => hyperfaceProvider.replaceCard(cardId)),
});

// Card-control channels the provider exposes. One schema per channel: an
// optional `enabled` toggle and an optional per-channel spend limit (INR).
const CARD_CONTROL_CHANNELS = ['online', 'pos', 'contactless', 'atm', 'international'] as const;
type CardControlChannel = (typeof CARD_CONTROL_CHANNELS)[number];

const CardControlChannelSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ description: 'Whether this channel is allowed' })),
  limit: Type.Optional(Type.Number({ description: 'Per-channel spend limit in INR' })),
});

const CardControlsSchema = Type.Object({
  online: Type.Optional(CardControlChannelSchema),
  pos: Type.Optional(CardControlChannelSchema),
  contactless: Type.Optional(CardControlChannelSchema),
  atm: Type.Optional(CardControlChannelSchema),
  international: Type.Optional(CardControlChannelSchema),
}, { description: 'Card-controls by channel, e.g. { "online": { "enabled": true }, "international": { "enabled": false, "limit": 50000 } }' });

interface NormalizedChannelControl {
  enabled?: boolean;
  limit?: number;
}

/**
 * Reduce caller input to a known, typed subset: only recognized channels, and
 * within each only `enabled` (boolean) and `limit` (finite number). This is
 * both what we send to the provider and what we log — never raw caller input.
 */
function normalizeCardControls(input: unknown): Record<string, NormalizedChannelControl> {
  const out: Record<string, NormalizedChannelControl> = {};
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  for (const channel of CARD_CONTROL_CHANNELS) {
    const raw = src[channel];
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const normalized: NormalizedChannelControl = {};
    if (typeof c.enabled === 'boolean') normalized.enabled = c.enabled;
    if (typeof c.limit === 'number' && Number.isFinite(c.limit)) normalized.limit = c.limit;
    if (Object.keys(normalized).length > 0) out[channel as CardControlChannel] = normalized;
  }
  return out;
}

export const liveSetCardControlsTool = defineTool({
  name: 'live_set_card_controls',
  description:
    'LIVE action: set card usage controls in the card system of record — enable/disable channels (online, POS, contactless, ATM, international) and per-channel limits. SENSITIVE — needs two-factor verification. Read get_live_card_controls first so you only change what the customer asked for.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    controls: CardControlsSchema,
    reason: Type.String(),
  }),
  execute: async ({ customer_id, controls, reason }) => {
    const normalized = normalizeCardControls(controls);
    return gatedCardAction(Number(customer_id), 'live_set_card_controls', String(reason),
      (cardId) => hyperfaceProvider.setCardControls(cardId, normalized),
      { controls: normalized });
  },
});

// Account-scoped writes (money movement + EMI)

async function gatedAccountAction(
  customerId: number,
  action:
    | 'live_refund' | 'live_create_emi' | 'live_foreclose_emi'
    | 'live_subscribe_benefit' | 'live_unsubscribe_benefit'
    | 'live_credit_rewards' | 'live_debit_rewards',
  detail: Record<string, unknown>,
  exec: (b: LiveBinding) => Promise<ProviderResult<unknown>>,
): Promise<string> {
  if (!liveEnabled()) return disabledJson();
  if (!config.hyperface.allowMutations) {
    return JSON.stringify({
      success: false,
      code: 'MUTATIONS_DISABLED',
      message: MSG.MUTATIONS_DISABLED_ACCOUNT,
    });
  }
  const verdict = await assertActionAllowed(customerId, action);
  if (!verdict.allowed) {
    return JSON.stringify({
      success: false,
      requires_verification: true,
      needed: verdict.needed,
      reason: verdict.reason,
    });
  }
  const binding = await resolveLiveBinding(customerId);
  if (!binding) {
    return JSON.stringify({ success: false, reason: 'No live card account is linked to this customer.' });
  }
  const res = await exec(binding);
  await logAction({
    customer_id: customerId,
    action_type: action,
    action_detail: {
      account_id: binding.accountId,
      demo_binding: binding.demo,
      provider_ok: res.ok,
      provider_code: res.ok ? null : res.code,
      verification_level: verdict.level,
      ...detail,
    },
    policy_reference: 'Live provider account action',
  });
  if (!res.ok) return shape(res, binding);
  return JSON.stringify({ success: true, live: true, account_id: binding.accountId, demo_binding: binding.demo, data: res.data });
}

export const liveRefundTool = defineTool({
  name: 'live_refund',
  description:
    'LIVE action: post a REFUND or CHARGEBACK credit to the account in the card system of record (the live dispute/refund path — Hyperface has no separate dispute object; reversals are credit postings). SENSITIVE — needs two-factor verification. Only after a deterministic policy gate (check_duplicate_refund_eligibility) returned eligible=true. State the exact credited amount on success.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    amount: Type.Number({ description: 'Amount to credit back, in INR' }),
    type: Type.Optional(Type.String({ description: 'REFUND (default) or CHARGEBACK' })),
    description: Type.String({ description: 'Why this credit is posted (merchant, original txn ref)' }),
  }),
  execute: async ({ customer_id, amount, type, description }) =>
    gatedAccountAction(Number(customer_id), 'live_refund',
      { amount: Number(amount), type: String(type ?? 'REFUND'), description: String(description) },
      (b) => hyperfaceProvider.creditTransaction({
        accountId: b.accountId,
        amount: Number(amount),
        creditTransactionType: String(type ?? 'REFUND').toUpperCase(),
        description: String(description),
      })),
});

export const liveCreateEmiTool = defineTool({
  name: 'live_create_emi',
  description:
    'LIVE action: convert a purchase to EMI in the card system of record. SENSITIVE — needs two-factor verification. Quote terms with get_live_emi_offer and check_emi_conversion_eligibility first, then create with the chosen tenure. State the monthly installment on success.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    amount: Type.Number(),
    tenure_months: Type.Number(),
    txn_ref_id: Type.Optional(Type.String({ description: 'Provider transaction ref id being converted' })),
  }),
  execute: async ({ customer_id, amount, tenure_months, txn_ref_id }) =>
    gatedAccountAction(Number(customer_id), 'live_create_emi',
      { amount: Number(amount), tenure_months: Number(tenure_months), txn_ref_id: txn_ref_id ? String(txn_ref_id) : null },
      (b) => hyperfaceProvider.createEmi({
        accountId: b.accountId,
        amount: Number(amount),
        tenure: Number(tenure_months),
        ...(txn_ref_id ? { txnRefId: String(txn_ref_id) } : {}),
      })),
});

export const liveForecloseEmiTool = defineTool({
  name: 'live_foreclose_emi',
  description:
    'LIVE action: foreclose (close early) an existing EMI plan in the card system of record. SENSITIVE — needs two-factor verification. State the foreclosure charge on success.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    emi_ref_id: Type.String({ description: 'Provider EMI plan ref id (from get_live_emis)' }),
    interest_charged: Type.Optional(Type.Number({ description: 'Interest already charged, if known' })),
  }),
  execute: async ({ customer_id, emi_ref_id, interest_charged }) =>
    gatedAccountAction(Number(customer_id), 'live_foreclose_emi',
      { emi_ref_id: String(emi_ref_id), interest_charged: interest_charged != null ? Number(interest_charged) : null },
      (b) => hyperfaceProvider.forecloseEmi({
        accountId: b.accountId,
        emiRefId: String(emi_ref_id),
        interestCharged: Number(interest_charged ?? 0),
      })),
});

// Core records tools (get_transactions, get_statements, get_reward_points,
// get_active_emis, get_customer_profile, get_outstanding_balance) are now
// live-first for phone-linked customers, so the duplicate live read tools were
// removed. What remains has no records-on-file counterpart. All of these reads
// require a phone-matched binding; a demo_env-only binding returns NO_BINDING.

// Additional live read tools (full Hyperface surface coverage)

export const getLiveBilledTransactionsTool = defineTool({
  name: 'get_live_billed_transactions',
  description:
    'LIVE provider data: the billed transactions on a SPECIFIC statement. REQUIRES a statement_id — call get_statements first, then pass the chosen statement\'s id here. Use for "what was on my <month> bill / show billed charges" questions. Contrasts with get_live_unbilled (current cycle, no statement needed).',
  parameters: Type.Object({
    customer_id: Type.Number(),
    statement_id: Type.String({ description: 'The statement id whose billed transactions to fetch (from get_statements)' }),
    count: Type.Optional(Type.Number({ description: 'Max transactions, default 50' })),
    offset: Type.Optional(Type.Number({ description: 'Page offset, default 0' })),
  }),
  execute: async ({ customer_id, statement_id, count, offset }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.billedTransactions(b.accountId, {
      statementId: String(statement_id),
      count: count != null ? Number(count) : undefined,
      offset: offset != null ? Number(offset) : undefined,
    })),
});

export const getLiveDownloadStatementTool = defineTool({
  name: 'get_live_download_statement',
  description:
    'LIVE provider data: download a specific statement document (PDF/details) by its provider statement id. Get the statement id from get_statements first. Use when the customer asks to "download my statement" or "send me my statement PDF".',
  parameters: Type.Object({
    customer_id: Type.Number(),
    statement_id: Type.String({ description: 'The provider statement id from get_statements' }),
  }),
  execute: async ({ customer_id, statement_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.downloadStatement(b.accountId, String(statement_id))),
});

export const getLiveBenefitsTool = defineTool({
  name: 'get_live_benefits',
  description:
    'LIVE provider data: benefits available to or subscribed by this customer/account — lounge access, insurance, cashback offers, partner discounts. Use for "what benefits do I have" or "what perks are on my card" questions.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.fetchBenefits({ accountId: b.accountId })),
});

export const getLiveBenefitsByProgramTool = defineTool({
  name: 'get_live_benefits_by_program',
  description:
    'LIVE provider data: all benefits available on the card program (not customer-specific). Use for "what benefits does this card offer" or "show me all card perks" questions.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    if (!liveEnabled()) return disabledJson();
    return shape(await hyperfaceProvider.fetchBenefitsByProgram({}));
  },
});

export const getLiveExpiringRewardsTool = defineTool({
  name: 'get_live_expiring_rewards',
  description:
    'LIVE provider data: reward points that are about to expire, with their expiry dates. Use for "are any of my points expiring" or "will I lose points" questions — helps the customer redeem before they lose value.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    before: Type.Optional(Type.String({ description: 'Show points expiring before this date (yyyy-mm-dd). Defaults to 90 days from now.' })),
  }),
  execute: async ({ customer_id, before }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.expiringRewards({
      accountId: b.accountId,
      before: before ? String(before) : undefined,
    })),
});

export const getLiveRewardTransactionsTool = defineTool({
  name: 'get_live_reward_transactions',
  description:
    'LIVE provider data: the full reward points transaction history — earn, burn, expire entries. More detail than the ledger; includes date ranges and pagination. Use for detailed rewards forensics.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    from: Type.Optional(Type.String({ description: 'Start date yyyy-mm-dd' })),
    to: Type.Optional(Type.String({ description: 'End date yyyy-mm-dd' })),
    count: Type.Optional(Type.Number()),
  }),
  execute: async ({ customer_id, from, to, count }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.rewardTransactions({
      accountId: b.accountId,
      from: from ? String(from) : undefined,
      to: to ? String(to) : undefined,
      count: count != null ? Number(count) : undefined,
    })),
});

export const getLiveRewardAccountTool = defineTool({
  name: 'get_live_reward_account',
  description:
    'LIVE provider data: the reward account configuration — earning rates, tier, multiplier, base rate. Use for "how do I earn points" or "what is my rewards rate" questions.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.rewardAccount({ accountId: b.accountId })),
});

export const getLiveEmiListTool = defineTool({
  name: 'get_live_emi_list',
  description:
    'LIVE provider data: all EMI plans (active, closed, foreclosed) from the card system of record. More complete than get_active_emis. Use for a comprehensive view of current and past EMI conversions.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.emiList(b.accountId)),
});

export const getLiveForeclosureDetailsTool = defineTool({
  name: 'get_live_foreclosure_details',
  description:
    'LIVE provider data: the exact foreclosure charges, outstanding principal, interest already paid, and total payable for a specific active EMI. Call before live_foreclose_emi to quote the exact cost.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    emi_ref_id: Type.String({ description: 'The EMI plan reference id' }),
  }),
  execute: async ({ customer_id, emi_ref_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.foreclosureDetails({
      accountId: b.accountId,
      emiRefId: String(emi_ref_id),
    })),
});

export const getLivePaymentStatusTool = defineTool({
  name: 'get_live_payment_status',
  description:
    'LIVE provider data: the status of a card repayment — whether a payment was received, credited, or is still pending. Use for "did my payment go through" or "when will my payment reflect" questions.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    payment_id: Type.Optional(Type.String({ description: 'Provider payment id' })),
    external_ref_id: Type.Optional(Type.String({ description: 'External reference id' })),
  }),
  execute: async ({ customer_id, payment_id, external_ref_id }) =>
    withBinding(Number(customer_id), (b) => hyperfaceProvider.paymentStatus({
      accountId: b.accountId,
      paymentId: payment_id ? String(payment_id) : undefined,
      extRefId: external_ref_id ? String(external_ref_id) : undefined,
    })),
});

export const getLiveCustomerDetailsTool = defineTool({
  name: 'get_live_customer_details',
  description:
    'LIVE provider data: the full customer profile from the card system of record — name, email, mobile, date of birth, address, KYC status. Use for "what details do you have on file" questions or to verify identity fields.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    if (!liveEnabled()) return disabledJson();
    const customer = await getCustomer(Number(customer_id));
    const binding = await resolveLiveBinding(Number(customer_id));
    // Phone-matched only: never serve the shared demo customer profile.
    if (!isServableBinding(binding, customer?.phone)) return noBindingJson();
    // Defensive: a servable binding always carries a real provider customer id,
    // but never call fetchCustomer with a missing/synthesized id.
    if (!binding!.hyperfaceCustomerId) {
      return JSON.stringify({ live: false, code: 'NOT_FOUND', message: 'No provider customer id on the linked account.' });
    }
    return shape(await hyperfaceProvider.fetchCustomer(binding!.hyperfaceCustomerId), binding);
  },
});

// Live action tools for benefits

export const liveSubscribeBenefitTool = defineTool({
  name: 'live_subscribe_benefit',
  description:
    'LIVE action: subscribe this account to a benefit (lounge access, insurance, partner offer). SENSITIVE — needs verification. Get available benefits with get_live_benefits first.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    benefit_id: Type.String({ description: 'The benefit id from get_live_benefits' }),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, benefit_id, reason }) =>
    gatedAccountAction(Number(customer_id), 'live_subscribe_benefit',
      { benefit_id: String(benefit_id), reason: String(reason) },
      (b) => hyperfaceProvider.subscribeBenefit({ accountId: b.accountId, benefitId: String(benefit_id) })),
});

export const liveUnsubscribeBenefitTool = defineTool({
  name: 'live_unsubscribe_benefit',
  description:
    'LIVE action: unsubscribe this account from a benefit. SENSITIVE — needs verification. Use get_live_benefits to find the benefit id.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    benefit_id: Type.String({ description: 'The benefit id to unsubscribe from' }),
    reason: Type.String(),
  }),
  execute: async ({ customer_id, benefit_id, reason }) =>
    gatedAccountAction(Number(customer_id), 'live_unsubscribe_benefit',
      { benefit_id: String(benefit_id), reason: String(reason) },
      (b) => hyperfaceProvider.unsubscribeBenefit({ accountId: b.accountId, benefitId: String(benefit_id) })),
});

// Live action tools for rewards

export const liveCreditRewardsTool = defineTool({
  name: 'live_credit_rewards',
  description:
    'LIVE action: credit reward points to the account (goodwill, promo, correction). Operator-only — requires verification. State the points and reason.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    points: Type.Number({ description: 'Points to credit' }),
    description: Type.String({ description: 'Why points are being credited' }),
  }),
  execute: async ({ customer_id, points, description }) =>
    gatedAccountAction(Number(customer_id), 'live_credit_rewards',
      { points: Number(points), description: String(description) },
      (b) => hyperfaceProvider.creditRewardPoints({ accountId: b.accountId, points: Number(points), description: String(description) })),
});

export const liveDebitRewardsTool = defineTool({
  name: 'live_debit_rewards',
  description:
    'LIVE action: redeem (debit) reward points from the account in the card system of record. SENSITIVE — needs verification. Quote the balance with get_reward_points first. 1 point = INR 0.25.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    points: Type.Number({ description: 'Points to redeem' }),
    description: Type.String({ description: 'Redemption note (e.g. "statement credit", "voucher")' }),
  }),
  execute: async ({ customer_id, points, description }) =>
    gatedAccountAction(Number(customer_id), 'live_debit_rewards',
      { points: Number(points), description: String(description) },
      (b) => hyperfaceProvider.debitRewardPoints({ accountId: b.accountId, points: Number(points), description: String(description) })),
});

export const LIVE_READ_TOOLS = [
  getLiveBindingTool, getLiveAccountOverviewTool, getLiveAccountDetailsTool,
  getLiveUnbilledTool, getLiveCardDetailsTool, getLiveCashbackTool,
  getLiveEmiOfferTool, inquireLiveTransactionTool,
  getLiveBilledTransactionsTool, getLiveDownloadStatementTool,
  getLiveBenefitsTool, getLiveBenefitsByProgramTool,
  getLiveEmiListTool, getLiveForeclosureDetailsTool,
  getLivePaymentStatusTool, getLiveCustomerDetailsTool,
];

export const LIVE_ACTION_TOOLS = [
  liveLockCardTool, liveUnlockCardTool, liveHotlistCardTool,
  liveReplaceCardTool, liveRefundTool, liveCreateEmiTool, liveForecloseEmiTool,
  // New coverage
  liveSubscribeBenefitTool, liveUnsubscribeBenefitTool,
];



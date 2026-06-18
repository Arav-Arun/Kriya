// Chat session verification: a single knowledge check.
// Sensitive actions require the customer to confirm their card's last 4 digits
// (valid for 30 minutes). Reads and protective blocks (block/lock card) require none.
import { defineTool, Type } from '@flue/runtime';
import { getCustomer, logAction } from '../core/queries.ts';

// Verification state store
const KNOWLEDGE_TTL_MS = 30 * 60_000;

interface VerifyState {
  knowledgeAt?: number;
}

const states = new Map<number, VerifyState>();

function stateFor(customerId: number): VerifyState {
  let s = states.get(customerId);
  if (!s) { s = {}; states.set(customerId, s); }
  return s;
}

function fresh(at: number | undefined, ttlMs: number): boolean {
  return at != null && Date.now() - at < ttlMs;
}

// Risk classification rules

/** Sensitive actions that require the card last-4 before executing. */
export const HIGH_RISK_ACTIONS = new Set([
  'unblock_card', 'hotlist_card', 'initiate_card_closure', 'replace_card',
  'initiate_refund', 'adjust_credit_limit', 'redeem_rewards', 'waive_fee',
  'convert_to_emi', 'foreclose_emi',
  'cancel_subscription', 'cancel_emandate', 'set_autopay',
  'toggle_international',
  // Live provider writes (system of record).
  'live_unlock_card', 'live_hotlist_card',
  'live_replace_card', 'live_refund', 'live_create_emi', 'live_foreclose_emi',
  'live_subscribe_benefit', 'live_unsubscribe_benefit',
  'live_credit_rewards', 'live_debit_rewards',
]);

interface VerificationStatus {
  /** Card last-4 confirmed within the last 30 minutes. */
  knowledge: boolean;
  /** Card last-4 confirmed — required for any sensitive action. */
  high_risk_allowed: boolean;
}

export function verificationStatus(customerId: number): VerificationStatus {
  const knowledge = fresh(stateFor(customerId).knowledgeAt, KNOWLEDGE_TTL_MS);
  return { knowledge, high_risk_allowed: knowledge };
}

interface ActionVerdict {
  allowed: boolean;
  level: string;
  reason: string;
  /** What would unlock the action if it is currently denied. */
  needed?: string;
}

/** Deterministic gate consulted by sensitive action tools before executing. */
export async function assertActionAllowed(customerId: number, actionType: string): Promise<ActionVerdict> {
  const v = verificationStatus(customerId);
  const level = v.knowledge ? 'knowledge' : 'none';

  if (!HIGH_RISK_ACTIONS.has(actionType)) {
    return { allowed: true, level, reason: 'Low-risk action; no card verification needed.' };
  }
  if (v.high_risk_allowed) {
    return { allowed: true, level, reason: 'Card last-4 verified.' };
  }

  await logAction({
    customer_id: customerId,
    action_type: 'verification_required',
    action_detail: { action: actionType, needed: 'knowledge' },
  });
  return {
    allowed: false,
    level,
    reason: `"${actionType}" is a sensitive action — ask the customer to type the last 4 digits of their card to confirm it's them, then retry.`,
    needed: 'knowledge',
  };
}

export async function verifyKnowledge(customerId: number, cardLast4: string): Promise<{ verified: boolean; reason?: string }> {
  const customer = await getCustomer(customerId);
  if (!customer) return { verified: false, reason: 'Customer not found.' };
  const expected = String(customer.card_number_last4 ?? '').trim();
  if (!expected || expected !== String(cardLast4 ?? '').trim()) {
    await logAction({ customer_id: customerId, action_type: 'verification_knowledge_failed', action_detail: {} });
    return { verified: false, reason: 'Those card digits do not match the card on this account.' };
  }
  stateFor(customerId).knowledgeAt = Date.now();
  await logAction({ customer_id: customerId, action_type: 'verification_knowledge_verified', action_detail: { method: 'card_last4' } });
  return { verified: true };
}

/** Deterministically checks user input for a 4-digit card verification code. */
export async function handleVerificationReply(
  customerId: number,
  message: string,
): Promise<{ handled: boolean; verified?: boolean; note?: string }> {
  const s = stateFor(customerId);
  if (!fresh(s.knowledgeAt, KNOWLEDGE_TTL_MS)) {
    const m = message.match(/(?<!\d)(\d{4})(?!\d)/);
    if (m) {
      const res = await verifyKnowledge(customerId, m[1]);
      return {
        handled: true, verified: res.verified,
        note: res.verified
          ? 'the card last-4 is correct — identity is now verified.'
          : 'the card digits did not match the account.',
      };
    }
  }
  return { handled: false };
}

// Agent tools

export const getVerificationStatusTool = defineTool({
  name: 'get_verification_status',
  description:
    'Check whether the customer has confirmed their card\'s last 4 digits and whether sensitive actions are allowed (high_risk_allowed). Call this BEFORE attempting a sensitive action so you know whether to ask for the card last-4 first.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => JSON.stringify(verificationStatus(Number(customer_id))),
});

export const verifyIdentityKnowledgeTool = defineTool({
  name: 'verify_identity_knowledge',
  description:
    'Verify the customer by the last 4 digits of their card (ask them to type it). On success this allows sensitive actions for 30 minutes. Never reveal the expected digits.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    card_last4: Type.String({ description: 'The 4 digits the customer typed' }),
  }),
  execute: async ({ customer_id, card_last4 }) =>
    JSON.stringify(await verifyKnowledge(Number(customer_id), String(card_last4))),
});

export const VERIFICATION_TOOLS = [
  getVerificationStatusTool, verifyIdentityKnowledgeTool,
];

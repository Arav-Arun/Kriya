// Customer verification for in-chat actions: is the person typing actually
// the cardholder, or someone random?
//
// Factor model (deterministic, auditable):
//   1. POSSESSION — the customer is in a live Kriya session: the web copilot
//      (signed in with their registered mobile number) or a trusted messaging
//      channel bound to that number (e.g. the verified Telegram webhook). Every
//      supported entry path grants possession, so it is effectively session-level
//      and is NEVER the factor a customer has to "go elsewhere" to satisfy.
//   2. KNOWLEDGE — the customer states their card's last 4 digits in chat and
//      it matches the account record. Valid 30 minutes. This is the only factor
//      the customer actively supplies, and they can always do it right here.
//
// Sensitive (high-risk) actions need BOTH factors. Low-risk/protective actions
// (block/lock card, reads) need none beyond the session. Every factor event
// and every denial is written to the audit log, and action tools attach the
// verification level they ran at.
//
// There is deliberately NO OTP/SMS factor: Kriya has no SMS sender, so it must
// never claim to text a code it cannot deliver. Sensitive actions are gated on
// possession (a verified messaging channel) plus knowledge (card last-4). If a
// real out-of-band sender is added later, reintroduce OTP as a third factor.
//
// State is in-memory (UAT/demo scale); the audit trail in actions_log is the
// durable record.
import { defineTool, Type } from '@flue/runtime';
import { getCustomer, logAction } from '../core/queries.ts';

// Verification state stores

interface ChannelBinding { kind: string; peer: string; trusted: boolean; at: number }
interface VerifyState {
  channel?: ChannelBinding;
  knowledgeAt?: number;
}

const TTL = {
  channelMs: 2 * 60 * 60_000,
  knowledgeMs: 30 * 60_000,
};

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

/** Actions that move money, loosen security, or are irreversible. Each needs
 *  BOTH identity factors (trusted-channel possession + card-last-4 knowledge)
 *  before it runs. Protective actions (block/lock a card) are deliberately NOT
 *  here — we never delay locking down a card the customer fears is compromised. */
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

export interface VerificationStatus {
  channel_kind: string | null;
  possession: boolean;
  knowledge: boolean;
  factor_count: number;
  /** Both factors satisfied — required for any high-risk action. */
  high_risk_allowed: boolean;
}

export function verificationStatus(customerId: number): VerificationStatus {
  const s = stateFor(customerId);
  const possession = Boolean(
    (s.channel?.trusted || s.channel?.kind === 'web') &&
    fresh(s.channel.at, TTL.channelMs)
  );
  const knowledge = fresh(s.knowledgeAt, TTL.knowledgeMs);
  const factor_count = [possession, knowledge].filter(Boolean).length;
  return {
    channel_kind: s.channel && fresh(s.channel.at, TTL.channelMs) ? s.channel.kind : null,
    possession, knowledge, factor_count,
    high_risk_allowed: factor_count >= 2,
  };
}

/** Called by the chat workflow at the start of every turn with channel context. */
export function noteChannelBinding(customerId: number, ctx: { kind: string; peer?: string; trusted: boolean }): void {
  const s = stateFor(customerId);
  s.channel = { kind: ctx.kind, peer: ctx.peer ?? '', trusted: ctx.trusted, at: Date.now() };
}

export interface ActionVerdict {
  allowed: boolean;
  level: string;
  reason: string;
  /** What would unlock the action if it is currently denied. */
  needed?: string;
}

/** Deterministic gate consulted by high-risk action tools before executing. */
export async function assertActionAllowed(customerId: number, actionType: string): Promise<ActionVerdict> {
  const v = verificationStatus(customerId);
  const level = [
    v.possession ? `possession(${v.channel_kind})` : null,
    v.knowledge ? 'knowledge' : null,
  ].filter(Boolean).join('+') || 'none';

  if (!HIGH_RISK_ACTIONS.has(actionType)) {
    return { allowed: true, level, reason: 'Low-risk action; session-level identity is sufficient.' };
  }
  if (v.high_risk_allowed) {
    return { allowed: true, level, reason: `Two-factor verification satisfied (${level}).` };
  }

  // Possession is granted by every supported entry path — the web copilot and
  // trusted messaging channels alike (see verificationStatus). So the only factor
  // a customer ever has to actively supply for a sensitive action is the card
  // last-4 (knowledge), and they can always do that right here in chat. There is
  // deliberately NO "do this from another channel" outcome: the customer is
  // already on a valid one, so we never dead-end them off to Telegram.
  const needed = 'knowledge' as const;
  await logAction({
    customer_id: customerId,
    action_type: 'verification_required',
    action_detail: { action: actionType, current_factors: level, needed },
  });
  return {
    allowed: false,
    level,
    reason: `"${actionType}" is a sensitive action — ask the customer to type the last 4 digits of their card to confirm it's them, then retry (current factors: ${level}).`,
    needed,
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

/**
 * Deterministic verification of a customer's numeric reply, run by the chat
 * workflow BEFORE the resolution agent: a standalone 4-digit token while the
 * knowledge factor is stale verifies the card last-4. Security-critical factor
 * handling must not hinge on a small model picking the right tool. Returns a
 * short note for the agent's context (and whether it acted), so the agent
 * re-attempts the pending action instead of re-asking for the factor.
 */
export async function handleVerificationReply(
  customerId: number,
  message: string,
): Promise<{ handled: boolean; verified?: boolean; factor?: 'knowledge'; note?: string }> {
  const s = stateFor(customerId);
  if (!fresh(s.knowledgeAt, TTL.knowledgeMs)) {
    const m = message.match(/(?<!\d)(\d{4})(?!\d)/);
    if (m) {
      const res = await verifyKnowledge(customerId, m[1]);
      return {
        handled: true, verified: res.verified, factor: 'knowledge',
        note: res.verified
          ? 'the card last-4 is correct — the knowledge factor is now satisfied.'
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
    'Check the customer\'s current identity verification level: which factors are satisfied (trusted-channel possession, card last-4 knowledge) and whether sensitive actions are allowed (high_risk_allowed — needs BOTH factors). Call this BEFORE attempting a sensitive action so you know whether to verify first.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => JSON.stringify(verificationStatus(Number(customer_id))),
});

export const verifyIdentityKnowledgeTool = defineTool({
  name: 'verify_identity_knowledge',
  description:
    'Verify the customer by the last 4 digits of their card (ask them to type it). On success this satisfies the knowledge factor for 30 minutes. Never reveal the expected digits.',
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

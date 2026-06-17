// Chat session verification using two-factor logic:
// 1. Possession: Active web session or verified/trusted messaging channel.
// 2. Knowledge: Card last-4 digits matched against the account record (valid for 30 min).
// Sensitive actions require both factors. Read-only and emergency blocks require possession only.
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

/** High-risk actions requiring both identity factors (possession + knowledge). */
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

  // Possession is established via session; request knowledge factor (card last-4) to satisfy 2FA.
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

/** Deterministically checks user input for a 4-digit card verification code. */
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

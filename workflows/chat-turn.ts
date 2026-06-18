// Orchestrates a single customer chat turn: Triage -> (Forensics || Policy Check) -> Resolution.
import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import triageAgent from '../agents/triage.ts';
import investigationAgent from '../agents/investigation.ts';
import policyAgent from '../agents/policy.ts';
import resolutionAgent from '../agents/resolution.ts';
import {
  TriageRouting, InvestigationFindings, PolicyFindings,
} from '../services/schemas.ts';
import {
  getCustomer, addMessage, getRecentMessages,
  getConversation, getActionsSince, createEscalation, getLastAssistantMessage,
} from '../core/queries.ts';
import { handleVerificationReply } from '../services/verify.ts';

interface Payload {
  customer_id: number;
  conversation_id?: number;
  message: string;
  /** Session origin — used only to tell the agent which channel it's on. */
  channel?: { kind: string; peer?: string };
}

export async function run(ctx: FlueContext<Payload>) {
  const customerId = Number(ctx.payload?.customer_id);
  const requestedConversationId = Number(ctx.payload?.conversation_id ?? 0) || undefined;
  const message = String(ctx.payload?.message ?? '').trim().slice(0, 2000);
  if (!customerId || !message) throw new Error('customer_id and message are required');

  const customer = await getCustomer(customerId);
  if (!customer) throw new Error(`Unknown customer ${customerId}`);

  const channel = ctx.payload?.channel;
  const channelNote = `Channel: ${channel?.kind ?? 'web'}. ACCOUNT READS (balance, limits, statements, transactions, card status) NEED NO VERIFICATION — answer them immediately. Only a sensitive action needs the customer's card last-4.`;

  // Deterministic validation of input digits before resolution step.
  const [verification, conv] = await Promise.all([
    handleVerificationReply(customerId, message),
    requestedConversationId ? getConversation(customerId, requestedConversationId) : Promise.resolve(null),
  ]);
  const verificationNote = verification.handled
    ? `\nIdentity update (handled deterministically just now): ${verification.note} Do NOT re-ask for this factor — call get_verification_status and continue the customer's pending request.`
    : '';

  const conversationId = requestedConversationId && conv ? requestedConversationId : undefined;

  const turnStartedAt = new Date().toISOString();
  const activeConversationId = await addMessage(customerId, 'user', message, null, conversationId);

  // Helper to log metrics and update client status cards.
  async function stage<T>(name: string, label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    ctx.log.info('stage', { stage: name, label, status: 'running' });
    try {
      const output = await fn();
      ctx.log.info('stage', { stage: name, label, status: 'done', elapsed_ms: Date.now() - t0, output });
      return output;
    } catch (err) {
      ctx.log.error('stage', { stage: name, label, status: 'error', elapsed_ms: Date.now() - t0, message: String(err) });
      throw err;
    }
  }

  try {
    // Concurrently fetch recent conversation context.
    const [recentMsgs, lastAssistantMsg] = await Promise.all([
      getRecentMessages(customerId, 6, activeConversationId),
      activeConversationId ? getLastAssistantMessage(customerId, activeConversationId) : Promise.resolve(null),
    ]);
    const recent = recentMsgs
      .map((m: any) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join('\n');

    let triage: any;
    const lastMeta = lastAssistantMsg && lastAssistantMsg.meta
      ? (typeof lastAssistantMsg.meta === 'string' ? JSON.parse(lastAssistantMsg.meta) : lastAssistantMsg.meta)
      : null;

    const isWaiting = lastMeta?.waitingForEmiTenure || lastMeta?.waitingForConfirmation;

    if (verification.handled || isWaiting) {
      triage = {
        route: 'direct',
        category: lastMeta?.category || 'General',
        urgency: 'Low',
        reasoning: verification.handled
          ? 'Skipping triage: the customer supplied an identity factor, handled deterministically.'
          : 'Skipping triage because the conversation is waiting for EMI tenure or confirmation.',
      };
      ctx.log.info('stage', {
        stage: 'triage',
        label: 'Triage',
        status: 'skipped',
        message: verification.handled ? 'Fast path: identity-factor reply' : 'Fast path: follow-up response to pending request',
      });
    } else {
      triage = await stage('triage', 'Triage', async () => {
        const harness = await ctx.init(triageAgent, { name: 'triage' });
        const session = await harness.session();
        const res = await session.prompt(
          `Route this customer chat turn.\n\nLatest message:\n${message}\n\nRecent conversation:\n${recent || '(start of conversation)'}`,
          { result: TriageRouting },
        );
        return res.data;
      });
    }

    let analysis: {
      investigation: InvestigationFindings;
      policy: PolicyFindings;
    } | null = null;

    if (triage.route === 'analysis') {
      const issue = `Customer ID: ${customerId} (${customer.name})\nIssue category: ${triage.category}\nCustomer message:\n${message}`;

      const [investigation, policy] = await Promise.all([
        stage('investigation', 'Investigation', async () => {
          const harness = await ctx.init(investigationAgent, { name: 'investigation' });
          const session = await harness.session();
          const res = await session.prompt(
            `Investigate this issue using the customer's account data.\n\n${issue}`,
            { result: InvestigationFindings },
          );
          return res.data;
        }),
        stage('policy', 'Policy Check', async () => {
          const harness = await ctx.init(policyAgent, { name: 'policy' });
          const session = await harness.session();
          const res = await session.prompt(
            `Determine the governing policy and eligibility.\n\n${issue}`,
            { result: PolicyFindings },
          );
          return res.data;
        }),
      ]);
      analysis = { investigation, policy };
    } else {
      for (const [s, l] of [
        ['investigation', 'Investigation'], ['policy', 'Policy Check'],
      ]) {
        ctx.log.info('stage', { stage: s, label: l, status: 'skipped', message: 'Fast path: no analysis needed' });
      }
    }

    const reply = await stage('resolution', 'Resolution', async () => {
      const harness = await ctx.init(resolutionAgent, { name: `chat-${customerId}` });
      const session = await harness.session();
      const prompt = analysis
        ? `Customer message:\n${message}\n\nSpecialist analysis (from real account data; trust it):\n${JSON.stringify(analysis, null, 2)}\n\n${channelNote}${verificationNote}\nCustomer ID for tool calls: ${customerId}`
        : `Customer message:\n${message}\n\n${channelNote}${verificationNote}\nCustomer ID for tool calls: ${customerId}`;
      const res = await session.prompt(prompt);
      return res.text;
    });

    // Retrieve all actions logged during this turn.
    const rawActions = await getActionsSince(customerId, turnStartedAt);

    // Read the deterministic state set by the set_conversation_state tool call, if any.
    const stateAction = rawActions.find((a: any) => a.action_type === 'conversation_state_updated');
    const stateValue = stateAction && stateAction.action_detail
      ? (typeof stateAction.action_detail === 'string' ? JSON.parse(stateAction.action_detail).state : (stateAction.action_detail as any).state)
      : null;

    // Filter internal logs from user audit.
    const actions = rawActions
      .filter((a: any) => ![
        'conversation_state_updated',
        'verification_required',
        'verification_knowledge_verified',
        'verification_knowledge_failed'
      ].includes(a.action_type))
      .map((a: any) => ({
        type: a.action_type,
        detail: a.action_detail ? (typeof a.action_detail === 'string' ? JSON.parse(a.action_detail) : a.action_detail) : null,
        at: a.performed_at,
      }));

    // Exclude presentational elements from action logs.
    const sideEffects = actions.filter((a) => a.type !== 'ui_card');
    const escalated = sideEffects.some((a) => a.type === 'escalation_created');
    const rejected = sideEffects.some((a) => String(a.type ?? '').endsWith('_rejected'));
    const status = escalated ? 'escalated' : rejected ? 'action_rejected' : sideEffects.length > 0 ? 'action_taken' : 'response_ready';

    const assistantMeta = {
      actions,
      category: triage.category,
      status,
      waitingForEmiTenure: stateValue === 'waiting_for_emi_tenure' ? true : undefined,
      waitingForConfirmation: stateValue === 'waiting_for_confirmation' ? true : undefined,
    };

    await addMessage(customerId, 'assistant', reply, assistantMeta, activeConversationId);
    ctx.log.info('turn', {
      reply, actions, analyzed: analysis !== null, category: triage.category, status, conversation_id: activeConversationId,
    });

    return { reply, actions, triage, analyzed: analysis !== null, status, conversation_id: activeConversationId };
  } catch (err) {
    // Fallback: log exception, escalate to support operations, and notify.
    const escalationId = await createEscalation({
      customer_id: customerId,
      category: 'General',
      priority: 'High',
      assigned_team: 'Customer Service',
      summary: `AI pipeline error while handling: "${message.slice(0, 200)}"`,
      investigation: `Error: ${String(err).slice(0, 500)}`,
      recommended_action: 'Review the conversation and contact the customer directly.',
    });
    const reply = `I'm sorry, ${customer.name.split(' ')[0]}, I ran into a technical problem while working on this. I've escalated it to our support team (reference ${escalationId}) and someone will reach out shortly.`;
    const actions = [{ type: 'escalation_created', detail: { escalation_id: escalationId }, at: new Date().toISOString() }];
    await addMessage(customerId, 'assistant', reply, { actions }, activeConversationId);
    ctx.log.info('turn', { reply, actions, analyzed: false, conversation_id: activeConversationId });
    return { reply, actions, error: true, conversation_id: activeConversationId };
  }
}

// Expose POST /workflows/chat-turn.
export const route: WorkflowRouteHandler = async (_c, next) => next();

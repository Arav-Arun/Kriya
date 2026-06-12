// One customer chat turn, as a Flue workflow:
//   Triage → (Account Evidence ∥ Policy Check ∥ Precedent Review) → Action Execution.
// The three review operations run in parallel for complex issues and are skipped for
// simple turns. The Action Execution agent holds the persistent per-customer session
// (chat-{customerId}), so conversation memory survives reloads and restarts.
import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import {
  triageAgent, investigationAgent, policyAgent, precedentAgent, resolutionAgent,
} from '../sentinel/agents.ts';
import {
  TriageRouting, InvestigationFindings, PolicyFindings, PrecedentFindings,
} from '../sentinel/schemas.ts';
import {
  getCustomer, addMessage, getRecentMessages, getRecentAttachments,
  getConversation, getActionsSince, createEscalation, getLastAssistantMessage,
} from '../lib/sentinel-db.ts';

function detectPendingState(reply: string): { waitingForEmiTenure?: boolean; waitingForConfirmation?: boolean } | null {
  const text = reply.toLowerCase();
  
  // Check for EMI tenure request
  const hasTenure = text.includes('tenure') || 
                    (text.includes('months') && (text.includes('3') || text.includes('6') || text.includes('9') || text.includes('12')));
  if (hasTenure) {
    return { waitingForEmiTenure: true };
  }
  
  // Check for confirmation requests (goodwill waivers, card closures, hotlisting, etc.)
  // We want to capture prompts/questions asking for confirmation and avoid past-tense completions
  const isAskingConfirmation = 
    text.includes('please confirm') ||
    text.includes('confirm if') ||
    text.includes('confirm whether') ||
    text.includes('confirm to') ||
    text.includes('confirm your') ||
    text.includes('reply "confirmed"') ||
    text.includes("reply 'confirmed'") ||
    text.includes('reply confirmed') ||
    text.includes('should i') ||
    text.includes('would you like') ||
    text.includes('do you want') ||
    text.includes('go ahead') ||
    (text.includes('proceed') && !text.includes('proceeded'));

  if (isAskingConfirmation) {
    return { waitingForConfirmation: true };
  }
  
  return null;
}

interface Payload {
  customer_id: number;
  conversation_id?: number;
  message: string;
}

export async function run(ctx: FlueContext<Payload>) {
  const customerId = Number(ctx.payload?.customer_id);
  const requestedConversationId = Number(ctx.payload?.conversation_id ?? 0) || undefined;
  const message = String(ctx.payload?.message ?? '').trim().slice(0, 2000);
  if (!customerId || !message) throw new Error('customer_id and message are required');

  const customer = await getCustomer(customerId);
  if (!customer) throw new Error(`Unknown customer ${customerId}`);
  const conversationId = requestedConversationId && await getConversation(customerId, requestedConversationId)
    ? requestedConversationId
    : undefined;

  const turnStartedAt = new Date().toISOString();
  const activeConversationId = await addMessage(customerId, 'user', message, null, conversationId);

  // Stage wrapper: emits run-stream log events the chat UI's analysis card consumes.
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
    const recent = (await getRecentMessages(customerId, 6, activeConversationId))
      .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join('\n');
    const evidence = (await getRecentAttachments(customerId, 4))
      .map((a: any) => {
        const kind = a.attachment_type === 'statement' ? 'Statement' : 'Evidence';
        return `${kind} ${a.id} (${a.filename}, ${a.created_at}): ${String(a.analysis ?? '').slice(0, 800)}`;
      })
      .join('\n');
    const evidenceBlock = evidence ? `\n\nRecent customer-uploaded statements/evidence:\n${evidence}` : '';

    let triage: any;
    const lastAssistantMsg = activeConversationId ? await getLastAssistantMessage(customerId, activeConversationId) : null;
    const lastMeta = lastAssistantMsg && lastAssistantMsg.meta
      ? (typeof lastAssistantMsg.meta === 'string' ? JSON.parse(lastAssistantMsg.meta) : lastAssistantMsg.meta)
      : null;

    if (lastMeta?.waitingForEmiTenure || lastMeta?.waitingForConfirmation) {
      triage = {
        route: 'direct',
        category: lastMeta.category || 'General',
        urgency: 'Low',
        reasoning: 'Skipping triage because the conversation is waiting for EMI tenure or confirmation.',
      };
      ctx.log.info('stage', {
        stage: 'triage',
        label: 'Triage',
        status: 'skipped',
        message: 'Fast path — follow-up response to pending request',
      });
    } else {
      triage = await stage('triage', 'Triage', async () => {
        const harness = await ctx.init(triageAgent, { name: 'triage' });
        const session = await harness.session();
        const res = await session.prompt(
          `Route this customer chat turn.\n\nLatest message:\n${message}\n\nRecent conversation:\n${recent || '(start of conversation)'}${evidenceBlock}`,
          { result: TriageRouting },
        );
        return res.data;
      });
    }

    let analysis: {
      investigation: InvestigationFindings;
      policy: PolicyFindings;
      precedents: PrecedentFindings;
    } | null = null;

    if (triage.route === 'analysis') {
      const issue = `Customer ID: ${customerId} (${customer.name})\nIssue category: ${triage.category}\nCustomer message:\n${message}${evidenceBlock}`;

      const [investigation, policy, precedents] = await Promise.all([
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
        stage('precedent', 'Precedents', async () => {
          const harness = await ctx.init(precedentAgent, { name: 'precedent' });
          const session = await harness.session();
          const res = await session.prompt(
            `Find historical precedents for this issue.\n\n${issue}`,
            { result: PrecedentFindings },
          );
          return res.data;
        }),
      ]);
      analysis = { investigation, policy, precedents };
    } else {
      for (const [s, l] of [
        ['investigation', 'Investigation'], ['policy', 'Policy Check'], ['precedent', 'Precedents'],
      ]) {
        ctx.log.info('stage', { stage: s, label: l, status: 'skipped', message: 'Fast path — no analysis needed' });
      }
    }

    const reply = await stage('resolution', 'Resolution', async () => {
      const harness = await ctx.init(resolutionAgent, { name: `chat-${customerId}` });
      const session = await harness.session();
      const prompt = analysis
        ? `Customer message:\n${message}${evidenceBlock}\n\nSpecialist analysis (from real account data — trust it):\n${JSON.stringify(analysis, null, 2)}\n\nCustomer ID for tool calls: ${customerId}`
        : `Customer message:\n${message}${evidenceBlock}\n\nCustomer ID for tool calls: ${customerId}`;
      const res = await session.prompt(prompt);
      return res.text;
    });

    // Authoritative record of what the Resolution agent actually did this turn
    // (every action tool writes to actions_log).
    const actions = (await getActionsSince(customerId, turnStartedAt)).map((a: any) => ({
      type: a.action_type,
      detail: a.action_detail ? JSON.parse(a.action_detail) : null,
      at: a.performed_at,
    }));

    const escalated = actions.some((a) => a.type === 'escalation_created');
    const rejected = actions.some((a) => String(a.type ?? '').endsWith('_rejected'));
    const status = escalated ? 'escalated' : rejected ? 'action_rejected' : actions.length > 0 ? 'action_taken' : 'response_ready';

    const pendingState = detectPendingState(reply);
    const assistantMeta = {
      actions,
      category: triage.category,
      status,
      ...pendingState,
    };

    await addMessage(customerId, 'assistant', reply, assistantMeta, activeConversationId);
    ctx.log.info('turn', {
      reply, actions, analyzed: analysis !== null, category: triage.category, status, conversation_id: activeConversationId,
    });

    return { reply, actions, triage, analyzed: analysis !== null, status, conversation_id: activeConversationId };
  } catch (err) {
    // Production guarantee: the chat never dead-ends. Apologize and hand off to a human.
    const escalationId = await createEscalation({
      customer_id: customerId,
      category: 'General',
      priority: 'High',
      assigned_team: 'Customer Service',
      summary: `AI pipeline error while handling: "${message.slice(0, 200)}"`,
      investigation: `Error: ${String(err).slice(0, 500)}`,
      recommended_action: 'Review the conversation and contact the customer directly.',
    });
    const reply = `I'm sorry, ${customer.name.split(' ')[0]} — I ran into a technical problem while working on this. I've escalated it to our support team (reference ${escalationId}) and someone will reach out shortly.`;
    const actions = [{ type: 'escalation_created', detail: { escalation_id: escalationId }, at: new Date().toISOString() }];
    await addMessage(customerId, 'assistant', reply, { actions }, activeConversationId);
    ctx.log.info('turn', { reply, actions, analyzed: false, conversation_id: activeConversationId });
    return { reply, actions, error: true, conversation_id: activeConversationId };
  }
}

// Expose POST /workflows/chat-turn.
export const route: WorkflowRouteHandler = async (_c, next) => next();

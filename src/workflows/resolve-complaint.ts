// Main Sentinel pipeline (docs/04_WORKFLOWS.md):
// Triage → Investigation → Policy → Similar Cases → Routing.
// Each stage is a separate single-responsibility agent that returns a
// validated structured result; that result feeds the next stage's prompt.
// Ticket creation is a separate workflow (create-ticket) triggered by the UI.
import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import {
  triageAgent, investigationAgent, policyAgent, similarCasesAgent, routingAgent,
} from '../sentinel/agents.ts';
import {
  TriageResult, InvestigationResult, PolicyResult, SimilarCasesResult, RoutingResult,
} from '../sentinel/schemas.ts';

interface Payload {
  complaint: string;
}

export async function run(ctx: FlueContext<Payload>) {
  const complaint = String(ctx.payload?.complaint ?? '').trim();
  if (!complaint) throw new Error('payload.complaint is required');

  // Stage wrapper: emits run-stream log events the UI timeline subscribes to.
  async function stage<T>(name: string, label: string, fn: () => Promise<T>): Promise<T> {
    ctx.log.info('stage', { stage: name, label, status: 'running' });
    try {
      const output = await fn();
      ctx.log.info('stage', { stage: name, label, status: 'done', output });
      return output;
    } catch (err) {
      ctx.log.error('stage', { stage: name, label, status: 'error', message: String(err) });
      throw err;
    }
  }

  const triage = await stage('triage', 'Triage Agent', async () => {
    const harness = await ctx.init(triageAgent, { name: 'triage' });
    const session = await harness.session();
    const res = await session.prompt(
      `Classify this support complaint:\n\n${complaint}`,
      { result: TriageResult },
    );
    return res.data;
  });

  const investigation = await stage('investigation', 'Investigation Agent', async () => {
    const harness = await ctx.init(investigationAgent, { name: 'investigation' });
    const session = await harness.session();
    const res = await session.prompt(
      `Investigate this complaint and gather evidence.\n\nComplaint:\n${complaint}\n\nTriage result:\n${JSON.stringify(triage, null, 2)}`,
      { result: InvestigationResult },
    );
    return res.data;
  });

  const policy = await stage('policy', 'Policy Agent', async () => {
    const harness = await ctx.init(policyAgent, { name: 'policy' });
    const session = await harness.session();
    const res = await session.prompt(
      `Determine the governing policy, eligibility and SLA.\n\nComplaint:\n${complaint}\n\nTriage:\n${JSON.stringify(triage)}\n\nInvestigation:\n${JSON.stringify(investigation, null, 2)}`,
      { result: PolicyResult },
    );
    return res.data;
  });

  const similarCases = await stage('similar-cases', 'Similar Cases Agent', async () => {
    const harness = await ctx.init(similarCasesAgent, { name: 'similar-cases' });
    const session = await harness.session();
    const res = await session.prompt(
      `Find historical precedents for this case.\n\nComplaint:\n${complaint}\n\nTriage:\n${JSON.stringify(triage)}\n\nKey evidence:\n${JSON.stringify(investigation.evidence)}`,
      { result: SimilarCasesResult },
    );
    return res.data;
  });

  const routing = await stage('routing', 'Routing Agent', async () => {
    const harness = await ctx.init(routingAgent, { name: 'routing' });
    const session = await harness.session();
    const res = await session.prompt(
      `Determine the responsible team and escalation path.\n\nTriage:\n${JSON.stringify(triage)}\n\nInvestigation evidence:\n${JSON.stringify(investigation.evidence)}\n\nPolicy:\n${JSON.stringify(policy)}\n\nSimilar cases recommendation:\n${JSON.stringify(similarCases.recommended_next_action)}`,
      { result: RoutingResult },
    );
    return res.data;
  });

  return {
    complaint,
    triage,
    investigation,
    policy,
    similar_cases: similarCases,
    routing,
    completed_at: new Date().toISOString(),
  };
}

// Expose POST /workflows/resolve-complaint.
export const route: WorkflowRouteHandler = async (_c, next) => next();

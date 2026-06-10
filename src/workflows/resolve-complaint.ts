// Resolve Complaint workflow (main analysis and routing pipeline):
// Triage → Investigation → [Policy || Similar Cases] → Conditional Branch → Routing.
// Each stage is a separate single-responsibility agent that returns a
// validated structured result; that result feeds the next stage's prompt.
// Ticket creation is a separate workflow (create-ticket) triggered by the UI.
import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import {
  triageAgent, investigationAgent, policyAgent, similarCasesAgent, routingAgent,
  escalationReviewAgent, missingInfoAgent,
} from '../sentinel/agents.ts';
import {
  TriageResult, InvestigationResult, PolicyResult, SimilarCasesResult, RoutingResult,
  EscalationReviewResult, MissingInfoResult,
} from '../sentinel/schemas.ts';
import { getCustomer } from '../lib/sentinel-db.ts';

interface Payload {
  complaint: string;
}

function missingInfoBranchReason(
  policy: PolicyResult,
  investigation: InvestigationResult,
): string | null {
  if (policy.eligibility === 'Needs More Information') {
    return 'Policy eligibility requires more information.';
  }
  if (!investigation.customer_found) {
    return 'Customer record was not found, so evidence is incomplete.';
  }
  if (investigation.matching_transactions.length === 0) {
    return 'No matching transaction evidence was found for this complaint.';
  }
  return null;
}

export async function run(ctx: FlueContext<Payload>) {
  const complaint = String(ctx.payload?.complaint ?? '').trim();
  if (!complaint) throw new Error('payload.complaint is required');

  // Stage wrapper: emits ru -stream log events the UI timeline subscribes to.
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

  let investigation: InvestigationResult;
  let customerExists = false;
  if (triage.customer_id && triage.customer_id > 0) {
    try {
      const customer = await getCustomer(triage.customer_id);
      if (customer) {
        customerExists = true;
      }
    } catch (err) {
      // Treat lookup failure or errors as not found to avoid crashing the pipeline
    }
  }

  if (customerExists) {
    investigation = await stage('investigation', 'Investigation Agent', async () => {
      const harness = await ctx.init(investigationAgent, { name: 'investigation' });
      const session = await harness.session();
      const res = await session.prompt(
        `Investigate this complaint and gather evidence.\n\nComplaint:\n${complaint}\n\nTriage result:\n${JSON.stringify(triage, null, 2)}`,
        { result: InvestigationResult },
      );
      return res.data;
    });
  } else {
    investigation = {
      customer_found: false,
      customer_name: null,
      card_status: null,
      risk_score: null,
      matching_transactions: [],
      evidence: [
        triage.customer_id
          ? `Customer ID ${triage.customer_id} was provided, but no customer record was found in the database; bypassed investigation.`
          : 'No customer ID provided in triage; bypassed investigation.'
      ],
      notes: triage.customer_id
        ? `Investigation bypassed: customer ID ${triage.customer_id} not found in database.`
        : 'Investigation bypassed: customer ID not found during triage.',
    };
    ctx.log.info('stage', {
      stage: 'investigation',
      label: 'Investigation Agent',
      status: 'skipped',
      message: triage.customer_id ? 'Skipped — Customer Not Found' : 'Skipped — No Customer ID',
      output: investigation,
    });
  }

  const [policy, similarCases] = await Promise.all([
    stage('policy', 'Policy Agent', async () => {
      const harness = await ctx.init(policyAgent, { name: 'policy' });
      const session = await harness.session();
      const res = await session.prompt(
        `Determine the governing policy, eligibility and SLA.\n\nComplaint:\n${complaint}\n\nTriage:\n${JSON.stringify(triage)}\n\nInvestigation:\n${JSON.stringify(investigation, null, 2)}`,
        { result: PolicyResult },
      );
      return res.data;
    }),
    stage('similar-cases', 'Similar Cases Agent', async () => {
      const harness = await ctx.init(similarCasesAgent, { name: 'similar-cases' });
      const session = await harness.session();
      const res = await session.prompt(
        `Find historical precedents for this case.\n\nComplaint:\n${complaint}\n\nTriage:\n${JSON.stringify(triage)}\n\nKey evidence:\n${JSON.stringify(investigation.evidence)}`,
        { result: SimilarCasesResult },
      );
      return res.data;
    }),
  ]);

  let branch: {
    type: 'escalation' | 'missing_information' | 'standard';
    reason: string;
    result: EscalationReviewResult | MissingInfoResult | null;
  };
  const missingInfoReason = missingInfoBranchReason(policy, investigation);

  if (policy.escalation_required) {
    const escalationResult = await stage('escalation-review', 'Escalation Review Agent', async () => {
      const harness = await ctx.init(escalationReviewAgent, { name: 'escalation-review' });
      const session = await harness.session();
      const res = await session.prompt(
        `Perform an escalation review for this complaint.\n\nComplaint:\n${complaint}\n\nTriage:\n${JSON.stringify(triage)}\n\nInvestigation:\n${JSON.stringify(investigation)}\n\nPolicy:\n${JSON.stringify(policy)}\n\nSimilar cases:\n${JSON.stringify(similarCases)}`,
        { result: EscalationReviewResult },
      );
      return res.data;
    });
    branch = {
      type: 'escalation',
      reason: 'Policy marked escalation_required=true.',
      result: escalationResult,
    };
    ctx.log.info('stage', {
      stage: 'missing-info',
      label: 'Missing Information Agent',
      status: 'skipped',
      message: 'Skipped — Escalation Branch Taken',
    });
  } else if (missingInfoReason) {
    const missingInfoResult = await stage('missing-info', 'Missing Information Agent', async () => {
      const harness = await ctx.init(missingInfoAgent, { name: 'missing-info' });
      const session = await harness.session();
      const res = await session.prompt(
        `Identify missing information required before this complaint can be resolved.\n\nBranch reason:\n${missingInfoReason}\n\nComplaint:\n${complaint}\n\nPolicy:\n${JSON.stringify(policy)}\n\nInvestigation:\n${JSON.stringify(investigation)}`,
        { result: MissingInfoResult },
      );
      return res.data;
    });
    branch = {
      type: 'missing_information',
      reason: missingInfoReason,
      result: missingInfoResult,
    };
    ctx.log.info('stage', {
      stage: 'escalation-review',
      label: 'Escalation Review Agent',
      status: 'skipped',
      message: 'Skipped — No Escalation Required',
    });
  } else {
    branch = {
      type: 'standard',
      reason: 'Policy and evidence are complete enough for standard routing.',
      result: null,
    };
    ctx.log.info('stage', {
      stage: 'escalation-review',
      label: 'Escalation Review Agent',
      status: 'skipped',
      message: 'Skipped — Standard Flow',
    });
    ctx.log.info('stage', {
      stage: 'missing-info',
      label: 'Missing Information Agent',
      status: 'skipped',
      message: 'Skipped — Standard Flow',
    });
  }

  const routing = await stage('routing', 'Routing Agent', async () => {
    const harness = await ctx.init(routingAgent, { name: 'routing' });
    const session = await harness.session();
    const res = await session.prompt(
      `Determine the responsible team and escalation path.\n\nTriage:\n${JSON.stringify(triage)}\n\nInvestigation evidence:\n${JSON.stringify(investigation.evidence)}\n\nPolicy:\n${JSON.stringify(policy)}\n\nSimilar cases recommendation:\n${JSON.stringify(similarCases.recommended_next_action)}\n\nBranch context:\n${JSON.stringify(branch)}`,
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
    branch,
    routing,
    completed_at: new Date().toISOString(),
  };
}

// Expose POST /workflows/resolve-complaint.
export const route: WorkflowRouteHandler = async (_c, next) => next();

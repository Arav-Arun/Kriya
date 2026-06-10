// Specialized Sentinel agents distributed across two workflows.
// Each has a single responsibility and only the tools that job needs.
// They run without a sandbox: all capability comes from custom tools.
import { createAgent } from '@flue/runtime';
import {
  getCustomerTool, getTransactionsTool, getCardStatusTool,
  searchPolicyTool, searchSimilarCasesTool, assignTeamTool, createTicketTool,
} from './tools.ts';
import {
  TRIAGE_PROMPT, INVESTIGATION_PROMPT, POLICY_PROMPT, SIMILAR_CASES_PROMPT,
  ROUTING_PROMPT, ESCALATION_REVIEW_PROMPT, MISSING_INFO_PROMPT, TICKET_PROMPT,
} from './prompts.ts';

const MODEL = process.env.SENTINEL_MODEL ?? 'openai/gpt-5.5';

function makeSentinelAgent(
  name: string,
  instructions: string,
  tools?: any[],
  thinkingLevel: 'low' | 'medium' | 'high' = 'low'
) {
  return createAgent(() => ({
    name,
    model: MODEL,
    thinkingLevel,
    sandbox: false,
    tools,
    instructions,
  }));
}

export const triageAgent = makeSentinelAgent('triage', TRIAGE_PROMPT);

export const investigationAgent = makeSentinelAgent(
  'investigation',
  INVESTIGATION_PROMPT,
  [getCustomerTool, getTransactionsTool, getCardStatusTool],
  'medium'
);

export const policyAgent = makeSentinelAgent(
  'policy',
  POLICY_PROMPT,
  [searchPolicyTool]
);

export const similarCasesAgent = makeSentinelAgent(
  'similar-cases',
  SIMILAR_CASES_PROMPT,
  [searchSimilarCasesTool]
);

export const routingAgent = makeSentinelAgent(
  'routing',
  ROUTING_PROMPT,
  [assignTeamTool]
);

export const escalationReviewAgent = makeSentinelAgent(
  'escalation-review',
  ESCALATION_REVIEW_PROMPT
);

export const missingInfoAgent = makeSentinelAgent(
  'missing-info',
  MISSING_INFO_PROMPT
);

export const ticketAgent = makeSentinelAgent(
  'ticket',
  TICKET_PROMPT,
  [createTicketTool]
);

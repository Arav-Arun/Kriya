// Sentinel's agent roster. Triage routes each chat turn; Investigation,
// Policy and Precedent run IN PARALLEL for complex issues; Resolution holds
// the persistent customer conversation and executes actions.
import { createAgent } from '@flue/runtime';
import {
  getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
  getOutstandingBalanceTool, getRewardPointsTool, getActiveEmisTool,
  getFeesAndChargesTool, searchPolicyTool, searchSimilarCasesTool,
  recordCustomerContextTool, recordCustomerTransactionTool,
  getStatementsTool, getDisputesTool, getSubscriptionsTool, cancelSubscriptionTool,
  getEmandatesTool, cancelEmandateTool,
  waiveFeeTool, blockCardTool, unblockCardTool, hotlistCardTool,
  toggleInternationalTool, setCardControlTool, setAutopayTool,
  convertToEmiTool, forecloseEmiTool, raiseDisputeTool,
  redeemRewardsTool, initiateRefundTool, adjustCreditLimitTool,
  initiateCardClosureTool, createEscalationTool,
} from './tools.ts';
import { POLICY_TOOLS } from './policy.ts';
import {
  TRIAGE_PROMPT, INVESTIGATION_PROMPT, POLICY_PROMPT,
  PRECEDENT_PROMPT, RESOLUTION_PROMPT,
} from './prompts.ts';

const MODEL = process.env.SENTINEL_MODEL ?? 'openai/gpt-5.5';

function makeAgent(
  name: string,
  instructions: string,
  tools?: any[],
  thinkingLevel: 'low' | 'medium' | 'high' = 'low',
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

export const triageAgent = makeAgent('Sentinel Triage', TRIAGE_PROMPT);

export const investigationAgent = makeAgent(
  'Sentinel Investigation',
  INVESTIGATION_PROMPT,
  [
    // Data-gathering tools ONLY. This agent collects facts — it does not
    // make eligibility decisions. Policy gate checks belong in Resolution.
    getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
    getOutstandingBalanceTool, getActiveEmisTool, getFeesAndChargesTool,
    getStatementsTool, getDisputesTool, getSubscriptionsTool,
    getEmandatesTool,
  ],
  'medium',
);

export const policyAgent = makeAgent('Sentinel Policy', POLICY_PROMPT, [searchPolicyTool]);

export const precedentAgent = makeAgent('Sentinel Precedent', PRECEDENT_PROMPT, [searchSimilarCasesTool]);

export const resolutionAgent = makeAgent(
  'Sentinel Resolution',
  RESOLUTION_PROMPT,
  [
    // Read tools for follow-ups that skip the specialist fan-out.
    getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
    getOutstandingBalanceTool, getRewardPointsTool, getActiveEmisTool,
    getFeesAndChargesTool, recordCustomerContextTool, recordCustomerTransactionTool,
    getStatementsTool, getDisputesTool, getSubscriptionsTool,
    getEmandatesTool, cancelEmandateTool,
    // Deterministic policy gates — MUST run before the matching sensitive action.
    ...POLICY_TOOLS,
    // Action tools — the resolution authority.
    waiveFeeTool, blockCardTool, unblockCardTool, hotlistCardTool,
    toggleInternationalTool, setCardControlTool, setAutopayTool,
    convertToEmiTool, forecloseEmiTool, raiseDisputeTool,
    redeemRewardsTool, initiateRefundTool, adjustCreditLimitTool,
    initiateCardClosureTool, createEscalationTool, cancelSubscriptionTool,
  ],
  'medium',
);

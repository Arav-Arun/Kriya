import { createAgent } from '@flue/runtime';
import { RESOLUTION_PROMPT } from '../services/prompts.ts';
import {
  getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
  getOutstandingBalanceTool, getActiveEmisTool,
  getFeesAndChargesTool, recordCustomerContextTool, recordCustomerTransactionTool,
  getStatementsTool, getDisputesTool, getSubscriptionsTool,
  getEmandatesTool,
  blockCardTool, unblockCardTool, hotlistCardTool,
  convertToEmiTool, forecloseEmiTool,
  initiateRefundTool, waiveFeeTool,
  createEscalationTool,
  setConversationStateTool,
} from '../services/tools.ts';
import { POLICY_TOOLS } from '../services/policy-gates.ts';
import { LIVE_READ_TOOLS, LIVE_ACTION_TOOLS, PRESENTATION_TOOLS } from '../services/provider-tools.ts';
import { VERIFICATION_TOOLS } from '../services/verify.ts';

const MODEL = process.env.SENTINEL_MODEL ?? 'openai/gpt-4o-mini';

export default createAgent(() => ({
  name: 'sentinel-resolution',
  model: MODEL,
  thinkingLevel: 'medium',
  sandbox: false,
  tools: [
    getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
    getOutstandingBalanceTool, getActiveEmisTool,
    getFeesAndChargesTool, recordCustomerContextTool, recordCustomerTransactionTool,
    getStatementsTool, getDisputesTool, getSubscriptionsTool,
    getEmandatesTool,
    ...POLICY_TOOLS,
    ...LIVE_READ_TOOLS, ...LIVE_ACTION_TOOLS, ...PRESENTATION_TOOLS, ...VERIFICATION_TOOLS,
    blockCardTool, unblockCardTool, hotlistCardTool,
    convertToEmiTool, forecloseEmiTool,
    initiateRefundTool, waiveFeeTool,
    createEscalationTool,
    setConversationStateTool,
  ],
  instructions: RESOLUTION_PROMPT,
}));


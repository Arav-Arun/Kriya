import { createAgent } from '@flue/runtime';
import { RESOLUTION_PROMPT } from '../services/prompts.ts';
import {
  getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
  getOutstandingBalanceTool, getActiveEmisTool,
  getFeesAndChargesTool, recordCustomerContextTool, recordCustomerTransactionTool,
  getStatementsTool, getDisputesTool, getSubscriptionsTool,
  getEmandatesTool, cancelEmandateTool,
  waiveFeeTool, blockCardTool, unblockCardTool, hotlistCardTool,
  toggleInternationalTool, setCardControlTool, setAutopayTool,
  convertToEmiTool, forecloseEmiTool, raiseDisputeTool,
  initiateRefundTool, adjustCreditLimitTool,
  initiateCardClosureTool, createEscalationTool, cancelSubscriptionTool,
  setConversationStateTool,
} from '../services/tools.ts';
import { POLICY_TOOLS } from '../services/policy-gates.ts';
import { LIVE_READ_TOOLS, LIVE_ACTION_TOOLS } from '../services/provider-tools.ts';
import { VERIFICATION_TOOLS } from '../services/verify.ts';

const MODEL = process.env.SENTINEL_MODEL ?? 'openai/gpt-4.1';

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
    getEmandatesTool, cancelEmandateTool,
    ...POLICY_TOOLS,
    ...LIVE_READ_TOOLS, ...LIVE_ACTION_TOOLS, ...VERIFICATION_TOOLS,
    waiveFeeTool, blockCardTool, unblockCardTool, hotlistCardTool,
    toggleInternationalTool, setCardControlTool, setAutopayTool,
    convertToEmiTool, forecloseEmiTool, raiseDisputeTool,
    initiateRefundTool, adjustCreditLimitTool,
    initiateCardClosureTool, createEscalationTool, cancelSubscriptionTool,
    setConversationStateTool,
  ],
  instructions: RESOLUTION_PROMPT,
}));


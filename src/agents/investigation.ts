import { createAgent } from '@flue/runtime';
import { INVESTIGATION_PROMPT } from '../services/prompts.ts';
import {
  getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
  getOutstandingBalanceTool, getActiveEmisTool, getFeesAndChargesTool,
  getStatementsTool, getDisputesTool, getSubscriptionsTool,
  getEmandatesTool,
} from '../services/tools.ts';
import { LIVE_READ_TOOLS } from '../services/provider-tools.ts';

const MODEL = process.env.SENTINEL_MODEL ?? 'openai/gpt-4o-mini';

export default createAgent(() => ({
  name: 'sentinel-investigation',
  model: MODEL,
  thinkingLevel: 'medium',
  sandbox: false,
  tools: [
    getCustomerProfileTool, getTransactionsTool, getPaymentHistoryTool,
    getOutstandingBalanceTool, getActiveEmisTool, getFeesAndChargesTool,
    getStatementsTool, getDisputesTool, getSubscriptionsTool,
    getEmandatesTool, ...LIVE_READ_TOOLS,
  ],
  instructions: INVESTIGATION_PROMPT,
}));

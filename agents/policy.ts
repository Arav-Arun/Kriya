import { createAgent } from '@flue/runtime';
import { POLICY_PROMPT } from '../services/prompts.ts';
import { searchPolicyTool } from '../services/tools.ts';

// Fast keyword policy lookup and rule extraction. Runs in parallel with Investigation.
const MODEL = process.env.POLICY_MODEL ?? 'openai/gpt-4o-mini';

export default createAgent(() => ({
  name: 'sentinel-policy',
  model: MODEL,
  thinkingLevel: 'low',
  sandbox: false,
  tools: [searchPolicyTool],
  instructions: POLICY_PROMPT,
}));

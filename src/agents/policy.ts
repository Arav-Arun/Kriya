import { createAgent } from '@flue/runtime';
import { POLICY_PROMPT } from '../services/prompts.ts';
import { searchPolicyTool } from '../services/tools.ts';

const MODEL = process.env.SENTINEL_MODEL ?? 'openai/gpt-4o-mini';

export default createAgent(() => ({
  name: 'sentinel-policy',
  model: MODEL,
  thinkingLevel: 'low',
  sandbox: false,
  tools: [searchPolicyTool],
  instructions: POLICY_PROMPT,
}));

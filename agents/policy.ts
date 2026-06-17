import { createAgent } from '@flue/runtime';
import { POLICY_PROMPT } from '../services/prompts.ts';
import { searchPolicyTool } from '../services/tools.ts';

// Policy is a keyword policy lookup + rule extraction (thinkingLevel low). It
// runs in parallel with Investigation, so a fast model keeps it from being the
// long pole of that parallel phase. Override with POLICY_MODEL if needed.
const MODEL = process.env.POLICY_MODEL ?? 'openai/gpt-4.1-mini';

export default createAgent(() => ({
  name: 'sentinel-policy',
  model: MODEL,
  thinkingLevel: 'low',
  sandbox: false,
  tools: [searchPolicyTool],
  instructions: POLICY_PROMPT,
}));

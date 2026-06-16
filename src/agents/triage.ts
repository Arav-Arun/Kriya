import { createAgent } from '@flue/runtime';
import { TRIAGE_PROMPT } from '../services/prompts.ts';

const MODEL = process.env.SENTINEL_MODEL ?? 'openai/gpt-4.1';

export default createAgent(() => ({
  name: 'sentinel-triage',
  model: MODEL,
  thinkingLevel: 'low',
  sandbox: false,
  instructions: TRIAGE_PROMPT,
}));

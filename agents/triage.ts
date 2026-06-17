import { createAgent } from '@flue/runtime';
import { TRIAGE_PROMPT } from '../services/prompts.ts';

// Fast 3-way route classification to avoid latency on analyzed turns.
const MODEL = process.env.TRIAGE_MODEL ?? 'openai/gpt-4o-mini';

export default createAgent(() => ({
  name: 'sentinel-triage',
  model: MODEL,
  thinkingLevel: 'low',
  sandbox: false,
  instructions: TRIAGE_PROMPT,
}));

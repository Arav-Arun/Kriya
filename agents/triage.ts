import { createAgent } from '@flue/runtime';
import { TRIAGE_PROMPT } from '../services/prompts.ts';

// Triage is a 3-way route classifier on the critical path — it runs (and the
// customer waits on it) before any specialist or the resolver starts. A small,
// fast model handles this reliably; using the frontier model here just adds
// latency to every analyzed turn. Override with TRIAGE_MODEL if needed.
const MODEL = process.env.TRIAGE_MODEL ?? 'openai/gpt-4.1-mini';

export default createAgent(() => ({
  name: 'sentinel-triage',
  model: MODEL,
  thinkingLevel: 'low',
  sandbox: false,
  instructions: TRIAGE_PROMPT,
}));

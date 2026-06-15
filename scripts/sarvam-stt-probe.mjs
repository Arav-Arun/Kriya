#!/usr/bin/env node
// Sarvam STT diagnostic: isolates why /api/voice/transcribe fails.
// Sends a synthetic WAV (a known-good format) to the Sarvam speech-to-text
// endpoint with the configured model, then reports the raw status/body. If WAV
// is accepted but the browser's webm/opus is not, the bug is the audio format.
//
//   node scripts/sarvam-stt-probe.mjs
import { readFileSync } from 'node:fs';

function loadEnv(path = '.env') {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const env = loadEnv();
const KEY = env.SARVAM_API_KEY;
const MODEL = env.SARVAM_STT_MODEL || 'saarika:v2.5';
if (!KEY) { console.error('SARVAM_API_KEY missing'); process.exit(1); }

// 1 second of 16 kHz, 16-bit mono PCM — a 440 Hz tone so it is not pure silence.
function toneWav(seconds = 1, freq = 440, rate = 16000) {
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

async function probe(label, filename, contentType, model, lang) {
  const form = new FormData();
  form.append('file', new Blob([toneWav()], { type: contentType }), filename);
  form.append('model', model);
  if (lang !== undefined) form.append('language_code', lang);
  try {
    const res = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST', headers: { 'api-subscription-key': KEY }, body: form,
    });
    const text = (await res.text()).slice(0, 300);
    console.log(`\n[${label}] model=${model} lang=${lang ?? '(omitted)'} file=${filename}`);
    console.log(`  HTTP ${res.status} ${res.ok ? 'OK' : ''}`);
    console.log(`  ${text}`);
  } catch (err) {
    console.log(`\n[${label}] ERROR ${err.message}`);
  }
}

console.log(`Configured model: ${MODEL}`);
await probe('wav + configured model + unknown', 'speech.wav', 'audio/wav', MODEL, 'unknown');
await probe('wav + saarika:v2 + unknown', 'speech.wav', 'audio/wav', 'saarika:v2', 'unknown');
await probe('wav + configured model + en-IN', 'speech.wav', 'audio/wav', MODEL, 'en-IN');
await probe('webm + configured model + unknown', 'speech.webm', 'audio/webm', MODEL, 'unknown');

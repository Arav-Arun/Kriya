// Sarvam voice for the web chat's voice mode: speech-to-text (saarika) and
// text-to-speech (bulbul). Thin wrappers over Sarvam's REST API — the routes
// in app.ts call these. Everything throws a clear error when SARVAM_API_KEY is
// unset, and callers surface that as a 503 rather than crashing the chat.
import { config } from '../config/env.ts';
import { supabase } from '../database/client.ts';

const STT_URL = 'https://api.sarvam.ai/speech-to-text';
const TTS_URL = 'https://api.sarvam.ai/text-to-speech';
// bulbul:v2 female voice; its per-request hard limit is 1500 chars.
const TTS_SPEAKER = 'anushka';
const TTS_MAX_CHARS = 1400;

// Languages bulbul can speak. We map the STT-detected language onto this set;
// anything else (incl. plain English) falls back to en-IN, which handles
// English and Hinglish replies well.
const SARVAM_LANGS = new Set([
  'bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN',
  'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
]);

export const voiceEnabled = (): boolean =>
  config.voiceProvider === 'sarvam'
    ? Boolean(config.sarvamApiKey)
    : config.voiceProvider === 'mock';

export interface Transcription {
  transcript: string;
  languageCode: string | null;
}

/**
 * Transcribe a recorded audio clip. `audio` is the blob the browser recorded
 * (webm/opus on Chrome, mp4 on Safari — both accepted by Sarvam).
 * language_code="unknown" lets saarika auto-detect across Indian languages.
 */
export async function transcribe(
  audio: Blob,
  filename = 'audio.webm',
): Promise<Transcription> {
  if (!voiceEnabled()) throw new Error('Voice is not configured.');

  if (config.voiceProvider === 'mock') {
    try {
      // Query the database to check if the last outbound message was a confirmation request
      const { data } = await supabase
        .from('channel_messages')
        .select('body, direction')
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data && data.direction === 'outbound') {
        const lower = data.body.toLowerCase();
        if (lower.includes('confirm') || lower.includes('sure') || lower.includes('block your card') || lower.includes('unblock your card')) {
          return { transcript: 'yes', languageCode: 'en-IN' };
        }
      }
    } catch (err) {
      console.warn('[voice-mock] database state check failed, defaulting to general query:', err);
    }
    
    // Default mock transcript to test card block intent
    return { transcript: 'mera card block kar do', languageCode: 'hi-IN' };
  }

  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', config.sarvamSttModel);
  form.append('language_code', 'unknown');

  const res = await fetch(STT_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': config.sarvamApiKey! },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Sarvam STT ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json() as { transcript?: string; language_code?: string | null };
  return { transcript: String(data.transcript ?? '').trim(), languageCode: data.language_code ?? null };
}

/**
 * Turn an assistant reply into one or more base64 WAV clips. Markdown is
 * stripped to a speakable form and chunked to bulbul's per-request limit; the
 * client plays the clips back to back so long answers still read aloud fully.
 */
export async function synthesize(text: string, languageCode?: string | null): Promise<string[]> {
  if (!voiceEnabled()) throw new Error('Voice is not configured.');

  if (config.voiceProvider === 'mock') {
    // Generate a valid tiny WAV file of silent audio so that HTML5 audio player works.
    const silentWavBase64 = generateSilentWavBase64(0.5);
    return [silentWavBase64];
  }

  const lang = languageCode && SARVAM_LANGS.has(languageCode) ? languageCode : 'en-IN';
  const clean = speakable(text);
  if (!clean) return [];

  const audios: string[] = [];
  for (const chunk of chunkText(clean, TTS_MAX_CHARS)) {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': config.sarvamApiKey!, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: chunk,
        target_language_code: lang,
        speaker: TTS_SPEAKER,
        model: config.sarvamTtsModel,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Sarvam TTS ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json() as { audios?: string[] };
    if (data.audios?.length) audios.push(...data.audios);
  }
  return audios;
}

/** Generate a 0.5-second valid 8kHz 8-bit mono silent PCM WAV file as a base64 string */
function generateSilentWavBase64(seconds = 0.5): string {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * seconds);
  const dataSize = numSamples;
  const fileSize = 36 + dataSize;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(fileSize, 4);
  buffer.write('WAVE', 8);

  // Format chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // Mono channel
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32); // Block align
  buffer.writeUInt16LE(8, 34); // Bits per sample

  // Data chunk header
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM silent value (128 for 8-bit unsigned PCM)
  buffer.fill(128, 44);

  return buffer.toString('base64');
}

/** Strip markdown and symbols so the spoken version reads cleanly. */
function speakable(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')          // code fences
    .replace(/`([^`]+)`/g, '$1')              // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')        // bold
    .replace(/\*([^*]+)\*/g, '$1')            // italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links → text
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')       // headings
    .replace(/^\s*[-*•]\s+/gm, '')            // bullets
    .replace(/[_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pack sentences into ≤max-char chunks; hard-split any single huge sentence. */
function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length > max) { chunks.push(cur.trim()); cur = ''; }
    if (p.length > max) {
      if (cur.trim()) { chunks.push(cur.trim()); cur = ''; }
      for (let i = 0; i < p.length; i += max) chunks.push(p.slice(i, i + max).trim());
    } else {
      cur += p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

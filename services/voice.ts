// Sarvam Voice STT and TTS services.
// Calls:
// - POST https://api.sarvam.ai/speech-to-text
// - POST https://api.sarvam.ai/text-to-speech
import { config } from '../core/env.ts';
import { supabase } from '../core/supabase.ts';

const STT_URL = 'https://api.sarvam.ai/speech-to-text';
const TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const TTS_SPEAKER = 'anushka';
const TTS_MAX_CHARS = 1400;

// Supported Indian languages for TTS. Fallback is en-IN.
const SARVAM_LANGS = new Set([
  'bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN',
  'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
]);

export const voiceEnabled = (): boolean =>
  config.voiceProvider === 'sarvam'
    ? Boolean(config.sarvamApiKey)
    : config.voiceProvider === 'mock';

interface Transcription {
  transcript: string;
  languageCode: string | null;
}

// Transcribe audio using STT API.
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

export function detectLanguage(text: string): string {
  // 1. Script checks (Unicode blocks)
  if (/[\u0900-\u097F]/.test(text)) {
    // Devanagari: Hindi or Marathi
    // If it contains common Marathi words, classify as mr-IN
    if (/\b(आहे|नाही|आणि|होती|होता|करणे|करून|तर|पण|माहिती)\b/.test(text)) {
      return 'mr-IN';
    }
    return 'hi-IN';
  }
  if (/[\u0980-\u09FF]/.test(text)) return 'bn-IN';
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gu-IN';
  if (/[\u0A00-\u0A7F]/.test(text)) return 'pa-IN';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta-IN';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te-IN';
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kn-IN';
  if (/[\u0D00-\u0D7F]/.test(text)) return 'ml-IN';
  if (/[\u0B00-\u0B7F]/.test(text)) return 'od-IN';

  // 2. Hinglish/Latin-script Indian language checks
  const hinglishWords = [
    'hai', 'hain', 'aap', 'apna', 'apni', 'apne', 'mera', 'meri', 'mere', 'ko', 'kar', 'karo', 'karke',
    'karna', 'kijiye', 'krpya', 'kripya', 'diya', 'de', 'do', 'liya', 'le', 'lo', 'nahi', 'nahin', 'na',
    'raha', 'rahi', 'rahe', 'chahiye', 'tha', 'thi', 'the', 'aur', 'se', 'ka', 'ki', 'ke', 'par', 'bhi',
    'hi', 'toh', 'to', 'kya', 'kyun', 'kab', 'kahan', 'kaise', 'kon', 'kaun', 'ek', 'do', 'teen', 'chaar',
    'din', 'mahina', 'saal', 'rupaye', 'rupaya', 'rupaye', 'bhej', 'band', 'chalu', 'dispute', 'transaction',
    'statement', 'balance', 'outstanding', 'card', 'block', 'unblock', 'limit', 'otp', 'pin', 'waive',
    'dhanyavaad', 'shukriya', 'namaste', 'namaskar', 'namaskaram', 'vanakkam'
  ];
  const words = text.toLowerCase().split(/[^a-z]+/);
  let matchCount = 0;
  for (const w of words) {
    if (hinglishWords.includes(w)) {
      matchCount++;
    }
  }
  if (matchCount >= 3 || (words.length > 0 && matchCount / words.length > 0.15)) {
    return 'hi-IN';
  }

  return 'en-IN';
}

// Synthesize text to speech using TTS API.
export async function synthesize(text: string, languageCode?: string | null): Promise<string[]> {
  if (!voiceEnabled()) throw new Error('Voice is not configured.');

  if (config.voiceProvider === 'mock') {
    // Generate a valid tiny WAV file of silent audio so that HTML5 audio player works.
    const silentWavBase64 = generateSilentWavBase64(0.5);
    return [silentWavBase64];
  }

  const lang = languageCode && SARVAM_LANGS.has(languageCode) ? languageCode : detectLanguage(text);
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

// Generate a 0.5-second 8kHz silent WAV file as base64.
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

// Strip markdown and symbols for spoken text compatibility.
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

// Split text into max-length chunks for the TTS speaker limit.
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

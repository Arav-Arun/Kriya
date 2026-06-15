// Upload analysis: every file the customer uploads (statement PDF/CSV/TXT or
// evidence image) goes through one path — extract what we can locally, then
// let the model read it. The summary becomes evidence the agents can use.
// Storage itself goes through src/services/storage.ts (Supabase Storage in
// production, local filesystem in development).
import path from 'node:path';

export type AttachmentType = 'statement' | 'evidence';

export const SUPPORTED_UPLOAD_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp',
  'application/pdf', 'text/csv', 'text/plain',
  'application/csv', 'application/vnd.ms-excel',
]);

const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function normalizeMimeType(mimeType: string, filename: string) {
  let type = mimeType.toLowerCase().split(';')[0].trim();
  if (!type || type === 'application/octet-stream') {
    type = EXT_TO_MIME[path.extname(filename).toLowerCase()] ?? type;
  }
  if (type === 'image/jpg') type = 'image/jpeg';
  return type;
}

function classify(filename: string, mimeType: string): AttachmentType {
  if (mimeType.startsWith('image/')) {
    return /statement|bill|transactions|ledger/i.test(filename) ? 'statement' : 'evidence';
  }
  return 'statement'; // PDFs, CSVs, and text exports are treated as statements
}

// Lightweight text extraction from unencrypted PDFs (Tj/TJ literals).
function extractPdfText(bytes: Buffer) {
  const raw = bytes.toString('latin1');
  const decode = (s: string) => s
    .replace(/\\[nr]/g, '\n').replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
  const chunks: string[] = [];
  for (const m of raw.matchAll(/\(([^()]{2,240})\)\s*Tj/g)) chunks.push(decode(m[1]));
  for (const m of raw.matchAll(/\[((?:.|\n){2,900}?)\]\s*TJ/g)) {
    for (const piece of m[1].matchAll(/\(([^()]{2,240})\)/g)) chunks.push(decode(piece[1]));
  }
  return chunks.join('\n').replace(/\s+\n/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
}

function extractOutputText(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  const chunks: string[] = [];
  for (const item of data?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

const STATEMENT_BRIEF = `Extract the support-relevant facts: total amount due, minimum due, payment due date, statement period, credit limit, available limit, fees and charges (name + amount), notable transactions (date, merchant, amount), failed or duplicate-looking charges, and reward points. Be concise (under 200 words), use ₹ for amounts, and write "unknown" for anything not present.`;
const EVIDENCE_BRIEF = `Extract the dispute-relevant facts: merchant names, amounts, dates, card last four, transaction or order IDs, payment status, fee names, and error messages. Be concise (under 120 words) and write "unknown" for anything not visible.`;

async function modelRead(input: object[]): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = (process.env.SENTINEL_MODEL ?? 'openai/gpt-4o-mini').replace(/^openai\//, '');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: input }] }),
  }).catch(() => null);
  if (!res?.ok) return null;
  return extractOutputText(await res.json()) || null;
}

export async function analyzeUpload(dataUrl: string, filename: string, mimeType: string, bytes: Buffer) {
  const attachmentType = classify(filename, mimeType);
  const brief = attachmentType === 'statement' ? STATEMENT_BRIEF : EVIDENCE_BRIEF;

  let analysis: string | null = null;
  if (mimeType.startsWith('image/')) {
    analysis = await modelRead([
      { type: 'input_text', text: `This is a customer-uploaded credit-card ${attachmentType} image (${filename}). ${brief}` },
      { type: 'input_image', image_url: dataUrl },
    ]);
  } else {
    const text = (mimeType === 'application/pdf'
      ? extractPdfText(bytes)
      : new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/ /g, ' ')
    ).slice(0, 40000);
    if (text.length > 40) {
      analysis = await modelRead([
        { type: 'input_text', text: `This is text extracted from a customer-uploaded credit-card ${attachmentType} (${filename}). ${brief}\n\n--- FILE CONTENT ---\n${text}` },
      ]);
    } else {
      analysis = 'The file appears scanned, encrypted, or image-only, so its contents could not be read automatically. It is stored as evidence — mention the charge, amount, or date in chat, or upload a CSV export or screenshot instead.';
    }
  }

  return {
    attachmentType,
    analysis: analysis ?? `${attachmentType === 'statement' ? 'Statement' : 'Evidence'} uploaded and stored. Automatic analysis is unavailable right now.`,
  };
}

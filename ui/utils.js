// Sentinel UI Utilities

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const mdInline = (s) => s
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

const mdCells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

// Markdown → HTML for assistant messages: bold, code, bullets, GitHub tables.
export function md(t) {
  const lines = esc(t).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const sep = lines[i + 1] ?? '';
    // A header row followed by a |---|:--:| separator starts a table.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(sep)) {
      const head = mdCells(line);
      const aligns = mdCells(sep).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left'));
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(mdCells(lines[i])); i += 1; }
      const th = head.map((h, k) => `<th style="text-align:${aligns[k] || 'left'}">${mdInline(h)}</th>`).join('');
      const trs = body.map((r) => `<tr>${r.map((c, k) => `<td style="text-align:${aligns[k] || 'left'}">${mdInline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }
    out.push(mdInline(line.replace(/^[-•]\s+(.*)$/, '• $1')));
    i += 1;
  }
  return out.join('\n')
    .replace(/\n*(<table[\s\S]*?<\/table>)\n*/g, '$1')
    .replace(/\n/g, '<br>');
}

export const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN');

export const fmtWhen = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d - new Date()) / 86400000);
};

// Decode a recorded audio blob (webm/opus, mp4/aac, …) and re-encode it as a
// 16 kHz mono 16-bit WAV — the format Sarvam STT reliably accepts. The browser's
// MediaRecorder emits webm/opus, which Sarvam rejects with a 400 ("format"), so
// we transcode in the page before upload. Returns null if the browser can't
// decode the blob, letting the caller fall back to the original.
export async function wavFromBlob(blob) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AudioCtx || !OfflineCtx) return null;
    const ac = new AudioCtx();
    const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
    if (ac.close) ac.close();
    const rate = 16000;
    const offline = new OfflineCtx(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), rate);
  } catch {
    return null;
  }
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

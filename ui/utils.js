// Sentinel UI Utilities

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const mdInline = (s) => s
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

export const mdCells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

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

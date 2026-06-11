// Shared UI helpers: nav, fetch, badges, and a minimal markdown renderer.

function renderNav(active) {
  const nav = document.createElement('nav');
  nav.innerHTML = `
    <div class="brand">Sentinel</div>
    <span class="dash-badge">Internal</span>
    <div class="nav-spacer"></div>
    <a href="/dashboard" data-page="dashboard">Dashboard</a>
    <a href="/knowledge" data-page="knowledge">Knowledge Base</a>`;
  nav.querySelector(`[data-page="${active}"]`)?.classList.add('active');
  document.body.prepend(nav);
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function priorityBadge(p) {
  const cls = { Critical: 'red', High: 'red', Medium: 'amber', Low: 'grey' }[p] ?? 'grey';
  return `<span class="badge ${cls}">${esc(p)}</span>`;
}

function statusBadge(s) {
  const cls = s === 'OPEN' ? 'green' : 'grey';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

// Minimal markdown → HTML for the knowledge docs (headings, lists, tables,
// bold, inline code, hr). Input is our own generated markdown only.
function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let table = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push('</tbody></table>'); table = false; } };
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*$/.test(line)) { closeList(); closeTable(); continue; }
    if (/^---+$/.test(line)) { closeList(); closeTable(); out.push('<hr>'); continue; }

    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { closeList(); closeTable(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
      if (!table) {
        closeList();
        out.push('<table><tbody>');
        out.push(`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`);
        table = true;
      } else {
        out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      continue;
    }
    closeTable();

    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    const ul = line.match(/^\s*[-•]\s+(.*)/);
    if (ol || ul) {
      const kind = ol ? 'ol' : 'ul';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ol ?? ul)[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTable();
  return out.join('\n');
}

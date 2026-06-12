// Shared UI helpers: nav, fetch, and badges.

function renderNav(active) {
  const nav = document.createElement('nav');
  nav.innerHTML = `
    <div class="brand">Sentinel</div>
    <span class="dash-badge">Internal</span>
    <div class="nav-spacer"></div>
    <a href="/dashboard" data-page="dashboard">Dashboard</a>`;
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


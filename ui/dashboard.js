// Internal operations dashboard — live portfolio analytics + escalation queue.
// All figures come from /api/analytics and /api/escalations, which compute
// everything from the database on each request. Nothing here is hard-coded.
(function () {
  const kpisEl = document.getElementById('kpis');
  const analyticsEl = document.getElementById('analytics');
  const listEl = document.getElementById('list');
  const detailEl = document.getElementById('detail');
  const statsEl = document.getElementById('stats');

  // ── Formatting helpers ──────────────────────────────────────────────
  const num = (n) => Number(n ?? 0).toLocaleString('en-IN');
  const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN');
  function inrShort(n) {
    n = Number(n ?? 0);
    const sign = n < 0 ? '-' : '';
    n = Math.abs(n);
    if (n >= 1e7) return `${sign}₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`;
    if (n >= 1e5) return `${sign}₹${(n / 1e5).toFixed(1).replace(/\.0$/, '')} L`;
    if (n >= 1e3) return `${sign}₹${Math.round(n / 1e3)}k`;
    return `${sign}₹${Math.round(n)}`;
  }
  const fmtMonth = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });

  // ── Label + colour maps (keys are the real DB enum values) ──────────
  const PAY_LABELS = { on_time: 'On time', late: 'Late', partial: 'Partial', missed: 'Missed' };
  const PAY_COLORS = { on_time: 'var(--green)', late: 'var(--amber)', partial: '#8ab4f8', missed: 'var(--red)' };
  const CIBIL_COLORS = { Excellent: 'var(--green)', Good: 'var(--accent)', Fair: 'var(--amber)', Poor: 'var(--red)' };
  const VARIANT_COLORS = { Classic: '#7b8aa0', Gold: '#c9a227', Platinum: '#9aa6bf', Signature: '#7c4dff' };
  const TXN_LABELS = { SUCCESS: 'Approved', DECLINED: 'Declined', REFUNDED: 'Refunded' };
  const TXN_COLORS = { SUCCESS: 'var(--green)', DECLINED: 'var(--red)', REFUNDED: '#8ab4f8' };
  const DISPUTE_LABELS = { under_review: 'Under review', provisional_credit: 'Provisional credit', won: 'Won', lost: 'Lost' };
  const DISPUTE_COLORS = { under_review: 'var(--amber)', provisional_credit: '#8ab4f8', won: 'var(--green)', lost: 'var(--red)' };
  const FEE_LABELS = {
    late_payment: 'Late payment', annual: 'Annual fee', finance_charge: 'Finance charges',
    forex_markup: 'Forex markup', cash_advance: 'Cash advance', overlimit: 'Overlimit',
    card_replacement: 'Card replacement',
  };

  // ── Chart primitives ────────────────────────────────────────────────
  function ordered(rows, key, order) {
    const rank = (k) => { const i = order.indexOf(k); return i < 0 ? 999 : i; };
    return [...rows].sort((a, b) => rank(a[key]) - rank(b[key]));
  }

  function aCard(title, figure, body, wide) {
    return `
      <div class="analytics-card${wide ? ' wide' : ''}">
        <div class="ac-head">
          <span class="ac-title">${esc(title)}</span>
          ${figure ? `<span class="ac-figure">${figure}</span>` : ''}
        </div>
        ${body}
      </div>`;
  }

  function hbars(rows, opts = {}) {
    if (!rows.length) return '<div class="empty-mini">No data.</div>';
    const max = opts.max ?? Math.max(...rows.map((r) => r.value), 1);
    return rows.map((r) => `
      <div class="spend-row">
        <div class="spend-label"><span>${esc(r.label)}</span><b>${r.display ?? num(r.value)}</b></div>
        <div class="spend-bar"><i style="width:${Math.max(2, Math.round(r.value / max * 100))}%${r.color ? `;background:${r.color}` : ''}"></i></div>
        ${r.sub ? `<small>${esc(r.sub)}</small>` : ''}
      </div>`).join('');
  }

  function vbars(rows) {
    if (!rows.length) return '<div class="empty-mini">No data.</div>';
    const max = Math.max(...rows.map((r) => r.value), 1);
    return `<div class="trend">${rows.map((r) => `
      <div class="trend-col" title="${esc(r.title ?? '')}">
        <b>${r.top}</b>
        <i style="height:${Math.max(4, Math.round(r.value / max * 100))}%"></i>
        <span>${esc(r.label)}</span>
      </div>`).join('')}</div>`;
  }

  function donut(segments, centerNum, centerSub) {
    const size = 132, stroke = 24;
    const live = segments.filter((s) => s.value > 0);
    const total = live.reduce((s, x) => s + x.value, 0) || 1;
    const r = (size - stroke) / 2, cx = size / 2, cy = size / 2;
    const circ = 2 * Math.PI * r;
    let acc = 0;
    const arcs = live.map((seg) => {
      const frac = seg.value / total;
      const dash = `${(frac * circ).toFixed(2)} ${circ.toFixed(2)}`;
      const rot = (-90 + acc * 360).toFixed(2);
      acc += frac;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${stroke}" stroke-dasharray="${dash}" transform="rotate(${rot} ${cx} ${cy})"/>`;
    }).join('');
    const center = centerNum != null ? `
      <text x="${cx}" y="${cy - 1}" text-anchor="middle" class="donut-center">${centerNum}</text>
      ${centerSub ? `<text x="${cx}" y="${cy + 15}" text-anchor="middle" class="donut-center-sub">${esc(centerSub)}</text>` : ''}` : '';
    return `<svg viewBox="0 0 ${size} ${size}" class="donut">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(95,99,104,0.22)" stroke-width="${stroke}"/>
      ${arcs}${center}
    </svg>`;
  }

  function legend(segments) {
    return `<div class="donut-legend">${segments.filter((s) => s.value > 0).map((s) =>
      `<span><i style="background:${s.color}"></i>${esc(s.label)}<b>${s.display ?? num(s.value)}</b></span>`).join('')}</div>`;
  }

  // ── Analytics ───────────────────────────────────────────────────────
  async function loadAnalytics() {
    let a;
    try {
      a = await fetch('/api/analytics').then((r) => r.json());
    } catch {
      kpisEl.innerHTML = '<div class="empty">Could not load analytics.</div>';
      return;
    }
    const o = a.overview ?? {};

    const kpi = (value, label) => `<div class="stat-card"><div class="stat-num">${value}</div><div class="stat-label">${label}</div></div>`;
    kpisEl.innerHTML = [
      kpi(num(o.customers), 'Cardholders'),
      kpi(num(o.active_cards), 'Active cards'),
      kpi(inrShort(o.total_outstanding), 'Outstanding'),
      kpi(`${o.utilization_pct ?? 0}%`, 'Utilization'),
      kpi(num(o.avg_cibil), 'Avg CIBIL'),
      kpi(num(o.open_disputes), 'Open disputes'),
      kpi(num(o.active_emis), 'Active EMIs'),
      kpi(inrShort(o.reward_liability_inr), 'Reward liability'),
    ].join('');

    const cards = [];

    // Monthly spend — full width
    const ms = a.monthly_spend ?? [];
    const msTotal = ms.reduce((s, m) => s + Number(m.total), 0);
    cards.push(aCard(
      'Monthly spend · last 12 months',
      `${inrShort(msTotal)} <small>total</small>`,
      vbars(ms.map((m) => ({
        value: Number(m.total), top: inrShort(m.total), label: fmtMonth(m.month),
        title: `${m.month} · ${inr(m.total)} · ${num(m.txn_count)} txns`,
      }))),
      true,
    ));

    // Spend by category
    const cat = a.category_spend ?? [];
    cards.push(aCard(
      'Spend by category · last 3 months',
      cat.length ? inrShort(cat.reduce((s, x) => s + Number(x.total), 0)) : '',
      hbars(cat.map((s) => ({
        label: s.category, value: Number(s.total), display: inrShort(s.total),
        sub: `${num(s.txn_count)} txns · ${num(s.points)} pts`,
      }))),
    ));

    // Top merchants
    const tm = a.top_merchants ?? [];
    cards.push(aCard(
      'Top merchants · last 3 months', '',
      hbars(tm.map((m) => ({
        label: m.merchant, value: Number(m.total), display: inrShort(m.total),
        sub: `${num(m.txn_count)} txns`,
      }))),
    ));

    // Payment health
    const ph = ordered(a.payment_health ?? [], 'payment_status', ['on_time', 'late', 'partial', 'missed']);
    const phTotal = ph.reduce((s, x) => s + Number(x.count), 0) || 1;
    const onTime = Number(ph.find((x) => x.payment_status === 'on_time')?.count ?? 0);
    cards.push(aCard(
      'Payment health · all statements',
      `${Math.round(onTime / phTotal * 100)}% <small>on time</small>`,
      hbars(ph.map((x) => ({
        label: PAY_LABELS[x.payment_status] ?? x.payment_status, value: Number(x.count),
        display: `${num(x.count)} · ${Math.round(x.count / phTotal * 100)}%`, color: PAY_COLORS[x.payment_status],
      }))),
    ));

    // CIBIL distribution
    const cb = ordered(a.cibil_distribution ?? [], 'band', ['Excellent', 'Good', 'Fair', 'Poor']);
    const cbTotal = cb.reduce((s, x) => s + Number(x.count), 0) || 1;
    cards.push(aCard(
      'Credit score distribution',
      `${num(o.avg_cibil)} <small>avg</small>`,
      hbars(cb.map((x) => ({
        label: `${x.band} (${x.min_score}–${x.max_score})`, value: Number(x.count),
        display: `${num(x.count)} · ${Math.round(x.count / cbTotal * 100)}%`, color: CIBIL_COLORS[x.band],
      }))),
    ));

    // Card variant mix — donut
    const vm = ordered(a.variant_mix ?? [], 'card_variant', ['Classic', 'Gold', 'Platinum', 'Signature']);
    const vmSegs = vm.map((v) => ({ label: v.card_variant, value: Number(v.count), color: VARIANT_COLORS[v.card_variant] ?? 'var(--accent)' }));
    cards.push(aCard(
      'Card variant mix', `${num(o.customers)} <small>cards</small>`,
      `<div class="donut-wrap">${donut(vmSegs, num(o.customers), 'cards')}${legend(vmSegs)}</div>`,
    ));

    // Transaction approvals — donut
    const ts = a.txn_status ?? [];
    const tsTotal = ts.reduce((s, x) => s + Number(x.count), 0) || 1;
    const declined = Number(ts.find((x) => x.status === 'DECLINED')?.count ?? 0);
    const tsSegs = ts.map((x) => ({ label: TXN_LABELS[x.status] ?? x.status, value: Number(x.count), color: TXN_COLORS[x.status] ?? 'var(--accent)' }));
    cards.push(aCard(
      'Transaction approvals · last 3 months',
      `${(declined / tsTotal * 100).toFixed(1)}% <small>declined</small>`,
      `<div class="donut-wrap">${donut(tsSegs, num(tsTotal), 'txns')}${legend(tsSegs)}</div>`,
    ));

    // Disputes by status
    const disp = ordered(a.dispute_breakdown ?? [], 'status', ['under_review', 'provisional_credit', 'won', 'lost']);
    cards.push(aCard(
      'Disputes by status', `${num(o.open_disputes)} <small>open</small>`,
      disp.length ? hbars(disp.map((x) => ({
        label: DISPUTE_LABELS[x.status] ?? x.status, value: Number(x.count),
        display: `${num(x.count)} · ${inrShort(x.amount)}`, color: DISPUTE_COLORS[x.status],
      }))) : '<div class="empty-mini">No disputes.</div>',
    ));

    // Fee revenue
    const fr = a.fee_revenue ?? [];
    const frTotal = fr.reduce((s, x) => s + Number(x.collected), 0);
    cards.push(aCard(
      'Fee revenue by type · all time',
      `${inrShort(frTotal)} <small>collected</small>`,
      hbars(fr.map((x) => ({
        label: FEE_LABELS[x.fee_type] ?? x.fee_type, value: Number(x.collected), display: inrShort(x.collected),
        sub: `${num(x.count)} charges${Number(x.waived) > 0 ? ` · ${inrShort(x.waived)} waived` : ''}`,
      }))),
    ));

    analyticsEl.innerHTML = cards.join('');
  }

  // ── Escalation queue ────────────────────────────────────────────────
  async function loadEscalations() {
    const escalations = await fetch('/api/escalations').then((r) => r.json());

    const open = escalations.filter((e) => e.status === 'open').length;
    const critical = escalations.filter((e) => e.priority === 'Critical' && e.status === 'open').length;
    const high = escalations.filter((e) => e.priority === 'High' && e.status === 'open').length;
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-num">${escalations.length}</div><div class="stat-label">Total</div></div>
      <div class="stat-card"><div class="stat-num">${open}</div><div class="stat-label">Open</div></div>
      <div class="stat-card stat-critical"><div class="stat-num">${critical}</div><div class="stat-label">Critical</div></div>
      <div class="stat-card stat-high"><div class="stat-num">${high}</div><div class="stat-label">High</div></div>
    `;

    if (escalations.length === 0) {
      listEl.innerHTML = '<div class="empty">No unresolved exceptions.</div>';
      return;
    }

    listEl.innerHTML = escalations.map((e) => `
      <div class="esc-row" data-id="${esc(e.id)}">
        <div class="esc-id mono">${esc(e.id)}</div>
        <div class="esc-cat">${esc(e.category)}</div>
        <div>${priorityBadge(e.priority)}</div>
        <div class="esc-team">${esc(e.assigned_team)}</div>
        <div>${statusBadge(e.status?.toUpperCase() ?? 'OPEN')}</div>
        <div class="esc-summary">${esc(e.summary)}</div>
        <div class="esc-date">${new Date(e.created_at).toLocaleDateString()}</div>
      </div>
    `).join('');

    for (const row of listEl.querySelectorAll('.esc-row')) {
      row.onclick = () => showDetail(row.dataset.id);
    }
  }

  async function showDetail(id) {
    const e = await fetch(`/api/escalations/${id}`).then((r) => r.json());
    if (e.error) return;

    detailEl.hidden = false;
    detailEl.innerHTML = `
      <div class="detail-header">
        <h2>${esc(e.id)} — ${esc(e.category)}</h2>
        <div>${priorityBadge(e.priority)} ${statusBadge(e.status?.toUpperCase() ?? 'OPEN')}</div>
      </div>
      <div class="kv">
        <dt>Customer ID</dt><dd>${e.customer_id ?? '—'}</dd>
        <dt>Assigned Team</dt><dd>${esc(e.assigned_team)}</dd>
        <dt>Created</dt><dd>${new Date(e.created_at).toLocaleString()}</dd>
        ${e.resolved_at ? `<dt>Resolved</dt><dd>${new Date(e.resolved_at).toLocaleString()} by ${esc(e.resolved_by ?? '—')}</dd>` : ''}
      </div>
      <h3>Summary</h3>
      <p>${esc(e.summary)}</p>
      ${e.investigation ? `<h3>Investigation</h3><p>${esc(e.investigation)}</p>` : ''}
      ${e.recommended_action ? `<h3>Recommended Action</h3><p>${esc(e.recommended_action)}</p>` : ''}
      ${e.resolution_notes ? `<h3>Resolution Notes</h3><p>${esc(e.resolution_notes)}</p>` : ''}
      ${e.status === 'open' ? `
        <div class="resolve-form">
          <h3>Resolve</h3>
          <input type="text" id="resolve-by" placeholder="Your name" class="resolve-input">
          <textarea id="resolve-notes" placeholder="Resolution notes..." class="resolve-textarea"></textarea>
          <button class="primary" id="resolve-btn">Mark Resolved</button>
        </div>
      ` : ''}
    `;

    const resolveBtn = document.getElementById('resolve-btn');
    if (resolveBtn) {
      resolveBtn.onclick = async () => {
        const by = document.getElementById('resolve-by').value || 'Support';
        const notes = document.getElementById('resolve-notes').value || '';
        await fetch(`/api/escalations/${id}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resolved_by: by, notes }),
        });
        await loadEscalations();
        showDetail(id);
      };
    }

    detailEl.scrollIntoView({ behavior: 'smooth' });
  }

  loadAnalytics();
  loadEscalations();
})();

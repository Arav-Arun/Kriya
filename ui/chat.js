// Sentinel chat. Each turn dispatches the chat-turn workflow, then consumes
// the live run stream: stage events drive the execution trace, text_delta
// events stream the reply, and the final 'turn' event carries the confirmed
// actions rendered as action cards.
(function () {
  const customer = JSON.parse(sessionStorage.getItem('customer') || 'null');
  if (!customer) { window.location.assign('/'); return; }

  const messagesEl = document.getElementById('messages');
  const welcomeEl = document.getElementById('welcome');
  const inputEl = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');
  const uploadStatus = document.getElementById('upload-status');
  const sidebarEl = document.getElementById('sidebar-content');
  const historyListEl = document.getElementById('history-list');

  const firstName = String(customer.name ?? '').split(' ')[0];
  document.getElementById('chat-user').textContent = `${customer.name} · **** ${customer.card_last4}`;
  document.getElementById('welcome-title').textContent = `Hi ${firstName}.`;
  document.getElementById('end-session-btn').onclick = () => {
    sessionStorage.removeItem('customer');
    window.location.assign('/');
  };

  // ── sidebar toggle (collapse on desktop, slide-in drawer on mobile) ──
  const SIDEBAR_PREF = 'sentinel:sidebar-collapsed';
  const mobileQuery = window.matchMedia('(max-width: 800px)');
  if (localStorage.getItem(SIDEBAR_PREF) === '1') document.body.classList.add('sidebar-collapsed');
  const closeDrawer = () => document.body.classList.remove('sidebar-open');
  document.getElementById('sidebar-toggle').onclick = () => {
    if (mobileQuery.matches) {
      document.body.classList.toggle('sidebar-open');
    } else {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      try { localStorage.setItem(SIDEBAR_PREF, collapsed ? '1' : '0'); } catch { /* private mode */ }
    }
  };
  document.getElementById('sidebar-backdrop').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  let busy = false;
  let started = false;
  let eventSource = null;
  let conversationId = Number(sessionStorage.getItem(`conversation:${customer.id}`) || 0) || null;

  // ── helpers ─────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const mdInline = (s) => s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const mdCells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  // Markdown → HTML for assistant messages: bold, code, bullets, GitHub tables.
  function md(t) {
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
  const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN');
  const fmtWhen = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  function hideWelcome() {
    if (!started) { welcomeEl.style.display = 'none'; started = true; }
  }
  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function resetMessagePane() {
    messagesEl.querySelectorAll('.msg').forEach((node) => node.remove());
    welcomeEl.style.display = '';
    started = false;
  }

  function addBubble(role, text) {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = `msg msg-${role}`;
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble-${role}`;
    if (role === 'assistant') bubble.innerHTML = md(text);
    else bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollDown();
    return bubble;
  }

  function addTyping() {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    wrap.dataset.typing = '1';
    wrap.innerHTML = '<div class="bubble bubble-assistant"><span class="typing-dots"><span></span><span></span><span></span></span></div>';
    messagesEl.appendChild(wrap);
    scrollDown();
  }
  function removeTyping() {
    messagesEl.querySelectorAll('[data-typing]').forEach((el) => el.remove());
  }

  function addStatus(text, type) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-status';
    wrap.innerHTML = `<div class="status-card ${type === 'error' ? 'status-error' : ''}">${esc(text)}</div>`;
    messagesEl.appendChild(wrap);
    scrollDown();
  }

  // ── action cards ────────────────────────────────────────────────────
  const ACTION_RENDER = {
    fee_waived: (d) => ['green', `Fee waived — ${inr(d?.amount)} ${String(d?.fee_type ?? '').replace(/_/g, ' ')} reversed`, d?.new_outstanding_total != null ? `Outstanding is now ${inr(d.new_outstanding_total)}` : ''],
    refund_initiated: (d) => ['green', `Refund credited — ${inr(d?.amount)} from ${d?.merchant ?? 'merchant'}`, d?.new_available_limit != null ? `Available limit is now ${inr(d.new_available_limit)}` : ''],
    refund_rejected: (d) => ['red', 'Refund not possible', d?.reason ?? ''],
    card_blocked: (d) => ['red', 'Card blocked', d?.reason ?? ''],
    card_unblocked: () => ['green', 'Card unblocked', 'Your card is active again'],
    card_hotlisted: () => ['red', 'Card permanently disabled', 'A replacement will be arranged'],
    international_toggled: (d) => ['blue', `International usage ${d?.enabled ? 'enabled' : 'disabled'}`, ''],
    emi_converted: (d) => ['blue', `EMI created — ${inr(d?.amount)} over ${d?.tenure} months`, `${inr(d?.emi_amount)}/month`],
    emi_foreclosed: (d) => ['blue', 'EMI foreclosed', `Total payable ${inr((d?.remaining_principal ?? 0) + (d?.foreclosure_charge ?? 0))}`],
    rewards_redeemed: (d) => ['green', `${Number(d?.points ?? 0).toLocaleString('en-IN')} points redeemed`, `${inr(d?.value_inr)} statement credit`],
    credit_limit_adjusted: (d) => ['green', 'Credit limit increased', `${inr(d?.old_limit)} → ${inr(d?.new_limit)}`],
    card_closure_initiated: () => ['amber', 'Card closure initiated', 'Confirmation within 7 working days'],
    escalation_created: (d) => ['amber', `Sent for specialist review — ${d?.escalation_id ?? ''}`, 'A specialist will take it from here'],
    context_recorded: () => ['blue', 'Account details saved', ''],
    transaction_recorded: (d) => ['blue', `Transaction noted — ${d?.merchant ?? ''} ${inr(d?.amount)}`, ''],
    card_control_updated: (d) => ['blue', `${String(d?.control ?? '').replace('_enabled', '').replace(/_/g, ' ')} transactions ${d?.enabled ? 'enabled' : 'disabled'}`, 'Card control updated'],
    autopay_updated: (d) => ['blue', `Autopay ${d?.enabled ? 'enabled' : 'disabled'}`, d?.enabled ? `Will pay the ${d?.mode === 'total_due' ? 'full statement' : 'minimum due'} automatically` : ''],
    dispute_raised: (d) => ['amber', `Dispute raised — ${d?.dispute_id ?? ''} · ${inr(d?.amount)} at ${d?.merchant ?? 'merchant'}`, 'Provisional credit within 7 working days; resolution in 30–45 days per RBI'],
    subscription_cancelled: (d) => ['green', `Subscription cancelled — ${d?.merchant ?? ''} ${inr(d?.amount)}/${d?.billing_cycle === 'annual' ? 'yr' : 'mo'}`, 'Autopay mandate revoked — no further charges to your card'],
  };

  function addActionCard(action) {
    const fn = ACTION_RENDER[action.type];
    if (!fn) return;
    const [color, label, detail] = fn(action.detail);
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    wrap.innerHTML = `
      <div class="action-card action-${color}">
        <span class="action-copy">
          <span>${esc(label)}</span>
          ${detail ? `<span class="ac-detail">${esc(detail)}</span>` : ''}
        </span>
      </div>`;
    messagesEl.appendChild(wrap);
    scrollDown();
  }

  // ── execution trace (agentic pipeline) ──────────────────────────────
  const PARALLEL_SET = new Set(['investigation', 'policy', 'precedent']);
  const stageTimers = {};

  function createTrace() {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    const card = document.createElement('div');
    card.className = 'trace-card';
    card.innerHTML = `
      <div class="trace-stage" data-stage="triage">
        <span class="trace-dot"></span>
        <span class="trace-label">Triage</span>
        <span class="trace-meta"></span>
        <span class="trace-time"></span>
      </div>
      <div class="trace-parallel" data-stage="parallel" hidden>
        <div class="trace-parallel-tag">Evidence · Policy · Precedent</div>
        <div class="trace-parallel-body">
          <div class="trace-stage" data-stage="investigation" hidden>
            <span class="trace-dot"></span>
            <span class="trace-label">Account Evidence</span>
            <span class="trace-meta"></span>
            <span class="trace-time"></span>
          </div>
          <div class="trace-stage" data-stage="policy" hidden>
            <span class="trace-dot"></span>
            <span class="trace-label">Policy Check</span>
            <span class="trace-meta"></span>
            <span class="trace-time"></span>
          </div>
          <div class="trace-stage" data-stage="precedent" hidden>
            <span class="trace-dot"></span>
            <span class="trace-label">Precedent Review</span>
            <span class="trace-meta"></span>
            <span class="trace-time"></span>
          </div>
        </div>
      </div>
      <div class="trace-stage" data-stage="resolution" hidden>
        <span class="trace-dot"></span>
        <span class="trace-label">Action Execution</span>
        <span class="trace-meta"></span>
        <span class="trace-time"></span>
      </div>`;
    wrap.appendChild(card);
    messagesEl.appendChild(wrap);
    scrollDown();
    return card;
  }

  function setStage(card, stage, status, attrs) {
    if (PARALLEL_SET.has(stage)) {
      const group = card.querySelector('[data-stage="parallel"]');
      if (group) {
        group.hidden = false;
        if (!group.classList.contains('done')) group.className = 'trace-parallel running';
      }
    }

    const row = card.querySelector(`.trace-stage[data-stage="${stage}"]`);
    if (!row) return;
    if (status === 'skipped' && row.hidden) return;
    row.hidden = false;
    row.className = `trace-stage ${status}`;

    if (status === 'running') stageTimers[stage] = Date.now();

    if (status === 'done' || status === 'error') {
      const timeEl = row.querySelector('.trace-time');
      if (timeEl) {
        const ms = attrs?.elapsed_ms ?? (stageTimers[stage] ? Date.now() - stageTimers[stage] : 0);
        if (ms > 0) timeEl.textContent = `${(ms / 1000).toFixed(1)}s`;
      }
      const metaEl = row.querySelector('.trace-meta');
      if (metaEl && status === 'done' && attrs?.output) {
        const o = attrs.output;
        if (stage === 'triage') metaEl.textContent = `${o.category ?? ''} · ${o.urgency ?? ''}`;
        else if (stage === 'investigation') metaEl.textContent = `${o.findings?.length ?? 0} findings · ${o.flags?.length ?? 0} flags`;
        else if (stage === 'policy') metaEl.textContent = o.eligibility ?? '';
        else if (stage === 'precedent') metaEl.textContent = `${o.cases?.length ?? 0} similar cases`;
      }
    }

    if (PARALLEL_SET.has(stage) && (status === 'done' || status === 'skipped')) {
      const group = card.querySelector('[data-stage="parallel"]');
      if (group) {
        const stages = group.querySelectorAll('.trace-stage');
        const allDone = [...stages].every((s) => s.classList.contains('done') || s.classList.contains('skipped') || s.hidden);
        const anyVisible = [...stages].some((s) => !s.hidden);
        if (allDone && anyVisible) group.className = 'trace-parallel done';
      }
    }

    scrollDown();
  }

  // ── sidebar ─────────────────────────────────────────────────────────
  const daysUntil = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    return Math.ceil((d - new Date()) / 86400000);
  };

  async function loadSidebar() {
    try {
      const p = await fetch(`/api/customer/${customer.id}/profile`).then((r) => r.json());
      const stCls = p.card_status === 'active' ? 'green' : p.card_status === 'blocked' ? 'red' : 'amber';
      const row = (label, value) => `<div class="sb-row"><span class="sb-label">${label}</span><span class="sb-value">${value}</span></div>`;
      const util = p.credit_limit > 0 ? Math.min(100, Math.round(p.outstanding_total / p.credit_limit * 100)) : 0;
      const utilCls = util >= 80 ? 'util-high' : util >= 50 ? 'util-warn' : '';
      const due = daysUntil(p.due_date);
      const dueBadge = due == null ? '' :
        due < 0 ? '<span class="badge red">Overdue</span>' :
        due <= 3 ? `<span class="badge red">${due}d left</span>` :
        due <= 7 ? `<span class="badge amber">${due}d left</span>` :
        `<span class="badge grey">${due}d left</span>`;
      const fmtDue = p.due_date
        ? new Date(`${p.due_date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
        : '—';
      sidebarEl.innerHTML = [
        row('Card', `${esc(p.card_variant)} · ${esc(p.card_last4)}`),
        `<div class="sb-row"><span class="sb-label">Status</span><span class="badge ${stCls}">${esc(p.card_status)}</span></div>`,
        row('Credit limit', inr(p.credit_limit)),
        `<div class="util-wrap"><div class="util-head"><span>${inr(p.outstanding_total)} of ${inr(p.credit_limit)} used</span><b>${util}%</b></div>
          <div class="spend-bar"><i class="${utilCls}" style="width:${util}%"></i></div></div>`,
        row('Available', inr(p.available_limit)),
        row('Min. due', inr(p.minimum_due)),
        `<div class="sb-row"><span class="sb-label">Due date</span><span class="sb-value sb-due">${esc(fmtDue)}${dueBadge}</span></div>`,
        row('Reward points', Number(p.reward_points ?? 0).toLocaleString('en-IN')),
        row('CIBIL', `<b class="${p.cibil_score >= 750 ? 'pts' : ''}">${p.cibil_score ?? '—'}</b>`),
        p.payment_summary?.total ? row('On-time payments', `${p.payment_summary.on_time_pct}%`) : '',
      ].join('');
    } catch {
      sidebarEl.innerHTML = '<div class="sidebar-loading">Could not load account.</div>';
    }
  }

  // ── conversations (open / rename / delete) ──────────────────────────
  const PENCIL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  const TRASH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  function startRename(item, id) {
    const strong = item.querySelector('strong');
    if (!strong) return;
    const current = strong.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'history-rename';
    input.value = current;
    input.maxLength = 80;
    strong.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const commit = async (save) => {
      if (settled) return;
      settled = true;
      const title = input.value.trim();
      if (save && title && title !== current) {
        await fetch(`/api/customer/${customer.id}/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title }),
        }).catch(() => {});
      }
      await loadConversations();
    };
    input.onclick = (e) => e.stopPropagation();
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') commit(false);
    };
    input.onblur = () => commit(true);
  }

  async function deleteConversation(deleteBtn, id) {
    // Two-tap confirm: first tap arms the button, second tap deletes.
    if (!deleteBtn.dataset.armed) {
      deleteBtn.dataset.armed = '1';
      deleteBtn.classList.add('confirm');
      deleteBtn.textContent = 'Sure?';
      setTimeout(() => {
        if (deleteBtn.isConnected) {
          delete deleteBtn.dataset.armed;
          deleteBtn.classList.remove('confirm');
          deleteBtn.innerHTML = TRASH_SVG;
        }
      }, 2600);
      return;
    }
    await fetch(`/api/customer/${customer.id}/conversations/${id}`, { method: 'DELETE' }).catch(() => {});
    if (id === conversationId) {
      conversationId = null;
      sessionStorage.removeItem(`conversation:${customer.id}`);
      resetMessagePane();
    }
    await loadConversations(); // re-selects the most recent conversation, if any
    if (conversationId && !messagesEl.querySelector('.msg')) await loadHistory();
  }

  async function loadConversations() {
    try {
      const conversations = await fetch(`/api/customer/${customer.id}/conversations`).then((r) => r.json());
      if (conversations.length && !conversations.some((c) => c.id === conversationId)) {
        conversationId = conversations[0].id;
        sessionStorage.setItem(`conversation:${customer.id}`, String(conversationId));
      }
      historyListEl.innerHTML = conversations.length
        ? conversations.map((c) => `
          <div class="history-item ${c.id === conversationId ? 'active' : ''}" data-id="${c.id}" role="button" tabindex="0">
            <div class="history-main">
              <strong>${esc(c.title)}</strong>
              <span>${fmtWhen(c.updated_at)}</span>
            </div>
            <div class="history-actions">
              <button type="button" class="hact" data-rename title="Rename" aria-label="Rename conversation">${PENCIL_SVG}</button>
              <button type="button" class="hact" data-delete title="Delete" aria-label="Delete conversation">${TRASH_SVG}</button>
            </div>
          </div>`).join('')
        : '<div class="sidebar-loading">No conversations yet.</div>';
      historyListEl.querySelectorAll('.history-item').forEach((item) => {
        const id = Number(item.dataset.id);
        item.addEventListener('click', async (e) => {
          if (e.target.closest('.hact') || e.target.closest('.history-rename')) return;
          if (busy) return;
          if (id === conversationId) { closeDrawer(); return; }
          conversationId = id;
          sessionStorage.setItem(`conversation:${customer.id}`, String(id));
          resetMessagePane();
          closeDrawer();
          await loadHistory();
          await loadConversations();
        });
        item.querySelector('[data-rename]').onclick = (e) => {
          e.stopPropagation();
          startRename(item, id);
        };
        item.querySelector('[data-delete]').onclick = (e) => {
          e.stopPropagation();
          if (!busy) deleteConversation(e.currentTarget, id);
        };
      });
    } catch {
      historyListEl.innerHTML = '<div class="sidebar-loading">Could not load history.</div>';
    }
  }

  async function loadHistory() {
    if (!conversationId) return;
    try {
      const history = await fetch(`/api/customer/${customer.id}/conversations/${conversationId}/messages`).then((r) => r.json());
      if (Array.isArray(history)) {
        for (const m of history) {
          addBubble(m.role, m.content);
          for (const a of m.meta?.actions ?? []) addActionCard(a);
        }
      }
    } catch { /* fresh conversation */ }
  }

  // ── send a turn ─────────────────────────────────────────────────────
  async function send(text) {
    text = String(text ?? '').trim();
    if (busy || !text) return;
    busy = true;
    sendBtn.disabled = true;
    inputEl.disabled = true;

    addBubble('user', text);
    inputEl.value = '';
    autoResize();

    let trace = null;
    let streamBubble = null;
    let streamedText = '';
    let resolutionStreaming = false;
    let turnData = null;

    const finish = () => {
      eventSource?.close();
      eventSource = null;
      removeTyping();
      busy = false;
      inputEl.disabled = false;
      sendBtn.disabled = !inputEl.value.trim();
      inputEl.focus();
      loadSidebar();
      loadConversations();
      panelCache = {}; // chat actions may have changed dispute/records data
    };

    const finalize = () => {
      removeTyping();
      const reply = turnData?.reply ?? streamedText;
      if (streamBubble) {
        streamBubble.classList.remove('bubble-streaming');
        streamBubble.innerHTML = md(reply);
      } else if (reply) {
        addBubble('assistant', reply);
      } else {
        addStatus('No response received. Please try again.', 'error');
      }
      for (const a of turnData?.actions ?? []) addActionCard(a);
      if (turnData?.conversation_id) {
        conversationId = Number(turnData.conversation_id);
        sessionStorage.setItem(`conversation:${customer.id}`, String(conversationId));
      }
      finish();
    };

    try {
      const res = await fetch('/workflows/chat-turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customer_id: customer.id, conversation_id: conversationId, message: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { runId } = await res.json();

      trace = createTrace();
      setStage(trace, 'triage', 'running');

      eventSource = new EventSource(`/runs/${encodeURIComponent(runId)}?offset=-1&live=sse`);
      eventSource.addEventListener('data', (e) => {
        for (const ev of JSON.parse(e.data)) {
          if (ev.type === 'log' && ev.message === 'stage') {
            const a = ev.attributes ?? {};
            setStage(trace, a.stage, a.status, a);
            if (a.stage === 'resolution' && a.status === 'running' && !streamBubble) {
              addTyping();
              resolutionStreaming = true;
            }
          } else if (ev.type === 'log' && ev.message === 'turn') {
            turnData = ev.attributes ?? {};
          } else if (ev.type === 'text_delta' && resolutionStreaming) {
            if (!streamBubble) {
              removeTyping();
              streamBubble = addBubble('assistant', '');
              streamBubble.classList.add('bubble-streaming');
            }
            streamedText += ev.text ?? '';
            streamBubble.innerHTML = md(streamedText);
            scrollDown();
          } else if (ev.type === 'run_end') {
            if (ev.isError && !turnData) {
              trace?.closest('.msg')?.remove();
              addStatus('Something went wrong. Please try again.', 'error');
              finish();
            } else {
              finalize();
            }
            return;
          }
        }
      });

      eventSource.onerror = () => {
        if (busy) {
          trace?.closest('.msg')?.remove();
          addStatus('Connection lost. Please send that again.', 'error');
          finish();
        }
      };
    } catch (err) {
      trace?.closest('.msg')?.remove();
      addStatus(`Could not reach Sentinel (${err.message}). Please try again.`, 'error');
      finish();
    }
  }

  // ── uploads ─────────────────────────────────────────────────────────
  function setUploadStatus(text) {
    uploadStatus.textContent = text ?? '';
    uploadStatus.hidden = !text;
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || busy) return;
    uploadBtn.disabled = true;
    setUploadStatus(`Reading ${file.name}…`);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
      });
      const res = await fetch(`/api/customer/${customer.id}/attachments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name, mime_type: file.type,
          data_url: dataUrl, conversation_id: conversationId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      const label = data.attachment_type === 'statement' ? 'statement' : 'evidence';
      addBubble('user', `Uploaded ${label}: ${data.filename}`);
      addBubble('assistant', data.analysis);
      setUploadStatus('');
      inputEl.placeholder = 'Ask anything about the uploaded file…';
      inputEl.focus();
      loadConversations();
    } catch (err) {
      setUploadStatus(err.message || 'Could not analyze this file.');
    } finally {
      uploadBtn.disabled = false;
    }
  });

  // ── input wiring ────────────────────────────────────────────────────
  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }
  inputEl.addEventListener('input', () => {
    sendBtn.disabled = busy || !inputEl.value.trim();
    autoResize();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(inputEl.value);
    }
  });
  sendBtn.onclick = () => send(inputEl.value);
  uploadBtn.onclick = () => fileInput.click();
  document.querySelectorAll('#suggestions .chip').forEach((chip) => {
    chip.onclick = () => send(chip.textContent);
  });
  document.getElementById('new-chat-btn').onclick = async () => {
    if (busy) return;
    const conversation = await fetch(`/api/customer/${customer.id}/conversations`, { method: 'POST' }).then((r) => r.json());
    conversationId = conversation.id;
    sessionStorage.setItem(`conversation:${customer.id}`, String(conversationId));
    resetMessagePane();
    closeDrawer();
    await loadConversations();
    inputEl.focus();
  };

  // ── app views (Card / Activity / Bills / Rewards) ───────────────────
  const tabsEl = document.getElementById('app-tabs');
  const chatView = document.getElementById('view-chat');
  const panelView = document.getElementById('view-panel');
  const panelContent = document.getElementById('panel-content');
  let activeView = 'chat';
  let panelCache = {};

  function switchView(view) {
    activeView = view;
    closeDrawer();
    tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const isChat = view === 'chat';
    chatView.style.display = isChat ? '' : 'none';
    panelView.hidden = isChat;
    if (!isChat) renderPanel(view);
  }
  tabsEl.addEventListener('click', (e) => {
    const button = e.target.closest('[data-view]');
    if (button) switchView(button.dataset.view);
  });

  function askChat(prompt) {
    switchView('chat');
    if (busy) {
      inputEl.value = prompt;
      sendBtn.disabled = false;
      inputEl.focus();
    } else {
      send(prompt);
    }
  }

  async function getJSON(key, url) {
    if (panelCache[key]) return panelCache[key];
    const data = await fetch(url).then((r) => r.json());
    panelCache[key] = data;
    return data;
  }

  async function renderPanel(view) {
    panelContent.innerHTML = '<div class="sidebar-loading">Loading…</div>';
    try {
      if (view === 'records') {
        const [disputes, actions] = await Promise.all([
          getJSON('disputes', `/api/customer/${customer.id}/disputes`),
          getJSON('actions', `/api/customer/${customer.id}/actions`),
        ]);
        panelContent.innerHTML = renderRecords(disputes, actions);
      } else if (view === 'account') {
        const [profile, txns, fees, subs] = await Promise.all([
          getJSON('profile', `/api/customer/${customer.id}/profile`),
          getJSON('transactions', `/api/customer/${customer.id}/transactions`),
          getJSON('fees', `/api/customer/${customer.id}/fees`),
          getJSON('subscriptions', `/api/customer/${customer.id}/subscriptions`),
        ]);
        panelContent.innerHTML = renderAccount(profile, txns, fees, subs);
      } else if (view === 'escalations') {
        // Always fetch fresh — escalations can be created or resolved at any time
        delete panelCache['escalations'];
        const escalations = await getJSON('escalations', `/api/customer/${customer.id}/escalations`);
        panelContent.innerHTML = renderEscalations(escalations);
      }
      wirePanel();
    } catch (err) {
      console.error(err);
      panelContent.innerHTML = '<div class="empty">Could not load this view.</div>';
    }
  }

  function wireAsks(root) {
    root.querySelectorAll('[data-ask]').forEach((b) => {
      b.onclick = () => askChat(b.dataset.ask);
    });
  }

  function wirePanel() {
    wireAsks(panelContent);

    // Wire Card Controls
    panelContent.querySelectorAll('input[data-control]').forEach((input) => {
      input.onchange = async () => {
        const ctrl = input.dataset.control;
        const enabled = input.checked;
        
        input.disabled = true;
        
        let mode = null;
        if (ctrl === 'autopay') {
          const modeSel = document.getElementById('control-autopay-mode');
          if (modeSel) {
            modeSel.disabled = !enabled;
            mode = modeSel.value;
          }
        }
        
        try {
          const res = await fetch(`/api/customer/${customer.id}/controls`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ control: ctrl, enabled, mode }),
          });
          if (res.ok) {
            delete panelCache['profile'];
            delete panelCache['actions'];
            await loadSidebar();
            await renderPanel(activeView);
          } else {
            input.checked = !enabled;
          }
        } catch (err) {
          console.error(err);
          input.checked = !enabled;
        } finally {
          input.disabled = false;
        }
      };
    });

    const autopayModeSel = document.getElementById('control-autopay-mode');
    if (autopayModeSel) {
      autopayModeSel.onchange = async () => {
        const autopayInput = panelContent.querySelector('input[data-control="autopay"]');
        const enabled = autopayInput ? autopayInput.checked : true;
        const mode = autopayModeSel.value;
        
        autopayModeSel.disabled = true;
        try {
          const res = await fetch(`/api/customer/${customer.id}/controls`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ control: 'autopay', enabled, mode }),
          });
          if (res.ok) {
            delete panelCache['profile'];
            delete panelCache['actions'];
            await loadSidebar();
            await renderPanel(activeView);
          }
        } catch (err) {
          console.error(err);
        } finally {
          autopayModeSel.disabled = false;
        }
      };
    }
  }

  const ESC_STATUS_BADGE = {
    open: ['amber', 'Open'],
    in_progress: ['', 'In Progress'],
    resolved: ['green', 'Resolved'],
  };
  const ESC_PRIORITY_BADGE = {
    Critical: 'red',
    High: 'amber',
    Medium: '',
    Low: 'grey',
  };

  function renderEscalations(escalations) {
    escalations = escalations ?? [];
    const open = escalations.filter(e => e.status === 'open' || e.status === 'in_progress');
    const resolved = escalations.filter(e => e.status === 'resolved');

    if (!escalations.length) {
      return `
        <div class="single-col">
          <div class="list-head"><h3 class="panel-h" style="margin-top:0;">Escalation Tickets</h3></div>
          <div class="card" style="padding:18px;">
            <div class="empty-mini">No escalation tickets. Issues that require specialist review appear here.</div>
          </div>
        </div>
      `;
    }

    const renderTicket = (e) => {
      const [cls, label] = ESC_STATUS_BADGE[e.status] ?? ['grey', e.status];
      const priorityCls = ESC_PRIORITY_BADGE[e.priority] ?? 'grey';
      const dateStr = new Date(e.created_at).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      return `
        <div class="control-row" style="flex-wrap:wrap;gap:6px;">
          <div style="flex:1;min-width:200px;">
            <strong>${esc(e.id)} · ${esc(e.category)}</strong>
            <small>${esc(e.summary)}</small>
            <small style="display:block;margin-top:4px;">Team: ${esc(e.assigned_team)} · ${esc(dateStr)}</small>
            ${e.status === 'resolved' && e.resolution_notes ? `<small style="display:block;margin-top:4px;color:var(--clr-green);">Resolution: ${esc(e.resolution_notes)}</small>` : ''}
          </div>
          <div class="txn-side" style="gap:6px;">
            <span class="badge ${priorityCls}">${esc(e.priority)}</span>
            <span class="badge ${cls}">${esc(label)}</span>
            ${e.status === 'open' ? `<button class="ghost mini" data-ask="What is the status of my escalation ticket ${esc(e.id)}?">Ask</button>` : ''}
          </div>
        </div>`;
    };

    return `
      <div class="single-col">
        <div class="list-head"><h3 class="panel-h" style="margin-top:0;">Escalation Tickets</h3><small>${escalations.length} ticket${escalations.length === 1 ? '' : 's'}</small></div>
        ${open.length ? `
          <div class="card" style="padding:0 18px;margin-bottom:16px;">
            ${open.map(renderTicket).join('')}
          </div>
        ` : ''}
        ${resolved.length ? `
          <h4 style="margin:8px 0 4px;font-size:12px;color:var(--fg3);text-transform:uppercase;letter-spacing:.5px;">Resolved</h4>
          <div class="card" style="padding:0 18px;">
            ${resolved.map(renderTicket).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  const DISPUTE_BADGE = {
    under_review: ['amber', 'Under review'],
    provisional_credit: ['', 'Provisional credit'],
    won: ['green', 'Resolved — won'],
    lost: ['red', 'Rejected'],
  };

  function renderAccount(profile, txns, fees, subs) {
    const sortedTxns = [...(txns ?? [])].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const sortedFees = [...(fees ?? [])].sort((a, b) => new Date(b.charged_on) - new Date(a.charged_on));
    const sortedSubs = [...(subs ?? [])].sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return new Date(b.started_on) - new Date(a.started_on);
    });

    const isAutopay = profile.autopay_enabled;

    return `
      <div class="panel-grid">
        <section>
          <h3 class="panel-h">Card & Limit Summary</h3>
          <div class="vcard vcard-${esc(String(profile.card_variant ?? 'Classic').toLowerCase())}">
            <div class="vcard-top">
              <b>${esc(profile.card_variant)} variant</b>
              <span class="badge ${profile.card_status === 'active' ? 'green' : 'red'}" style="margin:0;padding:2px 8px;font-size:10px;">${esc(profile.card_status.toUpperCase())}</span>
            </div>
            <div class="vcard-chip"></div>
            <div class="vcard-num">**** **** **** ${esc(profile.card_last4)}</div>
            <div class="vcard-bottom">
              <span>${esc(profile.name)}</span>
            </div>
          </div>
          <div class="stat-strip">
            <div><span>Credit Limit</span><strong>${inr(profile.credit_limit)}</strong></div>
            <div><span>Available Limit</span><strong>${inr(profile.available_limit)}</strong></div>
            <div><span>Outstanding</span><strong>${inr(profile.outstanding_total)}</strong></div>
          </div>
        </section>

        <section>
          <h3 class="panel-h">Bill & Payments</h3>
          <div class="due-hero">
            <div><span>Outstanding</span><strong>${inr(profile.outstanding_total)}</strong></div>
            <div><span>Minimum Due</span><strong>${inr(profile.minimum_due)}</strong></div>
            <div><span>Due Date</span><strong>${profile.due_date ? new Date(`${profile.due_date}T00:00:00`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'}) : '—'}</strong></div>
          </div>
          <div class="stat-strip">
            <div><span>CIBIL Score</span><strong>${profile.cibil_score || '—'}</strong></div>
            <div><span>KYC Status</span><strong>${esc(profile.kyc_status)}</strong></div>
            <div><span>On-time Rate</span><strong>${profile.payment_summary?.on_time_pct ? profile.payment_summary.on_time_pct + '%' : '—'}</strong></div>
          </div>
        </section>
      </div>

      <div class="panel-grid" style="margin-top: 24px;">
        <section>
          <h3 class="panel-h">Card Transaction Controls</h3>
          <div class="card" style="margin-bottom:0;">
            <div class="control-row">
              <div>
                <strong>Online Transactions</strong>
                <small>E-commerce, UPI, mobile apps</small>
              </div>
              <label class="switch">
                <input type="checkbox" data-control="online_enabled" ${profile.online_enabled ? 'checked' : ''}>
                <span></span>
              </label>
            </div>
            <div class="control-row">
              <div>
                <strong>POS Transactions</strong>
                <small>In-store swipes, physical terminals</small>
              </div>
              <label class="switch">
                <input type="checkbox" data-control="pos_enabled" ${profile.pos_enabled ? 'checked' : ''}>
                <span></span>
              </label>
            </div>
            <div class="control-row">
              <div>
                <strong>Contactless (Tap & Pay)</strong>
                <small>NFC contactless payments without PIN</small>
              </div>
              <label class="switch">
                <input type="checkbox" data-control="contactless_enabled" ${profile.contactless_enabled ? 'checked' : ''}>
                <span></span>
              </label>
            </div>
            <div class="control-row">
              <div>
                <strong>ATM Cash Withdrawals</strong>
                <small>Physical withdrawals at ATM terminals</small>
              </div>
              <label class="switch">
                <input type="checkbox" data-control="atm_enabled" ${profile.atm_enabled ? 'checked' : ''}>
                <span></span>
              </label>
            </div>
            <div class="control-row">
              <div>
                <strong>International Transactions</strong>
                <small>Cross-border payments outside India</small>
              </div>
              <label class="switch">
                <input type="checkbox" data-control="international" ${profile.international_enabled ? 'checked' : ''}>
                <span></span>
              </label>
            </div>
          </div>
        </section>

        <section>
          <h3 class="panel-h">Autopay & Rewards</h3>
          <div class="card" style="margin-bottom: 16px;">
            <div class="control-row">
              <div>
                <strong>Card Autopay Status</strong>
                <small>Automatically settle bills on due date</small>
              </div>
              <label class="switch">
                <input type="checkbox" data-control="autopay" ${isAutopay ? 'checked' : ''}>
                <span></span>
              </label>
            </div>
            <div class="control-row">
              <div>
                <strong>Autopay Settle Mode</strong>
                <small>Amount billed to auto-debit</small>
              </div>
              <div>
                <select class="mode-select" id="control-autopay-mode" ${!isAutopay ? 'disabled' : ''}>
                  <option value="total_due" ${profile.autopay_mode === 'total_due' ? 'selected' : ''}>Total Outstanding</option>
                  <option value="minimum_due" ${profile.autopay_mode === 'minimum_due' ? 'selected' : ''}>Minimum Due</option>
                </select>
              </div>
            </div>
          </div>
          <div class="points-hero">
            <span>Reward Points Balance</span>
            <div class="points-hero-row">
              <strong>${Number(profile.reward_points ?? 0).toLocaleString('en-IN')}</strong>
              <small class="badge green">Est. Value: ${inr(profile.reward_points * 0.25)}</small>
            </div>
            <small style="display:block;margin-top:8px;">Redeem points in chat for instant statement credit at ₹0.25/point.</small>
          </div>
        </section>
      </div>

      <div class="panel-grid" style="margin-top: 24px;">
        <section>
          <h3 class="panel-h">Recent Transactions</h3>
          <div class="card" style="padding:0 18px;margin-bottom:0;">
            <div class="txn-list">
              ${sortedTxns.length ? sortedTxns.map(t => `
                <div class="txn-row">
                  <div class="txn-main">
                    <strong>${esc(t.merchant)}</strong>
                    <small>${esc(t.category)} · ${new Date(t.timestamp).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'})}</small>
                  </div>
                  <div class="txn-side">
                    <b>${inr(t.amount)}</b>
                    <span class="badge ${t.status === 'SUCCESS' ? 'green' : t.status === 'DECLINED' ? 'red' : 'grey'}">${esc(t.status)}</span>
                  </div>
                </div>
              `).join('') : '<div class="empty-mini">No transactions found.</div>'}
            </div>
          </div>
        </section>

        <section>
          <h3 class="panel-h">Recent Fees & Charges</h3>
          <div class="card" style="padding:0 18px;margin-bottom:0;">
            <div class="txn-list">
              ${sortedFees.length ? sortedFees.map(f => `
                <div class="txn-row">
                  <div class="txn-main">
                    <strong>${esc(f.fee_type.replace(/_/g, ' ')).replace(/\b\w/g, c => c.toUpperCase())}</strong>
                    <small>${new Date(f.charged_on).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'})}</small>
                  </div>
                  <div class="txn-side">
                    <b>${inr(f.amount)}</b>
                    ${f.waived === 1 
                      ? '<span class="badge green" title="Goodwill Waiver Reversed">Waived</span>' 
                      : `<span class="badge red">Active</span>`
                    }
                  </div>
                </div>
              `).join('') : '<div class="empty-mini">No fees charged.</div>'}
            </div>
          </div>
        </section>
      </div>

      <div style="margin-top: 24px;">
        <h3 class="panel-h">Active Autopay Mandates (RBI e-Mandates)</h3>
        <div class="card" style="padding:0 18px;margin-bottom:0;">
          <div class="txn-list">
            ${sortedSubs.length ? sortedSubs.map(s => `
              <div class="txn-row">
                <div class="txn-main">
                  <strong>${esc(s.merchant)}</strong>
                  <small>${esc(s.plan)} · ${esc(s.category)} · registered ${new Date(s.started_on).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'})}</small>
                </div>
                <div class="txn-side">
                  <b>${inr(s.amount)}/${s.billing_cycle === 'annual' ? 'yr' : 'mo'}</b>
                  ${s.status === 'active' 
                    ? `<span class="badge green">Active</span><button class="ghost mini" data-ask="Show my active autopay standing instructions, then cancel Netflix.">Cancel</button>` 
                    : `<span class="badge grey">Cancelled on ${s.cancelled_on ? new Date(s.cancelled_on).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'}) : ''}</span>`
                  }
                </div>
              </div>
            `).join('') : '<div class="empty-mini">No active autopays or standing instructions.</div>'}
          </div>
        </div>
      </div>
    `;
  }

  function renderRecords(disputes, actions) {
    disputes = disputes ?? [];
    actions = actions ?? [];

    const ACTION_LABELS = {
      fee_waived: (d) => `Fee waived: Goodwill reversal of ${inr(d?.amount)} (${esc(d?.fee_type || '').replace(/_/g, ' ')})`,
      refund_initiated: (d) => `Refund credited: ${inr(d?.amount)} from ${esc(d?.merchant)}`,
      refund_rejected: (d) => `Refund rejected: ${esc(d?.reason)}`,
      card_blocked: (d) => `Card blocked: ${esc(d?.reason || 'Security lock')}`,
      card_unblocked: () => `Card unblocked: Security lock released`,
      card_hotlisted: () => `Card permanently disabled`,
      international_toggled: (d) => `International usage ${d?.enabled ? 'enabled' : 'disabled'}`,
      emi_converted: (d) => `EMI created: ${inr(d?.amount)} over ${d?.tenure} months`,
      emi_foreclosed: (d) => `EMI foreclosed: Principal ${inr(d?.remaining_principal)}`,
      rewards_redeemed: (d) => `Rewards redeemed: ${Number(d?.points).toLocaleString('en-IN')} points (${inr(d?.value_inr)} credit)`,
      credit_limit_adjusted: (d) => `Credit limit increased: ${inr(d?.old_limit)} → ${inr(d?.new_limit)}`,
      card_closure_initiated: () => `Card closure process initiated`,
      escalation_created: (d) => `Sent for specialist review: ticket ${esc(d?.escalation_id)}`,
      card_control_updated: (d) => `Card control updated: ${esc(d?.control).replace('_enabled', '').replace(/_/g, ' ').toUpperCase()} set to ${d?.enabled ? 'ENABLED' : 'DISABLED'}`,
      autopay_updated: (d) => `Autopay updated: ${d?.enabled ? 'ENABLED' : 'DISABLED'} (${esc(d?.mode).replace(/_/g, ' ')})`,
      dispute_raised: (d) => `Dispute raised: ${esc(d?.dispute_id)} · ${inr(d?.amount)} at ${esc(d?.merchant)}`,
      subscription_cancelled: (d) => `Standing instruction cancelled: ${esc(d?.merchant)}`,
    };

    let disputesHtml = '';
    if (!disputes.length) {
      disputesHtml = '<div class="empty-mini">No active disputes or chargebacks.</div>';
    } else {
      disputesHtml = disputes.map((d) => {
        const [cls, label] = DISPUTE_BADGE[d.status] ?? ['grey', d.status];
        return `
          <div class="control-row">
            <div>
              <strong>${esc(d.merchant)} · ${inr(d.amount)}</strong>
              <small>${esc(d.id)} · ${esc(d.reason)} · raised ${esc(d.raised_on)}</small>
            </div>
            <div class="txn-side">
              <span class="badge ${cls}">${esc(label)}</span>
              <button class="ghost mini" data-ask="What is the status of my dispute ${esc(d.id)} for the ${esc(d.merchant)} charge of ${inr(d.amount)}? Explain what happens next.">Status</button>
            </div>
          </div>`;
      }).join('');
    }

    let actionsHtml = '';
    if (!actions.length) {
      actionsHtml = '<div class="empty-mini">No operations or audits logged yet.</div>';
    } else {
      actionsHtml = actions.map((a) => {
        const detail = typeof a.action_detail === 'string' ? JSON.parse(a.action_detail) : a.action_detail;
        const labelFn = ACTION_LABELS[a.action_type] ?? (() => esc(a.action_type).replace(/_/g, ' '));
        const label = labelFn(detail);
        const dateStr = new Date(a.performed_at).toLocaleDateString('en-IN', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        });
        return `
          <div class="control-row">
            <div>
              <strong>${label}</strong>
              <small>${esc(a.policy_reference || 'General Operations Policy')} · ${esc(dateStr)}</small>
            </div>
            <div class="txn-side">
              <span class="badge grey">Audited</span>
            </div>
          </div>`;
      }).join('');
    }

    return `
      <div class="single-col">
        <div class="list-head"><h3 class="panel-h" style="margin-top:0;">Disputes & Chargebacks</h3><small>${disputes.length} case${disputes.length === 1 ? '' : 's'}</small></div>
        <div class="card" style="padding:0 18px;margin-bottom:24px;">
          ${disputesHtml}
        </div>

        <div class="list-head"><h3 class="panel-h">Audit Trail & Resolution Logs</h3><small>${actions.length} audited</small></div>
        <div class="card" style="padding:0 18px;">
          ${actionsHtml}
        </div>
      </div>
    `;
  }

  // ── boot ────────────────────────────────────────────────────────────
  (async () => {
    loadSidebar();
    await loadConversations();
    await loadHistory();
  })();
})();

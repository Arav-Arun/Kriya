import { esc, md, inr, fmtWhen, daysUntil, wavFromBlob } from './utils.js';
const ACTION_RENDER = {
  refund_initiated: (d) => ['green', `Refund credited: ${inr(d?.amount)} from ${d?.merchant ?? 'merchant'}`, d?.new_available_limit != null ? `Available limit is now ${inr(d.new_available_limit)}` : ''],
  refund_rejected: (d) => ['red', 'Refund not possible', d?.reason ?? ''],
  card_blocked: (d) => ['red', 'Card blocked', d?.reason ?? ''],
  card_unblocked: () => ['green', 'Card unblocked', 'Your card is active again'],
  card_hotlisted: () => ['red', 'Card permanently disabled', 'This cannot be undone'],
  international_toggled: (d) => ['blue', `International usage ${d?.enabled ? 'enabled' : 'disabled'}`, ''],
  emi_converted: (d) => ['blue', `EMI created: ${inr(d?.amount)} over ${d?.tenure} months`, `${inr(d?.emi_amount)}/month`],
  emi_foreclosed: (d) => ['blue', 'EMI foreclosed', `Total payable ${inr((d?.remaining_principal ?? 0) + (d?.foreclosure_charge ?? 0))}`],
  escalation_created: (d) => ['amber', `Sent for specialist review: ${d?.escalation_id ?? ''}`, 'A specialist will take it from here'],
  context_recorded: () => ['blue', 'Account details saved', ''],
  transaction_recorded: (d) => ['blue', `Transaction noted: ${d?.merchant ?? ''} ${inr(d?.amount)}`, ''],
  card_control_updated: (d) => ['blue', `${String(d?.control ?? '').replace('_enabled', '').replace(/_/g, ' ')} transactions ${d?.enabled ? 'enabled' : 'disabled'}`, 'Card control updated'],
  autopay_updated: (d) => ['blue', `Autopay ${d?.enabled ? 'enabled' : 'disabled'}`, d?.enabled ? `Mode: ${d?.mode === 'total_due' ? 'full statement' : 'minimum due'}` : ''],
};

// Starter prompts, paged (3×3 grid per page) so the welcome stays compact while
// covering the full surface: reads, spend insights, and the write actions Kriya
// can take.
const SUGGESTION_PAGES = [
  [
    'Check my outstanding balance',
    'How many reward points do I have?',
    'Where did my money go this month?',
    'Show my recent transactions',
    'How much cashback have I earned?',
    "What's on my latest statement?",
    'What are my EMI options?',
    'What perks does my card have?',
    'Is my card active or blocked?',
  ],
  [
    'Block my card',
    'Unblock my card',
    'Report my card lost or stolen',
    'Order a replacement card',
    'Refund a duplicate charge',
    'Convert a purchase to EMI',
    'Close an EMI early',
    'Redeem my reward points',
    'Add a benefit to my card',
  ],
];
let suggestionPage = 0;

const storedCustomer = JSON.parse(sessionStorage.getItem('customer') || 'null');
if (storedCustomer) {
  bootChat(storedCustomer);
} else {
  showLogin(bootChat);
}

// ── Sign in by registered mobile number ───────────────────────────────
// Replaces the old "pick a synthetic customer" segment picker: the number is
// looked up in the live card provider and the real account is linked. No
// demo data ever enters the chat.
async function showLogin(onLogin) {
  const overlay = document.getElementById('login-overlay');
  const form = document.getElementById('login-form');
  const phoneEl = document.getElementById('login-phone');
  const submitEl = document.getElementById('login-submit');
  const errorEl = document.getElementById('login-error');
  const demoEl = document.getElementById('login-demo');
  overlay.hidden = false;
  setTimeout(() => phoneEl.focus(), 60);

  // Offer the demo number as a one-tap shortcut when the server provides one.
  fetch('/api/web/config').then((r) => r.json()).then((cfg) => {
    if (cfg.demo_phone) {
      demoEl.hidden = false;
      demoEl.textContent = `Use the demo number · ${cfg.demo_phone}`;
      demoEl.onclick = () => { phoneEl.value = cfg.demo_phone; submit(); };
    }
  }).catch(() => {});

  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };

  async function submit() {
    const phone = phoneEl.value.replace(/\D/g, '');
    errorEl.hidden = true;
    if (phone.length < 10) { showError('Enter a valid mobile number.'); return; }
    submitEl.disabled = true;
    phoneEl.disabled = true;
    submitEl.textContent = 'Linking your account…';
    try {
      const res = await fetch('/api/identify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not sign you in.');
      sessionStorage.setItem('customer', JSON.stringify(data));
      overlay.hidden = true;
      onLogin(data);
    } catch (err) {
      showError(err.message);
      submitEl.disabled = false;
      phoneEl.disabled = false;
      submitEl.textContent = 'Continue';
      phoneEl.focus();
    }
  }

  form.onsubmit = (e) => { e.preventDefault(); submit(); };
}

function bootChat(customer) {
  const messagesEl = document.getElementById('messages');
  const welcomeEl = document.getElementById('welcome');
  const inputEl = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const historyListEl = document.getElementById('history-list');

  const firstName = String(customer.name ?? '').split(' ')[0];
  document.getElementById('chat-user').textContent = `${customer.name} · **** ${customer.card_last4}`;
  document.getElementById('welcome-title').textContent = `Hi ${firstName}.`;
  document.getElementById('end-session-btn').onclick = () => {
    sessionStorage.removeItem('customer');
    window.location.assign('/');
  };

  // ── sidebar toggle (collapse on desktop, slide-in drawer on mobile) ──
  const SIDEBAR_PREF = 'kriya:sidebar-collapsed';
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

  function hideWelcome() {
    if (!started && welcomeEl) { welcomeEl.style.display = 'none'; started = true; }
  }
  function scrollDown() { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; }

  function resetMessagePane() {
    if (messagesEl) {
      messagesEl.querySelectorAll('.msg').forEach((node) => node.remove());
    }
    if (welcomeEl) welcomeEl.style.display = '';
    started = false;
  }

  let activeSpeakBtn = null;
  let activeSpeakAudio = null;
  let activeSpeakQueue = [];

  function stopActiveSpeak() {
    if (activeSpeakBtn) {
      activeSpeakBtn.classList.remove('playing');
      activeSpeakBtn.classList.remove('loading');
      activeSpeakBtn = null;
    }
    activeSpeakQueue = [];
    if (activeSpeakAudio) {
      activeSpeakAudio.pause();
      activeSpeakAudio.src = '';
      activeSpeakAudio = null;
    }
  }

  async function speakText(text, btnEl) {
    if (activeSpeakBtn === btnEl) {
      stopActiveSpeak();
      return;
    }
    stopActiveSpeak();
    
    // Stop main microphone playback if active
    ttsQueue = [];
    if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ''; ttsAudio = null; }
    micBtn?.classList.remove('speaking');
    if (!recording && typeof setVoiceStatus === 'function') setVoiceStatus('');

    activeSpeakBtn = btnEl;
    btnEl.classList.add('loading');

    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (activeSpeakBtn !== btnEl) return;
      
      btnEl.classList.remove('loading');
      if (!res.ok || !data.audios?.length) {
        stopActiveSpeak();
        return;
      }

      activeSpeakQueue = data.audios.slice();
      btnEl.classList.add('playing');
      
      function playNextChunk() {
        if (activeSpeakBtn !== btnEl) return;
        if (!activeSpeakQueue.length) {
          stopActiveSpeak();
          return;
        }
        activeSpeakAudio = new Audio(`data:audio/wav;base64,${activeSpeakQueue.shift()}`);
        activeSpeakAudio.onended = playNextChunk;
        activeSpeakAudio.onerror = () => stopActiveSpeak();
        activeSpeakAudio.play().catch(() => stopActiveSpeak());
      }

      playNextChunk();
    } catch (err) {
      if (activeSpeakBtn === btnEl) {
        btnEl.classList.remove('loading');
        stopActiveSpeak();
      }
    }
  }

  function addBubble(role, text) {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = `msg msg-${role}`;
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble-${role}`;
    if (role === 'assistant') bubble.innerHTML = md(text);
    else bubble.textContent = text;

    const speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'bubble-speak-btn';
    speakBtn.title = 'Speak message';
    speakBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
    speakBtn.onclick = () => speakText(bubble.innerText, speakBtn);

    if (role === 'user') {
      wrap.appendChild(speakBtn);
      wrap.appendChild(bubble);
    } else {
      wrap.appendChild(bubble);
      wrap.appendChild(speakBtn);
    }

    if (messagesEl) {
      messagesEl.appendChild(wrap);
      scrollDown();
    }
    return bubble;
  }

  function addTyping() {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    wrap.dataset.typing = '1';
    wrap.innerHTML = '<div class="bubble bubble-assistant"><span class="typing-dots"><span></span><span></span><span></span></span></div>';
    if (messagesEl) {
      messagesEl.appendChild(wrap);
      scrollDown();
    }
  }

  // Remove typing indicator bubbles from UI
  function removeTyping() {
    if (messagesEl) {
      messagesEl.querySelectorAll('[data-typing]').forEach((el) => el.remove());
    }
  }

  function addStatus(text, type) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-status';
    wrap.innerHTML = `<div class="status-card ${type === 'error' ? 'status-error' : ''}">${esc(text)}</div>`;
    if (messagesEl) {
      messagesEl.appendChild(wrap);
      scrollDown();
    }
  }

  // ── action cards ────────────────────────────────────────────────────
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
    if (messagesEl) {
      messagesEl.appendChild(wrap);
      scrollDown();
    }
  }

  // ── generative cards (balance / spend / transactions / EMI) ─────────
  // Rendered from the structured `ui_card` action the resolution agent logs;
  // every figure is live provider data, the agent never fabricates a card.
  const fmtCardDate = (value) => {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  };

  function cardBalance(c) {
    const util = c.utilisation != null ? Math.max(0, Math.min(100, c.utilisation)) : null;
    const utilClass = util == null ? '' : util >= 85 ? 'util-high' : util >= 60 ? 'util-warn' : 'util-ok';
    const tag = c.status && c.status !== 'active'
      ? `<span class="kc-tag ${c.status === 'hotlisted' ? 'red' : 'amber'}">${esc(c.status)}</span>` : '';
    return `
      <div class="kc-head"><span class="kc-label">Outstanding balance</span>${tag}</div>
      <div class="kc-amount">${inr(c.outstanding)}</div>
      ${util != null ? `<div class="kc-bar"><i class="${utilClass}" style="width:${util}%"></i></div>` : ''}
      <div class="kc-foot">
        ${c.available != null ? `<span><b>${inr(c.available)}</b> available</span>` : ''}
        ${c.limit != null ? `<span><b>${inr(c.limit)}</b> limit${util != null ? ` · ${util}% used` : ''}</span>` : ''}
      </div>`;
  }

  function cardSpend(c) {
    const days = (() => {
      const a = new Date(c.window?.from), b = new Date(c.window?.to);
      const n = Math.round((b - a) / 86400000);
      return Number.isFinite(n) ? n : null;
    })();
    const label = days != null && days >= 28 && days <= 31
      ? 'Spending · last 30 days'
      : (c.window?.from ? `Spending · ${fmtCardDate(c.window.from)}–${fmtCardDate(c.window.to)}` : 'Spending');

    const colors = ['var(--indigo)', 'var(--saffron)', 'var(--green)', 'var(--amber)', 'var(--red)'];
    let currentPercent = 0;
    const segments = (c.categories || []).map((cat, index) => {
      const strokeLength = (cat.pct / 100) * 238.76;
      const offset = 238.76 - (currentPercent / 100) * 238.76;
      currentPercent += cat.pct;
      const color = colors[index % colors.length];
      return `<circle cx="50" cy="50" r="38" fill="transparent" stroke="${color}" stroke-width="8" stroke-dasharray="${strokeLength} 238.76" stroke-dashoffset="${offset}" transform="rotate(-90 50 50)" />`;
    }).join('');

    const totalStr = inr(c.total);
    const amtFontSize = totalStr.length > 8 ? '7.5' : totalStr.length > 6 ? '9' : '10';

    const svgChart = `
      <svg class="kc-spend-donut" width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="38" fill="transparent" stroke="var(--surface-2)" stroke-width="8" />
        ${segments}
        <text x="50" y="47" font-size="7" font-family="var(--sans)" font-weight="700" text-anchor="middle" fill="var(--faint)" letter-spacing="0.04em">TOTAL</text>
        <text x="50" y="60" font-size="${amtFontSize}" font-family="var(--serif)" font-weight="700" text-anchor="middle" fill="var(--text)">${totalStr}</text>
      </svg>
    `;

    const cats = (c.categories || []).map((cat, index) => {
      const color = colors[index % colors.length];
      return `
        <li class="kc-cat-item">
          <span class="kc-cat-name-wrap">
            <i class="kc-cat-dot" style="background-color: ${color}"></i>
            <span class="kc-cat-name">${esc(cat.label)}</span>
          </span>
          <span class="kc-cat-pct">${cat.pct}%</span>
          <span class="kc-cat-amt">${inr(cat.amount)}</span>
        </li>`;
    }).join('');

    return `
      <div class="kc-head"><span class="kc-label">${esc(label)}</span></div>
      <div class="kc-spend-body">
        ${svgChart}
        <ul class="kc-spend-list">${cats}</ul>
      </div>
      <div class="kc-foot">
        <span>${c.count} purchase${c.count === 1 ? '' : 's'}</span>
        ${c.unbilled != null ? `<span><b>${inr(c.unbilled)}</b> building toward next bill</span>` : ''}
      </div>`;
  }

  function cardTxns(c) {
    const rows = (c.rows || []).map((r) => `
      <li>
        <span class="kc-row-main"><strong>${esc(r.label)}</strong>${r.date ? `<small>${esc(fmtCardDate(r.date))}</small>` : ''}</span>
        <b class="kc-row-amt ${r.nature === 'credit' ? 'credit' : ''}">${r.nature === 'credit' ? '+' : ''}${inr(r.amount)}</b>
      </li>`).join('');
    return `<div class="kc-head"><span class="kc-label">Recent transactions</span></div><ul class="kc-rows">${rows}</ul>`;
  }

  function cardEmi(c) {
    const amt = c.amount != null ? ` · ${inr(c.amount)}` : '';
    const plans = (c.plans || []).map((p) => `
      <li class="kc-plan" data-tenure="${esc(p.tenure)}" role="button" tabindex="0">
        <span class="kc-plan-t">${esc(p.tenure)} months</span>
        <span class="kc-plan-m"><b>${inr(p.monthly)}</b>/mo</span>
        ${p.rate != null ? `<small>${esc(p.rate)}% p.a.</small>` : ''}
      </li>`).join('');
    return `<div class="kc-head"><span class="kc-label">EMI options${amt}</span></div><ul class="kc-plans">${plans}</ul><div class="kc-hint">Tap a plan to convert</div>`;
  }

  function addCard(card) {
    if (!card || !card.type) return;
    const body = card.type === 'balance' ? cardBalance(card)
      : card.type === 'spend' ? cardSpend(card)
      : card.type === 'transactions' ? cardTxns(card)
      : card.type === 'emi_offer' ? cardEmi(card)
      : null;
    if (!body) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    wrap.innerHTML = `<div class="kc kc-${esc(card.type)}">${body}</div>`;
    if (card.type === 'emi_offer') {
      wrap.querySelectorAll('.kc-plan').forEach((el) => {
        const tenure = el.dataset.tenure;
        const go = () => send(`Convert my outstanding balance to a ${tenure}-month EMI`);
        el.addEventListener('click', go);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      });
    }
    if (messagesEl) { messagesEl.appendChild(wrap); scrollDown(); }
  }

  // Render either a side-effect action card or a presentational ui_card.
  function addAction(a) {
    if (a?.type === 'ui_card') addCard(a.detail?.card);
    else addActionCard(a);
  }

  function updateSuggestions() {
    const suggestionsEl = document.getElementById('suggestions');
    const pagerEl = document.getElementById('suggestion-pager');
    if (!suggestionsEl) return;
    const pages = SUGGESTION_PAGES;

    const renderPage = () => {
      const chips = pages[suggestionPage] || [];
      suggestionsEl.innerHTML = chips.map((text) => `<button class="chip">${esc(text)}</button>`).join('');
      suggestionsEl.querySelectorAll('.chip').forEach((chip) => { chip.onclick = () => send(chip.textContent); });
      if (pagerEl) {
        pagerEl.hidden = pages.length <= 1;
        const pg = pagerEl.querySelector('.sg-page');
        if (pg) pg.textContent = `${suggestionPage + 1} / ${pages.length}`;
      }
    };

    if (pagerEl && !pagerEl.dataset.wired) {
      pagerEl.dataset.wired = '1';
      pagerEl.querySelector('.sg-prev').onclick = () => { suggestionPage = (suggestionPage - 1 + pages.length) % pages.length; renderPage(); };
      pagerEl.querySelector('.sg-next').onclick = () => { suggestionPage = (suggestionPage + 1) % pages.length; renderPage(); };
    }
    renderPage();
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
    await loadConversations();
    if (conversationId && !messagesEl.querySelector('.msg')) await loadHistory();
  }

  async function loadConversations() {
    if (!historyListEl) return;
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
          for (const a of m.meta?.actions ?? []) addAction(a);
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

    let streamBubble = null;
    let streamedText = '';
    let resolutionStreaming = false;
    let turnData = null;

    const finish = () => {
      eventSource?.close();
      eventSource = null;
      removeTyping();
      voiceReplyPending = false; // clear even on error paths that skip finalize
      busy = false;
      inputEl.disabled = false;
      sendBtn.disabled = !inputEl.value.trim();
      inputEl.focus();
      loadConversations();
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
      for (const a of turnData?.actions ?? []) addAction(a);
      if (turnData?.conversation_id) {
        conversationId = Number(turnData.conversation_id);
        sessionStorage.setItem(`conversation:${customer.id}`, String(conversationId));
      }
      // If this turn came in by voice, read the answer back aloud.
      if (voiceReplyPending && reply) { voiceReplyPending = false; speakReply(reply); }
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

      hideWelcome();
      addTyping();

      eventSource = new EventSource(`/runs/${encodeURIComponent(runId)}?offset=-1&live=sse`);
      eventSource.addEventListener('data', (e) => {
        for (const ev of JSON.parse(e.data)) {
          if (ev.type === 'log' && ev.message === 'stage') {
            const a = ev.attributes ?? {};
            if (a.stage === 'resolution' && a.status === 'running') {
              resolutionStreaming = true;
            }
          } else if (ev.type === 'log' && ev.message === 'turn') {
            turnData = ev.attributes ?? {};
          } else if (ev.type === 'text_delta' && resolutionStreaming) {
            const textDelta = ev.text ?? '';
            if (!streamBubble && !textDelta) {
              return;
            }
            if (!streamBubble) {
              removeTyping();
              streamBubble = addBubble('assistant', '');
              streamBubble.classList.add('bubble-streaming');
            }
            streamedText += textDelta;
            streamBubble.innerHTML = md(streamedText);
            scrollDown();
          } else if (ev.type === 'run_end') {
            if (ev.isError && !turnData) {
              removeTyping();
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
          removeTyping();
          addStatus('Connection lost. Please send that again.', 'error');
          finish();
        }
      };
    } catch (err) {
      removeTyping();
      addStatus(`Could not reach Kriya (${err.message}). Please try again.`, 'error');
      finish();
    }
  }

  // ── input wiring ────────────────────────────────────────────────────
  function autoResize() {
    if (inputEl) {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    }
  }
  if (inputEl) {
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
  }
  if (sendBtn) {
    sendBtn.onclick = () => send(inputEl.value);
  }

  const newChatBtn = document.getElementById('new-chat-btn');
  if (newChatBtn) {
    newChatBtn.onclick = async () => {
      if (busy) return;
      const conversation = await fetch(`/api/customer/${customer.id}/conversations`, { method: 'POST' }).then((r) => r.json());
      conversationId = conversation.id;
      sessionStorage.setItem(`conversation:${customer.id}`, String(conversationId));
      resetMessagePane();
      closeDrawer();
      await loadConversations();
      inputEl.focus();
    };
  }

  // ── ask chat (simplified CTA click helper) ───────────────────────────
  function askChat(prompt) {
    if (busy) {
      inputEl.value = prompt;
      sendBtn.disabled = false;
      inputEl.focus();
    } else {
      send(prompt);
    }
  }

  // voice mode (Sarvam STT in, TTS out), ChatGPT-style mic
  const micBtn = document.getElementById('mic-btn');
  const voiceStatusEl = document.getElementById('voice-status');
  let mediaRecorder = null;
  let recChunks = [];
  let recording = false;
  let lastVoiceLang = null;       // STT-detected language, reused for the reply
  let voiceReplyPending = false;  // speak the next assistant reply aloud
  let ttsAudio = null;            // currently-playing clip
  let ttsQueue = [];              // remaining base64 clips
  let voiceAvailable = false;

  function setVoiceStatus(text, opts = {}) {
    if (!voiceStatusEl) return;
    if (!text) { voiceStatusEl.hidden = true; voiceStatusEl.innerHTML = ''; return; }
    voiceStatusEl.hidden = false;
    let waveHtml = '';
    if (opts.cls === 'rec' || opts.cls === 'play' || opts.cls === 'work') {
      waveHtml = `
        <div class="voice-wave-bars ${opts.cls}">
          <span></span>
          <span></span>
          <span></span>
          <span></span>
          <span></span>
        </div>
      `;
    } else {
      waveHtml = `<span class="vs-dot ${opts.cls || ''}"></span>`;
    }
    voiceStatusEl.innerHTML = `${waveHtml}<span class="vs-text">${esc(text)}</span>`
      + (opts.stop ? '<button type="button" class="vs-stop">Stop</button>' : '');
    if (opts.stop) voiceStatusEl.querySelector('.vs-stop').onclick = opts.stop;
  }
  const flashStatus = (text, cls) => { setVoiceStatus(text, { cls }); setTimeout(() => { if (!recording && !ttsAudio) setVoiceStatus(''); }, 2600); };

  // Show the mic only when the server has voice (Sarvam) configured.
  fetch('/api/web/config').then((r) => r.json()).then((cfg) => {
    voiceAvailable = !!cfg.voice_enabled && !!(navigator.mediaDevices && window.MediaRecorder);
    if (voiceAvailable && micBtn) micBtn.hidden = false;
  }).catch(() => {});

  function pickMime() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    for (const t of types) if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    return '';
  }

  async function startRecording() {
    if (recording || busy) return;
    stopPlayback();  // talking over a reply cancels it
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      flashStatus('Microphone permission denied.', 'err');
      return;
    }
    const mime = pickMime();
    recChunks = [];
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recording = false;
      micBtn.classList.remove('recording');
      const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1200) { setVoiceStatus(''); return; }  // too short / silence
      await transcribeAndSend(blob);
    };
    mediaRecorder.start();
    recording = true;
    micBtn.classList.add('recording');
    setVoiceStatus('Listening… tap to stop', { cls: 'rec', stop: stopRecording });
  }

  function stopRecording() {
    if (recording && mediaRecorder) mediaRecorder.stop();
  }

  async function transcribeAndSend(blob) {
    setVoiceStatus('Transcribing…', { cls: 'work' });
    micBtn.classList.add('working');
    try {
      // Sarvam STT rejects raw webm/opus (400); transcode to WAV in the browser
      // first, falling back to the original blob if the browser can't decode it.
      const wav = await wavFromBlob(blob);
      const uploadBlob = wav || blob;
      const ext = wav ? 'wav' : blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const form = new FormData();
      form.append('audio', uploadBlob, `speech.${ext}`);
      const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      micBtn.classList.remove('working');
      if (!res.ok) throw new Error(data.error || 'Could not transcribe.');
      const text = String(data.transcript || '').trim();
      lastVoiceLang = data.language_code || null;
      setVoiceStatus('');
      if (!text) { flashStatus('Didn’t catch that, try again.', ''); return; }
      voiceReplyPending = true;  // read the answer back aloud
      send(text);
    } catch (err) {
      micBtn.classList.remove('working');
      flashStatus(err.message || 'Voice failed.', 'err');
    }
  }

  // ── TTS playback ────────────────────────────────────────────────────
  function stopPlayback() {
    ttsQueue = [];
    if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ''; ttsAudio = null; }
    micBtn?.classList.remove('speaking');
    if (!recording) setVoiceStatus('');
    stopActiveSpeak();
  }

  async function speakReply(text) {
    if (!voiceAvailable || !text) return;
    setVoiceStatus('Preparing voice…', { cls: 'work' });
    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, language_code: lastVoiceLang }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.audios?.length) { setVoiceStatus(''); return; }
      ttsQueue = data.audios.slice();
      micBtn?.classList.add('speaking');
      setVoiceStatus('Speaking…', { cls: 'play', stop: stopPlayback });
      playNext();
    } catch { setVoiceStatus(''); }
  }

  function playNext() {
    if (!ttsQueue.length) { stopPlayback(); return; }
    ttsAudio = new Audio(`data:audio/wav;base64,${ttsQueue.shift()}`);
    ttsAudio.onended = playNext;
    ttsAudio.onerror = stopPlayback;
    ttsAudio.play().catch(stopPlayback);
  }

  if (micBtn) {
    micBtn.onclick = () => {
      if (recording) stopRecording();
      else if (ttsAudio) stopPlayback();
      else startRecording();
    };
  }

  // ── boot ────────────────────────────────────────────────────────────
  (async () => {
    updateSuggestions();
    await loadConversations();
    await loadHistory();
  })();
}

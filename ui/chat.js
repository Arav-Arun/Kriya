import { esc, md, inr, fmtWhen, daysUntil } from './utils.js';
import { ACTION_RENDER, renderAccount, renderRecords, renderEscalations } from './renderers.js';
import { createTrace, setStage } from './trace.js';

const customer = JSON.parse(sessionStorage.getItem('customer') || 'null');
if (!customer) {
  window.location.assign('/');
} else {
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

  function addBubble(role, text) {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = `msg msg-${role}`;
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble-${role}`;
    if (role === 'assistant') bubble.innerHTML = md(text);
    else bubble.textContent = text;
    wrap.appendChild(bubble);
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

  // ── sidebar ─────────────────────────────────────────────────────────
  async function loadSidebar() {
    if (!sidebarEl) return;
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
      panelCache = {};
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

      hideWelcome();
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
    if (uploadStatus) {
      uploadStatus.textContent = text ?? '';
      uploadStatus.hidden = !text;
    }
  }

  if (fileInput) {
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
  if (uploadBtn) {
    uploadBtn.onclick = () => fileInput.click();
  }
  document.querySelectorAll('#suggestions .chip').forEach((chip) => {
    chip.onclick = () => send(chip.textContent);
  });
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
  if (tabsEl) {
    tabsEl.addEventListener('click', (e) => {
      const button = e.target.closest('[data-view]');
      if (button) switchView(button.dataset.view);
    });
  }

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
    if (!panelContent) return;
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
    if (!panelContent) return;
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

  // ── boot ────────────────────────────────────────────────────────────
  (async () => {
    loadSidebar();
    await loadConversations();
    await loadHistory();
  })();
}

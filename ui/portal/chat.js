import { esc, md, inr, fmtWhen, daysUntil } from '../shared/utils.js';
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
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');
  const uploadStatus = document.getElementById('upload-status');
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

  function updateSuggestions() {
    const suggestionsEl = document.getElementById('suggestions');
    if (!suggestionsEl) return;

    const chips = [
      'Check my outstanding balance',
      'View my recent transactions',
      'I want to increase my credit limit',
      'Block my card',
      'Check active EMI plans',
      'Convert a purchase to EMI',
    ];

    suggestionsEl.innerHTML = chips
      .map((text) => `<button class="chip">${esc(text)}</button>`)
      .join('');

    suggestionsEl.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => send(chip.textContent);
    });
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
      for (const a of turnData?.actions ?? []) addActionCard(a);
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

  // ── voice mode (Sarvam STT in, TTS out) — ChatGPT-style mic ──────────
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
    voiceStatusEl.innerHTML = `<span class="vs-dot ${opts.cls || ''}"></span><span class="vs-text">${esc(text)}</span>`
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
      const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const form = new FormData();
      form.append('audio', blob, `speech.${ext}`);
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

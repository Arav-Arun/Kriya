// Sentinel UI Trace stages tracker

export const PARALLEL_SET = new Set(['investigation', 'policy', 'precedent']);
export const stageTimers = {};

const messagesEl = document.getElementById('messages');
const scrollDown = () => { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; };

export function createTrace() {
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
  if (messagesEl) {
    messagesEl.appendChild(wrap);
    scrollDown();
  }
  return card;
}

export function setStage(card, stage, status, attrs) {
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

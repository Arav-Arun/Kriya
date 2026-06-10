// Assistant workflow flowchart state and stage-event rendering.

const AGENT_NAMES = {
  triage: 'Triage Agent',
  investigation: 'Investigation Agent',
  bypass: 'Investigation Bypass',
  policy: 'Policy Agent',
  'similar-cases': 'Similar Cases Agent',
  'escalation-review': 'Escalation Review',
  'missing-info': 'Missing Info Checklist',
  routing: 'Routing Agent',
  ticket: 'Ticket Agent',
};

const STAGE_EDGES = {
  investigation: { incoming: 'path-to-investigation', outgoing: 'path-from-investigation' },
  policy: { incoming: 'path-to-policy', outgoing: 'path-from-policy' },
  'similar-cases': { incoming: 'path-to-similar-cases', outgoing: 'path-from-similar-cases' },
  'escalation-review': { incoming: 'path-to-escalation-review', outgoing: 'path-from-escalation-review' },
  'missing-info': { incoming: 'path-to-missing-info', outgoing: 'path-from-missing-info' },
};

const stageStartTimes = {};

function markPath(id, status) {
  document.getElementById(id)?.setAttribute('class', status);
}

function clearPath(id) {
  document.getElementById(id)?.removeAttribute('class');
}

function resetWorkflowFlowchart() {
  document.querySelectorAll('.node-wrapper').forEach((el) => {
    el.classList.remove('running', 'done', 'error', 'skipped');
    const stageId = el.id.replace('node-', '');
    const nodeEl = el.querySelector('.node');
    if (nodeEl && AGENT_NAMES[stageId]) {
      nodeEl.textContent = AGENT_NAMES[stageId];
    }
  });
  document.querySelectorAll('.node-detail').forEach((el) => {
    el.textContent = '';
  });
  document.querySelectorAll('.branch-connector path, .branch-connector line, .straight-connector line').forEach((el) => {
    el.removeAttribute('class');
  });
  document.getElementById('detail-ticket').textContent = 'Waiting for review';
}

function setWorkflowStep(stage, status, detail, elapsed) {
  const el = document.getElementById(`node-${stage}`);
  if (!el) return;
  el.classList.remove('running', 'done', 'error', 'skipped');
  if (status) el.classList.add(status);

  const nodeEl = el.querySelector('.node');
  if (nodeEl && AGENT_NAMES[stage]) {
    if (status === 'done' && elapsed) {
      nodeEl.textContent = `${AGENT_NAMES[stage]} · done in ${elapsed}s`;
    } else if (status === 'running') {
      nodeEl.textContent = `${AGENT_NAMES[stage]} · working…`;
    } else {
      nodeEl.textContent = AGENT_NAMES[stage];
    }
  }

  if (detail !== undefined) {
    const detailEl = document.getElementById(`detail-${stage}`);
    if (detailEl) detailEl.textContent = detail;
  }
}

function stageDetail(stage, output) {
  if (!output) return '';
  switch (stage) {
    case 'triage':
      return `${output.category} · ${output.priority}${output.customer_id ? ` · Customer ${output.customer_id}` : ''}`;
    case 'investigation':
      return `${output.matching_transactions?.length ?? 0} matching transactions · ${output.evidence?.length ?? 0} evidence items`;
    case 'policy':
      return `${output.policy_id} · ${output.eligibility} · SLA ${output.sla}`;
    case 'similar-cases':
      return `${output.cases?.length ?? 0} similar cases found`;
    case 'escalation-review':
      return `${output.required_approver} · Action: ${output.escalation_action}`;
    case 'missing-info':
      return `${output.missing_documents?.length ?? 0} docs missing · ${output.can_continue ? 'can continue' : 'halted'}`;
    case 'routing':
      return `${output.assigned_team}`;
    case 'ticket':
      return `${output.ticket_id} created`;
    default:
      return '';
  }
}

function markStandardBranch() {
  const escEl = document.getElementById('node-escalation-review');
  const missEl = document.getElementById('node-missing-info');
  if (!escEl.classList.contains('done') && !missEl.classList.contains('done')) {
    markPath('path-bypass-branch', 'done');
    markPath('path-bypass-branch-merge', 'done');
    escEl.classList.add('skipped');
    missEl.classList.add('skipped');
    markPath('path-to-escalation-review', 'skipped');
    markPath('path-to-missing-info', 'skipped');
  }
}

function handleStageRunning(stage) {
  stageStartTimes[stage] = performance.now();
  setWorkflowStep(stage, 'running', 'working…');
  const edges = STAGE_EDGES[stage];
  if (edges?.incoming) markPath(edges.incoming, 'active');
  if (stage === 'routing') markStandardBranch();
}

function handleStageDone(stage, output) {
  const elapsed = stageStartTimes[stage]
    ? ((performance.now() - stageStartTimes[stage]) / 1000).toFixed(1)
    : null;
  setWorkflowStep(stage, 'done', stageDetail(stage, output), elapsed);

  const edges = STAGE_EDGES[stage];
  if (edges?.incoming) markPath(edges.incoming, 'done');
  if (edges?.outgoing) markPath(edges.outgoing, 'done');

  if (stage === 'triage') {
    if (output.customer_id && output.customer_id > 0) {
      markPath('path-to-investigation', 'done');
      markPath('path-to-bypass', 'skipped');
      document.getElementById('node-bypass')?.classList.add('skipped');
    } else {
      markPath('path-to-bypass', 'done');
      markPath('path-from-bypass', 'done');
      document.getElementById('node-bypass')?.classList.add('done');
      markPath('path-to-investigation', 'skipped');
      document.getElementById('node-investigation')?.classList.add('skipped');
    }
  }

  if (stage === 'escalation-review') {
    markPath('path-to-missing-info', 'skipped');
    document.getElementById('node-missing-info')?.classList.add('skipped');
    markPath('path-bypass-branch', 'skipped');
    markPath('path-bypass-branch-merge', 'skipped');
  }
  if (stage === 'missing-info') {
    markPath('path-to-escalation-review', 'skipped');
    document.getElementById('node-escalation-review')?.classList.add('skipped');
    markPath('path-bypass-branch', 'skipped');
    markPath('path-bypass-branch-merge', 'skipped');
  }
}

function handleStageSkipped(stage, message) {
  setWorkflowStep(stage, 'skipped', message ?? 'skipped');
  if (stage === 'investigation') {
    markPath('path-to-bypass', 'done');
    markPath('path-from-bypass', 'done');
    document.getElementById('node-bypass')?.classList.add('done');
    markPath('path-to-investigation', 'skipped');

    const detailBypassEl = document.getElementById('detail-bypass');
    if (detailBypassEl) {
      detailBypassEl.textContent = message ? message.replace('Skipped — ', '') : 'Bypassed';
    }
  }
  if (stage === 'escalation-review') {
    markPath('path-to-escalation-review', 'skipped');
    markPath('path-from-escalation-review', 'skipped');
  }
  if (stage === 'missing-info') {
    markPath('path-to-missing-info', 'skipped');
    markPath('path-from-missing-info', 'skipped');
  }
}

function handleWorkflowStageEvent({ stage, status, output, message }) {
  if (status === 'running') handleStageRunning(stage);
  if (status === 'done') handleStageDone(stage, output);
  if (status === 'error') setWorkflowStep(stage, 'error', message ?? 'failed');
  if (status === 'skipped') handleStageSkipped(stage, message);
}


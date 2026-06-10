// Assistant page controller: starts workflow runs, streams events, and renders results.

renderNav('assistant');

const runBtn = document.getElementById('run');
const runStatus = document.getElementById('run-status');
const complaintEl = document.getElementById('complaint');
let analysis = null;
let eventSource = null;

resetAssistantPage();

document.querySelectorAll('.sample').forEach((button) => {
  button.addEventListener('click', () => {
    complaintEl.value = button.textContent.trim();
  });
});

runBtn.addEventListener('click', async () => {
  const complaint = complaintEl.value.trim();
  if (!complaint) {
    complaintEl.focus();
    return;
  }

  runBtn.disabled = true;
  runStatus.textContent = 'Starting workflow…';
  analysis = null;
  eventSource?.close();
  resetAssistantPage();

  try {
    const { runId } = await fetchJSON('/workflows/resolve-complaint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ complaint }),
    });
    runStatus.textContent = `Run ${runId.split(':').pop()}`;
    watchRun(runId, complaint);
  } catch (err) {
    runStatus.textContent = '';
    showError(String(err));
    runBtn.disabled = false;
  }
});

function resetAssistantPage() {
  resetWorkflowFlowchart();
  document.getElementById('outcome-card').hidden = true;
  document.getElementById('result-col').style.display = 'none';
  document.querySelector('.cols').classList.remove('has-results');
  document.getElementById('detail-cards').innerHTML = '';
  document.getElementById('ticket-area').innerHTML = '';
}

function showError(msg) {
  document.getElementById('detail-cards').innerHTML =
    `<div class="card"><div class="error-box">${esc(msg)}</div></div>`;
}

function watchRun(runId, complaint) {
  eventSource = new EventSource(`/runs/${encodeURIComponent(runId)}?offset=-1&live=sse`);
  eventSource.addEventListener('data', (e) => {
    for (const ev of JSON.parse(e.data)) handleEvent(ev, complaint);
  });
  eventSource.onerror = () => {};
}

function handleEvent(ev, complaint) {
  if (ev.type === 'log' && ev.message === 'stage') {
    handleWorkflowStageEvent(ev.attributes ?? {});
  }

  if (ev.type === 'run_end') {
    eventSource?.close();
    runBtn.disabled = false;
    if (ev.isError) {
      runStatus.textContent = '';
      showError(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
      return;
    }
    analysis = ev.result;
    runStatus.textContent = 'Analysis complete';
    renderOutcome(complaint);
  }
}

function renderOutcome(complaint) {
  const { triage, investigation, policy, similar_cases, branch, routing } = analysis;
  document.getElementById('outcome-card').hidden = false;
  document.getElementById('result-col').style.display = '';
  document.querySelector('.cols').classList.add('has-results');
  document.getElementById('outcome').innerHTML = `
    <dl class="kv">
      <dt>Issue Category</dt><dd><span class="badge">${esc(triage.category)}</span></dd>
      <dt>Priority</dt><dd>${priorityBadge(routing.priority)}</dd>
      <dt>Eligibility</dt><dd>${esc(policy.eligibility)} · SLA ${esc(policy.sla)}</dd>
      <dt>Similar Cases</dt><dd>${similar_cases.cases.length} found</dd>
      <dt>Branch</dt><dd>${branchSummary(branch)}</dd>
      <dt>Assigned Team</dt><dd><strong>${esc(routing.assigned_team)}</strong></dd>
      <dt>Escalation</dt><dd>${esc(routing.escalation_path)}</dd>
    </dl>`;
  document.getElementById('ticket-area').innerHTML =
    `<button class="primary" id="create-ticket">Create Ticket</button> <span id="ticket-status" style="color:var(--muted);font-size:13px"></span>`;
  document.getElementById('create-ticket').addEventListener('click', () => createTicket(complaint));

  document.getElementById('detail-cards').innerHTML = `
    ${branchCard(branch)}
    ${investigationCard(investigation)}
    ${policyCard(policy)}
    ${similarCasesCard(similar_cases)}`;
}

function branchCard(branch) {
  if (!branch || branch.type === 'standard') return '';

  if (branch.type === 'escalation' && branch.result) {
    return `
      <div class="card" style="border-left: 4px solid var(--red);">
        <h2>Escalation Review Findings</h2>
        <dl class="kv" style="margin-top: 10px;">
          <dt>Branch Reason</dt><dd>${esc(branch.reason ?? 'Policy escalation required')}</dd>
          <dt>Required Approver</dt><dd><strong>${esc(branch.result.required_approver)}</strong></dd>
          <dt>Reason</dt><dd>${esc(branch.result.reason)}</dd>
          <dt>Escalation Action</dt><dd><code>${esc(branch.result.escalation_action)}</code></dd>
          <dt>Customer Impact</dt><dd>${esc(branch.result.customer_impact)}</dd>
        </dl>
      </div>`;
  }

  if (branch.type === 'missing_information' && branch.result) {
    return `
      <div class="card" style="border-left: 4px solid var(--amber);">
        <h2>Missing Information Checklist</h2>
        <dl class="kv" style="margin-top: 10px;">
          <dt>Branch Reason</dt><dd>${esc(branch.reason ?? 'More information required')}</dd>
          <dt>Halt Resolution?</dt><dd>${branch.result.can_continue ? '<span class="badge green">No (Proceeding)</span>' : '<span class="badge red">Yes (Halted)</span>'}</dd>
          <dt>Missing Items</dt><dd>${branch.result.missing_documents?.length ? `<ul>${branch.result.missing_documents.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : 'None'}</dd>
          <dt>Customer Request</dt><dd><em>"${esc(branch.result.customer_facing_request)}"</em></dd>
        </dl>
      </div>`;
  }

  return '';
}

function branchSummary(branch) {
  const labels = {
    escalation: 'Escalation Review',
    missing_information: 'Missing Info Checklist',
    standard: 'Standard Flow',
  };
  const label = labels[branch?.type] ?? 'Standard Flow';
  return `${esc(label)}${branch?.reason ? ` · ${esc(branch.reason)}` : ''}`;
}

function investigationCard(investigation) {
  return `
    <div class="card">
      <h2>Investigation Summary</h2>
      <p style="margin:0 0 8px">${esc(investigation.notes)}</p>
      <ul class="evidence">${investigation.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      ${investigation.matching_transactions.length ? `
        <div class="table-container" style="margin-top:8px">
          <table><thead>
            <tr><th>Transaction</th><th>Time</th><th>Merchant</th><th>Amount</th><th>Status</th></tr>
          </thead><tbody>
            ${investigation.matching_transactions.map((t) => `
              <tr><td class="mono">${esc(t.id)}</td><td class="mono">${esc(t.timestamp.replace('T', ' ').replace('Z', ''))}</td>
              <td>${esc(t.merchant)}</td><td>${esc(t.currency)} ${t.amount.toLocaleString('en-IN')}</td>
              <td>${esc(t.status)}</td></tr>`).join('')}
          </tbody></table>
        </div>` : ''}
    </div>`;
}

function policyCard(policy) {
  return `
    <div class="card">
      <h2>Policy — ${esc(policy.policy_id)} ${esc(policy.policy_name)}</h2>
      <p style="margin:0 0 8px">${esc(policy.rationale)}</p>
      <dl class="kv">
        <dt>Required documents</dt><dd>${policy.required_documents.map(esc).join('; ') || '—'}</dd>
        <dt>Required actions</dt><dd>${policy.required_actions.map(esc).join('; ') || '—'}</dd>
        <dt>Escalation required</dt><dd>${policy.escalation_required ? 'Yes' : 'No'}</dd>
      </dl>
    </div>`;
}

function similarCasesCard(similarCases) {
  return `
    <div class="card">
      <h2>Similar Historical Cases</h2>
      ${similarCases.cases.map((c) => `
        <p style="margin:6px 0"><span class="badge grey">${esc(c.case_id)}</span>
        ${esc(c.similarity)}<br>
        <span style="color:var(--muted)">Resolution: ${esc(c.resolution)} (${esc(c.resolution_time)})</span></p>`).join('')}
      <p style="margin:10px 0 0"><strong>Common resolution:</strong> ${esc(similarCases.common_resolution)}</p>
      <p style="margin:4px 0 0"><strong>Recommended next action:</strong> ${esc(similarCases.recommended_next_action)}</p>
    </div>`;
}

async function createTicket(complaint) {
  const btn = document.getElementById('create-ticket');
  const status = document.getElementById('ticket-status');
  btn.disabled = true;
  status.textContent = 'Ticket Agent working…';
  const start = performance.now();
  setWorkflowStep('ticket', 'running', 'working…');
  markPath('path-to-ticket', 'active');
  try {
    const res = await fetchJSON('/workflows/create-ticket?wait=result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ complaint, analysis }),
    });
    const ticket = res.result?.ticket ?? res.ticket ?? res;
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    setWorkflowStep('ticket', 'done', `${ticket.id} created`, elapsed);
    markPath('path-to-ticket', 'done');
    status.textContent = '';
    document.getElementById('ticket-area').innerHTML =
      `<div class="success-box">Ticket Created: ${esc(ticket.id)} → ${esc(ticket.assigned_team)}
       &nbsp;·&nbsp; <a href="/tickets">View in Open Tickets</a></div>`;
  } catch (err) {
    setWorkflowStep('ticket', 'error', 'failed');
    clearPath('path-to-ticket');
    status.textContent = '';
    btn.disabled = false;
    showError(String(err));
  }
}

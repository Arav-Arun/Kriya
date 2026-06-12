// Sentinel UI Renderers
import { esc, inr } from './utils.js';

export const DISPUTE_BADGE = {
  under_review: ['amber', 'Under review'],
  provisional_credit: ['', 'Provisional credit'],
  won: ['green', 'Resolved — won'],
  lost: ['red', 'Rejected'],
};

export const ESC_STATUS_BADGE = {
  open: ['amber', 'Open'],
  in_progress: ['', 'In Progress'],
  resolved: ['green', 'Resolved'],
};

export const ESC_PRIORITY_BADGE = {
  Critical: 'red',
  High: 'amber',
  Medium: '',
  Low: 'grey',
};

export const ACTION_RENDER = {
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

export function renderEscalations(escalations) {
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

export function renderAccount(profile, txns, fees, subs) {
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

export function renderRecords(disputes, actions) {
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

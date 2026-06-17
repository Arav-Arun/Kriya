import { esc, inr, fmtWhen } from '/assets/utils.js';

let tickets = [];
let activeTicket = null;

// DOM Elements
const searchInput = document.getElementById('search-input');
const filterPriority = document.getElementById('filter-priority');
const filterCategory = document.getElementById('filter-category');
const filterTeam = document.getElementById('filter-team');
const countOpen = document.getElementById('count-open');
const countResolved = document.getElementById('count-resolved');
const cardsOpen = document.getElementById('cards-open');
const cardsResolved = document.getElementById('cards-resolved');
const detailsBackdrop = document.getElementById('details-backdrop');
const detailsDrawer = document.getElementById('details-drawer');
const drawerClose = document.getElementById('drawer-close');

// Drawer DOM Elements
const drawerTicketId = document.getElementById('drawer-ticket-id');
const drawerTicketPriority = document.getElementById('drawer-ticket-priority');
const drawerSummary = document.getElementById('drawer-summary');
const drawerCategory = document.getElementById('drawer-category');
const drawerTeam = document.getElementById('drawer-team');
const drawerStatus = document.getElementById('drawer-status');
const drawerCreatedAt = document.getElementById('drawer-created-at');
const drawerInvestigation = document.getElementById('drawer-investigation');
const drawerRecommendedAction = document.getElementById('drawer-recommended-action');

// Customer Profile DOM Elements
const custName = document.getElementById('cust-name');
const custPhone = document.getElementById('cust-phone');
const custEmail = document.getElementById('cust-email');
const custCibil = document.getElementById('cust-cibil');
const custVariant = document.getElementById('cust-variant');
const custLast4 = document.getElementById('cust-last4');
const custStatus = document.getElementById('cust-status');
const custOutstanding = document.getElementById('cust-outstanding');
const custAvailable = document.getElementById('cust-available');
const custLimit = document.getElementById('cust-limit');
const custMindue = document.getElementById('cust-mindue');
const custDuedate = document.getElementById('cust-duedate');
const custKyc = document.getElementById('cust-kyc');

// Resolution DOM Elements
const resolutionActionBox = document.getElementById('resolution-action-box');
const resolutionNotes = document.getElementById('resolution-notes');
const btnSubmitResolve = document.getElementById('btn-submit-resolve');
const resolvedInfoBox = document.getElementById('resolved-info-box');
const ticketResolvedBy = document.getElementById('ticket-resolved-by');
const ticketResolvedAt = document.getElementById('ticket-resolved-at');
const ticketResolvedNotes = document.getElementById('ticket-resolved-notes');

// Init
window.addEventListener('DOMContentLoaded', () => {
  fetchTickets();
  setupEventListeners();
});

// Event Listeners
function setupEventListeners() {
  searchInput.addEventListener('input', renderBoard);
  filterPriority.addEventListener('change', renderBoard);
  filterCategory.addEventListener('change', renderBoard);
  filterTeam.addEventListener('change', renderBoard);
  
  drawerClose.addEventListener('click', closeDrawer);
  detailsBackdrop.addEventListener('click', closeDrawer);
  
  btnSubmitResolve.addEventListener('click', handleResolveTicket);
  
  // Tabs Setup
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const tabId = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      document.getElementById(tabId).classList.add('active');
    });
  });
}

async function fetchTickets() {
  try {
    const res = await fetch('/api/escalations');
    if (!res.ok) throw new Error('Failed to load tickets');
    tickets = await res.json();
    populateCategoryFilter();
    renderBoard();
  } catch (err) {
    console.error('Error fetching tickets:', err);
    const errHTML = `<div class="loading-state" style="color:var(--red);">Error loading tickets: ${esc(err.message)}</div>`;
    cardsOpen.innerHTML = errHTML;
    cardsResolved.innerHTML = errHTML;
  }
}

function populateCategoryFilter() {
  const categories = [...new Set(tickets.map(t => t.category).filter(Boolean))];
  filterCategory.innerHTML = '<option value="">All Categories</option>' + 
    categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

function getPriorityBadgeClass(priority) {
  switch (String(priority).toLowerCase()) {
    case 'critical': return 'badge red';
    case 'high': return 'badge red';
    case 'medium': return 'badge amber';
    case 'low': return 'badge grey';
    default: return 'badge';
  }
}

function renderBoard() {
  const query = searchInput.value.toLowerCase().trim();
  const priority = filterPriority.value;
  const category = filterCategory.value;
  const team = filterTeam.value;
  
  const filtered = tickets.filter(t => {
    // Search filter
    if (query) {
      const idMatch = String(t.id).toLowerCase().includes(query);
      const summaryMatch = String(t.summary || '').toLowerCase().includes(query);
      const nameMatch = t.customers?.name ? String(t.customers.name).toLowerCase().includes(query) : false;
      const phoneMatch = t.customers?.phone ? String(t.customers.phone).toLowerCase().includes(query) : false;
      if (!idMatch && !summaryMatch && !nameMatch && !phoneMatch) return false;
    }
    
    // Dropdowns filters
    if (priority && t.priority !== priority) return false;
    if (category && t.category !== category) return false;
    if (team && t.assigned_team !== team) return false;
    
    return true;
  });
  
  const openList = filtered.filter(t => t.status === 'open');
  const resolvedList = filtered.filter(t => t.status === 'resolved');
  
  countOpen.textContent = openList.length;
  countResolved.textContent = resolvedList.length;
  
  renderColumn(cardsOpen, openList);
  renderColumn(cardsResolved, resolvedList);
}

function renderColumn(container, list) {
  if (list.length === 0) {
    container.innerHTML = '<div class="loading-state">No tickets found</div>';
    return;
  }
  
  container.innerHTML = list.map(t => {
    const custNameStr = t.customers?.name ? esc(t.customers.name) : 'Anonymous Customer';
    const last4 = t.customers?.card_number_last4 ? `(···· ${esc(t.customers.card_number_last4)})` : '';
    const dateStr = t.created_at ? fmtWhen(t.created_at) : '';
    const priorityBadge = `<span class="${getPriorityBadgeClass(t.priority)}">${esc(t.priority)}</span>`;
    
    return `
      <div class="ticket-card" data-id="${esc(t.id)}">
        <div class="card-top">
          <span class="ticket-id">${esc(t.id)}</span>
          ${priorityBadge}
        </div>
        <h4 class="card-summary">${esc(t.summary)}</h4>
        <div class="card-customer">
          <strong>${custNameStr}</strong> ${last4}
        </div>
        <div class="card-bottom">
          <span class="ticket-team">${esc(t.assigned_team)}</span>
          <span>${esc(dateStr)}</span>
        </div>
      </div>
    `;
  }).join('');
  
  // Add click listeners to cards
  container.querySelectorAll('.ticket-card').forEach(card => {
    card.addEventListener('click', () => {
      const ticketId = card.getAttribute('data-id');
      const ticketObj = tickets.find(t => t.id === ticketId);
      if (ticketObj) {
        openDrawer(ticketObj);
      }
    });
  });
}

function openDrawer(ticket) {
  activeTicket = ticket;
  
  // Set Drawer Basic Fields
  drawerTicketId.textContent = ticket.id;
  drawerTicketPriority.textContent = ticket.priority;
  drawerTicketPriority.className = getPriorityBadgeClass(ticket.priority);
  drawerSummary.textContent = ticket.summary || 'No summary';
  drawerCategory.textContent = ticket.category || 'General';
  drawerTeam.textContent = ticket.assigned_team || 'Customer Service';
  drawerStatus.textContent = ticket.status === 'open' ? 'Open' : 'Resolved';
  drawerCreatedAt.textContent = ticket.created_at ? fmtWhen(ticket.created_at) : '-';
  
  drawerInvestigation.innerHTML = ticket.investigation ? esc(ticket.investigation).replace(/\n/g, '<br>') : 'No investigation notes available.';
  drawerRecommendedAction.innerHTML = ticket.recommended_action ? esc(ticket.recommended_action).replace(/\n/g, '<br>') : 'No recommended action provided.';
  
  // Set Customer Fields
  const c = ticket.customers;
  if (c) {
    custName.textContent = esc(c.name);
    custPhone.textContent = c.phone ? esc(c.phone) : '-';
    custEmail.textContent = c.email ? esc(c.email) : '-';
    custCibil.textContent = c.cibil_score != null ? esc(c.cibil_score) : 'Unavailable';
    custVariant.textContent = c.card_variant ? esc(c.card_variant) : '-';
    custLast4.textContent = c.card_number_last4 ? esc(c.card_number_last4) : '-';
    custStatus.textContent = c.card_status ? esc(c.card_status).toUpperCase() : '-';
    custOutstanding.textContent = c.outstanding_total != null ? inr(c.outstanding_total) : 'Unavailable';
    custAvailable.textContent = c.available_limit != null ? inr(c.available_limit) : 'Unavailable';
    custLimit.textContent = c.credit_limit != null ? inr(c.credit_limit) : 'Unavailable';
    custMindue.textContent = c.minimum_due != null ? inr(c.minimum_due) : 'Unavailable';
    custDuedate.textContent = c.due_date ? esc(c.due_date) : 'Unavailable';
    custKyc.textContent = c.kyc_status ? esc(c.kyc_status).toUpperCase() : 'Unavailable';
  } else {
    // Clear Customer info
    ['cust-name', 'cust-phone', 'cust-email', 'cust-cibil', 'cust-variant', 'cust-last4', 'cust-status', 
     'cust-outstanding', 'cust-available', 'cust-limit', 'cust-mindue', 'cust-duedate', 'cust-kyc'].forEach(id => {
      document.getElementById(id).textContent = 'No customer profile linked';
    });
  }
  
  // Fetch and Load Customer Activity (Tabs)
  loadCustomerActivity(ticket.customer_id);
  
  // Show Resolution Box vs Resolved Info
  if (ticket.status === 'open') {
    resolutionActionBox.hidden = false;
    resolvedInfoBox.hidden = true;
    resolutionNotes.value = '';
    btnSubmitResolve.disabled = false;
    btnSubmitResolve.textContent = 'Mark as Resolved';
  } else {
    resolutionActionBox.hidden = true;
    resolvedInfoBox.hidden = false;
    ticketResolvedBy.textContent = ticket.resolved_by || 'System';
    ticketResolvedAt.textContent = ticket.resolved_at ? fmtWhen(ticket.resolved_at) : '-';
    ticketResolvedNotes.textContent = ticket.resolution_notes || 'No resolution notes provided.';
  }
  
  // Open Drawer UI
  detailsBackdrop.classList.add('open');
  detailsDrawer.classList.add('open');
}

function closeDrawer() {
  activeTicket = null;
  detailsBackdrop.classList.remove('open');
  detailsDrawer.classList.remove('open');
}

async function loadCustomerActivity(customerId) {
  const tabTxns = document.getElementById('tab-txns');
  const tabDisputes = document.getElementById('tab-disputes');
  const tabLogs = document.getElementById('tab-logs');
  
  tabTxns.innerHTML = '<div class="loading-state">Loading transactions...</div>';
  tabDisputes.innerHTML = '<div class="loading-state">Loading disputes...</div>';
  tabLogs.innerHTML = '<div class="loading-state">Loading audit log...</div>';
  
  if (!customerId) {
    const noCust = '<div class="loading-state">No customer linked</div>';
    tabTxns.innerHTML = noCust;
    tabDisputes.innerHTML = noCust;
    tabLogs.innerHTML = noCust;
    return;
  }
  
  // Parallel fetch transactions, disputes, and audit log
  Promise.all([
    fetch(`/api/customer/${customerId}/transactions`).then(r => r.json()).catch(() => []),
    fetch(`/api/customer/${customerId}/disputes`).then(r => r.json()).catch(() => []),
    fetch(`/api/customer/${customerId}/actions`).then(r => r.json()).catch(() => [])
  ]).then(([txns, disputes, logs]) => {
    // 1. Render Transactions
    // Wait, transactions returns object with { source: 'live_provider', transactions: [...] }
    const txnList = txns.transactions || txns || [];
    if (txnList.length === 0) {
      tabTxns.innerHTML = '<div class="loading-state">No transactions recorded</div>';
    } else {
      tabTxns.innerHTML = `
        <div class="mini-log-list">
          ${txnList.map(t => `
            <div class="mini-log-item">
              <div class="mini-log-meta">
                <span>${esc(t.id)} · ${esc(t.channel || 'ONLINE')}</span>
                <span>${t.timestamp ? fmtWhen(t.timestamp) : ''}</span>
              </div>
              <div style="display:flex; justify-content:space-between; font-weight:500;">
                <span>${esc(t.merchant)}</span>
                <span>${inr(t.amount)}</span>
              </div>
              <div style="font-size:11px; margin-top:2px; color: ${t.status === 'SUCCESS' ? 'var(--green)' : t.status === 'REFUNDED' ? 'var(--accent)' : 'var(--red)'}">
                ${esc(t.status)} ${t.decline_reason ? `· ${esc(t.decline_reason)}` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
    
    // 2. Render Disputes
    if (disputes.length === 0) {
      tabDisputes.innerHTML = '<div class="loading-state">No disputes filed</div>';
    } else {
      tabDisputes.innerHTML = `
        <div class="mini-log-list">
          ${disputes.map(d => `
            <div class="mini-log-item">
              <div class="mini-log-meta">
                <span>${esc(d.id)} · Raised ${d.raised_on ? esc(d.raised_on) : ''}</span>
                <span class="badge ${d.status === 'won' ? 'green' : d.status === 'lost' ? 'red' : 'amber'}">${esc(d.status).toUpperCase().replace('_', ' ')}</span>
              </div>
              <div><strong>Merchant:</strong> ${esc(d.merchant)} · <strong>Amount:</strong> ${inr(d.amount)}</div>
              <div style="font-size:12px; margin-top:4px; color:var(--muted)">
                <strong>Reason:</strong> ${esc(d.reason)}<br>
                <strong>Notes:</strong> ${esc(d.resolution_note || '')}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
    
    // 3. Render Audit Logs
    if (logs.length === 0) {
      tabLogs.innerHTML = '<div class="loading-state">No audit logs found</div>';
    } else {
      tabLogs.innerHTML = `
        <div class="mini-log-list">
          ${logs.map(l => {
            const detailStr = l.action_detail ? JSON.stringify(l.action_detail) : '';
            return `
              <div class="mini-log-item">
                <div class="mini-log-meta">
                  <span>${esc(l.action_type).toUpperCase().replace(/_/g, ' ')}</span>
                  <span>${l.performed_at ? fmtWhen(l.performed_at) : ''}</span>
                </div>
                <div style="font-size:12px; color:var(--muted); font-family:var(--mono);">
                  ${esc(detailStr.slice(0, 150))}${detailStr.length > 150 ? '...' : ''}
                </div>
                ${l.policy_reference ? `<div style="font-size:11px; color:var(--faint); margin-top:2px;">Policy: ${esc(l.policy_reference)}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  }).catch(err => {
    console.error('Error fetching logs:', err);
    const failHTML = `<div class="loading-state" style="color:var(--red);">Failed to load activity logs: ${esc(err.message)}</div>`;
    tabTxns.innerHTML = failHTML;
    tabDisputes.innerHTML = failHTML;
    tabLogs.innerHTML = failHTML;
  });
}

async function handleResolveTicket() {
  if (!activeTicket) return;
  const notes = resolutionNotes.value.trim();
  if (!notes) {
    alert('Please enter resolution notes before resolving.');
    return;
  }
  
  btnSubmitResolve.disabled = true;
  btnSubmitResolve.textContent = 'Resolving ticket...';
  
  try {
    const res = await fetch(`/api/escalations/${activeTicket.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resolved_by: 'Support Operator',
        notes: notes
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to resolve escalation');
    
    // Update local ticket state
    activeTicket.status = 'resolved';
    activeTicket.resolved_by = 'Support Operator';
    activeTicket.resolved_at = new Date().toISOString();
    activeTicket.resolution_notes = notes;
    
    // Close drawer, refetch and re-render
    closeDrawer();
    fetchTickets();
  } catch (err) {
    console.error('Error resolving ticket:', err);
    alert(`Error: ${err.message}`);
    btnSubmitResolve.disabled = false;
    btnSubmitResolve.textContent = 'Mark as Resolved';
  }
}

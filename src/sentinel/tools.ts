// Model-callable tools for the Sentinel agents (docs/03_AGENT_ARCHITECTURE.md).
import { defineTool, Type } from '@flue/runtime';
import {
  getCustomer, getTransactions, searchCases, createTicket,
} from '../lib/sentinel-db.ts';
import { searchPolicies, getPlaybook, TEAM_BY_CATEGORY } from '../lib/knowledge.ts';

export const getCustomerTool = defineTool({
  name: 'get_customer',
  description: 'Look up a customer record (name, card status, risk score) by numeric customer ID.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const customer = await getCustomer(Number(customer_id));
    if (!customer) return JSON.stringify({ error: `No customer with id ${customer_id}` });
    return JSON.stringify(customer);
  },
});

export const getTransactionsTool = defineTool({
  name: 'get_transactions',
  description:
    'Fetch a customer\'s most recent card transactions (newest first). Optionally filter by merchant name substring. Amounts are in the listed currency (INR unless stated). Each row has id, timestamp, merchant, category, amount, currency, channel, location, status (SUCCESS/DECLINED) and decline_reason.',
  parameters: Type.Object({
    customer_id: Type.Number(),
    merchant: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number({ description: 'Max rows, default 30, max 100' })),
  }),
  execute: async ({ customer_id, merchant, limit }) => {
    const rows = await getTransactions(Number(customer_id), {
      merchant: merchant ? String(merchant) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return JSON.stringify({ count: rows.length, transactions: rows });
  },
});

export const getCardStatusTool = defineTool({
  name: 'get_card_status',
  description: 'Get only the card status (active / blocked / frozen / closed) and risk score for a customer ID.',
  parameters: Type.Object({ customer_id: Type.Number() }),
  execute: async ({ customer_id }) => {
    const customer = await getCustomer(Number(customer_id));
    if (!customer) return JSON.stringify({ error: `No customer with id ${customer_id}` });
    return JSON.stringify({ customer_id: customer.id, card_status: customer.card_status, risk_score: customer.risk_score });
  },
});

export const searchPolicyTool = defineTool({
  name: 'search_policy',
  description:
    'Search the bank\'s internal policy documents by keywords (issue type, merchant context, "duplicate charge", "fraud", "EMI", etc.). Returns the full text of the best-matching policies including eligibility rules, required documents, SLA, escalation conditions, and resolution procedure.',
  parameters: Type.Object({
    query: Type.String({ description: 'Keywords describing the issue' }),
  }),
  execute: async ({ query }) => {
    const docs = searchPolicies(String(query));
    if (docs.length === 0) return JSON.stringify({ error: 'No matching policies' });
    return docs.map((d) => `=== ${d.title} (${d.slug}) ===\n${d.content}`).join('\n\n');
  },
});

export const searchSimilarCasesTool = defineTool({
  name: 'search_similar_cases',
  description:
    'Search 100 resolved historical support cases by keywords, optionally filtered by category. Returns the closest matches with complaint, investigation findings, resolution, team, priority and resolution time. Use it to find precedents for the current complaint.',
  parameters: Type.Object({
    query: Type.String({ description: 'Keywords from the complaint and evidence' }),
    category: Type.Optional(Type.String({ description: 'e.g. "Duplicate Charge", "Fraud"' })),
    limit: Type.Optional(Type.Number({ description: 'Max cases, default 5' })),
  }),
  execute: async ({ query, category, limit }) => {
    const rows = await searchCases(String(query), {
      category: category ? String(category) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return JSON.stringify({ count: rows.length, cases: rows });
  },
});

export const assignTeamTool = defineTool({
  name: 'assign_team',
  description:
    'Resolve the owning team for an issue category and return that team\'s playbook (responsibilities, priority matrix, escalation rules, resolution guidelines). Valid categories: ' +
    Object.keys(TEAM_BY_CATEGORY).join(', ') + '.',
  parameters: Type.Object({
    category: Type.String({ description: 'Issue category' }),
  }),
  execute: async ({ category }) => {
    const cat = String(category);
    const team = TEAM_BY_CATEGORY[cat]
      ?? Object.entries(TEAM_BY_CATEGORY).find(([k]) => k.toLowerCase() === cat.toLowerCase())?.[1];
    if (!team) {
      return JSON.stringify({
        error: `Unknown category "${cat}"`,
        valid_categories: Object.keys(TEAM_BY_CATEGORY),
      });
    }
    const playbook = getPlaybook(team);
    return JSON.stringify({ category: cat, assigned_team: team, playbook: playbook?.content ?? null });
  },
});

export const createTicketTool = defineTool({
  name: 'create_ticket',
  description:
    'Create and store the final support ticket. Call this exactly once with the complete ticket fields. Returns the new ticket ID (e.g. TKT-1024).',
  parameters: Type.Object({
    category: Type.String(),
    priority: Type.String({ description: 'Low | Medium | High | Critical' }),
    customer_id: Type.Optional(Type.Number({ description: 'Omit if the customer was not identified' })),
    customer_name: Type.Optional(Type.String()),
    assigned_team: Type.String(),
    summary: Type.String({ description: '2-3 sentence operational summary of the issue and findings' }),
    complaint: Type.String({ description: 'The original complaint text' }),
    evidence: Type.String({ description: 'Bullet-style evidence summary from the investigation' }),
    policy_reference: Type.String({ description: 'Policy ID and name, e.g. "POL-001 Duplicate Charge"' }),
    sla: Type.String({ description: 'Resolution SLA from the policy' }),
    similar_case_ids: Type.String({ description: 'Comma-separated historical case IDs' }),
    recommendation: Type.String({ description: 'Recommended resolution action for the assignee' }),
  }),
  execute: async (args) => {
    const id = await createTicket({
      category: String(args.category),
      priority: String(args.priority),
      customer_id: args.customer_id == null ? null : Number(args.customer_id),
      customer_name: args.customer_name == null ? null : String(args.customer_name),
      assigned_team: String(args.assigned_team),
      summary: String(args.summary),
      complaint: String(args.complaint),
      evidence: String(args.evidence),
      policy_reference: String(args.policy_reference),
      sla: String(args.sla),
      similar_case_ids: String(args.similar_case_ids),
      recommendation: String(args.recommendation),
    });
    return JSON.stringify({ ticket_id: id, status: 'OPEN' });
  },
});

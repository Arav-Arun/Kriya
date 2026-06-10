// Structured outputs each agent must return (docs/03_AGENT_ARCHITECTURE.md).
// Flue validates the agent's answer against these before the workflow sees it.
import * as v from 'valibot';

export const CATEGORIES = [
  'Duplicate Charge', 'Fraud Transactions', 'Card Declined', 'EMI Conversion',
  'Rewards', 'Chargeback', 'Lost Card', 'KYC', 'Credit Limit Increase',
  'Card Closure', 'International Transactions', 'Merchant Disputes',
] as const;

export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;

export const TEAMS = [
  'Disputes Operations', 'Fraud Operations', 'Card Operations',
  'Customer Service', 'Risk Operations',
] as const;

export const TriageResult = v.object({
  category: v.picklist(CATEGORIES),
  priority: v.picklist(PRIORITIES),
  customer_id: v.nullable(v.number()),
  entities: v.array(v.object({ type: v.string(), value: v.string() })),
  summary: v.string(),
});
export type TriageResult = v.InferOutput<typeof TriageResult>;

export const InvestigationResult = v.object({
  customer_found: v.boolean(),
  customer_name: v.nullable(v.string()),
  card_status: v.nullable(v.string()),
  risk_score: v.nullable(v.number()),
  matching_transactions: v.array(v.object({
    id: v.string(),
    timestamp: v.string(),
    merchant: v.string(),
    amount: v.number(),
    currency: v.string(),
    status: v.string(),
  })),
  evidence: v.array(v.string()),
  notes: v.string(),
});
export type InvestigationResult = v.InferOutput<typeof InvestigationResult>;

export const PolicyResult = v.object({
  policy_id: v.string(),
  policy_name: v.string(),
  eligibility: v.picklist(['Eligible', 'Not Eligible', 'Needs More Information']),
  sla: v.string(),
  required_documents: v.array(v.string()),
  required_actions: v.array(v.string()),
  escalation_required: v.boolean(),
  rationale: v.string(),
});
export type PolicyResult = v.InferOutput<typeof PolicyResult>;

export const SimilarCasesResult = v.object({
  cases: v.array(v.object({
    case_id: v.string(),
    category: v.string(),
    similarity: v.string(),
    resolution: v.string(),
    resolution_time: v.string(),
  })),
  common_resolution: v.string(),
  recommended_next_action: v.string(),
});
export type SimilarCasesResult = v.InferOutput<typeof SimilarCasesResult>;

export const RoutingResult = v.object({
  assigned_team: v.picklist(TEAMS),
  priority: v.picklist(PRIORITIES),
  escalation_path: v.string(),
  rationale: v.string(),
});
export type RoutingResult = v.InferOutput<typeof RoutingResult>;

export const TicketResult = v.object({
  ticket_id: v.string(),
});
export type TicketResult = v.InferOutput<typeof TicketResult>;

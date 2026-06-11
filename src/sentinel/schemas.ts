// Structured outputs for the specialist agents. Flue validates each agent's
// answer against these before the workflow sees it.
import * as v from 'valibot';

export const CATEGORIES = [
  'Late Fee / Penalty', 'Duplicate Charge', 'Fraud Transactions', 'Card Declined',
  'EMI Conversion', 'Rewards', 'Chargeback', 'Lost Card', 'KYC',
  'Credit Limit Increase', 'Card Closure', 'International Transactions',
  'Merchant Disputes', 'Subscriptions / Autopay', 'Card Management',
  'Account Inquiry', 'General',
] as const;

export const URGENCIES = ['Low', 'Medium', 'High', 'Critical'] as const;

export const TEAMS = [
  'Disputes Operations', 'Fraud Operations', 'Card Operations',
  'Customer Service', 'Risk Operations',
] as const;

// Triage: decides whether this turn needs the parallel specialist fan-out.
export const TriageRouting = v.object({
  route: v.picklist(['direct', 'analysis']),
  category: v.picklist(CATEGORIES),
  urgency: v.picklist(URGENCIES),
  reasoning: v.string(),
});
export type TriageRouting = v.InferOutput<typeof TriageRouting>;

// Investigation: customer-data forensics.
export const InvestigationFindings = v.object({
  findings: v.array(v.string()),
  relevant_transactions: v.array(v.object({
    id: v.string(),
    merchant: v.string(),
    amount: v.number(),
    timestamp: v.string(),
    status: v.string(),
  })),
  payment_behavior: v.string(),
  flags: v.array(v.string()),
});
export type InvestigationFindings = v.InferOutput<typeof InvestigationFindings>;

// Policy: governing policy and eligibility.
export const PolicyFindings = v.object({
  policy_id: v.string(),
  policy_name: v.string(),
  eligibility: v.picklist(['Eligible', 'Not Eligible', 'Needs More Information']),
  sla: v.string(),
  key_rules: v.array(v.string()),
  escalation_required: v.boolean(),
});
export type PolicyFindings = v.InferOutput<typeof PolicyFindings>;

// Precedent: historical case matching.
export const PrecedentFindings = v.object({
  cases: v.array(v.object({
    case_id: v.string(),
    similarity: v.string(),
    resolution: v.string(),
  })),
  recommended_approach: v.string(),
});
export type PrecedentFindings = v.InferOutput<typeof PrecedentFindings>;

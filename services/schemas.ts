// Structured outputs schemas for Flue specialist agents.
import * as v from 'valibot';

export const CATEGORIES = [
  'Late Fee / Penalty', 'Duplicate Charge', 'Fraud Transactions', 'Card Declined',
  'EMI Conversion', 'Rewards', 'Chargeback', 'Lost Card', 'KYC',
  'Credit Limit Increase', 'Card Closure', 'International Transactions',
  'Merchant Disputes', 'Subscriptions / Autopay', 'Card Management',
  'Account Inquiry', 'General',
] as const;

const URGENCIES = ['Low', 'Medium', 'High', 'Critical'] as const;

export const TEAMS = [
  'Disputes Operations', 'Fraud Operations', 'Card Operations',
  'Customer Service', 'Risk Operations',
] as const;

// Triage schema
export const TriageRouting = v.object({
  route: v.picklist(['direct', 'analysis']),
  category: v.picklist(CATEGORIES),
  urgency: v.picklist(URGENCIES),
  reasoning: v.string(),
});
export type TriageRouting = v.InferOutput<typeof TriageRouting>;

// Investigation schema
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

// Policy schema
export const PolicyFindings = v.object({
  policy_id: v.string(),
  policy_name: v.string(),
  eligibility: v.picklist(['Eligible', 'Not Eligible', 'Needs More Information']),
  sla: v.string(),
  key_rules: v.array(v.string()),
  escalation_required: v.boolean(),
});
export type PolicyFindings = v.InferOutput<typeof PolicyFindings>;

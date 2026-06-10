# Policy: Credit Limit Increase

- Policy ID: POL-009
- Version: 2.1 | Effective: 01-Apr-2026
- Owner: Risk Operations

## Description

Governs customer-initiated credit limit increase (CLI) requests and bank-offered pre-approved increases. Per RBI card directions, limit increases require explicit customer consent — no unsolicited limit enhancement may be applied. Decisions are based on repayment history, bureau score, utilization, and income.

## Eligibility Rules

1. Account vintage of at least 6 months from card issuance.
2. No payment overdue in the trailing 12 months (no instance of 30+ days past due).
3. CIBIL score of 730 or above at the time of request.
4. Average utilization above 30% over the last 3 cycles supports the case; chronic utilization above 90% triggers affordability review instead of auto-approval.
5. Income proof is mandatory when the requested increase exceeds 40% of the current limit, or when the last income declaration is older than 24 months.
6. No active fraud investigation or KYC freeze on the account.

## Required Documents

- For salaried: latest 3 months' salary slips, or bank statement showing salary credits
- For self-employed: latest ITR with computation of income
- Not required for pre-approved offers within the pre-assessed cap

## Assigned Team

Risk Operations

## SLA

- Decision: within 3 working days of complete documentation
- Approved limit effective: immediately upon approval, confirmed via SMS/email

## Escalation Conditions

- Requested increase exceeds 100% of current limit, or the resulting limit exceeds ₹10,00,000 → Credit Committee approval.
- Active or recent (6 months) fraud flag on the account → auto-decline with Risk review before any future request.
- Income documents inconsistent with bureau-reported obligations → manual underwriting referral.

## Resolution Procedure

1. Confirm explicit customer consent for the increase request.
2. Run eligibility checks: vintage, delinquency history, bureau score, utilization, existing exposure.
3. Collect and verify income documents where required.
4. Compute the approved limit per the underwriting grid; cap at policy maximums.
5. Apply the new limit, send confirmation, and update bureau reporting next cycle.
6. For declines, communicate the primary reason (per fair-practice code) and the earliest re-application date (90 days).

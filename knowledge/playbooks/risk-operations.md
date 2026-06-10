# Team Playbook: Risk Operations

- Playbook ID: PB-005
- Version: 1.9 | Effective: 01-Apr-2026

## Responsibilities

- Own KYC compliance: periodic re-KYC, verification, freezes/unfreezes, and CKYC registry updates
- Underwrite credit limit increase requests and manage credit-line decreases on risk triggers
- Maintain customer risk scores and account risk ratings
- Review merchants flagged for dispute or fraud patterns; recommend network alerts or blocks
- Conduct account reviews referred by other teams (repeat fraud, replacement abuse, reward abuse)

## Issue Categories

- KYC (POL-008)
- Credit Limit Increase (POL-009)
- Risk re-rating referrals from Fraud Operations and Card Operations
- Merchant risk reviews referred from Disputes Operations

## Priority Matrix

| Priority | Criteria | First Response | Target Resolution |
|----------|----------|----------------|-------------------|
| P1 — Critical | Sanctions/PEP match pending clearance; account frozen in error | 2 hours | 1 working day |
| P2 — High | KYC-frozen account with verified documents awaiting unfreeze | 4 hours | 1 working day |
| P3 — Medium | CLI requests with complete documents; standard re-KYC verification | 24 hours | 3 working days |
| P4 — Low | Risk re-rating reviews, merchant reviews, data updates | 48 hours | 10 working days |

## Escalation Rules

1. PEP or sanctions list match → Compliance for enhanced due diligence; account stays frozen until cleared.
2. Suspected forged KYC documents → Risk Lead + fraud screening; do not return documents or tip off the customer.
3. CLI above ₹10,00,000 resulting limit or >100% increase → Credit Committee.
4. Affordability concerns (chronic >90% utilization with minimum payments) → restructure desk, not auto-decline.
5. Merchant review concluding "block" → network alert filed and Disputes Operations notified for open cases.

## Resolution Guidelines

- KYC freezes punish delay heavily — verify and unfreeze within one working day once documents pass; track every frozen account daily.
- Apply the CLI underwriting grid consistently; document any deviation with named approver.
- Communicate decline reasons specifically (per fair-practice code) — "policy reasons" is not an acceptable customer message.
- Risk score changes must cite the trigger event; unexplained score movements erode downstream trust in the score.
- For referred account reviews, close the loop with the referring team — tell them what changed and why.

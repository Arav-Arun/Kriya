# Team Playbook: Disputes Operations

- Playbook ID: PB-001
- Version: 2.0 | Effective: 01-Apr-2026

## Responsibilities

- Investigate and resolve billing disputes: duplicate charges, merchant disputes, and wrong-amount billing
- Own the full chargeback lifecycle: initiation, representment review, pre-arbitration, and arbitration
- Post and reconcile shadow (provisional) credits within RBI timelines
- Liaise with acquiring banks and card networks (Visa, Mastercard, RuPay) on dispute cases
- Track merchant dispute patterns and refer repeat offenders to Risk Operations

## Issue Categories

- Duplicate Charge (POL-001)
- Chargeback (POL-006)
- Merchant Disputes (POL-012)
- Billing corrections referred from EMI Conversion failures (POL-004)

## Priority Matrix

| Priority | Criteria | First Response | Target Resolution |
|----------|----------|----------------|-------------------|
| P1 — Critical | Amount > ₹2,00,000, or SLA breach imminent on shadow credit | 2 hours | 3 working days |
| P2 — High | Amount ₹50,000–₹2,00,000, or merchant unresponsive past window | 4 hours | 5 working days |
| P3 — Medium | Amount ₹5,000–₹50,000, standard dispute flow | 24 hours | 7 working days |
| P4 — Low | Amount < ₹5,000, single transaction, cooperative merchant | 24 hours | 10 working days |

## Escalation Rules

1. Amount > ₹50,000 → Senior Dispute Analyst owns the case.
2. Amount > ₹2,00,000 → Manager sign-off before chargeback/arbitration filing.
3. Merchant representment received → Pre-Arbitration Analyst within 5 working days.
4. Any indication the customer did not authorize the transaction → reclassify and transfer to Fraud Operations the same day.
5. 5+ disputes against one merchant in 30 days → Risk Operations merchant review.
6. Shadow-credit SLA (7 working days for duplicates) at risk → auto-escalate to team lead at day 5.

## Resolution Guidelines

- Always distinguish duplicate billing from merchant retries, split shipments, and recurring subscriptions before raising a dispute.
- Post shadow credit on time even if investigation continues; reversing later is acceptable, missing the RBI timeline is not.
- Build the evidence pack to the network reason code's exact requirements — incomplete packs lose representments.
- Keep customers informed at initiation, merchant response, and closure; silence drives repeat contacts and escalations.
- Record disposition codes accurately; they feed merchant risk reviews and policy tuning.

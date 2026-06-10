# Team Playbook: Card Operations

- Playbook ID: PB-003
- Version: 1.8 | Effective: 01-Apr-2026

## Responsibilities

- Resolve card lifecycle issues: declines, blocks/unblocks, lost-card hotlisting, replacements, and closures
- Manage usage controls: domestic/international flags, channel limits, contactless settings
- Run the card closure process within the RBI 7-working-day mandate
- Investigate authorization failures using decline response codes and network logs
- Handle international usage enablement, forex markup, and DCC billing queries

## Issue Categories

- Card Declined (POL-003)
- Lost Card (POL-007)
- Card Closure (POL-010)
- International Transactions (POL-011)

## Priority Matrix

| Priority | Criteria | First Response | Target Resolution |
|----------|----------|----------------|-------------------|
| P1 — Critical | Lost/stolen card (hotlist), customer stranded abroad, closure SLA at risk | Immediate (block < 30 min) | Same day for containment |
| P2 — High | Recurring declines blocking essential payments; suspected-fraud block referral | 4 business hours | 1 working day |
| P3 — Medium | Single decline investigation, international enablement issues, replacement tracking | 4 business hours | 2 working days |
| P4 — Low | Closure requests (within mandate), markup explanations, settings changes | 24 hours | 7 working days |

## Escalation Rules

1. Decline reason = SUSPECTED_FRAUD_BLOCK → Fraud Operations; never unblock without their clearance.
2. Decline reason = INSUFFICIENT_CREDIT_LIMIT with a CLI request → Risk Operations under POL-009.
3. Card closure exceeding 7 working days → Card Operations Manager; credit ₹500/day penalty proactively.
4. Third replacement in 12 months → Risk Operations misuse/compromise review.
5. Persistent declines with correct flags and available limit → technical desk with full network logs.
6. Lost card abroad → emergency assistance desk for expedited replacement.

## Resolution Guidelines

- Read the actual decline response code before theorizing — the log answers most decline complaints in one step.
- Hotlisting is irreversible; offer temporary freeze when the customer suspects misplacement rather than theft.
- On closure, check unbilled transactions and active EMIs first — they are the most common closure blockers.
- After any block/unblock or flag change, have the customer attempt a verification transaction before closing the case.
- Kill digital tokens whenever a card number is compromised or replaced; a blocked plastic card with live tokens is still exploitable.

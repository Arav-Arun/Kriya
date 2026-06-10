# Team Playbook: Fraud Operations

- Playbook ID: PB-002
- Version: 2.3 | Effective: 01-Apr-2026

## Responsibilities

- Contain reported and suspected card fraud: immediate blocks, token kills, and re-issuance
- Investigate unauthorized transactions: device, IP, geolocation, 3-D Secure and OTP log analysis
- Apply the RBI limited-liability matrix and decide customer refunds
- Raise fraud-coded chargebacks and Common Point of Purchase (CPP) alerts to networks
- Coordinate with law enforcement and the bank's nodal officer on high-value cases
- Monitor real-time fraud rules and feed confirmed-fraud signals back to rule tuning

## Issue Categories

- Fraud Transactions / unauthorized usage (POL-002)
- Suspected-fraud declines referred from Card Declined cases (POL-003)
- Unrecognized international transactions referred under POL-011
- Fraud occurring between card loss and report, referred from Lost Card (POL-007)

## Priority Matrix

| Priority | Criteria | First Response | Target Resolution |
|----------|----------|----------------|-------------------|
| P1 — Critical | Fraud in progress (active card), or amount > ₹1,00,000 | Immediate (block < 30 min) | 5 working days for containment + liability decision |
| P2 — High | Confirmed fraud, card already blocked, amount ₹25,000–₹1,00,000 | 2 hours | 7 working days |
| P3 — Medium | Single disputed transaction < ₹25,000, card blocked | 4 hours | 10 working days |
| P4 — Low | Suspicious-activity review, no customer dispute yet | 24 hours | 15 working days |

Final resolution including network recovery may run to the 90-day RBI outer limit; shadow credit must post within 10 working days regardless.

## Escalation Rules

1. Total disputed amount > ₹1,00,000 → Fraud Operations Lead + law-enforcement liaison; FIR required.
2. Skimming pattern across multiple cards at one terminal → CPP alert to the network within 24 hours.
3. Second confirmed fraud on the same customer in 6 months → Risk Operations account re-rating.
4. Suspected merchant or insider collusion → Compliance and Vigilance, with case file sealed.
5. Customer-induced classification contested by the customer → independent review by a second analyst before final decision.

## Resolution Guidelines

- Block first, investigate second — never keep a compromised card active to "observe".
- Capture evidence before it ages: OTP delivery logs, device fingerprints, and merchant descriptors.
- Apply the liability matrix mechanically on report timing; do not negotiate liability case-by-case.
- Communicate the shadow-credit date proactively; fraud victims are the most anxious customer segment.
- Classify the fraud vector on every case — vector statistics drive rule and limit changes.

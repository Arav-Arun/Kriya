# Policy: Chargeback

- Policy ID: POL-006
- Version: 2.7 | Effective: 01-Apr-2026
- Owner: Disputes Operations

## Description

A chargeback is a formal dispute raised through the card network (Visa, Mastercard, RuPay) to recover funds from the acquiring bank/merchant when direct merchant resolution fails or is inapplicable. Chargebacks carry network reason codes (e.g., duplicate processing, goods not received, fraud — card absent, credit not processed) and follow network-defined timelines for representment and arbitration.

## Eligibility Rules

1. The chargeback must be raised within 120 calendar days of the transaction settlement date (network rule), or of the expected-delivery date for goods/services disputes.
2. For goods/services disputes, the customer must have first attempted merchant resolution (15 days elapsed or documented merchant refusal) — see POL-012.
3. A valid network reason code must apply; "customer changed mind" is not chargeback-eligible.
4. Fraud-coded chargebacks require the card to be blocked and the fraud case registered under POL-002.
5. One chargeback per disputed transaction; partial-amount chargebacks allowed where partially delivered.

## Required Documents

- Customer Dispute Form with transaction details
- Proof of merchant contact attempt (for goods/services reason codes)
- Order confirmations, invoices, delivery/refund proof as applicable to the reason code

## Assigned Team

Disputes Operations

## SLA

- Chargeback initiation: within 3 working days of eligibility confirmation
- Shadow (provisional) credit: posted at initiation
- Merchant representment window: 30–45 days per network
- Final resolution: 90–120 days depending on network cycle and arbitration

## Escalation Conditions

- Merchant submits representment (re-presents the charge) → Pre-Arbitration Analyst reviews evidence quality within 5 working days.
- Disputed amount exceeds ₹2,00,000 → Disputes Operations Manager sign-off before arbitration filing.
- Network arbitration ruling against the bank → write-off committee per delegation matrix.

## Resolution Procedure

1. Validate eligibility, timelines, and reason code; verify prerequisite merchant-resolution attempt where required.
2. Compile the evidence pack per the network's reason-code requirements.
3. Raise the chargeback in the network dispute system; post shadow credit.
4. Monitor for representment; if none within the window, make the shadow credit permanent.
5. If represented, evaluate merchant evidence; either accept (reverse shadow credit, explain to customer) or proceed to pre-arbitration.
6. Record final outcome and network case ID; close with disposition "Chargeback Won", "Chargeback Lost", or "Withdrawn".

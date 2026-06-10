# Policy: Merchant Disputes

- Policy ID: POL-012
- Version: 2.5 | Effective: 01-Apr-2026
- Owner: Disputes Operations

## Description

Covers disputes where the transaction itself was authorized but the merchant failed to deliver as agreed: goods/services not received, defective or not-as-described items, wrong amount billed, cancelled orders or subscriptions still charged, and refunds promised but not processed. Merchant disputes precede and feed into the chargeback process (POL-006) when direct resolution fails.

## Eligibility Rules

1. The customer must first attempt resolution with the merchant; the dispute is eligible when 15 days have passed since merchant contact, or the merchant has explicitly refused in writing.
2. "Refund not received" disputes are eligible 10 working days after the merchant's documented refund confirmation.
3. Disputes must be raised within 120 calendar days of the transaction (or expected delivery date), aligned with network chargeback windows.
4. Quality/"not as described" disputes require evidence (photos, communication); pure buyer's remorse is not eligible.
5. Subscription disputes require proof of cancellation before the billing date.

## Required Documents

- Order confirmation / invoice
- Proof of merchant contact (emails, support tickets, call references) with dates
- Refund confirmation from the merchant, where applicable
- Photos or descriptions for defective/not-as-described claims

## Assigned Team

Disputes Operations

## SLA

- First response: within 24 hours
- Merchant outreach and response window: 7 working days
- If unresolved after merchant outreach: chargeback initiation within 3 working days (per POL-006 SLAs thereafter)

## Escalation Conditions

- Merchant unresponsive after 7 working days → initiate chargeback with the applicable reason code.
- Disputed amount exceeds ₹1,00,000 → Senior Dispute Analyst handles the case end-to-end.
- Pattern of disputes against the same merchant (5+ in 30 days across customers) → Risk Operations merchant review; possible network alert.

## Resolution Procedure

1. Verify eligibility: merchant-contact attempt, timelines, and evidence completeness.
2. Classify the dispute type (non-delivery, defective, wrong amount, cancelled-but-billed, refund not processed).
3. Contact the acquiring bank/merchant with the evidence pack; request resolution or written response within 7 working days.
4. If the merchant resolves (refund/replacement), verify the credit posts to the card and close.
5. If refused or unresponsive, initiate chargeback under POL-006 with the matching reason code; post shadow credit at initiation.
6. Keep the customer informed at each stage; close with disposition and any credit reference.

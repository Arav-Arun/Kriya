# Policy: Duplicate Charge

- Policy ID: POL-001
- Version: 2.3 | Effective: 01-Apr-2026
- Owner: Disputes Operations

## Description

A duplicate charge occurs when the same card is billed more than once by the same merchant for the same purchase; typically an identical amount within a short window (0-30 minutes). Common causes are merchant POS retries, payment gateway timeouts where the customer re-attempts payment, and double-submission on e-commerce checkout pages. Duplicate charges are distinct from recurring subscription billing and from split shipments billed separately.

## Eligibility Rules

1. Both transactions must be settled (posted), not one settled and one pending authorization. Pending authorizations usually auto-reverse within 5-7 working days.
2. The duplicate must be reported within 60 days of the statement date on which it appears.
3. Transactions must be at the same merchant with identical or near-identical amounts (tolerance ±₹1 for rounding) within a 24-hour window.
4. The transaction pattern must not match a recurring subscription (same merchant, same amount, ~30-day interval).
5. The card account must be in good standing or recently blocked; closed accounts older than 90 days are handled via the Card Closure desk.

## Required Documents

- Customer confirmation of the disputed transaction pair (transaction IDs or date/amount/merchant)
- Relevant statement extract or app transaction screenshot
- Merchant invoice or order confirmation, if available (optional but accelerates resolution)

## Assigned Team

Disputes Operations

## SLA

- Acknowledgement: within 24 hours of report
- Resolution: 7 working days
- If unresolved within 7 working days, a shadow (provisional) credit for the duplicate amount must be posted to the customer's account per RBI customer-protection guidelines.

## Escalation Conditions

- Duplicate amount exceeds ₹50,000 → route to Senior Dispute Analyst for review before merchant outreach.
- Merchant does not respond within 5 working days → initiate chargeback under POL-006 (reason: duplicate processing).
- Three or more duplicate incidents at the same merchant within 90 days → flag merchant to Risk Operations for merchant review.

## Resolution Procedure

1. Verify both transactions are settled and match on merchant, amount, and time window.
2. Rule out recurring billing and split-shipment patterns.
3. Confirm with the customer which transaction is legitimate.
4. Raise a duplicate-processing request with the acquiring merchant.
5. If the merchant confirms or fails to respond in 5 working days, reverse the duplicate amount (merchant credit or chargeback).
6. Post shadow credit if the 7-working-day SLA is breached.
7. Notify the customer of the reversal and close the case with disposition "Duplicate Reversed".

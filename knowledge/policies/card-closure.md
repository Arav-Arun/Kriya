# Policy: Card Closure

- Policy ID: POL-010
- Version: 1.7 | Effective: 01-Apr-2026
- Owner: Card Operations

## Description

Governs voluntary credit card closure requested by the customer. Per RBI card directions, a closure request must be honoured within 7 working days, subject to payment of all dues; failure attracts a penalty of ₹500 per day of delay payable to the customer. Retention offers may be made once but must not delay processing.

## Eligibility Rules

1. Total outstanding must be zero, including unbilled transactions and any pending EMI principal. Active EMIs must be foreclosed (foreclosure charges per POL-004 apply) before closure.
2. Reward points must be redeemed before closure; customers are given a one-time 30-day redemption window from the closure request date, after which unredeemed points lapse.
3. A credit balance on the account, if any, is refunded to the customer's registered bank account before closure.
4. Closure requests are accepted via app, internet banking, email from registered ID, or phone with full verification; a written letter is not mandatory.
5. Annual/renewal fee charged within the last 30 days is reversed pro-rata if the card was unused in the period.

## Required Documents

- None beyond identity verification on a registered channel; OTP confirmation records the closure consent.

## Assigned Team

Card Operations

## SLA

- Closure processing: within 7 working days of request (RBI mandate)
- Closure confirmation to customer: immediate on completion, via email and SMS
- Credit bureau update ("closed at customer request"): within 30-45 days

## Escalation Conditions

- Closure requested while a dispute/chargeback is open → place closure on documented hold; coordinate with Disputes Operations; inform the customer of the hold reason.
- Outstanding dues prevent closure and the customer contests the amount → statement reconciliation by a supervisor before any collections action.
- Processing exceeds 7 working days → auto-escalate to Card Operations Manager; compute and credit the ₹500/day penalty without requiring the customer to ask.

## Resolution Procedure

1. Verify identity and capture closure consent with reason code (for attrition analytics).
2. Check outstanding (billed + unbilled), active EMIs, and reward point balance; guide the customer through settlement and redemption.
3. Offer retention alternatives once, if applicable; proceed immediately if declined.
4. Block the card for fresh usage upon request acceptance; cancel standing instructions and tokens, and advise the customer to migrate recurring payments.
5. On zero balance, close the account, refund any credit balance, and issue a closure confirmation with a no-objection statement.
6. Update the credit bureau and archive the account per retention policy.

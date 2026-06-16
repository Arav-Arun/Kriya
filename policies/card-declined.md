# Policy: Card Declined

- Policy ID: POL-003
- Version: 1.8 | Effective: 01-Apr-2026
- Owner: Card Operations

## Description

Covers customer complaints where a transaction was declined at POS, e-commerce checkout, or recurring billing. Declines originate from issuer-side controls (credit limit, card status, usage flags, incorrect PIN), network rules, or merchant/acquirer issues. The goal is to identify the decline reason from authorization logs and either remediate or clearly explain it.

## Eligibility Rules

1. Any cardholder with an issued card may raise a decline complaint; the card need not be active (the status itself may be the cause).
2. Authorization logs are retained for 180 days; declines older than that cannot be investigated.
3. Declines caused by merchant/acquirer outages are logged but closed as "external"; no issuer remediation possible.

## Required Documents

- None mandatory. Merchant name, approximate date/time, and channel (POS/online/international) speed up log retrieval.

## Assigned Team

Card Operations

## SLA

- First response: within 4 business hours
- Resolution or root-cause explanation: within 1 working day

## Escalation Conditions

- Decline persists after remediation (e.g., limit available, card active, flags correct) → Card Operations technical desk.
- Decline reason is SUSPECTED_FRAUD_BLOCK → transfer to Fraud Operations; do not unblock without fraud clearance.
- Decline caused by insufficient limit with customer requesting an increase → route to Risk Operations under POL-009.
- More than 3 incorrect-PIN declines → card auto-locks; identity re-verification required before unlock.

## Resolution Procedure

1. Pull the authorization log entry and read the decline response code.
2. Map the code to a category: card status (blocked/frozen/expired), insufficient credit limit, incorrect PIN, international usage disabled, suspected fraud block, or merchant/network error.
3. Remediate where possible: unblock after verification, advise on limit, reset PIN counter, enable usage flags with customer consent.
4. If fraud-related, hand off to Fraud Operations with the log extract.
5. Confirm with the customer that a retry succeeds (or explain why the decline is expected behaviour).
6. Close with the decline category recorded for trend reporting.

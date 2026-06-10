# Policy: Fraud Transactions

- Policy ID: POL-002
- Version: 3.1 | Effective: 01-Apr-2026
- Owner: Fraud Operations

## Description

A fraud transaction is any transaction not authorized by the cardholder — including card-not-present (CNP) online fraud, skimming/cloning at POS or ATM, phishing/vishing-induced OTP compromise, and account takeover. Fraud cases require immediate containment (card block) before investigation begins.

## Eligibility Rules

1. Customer liability follows RBI limited-liability guidelines:
   - Reported within 3 working days of the transaction: zero customer liability.
   - Reported within 4–7 working days: customer liability capped at ₹10,000 or the transaction amount, whichever is lower.
   - Reported after 7 working days: liability per the bank's board-approved policy.
2. The card must be blocked immediately upon report; investigation cannot proceed on an active compromised card.
3. Transactions where the customer admits to sharing OTP/PIN are classified "customer-induced" and assessed separately, but the card is still blocked and re-issued.

## Required Documents

- Customer Dispute Form (CDF) signed physically or via OTP-authenticated digital consent
- FIR or police acknowledgement (e-FIR accepted) mandatory for disputed amounts above ₹1,00,000
- Identity proof (PAN or Aadhaar last-4 verification)

## Assigned Team

Fraud Operations

## SLA

- Card block: immediate, within 30 minutes of report
- Acknowledgement and case registration: within 24 hours
- Shadow (provisional) credit: within 10 working days of report
- Final resolution: within 90 days per RBI mandate

## Escalation Conditions

- Total disputed amount exceeds ₹1,00,000 → Fraud Operations Lead plus law-enforcement liaison.
- Card-present fraud with a skimming pattern (multiple cards, same terminal) → raise Common Point of Purchase (CPP) alert to the card network.
- Second confirmed fraud on the same customer within 6 months → refer to Risk Operations for account risk re-rating.
- Suspected internal/merchant collusion → Compliance and Vigilance.

## Resolution Procedure

1. Block the card immediately and confirm block to the customer.
2. Register the fraud case and capture all disputed transaction IDs.
3. Verify device, IP, geolocation, and 3-D Secure / OTP logs for each disputed transaction.
4. Classify the fraud vector (CNP, skimming, social engineering, account takeover).
5. Apply the RBI limited-liability matrix based on report timing.
6. Post shadow credit within 10 working days; raise network chargebacks with fraud reason codes where applicable.
7. Re-issue the card with a new number; reset all digital tokens.
8. Close with disposition "Fraud Confirmed — Customer Refunded", "Customer-Induced", or "Fraud Not Established", with written rationale.

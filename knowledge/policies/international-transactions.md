# Policy: International Transactions

- Policy ID: POL-011
- Version: 2.2 | Effective: 01-Apr-2026
- Owner: Card Operations

## Description

Covers enablement and control of international card usage, forex markup billing, dynamic currency conversion (DCC) issues, and complaints about international transactions. Per RBI directions, international usage is disabled by default at issuance and must be explicitly enabled by the customer, with independent limits for POS, e-commerce, and contactless channels.

## Eligibility Rules

1. International usage can be enabled only by the primary cardholder via app, internet banking, or verified phone request; enablement is channel-specific and limit-specific.
2. Forex markup of 3.5% plus GST applies on the converted INR amount for non-INR transactions.
3. DCC (paying in INR at a foreign merchant) is the merchant's conversion; markup disputes on DCC transactions are explained, not refunded, unless the customer was not offered a currency choice.
4. International spends are reportable under LRS; TCS at the prevailing rate applies on aggregate international spends above the annual threshold (₹7,00,000), collected through the card statement.
5. Transactions in foreign currency with Indian merchants (e.g., onward billing) are treated as international for markup purposes — disputes on this are eligible for review.

## Required Documents

- None for enablement/disablement (authenticated channel action is the record)
- For markup/DCC disputes: the transaction receipt showing currency and any DCC election

## Assigned Team

Card Operations

## SLA

- Enable/disable international usage: real-time to a maximum of 4 hours
- Markup or TCS billing query resolution: within 7 working days

## Escalation Conditions

- Customer does not recognize an international transaction → treat as suspected fraud; block per POL-002 and transfer to Fraud Operations immediately.
- TCS computation disputes above ₹50,000 → Compliance/tax desk review.
- Repeated declines abroad despite correct flags and limits → Card Operations technical desk with network log review.

## Resolution Procedure

1. Confirm the international usage flags, channel limits, and card network region settings.
2. For enablement requests, capture authenticated consent and set channel-wise limits.
3. For billing complaints, reconstruct the charge: transaction currency, network conversion rate, markup, GST, and any TCS line.
4. Explain DCC vs network conversion where applicable; refund markup only for documented billing errors.
5. For unrecognized transactions, hotlist and hand off to Fraud Operations without delay.
6. Close with the billing breakdown shared with the customer.

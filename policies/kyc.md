# Policy: KYC

- Policy ID: POL-008
- Version: 2.4 | Effective: 01-Apr-2026
- Owner: Risk Operations

## Description

Covers Know Your Customer compliance for credit card accounts: periodic re-KYC, pending/expired KYC remediation, identity document updates, and account freezes arising from KYC lapses. Aligned with RBI Master Direction on KYC and CKYC registry requirements.

## Eligibility Rules

1. Periodic re-KYC cycle is risk-based: high-risk customers every 2 years, medium-risk every 8 years, low-risk every 10 years.
2. Customers receive three notices (60, 30, and 7 days) before KYC expiry; on expiry without compliance, the card is frozen (temporary block) until re-KYC completes.
3. PAN is mandatory for all credit card accounts. One Officially Valid Document (OVD) is required for identity/address: Aadhaar, passport, driving licence, or voter ID.
4. Video-KYC (V-CIP) is accepted as a full-service channel; in-branch and assisted-visit options remain available.
5. Name/address changes take effect only after document verification; minor mismatches (initials, abbreviations) may be self-certified.

## Required Documents

- PAN (mandatory)
- One OVD: Aadhaar (offline XML / masked), passport, driving licence, or voter ID
- Recent photograph (captured live during V-CIP)

## Assigned Team

Risk Operations

## SLA

- Document verification: within 2 working days of submission
- Card unfreeze after successful verification: within 1 working day
- CKYC registry update: within 7 working days

## Escalation Conditions

- Document mismatch or suspected forgery → Risk Operations Lead plus a fraud screening check.
- Customer matches a PEP (politically exposed person) or sanctions list → Compliance for enhanced due diligence; card remains frozen pending clearance.
- Repeated V-CIP failures (3 attempts) → assisted in-person verification mandated.

## Resolution Procedure

1. Identify the KYC status driving the complaint (expired, pending verification, frozen account, data update).
2. Share the applicable document checklist and channels (app upload, V-CIP, branch).
3. Verify submitted documents against the application record and CKYC registry.
4. On success: update records, lift the freeze within 1 working day, and confirm to the customer.
5. On failure: state the specific deficiency and allow resubmission; escalate per conditions above where applicable.
6. Close with KYC status, verification date, and next re-KYC due date recorded.

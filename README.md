# Kriya

Kriya is an autonomous, customer-facing CardOps copilot for Indian credit card programs. It lets cardholders manage their accounts, resolve disputes, and configure cards in plain language (or via voice and attachments), while running strict policy gates and updating the bank system-of-record.

---

## Core Capabilities

1. **Hyperface System-of-Record Integration**: Resolves cardholder sessions live via `/customers/lookup` and queries balances, limits, and card states in real-time.
2. **Deterministic Policy Gating**: Eligibility check decisions (late-fee waivers, credit limit enhancements, duplicate-charge refunds, EMI conversions) are computed via strict rules in `src/services/policy-gates.ts` instead of relying on LLM vibes.
3. **RBI-Compliant Mandate & Dispute Lifecycles**: Fully models RBI e-mandate guidelines (cancellations, limits, pre-debit notifications) and structured dispute tracking.
4. **Bilingual Voice Copilot**: Streams speech-to-text and text-to-speech feedback in English, Hindi, and Hinglish via Sarvam AI.
5. **Cross-Channel Consistency**: Syncs customer context across Web Chat and Telegram (`t.me/kriya_copilot_bot`) channels.
6. **Strict-Live Honesty**: Customer account data is sourced only from the Hyperface system of record. When a feed is pending bank-side enablement (403) or otherwise unavailable, the affected figures are reported as an explicit "unavailable" with the reason — never substituting local records or placeholder values as the customer's real data.

---

## Agent Architecture

Each user interaction triggers a durable Flue workflow orchestrating specialized agents:

```
[Customer Msg] ──▶  Triage Agent  ──▶ (Investigation Agent ∥ Policy Agent) ──▶ Resolution Agent ──▶ [Card Mutation / Reply]
```

* **Triage**: Classifies category, urgency, and routing.
* **Investigation**: Performs read-only forensics against live databases and APIs.
* **Policy**: Searches the policies database to extract rules and SLAs.
* **Resolution**: Performs identity checks (OTP, card last-4) and executes card updates directly.

---

## Project Structure

```
src/
├── app.ts                        # Hono HTTP server (API, Telegram webhooks, and pages)
├── agents/                       # Specialized AI agents (Triage, Investigation, Policy, Resolution)
├── database/                     # Supabase database queries and client
├── providers/                    # Hyperface UAT API integration client
├── services/                     # Business logic (Policy gates, e-mandates, voice, attachments, verification)
└── workflows/                    # Durable Flue workflow orchestrators
```

---

## Getting Started

### Prerequisites
* Node.js ≥ 22.18
* Supabase credentials
* OpenAI API Key & Sarvam API Key (for Voice)

### Run Locally
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure `.env`:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-supabase-key
   OPENAI_API_KEY=your-openai-key
   SARVAM_API_KEY=your-sarvam-key
   KRIYA_PROVIDER_MODE=hyperface_uat
   HYPERFACE_SECRET_KEY=your-hyperface-secret
   ```
3. Start the dev server:
   ```bash
   npm run dev
   ```

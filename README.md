# Kriya

Kriya is an autonomous, customer-facing CardOps copilot for Indian credit card programs. It lets cardholders manage their accounts, resolve disputes, and configure cards in plain language (or via voice and attachments), while running strict policy gates and updating the bank system-of-record.

---

## Core Capabilities

1. **Live System-of-Record Account Access**: Resolves cardholders by their registered mobile number (`/customers/lookup`) and reads balances, credit/cash limits, card status, transactions, statements, unbilled spend, EMIs, benefits, and KYC straight from the Hyperface Credit Stack in real time.
2. **End-to-End Card Actions**: Blocks/locks, unblocks, hotlists and replaces cards; toggles usage controls (online, POS, contactless, ATM, international); converts purchases or outstanding to EMI and forecloses; posts refunds/chargebacks; manages autopay; and cancels RBI e-mandates, executed against the system of record, each verification- and policy-gated and fully audited.
3. **Spend Intelligence & SVG Analytics**: Turns live transactions into a plain-language money summary (spend by category, top merchants, largest purchase, and current cycle unbilled balance) along with a dynamic inline SVG Donut Chart rendering the spending category distribution.
4. **Generative, Visual Answers**: In the web/app chat, Kriya renders clean frosted cards (balance & utilisation, spends breakdown with SVG chart, recent transactions, and tap-to-convert EMI plans) alongside its text reply. Every figure is live; no card is shown when the live read is unavailable.
5. **Deterministic Policy Gating**: Eligibility for late-fee waivers, credit-limit increases, duplicate-charge refunds, and EMI conversions is computed via strict rules in `services/policy-gates.ts` instead of relying on LLM vibes.
6. **Support Tickets Kanban Board**: A Jira/Pinterest-style board at `/tickets` (also linked in the navbar) that displays all customer escalations. Support operators can filter and search tickets, open a detail panel to inspect customer profiles, live balances, unbilled transactions, active disputes, and full AI audit logs, and enter resolution notes to mark tickets as resolved in the database.
7. **Multilingual Voice Mode with Live Waves**: Speak to Kriya in English, Hindi, Hinglish, Tamil, Marathi, Malayalam, Bengali, Telugu, Kannada, Gujarati, or Punjabi via Sarvam integration. Active recording is accompanied by a minimal jumping voice waves animation in the chat input.
8. **RBI-Compliant Mandate & Dispute Lifecycles**: Fully models RBI e-mandate guidelines (cancellations, AFA-free limits, pre-debit notifications) and structured dispute/chargeback tracking with provisional-credit and resolution SLAs.
9. **Every Channel, One Brain**: The same agent pipeline serves the web copilot, Telegram (`t.me/kriya_copilot_bot`), and multilingual voice, meaning identity, memory, policy gates, and the audit trail come free on every surface.
10. **Strict-Live Honesty**: Customer account data is sourced only from the Hyperface system of record.

---

## Agent Architecture

Each user interaction triggers a durable Flue workflow orchestrating specialized agents:

```
[Customer Msg] ──▶  Triage Agent  ──▶ (Investigation Agent ∥ Policy Agent) ──▶ Resolution Agent ──▶ [Card Mutation / Reply]
```

- **Triage**: Classifies category, urgency, and routing.
- **Investigation**: Performs read-only forensics against live databases and APIs.
- **Policy**: Searches the policies database to extract rules and SLAs.
- **Resolution**: Verifies identity (card last-4; there is no OTP step), runs the deterministic policy gates, renders visual answer cards, and executes card updates directly against the system of record.

---

## Project Structure

```
├── app.ts                        # Hono HTTP server (API, Telegram webhooks, and pages)
├── db.ts                         # Flue persistence database configuration
├── agents/                       # Specialized AI agents (Triage, Investigation, Policy, Resolution)
├── channels/                     # Chat channel adapters (Telegram, Hermes)
├── database/                     # Supabase database queries and client
├── providers/                    # Hyperface UAT API integration client
├── services/                     # Business logic (Policy gates, e-mandates, voice, attachments, verification)
└── workflows/                    # Durable Flue workflow orchestrators
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 22.18
- Supabase credentials
- OpenAI API Key & Sarvam API Key (for Voice)

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
   HYPERFACE_SECRET_KEY=your-hyperface-access-secret
   # Issuer master key - used ONLY for the issuer customer-details API
   HYPERFACE_ISSUER_SECRET_KEY=your-issuer-master-key
   ```
3. Start the dev server:
   ```bash
   npm run dev
   ```

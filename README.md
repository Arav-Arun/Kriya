# Sentinel

An agentic, customer-facing operations copilot for an Indian credit card. A cardholder describes a problem in plain language — or uploads a statement or receipt — and Sentinel investigates their account, applies deterministic policy, executes the card operation, and returns an audit-style resolution record. What it cannot safely resolve, it escalates with a clear reference.

Built on the [Flue framework](https://flueframework.com). One chat message is one Flue workflow.

> **The Promise:** *Customer describes a credit-card issue by text or image. Flue agents retrieve account data, apply deterministic policy, execute safe operations directly in the database, and return a structured resolution receipt.*

---

## Why Flue

Sentinel is not a wrapper prompt with a chat box. Each turn is a durable, observable Flue workflow that orchestrates specialized agents and streams its operations to the browser as they run:

```
customer message  ──▶  TRIAGE  ──▶  route?
                                     │
              ┌──────────────────────┴───────────── simple ──▶ RESOLUTION
              │ complex
              ▼   (run in parallel)
   INVESTIGATION  ∥  POLICY CHECK  ∥  PRECEDENT REVIEW
              └──────────────────────┬───────────────────┘
                                     ▼
                              RESOLUTION
                                     ▼
                        AUDIT / RESOLUTION RECORD
                      (every action written to actions_log)
```

### Agent Architecture

The pipeline enforces a strict **separation of concerns** — each agent has a single, well-defined role:

| Agent | Role | Tools | Boundary |
|-------|------|-------|----------|
| **Sentinel Triage** | Classifies the customer's message, picks route (`direct` vs `analysis`), sets urgency | None (pure classification) | Never answers the customer |
| **Sentinel Investigation** | Gathers raw account facts: profile, transactions, fees, EMIs, disputes, mandates | Read-only data tools | **Never makes eligibility decisions** — that's Resolution's job |
| **Sentinel Policy** | Looks up the governing policy document, SLA, and eligibility rules | `search_policy` only | Reports rules; does not compute verdicts |
| **Sentinel Precedent** | Finds how similar historical cases were resolved | `search_similar_cases` only | Cites only real case IDs from the database |
| **Sentinel Resolution** | Holds the persistent customer session. **Sole authority** to run deterministic policy gates and execute card operations | All policy checks + all action tools | Owns decision-making and action execution |

**Why Investigation doesn't have policy gate tools:** Policy gate checks require the action context that only the Resolution agent holds. If Investigation computed eligibility, the Resolution agent would inherit stale verdicts from a different execution context. By keeping Investigation as pure forensics and giving Resolution exclusive policy-gate authority, we ensure every decision is computed fresh against live data at the moment of action.

The three review agents run in `Promise.all`, so a complex case completes in one round of work rather than three. The chat UI shows each operation as a named row with live status — not a generic "thinking…" animation, but the actual pipeline executing.

## Operational truth lives in the database

Every figure the customer sees is read from the database — nothing is mocked in the front end. Business data (customers, transactions, payments, fees, statements, disputes, e-mandates, conversations, and the `actions_log` audit trail) lives in **Supabase Postgres**, accessed through `src/lib/sentinel-db.ts`. Flue's own run state persists to Postgres when `DATABASE_URL` is set, and falls back to local SQLite for development.

## Policy is deterministic, not vibes

Core eligibility decisions are never left to the model's prose. Before any sensitive action, the Resolution agent must call a deterministic check in `src/sentinel/policy.ts` that computes the verdict from account data and returns a structured result:

```typescript
{ eligible, reason_codes, facts_checked, missing_evidence, required_next_step, policy_reference }
```

### Policy Gates

| Gate | Key Rules |
|------|-----------|
| **Late-fee waiver** | Max 1 per 12 months, fee ≤ ₹1,000, ≥80% on-time, **CIBIL ≥650** (below signals chronic delinquency), account not closed |
| **Credit-limit increase** | Vintage ≥6 months, **CIBIL ≥730**, zero missed/late in 12 months, utilization 30-90% (>90% triggers affordability review), KYC current, auto-ceiling 150% of current, committee review above ₹10,00,000 |
| **Duplicate-charge refund** | Both settled, same merchant + amount ±₹1 within 24h, reported within 60 days, not a recurring subscription pattern, no open dispute |
| **EMI conversion** | Amount ≥₹2,500, SUCCESS status, within 30 days of transaction date, account current (no overdue), **CIBIL ≥650**, total EMI exposure ≤80% of credit limit, excluded categories (fuel, cash advances, wallet, gold) |
| **E-mandate cancellation** | Mandate must exist and be active (RBI opt-out right), 24h pre-debit notice applies |
| **Fraud liability timing** | RBI zero-liability ≤3 working days, capped ≤7 days, card must be blocked immediately, FIR required above ₹1,00,000, repeat fraud in 6 months triggers risk re-rating |

The agent only acts on `eligible: true`; otherwise it explains the reason codes or collects the missing evidence. The ledger maths (`src/lib/ledger.ts`) and the e-mandate model (`src/lib/emandates.ts`) are pure and unit-tested.

## Automated vs. escalated

- **Automated** when policy, account data, and authority allow it: waive a fee, refund a confirmed duplicate, block/unblock a card, set card controls, cancel an e-mandate, convert to EMI, redeem points, raise a dispute, increase a limit when eligible.
- **Confirm first** for irreversible actions: card closure, permanent hotlisting.
- **Escalated** when the AI genuinely cannot finish — fraud investigations, chargebacks, KYC. The card is blocked first if fraud is suspected, an escalation is created with the investigation already attached, and the customer is given a reference (e.g. `ESC-1002`) and a status.

## Indian credit-card rules modelled

- **RBI e-mandate framework (2026)** — recurring autopays are real mandates: AFA at setup, a 24-hour pre-debit notification, customer opt-out/cancel at any time, **no customer fee** for e-mandate usage, and AFA-free recurring limits of **₹15,000** generally / **₹1,00,000** for insurance, mutual funds, and credit-card-bill mandates. Cancellation issues a receipt and stops future debits without refunding past charges.
- **RBI dispute lifecycle** — under_review → provisional_credit (within 7 working days) → won/lost (30–45 days).
- **RBI limited-liability (fraud) timing** — zero liability when reported within 3 working days, capped liability (₹10,000 or transaction value) at 4–7 days, per-policy beyond that. FIR mandatory for disputes above ₹1,00,000.
- **18% GST** on all card fees; **forex markup** at 3.5%; **fuel surcharge waiver**.
- **CIBIL bands** — Excellent 750+, Good 700–749, Fair 650–699, Needs attention < 650. CIBIL is enforced in policy gates (730 for limit increase, 650 for EMI conversion and fee waivers).
- **UPI-on-RuPay**, MCC codes, and 12-digit RRNs on transactions.

---

## Product Surfaces

1. **Copilot Chat**: Describe an issue by text or image; it gets resolved in the conversation. Live pipeline visibility shows each stage (Triage → Investigation ∥ Policy ∥ Precedent → Resolution) as it executes.
2. **Account Page**: A minimal, table-first, factual dashboard showing live database data:
   - **Bill & Limit Summary**: Total Limit, Available Limit, Outstanding Total, and Utilization progress bar.
   - **Outstanding Details**: Outstanding Billed, Minimum Due, Due Date with countdown, CIBIL score, and KYC status.
   - **Card Controls**: Interactive toggles for Online, POS, Contactless, ATM, and International usage, and Autopay settings. All toggles write real changes to Supabase and trigger audit logs.
   - **Rewards Summary**: Accumulated points balance and its cash value as statement credit (₹0.25 per point).
   - **Recent Transactions & Fees**: Real-time list of settled transactions and charges with waivers flagged.
   - **Active Autopays**: RBI e-mandate list with inline cancellation buttons.
3. **Resolution Records**: Displays active disputes/chargebacks alongside a comprehensive **Audit Trail & Resolution Logs** (from `actions_log` database) showing all automated actions, waiver history, and card control adjustments.
4. **Escalation Tickets**: Dedicated view for escalated issues that required specialist review. Shows ticket reference, priority, assigned team, status (Open/Resolved), and resolution notes. Customers can ask the copilot about ticket status directly from this view.
5. **Case History**: Sidebar history of past conversations with rename/delete support. The Resolution agent's session persists across conversations, so it remembers prior context.
6. **Optional evidence upload**: Allows statements/receipts (PDF, image, CSV, TXT) to be uploaded and analyzed via OpenAI Vision/Completions and stored as context for the copilot.

---

## Demo Steps (Rohan Mehta)

To run a demo for fintech leadership:

1. **Login**: Open `http://localhost:3583/` and click on **Rohan Mehta** to sign in.
2. **Explore Account Tab**: Click **Account** in the header. Note Rohan's active limits, his Netflix e-mandate of ₹649/mo, and active card control switches.
3. **Toggle Card Controls**: Turn off **International Transactions** or **Online Transactions** using the switches. Notice the sidebar snapshot updates immediately. Click the **Resolution Records** tab to see the change audited in the "Audit Trail" list.
4. **Late-Fee Goodwill Waiver**: 
   - Switch to **Chat** and type: `"I paid 1 day late, please waive the fee."`
   - Observe the live stages: Triage → Investigation ∥ Policy Check ∥ Precedent Review → Resolution.
   - Sentinel evaluates Rohan's record (CIBIL 807, 100% on-time payments, no waiver in the last 12 months) and waives the fee.
   - Check the **Account** page: outstanding balance has decreased, available limit increased, and the late fee is marked as "Waived".
5. **Cancel Netflix Autopay**:
   - In chat, type: `"Show my active autopays, then cancel Netflix."`
   - Sentinel runs the e-mandate cancellation check, revokes future debits with zero customer fee, and prints the e-mandate cancellation receipt.
   - Check the **Account** tab: the Netflix e-mandate is marked as Cancelled.
6. **CIBIL-Gated Credit Limit Increase**:
   - In chat, type: `"Increase my card limit."`
   - Sentinel evaluates Rohan's CIBIL score (807), card vintage, utilization band, and zero missed payments, then adjusts the credit limit to 150% of current and logs the enhancement.
7. **Fraud Reporting & Handoff**:
   - In chat, type: `"I see an unauthorized charge of ₹5,000 on June 10."`
   - Sentinel immediately blocks the card, computes the RBI limited-liability band (zero liability since reported within 3 working days), and escalates to **Fraud Operations** generating a ticket reference.
   - Check the **Escalation Tickets** tab to see the ticket with priority and assigned team.

---

## Project Structure

```
src/
├── app.ts                        # Hono HTTP routes (API + pages)
├── db.ts                         # Flue persistence configuration
├── lib/
│   ├── sentinel-db.ts            # All Supabase data access (customers, txns, fees, disputes, escalations, actions_log)
│   ├── knowledge.ts              # Policy & playbook document loading + semantic search
│   ├── ledger.ts                 # Pure ledger math (fees, GST, interest, forex markup)
│   ├── emandates.ts              # E-mandate model (RBI framework helpers, cancellation receipts)
│   └── attachments.ts            # Upload storage, MIME handling, Vision/LLM analysis
├── sentinel/
│   ├── agents.ts                 # Agent definitions (5 agents, each with scoped tools)
│   ├── prompts.ts                # System prompts enforcing separation of concerns
│   ├── schemas.ts                # Valibot schemas for structured agent outputs
│   ├── tools.ts                  # 25+ tool definitions (read-only + action tools)
│   └── policy.ts                 # Deterministic policy gates (6 checks, CIBIL-enforced)
└── workflows/
    └── chat-turn.ts              # Flue workflow: Triage → Parallel fan-out → Resolution

ui/                               # Static front-end (vanilla HTML/CSS/JS)
├── chat.html                     # Main app shell
├── chat.js                       # UI logic (tab rendering, chat, real-time pipeline stages)
├── app.css                       # Design system
├── start.html                    # Login / customer selection
├── dashboard.html                # Operations dashboard
└── knowledge.html                # Policy knowledge base viewer

knowledge/                        # Source-of-truth policy documents
├── policies/                     # 10 policy docs (POL-001 through POL-011)
├── playbooks/                    # Resolution playbooks
└── cases/                        # Historical case records for precedent matching

data/                             # Seed scripts and data
scripts/                          # Database seeding utilities
```

---

## Known Demo Limitations

These are documented limitations for the demo workspace:
1. **Real Payment Gateways**: Payment simulation is executed via direct PostgreSQL mutations rather than actual integrations (e.g. Razorpay/BillDesk).
2. **Vision Model Requirements**: Attachment analysis requires a vision-capable LLM. If the key is missing or fails, it falls back to a descriptive text note.
3. **Local Run-State Fallback**: Flue workflow runs use PostgreSQL when `DATABASE_URL` is set, falling back to local SQLite if unset.

---

## Setup & Deployment

### Prerequisites
- Node.js ≥ 22.18
- Supabase credentials + an OpenAI API Key

### Installation

```bash
npm install
npm run data:seed   # Seed database tables in Supabase
npm start           # Build and serve at http://localhost:3583
npm run typecheck   # Run TypeScript checks
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://...     # Optional: Flue run-state persistence
SENTINEL_MODEL=openai/gpt-5.5    # Optional: override the LLM model
```

# Kriya: Autonomous Credit-Card Copilot

Kriya is an autonomous, customer-facing CardOps copilot for modern Indian credit card programs. Built on a durable agentic workflow engine, Kriya enables cardholders to check live accounts, lock or replace cards, convert purchases to EMI, redeem rewards, and resolve refund/chargeback and fraud cases in plain language (or via voice) while enforcing strict regulatory policy gates.

---

## Core Capabilities

Kriya acts as a plain-language translator and execution layer for the [Hyperface Credit Stack](https://hyperface.stoplight.io/docs/credit-stack-apis/).

### 1. Accounts & Balances
* **Live Account Summary**: Fetches current ledger balance, available credit, cash limits, and overall card utilization in real time.
* **Account Records**: Reads product variant metadata, billing cycles, status, and key cardholder dates.

### 2. Card Management & Security
* **Emergency Operations**: Executes a card lock (reversible freeze) or permanent hotlisting (irreversible disable) on the live card during fraud events.
* **Replacement Routing**: Places a card replacement order (e.g., damaged or stolen cards) in the card system of record.

### 3. Transactions & Statements
* **Dynamic Ledgers**: Queries billed and unbilled transactions over any custom date window.
* **Statement Access**: Reads statement histories, billing totals, and minimum dues, and retrieves a specific statement's document by id.
* **Transaction Inquiries**: Inspects specific transaction details by reference ID to answer cardholder queries.

### 4. EMI & Pay Later
* **Tenure Eligibility**: Checks tenure options, interest rates, and monthly installment options for eligible purchases.
* **EMI Conversions**: Converts outstanding billing amounts or specific transactions into equated monthly installments.
* **Early Settle & Foreclose**: Computes foreclosure fees and executes EMI foreclosures against the ledger.

### 5. Rewards & Cashback
* **Live Points Balance**: Tracks earned, pending, redeemed, and expiring points.
* **Ledger History**: Inspects point postings associated with specific purchases.
* **Instant Redemption**: Redeems available reward points directly against the current card balance.
* **Cashback Activity**: Reads transaction-level cashback earned and reversed from the card system.

### 6. Refunds, Fraud & Escalations
* **Refunds & Chargebacks**: Posts refund or chargeback credits to the account in the card system of record (Hyperface has no separate dispute object — reversals are credit postings), behind a deterministic duplicate-charge gate.
* **Fraud Liability Assessment**: Deterministic RBI limited-liability band check (zero / limited / per-policy from the working days to report), then routes the case to Fraud Operations.
* **Kanban Operator Dashboard**: A web dashboard at `/tickets` letting operations teams review customer escalation histories, the account snapshot on file, audit trails, and log notes.

---

## Agent Architecture

Kriya coordinates user requests using a durable **Flue Workflow** that routes requests through specialized, cooperating agents:

```mermaid
graph TD
    classDef default fill:#fffdf9,stroke:#e8e0d0,stroke-width:2px,color:#1e2033;
    classDef highlight fill:#e9ebfc,stroke:#4250d5,stroke-width:2px,color:#1e2033;
    classDef saffron fill:#fdeede,stroke:#f9730c,stroke-width:2px,color:#1e2033;
    classDef green fill:#e3f1d8,stroke:#496d21,stroke-width:2px,color:#1e2033;
    
    User([User Message]) --> VerifyCheck{Verification Reply<br>or Pending EMI?}:::saffron
    
    VerifyCheck -->|Yes: Direct Bypass| Resolution[Resolution Agent]:::highlight
    VerifyCheck -->|No| Triage[Triage Agent]:::highlight
    
    Triage --> RouteCheck{Triage Route?}:::saffron
    
    RouteCheck -->|analysis| Parallel[Parallel Analysis]:::highlight
    Parallel --> Investigation[Investigation Agent]
    Parallel --> Policy[Policy Agent]
    
    Investigation --> Resolution
    Policy --> Resolution
    
    RouteCheck -->|direct| Resolution
    
    Resolution --> Tools{Deterministic<br>Policy Gates}:::saffron
    
    Tools -->|Pass| Ledger[Execute Hyperface UAT API]:::green
    Tools -->|Fail / Exception| DB[(Supabase DB / Support Tickets)]
    
    Ledger --> DB
    DB --> Reply([Reply & Visual Cards])
```

### Specialized Agents:
1. **Triage Agent**: Classifies intent into a category, detects urgency, and routes the turn `direct` vs `analysis`.
2. **Investigation Agent**: Conducts read-only queries against the database and card ledger APIs to build context.
3. **Policy Agent**: Searches the local Markdown policy corpus and returns advisory eligibility guidance, SLAs, and key rules. The binding deterministic checks live in the policy gates, not here.
4. **Resolution Agent**: Enforces identity checks, runs the deterministic policy gates, compiles visual cards, and triggers ledger modifications.

---

## Architecture & Workflow Diagrams

### Complete architecture

Seven layers: clients and channels reach the Hono HTTP server, which routes through Hermes and the Flue workflow runtime to four LLM agents (each calling OpenAI) and a set of deterministic tools, all backed by Supabase, the Flue database, and external services.

```mermaid
flowchart TB
    subgraph Clients["Clients and channels"]
        Web[Web chat]
        TG[Telegram]
        Voice[Voice]
        Ops[Operator board]
    end
    App["app.ts — Hono server<br/>pages · REST · voice · webhook · flue() mount"]
    Hermes["Hermes<br/>phone-keyed identity router"]
    Flue["Flue runtime — chat-turn<br/>durable orchestration + SSE"]
    subgraph Agents["Agents — LLM-driven"]
        Triage
        Investigation
        Policy
        Resolution
    end
    OpenAI["OpenAI<br/>gpt-4o-mini"]
    subgraph Tools["Tools and deterministic logic"]
        Tlocal[tools.ts]
        Tlive[provider-tools.ts]
        Tgate[policy-gates.ts]
        Tverify[verify.ts]
        Tknow[knowledge.ts]
    end
    subgraph Data["Data stores and external"]
        SB[(Supabase<br/>app + audit)]
        FDB[(Flue DB)]
        HF[Hyperface]
        Sarvam[Sarvam STT/TTS]
        TGAPI[Telegram API]
    end
    Web --> App
    TG --> App
    Voice --> App
    Ops --> App
    App -->|webhook / identify| Hermes
    App -->|web| Flue
    Hermes --> Flue
    Flue --> Agents
    Agents <-->|structured · streaming · tools| OpenAI
    Agents --> Tools
    Tlocal --> SB
    Tlive --> HF
    Tgate --> SB
    Tverify --> SB
    Flue --> FDB
    App --> Sarvam
    App --> TGAPI
```

### Full agentic workflow (one chat turn)

A turn enters the Flue `chat-turn` workflow, is routed by Triage, optionally fans out to parallel Investigation and Policy agents, then reaches Resolution, whose tool-calling loop reads data, verifies identity, runs a deterministic gate, executes a local or live action with an audit log, and streams the final reply. Any exception creates an escalation.

```mermaid
flowchart TB
    Start["Flue chat-turn — turn starts<br/>load customer · persist message · load context"]
    D1{"Verification or<br/>pending follow-up?"}
    Triage["Triage agent — OpenAI<br/>route · category · urgency"]
    D2{"Route = analysis?"}
    Inv["Investigation — OpenAI<br/>read tools: Supabase / Hyperface"]
    Pol["Policy — OpenAI<br/>search policies/*.md"]
    Res["Resolution agent — OpenAI<br/>streaming · question + findings"]
    subgraph Loop["Resolution tool-calling loop"]
        Read["Read tools<br/>get_* / live_*"]
        D3{"Sensitive action?"}
        Verify["verify — card last-4<br/>valid 30 min"]
        Gate["policy gate — check_*_eligibility<br/>deterministic"]
        Act["execute action — local / live<br/>+ write actions_log"]
    end
    Stream["Stream final reply + UI cards"]
    Final["Collect actions · derive status · persist + emit"]
    Chan["Final result — channel<br/>web: text + cards · Telegram: text"]
    Fail["On exception — escalation + safe apology"]
    Start --> D1
    D1 -->|no| Triage
    D1 -->|yes, skip| Res
    Triage --> D2
    D2 -->|direct| Res
    D2 -->|analysis| Inv
    D2 -->|analysis| Pol
    Inv --> Res
    Pol --> Res
    Res --> Read
    Read --> D3
    D3 -->|no| Stream
    D3 -->|yes| Verify
    Verify --> Gate
    Gate --> Act
    Act --> Stream
    Stream --> Final
    Final --> Chan
    Start -.->|exception| Fail
```

> Standalone SVG copies of both diagrams render in `diagrams/` (kept local — see `.gitignore`).

---

## Project Directory Structure

```
├── app.ts                        # Hono HTTP Server: handles routing, webhooks, and REST APIs
├── db.ts                         # Local Flue database persistence settings
├── agents/                       # Specialized AI agent definitions
│   ├── triage.ts                 # Intent classifier & router
│   ├── investigation.ts          # Read-only ledger research agent
│   ├── policy.ts                 # Policy extraction agent
│   └── resolution.ts             # Enforcement and mutation agent
├── channels/                     # Third-party chat channel adapters
│   ├── telegram.ts               # Telegram webhook verification and message handler
│   └── hermes.ts                 # Inbound routing and identity matching engine
├── core/                         # Core platform logic
│   ├── queries.ts                # Main database access layers (Supabase)
│   ├── env.ts                    # Hosted guardrails and configuration
│   └── supabase.ts               # Supabase client credentials wrapper
├── providers/                    # Core banking / credit ledger integrations
│   └── hyperface.ts              # UAT endpoint bindings for the Hyperface Credit Stack
├── services/                     # Business services
│   ├── policy-gates.ts           # Deterministic gates: late-fee waiver, duplicate refund, EMI conversion, fraud liability
│   ├── verify.ts                 # Identity checking logic
│   └── voice.ts                  # Voice mode: Sarvam STT & TTS translation
├── ui/                           # Frontend HTML, CSS, and Client JS
│   ├── start.html / start.css    # Landing page
│   ├── chat.html / chat.js       # Live chat client with voice wave animations
│   └── tickets.html / tickets.js # Kanban board for customer service agents
└── workflows/                    # Orchestrations
    └── chat-turn.ts              # Stateful conversation loop
```

---

## Getting Started

### Prerequisites
* **Node.js** ≥ 22.18
* **Supabase** instance configured for Kriya schemas
* **OpenAI API Key** (for general agent reasoning)
* **Sarvam API Key** (required for Multilingual Voice Mode)

### Installation
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file from the template:
   ```bash
   cp .env.example .env
   ```

3. Populate `.env` with your credentials:
   ```env
   PORT=3583
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-key
   OPENAI_API_KEY=your-openai-api-key
   SENTINEL_MODEL=openai/gpt-4o-mini
   SARVAM_API_KEY=your-sarvam-voice-api-key
   KRIYA_PROVIDER_MODE=hyperface_uat
   HYPERFACE_TENANT_ID=your-hyperface-tenant-id
   HYPERFACE_ACCESS_KEY=your-hyperface-access-key
   HYPERFACE_SECRET_KEY=your-hyperface-access-secret
   HYPERFACE_ISSUER_SECRET_KEY=your-issuer-master-key
   HYPERFACE_PROGRAM_ID=your-hyperface-program-id
   # Set to false to keep all live card mutations gated (reads still work)
   HYPERFACE_ALLOW_MUTATIONS=true
   ```
   > See `.env.example` for the full set of variables, including `DATABASE_URL`/`KRIYA_DEPLOYED` for hosted deployments and the Telegram webhook keys.

### Execution
* **Development Server (Hot reloading)**:
  ```bash
  npm run dev
  ```
* **Production Build**:
  ```bash
  npm run build
  ```
* **Production Run**:
  ```bash
  npm run start
  ```

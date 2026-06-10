# Sentinel

**An AI-powered support copilot for credit card operations** built with the Flue multi-agent framework.

A support employee types a customer complaint in plain English. Sentinel's specialized AI agents analyze the issue in a read-only workflow — classifying it, pulling customer data, checking bank policies, finding past precedents, and routing it to the right team. After human review and approval, a second workflow runs the Ticket Agent to generate and store a structured, ready-to-act support ticket.

---

## How It Works

Sentinel orchestrates **8 specialized agents** across two workflows. The first analyzes and routes; the second writes.

```
                        ┌─────────────────────┐
                        │   Customer Complaint│
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │    Triage Agent     │  ← classify, extract entities
                        └──────────┬──────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │  customer found    │                     │  no ID / not found
    ┌─────────▼──────────┐         │       ┌────────────▼────────────┐
    │ Investigation Agent│         │       │  Investigation Bypass   │
    │  (pull txns, find  │         │       │  (skip — no data to     │
    │   evidence)        │         │       │   investigate)          │
    └─────────┬──────────┘         │       └────────────┬────────────┘
              └────────────────────┼────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │         in parallel         │
          ┌─────────▼─────────┐        ┌──────────▼──────────┐
          │   Policy Agent    │        │ Similar Cases Agent │
          │ (find policy, SLA,│        │ (search 100 resolved│
          │  eligibility)     │        │ cases for precedent)│
          └─────────┬─────────┘        └──────────┬──────────┘
                    └──────────────┬──────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │ escalation required    │ needs more info        │  standard
 ┌────────▼─────────┐   ┌──────────▼──────────┐             │
 │ Escalation Review│   │ Missing Information │             │
 │ (approver, reason│   │ (list missing docs, │             │
 │  impact)         │   │  draft request)     │             │
 └────────┬─────────┘   └──────────┬──────────┘             │
          └────────────────────────┼────────────────────────┘
                                   │
                        ┌──────────▼──────────┐
                        │   Routing Agent     │  ← assign team, set priority
                        └──────────┬──────────┘
                                   │
                   ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─  Workflow 1 ends
                                   │
                        ┌──────────▼──────────┐
                        │    Human Review     │  ← operator inspects results
                        └──────────┬──────────┘
                                   │  "Create Ticket"
                        ┌──────────▼──────────┐
                        │    Ticket Agent     │  ← compose & store ticket
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │   Stored Ticket     │
                        └─────────────────────┘
```

### Workflow 1 - Resolve Complaint (Read-Only Analysis)

Seven agents analyze and route the complaint. No data is written.

#### Stage 1: Classification

| Agent      | What it does                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Triage** | Classifies the complaint (Duplicate Charge, Fraud, Merchant Dispute, etc.), sets priority, and extracts entities — customer ID, merchant, amounts, dates. |

#### Stage 2: Evidence Gathering (conditional)

| Agent                    | What it does                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Investigation**        | Pulls the customer profile and recent transactions from the database. Identifies patterns — duplicate charges seconds apart, overnight fraud bursts, declined cards — and lists concrete evidence. |
| **Investigation Bypass** | Activates when no customer ID is provided or when the ID is not found in the database. The pipeline continues with complaint-text evidence only.                                                   |

#### Stage 3: Policy & Precedent (parallel)

| Agent             | What it does                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Policy**        | Searches internal policy documents to find the governing policy, checks eligibility against evidence, and extracts the SLA, required documents, and resolution steps. |
| **Similar Cases** | Searches 100 resolved historical cases for precedents with the same failure pattern. Reports what worked before and recommends a next action.                         |

#### Stage 4: Conditional Branch (mutually exclusive)

| Agent                   | Triggers when                           | What it does                                                                                       |
| ----------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Escalation Review**   | Policy flags `escalation_required`      | Identifies the required approver, escalation reason and action, and customer impact.               |
| **Missing Information** | Policy needs more info, customer is missing, or no matching transaction evidence is found | Lists missing documents (dispute form, receipt, etc.) and drafts a polite customer-facing request. |
| _(Standard — no agent)_ | Neither condition met                   | Pipeline proceeds directly to routing.                                                             |

#### Stage 5: Routing

| Agent       | What it does                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Routing** | Assigns the owning team (Disputes Ops, Fraud Ops, Card Ops, etc.) using team playbooks, confirms priority against the playbook matrix, and sets the escalation path. |

### Workflow 2 — Create Ticket (Controlled Write)

After the operator reviews the analysis and clicks **Create Ticket**:

| Agent      | What it does                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket** | Composes all findings — including branch context (escalation details or missing-document list) — into a structured support ticket and stores it in the database. |

The analysis pipeline is in [`src/workflows/resolve-complaint.ts`](src/workflows/resolve-complaint.ts), while the ticket creation pipeline is in [`src/workflows/create-ticket.ts`](src/workflows/create-ticket.ts). Each agent is defined in [`src/sentinel/agents.ts`](src/sentinel/agents.ts) with focused instructions and only the tools it needs.

---

## The UI
Three pages, all served from a lightweight Hono server:

- **Assistant** (`/`) - Enter a complaint, watch each agent execute in real time via SSE, then create the ticket.
- **Open Tickets** (`/tickets`) - Browse generated tickets with full evidence, policy references, and recommendations.
- **Knowledge Base** (`/knowledge`) - Explore the policies, team playbooks, and historical cases the agents consult.

---

## Data

Sentinel's dynamic business data is stored in a Supabase PostgreSQL database. The static resources (policies, playbooks) are loaded from local markdown files:

- **50 customers** with varying card statuses and risk scores (stored in Supabase)
- **500+ transactions** across 30 merchants (stored in Supabase)
- **100 resolved historical cases** for precedent matching (stored in Supabase)
- **12 internal policies** covering dispute resolution, fraud handling, chargebacks, EMI, rewards, etc. (local markdown)
- **5 team playbooks** with priority matrices and escalation rules (local markdown)

Note: This data is synthesised. A further improvement would be to use real API calls for data.

---

## Quick Start

**Prerequisites:** Node.js ≥ 22.18, an OpenAI API key, and a Supabase project.

1. **Configure Environment Variables**:
   Copy `.env.example` to `.env` and fill in your keys:

   ```bash
   cp .env.example .env
   ```

   Add your keys:
   - `OPENAI_API_KEY`: Your OpenAI API key.
   - `NEXT_PUBLIC_SUPABASE_URL`: Your Supabase Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase service role API key.

2. **Install & Start**:

   ```bash
   # Install dependencies
   npm install

   # Start the server
   npm start
   # → http://localhost:3583
   ```

Try this in the Assistant:

> Customer reports duplicate Amazon charge. Customer ID: 1234

For development with hot reload:

```bash
npm run dev
```

---

## Project Structure

```
src/
  sentinel/
    agents.ts          # Agent definitions with instructions & tools
    schemas.ts         # Valibot schemas for structured agent outputs
    tools.ts           # Database & knowledge tools the agents call
  workflows/
    resolve-complaint.ts   # Main pipeline: Triage → ... → Routing
    create-ticket.ts       # Ticket creation (triggered from UI)
  lib/
    sentinel-db.ts     # Business database (Supabase PostgreSQL wrapper)
    knowledge.ts       # Markdown policy & playbook loader + search
  app.ts               # Hono HTTP server (UI + API + Flue routes)
  db.ts                # Flue runtime persistence

ui/                    # Frontend (HTML + CSS + JS)
knowledge/             # Policies, playbooks, historical cases (Markdown + JSON)
```

---

## Configuration

| Variable                    | Default          | Description                                                                                                       |
| --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`            | —                | Required. Your OpenAI API key.                                                                                    |
| `NEXT_PUBLIC_SUPABASE_URL`  | —                | Required. Your Supabase project URL.                                                                              |
| `SUPABASE_SERVICE_ROLE_KEY` | —                | Required. Your Supabase service role key (bypasses RLS for backend tools).                                        |
| `SENTINEL_MODEL`            | `openai/gpt-5.5` | Model for all agents. Any [Pi model specifier](https://pi.dev/models) works (e.g. `anthropic/claude-sonnet-4-6`). |
| `PORT`                      | `3583`           | Server port.                                                                                                      |

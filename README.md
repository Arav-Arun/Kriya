# Sentinel

**An AI-powered support copilot for credit card operations** — built with the [Flue](https://flueframework.com) multi-agent framework.

A support employee types a customer complaint in plain English. Sentinel's six AI agents work together — classifying the issue, pulling customer data, checking bank policies, finding past precedents, and routing it to the right team — then generate a structured, ready-to-act support ticket. The entire pipeline runs in seconds.

---

## How It Works

Sentinel orchestrates **six specialised agents** in a pipeline. Each agent has a single job, its own tools, and produces a validated result that feeds the next stage:

```
Complaint → Triage → Investigation → Policy → Similar Cases → Routing → Ticket
```

| Agent | What it does |
|---|---|
| **Triage** | Reads the complaint and classifies it (Duplicate Charge, Fraud, Merchant Dispute, etc.), sets priority, and extracts entities like customer ID, merchant name, and amounts. |
| **Investigation** | Uses tools to pull the customer's profile and recent transactions from the database. Identifies suspicious patterns — duplicate charges seconds apart, overnight fraud bursts, declined cards — and lists concrete evidence. |
| **Policy** | Searches the bank's internal policy documents to find the governing policy, checks eligibility rules against the evidence, and extracts the SLA, required documents, and resolution steps. |
| **Similar Cases** | Searches 100 resolved historical cases to find precedents with the same failure pattern. Reports what resolution worked before and recommends a next action. |
| **Routing** | Determines the owning team (Disputes Ops, Fraud Ops, Card Ops, etc.) using the team playbooks, confirms priority against the playbook's matrix, and sets the escalation path. |
| **Ticket** | Composes all findings into a structured support ticket and stores it — ready for a human agent to pick up and act on. |

Each agent is defined in [`src/sentinel/agents.ts`](src/sentinel/agents.ts) with focused instructions and only the tools it needs. The pipeline is in [`src/workflows/resolve-complaint.ts`](src/workflows/resolve-complaint.ts).

---

## The UI

Three pages, all served from a lightweight Hono server:

- **Assistant** (`/`) — Enter a complaint, watch each agent execute in real time via SSE, then create the ticket.
- **Open Tickets** (`/tickets`) — Browse generated tickets with full evidence, policy references, and recommendations.
- **Knowledge Base** (`/knowledge`) — Explore the policies, team playbooks, and historical cases the agents consult.

---

## Data

Sentinel's dynamic business data is stored in a Supabase PostgreSQL database. The static resources (policies, playbooks) are loaded from local markdown files:

- **50 customers** with varying card statuses and risk scores (stored in Supabase)
- **500+ transactions** across 30 merchants (stored in Supabase)
- **100 resolved historical cases** for precedent matching (stored in Supabase)
- **12 internal policies** covering dispute resolution, fraud handling, chargebacks, EMI, rewards, etc. (local markdown)
- **5 team playbooks** with priority matrices and escalation rules (local markdown)

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

> **Note:** The dev watcher rebuilds on file changes, which can interrupt in-flight workflow runs. Use `npm start` when demoing.

---

## Project Structure

```
src/
  sentinel/
    agents.ts          # Six agent definitions with instructions & tools
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

ui/                    # Static frontend (HTML + CSS + JS)
knowledge/             # Policies, playbooks, historical cases (Markdown + JSON)
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Required. Your OpenAI API key. |
| `NEXT_PUBLIC_SUPABASE_URL` | — | Required. Your Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Required. Your Supabase service role key (bypasses RLS for backend tools). |
| `SENTINEL_MODEL` | `openai/gpt-5.5` | Model for all agents. Any [Pi model specifier](https://pi.dev/models) works (e.g. `anthropic/claude-sonnet-4-6`). |
| `PORT` | `3583` | Server port. |

---

## CLI Usage

```bash
# Run the pipeline headlessly
npx flue run resolve-complaint --target node \
  --payload '{"complaint":"Customer reports duplicate Amazon charge. Customer ID: 1234"}'
```

---

## Built With

- [Flue](https://flueframework.com) — Multi-agent orchestration framework
- [Hono](https://hono.dev) — Lightweight HTTP server
- [Valibot](https://valibot.dev) — Schema validation for structured agent outputs
- OpenAI GPT — Language model powering all six agents
- Supabase PostgreSQL — Secure cloud database backend

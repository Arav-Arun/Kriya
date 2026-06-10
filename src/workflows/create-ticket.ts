// Final pipeline stage (docs/04_WORKFLOWS.md step 6): the Ticket Agent turns
// the resolve-complaint analysis into a stored, structured support ticket.
// Invoked by the UI's "Create Ticket" button with the analysis payload.
import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import { ticketAgent } from '../sentinel/agents.ts';
import { TicketResult } from '../sentinel/schemas.ts';
import { getTicket, attachAnalysis } from '../lib/sentinel-db.ts';

interface Payload {
  complaint: string;
  analysis: unknown;
}

export async function run(ctx: FlueContext<Payload>) {
  const { complaint, analysis } = ctx.payload ?? ({} as Payload);
  if (!complaint || !analysis) {
    throw new Error('payload.complaint and payload.analysis (resolve-complaint result) are required');
  }

  ctx.log.info('stage', { stage: 'ticket', label: 'Ticket Agent', status: 'running' });

  const harness = await ctx.init(ticketAgent, { name: 'ticket' });
  const session = await harness.session();
  const res = await session.prompt(
    `Create the support ticket for this completed analysis.\n\nComplaint:\n${complaint}\n\nFull analysis:\n${JSON.stringify(analysis, null, 2)}`,
    { result: TicketResult },
  );

  const ticket = await getTicket(res.data.ticket_id);
  if (!ticket) {
    throw new Error(`Ticket Agent reported ${res.data.ticket_id}, but no such ticket exists in the store`);
  }
  // Preserve the full pipeline analysis on the ticket for the detail view.
  await attachAnalysis(res.data.ticket_id, analysis);

  ctx.log.info('stage', {
    stage: 'ticket', label: 'Ticket Agent', status: 'done',
    output: { ticket_id: res.data.ticket_id },
  });

  return { ticket: await getTicket(res.data.ticket_id) };
}

// Expose POST /workflows/create-ticket.
export const route: WorkflowRouteHandler = async (_c, next) => next();

// Sentinel HTTP application: serves the UI, the read-only business API
// (tickets + knowledge base), and mounts Flue's public routes
// (POST /workflows/:name, GET /runs/:runId event streams).
import { Hono } from 'hono';
import { flue } from '@flue/runtime/routing';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listTickets, getTicket, listCases, getCase } from './lib/sentinel-db.ts';
import { policies, playbooks } from './lib/knowledge.ts';

import { fileURLToPath } from 'node:url';

const app = new Hono();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, '../ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveFile(file: string) {
  const full = path.join(UI_DIR, file);
  if (!full.startsWith(UI_DIR)) return null;
  try {
    const body = readFileSync(full);
    const type = MIME[path.extname(full)] ?? 'application/octet-stream';
    return new Response(new Uint8Array(body), { headers: { 'content-type': type } });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- UI pages
app.get('/', (c) => serveFile('index.html') ?? c.notFound());
app.get('/tickets', (c) => serveFile('tickets.html') ?? c.notFound());
app.get('/knowledge', (c) => serveFile('knowledge.html') ?? c.notFound());
app.get('/assets/:file', (c) => serveFile(c.req.param('file')) ?? c.notFound());

// ---------------------------------------------------------------- business API
app.get('/api/tickets', async (c) => c.json(await listTickets()));

app.get('/api/tickets/:id', async (c) => {
  const ticket = await getTicket(c.req.param('id'));
  return ticket ? c.json(ticket) : c.json({ error: 'Not found' }, 404);
});

app.get('/api/knowledge', async (c) => c.json({
  policies: policies.map((p) => ({ slug: p.slug, title: p.title })),
  playbooks: playbooks.map((p) => ({ slug: p.slug, title: p.title })),
  cases: await listCases(),
}));

app.get('/api/knowledge/policies/:slug', (c) => {
  const doc = policies.find((p) => p.slug === c.req.param('slug'));
  return doc ? c.json(doc) : c.json({ error: 'Not found' }, 404);
});

app.get('/api/knowledge/playbooks/:slug', (c) => {
  const doc = playbooks.find((p) => p.slug === c.req.param('slug'));
  return doc ? c.json(doc) : c.json({ error: 'Not found' }, 404);
});

app.get('/api/knowledge/cases/:id', async (c) => {
  const row = await getCase(c.req.param('id'));
  return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
});

// ---------------------------------------------------------------- Flue routes
app.route('/', flue());

export default app;

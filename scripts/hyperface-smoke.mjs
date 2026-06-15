#!/usr/bin/env node
// Hyperface UAT smoke test: verifies credentials and maps which routes are
// reachable with the current headers. Read-only — uses bogus resource IDs, so
// nothing in shared UAT is touched or mutated.
//
//   node scripts/hyperface-smoke.mjs
//
// Interpreting results: a 2xx, 404-with-business-error, or field-validation
// 400 means we are THROUGH the gateway (auth ok). A 401 means bad apikey.
// A 403 "Forbidden resource" means the route needs x-tenant-id (or a key
// scope we don't have yet).

import { readFileSync } from 'node:fs';

function loadEnv(path = '.env') {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const BASE = env.HYPERFACE_BASE_URL || 'https://api-uat.hyperface.co';
const SECRET = env.HYPERFACE_SECRET_KEY;
const TENANT = env.HYPERFACE_TENANT_ID;
const PROGRAM = env.HYPERFACE_PROGRAM_ID;
// Real sample resources when available — otherwise bogus IDs (auth-only probing).
const ACC = env.HYPERFACE_TEST_ACCOUNT_ID || 'acc_smoke_bogus';
const CARD = env.HYPERFACE_TEST_CARD_ID || 'card_smoke_bogus';

if (!SECRET) {
  console.error('HYPERFACE_SECRET_KEY missing in .env');
  process.exit(1);
}

const headers = { apikey: SECRET, 'content-type': 'application/json' };
if (TENANT) headers['x-tenant-id'] = TENANT;

async function probe(name, path, opts = {}) {
  try {
    const res = await fetch(BASE + path, { ...opts, headers: { ...headers, ...opts.headers } });
    const text = (await res.text()).slice(0, 120);
    // Hyperface support resolves errors by this trace id — surface it so a 403
    // can be reported to them directly (see the x-correlation-id ask in Slack).
    const cid = res.headers.get('x-correlation-id');
    // Through the gateway = any response that names the resource/field, or 2xx.
    const through = res.status < 400
      || /Unable to find|Validation Error|Bad Request|apiName/i.test(text);
    const tag = res.ok ? 'PASS' : through ? 'THRU' : res.status === 401 ? 'AUTH' : 'BLOCKED';
    console.log(`${tag.padEnd(8)} ${String(res.status).padEnd(4)} ${name.padEnd(36)} ${text}${cid ? `  [x-correlation-id=${cid}]` : ''}`);
    return tag;
  } catch (err) {
    console.log(`ERROR    --   ${name.padEnd(36)} ${err.message}`);
    return 'ERROR';
  }
}

console.log(`Base URL: ${BASE}`);
console.log(`Tenant:   ${TENANT ? TENANT : '(not set — expect BLOCKED on tenant-gated routes)'}\n`);

const results = [];
// Auth sanity: no key at all must be rejected.
const noAuth = await fetch(BASE + '/customers/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log(`${(noAuth.status === 401 ? 'PASS' : 'WARN').padEnd(8)} ${String(noAuth.status).padEnd(4)} ${'no-apikey rejected'.padEnd(36)} (expect 401)`);

// Routes that work with apikey alone today.
results.push(await probe('POST /customers/lookup', '/customers/lookup', { method: 'POST', body: JSON.stringify({ mobileNumber: '9999999999' }) }));
results.push(await probe('GET  /accounts/{id}/summary', `/accounts/${ACC}/summary`));
results.push(await probe('POST /accounts/transactionInquiry', '/accounts/transactionInquiry', { method: 'POST', body: '{}' }));

// Tenant-gated routes (BLOCKED until HYPERFACE_TENANT_ID is set & valid).
results.push(await probe('GET  /cards/{id}', `/cards/${CARD}`));
results.push(await probe('POST /accounts/{id}/transactions', `/accounts/${ACC}/transactions`, { method: 'POST', body: '{}' }));
results.push(await probe('POST /accounts/{id}/statements', `/accounts/${ACC}/statements`, { method: 'POST', body: '{}' }));
results.push(await probe('POST /rewards/summary', '/rewards/summary', { method: 'POST', body: JSON.stringify({ accountId: ACC }) }));
results.push(await probe('GET  /accounts/{id}/emi', `/accounts/${ACC}/emi`));
results.push(await probe('POST /event/webhook/fetchSubscriptions', '/event/webhook/fetchSubscriptions', { method: 'POST', body: JSON.stringify({ programId: PROGRAM }) }));

// Provisional endpoints (UNVERIFIED paths — see note in src/providers/hyperface.ts).
// Kept out of the results tally so they don't skew the key-scope summary; a 404
// here likely means the path is wrong, a 403 means it exists but is gated.
console.log('\n— provisional (unverified) endpoints —');
await probe('POST /event/webhook/unsubscribe', '/event/webhook/unsubscribe', { method: 'POST', body: JSON.stringify({ scope: 'ACCOUNT', scopeId: ACC }) });
await probe('GET  /accounts/{id}/statements/{sid}', `/accounts/${ACC}/statements/stmt_smoke_bogus`);
await probe('POST /accounts/payment/status', '/accounts/payment/status', { method: 'POST', body: JSON.stringify({ accountId: ACC }) });

const blocked = results.filter((r) => r === 'BLOCKED').length;
const authFail = results.filter((r) => r === 'AUTH').length;
console.log('');
if (authFail) console.log('✗ apikey rejected — check HYPERFACE_SECRET_KEY.');
else if (blocked) console.log(`✓ apikey valid. ${blocked} route(s) returned 403 — ${env.HYPERFACE_TEST_ACCOUNT_ID ? 'real IDs in use, so this is key scope: ask Hyperface to enable these API groups (transactions/statements/cards/EMI/rewards/webhooks) for the access key' : 'retest with real IDs (set HYPERFACE_TEST_ACCOUNT_ID/CARD_ID in .env) before suspecting key scope'}.`);
else console.log('✓ All probed routes reachable. Next: real customer/account/card IDs for data flows.');

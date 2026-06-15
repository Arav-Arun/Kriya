// Hyperface UAT provider. Auth is two headers: `apikey: <secret key>` plus
// `x-tenant-id` (datasource selector; "DEFAULT" for our programs — confirmed
// by Hyperface). Several API groups are still permission-gated for our key
// and return 403 "Forbidden resource"; those map to PERMISSION_PENDING so the
// chat agent can fall back to account records on file and say so honestly.
// Verified live (2026-06-12): customers/lookup and accounts/{id}/summary
// return full data; transactions/statements/cards/EMI/rewards/cashback/
// webhooks pending key enablement.
//
// This client mirrors the documented Credit Stack surface (see
// https://hyperface.stoplight.io/docs/credit-stack-apis) — Customer, Accounts,
// Card Issuing/Management, Transactions, Nudges, EMI, Benefits, Rewards,
// Cashback, Webhooks — grouped by the docs' categories in types.ts. Only the
// two endpoints noted above are live-verified; the rest are documented
// (unverified) and follow the documented method/path conventions but could not
// be live-verified (UAT down); reconcile their request/response shapes against
// the spec via scripts/hyperface-smoke.mjs before relying on them.
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.ts';
import type {
  CardProvider, ProviderResult, ProviderErrorCode,
  LiveCustomerMatch, LiveAccountSummary, LiveTransactionFilters, MutationOptions,
} from './types.ts';

const TIMEOUT_MS = 25_000;

function errCode(status: number): ProviderErrorCode {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION_PENDING';
  if (status === 404) return 'NOT_FOUND';
  if (status === 400 || status === 409 || status === 415 || status === 422) return 'VALIDATION';
  if (status >= 500) return 'PROVIDER_DOWN';
  return 'ERROR';
}

function friendly(code: ProviderErrorCode, status: number, body: string): string {
  switch (code) {
    case 'PERMISSION_PENDING':
      return 'This live data feed is pending bank-side enablement for our API key.';
    case 'NOT_FOUND':
      return `The provider could not find this resource (HTTP ${status}).`;
    case 'PROVIDER_DOWN':
      return `The card provider's test environment is temporarily unavailable (HTTP ${status}).`;
    case 'AUTH':
      return 'Provider credentials were rejected — check HYPERFACE_SECRET_KEY.';
    case 'VALIDATION':
      return `The provider rejected the request: ${body.slice(0, 200)}`;
    default:
      return `Provider call failed (HTTP ${status}): ${body.slice(0, 200)}`;
  }
}

async function call<T>(
  path: string,
  init: {
    method: string;
    body?: unknown;
    idempotencyKey?: string;
    // Some endpoints (e.g. statement document download) legitimately return a
    // non-JSON body. Only those may surface text as a successful result; for
    // everyone else a non-JSON 2xx is treated as an error so typed callers
    // never receive a bare string where they expect an object.
    expectText?: boolean;
  },
): Promise<ProviderResult<T>> {
  const hf = config.hyperface;
  if (!hf.configured) {
    return { ok: false, code: 'DISABLED', message: 'Hyperface is not configured (set HYPERFACE_SECRET_KEY).', source: 'hyperface' };
  }
  const headers: Record<string, string> = {
    apikey: hf.secretKey!,
    'x-tenant-id': hf.tenantId,
    // Hyperface versions its endpoints via this header (latest v2). Without it
    // the gateway defaults to v1; sending it explicitly per the API spec
    // future-proofs the newer feeds (transactions, etc.).
    'x-accept-hf-version': hf.apiVersion,
    'content-type': 'application/json',
  };
  if (init.idempotencyKey) headers['x-idempotency-key'] = init.idempotencyKey;

  const method = init.method;
  try {
    const res = await fetch(`${hf.baseUrl}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    // Every Hyperface response carries x-correlation-id; their support team
    // resolves API errors by this trace id, so capture it on every failure.
    const correlationId = res.headers.get('x-correlation-id') ?? undefined;
    if (!res.ok) {
      const code = errCode(res.status);
      console.warn(`[hyperface] ${method} ${path} → ${res.status} ${code}${correlationId ? ` x-correlation-id=${correlationId}` : ''}`);
      return { ok: false, code, status: res.status, message: friendly(code, res.status, text), correlationId, source: 'hyperface' };
    }
    try {
      return { ok: true, data: JSON.parse(text) as T, source: 'hyperface' };
    } catch {
      // A 2xx with a non-JSON body is only a success for text endpoints (e.g.
      // statement download). Anywhere else, returning the raw string would hand
      // a typed caller a bare string instead of the object it expects — surface
      // it as an error instead.
      if (init.expectText) {
        return { ok: true, data: text as unknown as T, source: 'hyperface' };
      }
      console.warn(`[hyperface] ${method} ${path} → 2xx but non-JSON body${correlationId ? ` x-correlation-id=${correlationId}` : ''}`);
      return {
        ok: false,
        code: 'ERROR',
        status: res.status,
        message: 'Provider returned a successful status with an unexpected non-JSON body.',
        correlationId,
        source: 'hyperface',
      };
    }
  } catch (err) {
    return {
      ok: false,
      code: 'PROVIDER_DOWN',
      message: `Could not reach the card provider: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      source: 'hyperface',
    };
  }
}

function idem(o?: MutationOptions): string {
  return o?.idempotencyKey ?? `kriya-${randomUUID()}`;
}

/** The statements endpoint requires a { from, to } body and the provider caps
 *  the window at 180 days. Default to roughly the last 180 days (yyyy-MM-dd). */
function defaultStatementWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 179 * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

export const hyperfaceProvider: CardProvider = {
  name: 'hyperface',
  get configured() { return config.hyperface.configured; },

  // ── Customer ─────────────────────────────────────────────────────────────
  createCustomer: (input, o) => call('/customers/create', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  fetchCustomer: (customerId) => call(`/customers/${customerId}`, { method: 'GET' }),
  updateCustomer: (customerId, input, o) => call(`/customers/${customerId}`, { method: 'POST', body: input, idempotencyKey: idem(o) }),

  async lookupCustomer(q) {
    const body: Record<string, unknown> = {};
    if (q.mobileNumber) body.mobileNumber = q.mobileNumber;
    if (q.pan) body.pan = q.pan;
    if (q.programId ?? config.hyperface.programId) body.programId = q.programId ?? config.hyperface.programId;
    const res = await call<{ status: string; customerAccounts: LiveCustomerMatch[] }>('/customers/lookup', { method: 'POST', body });
    if (!res.ok) return res;
    return { ok: true, data: res.data.customerAccounts ?? [], source: 'hyperface' };
  },

  createIssuerCustomer: (input, o) => call('/customers/issuer/create', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  updateIssuerCustomer: (input, o) => call('/customers/issuer/update', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  fetchIssuerCustomer: (input) => call('/customers/issuer/fetch', { method: 'POST', body: input }),

  // ── Accounts (Credit Card) ───────────────────────────────────────────────
  createCreditAccount: (input, o) => call('/accounts/create', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  createPaylaterAccount: (input, o) => call('/accounts/paylater/create', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  updateBillCycle: (accountId, input, o) => call(`/accounts/${accountId}/billCycle`, { method: 'PUT', body: input, idempotencyKey: idem(o) }),
  updateAccountCreditLimit: (accountId, input, o) => call(`/accounts/${accountId}/creditLimit`, { method: 'PUT', body: input, idempotencyKey: idem(o) }),
  accountSummary: (accountId) => call<LiveAccountSummary>(`/accounts/${accountId}/summary`, { method: 'GET' }),
  accountDetails: (accountId) => call(`/accounts/${accountId}`, { method: 'GET' }),
  updateAccountStatus: (accountId, input, o) => call(`/accounts/${accountId}/status`, { method: 'PUT', body: input, idempotencyKey: idem(o) }),

  // ── Card Issuing ─────────────────────────────────────────────────────────
  createCard: (input, o) => call('/cards/create', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  cardDetails: (cardId) => call(`/cards/${cardId}`, { method: 'GET' }),

  // ── Card Management ──────────────────────────────────────────────────────
  activateCard: (cardId, input, o) => call(`/cards/${cardId}/activate`, { method: 'POST', body: input ?? {}, idempotencyKey: idem(o) }),
  issuePhysicalCard: (cardId, input, o) => call(`/cards/${cardId}/physical`, { method: 'POST', body: input ?? {}, idempotencyKey: idem(o) }),
  setCardPin: (cardId, input, o) => call(`/cards/${cardId}/pin`, { method: 'POST', body: input, idempotencyKey: idem(o) }),
  lockCard: (cardId, o) => call(`/cards/${cardId}/lock`, { method: 'PUT', body: {}, idempotencyKey: idem(o) }),
  unlockCard: (cardId, o) => call(`/cards/${cardId}/unlock`, { method: 'PUT', body: {}, idempotencyKey: idem(o) }),
  hotlistCard: (cardId, reason, o) => call(`/cards/${cardId}/hotlist`, { method: 'PUT', body: { reason }, idempotencyKey: idem(o) }),
  replaceCard: (cardId, o) => call(`/cards/${cardId}/replace`, { method: 'POST', body: {}, idempotencyKey: idem(o) }),
  cardControls: (cardId) => call(`/cards/${cardId}/cardControls`, { method: 'GET' }),
  setCardControls: (cardId, controls, o) => call(`/cards/${cardId}/cardControls`, { method: 'POST', body: controls, idempotencyKey: idem(o) }),

  // ── Transactions ─────────────────────────────────────────────────────────
  statements: (accountId, range) => call(`/accounts/${accountId}/statements`, { method: 'POST', body: range ?? defaultStatementWindow() }),
  downloadStatement: (accountId, statementId) => call(`/accounts/${accountId}/statements/${statementId}/download`, { method: 'GET', expectText: true }),
  transactions: (accountId, f) => call(`/accounts/${accountId}/transactions`, { method: 'POST', body: f ?? {} }),
  billedTransactions: (accountId, f) => call(`/accounts/${accountId}/billed`, { method: 'POST', body: f ?? {} }),
  unbilledTransactions: (accountId) => call(`/accounts/${accountId}/unbilled`, { method: 'POST', body: {} }),
  transactionInquiry: (q) => call('/accounts/transactionInquiry', { method: 'POST', body: q }),
  debitTransaction: (input, o) => call('/accounts/createDebitTransaction', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  creditTransaction: (input, o) => call('/accounts/createCreditTransaction', { method: 'POST', body: input, idempotencyKey: idem(o) }),

  // ── Nudges ───────────────────────────────────────────────────────────────
  nudges: (accountId) => call(`/accounts/${accountId}/nudges`, { method: 'GET' }),

  // ── EMI ──────────────────────────────────────────────────────────────────
  emiConfig: (accountId, q) => {
    const params = new URLSearchParams({ accountId });
    if (q?.amount != null) params.set('amount', String(q.amount));
    if (q?.txnRefId) params.set('txnRefId', q.txnRefId);
    return call(`/accounts/emi?${params}`, { method: 'GET' });
  },
  createEmi: (input, o) => call('/accounts/emi/create', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  emiList: (accountId) => call(`/accounts/${accountId}/emi`, { method: 'GET' }),
  forecloseEmi: (input, o) => call('/accounts/emi/foreclose', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  foreclosureDetails: (input) => call('/accounts/emi/foreclosureDetails', { method: 'POST', body: input }),

  // ── Benefits ─────────────────────────────────────────────────────────────
  fetchBenefits: (input) => call('/benefits/fetch', { method: 'POST', body: input }),
  fetchBenefitsByProgram: (input) => call('/benefits/fetchByProgram', { method: 'POST', body: { programId: input.programId ?? config.hyperface.programId } }),
  subscribeBenefit: (input, o) => call('/benefits/subscribe', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  unsubscribeBenefit: (input, o) => call('/benefits/unsubscribe', { method: 'POST', body: input, idempotencyKey: idem(o) }),

  // ── Rewards ──────────────────────────────────────────────────────────────
  rewardsSummary: (accountId) => call('/rewards/summary', { method: 'POST', body: { accountId } }),
  rewardsLedger: (accountId) => call('/rewards/ledger', { method: 'POST', body: { accountId } }),
  creditRewardPoints: (input, o) => call('/rewards/credit', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  debitRewardPoints: (input, o) => call('/rewards/debit', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  expiringRewards: (input) => call('/rewards/expiring', { method: 'POST', body: input }),
  rewardAccount: (input) => call('/rewards/account', { method: 'POST', body: input }),
  rewardTransactions: (input) => call('/rewards/transactions', { method: 'POST', body: input }),

  // ── Cashback ─────────────────────────────────────────────────────────────
  cashbackSummary: (accountId, range) => call('/cashback/summary/fetch', { method: 'POST', body: { accountId, ...range } }),
  cashbackTransactions: (accountId, range) => call('/cashback/transactions/fetch', { method: 'POST', body: { accountId, ...range } }),

  // ── Webhooks ─────────────────────────────────────────────────────────────
  webhookSubscribe: (input, o) => call('/event/webhook/subscribe', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  webhookUnsubscribe: (input, o) => call('/event/webhook/unsubscribe', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  webhookPause: (input, o) => call('/event/webhook/pause', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  webhookResume: (input, o) => call('/event/webhook/resume', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  webhookFetchSubscriptions: (q) => call('/event/webhook/fetchSubscriptions', { method: 'POST', body: q }),

  // ── Aux ───────────────────────────────────────────────────────────────────
  // documented, unverified — path/shape inferred from the spec; reconcile when
  // UAT is back. Kept because get_live_payment_status (provider-tools.ts) calls it.
  paymentStatus: (q) => call('/accounts/payment/status', { method: 'POST', body: q }),
};

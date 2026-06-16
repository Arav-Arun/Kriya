// Hyperface API client implementation mirroring Credit Stack APIs.
// Base URL and versioning set via configs. Live endpoints: customers/lookup, accounts/{id}/summary.
// See Credit Stack spec: https://hyperface.stoplight.io/docs/credit-stack-apis
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
    apiKey?: string;
  },
): Promise<ProviderResult<T>> {
  const hf = config.hyperface;
  if (!hf.configured) {
    return { ok: false, code: 'DISABLED', message: 'Hyperface is not configured (set HYPERFACE_SECRET_KEY).', source: 'hyperface' };
  }
  const headers: Record<string, string> = {
    apikey: init.apiKey ?? hf.secretKey!,
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

  // Customer endpoints
  createCustomer: (input, o) => call('/customers', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  fetchCustomer: (custId) => call(`/customers/${custId}`, { method: 'GET' }),
  updateCustomer: (custId, input, o) => call(`/customers/${custId}`, { method: 'POST', body: input, idempotencyKey: idem(o) }),

  async lookupCustomer(q) {
    const body: Record<string, unknown> = {};
    if (q.mobileNumber) body.mobileNumber = q.mobileNumber;
    if (q.pan) body.pan = q.pan;
    if (q.programId ?? config.hyperface.programId) body.programId = q.programId ?? config.hyperface.programId;
    const res = await call<{ status: string; customerAccounts: LiveCustomerMatch[] }>('/customers/lookup', { method: 'POST', body });
    if (!res.ok) return res;
    return { ok: true, data: res.data.customerAccounts ?? [], source: 'hyperface' };
  },

  createIssuerCustomer: (input, o) => call('/customers/IssuerCustomer', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  updateIssuerCustomer: (input, o) => call('/customers/updateIssuerCustomer', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  fetchIssuerCustomer: (input) => call('/customers/fetchIssuerCustomer', { method: 'POST', body: input, apiKey: config.hyperface.issuerSecretKey }),

  // Accounts (Credit Card) endpoints
  createCreditAccount: (input, o) => call('/accounts/createCreditAccount', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  createPaylaterAccount: (input, o) => call('/accounts/createPaylaterAccount', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  updateBillCycle: (accountId, input, o) => call(`/accounts/${accountId}/billCycle`, { method: 'PUT', body: input, idempotencyKey: idem(o) }),
  updateAccountCreditLimit: (accountId, input, o) => call(`/accounts/${accountId}/creditLimit`, { method: 'PUT', body: input, idempotencyKey: idem(o) }),
  accountSummary: (accountId) => call<LiveAccountSummary>(`/accounts/${accountId}/summary`, { method: 'GET' }),
  accountDetails: (accountId) => call(`/accounts/${accountId}`, { method: 'GET' }),
  updateAccountStatus: (accountId, input, o) => call(`/accounts/${accountId}/status`, { method: 'PUT', body: input, idempotencyKey: idem(o) }),

  // Card Issuing endpoints
  createCard: (input, o) => call('/cards', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  cardDetails: (cardId) => call(`/cards/${cardId}`, { method: 'GET' }),

  // Card Management endpoints
  activateCard: (cardId, input, o) => call(`/cards/${cardId}/activate`, { method: 'POST', body: input ?? {}, idempotencyKey: idem(o) }),
  issuePhysicalCard: (cardId, input, o) => call(`/cards/${cardId}/issuePhysicalCard`, { method: 'POST', body: input ?? {}, idempotencyKey: idem(o) }),
  setCardPin: (cardId, input, o) => call(`/cards/${cardId}/pin`, { method: 'POST', body: input, idempotencyKey: idem(o) }),
  lockCard: (cardId, o) => call(`/cards/${cardId}/lock`, { method: 'PUT', body: {}, idempotencyKey: idem(o) }),
  unlockCard: (cardId, o) => call(`/cards/${cardId}/unlock`, { method: 'PUT', body: {}, idempotencyKey: idem(o) }),
  hotlistCard: (cardId, reason, o) => call(`/cards/${cardId}/hotlist`, { method: 'PUT', body: { reason }, idempotencyKey: idem(o) }),
  replaceCard: (cardId, o) => call(`/cards/${cardId}/replace`, { method: 'POST', body: {}, idempotencyKey: idem(o) }),
  cardControls: (cardId) => call(`/cards/${cardId}/cardControls`, { method: 'GET' }),
  setCardControls: (cardId, controls, o) => call(`/cards/${cardId}/cardControls`, { method: 'POST', body: controls, idempotencyKey: idem(o) }),

  // Transactions endpoints
  statements: (accountId, range) => call(`/accounts/${accountId}/statements`, { method: 'POST', body: range ?? defaultStatementWindow() }),
  downloadStatement: (accountId, statementId) => call(`/accounts/downloadStatement/${statementId}`, { method: 'GET', expectText: true }),
  transactions: (accountId, f) => call(`/accounts/${accountId}/transactions`, { method: 'POST', body: f ?? {} }),
  billedTransactions: (accountId, f) => call(`/accounts/${accountId}/billed`, { method: 'POST', body: { statementId: f.statementId, count: f.count ?? 50, offset: f.offset ?? 0 } }),
  unbilledTransactions: (accountId, opts) => call(`/accounts/${accountId}/unbilled`, { method: 'POST', body: { count: opts?.count ?? 50, offset: opts?.offset ?? 0 } }),
  transactionInquiry: (q) => call('/accounts/transactionInquiry', { method: 'POST', body: q }),
  debitTransaction: (input, o) => call('/accounts/createDebitTransaction', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  creditTransaction: (input, o) => call('/accounts/createCreditTransaction', { method: 'POST', body: input, idempotencyKey: idem(o) }),

  // Nudges endpoints
  // The /dmon/ service authenticates differently from the Credit Stack apikey
  // scheme and requires a JSON content-type; both are supplied by call().
  nudges: (accountId, opts) => {
    const params = new URLSearchParams();
    if (opts?.channel) params.set('channel', opts.channel);
    if (opts?.count != null) params.set('count', String(opts.count));
    const qs = params.size ? `?${params}` : '';
    return call(`/dmon/nudges/account/${accountId}${qs}`, { method: 'GET' });
  },

  // EMI endpoints
  emiConfig: (accountId, q) => {
    // GET /accounts/emi?accountId=&amount=|txnRefId=&emiType=. The provider
    // requires EITHER a positive amount OR a txnRefId; emiType selects which
    // outstanding to convert when no single purchase is named.
    const params = new URLSearchParams({ accountId });
    if (q?.amount != null) params.set('amount', String(q.amount));
    if (q?.txnRefId) params.set('txnRefId', q.txnRefId);
    if (q?.emiType) params.set('emiType', q.emiType);
    return call(`/accounts/emi?${params}`, { method: 'GET' });
  },
  createEmi: (input, o) => call('/accounts/emi/create', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  emiList: (accountId) => call(`/accounts/${accountId}/emi`, { method: 'GET' }),
  forecloseEmi: (input, o) => call('/accounts/emi/foreclose', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  foreclosureDetails: (input) => call(`/accounts/${input.accountId}/emi/foreclosureDetails`, { method: 'POST', body: input }),

  // Benefits endpoints
  fetchBenefits: (input) => call('/benefits/fetch', { method: 'POST', body: input }),
  fetchBenefitsByProgram: (input) => call('/dmon/benefits/pwa/program', { method: 'POST', body: { programId: input.programId ?? config.hyperface.programId } }),
  subscribeBenefit: (input, o) => call('/benefits/subscribe', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  unsubscribeBenefit: (input, o) => call('/benefits/unsubscribe', { method: 'POST', body: input, idempotencyKey: idem(o) }),

  // Rewards endpoints
  createRewardsAccount: (accountId, o) => call('/smartBenefit/rewards/createRewardsAccount', { method: 'POST', body: { accountId }, idempotencyKey: idem(o), apiKey: config.hyperface.issuerSecretKey }),
  rewardsSummary: (accountId) => call('/rewards/summary', { method: 'POST', body: { accountId }, apiKey: config.hyperface.issuerSecretKey }),
  rewardsLedger: (accountId) => call('/rewards/ledger', { method: 'POST', body: { accountId }, apiKey: config.hyperface.issuerSecretKey }),
  creditRewardPoints: (input, o) => call('/rewards/credit', { method: 'POST', body: input, idempotencyKey: idem(o), apiKey: config.hyperface.issuerSecretKey }),
  debitRewardPoints: (input, o) => call('/rewards/debit', { method: 'POST', body: input, idempotencyKey: idem(o), apiKey: config.hyperface.issuerSecretKey }),
  expiringRewards: (input) => call('/rewards/fetchExpiringRewardTransactions', { method: 'POST', body: input, apiKey: config.hyperface.issuerSecretKey }),
  rewardAccount: (input) => call('/rewards/accountDetails', { method: 'POST', body: input, apiKey: config.hyperface.issuerSecretKey }),
  rewardTransactions: (input) => call('/rewards/fetchRewardTransactions', { method: 'POST', body: input, apiKey: config.hyperface.issuerSecretKey }),

  // Cashback endpoints
  cashbackSummary: (accountId, range) => call('/cashback/summary/fetch', { method: 'POST', body: { accountId, ...range }, apiKey: config.hyperface.issuerSecretKey }),
  cashbackTransactions: (accountId, range) => call('/cashback/transactions/fetch', { method: 'POST', body: { accountId, ...range }, apiKey: config.hyperface.issuerSecretKey }),

  // Webhooks endpoints
  webhookSubscribe: (input, o) => call('/event/webhook/subscribe', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  webhookUnsubscribe: (input, o) => call('/event/webhook/unsubscribe', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  webhookPause: (input, o) => call('/event/webhook/pause', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  webhookResume: (input, o) => call('/event/webhook/resume', { method: 'POST', body: input, idempotencyKey: idem(o) }),
  webhookFetchSubscriptions: (q) => call('/event/webhook/fetchSubscriptions', { method: 'POST', body: q }),

};

// Card provider abstraction. The synthetic "provider" is the local Supabase
// dataset consumed by the existing tools in services/tools.ts; this module
// types the LIVE provider surface (Hyperface UAT today). Every call returns a
// ProviderResult so agents receive structured facts even when a route is
// blocked: UAT key permissions are being enabled group-by-group, so 403s are
// an expected, reportable state (PERMISSION_PENDING) rather than an error.

export type ProviderErrorCode =
  | 'PERMISSION_PENDING' // 403 — API group not yet enabled for our access key
  | 'NOT_FOUND'          // 404 — resource id is wrong or not in our program
  | 'VALIDATION'         // 400 — request shape rejected
  | 'AUTH'               // 401 — apikey missing/invalid (configuration problem)
  | 'PROVIDER_DOWN'      // 5xx / network — UAT outage (it happens mid-migration)
  | 'NOT_SUPPORTED'      // Hyperface has no API for this (disputes, mandates)
  | 'DISABLED'           // provider mode is synthetic / not configured
  | 'ERROR';

export type ProviderResult<T> =
  | { ok: true; data: T; source: 'hyperface' }
  // correlationId: the provider's x-correlation-id response header. Hyperface
  // support resolves API errors by this trace id, so we carry it on failures.
  | { ok: false; code: ProviderErrorCode; status?: number; message: string; correlationId?: string; source: 'hyperface' };

// ── Normalized facts (subset of Hyperface payloads the agents consume) ──

export interface LiveCardRef {
  id: string;
  type?: string;
  cardLast4?: string;
}

export interface LiveAccountRef {
  id: string;
  status?: string;
  cards: LiveCardRef[];
}

export interface LiveCustomerMatch {
  customerId: string;
  accounts: LiveAccountRef[];
}

/** GET /accounts/{id}/summary — the richest read we have live today. */
export interface LiveAccountSummary {
  account: {
    id: string;
    type?: string;
    currentBalance: number;
    approvedCreditLimit: number;
    availableCreditLimit: number;
    approvedCashLimit?: number;
    availableCashLimit?: number;
    currency?: string;
    customer?: {
      id: string;
      firstName?: string | null;
      lastName?: string | null;
      emailAddress?: string | null;
      mobileNumber?: string | null;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  primaryCard?: {
    id: string;
    accountId?: string;
    customerId?: string;
    maskedCardNumber?: string;
    cardExpiry?: string;
    cardStatus?: string;
    isLocked?: boolean;
    isHotlisted?: boolean;
    isActivated?: boolean;
    cardNetwork?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface LiveTransactionFilters {
  from?: string;
  to?: string;
  count?: number;
  offset?: number;
  txnNature?: 'CREDIT' | 'DEBIT';
  checkEmiEligibility?: boolean;
}

export interface MutationOptions {
  /**
   * Hyperface caches responses (including 5xx!) against x-idempotency-key for
   * 24h. Retrying after a 5xx MUST use a fresh key after read-verifying state.
   */
  idempotencyKey?: string;
}

// ── Provider interface ───────────────────────────────────────────────────
// The Hyperface Credit Stack surface, grouped by the docs' categories
// (https://hyperface.stoplight.io/docs/credit-stack-apis): Customer, Accounts,
// Card Issuing, Card Management, Transactions, Nudges, EMI, Benefits, Rewards,
// Cashback, Webhooks.
//
// Only the two endpoints tagged "live-verified" (lookupCustomer / accountSummary)
// were confirmed against UAT on 2026-06-12. Everything else is tagged
// "documented (unverified)": it follows the documented method/path conventions
// but could not be live-verified (UAT down); reconcile request/response shapes
// with the Stoplight spec via scripts/hyperface-smoke.mjs before relying on them
// in production. Every method returns a ProviderResult so callers get structured
// facts even when a route is permission-gated (403 → PERMISSION_PENDING).

export interface CardProvider {
  readonly name: 'hyperface';
  readonly configured: boolean;

  // ── Customer ─────────────────────────────────────────────────────────────
  createCustomer(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  fetchCustomer(customerId: string): Promise<ProviderResult<unknown>>;
  updateCustomer(customerId: string, input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  /** Match a customer by registered mobile / PAN (live-verified 2026-06-12). */
  lookupCustomer(q: { mobileNumber?: string; pan?: string; programId?: string }): Promise<ProviderResult<LiveCustomerMatch[]>>;
  createIssuerCustomer(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  updateIssuerCustomer(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  fetchIssuerCustomer(input: { customerId?: string; mobileNumber?: string; pan?: string }): Promise<ProviderResult<unknown>>;

  // ── Accounts (Credit Card) ───────────────────────────────────────────────
  createCreditAccount(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  createPaylaterAccount(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  updateBillCycle(accountId: string, input: { billingCycleDay?: number; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  updateAccountCreditLimit(accountId: string, input: { creditLimit: number; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  accountDetails(accountId: string): Promise<ProviderResult<unknown>>;            // documented (unverified)
  accountSummary(accountId: string): Promise<ProviderResult<LiveAccountSummary>>; // live-verified (2026-06-12)
  updateAccountStatus(accountId: string, input: { status: string; reason?: string }, o?: MutationOptions): Promise<ProviderResult<unknown>>;

  // ── Card Issuing ─────────────────────────────────────────────────────────
  createCard(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  cardDetails(cardId: string): Promise<ProviderResult<unknown>>;                  // documented (unverified)

  // ── Card Management (writes — gated by verification + policy upstream) ─────
  activateCard(cardId: string, input?: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  issuePhysicalCard(cardId: string, input?: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  setCardPin(cardId: string, input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  lockCard(cardId: string, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  unlockCard(cardId: string, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  hotlistCard(cardId: string, reason: string, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  replaceCard(cardId: string, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  cardControls(cardId: string): Promise<ProviderResult<unknown>>;                 // documented (unverified)
  setCardControls(cardId: string, controls: unknown, o?: MutationOptions): Promise<ProviderResult<unknown>>;

  // ── Transactions ─────────────────────────────────────────────────────────
  statements(accountId: string): Promise<ProviderResult<unknown>>;               // documented (unverified) — Fetch Statement Summary
  downloadStatement(accountId: string, statementId: string): Promise<ProviderResult<unknown>>; // documented (unverified) — returns a non-JSON document body
  transactions(accountId: string, f?: LiveTransactionFilters): Promise<ProviderResult<unknown>>; // documented (unverified)
  billedTransactions(accountId: string, f?: LiveTransactionFilters): Promise<ProviderResult<unknown>>; // documented (unverified)
  unbilledTransactions(accountId: string): Promise<ProviderResult<unknown>>;      // documented (unverified)
  transactionInquiry(q: { id?: string; extTxnRefId?: string }): Promise<ProviderResult<unknown>>; // documented (unverified)
  debitTransaction(input: { accountId: string; amount: number; debitTransactionType?: string; description: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  /** REFUND / CHARGEBACK postings (documented, unverified). */
  creditTransaction(input: { accountId: string; amount: number; creditTransactionType: string; description: string }, o?: MutationOptions): Promise<ProviderResult<unknown>>;

  // ── Nudges ───────────────────────────────────────────────────────────────
  nudges(accountId: string): Promise<ProviderResult<unknown>>;

  // ── EMI ──────────────────────────────────────────────────────────────────
  emiConfig(accountId: string, q?: { amount?: number; txnRefId?: string }): Promise<ProviderResult<unknown>>;
  createEmi(input: { accountId: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  emiList(accountId: string): Promise<ProviderResult<unknown>>;
  forecloseEmi(input: { accountId: string; emiRefId: string; interestCharged: number }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  foreclosureDetails(input: { accountId: string; emiRefId: string }): Promise<ProviderResult<unknown>>;

  // ── Benefits ─────────────────────────────────────────────────────────────
  fetchBenefits(input: { accountId?: string; customerId?: string }): Promise<ProviderResult<unknown>>;
  fetchBenefitsByProgram(input: { programId?: string }): Promise<ProviderResult<unknown>>;
  subscribeBenefit(input: { accountId: string; benefitId: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  unsubscribeBenefit(input: { accountId: string; benefitId: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;

  // ── Rewards ──────────────────────────────────────────────────────────────
  rewardsSummary(accountId: string): Promise<ProviderResult<unknown>>;
  rewardsLedger(accountId: string): Promise<ProviderResult<unknown>>;
  creditRewardPoints(input: { accountId: string; points: number; description?: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  debitRewardPoints(input: { accountId: string; points: number; description?: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  expiringRewards(input: { accountId: string; before?: string }): Promise<ProviderResult<unknown>>;
  rewardAccount(input: { accountId: string }): Promise<ProviderResult<unknown>>;
  rewardTransactions(input: { accountId: string; from?: string; to?: string; count?: number; offset?: number }): Promise<ProviderResult<unknown>>;

  // ── Cashback ─────────────────────────────────────────────────────────────
  cashbackSummary(accountId: string, range?: { startDate?: string; endDate?: string }): Promise<ProviderResult<unknown>>;
  cashbackTransactions(accountId: string, range?: { startDate?: string; endDate?: string }): Promise<ProviderResult<unknown>>;

  // ── Webhooks (event subscriptions; we register a shared-secret custom header
  //    at subscribe time and verify it on every delivery — no built-in sig). ──
  webhookSubscribe(input: { eventType: string; scope: string; scopeId: string; endpoint: string; headers?: Record<string, string> }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  webhookUnsubscribe(input: { subscriptionId?: string; scope?: string; scopeId?: string; eventType?: string }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  webhookPause(input: { subscriptionId?: string; scope?: string; scopeId?: string }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  webhookResume(input: { subscriptionId?: string; scope?: string; scopeId?: string }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  webhookFetchSubscriptions(q: { scope: string; scopeId: string }): Promise<ProviderResult<unknown>>;

  // ── Aux ───────────────────────────────────────────────────────────────────
  /** Read the status of a card repayment by provider id or external ref.
   *  documented, unverified — path/shape inferred from the spec. */
  paymentStatus(q: { accountId: string; paymentId?: string; extRefId?: string }): Promise<ProviderResult<unknown>>;
}

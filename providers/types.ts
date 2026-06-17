// Card provider abstraction. The synthetic "provider" is the local Supabase
// dataset consumed by the tools in services/tools.ts; this module types the
// live provider surface (Hyperface). Every call returns a ProviderResult so
// agents receive structured facts even when a route is blocked: when an API
// group is not enabled for the access key the provider returns 403, surfaced
// as PERMISSION_PENDING — an expected, reportable state rather than an error.

export type ProviderErrorCode =
  | 'PERMISSION_PENDING' // 403 — API group not enabled for the access key
  | 'NOT_FOUND'          // 404 — resource id is wrong or not in the program
  | 'VALIDATION'         // 400 — request shape rejected
  | 'AUTH'               // 401 — apikey missing or invalid
  | 'PROVIDER_DOWN'      // 5xx / network — provider unreachable
  | 'NOT_SUPPORTED'      // no provider API for this capability
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

/** GET /accounts/{id}/summary */
export interface LiveAccountSummary {
  primaryCard?: {
    id: string;
    accountId?: string;
    customerId?: string;
    cardDisplayName?: string;
    maskedCardNumber?: string;
    cardExpiry?: string;
    programId?: string;
    physicallyIssued?: boolean;
    virtuallyIssued?: boolean;
    isPrimary?: boolean;
    isActivated?: boolean;
    isHotlisted?: boolean;
    isLocked?: boolean;
    cardStatus?: 'ACTIVE' | 'INACTIVE';
    isPhysicalCardActivated?: boolean;
    isVirtualCardActivated?: boolean;
    cardType?: 'Physical' | 'Virtual' | 'VirtualUpgradeToPhysical' | 'Phygital';
    cardNetwork?: string;
    cardControls?: unknown[];
    [k: string]: unknown;
  };
  account: {
    id: string;
    type?: 'CreditAccount' | 'PrepaidAccount';
    currentBalance: number;
    approvedCreditLimit?: number;
    availableCreditLimit?: number;
    approvedCashLimit?: number;
    availableCashLimit?: number;
    currency?: string;
    customerId?: string;
    programId?: string;
    currentCycleStartDate?: string;
    currentCycleEndDate?: string;
    status?: 'ACTIVE' | 'CHARGE_OFF' | 'PENDING_CLOSURE' | 'CLOSED' | 'DORMANT' | 'SUSPENDED' | 'TRANSFERRED' | 'FORCED_SUSPENDED';
    dateCreated?: string;
    currentMonthLoadAmount?: string;
    totalMonthlyDebitAmount?: string;
    totalAmountLoadForFinancialYear?: string;
    customer?: {
      id?: string;
      firstName?: string | null;
      lastName?: string | null;
      emailAddress?: string | null;
      mobileNumber?: string | null;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  latestTransactions?: Array<{
    id?: string;
    extTxnRefId?: string;
    amount?: number;
    description?: string;
    transactionAmount?: number;
    transactionCurrency?: string | null;
    openingBalance?: number;
    closingBalance?: number;
    txnType?: string;
    postedToLedger?: boolean;
    merchantCategoryCode?: string | null;
    mid?: string | null;
    tid?: string | null;
    identifiedMerchantLogo?: string | null;
    transactionDate?: string;
    postingDate?: string;
    txnNature?: 'CREDIT' | 'DEBIT';
    txnSource?: 'CUSTOMER_INITIATED' | 'SYSTEM_GENERATED';
    txnStatus?: 'SETTLED' | 'APPROVED' | 'REVERSED' | 'EXPIRED' | 'PARTIALLY_SETTLED';
    cardLastFour?: string;
    txnReferenceNumber?: string;
    emiAllowed?: boolean;
    emiRefId?: string | null;
    emiStatus?: string | null;
    paymentMode?: string | null;
    [k: string]: unknown;
  }>;
  latestStatement?: {
    id?: string;
    billingCycle?: number;
    fromDate?: string;
    toDate?: string;
    openingBalance?: unknown;
    closingBalance?: unknown;
    totalAmountDue?: number;
    minimumAmountDue?: number;
    initialMAD?: number;
    initialTAD?: number;
    dueDate?: string;
    graceDate?: string;
    lateFeeIncurred?: number;
    taxOnLateFeeIncurred?: number;
    balanceAmountDue?: number;
    balanceAmountDueGrouped?: unknown;
    payments?: number;
    refundsAndCredits?: number;
    purchasesAndDebits?: number;
    fees?: number;
    financeCharges?: number;
    taxes?: number;
    cashback?: number;
    emi?: number;
    [k: string]: unknown;
  };
  offers?: unknown[];
  customerFkycDetail?: {
    id?: string;
    kycStatus?: 'smallKYC' | 'FKYC';
    fkycStatus?: 'NOT_INITIATED' | 'PENDING' | 'REJECTED' | 'COMPLETED';
    fkycMethod?: 'CKYC' | 'VKYC';
    [k: string]: unknown;
  };
  showVirtualCard?: boolean;
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

/** Billed transactions are fetched per statement: statementId is REQUIRED by the
 *  provider (get it from a statement), with optional pagination. No date range. */
export interface LiveBilledFilters {
  statementId: string;
  count?: number;
  offset?: number;
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
// Paths and request shapes follow the documented Credit Stack conventions.
// Endpoints whose access group is not enabled for the access key return 403,
// surfaced as PERMISSION_PENDING; every method returns a ProviderResult so
// callers receive structured facts even when a route is permission-gated.

export interface CardProvider {
  readonly name: 'hyperface';
  readonly configured: boolean;

  // ── Customer ─────────────────────────────────────────────────────────────
  createCustomer(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  fetchCustomer(custId: string): Promise<ProviderResult<unknown>>;
  updateCustomer(custId: string, input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  /** Match a customer by registered mobile number or PAN. */
  lookupCustomer(q: { mobileNumber?: string; pan?: string; programId?: string }): Promise<ProviderResult<LiveCustomerMatch[]>>;
  createIssuerCustomer(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  updateIssuerCustomer(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  /** Fetch an issuer customer by issuer-customer id or customerRefId. Provider
   *  requires one of `id` / `customerRefId` (no phone/PAN lookup here — use
   *  lookupCustomer for that). Path: POST /customers/fetchIssuerCustomer. */
  fetchIssuerCustomer(input: { id?: string; customerRefId?: string }): Promise<ProviderResult<unknown>>;

  // ── Accounts (Credit Card) ───────────────────────────────────────────────
  createCreditAccount(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  createPaylaterAccount(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  updateBillCycle(accountId: string, input: { billingCycleDay?: number; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  updateAccountCreditLimit(accountId: string, input: { creditLimit: number; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  accountDetails(accountId: string): Promise<ProviderResult<unknown>>;
  accountSummary(accountId: string): Promise<ProviderResult<LiveAccountSummary>>;
  updateAccountStatus(accountId: string, input: { status: string; reason?: string }, o?: MutationOptions): Promise<ProviderResult<unknown>>;

  // ── Card Issuing ─────────────────────────────────────────────────────────
  createCard(input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  cardDetails(cardId: string): Promise<ProviderResult<unknown>>;

  // ── Card Management (writes — gated by verification + policy upstream) ─────
  activateCard(cardId: string, input?: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  issuePhysicalCard(cardId: string, input?: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  setCardPin(cardId: string, input: Record<string, unknown>, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  lockCard(cardId: string, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  unlockCard(cardId: string, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  hotlistCard(cardId: string, reason: string, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  replaceCard(cardId: string, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  cardControls(cardId: string): Promise<ProviderResult<unknown>>;
  setCardControls(cardId: string, controls: unknown, o?: MutationOptions): Promise<ProviderResult<unknown>>;

  // ── Transactions ─────────────────────────────────────────────────────────
  statements(accountId: string, range?: { from: string; to: string }): Promise<ProviderResult<unknown>>; // date-range window capped at 180 days
  downloadStatement(accountId: string, statementId: string): Promise<ProviderResult<unknown>>; // returns a non-JSON document body
  transactions(accountId: string, f?: LiveTransactionFilters): Promise<ProviderResult<unknown>>;
  billedTransactions(accountId: string, f: LiveBilledFilters): Promise<ProviderResult<unknown>>; // requires statementId (from a statement)
  unbilledTransactions(accountId: string, opts?: { count?: number; offset?: number }): Promise<ProviderResult<unknown>>;
  transactionInquiry(q: { id?: string; extTxnRefId?: string }): Promise<ProviderResult<unknown>>;
  debitTransaction(input: { accountId: string; amount: number; debitTransactionType?: string; description: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  /** REFUND / CHARGEBACK postings. */
  creditTransaction(input: { accountId: string; amount: number; creditTransactionType: string; description: string }, o?: MutationOptions): Promise<ProviderResult<unknown>>;

  // ── EMI ──────────────────────────────────────────────────────────────────
  emiConfig(accountId: string, q?: { amount?: number; txnRefId?: string; emiType?: 'TOTAL_OUTSTANDING' | 'LAST_BILLED_OUTSTANDING' }): Promise<ProviderResult<unknown>>;
  createEmi(input: { accountId: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  emiList(accountId: string): Promise<ProviderResult<unknown>>;
  forecloseEmi(input: { accountId: string; emiRefId: string; interestCharged: 'MONTHLY' | 'PER_DIEM' | 'NONE' }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  foreclosureDetails(input: { accountId: string; emiRefId: string }): Promise<ProviderResult<unknown>>;

  // ── Benefits ─────────────────────────────────────────────────────────────
  fetchBenefits(input: { accountId?: string; customerId?: string }): Promise<ProviderResult<unknown>>;
  fetchBenefitsByProgram(input: { programId?: string }): Promise<ProviderResult<unknown>>;
  subscribeBenefit(input: { accountId: string; benefitId: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;
  unsubscribeBenefit(input: { accountId: string; benefitId: string; [k: string]: unknown }, o?: MutationOptions): Promise<ProviderResult<unknown>>;

  // ── Rewards ──────────────────────────────────────────────────────────────
  createRewardsAccount(accountId: string): Promise<ProviderResult<unknown>>;
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

}

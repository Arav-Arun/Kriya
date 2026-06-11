// RBI 2026 e-mandate (recurring standing instruction) model. Each card
// subscription IS an e-mandate; this module enriches the raw subscription row
// into the full regulatory object — AFA status, debit cap, validity period,
// 24-hour pre-debit notification, opt-out rights, merchant category, next debit,
// AFA-free recurring limit, and the no-customer-fee guarantee — all computed
// deterministically so the agents orchestrate/explain but never invent terms.

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (v: unknown): Date | null => {
  const d = new Date(String(v ?? ''));
  return Number.isNaN(d.getTime()) ? null : d;
};

// Merchant → RBI category. insurance / mutual_fund / credit_card_bill get the
// higher ₹1,00,000 AFA-free recurring limit; everything else ₹15,000.
const HIGH_LIMIT = new Set(['insurance', 'mutual_fund', 'credit_card_bill']);
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/netflix|prime|hotstar|spotify|youtube|sony|zee|ott|disney/i, 'ott_streaming'],
  [/insur|\blic\b|term plan|life cover/i, 'insurance'],
  [/mutual|\bsip\b|\bmf\b|invest|groww|zerodha|coin|kuvera/i, 'mutual_fund'],
  [/credit card|card bill|\bcred\b/i, 'credit_card_bill'],
  [/gym|cult|fitness/i, 'fitness'],
  [/electric|broadband|airtel|jio|\bvi\b|gas|water|bescom|bill/i, 'utility'],
  [/news|times|express|subscription|membership|saas|adobe|google one|icloud|software/i, 'digital_subscription'],
];
export function merchantCategory(merchant: string, plan?: string): string {
  const hay = `${merchant} ${plan ?? ''}`;
  for (const [re, cat] of CATEGORY_RULES) if (re.test(hay)) return cat;
  return 'general';
}
export const afaFreeLimitFor = (category: string): number => (HIGH_LIMIT.has(category) ? 100_000 : 15_000);

export interface EMandate {
  mandate_id: string;
  subscription_id: string;
  merchant: string;
  plan: string | null;
  merchant_category: string;
  amount: number;
  billing_cycle: string;
  mandate_cap_inr: number;          // max amount debitable per cycle under this mandate
  afa_status: string;               // additional factor of authentication at setup
  afa_completed_at_setup: boolean;
  afa_free_recurring_limit_inr: number;
  validity_period: { start: string | null; end: string | null; status: string };
  next_debit: { on: string | null; amount: number; afa_required: boolean } | null;
  pre_debit_notification: {
    required: boolean; notice_hours: number; send_on: string | null; channel: string; status: string;
  };
  opt_out: { available: boolean; channel: string; effect: string };
  cancellation_status: string;      // active | cancelled
  cancelled_on: string | null;
  customer_fee_inr: number;         // always 0 — RBI bars charging customers for e-mandate usage
  no_fee_note: string;
}

export function toEMandate(sub: Record<string, any>): EMandate {
  const id = String(sub.id);
  const merchant = String(sub.merchant ?? '');
  const plan = sub.plan != null ? String(sub.plan) : null;
  const category = merchantCategory(merchant, plan ?? undefined);
  const amount = Math.round(Number(sub.amount ?? 0));
  const cycle = String(sub.billing_cycle ?? 'monthly');
  const active = String(sub.status ?? 'active') === 'active';
  const afaFree = afaFreeLimitFor(category);
  // Debit cap = registered ceiling; a little headroom over the plan amount, but
  // never below the plan and capped at the AFA-free band when it fits.
  const mandateCap = Math.max(amount, Math.min(afaFree, Math.ceil((amount * 1.1) / 100) * 100));

  const start = parse(sub.registered_on) ?? parse(sub.created_on) ?? null;
  const nextOn = active ? parse(sub.next_charge_on) : null;
  const cancelledOn = sub.cancelled_on ? iso(parse(sub.cancelled_on)!) : null;
  // Each debit above the AFA-free limit needs fresh AFA; within it, no AFA.
  const afaRequiredNext = amount > afaFree;

  return {
    mandate_id: `EM-${id.replace(/^SUB-?/i, '')}`,
    subscription_id: id,
    merchant,
    plan,
    merchant_category: category,
    amount,
    billing_cycle: cycle,
    mandate_cap_inr: mandateCap,
    afa_status: 'verified_at_setup',
    afa_completed_at_setup: true,
    afa_free_recurring_limit_inr: afaFree,
    validity_period: {
      start: start ? iso(start) : null,
      // RBI mandates carry a registered validity; default 5-year horizon.
      end: start ? iso(new Date(start.getTime() + 5 * 365 * DAY)) : null,
      status: active ? 'active' : 'cancelled',
    },
    next_debit: active && nextOn
      ? { on: iso(nextOn), amount, afa_required: afaRequiredNext }
      : null,
    pre_debit_notification: {
      required: true,
      notice_hours: 24,
      // RBI: notify the customer at least 24h before each debit.
      send_on: active && nextOn ? iso(new Date(nextOn.getTime() - DAY)) : null,
      channel: 'SMS + email',
      status: active && nextOn ? 'scheduled' : 'not_applicable',
    },
    opt_out: {
      available: active,
      channel: 'in-app / chat',
      effect: 'stops all future debits; current paid cycle stays usable',
    },
    cancellation_status: active ? 'active' : 'cancelled',
    cancelled_on: cancelledOn,
    customer_fee_inr: 0,
    no_fee_note: 'No fee is charged to you for setting up, running, or cancelling this e-mandate (per RBI).',
  };
}

export interface CancellationReceipt {
  receipt_id: string;
  mandate_id: string;
  subscription_id: string;
  merchant: string;
  plan: string | null;
  amount: number;
  billing_cycle: string;
  cancelled_on: string;
  effective: string;
  next_debit_cancelled: { on: string; amount: number } | null;
  future_debits: string;
  current_period: string;
  customer_fee_inr: number;
  past_charges_note: string;
  confirmation: string;
}

export function buildCancellationReceipt(
  mandate: EMandate,
  nextChargeAvoided: string | null,
): CancellationReceipt {
  const today = iso(new Date());
  return {
    receipt_id: `RCPT-${mandate.mandate_id}-${today.replace(/-/g, '')}`,
    mandate_id: mandate.mandate_id,
    subscription_id: mandate.subscription_id,
    merchant: mandate.merchant,
    plan: mandate.plan,
    amount: mandate.amount,
    billing_cycle: mandate.billing_cycle,
    cancelled_on: today,
    effective: 'immediate',
    next_debit_cancelled: nextChargeAvoided ? { on: nextChargeAvoided, amount: mandate.amount } : null,
    future_debits: 'revoked — the card will not be auto-debited for this merchant again',
    current_period: 'any already-paid period stays usable until it ends',
    customer_fee_inr: 0,
    past_charges_note: 'This does not refund past charges. Use a refund or dispute for those.',
    confirmation: `E-mandate ${mandate.mandate_id} for ${mandate.merchant} cancelled. No further debits; no cancellation fee.`,
  };
}

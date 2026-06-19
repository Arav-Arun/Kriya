// Kriya e-mandate mapping service.
// Projects database subscriptions to RBI mandate objects.
// Note: Kriya does not query a live mandate registry; unverified values are returned as null or 'unknown'.

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (v: unknown): Date | null => {
  const d = new Date(String(v ?? ''));
  return Number.isNaN(d.getTime()) ? null : d;
};

// Merchant text → RBI-style category, inferred best-effort for the e-mandate view.
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/netflix|prime|hotstar|spotify|youtube|sony|zee|ott|disney/i, 'ott_streaming'],
  [/insur|\blic\b|term plan|life cover/i, 'insurance'],
  [/mutual|\bsip\b|\bmf\b|invest|groww|zerodha|coin|kuvera/i, 'mutual_fund'],
  [/credit card|card bill|\bcred\b/i, 'credit_card_bill'],
  [/gym|cult|fitness/i, 'fitness'],
  [/electric|broadband|airtel|jio|\bvi\b|gas|water|bescom|bill/i, 'utility'],
  [/news|times|express|subscription|membership|saas|adobe|google one|icloud|software/i, 'digital_subscription'],
  [/general/i, 'general'],
];
function merchantCategory(merchant: string, plan?: string): string {
  const hay = `${merchant} ${plan ?? ''}`;
  for (const [re, cat] of CATEGORY_RULES) if (re.test(hay)) return cat;
  return 'general';
}
// General RBI policy (NOT this mandate's verified terms): the AFA-free recurring
// debit limit by merchant category. Used by the e-mandate policy_reference block.
export const AFA_FREE_LIMIT_GENERAL_INR = 15_000;
export const AFA_FREE_LIMIT_HIGH_INR = 100_000;

interface EMandate {
  mandate_id: string;               // internal Kriya reference, NOT a registry id
  subscription_id: string;
  merchant: string;
  plan: string | null;
  merchant_category: string;        // inferred from merchant/plan text (best-effort)
  amount: number;                   // real plan amount from the subscription row
  billing_cycle: string;            // real billing cycle from the subscription row
  mandate_cap_inr: number | null;   // registered debit ceiling — unknown to Kriya
  afa_status: string;               // 'unknown' — Kriya holds no AFA record
  validity_period: { start: string | null; end: string | null; status: string };
  next_debit: { on: string | null; amount: number; afa_required: boolean | null } | null;
  pre_debit_notification: {
    required: boolean | null; notice_hours: number | null; send_on: string | null; channel: string | null; status: string;
  };
  opt_out: { available: boolean; channel: string; effect: string };
  cancellation_status: string;      // active | cancelled (real subscription state)
  cancelled_on: string | null;      // real cancellation date when present
  customer_fee_inr: number;         // 0 per RBI no-fee rule (general policy, applies here)
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

  const start = parse(sub.registered_on) ?? parse(sub.created_on) ?? null;
  const nextOn = active ? parse(sub.next_charge_on) : null;
  const cancelledOn = sub.cancelled_on ? iso(parse(sub.cancelled_on)!) : null;

  return {
    mandate_id: `KRIYA-EM-${id.replace(/^SUB-?/i, '')}`,
    subscription_id: id,
    merchant,
    plan,
    merchant_category: category,
    amount,
    billing_cycle: cycle,
    mandate_cap_inr: null,
    afa_status: 'unknown',
    validity_period: {
      start: start ? iso(start) : null,
      end: null,
      status: active ? 'active' : 'cancelled',
    },
    next_debit: active && nextOn
      ? { on: iso(nextOn), amount, afa_required: null }
      : null,
    pre_debit_notification: {
      required: null,
      notice_hours: null,
      send_on: null,
      channel: null,
      status: 'unknown',
    },
    opt_out: {
      available: active,
      channel: 'in-app / chat',
      effect: 'stops all future debits; current paid cycle stays usable',
    },
    cancellation_status: active ? 'active' : 'cancelled',
    cancelled_on: cancelledOn,
    customer_fee_inr: 0,
    no_fee_note: 'No fee is charged to you for setting up, running, or cancelling this e-mandate (per RBI no-customer-fee rule).',
  };
}


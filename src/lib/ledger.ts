// Pure ledger arithmetic. No I/O, no Supabase — the single source of truth for
// turning ledger entries into a balance, and for the limit/minimum-due math the
// action tools rely on. Kept pure so it is trivially testable.

export type LedgerEntryType = 'purchase' | 'fee' | 'finance_charge' | 'tax' | 'payment' | 'refund';

export interface LedgerEntry {
  type: LedgerEntryType;
  amount: number;
}

const DEBITS = new Set<LedgerEntryType>(['purchase', 'fee', 'finance_charge', 'tax']);

export function currentBalanceFromLedger(entries: LedgerEntry[]): number {
  let balance = 0;
  for (const e of entries) {
    const amount = Math.round(Number(e.amount) || 0);
    balance += DEBITS.has(e.type) ? amount : -amount;
  }
  return Math.max(balance, 0);
}

export function availableLimit(creditLimit: number, outstanding: number): number {
  return Math.max(0, Math.min(creditLimit, creditLimit - Math.max(0, outstanding)));
}

export function minimumDue(outstanding: number): number {
  const owed = Math.max(0, Math.round(outstanding));
  if (owed === 0) return 0;
  return Math.max(500, Math.round((owed * 0.05) / 100) * 100);
}

export function utilizationPct(outstanding: number, creditLimit: number): number {
  if (creditLimit <= 0) return 0;
  return Math.min(100, Math.round((Math.max(0, outstanding) / creditLimit) * 100));
}

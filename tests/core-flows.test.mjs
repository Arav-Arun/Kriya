import test from 'node:test';
import assert from 'node:assert/strict';
import { currentBalanceFromLedger, availableLimit, minimumDue, utilizationPct } from '../src/lib/ledger.ts';
import { toEMandate, buildCancellationReceipt, merchantCategory, afaFreeLimitFor } from '../src/lib/emandates.ts';

test('current balance from ledger', () => {
  const balance = currentBalanceFromLedger([
    { type: 'purchase', amount: 50000 },
    { type: 'fee', amount: 500 },
    { type: 'finance_charge', amount: 1200 },
    { type: 'tax', amount: 306 },
    { type: 'payment', amount: 20000 },
    { type: 'refund', amount: 2006 },
  ]);
  assert.equal(balance, 30000);
  assert.equal(availableLimit(100000, balance), 70000);
  assert.equal(utilizationPct(balance, 100000), 30);
  assert.equal(minimumDue(balance), 1500);
  assert.equal(minimumDue(0), 0);
  assert.equal(minimumDue(3000), 500, 'floor of 500 applies on small balances');
});

test('AFA-free recurring limits follow RBI category bands', () => {
  assert.equal(afaFreeLimitFor('insurance'), 100000);
  assert.equal(afaFreeLimitFor('mutual_fund'), 100000);
  assert.equal(afaFreeLimitFor('credit_card_bill'), 100000);
  assert.equal(afaFreeLimitFor('ott_streaming'), 15000);
  assert.equal(merchantCategory('Netflix'), 'ott_streaming');
  assert.equal(merchantCategory('LIC Term Plan premium'), 'insurance');
});

test('mandate cancellation produces a no-fee receipt and revokes future debits', () => {
  const sub = {
    id: 'SUB-0012', merchant: 'Netflix', plan: 'Premium', amount: 649,
    billing_cycle: 'monthly', status: 'active', next_charge_on: '2026-07-01', registered_on: '2025-01-01',
  };
  const mandate = toEMandate(sub);
  assert.equal(mandate.customer_fee_inr, 0, 'no customer fee for e-mandate usage');
  assert.equal(mandate.afa_completed_at_setup, true);
  assert.equal(mandate.pre_debit_notification.notice_hours, 24);
  assert.equal(mandate.pre_debit_notification.send_on, '2026-06-30', '24h before next debit');
  assert.equal(mandate.afa_free_recurring_limit_inr, 15000);
  assert.equal(mandate.next_debit.afa_required, false, '649 is under the 15k AFA-free band');

  const receipt = buildCancellationReceipt(mandate, sub.next_charge_on);
  assert.equal(receipt.customer_fee_inr, 0, 'no cancellation fee');
  assert.equal(receipt.next_debit_cancelled.on, '2026-07-01');
  assert.match(receipt.future_debits, /revoked/);
  assert.match(receipt.past_charges_note, /does not refund past charges/);
});

test('high-value mandate flags AFA on the next debit', () => {
  const mandate = toEMandate({
    id: 'SUB-0020', merchant: 'ICICI Pru Life insurance', plan: 'Annual', amount: 120000,
    billing_cycle: 'annual', status: 'active', next_charge_on: '2026-09-15', registered_on: '2024-09-15',
  });
  assert.equal(mandate.merchant_category, 'insurance');
  assert.equal(mandate.afa_free_recurring_limit_inr, 100000);
  assert.equal(mandate.next_debit.afa_required, true, '120k exceeds the 1L insurance AFA-free band');
});

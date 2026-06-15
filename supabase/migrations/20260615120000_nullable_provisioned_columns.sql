-- 20260615120000_nullable_provisioned_columns.sql
--
-- Make the columns that have NO live source nullable on the customers table.
--
-- When a customer is provisioned from the live card provider
-- (createCustomerFromLive, card_variant = 'live-linked'), the Hyperface API only
-- returns identity + balances: name, email, phone, card_number_last4,
-- card_status, credit_limit, available_limit, outstanding_total. Every other
-- account fact below has no live source. Kriya's HARD RULE is that no
-- fabricated/defaulted/placeholder value may ever be stored and read back as
-- real account data, so provisioning must write NULL for these columns rather
-- than inventing a value (e.g. cibil_score 0, kyc_status 'verified',
-- due_date today+20, card_network 'unknown'). The seed schema declared them
-- NOT NULL, which forced those fabricated placeholders.
--
-- This migration drops the NOT NULL constraint on each of the 15 affected
-- columns so the provisioning insert can legitimately store NULL.
--
-- IMPORTANT: this migration MUST be applied before live (hyperface_uat)
-- provisioning will work — without it, createCustomerFromLive's all-NULL insert
-- violates the NOT NULL constraints and fails (returning null / "no match").

ALTER TABLE customers ALTER COLUMN minimum_due DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN due_date DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN cibil_score DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN risk_score DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN reward_points_balance DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN kyc_status DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN kyc_expiry DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN card_network DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN card_issued_on DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN annual_fee DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN billing_cycle_day DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN per_txn_limit DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN lounge_visits_remaining DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN lounge_visits_total DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN fuel_surcharge_waiver DROP NOT NULL;

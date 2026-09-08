-- ============================================================
-- 20260908000900_loan_repay_type_equal_principal.sql
-- STEP 16-G2-D4.1 — allow 원금균등상환 ('equal_principal') on loans
--
-- Widens the single CHECK on public.loans.repay_type from
--   ('amortizing', 'bullet')
-- to
--   ('amortizing', 'equal_principal', 'bullet')
--
-- Minimal-change only:
--   - the column, its type, NOT NULL, default: untouched
--   - no table recreate, no data migration (every existing row is already
--     'amortizing' or 'bullet', both still permitted, so ADD CONSTRAINT
--     validates instantly with no row rewrite)
--   - no RLS / trigger / grant / index change
--   - no other column or table touched
--
-- The inline CHECK declared alongside the table in
-- 20260905000200_household_data.sql is auto-named `loans_repay_type_check`;
-- DROP ... IF EXISTS keeps this migration safe if it was ever renamed.
-- ============================================================

alter table public.loans
  drop constraint if exists loans_repay_type_check;

alter table public.loans
  add constraint loans_repay_type_check
  check (repay_type in ('amortizing', 'equal_principal', 'bullet'));

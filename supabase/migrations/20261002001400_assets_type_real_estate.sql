-- ============================================================
-- 20261002001400_assets_type_real_estate.sql
-- 자산 종류 개선 — allow 부동산 ('real_estate') on assets
--
-- Widens the single CHECK on public.assets.type from
--   ('cash', 'bank', 'savings', 'investment', 'other')
-- to
--   ('cash', 'bank', 'savings', 'investment', 'real_estate', 'other')
--
-- Minimal-change only (same shape as
-- 20260908000900_loan_repay_type_equal_principal.sql):
--   - the column, its type, NOT NULL: untouched
--   - no table recreate, no data migration (every existing row already holds
--     one of the five old values, all still permitted, so ADD CONSTRAINT
--     validates instantly with no row rewrite)
--   - no RLS / trigger / grant / index change
--   - no other column or table touched
--
-- The inline CHECK declared alongside the table in
-- 20260918001300_assets.sql is auto-named `assets_type_check`;
-- DROP ... IF EXISTS keeps this migration safe if it was ever renamed.
-- ============================================================

alter table public.assets
  drop constraint if exists assets_type_check;

alter table public.assets
  add constraint assets_type_check
  check (type in ('cash', 'bank', 'savings', 'investment', 'real_estate', 'other'));

-- ============================================================
-- 20261002001500_assets_subtype_institution.sql
-- 자산 관리 BATCH 2 — 자산 상세정보 (상세 종류 / 금융기관)
--
-- Adds two OPTIONAL columns to public.assets:
--   subtype      text null  -- 예금/적금/청약, 국내주식/ETF/…, 아파트/토지/… (app-side code)
--   institution  text null  -- 은행계좌·예·적금: 금융기관 code, 투자: 증권사 직접 입력
--
-- The top-level `type` and its CHECK (6 values, see
-- 20261002001400_assets_type_real_estate.sql) are untouched — the detail
-- refines `type`, it never becomes a new `type` value.
--
-- Minimal-change only:
--   - both columns are NULLABLE with NO default: every existing row keeps
--     working as-is with subtype/institution = NULL (no backfill, no row
--     rewrite — ADD COLUMN without a default is a catalog-only change)
--   - no existing column, constraint, index, trigger or RLS policy changed
--   - no new grant needed: `grant select, insert, update on public.assets
--     to authenticated` (20260918001300_assets.sql) is table-level, so it
--     already covers the new columns; the RLS policies are row-level
--
-- Deliberately NO cross-column CHECK tying subtype/institution to `type`:
-- an app version that predates these columns PATCHes only
-- name/type/balance, so changing `type` there leaves the old detail in
-- place. A cross-column CHECK would make that older app's save fail; the
-- client instead ignores a detail that does not fit the row's type
-- (src/lib/asset.ts `normalizeAssetDetail`). Only a length bound is
-- enforced here, as a guard against junk.
-- ============================================================

alter table public.assets
  add column subtype text,
  add column institution text;

alter table public.assets
  add constraint assets_subtype_length_check
  check (subtype is null or char_length(subtype) between 1 and 40);

alter table public.assets
  add constraint assets_institution_length_check
  check (institution is null or char_length(institution) between 1 and 40);

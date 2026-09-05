# Supabase migrations — 돈돈 가계부

STEP 16-A/16-B/16-B2/16-C/16-C1 설계 문서를 거쳐 승인된 스키마의 실제 SQL. **아직 어떤
원격 Supabase 프로젝트에도 실행되지 않았습니다** — 이 디렉터리는 파일만 존재하는
상태입니다.

**STEP 16-C1 최종 보강**: RLS를 001/002의 각 `CREATE TABLE` 직후 즉시 활성화(더 이상
004까지 RLS가 꺼진 채 남아있는 테이블 없음), `anon`/`authenticated`에 대해 15개 테이블
전부 `REVOKE ALL` 후 필요한 권한만 명시적으로 재부여, `id`/`created_at`까지 포함한
전체 identity 컬럼 불변 처리, `transactions`의 `from_recurring`/
`recurring_occurrence_date`/`from_planned`(provenance) 불변 처리, `profiles`는
`display_name`만 authenticated 본인이 UPDATE 가능(email/id/created_at은 불변)하도록
컬럼 grant 추가.

## 파일

| 파일 | 역할 |
|---|---|
| `20260905000100_identity.sql` | `profiles` / `households` / `household_members` / `invites` — 계정·가구 인프라(uuid PK), 트리거/RLS 없음 |
| `20260905000200_household_data.sql` | `household_settings` + 나머지 10개 household 소유 데이터 테이블(엔티티는 text PK, 기존 로컬 `uid(prefix)` 값 그대로), CHECK 제약 포함, 트리거/RLS 없음 |
| `20260905000300_integrity_triggers.sql` | `private` 스키마, 모든 트리거 함수/바인딩(신규 가입/가구 부트스트랩, identity 잠금, `updated_at` 갱신, Goal/Loan 캐시 원자 반영), household-scoped composite FK |
| `20260905000400_rls.sql` | `private.is_household_member` / `is_household_owner` 헬퍼, 전체 RLS 정책, `goals.saved`/`loans.paid`/`households.name`/`household_settings`/`budgets`의 column-level GRANT/REVOKE |
| `20260905000500_realtime.sql` | Realtime(Postgres Changes) publication 대상 테이블 + `REPLICA IDENTITY FULL` |

**빈 프로젝트에서 반드시 이 순서대로** 적용해야 합니다(파일명 timestamp가 곧 순서). 각
파일이 다음 파일에서 참조하는 테이블/스키마/함수를 전제로 하므로 순서를 건너뛰거나
섞어서 실행하면 실패합니다.

## 아직 하지 않은 것

- 원격 Supabase 프로젝트/Dashboard에 실행 (다음 STEP)
- 앱 코드에서 Supabase SDK 연결
- `redeem_invite`/초대 취소 RPC 구현 (SECURITY DEFINER RPC로 설계만 된 상태, STEP 16-D)
- `household_members`의 display_name 자기수정, 멤버 강퇴/탈퇴, owner 승계 (전용 RPC로 향후 구현)

## 로컬 검증

`supabase`/`psql` CLI나 Docker가 이 환경에 이미 설치돼 있지 않다면 이번 단계에서
새로 설치하지 않았습니다 — 실제 DB 적용 검증은 다음 STEP에서 진행합니다.

/**
 * 대한민국 공휴일 / 법정 기념일 — 근시일 범위만 담은 정적 표.
 *
 * 왜 정적 표인가: 설날·추석·부처님오신날은 음력 기반이라 클라이언트에서
 * 정확히 계산하려면 음력 변환 로직이 필요하고, 대체공휴일 규칙도 해마다
 * 개정될 수 있다. 그래서 대한민국 공식 자료(관보 · 월력요항) 기준으로
 * 확정된 날짜만 손으로 적어 둔다. 네이버 등 외부 서비스를 source of truth로
 * 쓰지 않는다. 대체공휴일도 요일 계산으로 추측하지 않고 공식 월력요항의
 * 실제 날짜만 넣는다.
 *
 * 커버 범위: 2025 ~ 2027. 이 범위 밖 날짜는 `krEvent`가 `undefined`,
 * `isKrHoliday`/`isKrRedDay`가 `false` → 달력은 주말(일=빨강 / 토=파랑)만
 * 표시한다. 공휴일 데이터가 없을 때 임의 색을 칠하지 않기 위해서다.
 *
 * 연도별 법 기준 차이 주의:
 *   - 근로자의 날(5/1)·제헌절(7/17)은 2026년부터 대한민국 공휴일이다
 *     → 2026·2027은 'public_holiday'(빨간 날). 2025는 당시 법 기준상
 *       공휴일이 아니었으므로 'commemoration'(요일 색을 따름)으로 유지.
 *
 * `full name`은 데이터에 보존하고, 달력 셀에는 `shortLabel`을 쓴다.
 * 새 규정/연도는 여기에 줄만 추가하면 앱의 모든 달력에 반영된다.
 */

export type CalendarEventType =
  | 'public_holiday' // 신정·삼일절·어린이날·현충일·광복절·개천절·한글날·성탄절·부처님오신날, 그리고 2026~ 노동절·제헌절
  | 'traditional_holiday' // 설날/추석 연휴
  | 'substitute_holiday' // 대체공휴일
  | 'temporary_holiday' // 정부 지정 임시공휴일
  | 'election' // 법정 공휴일인 선거일 (대선·총선·지방선거)
  | 'commemoration'; // 법정 기념일이지만 관공서 공휴일은 아님 (예: 2025년까지의 노동절·제헌절, 향후 일반 기념일)

export interface CalendarEvent {
  /** 정식 명칭 (그대로 보존). */
  name: string;
  /** 달력 셀에 표시할 짧은 라벨. */
  shortLabel: string;
  type: CalendarEventType;
}

/** '빨간 날'로 칠하는 이벤트 타입 (관공서 공휴일 + 법정 공휴일 선거). */
const RED_TYPES: ReadonlySet<CalendarEventType> = new Set<CalendarEventType>([
  'public_holiday',
  'traditional_holiday',
  'substitute_holiday',
  'temporary_holiday',
  'election',
]);

const KR_EVENTS: Record<string, CalendarEvent> = {
  /* ================= 2025 ================= */
  '2025-01-01': { name: '신정', shortLabel: '신정', type: 'public_holiday' },
  '2025-01-27': { name: '임시공휴일', shortLabel: '임시휴일', type: 'temporary_holiday' },
  '2025-01-28': { name: '설날 연휴', shortLabel: '설연휴', type: 'traditional_holiday' },
  '2025-01-29': { name: '설날', shortLabel: '설날', type: 'traditional_holiday' },
  '2025-01-30': { name: '설날 연휴', shortLabel: '설연휴', type: 'traditional_holiday' },
  '2025-03-01': { name: '삼일절', shortLabel: '삼일절', type: 'public_holiday' },
  '2025-03-03': { name: '삼일절 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  // 2025년 근로자의 날은 관공서 공휴일이 아니었음 -> commemoration.
  '2025-05-01': { name: '근로자의 날', shortLabel: '노동절', type: 'commemoration' },
  '2025-05-05': { name: '어린이날 · 부처님오신날', shortLabel: '어린이날', type: 'public_holiday' },
  '2025-05-06': { name: '대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2025-06-03': { name: '제21대 대통령선거', shortLabel: '대선', type: 'election' },
  '2025-06-06': { name: '현충일', shortLabel: '현충일', type: 'public_holiday' },
  // 2025년 제헌절은 공휴일이 아니었음 -> commemoration.
  '2025-07-17': { name: '제헌절', shortLabel: '제헌절', type: 'commemoration' },
  '2025-08-15': { name: '광복절', shortLabel: '광복절', type: 'public_holiday' },
  '2025-10-03': { name: '개천절', shortLabel: '개천절', type: 'public_holiday' },
  '2025-10-05': { name: '추석 연휴', shortLabel: '추석연휴', type: 'traditional_holiday' },
  '2025-10-06': { name: '추석', shortLabel: '추석', type: 'traditional_holiday' },
  '2025-10-07': { name: '추석 연휴', shortLabel: '추석연휴', type: 'traditional_holiday' },
  '2025-10-08': { name: '추석 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2025-10-09': { name: '한글날', shortLabel: '한글날', type: 'public_holiday' },
  '2025-12-25': { name: '성탄절', shortLabel: '성탄절', type: 'public_holiday' },

  /* ================= 2026 ================= */
  '2026-01-01': { name: '신정', shortLabel: '신정', type: 'public_holiday' },
  '2026-02-16': { name: '설날 연휴', shortLabel: '설연휴', type: 'traditional_holiday' },
  '2026-02-17': { name: '설날', shortLabel: '설날', type: 'traditional_holiday' },
  '2026-02-18': { name: '설날 연휴', shortLabel: '설연휴', type: 'traditional_holiday' },
  '2026-03-01': { name: '삼일절', shortLabel: '삼일절', type: 'public_holiday' },
  '2026-03-02': { name: '삼일절 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  // 2026년부터 근로자의 날은 대한민국 공휴일.
  '2026-05-01': { name: '근로자의 날', shortLabel: '노동절', type: 'public_holiday' },
  '2026-05-05': { name: '어린이날', shortLabel: '어린이날', type: 'public_holiday' },
  '2026-05-24': { name: '부처님오신날', shortLabel: '석탄일', type: 'public_holiday' },
  '2026-05-25': { name: '부처님오신날 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2026-06-03': { name: '제9회 전국동시지방선거', shortLabel: '지방선거', type: 'election' },
  '2026-06-06': { name: '현충일', shortLabel: '현충일', type: 'public_holiday' },
  // 2026년부터 제헌절은 대한민국 공휴일.
  '2026-07-17': { name: '제헌절', shortLabel: '제헌절', type: 'public_holiday' },
  '2026-08-15': { name: '광복절', shortLabel: '광복절', type: 'public_holiday' },
  '2026-08-17': { name: '광복절 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2026-09-24': { name: '추석 연휴', shortLabel: '추석연휴', type: 'traditional_holiday' },
  '2026-09-25': { name: '추석', shortLabel: '추석', type: 'traditional_holiday' },
  '2026-09-26': { name: '추석 연휴', shortLabel: '추석연휴', type: 'traditional_holiday' },
  // NOTE: 2026-09-28은 대체공휴일로 표시하지 않는다 (관보 미확정 · STEP 지시).
  '2026-10-03': { name: '개천절', shortLabel: '개천절', type: 'public_holiday' },
  '2026-10-05': { name: '개천절 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2026-10-09': { name: '한글날', shortLabel: '한글날', type: 'public_holiday' },
  '2026-12-25': { name: '성탄절', shortLabel: '성탄절', type: 'public_holiday' },

  /* ================= 2027 (공식 월력요항 기준) ================= */
  '2027-01-01': { name: '신정', shortLabel: '신정', type: 'public_holiday' },
  '2027-02-06': { name: '설날 연휴', shortLabel: '설연휴', type: 'traditional_holiday' },
  '2027-02-07': { name: '설날', shortLabel: '설날', type: 'traditional_holiday' },
  '2027-02-08': { name: '설날 연휴', shortLabel: '설연휴', type: 'traditional_holiday' },
  '2027-02-09': { name: '설날 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2027-03-01': { name: '삼일절', shortLabel: '삼일절', type: 'public_holiday' },
  '2027-05-01': { name: '근로자의 날', shortLabel: '노동절', type: 'public_holiday' },
  '2027-05-05': { name: '어린이날', shortLabel: '어린이날', type: 'public_holiday' },
  '2027-05-13': { name: '부처님오신날', shortLabel: '석탄일', type: 'public_holiday' },
  '2027-06-06': { name: '현충일', shortLabel: '현충일', type: 'public_holiday' },
  '2027-07-17': { name: '제헌절', shortLabel: '제헌절', type: 'public_holiday' },
  '2027-08-15': { name: '광복절', shortLabel: '광복절', type: 'public_holiday' },
  '2027-08-16': { name: '광복절 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2027-09-14': { name: '추석 연휴', shortLabel: '추석연휴', type: 'traditional_holiday' },
  '2027-09-15': { name: '추석', shortLabel: '추석', type: 'traditional_holiday' },
  '2027-09-16': { name: '추석 연휴', shortLabel: '추석연휴', type: 'traditional_holiday' },
  '2027-10-03': { name: '개천절', shortLabel: '개천절', type: 'public_holiday' },
  '2027-10-04': { name: '개천절 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2027-10-09': { name: '한글날', shortLabel: '한글날', type: 'public_holiday' },
  '2027-10-11': { name: '한글날 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
  '2027-12-25': { name: '성탄절', shortLabel: '성탄절', type: 'public_holiday' },
  '2027-12-27': { name: '성탄절 대체공휴일', shortLabel: '대체휴일', type: 'substitute_holiday' },
};

/** 첫/마지막 커버 연도 — 이 범위 밖은 항상 이벤트 없음. */
export const KR_EVENT_MIN_YEAR = 2025;
export const KR_EVENT_MAX_YEAR = 2027;

/** `dateKey`(YYYY-MM-DD)의 이벤트 메타데이터 (없으면 undefined). */
export function krEvent(dateKey: string): CalendarEvent | undefined {
  return KR_EVENTS[dateKey];
}

/**
 * 이 날짜를 달력에서 '빨간 날'로 칠해야 하는가.
 * 관공서 공휴일·대체공휴일·임시공휴일·명절·법정공휴일 선거일 = true.
 * `commemoration`(공휴일이 아닌 기념일) = false (요일 색을 따른다).
 */
export function isKrRedDay(dateKey: string): boolean {
  const ev = KR_EVENTS[dateKey];
  return ev != null && RED_TYPES.has(ev.type);
}

/* ---- 기존 API 호환 wrapper (unrelated 코드가 깨지지 않도록) ---- */

/** 대한민국 공휴일(빨간 날) 여부. `isKrRedDay`와 동일. */
export function isKrHoliday(dateKey: string): boolean {
  return isKrRedDay(dateKey);
}

/** 이벤트 정식 명칭 (없으면 undefined). */
export function krHolidayName(dateKey: string): string | undefined {
  return KR_EVENTS[dateKey]?.name;
}

/**
 * Rule-based natural-language input parser.
 *
 * Turns a one-line note like "점심 김치찌개 9000" or "월급 320만원" into a
 * partially-filled transaction that the user confirms in the normal input
 * screen. No network, no AI — pure string work.
 *
 * Design notes
 * ------------
 * - `parseNaturalInput()` is the plain function; `RuleBasedParser` wraps it
 *   behind the `InputParser` interface so a future `AIParser` can return the
 *   identical `NaturalParseResult` shape without touching the UI.
 * - It never invents data: an unrecognised amount is `null`, an uncertain
 *   type is flagged with `typeConfident: false`, an uncertain category is
 *   `null`. The screen lets the user fix all of it before saving.
 * - Categories resolve to EXISTING ids only (built-ins + whatever the caller
 *   passes in `options.categories`); it never creates a new taxonomy.
 * - Dates come back as a local `YYYY-MM-DD` key via `toDateKey`, the same
 *   format the input screen already uses, so timezone handling is unchanged.
 */

import { EXPENSE_CATS, INCOME_CATS, type Category, type TxnType } from '@/data/categories';
import { toDateKey } from '@/lib/format';

export interface NaturalParseResult {
  /** Best-guess type. Always set — check `typeConfident` before trusting it. */
  type: TxnType;
  typeConfident: boolean;
  /** Amount in KRW, or null when nothing amount-like was found. */
  amount: number | null;
  /** An existing category id, or null when not confident. */
  category: string | null;
  /** Suggested memo (may be an empty string). */
  memo: string;
  /** Local YYYY-MM-DD. Falls back to the reference date. */
  dateKey: string;
  dateConfident: boolean;
  /** What the parser recognised — for UI hints / debugging. */
  matched: {
    amountText: string | null;
    dateText: string | null;
    typeKeyword: string | null;
    categoryKeyword: string | null;
  };
  /** Trimmed input. */
  raw: string;
  /** True when at least an amount was found (minimum viable parse). */
  ok: boolean;
}

export interface ParseOptions {
  /**
   * The user's full category catalogue (both types). Enables matching custom
   * categories by name. Defaults to the built-in EXPENSE_CATS + INCOME_CATS.
   */
  categories?: Category[];
}

/** Extensible contract — RuleBasedParser today, AIParser later. */
export interface InputParser {
  parse(text: string, referenceDate?: Date): NaturalParseResult;
}

/* ------------------------------------------------------------------ *
 * Keyword tables
 * ------------------------------------------------------------------ */

/** Occasion words that describe *when*, not *what* — dropped from the memo. */
const MEAL_WORDS = ['점심', '저녁', '아침', '브런치', '야식', '간식', '식사', '밥'];

/** Income cues. `category` is an INCOME_CATS id or null when unsure. */
const INCOME_HINTS: { kw: RegExp; category: string | null; label: string }[] = [
  { kw: /월급|급여|봉급/, category: 'salary', label: '월급' },
  { kw: /상여|보너스|성과급|인센티브/, category: 'salary', label: '보너스' },
  { kw: /연봉/, category: 'salary', label: '연봉' },
  { kw: /부수입|부업|사이드잡?/, category: 'side', label: '부수입' },
  { kw: /알바|아르바이트/, category: 'side', label: '알바' },
  { kw: /외주|프리랜|용역비/, category: 'side', label: '외주' },
  { kw: /배당|예금이자|이자수익/, category: 'side', label: '배당' },
  { kw: /중고\s*(거래|판매|판매금)|당근|번개장터/, category: 'side', label: '중고거래' },
  { kw: /판매(?!원|처|점|장)|수익금?/, category: 'side', label: '판매' },
  { kw: /용돈|세뱃돈|세배돈/, category: 'allowance', label: '용돈' },
  { kw: /환급|환불|정산금?|캐시백|페이백/, category: null, label: '환급' },
  { kw: /입금|이체\s*받|송금\s*받/, category: null, label: '입금' },
];

/** Expense cues. `category` is an EXPENSE_CATS id. First match wins. */
const EXPENSE_HINTS: { kw: RegExp; category: string; label: string }[] = [
  {
    kw: /스타벅스|스벅|투썸|이디야|메가\s*커피|메가엠지씨|빽다방|컴포즈|폴바셋|블루보틀|커피빈|할리스|엔젤리너스|카페베네|더벤티|매머드|공차|커피|카페|아메리카노|라떼|아아|콜드브루|디저트|케이크|마카롱|빙수/,
    category: 'cafe',
    label: '카페',
  },
  {
    kw: /택시|카카오\s*t|타다|우버|버스|지하철|전철|기차|ktx|srt|무궁화|itx|교통(비|카드)?|대중교통|하이패스|톨게이트|주유|기름값|가스\s*충전|주차(비|요금)?/,
    category: 'transit',
    label: '교통',
  },
  {
    kw: /점심|저녁|아침|야식|간식|식사|밥값?|외식|배달|배민|배달의민족|요기요|쿠팡이츠|치킨|피자|햄버거|버거|국밥|김밥|분식|떡볶이|파스타|초밥|스시|라멘|우동|회식|술값?|맥주|소주|막걸리|고기|삼겹살|곱창|편의점|gs25|cu\b|씨유|세븐일레븐|이마트24|미니스톱|마트|장보기|장봄|반찬|김치찌개|된장찌개|백반|한식|중식|일식|양식|뷔페/,
    category: 'food',
    label: '식비',
  },
  {
    kw: /쇼핑|옷값?|의류|신발|운동화|가방|악세서리|화장품|올리브영|다이소|이케아|무신사|29cm|지그재그|에이블리|쿠팡(?!이츠)|11번가|지마켓|g마켓|옥션|알리익스프레스|테무|백화점|아울렛|생필품|생활용품/,
    category: 'shopping',
    label: '쇼핑',
  },
  {
    kw: /구독|넷플릭스|넷플|유튜브\s*프리미엄|유튜브프리미엄|디즈니\s*플러스|디즈니플러스|왓챠|웨이브|티빙|쿠팡플레이|스포티파이|애플뮤직|멜론|지니뮤직|벅스|챗gpt|chatgpt|노션|통신(비|요금)|휴대폰\s*요금|핸드폰\s*요금|요금제|인터넷\s*요금/,
    category: 'subscribe',
    label: '구독',
  },
  {
    kw: /병원|의원|약국|약값?|한의원|치과|피부과|정형외과|내과|이비인후과|안과|산부인과|건강검진|영양제|비타민|링거|물리치료|도수치료|진료비/,
    category: 'health',
    label: '건강',
  },
  {
    kw: /월세|전세|관리비|공과금|전기(세|요금)|가스(비|요금)|도시가스|수도(세|요금)|난방비|아파트\s*관리|부동산\s*중개|이사비|이삿짐/,
    category: 'housing',
    label: '주거',
  },
  {
    kw: /영화|cgv|메가박스|롯데시네마|영화관|공연|콘서트|연극|뮤지컬|전시(회)?|미술관|박물관|노래방|코인노래방|pc방|피시방|볼링|당구|스크린골프|여행|숙박|호텔|모텔|펜션|리조트|게임|스팀|플스|닌텐도|놀이공원|테마파크/,
    category: 'leisure',
    label: '여가',
  },
  {
    kw: /경조사|축의금|부의금|조의금|결혼식|장례식|돌잔치|집들이\s*선물|생일\s*선물|명절\s*(선물|비용?)|선물값?|선물/,
    category: 'gift',
    label: '경조사',
  },
];

/* ------------------------------------------------------------------ *
 * Amount
 * ------------------------------------------------------------------ */

// Ordered specific → general: 억[만][천] · 만[천] · 천 · comma/plain digits.
const AMOUNT_RE =
  /(\d+(?:\.\d+)?)\s*억(?:\s*(\d+(?:\.\d+)?)\s*만)?(?:\s*(\d+(?:\.\d+)?)\s*천)?\s*원?|(\d+(?:\.\d+)?)\s*만(?:\s*(\d+(?:\.\d+)?)\s*천)?\s*원?|(\d+(?:\.\d+)?)\s*천\s*원?|(\d{1,3}(?:,\d{3})+|\d+)\s*원?/g;

function amountFromMatch(m: RegExpMatchArray): number {
  const n = (s: string | undefined) => (s == null ? 0 : parseFloat(s));
  if (m[1] != null) return Math.round(n(m[1]) * 1e8 + n(m[2]) * 1e4 + n(m[3]) * 1e3);
  if (m[4] != null) return Math.round(n(m[4]) * 1e4 + n(m[5]) * 1e3);
  if (m[6] != null) return Math.round(n(m[6]) * 1e3);
  if (m[7] != null) return parseInt(m[7].replace(/,/g, ''), 10);
  return 0;
}

/* ------------------------------------------------------------------ *
 * Date
 * ------------------------------------------------------------------ */

function parseDate(text: string, ref: Date): { date: Date; text: string } | null {
  const dayOf = (mo: number, da: number) => {
    const d = new Date(ref.getFullYear(), mo - 1, da);
    // "12월 25일" typed in January → assume it means last year.
    if (d.getTime() - ref.getTime() > 183 * 86_400_000) d.setFullYear(d.getFullYear() - 1);
    return d;
  };

  let m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m) return { date: dayOf(+m[1], +m[2]), text: m[0] };

  m = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    const mo = +m[1];
    const da = +m[2];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return { date: dayOf(mo, da), text: m[0] };
  }

  const rel: [RegExp, number][] = [
    [/그저께|그제/, -2],
    [/어제|어저께/, -1],
    [/오늘/, 0],
  ];
  for (const [re, delta] of rel) {
    const mm = text.match(re);
    if (mm) {
      return {
        date: new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + delta),
        text: mm[0],
      };
    }
  }

  // "이번 주" — recognised (so it's stripped from the memo) but not a day.
  const wk = text.match(/이번\s*주|금주/);
  if (wk) {
    return { date: new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()), text: wk[0] };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Memo
 * ------------------------------------------------------------------ */

function replaceLast(s: string, sub: string, rep: string): string {
  const i = s.lastIndexOf(sub);
  return i < 0 ? s : s.slice(0, i) + rep + s.slice(i + sub.length);
}

function buildMemo(raw: string, removed: (string | null)[]): string {
  let s = raw;
  for (const r of removed) if (r) s = s.split(r).join(' ');
  let mealHit = '';
  for (const w of MEAL_WORDS) {
    if (s.includes(w)) {
      if (!mealHit) mealHit = w;
      s = s.split(w).join(' ');
    }
  }
  s = s
    .replace(/원(?![가-힣])/g, ' ')
    .replace(/[.,·•\-–—/\\|~!?()[\]{}"'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || mealHit;
}

/* ------------------------------------------------------------------ *
 * Parser
 * ------------------------------------------------------------------ */

export function parseNaturalInput(
  text: string,
  referenceDate: Date = new Date(),
  options: ParseOptions = {},
): NaturalParseResult {
  const raw = (text ?? '').trim();
  const allCats = options.categories ?? [...EXPENSE_CATS, ...INCOME_CATS];

  const result: NaturalParseResult = {
    type: 'expense',
    typeConfident: false,
    amount: null,
    category: null,
    memo: '',
    dateKey: toDateKey(referenceDate),
    dateConfident: false,
    matched: { amountText: null, dateText: null, typeKeyword: null, categoryKeyword: null },
    raw,
    ok: false,
  };
  if (!raw) return result;

  // 1) Date — parse then remove from the working text.
  let work = raw;
  const d = parseDate(raw, referenceDate);
  if (d) {
    result.dateKey = toDateKey(d.date);
    result.dateConfident = true;
    result.matched.dateText = d.text;
    work = work.split(d.text).join(' ');
  }

  // 2) Amount — last plausible amount token in the date-stripped text.
  let amountText: string | null = null;
  let amountVal: number | null = null;
  for (const m of work.matchAll(AMOUNT_RE)) {
    const v = amountFromMatch(m);
    if (v > 0) {
      amountVal = v;
      amountText = m[0].trim();
    }
  }
  if (amountVal != null) {
    result.amount = amountVal;
    result.matched.amountText = amountText;
    result.ok = true;
    if (amountText) work = replaceLast(work, amountText, ' ');
  }

  // 3) Type + category.
  const lower = raw.toLowerCase();

  // 3a) An explicit category name in the text wins (covers custom categories).
  let catByName: Category | null = null;
  for (const c of allCats) {
    if (c.name && c.name.length >= 2 && c.name !== '기타' && raw.includes(c.name)) {
      catByName = c;
      break;
    }
  }
  if (catByName) {
    const isIncome = INCOME_CATS.some((c) => c.id === catByName!.id);
    result.type = isIncome ? 'income' : 'expense';
    result.typeConfident = true;
    result.category = catByName.id;
    result.matched.categoryKeyword = catByName.name;
  } else {
    for (const h of INCOME_HINTS) {
      if (h.kw.test(lower)) {
        result.type = 'income';
        result.typeConfident = true;
        result.matched.typeKeyword = h.label;
        if (h.category) result.category = h.category;
        break;
      }
    }
    if (!result.typeConfident) {
      for (const h of EXPENSE_HINTS) {
        if (h.kw.test(lower)) {
          result.type = 'expense';
          result.typeConfident = true;
          result.category = h.category;
          result.matched.categoryKeyword = h.label;
          break;
        }
      }
    }
  }

  // Only ever hand back a category id that actually exists…
  if (result.category && !allCats.some((c) => c.id === result.category)) {
    result.category = null;
  }
  // …and one that belongs to the resolved type (for built-ins; trust customs).
  if (result.category) {
    const inExpense = EXPENSE_CATS.some((c) => c.id === result.category);
    const inIncome = INCOME_CATS.some((c) => c.id === result.category);
    if (result.type === 'expense' && inIncome && !inExpense) result.category = null;
    if (result.type === 'income' && inExpense && !inIncome) result.category = null;
  }

  // 4) Memo — raw minus date, amount, occasion words.
  result.memo = buildMemo(raw, [result.matched.dateText, result.matched.amountText]);

  return result;
}

export class RuleBasedParser implements InputParser {
  private options: ParseOptions;
  constructor(options: ParseOptions = {}) {
    this.options = options;
  }
  parse(text: string, referenceDate: Date = new Date()): NaturalParseResult {
    return parseNaturalInput(text, referenceDate, this.options);
  }
}

/** Shared instance using the built-in category catalogue. */
export const ruleBasedParser = new RuleBasedParser();

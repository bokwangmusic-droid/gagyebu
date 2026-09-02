/**
 * Card / bank SMS parser. Given a pasted text message it guesses the
 * transaction type, amount, merchant and category. Ported from the web
 * version (regex tables unchanged).
 */

import type { TxnType } from '@/data/categories';

export interface ParsedCardMessage {
  amount: number;
  merchant: string;
  category: string | null;
  type: TxnType;
}

const CATEGORY_KEYWORDS: { cat: string; pattern: RegExp }[] = [
  {
    cat: 'cafe',
    pattern:
      /스타벅스|이디야|투썸|파스쿠찌|커피빈|메가커피|메가엠지씨|빽다방|공차|할리스|폴바셋|블루보틀|카페|커피|COFFEE|스타벅|엔젤리너스|카페베네|이니시아|컴포즈|더벤티|매머드/i,
  },
  {
    cat: 'food',
    pattern:
      /GS25|CU\b|세븐일레븐|이마트24|미니스톱|김밥|분식|치킨|피자|맥도날드|버거킹|롯데리아|서브웨이|맘스터치|배달의민족|요기요|쿠팡이츠|배달|식당|국밥|덮밥|한솥|김가네|본죽|우아한형제들|BHC|BBQ|교촌|굽네|아웃백|VIPS|애슐리|스시|초밥|파스타|한식|중식|일식|양식|편의점/i,
  },
  {
    cat: 'transit',
    pattern:
      /카카오T|카카오모빌리티|택시|우버|타다|지하철|버스|서울교통공사|한국철도|SRT|KTX|공항철도|코레일|티머니|하이패스|주유|SK주유소|GS칼텍스|현대오일뱅크|S-OIL|고속|톨게이트/i,
  },
  {
    cat: 'shopping',
    pattern:
      /쿠팡|11번가|G마켓|옥션|위메프|티몬|무신사|29CM|SSG|이마트몰|롯데온|올리브영|다이소|IKEA|H&M|자라|유니클로|백화점|아울렛|카카오톡선물하기|스마트스토어|네이버쇼핑|알리|테무|배송|택배/i,
  },
  {
    cat: 'subscribe',
    pattern:
      /넷플릭스|NETFLIX|유튜브|YouTube|디즈니|왓챠|웨이브|WAVVE|티빙|TVING|스포티파이|SPOTIFY|애플뮤직|APPLE|멜론|MELON|지니|플로|FLO|프리미엄|구독|월정액/i,
  },
  {
    cat: 'health',
    pattern: /병원|의원|약국|한의원|치과|피부과|정형외과|내과|외과|산부인과|이비인후과|안과|건강검진/i,
  },
  {
    cat: 'leisure',
    pattern: /CGV|메가박스|롯데시네마|영화관|공연|콘서트|노래방|PC방|볼링|당구|호텔|리조트|펜션|숙박|여행/i,
  },
  {
    cat: 'housing',
    pattern: /월세|관리비|전기|수도|가스|도시가스|한국전력|아파트|주택|임대|보증금/i,
  },
];

export function parseCardMessage(text: string): ParsedCardMessage {
  const result: ParsedCardMessage = {
    amount: 0,
    merchant: '',
    category: null,
    type: 'expense',
  };
  if (!text || !text.trim()) return result;

  if (/입금|급여|월급|봉급|이체.*(받|입금|완료)|송금.*(받|입금)|salary/i.test(text)) {
    result.type = 'income';
  }

  const amountMatches = [...text.matchAll(/([\d]{1,3}(?:,\d{3})+|[\d]{4,})\s*원/g)];
  if (amountMatches.length === 0) return result;

  const valid = amountMatches.filter((m) => {
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 12), idx);
    return !/(누적|잔액|한도|잔여|balance)/i.test(before);
  });
  const pool = valid.length ? valid : amountMatches;
  const nums = pool.map((m) => parseInt(m[1].replace(/,/g, ''), 10));
  result.amount = nums.length ? nums[0] : 0;

  const candidates: string[] = [];
  for (const raw of text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)) {
    let line = raw;
    if (/^\[.+\]$/.test(line)) continue;
    if (/^-+$/.test(line)) continue;
    if (/^[\d,\s/\-.:원]+$/.test(line)) continue;
    if (/^(승인|취소|입금|출금|이체|매입|사용|결제)/.test(line) && line.length < 8) continue;
    line = line
      .replace(/\(.+?\)/g, '')
      .replace(/[\d,]+\s*원/g, '')
      .replace(/\d{2}[/\-.]\d{2}(?:[/\-.]\d{2,4})?/g, '')
      .replace(/\d{1,2}:\d{2}/g, '')
      .replace(/(승인|취소|입금|출금|이체|매입|사용|결제|일시불|할부|누적|잔액|한도)/g, '')
      .replace(
        /\b(신한|국민|KB국민|삼성|현대|롯데|하나|우리|BC|카카오뱅크|토스뱅크|신한은행|국민은행|우리은행|하나은행|기업은행|농협|씨티|SC제일|IBK|카카오|토스)(카드|뱅크|은행)?\b/g,
        '',
      )
      .replace(/[*]{2,}/g, '')
      .replace(/[^\w가-힣\s&]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (line.length >= 2 && line.length < 40 && /[가-힣A-Za-z]/.test(line)) {
      candidates.push(line);
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.length - a.length);
    result.merchant = candidates[0];
  }

  for (const rule of CATEGORY_KEYWORDS) {
    if (rule.pattern.test(text)) {
      result.category = rule.cat;
      break;
    }
  }
  if (result.type === 'income') {
    result.category = /급여|월급|봉급|salary/i.test(text) ? 'salary' : 'other-in';
  }

  return result;
}

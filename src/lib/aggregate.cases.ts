/**
 * Static verification for the home "최근 내역" selector `recentTransactions`
 * (src/lib/aggregate.ts). No test framework in this repo — plain data + a
 * runner, same convention as splits.cases.ts / remoteFinanceRealtime.cases.ts.
 * `tsc --noEmit` type-checks this; run ad-hoc with node after a transpile.
 */
import { recentTransactions } from '@/lib/aggregate';
import type { Transaction } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** Minimal Transaction factory — only the fields the selector reads matter. */
function tx(id: string, date: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id,
    type: 'expense',
    category: 'etc',
    amount: 1000,
    memo: '',
    date,
    ...over,
  };
}

const shuffle = <T,>(arr: T[], seed = 7): T[] => {
  // deterministic LCG shuffle so "scrambled input" is reproducible
  const a = arr.slice();
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export async function runAggregateCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // Six transactions, all distinct calendar instants (ascending by index).
  const six: Transaction[] = [
    tx('txn-1000-a', '2026-09-01T09:00:00.000Z'),
    tx('txn-2000-b', '2026-09-02T09:00:00.000Z'),
    tx('txn-3000-c', '2026-09-03T09:00:00.000Z'),
    tx('txn-4000-d', '2026-09-04T09:00:00.000Z'),
    tx('txn-5000-e', '2026-09-05T09:00:00.000Z'),
    tx('txn-6000-f', '2026-09-06T09:00:00.000Z'),
  ];

  // CASE 1 — 6 transactions -> newest 5, in date-desc order.
  {
    const out = recentTransactions(six, 5).map((t) => t.id);
    const want = ['txn-6000-f', 'txn-5000-e', 'txn-4000-d', 'txn-3000-c', 'txn-2000-b'];
    check(
      'CASE 1 six txns -> newest 5, date desc',
      JSON.stringify(out) === JSON.stringify(want),
      `got ${JSON.stringify(out)}`,
    );
  }

  // CASE 2 — scrambled input order -> identical result.
  {
    const a = recentTransactions(shuffle(six, 3), 5).map((t) => t.id);
    const b = recentTransactions(shuffle(six, 99), 5).map((t) => t.id);
    const c = recentTransactions(six, 5).map((t) => t.id);
    check(
      'CASE 2 input order does not affect result',
      JSON.stringify(a) === JSON.stringify(c) && JSON.stringify(b) === JSON.stringify(c),
      `a=${JSON.stringify(a)} b=${JSON.stringify(b)} c=${JSON.stringify(c)}`,
    );
  }

  // CASE 3 — same calendar date, several rows -> deterministic newest-created
  // first (id `<ms>` segment desc), and stable across input scrambling.
  {
    const sameDay: Transaction[] = [
      tx('txn-1699999999001-a', '2026-09-10T00:00:00.000Z'),
      tx('txn-1699999999002-b', '2026-09-10T00:00:00.000Z'),
      tx('txn-1699999999003-c', '2026-09-10T00:00:00.000Z'),
      tx('txn-1699999999004-d', '2026-09-10T00:00:00.000Z'),
    ];
    const out1 = recentTransactions(sameDay, 5).map((t) => t.id);
    const out2 = recentTransactions(shuffle(sameDay, 42), 5).map((t) => t.id);
    const want = [
      'txn-1699999999004-d',
      'txn-1699999999003-c',
      'txn-1699999999002-b',
      'txn-1699999999001-a',
    ];
    check(
      'CASE 3 same-date rows -> deterministic created-desc',
      JSON.stringify(out1) === JSON.stringify(want) &&
        JSON.stringify(out2) === JSON.stringify(want),
      `out1=${JSON.stringify(out1)} out2=${JSON.stringify(out2)}`,
    );
  }

  // CASE 4 — editing an OLD transaction (same id, same date, changed
  // memo/amount) must NOT lift it above newer-dated rows. The selector reads
  // only `date` + `id`, so an "edited" copy sorts exactly where the original
  // did.
  {
    const editedOld = tx('txn-2000-b', '2026-09-02T09:00:00.000Z', {
      memo: 'edited later',
      amount: 999999,
    });
    const withEdit = [six[0], editedOld, six[2], six[3], six[4], six[5]];
    const out = recentTransactions(withEdit, 5).map((t) => t.id);
    const want = ['txn-6000-f', 'txn-5000-e', 'txn-4000-d', 'txn-3000-c', 'txn-2000-b'];
    check(
      'CASE 4 edit without date change does not jump to top',
      JSON.stringify(out) === JSON.stringify(want),
      `got ${JSON.stringify(out)}`,
    );
  }

  // CASE 5 — local vs remote representation of the SAME logical rows yields
  // the SAME result. Both paths produce the identical `Transaction` shape;
  // the only difference is array order (local store prepends new rows, the
  // remote SELECT has no ORDER BY). The selector must erase that difference.
  {
    const remoteOrder = six.slice(); // e.g. heap/physical order
    const localOrder = six.slice().reverse(); // store prepends -> newest first
    const rOut = recentTransactions(remoteOrder, 5).map((t) => t.id);
    const lOut = recentTransactions(localOrder, 5).map((t) => t.id);
    check(
      'CASE 5 local and remote orderings -> identical selection',
      JSON.stringify(rOut) === JSON.stringify(lOut),
      `remote=${JSON.stringify(rOut)} local=${JSON.stringify(lOut)}`,
    );
  }

  // CASE 6 — pure: the input array is not mutated.
  {
    const input = six.slice();
    const snapshotIds = input.map((t) => t.id);
    recentTransactions(input, 3);
    check(
      'CASE 6 does not mutate the input array',
      JSON.stringify(input.map((t) => t.id)) === JSON.stringify(snapshotIds),
      `after=${JSON.stringify(input.map((t) => t.id))}`,
    );
  }

  // CASE 7 — limit handling: fewer rows than the limit returns all; limit 0
  // (or negative) returns none.
  {
    const three = six.slice(0, 3);
    const all = recentTransactions(three, 5).length;
    const none = recentTransactions(six, 0).length;
    const neg = recentTransactions(six, -2).length;
    check(
      'CASE 7 limit: fewer-than-limit returns all; <=0 returns none',
      all === 3 && none === 0 && neg === 0,
      `all=${all} none=${none} neg=${neg}`,
    );
  }

  // CASE 8 — id without a numeric middle segment: still deterministic (falls
  // back to id-string desc), never throws.
  {
    const weird: Transaction[] = [
      tx('legacy_x', '2026-09-07T00:00:00.000Z'),
      tx('legacy_a', '2026-09-07T00:00:00.000Z'),
      tx('txn-9000-z', '2026-09-06T00:00:00.000Z'),
    ];
    const out = recentTransactions(weird, 5).map((t) => t.id);
    check(
      'CASE 8 non-standard ids sort deterministically (id desc) without throwing',
      JSON.stringify(out) === JSON.stringify(['legacy_x', 'legacy_a', 'txn-9000-z']),
      `got ${JSON.stringify(out)}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

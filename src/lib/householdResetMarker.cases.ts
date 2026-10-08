/**
 * Static verification for the household finance reset marker decision
 * (src/lib/householdResetMarker.ts). Same convention as the other
 * `.cases.ts` files: plain data + a runner, never imported by the app.
 *
 * `roundTrip` pushes a map through exactly what the provider does with it —
 * `JSON.stringify` on save, `JSON.parse` + `parseResetMarkers` on the next
 * launch — so "the null baseline really is stored" is asserted on the
 * persisted bytes, not just on the in-memory object.
 */
import {
  applyResetMarker,
  createResetMarkerStore,
  decideResetMarker,
  parseResetMarkerMicros,
  parseResetMarkers,
  resetMarkerKey,
  type ResetMarkerMap,
} from '@/lib/householdResetMarker';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const KEY = resetMarkerKey('u-A', 'h-A');
const T1 = '2026-10-08T03:21:45.123456+00:00';
const T2 = '2026-10-09T10:00:00.000001+00:00';

const roundTrip = (m: ResetMarkerMap): ResetMarkerMap =>
  parseResetMarkers(JSON.parse(JSON.stringify(m)) as unknown);
const seen = (value: string | null, key = KEY): ResetMarkerMap => ({
  [key]: { initialized: true, value },
});

/** createResetMarkerStore over in-memory IO — async, so a runner of its own. */
export async function runResetMarkerStoreCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const memIO = (initial: unknown) => {
    let stored: unknown = initial;
    let loads = 0;
    let failSave = false;
    let failLoad = false;
    return {
      io: {
        load: () => {
          loads += 1;
          return failLoad ? Promise.reject(new Error('read')) : Promise.resolve(stored);
        },
        save: (m: ResetMarkerMap) => {
          if (failSave) return Promise.reject(new Error('disk full'));
          stored = JSON.parse(JSON.stringify(m)) as unknown;
          return Promise.resolve();
        },
      },
      stored: () => stored,
      loads: () => loads,
      setFailSave: (b: boolean) => {
        failSave = b;
      },
      setFailLoad: (b: boolean) => {
        failLoad = b;
      },
    };
  };

  // S1 — null baseline is written to storage, and a NEW store over it (= next launch) purges on T1
  {
    const m = memIO(null);
    const s1 = createResetMarkerStore(m.io);
    const first = await s1.decide(KEY, null);
    await s1.record(KEY, null);
    const s2 = createResetMarkerStore(m.io);
    check(
      'S1 null baseline persisted; after a restart null -> T1 = purge',
      first === 'bootstrap' &&
        JSON.stringify(m.stored()) === JSON.stringify({ [KEY]: { initialized: true, value: null } }) &&
        (await s2.decide(KEY, T1)) === 'purge',
      JSON.stringify(m.stored()),
    );
  }
  // S2 — decide never persists; record does; storage is read once
  {
    const m = memIO({ [KEY]: { initialized: true, value: T1 } });
    const s = createResetMarkerStore(m.io);
    const d1 = await s.decide(KEY, T2);
    const stillOld = JSON.stringify(m.stored()).includes(T1);
    await s.record(KEY, T2);
    const d2 = await s.decide(KEY, T2);
    await Promise.all([s.decide(KEY, T2), s.decide('other', null)]);
    check(
      'S2 decide is read-only, record persists, storage loaded exactly once',
      d1 === 'purge' && stillOld && d2 === 'unchanged' && JSON.stringify(m.stored()).includes(T2) && m.loads() === 1,
      `d1=${d1} d2=${d2} loads=${m.loads()}`,
    );
  }
  // S3 — malformed / unreadable storage -> bootstrap, never a purge, never a throw
  {
    const bad = createResetMarkerStore(memIO('not-a-map').io);
    const m = memIO(null);
    m.setFailLoad(true);
    const unreadable = createResetMarkerStore(m.io);
    check(
      'S3 malformed or unreadable storage -> bootstrap',
      (await bad.decide(KEY, T1)) === 'bootstrap' && (await unreadable.decide(KEY, T1)) === 'bootstrap',
      'bootstrap expected',
    );
  }
  // S5 — record() never moves a marker back, whatever the caller passes
  {
    const m = memIO({ [KEY]: { initialized: true, value: T2 } });
    const s = createResetMarkerStore(m.io);
    await s.record(KEY, T1);
    await s.record(KEY, null);
    check(
      'S5 record(older) / record(null) are no-ops: stored marker stays T2',
      (await s.decide(KEY, T2)) === 'unchanged' &&
        (await s.decide(KEY, T1)) === 'stale' &&
        JSON.stringify(m.stored()) === JSON.stringify({ [KEY]: { initialized: true, value: T2 } }),
      JSON.stringify(m.stored()),
    );
  }
  // S4 — a failed save keeps the in-memory marker for the session (no throw, no re-purge loop)
  {
    const m = memIO({ [KEY]: { initialized: true, value: T1 } });
    m.setFailSave(true);
    const s = createResetMarkerStore(m.io);
    await s.record(KEY, T2);
    check(
      'S4 save failure is swallowed; memory stays on the new marker',
      (await s.decide(KEY, T2)) === 'unchanged',
      await s.decide(KEY, T2),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

export function runHouseholdResetMarkerCases(): {
  results: CaseResult[];
  passed: number;
  failed: number;
} {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ---------------- required transitions A-D, as one device's lifetime ---------------- */

  // A — first online snapshot, never-reset household: baseline stored, no purge
  const a = applyResetMarker({}, KEY, null);
  const afterA = roundTrip(a.next);
  check(
    'A not initialized + server null -> bootstrap (no purge)',
    a.decision === 'bootstrap',
    a.decision,
  );
  check(
    'A the null baseline is really persisted: { initialized: true, value: null } survives save + reload',
    Object.prototype.hasOwnProperty.call(afterA, KEY) &&
      afterA[KEY].initialized === true &&
      afterA[KEY].value === null,
    JSON.stringify(afterA),
  );

  // B — the household's FIRST reset, seen by that same device after a restart
  const b = applyResetMarker(afterA, KEY, T1);
  const afterB = roundTrip(b.next);
  check(
    'B initialized null -> first timestamp = purge',
    b.decision === 'purge' && afterB[KEY]?.value === T1,
    `${b.decision} ${JSON.stringify(afterB)}`,
  );
  check(
    'B same timestamp again (next refresh / next launch) -> unchanged, map untouched',
    applyResetMarker(afterB, KEY, T1).decision === 'unchanged' &&
      applyResetMarker(afterB, KEY, T1).next === afterB,
    applyResetMarker(afterB, KEY, T1).decision,
  );

  // D — a later reset
  const d = applyResetMarker(afterB, KEY, T2);
  check(
    'D old timestamp -> new timestamp = purge',
    d.decision === 'purge' && roundTrip(d.next)[KEY]?.value === T2,
    `${d.decision} ${JSON.stringify(d.next)}`,
  );

  // C — a NEW device entering an already-reset household
  const c = applyResetMarker({}, KEY, T1);
  check(
    'C not initialized + server timestamp -> bootstrap (first seen timestamp = no purge)',
    c.decision === 'bootstrap' && roundTrip(c.next)[KEY]?.value === T1,
    `${c.decision} ${JSON.stringify(c.next)}`,
  );
  check(
    'C then a real reset on that device -> purge',
    decideResetMarker(roundTrip(c.next), KEY, T2) === 'purge',
    decideResetMarker(roundTrip(c.next), KEY, T2),
  );

  /* ------------------------------- other transitions ------------------------------- */

  check(
    'E initialized null, still null -> unchanged',
    decideResetMarker(seen(null), KEY, null) === 'unchanged',
    decideResetMarker(seen(null), KEY, null),
  );
  {
    const start = seen(T2);
    const f = applyResetMarker(start, KEY, T1);
    check(
      'F seen T2, then the OLDER T1 (late snapshot) -> stale: no purge, marker NOT moved back',
      f.decision === 'stale' && f.next === start && f.next[KEY].value === T2,
      `${f.decision} ${JSON.stringify(f.next)}`,
    );
  }
  {
    const start = seen(T1);
    const g = applyResetMarker(start, KEY, null);
    check(
      'G seen T1, then null -> stale: no purge, marker stays T1',
      g.decision === 'stale' && g.next === start && g.next[KEY].value === T1,
      `${g.decision} ${JSON.stringify(g.next)}`,
    );
  }
  {
    const utc = '2026-10-08T03:21:45.123+00:00';
    const kst = '2026-10-08T12:21:45.123+09:00';
    check(
      'H same instant, different UTC offset -> unchanged',
      decideResetMarker(seen(utc), KEY, kst) === 'unchanged',
      decideResetMarker(seen(utc), KEY, kst),
    );
  }
  /* ------------------- ordering at microsecond resolution ------------------- */
  {
    // Same millisecond, different microsecond: a JS Date cannot tell these apart.
    const early = '2026-10-08T03:21:45.123456+00:00';
    const late = '2026-10-08T03:21:45.123457+00:00';
    check(
      'Q1 same millisecond, 1 microsecond later -> purge (a real second reset is not missed)',
      Date.parse(early) === Date.parse(late) && decideResetMarker(seen(early), KEY, late) === 'purge',
      decideResetMarker(seen(early), KEY, late),
    );
    check(
      'Q2 same millisecond, 1 microsecond EARLIER -> stale (no purge)',
      decideResetMarker(seen(late), KEY, early) === 'stale',
      decideResetMarker(seen(late), KEY, early),
    );
  }
  {
    // Actual instant, not text: "12:00+09:00" is EARLIER than "04:00+00:00" although it sorts later as a string.
    const kstEarlier = '2026-10-08T12:00:00.000000+09:00'; // 03:00Z
    const utcLater = '2026-10-08T04:00:00.000000+00:00';
    check(
      'Q3 ordered by instant, never by string: later-looking text that is an earlier instant -> stale',
      kstEarlier > utcLater && decideResetMarker(seen(utcLater), KEY, kstEarlier) === 'stale',
      decideResetMarker(seen(utcLater), KEY, kstEarlier),
    );
    check(
      'Q4 ...and the reverse is a purge',
      decideResetMarker(seen(kstEarlier), KEY, utcLater) === 'purge',
      decideResetMarker(seen(kstEarlier), KEY, utcLater),
    );
  }
  {
    const forms = [
      '2026-10-08T03:21:45.123456+00:00',
      '2026-10-08T03:21:45.123456Z',
      '2026-10-08 03:21:45.123456+00',
      '2026-10-08T12:21:45.123456+09:00',
      '2026-10-07T22:21:45.123456-0500',
      '2026-10-08T03:21:45.1234560+00:00',
    ];
    const micros = forms.map(parseResetMarkerMicros);
    check(
      'Q5 one instant in six renderings (Z, space, +00, +09:00, -0500, 7 fraction digits) parses identically',
      micros.every((m) => m !== null && m === micros[0]) &&
        forms.every((f) => decideResetMarker(seen(forms[0]), KEY, f) === 'unchanged'),
      JSON.stringify(micros),
    );
    check(
      'Q6 microseconds are exact (no float drift) and fraction-less values parse',
      parseResetMarkerMicros('1970-01-01T00:00:00.000001+00:00') === 1 &&
        parseResetMarkerMicros('2026-10-08T03:21:45+00:00') === Date.UTC(2026, 9, 8, 3, 21, 45) * 1000 &&
        Number.isSafeInteger(parseResetMarkerMicros(T2) ?? NaN),
      String(parseResetMarkerMicros('1970-01-01T00:00:00.000001+00:00')),
    );
    check(
      'Q7 non-timestamps do not parse',
      ['x', '', '2026-10-08', '03:21:45', '2026-13-45T99:99:99Z-'].every((v) => parseResetMarkerMicros(v) === null),
      'null expected',
    );
  }

  /* ---------------------- unparseable values (never from PostgREST) ---------------------- */
  check(
    'I1 unparseable INCOMING vs a good remembered marker -> stale (garbage never purges or replaces)',
    decideResetMarker(seen(T1), KEY, 'garbage') === 'stale',
    decideResetMarker(seen(T1), KEY, 'garbage'),
  );
  check(
    'I2 unparseable REMEMBERED marker vs a good incoming one -> purge once (self-heals to the good value)',
    applyResetMarker(seen('garbage'), KEY, T1).decision === 'purge' &&
      decideResetMarker(applyResetMarker(seen('garbage'), KEY, T1).next, KEY, T1) === 'unchanged',
    applyResetMarker(seen('garbage'), KEY, T1).decision,
  );
  check(
    'I3 byte-identical unparseable strings -> unchanged',
    decideResetMarker(seen('x'), KEY, 'x') === 'unchanged',
    decideResetMarker(seen('x'), KEY, 'x'),
  );
  check(
    'I4 initialized null -> any non-null value -> purge (null is the oldest state)',
    decideResetMarker(seen(null), KEY, 'garbage') === 'purge',
    decideResetMarker(seen(null), KEY, 'garbage'),
  );

  /* -------------------------------- scope isolation -------------------------------- */
  {
    const markers = seen(T1);
    const otherHousehold = resetMarkerKey('u-A', 'h-B');
    const otherUser = resetMarkerKey('u-B', 'h-A');
    check(
      'J another household / another account on this device is NOT initialized by this entry',
      decideResetMarker(markers, otherHousehold, T2) === 'bootstrap' &&
        decideResetMarker(markers, otherUser, T2) === 'bootstrap',
      `${decideResetMarker(markers, otherHousehold, T2)}/${decideResetMarker(markers, otherUser, T2)}`,
    );
    const both = applyResetMarker(markers, otherHousehold, null).next;
    check(
      'K recording one scope leaves the other scope\'s entry intact',
      both[KEY]?.value === T1 && both[otherHousehold]?.value === null && Object.keys(both).length === 2,
      JSON.stringify(both),
    );
    check(
      'L applyResetMarker never mutates its input map',
      Object.keys(markers).length === 1 && markers[KEY].value === T1,
      JSON.stringify(markers),
    );
  }

  /* -------------------------------- malformed storage -------------------------------- */
  {
    const junk = [null, undefined, 'str', 3, true, [T1], []].map((r) => parseResetMarkers(r));
    check(
      'M whole value malformed (null / string / number / array) -> {} -> every scope bootstraps',
      junk.every((m) => Object.keys(m).length === 0) && decideResetMarker(junk[0], KEY, T1) === 'bootstrap',
      JSON.stringify(junk),
    );
    const mixed = parseResetMarkers({
      ok: { initialized: true, value: T1 },
      okNull: { initialized: true, value: null },
      notInit: { initialized: false, value: T1 },
      noFlag: { value: T1 },
      badValue: { initialized: true, value: 5 },
      missingValue: { initialized: true },
      num: 5,
      arr: [T1],
    });
    check(
      'N malformed entries are dropped individually; well-formed ones are kept',
      JSON.stringify(Object.keys(mixed).sort()) === JSON.stringify(['ok', 'okNull']) &&
        mixed.ok.value === T1 &&
        mixed.okNull.value === null,
      JSON.stringify(mixed),
    );
    check(
      'O a dropped (corrupt) entry bootstraps instead of purging',
      decideResetMarker(mixed, 'badValue', T2) === 'bootstrap',
      decideResetMarker(mixed, 'badValue', T2),
    );
  }

  /* ---------------------------- backward compatibility ---------------------------- */
  {
    const legacy = parseResetMarkers({ [KEY]: null, other: T1 });
    check(
      'P earlier bare `string | null` entries load as initialized entries',
      legacy[KEY]?.initialized === true &&
        legacy[KEY].value === null &&
        legacy.other?.value === T1 &&
        decideResetMarker(legacy, KEY, T1) === 'purge',
      JSON.stringify(legacy),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

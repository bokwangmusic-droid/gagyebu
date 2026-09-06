/**
 * Local backup snapshots — STEP 8-A.
 *
 * A rolling set of on-device snapshots of the *whole* user dataset so a
 * long-time user never loses everything to a bad edit, a failed migration or
 * an accidental reset. No files, no cloud — that is STEP 8-B.
 *
 * Storage layout (all under the existing `gagyebu.` namespace from
 * src/lib/storage.ts):
 *
 *   gagyebu.backupIndex          -> BackupMeta[]     (small; drives the list UI)
 *   gagyebu.backup:<id>          -> BackupSnapshot   (one key per snapshot body)
 *   gagyebu.lastAutoBackupDate   -> "YYYY-MM-DD"     (daily-once guard)
 *
 * `schemaVersion` is reused verbatim from src/lib/migrations.ts — this module
 * never invents its own versioning, and restore goes back through the store's
 * existing `importData()` (merge + `migrate()`) path.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import { toDateKey } from '@/lib/format';
import { migrate, SCHEMA_VERSION } from '@/lib/migrations';
import { loadItem, saveItem, storageKey } from '@/lib/storage';
import { DEFAULT_SETTINGS, type AppState } from '@/store/types';

export type BackupReason = 'auto' | 'manual' | 'before_restore' | 'before_reset' | 'before_import';

/**
 * `before_restore` + `before_reset` + `before_import` (STEP 16-F2 §5, added
 * for the local->household one-time import) — one-tap-recovery snapshots
 * taken right before a risky operation, kept in their own capped pool so
 * ordinary auto/manual backups can never evict them.
 */
const RECOVERY_REASONS: readonly BackupReason[] = ['before_restore', 'before_reset', 'before_import'];
const isRecoveryReason = (r: BackupReason) => RECOVERY_REASONS.includes(r);

/**
 * The persisted user-data slices a snapshot carries. Mirrors the store's
 * PERSIST_KEYS 1:1 (everything the user actually created / configured);
 * `seenOnboarding` and `schemaVersion` are app-meta, not backed up here.
 */
export type BackupData = Pick<
  AppState,
  | 'transactions'
  | 'budgets'
  | 'goals'
  | 'recurring'
  | 'planned'
  | 'loans'
  | 'cards'
  | 'notes'
  | 'customCats'
  | 'catOrder'
  | 'settings'
>;

export interface BackupMeta {
  id: string;
  createdAt: string; // ISO
  schemaVersion: number;
  reason: BackupReason;
  /** Transaction count — cheap secondary info for the list UI. */
  txnCount: number;
}

export interface BackupSnapshot extends BackupMeta {
  data: BackupData;
}

/**
 * Rolling caps. `auto` + `manual` share one budget; the recovery reasons
 * (`before_restore` + `before_reset`) share a separate one, so a restore- or
 * reset-safety snapshot never evicts an ordinary backup and neither pile can
 * grow without bound.
 */
const ROLLING_LIMIT = 3;
const RECOVERY_LIMIT = 3;

const INDEX_KEY = 'backupIndex';
const LAST_AUTO_KEY = 'lastAutoBackupDate';
const bodyKey = (id: string) => `backup:${id}`;

const genId = () => `bk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const newestFirst = (a: BackupMeta, b: BackupMeta) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

/** Backup list, newest first. Corrupt / missing index → empty list. */
export async function listBackups(): Promise<BackupMeta[]> {
  const raw = await loadItem<BackupMeta[]>(INDEX_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is BackupMeta =>
        !!m &&
        typeof m.id === 'string' &&
        typeof m.createdAt === 'string' &&
        (m.reason === 'auto' ||
          m.reason === 'manual' ||
          m.reason === 'before_restore' ||
          m.reason === 'before_reset' ||
          m.reason === 'before_import'),
    )
    .sort(newestFirst);
}

async function writeIndex(list: BackupMeta[]): Promise<void> {
  await AsyncStorage.setItem(storageKey(INDEX_KEY), JSON.stringify(list));
}

/** Split into the snapshots to keep (newest, within caps) and the ones to drop. */
function applyCaps(list: BackupMeta[]): { keep: BackupMeta[]; drop: BackupMeta[] } {
  const keep: BackupMeta[] = [];
  const drop: BackupMeta[] = [];
  let rolling = 0;
  let recovery = 0;
  for (const m of [...list].sort(newestFirst)) {
    if (isRecoveryReason(m.reason)) {
      if (recovery < RECOVERY_LIMIT) (keep.push(m), recovery++);
      else drop.push(m);
    } else if (rolling < ROLLING_LIMIT) (keep.push(m), rolling++);
    else drop.push(m);
  }
  return { keep, drop };
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

/**
 * Write a new snapshot of `data`. Returns its meta on success, or `null` if
 * the body could not be durably written (quota / storage error). Callers that
 * depend on the snapshot existing — the `before_restore` safety backup — MUST
 * check for `null` before continuing.
 *
 * The body is written and read back BEFORE the index is touched, and pruning
 * of older snapshots happens only after the new body is confirmed on disk.
 */
export async function createBackup(
  reason: BackupReason,
  data: BackupData,
): Promise<BackupMeta | null> {
  const meta: BackupMeta = {
    id: genId(),
    createdAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    reason,
    txnCount: Array.isArray(data.transactions) ? data.transactions.length : 0,
  };
  const snapshot: BackupSnapshot = { ...meta, data };
  const key = storageKey(bodyKey(meta.id));

  // 1) write the body and read it back to confirm it landed intact.
  try {
    await AsyncStorage.setItem(key, JSON.stringify(snapshot));
    const back = await AsyncStorage.getItem(key);
    if (!back) throw new Error('write not durable');
    JSON.parse(back); // corruption guard
  } catch {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* noop */
    }
    return null;
  }

  // 2) update + prune the index. A failure here leaves the (valid) body on
  //    disk; the next successful createBackup rebuilds the index around it.
  try {
    const current = await listBackups();
    const { keep, drop } = applyCaps([meta, ...current]);
    await writeIndex(keep);
    for (const d of drop) {
      try {
        await AsyncStorage.removeItem(storageKey(bodyKey(d.id)));
      } catch {
        /* noop */
      }
    }
  } catch {
    try {
      await writeIndex([meta]);
    } catch {
      /* noop */
    }
  }

  return meta;
}

/* ------------------------------------------------------------------ *
 * Read + validate
 * ------------------------------------------------------------------ */

/** Raw snapshot body (or `null` if missing / JSON-corrupt). */
export async function readSnapshot(id: string): Promise<unknown> {
  return loadItem<unknown>(bodyKey(id), null);
}

export type SnapshotCheck =
  | { ok: true; snapshot: BackupSnapshot }
  | { ok: false; reason: string };

const SLICE_ARRAYS = [
  'transactions',
  'goals',
  'recurring',
  'planned',
  'loans',
  'cards',
] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

type DataCheck = { ok: true } | { ok: false; reason: string };

/** Slice-shape check shared by the snapshot, file and paste validators. */
function validateBackupData(raw: unknown): DataCheck {
  if (!isPlainObject(raw)) return { ok: false, reason: '백업 데이터가 비어 있어요' };
  for (const k of SLICE_ARRAYS)
    if (!Array.isArray(raw[k])) return { ok: false, reason: `백업 데이터가 손상됐어요 (${k})` };
  if (!isPlainObject(raw.budgets)) return { ok: false, reason: '백업 데이터가 손상됐어요 (budgets)' };
  if (!isPlainObject(raw.settings)) return { ok: false, reason: '백업 데이터가 손상됐어요 (settings)' };
  if (!isPlainObject(raw.customCats)) return { ok: false, reason: '백업 데이터가 손상됐어요 (customCats)' };
  if (!isPlainObject(raw.catOrder)) return { ok: false, reason: '백업 데이터가 손상됐어요 (catOrder)' };
  if (typeof raw.notes !== 'string') return { ok: false, reason: '백업 데이터가 손상됐어요 (notes)' };
  return { ok: true };
}

/**
 * Structural + version check run before a restore. Rejects a body that isn't a
 * snapshot, has no `schemaVersion`, was made by a NEWER app (unknown future
 * shape — never force-restored), or whose data slices are the wrong kind.
 */
export function validateSnapshot(raw: unknown): SnapshotCheck {
  if (!isPlainObject(raw)) return { ok: false, reason: '백업을 읽을 수 없어요 (형식 오류)' };

  if (typeof raw.id !== 'string' || typeof raw.createdAt !== 'string')
    return { ok: false, reason: '백업 정보가 손상됐어요' };

  if (typeof raw.schemaVersion !== 'number' || !Number.isFinite(raw.schemaVersion))
    return { ok: false, reason: '백업에 버전 정보가 없어요' };
  if (raw.schemaVersion > SCHEMA_VERSION)
    return { ok: false, reason: '더 최신 버전에서 만든 백업이라 이 앱에서는 복원할 수 없어요' };

  const dataCheck = validateBackupData(raw.data);
  if (!dataCheck.ok) return dataCheck;

  return { ok: true, snapshot: raw as unknown as BackupSnapshot };
}

/* ------------------------------------------------------------------ *
 * Portable backup file (STEP 8-B) — export / import as a .json file
 * ------------------------------------------------------------------ */

export const EXPORT_APP_ID = 'gagyebu';
/** Envelope version. Bump only if the *file wrapper* changes, never for data. */
export const EXPORT_VERSION = 1;
const SUPPORTED_EXPORT_VERSIONS: readonly number[] = [1];

export interface BackupFile {
  app: typeof EXPORT_APP_ID;
  exportVersion: number;
  /** Data-shape version — reused verbatim from lib/migrations, no parallel scheme. */
  schemaVersion: number;
  exportedAt: string;
  data: BackupData;
}

/** Build the object that gets `JSON.stringify`d into the export file. */
export function buildBackupFile(data: BackupData, now: Date = new Date()): BackupFile {
  return {
    app: EXPORT_APP_ID,
    exportVersion: EXPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    data,
  };
}

/** `gagyebu-backup-YYYY-MM-DD-HHmm.json` — only OS-safe characters, no user input. */
export function backupFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `gagyebu-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}.json`
  );
}

export type FileCheck = { ok: true; file: BackupFile } | { ok: false; reason: string };

/** Strict validator for a picked `.json` backup file (§7). */
export function parseBackupFile(text: string): FileCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: '백업 파일을 읽을 수 없어요 (JSON 형식이 아니에요)' };
  }
  if (!isPlainObject(raw) || raw.app !== EXPORT_APP_ID)
    return { ok: false, reason: '가계부 백업 파일이 아니에요' };
  if (
    typeof raw.exportVersion !== 'number' ||
    !SUPPORTED_EXPORT_VERSIONS.includes(raw.exportVersion)
  )
    return { ok: false, reason: '지원하지 않는 백업 파일 형식이에요' };
  if (typeof raw.schemaVersion !== 'number' || !Number.isFinite(raw.schemaVersion))
    return { ok: false, reason: '백업 파일이 손상됐어요 (버전 정보 없음)' };
  if (raw.schemaVersion > SCHEMA_VERSION)
    return { ok: false, reason: '더 최신 버전의 앱에서 만든 백업이에요' };

  const dataCheck = validateBackupData(raw.data);
  if (!dataCheck.ok) return { ok: false, reason: dataCheck.reason };

  return {
    ok: true,
    file: {
      app: EXPORT_APP_ID,
      exportVersion: raw.exportVersion,
      schemaVersion: raw.schemaVersion,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      data: raw.data as unknown as BackupData,
    },
  };
}

export type TextImportCheck =
  | { ok: true; data: BackupData; schemaVersion: number }
  | { ok: false; reason: string };

/**
 * Lenient parser for the "불러오기" paste box. Accepts either the STEP 8-B file
 * envelope (`{ app, data }`) or STEP 8-A's flat `{ schemaVersion, ...slices }`
 * text payload, filling any slice missing from an old text export with the
 * current value — same leniency `store.importData` always had, but now the
 * result flows through the same safe restore path.
 */
export function parseTextImport(text: string, currentData: BackupData): TextImportCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: '올바른 백업 데이터가 아니에요 (JSON 형식이 아니에요)' };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: '올바른 백업 데이터가 아니에요' };

  const envelope = raw.app === EXPORT_APP_ID && isPlainObject(raw.data);
  const src = envelope ? (raw.data as Record<string, unknown>) : raw;
  const sv =
    typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion)
      ? raw.schemaVersion
      : 0;
  if (sv > SCHEMA_VERSION) return { ok: false, reason: '더 최신 버전의 앱에서 만든 백업이에요' };

  const merged: BackupData = {
    transactions: (src.transactions as BackupData['transactions']) ?? currentData.transactions,
    budgets: (src.budgets as BackupData['budgets']) ?? currentData.budgets,
    goals: (src.goals as BackupData['goals']) ?? currentData.goals,
    recurring: (src.recurring as BackupData['recurring']) ?? currentData.recurring,
    planned: (src.planned as BackupData['planned']) ?? currentData.planned,
    loans: (src.loans as BackupData['loans']) ?? currentData.loans,
    cards: (src.cards as BackupData['cards']) ?? currentData.cards,
    notes: (src.notes as BackupData['notes']) ?? currentData.notes,
    customCats: (src.customCats as BackupData['customCats']) ?? currentData.customCats,
    catOrder: (src.catOrder as BackupData['catOrder']) ?? currentData.catOrder,
    settings: (src.settings as BackupData['settings']) ?? currentData.settings,
  };
  const dataCheck = validateBackupData(merged);
  if (!dataCheck.ok) return { ok: false, reason: dataCheck.reason };

  return { ok: true, data: merged, schemaVersion: sv };
}

/** JSON shaped for `store.importData()` — a current-schema dataset, so
 *  importData's internal migrate() is a no-op and it just persists + setState. */
function dataToImportPayload(data: BackupData): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...data });
}

/* ------------------------------------------------------------------ *
 * Durable dataset write (used by restore)
 * ------------------------------------------------------------------ */

/**
 * The 11 persisted slice fields mapped to their on-disk key (store aliases:
 * `transactions` -> "txns"). Mirrors store.tsx PERSIST_KEYS + KEY_ALIAS.
 */
const SLICE_KEYS: { field: keyof BackupData; key: string }[] = [
  { field: 'transactions', key: 'txns' },
  { field: 'budgets', key: 'budgets' },
  { field: 'goals', key: 'goals' },
  { field: 'recurring', key: 'recurring' },
  { field: 'planned', key: 'planned' },
  { field: 'loans', key: 'loans' },
  { field: 'cards', key: 'cards' },
  { field: 'notes', key: 'notes' },
  { field: 'customCats', key: 'customCats' },
  { field: 'catOrder', key: 'catOrder' },
  { field: 'settings', key: 'settings' },
];

function pickSlices(s: AppState): BackupData {
  return {
    transactions: s.transactions,
    budgets: s.budgets,
    goals: s.goals,
    recurring: s.recurring,
    planned: s.planned,
    loans: s.loans,
    cards: s.cards,
    notes: s.notes,
    customCats: s.customCats,
    catOrder: s.catOrder,
    settings: s.settings,
  };
}

/**
 * Commit a whole dataset to disk with ONE `AsyncStorage.multiSet` (most
 * platforms apply it as a batch), then read every key back and byte-compare.
 * Returns true only when the *entire* set is verified on disk.
 *
 * Correctness here does NOT depend on `multiSet` being a fully atomic
 * transaction — it depends on this read-back verify plus the caller rolling
 * back on a `false` result. Together they replace the guarantee the store's
 * own persist path (a loop of independent, error-swallowing `saveItem` calls)
 * cannot give.
 */
async function writeDatasetDurably(data: BackupData, schemaVersion: number): Promise<boolean> {
  const pairs: [string, string][] = SLICE_KEYS.map(({ field, key }) => [
    storageKey(key),
    JSON.stringify(data[field]),
  ]);
  pairs.push([storageKey('schemaVersion'), JSON.stringify(schemaVersion)]);
  try {
    await AsyncStorage.multiSet(pairs);
    const back = await AsyncStorage.multiGet(pairs.map(([k]) => k));
    const onDisk = new Map(back);
    for (const [k, v] of pairs) if (onDisk.get(k) !== v) return false;
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

export type RestoreResult = { ok: true } | { ok: false; reason: string };

function restoreFailReason(rolledBack: boolean): string {
  return rolledBack
    ? '복원에 실패해 복원 전 상태로 되돌렸어요'
    : '복원에 실패했어요. 「백업」 탭의 「복원 전 백업」에서 다시 복원해 주세요';
}

/**
 * The single safe-restore core, shared by every entry point — a stored
 * snapshot (`performRestore`), a picked backup file or a pasted payload
 * (`performDataRestore`). Never called by UI directly.
 *
 *   1. write a `before_restore` snapshot of `currentData` — abort if it can't
 *      be durably written (never overwrite without a safety net)
 *   2. migrate the source data to the current schema (reuses lib/migrations)
 *   3. commit it to disk with `writeDatasetDurably` (multiSet + full read-back
 *      verify). On failure, roll the disk back to `currentData` and report — the
 *      React store was never touched, so the UI still shows the pre-restore data
 *   4. sync the in-memory store via `applyImport`, and REQUIRE it to succeed. A
 *      false / throwing applyImport means the store's single `setState` updater
 *      bailed before persisting, so in-memory is still pre-restore; roll the
 *      disk back too so disk and memory can never disagree, and report
 *
 * The `before_restore` snapshot from step 1 is kept in every failure path.
 */
async function restoreDataset(
  sourceData: BackupData,
  sourceSchemaVersion: number,
  currentData: BackupData,
  applyImport: (payload: string) => boolean,
): Promise<RestoreResult> {
  const safety = await createBackup('before_restore', currentData);
  if (!safety) return { ok: false, reason: '안전 백업을 만들지 못해 복원을 취소했어요' };

  const migrated = migrate(
    { seenOnboarding: false, ...sourceData },
    sourceSchemaVersion,
  ).state;
  const restored = pickSlices(migrated);

  if (!(await writeDatasetDurably(restored, SCHEMA_VERSION))) {
    const rolledBack = await writeDatasetDurably(currentData, SCHEMA_VERSION);
    return { ok: false, reason: restoreFailReason(rolledBack) };
  }

  let applied: boolean;
  try {
    applied = applyImport(dataToImportPayload(restored));
  } catch {
    applied = false;
  }
  if (!applied) {
    const rolledBack = await writeDatasetDurably(currentData, SCHEMA_VERSION);
    return { ok: false, reason: restoreFailReason(rolledBack) };
  }

  return { ok: true };
}

/** Restore a stored local snapshot by id (STEP 8-A backup list). */
export async function performRestore(
  id: string,
  currentData: BackupData,
  applyImport: (payload: string) => boolean,
): Promise<RestoreResult> {
  const check = validateSnapshot(await readSnapshot(id));
  if (!check.ok) return check;
  return restoreDataset(check.snapshot.data, check.snapshot.schemaVersion, currentData, applyImport);
}

/**
 * Restore an already-validated dataset — from a picked backup file
 * (`parseBackupFile`) or the paste box (`parseTextImport`). Goes through the
 * exact same safe path as a local-snapshot restore.
 */
export async function performDataRestore(
  sourceData: BackupData,
  sourceSchemaVersion: number,
  currentData: BackupData,
  applyImport: (payload: string) => boolean,
): Promise<RestoreResult> {
  return restoreDataset(sourceData, sourceSchemaVersion, currentData, applyImport);
}

/* ------------------------------------------------------------------ *
 * Daily auto-backup
 * ------------------------------------------------------------------ */

const DATA_DEFAULTS: BackupData = {
  transactions: [],
  budgets: {},
  goals: [],
  recurring: [],
  planned: [],
  loans: [],
  cards: [],
  notes: '',
  customCats: DEFAULT_CUSTOM_CATS,
  catOrder: DEFAULT_CAT_ORDER,
  settings: DEFAULT_SETTINGS,
};

/** Live persisted dataset straight off disk — independent of React state timing. */
async function readDiskData(): Promise<BackupData> {
  const [
    transactions,
    budgets,
    goals,
    recurring,
    planned,
    loans,
    cards,
    notes,
    customCats,
    catOrder,
    settings,
  ] = await Promise.all([
    loadItem('txns', DATA_DEFAULTS.transactions),
    loadItem('budgets', DATA_DEFAULTS.budgets),
    loadItem('goals', DATA_DEFAULTS.goals),
    loadItem('recurring', DATA_DEFAULTS.recurring),
    loadItem('planned', DATA_DEFAULTS.planned),
    loadItem('loans', DATA_DEFAULTS.loans),
    loadItem('cards', DATA_DEFAULTS.cards),
    loadItem('notes', DATA_DEFAULTS.notes),
    loadItem('customCats', DATA_DEFAULTS.customCats),
    loadItem('catOrder', DATA_DEFAULTS.catOrder),
    loadItem('settings', DATA_DEFAULTS.settings),
  ]);
  return {
    transactions,
    budgets,
    goals,
    recurring,
    planned,
    loans,
    cards,
    notes,
    customCats,
    catOrder,
    settings,
  };
}

/**
 * Whether there is anything worth snapshotting yet. Covers every user-owned
 * slice — including custom categories, a reordered category list, and any
 * non-default setting (profile name, quick-paste toggle, …) — so a user who
 * only customised categories/settings still gets auto-backups. A pristine
 * post-onboarding app (no data, default cats, default settings) returns false,
 * so it never accrues meaningless snapshots.
 */
export function hasBackupWorthyData(d: BackupData): boolean {
  return (
    (d.transactions?.length ?? 0) > 0 ||
    (d.goals?.length ?? 0) > 0 ||
    (d.recurring?.length ?? 0) > 0 ||
    (d.planned?.length ?? 0) > 0 ||
    (d.loans?.length ?? 0) > 0 ||
    (d.cards?.length ?? 0) > 0 ||
    Object.keys(d.budgets ?? {}).length > 0 ||
    (typeof d.notes === 'string' && d.notes.trim().length > 0) ||
    (d.customCats?.expense?.length ?? 0) > 0 ||
    (d.customCats?.income?.length ?? 0) > 0 ||
    JSON.stringify(d.catOrder ?? {}) !== JSON.stringify(DEFAULT_CAT_ORDER) ||
    JSON.stringify(d.settings ?? {}) !== JSON.stringify(DEFAULT_SETTINGS)
  );
}

/**
 * Fire-and-forget from app boot. Creates at most one `auto` snapshot per
 * calendar day (`toDateKey` = local YYYY-MM-DD). Every failure is swallowed —
 * it must never delay or break app start.
 */
export async function maybeAutoBackup(): Promise<void> {
  try {
    const today = toDateKey(new Date());
    const last = await loadItem<string>(LAST_AUTO_KEY, '');
    if (last === today) return;

    const data = await readDiskData();
    if (!hasBackupWorthyData(data)) return; // re-check on the next launch

    const meta = await createBackup('auto', data);
    if (meta) await saveItem(LAST_AUTO_KEY, today);
  } catch {
    /* never throw into startup */
  }
}

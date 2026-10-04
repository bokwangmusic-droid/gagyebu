import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { ChipSelect, Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import {
  ASSET_INSTITUTION_MAX,
  ASSET_TYPE_OPTIONS,
  BANK_INSTITUTION_OPTIONS,
  assetInstitutionMode,
  assetSubtypeOptions,
  describeAssetInstitution,
} from '@/lib/asset';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum } from '@/lib/format';
import { uid } from '@/lib/id';
import type { RemoteAssetMeta } from '@/lib/remoteFinanceMapping';
import type { NewAssetDraft } from '@/lib/remoteAssetWriteMapping';
import { createAsset, softDeleteAsset, updateAsset } from '@/services/remoteAssetWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import type { Asset, AssetType } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

/**
 * 자산 추가/수정 — 전체자산/순자산 STEP 5.
 *
 * loan-add.tsx / card-add.tsx와 같은 뼈대(라우트 얇은 래퍼 -> 폼 라우트 ->
 * 실제 폼, mount 시점 `expectedUpdatedAt` 고정, NumPad 금액 입력)를 그대로
 * 재사용한다. 단, assets는 아직 오프라인 큐에 연결돼 있지 않으므로(STEP 4/5
 * 범위 밖) 다른 화면들과 달리:
 *   - `usePendingWrites()` / `enqueueAssetCreate` 류를 전혀 쓰지 않는다.
 *   - `res.transport === true`(오프라인)일 때 큐에 넣는 대신, 그 자리에서
 *     명확한 한국어 메시지만 보여주고 폼은 열린 채로 둔다 — 임시 큐를
 *     만들지 않는다(STEP 5 지시사항).
 */
const OFFLINE_MESSAGE = '오프라인 상태예요. 인터넷 연결 후 다시 시도해주세요.';

type NumFieldKey = 'balance';

/** 상세 종류 Field label per type (only types that have subtype options). */
const SUBTYPE_FIELD_LABEL: Partial<Record<AssetType, string>> = {
  savings: '상품 종류',
  investment: '투자 종류',
  real_estate: '부동산 종류',
};

/** Integer digit entry — same rules as loan-add's 원금 입력. */
function applyIntDigit(cur: string, k: string, maxLen: number): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '00') return cur === '' || cur === '0' || cur.length + 2 > maxLen ? cur : cur + '00';
  if (k === '0') return cur === '' || cur === '0' || cur.length >= maxLen ? cur : cur + '0';
  return cur.length >= maxLen ? cur : (cur === '0' ? '' : cur) + k;
}

/**
 * Route entry for /asset-add.
 *
 *   /asset-add            -> new asset form (assetCreate)
 *   /asset-add?id=<aid>   -> edit form      (assetEdit)
 *
 * Either capability off -> ReadOnlyRouteNotice. Thin wrapper (loan-add
 * pattern) so AssetForm keeps an unconditional hook order.
 */
export default function AssetAddRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;

  if (idParam) {
    if (!REMOTE_FINANCE_WRITE.assetEdit) return <ReadOnlyRouteNotice title="자산 수정" />;
    return <AssetFormRoute editId={idParam} />;
  }
  if (!REMOTE_FINANCE_WRITE.assetCreate) return <ReadOnlyRouteNotice title="자산 추가" />;
  return <AssetForm key="create" mode={{ kind: 'create' }} />;
}

type FormMode = { kind: 'create' } | { kind: 'edit'; asset: Asset; meta: RemoteAssetMeta };

function AssetFormRoute({ editId }: { editId: string }) {
  const router = useRouter();
  const { status, error, assets, assetMeta, refresh } = useFinanceRead();

  // 폼이 한 번 실제 자산 + concurrency 토큰으로 해석되면 그 스냅샷을 고정
  // (loan-add.tsx/card-add.tsx와 동일 이유) — 이후 백그라운드 refresh가 이
  // 행을 지워도 열려있는 폼이 사라지지 않는다. 저장 시의 optimistic-
  // concurrency 체크가 deleted/gone/conflict를 최종 판단한다.
  const frozenRef = useRef<{ asset: Asset; meta: RemoteAssetMeta } | null>(null);
  const liveTarget = assets.find((a) => a.id === editId) ?? null;
  const liveMeta = assetMeta[editId] ?? null;
  if (!frozenRef.current && liveTarget && liveMeta) {
    frozenRef.current = { asset: liveTarget, meta: liveMeta };
  }
  if (frozenRef.current) {
    return (
      <AssetForm
        key={editId}
        mode={{ kind: 'edit', asset: frozenRef.current.asset, meta: frozenRef.current.meta }}
      />
    );
  }

  if (status !== 'ready') {
    return (
      <ModalScreen title="자산 수정" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }
  if (!liveTarget) {
    return (
      <EditUnavailable
        body="이미 삭제됐거나 다른 우리집의 자산일 수 있어요."
        onRetry={() => void refresh()}
      />
    );
  }
  return <EditUnavailable body="잠시 후 다시 시도해 주세요." onRetry={() => void refresh()} />;
}

function EditUnavailable({ body, onRetry }: { body: string; onRetry: () => void }) {
  const router = useRouter();
  return (
    <ModalScreen title="자산 수정" onClose={() => router.back()} scroll={false}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.xl,
          gap: spacing.md,
        }}
      >
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, textAlign: 'center' }}>
          자산을 찾을 수 없어요
        </Text>
        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 13,
            color: colors.textSub,
            textAlign: 'center',
            lineHeight: 19,
          }}
        >
          {body}
        </Text>
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
            다시 불러오기
          </Text>
        </Pressable>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSub }}>
            목록으로 돌아가기
          </Text>
        </Pressable>
      </View>
    </ModalScreen>
  );
}

function AssetForm({ mode }: { mode: FormMode }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  // Household finance READ values come ONLY from the remote read-only
  // source — never useStore(). No local addAsset/updateAsset is ever called.
  const { status, error, refresh } = useFinanceRead();

  const editing = mode.kind === 'edit' ? mode.asset : null;
  const isEdit = mode.kind === 'edit';

  // Concurrency token captured ONCE at mount — a later background refresh
  // must never swap it out (mirrors loan-add.tsx / card-add.tsx).
  const expectedUpdatedAtRef = useRef(mode.kind === 'edit' ? mode.meta.updatedAt : null);
  const assetIdRef = useRef(uid('asset'));

  const [name, setName] = useState(editing?.name ?? '');
  const [type, setType] = useState<AssetType>(editing?.type ?? 'bank');
  // 상세정보 (자산 관리 BATCH 2). '' = not chosen. A legacy asset has neither.
  // For 투자 the institution is free text; a leftover bank code is shown by
  // its name so the field never displays a raw code.
  const [subtype, setSubtype] = useState(editing?.subtype ?? '');
  const [institution, setInstitution] = useState(
    editing?.institution
      ? assetInstitutionMode(editing.type) === 'text'
        ? describeAssetInstitution(editing.institution)
        : editing.institution
      : '',
  );
  // Digits only (the NumPad has no minus key) + a separate sign. A balance can
  // go below 0 through 체크카드/이체 spending (DB balance sync), and an edit
  // must never silently flip −10,000 into 10,000.
  const [balance, setBalance] = useState(editing ? String(Math.abs(editing.balance)) : '');
  const [negative, setNegative] = useState(!!editing && editing.balance < 0);
  const showSignToggle = negative || (!!editing && editing.balance < 0);
  const [activeField, setActiveField] = useState<NumFieldKey | null>(null);

  const subtypeOptions = assetSubtypeOptions(type);
  const institutionMode = assetInstitutionMode(type);

  /** A different type has different detail choices — never carry them over. */
  const changeType = (next: AssetType) => {
    if (next === type) return;
    setSubtype('');
    if (assetInstitutionMode(next) !== institutionMode) setInstitution('');
    setType(next);
  };

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const busy = submitting || deleting;

  // 상세 종류 / 금융기관(은행계좌·예·적금)은 필수. 단, 상세정보가 없던 기존
  // 자산을 같은 종류 그대로 수정할 때는 비워 둔 채로도 저장할 수 있다 —
  // 금액만 고치려는 기존 사용자에게 새 입력을 강제하지 않는다.
  const sameTypeAsOriginal = editing?.type === type;
  const needSubtype =
    subtypeOptions.length > 0 && !subtype && !(sameTypeAsOriginal && !editing?.subtype);
  const needInstitution =
    institutionMode === 'select' && !institution && !(sameTypeAsOriginal && !editing?.institution);

  const canSave = name.trim().length > 0 && !needSubtype && !needInstitution;

  // The NumPad is a ModalScreen footer, so opening it shrinks the scroll
  // viewport. With the detail fields the form can now be taller than that
  // viewport; 현재 금액 is the LAST field, so scrolling to the end is exactly
  // what keeps it visible (loan-add.tsx needs per-field maths, this doesn't).
  const scrollRef = useRef<ScrollView>(null);
  const openField = (f: NumFieldKey) => {
    Keyboard.dismiss();
    setActiveField(f);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
  };
  const onKey = (k: string) => {
    if (activeField === 'balance') setBalance((v) => applyIntDigit(v, k, 12));
  };

  /** Draft-state -> NewAssetDraft, or null when the form isn't valid. */
  const buildDraft = (): NewAssetDraft | null => {
    const nm = name.trim();
    if (nm.length === 0) return null;
    const magnitude = parseNum(balance);
    if (!Number.isInteger(magnitude) || magnitude < 0) return null;
    const bal = negative && magnitude > 0 ? -magnitude : magnitude;
    if (needSubtype || needInstitution) return null;
    // Only the details this type uses; the mapper sends NULL for the rest.
    return {
      name: nm,
      type,
      subtype: subtypeOptions.length > 0 && subtype ? subtype : null,
      institution: institutionMode !== 'none' && institution.trim() ? institution.trim() : null,
      balance: bal,
    };
  };

  const save = async () => {
    if (submittingRef.current || deletingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    const draft = buildDraft();
    if (!draft) {
      toast.show('자산 정보를 확인해 주세요.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    if (mode.kind === 'create') {
      const res = await createAsset({
        id: assetIdRef.current,
        householdId: activeHousehold.id,
        expectedUserId: session.user.id,
        draft,
      });
      submittingRef.current = false;
      setSubmitting(false);
      if (!res.ok) {
        // 온라인 전용(STEP 5): 오프라인이어도 큐에 넣지 않고 그 자리에서
        // 안내만 한다 — 폼은 그대로 열려 있어 입력을 잃지 않는다.
        toast.show(res.transport === true ? OFFLINE_MESSAGE : res.message);
        return;
      }
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('자산을 추가했어요');
      router.back();
      return;
    }

    // ---- edit ---- expectedUpdatedAt is the token captured at MOUNT.
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      submittingRef.current = false;
      setSubmitting(false);
      toast.show('자산 정보를 다시 불러와 주세요.');
      return;
    }
    const res = await updateAsset({
      id: mode.asset.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
      draft,
    });
    submittingRef.current = false;
    setSubmitting(false);
    if (!res.ok) {
      if (res.transport === true) {
        toast.show(OFFLINE_MESSAGE);
        return;
      }
      if (res.reason === 'identity' || res.reason === 'error' || res.reason === 'invalid') {
        toast.show(res.message); // keep the form open with the user's input
        return;
      }
      // conflict / deleted / gone — reload authoritative data and leave.
      await refresh();
      toast.show(res.message);
      router.back();
      return;
    }
    await refresh();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast.show('자산을 수정했어요');
    router.back();
  };

  const confirmDelete = () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    Alert.alert('이 자산을 삭제할까요?', '자산 목록에서 사라져요. 기존 거래 내역에는 영향이 없어요.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void doDelete() },
    ]);
  };

  const doDelete = async () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      toast.show('자산 정보를 다시 불러와 주세요.');
      return;
    }

    deletingRef.current = true;
    setDeleting(true);

    const res = await softDeleteAsset({
      id: mode.asset.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    deletingRef.current = false;
    setDeleting(false);

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('자산을 삭제했어요');
      router.back();
      return;
    }

    if (res.transport === true) {
      toast.show(OFFLINE_MESSAGE);
      return;
    }
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    await refresh();
    toast.show(res.message);
    router.back();
  };

  if (status !== 'ready') {
    return (
      <ModalScreen title={isEdit ? '자산 수정' : '자산 추가'} onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen
      title={isEdit ? '자산 수정' : '자산 추가'}
      closeIcon="x"
      onClose={() => router.back()}
      scrollRef={scrollRef}
      right={
        <HeaderTextButton
          label={submitting ? '저장 중…' : '저장'}
          onPress={() => void save()}
          disabled={!canSave || busy}
        />
      }
      footer={
        activeField ? (
          <NumPad
            style={{ paddingBottom: insets.bottom + 16 }}
            onKey={onKey}
            onBackspace={() => onKey('back')}
            onDone={() => setActiveField(null)}
          />
        ) : undefined
      }
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        {isEdit && (
          <View style={{ alignItems: 'flex-end', marginBottom: spacing.xs }}>
            <Pressable
              onPress={confirmDelete}
              disabled={busy}
              hitSlop={10}
              style={{ padding: 4, opacity: busy ? 0.4 : 1 }}
            >
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.expenseText }}>
                {deleting ? '삭제 중…' : '삭제'}
              </Text>
            </Pressable>
          </View>
        )}

        <Field label="자산 종류">
          <ChipSelect value={type} onChange={changeType} options={ASSET_TYPE_OPTIONS} />
        </Field>

        {/* 상세정보 — 선택한 종류에 필요한 입력만 보여준다 (현금/기타 자산은 없음). */}
        {institutionMode === 'select' && (
          <Field label="금융기관">
            <ChipSelect value={institution} onChange={setInstitution} options={BANK_INSTITUTION_OPTIONS} />
          </Field>
        )}
        {subtypeOptions.length > 0 && (
          <Field label={SUBTYPE_FIELD_LABEL[type] ?? '상세 종류'}>
            <ChipSelect value={subtype} onChange={setSubtype} options={subtypeOptions} />
          </Field>
        )}
        {institutionMode === 'text' && (
          <Field label="금융기관 · 증권사 (선택)">
            <TextField
              value={institution}
              onChangeText={setInstitution}
              onFocus={() => setActiveField(null)}
              placeholder="예: 키움증권, 토스증권, 업비트"
              maxLength={ASSET_INSTITUTION_MAX}
            />
          </Field>
        )}

        <Field label="자산 이름">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setActiveField(null)}
            placeholder="예: 생활비통장, 비상금 적금, 삼성전자 주식"
            maxLength={30}
          />
        </Field>

        <Field label="현재 금액">
          <NumFieldRow
            value={balance ? `${negative && Number(balance) > 0 ? '−' : ''}${fmt(Number(balance))}` : ''}
            suffix="원"
            active={activeField === 'balance'}
            onPress={() => openField('balance')}
          />
          {showSignToggle && (
            <Pressable onPress={() => setNegative((v) => !v)} hitSlop={6} style={{ marginTop: 6 }}>
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: colors.textSub }}>
                {negative ? '마이너스(−) 잔액이에요 · ' : '플러스 잔액이에요 · '}
                <Text style={{ fontFamily: fontFamily.bold, color: colors.primaryStrong }}>
                  {negative ? '플러스로 바꾸기' : '마이너스로 바꾸기'}
                </Text>
              </Text>
            </Pressable>
          )}
        </Field>
      </View>
    </ModalScreen>
  );
}

/** Tap target that shows a numeric value + unit and opens the shared NumPad. */
function NumFieldRow({
  value,
  suffix,
  active,
  onPress,
}: {
  value: string;
  suffix: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        paddingVertical: 12,
        paddingHorizontal: 14,
        backgroundColor: active ? colors.primaryLighter : colors.white,
        borderWidth: 1,
        borderColor: active ? colors.primaryLight : colors.border,
        borderRadius: radii.md,
      }}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: fontFamily.semibold,
          fontSize: 16,
          color: value ? colors.text : active ? colors.primaryStrong : colors.textMuted,
          ...tabularNums,
        }}
      >
        {value || '0'}
      </Text>
      <Text
        style={{
          fontFamily: fontFamily.medium,
          fontSize: 14,
          color: active ? colors.primaryStrong : colors.textSub,
          marginLeft: 6,
        }}
      >
        {suffix}
      </Text>
    </Pressable>
  );
}

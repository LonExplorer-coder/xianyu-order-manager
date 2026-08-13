import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';

import type { DesktopApi } from '../core/desktop-api';
import type {
  AftersalesCase,
  AftersalesStatus,
  AftersalesWorkflow,
  ProgressAftersalesCaseInput,
  ReturnInspectionResult,
} from '../core/aftersales-cases';
import { normalizeShanghaiDateTime } from '../core/order-normalization';
import type { ShipmentRecord } from '../core/shipment-records';
import { AFTERSALES_STATUS_OPTIONS } from './aftersales-presentation';

type ShipmentItem = ShipmentRecord['packages'][number]['items'][number];

export function CreateAftersalesCaseDialog({
  api,
  record,
  existingCases,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  record: ShipmentRecord;
  existingCases: AftersalesCase[];
  onApplied: (created: AftersalesCase) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogFocus();
  const sourceItems = activeShipmentRecordItems(record);
  const [occurredAt, setOccurredAt] = useState(currentShanghaiDateTimeLocal());
  const [workflow, setWorkflow] = useState<AftersalesWorkflow>('general');
  const [requestedRefundYuan, setRequestedRefundYuan] = useState('');
  const [reason, setReason] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(sourceItems.map(({ id }) => [id, 0])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedItems = selectedItemInputs(sourceItems, quantities);
  const requestedRefundCents = yuanToCents(requestedRefundYuan);
  const canSubmit = Boolean(
    reason.trim() &&
    occurredAt &&
    selectedItems.length > 0 &&
    (workflow === 'general' || requestedRefundCents !== null),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const localOccurredAt = occurredAt.length === 16 ? `${occurredAt}:00` : occurredAt;
      const normalizedOccurredAt = normalizeShanghaiDateTime(localOccurredAt.replace('T', ' '));
      if (!normalizedOccurredAt) throw new Error('请填写有效的售后发生时间');
      onApplied(await api.createAftersalesCase({
        shipmentRecordId: record.id,
        workflow,
        occurredAt: normalizedOccurredAt,
        reason,
        ...(workflow === 'general'
          ? {}
          : { requestedRefundCents: requestedRefundCents as number }),
        items: selectedItems,
      }));
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="order-export-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-package-action-dialog aftersales-case-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">发货记录 · 商品与数量</span>
          <h2 id={headingId}>建立售后处理单</h2>
          <p id={descriptionId}>只选择本次问题涉及的商品和数量；不会改写原发货记录或物流状态。</p>
        </header>
        <label>
          <span>售后处理方式</span>
          <select
            aria-label="售后处理方式"
            value={workflow}
            disabled={saving}
            onChange={(event) => setWorkflow(event.target.value as AftersalesWorkflow)}
          >
            <option value="general">一般处理</option>
            <option value="refund_only">仅退款</option>
            <option value="return_refund">退货退款</option>
          </select>
        </label>
        <label>
          <span>售后发生时间</span>
          <input
            type="datetime-local"
            step={1}
            aria-label="售后发生时间"
            value={occurredAt}
            disabled={saving}
            onChange={(event) => setOccurredAt(event.target.value)}
          />
        </label>
        <ReasonField label="问题原因" value={reason} saving={saving} onChange={setReason} />
        {workflow !== 'general' && (
          <label>
            <span>申请退款金额（元）</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              aria-label="申请退款金额"
              value={requestedRefundYuan}
              disabled={saving}
              onChange={(event) => setRequestedRefundYuan(event.target.value)}
            />
          </label>
        )}
        <AftersalesItemQuantityFields
          sourceItems={sourceItems}
          quantities={quantities}
          existingCases={existingCases}
          saving={saving}
          onChange={setQuantities}
        />
        <DialogFooter saving={saving} canSubmit={canSubmit} error={error} onClose={onClose} action="create" />
      </form>
    </div>,
    document.body,
  );
}

export function UpdateAftersalesCaseDialog({
  api,
  record,
  aftersalesCase,
  existingCases,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  record: ShipmentRecord;
  aftersalesCase: AftersalesCase;
  existingCases: AftersalesCase[];
  onApplied: (updated: AftersalesCase) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogFocus();
  const sourceItems = activeShipmentRecordItems(record);
  const [status, setStatus] = useState<AftersalesStatus>(aftersalesCase.status);
  const [reason, setReason] = useState(aftersalesCase.reason);
  const [changeReason, setChangeReason] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(sourceItems.map((item) => [
      item.id,
      aftersalesCase.items.find(({ shipmentPackageItemId }) => (
        shipmentPackageItemId === item.id
      ))?.quantity ?? 0,
    ])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedItems = selectedItemInputs(sourceItems, quantities);
  const canSubmit = Boolean(reason.trim() && changeReason.trim() && selectedItems.length > 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !canSubmit) return;
    setSaving(true);
    setError('');
    try {
      onApplied(await api.updateAftersalesCase({
        caseId: aftersalesCase.id,
        expectedRevision: aftersalesCase.revision,
        status,
        reason,
        items: selectedItems,
        changeReason,
      }));
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="order-export-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-package-action-dialog aftersales-case-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">售后处理单 · 第 {aftersalesCase.revision} 版</span>
          <h2 id={headingId}>更新售后处理</h2>
          <p id={descriptionId}>状态、问题原因与商品数量的变化会作为新事件保留。</p>
        </header>
        <label>
          <span>售后状态</span>
          <select
            aria-label="售后状态"
            value={status}
            disabled={saving}
            onChange={(event) => setStatus(event.target.value as AftersalesStatus)}
          >
            {AFTERSALES_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <ReasonField label="问题原因" value={reason} saving={saving} onChange={setReason} />
        <AftersalesItemQuantityFields
          sourceItems={sourceItems}
          quantities={quantities}
          existingCases={existingCases}
          excludedCaseId={aftersalesCase.id}
          releasesQuantity={status === 'completed' || status === 'cancelled'}
          saving={saving}
          onChange={setQuantities}
        />
        <ReasonField label="本次变更原因" value={changeReason} saving={saving} onChange={setChangeReason} />
        <DialogFooter saving={saving} canSubmit={canSubmit} error={error} onClose={onClose} action="update" />
      </form>
    </div>,
    document.body,
  );
}

export function ProgressAftersalesCaseDialog({
  aftersalesCase,
  kind,
  onProgress,
  onClose,
}: {
  aftersalesCase: AftersalesCase;
  kind: ProgressAftersalesCaseInput['kind'];
  onProgress: (input: ProgressAftersalesCaseInput) => Promise<void>;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogFocus();
  const [occurredAt, setOccurredAt] = useState(currentShanghaiDateTimeLocal());
  const [reason, setReason] = useState('');
  const [amountYuan, setAmountYuan] = useState('');
  const [shippingCarrier, setShippingCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [inspectionResult, setInspectionResult] = useState<ReturnInspectionResult>('resellable');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const amountCents = yuanToCents(amountYuan);
  const returnRecordId = aftersalesCase.returns[0]?.id;
  const canSubmit = kind === 'confirm_refund'
    ? Boolean(reason.trim() && occurredAt && amountCents !== null)
    : kind === 'register_return'
      ? Boolean(reason.trim() && occurredAt && shippingCarrier.trim() && trackingNumber.trim())
      : kind === 'receive_return' || kind === 'inspect_return'
        ? Boolean(reason.trim() && occurredAt && returnRecordId)
        : Boolean(reason.trim());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const common = {
        caseId: aftersalesCase.id,
        expectedRevision: aftersalesCase.revision,
      };
      const normalizedOccurredAt = kind === 'complete' || kind === 'cancel'
        ? null
        : normalizeActionDateTime(occurredAt);
      const input: ProgressAftersalesCaseInput = kind === 'confirm_refund'
        ? {
          kind,
          ...common,
          actualRefundCents: amountCents as number,
          occurredAt: normalizedOccurredAt as string,
          note: reason,
        }
        : kind === 'register_return'
          ? {
            kind,
            ...common,
            shippingCarrier,
            trackingNumber,
            occurredAt: normalizedOccurredAt as string,
            reason,
          }
          : kind === 'receive_return'
            ? {
              kind,
              ...common,
              returnRecordId: returnRecordId as string,
              occurredAt: normalizedOccurredAt as string,
              reason,
            }
            : kind === 'inspect_return'
              ? {
                kind,
                ...common,
                returnRecordId: returnRecordId as string,
                result: inspectionResult,
                occurredAt: normalizedOccurredAt as string,
                note: reason,
              }
              : { kind, ...common, reason };
      await onProgress(input);
      onClose();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSaving(false);
    }
  }

  const copy = progressDialogCopy(kind);
  return createPortal(
    <div
      ref={dialogRef}
      className="order-export-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-package-action-dialog aftersales-case-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">售后处理 · 第 {aftersalesCase.revision} 版</span>
          <h2 id={headingId}>{copy.title}</h2>
          <p id={descriptionId}>{copy.description}</p>
        </header>
        {kind !== 'complete' && kind !== 'cancel' && (
          <label>
            <span>{copy.timeLabel}</span>
            <input
              type="datetime-local"
              step={1}
              aria-label={copy.timeLabel}
              value={occurredAt}
              disabled={saving}
              onChange={(event) => setOccurredAt(event.target.value)}
            />
          </label>
        )}
        {kind === 'register_return' && (
          <>
            <label>
              <span>退货承运方</span>
              <input
                aria-label="退货承运方"
                value={shippingCarrier}
                maxLength={100}
                disabled={saving}
                onChange={(event) => setShippingCarrier(event.target.value)}
              />
            </label>
            <label>
              <span>退货运单号</span>
              <input
                aria-label="退货运单号"
                value={trackingNumber}
                maxLength={200}
                disabled={saving}
                onChange={(event) => setTrackingNumber(event.target.value)}
              />
            </label>
          </>
        )}
        {kind === 'confirm_refund' && (
          <label>
            <span>实际退款金额（元）</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              aria-label="实际退款金额"
              value={amountYuan}
              disabled={saving}
              onChange={(event) => setAmountYuan(event.target.value)}
            />
          </label>
        )}
        {kind === 'inspect_return' && (
          <label>
            <span>退货检查结果</span>
            <select
              aria-label="退货检查结果"
              value={inspectionResult}
              disabled={saving}
              onChange={(event) => setInspectionResult(event.target.value as ReturnInspectionResult)}
            >
              <option value="resellable">可再次销售</option>
              <option value="defective">瑕疵品</option>
              <option value="scrapped">报废</option>
              <option value="other">其他</option>
            </select>
          </label>
        )}
        <ReasonField label={copy.reasonLabel} value={reason} saving={saving} onChange={setReason} />
        {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
        <footer>
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            返回
          </button>
          <button className="button button--primary" type="submit" disabled={saving || !canSubmit}>
            {saving ? '正在保存…' : copy.confirmLabel}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function AftersalesItemQuantityFields({
  sourceItems,
  quantities,
  existingCases,
  excludedCaseId,
  releasesQuantity = false,
  saving,
  onChange,
}: {
  sourceItems: readonly ShipmentItem[];
  quantities: Readonly<Record<string, number>>;
  existingCases: readonly AftersalesCase[];
  excludedCaseId?: string;
  releasesQuantity?: boolean;
  saving: boolean;
  onChange: (quantities: Record<string, number>) => void;
}) {
  return (
    <fieldset>
      <legend>涉及商品与数量</legend>
      <div className="aftersales-case-dialog__items">
        {sourceItems.map((item) => {
          const available = releasesQuantity
            ? item.quantity
            : availableAftersalesQuantity(item.id, item.quantity, existingCases, excludedCaseId);
          return (
            <label key={item.id}>
              <span>
                <strong>{item.sourceTitle}</strong>
                <small>{item.orderNumber}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</small>
              </span>
              <input
                type="number"
                min={0}
                max={available}
                step={1}
                aria-label={`${item.orderNumber} ${item.sourceTitle} 售后数量`}
                value={quantities[item.id] ?? 0}
                disabled={saving || (!excludedCaseId && available === 0)}
                onChange={(event) => onChange({
                  ...quantities,
                  [item.id]: Math.min(
                    available,
                    Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                  ),
                })}
              />
              <small>最多可处理 {available}</small>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ReasonField({
  label,
  value,
  saving,
  onChange,
}: {
  label: string;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <textarea
        aria-label={label}
        value={value}
        maxLength={500}
        disabled={saving}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function DialogFooter({
  saving,
  canSubmit,
  error,
  onClose,
  action,
}: {
  saving: boolean;
  canSubmit: boolean;
  error: string;
  onClose: () => void;
  action: 'create' | 'update';
}) {
  return (
    <>
      {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
      <footer>
        <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
          取消
        </button>
        <button className="button button--primary" type="submit" disabled={saving || !canSubmit}>
          {saving
            ? action === 'create' ? '正在建立…' : '正在更新…'
            : action === 'create' ? '确认建立' : '确认更新'}
        </button>
      </footer>
    </>
  );
}

function useDialogFocus() {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);
  return dialogRef;
}

function activeShipmentRecordItems(record: ShipmentRecord): ShipmentItem[] {
  return record.packages
    .filter(({ status }) => status === 'active')
    .flatMap(({ items }) => items);
}

function selectedItemInputs(
  sourceItems: readonly ShipmentItem[],
  quantities: Readonly<Record<string, number>>,
) {
  return sourceItems.flatMap((item) => {
    const quantity = quantities[item.id] ?? 0;
    return quantity > 0 ? [{ shipmentPackageItemId: item.id, quantity }] : [];
  });
}

function availableAftersalesQuantity(
  shipmentPackageItemId: string,
  sourceQuantity: number,
  cases: readonly AftersalesCase[],
  excludedCaseId?: string,
): number {
  const allocated = cases
    .filter((aftersalesCase) => (
      aftersalesCase.id !== excludedCaseId &&
      aftersalesCase.status !== 'completed' &&
      aftersalesCase.status !== 'cancelled'
    ))
    .flatMap(({ items }) => items)
    .filter((item) => item.shipmentPackageItemId === shipmentPackageItemId)
    .reduce((total, item) => total + item.quantity, 0);
  return Math.max(sourceQuantity - allocated, 0);
}

function currentShanghaiDateTimeLocal(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 19);
}

function normalizeActionDateTime(value: string): string {
  const localValue = value.length === 16 ? `${value}:00` : value;
  const normalized = normalizeShanghaiDateTime(localValue.replace('T', ' '));
  if (!normalized) throw new Error('请填写有效的发生时间');
  return normalized;
}

function progressDialogCopy(kind: ProgressAftersalesCaseInput['kind']) {
  if (kind === 'register_return') return {
    title: '登记退货物流',
    description: '这里只记录买家寄回的实物流转，不改变原包裹物流。',
    timeLabel: '退货寄出时间',
    reasonLabel: '退货登记说明',
    confirmLabel: '确认登记',
  };
  if (kind === 'receive_return') return {
    title: '确认收到退货',
    description: '收到后进入待检查，不会自动增加可销售库存。',
    timeLabel: '退货收到时间',
    reasonLabel: '退货收到说明',
    confirmLabel: '确认收到',
  };
  if (kind === 'inspect_return') return {
    title: '记录退货检查',
    description: '检查结果作为未来库存处理依据，不直接改动库存。',
    timeLabel: '退货检查时间',
    reasonLabel: '退货检查说明',
    confirmLabel: '确认检查',
  };
  if (kind === 'confirm_refund') return {
    title: '确认实际退款',
    description: '以平台账单、实际支付或人工核对结果建立独立资金记录。',
    timeLabel: '实际退款时间',
    reasonLabel: '退款确认说明',
    confirmLabel: '确认退款',
  };
  if (kind === 'complete') return {
    title: '完成售后',
    description: '退款和必要的退货事实已齐全，完成后历史仍保持可查。',
    timeLabel: '',
    reasonLabel: '完成原因',
    confirmLabel: '确认完成',
  };
  return {
    title: '取消售后',
    description: '只取消尚未确认的退款申请，已经发生的退货事实继续保留。',
    timeLabel: '',
    reasonLabel: '取消原因',
    confirmLabel: '确认取消',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}

function yuanToCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const [yuan, fraction = ''] = normalized.split('.');
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

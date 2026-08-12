import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';

import type { DesktopApi } from '../core/desktop-api';
import type { AftersalesCase, AftersalesStatus } from '../core/aftersales-cases';
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
  const [reason, setReason] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(sourceItems.map(({ id }) => [id, 0])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedItems = selectedItemInputs(sourceItems, quantities);
  const canSubmit = Boolean(reason.trim() && occurredAt && selectedItems.length > 0);

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
        occurredAt: normalizedOccurredAt,
        reason,
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
          releasesQuantity={status === 'completed'}
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
      aftersalesCase.id !== excludedCaseId && aftersalesCase.status !== 'completed'
    ))
    .flatMap(({ items }) => items)
    .filter((item) => item.shipmentPackageItemId === shipmentPackageItemId)
    .reduce((total, item) => total + item.quantity, 0);
  return Math.max(sourceQuantity - allocated, 0);
}

function currentShanghaiDateTimeLocal(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 19);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}

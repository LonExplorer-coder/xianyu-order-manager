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
  AftersalesReturnDiscrepancy,
  AftersalesReturnLogisticsStatus,
  ProgressAftersalesCaseInput,
  ReturnInspectionResult,
} from '../core/aftersales-cases';
import { normalizeShanghaiDateTime } from '../core/order-normalization';
import type { ShipmentRecord } from '../core/shipment-records';
import { AFTERSALES_STATUS_OPTIONS } from './aftersales-presentation';
import {
  LOGISTICS_EXCEPTION_TYPE_OPTIONS,
  logisticsExceptionStageLabel,
  nextLogisticsExceptionStages,
} from './logistics-presentation';

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
  returnRecordId,
  onProgress,
  onClose,
}: {
  aftersalesCase: AftersalesCase;
  kind: ProgressAftersalesCaseInput['kind'];
  returnRecordId?: string;
  onProgress: (input: ProgressAftersalesCaseInput) => Promise<void>;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogFocus();
  const returnRecord = aftersalesCase.returns.find(({ id }) => id === returnRecordId)
    ?? aftersalesCase.returns[0];
  const [occurredAt, setOccurredAt] = useState(currentShanghaiDateTimeLocal());
  const [reason, setReason] = useState('');
  const [amountYuan, setAmountYuan] = useState('');
  const [shippingCarrier, setShippingCarrier] = useState(
    kind === 'correct_return_logistics' ? returnRecord?.shippingCarrier ?? '' : '',
  );
  const [trackingNumber, setTrackingNumber] = useState(
    kind === 'correct_return_logistics' ? returnRecord?.trackingNumber ?? '' : '',
  );
  const [combineWithExisting, setCombineWithExisting] = useState(false);
  const [logisticsStatus, setLogisticsStatus] = useState<AftersalesReturnLogisticsStatus>(
    returnRecord?.logisticsStatus ?? 'in_transit',
  );
  const [carrierAcceptanceConfirmed, setCarrierAcceptanceConfirmed] = useState(false);
  const [exceptionType, setExceptionType] = useState<
    'lost' | 'delivery_dispute' | 'damaged' | 'misdelivered' | 'other'
  >('lost');
  const exceptionStageOptions = kind === 'progress_return_logistics_exception'
    && returnRecord?.currentException
    ? nextLogisticsExceptionStages(
      returnRecord.currentException.exceptionType,
      returnRecord.currentException.stage,
    )
    : ['pending_verification', 'investigating', 'confirmed'] as const;
  const [exceptionStage, setExceptionStage] = useState<
    'pending_verification' | 'investigating' | 'confirmed' | 'recovered' | 'resolved'
  >(exceptionStageOptions[0]);
  const [carrierConfirmedLoss, setCarrierConfirmedLoss] = useState(false);
  const activeExceptionType = kind === 'progress_return_logistics_exception'
    ? returnRecord?.currentException?.exceptionType
    : exceptionType;
  const [claimOutcome, setClaimOutcome] = useState<'approved' | 'rejected'>('approved');
  const [inspectionResult, setInspectionResult] = useState<ReturnInspectionResult>('resellable');
  const [inspectionResults, setInspectionResults] = useState<Record<string, ReturnInspectionResult>>(
    Object.fromEntries((returnRecord?.items ?? []).map((item) => [
      item.id,
      item.inspectionResult ?? 'resellable',
    ])),
  );
  const [receivedQuantities, setReceivedQuantities] = useState<Record<string, number>>(
    Object.fromEntries((returnRecord?.items ?? []).map((item) => [item.id, item.quantity])),
  );
  const [acceptedQuantities, setAcceptedQuantities] = useState<Record<string, number>>(
    Object.fromEntries((returnRecord?.items ?? []).map((item) => [item.id, item.receivedQuantity])),
  );
  const [discrepancies, setDiscrepancies] = useState<AftersalesReturnDiscrepancy[]>(
    returnRecord?.discrepancies ?? [],
  );
  const [differenceKind, setDifferenceKind] = useState<AftersalesReturnDiscrepancy['kind']>('missing');
  const [differenceReturnRecordItemId, setDifferenceReturnRecordItemId] = useState('');
  const [differenceQuantity, setDifferenceQuantity] = useState(1);
  const [differenceNote, setDifferenceNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const amountCents = yuanToCents(amountYuan);
  const needsAmount = kind === 'confirm_refund'
    || kind === 'open_carrier_claim'
    || kind === 'confirm_carrier_compensation'
    || (kind === 'resolve_carrier_claim' && claimOutcome === 'approved');
  const needsLogisticsIdentity = kind === 'register_return' || kind === 'correct_return_logistics';
  const needsReturnRecord = kind === 'receive_return' || kind === 'inspect_return'
    || kind === 'correct_return_logistics' || kind === 'update_return_logistics_status'
    || kind === 'record_return_logistics_exception'
    || kind === 'progress_return_logistics_exception'
    || kind === 'open_carrier_claim' || kind === 'resolve_carrier_claim'
    || kind === 'confirm_carrier_compensation';
  const canSubmit = Boolean(
    reason.trim()
    && (kind === 'complete' || kind === 'cancel' || occurredAt)
    && (!needsAmount || amountCents !== null)
    && (!needsLogisticsIdentity || (shippingCarrier.trim() && trackingNumber.trim()))
    && (!needsReturnRecord || returnRecord)
    && !((kind === 'record_return_logistics_exception'
      || kind === 'progress_return_logistics_exception')
      && activeExceptionType === 'lost' && exceptionStage === 'confirmed'
      && !carrierConfirmedLoss)
    && !(kind === 'update_return_logistics_status'
      && logisticsStatus === 'awaiting_carrier'
      && (carrierAcceptanceConfirmed || returnRecord?.carrierAcceptedAt != null)),
  );

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
      const targetId = returnRecord?.id as string;
      let input: ProgressAftersalesCaseInput;
      switch (kind) {
        case 'register_return':
          input = {
            kind, ...common, shippingCarrier, trackingNumber,
            ...(combineWithExisting ? { combineWithExisting: true } : {}),
            occurredAt: normalizedOccurredAt as string, reason,
          };
          break;
        case 'receive_return':
          input = {
            kind, ...common, returnRecordId: targetId,
            occurredAt: normalizedOccurredAt as string, reason,
            items: (returnRecord?.items ?? []).map((item) => ({
              returnRecordItemId: item.id,
              receivedQuantity: receivedQuantities[item.id] ?? 0,
            })),
            discrepancies,
          };
          break;
        case 'inspect_return':
          input = {
            kind, ...common, returnRecordId: targetId, result: inspectionResult,
            occurredAt: normalizedOccurredAt as string, note: reason,
            items: (returnRecord?.items ?? []).map((item) => ({
              returnRecordItemId: item.id,
              acceptedQuantity: acceptedQuantities[item.id] ?? 0,
              result: inspectionResults[item.id] ?? inspectionResult,
              note: reason,
            })),
            discrepancies,
          };
          break;
        case 'correct_return_logistics':
          input = {
            kind, ...common, returnRecordId: targetId, shippingCarrier, trackingNumber,
            occurredAt: normalizedOccurredAt as string, reason,
          };
          break;
        case 'update_return_logistics_status':
          input = {
            kind, ...common, returnRecordId: targetId, logisticsStatus,
            carrierAcceptanceConfirmed,
            occurredAt: normalizedOccurredAt as string, reason,
          };
          break;
        case 'record_return_logistics_exception':
          input = {
            kind, ...common, returnRecordId: targetId,
            exceptionType,
            stage: exceptionStage as 'pending_verification' | 'investigating' | 'confirmed',
            impact: { scope: 'package' },
            ...(exceptionType === 'lost' && exceptionStage === 'confirmed'
              ? { carrierConfirmedLoss: true }
              : {}),
            occurredAt: normalizedOccurredAt as string, reason,
          };
          break;
        case 'progress_return_logistics_exception':
          input = {
            kind, ...common, returnRecordId: targetId,
            exceptionId: returnRecord?.currentException?.id as string,
            expectedExceptionRevision: returnRecord?.currentException?.revision as number,
            stage: exceptionStage as 'investigating' | 'confirmed' | 'recovered' | 'resolved',
            ...(returnRecord?.currentException?.exceptionType === 'lost'
              && exceptionStage === 'confirmed' ? { carrierConfirmedLoss: true } : {}),
            occurredAt: normalizedOccurredAt as string, reason,
          };
          break;
        case 'open_carrier_claim':
          input = {
            kind, ...common, returnRecordId: targetId,
            requestedAmountCents: amountCents as number,
            occurredAt: normalizedOccurredAt as string, reason,
          };
          break;
        case 'resolve_carrier_claim':
          input = {
            kind, ...common, returnRecordId: targetId,
            expectedClaimRevision: returnRecord?.carrierClaim?.revision as number,
            outcome: claimOutcome,
            ...(claimOutcome === 'approved'
              ? { approvedAmountCents: amountCents as number }
              : {}),
            occurredAt: normalizedOccurredAt as string, reason,
          };
          break;
        case 'confirm_carrier_compensation':
          input = {
            kind, ...common, returnRecordId: targetId,
            expectedClaimRevision: returnRecord?.carrierClaim?.revision as number,
            amountCents: amountCents as number,
            occurredAt: normalizedOccurredAt as string, note: reason,
          };
          break;
        case 'confirm_refund':
          input = {
            kind, ...common, actualRefundCents: amountCents as number,
            occurredAt: normalizedOccurredAt as string, note: reason,
          };
          break;
        case 'complete':
        case 'cancel':
          input = { kind, ...common, reason };
          break;
      }
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
        {(kind === 'register_return' || kind === 'correct_return_logistics') && (
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
        {kind === 'register_return' && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={combineWithExisting}
              disabled={saving}
              onChange={(event) => setCombineWithExisting(event.target.checked)}
            />
            <span>确认同一运单属于合装退货，关联到已有退货包裹</span>
          </label>
        )}
        {kind === 'update_return_logistics_status' && (
          <>
            <label>
              <span>最新退货物流状态</span>
              <select
                aria-label="最新退货物流状态"
                value={logisticsStatus}
                disabled={saving}
                onChange={(event) => setLogisticsStatus(event.target.value as AftersalesReturnLogisticsStatus)}
              >
                {RETURN_LOGISTICS_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={carrierAcceptanceConfirmed}
                disabled={saving}
                onChange={(event) => setCarrierAcceptanceConfirmed(event.target.checked)}
              />
              <span>已核对承运方揽收证据</span>
            </label>
          </>
        )}
        {(kind === 'record_return_logistics_exception'
          || kind === 'progress_return_logistics_exception') && (
          <>
            {kind === 'record_return_logistics_exception' && (
              <label>
                <span>异常类型</span>
                <select aria-label="退货物流异常类型" value={exceptionType}
                  onChange={(event) => setExceptionType(event.target.value as typeof exceptionType)}>
                  {LOGISTICS_EXCEPTION_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              <span>异常处理阶段</span>
              <select aria-label="退货物流异常处理阶段" value={exceptionStage}
                onChange={(event) => setExceptionStage(event.target.value as typeof exceptionStage)}>
                {exceptionStageOptions.map((value) => (
                  <option key={value} value={value}>{logisticsExceptionStageLabel(value)}</option>
                ))}
              </select>
            </label>
            {((kind === 'record_return_logistics_exception' && exceptionType === 'lost')
              || (kind === 'progress_return_logistics_exception'
                && returnRecord?.currentException?.exceptionType === 'lost'))
              && exceptionStage === 'confirmed' && (
              <label className="checkbox-row">
                <input type="checkbox" checked={carrierConfirmedLoss}
                  onChange={(event) => setCarrierConfirmedLoss(event.target.checked)} />
                <span>已核对承运方的丢件结论</span>
              </label>
            )}
          </>
        )}
        {kind === 'resolve_carrier_claim' && (
          <label>
            <span>承运索赔结果</span>
            <select
              aria-label="承运索赔结果"
              value={claimOutcome}
              disabled={saving}
              onChange={(event) => setClaimOutcome(event.target.value as 'approved' | 'rejected')}
            >
              <option value="approved">同意赔付</option>
              <option value="rejected">拒绝赔付</option>
            </select>
          </label>
        )}
        {(kind === 'confirm_refund' || kind === 'open_carrier_claim'
          || kind === 'confirm_carrier_compensation'
          || (kind === 'resolve_carrier_claim' && claimOutcome === 'approved')) && (
          <label>
            <span>{progressAmountLabel(kind)}</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              aria-label={progressAmountAriaLabel(kind)}
              value={amountYuan}
              disabled={saving}
              onChange={(event) => setAmountYuan(event.target.value)}
            />
          </label>
        )}
        {(kind === 'receive_return' || kind === 'inspect_return') && returnRecord && (
          <fieldset>
            <legend>{kind === 'receive_return' ? '各商品实际收到数量' : '各商品检查通过数量'}</legend>
            <div className="aftersales-case-dialog__items">
              {returnRecord.items.map((item) => (
                <label key={item.id}>
                  <span>
                    <strong>{item.sourceTitle}</strong>
                    <small>{item.orderNumber}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</small>
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    aria-label={`${item.sourceTitle} ${kind === 'receive_return' ? '实际收到数量' : '检查通过数量'}`}
                    value={kind === 'receive_return'
                      ? receivedQuantities[item.id] ?? 0
                      : acceptedQuantities[item.id] ?? 0}
                    disabled={saving}
                    onChange={(event) => {
                      const quantity = Math.max(0, Number.parseInt(event.target.value, 10) || 0);
                      if (kind === 'receive_return') {
                        setReceivedQuantities({ ...receivedQuantities, [item.id]: quantity });
                      } else {
                        setAcceptedQuantities({
                          ...acceptedQuantities,
                          [item.id]: Math.min(item.receivedQuantity, quantity),
                        });
                      }
                    }}
                  />
                  <small>{kind === 'receive_return'
                    ? `计划退回 ${item.quantity}`
                    : `实际收到 ${item.receivedQuantity}`}</small>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {kind === 'inspect_return' && (
          <label>
            <span>退货检查结果</span>
            <select
              aria-label="退货检查结果"
              value={inspectionResult}
              disabled={saving}
              onChange={(event) => {
                const result = event.target.value as ReturnInspectionResult;
                setInspectionResult(result);
                setInspectionResults(Object.fromEntries(
                  (returnRecord?.items ?? []).map((item) => [item.id, result]),
                ));
              }}
            >
              <option value="resellable">可再次销售</option>
              <option value="defective">瑕疵品</option>
              <option value="scrapped">报废</option>
              <option value="other">其他</option>
            </select>
          </label>
        )}
        {kind === 'inspect_return' && returnRecord && (
          <fieldset>
            <legend>各商品检查结果</legend>
            <div className="aftersales-case-dialog__items">
              {returnRecord.items.map((item) => (
                <label key={item.id}>
                  <span>
                    <strong>{item.sourceTitle}</strong>
                    <small>{item.sourceSpec || '无款式或规格'}</small>
                  </span>
                  <select
                    aria-label={`${item.sourceTitle} 单项检查结果`}
                    value={inspectionResults[item.id] ?? inspectionResult}
                    disabled={saving}
                    onChange={(event) => setInspectionResults({
                      ...inspectionResults,
                      [item.id]: event.target.value as ReturnInspectionResult,
                    })}
                  >
                    <option value="resellable">可再次销售</option>
                    <option value="defective">瑕疵品</option>
                    <option value="scrapped">报废</option>
                    <option value="other">其他</option>
                  </select>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {(kind === 'receive_return' || kind === 'inspect_return') && (
          <fieldset>
            <legend>退货检查差异（可选）</legend>
            <label>
              <span>差异归属</span>
              <select
                aria-label="差异归属"
                value={differenceReturnRecordItemId}
                disabled={saving}
                onChange={(event) => setDifferenceReturnRecordItemId(event.target.value)}
              >
                <option value="">整个退货包裹</option>
                {(returnRecord?.items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>差异类型</span>
              <select
                aria-label="差异类型"
                value={differenceKind}
                disabled={saving}
                onChange={(event) => setDifferenceKind(event.target.value as AftersalesReturnDiscrepancy['kind'])}
              >
                {RETURN_DISCREPANCY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>差异数量</span>
              <input
                type="number"
                min={0}
                step={1}
                aria-label="差异数量"
                value={differenceQuantity}
                disabled={saving}
                onChange={(event) => setDifferenceQuantity(Math.max(0, Number.parseInt(event.target.value, 10) || 0))}
              />
            </label>
            <label>
              <span>差异说明</span>
              <input
                aria-label="差异说明"
                value={differenceNote}
                maxLength={500}
                disabled={saving}
                onChange={(event) => setDifferenceNote(event.target.value)}
              />
            </label>
            <button
              className="button button--quiet"
              type="button"
              disabled={saving || !differenceNote.trim()}
              onClick={() => {
                setDiscrepancies([...discrepancies, {
                  kind: differenceKind,
                  quantity: differenceQuantity,
                  note: differenceNote.trim(),
                  ...(differenceReturnRecordItemId
                    ? { returnRecordItemId: differenceReturnRecordItemId }
                    : {}),
                }]);
                setDifferenceNote('');
              }}
            >
              添加差异
            </button>
            {discrepancies.length > 0 && (
              <ul aria-label="已登记退货差异">
                {discrepancies.map((difference, index) => (
                  <li key={`${difference.kind}-${index}`}>
                    <span>
                      {difference.returnRecordItemId
                        ? `${returnRecord?.items.find(({ id }) => id === difference.returnRecordItemId)?.sourceTitle ?? '指定商品'} · `
                        : '整个包裹 · '}
                      {returnDiscrepancyOptionLabel(difference.kind)} {difference.quantity} 件 · {difference.note}
                    </span>
                    <button
                      className="button button--quiet"
                      type="button"
                      onClick={() => setDiscrepancies(discrepancies.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
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
  if (kind === 'correct_return_logistics') return {
    title: '更正退货物流',
    description: '当前信息更新为正确值，旧承运方、运单号和更正原因会保留在历史中；已有收到和检查事实不会被清空。',
    timeLabel: '物流更正时间',
    reasonLabel: '更正原因',
    confirmLabel: '确认更正',
  };
  if (kind === 'update_return_logistics_status') return {
    title: '更新退货物流状态',
    description: '只记录已人工核对的真实物流事实，不会自动判断责任、退款或库存处置。',
    timeLabel: '状态发生时间',
    reasonLabel: '状态核对说明',
    confirmLabel: '确认更新',
  };
  if (kind === 'record_return_logistics_exception') return {
    title: '登记退货物流异常',
    description: '异常事项与正常退货运输事实分别保存，不会自动决定退款或责任。',
    timeLabel: '异常发生时间',
    reasonLabel: '异常说明',
    confirmLabel: '确认登记',
  };
  if (kind === 'progress_return_logistics_exception') return {
    title: '推进退货物流异常',
    description: '只追加核实进展；找回或解决不会删除退款、检查或索赔历史。',
    timeLabel: '阶段发生时间',
    reasonLabel: '阶段说明',
    confirmLabel: '确认推进',
  };
  if (kind === 'open_carrier_claim') return {
    title: '建立承运索赔',
    description: '承运索赔与买家退款分别推进，申请金额不会自动生成退款。',
    timeLabel: '索赔建立时间',
    reasonLabel: '索赔原因',
    confirmLabel: '确认建立',
  };
  if (kind === 'resolve_carrier_claim') return {
    title: '登记承运索赔结果',
    description: '保留同意或拒赔结果、金额和原因，不反向修改已发生的买家退款。',
    timeLabel: '索赔结果时间',
    reasonLabel: '索赔结果说明',
    confirmLabel: '确认结果',
  };
  if (kind === 'confirm_carrier_compensation') return {
    title: '确认实际赔付',
    description: '实际到账金额作为独立资金事实保存，供后续财务模块读取。',
    timeLabel: '实际赔付时间',
    reasonLabel: '赔付确认说明',
    confirmLabel: '确认赔付',
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

const RETURN_LOGISTICS_STATUS_OPTIONS: ReadonlyArray<{
  value: AftersalesReturnLogisticsStatus;
  label: string;
}> = [
  { value: 'awaiting_carrier', label: '待承运方接收' },
  { value: 'in_transit', label: '运输中' },
  { value: 'delivered', label: '已签收' },
  { value: 'returned', label: '已退回' },
];

const RETURN_DISCREPANCY_OPTIONS: ReadonlyArray<{
  value: AftersalesReturnDiscrepancy['kind'];
  label: string;
}> = [
  { value: 'missing', label: '少件' },
  { value: 'empty_package', label: '空包' },
  { value: 'wrong_item', label: '错货' },
  { value: 'excess', label: '多退' },
  { value: 'mixed', label: '混装' },
  { value: 'damaged', label: '损坏' },
  { value: 'missing_accessory', label: '配件缺失' },
  { value: 'unidentified', label: '无法识别' },
];

function returnDiscrepancyOptionLabel(kind: AftersalesReturnDiscrepancy['kind']): string {
  return RETURN_DISCREPANCY_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function progressAmountLabel(kind: ProgressAftersalesCaseInput['kind']): string {
  if (kind === 'confirm_refund') return '实际退款金额（元）';
  if (kind === 'open_carrier_claim') return '申请索赔金额（元）';
  if (kind === 'confirm_carrier_compensation') return '实际赔付金额（元）';
  return '承运方同意赔付金额（元）';
}

function progressAmountAriaLabel(kind: ProgressAftersalesCaseInput['kind']): string {
  return progressAmountLabel(kind).replace('（元）', '');
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

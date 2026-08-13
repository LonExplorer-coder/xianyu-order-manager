import { useState } from 'react';

import type {
  AftersalesCase,
  AftersalesCaseUpdatedEvent,
  ProgressAftersalesCaseInput,
} from '../core/aftersales-cases';
import type { ShipmentRecord } from '../core/shipment-records';
import {
  aftersalesStatusLabel,
  carrierClaimStatusLabel,
  returnDiscrepancyLabel,
  returnLogisticsStatusLabel,
  returnQuantityDifferenceSummary,
} from './aftersales-presentation';
import { ProgressAftersalesCaseDialog } from './AftersalesCaseDialogs';

export function AftersalesCasePanel({
  record,
  aftersalesCases,
  focusedCaseId,
  onUpdate,
  onProgress,
}: {
  record: ShipmentRecord;
  aftersalesCases: readonly AftersalesCase[];
  focusedCaseId?: string;
  onUpdate: (aftersalesCase: AftersalesCase) => void;
  onProgress: (input: ProgressAftersalesCaseInput) => Promise<void>;
}) {
  const [progressTarget, setProgressTarget] = useState<{
    aftersalesCase: AftersalesCase;
    kind: ProgressAftersalesCaseInput['kind'];
    returnRecordId?: string;
  } | null>(null);
  if (aftersalesCases.length === 0) return null;
  return (
    <div className="shipment-record-card__aftersales" aria-label="售后处理单">
      {aftersalesCases.map((aftersalesCase) => (
        <section
          id={`aftersales-case-${aftersalesCase.id}`}
          key={aftersalesCase.id}
          className={focusedCaseId === aftersalesCase.id ? 'is-focused' : undefined}
          role="region"
          aria-label={`售后处理单 ${aftersalesCase.id}`}
          tabIndex={-1}
        >
          <header>
            <strong>
              {aftersalesWorkflowLabel(aftersalesCase.workflow)} · {' '}
              {aftersalesStatusLabel(aftersalesCase.status)}
            </strong>
            <span>{formatDateTime(aftersalesCase.occurredAt)}</span>
          </header>
          <p>{aftersalesCase.reason}</p>
          <ul>
            {aftersalesCase.items.map((item) => (
              <li key={item.id}>
                <span>{item.orderNumber} · {item.sourceTitle}
                  {item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</span>
                <strong>× {item.quantity}</strong>
              </li>
            ))}
          </ul>
          {aftersalesCase.refund && (
            <div className="shipment-record-card__aftersales-facts" aria-label="退款事实">
              <span>申请退款 <strong>{formatMoney(aftersalesCase.refund.requestedAmountCents)}</strong></span>
              {aftersalesCase.refund.actualRecord ? (
                <span>实际退款 <strong>{formatMoney(aftersalesCase.refund.actualRecord.amountCents)}</strong></span>
              ) : (
                <span>{aftersalesCase.refund.status === 'cancelled' ? '退款申请已取消' : '实际退款待确认'}</span>
              )}
            </div>
          )}
          {aftersalesCase.returns.map((returnRecord) => (
            <section
              className="shipment-record-card__return-record"
              key={returnRecord.id}
              aria-label={`退货包裹 ${returnRecord.id}`}
            >
              <header>
                <strong>退货包裹 · {returnLogisticsStatusLabel(returnRecord.logisticsStatus)}</strong>
                <span>{returnStatusLabel(returnRecord.status)}</span>
              </header>
              <p className="shipment-record-card__return-logistics">
                <strong>{returnRecord.shippingCarrier} · {returnRecord.trackingNumber}</strong>
              </p>
              {lastLogisticsCorrection(returnRecord) && (
                <small>
                  物流信息已更正 · {formatDateTime(lastLogisticsCorrection(returnRecord)?.occurredAt as string)}
                </small>
              )}
              <ul aria-label="退货商品真实数量">
                {returnRecord.items.map((item) => (
                  <li key={item.id}>
                    <span>{item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</span>
                    <strong>
                      计划 {item.quantity} · 收到 {item.receivedQuantity} · 通过 {item.acceptedQuantity}
                    </strong>
                  </li>
                ))}
              </ul>
              {(returnRecord.discrepancies.length > 0
                || returnQuantityDifferenceSummary(returnRecord).length > 0) && (
                <div className="shipment-record-card__return-exception" role="status">
                  <strong>退货检查存在差异</strong>
                  {returnQuantityDifferenceSummary(returnRecord).length > 0 && (
                    <span>{returnQuantityDifferenceSummary(returnRecord).join('；')}</span>
                  )}
                  {returnRecord.discrepancies.length > 0 && (
                    <span>{returnRecord.discrepancies.map((difference) => (
                      `${returnDiscrepancyLabel(difference.kind)} ${difference.quantity} 件 · ${difference.note}`
                    )).join('；')}</span>
                  )}
                </div>
              )}
              {returnRecord.inspection && (
                <p>
                  检查结果：{inspectionResultLabel(returnRecord.inspection.result)} · {' '}
                  {returnRecord.inspection.note}
                </p>
              )}
              {returnRecord.carrierClaim && (
                <div className="shipment-record-card__aftersales-facts" aria-label="承运索赔">
                  <span>承运索赔 <strong>{carrierClaimStatusLabel(returnRecord.carrierClaim.status)}</strong></span>
                  <span>申请 {formatMoney(returnRecord.carrierClaim.requestedAmountCents)}</span>
                  {returnRecord.carrierClaim.approvedAmountCents !== null && (
                    <span>同意 {formatMoney(returnRecord.carrierClaim.approvedAmountCents)}</span>
                  )}
                  {returnRecord.carrierClaim.actualCompensation && (
                    <span>实际赔付 <strong>{formatMoney(returnRecord.carrierClaim.actualCompensation.amountCents)}</strong></span>
                  )}
                </div>
              )}
              <div className="shipment-record-card__aftersales-actions">
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: 'correct_return_logistics',
                    returnRecordId: returnRecord.id,
                  })}
                >
                  更正退货物流
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: 'update_return_logistics_status',
                    returnRecordId: returnRecord.id,
                  })}
                >
                  更新退货物流状态
                </button>
                {!returnRecord.carrierClaim && carrierClaimAvailable(returnRecord.logisticsStatus) && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => setProgressTarget({
                      aftersalesCase,
                      kind: 'open_carrier_claim',
                      returnRecordId: returnRecord.id,
                    })}
                  >
                    建立承运索赔
                  </button>
                )}
                {returnRecord.carrierClaim?.status === 'pending' && (
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={() => setProgressTarget({
                      aftersalesCase,
                      kind: 'resolve_carrier_claim',
                      returnRecordId: returnRecord.id,
                    })}
                  >
                    登记索赔结果
                  </button>
                )}
                {returnRecord.carrierClaim?.status === 'approved' && (
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={() => setProgressTarget({
                      aftersalesCase,
                      kind: 'confirm_carrier_compensation',
                      returnRecordId: returnRecord.id,
                    })}
                  >
                    确认实际赔付
                  </button>
                )}
              </div>
              <details className="shipment-record-card__timeline">
                <summary>退货包裹完整历史</summary>
                <ol>
                  {returnRecord.timeline.map((event) => (
                    <li key={`${event.kind}-${event.resultRevision}`}>
                      <strong>{returnEventLabel(event.kind)}</strong>
                      <span>{returnEventDescription(event, returnRecord)}</span>
                      <small>{formatDateTime(event.occurredAt)}</small>
                    </li>
                  ))}
                </ol>
              </details>
              {returnRecord.carrierClaim && (
                <details className="shipment-record-card__timeline">
                  <summary>承运索赔完整历史</summary>
                  <ol>
                    {returnRecord.carrierClaim.timeline.map((event) => (
                      <li key={`${event.kind}-${event.resultRevision}`}>
                        <strong>{carrierClaimEventLabel(event.kind)}</strong>
                        <span>{event.kind === 'compensation_confirmed' ? event.note : event.reason}</span>
                        <small>{formatDateTime(event.occurredAt)}</small>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </section>
          ))}
          {(aftersalesCase.status === 'completed' || aftersalesCase.status === 'cancelled')
            && !primaryProgressAction(aftersalesCase) ? (
            <small>后续独立问题请另行建立售后处理单</small>
          ) : aftersalesCase.workflow === 'general' ? (
            <button
              className="button button--quiet"
              type="button"
              onClick={() => onUpdate(aftersalesCase)}
            >
              更新售后处理
            </button>
          ) : (
            <div className="shipment-record-card__aftersales-actions">
              {primaryProgressAction(aftersalesCase) && (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: primaryProgressAction(aftersalesCase) as ProgressAftersalesCaseInput['kind'],
                  })}
                >
                  {progressActionLabel(primaryProgressAction(aftersalesCase) as ProgressAftersalesCaseInput['kind'])}
                </button>
              )}
              {primaryProgressAction(aftersalesCase) === 'confirm_refund'
                && returnFactProgressAction(aftersalesCase) && (
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: returnFactProgressAction(aftersalesCase) as 'receive_return' | 'inspect_return',
                  })}
                >
                  {progressActionLabel(
                    returnFactProgressAction(aftersalesCase) as 'receive_return' | 'inspect_return',
                  )}
                </button>
              )}
              {aftersalesCase.status === 'ready_to_complete'
                && primaryProgressAction(aftersalesCase) !== 'complete' && (
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({ aftersalesCase, kind: 'complete' })}
                >
                  {progressActionLabel('complete')}
                </button>
              )}
              {aftersalesCase.refund?.status === 'pending' && (
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({ aftersalesCase, kind: 'cancel' })}
                >
                  取消售后
                </button>
              )}
            </div>
          )}
          <details className="shipment-record-card__timeline">
            <summary>售后处理时间线</summary>
            <ol>
              {aftersalesCase.timeline.map((event) => (
                <li key={`${event.kind}-${event.resultRevision}`}>
                  <strong>{event.kind === 'created'
                    ? `建立售后处理单 · ${aftersalesStatusLabel(event.status)}`
                    : event.before.status === event.after.status
                      ? '售后内容已更新'
                      : `${aftersalesStatusLabel(event.before.status)} → ${aftersalesStatusLabel(event.after.status)}`}</strong>
                  <span>{event.kind === 'created'
                    ? event.reason
                    : `变更原因：${event.changeReason}`}</span>
                  {event.kind === 'updated' && event.before.reason !== event.after.reason && (
                    <span>问题原因：{event.before.reason} → {event.after.reason}</span>
                  )}
                  {event.kind === 'updated' && itemQuantityChanges(event, record).map((change) => (
                    <span key={change}>商品数量：{change}</span>
                  ))}
                  <small>{formatDateTime(event.createdAt)}</small>
                </li>
              ))}
            </ol>
          </details>
        </section>
      ))}
      {progressTarget && (
        <ProgressAftersalesCaseDialog
          aftersalesCase={progressTarget.aftersalesCase}
          kind={progressTarget.kind}
          returnRecordId={progressTarget.returnRecordId}
          onProgress={onProgress}
          onClose={() => setProgressTarget(null)}
        />
      )}
    </div>
  );
}

function primaryProgressAction(
  aftersalesCase: AftersalesCase,
): ProgressAftersalesCaseInput['kind'] | null {
  if (aftersalesCase.status === 'ready_to_complete') {
    return returnFactProgressAction(aftersalesCase) ?? 'complete';
  }
  if (aftersalesCase.status === 'cancelled' || aftersalesCase.status === 'completed') {
    const terminalReturn = aftersalesCase.returns[0];
    if (terminalReturn?.status === 'in_transit' && terminalReturn.logisticsStatus !== 'lost') {
      return 'receive_return';
    }
    if (terminalReturn?.status === 'received') return 'inspect_return';
    return null;
  }
  if (aftersalesCase.workflow === 'refund_only' && aftersalesCase.status === 'waiting_refund') {
    return 'confirm_refund';
  }
  if (aftersalesCase.workflow !== 'return_refund') return null;
  const returnRecord = aftersalesCase.returns[0];
  if (aftersalesCase.status === 'waiting_return' && !returnRecord) return 'register_return';
  if (
    aftersalesCase.refund?.status === 'pending'
    && aftersalesCase.returns.length > 0
    && aftersalesCase.returns.every((record) => (
      record.status === 'inspected'
      || record.logisticsStatus === 'lost'
      || record.carrierClaim !== null
    ))
  ) {
    return 'confirm_refund';
  }
  if (aftersalesCase.status === 'waiting_return' && returnRecord?.status === 'in_transit') {
    return 'receive_return';
  }
  if (aftersalesCase.status === 'waiting_inspection' && returnRecord?.status === 'received') {
    return 'inspect_return';
  }
  if (aftersalesCase.status === 'waiting_refund' && returnRecord?.status === 'inspected') {
    return 'confirm_refund';
  }
  if (aftersalesCase.status === 'waiting_refund' && returnRecord?.logisticsStatus === 'lost') {
    return 'confirm_refund';
  }
  return null;
}

function returnFactProgressAction(
  aftersalesCase: AftersalesCase,
): 'receive_return' | 'inspect_return' | null {
  const returnRecord = aftersalesCase.returns[0];
  if (returnRecord?.status === 'in_transit' && returnRecord.logisticsStatus !== 'lost') {
    return 'receive_return';
  }
  if (returnRecord?.status === 'received') return 'inspect_return';
  return null;
}

function progressActionLabel(kind: ProgressAftersalesCaseInput['kind']): string {
  const labels: Record<ProgressAftersalesCaseInput['kind'], string> = {
    register_return: '登记退货物流',
    receive_return: '确认收到退货',
    inspect_return: '记录退货检查',
    confirm_refund: '确认实际退款',
    complete: '完成售后',
    cancel: '取消售后',
    correct_return_logistics: '更正退货物流',
    update_return_logistics_status: '更新退货物流状态',
    open_carrier_claim: '建立承运索赔',
    resolve_carrier_claim: '登记索赔结果',
    confirm_carrier_compensation: '确认实际赔付',
  };
  return labels[kind];
}

function aftersalesWorkflowLabel(workflow: AftersalesCase['workflow']): string {
  return workflow === 'refund_only'
    ? '仅退款'
    : workflow === 'return_refund'
      ? '退货退款'
      : '一般处理';
}

function returnStatusLabel(status: AftersalesCase['returns'][number]['status']): string {
  return status === 'in_transit' ? '运输中' : status === 'received' ? '已收到' : '已检查';
}

function inspectionResultLabel(
  result: NonNullable<AftersalesCase['returns'][number]['inspection']>['result'],
): string {
  return {
    resellable: '可再次销售',
    defective: '瑕疵品',
    scrapped: '报废',
    other: '其他',
  }[result];
}

function returnEventLabel(kind: AftersalesCase['returns'][number]['timeline'][number]['kind']): string {
  return {
    registered: '登记退货物流',
    items_combined: '确认合装退货',
    logistics_corrected: '更正退货物流',
    logistics_status_updated: '更新退货物流状态',
    received: '实际收到退货',
    inspected: '完成退货检查',
  }[kind];
}

function returnEventDescription(
  event: AftersalesCase['returns'][number]['timeline'][number],
  returnRecord: AftersalesCase['returns'][number],
): string {
  if (event.kind === 'received') {
    const quantities = event.items?.map((item) => {
      const source = returnRecord.items.find(({ id }) => id === item.returnRecordItemId);
      return `${source?.sourceTitle ?? '退货商品'}收到 ${item.receivedQuantity}`;
    }).join('、');
    const differences = event.discrepancies?.map((difference) => (
      `${returnDiscrepancyLabel(difference.kind)} ${difference.quantity}`
    )).join('、');
    return [quantities, differences, event.reason].filter(Boolean).join(' · ');
  }
  if (event.kind === 'inspected') {
    const quantities = event.items?.map((item) => {
      const source = returnRecord.items.find(({ id }) => id === item.returnRecordItemId);
      return `${source?.sourceTitle ?? '退货商品'}通过 ${item.acceptedQuantity}`;
    }).join('、');
    const differences = event.discrepancies?.map((difference) => (
      `${returnDiscrepancyLabel(difference.kind)} ${difference.quantity}`
    )).join('、');
    return [quantities, differences, inspectionResultLabel(event.result), event.note]
      .filter(Boolean)
      .join(' · ');
  }
  if (event.kind === 'logistics_corrected') {
    return `${event.before.shippingCarrier} ${event.before.trackingNumber} → ${event.after.shippingCarrier} ${event.after.trackingNumber} · ${event.reason}`;
  }
  if (event.kind === 'logistics_status_updated') {
    return `${returnLogisticsStatusLabel(event.before)} → ${returnLogisticsStatusLabel(event.after)} · ${event.reason}`;
  }
  return event.reason;
}

function lastLogisticsCorrection(returnRecord: AftersalesCase['returns'][number]) {
  return [...returnRecord.timeline].reverse().find(({ kind }) => kind === 'logistics_corrected');
}

function carrierClaimEventLabel(
  kind: NonNullable<AftersalesCase['returns'][number]['carrierClaim']>['timeline'][number]['kind'],
): string {
  return {
    opened: '建立承运索赔',
    approved: '承运方同意赔付',
    rejected: '承运方拒绝赔付',
    compensation_confirmed: '确认实际赔付',
  }[kind];
}

function carrierClaimAvailable(status: AftersalesCase['returns'][number]['logisticsStatus']): boolean {
  return status === 'lost' || status === 'delivery_dispute' || status === 'damaged'
    || status === 'misdelivered' || status === 'exception' || status === 'returned_to_buyer';
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(cents / 100).replace('CN¥', '¥');
}

function itemQuantityChanges(
  event: AftersalesCaseUpdatedEvent,
  record: ShipmentRecord,
): string[] {
  const sourceItems = new Map(record.packages
    .flatMap(({ items }) => items)
    .map((item) => [item.id, item] as const));
  const before = new Map(event.before.items.map((item) => (
    [item.shipmentPackageItemId, item.quantity] as const
  )));
  const after = new Map(event.after.items.map((item) => (
    [item.shipmentPackageItemId, item.quantity] as const
  )));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((itemId) => {
    const beforeQuantity = before.get(itemId) ?? 0;
    const afterQuantity = after.get(itemId) ?? 0;
    if (beforeQuantity === afterQuantity) return [];
    const sourceItem = sourceItems.get(itemId);
    const label = sourceItem
      ? `${sourceItem.sourceTitle}${sourceItem.sourceSpec ? ` · ${sourceItem.sourceSpec}` : ''}`
      : '已记录商品';
    return [`${label} ${beforeQuantity} → ${afterQuantity}`];
  });
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

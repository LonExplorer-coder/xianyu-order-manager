import { useState } from 'react';

import type {
  AftersalesCase,
  AftersalesCaseUpdatedEvent,
  ProgressAftersalesCaseInput,
} from '../core/aftersales-cases';
import type { ShipmentRecord } from '../core/shipment-records';
import { aftersalesStatusLabel } from './aftersales-presentation';
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
              aria-label={`退货记录 ${returnRecord.id}`}
            >
              <header>
                <strong>退货 · {returnStatusLabel(returnRecord.status)}</strong>
                <span>{returnRecord.shippingCarrier} · {returnRecord.trackingNumber}</span>
              </header>
              <p>{returnRecord.items.map((item) => (
                `${item.sourceTitle}${item.sourceSpec ? ` · ${item.sourceSpec}` : ''} × ${item.quantity}`
              )).join('、')}</p>
              {returnRecord.inspection && (
                <p>
                  检查结果：{inspectionResultLabel(returnRecord.inspection.result)} · {' '}
                  {returnRecord.inspection.note}
                </p>
              )}
              <details className="shipment-record-card__timeline">
                <summary>退货处理时间线</summary>
                <ol>
                  {returnRecord.timeline.map((event) => (
                    <li key={`${event.kind}-${event.resultRevision}`}>
                      <strong>{returnEventLabel(event.kind)}</strong>
                      <span>{event.kind === 'inspected'
                        ? `${inspectionResultLabel(event.result)} · ${event.note}`
                        : event.reason}</span>
                      <small>{formatDateTime(event.occurredAt)}</small>
                    </li>
                  ))}
                </ol>
              </details>
            </section>
          ))}
          {aftersalesCase.status === 'completed' || (
            aftersalesCase.status === 'cancelled' && !primaryProgressAction(aftersalesCase)
          ) ? (
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
  if (aftersalesCase.status === 'ready_to_complete') return 'complete';
  if (aftersalesCase.status === 'cancelled') {
    const cancelledReturn = aftersalesCase.returns[0];
    if (cancelledReturn?.status === 'in_transit') return 'receive_return';
    if (cancelledReturn?.status === 'received') return 'inspect_return';
    return null;
  }
  if (aftersalesCase.workflow === 'refund_only' && aftersalesCase.status === 'waiting_refund') {
    return 'confirm_refund';
  }
  if (aftersalesCase.workflow !== 'return_refund') return null;
  const returnRecord = aftersalesCase.returns[0];
  if (aftersalesCase.status === 'waiting_return' && !returnRecord) return 'register_return';
  if (aftersalesCase.status === 'waiting_return' && returnRecord?.status === 'in_transit') {
    return 'receive_return';
  }
  if (aftersalesCase.status === 'waiting_inspection' && returnRecord?.status === 'received') {
    return 'inspect_return';
  }
  if (aftersalesCase.status === 'waiting_refund' && returnRecord?.status === 'inspected') {
    return 'confirm_refund';
  }
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
  return kind === 'registered' ? '登记退货物流' : kind === 'received' ? '实际收到退货' : '完成退货检查';
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

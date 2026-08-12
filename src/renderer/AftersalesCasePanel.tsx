import type {
  AftersalesCase,
  AftersalesCaseUpdatedEvent,
} from '../core/aftersales-cases';
import type { ShipmentRecord } from '../core/shipment-records';
import { aftersalesStatusLabel } from './aftersales-presentation';

export function AftersalesCasePanel({
  record,
  aftersalesCases,
  onUpdate,
}: {
  record: ShipmentRecord;
  aftersalesCases: readonly AftersalesCase[];
  onUpdate: (aftersalesCase: AftersalesCase) => void;
}) {
  if (aftersalesCases.length === 0) return null;
  return (
    <div className="shipment-record-card__aftersales" aria-label="售后处理单">
      {aftersalesCases.map((aftersalesCase) => (
        <section key={aftersalesCase.id}>
          <header>
            <strong>{aftersalesStatusLabel(aftersalesCase.status)}</strong>
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
          {aftersalesCase.status === 'completed' ? (
            <small>后续独立问题请另行建立售后处理单</small>
          ) : (
            <button
              className="button button--quiet"
              type="button"
              onClick={() => onUpdate(aftersalesCase)}
            >
              更新售后处理
            </button>
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
    </div>
  );
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

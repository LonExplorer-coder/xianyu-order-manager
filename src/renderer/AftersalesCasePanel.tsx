import { useState } from 'react';

import type {
  AftersalesCase,
  AftersalesCaseUpdatedEvent,
  ProgressAftersalesCaseInput,
} from '../core/aftersales-cases';
import type { ShipmentRecord } from '../core/shipment-records';
import {
  aftersalesHandlingDirectionLabel,
  aftersalesPhysicalControlLabel,
  aftersalesStatusLabel,
  carrierClaimStatusLabel,
  returnDiscrepancyLabel,
  returnLogisticsStatusLabel,
  returnQuantityDifferenceSummary,
} from './aftersales-presentation';
import { shipmentLogisticsStatusLabel } from '../core/order-operations-projection';
import { ProgressAftersalesCaseDialog } from './AftersalesCaseDialogs';
import {
  logisticsExceptionStageLabel,
  logisticsExceptionTypeLabel,
} from './logistics-presentation';

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
          {aftersalesCase.rounds?.some(({ workflow }) => workflow !== 'legacy') && (
            <section className="shipment-record-card__coordination" aria-label="售后实物流转汇总">
              <strong>当前第 {aftersalesCase.fulfillment.currentRoundNumber} 轮 · {aftersalesCase.coordination.currentTodo}</strong>
              <span>
                累计发出 {aftersalesCase.fulfillment.cumulativeSentQuantity} 件
                {' · '}累计退回 {aftersalesCase.fulfillment.cumulativeReturnedQuantity} 件
                {' · '}买家当前持有 {aftersalesCase.fulfillment.buyerHeldQuantity} 件
              </span>
              <ol>
                {aftersalesCase.rounds.map((round) => (
                  <li key={round.id}>
                    <strong>第 {round.roundNumber} 轮 · {round.workflow === 'exchange' ? '换货' : round.workflow === 'direct_replacement' ? '直接补发' : '旧版处理'}</strong>
                    <span>来源发货 {round.sourceShipmentRecordId}</span>
                    <span>{round.items.map((item) => (
                      `${item.sourceTitle}${item.sourceSpec ? ` · ${item.sourceSpec}` : ''} × ${item.quantity}`
                    )).join('；')}</span>
                    {round.replacementShipment ? (
                      <span>补发：{round.replacementShipment.packages.map((shipmentPackage) => (
                        `${shipmentPackage.shippingCarrier} ${shipmentPackage.trackingNumber} · ${shipmentLogisticsStatusLabel(shipmentPackage.logisticsStatus)}`
                      )).join('；')}</span>
                    ) : <span>补发：尚未建立</span>}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {aftersalesCase.workflow === 'return_refund' && (
            <div
              className="shipment-record-card__coordination"
              aria-label="在途售后协调"
              role="status"
            >
              <strong>当前待办：{aftersalesCase.coordination.currentTodo}</strong>
              <span>
                处理方向：{aftersalesCase.coordination.handlingDirection
                  ? aftersalesHandlingDirectionLabel(aftersalesCase.coordination.handlingDirection)
                  : '待明确'}
                {' · '}实物控制：{aftersalesPhysicalControlLabel(aftersalesCase.coordination.physicalControl)}
              </span>
              {aftersalesCase.coordination.risk && (
                <span className="shipment-record-card__coordination-risk">
                  风险：{aftersalesCase.coordination.risk}
                </span>
              )}
            </div>
          )}
          {aftersalesCase.coordination.sourcePackages.length > 0 && (
            <div className="shipment-record-card__source-packages" aria-label="原正向包裹与商品数量">
              {aftersalesCase.coordination.sourcePackages.map((sourcePackage) => (
                <article key={sourcePackage.packageId}>
                  <header>
                    <strong>原正向包裹 · {sourcePackage.shippingCarrier}</strong>
                    <span>{sourcePackage.trackingNumber}</span>
                  </header>
                  <p>
                    实际流转：{shipmentLogisticsStatusLabel(sourcePackage.logisticsStatus)}
                    {sourcePackage.confirmedLost ? ' · 已确认丢失' : ''}
                  </p>
                  <ul>
                    {sourcePackage.items.map((item) => (
                      <li key={item.shipmentPackageItemId}>
                        <span>{item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</span>
                        <strong>
                          × {item.quantity}
                          {item.confirmedLostQuantity > 0
                            ? ` · 已确认丢失 ${item.confirmedLostQuantity}`
                            : ''}
                        </strong>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
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
              {returnRecord.currentException && (
                <div className="shipment-record-card__return-exception" role="status">
                  <strong>
                    物流异常 · {logisticsExceptionTypeLabel(
                      returnRecord.currentException.exceptionType,
                    )} · {logisticsExceptionStageLabel(returnRecord.currentException.stage)}
                  </strong>
                  <span>{returnRecord.currentException.reason}</span>
                  {aftersalesCase.coordination.returnException?.exceptionId
                    === returnRecord.currentException.id && (
                    <span>
                      退货异常处理：{aftersalesCase.coordination.returnException.decision
                        ? returnExceptionDecisionLabel(
                          aftersalesCase.coordination.returnException.decision,
                        )
                        : '待选择'}
                      {' · '}影响 {aftersalesCase.coordination.returnException.affectedQuantity} 件
                    </span>
                  )}
                </div>
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
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: returnRecord.currentException
                      ? 'progress_return_logistics_exception'
                      : 'record_return_logistics_exception',
                    returnRecordId: returnRecord.id,
                  })}
                >
                  {returnRecord.currentException ? '推进退货物流异常' : '登记退货物流异常'}
                </button>
                {aftersalesCase.coordination.returnException?.decision
                  && aftersalesCase.coordination.returnException.exceptionId
                    === returnRecord.currentException?.id && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => setProgressTarget({
                      aftersalesCase,
                      kind: 'decide_return_logistics_exception',
                      returnRecordId: returnRecord.id,
                    })}
                  >
                    更改退货异常处理
                  </button>
                )}
                {!returnRecord.carrierClaim && carrierClaimAvailable(returnRecord.currentException) && (
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
            && !primaryProgressAction(aftersalesCase)
            && aftersalesCase.coordination.interception?.status !== 'requested' ? (
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
              {aftersalesCase.coordination.interception?.status === 'requested' && (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: 'record_interception_result',
                  })}
                >
                  {progressActionLabel('record_interception_result')}
                </button>
              )}
              {aftersalesCase.workflow === 'return_refund'
                && aftersalesCase.status !== 'completed'
                && aftersalesCase.status !== 'cancelled'
                && aftersalesCase.coordination.availableDirections.some((direction) => (
                  direction !== aftersalesCase.coordination.handlingDirection
                )) && (
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: 'change_handling_direction',
                  })}
                >
                  {progressActionLabel('change_handling_direction')}
                </button>
              )}
              {primaryProgressAction(aftersalesCase) && (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: primaryProgressAction(aftersalesCase) as ProgressAftersalesCaseInput['kind'],
                    ...(primaryProgressAction(aftersalesCase)
                      === 'decide_return_logistics_exception'
                      ? {
                        returnRecordId:
                          aftersalesCase.coordination.returnException?.returnRecordId,
                      }
                      : {}),
                  })}
                >
                  {progressActionLabel(primaryProgressAction(aftersalesCase) as ProgressAftersalesCaseInput['kind'])}
                </button>
              )}
              {aftersalesCase.rounds?.at(-1)?.replacementShipment
                && aftersalesCase.status !== 'completed'
                && aftersalesCase.status !== 'cancelled' && (
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({ aftersalesCase, kind: 'start_next_round' })}
                >
                  {progressActionLabel('start_next_round')}
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
              {(aftersalesCase.refund?.status === 'pending'
                || aftersalesCase.workflow === 'exchange'
                || aftersalesCase.workflow === 'direct_replacement') && (
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
          {(aftersalesCase.coordination.handlingDirectionTimeline.length > 0
            || aftersalesCase.coordination.interception
            || aftersalesCase.coordination.returnExceptionHistory.some(
              ({ timeline }) => timeline.length > 0,
            )) && (
            <details className="shipment-record-card__timeline">
              <summary>售后协调完整历史</summary>
              <ol>
                {aftersalesCase.coordination.handlingDirectionTimeline.map((event, index) => (
                  <li key={`direction-${index}-${event.occurredAt}`}>
                    <strong>{event.kind === 'selected' ? '选择处理方向' : '转换处理方向'}</strong>
                    <span>
                      {event.before ? `${aftersalesHandlingDirectionLabel(event.before)} → ` : ''}
                      {aftersalesHandlingDirectionLabel(event.after)} · {event.reason}
                    </span>
                    <small>{formatDateTime(event.occurredAt)}</small>
                  </li>
                ))}
                {aftersalesCase.coordination.interception?.timeline.map((event, index) => (
                  <li key={`interception-${index}-${event.occurredAt}`}>
                    <strong>{interceptionEventLabel(event.kind)}</strong>
                    <span>{event.reason}</span>
                    <small>{formatDateTime(event.occurredAt)}</small>
                  </li>
                ))}
                {aftersalesCase.coordination.returnExceptionHistory.flatMap((exception) => (
                  exception.timeline.map((event, index) => (
                    <li key={`return-exception-decision-${exception.exceptionId}-${index}`}>
                      <strong>{event.kind === 'selected'
                        ? '选择退货异常处理'
                        : '更改退货异常处理'}</strong>
                      <span>
                        {event.before ? `${returnExceptionDecisionLabel(event.before)} → ` : ''}
                        {returnExceptionDecisionLabel(event.after)} · {event.reason}
                      </span>
                      <small>{formatDateTime(event.occurredAt)}</small>
                    </li>
                  ))
                ))}
              </ol>
            </details>
          )}
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
  if (aftersalesCase.coordination.returnException
    && aftersalesCase.coordination.returnException.decision === null) {
    return 'decide_return_logistics_exception';
  }
  if (aftersalesCase.status === 'ready_to_complete') {
    return returnFactProgressAction(aftersalesCase) ?? 'complete';
  }
  if (aftersalesCase.status === 'cancelled' || aftersalesCase.status === 'completed') {
    const currentRound = aftersalesCase.rounds?.at(-1);
    const terminalReturn = aftersalesCase.returns.find(({ id }) => (
      currentRound?.returnRecordIds.includes(id)
    )) ?? aftersalesCase.returns.at(-1);
    if (terminalReturn?.status === 'in_transit' && canReceiveReturn(terminalReturn)) {
      return 'receive_return';
    }
    if (terminalReturn?.status === 'received') return 'inspect_return';
    return null;
  }
  if (aftersalesCase.workflow === 'refund_only' && aftersalesCase.status === 'waiting_refund') {
    return 'confirm_refund';
  }
  const currentRound = aftersalesCase.rounds?.at(-1);
  if (currentRound?.workflow === 'exchange' || currentRound?.workflow === 'direct_replacement') {
    const returnRecord = aftersalesCase.returns.find(({ id }) => (
      currentRound.returnRecordIds.includes(id)
    ));
    if (currentRound.workflow === 'exchange'
      && aftersalesCase.status === 'waiting_return' && !returnRecord) return 'register_return';
    if (currentRound.workflow === 'exchange'
      && aftersalesCase.status === 'waiting_return'
      && returnRecord?.status === 'in_transit') {
      return canReceiveReturn(returnRecord) ? 'receive_return' : null;
    }
    if (currentRound.workflow === 'exchange'
      && aftersalesCase.status === 'waiting_inspection'
      && returnRecord?.status === 'received') return 'inspect_return';
    if (aftersalesCase.status === 'waiting_replacement'
      && !currentRound.replacementShipment) return 'create_replacement_shipment';
    return null;
  }
  if (aftersalesCase.workflow !== 'return_refund') return null;
  if (aftersalesCase.coordination.handlingDirection === 'only_refund'
    && aftersalesCase.status === 'waiting_refund') {
    return 'confirm_refund';
  }
  const returnRecord = aftersalesCase.returns[0];
  if (aftersalesCase.status === 'waiting_return' && !returnRecord) return 'register_return';
  if (
    aftersalesCase.refund?.status === 'pending'
    && aftersalesCase.returns.length > 0
    && aftersalesCase.returns.every((record) => (
      record.status === 'inspected'
      || record.carrierClaim !== null
      || (record.status === 'in_transit' && !isConfirmedLost(record))
      || (record.id === aftersalesCase.coordination.returnException?.returnRecordId
        && aftersalesCase.coordination.returnException.decision !== null)
    ))
  ) {
    return 'confirm_refund';
  }
  if (aftersalesCase.status === 'waiting_return' && returnRecord?.status === 'in_transit') {
    return canReceiveReturn(returnRecord) ? 'receive_return' : null;
  }
  if (aftersalesCase.status === 'waiting_inspection' && returnRecord?.status === 'received') {
    return 'inspect_return';
  }
  if (aftersalesCase.status === 'waiting_refund' && returnRecord?.status === 'inspected') {
    return 'confirm_refund';
  }
  return null;
}

function returnFactProgressAction(
  aftersalesCase: AftersalesCase,
): 'receive_return' | 'inspect_return' | null {
  const currentRound = aftersalesCase.rounds?.at(-1);
  const returnRecord = aftersalesCase.returns.find(({ id }) => (
    currentRound?.returnRecordIds.includes(id)
  )) ?? aftersalesCase.returns.at(-1);
  if (returnRecord?.status === 'in_transit' && canReceiveReturn(returnRecord)) {
    return 'receive_return';
  }
  if (returnRecord?.status === 'received') return 'inspect_return';
  return null;
}

function progressActionLabel(kind: ProgressAftersalesCaseInput['kind']): string {
  const labels: Record<ProgressAftersalesCaseInput['kind'], string> = {
    create_replacement_shipment: '建立本轮补发',
    start_next_round: '登记新一轮问题',
    record_interception_result: '登记拦截结果',
    change_handling_direction: '转换处理方向',
    register_return: '登记退货物流',
    receive_return: '确认收到退货',
    inspect_return: '记录退货检查',
    confirm_refund: '确认实际退款',
    complete: '完成售后',
    cancel: '取消售后',
    correct_return_logistics: '更正退货物流',
    update_return_logistics_status: '更新退货物流状态',
    record_return_logistics_exception: '登记退货物流异常',
    progress_return_logistics_exception: '推进退货物流异常',
    decide_return_logistics_exception: '选择退货异常处理',
    open_carrier_claim: '建立承运索赔',
    resolve_carrier_claim: '登记索赔结果',
    confirm_carrier_compensation: '确认实际赔付',
  };
  return labels[kind];
}

function returnExceptionDecisionLabel(
  decision: NonNullable<AftersalesCase['coordination']['returnException']>['decision'],
): string {
  return {
    wait_investigation: '等待调查',
    refund_in_advance: '先行退款',
    partial_refund: '部分退款',
    reject_refund: '拒绝退款',
    negotiate: '继续协商',
  }[decision ?? 'wait_investigation'];
}

function aftersalesWorkflowLabel(workflow: AftersalesCase['workflow']): string {
  return workflow === 'refund_only'
    ? '仅退款'
    : workflow === 'return_refund'
      ? '退货退款'
      : workflow === 'exchange'
        ? '换货'
        : workflow === 'direct_replacement'
          ? '直接补发'
          : '一般处理';
}

function interceptionEventLabel(
  kind: NonNullable<AftersalesCase['coordination']['interception']>['timeline'][number]['kind'],
): string {
  return {
    requested: '已申请拦截',
    succeeded: '拦截成功',
    failed: '拦截失败',
  }[kind];
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

function isConfirmedLost(returnRecord: AftersalesCase['returns'][number]): boolean {
  return returnRecord.currentException?.exceptionType === 'lost'
    && returnRecord.currentException.stage === 'confirmed';
}

function canReceiveReturn(returnRecord: AftersalesCase['returns'][number]): boolean {
  if (returnRecord.logisticsExceptions.some((exception) => (
    (exception.exceptionType === 'delivery_dispute'
      || exception.exceptionType === 'misdelivered')
    && exception.stage !== 'recovered'
    && exception.stage !== 'resolved'
  ))) return false;
  const lostByItem = new Map<string, number>();
  for (const exception of returnRecord.logisticsExceptions) {
    if (exception.exceptionType !== 'lost' || exception.stage !== 'confirmed') continue;
    if (exception.impact.scope === 'package') return false;
    for (const affected of exception.impact.items) {
      lostByItem.set(
        affected.sourceItemId,
        (lostByItem.get(affected.sourceItemId) ?? 0) + affected.quantity,
      );
    }
  }
  return returnRecord.items.some((item) => (
    (lostByItem.get(item.id) ?? 0) < item.quantity
  ));
}

function carrierClaimAvailable(
  exception: AftersalesCase['returns'][number]['currentException'],
): boolean {
  return exception?.stage === 'confirmed';
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

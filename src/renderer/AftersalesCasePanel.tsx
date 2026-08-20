import { useState } from 'react';

import type {
  AftersalesCase,
  AftersalesCaseUpdatedEvent,
  ChangeAftersalesCaseWorkflowTemplateInput,
  ProgressAftersalesCaseInput,
  RecordAftersalesWorkflowStepEventInput,
} from '../core/aftersales-cases';
import {
  displayedProductSpecification,
  displayedProductTitle,
} from '../core/product-standardization';
import type { DesktopApi } from '../core/desktop-api';
import {
  aftersalesWorkflowFieldLabel,
  aftersalesWorkflowStepCategoryLabel,
  deriveAftersalesWorkflowOperations,
  projectAftersalesWorkflowSteps,
  type AftersalesWorkflowOperation,
  type AftersalesWorkflowStepProjection,
} from '../core/aftersales-workflow-templates';
import type { ShipmentRecord } from '../core/shipment-records';
import {
  inventoryMovementSourceLabel,
  inventoryStateLabel,
  type InventoryMovementView,
} from '../core/inventory-ledger';
import { isUnresolvedLogisticsExceptionStage } from '../core/logistics-exceptions';
import {
  aftersalesHandlingDirectionLabel,
  aftersalesCaseOperationsCoordination,
  aftersalesReturnsForPresentation,
  aftersalesPhysicalControlLabel,
  aftersalesStatusLabel,
  carrierClaimStatusLabel,
  returnDiscrepancyLabel,
  returnLogisticsStatusLabel,
  returnQuantityDifferenceSummary,
} from './aftersales-presentation';
import { shipmentLogisticsStatusLabel } from '../core/order-operations-projection';
import {
  ChangeAftersalesWorkflowDialog,
  ProgressAftersalesCaseDialog,
  RecordAftersalesWorkflowStepEventDialog,
} from './AftersalesCaseDialogs';
import {
  logisticsExceptionStageLabel,
  logisticsExceptionTypeLabel,
} from './logistics-presentation';
import {
  FinanceFactsSummary,
  FinanceRecordDialog,
  type FinanceRecordDialogPreset,
} from './FinanceFacts';
import type { FinanceFactsForSource } from '../core/funds';

export function AftersalesCasePanel({
  api,
  record,
  aftersalesCases,
  focusedCaseId,
  onUpdate,
  onProgress,
  onChangeWorkflow,
  onRecordStepEvent,
}: {
  api: DesktopApi;
  record: ShipmentRecord;
  aftersalesCases: readonly AftersalesCase[];
  focusedCaseId?: string;
  onUpdate: (aftersalesCase: AftersalesCase) => void;
  onProgress: (input: ProgressAftersalesCaseInput) => Promise<void>;
  onChangeWorkflow: (input: ChangeAftersalesCaseWorkflowTemplateInput) => Promise<void>;
  onRecordStepEvent: (input: RecordAftersalesWorkflowStepEventInput) => Promise<void>;
}) {
  const [progressTarget, setProgressTarget] = useState<{
    aftersalesCase: AftersalesCase;
    kind: ProgressAftersalesCaseInput['kind'];
    returnRecordId?: string;
    outboundExceptionId?: string;
    roundId?: string;
  } | null>(null);
  const [workflowTarget, setWorkflowTarget] = useState<AftersalesCase | null>(null);
  const [stepEventTarget, setStepEventTarget] = useState<{
    aftersalesCase: AftersalesCase;
    step: AftersalesWorkflowStepProjection;
    kind: 'completed' | 'skipped';
  } | null>(null);
  const [inventoryImpactByCase, setInventoryImpactByCase] = useState<Record<
    string,
    { movements: InventoryMovementView[]; state: 'loading' | 'ready' | 'error' }
  >>({});
  const loadInventoryImpact = (caseId: string): void => {
    if (inventoryImpactByCase[caseId]) return;
    setInventoryImpactByCase((previous) => ({
      ...previous,
      [caseId]: { movements: [], state: 'loading' },
    }));
    api.queryAftersalesInventoryImpact(caseId)
      .then((movements) => {
        setInventoryImpactByCase((previous) => ({
          ...previous,
          [caseId]: { movements, state: 'ready' },
        }));
      })
      .catch(() => {
        setInventoryImpactByCase((previous) => ({
          ...previous,
          [caseId]: { movements: [], state: 'error' },
        }));
      });
  };
  const [fundsByCase, setFundsByCase] = useState<Record<
    string,
    { facts: FinanceFactsForSource | null; state: 'loading' | 'ready' | 'error' }
  >>({});
  const loadFundsImpact = (caseId: string): void => {
    if (fundsByCase[caseId]) return;
    setFundsByCase((previous) => ({
      ...previous,
      [caseId]: { facts: null, state: 'loading' },
    }));
    api.queryFinanceFactsForAftersalesCase(caseId)
      .then((facts) => {
        setFundsByCase((previous) => ({
          ...previous,
          [caseId]: { facts, state: 'ready' },
        }));
      })
      .catch(() => {
        setFundsByCase((previous) => ({
          ...previous,
          [caseId]: { facts: null, state: 'error' },
        }));
      });
  };
  const [recordFundsTarget, setRecordFundsTarget] = useState<{
    caseId: string;
    preset: FinanceRecordDialogPreset;
  } | null>(null);
  if (aftersalesCases.length === 0) return null;
  return (
    <div className="shipment-record-card__aftersales" aria-label="售后处理单">
      {aftersalesCases.map((aftersalesCase) => {
        const operationsCoordination = aftersalesCaseOperationsCoordination(aftersalesCase);
        const workflowSteps = projectAftersalesWorkflowSteps(
          aftersalesCase.workflowTemplate,
          aftersalesCase,
        );
        const operations = deriveAftersalesWorkflowOperations(
          aftersalesCase.workflowTemplate,
          aftersalesCase,
        );
        // 流程投影驱动的操作入口：被事实阻止时按钮可见但禁用，并展示原因。
        const renderWorkflowOperation = (
          operation: AftersalesWorkflowOperation,
          variant: 'primary' | 'quiet',
        ) => (
          <span
            className="aftersales-operation"
            key={`${variant}-${operation.stepId}-${operation.action}`}
          >
            <button
              className={variant === 'primary' ? 'button button--primary' : 'button button--quiet'}
              type="button"
              disabled={operation.blockedReason !== null}
              onClick={() => setProgressTarget({
                aftersalesCase,
                ...operationTargets(aftersalesCase, operation.action),
              })}
            >
              {progressActionLabel(operation.action)}
            </button>
            {operation.blockedReason !== null && (
              <small className="aftersales-operation__reason">{operation.blockedReason}</small>
            )}
          </span>
        );
        const renderSupplementalFacts = () => operations.supplemental.length === 0 ? null : (
          <details className="aftersales-supplemental-facts" open>
            <summary>补录已发生的真实事实（{operations.supplemental.length}）</summary>
            <div className="shipment-record-card__aftersales-actions">
              {operations.supplemental.map((operation) => (
                renderWorkflowOperation(operation, 'quiet')
              ))}
            </div>
          </details>
        );
        // 拦截结果是上下文事实入口：只要拦截待确认就常驻，终态售后同样适用。
        const interceptionResultButton = (
          <>
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
          </>
        );
        const outboundDecisionDerived = operations.primary.some(({ action }) => (
          action === 'decide_outbound_logistics_exception'
        ));
        return (
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
          <section className="aftersales-workflow-guide" aria-label="售后流程引导">
            <header>
              <div>
                <strong>{aftersalesCase.workflowTemplate.name}</strong>
                <span>版本 {aftersalesCase.workflowTemplate.version}</span>
              </div>
              {aftersalesCase.status !== 'completed' && aftersalesCase.status !== 'cancelled' && (
                <button type="button" onClick={() => setWorkflowTarget(aftersalesCase)}>
                  调整后续流程
                </button>
              )}
            </header>
            {(() => {
              const currentStep = workflowSteps.find(({ state }) => state === 'current');
              const partialSteps = workflowSteps.filter(({ state }) => state === 'partial');
              if (!currentStep && partialSteps.length === 0) return null;
              return (
                <div className="aftersales-workflow-guide__current" aria-label="当前主步骤">
                  {currentStep ? (
                    <>
                      <strong>当前步骤：{currentStep.name}</strong>
                      {currentStep.fields.length > 0 && (
                        <small>需核对：{currentStep.fields.map(aftersalesWorkflowFieldLabel).join('、')}</small>
                      )}
                      {currentStep.binding?.category === 'management' && (
                        <span>
                          <button
                            className="button button--quiet"
                            type="button"
                            onClick={() => setStepEventTarget({
                              aftersalesCase,
                              step: currentStep,
                              kind: 'completed',
                            })}
                          >
                            标记完成
                          </button>
                          <button
                            className="button button--quiet"
                            type="button"
                            onClick={() => setStepEventTarget({
                              aftersalesCase,
                              step: currentStep,
                              kind: 'skipped',
                            })}
                          >
                            带原因跳过
                          </button>
                        </span>
                      )}
                    </>
                  ) : (
                    <strong>当前没有待执行步骤</strong>
                  )}
                  {partialSteps.map((step) => (
                    <small key={`partial-${step.id}`}>
                      部分完成 · {step.name} · {stepProgressLabel(step)}
                    </small>
                  ))}
                </div>
              );
            })()}
            <ol>
              {workflowSteps.map((step, index) => (
                <li className={`is-${step.state}`} key={step.id}>
                  <span aria-hidden="true">{step.state === 'completed' ? '✓' : index + 1}</span>
                  <div>
                    <strong>{step.name}</strong>
                    <small>
                      {step.kind === null || step.binding === null
                        ? '需要检查 · 未绑定业务动作'
                        : `${step.required ? '必需' : '可选'} · ${
                          aftersalesWorkflowStepCategoryLabel(step.binding.category)
                        }`}
                      {step.state === 'current' ? ' · 当前建议' : ''}
                      {step.state === 'partial' ? ` · 部分完成 · ${stepProgressLabel(step)}` : ''}
                      {step.state === 'skipped' && step.stepEvent
                        ? ` · 已跳过 · ${step.stepEvent.reason}` : ''}
                      {step.state === 'not_applicable' && step.notApplicableReason
                        ? ` · 不再适用 · ${step.notApplicableReason}` : ''}
                    </small>
                    {step.state === 'current' && step.fields.length > 0 && (
                      <small>需核对：{step.fields.map(aftersalesWorkflowFieldLabel).join('、')}</small>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {(aftersalesCase.workflowTemplate.timeline.length > 1
              || aftersalesCase.workflowTemplate.stepEvents.length > 0) && (
              <details>
                <summary>流程版本与步骤历史</summary>
                <ol>
                  {aftersalesCase.workflowTemplate.timeline.map((event, index) => (
                    <li key={`${event.kind}-${index}`}>
                      <strong>{event.kind === 'selected' ? '选择流程' : '调整后续流程'}</strong>
                      <span>{event.reason}</span>
                      <small>{formatDateTime(event.occurredAt)}</small>
                    </li>
                  ))}
                  {aftersalesCase.workflowTemplate.stepEvents.map((event) => (
                    <li key={`step-event-${event.id}`}>
                      <strong>{event.kind === 'skipped' ? '跳过流程步骤' : '完成流程步骤'}</strong>
                      <span>
                        {stepNameById(aftersalesCase, event.stepId)} · {event.reason}
                        {event.remainingRisk !== null ? ` · 剩余风险：${event.remainingRisk}` : ''}
                      </span>
                      <small>{formatDateTime(event.occurredAt)}</small>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>
          <p>{aftersalesCase.reason}</p>
          <ul>
            {aftersalesCase.items.map((item) => {
              const specification = displayedProductSpecification(item);
              return (
                <li key={item.id}>
                  <span>{item.orderNumber} · {displayedProductTitle(item)}
                    {specification ? ` · ${specification}` : ''}</span>
                  <strong>× {item.quantity}</strong>
                </li>
              );
            })}
          </ul>
          <div
            className="shipment-record-card__coordination"
            aria-label="售后当前协调"
            role="status"
          >
            <strong>当前待办：{
              operationsCoordination.primaryTodo?.title
                ?? aftersalesCase.coordination.currentTodo
            }</strong>
            {operationsCoordination.secondaryTodoCount > 0 && (
              <details className="order-coordination-secondary shipment-records-secondary-todos">
                <summary>另有 {operationsCoordination.secondaryTodoCount} 项</summary>
                <ul>
                  {operationsCoordination.todos.slice(1).map((todo) => (
                    <li key={todo.id}>
                      <strong>{todo.title}</strong>
                      <small>{todo.detail}</small>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {aftersalesCase.coordination.risk && (
              <span className="shipment-record-card__coordination-risk">
                未解决风险：{aftersalesCase.coordination.risk}
              </span>
            )}
            <span>
              处理方向：{aftersalesCase.coordination.handlingDirection
                ? aftersalesHandlingDirectionLabel(aftersalesCase.coordination.handlingDirection)
                : '待明确'}
              {' · '}实物控制：{aftersalesPhysicalControlLabel(aftersalesCase.coordination.physicalControl)}
            </span>
          </div>
          {aftersalesCase.coordination.outboundException && (
            <div className="shipment-record-card__return-exception" aria-label="正向物流异常" role="status">
              <strong>
                正向物流异常 · {logisticsExceptionTypeLabel(
                  aftersalesCase.coordination.outboundException.exceptionType,
                )} · {logisticsExceptionStageLabel(
                  aftersalesCase.coordination.outboundException.stage,
                )}
              </strong>
              <span>
                影响 {aftersalesCase.coordination.outboundException.affectedQuantity} 件
                {' · '}买家侧处理：{aftersalesCase.coordination.outboundException.decision
                  ? outboundExceptionDecisionLabel(
                    aftersalesCase.coordination.outboundException.decision,
                  )
                  : '待选择'}
              </span>
              <ul aria-label="正向物流异常受影响商品">
                {aftersalesCase.coordination.outboundException.affectedItems.map((item) => (
                  <li key={item.shipmentPackageItemId}>
                    <span>{item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</span>
                    <strong>× {item.quantity}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {aftersalesCase.coordination.interceptedReturnInspection && (
            <div className="shipment-record-card__aftersales-facts" aria-label="拦截退回检查事实">
              <span>
                拦截退回已检查 · <strong>{inspectionResultLabel(
                  aftersalesCase.coordination.interceptedReturnInspection.result,
                )}</strong>
              </span>
              <span>
                {aftersalesCase.coordination.interceptedReturnInspection.items.reduce(
                  (sum, item) => sum + item.quantity,
                  0,
                )} 件 · {formatDateTime(
                  aftersalesCase.coordination.interceptedReturnInspection.occurredAt,
                )}
              </span>
            </div>
          )}
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
                  {sourcePackage.carrierClaim && (
                    <>
                      <p>
                        承运索赔：{carrierClaimStatusLabel(sourcePackage.carrierClaim.status)}
                        {' · '}申请 {formatMoney(sourcePackage.carrierClaim.requestedAmountCents)}
                        {sourcePackage.carrierClaim.actualCompensationCents !== null
                          ? ` · 实际赔付 ${formatMoney(sourcePackage.carrierClaim.actualCompensationCents)}`
                          : ''}
                      </p>
                      <details className="shipment-record-card__timeline">
                        <summary>正向承运索赔完整历史</summary>
                        <ol>
                          {sourcePackage.carrierClaim.timeline.map((event) => (
                            <li key={`${event.kind}-${event.resultRevision}`}>
                              <strong>{carrierClaimEventLabel(event.kind)}</strong>
                              <span>{carrierClaimEventDescription(event)}</span>
                              <small>{formatDateTime(event.occurredAt)}</small>
                            </li>
                          ))}
                        </ol>
                      </details>
                    </>
                  )}
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
            <>
              <div className="shipment-record-card__aftersales-facts" aria-label="退款事实">
                <span>退款目标 <strong>{formatMoney(aftersalesCase.refund.requestedAmountCents)}</strong></span>
                {aftersalesCase.refund.refundRecords.length > 0 ? (
                  <span>
                    已退累计 <strong>{formatMoney(
                      aftersalesCase.refund.fulfillment.refundedAmountCents,
                    )}</strong>
                    （{aftersalesCase.refund.refundRecords.length} 笔）
                  </span>
                ) : (
                  <span>{aftersalesCase.refund.status === 'cancelled' ? '退款申请已取消' : '实际退款待确认'}</span>
                )}
                {aftersalesCase.refund.fulfillment.kind === 'partial' && (
                  <span>
                    {aftersalesCase.refund.status === 'ended' ? '未再补退' : '剩余'}
                    {' '}<strong>{formatMoney(
                      aftersalesCase.refund.fulfillment.remainingAmountCents,
                    )}</strong>
                    {aftersalesCase.refund.status === 'ended' ? '' : ' 待退'}
                  </span>
                )}
                {aftersalesCase.refund.fulfillment.kind === 'conflict' && (
                  <span role="alert">实退累计已超过退款目标，请人工核对</span>
                )}
                {aftersalesCase.refund.status === 'ended' && <span>已带原因结束退款（未足额）</span>}
              </div>
              {aftersalesCase.refund.timeline.length > 0 && (
                <details className="shipment-record-card__timeline">
                  <summary>退款完整历史</summary>
                  <ol>
                    {aftersalesCase.refund.timeline.map((event) => (
                      <li key={`${event.kind}-${event.createdAt}`}>
                        <strong>{refundEventLabel(event.kind)}</strong>
                        <span>
                          {event.kind === 'target_adjusted'
                            ? `${formatMoney(event.beforeAmountCents ?? 0)} → ${formatMoney(event.requestedAmountCents)}`
                            : `申请 ${formatMoney(event.requestedAmountCents)}${
                              event.actualAmountCents === null
                                ? ''
                                : ` · 实际 ${formatMoney(event.actualAmountCents)}`
                            }`}
                          {' · '}{event.reason}
                        </span>
                        <small>{formatDateTime(event.occurredAt)}</small>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
          {aftersalesReturnsForPresentation(aftersalesCase).map((returnRecord) => (
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
              {returnRecord.logisticsExceptions
                .filter(({ stage }) => isUnresolvedLogisticsExceptionStage(stage))
                .map((exception) => (
                  <div className="shipment-record-card__return-exception" role="status" key={exception.id}>
                    <strong>
                      物流异常 · {logisticsExceptionTypeLabel(
                        exception.exceptionType,
                      )} · {logisticsExceptionStageLabel(exception.stage)}
                    </strong>
                    <span>{exception.reason}</span>
                    <ul aria-label="退货物流异常受影响商品">
                      {returnExceptionAffectedItems(returnRecord, exception).map((item) => (
                        <li key={item.id}>
                          <span>{item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</span>
                          <strong>× {item.quantity}</strong>
                        </li>
                      ))}
                    </ul>
                    {aftersalesCase.coordination.returnException?.exceptionId === exception.id && (
                      <span>
                        退货异常处理：{aftersalesCase.coordination.returnException.decision
                          ? returnExceptionDecisionLabel(
                            aftersalesCase.coordination.returnException.decision,
                          )
                          : '待选择'}
                        {' · '}影响 {aftersalesCase.coordination.returnException.affectedQuantity} 件
                      </span>
                    )}
                    <button
                      className="button button--quiet"
                      type="button"
                      aria-label={`推进退货物流异常 ${logisticsExceptionTypeLabel(exception.exceptionType)}`}
                      onClick={() => setProgressTarget({
                        aftersalesCase: {
                          ...aftersalesCase,
                          returns: aftersalesCase.returns.map((candidate) => candidate.id === returnRecord.id
                            ? {
                              ...candidate,
                              currentException: { ...exception, direction: 'return' as const },
                            }
                            : candidate),
                        },
                        kind: 'progress_return_logistics_exception',
                        returnRecordId: returnRecord.id,
                      })}
                    >
                      推进此异常
                    </button>
                  </div>
                ))}
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
                {returnRecord.status === 'in_transit' && (
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
                )}
                {(returnRecord.status === 'in_transit'
                  || returnRecord.currentException
                  || returnRecord.status === 'received'
                  || returnRecord.status === 'inspected') && (
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
                )}
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
              {returnRecord.logisticsExceptions.length > 0 && (
                <details className="shipment-record-card__timeline">
                  <summary>退货物流异常完整历史</summary>
                  <ol>
                    {returnRecord.logisticsExceptions.flatMap((exception) => (
                      exception.timeline.map((event) => (
                        <li key={`${exception.id}-${event.resultRevision}`}>
                          <strong>{logisticsExceptionTypeLabel(exception.exceptionType)}</strong>
                          <span>{logisticsExceptionEventDescription(event)}</span>
                          <small>{formatDateTime(event.occurredAt)}</small>
                        </li>
                      ))
                    ))}
                  </ol>
                </details>
              )}
              {returnRecord.carrierClaim && (
                <details className="shipment-record-card__timeline">
                  <summary>承运索赔完整历史</summary>
                  <ol>
                    {returnRecord.carrierClaim.timeline.map((event) => (
                      <li key={`${event.kind}-${event.resultRevision}`}>
                        <strong>{carrierClaimEventLabel(event.kind)}</strong>
                        <span>{carrierClaimEventDescription(event)}</span>
                        <small>{formatDateTime(event.occurredAt)}</small>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </section>
          ))}
          {aftersalesCase.status === 'completed' || aftersalesCase.status === 'cancelled' ? (
            operations.primary.length === 0 && operations.supplemental.length === 0
              && aftersalesCase.coordination.interception?.status !== 'requested' ? (
              <small>后续独立问题请另行建立售后处理单</small>
            ) : (
              <div className="shipment-record-card__aftersales-actions">
                {interceptionResultButton}
                {operations.primary.map((operation) => renderWorkflowOperation(operation, 'primary'))}
                {renderSupplementalFacts()}
              </div>
            )
          ) : (
            <div className="shipment-record-card__aftersales-actions">
              {interceptionResultButton}
              {!outboundDecisionDerived
                && aftersalesCase.coordination.outboundException
                && aftersalesCase.coordination.outboundException.decision === null && (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: 'decide_outbound_logistics_exception',
                    outboundExceptionId:
                      aftersalesCase.coordination.outboundException?.exceptionId,
                  })}
                >
                  {progressActionLabel('decide_outbound_logistics_exception')}
                </button>
              )}
              {aftersalesCase.coordination.outboundExceptionHistory
                .filter((exception) => exception.stage === 'confirmed')
                .map((exception) => {
                  const isPrimaryUndecided = exception.exceptionId
                    === aftersalesCase.coordination.outboundException?.exceptionId
                    && exception.decision === null;
                  if (isPrimaryUndecided) return null;
                    return (
                      <button
                        key={`outbound-exception-action-${exception.exceptionId}`}
                        className="button button--quiet"
                        type="button"
                        onClick={() => setProgressTarget({
                          aftersalesCase,
                          kind: 'decide_outbound_logistics_exception',
                          outboundExceptionId: exception.exceptionId,
                        })}
                      >
                        {exception.decision ? '更改正向异常处理' : '选择正向异常处理'}
                      </button>
                    );
                  })}
              {aftersalesCase.coordination.returnException !== null
                && aftersalesCase.coordination.returnException.decision === null && (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => setProgressTarget({
                    aftersalesCase,
                    kind: 'decide_return_logistics_exception',
                    returnRecordId: aftersalesCase.coordination.returnException?.returnRecordId,
                  })}
                >
                  {progressActionLabel('decide_return_logistics_exception')}
                </button>
              )}
              {aftersalesCase.workflow === 'return_refund'
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
              {operations.primary.map((operation) => renderWorkflowOperation(operation, 'primary'))}
              {renderSupplementalFacts()}
              {aftersalesCase.rounds
                .filter(({ replacementShipment }) => replacementShipment !== null)
                .map((round) => (
                  <button
                    key={`start-next-round-${round.id}`}
                    className="button button--quiet"
                    type="button"
                    onClick={() => setProgressTarget({
                      aftersalesCase,
                      kind: 'start_next_round',
                      roundId: round.id,
                    })}
                  >
                    第 {round.roundNumber} 轮补发再次出现问题
                  </button>
                ))}
              {aftersalesCase.status === 'ready_to_complete'
                && !operations.primary.some(({ action }) => action === 'complete') && (
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => setProgressTarget({ aftersalesCase, kind: 'complete' })}
                >
                  {progressActionLabel('complete')}
                </button>
              )}
              {aftersalesCase.workflow === 'general' && (
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => onUpdate(aftersalesCase)}
                >
                  更新售后处理
                </button>
              )}
              <button
                className="button button--quiet"
                type="button"
                onClick={() => setProgressTarget({ aftersalesCase, kind: 'cancel' })}
              >
                取消售后
              </button>
            </div>
          )}
          <details
            className="shipment-record-card__timeline"
            onToggle={(event) => {
              if ((event.target as HTMLDetailsElement).open) {
                loadInventoryImpact(aftersalesCase.id);
              }
            }}
          >
            <summary>库存影响</summary>
            {(() => {
              const impact = inventoryImpactByCase[aftersalesCase.id];
              if (!impact || impact.state === 'loading') {
                return <small>正在读取库存影响…</small>;
              }
              if (impact.state === 'error') {
                return <small>库存影响读取失败，请收起后重新展开</small>;
              }
              if (impact.movements.length === 0) {
                return <small>本售后尚未产生库存变化</small>;
              }
              return (
                <ol aria-label="本售后相关的库存流水">
                  {impact.movements.map((movement) => (
                    <li key={movement.id}>
                      <strong>
                        {movement.direction === 'in' ? '+' : '−'}{movement.quantity} {' '}
                        {inventoryStateLabel(movement.state)}
                      </strong>
                      <span>
                        {movement.name}{movement.specification ? ` · ${movement.specification}` : ''}
                        {' · '}{inventoryMovementSourceLabel(movement.sourceType)}
                        {' · '}{movement.reason}
                      </span>
                      <small>{formatDateTime(movement.occurredAt)}</small>
                    </li>
                  ))}
                </ol>
              );
            })()}
          </details>
          <details
            className="shipment-record-card__timeline"
            onToggle={(event) => {
              if ((event.target as HTMLDetailsElement).open) {
                loadFundsImpact(aftersalesCase.id);
              }
            }}
          >
            <summary>资金影响</summary>
            {(() => {
              const impact = fundsByCase[aftersalesCase.id];
              if (!impact || impact.state === 'loading') {
                return <small>正在读取资金影响…</small>;
              }
              if (impact.state === 'error') {
                return <small>资金影响读取失败，请收起后重新展开</small>;
              }
              return (
                <>
                  <FinanceFactsSummary facts={impact.facts} />
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => setRecordFundsTarget({
                      caseId: aftersalesCase.id,
                      preset: {
                        sourceType: 'aftersales_case',
                        sourceId: aftersalesCase.id,
                        sourceLabel: `售后处理单 · ${aftersalesCase.reason}`,
                        defaultType: 'return_freight',
                      },
                    })}
                  >
                    记运费 / 拦截费
                  </button>
                </>
              );
            })()}
          </details>
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
            || aftersalesCase.coordination.outboundExceptionHistory.some(
              ({ timeline }) => timeline.length > 0,
            )
            || aftersalesCase.coordination.interceptedReturnInspection
            || aftersalesCase.coordination.returnExceptionHistory.some(
              ({ timeline }) => timeline.length > 0,
            )) && (
            <details className="shipment-record-card__timeline">
              <summary>售后协调完整历史</summary>
              <ol>
                {aftersalesCase.coordination.handlingDirectionTimeline.map((event, index) => (
                  <li key={`direction-${index}-${event.occurredAt}`}>
                    <strong>{event.kind === 'selected'
                      ? '选择处理方向'
                      : event.kind === 'cleared' ? '结束处理方向' : '转换处理方向'}</strong>
                    <span>
                      {event.before ? `${aftersalesHandlingDirectionLabel(event.before)} → ` : ''}
                      {event.after ? aftersalesHandlingDirectionLabel(event.after) : '无指定处理方向'} · {event.reason}
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
                {aftersalesCase.coordination.outboundExceptionHistory.flatMap((exception) => (
                  exception.timeline.map((event, index) => (
                    <li key={`outbound-exception-decision-${exception.exceptionId}-${index}`}>
                      <strong>{event.kind === 'selected'
                        ? '选择正向异常处理'
                        : '更改正向异常处理'}</strong>
                      <span>
                        {event.before ? `${outboundExceptionDecisionLabel(event.before)} → ` : ''}
                        {outboundExceptionDecisionLabel(event.after)} · {event.reason}
                      </span>
                      <small>{formatDateTime(event.occurredAt)}</small>
                    </li>
                  ))
                ))}
                {aftersalesCase.coordination.interceptedReturnInspection && (
                  <li key={`intercepted-return-inspection-${aftersalesCase.coordination.interceptedReturnInspection.packageId}`}>
                    <strong>检查拦截退回商品</strong>
                    <span>
                      {inspectionResultLabel(
                        aftersalesCase.coordination.interceptedReturnInspection.result,
                      )} · {aftersalesCase.coordination.interceptedReturnInspection.reason}
                    </span>
                    <small>{formatDateTime(
                      aftersalesCase.coordination.interceptedReturnInspection.occurredAt,
                    )}</small>
                  </li>
                )}
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
        );
      })}
      {progressTarget && (
        <ProgressAftersalesCaseDialog
          aftersalesCase={progressTarget.aftersalesCase}
          kind={progressTarget.kind}
          returnRecordId={progressTarget.returnRecordId}
          outboundExceptionId={progressTarget.outboundExceptionId}
          roundId={progressTarget.roundId}
          onProgress={onProgress}
          onClose={() => setProgressTarget(null)}
        />
      )}
      {workflowTarget && (
        <ChangeAftersalesWorkflowDialog
          api={api}
          aftersalesCase={workflowTarget}
          onApplied={onChangeWorkflow}
          onClose={() => setWorkflowTarget(null)}
        />
      )}
      {stepEventTarget && (
        <RecordAftersalesWorkflowStepEventDialog
          aftersalesCase={stepEventTarget.aftersalesCase}
          stepId={stepEventTarget.step.id}
          stepName={stepNameById(stepEventTarget.aftersalesCase, stepEventTarget.step.id)}
          kind={stepEventTarget.kind}
          onRecorded={onRecordStepEvent}
          onClose={() => setStepEventTarget(null)}
        />
      )}
      {recordFundsTarget && (
        <FinanceRecordDialog
          api={api}
          preset={recordFundsTarget.preset}
          onClose={() => setRecordFundsTarget(null)}
          onSaved={() => {
            setFundsByCase((previous) => {
              const next = { ...previous };
              delete next[recordFundsTarget.caseId];
              return next;
            });
            loadFundsImpact(recordFundsTarget.caseId);
          }}
        />
      )}
    </div>
  );
}

function stepNameById(aftersalesCase: AftersalesCase, stepId: string): string {
  return aftersalesCase.workflowTemplate.steps.find(({ id }) => id === stepId)?.name ?? stepId;
}

function stepProgressLabel(step: {
  progress: AftersalesWorkflowStepProjection['progress'];
}): string {
  const progress = step.progress;
  if (!progress) return '';
  if (progress.kind === 'amount') {
    return `已退 ${formatMoney(progress.refundedCents)} / ${formatMoney(progress.targetCents)}`;
  }
  return `已完成 ${progress.doneQuantity} / ${progress.totalQuantity} 件`;
}

function operationTargets(
  aftersalesCase: AftersalesCase,
  action: ProgressAftersalesCaseInput['kind'],
): {
  kind: ProgressAftersalesCaseInput['kind'];
  returnRecordId?: string;
  outboundExceptionId?: string;
  roundId?: string;
} {
  if (action === 'receive_return' || action === 'inspect_return') {
    const preferredStatus = action === 'receive_return' ? 'in_transit' : 'received';
    const returnRecord = aftersalesCase.returns.find(({ status }) => (
      status === preferredStatus
    )) ?? aftersalesCase.returns.at(-1);
    return { kind: action, returnRecordId: returnRecord?.id };
  }
  if (action === 'decide_outbound_logistics_exception') {
    const exceptionId = aftersalesCase.coordination.outboundException?.exceptionId
      ?? aftersalesCase.coordination.outboundExceptionHistory.find(({ stage }) => (
        stage === 'confirmed'
      ))?.exceptionId;
    return { kind: action, outboundExceptionId: exceptionId };
  }
  if (action === 'create_replacement_shipment') {
    const round = aftersalesCase.rounds.find((candidate) => (
      candidate.replacementRequired && candidate.replacementShipment === null
    ));
    return { kind: action, roundId: round?.id };
  }
  if (action === 'start_next_round') {
    const round = [...aftersalesCase.rounds]
      .reverse().find(({ replacementShipment }) => replacementShipment !== null);
    return { kind: action, roundId: round?.id };
  }
  return { kind: action };
}

function progressActionLabel(kind: ProgressAftersalesCaseInput['kind']): string {
  const labels: Record<ProgressAftersalesCaseInput['kind'], string> = {
    cancel_refund_request: '取消本次退款申请',
    decide_outbound_logistics_exception: '选择正向异常处理',
    inspect_intercepted_return: '检查拦截退回商品',
    create_replacement_shipment: '建立本轮补发',
    start_next_round: '登记新一轮问题',
    record_interception_result: '登记拦截结果',
    change_handling_direction: '转换处理方向',
    register_return: '登记退货物流',
    receive_return: '确认收到退货',
    inspect_return: '记录退货检查',
    confirm_refund: '确认实际退款',
    adjust_refund_target: '调整退款目标金额',
    end_refund: '结束退款',
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

function outboundExceptionDecisionLabel(
  decision: NonNullable<AftersalesCase['coordination']['outboundException']>['decision'],
): string {
  return {
    wait_investigation: '继续等待调查',
    recover_or_redeliver: '追回或重新派送',
    refund_only: '仅退款',
    replacement: '直接补发',
    refund_and_replacement: '退款并补发',
  }[decision ?? 'wait_investigation'];
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

function carrierClaimEventDescription(
  event: NonNullable<AftersalesCase['returns'][number]['carrierClaim']>['timeline'][number],
): string {
  if (event.kind === 'opened') {
    return `申请 ${formatMoney(event.requestedAmountCents)} · ${event.reason}`;
  }
  if (event.kind === 'approved') {
    return `同意 ${formatMoney(event.approvedAmountCents as number)} · ${event.reason}`;
  }
  if (event.kind === 'rejected') return event.reason;
  if (event.kind === 'compensation_confirmed') {
    return `实际赔付 ${formatMoney(event.amountCents)} · ${event.note}`;
  }
  return '';
}

function refundEventLabel(
  kind: 'created' | 'confirmed' | 'cancelled' | 'reopened' | 'target_adjusted' | 'ended',
): string {
  return {
    created: '申请退款',
    confirmed: '确认实际退款',
    cancelled: '取消退款申请',
    reopened: '重新申请退款',
    target_adjusted: '调整退款目标',
    ended: '结束退款',
  }[kind];
}

function logisticsExceptionEventDescription(
  event: AftersalesCase['returns'][number]['logisticsExceptions'][number]['timeline'][number],
): string {
  if (event.kind === 'opened') {
    return `${logisticsExceptionStageLabel(event.stage)} · ${event.reason}`;
  }
  return `${logisticsExceptionStageLabel(event.beforeStage)} → ${logisticsExceptionStageLabel(event.afterStage)} · ${event.reason}`;
}

function returnExceptionAffectedItems(
  returnRecord: AftersalesCase['returns'][number],
  exception: AftersalesCase['returns'][number]['logisticsExceptions'][number],
): Array<{ id: string; sourceTitle: string; sourceSpec: string; quantity: number }> {
  if (exception.impact.scope === 'package') {
    return returnRecord.items.map((item) => ({
      id: item.id,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      quantity: item.quantity,
    }));
  }
  const quantityById = new Map(exception.impact.items.map(({ sourceItemId, quantity }) => (
    [sourceItemId, quantity] as const
  )));
  return returnRecord.items.flatMap((item) => {
    const quantity = quantityById.get(item.id);
    return quantity === undefined ? [] : [{
      id: item.id,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      quantity: Math.min(item.quantity, quantity),
    }];
  });
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

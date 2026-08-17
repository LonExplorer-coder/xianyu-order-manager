import { randomUUID } from 'node:crypto';

import {
  isAftersalesReturnLogisticsStatus,
  isAftersalesStatus,
  isAftersalesWorkflow,
  normalizeChangeAftersalesCaseWorkflowTemplateInput,
  normalizeAftersalesCaseQuery,
  normalizeCreateAftersalesCaseInput,
  normalizeProgressAftersalesCaseInput,
  normalizeRecordAftersalesWorkflowStepEventInput,
  normalizeUpdateAftersalesCaseInput,
  isSettledRefundStatus,
  projectAftersalesRefundFulfillment,
  type AftersalesCase,
  type AftersalesCaseEvent,
  type AftersalesCaseItem,
  type AftersalesCaseItemInput,
  type AftersalesCaseSnapshot,
  type AftersalesCaseStepEvent,
  type AftersalesCaseWorkflowTemplate,
  type AftersalesCaseWorkflowTemplateEvent,
  type AftersalesFulfillmentSummary,
  type AftersalesProcessingRound,
  type ProgressAftersalesCaseInput,
  type AftersalesReturnDiscrepancy,
  type AftersalesReturnRecord,
} from '../core/aftersales-cases';
import {
  AFTERSALES_WORKFLOW_STEP_BINDINGS,
  projectAftersalesWorkflowSteps,
} from '../core/aftersales-workflow-templates';
import {
  coordinateAftersales,
  isAftersalesHandlingDirection,
  isAftersalesOutboundExceptionDecision,
  isAftersalesReturnExceptionDecision,
  statusForHandlingDirection,
  type AftersalesHandlingDirection,
  type AftersalesHandlingDirectionEvent,
  type AftersalesInterception,
  type AftersalesInterceptionEvent,
  type AftersalesInterceptedReturnInspection,
  type AftersalesOutboundExceptionDecisionEvent,
  type AftersalesOutboundExceptionEvidence,
  type AftersalesPhysicalControl,
  type AftersalesReturnExceptionDecisionEvent,
  type AftersalesReturnExceptionEvidence,
  type AftersalesSourcePackageEvidence,
} from '../core/aftersales-coordination';
import {
  isOutboundLogisticsStatus,
  prepareLogisticsCorrection,
  prepareLogisticsStatusChange,
} from '../core/logistics-exceptions';
import { LogisticsExceptionService } from './logistics-exception-service';
import { AftersalesWorkflowTemplateService } from './aftersales-workflow-template-service';
import { Workspace } from './workspace';
import type { ShipmentRecord } from '../core/shipment-records';

type SqlRow = Record<string, string | number | null>;

export class AftersalesApplicationService {
  public constructor(
    private readonly workspace: Workspace,
    private readonly shipmentRecordReader?: (recordId: string) => ShipmentRecord,
  ) {}

  public create(input: unknown): AftersalesCase {
    const prepared = normalizeCreateAftersalesCaseInput(input);
    const workflowTemplate = this.aftersalesWorkflowTemplateService().requireEnabledCurrent(
      prepared.workflowTemplateId,
    );
    const workflow = workflowTemplate.workflow;
    if (workflowTemplate.scenario === 'intercept_return'
      && prepared.handlingDirection !== 'intercept') {
      throw new Error('拦截退回流程必须明确选择申请拦截');
    }
    if (workflow !== 'refund_only' && workflow !== 'return_refund'
      && prepared.requestedRefundCents !== undefined) {
      throw new Error('当前售后流程不能登记申请退款金额');
    }
    const activeParent = this.workspace.database.prepare(`
      SELECT cases.id
      FROM aftersales_replacement_shipments AS replacements
      JOIN aftersales_processing_rounds AS rounds ON rounds.id = replacements.round_id
      JOIN aftersales_cases AS cases ON cases.id = rounds.case_id
      WHERE replacements.shipment_record_id = ?
        AND cases.status NOT IN ('completed', 'cancelled')
      LIMIT 1
    `).get(prepared.shipmentRecordId) as SqlRow | undefined;
    if (activeParent) {
      throw new Error('补发商品仍属于未完成的售后处理，请在原处理单新增轮次');
    }
    const sourceItems = this.resolveSourceItems(prepared.shipmentRecordId, prepared.items);
    this.assertQuantitiesAvailable(prepared.items, sourceItems);
    const sourcePackages = sourcePackageEvidence(prepared.items, sourceItems);
    const initialCoordination = coordinateAftersales({
      handlingDirection: null,
      sourcePackages,
      interception: null,
    });
    const handlingDirection = initialHandlingDirection({
      workflow,
      requested: prepared.handlingDirection,
      physicalControl: initialCoordination.physicalControl,
      availableDirections: initialCoordination.availableDirections,
    });
    const interceptionPackageId = handlingDirection === 'intercept'
      ? resolveInterceptionPackageId(
        prepared.interceptionPackageId,
        sourcePackages.map(({ packageId }) => packageId),
      )
      : null;
    const caseId = randomUUID();
    const initialStatus = workflow === 'refund_only'
      ? 'waiting_refund'
      : handlingDirection === null
        ? 'processing'
      : statusForHandlingDirection(handlingDirection);
    const now = new Date().toISOString();
    const snapshot: AftersalesCaseSnapshot = {
      status: initialStatus,
      reason: prepared.reason,
      items: prepared.items,
    };
    this.workspace.transaction(() => {
      this.workspace.database.prepare(`
        INSERT INTO aftersales_cases (
          id, shipment_record_id, workflow, status, revision, reason, handling_direction,
          occurred_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        caseId,
        prepared.shipmentRecordId,
        workflow,
        initialStatus,
        prepared.reason,
        handlingDirection,
        prepared.occurredAt,
        now,
        now,
      );
      this.workspace.database.prepare(`
        INSERT INTO aftersales_case_workflow_template_events (
          id, case_id, kind, before_template_id, before_template_version,
          after_template_id, after_template_version, reason, occurred_at, created_at
        ) VALUES (?, ?, 'selected', NULL, NULL, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        caseId,
        workflowTemplate.id,
        workflowTemplate.version,
        prepared.reason,
        prepared.occurredAt,
        now,
      );
      const insertItem = this.workspace.database.prepare(`
        INSERT INTO aftersales_case_items (
          id, case_id, shipment_package_item_id, quantity
        ) VALUES (?, ?, ?, ?)
      `);
      for (const item of prepared.items) {
        insertItem.run(randomUUID(), caseId, item.shipmentPackageItemId, item.quantity);
      }
      const roundId = randomUUID();
      this.workspace.database.prepare(`
        INSERT INTO aftersales_processing_rounds (
          id, case_id, round_number, workflow, source_shipment_record_id,
          occurred_at, reason, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        roundId,
        caseId,
        handlingDirection === 'replacement'
          ? 'direct_replacement'
          : workflow === 'exchange' || workflow === 'direct_replacement'
          ? workflow
          : 'legacy',
        prepared.shipmentRecordId,
        prepared.occurredAt,
        prepared.reason,
        now,
      );
      const insertRoundItem = this.workspace.database.prepare(`
        INSERT INTO aftersales_processing_round_items (
          id, round_id, source_shipment_package_item_id, quantity
        ) VALUES (?, ?, ?, ?)
      `);
      for (const item of prepared.items) {
        insertRoundItem.run(
          randomUUID(),
          roundId,
          item.shipmentPackageItemId,
          item.quantity,
        );
      }
      if (handlingDirection !== null) {
        this.workspace.database.prepare(`
          INSERT INTO aftersales_handling_direction_events (
            id, case_id, kind, before_direction, after_direction,
            occurred_at, reason, created_at
          ) VALUES (?, ?, 'selected', NULL, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          caseId,
          handlingDirection,
          prepared.occurredAt,
          prepared.reason,
          now,
        );
      }
      if (handlingDirection === 'intercept') {
        this.workspace.database.prepare(`
          INSERT INTO aftersales_interception_packages (
            case_id, shipment_package_id, created_at
          ) VALUES (?, ?, ?)
        `).run(caseId, interceptionPackageId, now);
        this.workspace.database.prepare(`
          INSERT INTO aftersales_interception_events (
            id, case_id, kind, occurred_at, reason, created_at
          ) VALUES (?, ?, 'requested', ?, ?, ?)
        `).run(randomUUID(), caseId, prepared.occurredAt, prepared.reason, now);
      }
      if (workflow === 'refund_only' || workflow === 'return_refund') {
        const pendingItemId = randomUUID();
        const requestedAmountCents = prepared.requestedRefundCents;
        if (requestedAmountCents === undefined) throw new Error('申请退款金额无效');
        this.workspace.database.prepare(`
          INSERT INTO pending_financial_items (
            id, kind, aftersales_case_id, requested_amount_cents,
            status, created_at, resolved_at
          ) VALUES (?, 'aftersales_refund', ?, ?, 'pending', ?, NULL)
        `).run(pendingItemId, caseId, requestedAmountCents, now);
        this.workspace.database.prepare(`
          INSERT INTO pending_financial_item_events (
            id, pending_item_id, kind, requested_amount_cents,
            actual_amount_cents, reason, occurred_at, created_at
          ) VALUES (?, ?, 'created', ?, NULL, ?, ?, ?)
        `).run(
          randomUUID(), pendingItemId, requestedAmountCents,
          prepared.reason, prepared.occurredAt, now,
        );
      }
      this.workspace.database.prepare(`
        INSERT INTO aftersales_case_events (
          id, case_id, kind, base_revision, result_revision,
          before_snapshot_json, after_snapshot_json, change_reason, created_at
        ) VALUES (?, ?, 'created', 0, 1, NULL, ?, '', ?)
      `).run(randomUUID(), caseId, JSON.stringify(snapshot), now);
    });
    return this.get(caseId);
  }

  public query(input?: unknown): AftersalesCase[] {
    const query = normalizeAftersalesCaseQuery(input);
    const clauses: string[] = [];
    const values: string[] = [];
    if (query.status) {
      clauses.push('status = ?');
      values.push(query.status);
    }
    if (query.shipmentRecordId) {
      clauses.push('shipment_record_id = ?');
      values.push(query.shipmentRecordId);
    }
    const rows = this.workspace.database.prepare(`
      SELECT id
      FROM aftersales_cases
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, created_at DESC, id DESC
    `).all(...values) as unknown as SqlRow[];
    return rows.map((row) => this.get(asString(row.id)));
  }

  // 管理型步骤的人工完成或带原因跳过留痕；事实型步骤一律拒绝，真实事实只能通过领域动作补录。
  public recordStepEvent(input: unknown): AftersalesCase {
    const prepared = normalizeRecordAftersalesWorkflowStepEventInput(input);
    const current = this.get(prepared.caseId);
    if (current.status === 'completed' || current.status === 'cancelled') {
      throw new Error('已经结束的售后处理单不能登记流程步骤');
    }
    if (current.revision !== prepared.expectedRevision) {
      throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
    }
    const step = current.workflowTemplate.steps.find(({ id }) => id === prepared.stepId);
    if (!step) throw new Error('售后流程步骤不存在');
    if (step.kind === null) {
      throw new Error('需要检查的流程步骤未绑定业务动作，请先修正模板');
    }
    if (AFTERSALES_WORKFLOW_STEP_BINDINGS[step.kind].category !== 'management') {
      throw new Error('事实型流程步骤只能由真实业务事实满足');
    }
    if (current.workflowTemplate.stepEvents.some(({ stepId }) => stepId === prepared.stepId)) {
      throw new Error('该流程步骤已登记完成或跳过');
    }
    const projection = projectAftersalesWorkflowSteps(current.workflowTemplate, current)
      .find(({ id }) => id === prepared.stepId);
    if (!projection) {
      throw new Error('该流程步骤在当前流程条件下不可用');
    }
    if (projection.state === 'completed') {
      throw new Error('该流程步骤已由业务事实满足');
    }
    if (projection.state !== 'current' && projection.state !== 'not_started') {
      throw new Error('该流程步骤当前不能登记完成或跳过');
    }
    const latestTemplateEvent = current.workflowTemplate.timeline.at(-1);
    if (latestTemplateEvent) {
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        latestTemplateEvent.occurredAt,
        '流程步骤事件时间不能早于上一次流程选择',
      );
    }
    const now = new Date().toISOString();
    const snapshot: AftersalesCaseSnapshot = {
      status: current.status,
      reason: current.reason,
      items: current.items.map(({ shipmentPackageItemId, quantity }) => ({
        shipmentPackageItemId,
        quantity,
      })),
    };
    this.workspace.transaction(() => {
      this.workspace.database.prepare(`
        INSERT INTO aftersales_case_step_events (
          id, case_id, step_id, kind, reason, remaining_risk,
          workflow_template_id, workflow_template_version, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        current.id,
        prepared.stepId,
        prepared.kind,
        prepared.reason,
        prepared.remainingRisk ?? null,
        current.workflowTemplate.templateId,
        current.workflowTemplate.version,
        prepared.occurredAt,
        now,
      );
      const updated = this.workspace.database.prepare(`
        UPDATE aftersales_cases
        SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(now, current.id, current.revision);
      if (updated.changes !== 1) {
        throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
      }
      // 步骤事件不改变案件快照，但版本递增必须在处理单事件链上留痕，保持版本一一对应。
      this.workspace.database.prepare(`
        INSERT INTO aftersales_case_events (
          id, case_id, kind, base_revision, result_revision,
          before_snapshot_json, after_snapshot_json, change_reason, created_at
        ) VALUES (?, ?, 'updated', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        current.id,
        current.revision,
        current.revision + 1,
        JSON.stringify(snapshot),
        JSON.stringify(snapshot),
        prepared.reason,
        now,
      );
    });
    return this.get(current.id);
  }

  public changeWorkflowTemplate(input: unknown): AftersalesCase {
    const prepared = normalizeChangeAftersalesCaseWorkflowTemplateInput(input);
    const current = this.get(prepared.caseId);
    if (current.status === 'completed' || current.status === 'cancelled') {
      throw new Error('已结束的售后处理单不能调整后续流程');
    }
    if (current.revision !== prepared.expectedRevision) {
      throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
    }
    const target = this.aftersalesWorkflowTemplateService().requireEnabledCurrent(
      prepared.workflowTemplateId,
    );
    if (current.workflowTemplate.templateId === target.id
      && current.workflowTemplate.version === target.version) {
      throw new Error('售后流程没有变化');
    }
    const latestTemplateEvent = current.workflowTemplate.timeline.at(-1);
    if (!latestTemplateEvent) throw new Error('售后处理单缺少流程模板版本');
    assertOccurredAtNotBefore(
      prepared.occurredAt,
      latestTemplateEvent.occurredAt,
      '售后流程调整时间不能早于上一次流程选择',
    );

    const targetDirection = initialHandlingDirection({
      workflow: target.workflow,
      requested: prepared.handlingDirection
        ?? (target.workflow === current.workflow
          ? current.coordination.handlingDirection ?? undefined
          : undefined),
      physicalControl: current.coordination.physicalControl,
      availableDirections: current.coordination.availableDirections,
    });
    if (target.scenario === 'intercept_return' && targetDirection !== 'intercept') {
      throw new Error('拦截退回流程必须明确选择申请拦截');
    }
    const shouldRequestInterception = targetDirection === 'intercept'
      && current.coordination.handlingDirection !== 'intercept';
    if (shouldRequestInterception
      && current.coordination.interception?.status === 'requested') {
      throw new Error('已有待确认的拦截请求，请先登记结果');
    }
    const targetInterceptionPackageId = shouldRequestInterception
      ? resolveInterceptionPackageId(
        prepared.interceptionPackageId,
        current.coordination.sourcePackages.map(({ packageId }) => packageId),
      )
      : null;
    if ((target.workflow === 'refund_only' || target.workflow === 'return_refund')
      && current.refund === null && prepared.requestedRefundCents === undefined) {
      throw new Error('请先填写本次申请退款金额');
    }
    if (target.workflow !== 'refund_only' && target.workflow !== 'return_refund'
      && prepared.requestedRefundCents !== undefined) {
      throw new Error('当前售后流程不能登记申请退款金额');
    }
    const newRefundCents = current.refund === null
      && (target.workflow === 'refund_only' || target.workflow === 'return_refund')
      ? prepared.requestedRefundCents ?? null
      : null;
    const refundSettled = isSettledRefundStatus(current.refund?.status ?? null);
    const nextStatus = target.workflow === 'refund_only'
      ? refundSettled ? 'ready_to_complete' : 'waiting_refund'
      : targetDirection === null
        ? 'processing'
        : statusForHandlingDirection(targetDirection);
    const before: AftersalesCaseSnapshot = {
      status: current.status,
      reason: current.reason,
      items: current.items.map(({ shipmentPackageItemId, quantity }) => ({
        shipmentPackageItemId,
        quantity,
      })),
    };
    const after: AftersalesCaseSnapshot = { ...before, status: nextStatus };
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const updated = this.workspace.database.prepare(`
        UPDATE aftersales_cases
        SET workflow = ?, status = ?, handling_direction = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        target.workflow,
        nextStatus,
        targetDirection,
        now,
        current.id,
        current.revision,
      );
      if (updated.changes !== 1) {
        throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
      }
      this.workspace.database.prepare(`
        INSERT INTO aftersales_case_workflow_template_events (
          id, case_id, kind, before_template_id, before_template_version,
          after_template_id, after_template_version, reason, occurred_at, created_at
        ) VALUES (?, ?, 'changed', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        current.id,
        current.workflowTemplate.templateId,
        current.workflowTemplate.version,
        target.id,
        target.version,
        prepared.reason,
        prepared.occurredAt,
        now,
      );
      this.workspace.database.prepare(`
        INSERT INTO aftersales_case_events (
          id, case_id, kind, base_revision, result_revision,
          before_snapshot_json, after_snapshot_json, change_reason, created_at
        ) VALUES (?, ?, 'updated', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        current.id,
        current.revision,
        current.revision + 1,
        JSON.stringify(before),
        JSON.stringify(after),
        prepared.reason,
        now,
      );
      if (targetDirection !== current.coordination.handlingDirection) {
        const beforeDirection = current.coordination.handlingDirection;
        this.workspace.database.prepare(`
          INSERT INTO aftersales_handling_direction_events (
            id, case_id, kind, before_direction, after_direction,
            occurred_at, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          current.id,
          targetDirection === null
            ? 'cleared'
            : beforeDirection === null ? 'selected' : 'changed',
          beforeDirection,
          targetDirection,
          prepared.occurredAt,
          prepared.reason,
          now,
        );
      }
      if (shouldRequestInterception && targetInterceptionPackageId) {
        this.requestInterception(
          current,
          targetInterceptionPackageId,
          prepared.occurredAt,
          prepared.reason,
          now,
        );
      }
      if (target.workflow !== current.workflow
        && (target.workflow === 'exchange' || target.workflow === 'direct_replacement')
        && !this.hasReusableSceneRound(current, target.workflow)) {
        this.createReplacementRound(
          current,
          target.workflow,
          current.shipmentRecordId,
          current.items.map((item) => ({
            shipmentPackageItemId: item.shipmentPackageItemId,
            quantity: item.quantity,
          })),
          prepared.occurredAt,
          prepared.reason,
          now,
        );
      }
      if (newRefundCents !== null) {
        const pendingItemId = randomUUID();
        this.workspace.database.prepare(`
          INSERT INTO pending_financial_items (
            id, kind, aftersales_case_id, requested_amount_cents,
            status, created_at, resolved_at
          ) VALUES (?, 'aftersales_refund', ?, ?, 'pending', ?, NULL)
        `).run(pendingItemId, current.id, newRefundCents, now);
        this.workspace.database.prepare(`
          INSERT INTO pending_financial_item_events (
            id, pending_item_id, kind, requested_amount_cents,
            actual_amount_cents, reason, occurred_at, created_at
          ) VALUES (?, ?, 'created', ?, NULL, ?, ?, ?)
        `).run(
          randomUUID(), pendingItemId, newRefundCents,
          prepared.reason, prepared.occurredAt, now,
        );
      }
    });
    return this.get(current.id);
  }

  public update(input: unknown): AftersalesCase {
    const prepared = normalizeUpdateAftersalesCaseInput(input);
    const current = this.get(prepared.caseId);
    if (current.workflow !== 'general') {
      throw new Error('仅退款和退货退款请使用对应的流程操作');
    }
    if (prepared.status === 'ready_to_complete') {
      throw new Error('待完成只能由已确认的退款事实产生');
    }
    if (current.status === 'completed' || current.status === 'cancelled') {
      throw new Error('已结束的售后处理单不能重新打开，请为新的独立问题另行建立处理单');
    }
    if (current.revision !== prepared.expectedRevision) {
      throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
    }
    const sourceItems = this.resolveSourceItems(current.shipmentRecordId, prepared.items);
    this.assertQuantitiesAvailable(
      prepared.items,
      sourceItems,
      current.id,
      prepared.status !== 'completed' && prepared.status !== 'cancelled',
    );
    const before: AftersalesCaseSnapshot = {
      status: current.status,
      reason: current.reason,
      items: current.items.map(({ shipmentPackageItemId, quantity }) => ({
        shipmentPackageItemId,
        quantity,
      })),
    };
    const after: AftersalesCaseSnapshot = {
      status: prepared.status,
      reason: prepared.reason,
      items: prepared.items,
    };
    if (sameSnapshot(before, after)) throw new Error('售后处理单内容没有变化');

    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const updated = this.workspace.database.prepare(`
        UPDATE aftersales_cases
        SET status = ?, revision = revision + 1, reason = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        prepared.status,
        prepared.reason,
        now,
        current.id,
        prepared.expectedRevision,
      );
      if (updated.changes !== 1) {
        throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
      }
      this.workspace.database.prepare(`
        DELETE FROM aftersales_case_items WHERE case_id = ?
      `).run(current.id);
      const insertItem = this.workspace.database.prepare(`
        INSERT INTO aftersales_case_items (
          id, case_id, shipment_package_item_id, quantity
        ) VALUES (?, ?, ?, ?)
      `);
      for (const item of prepared.items) {
        insertItem.run(randomUUID(), current.id, item.shipmentPackageItemId, item.quantity);
      }
      this.workspace.database.prepare(`
        INSERT INTO aftersales_case_events (
          id, case_id, kind, base_revision, result_revision,
          before_snapshot_json, after_snapshot_json, change_reason, created_at
        ) VALUES (?, ?, 'updated', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        current.id,
        current.revision,
        current.revision + 1,
        JSON.stringify(before),
        JSON.stringify(after),
        prepared.changeReason,
        now,
      );
    });
    return this.get(current.id);
  }

  public progress(input: unknown): AftersalesCase {
    const prepared = normalizeProgressAftersalesCaseInput(input);
    const current = this.get(prepared.caseId);
    const carriesRefundFromEarlierTemplate = current.refund !== null
      && current.workflowTemplate.timeline.at(-1)?.kind === 'changed'
      && current.workflowTemplate.scenario !== 'refund_only'
      && current.workflowTemplate.scenario !== 'return_refund';
    const lostHandlingProgress = current.workflowTemplate.scenario === 'lost_handling'
      && (
        prepared.kind === 'decide_outbound_logistics_exception'
        || prepared.kind === 'confirm_refund'
        || prepared.kind === 'cancel_refund_request'
        || prepared.kind === 'adjust_refund_target'
        || prepared.kind === 'end_refund'
        || prepared.kind === 'create_replacement_shipment'
        || prepared.kind === 'start_next_round'
        || prepared.kind === 'complete'
      );
    if (current.workflow === 'general'
      && !lostHandlingProgress
      && !(carriesRefundFromEarlierTemplate && (
        prepared.kind === 'confirm_refund'
        || prepared.kind === 'cancel_refund_request'
        || prepared.kind === 'adjust_refund_target'
        || prepared.kind === 'end_refund'
        || prepared.kind === 'complete'
      ))) {
      throw new Error('一般售后请使用状态更新功能');
    }
    if (current.revision !== prepared.expectedRevision) {
      throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
    }
    const continuesClosedReturn = prepared.kind === 'record_interception_result'
      || prepared.kind === 'inspect_intercepted_return'
      || prepared.kind === 'receive_return'
      || prepared.kind === 'inspect_return'
      || prepared.kind === 'correct_return_logistics'
      || prepared.kind === 'update_return_logistics_status'
      || prepared.kind === 'record_return_logistics_exception'
      || prepared.kind === 'progress_return_logistics_exception'
      || prepared.kind === 'decide_return_logistics_exception'
      || prepared.kind === 'open_carrier_claim'
      || prepared.kind === 'resolve_carrier_claim'
      || prepared.kind === 'confirm_carrier_compensation';
    if (
      (current.status === 'completed' || current.status === 'cancelled')
      && !continuesClosedReturn
    ) {
      throw new Error('已经结束的售后处理单不能继续推进');
    }
    const now = new Date().toISOString();
    if (prepared.kind === 'cancel_refund_request') {
      if (current.refund?.status !== 'pending') throw new Error('当前没有待处理的退款申请');
      if (current.refund.refundRecords.length > 0) {
        throw new Error('已发生实际退款，请改用结束退款或调整退款目标金额');
      }
      const confirmedDecisions = current.coordination.outboundExceptionHistory
        .filter((exception) => exception.stage === 'confirmed')
        .map(({ decision }) => decision);
      if (!carriesRefundFromEarlierTemplate
        && (!confirmedDecisions.includes('replacement')
        || confirmedDecisions.some((decision) => (
          decision === 'refund_only' || decision === 'refund_and_replacement'
        )))) {
        throw new Error('只有明确选择直接补发时才能取消本次退款申请');
      }
      const latestDecisionAt = current.coordination.outboundExceptionHistory
        .flatMap(({ timeline }) => timeline)
        .reduce((latest, event) => (
          Date.parse(event.occurredAt) > Date.parse(latest) ? event.occurredAt : latest
        ), current.occurredAt);
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        latestDecisionAt,
        '取消退款申请时间不能早于异常处理选择时间',
      );
      this.workspace.transaction(() => {
        this.cancelPendingRefund(current, prepared.reason, prepared.occurredAt, now);
        const replacementPending = this.replacementDeliveryPending(current);
        this.advanceCase(current, replacementPending
          ? 'waiting_replacement'
          : current.workflow === 'general' ? 'processing' : 'ready_to_complete',
        prepared.reason, now);
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'decide_outbound_logistics_exception') {
      const exception = current.coordination.outboundExceptionHistory.find((candidate) => (
        candidate.exceptionId === prepared.exceptionId
        && candidate.packageId === prepared.packageId
      ));
      if (!exception) {
        throw new Error('当前售后没有可处理的正向物流异常');
      }
      if (exception.stage !== 'confirmed') {
        throw new Error('当前正向物流异常已经结束');
      }
      const beforeDecision = exception.decision;
      if (beforeDecision === prepared.decision) throw new Error('正向物流异常处理选择没有变化');
      const linkedReplacementRounds = this.replacementRoundsForException(
        current,
        exception.exceptionId,
      );
      const changesAwayFromReplacement = prepared.decision !== 'replacement'
        && prepared.decision !== 'refund_and_replacement';
      if (changesAwayFromReplacement && linkedReplacementRounds.some((round) => (
        round.replacementShipment?.packages.some(({ status }) => status === 'active')
      ))) {
        throw new Error('当前异常已建立补发记录；未交寄请先作废，已交寄请走拦截或后续处置');
      }
      if ((prepared.decision === 'refund_only'
        || prepared.decision === 'refund_and_replacement')
        && (current.refund === null || current.refund.status === 'cancelled')
        && prepared.requestedRefundCents === undefined) {
        throw new Error('请先填写本次申请退款金额');
      }
      const latestDecisionAt = exception.timeline.at(-1)?.occurredAt ?? exception.occurredAt;
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        latestDecisionAt,
        '正向异常处理选择时间不能早于上一条选择',
      );
      const createsReplacement = prepared.decision === 'replacement'
        || prepared.decision === 'refund_and_replacement';
      const affectedItems = this.outboundExceptionAffectedItems(current, exception);
      if (affectedItems.length === 0) throw new Error('正向物流异常未影响当前售后商品');
      const nextDirection: AftersalesHandlingDirection = createsReplacement
        ? 'replacement'
        : prepared.decision === 'refund_only'
          ? 'only_refund'
          : 'waiting';
      this.workspace.transaction(() => {
        if ((prepared.decision === 'refund_only'
          || prepared.decision === 'refund_and_replacement')
          && (current.refund === null || current.refund.status === 'cancelled')) {
          this.createPendingRefund(
            current.id,
            prepared.requestedRefundCents as number,
            prepared.reason,
            prepared.occurredAt,
            now,
          );
        }
        if (current.coordination.handlingDirection
          && current.coordination.handlingDirection !== nextDirection) {
          this.advanceHandlingDirection({
            current,
            beforeDirection: current.coordination.handlingDirection,
            afterDirection: nextDirection,
            occurredAt: prepared.occurredAt,
            reason: prepared.reason,
            now,
          });
        } else {
          this.advanceCase(current, statusForHandlingDirection(nextDirection), prepared.reason, now);
        }
        this.workspace.database.prepare(`
          INSERT INTO aftersales_outbound_exception_decision_events (
            id, case_id, exception_id, shipment_package_id, kind,
            before_decision, after_decision, affected_items_json,
            occurred_at, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          current.id,
          exception.exceptionId,
          exception.packageId,
          beforeDecision === null ? 'selected' : 'changed',
          beforeDecision,
          prepared.decision,
          JSON.stringify(exception.affectedItems),
          prepared.occurredAt,
          prepared.reason,
          now,
        );
        if (createsReplacement
          && !this.hasCurrentReplacementRoundForException(current, exception.exceptionId)) {
          this.createOutboundExceptionReplacementRound(
            current,
            exception,
            affectedItems,
            prepared.occurredAt,
            prepared.reason,
            now,
          );
        }
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'inspect_intercepted_return') {
      if (current.coordination.interception?.status !== 'succeeded') {
        throw new Error('只有拦截成功的原正向包裹才能登记退回检查');
      }
      if (current.coordination.interception.packageId !== prepared.packageId) {
        throw new Error('所选包裹与拦截成功事项不是同一包裹');
      }
      const record = this.readShipmentRecord(current.shipmentRecordId);
      const shipmentPackage = record.packages.find(({ id }) => id === prepared.packageId);
      if (!shipmentPackage || shipmentPackage.status !== 'active') {
        throw new Error('所选原正向包裹不存在或已撤销');
      }
      if (shipmentPackage.logisticsStatus !== 'returned') {
        throw new Error('原正向包裹尚未真实退回卖家，不能登记检查');
      }
      if (this.workspace.database.prepare(`
        SELECT 1
        FROM aftersales_intercepted_return_inspection_events
        WHERE case_id = ? AND shipment_package_id = ?
      `).get(current.id, prepared.packageId)) {
        throw new Error('该拦截退回包裹已经登记检查');
      }
      const caseItemById = new Map(current.items.map((item) => [
        item.shipmentPackageItemId,
        item,
      ] as const));
      const expectedItems = current.items.filter(({ packageId }) => packageId === prepared.packageId);
      if (prepared.items.length !== expectedItems.length) {
        throw new Error('拦截退回检查必须完整覆盖该包裹在本售后中的全部商品');
      }
      for (const item of prepared.items) {
        const source = caseItemById.get(item.shipmentPackageItemId);
        if (!source || source.packageId !== prepared.packageId || item.quantity !== source.quantity) {
          throw new Error('拦截退回检查必须精确覆盖本售后的商品数量');
        }
      }
      const latestAt = [
        shipmentPackage.timeline.at(-1)?.occurredAt ?? shipmentPackage.createdAt,
        current.coordination.interception.timeline.at(-1)?.occurredAt ?? current.occurredAt,
      ].sort((left, right) => Date.parse(right) - Date.parse(left))[0];
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        latestAt,
        '拦截退回检查时间不能早于实际退回或拦截结果时间',
      );
      this.workspace.transaction(() => {
        this.workspace.database.prepare(`
          INSERT INTO aftersales_intercepted_return_inspection_events (
            id, case_id, shipment_package_id, result, items_json,
            occurred_at, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), current.id, prepared.packageId, prepared.result,
          JSON.stringify(prepared.items), prepared.occurredAt, prepared.reason, now,
        );
        this.advanceCase(
          current,
          current.status === 'completed' || current.status === 'cancelled'
            ? current.status
            : 'processing',
          prepared.reason,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'create_replacement_shipment') {
      const round = current.rounds.find(({ id }) => id === prepared.roundId);
      if (!round || round.workflow === 'legacy') {
        throw new Error('当前售后没有可补发的处理轮次');
      }
      if (!round.replacementRequired) throw new Error('当前处理轮次已不需要补发');
      if (round.replacementShipment) throw new Error('当前处理轮次已建立补发记录');
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        round.occurredAt,
        '补发时间不能早于当前处理轮次开始时间',
      );
      if (round.workflow === 'exchange') {
        const roundReturns = current.returns.filter(({ id }) => round.returnRecordIds.includes(id));
        if (roundReturns.length === 0 || roundReturns.some(({ status }) => status !== 'inspected')) {
          throw new Error('换货必须先完成本轮退货收货与检查');
        }
        const latestInspectionAt = roundReturns.reduce((latest, returnRecord) => {
          const occurredAt = returnRecord.inspection?.occurredAt;
          return occurredAt && Date.parse(occurredAt) > Date.parse(latest) ? occurredAt : latest;
        }, round.occurredAt);
        assertOccurredAtNotBefore(
          prepared.occurredAt,
          latestInspectionAt,
          '补发时间不能早于本轮退货检查时间',
        );
      }
      const roundItemById = new Map(round.items.map((item) => [item.id, item] as const));
      const allocated = new Map<string, number>();
      for (const shipmentPackage of prepared.packages) {
        const seen = new Set<string>();
        for (const item of shipmentPackage.items) {
          if (seen.has(item.roundItemId)) throw new Error('同一补发包裹不能重复分配同一商品');
          seen.add(item.roundItemId);
          const source = roundItemById.get(item.roundItemId);
          if (!source) throw new Error('补发商品不属于当前处理轮次');
          allocated.set(item.roundItemId, (allocated.get(item.roundItemId) ?? 0) + item.quantity);
        }
      }
      if (round.items.some((item) => allocated.get(item.id) !== item.quantity)) {
        throw new Error('补发包裹必须精确覆盖当前处理轮次的全部商品数量');
      }
      this.workspace.transaction(() => {
        this.createReplacementShipment(current, round, prepared, now);
        this.advanceCase(current, 'waiting_replacement', prepared.reason, now);
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'start_next_round') {
      const currentRound = current.rounds.find(({ id }) => id === prepared.sourceRoundId);
      const replacement = currentRound?.replacementShipment;
      if (!currentRound || !replacement || replacement.id !== prepared.sourceShipmentRecordId) {
        throw new Error('新一轮必须以当前轮次的补发记录为来源');
      }
      const sourceItems = this.resolveSourceItems(prepared.sourceShipmentRecordId, prepared.items);
      this.assertQuantitiesAvailable(prepared.items, sourceItems, current.id);
      if (prepared.workflow === 'exchange' && prepared.items.some((item) => (
        asString(sourceItems.get(item.shipmentPackageItemId)?.source_logistics_status)
          !== 'delivered'
      ))) {
        throw new Error('补发商品尚未签收，不能建立买家退回的换货轮次');
      }
      if (prepared.workflow === 'exchange') {
        const latestDeliveryAt = prepared.items.reduce((latest, item) => {
          const deliveredAt = asNullableString(
            sourceItems.get(item.shipmentPackageItemId)?.source_delivered_at,
          );
          if (!deliveredAt) throw new Error('补发商品缺少可信签收时间');
          return Date.parse(deliveredAt) > Date.parse(latest) ? deliveredAt : latest;
        }, currentRound.replacementOccurredAt ?? currentRound.occurredAt);
        assertOccurredAtNotBefore(
          prepared.occurredAt,
          latestDeliveryAt,
          '新一轮换货问题时间不能早于补发商品签收时间',
        );
      }
      const latestSourceOccurredAt = currentRound.replacementOccurredAt
        ?? currentRound.occurredAt;
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        latestSourceOccurredAt,
        '新一轮问题时间不能早于上一轮补发时间',
      );
      const nextRoundNumber = (current.rounds.at(-1)?.roundNumber ?? 0) + 1;
      this.workspace.transaction(() => {
        const roundId = randomUUID();
        this.workspace.database.prepare(`
          INSERT INTO aftersales_processing_rounds (
            id, case_id, round_number, workflow, source_shipment_record_id,
            occurred_at, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          roundId,
          current.id,
          nextRoundNumber,
          prepared.workflow,
          prepared.sourceShipmentRecordId,
          prepared.occurredAt,
          prepared.reason,
          now,
        );
        const insertItem = this.workspace.database.prepare(`
          INSERT INTO aftersales_processing_round_items (
            id, round_id, source_shipment_package_item_id, quantity
          ) VALUES (?, ?, ?, ?)
        `);
        for (const item of prepared.items) {
          insertItem.run(randomUUID(), roundId, item.shipmentPackageItemId, item.quantity);
        }
        this.advanceCase(
          current,
          prepared.workflow === 'exchange' ? 'waiting_return' : 'waiting_replacement',
          prepared.reason,
          now,
        );
        this.workspace.database.prepare(`
          UPDATE aftersales_cases SET handling_direction = ? WHERE id = ?
        `).run(
          prepared.workflow === 'exchange' ? 'buyer_return' : 'replacement',
          current.id,
        );
        const nextDirection = prepared.workflow === 'exchange' ? 'buyer_return' : 'replacement';
        const previousDirection = current.coordination.handlingDirection;
        if (previousDirection && previousDirection !== nextDirection) {
          this.workspace.database.prepare(`
            INSERT INTO aftersales_handling_direction_events (
              id, case_id, kind, before_direction, after_direction,
              occurred_at, reason, created_at
            ) VALUES (?, ?, 'changed', ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            current.id,
            previousDirection,
            nextDirection,
            prepared.occurredAt,
            prepared.reason,
            now,
          );
        }
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'record_interception_result') {
      if (
        current.workflow !== 'return_refund'
        || current.coordination.interception?.status !== 'requested'
      ) {
        throw new Error('当前售后没有待确认的拦截请求');
      }
      if (!current.coordination.interception.packageId) {
        throw new Error('历史拦截事项未绑定具体包裹，请另建售后处理单');
      }
      const latestInterceptionAt = current.coordination.interception.timeline.at(-1)?.occurredAt;
      if (!latestInterceptionAt) throw new Error('拦截请求缺少发生时间');
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        latestInterceptionAt,
        '拦截结果时间不能早于拦截请求时间',
      );
      this.workspace.transaction(() => {
        this.workspace.database.prepare(`
          INSERT INTO aftersales_interception_events (
            id, case_id, kind, occurred_at, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          current.id,
          prepared.result,
          prepared.occurredAt,
          prepared.reason,
          now,
        );
        this.advanceCase(current, current.status, prepared.reason, now);
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'change_handling_direction') {
      if (current.workflow !== 'return_refund') {
        throw new Error('当前售后处理方式不能转换处理方向');
      }
      const beforeDirection = current.coordination.handlingDirection;
      if (!beforeDirection) throw new Error('当前售后缺少处理方向');
      if (beforeDirection === prepared.handlingDirection) {
        throw new Error('售后处理方向没有变化');
      }
      if (beforeDirection === 'replacement'
        && prepared.handlingDirection !== 'replacement'
        && current.rounds.some((round) => round.replacementShipment?.packages.some(
          ({ status }) => status === 'active',
        ))) {
        throw new Error('当前已建立补发记录；未交寄请先作废，已交寄请走拦截或后续处置');
      }
      if (current.returns.length > 0) {
        throw new Error('已有买家退货实物记录，请按退货流程继续处理');
      }
      if (
        prepared.handlingDirection === 'intercept'
        && current.coordination.interception?.status === 'requested'
      ) {
        throw new Error('已有待确认的拦截请求，请先登记结果');
      }
      if (!current.coordination.availableDirections.includes(prepared.handlingDirection)) {
        throw new Error('当前实物流转证据不允许该售后处理方向');
      }
      if (current.coordination.interception?.status === 'failed'
        && current.coordination.physicalControl === 'buyer'
        && prepared.handlingDirection !== 'buyer_return'
        && prepared.handlingDirection !== 'only_refund') {
        throw new Error('拦截失败且买家已签收，只能明确转为买家退回或仅退款');
      }
      const latestDirectionAt = current.coordination.handlingDirectionTimeline.at(-1)?.occurredAt
        ?? current.occurredAt;
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        latestDirectionAt,
        '处理方向转换时间不能早于上一条方向事件',
      );
      const interceptionPackageId = prepared.handlingDirection === 'intercept'
        ? resolveInterceptionPackageId(
          prepared.interceptionPackageId,
          current.coordination.sourcePackages.map(({ packageId }) => packageId),
        )
        : null;
      this.workspace.transaction(() => {
        this.advanceHandlingDirection({
          current,
          beforeDirection,
          afterDirection: prepared.handlingDirection,
          occurredAt: prepared.occurredAt,
          reason: prepared.reason,
          now,
          interceptionPackageId,
        });
        if (prepared.handlingDirection === 'replacement') {
          const replacementItems = current.coordination.interceptedReturnInspection?.items
            ?? current.items.map(({ shipmentPackageItemId, quantity }) => ({
              shipmentPackageItemId,
              quantity,
            }));
          const reusableRound = current.rounds.find((round) => (
            round.workflow === 'direct_replacement'
            && round.sourceShipmentRecordId === current.shipmentRecordId
            && round.replacementShipment === null
            && sameAftersalesItemAllocation(round.items, replacementItems)
          ));
          if (!reusableRound) {
            this.createDirectReplacementRound(
              current,
              current.shipmentRecordId,
              replacementItems,
              prepared.occurredAt,
              prepared.reason,
              now,
            );
          }
        }
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'register_return') {
      const activeRound = current.rounds.at(-1);
      if (
        (current.workflow !== 'return_refund' && activeRound?.workflow !== 'exchange') ||
        current.status !== 'waiting_return' ||
        !activeRound || activeRound.returnRecordIds.length > 0
      ) {
        throw new Error('当前售后尚不能登记退货物流');
      }
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        current.occurredAt,
        '退货寄出时间不能早于售后发生时间',
      );
      const existingPackageRow = this.workspace.database.prepare(`
        SELECT
          records.id, records.status, records.revision, records.occurred_at,
          EXISTS (
            SELECT 1 FROM logistics_exception_matters AS exceptions
            WHERE exceptions.return_record_id = records.id
              AND exceptions.exception_type = 'lost'
              AND exceptions.stage = 'confirmed'
          ) AS has_confirmed_loss,
          COALESCE((
            SELECT events.occurred_at
            FROM aftersales_return_record_events AS events
            WHERE events.return_record_id = records.id
            ORDER BY events.result_revision DESC
            LIMIT 1
          ), records.occurred_at) AS latest_event_at
        FROM aftersales_return_records AS records
        WHERE tracking_number = ? COLLATE NOCASE
        ORDER BY created_at, id
        LIMIT 1
      `).get(
        prepared.trackingNumber,
      ) as SqlRow | undefined;
      if (existingPackageRow && !prepared.combineWithExisting) {
        throw new Error('该退货运单已经登记，请确认是否属于合装退货');
      }
      if (existingPackageRow) {
        if (asString(existingPackageRow.status) !== 'in_transit') {
          throw new Error('已经收到或检查的退货包裹不能再追加合装商品');
        }
        if (asNumber(existingPackageRow.has_confirmed_loss) === 1) {
          throw new Error('已确认丢件的退货包裹不能再追加合装商品');
        }
        assertOccurredAtNotBefore(
          prepared.occurredAt,
          asString(existingPackageRow.latest_event_at),
          '合装退货确认时间不能早于退货包裹上一条事件',
        );
        const returnRecordId = asString(existingPackageRow.id);
        const returnRecordRevision = asNumber(existingPackageRow.revision);
        this.workspace.transaction(() => {
          const insertItem = this.workspace.database.prepare(`
            INSERT INTO aftersales_return_record_items (
              id, return_record_id, aftersales_case_id, shipment_package_item_id,
              quantity, received_quantity, accepted_quantity,
              inspection_result, inspection_note
            ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL)
          `);
          for (const item of activeRound.items) {
            insertItem.run(
              randomUUID(),
              returnRecordId,
              current.id,
              item.sourceShipmentPackageItemId,
              item.quantity,
            );
          }
          this.workspace.database.prepare(`
            INSERT INTO aftersales_round_returns (round_id, return_record_id)
            VALUES (?, ?)
          `).run(activeRound.id, returnRecordId);
          const updated = this.workspace.database.prepare(`
            UPDATE aftersales_return_records
            SET revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ? AND status = 'in_transit'
          `).run(now, returnRecordId, returnRecordRevision);
          if (updated.changes !== 1) throw new Error('退货包裹已在其他操作中更新');
          this.workspace.database.prepare(`
            INSERT INTO aftersales_return_record_events (
              id, return_record_id, kind, base_revision, result_revision,
              occurred_at, reason, inspection_result, payload_json, created_at
            ) VALUES (?, ?, 'items_combined', ?, ?, ?, ?, NULL, ?, ?)
          `).run(
            randomUUID(),
            returnRecordId,
            returnRecordRevision,
            returnRecordRevision + 1,
            prepared.occurredAt,
            prepared.reason,
            JSON.stringify({
              items: activeRound.items.map(({ sourceShipmentPackageItemId, quantity }) => ({
                shipmentPackageItemId: sourceShipmentPackageItemId,
                quantity,
              })),
            }),
            now,
          );
          this.advanceCase(current, 'waiting_return', prepared.reason, now);
        });
        return this.get(current.id);
      }
      const returnRecordId = randomUUID();
      this.workspace.transaction(() => {
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_records (
            id, aftersales_case_id, status, revision,
            shipping_carrier, tracking_number, occurred_at,
            received_at, inspection_result, inspection_note, inspected_at,
            created_at, updated_at, logistics_status, carrier_accepted_at,
            discrepancies_json
          ) VALUES (
            ?, ?, 'in_transit', 1, ?, ?, ?,
            NULL, NULL, NULL, NULL, ?, ?, 'awaiting_carrier', NULL, '[]'
          )
        `).run(
          returnRecordId,
          current.id,
          prepared.shippingCarrier,
          prepared.trackingNumber,
          prepared.occurredAt,
          now,
          now,
        );
        const insertItem = this.workspace.database.prepare(`
          INSERT INTO aftersales_return_record_items (
            id, return_record_id, aftersales_case_id, shipment_package_item_id,
            quantity, received_quantity, accepted_quantity,
            inspection_result, inspection_note
          ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL)
        `);
        for (const item of activeRound.items) {
          insertItem.run(
            randomUUID(),
            returnRecordId,
            current.id,
            item.sourceShipmentPackageItemId,
            item.quantity,
          );
        }
        this.workspace.database.prepare(`
          INSERT INTO aftersales_round_returns (round_id, return_record_id)
          VALUES (?, ?)
        `).run(activeRound.id, returnRecordId);
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_record_events (
            id, return_record_id, kind, base_revision, result_revision,
            occurred_at, reason, inspection_result, created_at
          ) VALUES (?, ?, 'registered', 0, 1, ?, ?, NULL, ?)
        `).run(
          randomUUID(),
          returnRecordId,
          prepared.occurredAt,
          prepared.reason,
          now,
        );
        this.advanceCase(current, 'waiting_return', prepared.reason, now);
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'correct_return_logistics') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      if (!returnRecord) throw new Error('退货包裹不存在或未关联当前售后');
      const nextLogistics = prepareLogisticsCorrection({
        current: {
          shippingCarrier: returnRecord.shippingCarrier,
          trackingNumber: returnRecord.trackingNumber,
        },
        next: {
          shippingCarrier: prepared.shippingCarrier,
          trackingNumber: prepared.trackingNumber,
        },
        occurredAt: prepared.occurredAt,
        latestOccurredAt: returnRecord.timeline.at(-1)?.occurredAt
          ?? returnRecord.occurredAt,
      });
      const duplicate = this.workspace.database.prepare(`
        SELECT id
        FROM aftersales_return_records
        WHERE tracking_number = ? COLLATE NOCASE AND id <> ?
        LIMIT 1
      `).get(
        nextLogistics.trackingNumber,
        returnRecord.id,
      ) as SqlRow | undefined;
      if (duplicate) throw new Error('该退货运单已经登记，请核对是否属于合装退货');
      this.workspace.transaction(() => {
        const updated = this.workspace.database.prepare(`
          UPDATE aftersales_return_records
          SET shipping_carrier = ?, tracking_number = ?,
              revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(
          nextLogistics.shippingCarrier,
          nextLogistics.trackingNumber,
          now,
          returnRecord.id,
          returnRecord.revision,
        );
        if (updated.changes !== 1) throw new Error('退货包裹已在其他操作中更新');
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_record_events (
            id, return_record_id, kind, base_revision, result_revision,
            occurred_at, reason, inspection_result, payload_json, created_at
          ) VALUES (?, ?, 'logistics_corrected', ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          randomUUID(),
          returnRecord.id,
          returnRecord.revision,
          returnRecord.revision + 1,
          prepared.occurredAt,
          prepared.reason,
          JSON.stringify({
            before: {
              shippingCarrier: returnRecord.shippingCarrier,
              trackingNumber: returnRecord.trackingNumber,
            },
            after: {
              shippingCarrier: nextLogistics.shippingCarrier,
              trackingNumber: nextLogistics.trackingNumber,
            },
          }),
          now,
        );
        this.advanceCase(current, current.status, prepared.reason, now);
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'update_return_logistics_status') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      if (!returnRecord) throw new Error('退货包裹不存在或未关联当前售后');
      const statusChange = prepareLogisticsStatusChange({
        direction: 'return',
        currentStatus: returnRecord.logisticsStatus,
        nextStatus: prepared.logisticsStatus,
        carrierAcceptedAt: returnRecord.carrierAcceptedAt,
        physicalReceiptAt: returnRecord.receivedAt,
        carrierAcceptanceConfirmed: prepared.carrierAcceptanceConfirmed ?? false,
        occurredAt: prepared.occurredAt,
        latestOccurredAt: returnRecord.timeline.at(-1)?.occurredAt
          ?? returnRecord.occurredAt,
      });
      if (
        prepared.logisticsStatus === returnRecord.logisticsStatus
        && statusChange.carrierAcceptedAt === returnRecord.carrierAcceptedAt
      ) {
        throw new Error('退货物流状态没有变化');
      }
      this.workspace.transaction(() => {
        const updated = this.workspace.database.prepare(`
          UPDATE aftersales_return_records
          SET logistics_status = ?, carrier_accepted_at = ?,
              revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(
          prepared.logisticsStatus,
          statusChange.carrierAcceptedAt,
          now,
          returnRecord.id,
          returnRecord.revision,
        );
        if (updated.changes !== 1) throw new Error('退货包裹已在其他操作中更新');
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_record_events (
            id, return_record_id, kind, base_revision, result_revision,
            occurred_at, reason, inspection_result, payload_json, created_at
          ) VALUES (?, ?, 'logistics_status_updated', ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          randomUUID(),
          returnRecord.id,
          returnRecord.revision,
          returnRecord.revision + 1,
          prepared.occurredAt,
          prepared.reason,
          JSON.stringify({
            before: returnRecord.logisticsStatus,
            after: prepared.logisticsStatus,
            carrierAcceptedAt: statusChange.carrierAcceptedAt,
          }),
          now,
        );
        this.advanceCasesForReturnRecord(
          returnRecord.id,
          current,
          (linkedCase) => linkedCase.status,
          prepared.reason,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'record_return_logistics_exception') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      if (!returnRecord) throw new Error('退货包裹不存在或未关联当前售后');
      if (returnRecord.status !== 'in_transit' && prepared.exceptionType !== 'damaged') {
        throw new Error('退货已实际收到，少件、空包、错货或破损请通过退货检查差异记录');
      }
      this.workspace.transaction(() => {
        this.logisticsExceptionService().openException({
          subject: { direction: 'return', packageId: returnRecord.id },
          expectedPackageRevision: returnRecord.revision,
          exceptionType: prepared.exceptionType,
          stage: prepared.stage,
          impact: prepared.impact ?? { scope: 'package' },
          availableItems: returnRecord.items.map((item) => ({
            sourceItemId: item.id,
            quantity: item.quantity,
          })),
          evidence: {
            carrierAcceptedAt: returnRecord.carrierAcceptedAt,
            physicalReceiptAt: returnRecord.receivedAt
              ?? (returnRecord.logisticsStatus === 'delivered'
                ? returnRecord.timeline.find((event) => (
                  event.kind === 'logistics_status_updated' && event.after === 'delivered'
                ))?.occurredAt ?? returnRecord.createdAt
                : null),
            carrierConfirmedLoss: prepared.carrierConfirmedLoss ?? false,
          },
          occurredAt: prepared.occurredAt,
          reason: prepared.reason,
        });
        this.advanceCasesForReturnRecord(
          returnRecord.id,
          current,
          (linkedCase) => linkedCase.status,
          prepared.reason,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'progress_return_logistics_exception') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      if (!returnRecord) throw new Error('退货包裹不存在或未关联当前售后');
      this.workspace.transaction(() => {
        this.logisticsExceptionService().progressException({
          subject: { direction: 'return', packageId: returnRecord.id },
          exceptionId: prepared.exceptionId,
          expectedExceptionRevision: prepared.expectedExceptionRevision,
          stage: prepared.stage,
          evidence: {
            carrierAcceptedAt: returnRecord.carrierAcceptedAt,
            physicalReceiptAt: returnRecord.receivedAt,
            carrierConfirmedLoss: prepared.carrierConfirmedLoss ?? false,
          },
          occurredAt: prepared.occurredAt,
          reason: prepared.reason,
        });
        this.advanceCasesForReturnRecord(
          returnRecord.id,
          current,
          (linkedCase) => linkedCase.status,
          prepared.reason,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'decide_return_logistics_exception') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      const coordinated = current.coordination.returnException;
      if (!returnRecord || !coordinated
        || coordinated.returnRecordId !== returnRecord.id
        || coordinated.exceptionId !== prepared.exceptionId) {
        throw new Error('当前售后没有待处理的退货物流异常');
      }
      if (coordinated.decision === prepared.decision) {
        throw new Error('退货物流异常处理选择没有变化');
      }
      const latestOccurredAt = coordinated.timeline.at(-1)?.occurredAt
        ?? returnRecord.logisticsExceptions.find(({ id }) => id === prepared.exceptionId)?.occurredAt;
      if (!latestOccurredAt) throw new Error('退货物流异常缺少发生时间');
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        latestOccurredAt,
        '异常处理选择时间不能早于异常事实或上次选择',
      );
      this.workspace.transaction(() => {
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_exception_decision_events (
            id, case_id, exception_id, return_record_id, kind,
            before_decision, after_decision, occurred_at, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          current.id,
          prepared.exceptionId,
          returnRecord.id,
          coordinated.decision === null ? 'selected' : 'changed',
          coordinated.decision,
          prepared.decision,
          prepared.occurredAt,
          prepared.reason,
          now,
        );
        this.advanceCase(current, current.status, prepared.reason, now);
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'receive_return') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      const returnRound = current.rounds.find(({ returnRecordIds }) => (
        returnRecordIds.includes(prepared.returnRecordId)
      ));
      if (
        (current.workflow !== 'return_refund' && returnRound?.workflow !== 'exchange') ||
        (current.status !== 'waiting_return'
          && current.status !== 'ready_to_complete'
          && current.status !== 'cancelled'
          && current.status !== 'completed') ||
        returnRecord?.status !== 'in_transit' || !returnRound
      ) {
        throw new Error('当前退货记录尚不能确认收到');
      }
      if (hasUnresolvedReceiptDispute(returnRecord)) {
        throw new Error('退货签收扫描存在争议，不能代替卖家登记实际收到');
      }
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        returnRecord.occurredAt,
        '退货收到时间不能早于寄出时间',
      );
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        returnRecord.timeline.at(-1)?.occurredAt ?? returnRecord.occurredAt,
        '退货收到时间不能早于上一条退货事件',
      );
      const receivedItems = prepared.items ?? returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity,
      }));
      assertReturnItemIds(
        returnRecord.items.map(({ id }) => id),
        receivedItems.map(({ returnRecordItemId }) => returnRecordItemId),
        '请完整填写当前退货包裹每件商品的实际收到数量',
      );
      assertReceivedQuantitiesOutsideConfirmedLoss(returnRecord, receivedItems);
      const discrepancies = prepared.discrepancies ?? [];
      assertDiscrepancyItemIds(returnRecord.items.map(({ id }) => id), discrepancies);
      this.workspace.transaction(() => {
        const updated = this.workspace.database.prepare(`
          UPDATE aftersales_return_records
          SET status = 'received', revision = revision + 1,
              received_at = ?, logistics_status = 'delivered',
              discrepancies_json = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'in_transit'
        `).run(
          prepared.occurredAt,
          JSON.stringify(discrepancies),
          now,
          returnRecord.id,
          returnRecord.revision,
        );
        if (updated.changes !== 1) throw new Error('退货记录已在其他操作中更新');
        const updateItem = this.workspace.database.prepare(`
          UPDATE aftersales_return_record_items
          SET received_quantity = ?
          WHERE id = ? AND return_record_id = ?
        `);
        for (const item of receivedItems) {
          const itemUpdate = updateItem.run(
            item.receivedQuantity,
            item.returnRecordItemId,
            returnRecord.id,
          );
          if (itemUpdate.changes !== 1) throw new Error('退货商品收到数量更新失败');
        }
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_record_events (
            id, return_record_id, kind, base_revision, result_revision,
            occurred_at, reason, inspection_result, payload_json, created_at
          ) VALUES (?, ?, 'received', ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          randomUUID(),
          returnRecord.id,
          returnRecord.revision,
          returnRecord.revision + 1,
          prepared.occurredAt,
          prepared.reason,
          JSON.stringify({ items: receivedItems, discrepancies }),
          now,
        );
        this.advanceCasesForReturnRecord(
          returnRecord.id,
          current,
          (linkedCase) => linkedCase.status === 'cancelled' || linkedCase.status === 'completed'
            || linkedCase.status === 'ready_to_complete'
            ? linkedCase.status
            : 'waiting_inspection',
          prepared.reason,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'inspect_return') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      const returnRound = current.rounds.find(({ returnRecordIds }) => (
        returnRecordIds.includes(prepared.returnRecordId)
      ));
      if (
        (current.workflow !== 'return_refund' && returnRound?.workflow !== 'exchange') ||
        (current.status !== 'waiting_inspection'
          && current.status !== 'ready_to_complete'
          && current.status !== 'cancelled'
          && current.status !== 'completed') ||
        returnRecord?.status !== 'received' || !returnRound
      ) {
        throw new Error('当前退货记录尚不能登记检查结果');
      }
      if (!returnRecord.receivedAt) throw new Error('退货记录缺少实际收到时间');
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        returnRecord.receivedAt,
        '退货检查时间不能早于收到时间',
      );
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        returnRecord.timeline.at(-1)?.occurredAt ?? returnRecord.receivedAt,
        '退货检查时间不能早于上一条退货事件',
      );
      const inspectedItems = prepared.items ?? returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        acceptedQuantity: item.receivedQuantity,
        result: prepared.result,
        note: prepared.note,
      }));
      assertReturnItemIds(
        returnRecord.items.map(({ id }) => id),
        inspectedItems.map(({ returnRecordItemId }) => returnRecordItemId),
        '请完整填写当前退货包裹每件商品的检查结果',
      );
      const sourceItems = new Map(returnRecord.items.map((item) => [item.id, item]));
      for (const item of inspectedItems) {
        const sourceItem = sourceItems.get(item.returnRecordItemId);
        if (!sourceItem) throw new Error('退货商品不存在');
        if (item.acceptedQuantity > sourceItem.receivedQuantity) {
          throw new Error('检查通过数量不能超过实际收到数量');
        }
      }
      const discrepancies = prepared.discrepancies ?? returnRecord.discrepancies;
      assertDiscrepancyItemIds(returnRecord.items.map(({ id }) => id), discrepancies);
      this.workspace.transaction(() => {
        const updated = this.workspace.database.prepare(`
          UPDATE aftersales_return_records
          SET status = 'inspected', revision = revision + 1,
              inspection_result = ?, inspection_note = ?, inspected_at = ?,
              discrepancies_json = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'received'
        `).run(
          prepared.result,
          prepared.note,
          prepared.occurredAt,
          JSON.stringify(discrepancies),
          now,
          returnRecord.id,
          returnRecord.revision,
        );
        if (updated.changes !== 1) throw new Error('退货记录已在其他操作中更新');
        const updateItem = this.workspace.database.prepare(`
          UPDATE aftersales_return_record_items
          SET accepted_quantity = ?, inspection_result = ?, inspection_note = ?
          WHERE id = ? AND return_record_id = ?
        `);
        for (const item of inspectedItems) {
          const itemUpdate = updateItem.run(
            item.acceptedQuantity,
            item.result,
            item.note,
            item.returnRecordItemId,
            returnRecord.id,
          );
          if (itemUpdate.changes !== 1) throw new Error('退货商品检查结果更新失败');
        }
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_record_events (
            id, return_record_id, kind, base_revision, result_revision,
            occurred_at, reason, inspection_result, payload_json, created_at
          ) VALUES (?, ?, 'inspected', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          returnRecord.id,
          returnRecord.revision,
          returnRecord.revision + 1,
          prepared.occurredAt,
          prepared.note,
          prepared.result,
          JSON.stringify({ items: inspectedItems, discrepancies }),
          now,
        );
        this.advanceCasesForReturnRecord(
          returnRecord.id,
          current,
          (linkedCase) => linkedCase.status === 'cancelled' || linkedCase.status === 'completed'
            || linkedCase.status === 'ready_to_complete'
            ? linkedCase.status
            : linkedCase.rounds.find(({ returnRecordIds }) => (
              returnRecordIds.includes(returnRecord.id)
            ))?.workflow === 'exchange'
              ? 'waiting_replacement'
              : 'waiting_refund',
          prepared.note,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'open_carrier_claim') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      if (!returnRecord) throw new Error('退货包裹不存在或未关联当前售后');
      if (!returnRecord.currentException) throw new Error('当前退货包裹没有可索赔的物流异常');
      this.logisticsExceptionService().openClaim({
        subject: { direction: 'return', packageId: returnRecord.id },
        exception: returnRecord.currentException,
        latestOccurredAt: returnRecord.timeline.at(-1)?.occurredAt
          ?? returnRecord.occurredAt,
        impact: returnRecord.currentException.impact,
        requestedAmountCents: prepared.requestedAmountCents,
        occurredAt: prepared.occurredAt,
        reason: prepared.reason,
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'resolve_carrier_claim') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      const claim = returnRecord?.carrierClaim;
      if (!returnRecord || !claim) throw new Error('当前退货包裹尚未建立承运索赔');
      if (claim.status !== 'pending' || claim.revision !== prepared.expectedClaimRevision) {
        throw new Error('承运索赔已在其他操作中更新，请刷新后重试');
      }
      const approvedAmountCents = prepared.outcome === 'approved'
        ? prepared.approvedAmountCents as number
        : null;
      this.logisticsExceptionService().resolveClaim({
        subject: { direction: 'return', packageId: returnRecord.id },
        expectedClaimRevision: claim.revision,
        outcome: prepared.outcome,
        approvedAmountCents,
        occurredAt: prepared.occurredAt,
        reason: prepared.reason,
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'confirm_carrier_compensation') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      const claim = returnRecord?.carrierClaim;
      if (!returnRecord || !claim) throw new Error('当前退货包裹尚未建立承运索赔');
      if (claim.status !== 'approved' || claim.revision !== prepared.expectedClaimRevision) {
        throw new Error('当前承运索赔尚不能确认实际赔付');
      }
      this.logisticsExceptionService().confirmCompensation({
        subject: { direction: 'return', packageId: returnRecord.id },
        expectedClaimRevision: claim.revision,
        amountCents: prepared.amountCents,
        occurredAt: prepared.occurredAt,
        note: prepared.note,
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'confirm_refund') {
      const refund = current.refund;
      const explicitOnlyRefund = current.workflow === 'return_refund'
        && current.coordination.handlingDirection === 'only_refund';
      const exceptionDecision = current.coordination.returnException?.decision ?? null;
      const exceptionRefundSupported = exceptionDecision !== null;
      const outboundRefundExceptions = current.coordination.outboundExceptionHistory.filter(
        (exception) => exception.stage === 'confirmed'
          && (exception.decision === 'refund_only'
            || exception.decision === 'refund_and_replacement'),
      );
      const outboundRefundSupported = outboundRefundExceptions.length > 0;
      const carriedRefundSupported = carriesRefundFromEarlierTemplate
        && refund?.status === 'pending';
      const returnDecisionSupported = explicitOnlyRefund || (
        current.returns.length > 0
        && !(current.coordination.returnException?.exceptionType === 'lost'
          && current.coordination.returnException.stage === 'confirmed'
          && exceptionDecision === null)
        && current.returns.every((returnRecord) => (
          returnRecord.status === 'inspected'
          || returnRecord.carrierClaim !== null
          || (returnRecord.status === 'in_transit'
            && !hasUnresolvedConfirmedLoss(returnRecord))
          || (returnRecord.id === current.coordination.returnException?.returnRecordId
            && exceptionRefundSupported)
        ))
      );
      if (
        current.workflow === 'return_refund' &&
        !returnDecisionSupported &&
        !outboundRefundSupported
      ) {
        throw new Error('请先完成退货检查、确认丢件或建立承运索赔');
      }
      const refundStatusReady = current.status === 'waiting_refund'
        || (current.status === 'waiting_replacement' && outboundRefundSupported)
        || carriedRefundSupported
        || (current.workflow === 'return_refund'
          && (current.status === 'waiting_return' || current.status === 'waiting_inspection')
          && returnDecisionSupported);
      if (!refundStatusReady || refund?.status !== 'pending') {
        throw new Error('当前售后尚不能确认实际退款');
      }
      const latestOutboundRefundAt = outboundRefundExceptions
        .flatMap(({ timeline }) => timeline.at(-1)?.occurredAt ?? [])
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
      const earliestRefundAt = latestOutboundRefundAt
        ?? (carriedRefundSupported ? refund?.latestEventAt : undefined)
        ?? (explicitOnlyRefund
        ? current.occurredAt
        : current.workflow === 'return_refund'
        ? current.coordination.returnException?.timeline.at(-1)?.occurredAt
          ?? latestReturnDecisionEvidenceAt(current.returns)
        : current.occurredAt);
      if (!earliestRefundAt) throw new Error('退货记录缺少检查、丢件或索赔时间');
      const latestRecordAt = refund.refundRecords.at(-1)?.occurredAt ?? null;
      const refundNotBefore = latestRecordAt !== null
        && Date.parse(latestRecordAt) > Date.parse(earliestRefundAt)
        ? latestRecordAt
        : earliestRefundAt;
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        refundNotBefore,
        latestRecordAt !== null
          ? '补退时间不能早于上一笔实际退款'
          : current.workflow === 'return_refund' && !explicitOnlyRefund
          ? current.coordination.returnException?.timeline.length
            ? '实际退款时间不能早于退货异常处理选择时间'
            : current.returns.some(hasUnresolvedConfirmedLoss)
            ? '实际退款时间不能早于退货丢件确认时间'
            : current.returns.some(({ carrierClaim }) => carrierClaim !== null)
              ? '实际退款时间不能早于承运索赔建立时间'
              : '实际退款时间不能早于退货检查时间'
          : '实际退款时间不能早于售后发生时间',
      );
      const refundedAfter = refund.fulfillment.refundedAmountCents
        + prepared.actualRefundCents;
      const financialRecordId = randomUUID();
      this.workspace.transaction(() => {
        this.workspace.database.prepare(`
          INSERT INTO financial_records (
            id, kind, pending_item_id, aftersales_case_id,
            amount_cents, occurred_at, note, created_at
          ) VALUES (?, 'aftersales_refund', ?, ?, ?, ?, ?, ?)
        `).run(
          financialRecordId,
          refund.pendingItemId,
          current.id,
          prepared.actualRefundCents,
          prepared.occurredAt,
          prepared.note,
          now,
        );
        if (outboundRefundSupported) {
          this.workspace.database.prepare(`
            INSERT INTO aftersales_outbound_exception_refund_links (
              financial_record_id, decision_event_id, created_at
            )
            SELECT ?, decisions.id, ?
            FROM aftersales_outbound_exception_decision_events AS decisions
            WHERE decisions.case_id = ?
              AND decisions.after_decision IN ('refund_only', 'refund_and_replacement')
              AND decisions.sequence = (
                SELECT MAX(latest.sequence)
                FROM aftersales_outbound_exception_decision_events AS latest
                WHERE latest.case_id = decisions.case_id
                  AND latest.exception_id = decisions.exception_id
              )
          `).run(financialRecordId, now, current.id);
        }
        const replacementPending = this.replacementDeliveryPending(current);
        if (refundedAfter >= refund.requestedAmountCents) {
          this.confirmPendingRefund({
            pendingItemId: refund.pendingItemId,
            requestedAmountCents: refund.requestedAmountCents,
            refundedAmountCents: refundedAfter,
            reason: prepared.note,
            occurredAt: prepared.occurredAt,
            now,
          });
          this.advanceCase(
            current,
            replacementPending ? 'waiting_replacement' : 'ready_to_complete',
            `确认实际退款：${prepared.note}`,
            now,
          );
        } else {
          this.advanceCase(current, current.status, `部分退款：${prepared.note}`, now);
        }
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'adjust_refund_target') {
      const refund = current.refund;
      if (!refund || (refund.status !== 'pending' && refund.status !== 'confirmed')) {
        throw new Error('当前退款申请尚不能调整目标金额');
      }
      if (prepared.requestedRefundCents === refund.requestedAmountCents) {
        throw new Error('退款目标金额没有变化');
      }
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        refund.latestEventAt,
        '调整退款目标时间不能早于上一条退款事件',
      );
      this.workspace.transaction(() => {
        const updated = this.workspace.database.prepare(`
          UPDATE pending_financial_items
          SET requested_amount_cents = ?
          WHERE id = ? AND requested_amount_cents = ?
            AND status IN ('pending', 'confirmed')
        `).run(
          prepared.requestedRefundCents,
          refund.pendingItemId,
          refund.requestedAmountCents,
        );
        if (updated.changes !== 1) throw new Error('退款申请已在其他操作中变更');
        this.workspace.database.prepare(`
          INSERT INTO aftersales_refund_target_adjustment_events (
            id, pending_item_id, before_amount_cents, after_amount_cents,
            reason, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          refund.pendingItemId,
          refund.requestedAmountCents,
          prepared.requestedRefundCents,
          prepared.reason,
          prepared.occurredAt,
          now,
        );
        const refundedAmountCents = refund.fulfillment.refundedAmountCents;
        if (refund.status === 'pending' && refundedAmountCents >= prepared.requestedRefundCents) {
          this.confirmPendingRefund({
            pendingItemId: refund.pendingItemId,
            requestedAmountCents: prepared.requestedRefundCents,
            refundedAmountCents,
            reason: prepared.reason,
            occurredAt: prepared.occurredAt,
            now,
          });
          this.advanceCase(
            current,
            this.replacementDeliveryPending(current)
              ? 'waiting_replacement'
              : 'ready_to_complete',
            `调整退款目标至已退金额：${prepared.reason}`,
            now,
          );
        } else if (refund.status === 'confirmed'
          && refundedAmountCents < prepared.requestedRefundCents) {
          const reopened = this.workspace.database.prepare(`
            UPDATE pending_financial_items
            SET status = 'pending', resolved_at = NULL
            WHERE id = ? AND status = 'confirmed'
          `).run(refund.pendingItemId);
          if (reopened.changes !== 1) throw new Error('退款申请已在其他操作中处理');
          this.advanceCase(
            current,
            current.status === 'ready_to_complete' ? 'waiting_refund' : current.status,
            `上调退款目标：${prepared.reason}`,
            now,
          );
        } else {
          this.advanceCase(current, current.status, `调整退款目标：${prepared.reason}`, now);
        }
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'end_refund') {
      const refund = current.refund;
      if (!refund || refund.status === 'cancelled' || refund.status === 'ended') {
        throw new Error('当前退款申请尚不能结束退款');
      }
      const refundedAmountCents = refund.fulfillment.refundedAmountCents;
      if (refundedAmountCents === 0) {
        throw new Error('结束退款前至少要有一笔实际退款');
      }
      if (refundedAmountCents > refund.requestedAmountCents) {
        throw new Error('实退已超过退款目标，请人工核对金额');
      }
      if (refund.status === 'confirmed'
        || refundedAmountCents >= refund.requestedAmountCents) {
        throw new Error('退款已足额，无需结束退款');
      }
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        refund.latestEventAt,
        '结束退款时间不能早于上一条退款事件',
      );
      this.workspace.transaction(() => {
        const ended = this.workspace.database.prepare(`
          UPDATE pending_financial_items
          SET status = 'ended', resolved_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, refund.pendingItemId);
        if (ended.changes !== 1) throw new Error('退款申请已在其他操作中处理');
        this.workspace.database.prepare(`
          INSERT INTO aftersales_refund_ending_events (
            id, pending_item_id, requested_amount_cents, refunded_amount_cents,
            reason, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          refund.pendingItemId,
          refund.requestedAmountCents,
          refundedAmountCents,
          prepared.reason,
          prepared.occurredAt,
          now,
        );
        const replacementPending = this.replacementDeliveryPending(current);
        this.advanceCase(
          current,
          replacementPending ? 'waiting_replacement' : 'ready_to_complete',
          `结束退款：${prepared.reason}`,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'cancel') {
      const refund = current.refund;
      this.workspace.transaction(() => {
        if (refund?.status === 'pending' && refund.refundRecords.length === 0) {
          const cancelled = this.workspace.database.prepare(`
            UPDATE pending_financial_items
            SET status = 'cancelled', resolved_at = ?
            WHERE id = ? AND status = 'pending'
          `).run(now, refund.pendingItemId);
          if (cancelled.changes !== 1) throw new Error('退款申请已在其他操作中处理');
          this.workspace.database.prepare(`
            INSERT INTO pending_financial_item_events (
              id, pending_item_id, kind, requested_amount_cents,
              actual_amount_cents, reason, occurred_at, created_at
            ) VALUES (?, ?, 'cancelled', ?, NULL, ?, ?, ?)
          `).run(
            randomUUID(), refund.pendingItemId, refund.requestedAmountCents,
            prepared.reason, now, now,
          );
        }
        this.advanceCase(current, 'cancelled', prepared.reason, now);
      });
      return this.get(current.id);
    }
    const replacementWorkflow = current.rounds.at(-1)?.workflow === 'exchange'
      || current.rounds.at(-1)?.workflow === 'direct_replacement';
    if (
      current.status !== 'ready_to_complete'
      || (current.refund !== null
        && !isSettledRefundStatus(current.refund.status)
        && current.refund.status !== 'cancelled')
      || (!replacementWorkflow && !isSettledRefundStatus(current.refund?.status ?? null))
      || !this.allRequiredReplacementRoundsDelivered(current)
    ) {
      throw new Error('请先完成退款与必要的退货处理');
    }
    this.workspace.transaction(() => {
      this.advanceCase(current, 'completed', prepared.reason, now);
    });
    return this.get(current.id);
  }

  public assertPackagesCanBeCancelled(packageIds: readonly string[]): void {
    const aftersalesEvidence = this.workspace.database.prepare(`
      SELECT 1
      FROM shipment_package_items AS shipment_items
      WHERE shipment_items.package_id = ?
        AND (
          EXISTS (
            SELECT 1 FROM aftersales_case_items AS case_items
            WHERE case_items.shipment_package_item_id = shipment_items.id
          )
          OR EXISTS (
            SELECT 1 FROM aftersales_processing_round_items AS round_items
            WHERE round_items.source_shipment_package_item_id = shipment_items.id
          )
        )
      LIMIT 1
    `);
    if (packageIds.some((packageId) => aftersalesEvidence.get(packageId))) {
      throw new Error('包裹已经产生售后处理证据，不能按未交寄撤销');
    }
  }

  public synchronizeReplacementShipment(shipmentRecordId: string, now: string): void {
    const row = this.workspace.database.prepare(`
      SELECT rounds.case_id, rounds.id AS round_id
      FROM aftersales_replacement_shipments AS replacements
      JOIN aftersales_processing_rounds AS rounds ON rounds.id = replacements.round_id
      WHERE replacements.shipment_record_id = ?
    `).get(shipmentRecordId) as SqlRow | undefined;
    if (!row) return;
    const current = this.get(asString(row.case_id));
    const round = current.rounds.find(({ id }) => id === asString(row.round_id));
    if (!round || !round.replacementShipment) return;
    if (current.status === 'completed' || current.status === 'cancelled') return;
    const activePackages = round.replacementShipment.packages.filter(({ status }) => status === 'active');
    if (activePackages.length === 0 || activePackages.some(({ logisticsStatus }) => (
      logisticsStatus !== 'delivered'
    ))) return;
    if (!this.allRequiredReplacementRoundsDelivered(current)) {
      if (current.status !== 'waiting_replacement') {
        this.workspace.transaction(() => {
          this.advanceCase(current, 'waiting_replacement', '仍有其他待完成的补发轮次', now);
        });
      }
      return;
    }
    if (current.refund !== null
      && !isSettledRefundStatus(current.refund.status)
      && current.refund.status !== 'cancelled') {
      if (current.status !== 'waiting_refund') {
        this.workspace.transaction(() => {
          this.advanceCase(current, 'waiting_refund', '本轮补发已签收，等待确认实际退款', now);
        });
      }
      return;
    }
    if (current.status === 'ready_to_complete') return;
    this.workspace.transaction(() => {
      this.advanceCase(current, 'ready_to_complete', '本轮补发包裹已全部签收', now);
    });
  }

  public synchronizeCancelledReplacementShipment(
    shipmentRecordId: string,
    cancelledPackageIds: readonly string[],
    reason: string,
    now: string,
  ): void {
    const row = this.workspace.database.prepare(`
      SELECT rounds.case_id, rounds.id AS round_id, links.exception_id
      FROM aftersales_replacement_shipments AS replacements
      JOIN aftersales_processing_rounds AS rounds ON rounds.id = replacements.round_id
      LEFT JOIN aftersales_outbound_exception_replacement_rounds AS links
        ON links.round_id = rounds.id
      WHERE replacements.shipment_record_id = ?
    `).get(shipmentRecordId) as SqlRow | undefined;
    if (!row) return;
    const current = this.get(asString(row.case_id));
    if (current.status === 'completed' || current.status === 'cancelled') return;
    const round = current.rounds.find(({ id }) => id === asString(row.round_id));
    if (!round?.replacementShipment) return;
    const placeholders = cancelledPackageIds.map(() => '?').join(', ');
    const retryItems = this.workspace.database.prepare(`
      SELECT round_items.source_shipment_package_item_id, SUM(replacement_items.quantity) AS quantity
      FROM aftersales_replacement_items AS replacement_items
      JOIN aftersales_processing_round_items AS round_items
        ON round_items.id = replacement_items.round_item_id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = replacement_items.shipment_package_item_id
      WHERE replacement_items.replacement_shipment_id = (
        SELECT id FROM aftersales_replacement_shipments WHERE shipment_record_id = ?
      )
        AND shipment_items.package_id IN (${placeholders})
      GROUP BY round_items.source_shipment_package_item_id
      ORDER BY round_items.source_shipment_package_item_id
    `).all(shipmentRecordId, ...cancelledPackageIds) as Array<{
      source_shipment_package_item_id: string;
      quantity: number;
    }>;
    if (retryItems.length === 0) return;
    const exceptionId = row.exception_id === null ? null : asString(row.exception_id);
    const latestExceptionDecision = exceptionId === null
      ? null
      : this.workspace.database.prepare(`
        SELECT after_decision
        FROM aftersales_outbound_exception_decision_events
        WHERE case_id = ? AND exception_id = ?
        ORDER BY sequence DESC
        LIMIT 1
      `).get(current.id, exceptionId) as SqlRow | undefined;
    const exceptionStillRequiresReplacement = latestExceptionDecision !== null
      && latestExceptionDecision !== undefined
      && (asString(latestExceptionDecision.after_decision) === 'replacement'
        || asString(latestExceptionDecision.after_decision) === 'refund_and_replacement');
    const unmappedRoundStillRequiresReplacement = exceptionId === null
      && (round.workflow === 'exchange'
        || current.coordination.handlingDirection === 'replacement');
    if (exceptionStillRequiresReplacement || unmappedRoundStillRequiresReplacement) {
      this.workspace.transaction(() => {
        const retryRoundId = this.createDirectReplacementRound(
          current,
          round.sourceShipmentRecordId,
          retryItems.map((item) => ({
            shipmentPackageItemId: item.source_shipment_package_item_id,
            quantity: item.quantity,
          })),
          now,
          reason,
          now,
        );
        if (exceptionId !== null) {
          this.workspace.database.prepare(`
            INSERT INTO aftersales_outbound_exception_replacement_rounds (
              exception_id, case_id, round_id, created_at
            ) VALUES (?, ?, ?, ?)
          `).run(exceptionId, current.id, retryRoundId, now);
        }
        this.advanceCase(current, 'waiting_replacement', reason, now);
      });
    }
  }

  private resolveSourceItems(
    shipmentRecordId: string,
    inputs: readonly AftersalesCaseItemInput[],
  ): Map<string, SqlRow> {
    const recordRow = this.workspace.database.prepare(`
      SELECT records.id, voids.id AS void_event_id
      FROM shipment_records AS records
      LEFT JOIN shipment_record_void_events AS voids
        ON voids.shipment_record_id = records.id
      WHERE records.id = ?
    `).get(shipmentRecordId) as SqlRow | undefined;
    if (!recordRow) throw new Error('发货记录不存在');
    if (recordRow.void_event_id !== null) throw new Error('已作废的发货记录不能建立售后处理单');
    const sourceItems = new Map<string, SqlRow>();
    for (const input of inputs) {
      const row = this.workspace.database.prepare(`
        SELECT
          items.*,
          packages.id AS source_package_id,
          packages.shipment_record_id,
          packages.position AS source_package_position,
          packages.shipping_carrier AS source_shipping_carrier,
          packages.tracking_number AS source_tracking_number,
          packages.logistics_status AS source_logistics_status,
          COALESCE((
            SELECT events.occurred_at
            FROM shipment_package_logistics_status_events AS events
            WHERE events.package_id = packages.id
              AND events.after_status = 'delivered'
            ORDER BY events.result_revision DESC
            LIMIT 1
          ), CASE
            WHEN packages.logistics_status = 'delivered' THEN packages.created_at
            ELSE NULL
          END) AS source_delivered_at,
          COALESCE((
            SELECT MAX(CASE
              WHEN json_extract(exceptions.impact_json, '$.scope') = 'package'
                THEN items.quantity
              ELSE COALESCE((
                SELECT json_extract(affected_item.value, '$.quantity')
                FROM json_each(exceptions.impact_json, '$.items') AS affected_item
                WHERE json_extract(affected_item.value, '$.sourceItemId') = items.id
                LIMIT 1
              ), 0)
            END)
            FROM logistics_exception_matters AS exceptions
            WHERE exceptions.shipment_package_id = packages.id
              AND exceptions.exception_type = 'lost'
              AND exceptions.stage = 'confirmed'
          ), 0) AS source_confirmed_lost_quantity,
          cancellations.id AS cancellation_event_id
        FROM shipment_package_items AS items
        JOIN shipment_packages AS packages ON packages.id = items.package_id
        LEFT JOIN shipment_package_cancellation_events AS cancellations
          ON cancellations.package_id = packages.id
        WHERE items.id = ?
      `).get(input.shipmentPackageItemId) as SqlRow | undefined;
      if (!row || asString(row.shipment_record_id) !== shipmentRecordId) {
        throw new Error('所选商品不属于当前发货记录');
      }
      if (row.cancellation_event_id !== null) throw new Error('已撤销包裹中的商品不能建立售后处理单');
      sourceItems.set(input.shipmentPackageItemId, row);
    }
    return sourceItems;
  }

  private assertQuantitiesAvailable(
    inputs: readonly AftersalesCaseItemInput[],
    sourceItems: ReadonlyMap<string, SqlRow>,
    excludedCaseId?: string,
    reserveQuantity = true,
  ): void {
    for (const input of inputs) {
      const sourceItem = sourceItems.get(input.shipmentPackageItemId);
      if (!sourceItem) throw new Error('发货快照商品不存在');
      const allocatedRow = this.workspace.database.prepare(`
        SELECT COALESCE(SUM(items.quantity), 0) AS quantity
        FROM aftersales_case_items AS items
        JOIN aftersales_cases AS cases ON cases.id = items.case_id
        WHERE items.shipment_package_item_id = ?
          AND cases.status NOT IN ('completed', 'cancelled')
          AND (? IS NULL OR cases.id <> ?)
      `).get(
        input.shipmentPackageItemId,
        excludedCaseId ?? null,
        excludedCaseId ?? null,
      ) as SqlRow;
      const available = asNumber(sourceItem.quantity) - (
        reserveQuantity ? asNumber(allocatedRow.quantity) : 0
      );
      if (input.quantity > available) {
        throw new Error(
          `${asString(sourceItem.source_title)}最多还可登记 ${Math.max(available, 0)} 件售后`,
        );
      }
    }
  }

  private get(caseId: string): AftersalesCase {
    const row = this.workspace.database.prepare(`
      SELECT * FROM aftersales_cases WHERE id = ?
    `).get(caseId) as SqlRow | undefined;
    if (!row) throw new Error('售后处理单不存在');
    const itemRows = this.workspace.database.prepare(`
      SELECT
        case_items.id,
        case_items.shipment_package_item_id,
        case_items.quantity,
        shipment_items.package_id,
        shipment_items.order_id,
        shipment_items.source_order_item_id,
        shipment_items.order_number,
        shipment_items.source_title,
        shipment_items.source_spec,
        shipment_items.quantity AS source_shipped_quantity
      FROM aftersales_case_items AS case_items
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      WHERE case_items.case_id = ?
      ORDER BY shipment_items.order_number, shipment_items.position, case_items.id
    `).all(caseId) as unknown as SqlRow[];
    const items = itemRows.map((itemRow): AftersalesCaseItem => ({
      id: asString(itemRow.id),
      shipmentPackageItemId: asString(itemRow.shipment_package_item_id),
      packageId: asString(itemRow.package_id),
      orderId: asString(itemRow.order_id),
      orderItemId: asString(itemRow.source_order_item_id),
      orderNumber: asString(itemRow.order_number),
      sourceTitle: asString(itemRow.source_title),
      sourceSpec: asString(itemRow.source_spec),
      quantity: asNumber(itemRow.quantity),
      sourceShippedQuantity: asNumber(itemRow.source_shipped_quantity),
    }));
    const eventRows = this.workspace.database.prepare(`
      SELECT *
      FROM aftersales_case_events
      WHERE case_id = ?
      ORDER BY result_revision
    `).all(caseId) as unknown as SqlRow[];
    const occurredAt = asString(row.occurred_at);
    const timeline = eventRows.map((eventRow): AftersalesCaseEvent => {
      const snapshot = parseSnapshot(asString(eventRow.after_snapshot_json));
      const resultRevision = asNumber(eventRow.result_revision);
      if (asString(eventRow.kind) === 'created') {
        if (resultRevision !== 1) {
          throw new Error('数据库售后处理单建立事件无效');
        }
        return {
          kind: 'created',
          resultRevision: 1,
          status: snapshot.status,
          reason: snapshot.reason,
          occurredAt,
          items: snapshot.items,
          createdAt: asString(eventRow.created_at),
        };
      }
      const beforeJson = eventRow.before_snapshot_json;
      if (beforeJson === null) throw new Error('数据库售后处理单变更事件无效');
      return {
        kind: 'updated',
        baseRevision: asNumber(eventRow.base_revision),
        resultRevision,
        changeReason: asString(eventRow.change_reason),
        before: parseSnapshot(asString(beforeJson)),
        after: snapshot,
        createdAt: asString(eventRow.created_at),
      };
    });
    const refund = this.getRefund(caseId);
    const returns = this.getReturns(caseId);
    const rounds = this.getProcessingRounds(caseId);
    const fulfillment = this.getFulfillmentSummary(caseId, rounds);
    const returnExceptions = this.getReturnExceptionEvidenceHistory(caseId, returns).map(
      (exception) => ({
        ...exception,
        decisionTimeline: this.getReturnExceptionDecisionTimeline(
          caseId,
          exception.exceptionId,
        ),
      }),
    );
    const outboundExceptions = this.getOutboundExceptionEvidenceHistory({
      id: caseId,
      shipmentRecordId: asString(row.shipment_record_id),
      items,
      rounds,
    }).map((exception) => ({
      ...exception,
      decisionTimeline: this.getOutboundExceptionDecisionTimeline(caseId, exception.exceptionId),
    }));
    const coordination = coordinateAftersales({
      handlingDirection: asNullableHandlingDirection(row.handling_direction),
      sourcePackages: this.getSourcePackageEvidence(caseId),
      interception: this.getInterception(caseId),
      handlingDirectionTimeline: this.getHandlingDirectionTimeline(caseId),
      refundStatus: refund?.status ?? null,
      returnExceptions,
      outboundExceptions,
      interceptedReturnInspection: this.getInterceptedReturnInspection(caseId),
    });
    const currentRound = rounds.find((round) => (
      round.replacementRequired && !replacementRoundDelivered(round)
    )) ?? [...rounds].reverse().find(({ replacementRequired }) => (
      replacementRequired
    )) ?? rounds.at(-1);
    const currentRoundReturns = currentRound
      ? returns.filter(({ id }) => currentRound.returnRecordIds.includes(id))
      : [];
    const hasUndecidedOutboundException = coordination.outboundExceptionHistory.some((exception) => (
      exception.stage === 'confirmed' && exception.decision === null
    ));
    const workflowTemplate = this.getWorkflowTemplate(caseId);
    return {
      id: asString(row.id),
      shipmentRecordId: asString(row.shipment_record_id),
      workflow: asAftersalesWorkflow(row.workflow),
      workflowTemplate,
      status: asAftersalesStatus(row.status),
      revision: asNumber(row.revision),
      reason: asString(row.reason),
      occurredAt,
      items,
      refund,
      returns,
      rounds,
      fulfillment,
      coordination: currentRound && currentRound.workflow !== 'legacy'
        && coordination.returnException === null
        && !hasUndecidedOutboundException
        ? {
          ...coordination,
          currentTodo: replacementRoundTodo(currentRound, currentRoundReturns),
        }
        : coordination,
      timeline,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  private getWorkflowTemplate(caseId: string): AftersalesCaseWorkflowTemplate {
    const rows = this.workspace.database.prepare(`
      SELECT *
      FROM aftersales_case_workflow_template_events
      WHERE case_id = ?
      ORDER BY sequence
    `).all(caseId) as unknown as SqlRow[];
    if (rows.length === 0) throw new Error('售后处理单缺少流程模板版本');
    const timeline = rows.map((row): AftersalesCaseWorkflowTemplateEvent => {
      const kind = asString(row.kind);
      if (kind !== 'selected' && kind !== 'changed') {
        throw new Error('数据库售后流程模板选择事件无效');
      }
      return {
        kind,
        before: row.before_template_id === null
          ? null
          : {
            templateId: asString(row.before_template_id),
            version: asNumber(row.before_template_version),
          },
        after: {
          templateId: asString(row.after_template_id),
          version: asNumber(row.after_template_version),
        },
        reason: asString(row.reason),
        occurredAt: asString(row.occurred_at),
        createdAt: asString(row.created_at),
      };
    });
    const current = timeline.at(-1);
    if (!current) throw new Error('售后处理单缺少流程模板版本');
    const template = this.aftersalesWorkflowTemplateService().getVersion(
      current.after.templateId,
      current.after.version,
    );
    const stepEventRows = this.workspace.database.prepare(`
      SELECT *
      FROM aftersales_case_step_events
      WHERE case_id = ?
      ORDER BY sequence
    `).all(caseId) as unknown as SqlRow[];
    const stepEvents = stepEventRows.map((row): AftersalesCaseStepEvent => {
      const kind = asString(row.kind);
      if (kind !== 'completed' && kind !== 'skipped') {
        throw new Error('数据库售后流程步骤事件无效');
      }
      return {
        id: asString(row.id),
        stepId: asString(row.step_id),
        kind,
        reason: asString(row.reason),
        remainingRisk: row.remaining_risk === null ? null : asString(row.remaining_risk),
        workflowTemplateId: asString(row.workflow_template_id),
        workflowTemplateVersion: asNumber(row.workflow_template_version),
        occurredAt: asString(row.occurred_at),
        createdAt: asString(row.created_at),
      };
    });
    return {
      templateId: template.id,
      version: template.version,
      name: template.name,
      scenario: template.scenario,
      steps: template.steps,
      timeline,
      stepEvents,
    };
  }

  private getProcessingRounds(caseId: string): AftersalesProcessingRound[] {
    const rows = this.workspace.database.prepare(`
      SELECT * FROM aftersales_processing_rounds
      WHERE case_id = ?
      ORDER BY round_number, id
    `).all(caseId) as unknown as SqlRow[];
    return rows.map((row) => {
      const roundId = asString(row.id);
      const itemRows = this.workspace.database.prepare(`
        SELECT
          round_items.id,
          round_items.source_shipment_package_item_id,
          round_items.quantity,
          shipment_items.package_id,
          shipment_items.order_id,
          shipment_items.source_order_item_id,
          shipment_items.order_number,
          shipment_items.source_title,
          shipment_items.source_spec
        FROM aftersales_processing_round_items AS round_items
        JOIN shipment_package_items AS shipment_items
          ON shipment_items.id = round_items.source_shipment_package_item_id
        WHERE round_items.round_id = ?
        ORDER BY shipment_items.order_number, shipment_items.position, round_items.id
      `).all(roundId) as unknown as SqlRow[];
      const returnRows = this.workspace.database.prepare(`
        SELECT return_record_id FROM aftersales_round_returns
        WHERE round_id = ? ORDER BY return_record_id
      `).all(roundId) as unknown as SqlRow[];
      const replacementRow = this.workspace.database.prepare(`
        SELECT shipment_record_id, occurred_at FROM aftersales_replacement_shipments
        WHERE round_id = ?
      `).get(roundId) as SqlRow | undefined;
      const mappedDecisionRow = this.workspace.database.prepare(`
        SELECT decisions.after_decision
        FROM aftersales_outbound_exception_replacement_rounds AS links
        JOIN aftersales_outbound_exception_decision_events AS decisions
          ON decisions.exception_id = links.exception_id
         AND decisions.case_id = links.case_id
        WHERE links.round_id = ?
        ORDER BY decisions.sequence DESC
        LIMIT 1
      `).get(roundId) as SqlRow | undefined;
      const workflow = asString(row.workflow);
      if (workflow !== 'legacy' && workflow !== 'exchange' && workflow !== 'direct_replacement') {
        throw new Error('数据库售后处理轮次方式错误');
      }
      const replacementShipment = replacementRow
        ? this.readShipmentRecord(asString(replacementRow.shipment_record_id))
        : null;
      const hasActiveReplacementPackage = replacementShipment?.packages.some(({ status }) => (
        status === 'active'
      )) ?? false;
      const handlingDirectionRow = this.workspace.database.prepare(`
        SELECT handling_direction FROM aftersales_cases WHERE id = ?
      `).get(caseId) as SqlRow;
      const handlingDirection = asNullableHandlingDirection(
        handlingDirectionRow.handling_direction,
      );
      const latestDecisionRequiresReplacement = mappedDecisionRow !== undefined
        && (asString(mappedDecisionRow.after_decision) === 'replacement'
          || asString(mappedDecisionRow.after_decision) === 'refund_and_replacement');
      const replacementRequired = workflow !== 'legacy' && (
        hasActiveReplacementPackage
        || (replacementShipment === null && (
          latestDecisionRequiresReplacement
          || (mappedDecisionRow === undefined
            && (workflow === 'exchange'
              ? handlingDirection === 'buyer_return'
              : handlingDirection === 'replacement'))
        ))
      );
      return {
        id: roundId,
        roundNumber: asNumber(row.round_number),
        workflow,
        replacementRequired,
        sourceShipmentRecordId: asString(row.source_shipment_record_id),
        items: itemRows.map((item) => ({
          id: asString(item.id),
          sourceShipmentPackageItemId: asString(item.source_shipment_package_item_id),
          packageId: asString(item.package_id),
          orderId: asString(item.order_id),
          orderItemId: asString(item.source_order_item_id),
          orderNumber: asString(item.order_number),
          sourceTitle: asString(item.source_title),
          sourceSpec: asString(item.source_spec),
          quantity: asNumber(item.quantity),
        })),
        returnRecordIds: returnRows.map((item) => asString(item.return_record_id)),
        replacementShipment,
        replacementOccurredAt: replacementRow
          ? asString(replacementRow.occurred_at)
          : null,
        occurredAt: asString(row.occurred_at),
        reason: asString(row.reason),
        createdAt: asString(row.created_at),
      };
    });
  }

  private getFulfillmentSummary(
    caseId: string,
    rounds: readonly AftersalesProcessingRound[],
  ): AftersalesFulfillmentSummary {
    const sentRow = this.workspace.database.prepare(`
      SELECT
        (SELECT COALESCE(SUM(quantity), 0) FROM aftersales_case_items WHERE case_id = ?) +
        (SELECT COALESCE(SUM(items.quantity), 0)
         FROM aftersales_replacement_items AS items
         JOIN aftersales_replacement_shipments AS replacements
           ON replacements.id = items.replacement_shipment_id
         JOIN aftersales_processing_rounds AS rounds ON rounds.id = replacements.round_id
         WHERE rounds.case_id = ?) AS quantity
    `).get(caseId, caseId) as SqlRow;
    const returnedRow = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(return_items.received_quantity), 0) AS quantity
      FROM aftersales_round_returns AS links
      JOIN aftersales_processing_rounds AS rounds ON rounds.id = links.round_id
      JOIN aftersales_return_record_items AS return_items
        ON return_items.return_record_id = links.return_record_id
       AND return_items.aftersales_case_id = rounds.case_id
      WHERE rounds.case_id = ?
    `).get(caseId) as SqlRow;
    const heldOriginalRow = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(case_items.quantity), 0) AS quantity
      FROM aftersales_case_items AS case_items
      JOIN shipment_package_items AS items
        ON items.id = case_items.shipment_package_item_id
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      WHERE case_items.case_id = ? AND packages.logistics_status = 'delivered'
    `).get(caseId) as SqlRow;
    const heldReplacementRow = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(mapped.quantity), 0) AS quantity
      FROM aftersales_replacement_items AS mapped
      JOIN aftersales_replacement_shipments AS replacements
        ON replacements.id = mapped.replacement_shipment_id
      JOIN aftersales_processing_rounds AS rounds ON rounds.id = replacements.round_id
      JOIN shipment_package_items AS items ON items.id = mapped.shipment_package_item_id
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      WHERE rounds.case_id = ? AND packages.logistics_status = 'delivered'
    `).get(caseId) as SqlRow;
    const returned = asNumber(returnedRow.quantity);
    return {
      cumulativeSentQuantity: asNumber(sentRow.quantity),
      cumulativeReturnedQuantity: returned,
      buyerHeldQuantity: Math.max(
        asNumber(heldOriginalRow.quantity) + asNumber(heldReplacementRow.quantity) - returned,
        0,
      ),
      currentRoundNumber: rounds.at(-1)?.roundNumber ?? 1,
    };
  }

  private readShipmentRecord(recordId: string): ShipmentRecord {
    if (!this.shipmentRecordReader) throw new Error('售后服务缺少发货记录读取器');
    return this.shipmentRecordReader(recordId);
  }

  private createReplacementShipment(
    current: AftersalesCase,
    round: AftersalesProcessingRound,
    prepared: Extract<ProgressAftersalesCaseInput, { kind: 'create_replacement_shipment' }>,
    now: string,
  ): void {
    const sourceRecord = this.readShipmentRecord(round.sourceShipmentRecordId);
    const sourceItemRows = new Map(round.items.map((item) => {
      const row = this.workspace.database.prepare(`
        SELECT * FROM shipment_package_items WHERE id = ?
      `).get(item.sourceShipmentPackageItemId) as SqlRow | undefined;
      if (!row) throw new Error('补发商品来源快照不存在');
      return [item.id, row] as const;
    }));
    const allocatedOrderIds = [...new Set(prepared.packages.flatMap((shipmentPackage) => (
      shipmentPackage.items.map((item) => (
        asString(sourceItemRows.get(item.roundItemId)?.order_id)
      ))
    )))].sort();
    const sourceOrderById = new Map(sourceRecord.sourceOrders.map((order) => [order.orderId, order]));
    const memberOrders = allocatedOrderIds.map((orderId) => {
      const order = sourceOrderById.get(orderId);
      if (!order) throw new Error('补发记录缺少订单来源快照');
      return order;
    });
    const totalQuantity = prepared.packages.flatMap(({ items }) => items)
      .reduce((sum, { quantity }) => sum + quantity, 0);
    const archiveId = randomUUID();
    const recordId = randomUUID();
    const sourceGroupId = `aftersales-replacement-${current.id}-round-${round.roundNumber}`;
    this.workspace.database.prepare(`
      INSERT INTO shipment_group_archives (
        id, source_group_id, status, recipient, phone, phone_normalized,
        address_original, address_normalized, member_order_ids_json,
        member_recipient_snapshots_json, total_quantity,
        created_at, fully_shipped_at, updated_at
      ) VALUES (?, ?, 'fully_shipped', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      archiveId,
      sourceGroupId,
      sourceRecord.recipient,
      sourceRecord.phone,
      sourceRecord.phoneNormalized,
      sourceRecord.addressOriginal,
      sourceRecord.addressNormalized,
      JSON.stringify(allocatedOrderIds),
      JSON.stringify(memberOrders.map((order) => ({
        orderId: order.orderId,
        recipient: order.recipient,
        phone: order.phone,
        addressOriginal: order.addressOriginal,
      }))),
      totalQuantity,
      now,
      now,
      now,
    );
    this.workspace.database.prepare(`
      INSERT INTO shipment_records (
        id, shipment_group_archive_id, source_group_id, recipient, phone,
        phone_normalized, address_original, address_normalized, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId,
      archiveId,
      sourceGroupId,
      sourceRecord.recipient,
      sourceRecord.phone,
      sourceRecord.phoneNormalized,
      sourceRecord.addressOriginal,
      sourceRecord.addressNormalized,
      now,
    );
    const insertSnapshot = this.workspace.database.prepare(`
      INSERT INTO shipment_record_order_snapshots (
        id, shipment_record_id, order_id, order_number, seller_account,
        buyer_nickname, recipient, phone, address_original,
        amount_cents, revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const order of memberOrders) {
      insertSnapshot.run(
        randomUUID(), recordId, order.orderId, order.orderNumber, order.sellerAccount,
        order.buyerNickname, order.recipient, order.phone, order.addressOriginal,
        order.amountCents, order.revision, now,
      );
    }
    const replacementId = randomUUID();
    this.workspace.database.prepare(`
      INSERT INTO aftersales_replacement_shipments (
        id, round_id, shipment_record_id, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(replacementId, round.id, recordId, prepared.occurredAt, now);
    for (const [packagePosition, shipmentPackage] of prepared.packages.entries()) {
      const packageId = randomUUID();
      this.workspace.database.prepare(`
        INSERT INTO shipment_packages (
          id, shipment_record_id, position, shipping_carrier,
          tracking_number, revision, created_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(
        packageId,
        recordId,
        packagePosition,
        shipmentPackage.shippingCarrier,
        shipmentPackage.trackingNumber,
        now,
      );
      for (const [itemPosition, item] of shipmentPackage.items.entries()) {
        const source = sourceItemRows.get(item.roundItemId);
        if (!source) throw new Error('补发商品来源已变化');
        const shipmentItemId = randomUUID();
        this.workspace.database.prepare(`
          INSERT INTO shipment_package_items (
            id, package_id, position, order_id, source_order_item_id,
            order_number, seller_account, buyer_nickname, source_title, source_spec,
            unit_price_cents, source_item_quantity, quantity, subtotal_cents, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          shipmentItemId,
          packageId,
          itemPosition,
          asString(source.order_id),
          asString(source.source_order_item_id),
          asString(source.order_number),
          asString(source.seller_account),
          asString(source.buyer_nickname),
          asString(source.source_title),
          asString(source.source_spec),
          asNumber(source.unit_price_cents),
          asNumber(source.source_item_quantity),
          item.quantity,
          asNumber(source.unit_price_cents) * item.quantity,
          now,
        );
        this.workspace.database.prepare(`
          INSERT INTO aftersales_replacement_items (
            id, replacement_shipment_id, round_item_id,
            shipment_package_item_id, quantity
          ) VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), replacementId, item.roundItemId, shipmentItemId, item.quantity);
      }
    }
  }

  private getSourcePackageEvidence(caseId: string): AftersalesSourcePackageEvidence[] {
    const rows = this.workspace.database.prepare(`
      SELECT
        packages.id AS package_id,
        packages.shipping_carrier,
        packages.tracking_number,
        packages.logistics_status,
        case_items.quantity,
        shipment_items.id AS shipment_package_item_id,
        shipment_items.source_title,
        shipment_items.source_spec,
        COALESCE((
          SELECT MAX(CASE
            WHEN json_extract(exceptions.impact_json, '$.scope') = 'package'
              THEN case_items.quantity
            ELSE COALESCE((
              SELECT json_extract(affected_item.value, '$.quantity')
              FROM json_each(exceptions.impact_json, '$.items') AS affected_item
              WHERE json_extract(affected_item.value, '$.sourceItemId') = shipment_items.id
              LIMIT 1
            ), 0)
          END)
          FROM logistics_exception_matters AS exceptions
          WHERE exceptions.shipment_package_id = packages.id
            AND exceptions.exception_type = 'lost'
            AND exceptions.stage = 'confirmed'
        ), 0) AS confirmed_lost_quantity
      FROM aftersales_case_items AS case_items
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      JOIN shipment_packages AS packages ON packages.id = shipment_items.package_id
      WHERE case_items.case_id = ?
      ORDER BY packages.position, packages.id, shipment_items.position, shipment_items.id
    `).all(caseId) as unknown as SqlRow[];
    const packages = new Map<string, AftersalesSourcePackageEvidence>();
    for (const row of rows) {
      const packageId = asString(row.package_id);
      const logisticsStatus = asString(row.logistics_status);
      if (!isOutboundLogisticsStatus(logisticsStatus)) {
        throw new Error('数据库原正向包裹物流状态错误');
      }
      const sourcePackage = packages.get(packageId) ?? {
        packageId,
        shippingCarrier: asString(row.shipping_carrier),
        trackingNumber: asString(row.tracking_number),
        logisticsStatus,
        confirmedLost: false,
        items: [],
      };
      const quantity = asNumber(row.quantity);
      const confirmedLostQuantity = Math.min(
        quantity,
        asNumber(row.confirmed_lost_quantity),
      );
      sourcePackage.items.push({
        shipmentPackageItemId: asString(row.shipment_package_item_id),
        sourceTitle: asString(row.source_title),
        sourceSpec: asString(row.source_spec),
        quantity,
        confirmedLostQuantity,
      });
      sourcePackage.confirmedLost = sourcePackage.items.every((item) => (
        item.confirmedLostQuantity === item.quantity
      ));
      packages.set(packageId, sourcePackage);
    }
    for (const sourcePackage of packages.values()) {
      const claim = this.logisticsExceptionService().getClaim({
        direction: 'outbound',
        packageId: sourcePackage.packageId,
      });
      sourcePackage.carrierClaim = claim ? {
        id: claim.id,
        status: claim.status,
        requestedAmountCents: claim.requestedAmountCents,
        approvedAmountCents: claim.approvedAmountCents,
        actualCompensationCents: claim.actualCompensation?.amountCents ?? null,
        impact: claim.impact,
        updatedAt: claim.timeline.at(-1)?.occurredAt ?? claim.updatedAt,
        timeline: claim.timeline,
      } : null;
    }
    return [...packages.values()];
  }

  private getHandlingDirectionTimeline(caseId: string): AftersalesHandlingDirectionEvent[] {
    const rows = this.workspace.database.prepare(`
      SELECT kind, before_direction, after_direction, occurred_at, reason, created_at
      FROM aftersales_handling_direction_events
      WHERE case_id = ?
      ORDER BY sequence
    `).all(caseId) as unknown as SqlRow[];
    return rows.map((row) => {
      const kind = asString(row.kind);
      if (kind !== 'selected' && kind !== 'changed' && kind !== 'cleared') {
        throw new Error('数据库售后处理方向事件错误');
      }
      const after = asNullableHandlingDirection(row.after_direction);
      if ((kind === 'cleared' && after !== null)
        || (kind !== 'cleared' && after === null)) {
        throw new Error('数据库售后处理方向事件错误');
      }
      return {
        kind,
        before: asNullableHandlingDirection(row.before_direction),
        after,
        occurredAt: asString(row.occurred_at),
        reason: asString(row.reason),
        createdAt: asString(row.created_at),
      };
    });
  }

  private getInterception(caseId: string): AftersalesInterception | null {
    const packageRow = this.workspace.database.prepare(`
      SELECT shipment_package_id
      FROM aftersales_interception_packages
      WHERE case_id = ?
    `).get(caseId) as SqlRow | undefined;
    const rows = this.workspace.database.prepare(`
      SELECT kind, occurred_at, reason, created_at
      FROM aftersales_interception_events
      WHERE case_id = ?
      ORDER BY sequence
    `).all(caseId) as unknown as SqlRow[];
    if (rows.length === 0) return null;
    const timeline = rows.map((row): AftersalesInterceptionEvent => {
      const kind = asString(row.kind);
      if (kind !== 'requested' && kind !== 'succeeded' && kind !== 'failed') {
        throw new Error('数据库拦截事项事件错误');
      }
      return {
        kind,
        occurredAt: asString(row.occurred_at),
        reason: asString(row.reason),
        createdAt: asString(row.created_at),
      };
    });
    return {
      packageId: packageRow ? asString(packageRow.shipment_package_id) : null,
      status: timeline.at(-1)?.kind as AftersalesInterception['status'],
      timeline,
    };
  }

  private getReturnExceptionEvidenceHistory(
    caseId: string,
    returns: AftersalesCase['returns'],
  ): AftersalesReturnExceptionEvidence[] {
    const evidence: AftersalesReturnExceptionEvidence[] = [];
    for (const returnRecord of returns) {
      const caseItems = returnRecord.items.filter((item) => item.aftersalesCaseId === caseId);
      if (caseItems.length === 0) continue;
      const itemIds = new Set(caseItems.map(({ id }) => id));
      for (const exception of returnRecord.logisticsExceptions) {
        if (!(exception.impact.scope === 'package'
          || exception.impact.items.some(({ sourceItemId }) => itemIds.has(sourceItemId)))
        ) continue;
        const affectedQuantity = exception.impact.scope === 'package'
          ? caseItems.reduce((total, item) => total + item.quantity, 0)
          : exception.impact.items.reduce((total, affectedItem) => (
            itemIds.has(affectedItem.sourceItemId) ? total + affectedItem.quantity : total
          ), 0);
        evidence.push({
          exceptionId: exception.id,
          returnRecordId: returnRecord.id,
          exceptionType: exception.exceptionType,
          stage: exception.stage,
          affectedQuantity,
        });
      }
    }
    return evidence;
  }

  private getReturnExceptionDecisionTimeline(
    caseId: string,
    exceptionId: string,
  ): AftersalesReturnExceptionDecisionEvent[] {
    const rows = this.workspace.database.prepare(`
      SELECT kind, exception_id, return_record_id, before_decision,
             after_decision, occurred_at, reason, created_at
      FROM aftersales_return_exception_decision_events
      WHERE case_id = ? AND exception_id = ?
      ORDER BY sequence
    `).all(caseId, exceptionId) as unknown as SqlRow[];
    return rows.map((row) => {
      const kind = asString(row.kind);
      const before = row.before_decision === null ? null : asString(row.before_decision);
      const after = asString(row.after_decision);
      if ((kind !== 'selected' && kind !== 'changed')
        || (before !== null && !isAftersalesReturnExceptionDecision(before))
        || !isAftersalesReturnExceptionDecision(after)) {
        throw new Error('数据库退货异常处理选择事件错误');
      }
      return {
        kind,
        exceptionId: asString(row.exception_id),
        returnRecordId: asString(row.return_record_id),
        before,
        after,
        occurredAt: asString(row.occurred_at),
        reason: asString(row.reason),
        createdAt: asString(row.created_at),
      };
    });
  }

  private getOutboundExceptionEvidenceHistory(input: {
    id: string;
    shipmentRecordId: string;
    items: AftersalesCaseItem[];
    rounds: AftersalesProcessingRound[];
  }): AftersalesOutboundExceptionEvidence[] {
    const evidence: AftersalesOutboundExceptionEvidence[] = [];
    const sources = new Map<string, Array<{
      shipmentPackageItemId: string;
      packageId: string;
      sourceTitle: string;
      sourceSpec: string;
      quantity: number;
    }>>();
    sources.set(input.shipmentRecordId, input.items.map((item) => ({
      shipmentPackageItemId: item.shipmentPackageItemId,
      packageId: item.packageId,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      quantity: item.quantity,
    })));
    for (const round of input.rounds) {
      if (!round.replacementShipment) continue;
      sources.set(
        round.replacementShipment.id,
        round.replacementShipment.packages.flatMap((shipmentPackage) => (
          shipmentPackage.items.map((item) => ({
            shipmentPackageItemId: item.id,
            packageId: shipmentPackage.id,
            sourceTitle: item.sourceTitle,
            sourceSpec: item.sourceSpec,
            quantity: item.quantity,
          }))
        )),
      );
    }
    for (const [sourceShipmentRecordId, relevantItems] of sources) {
      const record = this.readShipmentRecord(sourceShipmentRecordId);
      for (const shipmentPackage of record.packages) {
        const caseItems = relevantItems.filter(({ packageId }) => packageId === shipmentPackage.id);
        if (caseItems.length === 0) continue;
        for (const exception of shipmentPackage.logisticsExceptions) {
          const affectedItems = caseItems.flatMap((item) => {
            const quantity = exception.impact.scope === 'package'
              ? item.quantity
              : Math.min(
                item.quantity,
                exception.impact.items.find(({ sourceItemId }) => (
                  sourceItemId === item.shipmentPackageItemId
                ))?.quantity ?? 0,
              );
            return quantity > 0 ? [{ ...item, quantity }] : [];
          });
          const affectedQuantity = affectedItems.reduce((sum, item) => sum + item.quantity, 0);
          if (affectedQuantity <= 0) continue;
          evidence.push({
            exceptionId: exception.id,
            sourceShipmentRecordId,
            packageId: shipmentPackage.id,
            exceptionType: exception.exceptionType,
            stage: exception.stage,
            affectedQuantity,
            affectedItems: affectedItems.map((item) => ({
              shipmentPackageItemId: item.shipmentPackageItemId,
              sourceTitle: item.sourceTitle,
              sourceSpec: item.sourceSpec,
              quantity: item.quantity,
            })),
            occurredAt: exception.timeline.at(-1)?.occurredAt ?? exception.occurredAt,
          });
        }
      }
    }
    return evidence.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  }

  private getOutboundExceptionDecisionTimeline(
    caseId: string,
    exceptionId: string,
  ): AftersalesOutboundExceptionDecisionEvent[] {
    const rows = this.workspace.database.prepare(`
      SELECT kind, exception_id, shipment_package_id, before_decision,
             after_decision, affected_items_json, occurred_at, reason, created_at
      FROM aftersales_outbound_exception_decision_events
      WHERE case_id = ? AND exception_id = ?
      ORDER BY sequence
    `).all(caseId, exceptionId) as unknown as SqlRow[];
    return rows.map((row) => {
      const kind = asString(row.kind);
      const before = row.before_decision === null ? null : asString(row.before_decision);
      const after = asString(row.after_decision);
      if ((kind !== 'selected' && kind !== 'changed')
        || (before !== null && !isAftersalesOutboundExceptionDecision(before))
        || !isAftersalesOutboundExceptionDecision(after)) {
        throw new Error('数据库正向物流异常处理选择事件错误');
      }
      return {
        kind,
        exceptionId: asString(row.exception_id),
        packageId: asString(row.shipment_package_id),
        before,
        after,
        affectedItems: parseOutboundAffectedItems(asString(row.affected_items_json)),
        occurredAt: asString(row.occurred_at),
        reason: asString(row.reason),
        createdAt: asString(row.created_at),
      };
    });
  }

  private getInterceptedReturnInspection(
    caseId: string,
  ): AftersalesInterceptedReturnInspection | null {
    const row = this.workspace.database.prepare(`
      SELECT shipment_package_id, result, items_json, occurred_at, reason, created_at
      FROM aftersales_intercepted_return_inspection_events
      WHERE case_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(caseId) as SqlRow | undefined;
    if (!row) return null;
    const result = asString(row.result);
    if (result !== 'resellable' && result !== 'defective'
      && result !== 'scrapped' && result !== 'other') {
      throw new Error('数据库拦截退回检查结果错误');
    }
    return {
      packageId: asString(row.shipment_package_id),
      result,
      items: parseAftersalesItemInputs(
        JSON.parse(asString(row.items_json)) as unknown,
        '数据库拦截退回检查商品错误',
      ),
      occurredAt: asString(row.occurred_at),
      reason: asString(row.reason),
      createdAt: asString(row.created_at),
    };
  }

  private getRefund(caseId: string): AftersalesCase['refund'] {
    const row = this.workspace.database.prepare(`
      SELECT *
      FROM pending_financial_items
      WHERE aftersales_case_id = ?
    `).get(caseId) as SqlRow | undefined;
    if (!row) return null;
    const status = asString(row.status);
    if (status !== 'pending' && status !== 'confirmed' && status !== 'cancelled'
      && status !== 'ended') {
      throw new Error('数据库待确认资金事项状态错误');
    }
    const pendingItemId = asString(row.id);
    const requestedAmountCents = asNumber(row.requested_amount_cents);
    const recordRows = this.workspace.database.prepare(`
      SELECT *
      FROM financial_records
      WHERE pending_item_id = ?
      ORDER BY occurred_at, created_at, id
    `).all(pendingItemId) as unknown as SqlRow[];
    const refundRecords = recordRows.map((recordRow) => ({
      id: asString(recordRow.id),
      kind: 'aftersales_refund' as const,
      amountCents: asNumber(recordRow.amount_cents),
      occurredAt: asString(recordRow.occurred_at),
      note: asString(recordRow.note),
      createdAt: asString(recordRow.created_at),
    }));
    const caseOccurredAt = asString((this.workspace.database.prepare(`
      SELECT occurred_at FROM aftersales_cases WHERE id = ?
    `).get(caseId) as SqlRow).occurred_at);
    const refundEventRows = this.workspace.database.prepare(`
      SELECT
        kind, requested_amount_cents, actual_amount_cents,
        reason, occurred_at, created_at
      FROM pending_financial_item_events
      WHERE pending_item_id = ?
      ORDER BY sequence
    `).all(pendingItemId) as unknown as SqlRow[];
    const reopeningRows = this.workspace.database.prepare(`
      SELECT
        'reopened' AS kind,
        reopen.requested_amount_cents,
        NULL AS actual_amount_cents,
        reopen.reason,
        reopen.occurred_at,
        reopen.created_at
      FROM aftersales_refund_reopening_events AS reopen
      WHERE reopen.pending_item_id = ?
      ORDER BY reopen.sequence
    `).all(pendingItemId) as unknown as SqlRow[];
    const adjustmentRows = this.workspace.database.prepare(`
      SELECT
        'target_adjusted' AS kind,
        adjust.after_amount_cents AS requested_amount_cents,
        adjust.before_amount_cents AS before_amount_cents,
        NULL AS actual_amount_cents,
        adjust.reason,
        adjust.occurred_at,
        adjust.created_at
      FROM aftersales_refund_target_adjustment_events AS adjust
      WHERE adjust.pending_item_id = ?
      ORDER BY adjust.sequence
    `).all(pendingItemId) as unknown as SqlRow[];
    const endingRows = this.workspace.database.prepare(`
      SELECT
        'ended' AS kind,
        ending.requested_amount_cents,
        NULL AS before_amount_cents,
        ending.refunded_amount_cents AS actual_amount_cents,
        ending.reason,
        ending.occurred_at,
        ending.created_at
      FROM aftersales_refund_ending_events AS ending
      WHERE ending.pending_item_id = ?
      ORDER BY ending.sequence
    `).all(pendingItemId) as unknown as SqlRow[];
    const timeline = [
      ...adjustmentRows.map((eventRow) => ({
        kind: 'target_adjusted' as const,
        requestedAmountCents: asNumber(eventRow.requested_amount_cents),
        beforeAmountCents: asNumber(eventRow.before_amount_cents),
        actualAmountCents: null,
        reason: asString(eventRow.reason),
        occurredAt: asString(eventRow.occurred_at),
        createdAt: asString(eventRow.created_at),
      })),
      ...endingRows.map((eventRow) => ({
        kind: 'ended' as const,
        requestedAmountCents: asNumber(eventRow.requested_amount_cents),
        beforeAmountCents: null,
        actualAmountCents: asNumber(eventRow.actual_amount_cents),
        reason: asString(eventRow.reason),
        occurredAt: asString(eventRow.occurred_at),
        createdAt: asString(eventRow.created_at),
      })),
      ...refundEventRows.map((eventRow) => ({
        kind: asString(eventRow.kind) as 'created' | 'confirmed' | 'cancelled',
        requestedAmountCents: asNumber(eventRow.requested_amount_cents),
        beforeAmountCents: null,
        actualAmountCents: eventRow.actual_amount_cents === null
          ? null
          : asNumber(eventRow.actual_amount_cents),
        reason: asString(eventRow.reason),
        occurredAt: asString(eventRow.occurred_at),
        createdAt: asString(eventRow.created_at),
      })),
      ...reopeningRows.map((eventRow) => ({
        kind: 'reopened' as const,
        requestedAmountCents: asNumber(eventRow.requested_amount_cents),
        beforeAmountCents: null,
        actualAmountCents: null,
        reason: asString(eventRow.reason),
        occurredAt: asString(eventRow.occurred_at),
        createdAt: asString(eventRow.created_at),
      })),
    ].sort((first, second) => {
      const occurredDifference = Date.parse(first.occurredAt) - Date.parse(second.occurredAt);
      return occurredDifference !== 0
        ? occurredDifference
        : first.createdAt.localeCompare(second.createdAt);
    });
    const latestEventAt = [
      ...timeline.map((event) => event.occurredAt),
      ...refundRecords.map((record) => record.occurredAt),
    ].reduce((latest, occurredAt) => (
      Date.parse(occurredAt) > Date.parse(latest) ? occurredAt : latest
    ), caseOccurredAt);
    return {
      pendingItemId,
      requestedAmountCents,
      status,
      refundRecords,
      fulfillment: projectAftersalesRefundFulfillment(requestedAmountCents, refundRecords),
      createdAt: asString(row.created_at),
      latestEventAt,
      timeline,
    };
  }

  private getReturns(caseId: string): AftersalesCase['returns'] {
    const rows = this.workspace.database.prepare(`
      SELECT DISTINCT records.*
      FROM aftersales_return_records AS records
      JOIN aftersales_return_record_items AS return_items
        ON return_items.return_record_id = records.id
      WHERE return_items.aftersales_case_id = ?
      ORDER BY records.created_at, records.id
    `).all(caseId) as unknown as SqlRow[];
    return rows.map((row) => {
      const returnRecordId = asString(row.id);
      const itemRows = this.workspace.database.prepare(`
        SELECT
          return_items.id,
          return_items.aftersales_case_id,
          return_items.shipment_package_item_id,
          return_items.quantity,
          return_items.received_quantity,
          return_items.accepted_quantity,
          return_items.inspection_result AS item_inspection_result,
          return_items.inspection_note AS item_inspection_note,
          shipment_items.order_id,
          shipment_items.source_order_item_id,
          shipment_items.order_number,
          shipment_items.source_title,
          shipment_items.source_spec
        FROM aftersales_return_record_items AS return_items
        JOIN shipment_package_items AS shipment_items
          ON shipment_items.id = return_items.shipment_package_item_id
        WHERE return_items.return_record_id = ?
        ORDER BY shipment_items.order_number, shipment_items.position, return_items.id
      `).all(returnRecordId) as unknown as SqlRow[];
      const eventRows = this.workspace.database.prepare(`
        SELECT *
        FROM aftersales_return_record_events
        WHERE return_record_id = ?
        ORDER BY result_revision
      `).all(returnRecordId) as unknown as SqlRow[];
      const timeline: AftersalesCase['returns'][number]['timeline'] = eventRows.map((eventRow) => {
        const kind = asString(eventRow.kind);
        const common = {
          occurredAt: asString(eventRow.occurred_at),
          createdAt: asString(eventRow.created_at),
        };
        if (kind === 'registered') return {
          kind,
          resultRevision: 1,
          ...common,
          reason: asString(eventRow.reason),
        };
        const baseRevision = asNumber(eventRow.base_revision);
        const resultRevision = asNumber(eventRow.result_revision);
        if (kind === 'items_combined') {
          const payload = parseJsonRecord(eventRow.payload_json, '数据库合装退货事件错误');
          return {
            kind,
            baseRevision,
            resultRevision,
            ...common,
            reason: asString(eventRow.reason),
            items: parseAftersalesItemInputs(payload.items, '数据库合装退货事件错误'),
          };
        }
        if (kind === 'logistics_corrected') {
          const payload = parseJsonRecord(eventRow.payload_json, '数据库退货物流更正事件错误');
          return {
            kind,
            baseRevision,
            resultRevision,
            ...common,
            reason: asString(eventRow.reason),
            before: parseLogisticsIdentity(payload.before),
            after: parseLogisticsIdentity(payload.after),
          };
        }
        if (kind === 'logistics_status_updated') {
          const payload = parseJsonRecord(eventRow.payload_json, '数据库退货物流状态事件错误');
          if (
            !isAftersalesReturnLogisticsStatus(payload.before)
            || !isAftersalesReturnLogisticsStatus(payload.after)
          ) {
            throw new Error('数据库退货物流状态事件错误');
          }
          return {
            kind,
            baseRevision,
            resultRevision,
            ...common,
            reason: asString(eventRow.reason),
            before: payload.before,
            after: payload.after,
          };
        }
        if (kind === 'received') {
          const payload = parseJsonRecord(eventRow.payload_json, '数据库退货收到事件错误');
          return {
            kind,
            baseRevision,
            resultRevision,
            ...common,
            reason: asString(eventRow.reason),
            ...(payload.items === undefined
              ? {}
              : { items: parseReceivedEventItems(payload.items) }),
            ...(payload.discrepancies === undefined
              ? {}
              : { discrepancies: parseReturnDiscrepancyArray(payload.discrepancies) }),
          };
        }
        if (kind !== 'inspected') throw new Error('数据库退货记录事件错误');
        const result = asReturnInspectionResult(eventRow.inspection_result);
        const payload = parseJsonRecord(eventRow.payload_json, '数据库退货检查事件错误');
        return {
          kind,
          baseRevision,
          resultRevision,
          ...common,
          result,
          note: asString(eventRow.reason),
          ...(payload.items === undefined
            ? {}
            : { items: parseInspectedEventItems(payload.items) }),
          ...(payload.discrepancies === undefined
            ? {}
            : { discrepancies: parseReturnDiscrepancyArray(payload.discrepancies) }),
        };
      });
      const status = asString(row.status);
      if (status !== 'in_transit' && status !== 'received' && status !== 'inspected') {
        throw new Error('数据库退货记录状态错误');
      }
      const inspectionResult = row.inspection_result === null
        ? null
        : asReturnInspectionResult(row.inspection_result);
      const logisticsStatus = asString(row.logistics_status);
      if (!isAftersalesReturnLogisticsStatus(logisticsStatus)) {
        throw new Error('数据库退货物流状态错误');
      }
      const logisticsExceptions = this.logisticsExceptionService().getExceptions({
        direction: 'return',
        packageId: returnRecordId,
      });
      return {
        id: returnRecordId,
        status,
        revision: asNumber(row.revision),
        logisticsStatus,
        carrierAcceptedAt: row.carrier_accepted_at === null
          ? null
          : asString(row.carrier_accepted_at),
        shippingCarrier: asString(row.shipping_carrier),
        trackingNumber: asString(row.tracking_number),
        occurredAt: asString(row.occurred_at),
        receivedAt: row.received_at === null ? null : asString(row.received_at),
        inspection: inspectionResult === null ? null : {
          result: inspectionResult,
          occurredAt: asString(row.inspected_at),
          note: asString(row.inspection_note),
        },
        items: itemRows.map((itemRow) => ({
          id: asString(itemRow.id),
          aftersalesCaseId: asString(itemRow.aftersales_case_id),
          shipmentPackageItemId: asString(itemRow.shipment_package_item_id),
          quantity: asNumber(itemRow.quantity),
          receivedQuantity: asNumber(itemRow.received_quantity),
          acceptedQuantity: asNumber(itemRow.accepted_quantity),
          inspectionResult: itemRow.item_inspection_result === null
            ? null
            : asReturnInspectionResult(itemRow.item_inspection_result),
          inspectionNote: itemRow.item_inspection_note === null
            ? null
            : asString(itemRow.item_inspection_note),
          orderId: asString(itemRow.order_id),
          orderItemId: asString(itemRow.source_order_item_id),
          orderNumber: asString(itemRow.order_number),
          sourceTitle: asString(itemRow.source_title),
          sourceSpec: asString(itemRow.source_spec),
        })),
        discrepancies: parseReturnDiscrepancies(row.discrepancies_json),
        currentException: [...logisticsExceptions].reverse().find(({ stage }) => (
          stage !== 'resolved'
        )) as AftersalesCase['returns'][number]['currentException'] ?? null,
        logisticsExceptions,
        carrierClaim: this.getCarrierClaim(returnRecordId),
        timeline,
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
    });
  }

  private getCarrierClaim(
    returnRecordId: string,
  ): AftersalesCase['returns'][number]['carrierClaim'] {
    return this.logisticsExceptionService().getClaim({
      direction: 'return',
      packageId: returnRecordId,
    });
  }

  private logisticsExceptionService(): LogisticsExceptionService {
    return new LogisticsExceptionService(this.workspace);
  }

  private aftersalesWorkflowTemplateService(): AftersalesWorkflowTemplateService {
    return new AftersalesWorkflowTemplateService(this.workspace);
  }

  private advanceCase(
    current: AftersalesCase,
    status: AftersalesCase['status'],
    changeReason: string,
    now: string,
  ): void {
    const before: AftersalesCaseSnapshot = {
      status: current.status,
      reason: current.reason,
      items: current.items.map(({ shipmentPackageItemId, quantity }) => ({
        shipmentPackageItemId,
        quantity,
      })),
    };
    const after: AftersalesCaseSnapshot = { ...before, status };
    const updated = this.workspace.database.prepare(`
      UPDATE aftersales_cases
      SET status = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(status, now, current.id, current.revision);
    if (updated.changes !== 1) {
      throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
    }
    this.workspace.database.prepare(`
      INSERT INTO aftersales_case_events (
        id, case_id, kind, base_revision, result_revision,
        before_snapshot_json, after_snapshot_json, change_reason, created_at
      ) VALUES (?, ?, 'updated', ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      current.id,
      current.revision,
      current.revision + 1,
      JSON.stringify(before),
      JSON.stringify(after),
      changeReason,
      now,
    );
  }

  private advanceHandlingDirection(input: {
    current: AftersalesCase;
    beforeDirection: AftersalesHandlingDirection;
    afterDirection: AftersalesHandlingDirection;
    occurredAt: string;
    reason: string;
    now: string;
    interceptionPackageId?: string | null;
  }): void {
    const nextStatus = statusForHandlingDirection(input.afterDirection);
    const before: AftersalesCaseSnapshot = {
      status: input.current.status,
      reason: input.current.reason,
      items: input.current.items.map(({ shipmentPackageItemId, quantity }) => ({
        shipmentPackageItemId,
        quantity,
      })),
    };
    const after: AftersalesCaseSnapshot = { ...before, status: nextStatus };
    const updated = this.workspace.database.prepare(`
      UPDATE aftersales_cases
      SET handling_direction = ?, status = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      input.afterDirection,
      nextStatus,
      input.now,
      input.current.id,
      input.current.revision,
    );
    if (updated.changes !== 1) {
      throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
    }
    this.workspace.database.prepare(`
      INSERT INTO aftersales_case_events (
        id, case_id, kind, base_revision, result_revision,
        before_snapshot_json, after_snapshot_json, change_reason, created_at
      ) VALUES (?, ?, 'updated', ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.current.id,
      input.current.revision,
      input.current.revision + 1,
      JSON.stringify(before),
      JSON.stringify(after),
      input.reason,
      input.now,
    );
    this.workspace.database.prepare(`
      INSERT INTO aftersales_handling_direction_events (
        id, case_id, kind, before_direction, after_direction,
        occurred_at, reason, created_at
      ) VALUES (?, ?, 'changed', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.current.id,
      input.beforeDirection,
      input.afterDirection,
      input.occurredAt,
      input.reason,
      input.now,
    );
    if (input.afterDirection === 'intercept') {
      this.requestInterception(
        input.current,
        input.interceptionPackageId,
        input.occurredAt,
        input.reason,
        input.now,
      );
    }
  }

  private requestInterception(
    current: AftersalesCase,
    packageId: string | null | undefined,
    occurredAt: string,
    reason: string,
    now: string,
  ): void {
    if (!packageId) throw new Error('请明确选择本次拦截的包裹');
    const existingBinding = this.workspace.database.prepare(`
      SELECT shipment_package_id
      FROM aftersales_interception_packages
      WHERE case_id = ?
    `).get(current.id) as SqlRow | undefined;
    if (existingBinding && asString(existingBinding.shipment_package_id) !== packageId) {
      throw new Error('已存在其他包裹的拦截事项，请另建售后处理单');
    }
    if (!existingBinding) {
      this.workspace.database.prepare(`
        INSERT INTO aftersales_interception_packages (
          case_id, shipment_package_id, created_at
        ) VALUES (?, ?, ?)
      `).run(current.id, packageId, now);
    }
    this.workspace.database.prepare(`
      INSERT INTO aftersales_interception_events (
        id, case_id, kind, occurred_at, reason, created_at
      ) VALUES (?, ?, 'requested', ?, ?, ?)
    `).run(randomUUID(), current.id, occurredAt, reason, now);
  }

  private outboundExceptionAffectedItems(
    _current: AftersalesCase,
    exception: AftersalesOutboundExceptionEvidence,
  ): AftersalesCaseItemInput[] {
    return exception.affectedItems.map((item) => ({
      shipmentPackageItemId: item.shipmentPackageItemId,
      quantity: item.quantity,
    }));
  }

  private replacementRoundsForException(
    current: AftersalesCase,
    exceptionId: string,
  ): AftersalesProcessingRound[] {
    const rows = this.workspace.database.prepare(`
      SELECT round_id
      FROM aftersales_outbound_exception_replacement_rounds
      WHERE exception_id = ?
      ORDER BY created_at, round_id
    `).all(exceptionId) as SqlRow[];
    const roundIds = new Set(rows.map((row) => asString(row.round_id)));
    return current.rounds.filter(({ id }) => roundIds.has(id));
  }

  private hasCurrentReplacementRoundForException(
    current: AftersalesCase,
    exceptionId: string,
  ): boolean {
    return this.replacementRoundsForException(current, exceptionId).some((round) => (
      round.replacementShipment === null
      || round.replacementShipment.packages.some(({ status }) => status === 'active')
    ));
  }

  private createOutboundExceptionReplacementRound(
    current: AftersalesCase,
    exception: AftersalesOutboundExceptionEvidence,
    affectedItems: readonly AftersalesCaseItemInput[],
    occurredAt: string,
    reason: string,
    now: string,
  ): void {
    const alreadyRequiredBySourceItem = this.requiredReplacementQuantityBySourceItem(current);
    const sourceQuantityByItem = new Map<string, number>();
    for (const item of current.items) {
      sourceQuantityByItem.set(item.shipmentPackageItemId, item.quantity);
    }
    for (const sourceRound of current.rounds) {
      for (const shipmentPackage of sourceRound.replacementShipment?.packages ?? []) {
        for (const item of shipmentPackage.items) {
          sourceQuantityByItem.set(item.id, item.quantity);
        }
      }
    }
    if (affectedItems.some((item) => (
      (alreadyRequiredBySourceItem.get(item.shipmentPackageItemId) ?? 0) + item.quantity
        > (sourceQuantityByItem.get(item.shipmentPackageItemId) ?? 0)
    ))) {
      throw new Error('同一来源商品数量已被其他未完成异常补发占用');
    }
    const roundId = this.createDirectReplacementRound(
      current,
      exception.sourceShipmentRecordId,
      affectedItems,
      occurredAt,
      reason,
      now,
    );
    this.workspace.database.prepare(`
      INSERT INTO aftersales_outbound_exception_replacement_rounds (
        exception_id, case_id, round_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(exception.exceptionId, current.id, roundId, now);
  }

  private requiredReplacementQuantityBySourceItem(
    current: AftersalesCase,
  ): Map<string, number> {
    const required = new Map<string, number>();
    for (const round of current.rounds.filter(({ replacementRequired }) => replacementRequired)) {
      if (!round.replacementShipment) {
        for (const item of round.items) {
          required.set(
            item.sourceShipmentPackageItemId,
            (required.get(item.sourceShipmentPackageItemId) ?? 0) + item.quantity,
          );
        }
        continue;
      }
      const rows = this.workspace.database.prepare(`
        SELECT round_items.source_shipment_package_item_id,
               SUM(replacement_items.quantity) AS quantity
        FROM aftersales_replacement_items AS replacement_items
        JOIN aftersales_processing_round_items AS round_items
          ON round_items.id = replacement_items.round_item_id
        JOIN shipment_package_items AS shipment_items
          ON shipment_items.id = replacement_items.shipment_package_item_id
        JOIN shipment_packages AS packages ON packages.id = shipment_items.package_id
        LEFT JOIN shipment_package_cancellation_events AS cancellations
          ON cancellations.package_id = packages.id
        WHERE replacement_items.replacement_shipment_id = (
          SELECT id FROM aftersales_replacement_shipments WHERE round_id = ?
        )
          AND cancellations.id IS NULL
        GROUP BY round_items.source_shipment_package_item_id
      `).all(round.id) as Array<{
        source_shipment_package_item_id: string;
        quantity: number;
      }>;
      for (const row of rows) {
        required.set(
          row.source_shipment_package_item_id,
          (required.get(row.source_shipment_package_item_id) ?? 0) + row.quantity,
        );
      }
    }
    return required;
  }

  private createDirectReplacementRound(
    current: AftersalesCase,
    sourceShipmentRecordId: string,
    affectedItems: readonly AftersalesCaseItemInput[],
    occurredAt: string,
    reason: string,
    now: string,
  ): string {
    return this.createReplacementRound(
      current,
      'direct_replacement',
      sourceShipmentRecordId,
      affectedItems,
      occurredAt,
      reason,
      now,
    );
  }

  private createReplacementRound(
    current: AftersalesCase,
    workflow: 'exchange' | 'direct_replacement',
    sourceShipmentRecordId: string,
    affectedItems: readonly AftersalesCaseItemInput[],
    occurredAt: string,
    reason: string,
    now: string,
  ): string {
    const nextRoundNumber = (current.rounds.at(-1)?.roundNumber ?? 0) + 1;
    const roundId = randomUUID();
    this.workspace.database.prepare(`
      INSERT INTO aftersales_processing_rounds (
        id, case_id, round_number, workflow, source_shipment_record_id,
        occurred_at, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      roundId, current.id, nextRoundNumber, workflow, sourceShipmentRecordId,
      occurredAt, reason, now,
    );
    const insertItem = this.workspace.database.prepare(`
      INSERT INTO aftersales_processing_round_items (
        id, round_id, source_shipment_package_item_id, quantity
      ) VALUES (?, ?, ?, ?)
    `);
    for (const item of affectedItems) {
      insertItem.run(randomUUID(), roundId, item.shipmentPackageItemId, item.quantity);
    }
    return roundId;
  }

  private hasReusableSceneRound(
    current: AftersalesCase,
    workflow: 'exchange' | 'direct_replacement',
  ): boolean {
    return current.rounds.some((round) => {
      if (round.workflow !== workflow || round.replacementShipment !== null) return false;
      const mappedException = this.workspace.database.prepare(`
        SELECT 1
        FROM aftersales_outbound_exception_replacement_rounds
        WHERE round_id = ?
        LIMIT 1
      `).get(round.id);
      return mappedException === undefined;
    });
  }

  private cancelPendingRefund(
    current: AftersalesCase,
    reason: string,
    occurredAt: string,
    now: string,
  ): void {
    const refund = current.refund;
    if (!refund || refund.status !== 'pending' || refund.refundRecords.length > 0) return;
    const cancelled = this.workspace.database.prepare(`
      UPDATE pending_financial_items
      SET status = 'cancelled', resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, refund.pendingItemId);
    if (cancelled.changes !== 1) throw new Error('退款申请已在其他操作中处理');
    this.workspace.database.prepare(`
      INSERT INTO pending_financial_item_events (
        id, pending_item_id, kind, requested_amount_cents,
        actual_amount_cents, reason, occurred_at, created_at
      ) VALUES (?, ?, 'cancelled', ?, NULL, ?, ?, ?)
    `).run(
      randomUUID(), refund.pendingItemId, refund.requestedAmountCents,
      reason, occurredAt, now,
    );
  }

  private createPendingRefund(
    caseId: string,
    requestedAmountCents: number,
    reason: string,
    occurredAt: string,
    now: string,
  ): void {
    const existing = this.workspace.database.prepare(`
      SELECT id, requested_amount_cents, status
      FROM pending_financial_items
      WHERE aftersales_case_id = ?
    `).get(caseId) as SqlRow | undefined;
    if (existing) {
      if (asString(existing.status) !== 'cancelled') {
        throw new Error('当前售后已有未取消的退款事项');
      }
      const reopened = this.workspace.database.prepare(`
        UPDATE pending_financial_items
        SET requested_amount_cents = ?, status = 'pending', resolved_at = NULL
        WHERE id = ? AND status = 'cancelled'
      `).run(requestedAmountCents, asString(existing.id));
      if (reopened.changes !== 1) throw new Error('退款申请已在其他操作中变更');
      this.workspace.database.prepare(`
        INSERT INTO aftersales_refund_reopening_events (
          id, pending_item_id, previous_requested_amount_cents,
          requested_amount_cents, reason, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), asString(existing.id), asNumber(existing.requested_amount_cents),
        requestedAmountCents, reason, occurredAt, now,
      );
      return;
    }
    const pendingItemId = randomUUID();
    this.workspace.database.prepare(`
      INSERT INTO pending_financial_items (
        id, kind, aftersales_case_id, requested_amount_cents,
        status, created_at, resolved_at
      ) VALUES (?, 'aftersales_refund', ?, ?, 'pending', ?, NULL)
    `).run(pendingItemId, caseId, requestedAmountCents, now);
    this.workspace.database.prepare(`
      INSERT INTO pending_financial_item_events (
        id, pending_item_id, kind, requested_amount_cents,
        actual_amount_cents, reason, occurred_at, created_at
      ) VALUES (?, ?, 'created', ?, NULL, ?, ?, ?)
    `).run(randomUUID(), pendingItemId, requestedAmountCents, reason, occurredAt, now);
  }

  private allRequiredReplacementRoundsDelivered(current: AftersalesCase): boolean {
    const requiredRounds = current.rounds.filter(({ replacementRequired }) => replacementRequired);
    return requiredRounds.every(replacementRoundDelivered);
  }

  private replacementDeliveryPending(current: AftersalesCase): boolean {
    return current.rounds.some(({ replacementRequired }) => replacementRequired)
      && !this.allRequiredReplacementRoundsDelivered(current);
  }

  private confirmPendingRefund(input: {
    pendingItemId: string;
    requestedAmountCents: number;
    refundedAmountCents: number;
    reason: string;
    occurredAt: string;
    now: string;
  }): void {
    const resolved = this.workspace.database.prepare(`
      UPDATE pending_financial_items
      SET status = 'confirmed', resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(input.now, input.pendingItemId);
    if (resolved.changes !== 1) throw new Error('退款申请已在其他操作中处理');
    this.workspace.database.prepare(`
      INSERT INTO pending_financial_item_events (
        id, pending_item_id, kind, requested_amount_cents,
        actual_amount_cents, reason, occurred_at, created_at
      ) VALUES (?, ?, 'confirmed', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.pendingItemId,
      input.requestedAmountCents,
      input.refundedAmountCents,
      input.reason,
      input.occurredAt,
      input.now,
    );
  }

  private advanceCasesForReturnRecord(
    returnRecordId: string,
    current: AftersalesCase,
    statusForCase: (linkedCase: AftersalesCase) => AftersalesCase['status'],
    changeReason: string,
    now: string,
  ): void {
    const rows = this.workspace.database.prepare(`
      SELECT DISTINCT aftersales_case_id
      FROM aftersales_return_record_items
      WHERE return_record_id = ?
      ORDER BY aftersales_case_id
    `).all(returnRecordId) as unknown as SqlRow[];
    for (const row of rows) {
      const caseId = asString(row.aftersales_case_id);
      const linkedCase = caseId === current.id ? current : this.get(caseId);
      this.advanceCase(linkedCase, statusForCase(linkedCase), changeReason, now);
    }
  }
}

function initialHandlingDirection(input: {
  workflow: AftersalesCase['workflow'];
  requested: AftersalesHandlingDirection | undefined;
  physicalControl: AftersalesPhysicalControl;
  availableDirections: readonly AftersalesHandlingDirection[];
}): AftersalesHandlingDirection | null {
  if (input.workflow === 'general') {
    if (input.requested !== undefined) throw new Error('一般处理不能选择专用售后处理方向');
    return null;
  }
  if (input.workflow === 'refund_only') {
    if (input.requested !== undefined) throw new Error('仅退款处理不能选择退货退款处理方向');
    return null;
  }
  if (input.workflow === 'exchange') {
    if (input.requested !== undefined && input.requested !== 'buyer_return') {
      throw new Error('换货处理必须先由买家退回商品');
    }
    if (!input.availableDirections.includes('buyer_return')) {
      throw new Error('当前实物控制关系不允许建立换货处理');
    }
    return 'buyer_return';
  }
  if (input.workflow === 'direct_replacement') {
    if (input.requested !== undefined && input.requested !== 'replacement') {
      throw new Error('直接补发处理方向无效');
    }
    if (!input.availableDirections.includes('replacement')) {
      throw new Error('当前实物控制关系不允许直接补发');
    }
    return 'replacement';
  }
  const requested = input.requested;
  if (!requested) {
    throw new Error('请根据当前实物控制关系明确选择售后处理方向');
  }
  if (!input.availableDirections.includes(requested)) {
    throw new Error('当前实物流转证据不允许该售后处理方向');
  }
  return requested;
}

function replacementRoundTodo(
  round: AftersalesProcessingRound,
  returns: readonly AftersalesReturnRecord[],
): string {
  if (round.workflow === 'legacy') return '继续当前售后处理';
  if (round.workflow === 'exchange' && returns.length === 0) return '等待买家退回';
  if (round.workflow === 'exchange' && returns.some(({ status }) => status === 'in_transit')) {
    return '等待并确认收到本轮退回商品';
  }
  if (round.workflow === 'exchange' && returns.some(({ status }) => status === 'received')) {
    return '检查本轮退回商品';
  }
  if (!round.replacementShipment) return `安排第 ${round.roundNumber} 轮补发`;
  const activePackages = round.replacementShipment.packages.filter(({ status }) => status === 'active');
  if (activePackages.length > 0 && activePackages.every(({ logisticsStatus }) => (
    logisticsStatus === 'delivered'
  ))) {
    return '确认本轮补发签收并完成售后，或登记新的处理轮次';
  }
  return `跟进第 ${round.roundNumber} 轮补发运输`;
}

function replacementRoundDelivered(round: AftersalesProcessingRound): boolean {
  const activePackages = round.replacementShipment?.packages.filter(({ status }) => (
    status === 'active'
  )) ?? [];
  return activePackages.length > 0 && activePackages.every(({ logisticsStatus }) => (
    logisticsStatus === 'delivered'
  ));
}

function sameAftersalesItemAllocation(
  roundItems: readonly AftersalesProcessingRound['items'][number][],
  items: readonly AftersalesCaseItemInput[],
): boolean {
  if (roundItems.length !== items.length) return false;
  const quantities = new Map(items.map((item) => (
    [item.shipmentPackageItemId, item.quantity] as const
  )));
  return roundItems.every((item) => (
    quantities.get(item.sourceShipmentPackageItemId) === item.quantity
  ));
}

function sourcePackageEvidence(
  inputs: readonly AftersalesCaseItemInput[],
  sourceItems: ReadonlyMap<string, SqlRow>,
): AftersalesSourcePackageEvidence[] {
  const packages = new Map<string, AftersalesSourcePackageEvidence>();
  for (const input of inputs) {
    const row = sourceItems.get(input.shipmentPackageItemId);
    if (!row) throw new Error('发货快照商品不存在');
    const packageId = asString(row.source_package_id);
    const logisticsStatus = asString(row.source_logistics_status);
    if (!isOutboundLogisticsStatus(logisticsStatus)) {
      throw new Error('数据库原正向包裹物流状态错误');
    }
    const sourcePackage = packages.get(packageId) ?? {
      packageId,
      shippingCarrier: asString(row.source_shipping_carrier),
      trackingNumber: asString(row.source_tracking_number),
      logisticsStatus,
      confirmedLost: false,
      items: [],
    };
    const confirmedLostQuantity = Math.min(
      input.quantity,
      asNumber(row.source_confirmed_lost_quantity),
    );
    sourcePackage.items.push({
      shipmentPackageItemId: input.shipmentPackageItemId,
      sourceTitle: asString(row.source_title),
      sourceSpec: asString(row.source_spec),
      quantity: input.quantity,
      confirmedLostQuantity,
    });
    sourcePackage.confirmedLost = sourcePackage.items.every((item) => (
      item.confirmedLostQuantity === item.quantity
    ));
    packages.set(packageId, sourcePackage);
  }
  return [...packages.values()];
}

function asString(value: string | number | null | undefined): string {
  if (typeof value !== 'string') throw new Error('数据库文本字段格式错误');
  return value;
}

function asNullableString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return asString(value);
}

function asNumber(value: string | number | null | undefined): number {
  if (typeof value !== 'number') throw new Error('数据库数字字段格式错误');
  return value;
}

function asAftersalesStatus(
  value: string | number | null | undefined,
): AftersalesCase['status'] {
  if (isAftersalesStatus(value)) return value;
  throw new Error('数据库售后状态错误');
}

function asAftersalesWorkflow(
  value: string | number | null | undefined,
): AftersalesCase['workflow'] {
  if (isAftersalesWorkflow(value)) return value;
  throw new Error('数据库售后处理方式错误');
}

function asNullableHandlingDirection(
  value: string | number | null | undefined,
): AftersalesHandlingDirection | null {
  if (value === null || value === undefined) return null;
  if (isAftersalesHandlingDirection(value)) return value;
  throw new Error('数据库售后处理方向错误');
}

function asReturnInspectionResult(
  value: string | number | null | undefined,
): NonNullable<AftersalesCase['returns'][number]['inspection']>['result'] {
  if (value === 'resellable' || value === 'defective' || value === 'scrapped' || value === 'other') {
    return value;
  }
  throw new Error('数据库退货检查结果错误');
}

function assertOccurredAtNotBefore(
  occurredAt: string,
  previousOccurredAt: string,
  message: string,
): void {
  if (Date.parse(occurredAt) < Date.parse(previousOccurredAt)) throw new Error(message);
}

function parseSnapshot(serialized: string): AftersalesCaseSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error('数据库售后处理单快照格式错误', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('数据库售后处理单快照格式错误');
  }
  const snapshot = value as Record<string, unknown>;
  if (
    !isAftersalesStatus(snapshot.status) ||
    typeof snapshot.reason !== 'string' ||
    !snapshot.reason.trim() ||
    !Array.isArray(snapshot.items)
  ) {
    throw new Error('数据库售后处理单快照格式错误');
  }
  const items = snapshot.items.map((item): AftersalesCaseItemInput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('数据库售后处理单快照格式错误');
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.shipmentPackageItemId !== 'string' ||
      !record.shipmentPackageItemId ||
      !Number.isSafeInteger(record.quantity) ||
      Number(record.quantity) <= 0
    ) {
      throw new Error('数据库售后处理单快照格式错误');
    }
    return {
      shipmentPackageItemId: record.shipmentPackageItemId,
      quantity: Number(record.quantity),
    };
  });
  if (
    items.length === 0 ||
    new Set(items.map(({ shipmentPackageItemId }) => shipmentPackageItemId)).size !== items.length
  ) {
    throw new Error('数据库售后处理单快照格式错误');
  }
  return { status: snapshot.status, reason: snapshot.reason, items };
}

function sameSnapshot(left: AftersalesCaseSnapshot, right: AftersalesCaseSnapshot): boolean {
  if (left.status !== right.status || left.reason !== right.reason) return false;
  const normalized = (items: readonly AftersalesCaseItemInput[]) => [...items]
    .sort((first, second) => (
      first.shipmentPackageItemId.localeCompare(second.shipmentPackageItemId)
    ));
  return JSON.stringify(normalized(left.items)) === JSON.stringify(normalized(right.items));
}

function assertReturnItemIds(
  expectedIds: readonly string[],
  actualIds: readonly string[],
  message: string,
): void {
  if (
    expectedIds.length !== actualIds.length
    || expectedIds.some((id) => !actualIds.includes(id))
    || new Set(actualIds).size !== actualIds.length
  ) {
    throw new Error(message);
  }
}

function parseJsonRecord(
  value: string | number | null | undefined,
  message: string,
): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error(message);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(message);
  return parsed as Record<string, unknown>;
}

function parseLogisticsIdentity(value: unknown): {
  shippingCarrier: string;
  trackingNumber: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('数据库退货物流更正事件错误');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.shippingCarrier !== 'string' || typeof record.trackingNumber !== 'string') {
    throw new Error('数据库退货物流更正事件错误');
  }
  return {
    shippingCarrier: record.shippingCarrier,
    trackingNumber: record.trackingNumber,
  };
}

function parseAftersalesItemInputs(value: unknown, message: string): AftersalesCaseItemInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(message);
  return value.map((item): AftersalesCaseItemInput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(message);
    const record = item as Record<string, unknown>;
    if (
      typeof record.shipmentPackageItemId !== 'string'
      || !Number.isSafeInteger(record.quantity)
      || Number(record.quantity) <= 0
    ) {
      throw new Error(message);
    }
    return {
      shipmentPackageItemId: record.shipmentPackageItemId,
      quantity: Number(record.quantity),
    };
  });
}

function parseReturnDiscrepancies(
  value: string | number | null | undefined,
): AftersalesReturnDiscrepancy[] {
  if (typeof value !== 'string') throw new Error('数据库退货检查差异错误');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('数据库退货检查差异错误', { cause: error });
  }
  return parseReturnDiscrepancyArray(parsed);
}

function parseReturnDiscrepancyArray(value: unknown): AftersalesReturnDiscrepancy[] {
  if (!Array.isArray(value)) throw new Error('数据库退货检查差异错误');
  return value.map((value): AftersalesReturnDiscrepancy => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('数据库退货检查差异错误');
    }
    const record = value as Record<string, unknown>;
    if (
      !isReturnDiscrepancyKind(record.kind)
      || !Number.isSafeInteger(record.quantity)
      || Number(record.quantity) < 0
      || typeof record.note !== 'string'
      || (record.returnRecordItemId !== undefined
        && typeof record.returnRecordItemId !== 'string')
    ) {
      throw new Error('数据库退货检查差异错误');
    }
    return {
      kind: record.kind,
      quantity: Number(record.quantity),
      note: record.note,
      ...(record.returnRecordItemId === undefined
        ? {}
        : { returnRecordItemId: record.returnRecordItemId }),
    };
  });
}

function assertDiscrepancyItemIds(
  returnRecordItemIds: readonly string[],
  discrepancies: readonly AftersalesReturnDiscrepancy[],
): void {
  const validIds = new Set(returnRecordItemIds);
  if (discrepancies.some(({ returnRecordItemId }) => (
    returnRecordItemId !== undefined && !validIds.has(returnRecordItemId)
  ))) {
    throw new Error('退货检查差异关联了不属于当前包裹的商品');
  }
}

function parseReceivedEventItems(
  value: unknown,
): NonNullable<Extract<AftersalesCase['returns'][number]['timeline'][number], {
  kind: 'received';
}>['items']> {
  if (!Array.isArray(value)) throw new Error('数据库退货收到事件错误');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('数据库退货收到事件错误');
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.returnRecordItemId !== 'string'
      || !Number.isSafeInteger(record.receivedQuantity)
      || Number(record.receivedQuantity) < 0
    ) {
      throw new Error('数据库退货收到事件错误');
    }
    return {
      returnRecordItemId: record.returnRecordItemId,
      receivedQuantity: Number(record.receivedQuantity),
    };
  });
}

function parseInspectedEventItems(
  value: unknown,
): NonNullable<Extract<AftersalesCase['returns'][number]['timeline'][number], {
  kind: 'inspected';
}>['items']> {
  if (!Array.isArray(value)) throw new Error('数据库退货检查事件错误');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('数据库退货检查事件错误');
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.returnRecordItemId !== 'string'
      || !Number.isSafeInteger(record.acceptedQuantity)
      || Number(record.acceptedQuantity) < 0
      || !isReturnInspectionResultValue(record.result)
      || typeof record.note !== 'string'
    ) {
      throw new Error('数据库退货检查事件错误');
    }
    return {
      returnRecordItemId: record.returnRecordItemId,
      acceptedQuantity: Number(record.acceptedQuantity),
      result: record.result,
      note: record.note,
    };
  });
}

function isReturnInspectionResultValue(
  value: unknown,
): value is NonNullable<AftersalesCase['returns'][number]['items'][number]['inspectionResult']> {
  return value === 'resellable' || value === 'defective' || value === 'scrapped' || value === 'other';
}

function isReturnDiscrepancyKind(
  value: unknown,
): value is AftersalesReturnDiscrepancy['kind'] {
  return value === 'missing' || value === 'empty_package' || value === 'wrong_item'
    || value === 'excess' || value === 'mixed' || value === 'damaged'
    || value === 'missing_accessory' || value === 'unidentified';
}

function latestReturnDecisionEvidenceAt(returns: AftersalesCase['returns']): string | null {
  const occurredAt = returns.flatMap((returnRecord) => {
    if (returnRecord.inspection) return [returnRecord.inspection.occurredAt];
    const loss = [...returnRecord.logisticsExceptions]
      .reverse()
      .find((exception) => (
        exception.exceptionType === 'lost'
        && (exception.stage === 'confirmed' || exception.stage === 'recovered')
      ));
    if (loss) return [loss.occurredAt];
    const claimOpened = returnRecord.carrierClaim?.timeline.find(({ kind }) => kind === 'opened');
    return claimOpened ? [claimOpened.occurredAt] : [returnRecord.occurredAt];
  });
  if (occurredAt.length === 0) return null;
  return occurredAt.reduce((latest, candidate) => (
    Date.parse(candidate) > Date.parse(latest) ? candidate : latest
  ));
}

function hasUnresolvedConfirmedLoss(
  returnRecord: AftersalesCase['returns'][number],
): boolean {
  return returnRecord.logisticsExceptions.some((exception) => (
    exception.exceptionType === 'lost' && exception.stage === 'confirmed'
  ));
}

function assertReceivedQuantitiesOutsideConfirmedLoss(
  returnRecord: AftersalesCase['returns'][number],
  receivedItems: readonly { returnRecordItemId: string; receivedQuantity: number }[],
): void {
  const planned = new Map(returnRecord.items.map((item) => [item.id, item.quantity]));
  const lostQuantities = new Map<string, number>();
  for (const exception of returnRecord.logisticsExceptions) {
    if (exception.exceptionType !== 'lost' || exception.stage !== 'confirmed') continue;
    if (exception.impact.scope === 'package') {
      for (const item of returnRecord.items) lostQuantities.set(item.id, item.quantity);
      continue;
    }
    for (const affected of exception.impact.items) {
      lostQuantities.set(
        affected.sourceItemId,
        Math.min(
          planned.get(affected.sourceItemId) ?? 0,
          (lostQuantities.get(affected.sourceItemId) ?? 0) + affected.quantity,
        ),
      );
    }
  }
  const maximumReceivableQuantity = returnRecord.items.reduce((total, item) => (
    total + item.quantity - (lostQuantities.get(item.id) ?? 0)
  ), 0);
  if (maximumReceivableQuantity === 0) {
    throw new Error('退货已确认丢失，不能登记实际收到或检查');
  }
  for (const received of receivedItems) {
    const maximumReceivable = (planned.get(received.returnRecordItemId) ?? 0)
      - (lostQuantities.get(received.returnRecordItemId) ?? 0);
    if (received.receivedQuantity > maximumReceivable) {
      throw new Error('退货已确认丢失，不能登记实际收到或检查');
    }
  }
}

function hasUnresolvedReceiptDispute(
  returnRecord: AftersalesCase['returns'][number],
): boolean {
  return returnRecord.logisticsExceptions.some((exception) => (
    (exception.exceptionType === 'delivery_dispute'
      || exception.exceptionType === 'misdelivered')
    && exception.stage !== 'recovered'
    && exception.stage !== 'resolved'
  ));
}

function resolveInterceptionPackageId(
  requestedPackageId: string | undefined,
  eligiblePackageIds: readonly string[],
): string {
  const uniquePackageIds = [...new Set(eligiblePackageIds)];
  if (requestedPackageId) {
    if (!uniquePackageIds.includes(requestedPackageId)) {
      throw new Error('拦截包裹不属于当前售后商品');
    }
    return requestedPackageId;
  }
  if (uniquePackageIds.length !== 1) {
    throw new Error('多包裹售后请明确选择本次拦截的包裹');
  }
  return uniquePackageIds[0];
}

function parseOutboundAffectedItems(
  value: string,
): AftersalesOutboundExceptionEvidence['affectedItems'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('数据库正向异常影响商品无效');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('数据库正向异常影响商品无效');
  }
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('数据库正向异常影响商品无效');
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.shipmentPackageItemId !== 'string'
      || typeof item.sourceTitle !== 'string'
      || typeof item.sourceSpec !== 'string'
      || !Number.isSafeInteger(item.quantity)
      || Number(item.quantity) < 1) {
      throw new Error('数据库正向异常影响商品无效');
    }
    return {
      shipmentPackageItemId: item.shipmentPackageItemId,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      quantity: Number(item.quantity),
    };
  });
}

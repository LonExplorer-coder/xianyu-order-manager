import { randomUUID } from 'node:crypto';

import {
  isAftersalesStatus,
  isAftersalesWorkflow,
  normalizeAftersalesCaseQuery,
  normalizeCreateAftersalesCaseInput,
  normalizeProgressAftersalesCaseInput,
  normalizeUpdateAftersalesCaseInput,
  type AftersalesCase,
  type AftersalesCaseEvent,
  type AftersalesCaseItem,
  type AftersalesCaseItemInput,
  type AftersalesCaseSnapshot,
} from '../core/aftersales-cases';
import { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

export class AftersalesApplicationService {
  public constructor(private readonly workspace: Workspace) {}

  public create(input: unknown): AftersalesCase {
    const prepared = normalizeCreateAftersalesCaseInput(input);
    const sourceItems = this.resolveSourceItems(prepared.shipmentRecordId, prepared.items);
    this.assertQuantitiesAvailable(prepared.items, sourceItems);
    const caseId = randomUUID();
    const initialStatus = prepared.workflow === 'general'
      ? 'processing'
      : prepared.workflow === 'return_refund'
        ? 'waiting_return'
        : 'waiting_refund';
    const now = new Date().toISOString();
    const snapshot: AftersalesCaseSnapshot = {
      status: initialStatus,
      reason: prepared.reason,
      items: prepared.items,
    };
    this.workspace.transaction(() => {
      this.workspace.database.prepare(`
        INSERT INTO aftersales_cases (
          id, shipment_record_id, workflow, status, revision, reason,
          occurred_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        caseId,
        prepared.shipmentRecordId,
        prepared.workflow,
        initialStatus,
        prepared.reason,
        prepared.occurredAt,
        now,
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
      if (prepared.workflow !== 'general') {
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
            actual_amount_cents, reason, created_at
          ) VALUES (?, ?, 'created', ?, NULL, ?, ?)
        `).run(randomUUID(), pendingItemId, requestedAmountCents, prepared.reason, now);
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
    if (current.workflow === 'general') {
      throw new Error('一般售后请使用状态更新功能');
    }
    if (current.revision !== prepared.expectedRevision) {
      throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
    }
    const continuesCancelledReturn = current.status === 'cancelled' && (
      prepared.kind === 'receive_return' || prepared.kind === 'inspect_return'
    );
    if (current.status === 'completed' || (current.status === 'cancelled' && !continuesCancelledReturn)) {
      throw new Error('已经结束的售后处理单不能继续推进');
    }
    const now = new Date().toISOString();
    if (prepared.kind === 'register_return') {
      if (
        current.workflow !== 'return_refund' ||
        current.status !== 'waiting_return' ||
        current.returns.length > 0
      ) {
        throw new Error('当前售后尚不能登记退货物流');
      }
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        current.occurredAt,
        '退货寄出时间不能早于售后发生时间',
      );
      const returnRecordId = randomUUID();
      this.workspace.transaction(() => {
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_records (
            id, aftersales_case_id, status, revision,
            shipping_carrier, tracking_number, occurred_at,
            received_at, inspection_result, inspection_note, inspected_at,
            created_at, updated_at
          ) VALUES (
            ?, ?, 'in_transit', 1, ?, ?, ?,
            NULL, NULL, NULL, NULL, ?, ?
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
            id, return_record_id, shipment_package_item_id, quantity
          ) VALUES (?, ?, ?, ?)
        `);
        for (const item of current.items) {
          insertItem.run(
            randomUUID(),
            returnRecordId,
            item.shipmentPackageItemId,
            item.quantity,
          );
        }
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
    if (prepared.kind === 'receive_return') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      if (
        current.workflow !== 'return_refund' ||
        (current.status !== 'waiting_return' && current.status !== 'cancelled') ||
        returnRecord?.status !== 'in_transit'
      ) {
        throw new Error('当前退货记录尚不能确认收到');
      }
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        returnRecord.occurredAt,
        '退货收到时间不能早于寄出时间',
      );
      this.workspace.transaction(() => {
        const updated = this.workspace.database.prepare(`
          UPDATE aftersales_return_records
          SET status = 'received', revision = revision + 1,
              received_at = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'in_transit'
        `).run(
          prepared.occurredAt,
          now,
          returnRecord.id,
          returnRecord.revision,
        );
        if (updated.changes !== 1) throw new Error('退货记录已在其他操作中更新');
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_record_events (
            id, return_record_id, kind, base_revision, result_revision,
            occurred_at, reason, inspection_result, created_at
          ) VALUES (?, ?, 'received', ?, ?, ?, ?, NULL, ?)
        `).run(
          randomUUID(),
          returnRecord.id,
          returnRecord.revision,
          returnRecord.revision + 1,
          prepared.occurredAt,
          prepared.reason,
          now,
        );
        this.advanceCase(
          current,
          current.status === 'cancelled' ? 'cancelled' : 'waiting_inspection',
          prepared.reason,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'inspect_return') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      if (
        current.workflow !== 'return_refund' ||
        (current.status !== 'waiting_inspection' && current.status !== 'cancelled') ||
        returnRecord?.status !== 'received'
      ) {
        throw new Error('当前退货记录尚不能登记检查结果');
      }
      if (!returnRecord.receivedAt) throw new Error('退货记录缺少实际收到时间');
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        returnRecord.receivedAt,
        '退货检查时间不能早于收到时间',
      );
      this.workspace.transaction(() => {
        const updated = this.workspace.database.prepare(`
          UPDATE aftersales_return_records
          SET status = 'inspected', revision = revision + 1,
              inspection_result = ?, inspection_note = ?, inspected_at = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'received'
        `).run(
          prepared.result,
          prepared.note,
          prepared.occurredAt,
          now,
          returnRecord.id,
          returnRecord.revision,
        );
        if (updated.changes !== 1) throw new Error('退货记录已在其他操作中更新');
        this.workspace.database.prepare(`
          INSERT INTO aftersales_return_record_events (
            id, return_record_id, kind, base_revision, result_revision,
            occurred_at, reason, inspection_result, created_at
          ) VALUES (?, ?, 'inspected', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          returnRecord.id,
          returnRecord.revision,
          returnRecord.revision + 1,
          prepared.occurredAt,
          prepared.note,
          prepared.result,
          now,
        );
        this.advanceCase(
          current,
          current.status === 'cancelled' ? 'cancelled' : 'waiting_refund',
          prepared.note,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'confirm_refund') {
      const refund = current.refund;
      if (
        current.workflow === 'return_refund' &&
        (current.returns.length !== 1 || current.returns[0].status !== 'inspected')
      ) {
        throw new Error('请先完成退货检查');
      }
      if (current.status !== 'waiting_refund' || refund?.status !== 'pending') {
        throw new Error('当前售后尚不能确认实际退款');
      }
      const earliestRefundAt = current.workflow === 'return_refund'
        ? current.returns[0].inspection?.occurredAt
        : current.occurredAt;
      if (!earliestRefundAt) throw new Error('退货记录缺少检查时间');
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        earliestRefundAt,
        current.workflow === 'return_refund'
          ? '实际退款时间不能早于退货检查时间'
          : '实际退款时间不能早于售后发生时间',
      );
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
        const resolved = this.workspace.database.prepare(`
          UPDATE pending_financial_items
          SET status = 'confirmed', resolved_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, refund.pendingItemId);
        if (resolved.changes !== 1) throw new Error('退款申请已在其他操作中处理');
        this.workspace.database.prepare(`
          INSERT INTO pending_financial_item_events (
            id, pending_item_id, kind, requested_amount_cents,
            actual_amount_cents, reason, created_at
          ) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)
        `).run(
          randomUUID(),
          refund.pendingItemId,
          refund.requestedAmountCents,
          prepared.actualRefundCents,
          prepared.note,
          now,
        );
        this.advanceCase(
          current,
          'ready_to_complete',
          `确认实际退款：${prepared.note}`,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'cancel') {
      const refund = current.refund;
      if (!refund || refund.status !== 'pending') {
        throw new Error('已经确认实际退款的售后不能取消');
      }
      this.workspace.transaction(() => {
        const cancelled = this.workspace.database.prepare(`
          UPDATE pending_financial_items
          SET status = 'cancelled', resolved_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, refund.pendingItemId);
        if (cancelled.changes !== 1) throw new Error('退款申请已在其他操作中处理');
        this.workspace.database.prepare(`
          INSERT INTO pending_financial_item_events (
            id, pending_item_id, kind, requested_amount_cents,
            actual_amount_cents, reason, created_at
          ) VALUES (?, ?, 'cancelled', ?, NULL, ?, ?)
        `).run(
          randomUUID(),
          refund.pendingItemId,
          refund.requestedAmountCents,
          prepared.reason,
          now,
        );
        this.advanceCase(current, 'cancelled', prepared.reason, now);
      });
      return this.get(current.id);
    }
    if (current.status !== 'ready_to_complete' || current.refund?.status !== 'confirmed') {
      throw new Error('请先完成退款与必要的退货处理');
    }
    this.workspace.transaction(() => {
      this.advanceCase(current, 'completed', prepared.reason, now);
    });
    return this.get(current.id);
  }

  public assertPackagesCanBeCancelled(packageIds: readonly string[]): void {
    const aftersalesEvidence = this.workspace.database.prepare(`
      SELECT cases.id
      FROM shipment_package_items AS shipment_items
      JOIN aftersales_case_items AS case_items
        ON case_items.shipment_package_item_id = shipment_items.id
      JOIN aftersales_cases AS cases ON cases.id = case_items.case_id
      WHERE shipment_items.package_id = ?
      LIMIT 1
    `);
    if (packageIds.some((packageId) => aftersalesEvidence.get(packageId))) {
      throw new Error('包裹已经产生售后处理证据，不能按未交寄撤销');
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
    return {
      id: asString(row.id),
      shipmentRecordId: asString(row.shipment_record_id),
      workflow: asAftersalesWorkflow(row.workflow),
      status: asAftersalesStatus(row.status),
      revision: asNumber(row.revision),
      reason: asString(row.reason),
      occurredAt,
      items,
      refund: this.getRefund(caseId),
      returns: this.getReturns(caseId),
      timeline,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
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
    if (status !== 'pending' && status !== 'confirmed' && status !== 'cancelled') {
      throw new Error('数据库待确认资金事项状态错误');
    }
    const actualRow = this.workspace.database.prepare(`
      SELECT *
      FROM financial_records
      WHERE pending_item_id = ?
    `).get(asString(row.id)) as SqlRow | undefined;
    return {
      pendingItemId: asString(row.id),
      requestedAmountCents: asNumber(row.requested_amount_cents),
      status,
      actualRecord: actualRow ? {
        id: asString(actualRow.id),
        kind: 'aftersales_refund',
        amountCents: asNumber(actualRow.amount_cents),
        occurredAt: asString(actualRow.occurred_at),
        note: asString(actualRow.note),
        createdAt: asString(actualRow.created_at),
      } : null,
      createdAt: asString(row.created_at),
    };
  }

  private getReturns(caseId: string): AftersalesCase['returns'] {
    const rows = this.workspace.database.prepare(`
      SELECT *
      FROM aftersales_return_records
      WHERE aftersales_case_id = ?
      ORDER BY created_at, id
    `).all(caseId) as unknown as SqlRow[];
    return rows.map((row) => {
      const returnRecordId = asString(row.id);
      const itemRows = this.workspace.database.prepare(`
        SELECT
          return_items.id,
          return_items.shipment_package_item_id,
          return_items.quantity,
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
        if (kind === 'received') return {
          kind,
          baseRevision,
          resultRevision,
          ...common,
          reason: asString(eventRow.reason),
        };
        if (kind !== 'inspected') throw new Error('数据库退货记录事件错误');
        const result = asReturnInspectionResult(eventRow.inspection_result);
        return {
          kind,
          baseRevision,
          resultRevision,
          ...common,
          result,
          note: asString(eventRow.reason),
        };
      });
      const status = asString(row.status);
      if (status !== 'in_transit' && status !== 'received' && status !== 'inspected') {
        throw new Error('数据库退货记录状态错误');
      }
      const inspectionResult = row.inspection_result === null
        ? null
        : asReturnInspectionResult(row.inspection_result);
      return {
        id: returnRecordId,
        status,
        revision: asNumber(row.revision),
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
          shipmentPackageItemId: asString(itemRow.shipment_package_item_id),
          quantity: asNumber(itemRow.quantity),
          orderId: asString(itemRow.order_id),
          orderItemId: asString(itemRow.source_order_item_id),
          orderNumber: asString(itemRow.order_number),
          sourceTitle: asString(itemRow.source_title),
          sourceSpec: asString(itemRow.source_spec),
        })),
        timeline,
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
    });
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
}

function asString(value: string | number | null | undefined): string {
  if (typeof value !== 'string') throw new Error('数据库文本字段格式错误');
  return value;
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

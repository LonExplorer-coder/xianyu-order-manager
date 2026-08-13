import { randomUUID } from 'node:crypto';

import {
  isAftersalesReturnLogisticsStatus,
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
  type AftersalesReturnDiscrepancy,
} from '../core/aftersales-cases';
import {
  prepareLogisticsCorrection,
  prepareLogisticsStatusChange,
  sameLogisticsExceptionImpact,
  type LogisticsExceptionImpact,
} from '../core/logistics-exceptions';
import { LogisticsExceptionService } from './logistics-exception-service';
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
    const continuesClosedReturn = prepared.kind === 'receive_return'
      || prepared.kind === 'inspect_return'
      || prepared.kind === 'correct_return_logistics'
      || prepared.kind === 'update_return_logistics_status'
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
      const existingPackageRow = this.workspace.database.prepare(`
        SELECT
          records.id, records.status, records.revision, records.occurred_at,
          records.logistics_status,
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
        if (asString(existingPackageRow.logistics_status) === 'lost') {
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
          for (const item of current.items) {
            insertItem.run(
              randomUUID(),
              returnRecordId,
              current.id,
              item.shipmentPackageItemId,
              item.quantity,
            );
          }
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
              items: current.items.map(({ shipmentPackageItemId, quantity }) => ({
                shipmentPackageItemId,
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
        for (const item of current.items) {
          insertItem.run(
            randomUUID(),
            returnRecordId,
            current.id,
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
        carrierConfirmedLoss: prepared.carrierConfirmedLoss ?? false,
        occurredAt: prepared.occurredAt,
        latestOccurredAt: returnRecord.timeline.at(-1)?.occurredAt
          ?? returnRecord.occurredAt,
        impact: prepared.impact ?? { scope: 'package' },
        availableItems: returnRecord.items.map((item) => ({
          sourceItemId: item.id,
          quantity: item.quantity,
        })),
      });
      if (
        prepared.logisticsStatus === returnRecord.logisticsStatus
        && statusChange.carrierAcceptedAt === returnRecord.carrierAcceptedAt
        && sameLogisticsExceptionImpact(
          [...returnRecord.timeline].reverse().find((event) => (
            event.kind === 'logistics_status_updated'
          ))?.impact ?? { scope: 'package' },
          statusChange.impact,
        )
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
            impact: statusChange.impact,
          }),
          now,
        );
        this.advanceCasesForReturnRecord(
          returnRecord.id,
          current,
          (linkedCase) => {
            if (
              prepared.logisticsStatus === 'lost'
              && linkedCase.workflow === 'return_refund'
              && linkedCase.refund?.status === 'pending'
              && linkedCase.status !== 'completed'
              && linkedCase.status !== 'cancelled'
            ) {
              return 'waiting_refund';
            }
            if (
              returnRecord.logisticsStatus === 'lost'
              && prepared.logisticsStatus !== 'lost'
              && returnRecord.status === 'in_transit'
              && linkedCase.workflow === 'return_refund'
              && linkedCase.refund?.status === 'pending'
              && linkedCase.status === 'waiting_refund'
            ) {
              return 'waiting_return';
            }
            return linkedCase.status;
          },
          prepared.reason,
          now,
        );
      });
      return this.get(current.id);
    }
    if (prepared.kind === 'receive_return') {
      const returnRecord = current.returns.find(({ id }) => id === prepared.returnRecordId);
      if (
        current.workflow !== 'return_refund' ||
        (current.status !== 'waiting_return'
          && current.status !== 'ready_to_complete'
          && current.status !== 'cancelled'
          && current.status !== 'completed') ||
        returnRecord?.status !== 'in_transit'
      ) {
        throw new Error('当前退货记录尚不能确认收到');
      }
      if (returnRecord.logisticsStatus === 'lost') {
        throw new Error('请先把已找回包裹的退货物流状态更新为实际状态');
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
      if (
        current.workflow !== 'return_refund' ||
        (current.status !== 'waiting_inspection'
          && current.status !== 'ready_to_complete'
          && current.status !== 'cancelled'
          && current.status !== 'completed') ||
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
      this.logisticsExceptionService().openClaim({
        subject: { direction: 'return', packageId: returnRecord.id },
        currentStatus: returnRecord.logisticsStatus,
        latestOccurredAt: returnRecord.timeline.at(-1)?.occurredAt
          ?? returnRecord.occurredAt,
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
      const returnDecisionSupported = current.returns.length > 0
        && current.returns.every((returnRecord) => (
          returnRecord.status === 'inspected'
          || returnRecord.logisticsStatus === 'lost'
          || returnRecord.carrierClaim !== null
      ));
      if (
        current.workflow === 'return_refund' &&
        !returnDecisionSupported
      ) {
        throw new Error('请先完成退货检查、确认丢件或建立承运索赔');
      }
      const refundStatusReady = current.status === 'waiting_refund'
        || (current.workflow === 'return_refund'
          && (current.status === 'waiting_return' || current.status === 'waiting_inspection')
          && returnDecisionSupported);
      if (!refundStatusReady || refund?.status !== 'pending') {
        throw new Error('当前售后尚不能确认实际退款');
      }
      const earliestRefundAt = current.workflow === 'return_refund'
        ? latestReturnDecisionEvidenceAt(current.returns)
        : current.occurredAt;
      if (!earliestRefundAt) throw new Error('退货记录缺少检查、丢件或索赔时间');
      assertOccurredAtNotBefore(
        prepared.occurredAt,
        earliestRefundAt,
        current.workflow === 'return_refund'
          ? current.returns.some(({ logisticsStatus }) => logisticsStatus === 'lost')
            ? '实际退款时间不能早于退货丢件确认时间'
            : current.returns.some(({ carrierClaim }) => carrierClaim !== null)
              ? '实际退款时间不能早于承运索赔建立时间'
              : '实际退款时间不能早于退货检查时间'
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
            impact: parseStoredLogisticsImpact(payload.impact),
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

function parseStoredLogisticsImpact(value: unknown): LogisticsExceptionImpact {
  if (value === undefined) return { scope: 'package' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('数据库退货物流异常影响范围错误');
  }
  const record = value as Record<string, unknown>;
  if (record.scope === 'package') return { scope: 'package' };
  if (record.scope !== 'items' || !Array.isArray(record.items)) {
    throw new Error('数据库退货物流异常影响范围错误');
  }
  return {
    scope: 'items',
    items: record.items.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('数据库退货物流异常商品错误');
      }
      const item = value as Record<string, unknown>;
      if (
        typeof item.sourceItemId !== 'string'
        || !Number.isSafeInteger(item.quantity)
        || Number(item.quantity) <= 0
      ) {
        throw new Error('数据库退货物流异常商品错误');
      }
      return { sourceItemId: item.sourceItemId, quantity: Number(item.quantity) };
    }),
  };
}

function latestReturnDecisionEvidenceAt(returns: AftersalesCase['returns']): string | null {
  const occurredAt = returns.flatMap((returnRecord) => {
    if (returnRecord.inspection) return [returnRecord.inspection.occurredAt];
    const loss = [...returnRecord.timeline]
      .reverse()
      .find((event) => event.kind === 'logistics_status_updated' && event.after === 'lost');
    if (loss) return [loss.occurredAt];
    const claimOpened = returnRecord.carrierClaim?.timeline.find(({ kind }) => kind === 'opened');
    return claimOpened ? [claimOpened.occurredAt] : [];
  });
  if (occurredAt.length === 0) return null;
  return occurredAt.reduce((latest, candidate) => (
    Date.parse(candidate) > Date.parse(latest) ? candidate : latest
  ));
}

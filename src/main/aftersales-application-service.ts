import { randomUUID } from 'node:crypto';

import {
  isAftersalesStatus,
  normalizeAftersalesCaseQuery,
  normalizeCreateAftersalesCaseInput,
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
    const now = new Date().toISOString();
    const snapshot: AftersalesCaseSnapshot = {
      status: 'processing',
      reason: prepared.reason,
      items: prepared.items,
    };
    this.workspace.transaction(() => {
      this.workspace.database.prepare(`
        INSERT INTO aftersales_cases (
          id, shipment_record_id, status, revision, reason,
          occurred_at, created_at, updated_at
        ) VALUES (?, ?, 'processing', 1, ?, ?, ?, ?)
      `).run(
        caseId,
        prepared.shipmentRecordId,
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
    if (current.status === 'completed') {
      throw new Error('已完成的售后处理单不能重新打开，请为新的独立问题另行建立处理单');
    }
    if (current.revision !== prepared.expectedRevision) {
      throw new Error('售后处理单已在其他操作中更新，请刷新后重试');
    }
    const sourceItems = this.resolveSourceItems(current.shipmentRecordId, prepared.items);
    this.assertQuantitiesAvailable(
      prepared.items,
      sourceItems,
      current.id,
      prepared.status !== 'completed',
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
          AND cases.status <> 'completed'
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
        if (resultRevision !== 1 || snapshot.status !== 'processing') {
          throw new Error('数据库售后处理单建立事件无效');
        }
        return {
          kind: 'created',
          resultRevision: 1,
          status: 'processing',
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
      status: asAftersalesStatus(row.status),
      revision: asNumber(row.revision),
      reason: asString(row.reason),
      occurredAt,
      items,
      timeline,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
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

import type { DatabaseSync } from 'node:sqlite';

import {
  isAftersalesStatus,
  type AftersalesReturnStatus,
  type AftersalesStatus,
} from '../core/aftersales-cases';
import {
  aftersalesTodoForCases,
  shipmentTodoForStatuses,
  type OrderOperationsAftersalesCase,
  type OrderOperationsPackage,
  type OrderOperationsProjection,
  type OrderOperationsShipmentRecord,
} from '../core/order-operations-projection';
import {
  isShipmentLogisticsStatus,
  type ShipmentLogisticsStatus,
} from '../core/shipment-records';

type SqlRow = Record<string, string | number | null>;

type ProjectedAftersalesCase = {
  value: OrderOperationsAftersalesCase;
  returnStatuses: AftersalesReturnStatus[];
};

export class OrderOperationsProjectionService {
  public constructor(private readonly database: DatabaseSync) {}

  public get(orderId: string): OrderOperationsProjection {
    return this.getMany([orderId]).get(orderId) ?? emptyProjection();
  }

  public getMany(orderIds: readonly string[]): ReadonlyMap<string, OrderOperationsProjection> {
    const uniqueOrderIds = [...new Set(orderIds)];
    if (uniqueOrderIds.length === 0) return new Map();
    const shipmentRecordsByOrder = this.shipmentRecords(uniqueOrderIds);
    const aftersalesCasesByOrder = this.aftersalesCases(uniqueOrderIds);
    return new Map(uniqueOrderIds.map((orderId) => {
      const shipmentRecords = shipmentRecordsByOrder.get(orderId) ?? [];
      const aftersalesCases = aftersalesCasesByOrder.get(orderId) ?? [];
      return [orderId, buildProjection(shipmentRecords, aftersalesCases)] as const;
    }));
  }

  private shipmentRecords(
    orderIds: readonly string[],
  ): ReadonlyMap<string, OrderOperationsShipmentRecord[]> {
    const rows = this.database.prepare(`
      SELECT
        items.order_id,
        records.id AS record_id,
        records.shipment_group_archive_id AS archive_id,
        records.created_at AS record_created_at,
        voids.id AS void_event_id,
        packages.id AS package_id,
        packages.position AS package_position,
        packages.shipping_carrier,
        packages.tracking_number,
        packages.logistics_status,
        cancellations.id AS cancellation_event_id,
        cancellations.reason AS cancellation_reason,
        items.id AS shipment_package_item_id,
        items.source_order_item_id,
        items.source_title,
        items.source_spec,
        items.quantity,
        items.position AS item_position
      FROM shipment_package_items AS items
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      JOIN shipment_records AS records ON records.id = packages.shipment_record_id
      LEFT JOIN shipment_record_void_events AS voids
        ON voids.shipment_record_id = records.id
      LEFT JOIN shipment_package_cancellation_events AS cancellations
        ON cancellations.package_id = packages.id
      WHERE items.order_id IN (SELECT value FROM json_each(?))
      ORDER BY
        items.order_id,
        records.created_at DESC,
        records.id DESC,
        packages.position,
        packages.id,
        items.position,
        items.id
    `).all(JSON.stringify(orderIds)) as unknown as SqlRow[];
    const result = new Map<string, OrderOperationsShipmentRecord[]>();
    const recordsByOrder = new Map<string, Map<string, OrderOperationsShipmentRecord>>();
    const packagesByOrder = new Map<string, Map<string, OrderOperationsPackage>>();
    for (const row of rows) {
      const orderId = asString(row.order_id);
      const records = recordsByOrder.get(orderId) ?? new Map();
      const packages = packagesByOrder.get(orderId) ?? new Map();
      recordsByOrder.set(orderId, records);
      packagesByOrder.set(orderId, packages);
      const recordId = asString(row.record_id);
      let record = records.get(recordId);
      if (!record) {
        record = {
          id: recordId,
          archiveId: asString(row.archive_id),
          status: row.void_event_id === null ? 'active' : 'voided',
          createdAt: asString(row.record_created_at),
          packages: [],
        };
        records.set(recordId, record);
      }
      const packageId = asString(row.package_id);
      let shipmentPackage = packages.get(packageId);
      if (!shipmentPackage) {
        shipmentPackage = {
          id: packageId,
          position: asNumber(row.package_position),
          status: row.cancellation_event_id === null ? 'active' : 'cancelled',
          logisticsStatus: asShipmentLogisticsStatus(row.logistics_status),
          shippingCarrier: asString(row.shipping_carrier),
          trackingNumber: asString(row.tracking_number),
          cancellationReason: row.cancellation_reason === null
            ? null
            : asString(row.cancellation_reason),
          items: [],
        };
        packages.set(packageId, shipmentPackage);
        record.packages.push(shipmentPackage);
      }
      shipmentPackage.items.push({
        shipmentPackageItemId: asString(row.shipment_package_item_id),
        orderItemId: asString(row.source_order_item_id),
        sourceTitle: asString(row.source_title),
        sourceSpec: asString(row.source_spec),
        quantity: asNumber(row.quantity),
      });
    }
    for (const [orderId, records] of recordsByOrder) result.set(orderId, [...records.values()]);
    return result;
  }

  private aftersalesCases(
    orderIds: readonly string[],
  ): ReadonlyMap<string, ProjectedAftersalesCase[]> {
    const rows = this.database.prepare(`
      SELECT
        shipment_items.order_id,
        cases.id AS case_id,
        cases.shipment_record_id,
        cases.status,
        cases.reason,
        cases.occurred_at,
        cases.created_at,
        (
          SELECT json_group_array(return_records.status)
          FROM aftersales_return_records AS return_records
          WHERE return_records.aftersales_case_id = cases.id
        ) AS return_statuses_json,
        case_items.quantity,
        shipment_items.id AS shipment_package_item_id,
        shipment_items.package_id,
        shipment_items.source_order_item_id,
        shipment_items.source_title,
        shipment_items.source_spec,
        shipment_items.position AS item_position
      FROM aftersales_case_items AS case_items
      JOIN aftersales_cases AS cases ON cases.id = case_items.case_id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      ORDER BY
        shipment_items.order_id,
        cases.occurred_at DESC,
        cases.created_at DESC,
        cases.id DESC,
        shipment_items.position,
        shipment_items.id
    `).all(JSON.stringify(orderIds)) as unknown as SqlRow[];
    const result = new Map<string, ProjectedAftersalesCase[]>();
    const casesByOrder = new Map<string, Map<string, ProjectedAftersalesCase>>();
    for (const row of rows) {
      const orderId = asString(row.order_id);
      const cases = casesByOrder.get(orderId) ?? new Map();
      casesByOrder.set(orderId, cases);
      const caseId = asString(row.case_id);
      let projectedCase = cases.get(caseId);
      if (!projectedCase) {
        const status = asAftersalesStatus(row.status);
        const returnStatuses = parseReturnStatuses(row.return_statuses_json);
        projectedCase = {
          value: {
            id: caseId,
            shipmentRecordId: asString(row.shipment_record_id),
            status,
            reason: asString(row.reason),
            occurredAt: asString(row.occurred_at),
            currentTodo: aftersalesTodoForCases([{ status, returnStatuses }])
              ?? '无需售后操作',
            items: [],
          },
          returnStatuses,
        };
        cases.set(caseId, projectedCase);
      }
      projectedCase.value.items.push({
        shipmentPackageItemId: asString(row.shipment_package_item_id),
        packageId: asString(row.package_id),
        orderItemId: asString(row.source_order_item_id),
        sourceTitle: asString(row.source_title),
        sourceSpec: asString(row.source_spec),
        quantity: asNumber(row.quantity),
      });
    }
    for (const [orderId, cases] of casesByOrder) result.set(orderId, [...cases.values()]);
    return result;
  }
}

function buildProjection(
  shipmentRecords: OrderOperationsShipmentRecord[],
  projectedAftersalesCases: ProjectedAftersalesCase[],
): OrderOperationsProjection {
  const aftersalesCases = projectedAftersalesCases.map(({ value }) => value);
  const aftersalesTodo = aftersalesTodoForCases(projectedAftersalesCases.map((projectedCase) => ({
    status: projectedCase.value.status,
    returnStatuses: projectedCase.returnStatuses,
  })));
  const logisticsStatuses = new Set<ShipmentLogisticsStatus>();
  for (const record of shipmentRecords) {
    if (record.status === 'voided') continue;
    for (const shipmentPackage of record.packages) {
      if (shipmentPackage.status === 'active') {
        logisticsStatuses.add(shipmentPackage.logisticsStatus);
      }
    }
  }
  return {
    shipmentRecords,
    aftersalesCases,
    currentTodo: aftersalesTodo ?? shipmentTodoForStatuses(logisticsStatuses),
  };
}

function emptyProjection(): OrderOperationsProjection {
  return buildProjection([], []);
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('数据库订单运营投影文本格式错误');
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('数据库订单运营投影数字格式错误');
  }
  return value;
}

function asShipmentLogisticsStatus(value: unknown): ShipmentLogisticsStatus {
  if (!isShipmentLogisticsStatus(value)) throw new Error('数据库包裹物流状态格式错误');
  return value;
}

function asAftersalesStatus(value: unknown): AftersalesStatus {
  if (!isAftersalesStatus(value)) throw new Error('数据库售后状态格式错误');
  return value;
}

function parseReturnStatuses(value: unknown): AftersalesReturnStatus[] {
  if (typeof value !== 'string') throw new Error('数据库退货状态投影格式错误');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('数据库退货状态投影格式错误', { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((status) => (
    status === 'in_transit' || status === 'received' || status === 'inspected'
  ))) {
    throw new Error('数据库退货状态投影格式错误');
  }
  return parsed;
}

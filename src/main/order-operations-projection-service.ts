import type { DatabaseSync } from 'node:sqlite';

import { isAftersalesStatus, type AftersalesStatus } from '../core/aftersales-cases';
import {
  aftersalesTodoForStatuses,
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

export class OrderOperationsProjectionService {
  public constructor(private readonly database: DatabaseSync) {}

  public get(orderId: string): OrderOperationsProjection {
    const shipmentRecords = this.shipmentRecords(orderId);
    const aftersalesCases = this.aftersalesCases(orderId);
    const aftersalesTodo = aftersalesTodoForStatuses(new Set(
      aftersalesCases
        .filter(({ status }) => status !== 'completed')
        .map(({ status }) => status),
    ));
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

  private shipmentRecords(orderId: string): OrderOperationsShipmentRecord[] {
    const rows = this.database.prepare(`
      SELECT
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
      WHERE items.order_id = ?
      ORDER BY
        records.created_at DESC,
        records.id DESC,
        packages.position,
        packages.id,
        items.position,
        items.id
    `).all(orderId) as unknown as SqlRow[];
    const records = new Map<string, OrderOperationsShipmentRecord>();
    const packages = new Map<string, OrderOperationsPackage>();
    for (const row of rows) {
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
    return [...records.values()];
  }

  private aftersalesCases(orderId: string): OrderOperationsAftersalesCase[] {
    const rows = this.database.prepare(`
      SELECT
        cases.id AS case_id,
        cases.shipment_record_id,
        cases.status,
        cases.reason,
        cases.occurred_at,
        cases.created_at,
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
      WHERE shipment_items.order_id = ?
      ORDER BY
        cases.occurred_at DESC,
        cases.created_at DESC,
        cases.id DESC,
        shipment_items.position,
        shipment_items.id
    `).all(orderId) as unknown as SqlRow[];
    const cases = new Map<string, OrderOperationsAftersalesCase>();
    for (const row of rows) {
      const caseId = asString(row.case_id);
      let aftersalesCase = cases.get(caseId);
      if (!aftersalesCase) {
        const status = asAftersalesStatus(row.status);
        aftersalesCase = {
          id: caseId,
          shipmentRecordId: asString(row.shipment_record_id),
          status,
          reason: asString(row.reason),
          occurredAt: asString(row.occurred_at),
          currentTodo: status === 'completed'
            ? '无需售后操作'
            : aftersalesTodoForStatuses(new Set([status])) ?? '无需售后操作',
          items: [],
        };
        cases.set(caseId, aftersalesCase);
      }
      aftersalesCase.items.push({
        shipmentPackageItemId: asString(row.shipment_package_item_id),
        packageId: asString(row.package_id),
        orderItemId: asString(row.source_order_item_id),
        sourceTitle: asString(row.source_title),
        sourceSpec: asString(row.source_spec),
        quantity: asNumber(row.quantity),
      });
    }
    return [...cases.values()];
  }
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

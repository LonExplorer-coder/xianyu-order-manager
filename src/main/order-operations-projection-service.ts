import type { DatabaseSync } from 'node:sqlite';

import {
  isAftersalesReturnLogisticsStatus,
  isAftersalesStatus,
  type AftersalesReturnDiscrepancy,
  type AftersalesReturnLogisticsStatus,
  type AftersalesReturnStatus,
  type AftersalesStatus,
  type CarrierClaimStatus,
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
import { supportsCarrierClaim } from '../core/logistics-exceptions';

type SqlRow = Record<string, string | number | null>;

type ProjectedAftersalesCase = {
  value: OrderOperationsAftersalesCase;
  returnStatuses: AftersalesReturnStatus[];
  returnLogisticsStatuses: AftersalesReturnLogisticsStatus[];
  carrierClaimStatuses: CarrierClaimStatus[];
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
        (
          SELECT events.payload_json
          FROM shipment_package_logistics_status_events AS events
          WHERE events.package_id = packages.id
          ORDER BY events.result_revision DESC
          LIMIT 1
        ) AS latest_status_payload_json,
        (
          SELECT events.reason
          FROM shipment_package_logistics_status_events AS events
          WHERE events.package_id = packages.id
          ORDER BY events.result_revision DESC
          LIMIT 1
        ) AS latest_status_reason,
        (
          SELECT events.occurred_at
          FROM shipment_package_logistics_status_events AS events
          WHERE events.package_id = packages.id
          ORDER BY events.result_revision DESC
          LIMIT 1
        ) AS latest_status_occurred_at,
        claims.status AS outbound_carrier_claim_status,
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
      LEFT JOIN carrier_claims AS claims
        ON claims.direction = 'outbound' AND claims.shipment_package_id = packages.id
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
    const packageExceptionPayloads = new Map<string, {
      status: ShipmentLogisticsStatus;
      payload: Record<string, unknown>;
      reason: string;
      occurredAt: string;
    }>();
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
        const logisticsStatus = asShipmentLogisticsStatus(row.logistics_status);
        shipmentPackage = {
          id: packageId,
          position: asNumber(row.package_position),
          status: row.cancellation_event_id === null ? 'active' : 'cancelled',
          logisticsStatus,
          shippingCarrier: asString(row.shipping_carrier),
          trackingNumber: asString(row.tracking_number),
          cancellationReason: row.cancellation_reason === null
            ? null
            : asString(row.cancellation_reason),
          currentException: null,
          carrierClaimStatus: parseOptionalCarrierClaimStatus(
            row.outbound_carrier_claim_status,
          ),
          items: [],
        };
        if (
          row.latest_status_payload_json !== null
          && row.latest_status_reason !== null
          && row.latest_status_occurred_at !== null
        ) {
          packageExceptionPayloads.set(`${orderId}\u0000${packageId}`, {
            status: logisticsStatus,
            payload: parseJsonRecord(row.latest_status_payload_json),
            reason: asString(row.latest_status_reason),
            occurredAt: asString(row.latest_status_occurred_at),
          });
        }
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
    for (const [orderId, packages] of packagesByOrder) {
      for (const [packageId, shipmentPackage] of packages) {
        const facts = packageExceptionPayloads.get(`${orderId}\u0000${packageId}`);
        if (!facts || !supportsCarrierClaim(facts.status)) continue;
        const impact = parseProjectedLogisticsImpact(facts.payload.impact);
        const itemIds = new Set(shipmentPackage.items.map(({ shipmentPackageItemId }) => (
          shipmentPackageItemId
        )));
        const affectedQuantity = impact.scope === 'package'
          ? shipmentPackage.items.reduce((total, item) => total + item.quantity, 0)
          : impact.items
            .filter((item) => itemIds.has(item.sourceItemId))
            .reduce((total, item) => total + item.quantity, 0);
        if (affectedQuantity === 0) continue;
        shipmentPackage.currentException = {
          direction: 'outbound',
          logisticsStatus: facts.status,
          affectedQuantity,
          reason: facts.reason,
          occurredAt: facts.occurredAt,
        };
      }
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
          SELECT json_group_array(DISTINCT return_records.status)
          FROM aftersales_return_records AS return_records
          JOIN aftersales_return_record_items AS return_items
            ON return_items.return_record_id = return_records.id
          WHERE return_items.aftersales_case_id = cases.id
        ) AS return_statuses_json,
        (
          SELECT json_group_array(DISTINCT return_records.logistics_status)
          FROM aftersales_return_records AS return_records
          JOIN aftersales_return_record_items AS return_items
            ON return_items.return_record_id = return_records.id
          WHERE return_items.aftersales_case_id = cases.id
        ) AS return_logistics_statuses_json,
        (
          SELECT json_group_array(DISTINCT claims.status)
          FROM carrier_claims AS claims
          JOIN aftersales_return_records AS return_records
            ON return_records.id = claims.return_record_id
          JOIN aftersales_return_record_items AS return_items
            ON return_items.return_record_id = return_records.id
          WHERE return_items.aftersales_case_id = cases.id
        ) AS carrier_claim_statuses_json,
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
        const returnLogisticsStatuses = parseReturnLogisticsStatuses(
          row.return_logistics_statuses_json,
        );
        const carrierClaimStatuses = parseCarrierClaimStatuses(row.carrier_claim_statuses_json);
        projectedCase = {
          value: {
            id: caseId,
            shipmentRecordId: asString(row.shipment_record_id),
            status,
            reason: asString(row.reason),
            occurredAt: asString(row.occurred_at),
            currentTodo: aftersalesTodoForCases([{
              status,
              returnStatuses,
              returnLogisticsStatuses,
              carrierClaimStatuses,
            }])
              ?? '无需售后操作',
            items: [],
            returnPackages: [],
          },
          returnStatuses,
          returnLogisticsStatuses,
          carrierClaimStatuses,
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
    const returnRows = this.database.prepare(`
      SELECT
        shipment_items.order_id,
        return_items.aftersales_case_id AS case_id,
        return_records.id AS return_record_id,
        return_records.status AS return_status,
        return_records.shipping_carrier,
        return_records.tracking_number,
        return_records.logistics_status,
        return_records.discrepancies_json,
        (
          SELECT events.payload_json
          FROM aftersales_return_record_events AS events
          WHERE events.return_record_id = return_records.id
            AND events.kind = 'logistics_status_updated'
          ORDER BY events.result_revision DESC
          LIMIT 1
        ) AS latest_status_payload_json,
        (
          SELECT events.reason
          FROM aftersales_return_record_events AS events
          WHERE events.return_record_id = return_records.id
            AND events.kind = 'logistics_status_updated'
          ORDER BY events.result_revision DESC
          LIMIT 1
        ) AS latest_status_reason,
        (
          SELECT events.occurred_at
          FROM aftersales_return_record_events AS events
          WHERE events.return_record_id = return_records.id
            AND events.kind = 'logistics_status_updated'
          ORDER BY events.result_revision DESC
          LIMIT 1
        ) AS latest_status_occurred_at,
        claims.status AS carrier_claim_status,
        return_items.quantity AS planned_quantity,
        return_items.received_quantity,
        return_items.accepted_quantity,
        return_items.id AS return_record_item_id,
        shipment_items.id AS shipment_package_item_id,
        shipment_items.source_title,
        shipment_items.source_spec,
        shipment_items.position AS item_position
      FROM aftersales_return_record_items AS return_items
      JOIN aftersales_return_records AS return_records
        ON return_records.id = return_items.return_record_id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = return_items.shipment_package_item_id
      LEFT JOIN carrier_claims AS claims
        ON claims.return_record_id = return_records.id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      ORDER BY
        shipment_items.order_id,
        return_items.aftersales_case_id,
        return_records.created_at,
        return_records.id,
        shipment_items.position,
        shipment_items.id
    `).all(JSON.stringify(orderIds)) as unknown as SqlRow[];
    const packages = new Map<string, OrderOperationsAftersalesCase['returnPackages'][number]>();
    const packageDiscrepancies = new Map<string, AftersalesReturnDiscrepancy[]>();
    const packageItemIds = new Map<string, Set<string>>();
    const packageExceptionPayloads = new Map<string, {
      payload: Record<string, unknown>;
      reason: string;
      occurredAt: string;
    }>();
    for (const row of returnRows) {
      const orderId = asString(row.order_id);
      const caseId = asString(row.case_id);
      const projectedCase = casesByOrder.get(orderId)?.get(caseId);
      if (!projectedCase) continue;
      const returnRecordId = asString(row.return_record_id);
      const key = `${orderId}\u0000${caseId}\u0000${returnRecordId}`;
      let returnPackage = packages.get(key);
      if (!returnPackage) {
        const logisticsStatus = row.logistics_status;
        if (!isAftersalesReturnLogisticsStatus(logisticsStatus)) {
          throw new Error('数据库退货物流状态投影格式错误');
        }
        packageDiscrepancies.set(key, parseReturnDiscrepancies(row.discrepancies_json));
        packageItemIds.set(key, new Set());
        returnPackage = {
          id: returnRecordId,
          status: parseReturnStatus(row.return_status),
          shippingCarrier: asString(row.shipping_carrier),
          trackingNumber: asString(row.tracking_number),
          logisticsStatus,
          currentException: null,
          discrepancies: [],
          carrierClaimStatus: parseOptionalCarrierClaimStatus(row.carrier_claim_status),
          items: [],
        };
        packages.set(key, returnPackage);
        projectedCase.value.returnPackages.push(returnPackage);
        if (
          supportsCarrierClaim(logisticsStatus)
          && row.latest_status_payload_json !== null
          && row.latest_status_reason !== null
          && row.latest_status_occurred_at !== null
        ) {
          packageExceptionPayloads.set(key, {
            payload: parseJsonRecord(row.latest_status_payload_json),
            reason: asString(row.latest_status_reason),
            occurredAt: asString(row.latest_status_occurred_at),
          });
        }
      }
      packageItemIds.get(key)?.add(asString(row.return_record_item_id));
      returnPackage.items.push({
        shipmentPackageItemId: asString(row.shipment_package_item_id),
        sourceTitle: asString(row.source_title),
        sourceSpec: asString(row.source_spec),
        plannedQuantity: asNumber(row.planned_quantity),
        receivedQuantity: asNumber(row.received_quantity),
        acceptedQuantity: asNumber(row.accepted_quantity),
      });
    }
    for (const [key, returnPackage] of packages) {
      const itemIds = packageItemIds.get(key) ?? new Set<string>();
      returnPackage.discrepancies = (packageDiscrepancies.get(key) ?? []).filter((difference) => (
        difference.returnRecordItemId === undefined
        || itemIds.has(difference.returnRecordItemId)
      ));
      const exceptionFacts = packageExceptionPayloads.get(key);
      if (exceptionFacts) {
        const impact = parseProjectedLogisticsImpact(exceptionFacts.payload.impact);
        const affectedQuantity = impact.scope === 'package'
          ? returnPackage.items.reduce((total, item) => total + item.plannedQuantity, 0)
          : impact.items
            .filter((item) => itemIds.has(item.sourceItemId))
            .reduce((total, item) => total + item.quantity, 0);
        if (affectedQuantity > 0) {
          returnPackage.currentException = {
            direction: 'return',
            logisticsStatus: returnPackage.logisticsStatus,
            affectedQuantity,
            reason: exceptionFacts.reason,
            occurredAt: exceptionFacts.occurredAt,
          };
        }
      }
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
    returnLogisticsStatuses: projectedCase.returnLogisticsStatuses,
    carrierClaimStatuses: projectedCase.carrierClaimStatuses,
  })));
  const logisticsStatuses = new Set<ShipmentLogisticsStatus>();
  const carrierClaimStatuses = new Set<CarrierClaimStatus>();
  for (const record of shipmentRecords) {
    if (record.status === 'voided') continue;
    for (const shipmentPackage of record.packages) {
      if (shipmentPackage.status === 'active') {
        logisticsStatuses.add(shipmentPackage.logisticsStatus);
        if (shipmentPackage.carrierClaimStatus) {
          carrierClaimStatuses.add(shipmentPackage.carrierClaimStatus);
        }
      }
    }
  }
  return {
    shipmentRecords,
    aftersalesCases,
    currentTodo: aftersalesTodo
      ?? shipmentTodoForStatuses(logisticsStatuses, carrierClaimStatuses),
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

function parseReturnStatus(value: unknown): AftersalesReturnStatus {
  if (value === 'in_transit' || value === 'received' || value === 'inspected') return value;
  throw new Error('数据库退货状态投影格式错误');
}

function parseReturnLogisticsStatuses(value: unknown): AftersalesReturnLogisticsStatus[] {
  const parsed = parseJsonArray(value, '数据库退货物流状态投影格式错误');
  if (!parsed.every(isAftersalesReturnLogisticsStatus)) {
    throw new Error('数据库退货物流状态投影格式错误');
  }
  return parsed;
}

function parseCarrierClaimStatuses(value: unknown): CarrierClaimStatus[] {
  const parsed = parseJsonArray(value, '数据库承运索赔状态投影格式错误');
  if (!parsed.every((status): status is CarrierClaimStatus => (
    status === 'pending' || status === 'approved' || status === 'rejected' || status === 'paid'
  ))) {
    throw new Error('数据库承运索赔状态投影格式错误');
  }
  return parsed;
}

function parseJsonArray(value: unknown, message: string): unknown[] {
  if (typeof value !== 'string') throw new Error(message);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(message);
  return parsed;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('数据库物流异常投影格式错误');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('数据库物流异常投影格式错误', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('数据库物流异常投影格式错误');
  }
  return parsed as Record<string, unknown>;
}

function parseProjectedLogisticsImpact(value: unknown):
  | { scope: 'package' }
  | { scope: 'items'; items: Array<{ sourceItemId: string; quantity: number }> } {
  if (value === undefined) return { scope: 'package' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('数据库物流异常影响范围投影格式错误');
  }
  const record = value as Record<string, unknown>;
  if (record.scope === 'package') return { scope: 'package' };
  if (record.scope !== 'items' || !Array.isArray(record.items)) {
    throw new Error('数据库物流异常影响范围投影格式错误');
  }
  return {
    scope: 'items',
    items: record.items.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('数据库物流异常商品投影格式错误');
      }
      const item = value as Record<string, unknown>;
      if (
        typeof item.sourceItemId !== 'string'
        || !Number.isSafeInteger(item.quantity)
        || Number(item.quantity) <= 0
      ) {
        throw new Error('数据库物流异常商品投影格式错误');
      }
      return { sourceItemId: item.sourceItemId, quantity: Number(item.quantity) };
    }),
  };
}

function parseOptionalCarrierClaimStatus(value: unknown): CarrierClaimStatus | null {
  if (value === null) return null;
  if (value === 'pending' || value === 'approved' || value === 'rejected' || value === 'paid') {
    return value;
  }
  throw new Error('数据库承运索赔状态投影格式错误');
}

function parseReturnDiscrepancies(value: unknown): AftersalesReturnDiscrepancy[] {
  const parsed = parseJsonArray(value, '数据库退货检查差异投影格式错误');
  return parsed.map((item): AftersalesReturnDiscrepancy => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('数据库退货检查差异投影格式错误');
    }
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    if (
      (kind !== 'missing' && kind !== 'empty_package' && kind !== 'wrong_item'
        && kind !== 'excess' && kind !== 'mixed' && kind !== 'damaged'
        && kind !== 'missing_accessory' && kind !== 'unidentified')
      || !Number.isSafeInteger(record.quantity)
      || Number(record.quantity) < 0
      || typeof record.note !== 'string'
    ) {
      throw new Error('数据库退货检查差异投影格式错误');
    }
    if (record.returnRecordItemId !== undefined && typeof record.returnRecordItemId !== 'string') {
      throw new Error('数据库退货检查差异投影格式错误');
    }
    return {
      kind,
      quantity: Number(record.quantity),
      note: record.note,
      ...(record.returnRecordItemId === undefined
        ? {}
        : { returnRecordItemId: record.returnRecordItemId }),
    };
  });
}

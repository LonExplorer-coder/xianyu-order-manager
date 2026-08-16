import type { DatabaseSync } from 'node:sqlite';

import {
  isAftersalesReturnLogisticsStatus,
  isAftersalesStatus,
  type AftersalesReturnDiscrepancy,
  type AftersalesReturnLogisticsStatus,
  type AftersalesReturnStatus,
  type AftersalesStatus,
  type CarrierClaimStatus,
  type PendingFinancialItemStatus,
} from '../core/aftersales-cases';
import {
  aftersalesTodoForCases,
  coordinateAftersalesOrderOperations,
  coordinateOrderOperations,
  shipmentOrderOperationCandidates,
  shipmentTodoForStatuses,
  type OrderFulfillmentPlanAttribution,
  type OrderOperationsAftersalesCase,
  type OrderOperationsPackage,
  type OrderOperationsProjection,
  type OrderOperationsShipmentRecord,
  type OrderOperationsFact,
  type OrderOperationsHistoryEntry,
  type OrderOperationsRisk,
  type OrderOperationsTodoCandidate,
} from '../core/order-operations-projection';
import {
  isFulfillmentPlanType,
  type FulfillmentPlanType,
} from '../core/fulfillment-plans';
import {
  isShipmentLogisticsStatus,
  type ShipmentLogisticsStatus,
} from '../core/shipment-records';
import {
  isUnresolvedLogisticsExceptionStage,
  type LogisticsExceptionStage,
  type LogisticsExceptionType,
} from '../core/logistics-exceptions';

type SqlRow = Record<string, string | number | null>;

type ProjectedAftersalesCase = {
  value: OrderOperationsAftersalesCase;
  workflow: 'general' | 'refund_only' | 'return_refund' | 'exchange' | 'direct_replacement';
  handlingDirection: string | null;
  returnStatuses: AftersalesReturnStatus[];
  returnLogisticsStatuses: AftersalesReturnLogisticsStatus[];
  carrierClaimStatuses: CarrierClaimStatus[];
  hasUnresolvedLogisticsException: boolean;
  hasPendingReturnExceptionDecision: boolean;
};

export class OrderOperationsProjectionService {
  public constructor(private readonly database: DatabaseSync) {}

  public get(orderId: string): OrderOperationsProjection {
    return this.getMany([orderId]).get(orderId) ?? emptyProjection();
  }

  public getMany(orderIds: readonly string[]): ReadonlyMap<string, OrderOperationsProjection> {
    return this.projectMany(orderIds, true);
  }

  public getOverviewMany(
    orderIds: readonly string[],
  ): ReadonlyMap<string, OrderOperationsProjection> {
    return this.projectMany(orderIds, false);
  }

  private projectMany(
    orderIds: readonly string[],
    includeHistory: boolean,
  ): ReadonlyMap<string, OrderOperationsProjection> {
    const uniqueOrderIds = [...new Set(orderIds)];
    if (uniqueOrderIds.length === 0) return new Map();
    const shipmentRecordsByOrder = this.shipmentRecords(uniqueOrderIds);
    const aftersalesCasesByOrder = this.aftersalesCases(uniqueOrderIds);
    const attributionsByOrder = this.fulfillmentPlanAttributions(uniqueOrderIds);
    const historyByOrder = includeHistory
      ? this.historyEntries(uniqueOrderIds)
      : new Map<string, OrderOperationsHistoryEntry[]>();
    return new Map(uniqueOrderIds.map((orderId) => {
      const shipmentRecords = shipmentRecordsByOrder.get(orderId) ?? [];
      const aftersalesCases = aftersalesCasesByOrder.get(orderId) ?? [];
      const history = historyByOrder.get(orderId) ?? [];
      return [orderId, buildProjection(
        shipmentRecords,
        aftersalesCases,
        history,
        attributionsByOrder.get(orderId) ?? { status: 'none' },
      )] as const;
    }));
  }

  private fulfillmentPlanAttributions(
    orderIds: readonly string[],
  ): ReadonlyMap<string, OrderFulfillmentPlanAttribution> {
    const rows = this.database.prepare(`
      SELECT
        members.order_id,
        members.released_at,
        members.removed_at,
        plans.id AS plan_id,
        plans.type AS plan_type,
        plans.name AS plan_name
      FROM fulfillment_plan_members AS members
      JOIN fulfillment_plans AS plans ON plans.id = members.plan_id
      WHERE members.order_id IN (SELECT value FROM json_each(?))
      ORDER BY members.joined_at, members.id
    `).all(JSON.stringify(orderIds)) as unknown as SqlRow[];
    const activeByOrder = new Map<string, SqlRow>();
    const releasedByOrder = new Map<string, SqlRow>();
    for (const row of rows) {
      const orderId = asString(row.order_id);
      if (row.released_at === null && row.removed_at === null) {
        if (!activeByOrder.has(orderId)) activeByOrder.set(orderId, row);
      } else if (row.released_at !== null && !releasedByOrder.has(orderId)) {
        releasedByOrder.set(orderId, row);
      }
    }
    const result = new Map<string, OrderFulfillmentPlanAttribution>();
    for (const orderId of orderIds) {
      const row = activeByOrder.get(orderId) ?? releasedByOrder.get(orderId);
      if (!row) {
        result.set(orderId, { status: 'none' });
        continue;
      }
      result.set(orderId, {
        status: row.released_at === null ? 'active' : 'released',
        planId: asString(row.plan_id),
        planType: asFulfillmentPlanType(row.plan_type),
        planName: asString(row.plan_name),
      });
    }
    return result;
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
        replacements.id AS replacement_id,
        replacement_rounds.case_id AS replacement_case_id,
        voids.id AS void_event_id,
        packages.id AS package_id,
        packages.position AS package_position,
        packages.shipping_carrier,
        packages.tracking_number,
        packages.logistics_status,
        MAX(
          packages.created_at,
          COALESCE((
            SELECT MAX(status_events.occurred_at)
            FROM shipment_package_logistics_status_events AS status_events
            WHERE status_events.package_id = packages.id
          ), packages.created_at),
          COALESCE((
            SELECT MAX(change_events.occurred_at)
            FROM shipment_package_logistics_change_events AS change_events
            WHERE change_events.package_id = packages.id
          ), packages.created_at)
        ) AS package_updated_at,
        claims.status AS outbound_carrier_claim_status,
        COALESCE((
          SELECT MAX(claim_events.occurred_at)
          FROM carrier_claim_events AS claim_events
          WHERE claim_events.claim_id = claims.id
        ), claims.updated_at) AS outbound_carrier_claim_updated_at,
        claims.impact_json AS outbound_carrier_claim_impact_json,
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
      LEFT JOIN aftersales_replacement_shipments AS replacements
        ON replacements.shipment_record_id = records.id
      LEFT JOIN aftersales_processing_rounds AS replacement_rounds
        ON replacement_rounds.id = replacements.round_id
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
    const packageClaimFacts = new Map<string, {
      status: CarrierClaimStatus;
      impact: ReturnType<typeof parseProjectedLogisticsImpact>;
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
          sourceRole: row.replacement_id === null ? 'initial' : 'replacement',
          replacementAftersalesCaseId: row.replacement_case_id === null
            ? null
            : asString(row.replacement_case_id),
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
          updatedAt: asString(row.package_updated_at),
          shippingCarrier: asString(row.shipping_carrier),
          trackingNumber: asString(row.tracking_number),
          cancellationReason: row.cancellation_reason === null
            ? null
            : asString(row.cancellation_reason),
          currentException: null,
          logisticsExceptions: [],
          carrierClaimStatus: null,
          carrierClaimUpdatedAt: null,
          items: [],
        };
        const claimStatus = parseOptionalCarrierClaimStatus(
          row.outbound_carrier_claim_status,
        );
        if (claimStatus) {
          shipmentPackage.carrierClaimUpdatedAt = asString(
            row.outbound_carrier_claim_updated_at,
          );
          packageClaimFacts.set(`${orderId}\u0000${packageId}`, {
            status: claimStatus,
            impact: parseProjectedLogisticsImpact(
              parseJsonRecord(row.outbound_carrier_claim_impact_json),
            ),
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
    const exceptionRows = this.database.prepare(`
      SELECT
        package_items.order_id,
        packages.id AS package_id,
        exceptions.id AS exception_id,
        exceptions.exception_type,
        exceptions.stage,
        exceptions.impact_json,
        exceptions.reason,
        COALESCE((
          SELECT MAX(exception_events.occurred_at)
          FROM logistics_exception_events AS exception_events
          WHERE exception_events.exception_id = exceptions.id
        ), exceptions.occurred_at) AS latest_occurred_at
      FROM logistics_exception_matters AS exceptions
      JOIN shipment_packages AS packages ON packages.id = exceptions.shipment_package_id
      JOIN shipment_package_items AS package_items ON package_items.package_id = packages.id
      WHERE exceptions.direction = 'outbound'
        AND package_items.order_id IN (SELECT value FROM json_each(?))
        AND (
          json_extract(exceptions.impact_json, '$.scope') = 'package'
          OR EXISTS (
            SELECT 1
            FROM json_each(exceptions.impact_json, '$.items') AS affected_item
            JOIN shipment_package_items AS affected_package_item
              ON affected_package_item.id = json_extract(
                affected_item.value, '$.sourceItemId'
              )
            WHERE affected_package_item.package_id = packages.id
              AND affected_package_item.order_id = package_items.order_id
          )
        )
      GROUP BY package_items.order_id, exceptions.id
      ORDER BY
        package_items.order_id,
        latest_occurred_at,
        exceptions.created_at,
        exceptions.id
    `).all(JSON.stringify(orderIds)) as unknown as SqlRow[];
    for (const row of exceptionRows) {
      const orderId = asString(row.order_id);
      const packageId = asString(row.package_id);
      const shipmentPackage = packagesByOrder.get(orderId)?.get(packageId);
      if (!shipmentPackage) continue;
      const impact = parseProjectedLogisticsImpact(parseJsonRecord(row.impact_json));
      const affectedQuantity = affectedQuantityForImpact(
        impact,
        new Set(shipmentPackage.items.map(({ shipmentPackageItemId }) => (
          shipmentPackageItemId
        ))),
        shipmentPackage.items.reduce((total, item) => total + item.quantity, 0),
      );
      if (affectedQuantity === 0) continue;
      const affectedItems = affectedItemsForImpact(impact, shipmentPackage.items.map((item) => ({
        sourceItemId: item.shipmentPackageItemId,
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        quantity: item.quantity,
      })));
      shipmentPackage.logisticsExceptions.push({
        id: asString(row.exception_id),
        direction: 'outbound',
        exceptionType: parseLogisticsExceptionType(row.exception_type),
        stage: parseLogisticsExceptionStage(row.stage),
        affectedQuantity,
        affectedItems,
        reason: asString(row.reason),
        occurredAt: asString(row.latest_occurred_at),
      });
    }
    for (const [orderId, packages] of packagesByOrder) {
      for (const [packageId, shipmentPackage] of packages) {
        shipmentPackage.currentException = [...shipmentPackage.logisticsExceptions]
          .reverse()
          .find(({ stage }) => isUnresolvedLogisticsExceptionStage(stage)) ?? null;
      }
      for (const [packageId, shipmentPackage] of packages) {
        const claimFacts = packageClaimFacts.get(`${orderId}\u0000${packageId}`);
        if (!claimFacts) continue;
        const itemIds = new Set(shipmentPackage.items.map(({ shipmentPackageItemId }) => (
          shipmentPackageItemId
        )));
        const affectedItems = affectedItemsForImpact(
          claimFacts.impact,
          shipmentPackage.items.map((item) => ({
            sourceItemId: item.shipmentPackageItemId,
            sourceTitle: item.sourceTitle,
            sourceSpec: item.sourceSpec,
            quantity: item.quantity,
          })),
        );
        const affectedQuantity = affectedItems.reduce((total, item) => total + item.quantity, 0);
        if (affectedQuantity > 0) {
          shipmentPackage.carrierClaimStatus = claimFacts.status;
          shipmentPackage.carrierClaimAffectedQuantity = affectedQuantity;
          shipmentPackage.carrierClaimAffectedItems = affectedItems;
        }
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
        cases.workflow,
        cases.handling_direction,
        cases.reason,
        cases.occurred_at,
        cases.updated_at,
        cases.created_at,
        refunds.requested_amount_cents AS refund_requested_amount_cents,
        refunds.status AS refund_status,
        refund_records.amount_cents AS refund_actual_amount_cents,
        refund_records.occurred_at AS refund_occurred_at,
        COALESCE((
          SELECT refund_events.occurred_at
          FROM (
            SELECT events.occurred_at, events.sequence
            FROM pending_financial_item_events AS events
            WHERE events.pending_item_id = refunds.id
            UNION ALL
            SELECT events.occurred_at, events.sequence
            FROM aftersales_refund_reopening_events AS events
            WHERE events.pending_item_id = refunds.id
          ) AS refund_events
          ORDER BY julianday(refund_events.occurred_at) DESC, refund_events.sequence DESC
          LIMIT 1
        ), cases.occurred_at) AS refund_latest_event_at,
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
      LEFT JOIN pending_financial_items AS refunds
        ON refunds.aftersales_case_id = cases.id
      LEFT JOIN financial_records AS refund_records
        ON refund_records.pending_item_id = refunds.id
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
          workflow: parseAftersalesWorkflow(row.workflow),
          handlingDirection: row.handling_direction === null
            ? null
            : asString(row.handling_direction),
          value: {
            id: caseId,
            shipmentRecordId: asString(row.shipment_record_id),
            status,
            reason: asString(row.reason),
            occurredAt: asString(row.occurred_at),
            updatedAt: asString(row.updated_at),
            currentTodo: aftersalesTodoForCases([{
              status,
              returnStatuses,
              returnLogisticsStatuses,
              carrierClaimStatuses,
              hasUnresolvedLogisticsException: false,
              hasPendingReturnExceptionDecision: false,
            }])
              ?? '无需售后操作',
            refund: row.refund_status === null ? null : {
              requestedAmountCents: asNumber(row.refund_requested_amount_cents),
              status: parsePendingFinancialItemStatus(row.refund_status),
              actualAmountCents: row.refund_actual_amount_cents === null
                ? null
                : asNumber(row.refund_actual_amount_cents),
              occurredAt: row.refund_status === 'pending'
                ? asString(row.refund_latest_event_at)
                : row.refund_occurred_at === null
                  ? asString(row.refund_latest_event_at)
                  : asString(row.refund_occurred_at),
            },
            items: [],
            returnPackages: [],
          },
          returnStatuses,
          returnLogisticsStatuses,
          carrierClaimStatuses,
          hasUnresolvedLogisticsException: false,
          hasPendingReturnExceptionDecision: false,
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
        MAX(
          return_records.occurred_at,
          COALESCE((
            SELECT MAX(return_events.occurred_at)
            FROM aftersales_return_record_events AS return_events
            WHERE return_events.return_record_id = return_records.id
          ), return_records.occurred_at)
        ) AS return_updated_at,
        return_records.discrepancies_json,
        claims.status AS carrier_claim_status,
        COALESCE((
          SELECT MAX(claim_events.occurred_at)
          FROM carrier_claim_events AS claim_events
          WHERE claim_events.claim_id = claims.id
        ), claims.updated_at) AS carrier_claim_updated_at,
        claims.impact_json AS carrier_claim_impact_json,
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
    const packageAffectedItems = new Map<string, Map<string, {
      sourceItemId: string;
      sourceTitle: string;
      sourceSpec: string;
      quantity: number;
    }>>();
    const pendingReturnDecisionCases = new Set<string>();
    const packageClaimFacts = new Map<string, {
      status: CarrierClaimStatus;
      impact: ReturnType<typeof parseProjectedLogisticsImpact>;
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
        packageAffectedItems.set(key, new Map());
        returnPackage = {
          id: returnRecordId,
          status: parseReturnStatus(row.return_status),
          shippingCarrier: asString(row.shipping_carrier),
          trackingNumber: asString(row.tracking_number),
          logisticsStatus,
          updatedAt: asString(row.return_updated_at),
          currentException: null,
          logisticsExceptions: [],
          discrepancies: [],
          carrierClaimStatus: null,
          carrierClaimUpdatedAt: null,
          items: [],
        };
        const claimStatus = parseOptionalCarrierClaimStatus(row.carrier_claim_status);
        if (claimStatus) {
          returnPackage.carrierClaimUpdatedAt = asString(row.carrier_claim_updated_at);
          packageClaimFacts.set(key, {
            status: claimStatus,
            impact: parseProjectedLogisticsImpact(
              parseJsonRecord(row.carrier_claim_impact_json),
            ),
          });
        }
        packages.set(key, returnPackage);
        projectedCase.value.returnPackages.push(returnPackage);
      }
      const returnRecordItemId = asString(row.return_record_item_id);
      packageItemIds.get(key)?.add(returnRecordItemId);
      packageAffectedItems.get(key)?.set(returnRecordItemId, {
        sourceItemId: returnRecordItemId,
        sourceTitle: asString(row.source_title),
        sourceSpec: asString(row.source_spec),
        quantity: asNumber(row.planned_quantity),
      });
      returnPackage.items.push({
        shipmentPackageItemId: asString(row.shipment_package_item_id),
        sourceTitle: asString(row.source_title),
        sourceSpec: asString(row.source_spec),
        plannedQuantity: asNumber(row.planned_quantity),
        receivedQuantity: asNumber(row.received_quantity),
        acceptedQuantity: asNumber(row.accepted_quantity),
      });
    }
    const returnExceptionRows = this.database.prepare(`
      SELECT
        shipment_items.order_id,
        return_items.aftersales_case_id AS case_id,
        return_records.id AS return_record_id,
        exceptions.id AS exception_id,
        exceptions.exception_type,
        exceptions.stage,
        exceptions.impact_json,
        exceptions.reason,
        COALESCE((
          SELECT MAX(exception_events.occurred_at)
          FROM logistics_exception_events AS exception_events
          WHERE exception_events.exception_id = exceptions.id
        ), exceptions.occurred_at) AS latest_occurred_at,
        (
          SELECT decisions.after_decision
          FROM aftersales_return_exception_decision_events AS decisions
          WHERE decisions.case_id = return_items.aftersales_case_id
            AND decisions.exception_id = exceptions.id
          ORDER BY decisions.sequence DESC
          LIMIT 1
        ) AS exception_decision
      FROM logistics_exception_matters AS exceptions
      JOIN aftersales_return_records AS return_records
        ON return_records.id = exceptions.return_record_id
      JOIN aftersales_return_record_items AS return_items
        ON return_items.return_record_id = return_records.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = return_items.shipment_package_item_id
      WHERE exceptions.direction = 'return'
        AND shipment_items.order_id IN (SELECT value FROM json_each(?))
        AND (
          json_extract(exceptions.impact_json, '$.scope') = 'package'
          OR EXISTS (
            SELECT 1
            FROM json_each(exceptions.impact_json, '$.items') AS affected_item
            JOIN aftersales_return_record_items AS affected_return_item
              ON affected_return_item.id = json_extract(
                affected_item.value, '$.sourceItemId'
              )
            JOIN shipment_package_items AS affected_shipment_item
              ON affected_shipment_item.id = affected_return_item.shipment_package_item_id
            WHERE affected_return_item.return_record_id = return_records.id
              AND affected_shipment_item.order_id = shipment_items.order_id
          )
        )
      GROUP BY shipment_items.order_id, return_items.aftersales_case_id, exceptions.id
      ORDER BY
        shipment_items.order_id,
        latest_occurred_at,
        exceptions.created_at,
        exceptions.id
    `).all(JSON.stringify(orderIds)) as unknown as SqlRow[];
    for (const row of returnExceptionRows) {
      const orderId = asString(row.order_id);
      const caseId = asString(row.case_id);
      const returnRecordId = asString(row.return_record_id);
      const key = `${orderId}\u0000${caseId}\u0000${returnRecordId}`;
      const returnPackage = packages.get(key);
      if (!returnPackage) continue;
      const itemIds = packageItemIds.get(key) ?? new Set<string>();
      const impact = parseProjectedLogisticsImpact(parseJsonRecord(row.impact_json));
      const affectedQuantity = affectedQuantityForImpact(
        impact,
        itemIds,
        returnPackage.items.reduce((total, item) => total + item.plannedQuantity, 0),
      );
      if (affectedQuantity === 0) continue;
      const affectedItems = affectedItemsForImpact(
        impact,
        [...(packageAffectedItems.get(key)?.values() ?? [])],
      );
      returnPackage.logisticsExceptions.push({
        id: asString(row.exception_id),
        direction: 'return',
        exceptionType: parseLogisticsExceptionType(row.exception_type),
        stage: parseLogisticsExceptionStage(row.stage),
        affectedQuantity,
        affectedItems,
        reason: asString(row.reason),
        occurredAt: asString(row.latest_occurred_at),
      });
      if (Date.parse(asString(row.latest_occurred_at)) > Date.parse(returnPackage.updatedAt)) {
        returnPackage.updatedAt = asString(row.latest_occurred_at);
      }
      if (
        row.exception_type === 'lost'
        && row.stage === 'confirmed'
        && row.exception_decision === null
      ) {
        pendingReturnDecisionCases.add(`${orderId}\u0000${caseId}`);
      }
    }
    for (const [key, returnPackage] of packages) {
      const itemIds = packageItemIds.get(key) ?? new Set<string>();
      returnPackage.discrepancies = (packageDiscrepancies.get(key) ?? []).filter((difference) => (
        difference.returnRecordItemId === undefined
        || itemIds.has(difference.returnRecordItemId)
      ));
      returnPackage.currentException = [...returnPackage.logisticsExceptions]
        .reverse()
        .find(({ stage }) => isUnresolvedLogisticsExceptionStage(stage)) ?? null;
      const claimFacts = packageClaimFacts.get(key);
      if (
        claimFacts
        && affectedQuantityForImpact(claimFacts.impact, itemIds, 1) > 0
      ) {
        returnPackage.carrierClaimStatus = claimFacts.status;
        const affectedItems = affectedItemsForImpact(
          claimFacts.impact,
          [...(packageAffectedItems.get(key)?.values() ?? [])],
        );
        returnPackage.carrierClaimAffectedItems = affectedItems;
        returnPackage.carrierClaimAffectedQuantity = affectedItems.reduce(
          (total, item) => total + item.quantity,
          0,
        );
      }
    }
    for (const [orderId, cases] of casesByOrder) {
      for (const projectedCase of cases.values()) {
        projectedCase.returnStatuses = projectedCase.value.returnPackages.map(
          ({ status }) => status,
        );
        projectedCase.returnLogisticsStatuses = projectedCase.value.returnPackages.map(
          ({ logisticsStatus }) => logisticsStatus,
        );
        projectedCase.hasUnresolvedLogisticsException = projectedCase.value.returnPackages.some(
          ({ currentException }) => currentException !== null
            && currentException.stage !== 'recovered',
        );
        projectedCase.carrierClaimStatuses = projectedCase.value.returnPackages.flatMap(
          ({ carrierClaimStatus }) => carrierClaimStatus ? [carrierClaimStatus] : [],
        );
        projectedCase.hasPendingReturnExceptionDecision = pendingReturnDecisionCases.has(
          `${orderId}\u0000${projectedCase.value.id}`,
        );
        projectedCase.value.currentTodo = aftersalesTodoForCases([{
          status: projectedCase.value.status,
          returnStatuses: projectedCase.returnStatuses,
          returnLogisticsStatuses: projectedCase.returnLogisticsStatuses,
          carrierClaimStatuses: projectedCase.carrierClaimStatuses,
          hasUnresolvedLogisticsException: projectedCase.hasUnresolvedLogisticsException,
          hasPendingReturnExceptionDecision: projectedCase.hasPendingReturnExceptionDecision,
        }]) ?? '无需售后操作';
      }
      result.set(orderId, [...cases.values()]);
    }
    return result;
  }

  private historyEntries(
    orderIds: readonly string[],
  ): ReadonlyMap<string, OrderOperationsHistoryEntry[]> {
    const result = new Map<string, OrderOperationsHistoryEntry[]>();
    const append = (row: SqlRow, entry: OrderOperationsHistoryEntry) => {
      const orderId = asString(row.order_id);
      const values = result.get(orderId) ?? [];
      values.push(entry);
      result.set(orderId, values);
    };
    const shipmentRows = this.database.prepare(`
      SELECT
        package_items.order_id,
        events.id,
        'logistics_status' AS event_kind,
        events.before_status || ' → ' || events.after_status || ' · ' || events.reason AS detail,
        events.occurred_at,
        packages.shipment_record_id,
        packages.id AS package_id
      FROM shipment_package_logistics_status_events AS events
      JOIN shipment_packages AS packages ON packages.id = events.package_id
      JOIN shipment_package_items AS package_items ON package_items.package_id = packages.id
      WHERE package_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY package_items.order_id, events.id

      UNION ALL

      SELECT
        package_items.order_id,
        events.id,
        'logistics_corrected' AS event_kind,
        events.before_shipping_carrier || ' ' || events.before_tracking_number
          || ' → ' || events.after_shipping_carrier || ' ' || events.after_tracking_number
          || ' · ' || events.reason AS detail,
        events.occurred_at,
        packages.shipment_record_id,
        packages.id AS package_id
      FROM shipment_package_logistics_change_events AS events
      JOIN shipment_packages AS packages ON packages.id = events.package_id
      JOIN shipment_package_items AS package_items ON package_items.package_id = packages.id
      WHERE package_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY package_items.order_id, events.id

      UNION ALL

      SELECT
        package_items.order_id,
        events.id,
        'package_cancelled' AS event_kind,
        events.reason AS detail,
        events.created_at AS occurred_at,
        packages.shipment_record_id,
        packages.id AS package_id
      FROM shipment_package_cancellation_events AS events
      JOIN shipment_packages AS packages ON packages.id = events.package_id
      JOIN shipment_package_items AS package_items ON package_items.package_id = packages.id
      WHERE package_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY package_items.order_id, events.id

      UNION ALL

      SELECT
        record_orders.order_id,
        events.id,
        'shipment_voided' AS event_kind,
        events.reason AS detail,
        events.created_at AS occurred_at,
        events.shipment_record_id,
        NULL AS package_id
      FROM shipment_record_void_events AS events
      JOIN shipment_record_order_snapshots AS record_orders
        ON record_orders.shipment_record_id = events.shipment_record_id
      WHERE record_orders.order_id IN (SELECT value FROM json_each(?))
      GROUP BY record_orders.order_id, events.id
    `).all(
      JSON.stringify(orderIds),
      JSON.stringify(orderIds),
      JSON.stringify(orderIds),
      JSON.stringify(orderIds),
    ) as unknown as SqlRow[];
    for (const row of shipmentRows) {
      const eventKind = asString(row.event_kind);
      append(row, {
        id: `shipment-event:${asString(row.id)}`,
        kind: 'logistics',
        title: eventKind === 'logistics_status'
          ? '更新物流进展'
          : eventKind === 'logistics_corrected'
            ? '更正物流信息'
            : eventKind === 'package_cancelled'
              ? '撤销包裹'
              : '作废发货记录',
        detail: asString(row.detail),
        occurredAt: asString(row.occurred_at),
        target: {
          kind: 'shipment_record',
          shipmentRecordId: asString(row.shipment_record_id),
          ...(row.package_id === null ? {} : { packageId: asString(row.package_id) }),
        },
      });
    }

    const aftersalesRows = this.database.prepare(`
      SELECT
        shipment_items.order_id,
        events.id,
        'case_' || events.kind AS event_kind,
        CASE events.kind
          WHEN 'created' THEN json_extract(events.after_snapshot_json, '$.status')
            || ' · ' || json_extract(events.after_snapshot_json, '$.reason')
          ELSE json_extract(events.before_snapshot_json, '$.status') || ' → '
            || json_extract(events.after_snapshot_json, '$.status') || ' · '
            || events.change_reason
        END AS detail,
        events.created_at AS occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id,
        NULL AS return_record_id
      FROM aftersales_case_events AS events
      JOIN aftersales_cases AS cases ON cases.id = events.case_id
      JOIN aftersales_case_items AS case_items ON case_items.case_id = cases.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY shipment_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        'direction_' || events.kind AS event_kind,
        COALESCE(events.before_direction || ' → ', '')
          || COALESCE(events.after_direction, '无指定处理方向')
          || ' · ' || events.reason AS detail,
        events.occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id,
        NULL AS return_record_id
      FROM aftersales_handling_direction_events AS events
      JOIN aftersales_cases AS cases ON cases.id = events.case_id
      JOIN aftersales_case_items AS case_items ON case_items.case_id = cases.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY shipment_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        'interception_' || events.kind AS event_kind,
        events.reason AS detail,
        events.occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id,
        NULL AS return_record_id
      FROM aftersales_interception_events AS events
      JOIN aftersales_cases AS cases ON cases.id = events.case_id
      JOIN aftersales_case_items AS case_items ON case_items.case_id = cases.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY shipment_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        'return_' || events.kind AS event_kind,
        CASE events.kind
          WHEN 'logistics_corrected' THEN
            json_extract(events.payload_json, '$.before.shippingCarrier') || ' '
            || json_extract(events.payload_json, '$.before.trackingNumber') || ' → '
            || json_extract(events.payload_json, '$.after.shippingCarrier') || ' '
            || json_extract(events.payload_json, '$.after.trackingNumber') || ' · '
            || events.reason
          WHEN 'logistics_status_updated' THEN
            json_extract(events.payload_json, '$.before') || ' → '
            || json_extract(events.payload_json, '$.after') || ' · ' || events.reason
          WHEN 'inspected' THEN
            COALESCE(events.inspection_result, '未记录检查结果') || ' · ' || events.reason
          ELSE events.reason
        END AS detail,
        events.occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id,
        return_records.id AS return_record_id
      FROM aftersales_return_record_events AS events
      JOIN aftersales_return_records AS return_records
        ON return_records.id = events.return_record_id
      JOIN aftersales_cases AS cases ON cases.id = return_records.aftersales_case_id
      JOIN aftersales_return_record_items AS return_items
        ON return_items.return_record_id = return_records.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = return_items.shipment_package_item_id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY shipment_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        'return_decision_' || events.kind AS event_kind,
        COALESCE(events.before_decision || ' → ', '')
          || events.after_decision || ' · ' || events.reason AS detail,
        events.occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id,
        events.return_record_id
      FROM aftersales_return_exception_decision_events AS events
      JOIN aftersales_cases AS cases ON cases.id = events.case_id
      JOIN logistics_exception_matters AS exceptions ON exceptions.id = events.exception_id
      JOIN aftersales_return_record_items AS return_items
        ON return_items.return_record_id = events.return_record_id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = return_items.shipment_package_item_id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
        AND (
          json_extract(exceptions.impact_json, '$.scope') = 'package'
          OR EXISTS (
            SELECT 1
            FROM json_each(exceptions.impact_json, '$.items') AS affected_item
            WHERE json_extract(affected_item.value, '$.sourceItemId') = return_items.id
          )
        )
      GROUP BY shipment_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        'outbound_decision_' || events.kind AS event_kind,
        COALESCE(events.before_decision || ' → ', '')
          || events.after_decision || ' · ' || events.reason AS detail,
        events.occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id,
        NULL AS return_record_id
      FROM aftersales_outbound_exception_decision_events AS events
      JOIN aftersales_cases AS cases ON cases.id = events.case_id
      JOIN json_each(events.affected_items_json) AS affected_item
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = json_extract(
          affected_item.value, '$.shipmentPackageItemId'
        )
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY shipment_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        'intercepted_return_inspected' AS event_kind,
        events.reason AS detail,
        events.occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id,
        NULL AS return_record_id
      FROM aftersales_intercepted_return_inspection_events AS events
      JOIN aftersales_cases AS cases ON cases.id = events.case_id
      JOIN aftersales_case_items AS case_items ON case_items.case_id = cases.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY shipment_items.order_id, events.id
    `).all(
      ...Array.from({ length: 7 }, () => JSON.stringify(orderIds)),
    ) as unknown as SqlRow[];
    for (const row of aftersalesRows) {
      const eventKind = asString(row.event_kind);
      append(row, {
        id: `aftersales-event:${asString(row.id)}`,
        kind: eventKind.startsWith('return_') ? 'return' : 'aftersales',
        title: aftersalesHistoryTitle(eventKind),
        detail: asString(row.detail),
        occurredAt: asString(row.occurred_at),
        target: {
          kind: 'aftersales_case',
          shipmentRecordId: asString(row.shipment_record_id),
          aftersalesCaseId: asString(row.case_id),
          ...(row.return_record_id === null
            ? {}
            : { returnRecordId: asString(row.return_record_id) }),
        },
      });
    }

    const financialRows = this.database.prepare(`
      SELECT
        shipment_items.order_id,
        events.id,
        'refund_' || events.kind AS event_kind,
        CASE events.kind
          WHEN 'created' THEN '申请 ¥' || printf('%.2f', events.requested_amount_cents / 100.0)
            || ' · ' || events.reason
          WHEN 'confirmed' THEN '申请 ¥' || printf('%.2f', events.requested_amount_cents / 100.0)
            || ' → 实际 ¥' || printf('%.2f', events.actual_amount_cents / 100.0)
            || ' · ' || events.reason
          ELSE '取消申请 ¥' || printf('%.2f', events.requested_amount_cents / 100.0)
            || ' · ' || events.reason
        END AS detail,
        events.occurred_at AS occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id
      FROM pending_financial_item_events AS events
      JOIN pending_financial_items AS pending ON pending.id = events.pending_item_id
      JOIN aftersales_cases AS cases ON cases.id = pending.aftersales_case_id
      JOIN aftersales_case_items AS case_items ON case_items.case_id = cases.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      LEFT JOIN financial_records AS records
        ON records.pending_item_id = pending.id AND events.kind = 'confirmed'
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY shipment_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        'refund_reopened' AS event_kind,
        events.reason AS detail,
        events.occurred_at AS occurred_at,
        cases.shipment_record_id,
        cases.id AS case_id
      FROM aftersales_refund_reopening_events AS events
      JOIN pending_financial_items AS pending ON pending.id = events.pending_item_id
      JOIN aftersales_cases AS cases ON cases.id = pending.aftersales_case_id
      JOIN aftersales_case_items AS case_items ON case_items.case_id = cases.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      WHERE shipment_items.order_id IN (SELECT value FROM json_each(?))
      GROUP BY shipment_items.order_id, events.id
    `).all(JSON.stringify(orderIds), JSON.stringify(orderIds)) as unknown as SqlRow[];
    for (const row of financialRows) {
      append(row, {
        id: `refund-event:${asString(row.id)}`,
        kind: 'refund',
        title: refundHistoryTitle(asString(row.event_kind)),
        detail: asString(row.detail),
        occurredAt: asString(row.occurred_at),
        target: {
          kind: 'aftersales_case',
          shipmentRecordId: asString(row.shipment_record_id),
          aftersalesCaseId: asString(row.case_id),
        },
      });
    }

    const exceptionRows = this.database.prepare(`
      SELECT
        package_items.order_id,
        events.id,
        events.kind AS event_kind,
        events.after_stage,
        exceptions.exception_type || ' · '
          || COALESCE(events.before_stage || ' → ', '')
          || events.after_stage || ' · ' || events.reason AS detail,
        events.occurred_at,
        packages.shipment_record_id,
        packages.id AS package_id,
        NULL AS case_id,
        NULL AS return_record_id
      FROM logistics_exception_events AS events
      JOIN logistics_exception_matters AS exceptions ON exceptions.id = events.exception_id
      JOIN shipment_packages AS packages ON packages.id = exceptions.shipment_package_id
      JOIN shipment_package_items AS package_items ON package_items.package_id = packages.id
      WHERE exceptions.direction = 'outbound'
        AND package_items.order_id IN (SELECT value FROM json_each(?))
        AND (
          json_extract(exceptions.impact_json, '$.scope') = 'package'
          OR EXISTS (
            SELECT 1
            FROM json_each(exceptions.impact_json, '$.items') AS affected_item
            JOIN shipment_package_items AS affected_package_item
              ON affected_package_item.id = json_extract(affected_item.value, '$.sourceItemId')
            WHERE affected_package_item.package_id = packages.id
              AND affected_package_item.order_id = package_items.order_id
          )
        )
      GROUP BY package_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        events.kind AS event_kind,
        events.after_stage,
        exceptions.exception_type || ' · '
          || COALESCE(events.before_stage || ' → ', '')
          || events.after_stage || ' · ' || events.reason AS detail,
        events.occurred_at,
        cases.shipment_record_id,
        NULL AS package_id,
        cases.id AS case_id,
        return_records.id AS return_record_id
      FROM logistics_exception_events AS events
      JOIN logistics_exception_matters AS exceptions ON exceptions.id = events.exception_id
      JOIN aftersales_return_records AS return_records
        ON return_records.id = exceptions.return_record_id
      JOIN aftersales_cases AS cases ON cases.id = return_records.aftersales_case_id
      JOIN aftersales_return_record_items AS return_items
        ON return_items.return_record_id = return_records.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = return_items.shipment_package_item_id
      WHERE exceptions.direction = 'return'
        AND shipment_items.order_id IN (SELECT value FROM json_each(?))
        AND (
          json_extract(exceptions.impact_json, '$.scope') = 'package'
          OR EXISTS (
            SELECT 1
            FROM json_each(exceptions.impact_json, '$.items') AS affected_item
            JOIN aftersales_return_record_items AS affected_return_item
              ON affected_return_item.id = json_extract(affected_item.value, '$.sourceItemId')
            JOIN shipment_package_items AS affected_shipment_item
              ON affected_shipment_item.id = affected_return_item.shipment_package_item_id
            WHERE affected_return_item.return_record_id = return_records.id
              AND affected_shipment_item.order_id = shipment_items.order_id
          )
        )
      GROUP BY shipment_items.order_id, events.id
    `).all(JSON.stringify(orderIds), JSON.stringify(orderIds)) as unknown as SqlRow[];
    for (const row of exceptionRows) {
      const target = row.case_id === null ? {
        kind: 'shipment_record' as const,
        shipmentRecordId: asString(row.shipment_record_id),
        packageId: asString(row.package_id),
      } : {
        kind: 'aftersales_case' as const,
        shipmentRecordId: asString(row.shipment_record_id),
        aftersalesCaseId: asString(row.case_id),
        returnRecordId: asString(row.return_record_id),
      };
      append(row, {
        id: `logistics-exception-event:${asString(row.id)}`,
        kind: 'logistics_exception',
        title: logisticsExceptionHistoryTitle(
          asString(row.event_kind),
          parseLogisticsExceptionStage(row.after_stage),
          row.case_id !== null,
        ),
        detail: asString(row.detail),
        occurredAt: asString(row.occurred_at),
        target,
      });
    }

    const claimRows = this.database.prepare(`
      SELECT
        package_items.order_id,
        events.id,
        events.kind AS event_kind,
        CASE events.kind
          WHEN 'opened' THEN '申请索赔 ¥' || printf('%.2f', events.amount_cents / 100.0)
          WHEN 'approved' THEN '同意赔付 ¥' || printf('%.2f', events.amount_cents / 100.0)
          WHEN 'compensation_confirmed' THEN '实际赔付 ¥' || printf('%.2f', events.amount_cents / 100.0)
          ELSE '承运方拒赔'
        END || ' · ' || events.reason AS detail,
        events.occurred_at,
        packages.shipment_record_id,
        packages.id AS package_id,
        NULL AS case_id,
        NULL AS return_record_id
      FROM carrier_claim_events AS events
      JOIN carrier_claims AS claims ON claims.id = events.claim_id
      JOIN shipment_packages AS packages ON packages.id = claims.shipment_package_id
      JOIN shipment_package_items AS package_items ON package_items.package_id = packages.id
      WHERE claims.direction = 'outbound'
        AND package_items.order_id IN (SELECT value FROM json_each(?))
        AND (
          json_extract(claims.impact_json, '$.scope') = 'package'
          OR EXISTS (
            SELECT 1 FROM json_each(claims.impact_json, '$.items') AS affected_item
            JOIN shipment_package_items AS affected_package_item
              ON affected_package_item.id = json_extract(affected_item.value, '$.sourceItemId')
            WHERE affected_package_item.package_id = packages.id
              AND affected_package_item.order_id = package_items.order_id
          )
        )
      GROUP BY package_items.order_id, events.id

      UNION ALL

      SELECT
        shipment_items.order_id,
        events.id,
        events.kind AS event_kind,
        CASE events.kind
          WHEN 'opened' THEN '申请索赔 ¥' || printf('%.2f', events.amount_cents / 100.0)
          WHEN 'approved' THEN '同意赔付 ¥' || printf('%.2f', events.amount_cents / 100.0)
          WHEN 'compensation_confirmed' THEN '实际赔付 ¥' || printf('%.2f', events.amount_cents / 100.0)
          ELSE '承运方拒赔'
        END || ' · ' || events.reason AS detail,
        events.occurred_at,
        cases.shipment_record_id,
        NULL AS package_id,
        cases.id AS case_id,
        return_records.id AS return_record_id
      FROM carrier_claim_events AS events
      JOIN carrier_claims AS claims ON claims.id = events.claim_id
      JOIN aftersales_return_records AS return_records
        ON return_records.id = claims.return_record_id
      JOIN aftersales_cases AS cases ON cases.id = return_records.aftersales_case_id
      JOIN aftersales_return_record_items AS return_items
        ON return_items.return_record_id = return_records.id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = return_items.shipment_package_item_id
      WHERE claims.direction = 'return'
        AND shipment_items.order_id IN (SELECT value FROM json_each(?))
        AND (
          json_extract(claims.impact_json, '$.scope') = 'package'
          OR EXISTS (
            SELECT 1 FROM json_each(claims.impact_json, '$.items') AS affected_item
            JOIN aftersales_return_record_items AS affected_return_item
              ON affected_return_item.id = json_extract(affected_item.value, '$.sourceItemId')
            JOIN shipment_package_items AS affected_shipment_item
              ON affected_shipment_item.id = affected_return_item.shipment_package_item_id
            WHERE affected_return_item.return_record_id = return_records.id
              AND affected_shipment_item.order_id = shipment_items.order_id
          )
        )
      GROUP BY shipment_items.order_id, events.id
    `).all(JSON.stringify(orderIds), JSON.stringify(orderIds)) as unknown as SqlRow[];
    for (const row of claimRows) {
      const target = row.case_id === null ? {
        kind: 'shipment_record' as const,
        shipmentRecordId: asString(row.shipment_record_id),
        packageId: asString(row.package_id),
      } : {
        kind: 'aftersales_case' as const,
        shipmentRecordId: asString(row.shipment_record_id),
        aftersalesCaseId: asString(row.case_id),
        returnRecordId: asString(row.return_record_id),
      };
      append(row, {
        id: `carrier-claim-event:${asString(row.id)}`,
        kind: 'carrier_claim',
        title: carrierClaimHistoryTitle(asString(row.event_kind)),
        detail: asString(row.detail),
        occurredAt: asString(row.occurred_at),
        target,
      });
    }
    const planRows = this.database.prepare(`
      SELECT
        members.order_id,
        members.id AS member_id,
        members.joined_at,
        members.join_reason,
        members.released_at,
        members.released_reason,
        members.removed_at,
        members.removed_reason,
        plans.id AS plan_id,
        plans.name AS plan_name
      FROM fulfillment_plan_members AS members
      JOIN fulfillment_plans AS plans ON plans.id = members.plan_id
      WHERE members.order_id IN (SELECT value FROM json_each(?))
      ORDER BY members.order_id, members.joined_at, members.id
    `).all(JSON.stringify(orderIds)) as unknown as SqlRow[];
    for (const row of planRows) {
      const memberId = asString(row.member_id);
      const planId = asString(row.plan_id);
      const planName = asString(row.plan_name);
      const target = { kind: 'fulfillment_plan' as const, planId };
      append(row, {
        id: `fulfillment-plan:joined:${memberId}`,
        kind: 'fulfillment_plan',
        title: '加入履约计划',
        detail: `${planName} · ${asString(row.join_reason)}`,
        occurredAt: asString(row.joined_at),
        target,
      });
      if (row.released_at !== null) {
        append(row, {
          id: `fulfillment-plan:released:${memberId}`,
          kind: 'fulfillment_plan',
          title: '被履约计划释放',
          detail: `${planName} · ${asString(row.released_reason)}`,
          occurredAt: asString(row.released_at),
          target,
        });
      }
      if (row.removed_at !== null) {
        append(row, {
          id: `fulfillment-plan:removed:${memberId}`,
          kind: 'fulfillment_plan',
          title: '退出履约计划',
          detail: `${planName} · ${asString(row.removed_reason)}`,
          occurredAt: asString(row.removed_at),
          target,
        });
      }
    }
    for (const history of result.values()) {
      history.sort((first, second) => Date.parse(second.occurredAt) - Date.parse(first.occurredAt));
    }
    return result;
  }
}

function aftersalesHistoryTitle(eventKind: string): string {
  if (eventKind === 'case_created') return '建立售后处理单';
  if (eventKind === 'case_updated') return '更新售后处理';
  if (eventKind === 'direction_cleared') return '结束售后处理方向';
  if (eventKind.startsWith('direction_')) return '选择售后处理方向';
  if (eventKind === 'interception_requested') return '申请拦截正向包裹';
  if (eventKind === 'interception_succeeded') return '确认拦截成功';
  if (eventKind === 'interception_failed') return '确认拦截失败';
  if (eventKind === 'return_registered') return '登记退货包裹';
  if (eventKind === 'return_items_combined') return '合并退货商品';
  if (eventKind === 'return_logistics_corrected') return '更正退货物流信息';
  if (eventKind === 'return_logistics_status_updated') return '更新退货物流进展';
  if (eventKind === 'return_received') return '确认实际收到退货';
  if (eventKind === 'return_inspected') return '完成退货检查';
  if (eventKind.startsWith('return_decision_')) return '选择退货异常处理';
  if (eventKind.startsWith('outbound_decision_')) return '选择正向异常处理';
  if (eventKind === 'intercepted_return_inspected') return '检查拦截退回商品';
  return '更新售后处理';
}

function refundHistoryTitle(eventKind: string): string {
  if (eventKind === 'refund_created') return '登记待退款';
  if (eventKind === 'refund_confirmed') return '确认实际退款';
  if (eventKind === 'refund_cancelled') return '取消待退款';
  return '重新申请退款';
}

function carrierClaimHistoryTitle(eventKind: string): string {
  if (eventKind === 'opened') return '建立承运索赔';
  if (eventKind === 'approved') return '承运索赔已批准';
  if (eventKind === 'rejected') return '承运索赔已驳回';
  return '确认承运赔付';
}

function logisticsExceptionHistoryTitle(
  eventKind: string,
  afterStage: LogisticsExceptionStage,
  isReturn: boolean,
): string {
  const direction = isReturn ? '退货' : '正向';
  if (eventKind === 'opened') return `登记${direction}物流异常`;
  return isUnresolvedLogisticsExceptionStage(afterStage)
    ? `推进${direction}物流异常`
    : `结束${direction}物流异常`;
}

function buildProjection(
  shipmentRecords: OrderOperationsShipmentRecord[],
  projectedAftersalesCases: ProjectedAftersalesCase[],
  sourceHistory: readonly OrderOperationsHistoryEntry[] = [],
  fulfillmentPlanAttribution: OrderFulfillmentPlanAttribution = { status: 'none' },
): OrderOperationsProjection {
  const aftersalesCases = projectedAftersalesCases.map(({ value }) => value);
  const aftersalesTodo = aftersalesTodoForCases(projectedAftersalesCases.map((projectedCase) => ({
    status: projectedCase.value.status,
    returnStatuses: projectedCase.returnStatuses,
    returnLogisticsStatuses: projectedCase.returnLogisticsStatuses,
    carrierClaimStatuses: projectedCase.carrierClaimStatuses,
    hasUnresolvedLogisticsException: projectedCase.hasUnresolvedLogisticsException,
    hasPendingReturnExceptionDecision: projectedCase.hasPendingReturnExceptionDecision,
  })));
  const logisticsStatuses = new Set<ShipmentLogisticsStatus>();
  const carrierClaimStatuses = new Set<CarrierClaimStatus>();
  let hasUnresolvedLogisticsException = false;
  const todoCandidates: OrderOperationsTodoCandidate[] = shipmentOrderOperationCandidates(
    shipmentRecords,
  );
  const risks: OrderOperationsRisk[] = [];
  const facts: OrderOperationsFact[] = [];
  const history: OrderOperationsHistoryEntry[] = [...sourceHistory];
  for (const record of shipmentRecords) {
    history.push({
      id: `shipment:${record.id}`,
      kind: record.sourceRole === 'replacement' ? 'replacement' : 'shipment',
      title: record.sourceRole === 'replacement' ? '建立补发记录' : '建立发货记录',
      detail: '实际发货事实已建立',
      occurredAt: record.createdAt,
      target: { kind: 'shipment_record', shipmentRecordId: record.id },
    });
    if (record.status === 'voided') continue;
    for (const shipmentPackage of record.packages) {
      if (shipmentPackage.status === 'active') {
        const target = {
          kind: 'shipment_record' as const,
          shipmentRecordId: record.id,
          packageId: shipmentPackage.id,
        };
        logisticsStatuses.add(shipmentPackage.logisticsStatus);
        hasUnresolvedLogisticsException ||= shipmentPackage.currentException !== null
          && isUnresolvedLogisticsExceptionStage(shipmentPackage.currentException.stage);
        facts.push({
          id: `outbound-logistics:${shipmentPackage.id}`,
          kind: record.sourceRole === 'replacement' ? 'replacement' : 'outbound_logistics',
          label: record.sourceRole === 'replacement' ? '补发' : '正向物流',
          value: shipmentPackage.logisticsStatus,
          detail: [shipmentPackage.shippingCarrier, shipmentPackage.trackingNumber]
            .filter(Boolean).join(' · ') || '未填写物流信息',
          affectedQuantity: shipmentPackage.items.reduce(
            (total, item) => total + item.quantity,
            0,
          ),
          occurredAt: shipmentPackage.updatedAt,
          target,
        });
        for (const exception of shipmentPackage.logisticsExceptions) {
          facts.push({
            id: `logistics-exception:${exception.id}`,
            kind: 'logistics_exception',
            label: record.sourceRole === 'replacement' ? '补发物流异常' : '正向物流异常',
            value: exception.stage,
            detail: exception.reason,
            affectedQuantity: exception.affectedQuantity,
            occurredAt: exception.occurredAt,
            target,
          });
          if (isUnresolvedLogisticsExceptionStage(exception.stage)) {
            risks.push({
              id: `logistics-exception:${exception.id}`,
              kind: 'logistics_exception',
              packageRole: record.sourceRole === 'replacement'
                ? 'replacement'
                : 'original_outbound',
              exceptionType: exception.exceptionType,
              affectedQuantity: exception.affectedQuantity,
              items: publicAffectedItems(exception.affectedItems),
              title: record.sourceRole === 'replacement'
                ? '补发物流异常'
                : '正向物流异常',
              detail: exception.reason,
              occurredAt: exception.occurredAt,
              target,
            });
          }
        }
        if (shipmentPackage.carrierClaimStatus) {
          carrierClaimStatuses.add(shipmentPackage.carrierClaimStatus);
          facts.push({
            id: `carrier-claim:${shipmentPackage.id}`,
            kind: 'carrier_claim',
            label: '承运索赔',
            value: shipmentPackage.carrierClaimStatus,
            detail: '正向包裹承运索赔独立推进',
            affectedQuantity: shipmentPackage.carrierClaimAffectedQuantity
              ?? shipmentPackage.items.reduce((total, item) => total + item.quantity, 0),
            occurredAt: shipmentPackage.carrierClaimUpdatedAt ?? shipmentPackage.updatedAt,
            target,
          });
        }
      }
    }
  }
  for (const projectedCase of projectedAftersalesCases) {
    const aftersalesCase = projectedCase.value;
    const caseSourceItemIds = new Set(aftersalesCase.items.map((item) => (
      item.shipmentPackageItemId
    )));
    const matchingOutboundPackages = shipmentRecords
      .filter(({ sourceRole, status }) => sourceRole === 'initial' && status === 'active')
      .flatMap(({ packages }) => packages)
      .filter((shipmentPackage) => (
        shipmentPackage.status === 'active'
        && shipmentPackage.items.some(({ shipmentPackageItemId }) => (
          caseSourceItemIds.has(shipmentPackageItemId)
        ))
      ));
    const outboundClaims = matchingOutboundPackages.flatMap((shipmentPackage) => {
      if (!shipmentPackage.carrierClaimStatus) return [];
      const affectedItems = (shipmentPackage.carrierClaimAffectedItems
        ?? shipmentPackage.items).filter(({ shipmentPackageItemId }) => (
        shipmentPackageItemId !== undefined
        && caseSourceItemIds.has(shipmentPackageItemId)
      ));
      const affectedQuantity = affectedItems.reduce((total, item) => total + item.quantity, 0);
      return affectedQuantity === 0 ? [] : [{
        packageId: shipmentPackage.id,
        status: shipmentPackage.carrierClaimStatus,
        updatedAt: shipmentPackage.carrierClaimUpdatedAt ?? shipmentPackage.updatedAt,
        affectedQuantity,
      }];
    });
    const outboundExceptions = matchingOutboundPackages.flatMap((shipmentPackage) => (
      shipmentPackage.logisticsExceptions.flatMap((exception) => {
        const affectedItems = exception.affectedItems.filter(({ shipmentPackageItemId }) => (
          shipmentPackageItemId !== undefined
          && caseSourceItemIds.has(shipmentPackageItemId)
        ));
        const affectedQuantity = affectedItems.reduce((total, item) => total + item.quantity, 0);
        return affectedQuantity === 0 ? [] : [{
          id: exception.id,
          stage: exception.stage,
          affectedQuantity,
          occurredAt: exception.occurredAt,
          requiresDecision: exception.stage === 'confirmed'
            && projectedCase.handlingDirection === 'waiting',
        }];
      })
    ));
    const target = {
      kind: 'aftersales_case' as const,
      shipmentRecordId: aftersalesCase.shipmentRecordId,
      aftersalesCaseId: aftersalesCase.id,
    };
    const hasActiveReplacement = shipmentRecords.some((record) => (
      record.sourceRole === 'replacement'
      && record.replacementAftersalesCaseId === aftersalesCase.id
      && record.status === 'active'
    ));
    const caseCoordination = coordinateAftersalesOrderOperations({
      id: aftersalesCase.id,
      shipmentRecordId: aftersalesCase.shipmentRecordId,
      status: aftersalesCase.status,
      currentTodo: aftersalesCase.currentTodo,
      updatedAt: aftersalesCase.updatedAt,
      itemQuantity: aftersalesCase.items.reduce((total, item) => total + item.quantity, 0),
      refund: aftersalesCase.refund ? {
        status: aftersalesCase.refund.status,
        requestedAmountCents: aftersalesCase.refund.requestedAmountCents,
        occurredAt: aftersalesCase.refund.occurredAt ?? aftersalesCase.occurredAt,
      } : null,
      outboundClaims,
      outboundExceptions,
      returns: aftersalesCase.returnPackages.map((returnPackage) => ({
        id: returnPackage.id,
        status: returnPackage.status,
        logisticsStatus: returnPackage.logisticsStatus,
        updatedAt: returnPackage.updatedAt,
        exceptions: returnPackage.logisticsExceptions.map((exception) => ({
          id: exception.id,
          exceptionType: exception.exceptionType,
          stage: exception.stage,
          affectedQuantity: exception.affectedQuantity,
          occurredAt: exception.occurredAt,
        })),
        claim: returnPackage.carrierClaimStatus ? {
          status: returnPackage.carrierClaimStatus,
          updatedAt: returnPackage.carrierClaimUpdatedAt ?? returnPackage.updatedAt,
          affectedQuantity: returnPackage.carrierClaimAffectedQuantity
            ?? returnPackage.items.reduce(
              (total, item) => total + item.plannedQuantity,
              0,
            ),
        } : null,
      })),
      hasPendingReturnExceptionDecision: projectedCase.hasPendingReturnExceptionDecision,
      suppressGenericTodo: (
        hasActiveReplacement
          && aftersalesCase.status === 'waiting_replacement'
      ) || outboundExceptions.some(({ stage }) => (
        isUnresolvedLogisticsExceptionStage(stage)
      )),
    });
    todoCandidates.push(...caseCoordination.todos);
    const sourceItemIds = new Set(aftersalesCase.items.map(({ shipmentPackageItemId }) => (
      shipmentPackageItemId
    )));
    const returnedQuantityByItemId = new Map<string, number>();
    for (const returnPackage of aftersalesCase.returnPackages) {
      for (const item of returnPackage.items) {
        returnedQuantityByItemId.set(
          item.shipmentPackageItemId,
          (returnedQuantityByItemId.get(item.shipmentPackageItemId) ?? 0)
            + item.receivedQuantity,
        );
      }
    }
    const confirmedLostQuantityByItemId = new Map<string, number>();
    const originallyReturnedItemIds = new Set<string>();
    for (const record of shipmentRecords) {
      if (record.sourceRole !== 'initial' || record.status !== 'active') continue;
      for (const shipmentPackage of record.packages) {
        if (shipmentPackage.status !== 'active') continue;
        if (shipmentPackage.logisticsStatus === 'returned') {
          for (const item of shipmentPackage.items) {
            if (sourceItemIds.has(item.shipmentPackageItemId)) {
              originallyReturnedItemIds.add(item.shipmentPackageItemId);
            }
          }
        }
        for (const exception of shipmentPackage.logisticsExceptions) {
          if (exception.exceptionType !== 'lost' || exception.stage !== 'confirmed') continue;
          for (const item of exception.affectedItems) {
            if (!item.shipmentPackageItemId || !sourceItemIds.has(item.shipmentPackageItemId)) {
              continue;
            }
            confirmedLostQuantityByItemId.set(
              item.shipmentPackageItemId,
              Math.max(
                confirmedLostQuantityByItemId.get(item.shipmentPackageItemId) ?? 0,
                item.quantity,
              ),
            );
          }
        }
      }
    }
    const outstandingItems = aftersalesCase.items.flatMap((item) => {
      const returnedQuantity = originallyReturnedItemIds.has(item.shipmentPackageItemId)
        ? item.quantity
        : returnedQuantityByItemId.get(item.shipmentPackageItemId) ?? 0;
      const confirmedLostQuantity = confirmedLostQuantityByItemId.get(
        item.shipmentPackageItemId,
      ) ?? 0;
      const quantity = Math.max(0, item.quantity - returnedQuantity - confirmedLostQuantity);
      return quantity === 0 ? [] : [{
        shipmentPackageItemId: item.shipmentPackageItemId,
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        quantity,
      }];
    });
    const outstandingQuantity = outstandingItems.reduce(
      (total, item) => total + item.quantity,
      0,
    );
    if (aftersalesCase.refund?.status === 'confirmed' && outstandingQuantity > 0) {
      const riskId = `refund-without-goods:${aftersalesCase.id}`;
      risks.push({
        id: riskId,
        kind: 'refund_without_goods',
        packageRole: 'original_outbound',
        affectedQuantity: outstandingQuantity,
        items: publicAffectedItems(outstandingItems),
        title: '退款后原商品未收回',
        detail: '资金已退出，原商品仍在承运方或买家控制中',
        occurredAt: aftersalesCase.refund.occurredAt ?? aftersalesCase.updatedAt,
        target,
      });
      todoCandidates.push({
        id: riskId,
        priority: 'physical_risk',
        title: '跟进收回原商品',
        detail: `已退款，仍需收回 ${outstandingQuantity} 件商品`,
        occurredAt: aftersalesCase.refund.occurredAt ?? aftersalesCase.updatedAt,
        target,
      });
    }
    const replacementWithoutReturnedGoods = outstandingQuantity > 0
      && (projectedCase.handlingDirection === 'replacement'
        || (projectedCase.workflow === 'exchange' && hasActiveReplacement));
    if (replacementWithoutReturnedGoods) {
      const riskId = `replacement-before-return:${aftersalesCase.id}`;
      risks.push({
        id: riskId,
        kind: 'replacement_before_return',
        packageRole: 'replacement',
        affectedQuantity: outstandingQuantity,
        items: publicAffectedItems(outstandingItems),
        title: hasActiveReplacement ? '原商品未退回已先补发' : '补发前原商品未收回',
        detail: hasActiveReplacement
          ? '补发与原商品退回分别跟踪，不猜测原商品已收回'
          : '原商品仍在承运方或买家控制中，补发可能造成重复交付',
        occurredAt: aftersalesCase.updatedAt,
        target,
      });
      todoCandidates.push({
        id: riskId,
        priority: 'physical_risk',
        title: hasActiveReplacement ? '跟进原商品退回' : '补发前确认原商品去向',
        detail: hasActiveReplacement
          ? `已先补发 ${outstandingQuantity} 件商品，原商品尚未退回`
          : `拟补发 ${outstandingQuantity} 件商品，原商品尚未收回`,
        occurredAt: aftersalesCase.updatedAt,
        target,
      });
    }
    facts.push({
      id: `aftersales:${aftersalesCase.id}`,
      kind: 'aftersales',
      label: '售后处理',
      value: aftersalesCase.status,
      detail: aftersalesCase.reason,
      affectedQuantity: aftersalesCase.items.reduce((total, item) => total + item.quantity, 0),
      occurredAt: aftersalesCase.updatedAt,
      target,
    });
    if (aftersalesCase.refund) {
      const refundOccurredAt = aftersalesCase.refund.occurredAt ?? aftersalesCase.occurredAt;
      facts.push({
        id: `refund:${aftersalesCase.id}`,
        kind: 'refund',
        label: '退款',
        value: aftersalesCase.refund.status,
        detail: aftersalesCase.refund.actualAmountCents === null
          ? `申请金额 ¥${(aftersalesCase.refund.requestedAmountCents / 100).toFixed(2)}`
          : `实际退款 ¥${(aftersalesCase.refund.actualAmountCents / 100).toFixed(2)}`,
        affectedQuantity: aftersalesCase.items.reduce(
          (total, item) => total + item.quantity,
          0,
        ),
        occurredAt: refundOccurredAt,
        target,
      });
    }
    for (const returnPackage of aftersalesCase.returnPackages) {
      const returnTarget = {
        ...target,
        returnRecordId: returnPackage.id,
      };
      const returnQuantity = returnPackage.items.reduce(
        (total, item) => total + item.plannedQuantity,
        0,
      );
      facts.push({
        id: `return-logistics:${returnPackage.id}`,
        kind: 'return_logistics',
        label: '退货物流',
        value: returnPackage.logisticsStatus,
        detail: [returnPackage.shippingCarrier, returnPackage.trackingNumber]
          .filter(Boolean).join(' · ') || '未填写退货物流信息',
        affectedQuantity: returnQuantity,
        occurredAt: returnPackage.updatedAt,
        target: returnTarget,
      });
      for (const exception of returnPackage.logisticsExceptions) {
        facts.push({
          id: `logistics-exception:${exception.id}`,
          kind: 'logistics_exception',
          label: '退货物流异常',
          value: exception.stage,
          detail: exception.reason,
          affectedQuantity: exception.affectedQuantity,
          occurredAt: exception.occurredAt,
          target: returnTarget,
        });
        if (isUnresolvedLogisticsExceptionStage(exception.stage)) {
          risks.push({
            id: `logistics-exception:${exception.id}`,
            kind: 'logistics_exception',
            packageRole: 'return',
            exceptionType: exception.exceptionType,
            affectedQuantity: exception.affectedQuantity,
            items: publicAffectedItems(exception.affectedItems),
            title: '退货物流异常',
            detail: exception.reason,
            occurredAt: exception.occurredAt,
            target: returnTarget,
          });
        }
      }
      if (returnPackage.carrierClaimStatus) {
        facts.push({
          id: `carrier-claim:return:${returnPackage.id}`,
          kind: 'carrier_claim',
          label: '承运索赔',
          value: returnPackage.carrierClaimStatus,
          detail: '退货物流承运索赔独立推进',
          affectedQuantity: returnPackage.carrierClaimAffectedQuantity ?? returnQuantity,
          occurredAt: returnPackage.carrierClaimUpdatedAt ?? returnPackage.updatedAt,
          target: returnTarget,
        });
      }
    }
  }
  const coordination = coordinateOrderOperations(todoCandidates);
  risks.sort((first, second) => Date.parse(second.occurredAt) - Date.parse(first.occurredAt));
  facts.sort((first, second) => Date.parse(second.occurredAt) - Date.parse(first.occurredAt));
  history.sort((first, second) => Date.parse(second.occurredAt) - Date.parse(first.occurredAt));
  return {
    shipmentRecords,
    aftersalesCases,
    currentTodo: coordination.primaryTodo?.title ?? aftersalesTodo
      ?? shipmentTodoForStatuses(logisticsStatuses, carrierClaimStatuses, hasUnresolvedLogisticsException),
    coordination,
    risks,
    facts,
    history,
    fulfillmentPlanAttribution,
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

function asFulfillmentPlanType(value: unknown): FulfillmentPlanType {
  if (!isFulfillmentPlanType(value)) throw new Error('数据库履约计划类型格式错误');
  return value;
}

function parseLogisticsExceptionType(value: unknown): LogisticsExceptionType {
  if (
    value === 'lost'
    || value === 'delivery_dispute'
    || value === 'damaged'
    || value === 'misdelivered'
    || value === 'other'
  ) return value;
  throw new Error('数据库物流异常类型投影格式错误');
}

function parseLogisticsExceptionStage(value: unknown): LogisticsExceptionStage {
  if (
    value === 'pending_verification'
    || value === 'investigating'
    || value === 'confirmed'
    || value === 'recovered'
    || value === 'resolved'
  ) return value;
  throw new Error('数据库物流异常阶段投影格式错误');
}

function asAftersalesStatus(value: unknown): AftersalesStatus {
  if (!isAftersalesStatus(value)) throw new Error('数据库售后状态格式错误');
  return value;
}

function parseAftersalesWorkflow(
  value: unknown,
): ProjectedAftersalesCase['workflow'] {
  if (
    value === 'general'
    || value === 'refund_only'
    || value === 'return_refund'
    || value === 'exchange'
    || value === 'direct_replacement'
  ) return value;
  throw new Error('数据库售后流程投影格式错误');
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

function affectedQuantityForImpact(
  impact: ReturnType<typeof parseProjectedLogisticsImpact>,
  visibleItemIds: ReadonlySet<string>,
  packageQuantity: number,
): number {
  return impact.scope === 'package'
    ? packageQuantity
    : impact.items
      .filter((item) => visibleItemIds.has(item.sourceItemId))
      .reduce((total, item) => total + item.quantity, 0);
}

function affectedItemsForImpact(
  impact: ReturnType<typeof parseProjectedLogisticsImpact>,
  visibleItems: readonly {
    sourceItemId: string;
    sourceTitle: string;
    sourceSpec: string;
    quantity: number;
  }[],
): Array<{
  shipmentPackageItemId: string;
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
}> {
  if (impact.scope === 'package') {
    return visibleItems.map(({ sourceItemId, sourceTitle, sourceSpec, quantity }) => ({
      shipmentPackageItemId: sourceItemId,
      sourceTitle,
      sourceSpec,
      quantity,
    }));
  }
  const quantityByItemId = new Map(impact.items.map(({ sourceItemId, quantity }) => (
    [sourceItemId, quantity] as const
  )));
  return visibleItems.flatMap(({ sourceItemId, sourceTitle, sourceSpec, quantity }) => {
    const affectedQuantity = quantityByItemId.get(sourceItemId);
    return affectedQuantity === undefined
      ? []
      : [{
        shipmentPackageItemId: sourceItemId,
        sourceTitle,
        sourceSpec,
        quantity: Math.min(quantity, affectedQuantity),
      }];
  });
}

function publicAffectedItems(
  items: readonly {
    sourceTitle: string;
    sourceSpec: string;
    quantity: number;
  }[],
): Array<{ sourceTitle: string; sourceSpec: string; quantity: number }> {
  return items.map(({ sourceTitle, sourceSpec, quantity }) => ({
    sourceTitle,
    sourceSpec,
    quantity,
  }));
}

function parseOptionalCarrierClaimStatus(value: unknown): CarrierClaimStatus | null {
  if (value === null) return null;
  if (value === 'pending' || value === 'approved' || value === 'rejected' || value === 'paid') {
    return value;
  }
  throw new Error('数据库承运索赔状态投影格式错误');
}

function parsePendingFinancialItemStatus(value: unknown): PendingFinancialItemStatus {
  if (value === 'pending' || value === 'confirmed' || value === 'cancelled') return value;
  throw new Error('数据库资金事项状态投影格式错误');
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

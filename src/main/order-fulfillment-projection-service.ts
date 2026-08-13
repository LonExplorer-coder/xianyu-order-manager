import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { FulfillmentStatus } from '../core/contracts';

export type ShipmentProjectedFulfillmentStatus = Extract<
  FulfillmentStatus,
  'pending_shipment' | 'partially_shipped' | 'shipped' | 'delivered'
>;

type OrderStatusRow = {
  fulfillment_status: string;
  revision: number;
};

type QuantityRow = {
  ordered_quantity: number;
  shipped_quantity: number;
};

type CountRow = { count: number };

export class OrderFulfillmentProjectionService {
  public constructor(private readonly database: DatabaseSync) {}

  public hasShipmentHistory(orderId: string): boolean {
    const replacementJoin = this.replacementJoin('packages', 'shipment_record_id');
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM shipment_package_items AS items
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      ${replacementJoin.sql}
      WHERE items.order_id = ? ${replacementJoin.condition}
    `).get(orderId) as CountRow;
    return row.count > 0;
  }

  public hasActiveShipmentQuantity(orderId: string): boolean {
    const replacementJoin = this.replacementJoin('records');
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM shipment_package_items AS items
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      JOIN shipment_records AS records ON records.id = packages.shipment_record_id
      LEFT JOIN shipment_package_cancellation_events AS cancellations
        ON cancellations.package_id = packages.id
      LEFT JOIN shipment_record_void_events AS voids
        ON voids.shipment_record_id = records.id
      ${replacementJoin.sql}
      WHERE items.order_id = ?
        AND cancellations.id IS NULL
        AND voids.id IS NULL
        ${replacementJoin.condition}
    `).get(orderId) as CountRow;
    return row.count > 0;
  }

  public project(orderId: string): ShipmentProjectedFulfillmentStatus {
    const replacementJoin = this.replacementJoin('records');
    const replacementPredicate = replacementJoin.enabled ? 'AND replacements.id IS NULL' : '';
    const quantities = this.database.prepare(`
      SELECT
        order_items.quantity AS ordered_quantity,
        COALESCE(SUM(CASE
          WHEN cancellations.id IS NULL AND voids.id IS NULL ${replacementPredicate}
            THEN shipment_items.quantity
          ELSE 0
        END), 0) AS shipped_quantity
      FROM order_items
      LEFT JOIN shipment_package_items AS shipment_items
        ON shipment_items.source_order_item_id = order_items.id
      LEFT JOIN shipment_packages AS packages ON packages.id = shipment_items.package_id
      LEFT JOIN shipment_records AS records ON records.id = packages.shipment_record_id
      LEFT JOIN shipment_package_cancellation_events AS cancellations
        ON cancellations.package_id = packages.id
      LEFT JOIN shipment_record_void_events AS voids
        ON voids.shipment_record_id = records.id
      ${replacementJoin.sql}
      WHERE order_items.order_id = ?
      GROUP BY order_items.id, order_items.position, order_items.quantity
      ORDER BY order_items.position, order_items.id
    `).all(orderId) as unknown as QuantityRow[];
    const totalShipped = quantities.reduce(
      (total, item) => total + item.shipped_quantity,
      0,
    );
    if (totalShipped === 0) return 'pending_shipment';
    if (quantities.some((item) => item.shipped_quantity < item.ordered_quantity)) {
      return 'partially_shipped';
    }
    const packageCounts = this.database.prepare(`
      SELECT
        COUNT(DISTINCT packages.id) AS package_count,
        COUNT(DISTINCT CASE
          WHEN packages.logistics_status = 'delivered' THEN packages.id
          ELSE NULL
        END) AS delivered_count
      FROM shipment_package_items AS items
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      JOIN shipment_records AS records ON records.id = packages.shipment_record_id
      LEFT JOIN shipment_package_cancellation_events AS cancellations
        ON cancellations.package_id = packages.id
      LEFT JOIN shipment_record_void_events AS voids
        ON voids.shipment_record_id = records.id
      ${replacementJoin.sql}
      WHERE items.order_id = ?
        AND cancellations.id IS NULL
        AND voids.id IS NULL
        ${replacementJoin.condition}
    `).get(orderId) as { package_count: number; delivered_count: number };
    return packageCounts.package_count > 0
      && packageCounts.delivered_count === packageCounts.package_count
      ? 'delivered'
      : 'shipped';
  }

  public synchronize(orderId: string, now: string): boolean {
    const current = this.database.prepare(`
      SELECT fulfillment_status, revision
      FROM original_orders
      WHERE id = ?
    `).get(orderId) as OrderStatusRow | undefined;
    if (!current) throw new Error('订单不存在');
    const currentStatus = current.fulfillment_status as FulfillmentStatus;
    const nextStatus = this.project(orderId);
    if (currentStatus === nextStatus) return false;
    const updated = this.database.prepare(`
      UPDATE original_orders
      SET fulfillment_status = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(nextStatus, now, orderId, current.revision);
    if (updated.changes !== 1) {
      throw new Error('订单已在其他操作中更新，请刷新后重试');
    }
    const eventId = randomUUID();
    this.database.prepare(`
      INSERT INTO order_change_events (
        id, order_id, source_snapshot_id, source,
        base_revision, result_revision, created_at
      ) VALUES (?, ?, NULL, 'shipment_sync', ?, ?, ?)
    `).run(eventId, orderId, current.revision, current.revision + 1, now);
    this.database.prepare(`
      INSERT INTO order_field_changes (
        id, event_id, field_path, before_json, after_json
      ) VALUES (?, ?, 'fulfillmentStatus', ?, ?)
    `).run(
      randomUUID(),
      eventId,
      JSON.stringify(currentStatus),
      JSON.stringify(nextStatus),
    );
    return true;
  }

  private replacementJoin(
    recordAlias: 'packages' | 'records',
    recordIdColumn: 'id' | 'shipment_record_id' = 'id',
  ): {
    enabled: boolean;
    sql: string;
    condition: string;
  } {
    const enabled = Boolean(this.database.prepare(`
      SELECT 1 FROM sqlite_schema
      WHERE type = 'table' AND name = 'aftersales_replacement_shipments'
    `).get());
    if (!enabled) return { enabled, sql: '', condition: '' };
    return {
      enabled,
      sql: `LEFT JOIN aftersales_replacement_shipments AS replacements
        ON replacements.shipment_record_id = ${recordAlias}.${recordIdColumn}`,
      condition: 'AND replacements.id IS NULL',
    };
  }

  public synchronizeExistingShipmentOrders(now: string): void {
    const rows = this.database.prepare(`
      SELECT DISTINCT order_id
      FROM shipment_package_items
      ORDER BY order_id
    `).all() as unknown as Array<{ order_id: string }>;
    for (const row of rows) this.synchronize(row.order_id, now);
  }
}

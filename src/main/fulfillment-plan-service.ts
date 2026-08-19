import { randomUUID } from 'node:crypto';

import {
  fulfillmentPlanStatusAfterRelease,
  normalizeAddFulfillmentPlanOrdersInput,
  normalizeCloseFulfillmentPlanInput,
  normalizeConfirmGroupFormationInput,
  normalizeCreateFulfillmentPlanInput,
  normalizeFulfillmentPlanId,
  normalizeFulfillmentPlanQuery,
  normalizeReleaseFulfillmentPlanOrdersInput,
  normalizeRemoveFulfillmentPlanOrderInput,
  normalizeUpdateFulfillmentPlanInput,
  type FulfillmentPlanEventType,
  type FulfillmentPlanEventView,
  type FulfillmentPlanMemberView,
  type FulfillmentPlanProgressOrder,
  type FulfillmentPlanProgressView,
  type FulfillmentPlanStatus,
  type FulfillmentPlanType,
  type FulfillmentPlanView,
  type GroupFormationBasis,
} from '../core/fulfillment-plans';
import { InventoryLedgerService } from './inventory-ledger-service';
import { OrderOperationsProjectionService } from './order-operations-projection-service';
import { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

export class FulfillmentPlanService {
  public constructor(private readonly workspace: Workspace) {}

  public query(input?: unknown): FulfillmentPlanView[] {
    const query = normalizeFulfillmentPlanQuery(input);
    const where: string[] = [];
    const parameters: string[] = [];
    if (query.type) {
      where.push('type = ?');
      parameters.push(query.type);
    }
    if (query.status) {
      where.push('status = ?');
      parameters.push(query.status);
    }
    const rows = this.workspace.database.prepare(`
      SELECT id, type, name, status, expected_ship_at, target_quantity, deadline_at,
        demand_alert_threshold, formed_at, revision, created_at, updated_at, closed_at
      FROM fulfillment_plans
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at, id
    `).all(...parameters) as unknown as SqlRow[];
    return rows.map((row) => this.planView(row));
  }

  public progress(input: unknown): FulfillmentPlanProgressView {
    const planId = normalizeFulfillmentPlanId(input);
    this.requirePlanRow(planId);
    const memberRows = this.workspace.database.prepare(`
      SELECT id, order_id, joined_at, join_reason,
        released_at, released_reason, removed_at, removed_reason
      FROM fulfillment_plan_members
      WHERE plan_id = ? AND released_at IS NOT NULL AND removed_at IS NULL
      ORDER BY joined_at, id
    `).all(planId) as unknown as SqlRow[];
    const members = memberRows.map((row) => this.memberView(row));
    const projections = new OrderOperationsProjectionService(this.workspace.database)
      .getOverviewMany(members.map((member) => member.orderId));
    const orders: FulfillmentPlanProgressOrder[] = members.map((member) => {
      const shipments = (projections.get(member.orderId)?.shipmentRecords ?? [])
        .filter((record) => record.status === 'active')
        .map((record) => ({
          recordId: record.id,
          createdAt: record.createdAt,
          packages: record.packages
            .filter((shipmentPackage) => shipmentPackage.status === 'active')
            .map((shipmentPackage) => ({
              id: shipmentPackage.id,
              shippingCarrier: shipmentPackage.shippingCarrier,
              trackingNumber: shipmentPackage.trackingNumber,
              logisticsStatus: shipmentPackage.logisticsStatus,
              items: shipmentPackage.items.map((item) => ({
                sourceTitle: item.sourceTitle,
                sourceSpec: item.sourceSpec,
                quantity: item.quantity,
              })),
            })),
        }))
        .filter((shipment) => shipment.packages.length > 0)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return {
        orderId: member.orderId,
        systemOrderNumber: member.systemOrderNumber,
        buyerNickname: member.buyerNickname,
        items: member.items,
        releasedAt: member.releasedAt ?? '',
        releasedReason: member.releasedReason ?? '',
        shipments,
      };
    });
    return { planId, orders };
  }

  public create(input: unknown): FulfillmentPlanView {
    const prepared = normalizeCreateFulfillmentPlanInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.workspace.database.prepare(`
        INSERT INTO fulfillment_plans (
          id, type, name, status, expected_ship_at, target_quantity, deadline_at,
          demand_alert_threshold, formed_at, revision, created_at, updated_at, closed_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, 1, ?, ?, NULL)
      `).run(
        id,
        prepared.type,
        prepared.name,
        prepared.expectedShipAt,
        prepared.targetQuantity,
        prepared.deadlineAt,
        prepared.demandAlertThreshold,
        now,
        now,
      );
      this.recordEvent(id, null, 'created', prepared.reason, [], now);
    });
    return this.planView(this.requirePlanRow(id));
  }

  public addOrders(input: unknown): FulfillmentPlanView {
    const prepared = normalizeAddFulfillmentPlanOrdersInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const plan = this.requirePlanRow(prepared.planId);
      this.assertRevision(plan, prepared.expectedRevision);
      this.assertPlanOpen(plan, '加入订单');
      this.assertGroupBuyNotFormed(plan, '加入订单');
      for (const orderId of prepared.orderIds) {
        this.assertOrderCanJoin(orderId, prepared.planId);
        this.workspace.database.prepare(`
          INSERT INTO fulfillment_plan_members (
            id, plan_id, order_id, joined_at, join_reason
          ) VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), prepared.planId, orderId, now, prepared.reason);
      }
      this.recordEvent(
        prepared.planId,
        null,
        'orders_added',
        prepared.reason,
        prepared.orderIds,
        now,
      );
      this.bumpRevision(prepared.planId, now);
    });
    return this.planView(this.requirePlanRow(prepared.planId));
  }

  public removeOrder(input: unknown): FulfillmentPlanView {
    const prepared = normalizeRemoveFulfillmentPlanOrderInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const plan = this.requirePlanRow(prepared.planId);
      this.assertRevision(plan, prepared.expectedRevision);
      this.assertPlanOpen(plan, '退出订单');
      const member = this.activeMemberRow(prepared.planId, prepared.orderId);
      if (!member) throw new Error('订单不在该履约计划中');
      this.workspace.database.prepare(`
        UPDATE fulfillment_plan_members
        SET removed_at = ?, removed_reason = ?
        WHERE id = ?
      `).run(now, prepared.reason, asString(member.id));
      this.recordEvent(
        prepared.planId,
        prepared.orderId,
        'order_removed',
        prepared.reason,
        [prepared.orderId],
        now,
      );
      this.bumpRevision(prepared.planId, now);
    });
    return this.planView(this.requirePlanRow(prepared.planId));
  }

  public releaseOrders(input: unknown): FulfillmentPlanView {
    const prepared = normalizeReleaseFulfillmentPlanOrdersInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const plan = this.requirePlanRow(prepared.planId);
      this.assertRevision(plan, prepared.expectedRevision);
      const status = asString(plan.status) as FulfillmentPlanStatus;
      if (status === 'closed') throw new Error('履约计划已关闭，不能释放订单');
      if (status === 'released') throw new Error('履约计划已全部释放');
      this.assertGroupBuyFormed(plan, '释放订单');
      const activeMembers = this.activeMemberRows(prepared.planId);
      const activeOrderIds = new Set(activeMembers.map((row) => asString(row.order_id)));
      const releasingIds = prepared.orderIds ?? [...activeOrderIds];
      for (const orderId of releasingIds) {
        if (!activeOrderIds.has(orderId)) throw new Error('订单不在该履约计划中');
      }
      const releasingStatusById = new Map(activeMembers.map((row) => [
        asString(row.order_id),
        asString(row.platform_transaction_status),
      ]));
      if (releasingIds.some((orderId) => (
        ['cancelled', 'refunded'].includes(releasingStatusById.get(orderId) ?? '')
      ))) {
        throw new Error('已取消或退款的订单不能释放，请先将其退出计划');
      }
      // 预留即占用：释放前核对可用现货（可销售 − 已预留，未释放成员不占预留）。
      // 不足默认拒绝、可勾选知悉风险强制放行；已超卖（可用为负）时硬拦不放行，
      // 补货前不新增任何占用（ADR 0041）。
      const gate = this.stockShortageForRelease(releasingIds);
      if (gate.oversold.length > 0) {
        throw new Error(
          `已超卖：${gate.oversold.join('、')}；补货前不能释放，超卖状态下不能强制释放`,
        );
      }
      if (gate.shortage.length > 0 && !prepared.acknowledgeStockShortageRisk) {
        throw new Error(
          `可用现货不足：${gate.shortage.join('、')}；可补货或到货后释放，或勾选知悉缺货风险强制释放`,
        );
      }
      const nextStatus = fulfillmentPlanStatusAfterRelease(
        activeMembers.length,
        releasingIds.length,
      );
      const update = this.workspace.database.prepare(`
        UPDATE fulfillment_plan_members
        SET released_at = ?, released_reason = ?
        WHERE plan_id = ? AND order_id = ? AND released_at IS NULL AND removed_at IS NULL
      `);
      for (const orderId of releasingIds) update.run(now, prepared.reason, prepared.planId, orderId);
      this.workspace.database.prepare(`
        UPDATE fulfillment_plans SET status = ? WHERE id = ?
      `).run(nextStatus, prepared.planId);
      this.recordEvent(
        prepared.planId,
        null,
        'orders_released',
        prepared.reason,
        releasingIds,
        now,
        null,
        null,
        gate.shortage.length > 0,
      );
      this.bumpRevision(prepared.planId, now);
    });
    return this.planView(this.requirePlanRow(prepared.planId));
  }

  public update(input: unknown): FulfillmentPlanView {
    const prepared = normalizeUpdateFulfillmentPlanInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const plan = this.requirePlanRow(prepared.planId);
      this.assertRevision(plan, prepared.expectedRevision);
      this.assertPlanOpen(plan, '更新');
      const assignments: string[] = [];
      const parameters: Array<string | number | null> = [];
      if (prepared.name !== null) {
        assignments.push('name = ?');
        parameters.push(prepared.name);
      }
      if (prepared.expectedShipAt !== null) {
        assignments.push('expected_ship_at = ?');
        parameters.push(prepared.expectedShipAt);
      }
      if (prepared.targetQuantity !== null) {
        assignments.push('target_quantity = ?');
        parameters.push(prepared.targetQuantity);
      }
      if (prepared.deadlineAt !== null) {
        assignments.push('deadline_at = ?');
        parameters.push(prepared.deadlineAt);
      }
      if (prepared.demandAlertThreshold !== null) {
        assignments.push('demand_alert_threshold = ?');
        parameters.push(prepared.demandAlertThreshold);
      }
      const eventType: FulfillmentPlanEventType = prepared.markDelayed ? 'delayed' : 'updated';
      if (prepared.markDelayed) {
        assignments.push("status = 'delayed'");
      }
      this.workspace.database.prepare(`
        UPDATE fulfillment_plans SET ${assignments.join(', ')} WHERE id = ?
      `).run(...parameters, prepared.planId);
      this.recordEvent(prepared.planId, null, eventType, prepared.reason, [], now);
      this.bumpRevision(prepared.planId, now);
    });
    return this.planView(this.requirePlanRow(prepared.planId));
  }

  public confirmFormation(input: unknown): FulfillmentPlanView {
    const prepared = normalizeConfirmGroupFormationInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const plan = this.requirePlanRow(prepared.planId);
      this.assertRevision(plan, prepared.expectedRevision);
      this.assertPlanOpen(plan, '确认成团');
      if (asString(plan.type) !== 'group_buy') throw new Error('只有团购计划可以确认成团');
      if (plan.formed_at !== null) throw new Error('该团购计划已确认成团');
      if (prepared.basis === 'quantity') {
        const targetQuantity = plan.target_quantity;
        if (typeof targetQuantity !== 'number'
          || this.activeItemQuantity(prepared.planId) < targetQuantity) {
          throw new Error('活跃件数尚未达到成团数量，不能按已达成团数量确认');
        }
      }
      if (prepared.basis === 'deadline') {
        const deadlineAt = plan.deadline_at;
        if (typeof deadlineAt !== 'string' || now < deadlineAt) {
          throw new Error('尚未到达团购截止时间，不能按已到截止时间确认');
        }
      }
      this.workspace.database.prepare(`
        UPDATE fulfillment_plans SET formed_at = ? WHERE id = ?
      `).run(now, prepared.planId);
      this.recordEvent(
        prepared.planId,
        null,
        'formed',
        prepared.reason,
        [],
        now,
        prepared.basis,
        this.activeItemQuantity(prepared.planId),
      );
      this.bumpRevision(prepared.planId, now);
    });
    return this.planView(this.requirePlanRow(prepared.planId));
  }

  public close(input: unknown): FulfillmentPlanView {
    const prepared = normalizeCloseFulfillmentPlanInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const plan = this.requirePlanRow(prepared.planId);
      this.assertRevision(plan, prepared.expectedRevision);
      const status = asString(plan.status) as FulfillmentPlanStatus;
      if (status === 'closed') throw new Error('履约计划已关闭');
      const unformedGroupBuy = asString(plan.type) === 'group_buy'
        && plan.formed_at === null;
      const freedOrderIds = unformedGroupBuy
        ? []
        : this.activeMemberRows(prepared.planId).map((row) => asString(row.order_id));
      if (!unformedGroupBuy && freedOrderIds.length > 0) {
        this.workspace.database.prepare(`
          UPDATE fulfillment_plan_members
          SET removed_at = ?, removed_reason = ?
          WHERE plan_id = ? AND released_at IS NULL AND removed_at IS NULL
        `).run(now, prepared.reason, prepared.planId);
      }
      this.workspace.database.prepare(`
        UPDATE fulfillment_plans SET status = 'closed', closed_at = ? WHERE id = ?
      `).run(now, prepared.planId);
      this.recordEvent(
        prepared.planId,
        null,
        'closed',
        prepared.reason,
        unformedGroupBuy ? [] : freedOrderIds,
        now,
      );
      this.bumpRevision(prepared.planId, now);
    });
    return this.planView(this.requirePlanRow(prepared.planId));
  }

  private planView(plan: SqlRow): FulfillmentPlanView {
    const planId = asString(plan.id);
    const memberRows = this.workspace.database.prepare(`
      SELECT id, order_id, joined_at, join_reason,
        released_at, released_reason, removed_at, removed_reason
      FROM fulfillment_plan_members
      WHERE plan_id = ?
      ORDER BY joined_at, id
    `).all(planId) as unknown as SqlRow[];
    const members = memberRows.map((row) => this.memberView(row));
    const activeMembers = members.filter((member) => (
      member.releasedAt === null && member.removedAt === null
    ));
    const eventRows = this.workspace.database.prepare(`
      SELECT id, order_id, event_type, reason, payload_json, occurred_at, created_at
      FROM fulfillment_plan_events
      WHERE plan_id = ?
      ORDER BY sequence
    `).all(planId) as unknown as SqlRow[];
    const events: FulfillmentPlanEventView[] = eventRows.map((row) => ({
      id: asString(row.id),
      planId,
      orderId: row.order_id === null ? null : asString(row.order_id),
      eventType: asString(row.event_type) as FulfillmentPlanEventType,
      reason: asString(row.reason),
      orderIds: parseStoredOrderIds(asString(row.payload_json)),
      basis: parseStoredFormationBasis(asString(row.payload_json)),
      stockShortageAcknowledged: parseStoredStockShortageFlag(asString(row.payload_json)),
      occurredAt: asString(row.occurred_at),
      createdAt: asString(row.created_at),
    }));
    return {
      id: planId,
      type: asString(plan.type) as FulfillmentPlanType,
      name: asString(plan.name),
      status: asString(plan.status) as FulfillmentPlanStatus,
      expectedShipAt: plan.expected_ship_at === null ? null : asString(plan.expected_ship_at),
      targetQuantity: typeof plan.target_quantity === 'number' ? plan.target_quantity : null,
      deadlineAt: plan.deadline_at === null ? null : asString(plan.deadline_at),
      demandAlertThreshold: typeof plan.demand_alert_threshold === 'number'
        ? Number(plan.demand_alert_threshold)
        : null,
      formedAt: plan.formed_at === null ? null : asString(plan.formed_at),
      revision: Number(plan.revision),
      createdAt: asString(plan.created_at),
      updatedAt: asString(plan.updated_at),
      closedAt: plan.closed_at === null ? null : asString(plan.closed_at),
      members,
      events,
      activeOrderCount: activeMembers.length,
      activeItemQuantity: activeMembers.reduce(
        (total, member) => total + member.items.reduce((sum, item) => sum + item.quantity, 0),
        0,
      ),
      releasedOrderCount: members.filter((member) => member.releasedAt !== null).length,
    };
  }

  private memberView(row: SqlRow): FulfillmentPlanMemberView {
    const orderId = asString(row.order_id);
    const order = this.workspace.database.prepare(`
      SELECT system_order_number, platform_order_number, buyer_nickname,
        platform_transaction_status
      FROM original_orders
      WHERE id = ?
    `).get(orderId) as SqlRow | undefined;
    const itemRows = this.workspace.database.prepare(`
      SELECT id, source_title, source_spec, quantity
      FROM order_items
      WHERE order_id = ?
      ORDER BY position
    `).all(orderId) as unknown as SqlRow[];
    return {
      orderId,
      systemOrderNumber: order ? asString(order.system_order_number) : '',
      platformOrderNumber: order ? asString(order.platform_order_number) : '',
      buyerNickname: order ? asString(order.buyer_nickname) : '',
      platformTransactionStatus: order ? asString(order.platform_transaction_status) : '',
      joinedAt: asString(row.joined_at),
      joinReason: asString(row.join_reason),
      releasedAt: row.released_at === null ? null : asString(row.released_at),
      releasedReason: row.released_reason === null ? null : asString(row.released_reason),
      removedAt: row.removed_at === null ? null : asString(row.removed_at),
      removedReason: row.removed_reason === null ? null : asString(row.removed_reason),
      items: itemRows.map((item) => ({
        itemId: asString(item.id),
        sourceTitle: asString(item.source_title),
        sourceSpec: asString(item.source_spec),
        quantity: Number(item.quantity),
      })),
    };
  }

  private requirePlanRow(planId: string): SqlRow {
    const row = this.workspace.database.prepare(`
      SELECT id, type, name, status, expected_ship_at, target_quantity, deadline_at,
        demand_alert_threshold, formed_at, revision, created_at, updated_at, closed_at
      FROM fulfillment_plans
      WHERE id = ?
    `).get(planId) as SqlRow | undefined;
    if (!row) throw new Error('未找到履约计划');
    return row;
  }

  private activeItemQuantity(planId: string): number {
    const row = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(items.quantity), 0) AS total
      FROM order_items AS items
      JOIN fulfillment_plan_members AS members ON members.order_id = items.order_id
      WHERE members.plan_id = ? AND members.released_at IS NULL AND members.removed_at IS NULL
    `).get(planId) as SqlRow | undefined;
    return Number(row?.total ?? 0);
  }

  private activeMemberRow(planId: string, orderId: string): SqlRow | undefined {
    return this.workspace.database.prepare(`
      SELECT id FROM fulfillment_plan_members
      WHERE plan_id = ? AND order_id = ? AND released_at IS NULL AND removed_at IS NULL
    `).get(planId, orderId) as SqlRow | undefined;
  }

  // 返回本次释放的核对结果：shortage 为可用现货不足的商品（可强制放行），
  // oversold 为已超卖的商品（硬拦）；两者皆空表示可用现货足以覆盖本次释放。
  private stockShortageForRelease(releasingOrderIds: readonly string[]): {
    shortage: string[];
    oversold: string[];
  } {
    if (releasingOrderIds.length === 0) return { shortage: [], oversold: [] };
    const ledger = new InventoryLedgerService(this.workspace);
    const stock = ledger.stockQuantitiesByProduct();
    const reserved = ledger.reservedQuantitiesByProduct();
    const availableByProduct = new Map<string, number>();
    for (const [productId, quantities] of stock) {
      availableByProduct.set(
        productId,
        quantities.sellable - (reserved.get(productId) ?? 0),
      );
    }
    const placeholders = releasingOrderIds.map(() => '?').join(', ');
    const itemRows = this.workspace.database.prepare(`
      SELECT oi.standard_product_id AS product_id, oi.id AS item_id, oi.quantity,
        p.sku, p.name, p.specification
      FROM order_items oi
      JOIN standard_products p ON p.id = oi.standard_product_id
      WHERE oi.order_id IN (${placeholders})
    `).all(...releasingOrderIds) as unknown as SqlRow[];
    const refundRows = this.workspace.database.prepare(`
      SELECT order_item_id, SUM(quantity) AS refunded
      FROM fulfillment_refund_events
      GROUP BY order_item_id
    `).all() as unknown as Array<{ order_item_id: string; refunded: number }>;
    const refundedByItem = new Map(refundRows.map((row) => [
      row.order_item_id,
      Number(row.refunded),
    ]));
    const demandByProduct = new Map<string, number>();
    for (const row of itemRows) {
      const productId = asString(row.product_id);
      const net = Number(row.quantity) - (refundedByItem.get(asString(row.item_id)) ?? 0);
      if (net <= 0) continue;
      demandByProduct.set(productId, (demandByProduct.get(productId) ?? 0) + net);
    }
    const shortage: string[] = [];
    const oversold: string[] = [];
    for (const [productId, demand] of demandByProduct) {
      const available = availableByProduct.get(productId) ?? 0;
      if (demand <= available) continue;
      const item = itemRows.find((row) => asString(row.product_id) === productId)!;
      const spec = asString(item.specification);
      const label = `${asString(item.name)}（${spec}）`;
      if (available < 0) {
        oversold.push(
          `${label}待发货占用已超过可销售 ${-available} 件（本次释放还需补货 ${demand - available} 件）`,
        );
        continue;
      }
      shortage.push(`${label}还差 ${demand - available} 件`);
    }
    return { shortage, oversold };
  }

  private activeMemberRows(planId: string): SqlRow[] {
    return this.workspace.database.prepare(`
      SELECT members.id, members.order_id, orders.platform_transaction_status
      FROM fulfillment_plan_members AS members
      JOIN original_orders AS orders ON orders.id = members.order_id
      WHERE members.plan_id = ? AND members.released_at IS NULL AND members.removed_at IS NULL
      ORDER BY members.joined_at, members.id
    `).all(planId) as unknown as SqlRow[];
  }

  private assertRevision(plan: SqlRow, expectedRevision: number): void {
    if (Number(plan.revision) !== expectedRevision) {
      throw new Error('履约计划已被更新，请刷新后重试');
    }
  }

  private assertPlanOpen(plan: SqlRow, action: string): void {
    const status = asString(plan.status) as FulfillmentPlanStatus;
    if (status === 'closed') throw new Error(`履约计划已关闭，不能${action}`);
    if (status === 'released') throw new Error(`履约计划已全部释放，不能${action}`);
  }

  private assertGroupBuyNotFormed(plan: SqlRow, action: string): void {
    if (asString(plan.type) === 'group_buy' && plan.formed_at !== null) {
      throw new Error(`团购已成团，成员已锁定，不能${action}`);
    }
  }

  private assertGroupBuyFormed(plan: SqlRow, action: string): void {
    if (asString(plan.type) === 'group_buy' && plan.formed_at === null) {
      throw new Error(`团购计划需先确认成团才能${action}`);
    }
  }

  private assertOrderCanJoin(orderId: string, planId: string): void {
    const order = this.workspace.database.prepare(`
      SELECT fulfillment_status, lifecycle_status, platform_transaction_status
      FROM original_orders
      WHERE id = ?
    `).get(orderId) as SqlRow | undefined;
    if (!order) throw new Error('未找到订单');
    if (asString(order.lifecycle_status) !== 'active'
      || ['cancelled', 'refunded'].includes(asString(order.platform_transaction_status))) {
      throw new Error('已取消或退款的订单不能加入履约计划');
    }
    if (asString(order.fulfillment_status) !== 'pending_shipment') {
      throw new Error('只有待发货订单可以加入履约计划');
    }
    const membership = this.workspace.database.prepare(`
      SELECT plan_id FROM fulfillment_plan_members
      WHERE order_id = ? AND released_at IS NULL AND removed_at IS NULL
    `).get(orderId) as SqlRow | undefined;
    if (membership) {
      throw new Error(
        asString(membership.plan_id) === planId
          ? '订单已在该履约计划中'
          : '订单已归属其他未释放履约计划',
      );
    }
    const releasedMembership = this.workspace.database.prepare(`
      SELECT 1 AS found FROM fulfillment_plan_members
      WHERE order_id = ? AND released_at IS NOT NULL
    `).get(orderId) as SqlRow | undefined;
    if (releasedMembership) {
      throw new Error('订单已被履约计划释放，不能再加入新计划');
    }
  }

  private recordEvent(
    planId: string,
    orderId: string | null,
    eventType: FulfillmentPlanEventType,
    reason: string,
    orderIds: readonly string[],
    now: string,
    basis: GroupFormationBasis | null = null,
    activeItemQuantity: number | null = null,
    stockShortageAcknowledged = false,
  ): void {
    const payload: Record<string, unknown> = { orderIds: [...orderIds] };
    if (basis !== null) payload.basis = basis;
    if (activeItemQuantity !== null) payload.activeItemQuantity = activeItemQuantity;
    if (stockShortageAcknowledged) payload.stockShortageAcknowledged = true;
    this.workspace.database.prepare(`
      INSERT INTO fulfillment_plan_events (
        id, plan_id, order_id, event_type, reason, payload_json, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      planId,
      orderId,
      eventType,
      reason,
      JSON.stringify(payload),
      now,
      now,
    );
  }

  private bumpRevision(planId: string, now: string): void {
    this.workspace.database.prepare(`
      UPDATE fulfillment_plans SET revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(now, planId);
  }
}

function asString(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function parseStoredOrderIds(payloadJson: string): string[] {
  try {
    const parsed = JSON.parse(payloadJson) as { orderIds?: unknown };
    return Array.isArray(parsed.orderIds)
      ? parsed.orderIds.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseStoredStockShortageFlag(payloadJson: string): boolean {
  try {
    const parsed = JSON.parse(payloadJson) as { stockShortageAcknowledged?: unknown };
    return parsed.stockShortageAcknowledged === true;
  } catch {
    return false;
  }
}

function parseStoredFormationBasis(payloadJson: string): GroupFormationBasis | null {
  try {
    const parsed = JSON.parse(payloadJson) as { basis?: unknown };
    if (parsed.basis === 'quantity' || parsed.basis === 'deadline'
      || parsed.basis === 'early') {
      return parsed.basis;
    }
    return null;
  } catch {
    return null;
  }
}

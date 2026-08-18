import { randomUUID } from 'node:crypto';

import { normalizeFulfillmentPlanId } from '../core/fulfillment-plans';
import {
  normalizeCreatePurchaseSuggestionInput,
  normalizePurchaseSuggestionActionInput,
  normalizeRegisterFulfillmentRefundInput,
  type FulfillmentDemandProductView,
  type FulfillmentDemandTotals,
  type FulfillmentDemandUnmappedView,
  type FulfillmentDemandView,
  type PurchaseSuggestionEventType,
  type PurchaseSuggestionStatus,
  type PurchaseSuggestionView,
} from '../core/fulfillment-demand';
import { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

export class FulfillmentDemandService {
  public constructor(private readonly workspace: Workspace) {}

  public demand(planIdInput: unknown): FulfillmentDemandView {
    return this.buildDemandView(this.requireDemandPlan(
      normalizeFulfillmentPlanId(planIdInput),
    ));
  }

  public registerRefund(input: unknown): FulfillmentDemandView {
    const prepared = normalizeRegisterFulfillmentRefundInput(input);
    const now = new Date().toISOString();
    const plan = this.requireDemandPlan(prepared.planId);
    this.assertPlanOpen(plan.status as string, '登记发货前退款');
    this.workspace.transaction(() => {
      const member = this.workspace.database.prepare(`
        SELECT id FROM fulfillment_plan_members
        WHERE plan_id = ? AND order_id = ? AND released_at IS NULL AND removed_at IS NULL
      `).get(prepared.planId, prepared.orderId) as SqlRow | undefined;
      if (!member) throw new Error('订单不是该履约计划的未释放成员');
      const order = this.workspace.database.prepare(`
        SELECT lifecycle_status, platform_transaction_status
        FROM original_orders WHERE id = ?
      `).get(prepared.orderId) as SqlRow | undefined;
      if (!order) throw new Error('未找到订单');
      if (asString(order.lifecycle_status) !== 'active') {
        throw new Error('订单不在正常生命周期，不能登记发货前退款');
      }
      const transactionStatus = asString(order.platform_transaction_status);
      if (transactionStatus === 'refunded') {
        throw new Error('订单已是整单退款状态，无需再登记商品级退款');
      }
      if (transactionStatus === 'cancelled') {
        throw new Error('订单已取消，需求已整体剔除，无需登记退款');
      }
      const item = this.workspace.database.prepare(`
        SELECT id, order_id, quantity, standard_product_id
        FROM order_items WHERE id = ?
      `).get(prepared.orderItemId) as SqlRow | undefined;
      if (!item || asString(item.order_id) !== prepared.orderId) {
        throw new Error('订单商品不存在或不属于该订单');
      }
      const refundedRow = this.workspace.database.prepare(`
        SELECT COALESCE(SUM(quantity), 0) AS refunded FROM fulfillment_refund_events
        WHERE order_item_id = ?
      `).get(prepared.orderItemId) as SqlRow;
      const refunded = Number(refundedRow?.refunded ?? 0);
      const itemQuantity = Number(item.quantity);
      if (refunded + prepared.quantity > itemQuantity) {
        throw new Error(`退款数量超过该商品剩余可退数量（还可退 ${itemQuantity - refunded} 件）`);
      }
      this.workspace.database.prepare(`
        INSERT INTO fulfillment_refund_events (
          id, plan_id, order_id, order_item_id, quantity, reason, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        prepared.planId,
        prepared.orderId,
        prepared.orderItemId,
        prepared.quantity,
        prepared.reason,
        now,
        now,
      );
      const productId = item.standard_product_id === null
        ? null
        : asString(item.standard_product_id);
      if (productId) {
        this.reduceDraftSuggestions(
          prepared.planId,
          [productId],
          `发货前退款后重算未确认建议：${prepared.reason}`,
          now,
        );
      }
    });
    return this.buildDemandView(plan);
  }

  public createSuggestion(input: unknown): FulfillmentDemandView {
    const prepared = normalizeCreatePurchaseSuggestionInput(input);
    const now = new Date().toISOString();
    const plan = this.requireDemandPlan(prepared.planId);
    this.assertPlanOpen(asString(plan.status), '创建采购建议');
    const conditional = this.isConditionalPlan(plan);
    if (conditional && !prepared.acknowledgeUnformedRisk) {
      throw new Error('未成团计划的需求只用于预测，提前采购需勾选确认未成团库存风险');
    }
    this.workspace.transaction(() => {
      const product = this.workspace.database.prepare(`
        SELECT id FROM standard_products WHERE id = ?
      `).get(prepared.standardProductId) as SqlRow | undefined;
      if (!product) throw new Error('未找到标准商品');
      const snapshot = this.productDemandSnapshot(prepared.planId, prepared.standardProductId);
      const suggestionCapacity = Math.max(
        0,
        snapshot.uncoveredQuantity - snapshot.draftQuantity,
      );
      if (prepared.quantity > suggestionCapacity) {
        throw new Error(`采购建议数量超过未覆盖需求（当前可建议 ${suggestionCapacity} 件）`);
      }
      const id = randomUUID();
      this.workspace.database.prepare(`
        INSERT INTO purchase_suggestions (
          id, plan_id, standard_product_id, quantity, status,
          created_at, confirmed_at, cancelled_at, cancel_reason, risk_acknowledged_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, NULL, NULL, NULL, ?)
      `).run(
        id,
        prepared.planId,
        prepared.standardProductId,
        prepared.quantity,
        now,
        conditional ? now : null,
      );
      this.recordSuggestionEvent(id, prepared.planId, 'created', null, prepared.reason, now);
    });
    return this.buildDemandView(plan);
  }

  public confirmSuggestion(input: unknown): FulfillmentDemandView {
    const prepared = normalizePurchaseSuggestionActionInput(input);
    const now = new Date().toISOString();
    const plan = this.requireDemandPlan(prepared.planId);
    this.assertPlanOpen(asString(plan.status), '确认采购建议');
    this.workspace.transaction(() => {
      const suggestion = this.requireSuggestion(prepared.planId, prepared.suggestionId);
      if (asString(suggestion.status) !== 'draft') {
        throw new Error('只有待确认建议可以确认');
      }
      this.workspace.database.prepare(`
        UPDATE purchase_suggestions
        SET status = 'confirmed', confirmed_at = ?
        WHERE id = ?
      `).run(now, prepared.suggestionId);
      this.recordSuggestionEvent(
        prepared.suggestionId,
        prepared.planId,
        'confirmed',
        null,
        prepared.reason,
        now,
      );
    });
    return this.buildDemandView(plan);
  }

  public cancelSuggestion(input: unknown): FulfillmentDemandView {
    const prepared = normalizePurchaseSuggestionActionInput(input);
    const now = new Date().toISOString();
    const plan = this.requireDemandPlan(prepared.planId);
    this.workspace.transaction(() => {
      const suggestion = this.requireSuggestion(prepared.planId, prepared.suggestionId);
      if (asString(suggestion.status) === 'cancelled') {
        throw new Error('采购建议已取消');
      }
      this.workspace.database.prepare(`
        UPDATE purchase_suggestions
        SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
        WHERE id = ?
      `).run(now, prepared.reason, prepared.suggestionId);
      this.recordSuggestionEvent(
        prepared.suggestionId,
        prepared.planId,
        'cancelled',
        null,
        prepared.reason,
        now,
      );
    });
    return this.buildDemandView(plan);
  }

  public shrinkDraftsAfterOrderExit(orderId: string, now: string, reason: string): void {
    const membership = this.workspace.database.prepare(`
      SELECT m.plan_id
      FROM fulfillment_plan_members m
      WHERE m.order_id = ? AND m.released_at IS NULL AND m.removed_at IS NULL
    `).get(orderId) as SqlRow | undefined;
    if (!membership) return;
    const productRows = this.workspace.database.prepare(`
      SELECT DISTINCT standard_product_id FROM order_items
      WHERE order_id = ? AND standard_product_id IS NOT NULL
    `).all(orderId) as unknown as SqlRow[];
    const productIds = productRows
      .map((row) => asString(row.standard_product_id))
      .filter((value) => value !== '');
    if (productIds.length === 0) return;
    this.reduceDraftSuggestions(asString(membership.plan_id), productIds, reason, now);
  }

  private requireDemandPlan(planId: string): SqlRow {
    const plan = this.workspace.database.prepare(`
      SELECT id, type, name, status, formed_at, demand_alert_threshold
      FROM fulfillment_plans
      WHERE id = ?
    `).get(planId) as SqlRow | undefined;
    if (!plan) throw new Error('未找到履约计划');
    return plan;
  }

  private isConditionalPlan(plan: SqlRow): boolean {
    return asString(plan.type) === 'group_buy' && plan.formed_at === null;
  }

  private assertPlanOpen(status: string, action: string): void {
    if (status === 'closed') throw new Error(`履约计划已关闭，不能${action}`);
    if (status === 'released') throw new Error(`履约计划已全部释放，不能${action}`);
  }

  private requireSuggestion(planId: string, suggestionId: string): SqlRow {
    const suggestion = this.workspace.database.prepare(`
      SELECT id, plan_id, status FROM purchase_suggestions
      WHERE id = ? AND plan_id = ?
    `).get(suggestionId, planId) as SqlRow | undefined;
    if (!suggestion) throw new Error('未找到该采购建议');
    return suggestion;
  }

  private buildDemandView(plan: SqlRow): FulfillmentDemandView {
    const planId = asString(plan.id);
    const memberRows = this.workspace.database.prepare(`
      SELECT m.order_id, o.lifecycle_status, o.platform_transaction_status
      FROM fulfillment_plan_members m
      JOIN original_orders o ON o.id = m.order_id
      WHERE m.plan_id = ? AND m.released_at IS NULL AND m.removed_at IS NULL
      ORDER BY m.joined_at, m.id
    `).all(planId) as unknown as SqlRow[];
    const activeOrderIds = memberRows
      .filter((row) => asString(row.lifecycle_status) === 'active')
      .map((row) => asString(row.order_id));
    const refundedByItemId = new Map<string, number>(
      (this.workspace.database.prepare(`
        SELECT order_item_id, SUM(quantity) AS quantity FROM fulfillment_refund_events
        WHERE plan_id = ? GROUP BY order_item_id
      `).all(planId) as unknown as Array<{ order_item_id: string; quantity: number }>)
        .map((row) => [row.order_item_id, Number(row.quantity)]),
    );
    const productRows = this.workspace.database.prepare(`
      SELECT id, sku, name, specification FROM standard_products
    `).all() as unknown as SqlRow[];
    const productInfoById = new Map(productRows.map((row) => [asString(row.id), row]));

    type ProductAccumulator = {
      demandQuantity: number;
      refundedOrCancelledQuantity: number;
    };
    const products = new Map<string, ProductAccumulator>();
    const unmapped = new Map<string, FulfillmentDemandUnmappedView & { orderIds: Set<string> }>();
    if (activeOrderIds.length > 0) {
      const placeholders = activeOrderIds.map(() => '?').join(', ');
      const itemRows = this.workspace.database.prepare(`
        SELECT id, order_id, source_title, source_spec, quantity, standard_product_id
        FROM order_items
        WHERE order_id IN (${placeholders})
        ORDER BY order_id, position
      `).all(...activeOrderIds) as unknown as SqlRow[];
      const orderStatusById = new Map(memberRows.map((row) => [
        asString(row.order_id),
        asString(row.platform_transaction_status),
      ]));
      for (const item of itemRows) {
        const orderId = asString(item.order_id);
        const transactionStatus = orderStatusById.get(orderId) ?? 'unknown';
        const quantity = Number(item.quantity);
        const refundedQuantity = ['cancelled', 'refunded'].includes(transactionStatus)
          ? quantity
          : Math.min(refundedByItemId.get(asString(item.id)) ?? 0, quantity);
        const productId = item.standard_product_id === null
          ? null
          : asString(item.standard_product_id);
        if (productId === null || !productInfoById.has(productId)) {
          const netQuantity = quantity - refundedQuantity;
          if (netQuantity <= 0) continue;
          const title = asString(item.source_title);
          const spec = asString(item.source_spec);
          const key = `${title}\u0000${spec}`;
          const existing = unmapped.get(key) ?? {
            sourceTitle: title,
            sourceSpec: spec,
            quantity: 0,
            orderCount: 0,
            orderIds: new Set<string>(),
          };
          existing.quantity += netQuantity;
          existing.orderIds.add(orderId);
          unmapped.set(key, existing);
          continue;
        }
        const existing = products.get(productId) ?? {
          demandQuantity: 0,
          refundedOrCancelledQuantity: 0,
        };
        existing.demandQuantity += quantity - refundedQuantity;
        existing.refundedOrCancelledQuantity += refundedQuantity;
        products.set(productId, existing);
      }
    }

    const suggestionRows = this.workspace.database.prepare(`
      SELECT s.id, s.plan_id, s.standard_product_id, s.quantity, s.status,
        s.created_at, s.confirmed_at, s.cancelled_at, s.cancel_reason,
        s.risk_acknowledged_at,
        p.sku, p.name, p.specification
      FROM purchase_suggestions s
      JOIN standard_products p ON p.id = s.standard_product_id
      WHERE s.plan_id = ?
      ORDER BY s.created_at, s.id
    `).all(planId) as unknown as SqlRow[];
    const confirmedByProduct = new Map<string, number>();
    const draftByProduct = new Map<string, number>();
    for (const row of suggestionRows) {
      const productId = asString(row.standard_product_id);
      const bucket = asString(row.status) === 'confirmed' ? confirmedByProduct : draftByProduct;
      if (asString(row.status) === 'cancelled') continue;
      bucket.set(productId, (bucket.get(productId) ?? 0) + Number(row.quantity));
    }

    const productIdsWithDemand = new Set<string>([
      ...products.keys(),
      ...confirmedByProduct.keys(),
      ...draftByProduct.keys(),
    ]);
    const productViews: FulfillmentDemandProductView[] = [...productIdsWithDemand]
      .map((productId) => {
        const info = productInfoById.get(productId)!;
        const demandQuantity = products.get(productId)?.demandQuantity ?? 0;
        const refunded = products.get(productId)?.refundedOrCancelledQuantity ?? 0;
        const confirmed = confirmedByProduct.get(productId) ?? 0;
        const draft = draftByProduct.get(productId) ?? 0;
        const uncoveredQuantity = Math.max(0, demandQuantity - confirmed);
        return {
          standardProductId: productId,
          sku: asString(info.sku),
          name: asString(info.name),
          specification: asString(info.specification),
          demandQuantity,
          refundedOrCancelledQuantity: refunded,
          confirmedInTransitQuantity: confirmed,
          draftSuggestionQuantity: draft,
          uncoveredQuantity,
          overPurchaseRisk: confirmed > demandQuantity,
          draftExceedsUncovered: draft > uncoveredQuantity,
        };
      })
      .sort((left, right) => left.sku.localeCompare(right.sku));

    const suggestions: PurchaseSuggestionView[] = suggestionRows.map((row) => ({
      id: asString(row.id),
      planId,
      standardProductId: asString(row.standard_product_id),
      sku: asString(row.sku),
      name: asString(row.name),
      specification: asString(row.specification),
      quantity: Number(row.quantity),
      status: asString(row.status) as PurchaseSuggestionStatus,
      createdAt: asString(row.created_at),
      confirmedAt: row.confirmed_at === null ? null : asString(row.confirmed_at),
      cancelledAt: row.cancelled_at === null ? null : asString(row.cancelled_at),
      cancelReason: row.cancel_reason === null ? null : asString(row.cancel_reason),
      riskAcknowledgedAt: row.risk_acknowledged_at === null
        ? null
        : asString(row.risk_acknowledged_at),
    }));

    const releasedRow = this.workspace.database.prepare(`
      SELECT COUNT(*) AS released FROM fulfillment_plan_members
      WHERE plan_id = ? AND released_at IS NOT NULL
    `).get(planId) as SqlRow;
    const totals: FulfillmentDemandTotals = {
      demandQuantity: productViews.reduce((total, view) => total + view.demandQuantity, 0),
      refundedOrCancelledQuantity: productViews.reduce(
        (total, view) => total + view.refundedOrCancelledQuantity,
        0,
      ),
      confirmedInTransitQuantity: productViews.reduce(
        (total, view) => total + view.confirmedInTransitQuantity,
        0,
      ),
      draftSuggestionQuantity: productViews.reduce(
        (total, view) => total + view.draftSuggestionQuantity,
        0,
      ),
      uncoveredQuantity: productViews.reduce(
        (total, view) => total + view.uncoveredQuantity,
        0,
      ),
      allocatedStockQuantity: 0,
      pendingInspectionQuantity: 0,
      releasedOrderCount: Number(releasedRow?.released ?? 0),
    };
    return {
      planId,
      planName: asString(plan.name),
      conditional: this.isConditionalPlan(plan),
      demandAlertThreshold: typeof plan.demand_alert_threshold === 'number'
        ? Number(plan.demand_alert_threshold)
        : null,
      products: productViews,
      unmapped: [...unmapped.values()]
        .map(({ orderIds, ...view }) => ({ ...view, orderCount: orderIds.size }))
        .sort((left, right) => (
          left.sourceTitle.localeCompare(right.sourceTitle)
          || left.sourceSpec.localeCompare(right.sourceSpec)
        )),
      suggestions,
      totals,
    };
  }

  private productDemandSnapshot(
    planId: string,
    productId: string,
  ): {
    demandQuantity: number;
    confirmedQuantity: number;
    draftQuantity: number;
    uncoveredQuantity: number;
  } {
    const view = this.buildDemandView(this.requireDemandPlan(planId));
    const product = view.products.find(
      (candidate) => candidate.standardProductId === productId,
    );
    return {
      demandQuantity: product?.demandQuantity ?? 0,
      confirmedQuantity: product?.confirmedInTransitQuantity ?? 0,
      draftQuantity: product?.draftSuggestionQuantity ?? 0,
      uncoveredQuantity: product?.uncoveredQuantity ?? 0,
    };
  }

  private reduceDraftSuggestions(
    planId: string,
    productIds: readonly string[],
    reason: string,
    now: string,
  ): void {
    for (const productId of productIds) {
      const snapshot = this.productDemandSnapshot(planId, productId);
      const allowedDraft = Math.max(
        0,
        snapshot.demandQuantity - snapshot.confirmedQuantity,
      );
      const draftRows = this.workspace.database.prepare(`
        SELECT id, quantity FROM purchase_suggestions
        WHERE plan_id = ? AND standard_product_id = ? AND status = 'draft'
        ORDER BY created_at DESC, id DESC
      `).all(planId, productId) as unknown as SqlRow[];
      const totalDraft = draftRows.reduce((total, row) => total + Number(row.quantity), 0);
      let excess = totalDraft - allowedDraft;
      for (const row of draftRows) {
        if (excess <= 0) break;
        const quantity = Number(row.quantity);
        const reduced = Math.max(0, quantity - excess);
        excess -= quantity - reduced;
        if (reduced === 0) {
          this.workspace.database.prepare(`
            UPDATE purchase_suggestions
            SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
            WHERE id = ?
          `).run(now, reason, asString(row.id));
          this.recordSuggestionEvent(asString(row.id), planId, 'cancelled', null, reason, now);
          continue;
        }
        this.workspace.database.prepare(`
          UPDATE purchase_suggestions SET quantity = ? WHERE id = ?
        `).run(reduced, asString(row.id));
        this.recordSuggestionEvent(asString(row.id), planId, 'reduced', reduced, reason, now);
      }
    }
  }

  private recordSuggestionEvent(
    suggestionId: string,
    planId: string,
    eventType: PurchaseSuggestionEventType,
    quantity: number | null,
    reason: string,
    now: string,
  ): void {
    this.workspace.database.prepare(`
      INSERT INTO purchase_suggestion_events (
        id, suggestion_id, plan_id, event_type, quantity, reason, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), suggestionId, planId, eventType, quantity, reason, now, now);
  }
}

function asString(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

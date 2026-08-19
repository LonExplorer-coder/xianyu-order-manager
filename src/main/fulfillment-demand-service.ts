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
import { InventoryLedgerService } from './inventory-ledger-service';

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
      if (asString(suggestion.status) === 'converted') {
        throw new Error('已转采购订单的建议由采购订单承接，不能取消');
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
        s.risk_acknowledged_at, s.purchase_order_id,
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
      const status = asString(row.status);
      // converted 建议的覆盖由其采购订单承接，不再按建议重复计数。
      if (status === 'cancelled' || status === 'converted') continue;
      const bucket = status === 'confirmed' ? confirmedByProduct : draftByProduct;
      bucket.set(productId, (bucket.get(productId) ?? 0) + Number(row.quantity));
    }

    // 计划关联订单的采购在途（已确认且尚未到货）与已到货数量。
    const transitByProduct = new Map<string, number>(
      (this.workspace.database.prepare(`
        SELECT poi.standard_product_id AS product_id,
          SUM(MAX(poi.quantity - COALESCE(a.received, 0), 0)) AS quantity
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.purchase_order_id
        LEFT JOIN (
          SELECT purchase_order_item_id, SUM(received_quantity) AS received
          FROM purchase_arrival_items
          GROUP BY purchase_order_item_id
        ) a ON a.purchase_order_item_id = poi.id
        WHERE po.status = 'confirmed' AND po.plan_id = ?
        GROUP BY poi.standard_product_id
      `).all(planId) as unknown as Array<{ product_id: string; quantity: number }>)
        .map((row) => [row.product_id, Number(row.quantity)]),
    );
    const arrivedByProduct = new Map<string, number>(
      (this.workspace.database.prepare(`
        SELECT poi.standard_product_id AS product_id, SUM(ai.received_quantity) AS quantity
        FROM purchase_arrival_items ai
        JOIN purchase_order_items poi ON poi.id = ai.purchase_order_item_id
        JOIN purchase_orders po ON po.id = poi.purchase_order_id
        WHERE po.plan_id = ?
        GROUP BY poi.standard_product_id
      `).all(planId) as unknown as Array<{ product_id: string; quantity: number }>)
        .map((row) => [row.product_id, Number(row.quantity)]),
    );

    const stockByProduct = new InventoryLedgerService(this.workspace)
      .stockQuantitiesByProduct();
    const reservedByProduct = new InventoryLedgerService(this.workspace)
      .reservedQuantitiesByProduct();
    const productIdsWithDemand = new Set<string>([
      ...products.keys(),
      ...confirmedByProduct.keys(),
      ...draftByProduct.keys(),
      ...transitByProduct.keys(),
      ...arrivedByProduct.keys(),
    ]);
    const productViews: FulfillmentDemandProductView[] = [...productIdsWithDemand]
      .map((productId) => {
        const info = productInfoById.get(productId)!;
        const demandQuantity = products.get(productId)?.demandQuantity ?? 0;
        const refunded = products.get(productId)?.refundedOrCancelledQuantity ?? 0;
        const confirmed = confirmedByProduct.get(productId) ?? 0;
        const draft = draftByProduct.get(productId) ?? 0;
        // 现货口径是「已分配」近似：可销售先扣除计划外待发货订单的已预留数量
        // （未释放计划成员不占预留，其需求就是本计划需求，不会重复扣减）；
        // 跨计划共享同批现货仍是已知限制，按商品分配归后续库存分配机制。
        const availableSellable = Math.max(
          0,
          (stockByProduct.get(productId)?.sellable ?? 0)
            - (reservedByProduct.get(productId) ?? 0),
        );
        const sellableCovered = Math.min(demandQuantity, availableSellable);
        const inTransit = transitByProduct.get(productId) ?? 0;
        // 采购缺口 = 有效需求 - 可用现货 - 已确认采购在途 - 已确认建议（未转单）。
        const uncoveredQuantity = Math.max(
          0,
          demandQuantity - sellableCovered - inTransit - confirmed,
        );
        return {
          standardProductId: productId,
          sku: asString(info.sku),
          name: asString(info.name),
          specification: asString(info.specification),
          demandQuantity,
          refundedOrCancelledQuantity: refunded,
          sellableCoveredQuantity: sellableCovered,
          confirmedInTransitQuantity: inTransit,
          arrivedQuantity: arrivedByProduct.get(productId) ?? 0,
          confirmedSuggestionQuantity: confirmed,
          draftSuggestionQuantity: draft,
          uncoveredQuantity,
          // 多采购风险与缺口公式同一覆盖口径：现货、在途与建议合计超出需求即预警。
          overPurchaseRisk: sellableCovered + inTransit + confirmed > demandQuantity,
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
      purchaseOrderId: row.purchase_order_id === null
        ? null
        : asString(row.purchase_order_id),
    }));

    const releasedRow = this.workspace.database.prepare(`
      SELECT COUNT(*) AS released FROM fulfillment_plan_members
      WHERE plan_id = ? AND released_at IS NOT NULL
    `).get(planId) as SqlRow;
    const linkedOrderRows = this.workspace.database.prepare(`
      SELECT po.id, po.sequence, po.status, po.expected_at,
        s.name AS supplier_name,
        COALESCE((
          SELECT SUM(poi.quantity) FROM purchase_order_items poi
          WHERE poi.purchase_order_id = po.id
        ), 0) AS ordered_quantity,
        COALESCE((
          SELECT SUM(ai.received_quantity)
          FROM purchase_arrival_items ai
          JOIN purchase_order_items poi ON poi.id = ai.purchase_order_item_id
          WHERE poi.purchase_order_id = po.id
        ), 0) AS arrived_quantity
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.plan_id = ?
      ORDER BY po.sequence
    `).all(planId) as unknown as SqlRow[];
    const linkedPurchaseOrders = linkedOrderRows.map((row) => ({
      orderId: asString(row.id),
      sequence: Number(row.sequence),
      status: asString(row.status) as 'draft' | 'confirmed' | 'cancelled',
      supplierName: asString(row.supplier_name),
      expectedAt: asString(row.expected_at),
      orderedQuantity: Number(row.ordered_quantity),
      arrivedQuantity: Number(row.arrived_quantity),
    }));
    const totals: FulfillmentDemandTotals = {
      demandQuantity: productViews.reduce((total, view) => total + view.demandQuantity, 0),
      refundedOrCancelledQuantity: productViews.reduce(
        (total, view) => total + view.refundedOrCancelledQuantity,
        0,
      ),
      sellableCoveredQuantity: productViews.reduce(
        (total, view) => total + view.sellableCoveredQuantity,
        0,
      ),
      confirmedInTransitQuantity: productViews.reduce(
        (total, view) => total + view.confirmedInTransitQuantity,
        0,
      ),
      arrivedQuantity: productViews.reduce(
        (total, view) => total + view.arrivedQuantity,
        0,
      ),
      confirmedSuggestionQuantity: productViews.reduce(
        (total, view) => total + view.confirmedSuggestionQuantity,
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
      pendingInspectionQuantity: productViews.reduce(
        (total, view) => (
          total + (stockByProduct.get(view.standardProductId)?.awaitingInspection ?? 0)
        ),
        0,
      ),
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
      linkedPurchaseOrders,
      totals,
    };
  }

  private productDemandSnapshot(
    planId: string,
    productId: string,
  ): {
    draftQuantity: number;
    uncoveredQuantity: number;
  } {
    const view = this.buildDemandView(this.requireDemandPlan(planId));
    const product = view.products.find(
      (candidate) => candidate.standardProductId === productId,
    );
    return {
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
      // 与缺口公式同一口径：现货、在途与已确认建议覆盖掉的需求不再保留待确认建议。
      const allowedDraft = Math.max(0, snapshot.uncoveredQuantity);
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

import type {
  ProfitCostComponent,
  ProfitMoneyComponent,
  ProfitOrderRow,
  ProfitProductRow,
  ProfitReportTotals,
  ProfitReportView,
} from '../core/profit';
import type { FinanceDirectionName, FinanceRecordTypeName } from '../core/funds';
import type { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

type OrderSeed = {
  orderId: string;
  orderNumber: string;
  sellerAccount: string;
  buyerNickname: string;
  orderedAt: string;
  amountCents: number;
  subtotalCents: number;
  items: Array<{
    itemId: string;
    standardProductId: string | null;
    subtotalCents: number;
    quantity: number;
  }>;
};

type ProductSeed = {
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
};

const FREIGHT_TYPES: ReadonlySet<string> = new Set([
  'initial_freight',
  'return_freight',
  'replacement_freight',
  'interception_fee',
]);

// 只读计算的成本与利润报表（ADR 0045）：不写任何表，加权平均单价按查询时点计算。
export class ProfitService {
  public constructor(private readonly workspace: Workspace) {}

  public report(): ProfitReportView {
    const products = this.loadProducts();
    const avgUnitCost = this.averageUnitCostCents();
    const orders = this.loadOrders();

    const orderById = new Map(orders.map((order) => [order.orderId, order]));
    // 归属链解析：来源 → 订单集合（带缓存）。任何一步查不到都返回空集合，进入「采购与其他」。
    const ordersOfSource = this.buildSourceResolver(orderById);

    type OrderAccumulator = {
      row: ProfitOrderRow;
      participatingNetCents: number;
    };
    const accumulators = new Map<string, OrderAccumulator>(orders.map((order) => [order.orderId, {
      participatingNetCents: 0,
      row: {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        sellerAccount: order.sellerAccount,
        buyerNickname: order.buyerNickname,
        orderedAt: order.orderedAt,
        transactionAmountCents: order.amountCents,
        settlementNetCents: 0,
        refundNetCents: 0,
        platformFeeNetCents: 0,
        freightNetCents: 0,
        claimNetCents: 0,
        miscNetCents: 0,
        purchaseCostCents: 0,
        profitCents: 0,
        pendingRemainingCents: 0,
        moneyComponents: [],
        costComponents: [],
      },
    }]));

    const others: ProfitMoneyComponent[] = [];
    const othersSigned = { net: 0, pending: 0, purchase: 0 };

    const applyMoneyComponent = (
      component: ProfitMoneyComponent,
      targetOrderIds: string[],
    ): void => {
      if (targetOrderIds.length === 0) {
        others.push(component);
        const signed = component.allocatedCents;
        othersSigned.net += signed;
        if (component.kind === 'pending') othersSigned.pending += signed;
        if (component.type === 'purchase_cost') othersSigned.purchase += signed;
        return;
      }
      const magnitude = Math.abs(component.allocatedCents);
      const sign = component.allocatedCents < 0 ? -1 : 1;
      const allocations = this.allocateMagnitude(
        magnitude,
        targetOrderIds.map((orderId) => orderById.get(orderId)!.subtotalCents),
      );
      targetOrderIds.forEach((orderId, index) => {
        const accumulator = accumulators.get(orderId)!;
        const allocated = sign * allocations[index];
        const perOrder: ProfitMoneyComponent = (
          targetOrderIds.length === 1 ? component : { ...component, allocatedCents: allocated }
        );
        accumulator.row.moneyComponents.push(perOrder);
        if (perOrder.kind === 'pending') {
          // 待确认只进「待确认净额」列与明细，绝不混入已实现利润的类型列（ADR 0045 决策 6）。
          accumulator.row.pendingRemainingCents += allocated;
          return;
        }
        if (perOrder.reference) return;
        const signedNet = allocated;
        switch (perOrder.type) {
          case 'platform_settlement':
            accumulator.row.settlementNetCents += signedNet;
            accumulator.participatingNetCents += signedNet;
            break;
          case 'refund':
            accumulator.row.refundNetCents += signedNet;
            accumulator.participatingNetCents += signedNet;
            break;
          case 'platform_fee':
            accumulator.row.platformFeeNetCents += signedNet;
            accumulator.participatingNetCents += signedNet;
            break;
          case 'carrier_claim':
            accumulator.row.claimNetCents += signedNet;
            accumulator.participatingNetCents += signedNet;
            break;
          case 'misc_expense':
            accumulator.row.miscNetCents += signedNet;
            accumulator.participatingNetCents += signedNet;
            break;
          case 'initial_freight':
          case 'return_freight':
          case 'replacement_freight':
          case 'interception_fee':
            accumulator.row.freightNetCents += signedNet;
            accumulator.participatingNetCents += signedNet;
            break;
          default:
            break;
        }
      });
    };

    // 已确认资金记录的归属与分摊。采购成本类资金无论挂哪里都不进订单利润（ADR 0045 决策 2）。
    for (const record of this.loadConfirmedRecords()) {
      const signed = record.direction === 'income' ? record.amountCents : -record.amountCents;
      const targets = record.type === 'purchase_cost'
        ? []
        : ordersOfSource(record.sourceType, record.sourceId);
      applyMoneyComponent({
        kind: 'record',
        id: record.id,
        type: record.type,
        direction: record.direction,
        amountCents: record.amountCents,
        allocatedCents: signed,
        remainingCents: null,
        sourceLabel: record.sourceLabel,
        occurredAt: record.occurredAt,
        note: record.note,
        reference: record.type === 'order_transaction',
      }, targets);
    }

    // 待确认事项：剩余金额经同一链路挂账，单列不进利润。
    for (const pending of this.loadPendingItems()) {
      if (pending.status !== 'pending') continue;
      const signed = pending.direction === 'income'
        ? pending.remainingCents
        : -pending.remainingCents;
      if (signed === 0) continue;
      const targets = pending.type === 'purchase_cost'
        ? []
        : ordersOfSource(pending.sourceType, pending.sourceId);
      applyMoneyComponent({
        kind: 'pending',
        id: pending.id,
        type: pending.type,
        direction: pending.direction,
        amountCents: pending.amountCents,
        allocatedCents: signed,
        remainingCents: signed,
        sourceLabel: pending.sourceLabel,
        occurredAt: pending.occurredAt,
        note: pending.note,
        reference: false,
      }, targets);
    }

    // 成本：发出与冲回组件挂在订单行，同一来源链给出商品与数量追溯。
    this.applyCosts(accumulators, avgUnitCost);

    for (const accumulator of accumulators.values()) {
      const row = accumulator.row;
      row.profitCents = row.settlementNetCents
        + row.claimNetCents
        + row.refundNetCents
        + row.platformFeeNetCents
        + row.freightNetCents
        + row.miscNetCents
        - row.purchaseCostCents;
    }

    const { products: productRows, unmapped } = this.buildProductRollup(
      orders,
      products,
      avgUnitCost,
      accumulators,
    );

    const totals: ProfitReportTotals = {
      transactionCents: orders.reduce((sum, order) => sum + order.amountCents, 0),
      profitCents: 0,
      pendingRemainingCents: othersSigned.pending,
      scrapCostCents: productRows.reduce((sum, row) => sum + row.scrapCostCents, 0),
      purchasePaymentNetCents: othersSigned.purchase,
      othersNetCents: othersSigned.net,
    };
    for (const accumulator of accumulators.values()) {
      totals.profitCents += accumulator.row.profitCents;
      totals.pendingRemainingCents += accumulator.row.pendingRemainingCents;
    }

    return {
      generatedAt: new Date().toISOString(),
      orders: orders.map((order) => accumulators.get(order.orderId)!.row),
      products: productRows,
      unmapped,
      others,
      totals,
    };
  }

  // 金额按权重分摊：向下取整，余数分给第一个权重位（订单按订单号排序、商品按明细位置）。
  private allocateMagnitude(magnitude: number, weights: number[]): number[] {
    if (weights.length === 0) return [];
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight <= 0 || magnitude === 0) {
      return weights.map((_, index) => (index === 0 ? magnitude : 0));
    }
    const shares = weights.map((weight) => Math.floor((magnitude * weight) / totalWeight));
    const remainder = magnitude - shares.reduce((sum, share) => sum + share, 0);
    shares[0] += remainder;
    return shares;
  }

  private loadProducts(): ProductSeed[] {
    return (this.workspace.database.prepare(`
      SELECT id, sku, name, specification
      FROM standard_products
      ORDER BY sku, id
    `).all() as unknown as SqlRow[]).map((row) => ({
      standardProductId: String(row.id),
      sku: String(row.sku),
      name: String(row.name),
      specification: String(row.specification),
    }));
  }

  // 加权平均采购单价（ADR 0045 决策 2）：关联采购单的供应方退货按该采购单单价冲减。
  private averageUnitCostCents(): Map<string, number> {
    const arrivals = new Map<string, { quantity: number; amount: number }>();
    for (const row of this.workspace.database.prepare(`
      SELECT poi.standard_product_id AS pid,
        SUM(pai.received_quantity) AS quantity,
        SUM(pai.received_quantity * poi.unit_price_cents) AS amount
      FROM purchase_arrival_items pai
      JOIN purchase_order_items poi ON poi.id = pai.purchase_order_item_id
      JOIN purchase_orders po ON po.id = poi.purchase_order_id AND po.status = 'confirmed'
      GROUP BY poi.standard_product_id
    `).all() as unknown as SqlRow[]) {
      arrivals.set(String(row.pid), { quantity: Number(row.quantity), amount: Number(row.amount) });
    }

    const reversals = new Map<string, { quantity: number; amount: number }>();
    for (const row of this.workspace.database.prepare(`
      SELECT sri.standard_product_id AS pid, sri.quantity AS quantity,
        (SELECT poi.unit_price_cents FROM purchase_order_items poi
          WHERE poi.purchase_order_id = sr.purchase_order_id
            AND poi.standard_product_id = sri.standard_product_id) AS price
      FROM supplier_returns sr
      JOIN supplier_return_items sri ON sri.supplier_return_id = sr.id
      WHERE sr.purchase_order_id IS NOT NULL
    `).all() as unknown as SqlRow[]) {
      if (row.price === null) continue;
      const pid = String(row.pid);
      const entry = reversals.get(pid) ?? { quantity: 0, amount: 0 };
      entry.quantity += Number(row.quantity);
      entry.amount += Number(row.quantity) * Number(row.price);
      reversals.set(pid, entry);
    }

    const result = new Map<string, number>();
    for (const [pid, arrival] of arrivals) {
      const reversal = reversals.get(pid) ?? { quantity: 0, amount: 0 };
      const base = arrival.quantity - reversal.quantity;
      const net = arrival.amount - reversal.amount;
      if (base > 0) result.set(pid, Math.round(net / base));
      else if (arrival.quantity > 0) result.set(pid, Math.round(arrival.amount / arrival.quantity));
      else result.set(pid, 0);
    }
    return result;
  }

  private loadOrders(): OrderSeed[] {
    const orderRows = this.workspace.database.prepare(`
      SELECT id, platform_order_number, seller_account, buyer_nickname,
        ordered_at_normalized, amount_cents
      FROM original_orders
      ORDER BY ordered_at_normalized, id
    `).all() as unknown as SqlRow[];
    const itemRows = this.workspace.database.prepare(`
      SELECT id, order_id, position, standard_product_id, quantity, subtotal_cents
      FROM order_items
      ORDER BY order_id, position
    `).all() as unknown as SqlRow[];
    const itemsByOrder = new Map<string, OrderSeed['items']>();
    for (const row of itemRows) {
      const orderId = String(row.order_id);
      const items = itemsByOrder.get(orderId) ?? [];
      items.push({
        itemId: String(row.id),
        standardProductId: row.standard_product_id === null
          ? null
          : String(row.standard_product_id),
        subtotalCents: Number(row.subtotal_cents),
        quantity: Number(row.quantity),
      });
      itemsByOrder.set(orderId, items);
    }
    return orderRows.map((row) => {
      const orderId = String(row.id);
      const items = itemsByOrder.get(orderId) ?? [];
      return {
        orderId,
        orderNumber: String(row.platform_order_number),
        sellerAccount: String(row.seller_account),
        buyerNickname: String(row.buyer_nickname),
        orderedAt: String(row.ordered_at_normalized),
        amountCents: Number(row.amount_cents),
        subtotalCents: items.reduce((sum, item) => sum + item.subtotalCents, 0),
        items,
      };
    });
  }

  private buildSourceResolver(
    orderById: Map<string, OrderSeed>,
  ): (sourceType: string | null, sourceId: string | null) => string[] {
    const cache = new Map<string, string[]>();
    const ordersOfRecord = (recordId: string): string[] => {
      const rows = this.workspace.database.prepare(`
        SELECT DISTINCT spi.order_id AS oid
        FROM shipment_package_items spi
        JOIN shipment_packages sp ON sp.id = spi.package_id
        WHERE sp.shipment_record_id = ?
        ORDER BY spi.order_id
      `).all(recordId) as unknown as SqlRow[];
      return rows.map((row) => String(row.oid));
    };
    const ordersOfCase = (caseId: string): string[] => {
      const rows = this.workspace.database.prepare(`
        SELECT DISTINCT spi.order_id AS oid
        FROM aftersales_case_items ci
        JOIN shipment_package_items spi ON spi.id = ci.shipment_package_item_id
        WHERE ci.case_id = ?
        ORDER BY spi.order_id
      `).all(caseId) as unknown as SqlRow[];
      return rows.map((row) => String(row.oid));
    };
    const ordersOfClaim = (claimId: string): string[] => {
      const claim = this.workspace.database.prepare(`
        SELECT return_record_id, shipment_package_id FROM carrier_claims WHERE id = ?
      `).get(claimId) as unknown as SqlRow | undefined;
      if (!claim) return [];
      if (claim.return_record_id !== null) {
        const caseRow = this.workspace.database.prepare(`
          SELECT aftersales_case_id AS cid FROM aftersales_return_records WHERE id = ?
        `).get(String(claim.return_record_id)) as unknown as SqlRow | undefined;
        return caseRow ? ordersOfCase(String(caseRow.cid)) : [];
      }
      if (claim.shipment_package_id !== null) {
        const recordRow = this.workspace.database.prepare(`
          SELECT shipment_record_id AS rid FROM shipment_packages WHERE id = ?
        `).get(String(claim.shipment_package_id)) as unknown as SqlRow | undefined;
        return recordRow ? ordersOfRecord(String(recordRow.rid)) : [];
      }
      return [];
    };
    const ordersOfCaseAnchor = (sourceId: string): string[] => {
      const direct = this.workspace.database.prepare(`
        SELECT 1 FROM aftersales_cases WHERE id = ?
      `).get(sourceId);
      if (direct) return ordersOfCase(sourceId);
      const refundRow = this.workspace.database.prepare(`
        SELECT aftersales_case_id AS cid FROM financial_records WHERE id = ?
      `).get(sourceId) as unknown as SqlRow | undefined;
      return refundRow ? ordersOfCase(String(refundRow.cid)) : [];
    };

    return (sourceType: string | null, sourceId: string | null): string[] => {
      if (sourceType === null || sourceId === null) return [];
      const key = `${sourceType}:${sourceId}`;
      const cached = cache.get(key);
      if (cached) return cached;
      let resolved: string[];
      if (sourceType === 'order') {
        resolved = orderById.has(sourceId) ? [sourceId] : [];
      } else if (sourceType === 'shipment_record') {
        resolved = ordersOfRecord(sourceId);
      } else if (sourceType === 'aftersales_case') {
        resolved = ordersOfCaseAnchor(sourceId);
      } else if (sourceType === 'logistics_exception') {
        resolved = ordersOfClaim(sourceId);
      } else {
        resolved = [];
      }
      // 多订单挂账按订单号稳定排序，余数分给订单号最前的订单。
      resolved = [...resolved].sort((left, right) => {
        const leftNumber = orderById.get(left)?.orderNumber ?? '';
        const rightNumber = orderById.get(right)?.orderNumber ?? '';
        return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
      });
      cache.set(key, resolved);
      return resolved;
    };
  }

  private loadConfirmedRecords(): Array<{
    id: string;
    type: FinanceRecordTypeName;
    direction: FinanceDirectionName;
    amountCents: number;
    occurredAt: string;
    note: string;
    sourceType: string | null;
    sourceId: string | null;
    sourceLabel: string;
  }> {
    return (this.workspace.database.prepare(`
      SELECT r.id, r.type, r.direction, r.amount_cents, r.occurred_at, r.note,
        r.source_type, r.source_id
      FROM finance_records r
      ORDER BY r.sequence
    `).all() as unknown as SqlRow[]).map((row) => ({
      id: String(row.id),
      type: row.type as FinanceRecordTypeName,
      direction: row.direction as FinanceDirectionName,
      amountCents: Number(row.amount_cents),
      occurredAt: String(row.occurred_at),
      note: String(row.note),
      sourceType: row.source_type === null ? null : String(row.source_type),
      sourceId: row.source_id === null ? null : String(row.source_id),
      sourceLabel: this.moneySourceLabel(
        row.source_type === null ? null : String(row.source_type),
        row.source_id === null ? null : String(row.source_id),
      ),
    }));
  }

  private loadPendingItems(): Array<{
    id: string;
    type: FinanceRecordTypeName;
    direction: FinanceDirectionName;
    amountCents: number;
    remainingCents: number;
    status: string;
    occurredAt: string;
    note: string;
    sourceType: string | null;
    sourceId: string | null;
    sourceLabel: string;
  }> {
    const signedByPendingItem = new Map<string, number>(
      (this.workspace.database.prepare(`
        SELECT pending_item_id,
          COALESCE(SUM(CASE direction WHEN 'income' THEN amount_cents ELSE -amount_cents END), 0)
            AS signed
        FROM finance_records
        WHERE pending_item_id IS NOT NULL
        GROUP BY pending_item_id
      `).all() as unknown as SqlRow[]).map((row) => [String(row.pending_item_id), Number(row.signed)]),
    );
    return (this.workspace.database.prepare(`
      SELECT id, type, direction, amount_cents, status, source_type, source_id,
        note, occurred_at
      FROM finance_pending_items
      ORDER BY created_at, id
    `).all() as unknown as SqlRow[]).map((row) => {
      const sign = row.direction === 'income' ? 1 : -1;
      const remaining = Math.max(
        Number(row.amount_cents) - sign * (signedByPendingItem.get(String(row.id)) ?? 0),
        0,
      );
      return {
        id: String(row.id),
        type: row.type as FinanceRecordTypeName,
        direction: row.direction as FinanceDirectionName,
        amountCents: Number(row.amount_cents),
        remainingCents: remaining,
        status: String(row.status),
        occurredAt: String(row.occurred_at),
        note: String(row.note),
        sourceType: row.source_type === null ? null : String(row.source_type),
        sourceId: row.source_id === null ? null : String(row.source_id),
        sourceLabel: this.moneySourceLabel(
          row.source_type === null ? null : String(row.source_type),
          row.source_id === null ? null : String(row.source_id),
        ),
      };
    });
  }

  // 资金来源的可读描述：双语义锚点翻译成人话（退款→售后单、索赔→承运索赔）。
  private moneySourceLabel(sourceType: string | null, sourceId: string | null): string {
    if (sourceType === null || sourceId === null) return '直接录入（无来源）';
    if (sourceType === 'order') {
      const row = this.workspace.database.prepare(`
        SELECT platform_order_number FROM original_orders WHERE id = ?
      `).get(sourceId) as unknown as SqlRow | undefined;
      return row ? `订单 ${String(row.platform_order_number)}` : '订单（已不存在）';
    }
    if (sourceType === 'shipment_record') {
      const row = this.workspace.database.prepare(`
        SELECT sp.tracking_number FROM shipment_packages sp
        WHERE sp.shipment_record_id = ? ORDER BY sp.position LIMIT 1
      `).get(sourceId) as unknown as SqlRow | undefined;
      return row ? `发货记录 ${String(row.tracking_number)}` : '发货记录（已不存在）';
    }
    if (sourceType === 'aftersales_case') {
      const caseId = this.caseIdOfAnchor(sourceId);
      return caseId ? `售后处理单 ${caseId.slice(0, 8)} 实际退款` : '售后处理单（已不存在）';
    }
    if (sourceType === 'logistics_exception') {
      const claim = this.workspace.database.prepare(`
        SELECT direction FROM carrier_claims WHERE id = ?
      `).get(sourceId) as unknown as SqlRow | undefined;
      if (!claim) return '承运索赔（已不存在）';
      return claim.direction === 'return' ? '承运索赔（售后退回）' : '承运索赔（正向丢件）';
    }
    if (sourceType === 'purchase_order') {
      const row = this.workspace.database.prepare(`
        SELECT sequence FROM purchase_orders WHERE id = ?
      `).get(sourceId) as unknown as SqlRow | undefined;
      return row ? `采购订单 #${Number(row.sequence)}` : '采购订单（已不存在）';
    }
    if (sourceType === 'supplier_return') {
      const row = this.workspace.database.prepare(`
        SELECT s.name FROM supplier_returns sr JOIN suppliers s ON s.supplier_id = sr.supplier_id
        WHERE sr.id = ?
      `).get(sourceId) as unknown as SqlRow | undefined;
      return row ? `供应方退货（${String(row.name)}）` : '供应方退货（已不存在）';
    }
    return '未知来源';
  }

  private caseIdOfAnchor(sourceId: string): string | null {
    const direct = this.workspace.database.prepare(`
      SELECT id FROM aftersales_cases WHERE id = ?
    `).get(sourceId) as unknown as SqlRow | undefined;
    if (direct) return String(direct.id);
    const refundRow = this.workspace.database.prepare(`
      SELECT aftersales_case_id AS cid FROM financial_records WHERE id = ?
    `).get(sourceId) as unknown as SqlRow | undefined;
    return refundRow ? String(refundRow.cid) : null;
  }

  private applyCosts(
    accumulators: Map<string, { row: ProfitOrderRow; participatingNetCents: number }>,
    avgUnitCost: Map<string, number>,
  ): void {
    const productsById = new Map(
      this.loadProducts().map((product) => [product.standardProductId, product]),
    );
    const componentOf = (
      kind: ProfitCostComponent['kind'],
      row: SqlRow,
      quantity: number,
      sourceLabel: string,
    ): ProfitCostComponent => {
      const unit = avgUnitCost.get(String(row.pid)) ?? 0;
      const product = productsById.get(String(row.pid));
      return {
        kind,
        sourceLabel,
        shipmentRecordId: row.rid === undefined || row.rid === null
          ? null
          : String(row.rid),
        returnRecordId: row.return_record_id === undefined || row.return_record_id === null
          ? null
          : String(row.return_record_id),
        standardProductId: String(row.pid),
        sku: product?.sku ?? '',
        name: product?.name ?? '',
        quantity,
        unitCostCents: unit,
        amountCents: kind === 'dispatch' ? quantity * unit : -quantity * unit,
        occurredAt: String(row.occurred_at),
        reason: String(row.reason ?? ''),
      };
    };

    // 发出：排除已撤销包裹（整单作废即全部包裹撤销），补发记录挂原订单。
    for (const row of this.workspace.database.prepare(`
      SELECT spi.order_id AS oid, oi.standard_product_id AS pid,
        sp.shipment_record_id AS rid, sr.created_at AS occurred_at,
        CASE WHEN EXISTS (
          SELECT 1 FROM aftersales_replacement_shipments ars
          WHERE ars.shipment_record_id = sp.shipment_record_id
        ) THEN 1 ELSE 0 END AS is_replacement,
        (
          SELECT sp2.tracking_number FROM shipment_packages sp2
          WHERE sp2.shipment_record_id = sp.shipment_record_id
          ORDER BY sp2.position LIMIT 1
        ) AS tracking_number,
        SUM(spi.quantity) AS quantity
      FROM shipment_package_items spi
      JOIN shipment_packages sp ON sp.id = spi.package_id
      JOIN shipment_records sr ON sr.id = sp.shipment_record_id
      JOIN order_items oi ON oi.id = spi.source_order_item_id
      LEFT JOIN shipment_package_cancellation_events ce ON ce.package_id = sp.id
      WHERE ce.id IS NULL AND oi.standard_product_id IS NOT NULL
      GROUP BY spi.order_id, oi.standard_product_id, sp.shipment_record_id
      ORDER BY sr.created_at, sp.shipment_record_id
    `).all() as unknown as SqlRow[]) {
      const accumulator = accumulators.get(String(row.oid));
      if (!accumulator) continue;
      const quantity = Number(row.quantity);
      const tracking = row.tracking_number === null ? '' : String(row.tracking_number);
      const label = Number(row.is_replacement) === 1
        ? `补发记录 ${tracking}`
        : `发货记录 ${tracking}`;
      const component = componentOf('dispatch', row, quantity, label);
      accumulator.row.costComponents.push(component);
      accumulator.row.purchaseCostCents += component.amountCents;
    }

    // 退货检查冲回：转可销售与报废都实际回来了，冲减订单发出成本。
    for (const row of this.workspace.database.prepare(`
      SELECT arri.return_record_id, arri.inspection_result, arri.accepted_quantity,
        rr.inspected_at AS occurred_at,
        spi.order_id AS oid, oi.standard_product_id AS pid,
        rr.aftersales_case_id AS case_id
      FROM aftersales_return_record_items arri
      JOIN aftersales_return_records rr ON rr.id = arri.return_record_id
      JOIN shipment_package_items spi ON spi.id = arri.shipment_package_item_id
      JOIN order_items oi ON oi.id = spi.source_order_item_id
      WHERE arri.inspection_result IN ('resellable', 'scrapped')
        AND arri.accepted_quantity > 0
        AND oi.standard_product_id IS NOT NULL
      ORDER BY rr.inspected_at, arri.return_record_id
    `).all() as unknown as SqlRow[]) {
      const accumulator = accumulators.get(String(row.oid));
      if (!accumulator) continue;
      const quantity = Number(row.accepted_quantity);
      const caseLabel = row.case_id === null ? '' : String(row.case_id).slice(0, 8);
      const label = row.inspection_result === 'scrapped'
        ? `售后处理单 ${caseLabel} 退货检查报废`
        : `售后处理单 ${caseLabel} 退货检查转可销售`;
      const component = componentOf(
        row.inspection_result === 'scrapped' ? 'scrap' : 'recovery',
        row,
        quantity,
        label,
      );
      accumulator.row.costComponents.push(component);
      accumulator.row.purchaseCostCents += component.amountCents;
    }

    // 拦截退回检查冲回：事件级结果按明细精确覆盖，等量冲减。
    for (const row of this.workspace.database.prepare(`
      SELECT e.id AS event_id, e.result, e.items_json, e.occurred_at,
        spi.order_id AS oid, oi.standard_product_id AS pid, spi.id AS spi_id,
        (SELECT ac.id FROM aftersales_cases ac WHERE ac.id = e.case_id) AS case_id
      FROM aftersales_intercepted_return_inspection_events e
      JOIN shipment_packages sp ON sp.id = e.shipment_package_id
      JOIN shipment_package_items spi ON spi.package_id = sp.id
      JOIN order_items oi ON oi.id = spi.source_order_item_id
      WHERE e.result IN ('resellable', 'scrapped')
        AND oi.standard_product_id IS NOT NULL
      ORDER BY e.occurred_at, e.id
    `).all() as unknown as SqlRow[]) {
      const accumulator = accumulators.get(String(row.oid));
      if (!accumulator) continue;
      const items = JSON.parse(String(row.items_json)) as Array<{
        shipmentPackageItemId?: string;
        quantity?: number;
      }>;
      const item = items.find((candidate) => candidate.shipmentPackageItemId === String(row.spi_id));
      if (!item || !item.quantity) continue;
      const quantity = Number(item.quantity);
      const caseLabel = row.case_id === null ? '' : String(row.case_id).slice(0, 8);
      const label = row.result === 'scrapped'
        ? `售后处理单 ${caseLabel} 拦截退回报废`
        : `售后处理单 ${caseLabel} 拦截退回转可销售`;
      const component = componentOf(
        row.result === 'scrapped' ? 'scrap' : 'recovery',
        row,
        quantity,
        label,
      );
      accumulator.row.costComponents.push(component);
      accumulator.row.purchaseCostCents += component.amountCents;
    }
  }

  private buildProductRollup(
    orders: OrderSeed[],
    products: ProductSeed[],
    avgUnitCost: Map<string, number>,
    accumulators: Map<string, { row: ProfitOrderRow; participatingNetCents: number }>,
  ): {
    products: ProfitProductRow[];
    unmapped: { orderCount: number; transactionCents: number; allocatedNetCents: number };
  } {
    type ProductAccumulator = {
      orderNumbers: Set<string>;
      transactionCents: number;
      allocatedNetCents: number;
      dispatchedQuantity: number;
      scrapQuantity: number;
      scrapCostCents: number;
      returnReceivedQuantity: number;
      costComponents: ProfitCostComponent[];
      allocations: ProfitProductRow['allocations'];
    };
    const accumulatorsByProduct = new Map<string, ProductAccumulator>(
      products.map((product) => [product.standardProductId, {
        orderNumbers: new Set<string>(),
        transactionCents: 0,
        allocatedNetCents: 0,
        dispatchedQuantity: 0,
        scrapQuantity: 0,
        scrapCostCents: 0,
        returnReceivedQuantity: 0,
        costComponents: [],
        allocations: [],
      }]),
    );
    const unmapped: { orderCount: Set<string>; transactionCents: number; allocatedNetCents: number } = {
      orderCount: new Set<string>(),
      transactionCents: 0,
      allocatedNetCents: 0,
    };

    // 订单参与净额按明细小计分摊到商品；未映射份额单列。
    for (const order of orders) {
      const accumulator = accumulators.get(order.orderId)!;
      const magnitude = Math.abs(accumulator.participatingNetCents);
      const sign = accumulator.participatingNetCents < 0 ? -1 : 1;
      const shares = this.allocateMagnitude(
        magnitude,
        order.items.map((item) => item.subtotalCents),
      );
      const orderAllocationByProduct = new Map<string, number>();
      order.items.forEach((item, index) => {
        const allocated = sign * shares[index];
        if (item.standardProductId === null) {
          unmapped.orderCount.add(order.orderId);
          unmapped.transactionCents += item.subtotalCents;
          unmapped.allocatedNetCents += allocated;
          return;
        }
        const productAccumulator = accumulatorsByProduct.get(item.standardProductId);
        if (!productAccumulator) return;
        productAccumulator.orderNumbers.add(order.orderNumber);
        productAccumulator.transactionCents += item.subtotalCents;
        productAccumulator.allocatedNetCents += allocated;
        orderAllocationByProduct.set(
          item.standardProductId,
          (orderAllocationByProduct.get(item.standardProductId) ?? 0) + allocated,
        );
      });
      for (const [productId, allocated] of orderAllocationByProduct) {
        accumulatorsByProduct.get(productId)!.allocations.push({
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          transactionCents: 0,
          allocatedNetCents: allocated,
        });
      }
    }

    // 交易份额按商品归集（同商品多明细合并为一行分配记录）。
    for (const order of orders) {
      const byProduct = new Map<string, number>();
      for (const item of order.items) {
        if (item.standardProductId === null) continue;
        byProduct.set(
          item.standardProductId,
          (byProduct.get(item.standardProductId) ?? 0) + item.subtotalCents,
        );
      }
      for (const [productId, transactionCents] of byProduct) {
        const productAccumulator = accumulatorsByProduct.get(productId);
        if (!productAccumulator) continue;
        const allocation = productAccumulator.allocations.find((entry) => (
          entry.orderId === order.orderId
        ));
        if (allocation) allocation.transactionCents = transactionCents;
        else productAccumulator.allocations.push({
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          transactionCents,
          allocatedNetCents: 0,
        });
      }
    }

    // 订单成本组件归集到商品：发出与冲回数量合并，报废组件来自到货与库存检查。
    for (const accumulator of accumulators.values()) {
      for (const component of accumulator.row.costComponents) {
        const productAccumulator = accumulatorsByProduct.get(component.standardProductId);
        if (!productAccumulator) continue;
        productAccumulator.costComponents.push(component);
        if (component.kind === 'dispatch') productAccumulator.dispatchedQuantity += component.quantity;
        else productAccumulator.dispatchedQuantity -= component.quantity;
      }
    }

    for (const row of this.workspace.database.prepare(`
      SELECT standard_product_id AS pid, quantity, occurred_at, source_id, reason
      FROM inventory_movements
      WHERE source_type = 'inspection_result' AND state = 'scrapped' AND direction = 'in'
      ORDER BY occurred_at, sequence
    `).all() as unknown as SqlRow[]) {
      const productAccumulator = accumulatorsByProduct.get(String(row.pid));
      if (!productAccumulator) continue;
      const quantity = Number(row.quantity);
      const unit = avgUnitCost.get(String(row.pid)) ?? 0;
      const isReturnInspection = this.workspace.database.prepare(`
        SELECT 1 FROM aftersales_return_records WHERE id = ?
      `).get(String(row.source_id)) !== undefined;
      productAccumulator.scrapQuantity += quantity;
      productAccumulator.scrapCostCents += quantity * unit;
      productAccumulator.costComponents.push({
        kind: 'scrap',
        sourceLabel: isReturnInspection ? '退货检查报废' : '库存检查报废',
        shipmentRecordId: null,
        returnRecordId: isReturnInspection ? String(row.source_id) : null,
        standardProductId: String(row.pid),
        sku: '',
        name: '',
        quantity,
        unitCostCents: unit,
        amountCents: quantity * unit,
        occurredAt: String(row.occurred_at),
        reason: String(row.reason),
      });
    }

    for (const row of this.workspace.database.prepare(`
      SELECT poi.standard_product_id AS pid, pai.scrapped_quantity AS quantity,
        poi.unit_price_cents AS price, pa.occurred_at, po.sequence
      FROM purchase_arrival_items pai
      JOIN purchase_arrivals pa ON pa.id = pai.arrival_id
      JOIN purchase_order_items poi ON poi.id = pai.purchase_order_item_id
      JOIN purchase_orders po ON po.id = poi.purchase_order_id AND po.status = 'confirmed'
      WHERE pai.scrapped_quantity > 0
      ORDER BY pa.occurred_at, pai.id
    `).all() as unknown as SqlRow[]) {
      const productAccumulator = accumulatorsByProduct.get(String(row.pid));
      if (!productAccumulator) continue;
      const quantity = Number(row.quantity);
      const unit = Number(row.price);
      productAccumulator.scrapQuantity += quantity;
      productAccumulator.scrapCostCents += quantity * unit;
      productAccumulator.costComponents.push({
        kind: 'scrap',
        sourceLabel: `到货检查报废（采购订单 #${Number(row.sequence)}）`,
        shipmentRecordId: null,
        returnRecordId: null,
        standardProductId: String(row.pid),
        sku: '',
        name: '',
        quantity,
        unitCostCents: unit,
        amountCents: quantity * unit,
        occurredAt: String(row.occurred_at),
        reason: '',
      });
    }

    for (const row of this.workspace.database.prepare(`
      SELECT standard_product_id AS pid, SUM(quantity) AS quantity
      FROM inventory_movements
      WHERE source_type = 'return_receipt' AND state = 'awaiting_inspection' AND direction = 'in'
      GROUP BY standard_product_id
    `).all() as unknown as SqlRow[]) {
      const productAccumulator = accumulatorsByProduct.get(String(row.pid));
      if (productAccumulator) {
        productAccumulator.returnReceivedQuantity += Number(row.quantity);
      }
    }

    const supplierReturned = new Map<string, number>(
      (this.workspace.database.prepare(`
        SELECT standard_product_id AS pid, SUM(quantity) AS quantity
        FROM supplier_return_items GROUP BY standard_product_id
      `).all() as unknown as SqlRow[]).map((row) => [String(row.pid), Number(row.quantity)]),
    );

    const productRows: ProfitProductRow[] = products.map((product) => {
      const accumulator = accumulatorsByProduct.get(product.standardProductId)!;
      const unit = avgUnitCost.get(product.standardProductId) ?? 0;
      const dispatchedCost = accumulator.dispatchedQuantity * unit;
      return {
        standardProductId: product.standardProductId,
        sku: product.sku,
        name: product.name,
        specification: product.specification,
        avgUnitCostCents: unit,
        arrivedQuantity: 0,
        supplierReturnedQuantity: supplierReturned.get(product.standardProductId) ?? 0,
        orderCount: accumulator.orderNumbers.size,
        transactionCents: accumulator.transactionCents,
        allocatedNetCents: accumulator.allocatedNetCents,
        dispatchedQuantity: accumulator.dispatchedQuantity,
        dispatchedCostCents: dispatchedCost,
        scrapQuantity: accumulator.scrapQuantity,
        scrapCostCents: accumulator.scrapCostCents,
        returnReceivedQuantity: accumulator.returnReceivedQuantity,
        marginCents: accumulator.allocatedNetCents - dispatchedCost - accumulator.scrapCostCents,
        allocations: accumulator.allocations,
        costComponents: accumulator.costComponents.map((component) => ({
          ...component,
          sku: component.sku || product.sku,
          name: component.name || product.name,
        })),
      };
    });

    // 到货数量补充展示。
    const arrived = new Map<string, number>(
      (this.workspace.database.prepare(`
        SELECT poi.standard_product_id AS pid, SUM(pai.received_quantity) AS quantity
        FROM purchase_arrival_items pai
        JOIN purchase_order_items poi ON poi.id = pai.purchase_order_item_id
        JOIN purchase_orders po ON po.id = poi.purchase_order_id AND po.status = 'confirmed'
        GROUP BY poi.standard_product_id
      `).all() as unknown as SqlRow[]).map((row) => [String(row.pid), Number(row.quantity)]),
    );
    for (const row of productRows) {
      row.arrivedQuantity = arrived.get(row.standardProductId) ?? 0;
    }

    return {
      products: productRows,
      unmapped: {
        orderCount: unmapped.orderCount.size,
        transactionCents: unmapped.transactionCents,
        allocatedNetCents: unmapped.allocatedNetCents,
      },
    };
  }
}

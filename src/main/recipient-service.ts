import { randomUUID } from 'node:crypto';

import {
  formatReadableOrderNumber,
  shanghaiMonthKey,
  shanghaiYYMM,
} from '../core/readable-order-numbers';
import { parseStoredShipmentArchiveOrderIds } from '../core/shipment-archive-storage';
import type { OrderSpendingView, RecipientSummaryView } from '../core/recipients';
import { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

export type RecipientView = {
  id: string;
  recipientNumber: number;
  name: string;
  phoneNormalized: string;
  displayName: string | null;
  mergedIntoRecipientId: string | null;
  mergedReason: string | null;
  mergedAt: string | null;
  createdAt: string;
};

export class RecipientService {
  public constructor(private readonly workspace: Workspace) {}

  public queryRecipients(): RecipientView[] {
    const rows = this.workspace.database.prepare(`
      SELECT id, recipient_number, name, phone_normalized, display_name,
        merged_into_recipient_id, merged_reason, merged_at, created_at
      FROM recipients
      ORDER BY recipient_number
    `).all() as unknown as SqlRow[];
    return rows.map((row) => recipientView(row));
  }

  public queryRecipientSummaries(): RecipientSummaryView[] {
    const { byId, byPair } = this.recipientIndexes();
    const ordersByFinal = this.ordersByFinalRecipientId(byPair, byId);
    const spending = this.spendingProjection();
    return this.queryRecipients().map((view) => {
      const row = byId.get(view.id);
      if (!row) throw new Error('数据库收件人注册表已变化');
      const final = this.resolveFinalRecipient(row, byId);
      const merged = view.mergedIntoRecipientId !== null;
      const orders = merged ? [] : ordersByFinal.get(view.id) ?? [];
      const addresses: string[] = [];
      for (const order of orders) {
        const address = asString(order.address_original);
        if (address && !addresses.includes(address)) addresses.push(address);
      }
      const totals = merged ? undefined : spending.byRecipientId.get(view.id);
      return {
        ...view,
        effectiveName: final.display_name === null
          ? asString(final.name)
          : asString(final.display_name),
        orderCount: orders.length,
        addresses,
        totalSpendCents: totals?.totalSpendCents ?? 0,
        totalRefundCents: totals?.totalRefundCents ?? 0,
      };
    });
  }

  /**
   * 收件人累计消费、累计退款与回购批次的只读投影。
   * 有效订单 = 平台交易状态为已付款或未知且生命周期正常。回购按购买批次计：
   * 已进入发货组档案的订单以档案为批次，未入档订单按发货匹配键归入当前未发轮；
   * 批次按批内最早有效订单时间（付款→下单→入库回退链）排序。退款 = 售后实退
   * 资金按受影响订单商品小计分摊（回收站、永久删除或无法归属的订单份额不计入），
   * 加未走售后登记的正常整单退款订单按实付金额推断，同一订单不重复计。
   */
  public spendingProjection(): {
    byOrderId: ReadonlyMap<string, OrderSpendingView>;
    byRecipientId: ReadonlyMap<string, { totalSpendCents: number; totalRefundCents: number }>;
  } {
    const { byId, byPair } = this.recipientIndexes();
    const orderRows = this.workspace.database.prepare(`
      SELECT id, recipient, phone_normalized, address_normalized,
        platform_transaction_status, lifecycle_status, amount_cents,
        paid_at_normalized, ordered_at_normalized, created_at
      FROM original_orders
    `).all() as unknown as SqlRow[];

    type SpendingOrder = {
      id: string;
      recipientId: string;
      valid: boolean;
      amountCents: number;
      platformTransactionStatus: string;
      lifecycleStatus: string;
      phoneNormalized: string;
      addressNormalized: string;
      rankMillis: number;
    };
    const ordersByRecipient = new Map<string, SpendingOrder[]>();
    const recipientIdByOrderId = new Map<string, string>();
    const orderById = new Map<string, SpendingOrder>();
    for (const row of orderRows) {
      const name = asString(row.recipient);
      const phone = asString(row.phone_normalized);
      if (!name.trim() || !phone.trim()) continue;
      const pair = byPair.get(recipientPairKey(name, phone));
      if (!pair) continue;
      const finalRecipientId = asString(this.resolveFinalRecipient(pair, byId).id);
      const orderId = asString(row.id);
      recipientIdByOrderId.set(orderId, finalRecipientId);
      const status = asString(row.platform_transaction_status);
      const lifecycle = asString(row.lifecycle_status);
      const paidAt = asString(row.paid_at_normalized);
      const orderedAt = asString(row.ordered_at_normalized);
      const order: SpendingOrder = {
        id: orderId,
        recipientId: finalRecipientId,
        valid: (status === 'paid' || status === 'unknown') && lifecycle === 'active',
        amountCents: Number(row.amount_cents),
        platformTransactionStatus: status,
        lifecycleStatus: lifecycle,
        phoneNormalized: phone,
        addressNormalized: asString(row.address_normalized),
        // 平台交易时间带 +08:00、入库时间是 UTC ISO，字符串不可直接比较，统一换成纪元毫秒。
        rankMillis: Date.parse(paidAt || orderedAt || asString(row.created_at)) || 0,
      };
      orderById.set(orderId, order);
      const group = ordersByRecipient.get(finalRecipientId) ?? [];
      group.push(order);
      ordersByRecipient.set(finalRecipientId, group);
    }

    // 购买批次：已入发货组档案的订单以档案为批次（重叠档案取最早建档），
    // 未入档订单按发货匹配键归入当前未发轮。
    const archiveIdByOrderId = new Map<string, string>();
    const archiveRows = this.workspace.database.prepare(`
      SELECT id, member_order_ids_json
      FROM shipment_group_archives
      ORDER BY created_at, id
    `).all() as unknown as SqlRow[];
    for (const archiveRow of archiveRows) {
      const archiveId = asString(archiveRow.id);
      for (const orderId of parseStoredShipmentArchiveOrderIds(
        asString(archiveRow.member_order_ids_json),
        '数据库发货组档案成员订单格式错误',
      )) {
        if (!archiveIdByOrderId.has(orderId)) archiveIdByOrderId.set(orderId, archiveId);
      }
    }
    const batchKeyByOrderId = new Map<string, string>();
    for (const [orderId, order] of orderById) {
      batchKeyByOrderId.set(
        orderId,
        archiveIdByOrderId.get(orderId)
          ?? `open|${order.phoneNormalized}|${order.addressNormalized}`,
      );
    }
    // 批次时间取批内全部有效订单（可跨收件人合装）的最早回退链时间。
    const batchEarliestMillis = new Map<string, number>();
    for (const order of orderById.values()) {
      if (!order.valid) continue;
      const batchKey = batchKeyByOrderId.get(order.id) as string;
      const earliest = batchEarliestMillis.get(batchKey);
      if (earliest === undefined || order.rankMillis < earliest) {
        batchEarliestMillis.set(batchKey, order.rankMillis);
      }
    }

    const totalSpendByRecipient = new Map<string, number>();
    const rankByOrderId = new Map<string, number>();
    for (const [recipientId, orders] of ordersByRecipient) {
      const validOrders = orders.filter((order) => order.valid);
      totalSpendByRecipient.set(
        recipientId,
        validOrders.reduce((total, order) => total + order.amountCents, 0),
      );
      const batchKeys = [...new Set(
        validOrders.map((order) => batchKeyByOrderId.get(order.id) as string),
      )];
      batchKeys.sort((left, right) => (
        (batchEarliestMillis.get(left) ?? 0) - (batchEarliestMillis.get(right) ?? 0)
          || left.localeCompare(right)
      ));
      const batchRankByKey = new Map(batchKeys.map((key, index) => [key, index + 1]));
      for (const order of validOrders) {
        const rank = batchRankByKey.get(batchKeyByOrderId.get(order.id) as string);
        if (rank !== undefined) rankByOrderId.set(order.id, rank);
      }
    }

    const totalRefundByRecipient = new Map<string, number>();
    const refundTouchedOrderIds = new Set<string>();
    const refundRows = this.workspace.database.prepare(`
      SELECT financial_records.id, financial_records.amount_cents,
        financial_records.aftersales_case_id
      FROM financial_records
      WHERE financial_records.kind = 'aftersales_refund'
      ORDER BY financial_records.created_at, financial_records.id
    `).all() as unknown as SqlRow[];
    const caseItemsStatement = this.workspace.database.prepare(`
      SELECT package_items.order_id, SUM(package_items.subtotal_cents) AS subtotal_cents
      FROM aftersales_case_items AS case_items
      JOIN shipment_package_items AS package_items
        ON package_items.id = case_items.shipment_package_item_id
      WHERE case_items.case_id = ?
      GROUP BY package_items.order_id
    `);
    const addRefund = (recipientId: string, cents: number) => {
      totalRefundByRecipient.set(recipientId, (totalRefundByRecipient.get(recipientId) ?? 0) + cents);
    };
    for (const refundRow of refundRows) {
      const affected = caseItemsStatement
        .all(asString(refundRow.aftersales_case_id)) as unknown as SqlRow[];
      for (const item of affected) refundTouchedOrderIds.add(asString(item.order_id));
      const amountCents = Number(refundRow.amount_cents);
      // 退款按受影响订单分摊：分母取全部受影响订单的商品小计，只有可归属且
      // 生命周期正常的订单把份额计入其收件人，其余份额不计（不摊给别人）。
      const totalSubtotal = affected.reduce(
        (total, item) => total + Number(item.subtotal_cents),
        0,
      );
      const credited = affected
        .map((item) => {
          const orderId = asString(item.order_id);
          const order = orderById.get(orderId);
          if (!order || order.lifecycleStatus !== 'active') return null;
          return { recipientId: order.recipientId, subtotalCents: Number(item.subtotal_cents) };
        })
        .filter((entry): entry is { recipientId: string; subtotalCents: number } => entry !== null);
      if (credited.length === 0 || totalSubtotal <= 0) continue;
      let distributed = 0;
      const shares = credited
        .map((entry) => ({
          recipientId: entry.recipientId,
          cents: Math.floor((amountCents * entry.subtotalCents) / totalSubtotal),
        }))
        .sort((left, right) => right.cents - left.cents || left.recipientId.localeCompare(right.recipientId));
      for (const share of shares) {
        addRefund(share.recipientId, share.cents);
        distributed += share.cents;
      }
      for (const share of shares) {
        if (distributed >= amountCents) break;
        addRefund(share.recipientId, 1);
        distributed += 1;
      }
    }
    for (const orders of ordersByRecipient.values()) {
      for (const order of orders) {
        if (
          order.platformTransactionStatus !== 'refunded'
          || order.lifecycleStatus !== 'active'
          || refundTouchedOrderIds.has(order.id)
        ) continue;
        addRefund(order.recipientId, order.amountCents);
      }
    }

    const byRecipientId = new Map<string, { totalSpendCents: number; totalRefundCents: number }>();
    for (const [recipientId, totalSpendCents] of totalSpendByRecipient) {
      byRecipientId.set(recipientId, {
        totalSpendCents,
        totalRefundCents: totalRefundByRecipient.get(recipientId) ?? 0,
      });
    }
    for (const [recipientId, totalRefundCents] of totalRefundByRecipient) {
      if (!byRecipientId.has(recipientId)) {
        byRecipientId.set(recipientId, { totalSpendCents: 0, totalRefundCents });
      }
    }
    const byOrderId = new Map<string, OrderSpendingView>();
    for (const [orderId, recipientId] of recipientIdByOrderId) {
      const totals = byRecipientId.get(recipientId) ?? { totalSpendCents: 0, totalRefundCents: 0 };
      byOrderId.set(orderId, {
        repurchaseRank: rankByOrderId.get(orderId) ?? null,
        totalSpendCents: totals.totalSpendCents,
        totalRefundCents: totals.totalRefundCents,
      });
    }
    return { byOrderId, byRecipientId };
  }

  public orderIdsForRecipient(recipientId: string): string[] {
    const { byId, byPair } = this.recipientIndexes();
    const row = byId.get(recipientId);
    if (!row) throw new Error('未找到收件人');
    const final = this.resolveFinalRecipient(row, byId);
    return (this.ordersByFinalRecipientId(byPair, byId).get(asString(final.id)) ?? [])
      .map((order) => asString(order.id));
  }

  public ensureRecipient(name: string, phoneNormalized: string, now: string): void {
    if (!name.trim() || !phoneNormalized.trim()) return;
    this.workspace.database.prepare(`
      INSERT OR IGNORE INTO recipients (
        id, recipient_number, name, phone_normalized, created_at
      ) VALUES (
        ?,
        COALESCE((SELECT MAX(recipient_number) FROM recipients), 0) + 1,
        ?, ?, ?
      )
    `).run(randomUUID(), name, phoneNormalized, now);
  }

  public mergeRecipients(input: unknown): RecipientSummaryView[] {
    const record = objectValue(input, '合并收件人参数无效');
    rejectUnknownKeys(
      record,
      ['sourceRecipientId', 'targetRecipientId', 'keepNameFrom', 'reason'],
      '合并收件人参数无效',
    );
    const sourceRecipientId = boundedText(
      record.sourceRecipientId,
      200,
      '来源收件人标识无效',
    );
    const targetRecipientId = boundedText(
      record.targetRecipientId,
      200,
      '目标收件人标识无效',
    );
    if (record.keepNameFrom !== 'source' && record.keepNameFrom !== 'target') {
      throw new Error('显示名称存续选择无效');
    }
    const reason = boundedText(record.reason, 500, '请填写非空原因');
    if (sourceRecipientId === targetRecipientId) {
      throw new Error('不能将收件人合并到其自身');
    }
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const source = this.recipientRow(sourceRecipientId);
      const target = this.recipientRow(targetRecipientId);
      if (!source || !target) throw new Error('未找到收件人');
      if (
        source.merged_into_recipient_id !== null
        || target.merged_into_recipient_id !== null
      ) {
        throw new Error('收件人已合并，不能再次合并');
      }
      if (record.keepNameFrom === 'source') {
        this.workspace.database.prepare(`
          UPDATE recipients SET display_name = ? WHERE id = ?
        `).run(
          source.display_name === null ? asString(source.name) : asString(source.display_name),
          targetRecipientId,
        );
      }
      this.workspace.database.prepare(`
        UPDATE recipients
        SET merged_into_recipient_id = ?, merged_reason = ?, merged_at = ?
        WHERE id = ?
      `).run(targetRecipientId, reason, now, sourceRecipientId);
    });
    return this.queryRecipientSummaries();
  }

  public readableOrderNumbers(
    orderIds: readonly string[],
  ): ReadonlyMap<string, string | null> {
    const uniqueOrderIds = [...new Set(orderIds)];
    const result = new Map<string, string | null>();
    if (uniqueOrderIds.length === 0) return result;

    const { byId: recipientById, byPair: recipientByPair } = this.recipientIndexes();
    const createdAtByOrderId = new Map<string, string>();
    const recipientNumberByOrderId = new Map<string, number>();
    const spotGroups = new Map<string, Array<{ id: string; createdAt: string }>>();
    const orderRows = this.workspace.database.prepare(`
      SELECT id, recipient, phone_normalized, created_at
      FROM original_orders
    `).all() as unknown as SqlRow[];
    for (const row of orderRows) {
      const orderId = asString(row.id);
      const createdAt = asString(row.created_at);
      createdAtByOrderId.set(orderId, createdAt);
      const name = asString(row.recipient);
      const phone = asString(row.phone_normalized);
      if (!name.trim() || !phone.trim()) continue;
      const pair = recipientByPair.get(recipientPairKey(name, phone));
      if (!pair) continue;
      const final = this.resolveFinalRecipient(pair, recipientById);
      recipientNumberByOrderId.set(orderId, Number(final.recipient_number));
      const groupKey = `${asString(final.id)}|${shanghaiMonthKey(createdAt)}`;
      const group = spotGroups.get(groupKey) ?? [];
      group.push({ id: orderId, createdAt });
      spotGroups.set(groupKey, group);
    }
    const spotSequenceByOrderId = new Map<string, number>();
    for (const group of spotGroups.values()) {
      group.sort((first, second) => (
        Date.parse(first.createdAt) - Date.parse(second.createdAt)
        || first.id.localeCompare(second.id)
      ));
      group.forEach((entry, index) => spotSequenceByOrderId.set(entry.id, index + 1));
    }

    const planIdByOrderId = new Map<string, string>();
    const memberRows = this.workspace.database.prepare(`
      SELECT order_id, plan_id, released_at, removed_at
      FROM fulfillment_plan_members
      WHERE order_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(uniqueOrderIds)) as unknown as SqlRow[];
    for (const row of memberRows) {
      if (row.released_at === null && row.removed_at === null) {
        planIdByOrderId.set(asString(row.order_id), asString(row.plan_id));
      }
    }
    for (const row of memberRows) {
      if (row.released_at !== null && !planIdByOrderId.has(asString(row.order_id))) {
        planIdByOrderId.set(asString(row.order_id), asString(row.plan_id));
      }
    }

    const createdAtByPlanId = new Map<string, string>();
    const batchByPlanId = new Map<string, number>();
    const planRows = this.workspace.database.prepare(`
      SELECT id, created_at FROM fulfillment_plans
    `).all() as unknown as SqlRow[];
    const planGroups = new Map<string, Array<{ id: string; createdAt: string }>>();
    for (const row of planRows) {
      const planId = asString(row.id);
      const createdAt = asString(row.created_at);
      createdAtByPlanId.set(planId, createdAt);
      const groupKey = shanghaiMonthKey(createdAt);
      const group = planGroups.get(groupKey) ?? [];
      group.push({ id: planId, createdAt });
      planGroups.set(groupKey, group);
    }
    for (const group of planGroups.values()) {
      group.sort((first, second) => (
        Date.parse(first.createdAt) - Date.parse(second.createdAt)
        || first.id.localeCompare(second.id)
      ));
      group.forEach((entry, index) => batchByPlanId.set(entry.id, index + 1));
    }

    for (const orderId of uniqueOrderIds) {
      const recipientNumber = recipientNumberByOrderId.get(orderId);
      const createdAt = createdAtByOrderId.get(orderId);
      if (recipientNumber === undefined || createdAt === undefined) {
        result.set(orderId, null);
        continue;
      }
      const planId = planIdByOrderId.get(orderId);
      if (planId !== undefined) {
        const batch = batchByPlanId.get(planId);
        const planCreatedAt = createdAtByPlanId.get(planId);
        if (batch === undefined || planCreatedAt === undefined) {
          throw new Error('数据库履约计划成员指向缺失计划');
        }
        result.set(orderId, formatReadableOrderNumber({
          yymm: shanghaiYYMM(planCreatedAt),
          sequence: batch,
          recipientNumber,
          kind: 'PL',
        }));
        continue;
      }
      const sequence = spotSequenceByOrderId.get(orderId);
      if (sequence === undefined) {
        result.set(orderId, null);
        continue;
      }
      result.set(orderId, formatReadableOrderNumber({
        yymm: shanghaiYYMM(createdAt),
        sequence,
        recipientNumber,
        kind: 'PT',
      }));
    }
    return result;
  }

  private recipientRow(recipientId: string): SqlRow | undefined {
    return this.workspace.database.prepare(`
      SELECT id, name, display_name, merged_into_recipient_id
      FROM recipients
      WHERE id = ?
    `).get(recipientId) as SqlRow | undefined;
  }

  private recipientIndexes(): { byId: Map<string, SqlRow>; byPair: Map<string, SqlRow> } {
    const byId = new Map<string, SqlRow>();
    const byPair = new Map<string, SqlRow>();
    const rows = this.workspace.database.prepare(`
      SELECT id, recipient_number, name, phone_normalized, display_name,
        merged_into_recipient_id
      FROM recipients
    `).all() as unknown as SqlRow[];
    for (const row of rows) {
      byId.set(asString(row.id), row);
      byPair.set(
        recipientPairKey(asString(row.name), asString(row.phone_normalized)),
        row,
      );
    }
    return { byId, byPair };
  }

  private resolveFinalRecipient(
    row: SqlRow,
    byId: ReadonlyMap<string, SqlRow>,
  ): SqlRow {
    let current = row;
    const seen = new Set<string>([asString(row.id)]);
    while (current.merged_into_recipient_id !== null) {
      const nextId = asString(current.merged_into_recipient_id);
      if (seen.has(nextId)) throw new Error('数据库收件人合并链存在循环');
      seen.add(nextId);
      const next = byId.get(nextId);
      if (!next) throw new Error('数据库收件人合并链指向缺失收件人');
      current = next;
    }
    return current;
  }

  private ordersByFinalRecipientId(
    byPair: ReadonlyMap<string, SqlRow>,
    byId: ReadonlyMap<string, SqlRow>,
  ): ReadonlyMap<string, SqlRow[]> {
    const rows = this.workspace.database.prepare(`
      SELECT id, recipient, phone_normalized, address_original, created_at
      FROM original_orders
      ORDER BY created_at, id
    `).all() as unknown as SqlRow[];
    const result = new Map<string, SqlRow[]>();
    for (const row of rows) {
      const name = asString(row.recipient);
      const phone = asString(row.phone_normalized);
      if (!name.trim() || !phone.trim()) continue;
      const pair = byPair.get(recipientPairKey(name, phone));
      if (!pair) continue;
      const final = this.resolveFinalRecipient(pair, byId);
      const orders = result.get(asString(final.id)) ?? [];
      orders.push(row);
      result.set(asString(final.id), orders);
    }
    return result;
  }
}

function recipientView(row: SqlRow): RecipientView {
  return {
    id: asString(row.id),
    recipientNumber: Number(row.recipient_number),
    name: asString(row.name),
    phoneNormalized: asString(row.phone_normalized),
    displayName: row.display_name === null ? null : asString(row.display_name),
    mergedIntoRecipientId: row.merged_into_recipient_id === null
      ? null
      : asString(row.merged_into_recipient_id),
    mergedReason: row.merged_reason === null ? null : asString(row.merged_reason),
    mergedAt: row.merged_at === null ? null : asString(row.merged_at),
    createdAt: asString(row.created_at),
  };
}

function recipientPairKey(name: string, phoneNormalized: string): string {
  return `${name}\u0000${phoneNormalized}`;
}

function asString(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(message);
}

function boundedText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(message);
  return normalized;
}

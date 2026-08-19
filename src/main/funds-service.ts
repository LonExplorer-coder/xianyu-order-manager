import { randomUUID } from 'node:crypto';

import {
  FINANCE_RECORD_TYPES,
  financeDirectionOfType,
  financeMoneyLabel,
  normalizeCancelPendingFinanceItemInput,
  normalizeConfirmPendingFinanceItemInput,
  normalizeRecordFinanceRecordInput,
  normalizeRecordPendingFinanceItemInput,
  normalizeReverseFinanceRecordInput,
} from '../core/funds';
import type {
  FinanceDirectionName,
  FinancePendingItemView,
  FinanceRecordTypeName,
  FinanceRecordView,
  FinanceSourceTypeName,
  FinanceTypeTotalView,
  FinancePendingTotalView,
  FundsView,
} from '../core/funds';
import type { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

const SOURCE_TABLES: Record<FinanceSourceTypeName, string> = {
  order: 'original_orders',
  shipment_record: 'shipment_records',
  aftersales_case: 'aftersales_cases',
  purchase_order: 'purchase_orders',
  supplier_return: 'supplier_returns',
  logistics_exception: 'logistics_exceptions',
};

export class FundsService {
  public constructor(private readonly workspace: Workspace) {}

  public view(): FundsView {
    return this.buildView();
  }

  // 业务事实产生待确认资金事项（ADR 0042：业务完成不冒充资金已发生）。
  // 幂等锚点是 (来源类型, 来源标识, 类型)：source_id 必须指向具体业务事实（如某笔退款记录），
  // 重复提交同一事实是幂等无操作，不叠加金额。
  public recordPendingItem(input: unknown): FundsView {
    const prepared = normalizeRecordPendingFinanceItemInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.requireSourceRecord(prepared.sourceType, prepared.sourceId);
      this.workspace.database.prepare(`
        INSERT OR IGNORE INTO finance_pending_items (
          id, type, direction, amount_cents, currency, status,
          source_type, source_id, note, occurred_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'CNY', 'pending', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        prepared.type,
        financeDirectionOfType(prepared.type),
        prepared.amountCents,
        prepared.sourceType,
        prepared.sourceId,
        prepared.note,
        prepared.occurredAt,
        now,
        now,
      );
    });
    return this.buildView();
  }

  // 人工确认待确认事项的一部分或全部：生成不可变资金记录，不动事项本身。
  public confirmPendingItem(input: unknown): FundsView {
    const prepared = normalizeConfirmPendingFinanceItemInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const item = this.requirePendingItem(prepared.pendingItemId);
      if (item.status === 'cancelled') {
        throw new Error('该待确认事项已经取消，不能继续确认');
      }
      const remaining = this.remainingCents(item);
      if (prepared.amountCents > remaining) {
        throw new Error(`剩余可确认金额 ${financeMoneyLabel(remaining)}，`
          + `不够确认 ${financeMoneyLabel(prepared.amountCents)}`);
      }
      this.insertRecord({
        type: item.type as FinanceRecordTypeName,
        direction: item.direction as FinanceDirectionName,
        amountCents: prepared.amountCents,
        occurredAt: prepared.occurredAt !== undefined && prepared.occurredAt !== ''
          ? prepared.occurredAt
          : now,
        confirmedAt: now,
        pendingItemId: String(item.id),
        sourceType: item.source_type as FinanceSourceTypeName,
        sourceId: String(item.source_id),
        reversesRecordId: null,
        note: prepared.note ?? '',
        createdAt: now,
      });
    });
    return this.buildView();
  }

  // 取消只取消剩余待确认金额；已确认的资金记录保留，历史不被覆盖。
  public cancelPendingItem(input: unknown): FundsView {
    const prepared = normalizeCancelPendingFinanceItemInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const item = this.requirePendingItem(prepared.pendingItemId);
      if (item.status === 'cancelled') {
        throw new Error('该待确认事项已经取消');
      }
      if (this.remainingCents(item) <= 0) {
        throw new Error('该事项已全部确认，没有可取消的剩余金额');
      }
      this.workspace.database.prepare(`
        UPDATE finance_pending_items
        SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(now, prepared.reason, now, item.id);
    });
    return this.buildView();
  }

  // 直接录入已确认的资金记录（如自付运费、人工费用）；没有待确认阶段。
  public recordDirectRecord(input: unknown): FundsView {
    const prepared = normalizeRecordFinanceRecordInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.insertRecord({
        type: prepared.type,
        direction: prepared.direction,
        amountCents: prepared.amountCents,
        occurredAt: prepared.occurredAt,
        confirmedAt: now,
        pendingItemId: null,
        sourceType: null,
        sourceId: null,
        reversesRecordId: null,
        note: prepared.note,
        createdAt: now,
      });
    });
    return this.buildView();
  }

  // 冲正生成反向记录：类型与原记录一致、方向相反、金额不超过原记录未冲正余额；
  // 原记录保持不变。经待确认事项确认的记录冲正后，该事项的剩余可确认金额自动回补。
  public reverseRecord(input: unknown): FundsView {
    const prepared = normalizeReverseFinanceRecordInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const original = this.workspace.database.prepare(`
        SELECT id, type, direction, amount_cents, pending_item_id
        FROM finance_records WHERE id = ?
      `).get(prepared.recordId) as unknown as SqlRow | undefined;
      if (!original) throw new Error('资金记录不存在');

      const reversedRow = this.workspace.database.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS reversed
        FROM finance_records WHERE reverses_record_id = ?
      `).get(prepared.recordId) as unknown as SqlRow;
      const unreversed = Number(original.amount_cents) - Number(reversedRow.reversed);
      if (prepared.amountCents > unreversed) {
        throw new Error(`冲正金额超过原记录未冲正余额（未冲正 ${financeMoneyLabel(unreversed)}）`);
      }

      const opposite: FinanceDirectionName = original.direction === 'income' ? 'expense' : 'income';
      this.insertRecord({
        type: original.type as FinanceRecordTypeName,
        direction: opposite,
        amountCents: prepared.amountCents,
        occurredAt: prepared.occurredAt !== undefined && prepared.occurredAt !== ''
          ? prepared.occurredAt
          : now,
        confirmedAt: now,
        pendingItemId: (original.pending_item_id as string | null) ?? null,
        sourceType: null,
        sourceId: null,
        reversesRecordId: original.id as string,
        note: prepared.note,
        createdAt: now,
      });
    });
    return this.buildView();
  }

  private remainingCents(row: SqlRow): number {
    const signed = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(CASE direction WHEN 'income' THEN amount_cents ELSE -amount_cents END), 0)
        AS signed
      FROM finance_records WHERE pending_item_id = ?
    `).get(row.id) as unknown as SqlRow;
    const sign = row.direction === 'income' ? 1 : -1;
    return Number(row.amount_cents) - sign * Number(signed.signed);
  }

  private requirePendingItem(id: string): SqlRow {
    const item = this.workspace.database.prepare(`
      SELECT id, type, direction, amount_cents, status, source_type, source_id
      FROM finance_pending_items WHERE id = ?
    `).get(id) as unknown as SqlRow | undefined;
    if (!item) throw new Error('待确认资金事项不存在');
    return item;
  }

  private requireSourceRecord(sourceType: FinanceSourceTypeName, sourceId: string): void {
    const exists = this.workspace.database.prepare(`
      SELECT 1 FROM ${SOURCE_TABLES[sourceType]} WHERE id = ?
    `).get(sourceId);
    if (!exists) throw new Error('来源记录不存在');
  }

  private insertRecord(entry: {
    type: FinanceRecordTypeName;
    direction: FinanceDirectionName;
    amountCents: number;
    occurredAt: string;
    confirmedAt: string;
    pendingItemId: string | null;
    sourceType: FinanceSourceTypeName | null;
    sourceId: string | null;
    reversesRecordId: string | null;
    note: string;
    createdAt: string;
  }): void {
    this.workspace.database.prepare(`
      INSERT INTO finance_records (
        id, type, direction, amount_cents, currency, confirmed_source,
        occurred_at, confirmed_at, pending_item_id, source_type, source_id,
        reverses_record_id, note, created_at
      ) VALUES (?, ?, ?, ?, 'CNY', 'manual_confirmation', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      entry.type,
      entry.direction,
      entry.amountCents,
      entry.occurredAt,
      entry.confirmedAt,
      entry.pendingItemId,
      entry.sourceType,
      entry.sourceId,
      entry.reversesRecordId,
      entry.note,
      entry.createdAt,
    );
  }

  private buildView(): FundsView {
    const pendingItems = (this.workspace.database.prepare(`
      SELECT id, type, direction, amount_cents, status, source_type, source_id,
        note, occurred_at, cancelled_at, cancel_reason, created_at
      FROM finance_pending_items
      ORDER BY created_at, id
    `).all() as unknown as SqlRow[]).map((row) => {
      const confirmed = Number(row.amount_cents) - this.remainingCents(row);
      const cancelled = row.status === 'cancelled';
      return {
        id: String(row.id),
        type: row.type as FinanceRecordTypeName,
        direction: row.direction as FinanceDirectionName,
        amountCents: Number(row.amount_cents),
        currency: 'CNY' as const,
        status: row.status as 'pending' | 'cancelled',
        confirmedCents: confirmed,
        remainingCents: cancelled ? 0 : this.remainingCents(row),
        sourceType: row.source_type as FinanceSourceTypeName,
        sourceId: String(row.source_id),
        note: String(row.note),
        occurredAt: String(row.occurred_at),
        cancelledAt: row.cancelled_at === null ? null : String(row.cancelled_at),
        cancelReason: row.cancel_reason === null ? null : String(row.cancel_reason),
        createdAt: String(row.created_at),
      } satisfies FinancePendingItemView;
    });

    const records = (this.workspace.database.prepare(`
      SELECT sequence, id, type, direction, amount_cents, confirmed_source,
        occurred_at, confirmed_at, pending_item_id, source_type, source_id,
        reverses_record_id, note, created_at
      FROM finance_records
      ORDER BY sequence
    `).all() as unknown as SqlRow[]).map((row) => ({
      id: String(row.id),
      sequence: Number(row.sequence),
      type: row.type as FinanceRecordTypeName,
      direction: row.direction as FinanceDirectionName,
      amountCents: Number(row.amount_cents),
      currency: 'CNY' as const,
      confirmedSource: 'manual_confirmation' as const,
      confirmedAt: String(row.confirmed_at),
      occurredAt: String(row.occurred_at),
      pendingItemId: row.pending_item_id === null ? null : String(row.pending_item_id),
      sourceType: row.source_type === null ? null : row.source_type as FinanceSourceTypeName,
      sourceId: row.source_id === null ? null : String(row.source_id),
      reversesRecordId: row.reverses_record_id === null
        ? null
        : String(row.reverses_record_id),
      note: String(row.note),
      createdAt: String(row.created_at),
    } satisfies FinanceRecordView));

    const typeTotals: FinanceTypeTotalView[] = FINANCE_RECORD_TYPES.map((type) => ({
      type,
      incomeCents: 0,
      expenseCents: 0,
      netCents: 0,
    }));
    const totalByType = new Map(typeTotals.map((total) => [total.type, total]));
    for (const record of records) {
      const total = totalByType.get(record.type)!;
      if (record.direction === 'income') total.incomeCents += record.amountCents;
      else total.expenseCents += record.amountCents;
    }
    for (const total of typeTotals) total.netCents = total.incomeCents - total.expenseCents;

    const pendingTotals: FinancePendingTotalView[] = FINANCE_RECORD_TYPES.map((type) => ({
      type,
      count: 0,
      amountCents: 0,
      remainingCents: 0,
    }));
    const pendingByType = new Map(pendingTotals.map((total) => [total.type, total]));
    for (const item of pendingItems) {
      if (item.status !== 'pending') continue;
      const total = pendingByType.get(item.type)!;
      total.count += 1;
      total.amountCents += item.amountCents;
      total.remainingCents += item.remainingCents;
    }

    const totals = {
      incomeCents: typeTotals.reduce((sum, row) => sum + row.incomeCents, 0),
      expenseCents: typeTotals.reduce((sum, row) => sum + row.expenseCents, 0),
      netCents: 0,
      pendingRemainingCents: pendingTotals.reduce((sum, row) => sum + row.remainingCents, 0),
    };
    totals.netCents = totals.incomeCents - totals.expenseCents;

    return { pendingItems, records, typeTotals, pendingTotals, totals };
  }
}

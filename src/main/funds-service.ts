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
  FinanceFactsForSource,
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

// 人工录入来源的存在性校验表。注意 (source_type, source_id) 是双层语义：
// 人工录入的 sourceId 指向这里的业务主表；业务钩子（ADR 0044）写入的 sourceId
// 是事实级锚点——aftersales_case 指向 legacy financial_records.id（逐笔退款），
// logistics_exception 指向 carrier_claims.id（索赔本身），两者都不在本表内。
const SOURCE_TABLES: Record<FinanceSourceTypeName, string> = {
  order: 'original_orders',
  shipment_record: 'shipment_records',
  aftersales_case: 'aftersales_cases',
  purchase_order: 'purchase_orders',
  supplier_return: 'supplier_returns',
  logistics_exception: 'logistics_exception_matters',
};

export class FundsService {
  public constructor(private readonly workspace: Workspace) {}

  public view(): FundsView {
    return this.buildView();
  }

  public factsForSource(sourceType: FinanceSourceTypeName, sourceId: string): FinanceFactsForSource {
    const view = this.buildView();
    return {
      pendingItems: view.pendingItems.filter((item) => (
        item.sourceType === sourceType && item.sourceId === sourceId
      )),
      records: view.records.filter((record) => (
        record.sourceType === sourceType && record.sourceId === sourceId
      )),
    };
  }

  // 售后处理单的资金聚合：直接挂单的事项/记录，加上按事实级锚点立账的
  // 实际退款（legacy financial_records 逐笔）与承运索赔同意（carrier_claims）。
  public factsForAftersalesCase(caseId: string): FinanceFactsForSource {
    const caseSourceIds = new Set<string>([caseId]);
    for (const row of this.workspace.database.prepare(`
      SELECT id FROM financial_records WHERE aftersales_case_id = ?
    `).all(caseId) as unknown as SqlRow[]) {
      caseSourceIds.add(String(row.id));
    }
    return this.factsForAnchors(
      caseSourceIds,
      new Set<string>((
        this.workspace.database.prepare(`
          SELECT c.id AS id
          FROM carrier_claims c
          JOIN aftersales_return_records r ON r.id = c.return_record_id
          WHERE r.aftersales_case_id = ?
        `).all(caseId) as unknown as SqlRow[]
      ).map((row) => String(row.id))),
    );
  }

  // 发货记录的资金聚合：直接挂记录的记录（如首发运费），加上该记录各包裹的
  // 正向丢件索赔同意待确认（carrier_claims 出库方向，ADR 0044）。
  public factsForShipmentRecord(recordId: string): FinanceFactsForSource {
    const claimIds = new Set<string>((
      this.workspace.database.prepare(`
        SELECT c.id AS id
        FROM carrier_claims c
        JOIN shipment_packages p ON p.id = c.shipment_package_id
        WHERE c.direction = 'outbound' AND p.shipment_record_id = ?
      `).all(recordId) as unknown as SqlRow[]
    ).map((row) => String(row.id)));
    return this.factsForAnchors(new Set<string>([recordId]), claimIds);
  }

  private factsForAnchors(
    primarySourceIds: Set<string>,
    claimIds: Set<string>,
  ): FinanceFactsForSource {
    const view = this.buildView();
    const belongs = (sourceType: FinanceSourceTypeName, sourceId: string | null): boolean => (
      sourceId !== null
      && ((sourceType === 'aftersales_case' && primarySourceIds.has(sourceId))
        || (sourceType === 'shipment_record' && primarySourceIds.has(sourceId))
        || (sourceType === 'logistics_exception' && claimIds.has(sourceId)))
    );
    return {
      pendingItems: view.pendingItems.filter((item) => belongs(item.sourceType, item.sourceId)),
      records: view.records.filter((record) => (
        record.sourceType !== null && belongs(record.sourceType, record.sourceId)
      )),
    };
  }

  // 业务事实产生待确认资金事项（ADR 0042：业务完成不冒充资金已发生）。
  // 幂等锚点是 (来源类型, 来源标识, 类型)：source_id 必须指向具体业务事实（如某笔退款记录），
  // 重复提交同一事实是幂等无操作，不叠加金额。
  public recordPendingItem(input: unknown): FundsView {
    const prepared = normalizeRecordPendingFinanceItemInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.requireSourceRecord(prepared.sourceType, prepared.sourceId);
      this.insertPendingItem(prepared, now);
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

  // 业务事实钩子：在业务事务内幂等立账待确认事项（#74）。
  // 与人工入口不同：来源存在性由调用方的事实真实性保证，不重复校验；
  // 重复提交同一事实被唯一锚点吞掉。业务完成到这里为止，绝不生成资金记录。
  // 注意：note 沿用业务侧说明，两侧长度上限都是 500（aftersales-cases / logistics-exceptions），
  // 业务侧放宽前这里隐式依赖该上限。
  public recordBusinessPendingFact(fact: {
    type: FinanceRecordTypeName;
    amountCents: number;
    sourceType: FinanceSourceTypeName;
    sourceId: string;
    note: string;
    occurredAt: string;
  }): void {
    this.insertPendingItem(fact, new Date().toISOString());
  }

  // 幂等只作用于 (来源类型, 来源标识, 类型) 锚点；其他约束冲突照常抛错，不静默吞掉。
  private insertPendingItem(entry: {
    type: FinanceRecordTypeName;
    amountCents: number;
    sourceType: FinanceSourceTypeName;
    sourceId: string;
    note: string;
    occurredAt: string;
  }, now: string): void {
    this.workspace.database.prepare(`
      INSERT INTO finance_pending_items (
        id, type, direction, amount_cents, currency, status,
        source_type, source_id, note, occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'CNY', 'pending', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_type, source_id, type) DO NOTHING
    `).run(
      randomUUID(),
      entry.type,
      financeDirectionOfType(entry.type),
      entry.amountCents,
      entry.sourceType,
      entry.sourceId,
      entry.note,
      entry.occurredAt,
      now,
      now,
    );
  }

  // 直接录入已确认的资金记录（如自付运费、人工费用、采购付款）；来源可选，
  // 提供时必须指向真实业务记录（校验存在），确认后记录永久关联该来源。
  public recordDirectRecord(input: unknown): FundsView {
    const prepared = normalizeRecordFinanceRecordInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      if (prepared.sourceType !== undefined && prepared.sourceId !== undefined) {
        this.requireSourceRecord(prepared.sourceType, prepared.sourceId);
      }
      this.insertRecord({
        type: prepared.type,
        direction: prepared.direction,
        amountCents: prepared.amountCents,
        occurredAt: prepared.occurredAt,
        confirmedAt: now,
        pendingItemId: null,
        sourceType: prepared.sourceType ?? null,
        sourceId: prepared.sourceId ?? null,
        reversesRecordId: null,
        note: prepared.note,
        createdAt: now,
      });
    });
    return this.buildView();
  }

  // 冲正生成反向记录：类型与原记录一致、方向相反、金额不超过原记录未冲正余额；
  // 原记录保持不变，来源与待确认事项归属沿用原记录。经待确认事项确认的记录冲正后，
  // 该事项的剩余可确认金额自动回补。
  public reverseRecord(input: unknown): FundsView {
    const prepared = normalizeReverseFinanceRecordInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const original = this.workspace.database.prepare(`
        SELECT id, type, direction, amount_cents, pending_item_id, source_type, source_id
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
        sourceType: (original.source_type as FinanceSourceTypeName | null) ?? null,
        sourceId: (original.source_id as string | null) ?? null,
        reversesRecordId: original.id as string,
        note: prepared.note,
        createdAt: now,
      });
    });
    return this.buildView();
  }

  // 与 buildView 的聚合口径保持一致：剩余待确认按方向加权净额，最低钳到 0。
  private remainingCents(row: SqlRow): number {
    const signed = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(CASE direction WHEN 'income' THEN amount_cents ELSE -amount_cents END), 0)
        AS signed
      FROM finance_records WHERE pending_item_id = ?
    `).get(row.id) as unknown as SqlRow;
    const sign = row.direction === 'income' ? 1 : -1;
    return Math.max(Number(row.amount_cents) - sign * Number(signed.signed), 0);
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
    const pendingItems = (this.workspace.database.prepare(`
      SELECT id, type, direction, amount_cents, status, source_type, source_id,
        note, occurred_at, cancelled_at, cancel_reason, created_at
      FROM finance_pending_items
      ORDER BY created_at, id
    `).all() as unknown as SqlRow[]).map((row) => {
      const sign = row.direction === 'income' ? 1 : -1;
      const remaining = Math.max(
        Number(row.amount_cents) - sign * (signedByPendingItem.get(String(row.id)) ?? 0),
        0,
      );
      const cancelled = row.status === 'cancelled';
      return {
        id: String(row.id),
        type: row.type as FinanceRecordTypeName,
        direction: row.direction as FinanceDirectionName,
        amountCents: Number(row.amount_cents),
        currency: 'CNY' as const,
        status: row.status as 'pending' | 'cancelled',
        confirmedCents: Number(row.amount_cents) - remaining,
        remainingCents: cancelled ? 0 : remaining,
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

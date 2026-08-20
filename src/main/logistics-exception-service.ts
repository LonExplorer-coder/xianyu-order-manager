import { randomUUID } from 'node:crypto';

import {
  assertOccurredAtNotBefore,
  prepareLogisticsExceptionOpening,
  prepareLogisticsExceptionProgress,
  supportsCarrierClaim,
  type CarrierClaim,
  type LogisticsDirection,
  type LogisticsAffectedItem,
  type LogisticsExceptionEvidence,
  type LogisticsExceptionImpact,
  type LogisticsExceptionMatter,
  type LogisticsExceptionStage,
  type LogisticsExceptionType,
} from '../core/logistics-exceptions';
import { Workspace } from './workspace';
import { FundsService } from './funds-service';

type SqlRow = Record<string, string | number | null>;

export type LogisticsSubject = {
  direction: LogisticsDirection;
  packageId: string;
};

export class LogisticsExceptionService {
  public constructor(private readonly workspace: Workspace) {}

  private fundsService(): FundsService {
    return new FundsService(this.workspace);
  }

  public openException(input: {
    subject: LogisticsSubject;
    expectedPackageRevision: number;
    exceptionType: LogisticsExceptionType;
    stage: LogisticsExceptionStage;
    impact: LogisticsExceptionImpact;
    availableItems: readonly LogisticsAffectedItem[];
    evidence: LogisticsExceptionEvidence;
    occurredAt: string;
    reason: string;
  }): LogisticsExceptionMatter {
    prepareLogisticsExceptionOpening(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const table = input.subject.direction === 'outbound'
        ? 'shipment_packages'
        : 'aftersales_return_records';
      const packageUpdated = this.workspace.database.prepare(`
        UPDATE ${table}
        SET revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(input.subject.packageId, input.expectedPackageRevision);
      if (packageUpdated.changes !== 1) throw new Error('包裹事实已在其他操作中更新');
      this.workspace.database.prepare(`
        INSERT INTO logistics_exception_matters (
          id, direction, shipment_package_id, return_record_id,
          exception_type, stage, revision, impact_json, reason,
          occurred_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.subject.direction,
        input.subject.direction === 'outbound' ? input.subject.packageId : null,
        input.subject.direction === 'return' ? input.subject.packageId : null,
        input.exceptionType,
        input.stage,
        JSON.stringify(input.impact),
        input.reason,
        input.occurredAt,
        now,
        now,
      );
      this.workspace.database.prepare(`
        INSERT INTO logistics_exception_events (
          id, exception_id, kind, base_revision, result_revision,
          before_stage, after_stage, reason, occurred_at, impact_json, created_at
        ) VALUES (?, ?, 'opened', 0, 1, NULL, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        id,
        input.stage,
        input.reason,
        input.occurredAt,
        JSON.stringify(input.impact),
        now,
      );
    });
    return this.requireException(input.subject, id);
  }

  public progressException(input: {
    subject: LogisticsSubject;
    exceptionId: string;
    expectedExceptionRevision: number;
    stage: LogisticsExceptionStage;
    evidence: LogisticsExceptionEvidence;
    occurredAt: string;
    reason: string;
  }): LogisticsExceptionMatter {
    const current = this.requireException(input.subject, input.exceptionId);
    if (current.revision !== input.expectedExceptionRevision) {
      throw new Error('物流异常已在其他操作中更新，请刷新后重试');
    }
    prepareLogisticsExceptionProgress({
      exceptionType: current.exceptionType,
      currentStage: current.stage,
      nextStage: input.stage,
      occurredAt: input.occurredAt,
      latestOccurredAt: current.timeline.at(-1)?.occurredAt ?? current.occurredAt,
      evidence: input.evidence,
    });
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const updated = this.workspace.database.prepare(`
        UPDATE logistics_exception_matters
        SET stage = ?, revision = revision + 1, reason = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        input.stage,
        input.reason,
        now,
        current.id,
        current.revision,
      );
      if (updated.changes !== 1) throw new Error('物流异常已在其他操作中更新');
      this.workspace.database.prepare(`
        INSERT INTO logistics_exception_events (
          id, exception_id, kind, base_revision, result_revision,
          before_stage, after_stage, reason, occurred_at, impact_json, created_at
        ) VALUES (?, ?, 'stage_changed', ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        randomUUID(),
        current.id,
        current.revision,
        current.revision + 1,
        current.stage,
        input.stage,
        input.reason,
        input.occurredAt,
        now,
      );
    });
    return this.requireException(input.subject, current.id);
  }

  public getExceptions(subject: LogisticsSubject): LogisticsExceptionMatter[] {
    const column = subject.direction === 'outbound' ? 'shipment_package_id' : 'return_record_id';
    const rows = this.workspace.database.prepare(`
      SELECT * FROM logistics_exception_matters
      WHERE direction = ? AND ${column} = ?
      ORDER BY occurred_at, created_at, id
    `).all(subject.direction, subject.packageId) as unknown as SqlRow[];
    return rows.map((row) => this.exceptionFromRow(subject, row));
  }

  public openClaim(input: {
    subject: LogisticsSubject;
    exception: LogisticsExceptionMatter;
    latestOccurredAt: string;
    impact: LogisticsExceptionImpact;
    requestedAmountCents: number;
    occurredAt: string;
    reason: string;
  }): CarrierClaim {
    if (!supportsCarrierClaim(input.exception)) {
      throw new Error('当前物流异常尚不能建立承运索赔');
    }
    if (this.getClaim(input.subject)) throw new Error('当前包裹已经建立承运索赔');
    assertOccurredAtNotBefore(
      input.occurredAt,
      input.exception.timeline.at(-1)?.occurredAt ?? input.latestOccurredAt,
      '承运索赔时间不能早于物流异常时间',
    );
    const claimId = randomUUID();
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.workspace.database.prepare(`
        INSERT INTO carrier_claims (
          id, direction, shipment_package_id, return_record_id,
          status, revision, requested_amount_cents, approved_amount_cents,
          impact_json, reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 1, ?, NULL, ?, ?, ?, ?)
      `).run(
        claimId,
        input.subject.direction,
        input.subject.direction === 'outbound' ? input.subject.packageId : null,
        input.subject.direction === 'return' ? input.subject.packageId : null,
        input.requestedAmountCents,
        JSON.stringify(input.impact),
        input.reason,
        now,
        now,
      );
      this.workspace.database.prepare(`
        INSERT INTO carrier_claim_events (
          id, claim_id, kind, base_revision, result_revision,
          occurred_at, reason, amount_cents, impact_json, created_at
        ) VALUES (?, ?, 'opened', 0, 1, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        claimId,
        input.occurredAt,
        input.reason,
        input.requestedAmountCents,
        JSON.stringify(input.impact),
        now,
      );
    });
    return this.requireClaim(input.subject);
  }

  public resolveClaim(input: {
    subject: LogisticsSubject;
    expectedClaimRevision: number;
    outcome: 'approved' | 'rejected';
    approvedAmountCents: number | null;
    occurredAt: string;
    reason: string;
  }): CarrierClaim {
    const claim = this.requireClaim(input.subject);
    if (claim.status !== 'pending' || claim.revision !== input.expectedClaimRevision) {
      throw new Error('承运索赔已在其他操作中更新，请刷新后重试');
    }
    assertOccurredAtNotBefore(
      input.occurredAt,
      claim.timeline.at(-1)?.occurredAt ?? claim.createdAt,
      '承运索赔结果时间不能早于上一条索赔事件',
    );
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const updated = this.workspace.database.prepare(`
        UPDATE carrier_claims
        SET status = ?, revision = revision + 1, approved_amount_cents = ?,
            reason = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'pending'
      `).run(
        input.outcome,
        input.approvedAmountCents,
        input.reason,
        now,
        claim.id,
        claim.revision,
      );
      if (updated.changes !== 1) throw new Error('承运索赔已在其他操作中更新');
      this.workspace.database.prepare(`
        INSERT INTO carrier_claim_events (
          id, claim_id, kind, base_revision, result_revision,
          occurred_at, reason, amount_cents, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        claim.id,
        input.outcome,
        claim.revision,
        claim.revision + 1,
        input.occurredAt,
        input.reason,
        input.approvedAmountCents,
        now,
      );
      // 业务资金钩子（#74）：承运方同意赔付只立待确认事项，锚点是本索赔；
      // 实际到账前保持待确认，确认实际赔付不自动生成资金记录。
      if (input.outcome === 'approved' && input.approvedAmountCents !== null) {
        this.fundsService().recordBusinessPendingFact({
          type: 'carrier_claim',
          amountCents: input.approvedAmountCents,
          sourceType: 'logistics_exception',
          sourceId: claim.id,
          note: input.reason,
          occurredAt: input.occurredAt,
        });
      }
    });
    return this.requireClaim(input.subject);
  }

  public confirmCompensation(input: {
    subject: LogisticsSubject;
    expectedClaimRevision: number;
    amountCents: number;
    occurredAt: string;
    note: string;
  }): CarrierClaim {
    const claim = this.requireClaim(input.subject);
    if (claim.status !== 'approved' || claim.revision !== input.expectedClaimRevision) {
      throw new Error('当前承运索赔尚不能确认实际赔付');
    }
    assertOccurredAtNotBefore(
      input.occurredAt,
      claim.timeline.at(-1)?.occurredAt ?? claim.createdAt,
      '实际赔付时间不能早于承运方同意赔付时间',
    );
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.workspace.database.prepare(`
        INSERT INTO carrier_compensation_records (
          id, claim_id, amount_cents, occurred_at, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), claim.id, input.amountCents, input.occurredAt, input.note, now);
      const updated = this.workspace.database.prepare(`
        UPDATE carrier_claims
        SET status = 'paid', revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'approved'
      `).run(now, claim.id, claim.revision);
      if (updated.changes !== 1) throw new Error('承运索赔已在其他操作中更新');
      this.workspace.database.prepare(`
        INSERT INTO carrier_claim_events (
          id, claim_id, kind, base_revision, result_revision,
          occurred_at, reason, amount_cents, created_at
        ) VALUES (?, ?, 'compensation_confirmed', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        claim.id,
        claim.revision,
        claim.revision + 1,
        input.occurredAt,
        input.note,
        input.amountCents,
        now,
      );
    });
    return this.requireClaim(input.subject);
  }

  public getClaim(subject: LogisticsSubject): CarrierClaim | null {
    const column = subject.direction === 'outbound' ? 'shipment_package_id' : 'return_record_id';
    const row = this.workspace.database.prepare(`
      SELECT * FROM carrier_claims
      WHERE direction = ? AND ${column} = ?
    `).get(subject.direction, subject.packageId) as SqlRow | undefined;
    if (!row) return null;
    const claimId = asString(row.id);
    const status = asCarrierClaimStatus(row.status);
    const compensationRow = this.workspace.database.prepare(`
      SELECT * FROM carrier_compensation_records WHERE claim_id = ?
    `).get(claimId) as SqlRow | undefined;
    const timeline = (this.workspace.database.prepare(`
      SELECT * FROM carrier_claim_events WHERE claim_id = ? ORDER BY result_revision
    `).all(claimId) as unknown as SqlRow[]).map((eventRow): CarrierClaim['timeline'][number] => {
      const kind = asString(eventRow.kind);
      const occurredAt = asString(eventRow.occurred_at);
      const createdAt = asString(eventRow.created_at);
      const resultRevision = asNumber(eventRow.result_revision);
      if (kind === 'opened') return {
        kind,
        resultRevision: 1,
        requestedAmountCents: asNumber(eventRow.amount_cents),
        impact: parseLogisticsImpact(eventRow.impact_json),
        reason: asString(eventRow.reason),
        occurredAt,
        createdAt,
      };
      const baseRevision = asNumber(eventRow.base_revision);
      if (kind === 'approved' || kind === 'rejected') return {
        kind,
        baseRevision,
        resultRevision,
        approvedAmountCents: eventRow.amount_cents === null
          ? null
          : asNumber(eventRow.amount_cents),
        reason: asString(eventRow.reason),
        occurredAt,
        createdAt,
      };
      if (kind !== 'compensation_confirmed') throw new Error('数据库承运索赔事件错误');
      return {
        kind,
        baseRevision,
        resultRevision,
        amountCents: asNumber(eventRow.amount_cents),
        note: asString(eventRow.reason),
        occurredAt,
        createdAt,
      };
    });
    return {
      id: claimId,
      status,
      revision: asNumber(row.revision),
      requestedAmountCents: asNumber(row.requested_amount_cents),
      approvedAmountCents: row.approved_amount_cents === null
        ? null
        : asNumber(row.approved_amount_cents),
      impact: parseLogisticsImpact(row.impact_json),
      reason: asString(row.reason),
      actualCompensation: compensationRow ? {
        id: asString(compensationRow.id),
        amountCents: asNumber(compensationRow.amount_cents),
        occurredAt: asString(compensationRow.occurred_at),
        note: asString(compensationRow.note),
        createdAt: asString(compensationRow.created_at),
      } : null,
      timeline,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  private requireClaim(subject: LogisticsSubject): CarrierClaim {
    const claim = this.getClaim(subject);
    if (!claim) throw new Error('当前包裹尚未建立承运索赔');
    return claim;
  }

  private requireException(
    subject: LogisticsSubject,
    exceptionId: string,
  ): LogisticsExceptionMatter {
    const column = subject.direction === 'outbound' ? 'shipment_package_id' : 'return_record_id';
    const row = this.workspace.database.prepare(`
      SELECT * FROM logistics_exception_matters
      WHERE id = ? AND direction = ? AND ${column} = ?
    `).get(exceptionId, subject.direction, subject.packageId) as SqlRow | undefined;
    if (!row) throw new Error('物流异常事项不存在');
    return this.exceptionFromRow(subject, row);
  }

  private exceptionFromRow(
    subject: LogisticsSubject,
    row: SqlRow,
  ): LogisticsExceptionMatter {
    const id = asString(row.id);
    const eventRows = this.workspace.database.prepare(`
      SELECT * FROM logistics_exception_events
      WHERE exception_id = ?
      ORDER BY result_revision
    `).all(id) as unknown as SqlRow[];
    const timeline = eventRows.map((eventRow): LogisticsExceptionMatter['timeline'][number] => {
      const kind = asString(eventRow.kind);
      const occurredAt = asString(eventRow.occurred_at);
      const createdAt = asString(eventRow.created_at);
      const resultRevision = asNumber(eventRow.result_revision);
      if (kind === 'opened') return {
        kind,
        resultRevision: 1,
        stage: asLogisticsExceptionStage(eventRow.after_stage),
        impact: parseLogisticsImpact(eventRow.impact_json),
        reason: asString(eventRow.reason),
        occurredAt,
        createdAt,
      };
      if (kind !== 'stage_changed') throw new Error('数据库物流异常事件错误');
      return {
        kind,
        baseRevision: asNumber(eventRow.base_revision),
        resultRevision,
        beforeStage: asLogisticsExceptionStage(eventRow.before_stage),
        afterStage: asLogisticsExceptionStage(eventRow.after_stage),
        reason: asString(eventRow.reason),
        occurredAt,
        createdAt,
      };
    });
    return {
      id,
      direction: subject.direction,
      packageId: subject.packageId,
      exceptionType: asLogisticsExceptionType(row.exception_type),
      stage: asLogisticsExceptionStage(row.stage),
      revision: asNumber(row.revision),
      impact: parseLogisticsImpact(row.impact_json),
      reason: asString(row.reason),
      occurredAt: asString(row.occurred_at),
      timeline,
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('数据库物流异常文本格式错误');
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('数据库物流异常数字格式错误');
  }
  return value;
}

function asCarrierClaimStatus(value: unknown): CarrierClaim['status'] {
  if (value === 'pending' || value === 'approved' || value === 'rejected' || value === 'paid') {
    return value;
  }
  throw new Error('数据库承运索赔状态错误');
}

function asLogisticsExceptionType(value: unknown): LogisticsExceptionType {
  if (
    value === 'lost'
    || value === 'delivery_dispute'
    || value === 'damaged'
    || value === 'misdelivered'
    || value === 'other'
  ) return value;
  throw new Error('数据库物流异常类型错误');
}

function asLogisticsExceptionStage(value: unknown): LogisticsExceptionStage {
  if (
    value === 'pending_verification'
    || value === 'investigating'
    || value === 'confirmed'
    || value === 'recovered'
    || value === 'resolved'
  ) return value;
  throw new Error('数据库物流异常阶段错误');
}

function parseLogisticsImpact(value: unknown): LogisticsExceptionImpact {
  if (typeof value !== 'string') throw new Error('数据库承运索赔影响范围错误');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('数据库承运索赔影响范围错误', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('数据库承运索赔影响范围错误');
  }
  const record = parsed as Record<string, unknown>;
  if (record.scope === 'package') return { scope: 'package' };
  if (record.scope !== 'items' || !Array.isArray(record.items) || record.items.length === 0) {
    throw new Error('数据库承运索赔影响范围错误');
  }
  return {
    scope: 'items',
    items: record.items.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('数据库承运索赔影响商品错误');
      }
      const item = value as Record<string, unknown>;
      if (
        typeof item.sourceItemId !== 'string'
        || !Number.isSafeInteger(item.quantity)
        || Number(item.quantity) <= 0
      ) throw new Error('数据库承运索赔影响商品错误');
      return { sourceItemId: item.sourceItemId, quantity: Number(item.quantity) };
    }),
  };
}

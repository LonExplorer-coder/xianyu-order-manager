import { randomUUID } from 'node:crypto';

import {
  assertOccurredAtNotBefore,
  supportsCarrierClaim,
  type CarrierClaim,
  type LogisticsDirection,
  type LogisticsStatus,
} from '../core/logistics-exceptions';
import { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

export type LogisticsSubject = {
  direction: LogisticsDirection;
  packageId: string;
};

export class LogisticsExceptionService {
  public constructor(private readonly workspace: Workspace) {}

  public openClaim(input: {
    subject: LogisticsSubject;
    currentStatus: LogisticsStatus;
    latestOccurredAt: string;
    requestedAmountCents: number;
    occurredAt: string;
    reason: string;
  }): CarrierClaim {
    if (!supportsCarrierClaim(input.currentStatus)) {
      throw new Error('当前物流状态不能建立承运索赔');
    }
    if (this.getClaim(input.subject)) throw new Error('当前包裹已经建立承运索赔');
    assertOccurredAtNotBefore(
      input.occurredAt,
      input.latestOccurredAt,
      '承运索赔时间不能早于物流异常时间',
    );
    const claimId = randomUUID();
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.workspace.database.prepare(`
        INSERT INTO carrier_claims (
          id, direction, shipment_package_id, return_record_id,
          status, revision, requested_amount_cents, approved_amount_cents,
          reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 1, ?, NULL, ?, ?, ?)
      `).run(
        claimId,
        input.subject.direction,
        input.subject.direction === 'outbound' ? input.subject.packageId : null,
        input.subject.direction === 'return' ? input.subject.packageId : null,
        input.requestedAmountCents,
        input.reason,
        now,
        now,
      );
      this.workspace.database.prepare(`
        INSERT INTO carrier_claim_events (
          id, claim_id, kind, base_revision, result_revision,
          occurred_at, reason, amount_cents, created_at
        ) VALUES (?, ?, 'opened', 0, 1, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        claimId,
        input.occurredAt,
        input.reason,
        input.requestedAmountCents,
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

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { OcrMonthlyUsage, OcrUsageEventRecord } from '../core/ocr-usage';
import type { OcrUsageEventStore } from './ocr-usage-service';

type SqlRow = Record<string, string | number | null>;

export class OcrUsageDatabase implements OcrUsageEventStore {
  private readonly database: DatabaseSync;

  public constructor(configDirectory: string) {
    mkdirSync(configDirectory, { recursive: true });
    this.database = new DatabaseSync(join(configDirectory, 'ocr-usage.sqlite3'), {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
      defensive: true,
    });
    this.database.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS ocr_usage_events (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL CHECK (length(workspace_key) = 64),
        occurred_at TEXT NOT NULL,
        call_kind TEXT NOT NULL
          CHECK (call_kind IN ('recognition', 'connection_test', 'candidate_adjudication')),
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_id TEXT NOT NULL DEFAULT '',
        estimated_cents INTEGER NOT NULL CHECK (estimated_cents >= 0)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS ocr_usage_events_by_occurred_at
      ON ocr_usage_events (occurred_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS imported_ocr_usage_workspaces (
        workspace_key TEXT PRIMARY KEY CHECK (length(workspace_key) = 64),
        imported_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS ocr_usage_events_are_immutable_on_update
      BEFORE UPDATE ON ocr_usage_events
      BEGIN
        SELECT RAISE(ABORT, 'ocr usage events are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS ocr_usage_events_are_immutable_on_delete
      BEFORE DELETE ON ocr_usage_events
      BEGIN
        SELECT RAISE(ABORT, 'ocr usage events are immutable');
      END;
    `);
  }

  public recordOcrUsageEvent(event: OcrUsageEventRecord): void {
    this.database.prepare(`
      INSERT INTO ocr_usage_events (
        id, workspace_key, occurred_at, call_kind, outcome,
        provider, model, request_id, estimated_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.workspaceKey,
      event.occurredAt,
      event.kind,
      event.outcome,
      event.provider,
      event.model,
      event.requestId ?? '',
      event.estimatedCents,
    );
  }

  public queryOcrMonthlyUsage(fromIso: string, toIso: string): OcrMonthlyUsage {
    const row = this.database.prepare(`
      SELECT
        COUNT(*) AS total_calls,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS succeeded_calls,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failed_calls,
        COALESCE(SUM(estimated_cents), 0) AS estimated_cost_cents
      FROM ocr_usage_events
      WHERE occurred_at >= ? AND occurred_at < ?
    `).get(fromIso, toIso) as SqlRow;
    return {
      totalCalls: Number(row.total_calls),
      succeededCalls: Number(row.succeeded_calls),
      failedCalls: Number(row.failed_calls),
      estimatedCostCents: Number(row.estimated_cost_cents),
    };
  }

  public queryRecentOcrUsageEvents(limit: number): OcrUsageEventRecord[] {
    const rows = this.database.prepare(`
      SELECT id, workspace_key, occurred_at, call_kind, outcome,
        provider, model, request_id, estimated_cents
      FROM ocr_usage_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `).all(limit) as unknown as SqlRow[];
    return rows.map((row) => {
      const requestId = String(row.request_id ?? '');
      return {
        id: String(row.id),
        workspaceKey: String(row.workspace_key),
        occurredAt: String(row.occurred_at),
        kind: String(row.call_kind) as OcrUsageEventRecord['kind'],
        outcome: String(row.outcome) as OcrUsageEventRecord['outcome'],
        provider: String(row.provider),
        model: String(row.model),
        ...(requestId ? { requestId } : {}),
        estimatedCents: Number(row.estimated_cents),
      };
    });
  }

  public importWorkspaceEvents(
    workspaceKey: string,
    events: readonly OcrUsageEventRecord[],
  ): void {
    const imported = this.database.prepare(`
      SELECT 1 FROM imported_ocr_usage_workspaces WHERE workspace_key = ?
    `).get(workspaceKey);
    if (imported) return;

    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO ocr_usage_events (
          id, workspace_key, occurred_at, call_kind, outcome,
          provider, model, request_id, estimated_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        insert.run(
          event.id,
          workspaceKey,
          event.occurredAt,
          event.kind,
          event.outcome,
          event.provider,
          event.model,
          event.requestId ?? '',
          event.estimatedCents,
        );
      }
      this.database.prepare(`
        INSERT INTO imported_ocr_usage_workspaces (workspace_key, imported_at)
        VALUES (?, ?)
      `).run(workspaceKey, new Date().toISOString());
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }
}

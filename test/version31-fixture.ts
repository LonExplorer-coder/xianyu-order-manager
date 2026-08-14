import type { DatabaseSync } from 'node:sqlite';

export function removeVersion31ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion32ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_interception_package_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_interception_packages_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_interception_packages_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspection_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS logistics_exception_identity_is_immutable_on_update;
    DROP TRIGGER IF EXISTS logistics_exception_matters_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS logistics_exception_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS logistics_exception_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS legacy_shipment_mixed_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS legacy_shipment_mixed_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS legacy_return_mixed_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS legacy_return_mixed_events_are_immutable_on_delete;
    DROP TABLE IF EXISTS logistics_exception_events;
    DROP TABLE IF EXISTS logistics_exception_matters;
    DROP TABLE IF EXISTS legacy_shipment_package_mixed_logistics_events;
    DROP TABLE IF EXISTS legacy_return_mixed_logistics_events;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion32ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion33ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_direction_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_direction_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_interception_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_interception_events_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_handling_direction_events;
    DROP TABLE IF EXISTS aftersales_interception_events;
    DELETE FROM schema_migrations WHERE version = 32;
    PRAGMA foreign_keys = ON;
  `);
  const hasHandlingDirection = (database.prepare('PRAGMA table_info(aftersales_cases)').all() as Array<{
    name: string;
  }>).some(({ name }) => name === 'handling_direction');
  if (hasHandlingDirection) {
    database.exec('ALTER TABLE aftersales_cases DROP COLUMN handling_direction;');
  }
}

export function removeVersion33ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion34ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_return_exception_decision_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_return_exception_decisions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_return_exception_decisions_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_return_exception_decision_events;
    DELETE FROM schema_migrations WHERE version = 33;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion34ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion35ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_processing_rounds_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_processing_rounds_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_processing_round_items_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_processing_round_items_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_round_returns_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_round_returns_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_replacement_shipments_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_replacement_shipments_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_replacement_items_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_replacement_items_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_processing_round_item_source_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_replacement_item_identity_is_valid_on_insert;
    DROP TABLE IF EXISTS aftersales_replacement_items;
    DROP TABLE IF EXISTS aftersales_replacement_shipments;
    DROP TABLE IF EXISTS aftersales_round_returns;
    DROP TABLE IF EXISTS aftersales_processing_round_items;
    DROP TABLE IF EXISTS aftersales_processing_rounds;
    DELETE FROM schema_migrations WHERE version = 34;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion35ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion36ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decision_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_link_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_links_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_links_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspection_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspections_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspections_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_outbound_exception_refund_links;
    DROP TABLE IF EXISTS aftersales_outbound_exception_decision_events;
    DROP TABLE IF EXISTS aftersales_outbound_exception_replacement_rounds;
    DROP TABLE IF EXISTS aftersales_intercepted_return_inspection_events;
    DROP TABLE IF EXISTS aftersales_interception_packages;
    DELETE FROM schema_migrations WHERE version = 35;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion36ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion38ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_refund_reopening_events;
    DELETE FROM schema_migrations WHERE version IN (36, 37);
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion38ExtensionArtifacts(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_case_workflow_template_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_case_workflow_template_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_workflow_template_versions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_workflow_template_versions_are_immutable_on_delete;
    DROP INDEX IF EXISTS aftersales_case_workflow_template_events_by_case;
    DROP TABLE IF EXISTS aftersales_case_workflow_template_events;
    DROP TABLE IF EXISTS aftersales_workflow_template_versions;
    DROP TABLE IF EXISTS aftersales_workflow_templates;

    DROP TRIGGER IF EXISTS aftersales_direction_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_direction_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS aftersales_direction_events_by_case;
    CREATE TABLE aftersales_handling_direction_events_v37 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('selected', 'changed')),
      before_direction TEXT CHECK (
        before_direction IS NULL OR before_direction IN (
          'waiting', 'intercept', 'refuse', 'only_refund', 'replacement', 'buyer_return'
        )
      ),
      after_direction TEXT NOT NULL CHECK (after_direction IN (
        'waiting', 'intercept', 'refuse', 'only_refund', 'replacement', 'buyer_return'
      )),
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      CHECK (
        (kind = 'selected' AND before_direction IS NULL)
        OR (kind = 'changed' AND before_direction IS NOT NULL
          AND before_direction <> after_direction)
      )
    ) STRICT;
    INSERT INTO aftersales_handling_direction_events_v37 (
      sequence, id, case_id, kind, before_direction, after_direction,
      occurred_at, reason, created_at
    )
    SELECT sequence, id, case_id, kind, before_direction, after_direction,
      occurred_at, reason, created_at
    FROM aftersales_handling_direction_events
    WHERE kind <> 'cleared';
    DROP TABLE aftersales_handling_direction_events;
    ALTER TABLE aftersales_handling_direction_events_v37
      RENAME TO aftersales_handling_direction_events;
    CREATE INDEX aftersales_direction_events_by_case
      ON aftersales_handling_direction_events (case_id, sequence);
    CREATE TRIGGER aftersales_direction_events_are_immutable_on_update
    BEFORE UPDATE ON aftersales_handling_direction_events
    BEGIN SELECT RAISE(ABORT, 'aftersales handling direction events are immutable'); END;
    CREATE TRIGGER aftersales_direction_events_are_immutable_on_delete
    BEFORE DELETE ON aftersales_handling_direction_events
    BEGIN SELECT RAISE(ABORT, 'aftersales handling direction events are immutable'); END;
    DELETE FROM schema_migrations WHERE version = 38;
    PRAGMA foreign_keys = ON;
  `);
}

export function downgradeVersion35ToOriginalSchema(database: DatabaseSync): void {
  removeVersion36ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspection_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_interception_package_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_interception_packages_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_interception_packages_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_link_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_links_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_links_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_outbound_exception_refund_links;
    DROP TABLE IF EXISTS aftersales_interception_packages;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decision_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete;
    DROP INDEX IF EXISTS aftersales_outbound_exception_decisions_by_case;

    CREATE TABLE aftersales_outbound_exception_decision_events_original_v35 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      exception_id TEXT NOT NULL REFERENCES logistics_exception_matters(id) ON DELETE RESTRICT,
      shipment_package_id TEXT NOT NULL REFERENCES shipment_packages(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('selected', 'changed')),
      before_decision TEXT CHECK (
        before_decision IS NULL OR before_decision IN (
          'wait_investigation', 'recover_or_redeliver', 'refund_only',
          'replacement', 'refund_and_replacement'
        )
      ),
      after_decision TEXT NOT NULL CHECK (after_decision IN (
        'wait_investigation', 'recover_or_redeliver', 'refund_only',
        'replacement', 'refund_and_replacement'
      )),
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      CHECK (
        (kind = 'selected' AND before_decision IS NULL)
        OR (kind = 'changed' AND before_decision IS NOT NULL
          AND before_decision <> after_decision)
      )
    ) STRICT;
    INSERT INTO aftersales_outbound_exception_decision_events_original_v35 (
      sequence, id, case_id, exception_id, shipment_package_id, kind,
      before_decision, after_decision, occurred_at, reason, created_at
    )
    SELECT sequence, id, case_id, exception_id, shipment_package_id, kind,
      before_decision, after_decision, occurred_at, reason, created_at
    FROM aftersales_outbound_exception_decision_events;
    DROP TABLE aftersales_outbound_exception_decision_events;
    ALTER TABLE aftersales_outbound_exception_decision_events_original_v35
      RENAME TO aftersales_outbound_exception_decision_events;
    CREATE INDEX aftersales_outbound_exception_decisions_by_case
      ON aftersales_outbound_exception_decision_events (case_id, exception_id, sequence);
    CREATE TRIGGER aftersales_outbound_exception_decisions_are_immutable_on_update
      BEFORE UPDATE ON aftersales_outbound_exception_decision_events
      BEGIN SELECT RAISE(ABORT, 'outbound exception decision events are immutable'); END;
    CREATE TRIGGER aftersales_outbound_exception_decisions_are_immutable_on_delete
      BEFORE DELETE ON aftersales_outbound_exception_decision_events
      BEGIN SELECT RAISE(ABORT, 'outbound exception decision events are immutable'); END;

    CREATE TABLE aftersales_outbound_exception_replacement_rounds_original_v35 (
      exception_id TEXT PRIMARY KEY
        REFERENCES logistics_exception_matters(id) ON DELETE RESTRICT,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      round_id TEXT NOT NULL UNIQUE
        REFERENCES aftersales_processing_rounds(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO aftersales_outbound_exception_replacement_rounds_original_v35 (
      exception_id, case_id, round_id, created_at
    )
    SELECT exception_id, case_id, round_id, created_at
    FROM aftersales_outbound_exception_replacement_rounds;
    DROP TABLE aftersales_outbound_exception_replacement_rounds;
    ALTER TABLE aftersales_outbound_exception_replacement_rounds_original_v35
      RENAME TO aftersales_outbound_exception_replacement_rounds;
    CREATE TRIGGER aftersales_outbound_exception_replacement_rounds_are_immutable_on_update
      BEFORE UPDATE ON aftersales_outbound_exception_replacement_rounds
      BEGIN SELECT RAISE(ABORT, 'outbound exception replacement rounds are immutable'); END;
    CREATE TRIGGER aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete
      BEFORE DELETE ON aftersales_outbound_exception_replacement_rounds
      BEGIN SELECT RAISE(ABORT, 'outbound exception replacement rounds are immutable'); END;
    PRAGMA foreign_keys = ON;
  `);
}

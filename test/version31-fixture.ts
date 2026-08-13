import type { DatabaseSync } from 'node:sqlite';

export function removeVersion31ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion32ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
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
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decision_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspection_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspections_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspections_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_outbound_exception_decision_events;
    DROP TABLE IF EXISTS aftersales_outbound_exception_replacement_rounds;
    DROP TABLE IF EXISTS aftersales_intercepted_return_inspection_events;
    DELETE FROM schema_migrations WHERE version = 35;
    PRAGMA foreign_keys = ON;
  `);
}

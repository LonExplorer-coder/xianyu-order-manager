import { useId, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import type {
  CustomFieldDefinition,
  CustomFieldValue,
  SaveShipmentGroupCustomFieldValuesInput,
} from '../core/custom-fields';
import type {
  OpenShipmentGroup,
  ShipmentGroupCustomFieldValue,
} from '../core/shipment-groups';
import { CustomFieldInput } from './CustomFieldInput';

export function ShipmentGroupCustomFieldsDialog({
  group,
  definitions,
  values,
  onSave,
  onApplied,
  onClose,
}: {
  group: OpenShipmentGroup;
  definitions: CustomFieldDefinition[];
  values: ShipmentGroupCustomFieldValue[];
  onSave: (
    input: SaveShipmentGroupCustomFieldValuesInput,
  ) => Promise<ShipmentGroupCustomFieldValue[]>;
  onApplied: (values: ShipmentGroupCustomFieldValue[]) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const [draft, setDraft] = useState<Map<string, CustomFieldValue | null>>(() => (
    new Map(definitions.map((definition) => {
      const stored = values.find(({ shipmentGroupId, definitionId }) => (
        shipmentGroupId === group.id && definitionId === definition.id
      ));
      return [definition.id, stored?.value ?? definition.defaultValue] as const;
    }))
  ));
  const [validity, setValidity] = useState<Map<string, boolean>>(() => (
    new Map(definitions.map(({ id }) => [id, true]))
  ));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || [...validity.values()].some((valid) => !valid)) return;
    setSaving(true);
    setError('');
    try {
      const saved = await onSave({
        shipmentGroupId: group.id,
        expectedMemberOrderIds: group.orders.map(({ id }) => id),
        values: definitions.map((definition) => ({
          definitionId: definition.id,
          value: draft.get(definition.id) ?? null,
        })),
      });
      onApplied(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="order-export-backdrop" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <form className="order-export-dialog" onSubmit={(event) => void save(event)}>
        <header className="order-export-dialog__header">
          <span className="section-kicker">当前发货组</span>
          <h2 id={headingId}>编辑发货组字段</h2>
          <p>{group.orders.map(({ orderNumber }) => orderNumber).join('、')}</p>
        </header>
        <div className="custom-field-grid">
          {definitions.map((definition) => (
            <CustomFieldInput
              key={definition.id}
              definition={definition}
              value={draft.get(definition.id) ?? null}
              onChange={(value) => setDraft((current) => {
                const next = new Map(current);
                next.set(definition.id, value);
                return next;
              })}
              onValidityChange={(valid) => setValidity((current) => {
                const next = new Map(current);
                next.set(definition.id, valid);
                return next;
              })}
            />
          ))}
        </div>
        {error && <p className="order-export-dialog__error" role="alert">{error}</p>}
        <footer className="order-export-dialog__actions">
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>取消</button>
          <button className="button button--primary" type="submit" disabled={saving}>
            {saving ? '正在保存…' : '保存发货组字段'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

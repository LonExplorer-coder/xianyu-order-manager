import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import type { OpenShipmentGroup } from '../core/shipment-groups';
import type {
  ShipmentGroupExportInput,
  ShipmentGroupExportPreviewResult,
  ShipmentGroupExportResult,
} from '../core/shipment-group-export';
import type { TableTemplate } from '../core/table-templates';

export type ShipmentGroupExportDialogProps = {
  groups: OpenShipmentGroup[];
  templates: TableTemplate[];
  initialShipmentGroupTemplateId: string | null;
  onPreview: (input: ShipmentGroupExportInput) => Promise<ShipmentGroupExportPreviewResult>;
  onExport: (input: ShipmentGroupExportInput) => Promise<ShipmentGroupExportResult>;
  onSaved: (result: Extract<ShipmentGroupExportResult, { kind: 'saved' }>) => void;
  onClose: () => void;
};

export function ShipmentGroupExportDialog({
  groups,
  templates,
  initialShipmentGroupTemplateId,
  onPreview,
  onExport,
  onSaved,
  onClose,
}: ShipmentGroupExportDialogProps) {
  const headingId = useId();
  const [orderTemplateId, setOrderTemplateId] = useState('');
  const [orderItemTemplateId, setOrderItemTemplateId] = useState('');
  const [shipmentGroupTemplateId, setShipmentGroupTemplateId] = useState(() => (
    templates.some(({ id, granularity }) => (
      id === initialShipmentGroupTemplateId && granularity === 'shipment_group'
    )) ? initialShipmentGroupTemplateId ?? '' : ''
  ));
  const [maskingEnabled, setMaskingEnabled] = useState(true);
  const [preview, setPreview] = useState<ShipmentGroupExportPreviewResult | null>(null);
  const [activeSheetName, setActiveSheetName] = useState<
    '订单总表' | '订单商品明细表' | '合并发货表'
  >('合并发货表');
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const shipmentGroupIds = useMemo(() => groups.map(({ id }) => id), [groups]);

  function exportInput(): ShipmentGroupExportInput {
    return {
      shipmentGroupIds,
      orderTemplateId: orderTemplateId || null,
      orderItemTemplateId: orderItemTemplateId || null,
      shipmentGroupTemplateId: shipmentGroupTemplateId || null,
      masking: maskingEnabled ? 'masked' : 'original',
    };
  }

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError('');
    void onPreview(exportInput()).then((result) => {
      if (cancelled) return;
      setPreview(result);
      setPreviewLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setPreview(null);
      setPreviewError(errorMessage(reason));
      setPreviewLoading(false);
    });
    return () => { cancelled = true; };
  }, [
    maskingEnabled,
    onPreview,
    orderItemTemplateId,
    orderTemplateId,
    shipmentGroupIds,
    shipmentGroupTemplateId,
  ]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || previewLoading || previewError) return;
    setSaving(true);
    setError('');
    try {
      const result = await onExport(exportInput());
      if (result.kind === 'cancelled') {
        onClose();
      } else {
        onSaved(result);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  const activeSheet = preview?.sheets.find(({ name }) => name === activeSheetName)
    ?? preview?.sheets[0];
  const orderTemplates = templates.filter(({ granularity }) => granularity === 'order');
  const itemTemplates = templates.filter(({ granularity }) => granularity === 'order_item');
  const groupTemplates = templates.filter(({ granularity }) => granularity === 'shipment_group');

  return createPortal(
    <div className="order-export-backdrop" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <form className="order-export-dialog" onSubmit={(event) => void save(event)}>
        <header className="order-export-dialog__header">
          <span className="section-kicker">导出发货组</span>
          <h2 id={headingId}>导出三表 Excel</h2>
          <p>同一范围固定生成“订单总表”、“订单商品明细表”和“合并发货表”。</p>
        </header>

        <div className="order-export-dialog__counts" aria-label="导出数量">
          <span>{preview?.shipmentGroupCount ?? groups.length} 个发货组</span>
          <span>{preview?.orderCount ?? '—'} 笔订单</span>
          <span>{preview?.orderItemCount ?? '—'} 条订单商品明细</span>
        </div>

        <div className="order-export-dialog__templates">
          {[
            ['订单总表模板', orderTemplateId, setOrderTemplateId, orderTemplates],
            ['订单商品明细表模板', orderItemTemplateId, setOrderItemTemplateId, itemTemplates],
            ['合并发货表模板', shipmentGroupTemplateId, setShipmentGroupTemplateId, groupTemplates],
          ].map(([label, value, setter, options]) => (
            <label key={label as string}>
              <span>{label as string}</span>
              <select
                aria-label={label as string}
                value={value as string}
                disabled={saving}
                onChange={(event) => (setter as (value: string) => void)(event.target.value)}
              >
                <option value="">系统默认字段</option>
                {(options as TableTemplate[]).map((template) => (
                  <option key={template.id} value={template.id}>{template.name}</option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <section className="order-export-dialog__preview" aria-label="发货组导出预览区域">
          <div className="order-export-dialog__preview-tabs" role="tablist" aria-label="导出工作表预览">
            {preview?.sheets.map((sheet) => (
              <button
                key={sheet.name}
                type="button"
                role="tab"
                aria-selected={sheet.name === activeSheet?.name}
                onClick={() => setActiveSheetName(sheet.name)}
              >
                {sheet.name}预览
              </button>
            ))}
          </div>
          {previewLoading ? (
            <p className="order-export-dialog__preview-state" role="status">正在生成真实导出预览…</p>
          ) : previewError ? (
            <p className="order-export-dialog__error" role="alert">{previewError}</p>
          ) : activeSheet ? (
            <>
              <div className="order-table-wrap">
                <table aria-label={`${activeSheet.name}导出预览`}>
                  <thead><tr>{activeSheet.columns.map((column, index) => (
                    <th key={`${column.header}:${index}`}>{column.header}</th>
                  ))}</tr></thead>
                  <tbody>{activeSheet.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>{row.map((value, columnIndex) => (
                      <td key={columnIndex}>{value}</td>
                    ))}</tr>
                  ))}</tbody>
                </table>
              </div>
              {activeSheet.totalRowCount > activeSheet.rows.length && (
                <small>仅预览前 {activeSheet.rows.length} 行，保存时导出全部 {activeSheet.totalRowCount} 行。</small>
              )}
            </>
          ) : null}
        </section>

        <section className="order-export-dialog__masking">
          <label>
            <input
              type="checkbox"
              checked={maskingEnabled}
              disabled={saving}
              onChange={(event) => setMaskingEnabled(event.target.checked)}
            />
            <span><strong>导出时脱敏</strong><small>仅影响本次三表预览与导出</small></span>
          </label>
          {!maskingEnabled && (
            <p className="order-export-dialog__privacy-warning" role="alert">
              隐私提醒：本次文件将包含完整收件人、手机号和收货地址。
            </p>
          )}
        </section>

        {error && <p className="order-export-dialog__error" role="alert">{error}</p>}
        <footer className="order-export-dialog__actions">
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>取消</button>
          <button
            className="button button--primary"
            type="submit"
            disabled={saving || previewLoading || Boolean(previewError)}
          >
            {saving ? '正在生成…' : '保存三表 Excel'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

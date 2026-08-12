import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import type { OrderSummary } from '../core/contracts';
import {
  type OrderExportInput,
  type OrderExportPreviewResult,
  type OrderExportResult,
} from '../core/order-export';
import {
  type TableTemplate,
} from '../core/table-templates';

export type OrderExportDialogProps = {
  scopeKind: OrderExportInput['scope']['kind'];
  orders: OrderSummary[];
  templates: TableTemplate[];
  initialOrderTemplateId: string | null;
  onPreview: (input: OrderExportInput) => Promise<OrderExportPreviewResult>;
  onExport: (input: OrderExportInput) => Promise<OrderExportResult>;
  onSaved: (result: Extract<OrderExportResult, { kind: 'saved' }>) => void;
  onClose: () => void;
};

export function OrderExportDialog({
  scopeKind,
  orders,
  templates,
  initialOrderTemplateId,
  onPreview,
  onExport,
  onSaved,
  onClose,
}: OrderExportDialogProps) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const [orderTemplateId, setOrderTemplateId] = useState(() => (
    templates.some(({ id, granularity }) => (
      id === initialOrderTemplateId && granularity === 'order'
    )) ? initialOrderTemplateId ?? '' : ''
  ));
  const [includeOrderItems, setIncludeOrderItems] = useState(false);
  const [orderItemTemplateId, setOrderItemTemplateId] = useState('');
  const [activePreviewSheet, setActivePreviewSheet] = useState<
    '订单总表' | '订单商品明细表'
  >('订单总表');
  const [preview, setPreview] = useState<OrderExportPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const orderIds = useMemo(() => orders.map(({ id }) => id), [orders]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    firstFieldRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError('');
    const input = exportInput();
    void onPreview(input).then((result) => {
      if (cancelled) return;
      setPreview(result);
      setPreviewLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setPreview(null);
      setPreviewError(errorMessage(reason));
      setPreviewLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [includeOrderItems, onPreview, orderIds, orderItemTemplateId, orderTemplateId]);

  function exportInput(): OrderExportInput {
    return {
      scope: { kind: scopeKind, orderIds },
      orderTemplateId: orderTemplateId || null,
      includeOrderItems,
      orderItemTemplateId: includeOrderItems ? orderItemTemplateId || null : null,
      masking: 'default',
    };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || orderIds.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const result = await onExport(exportInput());
      if (result.kind === 'cancelled') {
        onClose();
        return;
      }
      onSaved(result);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      if (!saving) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = dialogRef.current
      ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ))
      : [];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const orderTemplates = useMemo(
    () => templates.filter(({ granularity }) => granularity === 'order'),
    [templates],
  );
  const orderItemTemplates = useMemo(
    () => templates.filter(({ granularity }) => granularity === 'order_item'),
    [templates],
  );
  const visibleSheets = preview?.sheets ?? [];
  const activeSheet = visibleSheets.find(({ name }) => name === activePreviewSheet)
    ?? visibleSheets[0];

  return createPortal(
    <div
      ref={dialogRef}
      className="order-export-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <form className="order-export-dialog" onSubmit={(event) => void save(event)}>
        <header className="order-export-dialog__header">
          <span className="section-kicker">
            {scopeKind === 'selected_orders' ? '导出已选订单' : '导出当前结果'}
          </span>
          <h2 id={headingId}>导出订单 Excel</h2>
          <p id={descriptionId}>
            {scopeKind === 'selected_orders'
              ? '仅导出已勾选订单，默认生成“订单总表”。'
              : '导出当前筛选结果，默认生成“订单总表”。'}
          </p>
        </header>

        <div className="order-export-dialog__counts" aria-label="导出数量">
          <span>{orderIds.length} 笔订单</span>
          {includeOrderItems && preview?.orderItemCount !== null && (
            <span>{preview?.orderItemCount ?? '—'} 条订单商品明细</span>
          )}
        </div>

        <label className="order-export-dialog__item-option">
          <input
            type="checkbox"
            checked={includeOrderItems}
            disabled={saving}
            onChange={(event) => {
              setIncludeOrderItems(event.target.checked);
              if (!event.target.checked) {
                setOrderItemTemplateId('');
                setActivePreviewSheet('订单总表');
              }
            }}
          />
          <span>
            <strong>附加订单商品明细表</strong>
            <small>每行对应订单中的一个商品，用“订单号 + 商品序号”定位。</small>
          </span>
        </label>

        <div className="order-export-dialog__templates">
          <label>
            <span>订单总表模板</span>
            <select
              ref={firstFieldRef}
              aria-label="订单总表模板"
              value={orderTemplateId}
              disabled={saving}
              onChange={(event) => setOrderTemplateId(event.target.value)}
            >
              <option value="">系统默认字段</option>
              {orderTemplates.map((template) => (
                <option value={template.id} key={template.id}>{template.name}</option>
              ))}
            </select>
          </label>
          {includeOrderItems && (
            <label>
              <span>订单商品明细表模板</span>
              <select
                aria-label="订单商品明细表模板"
                value={orderItemTemplateId}
                disabled={saving}
                onChange={(event) => setOrderItemTemplateId(event.target.value)}
              >
                <option value="">系统默认字段</option>
                {orderItemTemplates.map((template) => (
                  <option value={template.id} key={template.id}>{template.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        <section className="order-export-dialog__preview" aria-label="订单导出预览区域">
          <div className="order-export-dialog__preview-tabs" role="tablist" aria-label="导出工作表预览">
            {visibleSheets.map((sheet) => (
              <button
                key={sheet.name}
                type="button"
                role="tab"
                aria-selected={sheet.name === activeSheet?.name}
                onClick={() => setActivePreviewSheet(sheet.name)}
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
                  <thead>
                    <tr>
                      {activeSheet.columns.map((column, index) => (
                        <th key={`${column.header}:${index}`}>{column.header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeSheet.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((value, columnIndex) => (
                          <td key={columnIndex}>{value}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {activeSheet.totalRowCount > activeSheet.rows.length && (
                <small>
                  仅预览前 {activeSheet.rows.length} 行，保存时将导出该工作表全部 {activeSheet.totalRowCount} 行。
                </small>
              )}
            </>
          ) : (
            <p className="order-export-dialog__preview-state">没有可预览的工作表。</p>
          )}
        </section>

        <section className="order-export-dialog__masking" aria-labelledby={`${headingId}-masking`}>
          <div>
            <strong id={`${headingId}-masking`}>导出时默认脱敏</strong>
            <span>系统内的原始数据不会被修改</span>
          </div>
          <ul>
            <li>收件人仅保留姓氏</li>
            <li>手机号保留前 3 后 4 位</li>
            <li>地址仅保留省、市、区县</li>
            <li>买家昵称仅保留首尾字符</li>
          </ul>
        </section>

        {error && <p className="order-export-dialog__error" role="alert">{error}</p>}

        <footer className="order-export-dialog__actions">
          <button
            className="button button--quiet"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={saving || previewLoading || orderIds.length === 0 || Boolean(previewError)}
          >
            {saving ? '正在生成…' : '保存 Excel'}
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

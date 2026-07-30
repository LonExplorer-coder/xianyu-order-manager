import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import type { OrderExportInput, OrderExportResult } from '../core/order-export';
import type { TableTemplate } from '../core/table-templates';

export type OrderExportDialogProps = {
  scopeKind: OrderExportInput['scope']['kind'];
  orderIds: string[];
  orderItemCount: number;
  templates: TableTemplate[];
  onExport: (input: OrderExportInput) => Promise<OrderExportResult>;
  onSaved: (result: Extract<OrderExportResult, { kind: 'saved' }>) => void;
  onClose: () => void;
};

export function OrderExportDialog({
  scopeKind,
  orderIds,
  orderItemCount,
  templates,
  onExport,
  onSaved,
  onClose,
}: OrderExportDialogProps) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const [orderTemplateId, setOrderTemplateId] = useState('');
  const [orderItemTemplateId, setOrderItemTemplateId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    firstFieldRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || orderIds.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const result = await onExport({
        scope: {
          kind: scopeKind,
          orderIds,
        },
        orderTemplateId: orderTemplateId || null,
        orderItemTemplateId: orderItemTemplateId || null,
        masking: 'default',
      });
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

  const orderTemplates = templates.filter(({ granularity }) => granularity === 'order');
  const orderItemTemplates = templates.filter(
    ({ granularity }) => granularity === 'order_item',
  );

  return (
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
              ? '仅导出已勾选订单，生成“订单总表”和“商品明细”。'
              : '导出当前筛选结果，生成“订单总表”和“商品明细”。'}
          </p>
        </header>

        <div className="order-export-dialog__counts" aria-label="导出数量">
          <span>{orderIds.length} 笔订单</span>
          <span>{orderItemCount} 条商品明细</span>
        </div>

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
          <label>
            <span>商品明细表模板</span>
            <select
              aria-label="商品明细表模板"
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
        </div>

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
            disabled={saving || orderIds.length === 0}
          >
            {saving ? '正在生成…' : '保存 Excel'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

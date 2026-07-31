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
import type {
  CustomFieldDefinition,
  CustomFieldValueRecord,
} from '../core/custom-fields';
import {
  DEFAULT_ORDER_EXPORT_COLUMNS,
  defaultMaskedOrderCell,
  orderExportBuiltinTextLabel,
  type OrderExportInput,
  type OrderExportResult,
} from '../core/order-export';
import {
  createCustomFieldValueIndex,
  createOrderTableProjectionPlan,
  projectOrderTableProjectionRow,
  type OrderTableProjectionColumn,
  type TableCellValue,
  type TableTemplate,
} from '../core/table-templates';

const ORDER_EXPORT_PREVIEW_ROW_LIMIT = 5;

export type OrderExportDialogProps = {
  scopeKind: OrderExportInput['scope']['kind'];
  orders: OrderSummary[];
  customFieldDefinitions: CustomFieldDefinition[];
  customFieldValues: CustomFieldValueRecord[];
  templates: TableTemplate[];
  initialOrderTemplateId: string | null;
  onExport: (input: OrderExportInput) => Promise<OrderExportResult>;
  onSaved: (result: Extract<OrderExportResult, { kind: 'saved' }>) => void;
  onClose: () => void;
};

export function OrderExportDialog({
  scopeKind,
  orders,
  customFieldDefinitions,
  customFieldValues,
  templates,
  initialOrderTemplateId,
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
  const [orderItemTemplateId, setOrderItemTemplateId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const orderIds = orders.map(({ id }) => id);
  const orderItemCount = orders.reduce((total, order) => total + order.items.length, 0);

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

  const orderTemplates = useMemo(
    () => templates.filter(({ granularity }) => granularity === 'order'),
    [templates],
  );
  const orderItemTemplates = useMemo(
    () => templates.filter(({ granularity }) => granularity === 'order_item'),
    [templates],
  );
  const customFieldValueIndex = useMemo(
    () => createCustomFieldValueIndex(customFieldValues),
    [customFieldValues],
  );
  const orderProjection = useMemo(() => {
    const template = orderTemplates.find(({ id }) => id === orderTemplateId);
    try {
      const plan = createOrderTableProjectionPlan(
        template?.columns ?? DEFAULT_ORDER_EXPORT_COLUMNS,
        orders,
        customFieldDefinitions,
      );
      return {
        plan,
        rows: orders.slice(0, ORDER_EXPORT_PREVIEW_ROW_LIMIT).map((order) => ({
          order,
          values: projectOrderTableProjectionRow(plan, order, customFieldValueIndex),
        })),
        error: '',
      };
    } catch (reason) {
      return { plan: null, rows: [], error: errorMessage(reason) };
    }
  }, [
    customFieldDefinitions,
    customFieldValueIndex,
    orderTemplateId,
    orderTemplates,
    orders,
  ]);

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

        <section className="order-export-dialog__preview" aria-label="订单总表导出预览区域">
          <strong>订单总表预览</strong>
          {orderProjection.error ? (
            <p className="order-export-dialog__error" role="alert">{orderProjection.error}</p>
          ) : (
            <div className="order-table-wrap">
              <table aria-label="订单总表导出预览">
                <thead>
                  <tr>
                    {orderProjection.plan?.columns.map((column) => (
                      <th key={column.key}>{column.header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orderProjection.rows.map(({ order, values }) => (
                    <tr key={order.id}>
                      {orderProjection.plan?.columns.map((column, index) => (
                        <td key={column.key}>
                          {orderExportPreviewCellText(order, column, values[index] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {orders.length > ORDER_EXPORT_PREVIEW_ROW_LIMIT && (
            <small>
              仅预览前 {ORDER_EXPORT_PREVIEW_ROW_LIMIT} 笔，保存时将导出本次范围全部订单。
            </small>
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
            disabled={saving || orderIds.length === 0 || Boolean(orderProjection.error)}
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

function orderExportPreviewCellText(
  order: OrderSummary,
  column: OrderTableProjectionColumn,
  value: TableCellValue,
): string {
  let displayedValue = value;
  if (column.kind === 'field' && column.field.kind === 'builtin') {
    displayedValue = defaultMaskedOrderCell(column.field.key, value, {
      province: order.province ?? '',
      city: order.city ?? '',
      district: order.district ?? '',
    });
    if (typeof displayedValue === 'string') {
      displayedValue = orderExportBuiltinTextLabel(column.field.key, displayedValue)
        ?? displayedValue;
    }
  }
  if (displayedValue === null || displayedValue === '') return '';
  if (column.valueType === 'money' && typeof displayedValue === 'number') {
    return `¥${(displayedValue / 100).toFixed(2)}`;
  }
  if (column.valueType === 'datetime' && typeof displayedValue === 'string') {
    const instant = new Date(displayedValue);
    if (!Number.isFinite(instant.getTime())) return displayedValue;
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(instant);
  }
  if (column.valueType === 'checkbox' && typeof displayedValue === 'boolean') {
    return displayedValue ? '是' : '否';
  }
  if (Array.isArray(displayedValue)) return displayedValue.join('、');
  return String(displayedValue);
}

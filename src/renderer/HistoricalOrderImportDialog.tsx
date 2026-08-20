import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopApi } from '../core/desktop-api';
import {
  HISTORICAL_ORDER_COLUMN_KEYS,
  type HistoricalOrderColumnKey,
  type HistoricalOrderColumnMapping,
  type HistoricalOrderImportPreview,
  type HistoricalOrderImportResult,
  type HistoricalOrderImportSelectionOutcome,
} from '../core/historical-order-import';

export type SelectedHistoricalOrderImport = Extract<
  HistoricalOrderImportSelectionOutcome,
  { kind: 'selected' }
>;

type HistoricalOrderImportDialogProps = {
  api: DesktopApi;
  selection: SelectedHistoricalOrderImport;
  onClose: () => void;
  onImported: (result: HistoricalOrderImportResult) => void;
};

const REQUIRED_COLUMNS: readonly HistoricalOrderColumnKey[] = [
  'platform', 'sellerAccount', 'orderNumber', 'recipient', 'phone', 'address',
  'amount', 'itemTitle', 'unitPrice', 'quantity',
];

const COLUMN_LABELS: Record<HistoricalOrderColumnKey, string> = {
  platform: '平台',
  sellerAccount: '卖家账号',
  orderNumber: '平台订单编号',
  alipayTransactionNumber: '支付宝交易号',
  buyerNickname: '买家昵称',
  recipient: '收件人',
  phone: '手机号',
  address: '完整收货地址',
  orderedAt: '下单时间',
  paidAt: '付款时间',
  productTotal: '商品总价',
  shippingFee: '运费',
  amount: '成交金额',
  platformTransactionStatus: '平台交易状态',
  fulfillmentStatus: '履约状态',
  itemTitle: '商品标题',
  itemSpec: '款式或规格',
  unitPrice: '商品单价',
  quantity: '商品数量',
};

const OPTIONAL_COLUMNS = HISTORICAL_ORDER_COLUMN_KEYS.filter(
  (key) => !REQUIRED_COLUMNS.includes(key),
);

export function HistoricalOrderImportDialog({
  api,
  selection,
  onClose,
  onImported,
}: HistoricalOrderImportDialogProps) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previewRequestVersion = useRef(0);
  const [columnMapping, setColumnMapping] = useState<HistoricalOrderColumnMapping>(
    selection.inspection.suggestedColumnMapping,
  );
  const [preview, setPreview] = useState<HistoricalOrderImportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'download' | 'confirm' | null>('preview');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    busyRef.current = busy;
    onCloseRef.current = onClose;
  }, [busy, onClose]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const firstFocusable = () => dialog?.querySelector<HTMLElement>(
      'select:not([disabled]), button:not([disabled])',
    ) ?? null;
    (firstFocusable() ?? dialog)?.focus();
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current === null) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    const keepFocusInside = (event: FocusEvent) => {
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        (firstFocusable() ?? dialog).focus();
      }
    };
    document.addEventListener('keydown', handleDocumentKeyDown);
    document.addEventListener('focusin', keepFocusInside);
    void loadPreview(selection.inspection.suggestedColumnMapping);
    return () => {
      document.removeEventListener('keydown', handleDocumentKeyDown);
      document.removeEventListener('focusin', keepFocusInside);
      returnFocus?.focus();
    };
    // The selected file starts one immutable short-lived session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.sessionId]);

  async function loadPreview(mapping: HistoricalOrderColumnMapping) {
    const requestVersion = previewRequestVersion.current + 1;
    previewRequestVersion.current = requestVersion;
    setBusy('preview');
    setError('');
    setFeedback('');
    try {
      const nextPreview = await api.previewHistoricalOrderImport(selection.sessionId, {
        columnMapping: mapping,
      });
      if (previewRequestVersion.current === requestVersion) setPreview(nextPreview);
    } catch (previewError) {
      if (previewRequestVersion.current === requestVersion) {
        setPreview(null);
        setError(errorMessage(previewError));
      }
    } finally {
      if (previewRequestVersion.current === requestVersion) setBusy(null);
    }
  }

  function invalidatePreview() {
    previewRequestVersion.current += 1;
    setPreview(null);
    setBusy(null);
    setFeedback('');
  }

  function updateWorksheet(worksheet: string) {
    const suggested = selection.inspection.suggestedColumnMapping;
    setColumnMapping(worksheet === suggested.worksheet
      ? suggested
      : {
        worksheet,
        columns: Object.fromEntries(
          HISTORICAL_ORDER_COLUMN_KEYS.map((key) => [key, null]),
        ) as HistoricalOrderColumnMapping['columns'],
      });
    invalidatePreview();
  }

  function updateColumn(key: HistoricalOrderColumnKey, value: string) {
    const selectedColumn = value ? Number(value) : null;
    setColumnMapping((current) => {
      const columns = { ...current.columns };
      if (selectedColumn !== null) {
        for (const candidateKey of HISTORICAL_ORDER_COLUMN_KEYS) {
          if (candidateKey !== key && columns[candidateKey] === selectedColumn) {
            columns[candidateKey] = null;
          }
        }
      }
      columns[key] = selectedColumn;
      return { ...current, columns };
    });
    invalidatePreview();
  }

  async function downloadErrors() {
    if (!preview) return;
    setBusy('download');
    setError('');
    setFeedback('');
    try {
      const result = await api.downloadHistoricalOrderImportErrors(selection.sessionId, {
        columnMapping,
        previewToken: preview.previewToken,
      });
      if (result.kind === 'saved') setFeedback(`已保存 ${result.rowCount} 行错误：${result.fileName}`);
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    } finally {
      setBusy(null);
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setBusy('confirm');
    setError('');
    try {
      const result = await api.confirmHistoricalOrderImport(selection.sessionId, {
        columnMapping,
        previewToken: preview.previewToken,
      });
      onImported(result);
    } catch (confirmationError) {
      setError(errorMessage(confirmationError));
      setBusy(null);
    }
  }

  const worksheet = selection.inspection.worksheets.find(
    ({ name }) => name === columnMapping.worksheet,
  );
  const missingRequiredColumn = REQUIRED_COLUMNS.some(
    (key) => columnMapping.columns[key] === null,
  );

  return createPortal((
    <div
      ref={dialogRef}
      className="historical-import-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <section className="historical-import-dialog">
        <header>
          <div>
            <span className="section-kicker">历史来源</span>
            <h2 id={headingId}>导入历史订单</h2>
            <p><strong>{selection.fileName}</strong>只有在你确认后才会写入；错误行会跳过。</p>
          </div>
          <button className="button button--quiet" type="button" onClick={onClose} disabled={busy !== null}>
            关闭
          </button>
        </header>

        <div className="historical-import-dialog__mapping">
          <label>
            <span>工作表</span>
            <select
              value={columnMapping.worksheet}
              disabled={busy !== null}
              onChange={(event) => updateWorksheet(event.target.value)}
            >
              {selection.inspection.worksheets.map(({ name }) => (
                <option value={name} key={name}>{name}</option>
              ))}
            </select>
          </label>
          <ColumnMappingFields
            keys={REQUIRED_COLUMNS}
            headers={worksheet?.headers ?? []}
            mapping={columnMapping}
            required
            disabled={busy !== null}
            onChange={updateColumn}
          />
          <details>
            <summary>可选列</summary>
            <ColumnMappingFields
              keys={OPTIONAL_COLUMNS}
              headers={worksheet?.headers ?? []}
              mapping={columnMapping}
              required={false}
              disabled={busy !== null}
              onChange={updateColumn}
            />
          </details>
          <button
            className="button button--quiet"
            type="button"
            disabled={busy !== null || missingRequiredColumn}
            onClick={() => void loadPreview(columnMapping)}
          >
            {busy === 'preview' ? '正在预览…' : '更新预览'}
          </button>
        </div>

        {preview && (
          <div className="historical-import-dialog__preview">
            <div className="historical-import-dialog__counts" aria-label="导入摘要">
              <span aria-label={`新增 ${preview.summary.createOrderCount} 笔`}><strong>{preview.summary.createOrderCount}</strong>新增订单</span>
              <span aria-label={`更新 ${preview.summary.updateOrderCount} 笔`}><strong>{preview.summary.updateOrderCount}</strong>更新订单</span>
              <span aria-label={`重复 ${preview.summary.duplicateOrderCount} 笔`}><strong>{preview.summary.duplicateOrderCount}</strong>重复跳过</span>
              <span aria-label={`错误 ${preview.summary.errorRowCount} 行`}><strong>{preview.summary.errorRowCount}</strong>错误行</span>
            </div>
            {preview.orders.length > 0 && (
              <div className="historical-import-dialog__table-wrap">
                <table>
                  <thead><tr><th>原行</th><th>平台订单编号</th><th>收件人</th><th>商品</th><th>金额</th><th>动作</th><th>变更明细</th></tr></thead>
                  <tbody>{preview.orders.map((order) => (
                    <tr key={`${order.orderNumber}-${order.rowNumbers.join('-')}`}>
                      <td>{order.rowNumbers.join('、')}</td>
                      <td>{order.orderNumber}</td>
                      <td>{order.recipient}</td>
                      <td>{order.itemCount} 件</td>
                      <td>{formatMoney(order.amountCents)}</td>
                      <td>{actionLabel(order.action)}</td>
                      <td>
                        {order.changes.length === 0
                          ? '—'
                          : (
                            <ul
                              className="historical-import-dialog__changes"
                              aria-label={`${order.orderNumber} 变更明细`}
                            >
                              {order.changes.map((change) => (
                                <li key={change.path}>
                                  <strong>{historicalChangeLabel(change.path)}</strong>
                                  <span>
                                    {historicalChangeValue(change.path, change.before)}
                                    {' → '}
                                    {historicalChangeValue(change.path, change.after)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {preview.errorRows.length > 0 && (
              <div className="historical-import-dialog__errors">
                {preview.errorRows.slice(0, 5).map((row) => (
                  <p key={row.rowNumber}><strong>第 {row.rowNumber} 行</strong>{row.errors.join('；')}</p>
                ))}
                {preview.errorRows.length > 5 && <small>另有 {preview.errorRows.length - 5} 行，可下载完整错误表。</small>}
              </div>
            )}
          </div>
        )}

        {error && <p className="historical-import-dialog__error" role="alert">{error}</p>}
        {feedback && <p className="historical-import-dialog__feedback" role="status">{feedback}</p>}
        <footer>
          {preview && preview.summary.errorRowCount > 0 && (
            <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void downloadErrors()}>
              {busy === 'download' ? '正在生成…' : `下载 ${preview.summary.errorRowCount} 行错误`}
            </button>
          )}
          <button className="button button--quiet" type="button" disabled={busy !== null} onClick={onClose}>取消</button>
          <button className="button button--primary" type="button" disabled={!preview || busy !== null} onClick={() => void confirmImport()}>
            {busy === 'confirm' ? '正在导入…' : '确认导入'}
          </button>
        </footer>
      </section>
    </div>
  ), document.body);
}

function ColumnMappingFields({
  keys,
  headers,
  mapping,
  required,
  disabled,
  onChange,
}: {
  keys: readonly HistoricalOrderColumnKey[];
  headers: readonly string[];
  mapping: HistoricalOrderColumnMapping;
  required: boolean;
  disabled: boolean;
  onChange: (key: HistoricalOrderColumnKey, value: string) => void;
}) {
  return (
    <div className="historical-import-dialog__mapping-grid">
      {keys.map((key) => (
        <label key={key}>
          <span>{COLUMN_LABELS[key]}{required ? ' *' : ''}</span>
          <select
            aria-label={`${COLUMN_LABELS[key]}列`}
            disabled={disabled}
            value={mapping.columns[key] ?? ''}
            onChange={(event) => onChange(key, event.target.value)}
          >
            <option value="">{required ? '请选择' : '不导入'}</option>
            {headers.map((header, index) => (
              <option value={index + 1} key={`${index}-${header}`}>
                {index + 1}. {header || `未命名列 ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

function actionLabel(action: HistoricalOrderImportPreview['orders'][number]['action']): string {
  if (action === 'create') return '新增';
  if (action === 'update') return '更新';
  return '重复跳过';
}

function formatMoney(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

const CHANGE_LABELS: Record<string, string> = {
  alipayTransactionNumber: '支付宝交易号',
  buyerNickname: '买家昵称',
  recipient: '收件人',
  phone: '手机号',
  phoneNormalized: '标准化手机号',
  addressOriginal: '完整收货地址',
  addressNormalized: '标准化收货地址',
  province: '省', city: '市', district: '区县',
  orderedAtOriginal: '下单时间', orderedAtNormalized: '标准化下单时间',
  paidAtOriginal: '付款时间', paidAtNormalized: '标准化付款时间',
  productTotalCents: '商品总价', shippingFeeCents: '运费', amountCents: '成交金额',
  platformTransactionStatus: '平台交易状态', fulfillmentStatus: '履约状态',
};

const ITEM_CHANGE_LABELS: Record<string, string> = {
  sourceTitle: '商品标题', sourceSpec: '款式或规格', unitPriceCents: '商品单价',
  quantity: '商品数量', quantitySource: '数量来源',
};

function historicalChangeLabel(path: string): string {
  const itemField = /^items\[(\d+)\]\.(.+)$/u.exec(path);
  if (itemField) {
    return `商品 ${Number(itemField[1]) + 1} · ${ITEM_CHANGE_LABELS[itemField[2]] ?? itemField[2]}`;
  }
  const addedItem = /^items\[(\d+)\]$/u.exec(path);
  if (addedItem) return `新增商品 ${Number(addedItem[1]) + 1}`;
  const removedItem = /^items\.removed\[(\d+)\]$/u.exec(path);
  if (removedItem) return `移除商品 ${Number(removedItem[1]) + 1}`;
  return CHANGE_LABELS[path] ?? path;
}

function historicalChangeValue(path: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '空';
  if (/(?:Total|Fee|amount|Price)Cents$/u.test(path) && typeof value === 'number') {
    return formatMoney(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

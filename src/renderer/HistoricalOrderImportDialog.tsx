import { useEffect, useId, useRef, useState } from 'react';

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
  const [columnMapping, setColumnMapping] = useState<HistoricalOrderColumnMapping>(
    selection.inspection.suggestedColumnMapping,
  );
  const [preview, setPreview] = useState<HistoricalOrderImportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'download' | 'confirm' | null>('preview');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    dialogRef.current?.focus();
    void loadPreview(selection.inspection.suggestedColumnMapping);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
    // The selected file starts one immutable short-lived session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.sessionId]);

  async function loadPreview(mapping: HistoricalOrderColumnMapping) {
    setBusy('preview');
    setError('');
    setFeedback('');
    try {
      setPreview(await api.previewHistoricalOrderImport(selection.sessionId, {
        columnMapping: mapping,
      }));
    } catch (previewError) {
      setPreview(null);
      setError(errorMessage(previewError));
    } finally {
      setBusy(null);
    }
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
    setPreview(null);
    setFeedback('');
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
    setPreview(null);
    setFeedback('');
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

  return (
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
            <select value={columnMapping.worksheet} onChange={(event) => updateWorksheet(event.target.value)}>
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
            onChange={updateColumn}
          />
          <details>
            <summary>可选列</summary>
            <ColumnMappingFields
              keys={OPTIONAL_COLUMNS}
              headers={worksheet?.headers ?? []}
              mapping={columnMapping}
              required={false}
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
              <span><strong>{preview.summary.createOrderCount}</strong>新增 {preview.summary.createOrderCount} 笔</span>
              <span><strong>{preview.summary.updateOrderCount}</strong>更新 {preview.summary.updateOrderCount} 笔</span>
              <span><strong>{preview.summary.duplicateOrderCount}</strong>重复 {preview.summary.duplicateOrderCount} 笔</span>
              <span><strong>{preview.summary.errorRowCount}</strong>错误 {preview.summary.errorRowCount} 行</span>
            </div>
            {preview.orders.length > 0 && (
              <div className="historical-import-dialog__table-wrap">
                <table>
                  <thead><tr><th>原行</th><th>平台订单编号</th><th>收件人</th><th>商品</th><th>金额</th><th>动作</th></tr></thead>
                  <tbody>{preview.orders.map((order) => (
                    <tr key={`${order.orderNumber}-${order.rowNumbers.join('-')}`}>
                      <td>{order.rowNumbers.join('、')}</td>
                      <td>{order.orderNumber}</td>
                      <td>{order.recipient}</td>
                      <td>{order.itemCount} 件</td>
                      <td>{formatMoney(order.amountCents)}</td>
                      <td>{actionLabel(order.action)}</td>
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
  );
}

function ColumnMappingFields({
  keys,
  headers,
  mapping,
  required,
  onChange,
}: {
  keys: readonly HistoricalOrderColumnKey[];
  headers: readonly string[];
  mapping: HistoricalOrderColumnMapping;
  required: boolean;
  onChange: (key: HistoricalOrderColumnKey, value: string) => void;
}) {
  return (
    <div className="historical-import-dialog__mapping-grid">
      {keys.map((key) => (
        <label key={key}>
          <span>{COLUMN_LABELS[key]}{required ? ' *' : ''}</span>
          <select
            aria-label={`${COLUMN_LABELS[key]}列`}
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

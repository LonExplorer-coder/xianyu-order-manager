import { useEffect, useState } from 'react';

import type { OrderSummary } from '../core/contracts';
import type { DesktopApi } from '../core/desktop-api';
import type { RecipientSummaryView } from '../core/recipients';
import {
  ConfirmDangerDialog,
  EmptyState,
  InlineError,
  ReasonField,
} from './DialogShell';

type MergeDialogState = {
  keepNumberFromId: string;
  keepNameFromId: string;
  reason: string;
};

export function RecipientsWorkspace({ api }: { api: DesktopApi }) {
  const [recipients, setRecipients] = useState<RecipientSummaryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ordersByRecipient, setOrdersByRecipient] = useState<Record<string, OrderSummary[]>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [mergeDialog, setMergeDialog] = useState<MergeDialogState | null>(null);
  const [recipientQuery, setRecipientQuery] = useState('');

  async function refresh(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      setRecipients(await api.queryRecipients());
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [api]);

  useEffect(() => {
    if (!expandedId || ordersByRecipient[expandedId]) return;
    let stale = false;
    api.queryRecipientOrders(expandedId)
      .then((orders) => {
        if (!stale) setOrdersByRecipient((current) => ({ ...current, [expandedId]: orders }));
      })
      .catch((value) => { if (!stale) setError(errorMessage(value)); });
    return () => { stale = true; };
  }, [api, expandedId, ordersByRecipient]);

  const active = recipients.filter(({ mergedIntoRecipientId }) => mergedIntoRecipientId === null);
  const mergedAway = recipients.filter(({ mergedIntoRecipientId }) => (
    mergedIntoRecipientId !== null
  ));
  const recipientQueryText = recipientQuery.trim().toLowerCase();
  const matchesRecipient = (recipient: RecipientSummaryView): boolean => {
    if (!recipientQueryText) return true;
    const haystacks = [
      String(recipient.recipientNumber).padStart(3, '0'),
      recipient.effectiveName,
      recipient.name,
      ...(recipient.displayName !== null ? [recipient.displayName] : []),
      recipient.phoneNormalized,
      ...recipient.addresses,
    ];
    return haystacks.some((value) => value.toLowerCase().includes(recipientQueryText));
  };
  const filteredActive = active.filter(matchesRecipient);
  const filteredMergedAway = mergedAway.filter(matchesRecipient);
  const hasActiveRecipientQuery = recipientQueryText !== '';
  const recipientById = new Map(recipients.map((recipient) => [recipient.id, recipient]));
  const mergeCandidates = [...selected]
    .map((id) => recipientById.get(id))
    .filter((recipient): recipient is RecipientSummaryView => recipient !== undefined)
    .sort((first, second) => first.recipientNumber - second.recipientNumber);

  function toggleSelected(recipientId: string): void {
    const next = new Set(selected);
    if (next.has(recipientId)) next.delete(recipientId);
    else if (next.size < 2) next.add(recipientId);
    setSelected(next);
  }

  async function submitMerge(): Promise<void> {
    if (!mergeDialog || mergeCandidates.length !== 2) return;
    const [source, target] = mergeCandidates[0].id === mergeDialog.keepNumberFromId
      ? [mergeCandidates[1], mergeCandidates[0]]
      : [mergeCandidates[0], mergeCandidates[1]];
    setBusy(true);
    setError('');
    try {
      await api.mergeRecipients({
        sourceRecipientId: source.id,
        targetRecipientId: target.id,
        keepNameFrom: mergeDialog.keepNameFromId === source.id ? 'source' : 'target',
        reason: mergeDialog.reason,
      });
      setMergeDialog(null);
      setSelected(new Set());
      setOrdersByRecipient({});
      setFeedback(`已将 ${source.effectiveName} 并入 ${target.effectiveName}`);
      await refresh();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="recipients-workspace workspace-enter">
      <header className="workspace-header">
        <div>
          <span className="section-kicker">姓名 + 规范化手机号</span>
          <h1>收件人</h1>
          <p>新组合首次出现自动建档发号；合并是修正归类错误的唯一入口，编号只增不复用。</p>
        </div>
        <button
          className="button button--primary"
          type="button"
          disabled={mergeCandidates.length !== 2 || busy}
          onClick={() => setMergeDialog({
            keepNumberFromId: mergeCandidates[0]?.id ?? '',
            keepNameFromId: mergeCandidates[0]?.id ?? '',
            reason: '',
          })}
        >
          合并所选收件人
        </button>
      </header>

      <InlineError message={error} />
      {feedback && <div className="settings-notice settings-notice--success" role="status">{feedback}</div>}

      <section className="order-query workspace-query" aria-label="收件人查询">
        <label className="order-query__search">
          <span>搜索收件人</span>
          <input
            type="search"
            placeholder="编号、姓名、手机号或地址"
            value={recipientQuery}
            onChange={(event) => setRecipientQuery(event.target.value)}
          />
        </label>
        <span className="order-query__result" role="status" aria-live="polite">
          显示 {filteredActive.length} / {active.length} 个
        </span>
        {hasActiveRecipientQuery && (
          <button
            className="button button--quiet order-query__clear"
            type="button"
            onClick={() => setRecipientQuery('')}
          >
            清除筛选
          </button>
        )}
      </section>

      {loading ? (
        <EmptyState title="正在读取收件人…" status />
      ) : active.length === 0 ? (
        <EmptyState
          title="还没有收件人"
          hint="订单入库或修改时，新的姓名手机号组合会自动建档发号。"
        />
      ) : filteredActive.length === 0 ? (
        <EmptyState
          title="没有匹配的收件人"
          hint="清除筛选或调整搜索内容后重试。"
        />
      ) : (
        <div className="recipient-list" aria-label="收件人列表">
          {filteredActive.map((recipient) => {
            const expanded = expandedId === recipient.id;
            const orders = ordersByRecipient[recipient.id];
            return (
              <article className="aftersales-workflow-card" key={recipient.id}>
                <header>
                  <label className="aftersales-workflow-card__select">
                    <input
                      type="checkbox"
                      checked={selected.has(recipient.id)}
                      aria-label={`选择收件人 ${recipient.effectiveName}`}
                      onChange={() => toggleSelected(recipient.id)}
                    />
                  </label>
                  <div className="aftersales-workflow-card__heading">
                    <span className="status-chip">
                      编号 {String(recipient.recipientNumber).padStart(3, '0')}
                    </span>
                    <h2>
                      {recipient.effectiveName}
                      {recipient.displayName !== null ? `（原姓名 ${recipient.name}）` : ''}
                    </h2>
                  </div>
                  <strong>{recipient.phoneNormalized}</strong>
                </header>
                <p>
                  {recipient.orderCount} 笔订单
                  {recipient.addresses.length > 0
                    ? ` · ${recipient.addresses.length} 个地址：${recipient.addresses[0]}${
                      recipient.addresses.length > 1 ? ' 等' : ''
                    }`
                    : ''}
                </p>
                <footer>
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : recipient.id)}
                  >
                    {expanded ? '收起' : '订单与地址'}
                  </button>
                </footer>

                {expanded && (
                  <div className="recipient-detail">
                    {!orders ? (
                      <p role="status">正在读取订单…</p>
                    ) : orders.length === 0 ? (
                      <p>该收件人当前没有订单。</p>
                    ) : (
                      <div className="table-frame table-frame--embedded">
                        <table>
                          <thead>
                            <tr>
                              <th>系统订单编号</th>
                              <th>可读编号</th>
                              <th>订单号</th>
                              <th>入库时间</th>
                              <th>成交金额</th>
                            </tr>
                          </thead>
                          <tbody>
                            {orders.map((order) => (
                              <tr key={order.id}>
                                <td>{order.systemOrderNumber}</td>
                                <td>{order.readableOrderNumber ?? '—'}</td>
                                <td>{order.orderNumber}</td>
                                <td>{formatDateTime(order.createdAt)}</td>
                                <td>¥{(order.amountCents / 100).toFixed(2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {recipient.addresses.length > 0 && (
                      <ul className="recipient-addresses" aria-label="地址簿">
                        {recipient.addresses.map((address) => (
                          <li key={address}>{address}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {mergedAway.length > 0 && (!hasActiveRecipientQuery || filteredMergedAway.length > 0) && (
        <details className="recipient-merged">
          <summary role="button">
            已合并（{hasActiveRecipientQuery ? filteredMergedAway.length : mergedAway.length}）
          </summary>
          <ul>
            {(hasActiveRecipientQuery ? filteredMergedAway : mergedAway).map((recipient) => (
              <li key={recipient.id}>
                <span>
                  {String(recipient.recipientNumber).padStart(3, '0')} · {recipient.name} ·{' '}
                  {recipient.phoneNormalized}
                </span>
                <small>
                  已并入 {recipient.effectiveName}
                  {recipient.mergedAt ? ` · ${formatDateTime(recipient.mergedAt)}` : ''}
                  {recipient.mergedReason ? ` · ${recipient.mergedReason}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}

      {mergeDialog && mergeCandidates.length === 2 && (
        <ConfirmDangerDialog
          kicker="不可撤销操作"
          title="合并收件人"
          description="合并后，被并方的订单归入存续方并改用存续方编号；已冻结的发货快照编号不受影响；合并不可撤销。编号存续方与显示名称存续方分开选择。"
          busy={busy}
          confirmLabel="确认合并"
          canSubmit={mergeDialog.reason.trim() !== ''}
          onConfirm={() => void submitMerge()}
          onClose={() => setMergeDialog(null)}
        >
          <div className="recipient-merge-parties">
            {mergeCandidates.map((recipient) => (
              <section key={recipient.id}>
                <h3>
                  {String(recipient.recipientNumber).padStart(3, '0')} ·{' '}
                  {recipient.effectiveName}
                </h3>
                <p>
                  {recipient.name} · {recipient.phoneNormalized} · {recipient.orderCount} 笔订单
                </p>
                {recipient.addresses.slice(0, 3).map((address) => (
                  <small key={address}>{address}</small>
                ))}
                <label>
                  <input
                    type="radio"
                    name="keep-number-from"
                    checked={mergeDialog.keepNumberFromId === recipient.id}
                    disabled={busy}
                    onChange={() => setMergeDialog({
                      ...mergeDialog,
                      keepNumberFromId: recipient.id,
                    })}
                  />
                  <span>保留此编号（{String(recipient.recipientNumber).padStart(3, '0')}）</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="keep-name-from"
                    checked={mergeDialog.keepNameFromId === recipient.id}
                    disabled={busy}
                    onChange={() => setMergeDialog({
                      ...mergeDialog,
                      keepNameFromId: recipient.id,
                    })}
                  />
                  <span>保留此显示名称（{recipient.effectiveName}）</span>
                </label>
              </section>
            ))}
          </div>
          <ReasonField
            label="合并原因"
            value={mergeDialog.reason}
            saving={busy}
            onChange={(reason) => setMergeDialog({ ...mergeDialog, reason })}
          />
        </ConfirmDangerDialog>
      )}
    </section>
  );
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

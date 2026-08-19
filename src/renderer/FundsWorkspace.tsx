import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import {
  FINANCE_RECORD_TYPES,
  financeConfirmedSourceLabel,
  financeDirectionLabel,
  financeDirectionOfType,
  financePendingStatusLabel,
  financeRecordTypeLabel,
  financeSourceLabel,
  type FinanceDirectionName,
  type FinancePendingItemView,
  type FinanceRecordTypeName,
  type FinanceRecordView,
  type FundsView,
} from '../core/funds';
import { DialogShell, EmptyState, InlineError, ReasonField } from './DialogShell';

type DialogKind =
  | { kind: 'record' }
  | { kind: 'confirm'; item: FinancePendingItemView }
  | { kind: 'cancel'; item: FinancePendingItemView }
  | { kind: 'reverse'; record: FinanceRecordView };

export function FundsWorkspace({ api }: { api: DesktopApi }) {
  const [view, setView] = useState<FundsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [typeFilter, setTypeFilter] = useState<FinanceRecordTypeName | ''>('');

  const [recordType, setRecordType] = useState<FinanceRecordTypeName>('replacement_freight');
  const [recordDirection, setRecordDirection] = useState<FinanceDirectionName>('expense');
  const [recordAmountYuan, setRecordAmountYuan] = useState('');
  const [recordOccurredAt, setRecordOccurredAt] = useState('');
  const [recordNote, setRecordNote] = useState('');
  const [confirmAmountYuan, setConfirmAmountYuan] = useState('');
  const [confirmNote, setConfirmNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [reverseAmountYuan, setReverseAmountYuan] = useState('');
  const [reverseNote, setReverseNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.queryFunds()
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (loading) {
    return shell(
      <EmptyState title="正在读取资金…" status />,
    );
  }

  if (error || !view) {
    return shell(
      <InlineError message={error || '资金视图不可用'} />,
    );
  }

  const pendingItems = view.pendingItems;
  const records = view.records;
  const pendingTotalsByType = new Map(view.pendingTotals.map((row) => [row.type, row]));
  const filteredRecords = typeFilter === ''
    ? records
    : records.filter((record) => record.type === typeFilter);

  const unreversedCentsOf = (record: FinanceRecordView): number => (
    record.amountCents - records
      .filter((candidate) => candidate.reversesRecordId === record.id)
      .reduce((total, candidate) => total + candidate.amountCents, 0)
  );

  function openRecordDialog() {
    setRecordType('replacement_freight');
    setRecordDirection(financeDirectionOfType('replacement_freight'));
    setRecordAmountYuan('');
    setRecordOccurredAt('');
    setRecordNote('');
    setFormError('');
    setDialog({ kind: 'record' });
  }

  const openConfirmDialog = (item: FinancePendingItemView) => {
    setConfirmAmountYuan((item.remainingCents / 100).toFixed(2));
    setConfirmNote('');
    setFormError('');
    setDialog({ kind: 'confirm', item });
  };

  const openCancelDialog = (item: FinancePendingItemView) => {
    setCancelReason('');
    setFormError('');
    setDialog({ kind: 'cancel', item });
  };

  const openReverseDialog = (record: FinanceRecordView) => {
    setReverseAmountYuan((unreversedCentsOf(record) / 100).toFixed(2));
    setReverseNote('');
    setFormError('');
    setDialog({ kind: 'reverse', record });
  };

  const submit = (operation: () => Promise<FundsView>) => {
    setSaving(true);
    setFormError('');
    operation()
      .then((next) => {
        setView(next);
        setDialog(null);
      })
      .catch((cause: unknown) => {
        setFormError(errorMessage(cause));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const submitRecord = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amountCents = parseMoneyToCents(recordAmountYuan);
    if (amountCents === null) {
      setFormError('请填写大于零的金额');
      return;
    }
    submit(() => api.recordFinanceRecord({
      type: recordType,
      direction: recordDirection,
      amountCents,
      occurredAt: recordOccurredAt
        ? new Date(recordOccurredAt).toISOString()
        : new Date().toISOString(),
      note: recordNote.trim(),
    }));
  };

  const submitConfirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dialog?.kind !== 'confirm') return;
    const amountCents = parseMoneyToCents(confirmAmountYuan);
    if (amountCents === null) {
      setFormError('请填写大于零的确认金额');
      return;
    }
    submit(() => api.confirmPendingFinanceItem({
      pendingItemId: dialog.item.id,
      amountCents,
      note: confirmNote.trim(),
    }));
  };

  const submitCancel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dialog?.kind !== 'cancel') return;
    submit(() => api.cancelPendingFinanceItem({
      pendingItemId: dialog.item.id,
      reason: cancelReason.trim(),
    }));
  };

  const submitReverse = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dialog?.kind !== 'reverse') return;
    const amountCents = parseMoneyToCents(reverseAmountYuan);
    if (amountCents === null) {
      setFormError('请填写大于零的冲正金额');
      return;
    }
    submit(() => api.reverseFinanceRecord({
      recordId: dialog.record.id,
      amountCents,
      note: reverseNote.trim(),
    }));
  };

  return shell(
    <>
      <div className="funds-overview" aria-label="资金汇总">
        <span>
          <strong>{formatMoney(view.totals.incomeCents)}</strong>
          <small>已确认收入</small>
        </span>
        <span>
          <strong>{formatMoney(view.totals.expenseCents)}</strong>
          <small>已确认支出</small>
        </span>
        <span>
          <strong>{formatMoney(view.totals.netCents)}</strong>
          <small>净额（收入 − 支出）</small>
        </span>
        <span>
          <strong>{formatMoney(view.totals.pendingRemainingCents)}</strong>
          <small>待确认余额（未混入净额）</small>
        </span>
      </div>

      <h2>资金类型汇总</h2>
      <p className="workspace-subtitle">
        点击一行只在资金记录里看这个类型；成交金额、平台结算与退款分开记，不互相折算。
      </p>
      <div className="table-frame">
        <table aria-label="资金类型汇总">
          <thead>
            <tr>
              <th>类型</th>
              <th>收入</th>
              <th>支出</th>
              <th>净额</th>
              <th>待确认余额</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {view.typeTotals.map((total) => {
              const pendingTotal = pendingTotalsByType.get(total.type)!;
              const active = typeFilter === total.type;
              return (
                <tr key={total.type} className={active ? 'is-selected' : undefined}>
                  <td>{financeRecordTypeLabel(total.type)}</td>
                  <td>{formatMoney(total.incomeCents)}</td>
                  <td>{formatMoney(total.expenseCents)}</td>
                  <td>{formatMoney(total.netCents)}</td>
                  <td>
                    {pendingTotal.count > 0
                      ? `${formatMoney(pendingTotal.remainingCents)}（${pendingTotal.count} 项）`
                      : '—'}
                  </td>
                  <td>
                    <button
                      className="button button--quiet"
                      type="button"
                      aria-pressed={active}
                      onClick={() => setTypeFilter(active ? '' : total.type)}
                    >
                      {active ? '取消筛选' : '筛选记录'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>待确认资金事项</h2>
      <p className="workspace-subtitle">
        业务动作（退款、理赔、应付等）先挂在这里；确认多少记多少，剩余金额可以取消，不确认就不算已发生的钱。
      </p>
      {pendingItems.length === 0 ? (
        <EmptyState
          title="还没有待确认资金事项"
          hint="订单、售后、物流与采购接入资金后（#74），预计发生的钱会先出现在这里等人工确认。"
        />
      ) : (
        <div className="table-frame">
          <table aria-label="待确认资金事项">
            <thead>
              <tr>
                <th>类型</th>
                <th>方向</th>
                <th>金额</th>
                <th>已确认</th>
                <th>剩余</th>
                <th>状态</th>
                <th>来源</th>
                <th>发生时间</th>
                <th>说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pendingItems.map((item) => (
                <tr key={item.id}>
                  <td>{financeRecordTypeLabel(item.type)}</td>
                  <td>{financeDirectionLabel(item.direction)}</td>
                  <td>{formatMoney(item.amountCents)}</td>
                  <td>{formatMoney(item.confirmedCents)}</td>
                  <td>{formatMoney(item.remainingCents)}</td>
                  <td>
                    {financePendingStatusLabel(item.status)}
                    {item.status === 'cancelled' && item.cancelReason
                      ? `（${item.cancelReason}）`
                      : ''}
                  </td>
                  <td>{financeSourceLabel(item.sourceType)}</td>
                  <td>{formatTime(item.occurredAt)}</td>
                  <td>{item.note}</td>
                  <td>
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={item.status !== 'pending' || item.remainingCents <= 0}
                      onClick={() => openConfirmDialog(item)}
                    >
                      确认到账
                    </button>
                    {' '}
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={item.status !== 'pending' || item.remainingCents <= 0}
                      onClick={() => openCancelDialog(item)}
                    >
                      取消剩余
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>
        资金记录
        {typeFilter !== '' && (
          <>
            {' '}
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setTypeFilter('')}
            >
              清除类型筛选（{financeRecordTypeLabel(typeFilter)}）
            </button>
          </>
        )}
      </h2>
      <p className="workspace-subtitle">
        只有人工确认过的钱才进入这里；每笔记录不可修改，记错了用「冲正」生成反向记录。
      </p>
      {records.length === 0 ? (
        <EmptyState
          title="还没有资金记录"
          hint="从右上角「录入资金记录」开始，或到待确认事项里确认到账。"
        />
      ) : (
        <div className="table-frame">
          <table aria-label="资金记录">
            <thead>
              <tr>
                <th>序号</th>
                <th>类型</th>
                <th>方向</th>
                <th>金额</th>
                <th>确认方式</th>
                <th>发生时间</th>
                <th>确认时间</th>
                <th>来源</th>
                <th>说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((record) => (
                <tr key={record.id}>
                  <td>{record.sequence}</td>
                  <td>
                    {financeRecordTypeLabel(record.type)}
                    {record.reversesRecordId !== null && '（冲正）'}
                  </td>
                  <td>{financeDirectionLabel(record.direction)}</td>
                  <td>{formatMoney(record.amountCents)}</td>
                  <td>{financeConfirmedSourceLabel(record.confirmedSource)}</td>
                  <td>{formatTime(record.occurredAt)}</td>
                  <td>{formatTime(record.confirmedAt)}</td>
                  <td>
                    {record.pendingItemId !== null && record.sourceType !== null
                      ? `${financeSourceLabel(record.sourceType)} · 待确认事项`
                      : '直接录入'}
                  </td>
                  <td>{record.note}</td>
                  <td>
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={unreversedCentsOf(record) <= 0}
                      onClick={() => openReverseDialog(record)}
                    >
                      冲正
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'record' && (
        <DialogShell
          kicker="资金·直接录入"
          title="录入资金记录"
          description="已经实际发生的收入或支出（如自付运费、平台结算到账）；不确定的钱先走待确认事项。"
          busy={saving}
          onClose={() => setDialog(null)}
          onSubmit={submitRecord}
        >
          <label>
            <span>类型</span>
            <select
              aria-label="资金类型"
              value={recordType}
              disabled={saving}
              onChange={(event) => {
                const next = event.target.value as FinanceRecordTypeName;
                setRecordType(next);
                setRecordDirection(financeDirectionOfType(next));
              }}
            >
              {FINANCE_RECORD_TYPES.map((type) => (
                <option key={type} value={type}>{financeRecordTypeLabel(type)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>收支方向{recordType !== 'misc_expense' ? '（按类型固定）' : ''}</span>
            <select
              aria-label="收支方向"
              value={recordDirection}
              disabled={saving || recordType !== 'misc_expense'}
              onChange={(event) => setRecordDirection(
                event.target.value === 'income' ? 'income' : 'expense',
              )}
            >
              <option value="income">收入</option>
              <option value="expense">支出</option>
            </select>
          </label>
          <label>
            <span>金额（元）</span>
            <input
              aria-label="金额（元）"
              type="number"
              min={0.01}
              step={0.01}
              value={recordAmountYuan}
              disabled={saving}
              onChange={(event) => setRecordAmountYuan(event.target.value)}
            />
          </label>
          <label>
            <span>发生时间（留空为现在）</span>
            <input
              type="datetime-local"
              aria-label="发生时间"
              value={recordOccurredAt}
              disabled={saving}
              onChange={(event) => setRecordOccurredAt(event.target.value)}
            />
          </label>
          <ReasonField
            label="说明（必填）"
            value={recordNote}
            saving={saving}
            onChange={setRecordNote}
          />
          <InlineError message={formError} />
          <footer>
            <button
              className="button button--quiet"
              type="button"
              disabled={saving}
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '保存资金记录'}
            </button>
          </footer>
        </DialogShell>
      )}

      {dialog?.kind === 'confirm' && (
        <DialogShell
          kicker="资金·确认到账"
          title={`确认 ${financeRecordTypeLabel(dialog.item.type)}`}
          description={`金额 ${formatMoney(dialog.item.amountCents)}，已确认 ${formatMoney(dialog.item.confirmedCents)}，本次确认后剩余待确认 ${
            formatMoney(Math.max(dialog.item.remainingCents - (parseMoneyToCents(confirmAmountYuan) ?? 0), 0))
          }。`}
          busy={saving}
          onClose={() => setDialog(null)}
          onSubmit={submitConfirm}
        >
          <label>
            <span>本次确认金额（元）</span>
            <input
              aria-label="本次确认金额（元）"
              type="number"
              min={0.01}
              step={0.01}
              value={confirmAmountYuan}
              disabled={saving}
              onChange={(event) => setConfirmAmountYuan(event.target.value)}
            />
          </label>
          <ReasonField
            label="备注（选填）"
            value={confirmNote}
            saving={saving}
            onChange={setConfirmNote}
          />
          <InlineError message={formError} />
          <footer>
            <button
              className="button button--quiet"
              type="button"
              disabled={saving}
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '确认到账'}
            </button>
          </footer>
        </DialogShell>
      )}

      {dialog?.kind === 'cancel' && (
        <DialogShell
          kicker="资金·取消剩余"
          title={`取消 ${financeRecordTypeLabel(dialog.item.type)} 的剩余金额`}
          description={`剩余 ${formatMoney(dialog.item.remainingCents)} 将不再等待确认；已确认的 ${
            formatMoney(dialog.item.confirmedCents)
          } 保持不动。`}
          busy={saving}
          onClose={() => setDialog(null)}
          onSubmit={submitCancel}
        >
          <ReasonField
            label="取消原因（必填）"
            value={cancelReason}
            saving={saving}
            onChange={setCancelReason}
          />
          <InlineError message={formError} />
          <footer>
            <button
              className="button button--quiet"
              type="button"
              disabled={saving}
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '取消剩余金额'}
            </button>
          </footer>
        </DialogShell>
      )}

      {dialog?.kind === 'reverse' && (
        <DialogShell
          kicker="资金·冲正"
          title={`冲正 ${financeRecordTypeLabel(dialog.record.type)} 记录`}
          description={`原记录 ${financeDirectionLabel(dialog.record.direction)} ${
            formatMoney(dialog.record.amountCents)
          }，未冲正余额 ${formatMoney(unreversedCentsOf(dialog.record))}；冲正生成反向记录，原记录保持不变。`}
          busy={saving}
          onClose={() => setDialog(null)}
          onSubmit={submitReverse}
        >
          <label>
            <span>冲正金额（元）</span>
            <input
              aria-label="冲正金额（元）"
              type="number"
              min={0.01}
              step={0.01}
              value={reverseAmountYuan}
              disabled={saving}
              onChange={(event) => setReverseAmountYuan(event.target.value)}
            />
          </label>
          <ReasonField
            label="冲正原因（必填）"
            value={reverseNote}
            saving={saving}
            onChange={setReverseNote}
          />
          <InlineError message={formError} />
          <footer>
            <button
              className="button button--quiet"
              type="button"
              disabled={saving}
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '生成冲正记录'}
            </button>
          </footer>
        </DialogShell>
      )}
    </>,
  );

  function shell(children: ReactNode) {
    return (
      <section className="funds-workspace workspace-enter" aria-label="资金">
        <header className="workspace-header">
          <div>
            <span className="section-kicker">资金·待确认与已确认</span>
            <h1>资金</h1>
            <p className="workspace-subtitle">
              业务完成不等于钱已发生：预计会发生的先挂「待确认事项」，
              人工确认后才成为不可变的「资金记录」，记错用冲正抵回，不改历史。
            </p>
          </div>
          <div className="toolbar">
            <button
              className="button button--quiet"
              type="button"
              onClick={openRecordDialog}
            >
              录入资金记录
            </button>
          </div>
        </header>
        {children}
      </section>
    );
  }
}

function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}¥${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

function parseMoneyToCents(value: string): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

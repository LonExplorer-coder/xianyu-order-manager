import { useState, type FormEvent } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import {
  FINANCE_RECORD_TYPES,
  financeDirectionLabel,
  financeDirectionOfType,
  financePendingStatusLabel,
  financeRecordTypeLabel,
  financeSourceLabel,
  type FinanceDirectionName,
  type FinanceFactsForSource,
  type FinanceRecordTypeName,
  type FinanceSourceTypeName,
  type FundsView,
} from '../core/funds';
import { DialogShell, InlineError } from './DialogShell';

// 业务详情页「记一笔」的预填来源：来源锁定为该业务记录，类型与方向可预选。
export type FinanceRecordDialogPreset = {
  sourceType: FinanceSourceTypeName;
  sourceId: string;
  sourceLabel: string;
  defaultType?: FinanceRecordTypeName;
  defaultDirection?: FinanceDirectionName;
};

export function FinanceRecordDialog({ api, preset, onClose, onSaved }: {
  api: DesktopApi;
  preset: FinanceRecordDialogPreset | null;
  onClose: () => void;
  onSaved: (view: FundsView) => void;
}) {
  const initialType = preset?.defaultType ?? 'replacement_freight';
  const [type, setType] = useState<FinanceRecordTypeName>(initialType);
  const [direction, setDirection] = useState<FinanceDirectionName>(
    preset?.defaultDirection ?? financeDirectionOfType(initialType),
  );
  const [amountYuan, setAmountYuan] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const directionLocked = type !== 'misc_expense' && type !== 'purchase_cost';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amountCents = parseMoneyToCents(amountYuan);
    if (amountCents === null) {
      setFormError('请填写大于零的金额');
      return;
    }
    setSaving(true);
    setFormError('');
    api.recordFinanceRecord({
      type,
      direction,
      amountCents,
      occurredAt: occurredAt
        ? new Date(occurredAt).toISOString()
        : new Date().toISOString(),
      note: note.trim(),
      ...(preset
        ? { sourceType: preset.sourceType, sourceId: preset.sourceId }
        : {}),
    })
      .then((view) => {
        onSaved(view);
        onClose();
      })
      .catch((cause: unknown) => {
        setFormError(errorMessage(cause));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <DialogShell
      kicker={preset ? '资金·记一笔' : '资金·直接录入'}
      title="录入资金记录"
      description={preset
        ? `记录会永久关联：${preset.sourceLabel}。已经实际发生的收入或支出；不确定的钱先走待确认事项。`
        : '已经实际发生的收入或支出（如自付运费、平台结算到账）；不确定的钱先走待确认事项。'}
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {preset && (
        <p className="workspace-subtitle">
          关联来源：{preset.sourceLabel}（{financeSourceLabel(preset.sourceType)}）
        </p>
      )}
      <label>
        <span>类型</span>
        <select
          aria-label="资金类型"
          value={type}
          disabled={saving}
          onChange={(event) => {
            const next = event.target.value as FinanceRecordTypeName;
            setType(next);
            setDirection(financeDirectionOfType(next));
          }}
        >
          {FINANCE_RECORD_TYPES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {financeRecordTypeLabel(candidate)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>收支方向{directionLocked ? '（按类型固定）' : ''}</span>
        <select
          aria-label="收支方向"
          value={direction}
          disabled={saving || directionLocked}
          onChange={(event) => setDirection(
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
          value={amountYuan}
          disabled={saving}
          onChange={(event) => setAmountYuan(event.target.value)}
        />
      </label>
      <label>
        <span>发生时间（留空为现在）</span>
        <input
          type="datetime-local"
          aria-label="发生时间"
          value={occurredAt}
          disabled={saving}
          onChange={(event) => setOccurredAt(event.target.value)}
        />
      </label>
      <label>
        <span>说明（必填）</span>
        <input
          aria-label="资金说明"
          value={note}
          disabled={saving}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <InlineError message={formError} />
      <footer>
        <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
          取消
        </button>
        <button className="button button--primary" type="submit" disabled={saving}>
          {saving ? '正在保存…' : '保存资金记录'}
        </button>
      </footer>
    </DialogShell>
  );
}

// 业务详情里的只读资金摘要：待确认事项与已确认记录分开列示。
export function FinanceFactsSummary({ facts }: { facts: FinanceFactsForSource | null }) {
  if (!facts) return <p className="workspace-subtitle">正在读取资金…</p>;
  if (facts.pendingItems.length === 0 && facts.records.length === 0) {
    return <p className="workspace-subtitle">还没有关联的资金事项或记录。</p>;
  }
  return (
    <>
      {facts.pendingItems.length > 0 && (
        <>
          <p className="workspace-subtitle">待确认事项（业务已发生、等人工确认的钱）</p>
          <ul>
            {facts.pendingItems.map((item) => (
              <li key={item.id}>
                {financeRecordTypeLabel(item.type)} · {financeDirectionLabel(item.direction)} ·{' '}
                {formatMoney(item.amountCents)}
                {item.remainingCents < item.amountCents
                  ? `（已确认 ${formatMoney(item.confirmedCents)}，剩余 ${formatMoney(item.remainingCents)}）`
                  : ''}{' '}
                · {financePendingStatusLabel(item.status)}
                {item.status === 'cancelled' && item.cancelReason ? `（${item.cancelReason}）` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {facts.records.length > 0 && (
        <>
          <p className="workspace-subtitle">资金记录（人工确认后不可改）</p>
          <ul>
            {facts.records.map((record) => (
              <li key={record.id}>
                {financeRecordTypeLabel(record.type)}
                {record.reversesRecordId !== null && '（冲正）'} ·{' '}
                {financeDirectionLabel(record.direction)} · {formatMoney(record.amountCents)} ·{' '}
                {formatTime(record.occurredAt)} · <span>{record.note}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function financeFactsNetCents(facts: FinanceFactsForSource): number {
  return facts.records.reduce(
    (total, record) => total + (record.direction === 'income'
      ? record.amountCents
      : -record.amountCents),
    0,
  );
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}¥${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

export function parseMoneyToCents(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/u.test(value.trim())) return null;
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

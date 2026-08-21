import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import type { OcrQuotaMode, OcrUsageView } from '../core/ocr-usage';

type OcrUsageApi = Pick<
  DesktopApi,
  'getOcrUsage' | 'saveOcrUsageQuota' | 'confirmOcrUsageResume'
>;

type Feedback = { kind: 'success' | 'error'; message: string } | null;

export function OcrUsageSettingsPanel({ api }: { api: OcrUsageApi }) {
  const [usage, setUsage] = useState<OcrUsageView | null>(null);
  const [busy, setBusy] = useState<'saving' | 'resuming' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [limitInput, setLimitInput] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [quotaMode, setQuotaMode] = useState<OcrQuotaMode>('remind');

  useEffect(() => {
    let active = true;
    void api.getOcrUsage()
      .then((value) => {
        if (!active) return;
        applyUsage(value);
      })
      .catch((error: unknown) => {
        if (active) setFeedback({ kind: 'error', message: errorMessage(error) });
      });
    return () => {
      active = false;
    };
  }, [api]);

  function applyUsage(value: OcrUsageView): void {
    setUsage(value);
    setLimitInput(formatMoneyInput(value.quota.monthlyLimitCents));
    setPriceInput(formatMoneyInput(value.quota.estimatedPricePerCallCents));
    setQuotaMode(value.quota.mode);
  }

  async function saveQuota(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!/^\d+(\.\d{1,2})?$/u.test(limitInput.trim())) {
      setFeedback({ kind: 'error', message: '月度额度必须是 0 到 100000 元之间的数字' });
      return;
    }
    if (!/^\d+(\.\d{1,2})?$/u.test(priceInput.trim())) {
      setFeedback({ kind: 'error', message: '单次估算费用必须是 0 到 1000 元之间的数字' });
      return;
    }
    setBusy('saving');
    setFeedback(null);
    try {
      const saved = await api.saveOcrUsageQuota({
        monthlyLimitCents: Math.round(Number(limitInput) * 100),
        mode: quotaMode,
        estimatedPricePerCallCents: Math.round(Number(priceInput) * 100),
      });
      applyUsage(saved);
      setFeedback({ kind: 'success', message: 'OCR 用量额度设置已保存' });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function resumeUsage(): Promise<void> {
    setBusy('resuming');
    setFeedback(null);
    try {
      const resumed = await api.confirmOcrUsageResume();
      applyUsage(resumed);
      setFeedback({ kind: 'success', message: '已确认继续，本月不再拦截付费调用' });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  const progressMaximum = usage?.quota.monthlyLimitCents || 1;
  const progressValue = Math.min(usage?.usage.estimatedCostCents ?? 0, progressMaximum);

  return (
    <section className="settings-section settings-section--ocr-usage">
      <div className="settings-section-heading">
        <div>
          <span className="section-kicker">用量与额度</span>
          <h2>OCR 用量</h2>
          <p>统计本机所有数据目录本月发生的付费调用。</p>
        </div>
        {usage?.hardPaused && (
          <span className="service-state is-ready">
            <i aria-hidden="true" />
            已暂停
          </span>
        )}
      </div>

      {!usage ? (
        feedback ? <Notice feedback={feedback} /> : (
          <div className="settings-loading settings-loading--compact" role="status">
            正在读取 OCR 用量…
          </div>
        )
      ) : (
        <>
          <div className="ocr-usage-stats" aria-label="本月 OCR 用量统计">
            <UsageStat value={String(usage.usage.totalCalls)} label="调用次数" />
            <UsageStat
              value={usage.usage.totalCalls > 0
                ? `${Math.round((usage.usage.succeededCalls / usage.usage.totalCalls) * 100)}%`
                : '—'}
              label="成功率"
            />
            <UsageStat value={formatMoney(usage.usage.estimatedCostCents)} label="估算费用" />
            <UsageStat value={formatMoney(usage.quota.monthlyLimitCents)} label="月度额度" />
          </div>

          <div
            className={`ocr-usage-meter${usage.overLimit ? ' is-over-limit' : ''}`}
            role="progressbar"
            aria-label="本月 OCR 费用进度"
            aria-valuemin={0}
            aria-valuemax={progressMaximum}
            aria-valuenow={progressValue}
            aria-valuetext={`${formatMoney(usage.usage.estimatedCostCents)} / ${formatMoney(usage.quota.monthlyLimitCents)}`}
          >
            <i style={{
              width: `${usage.quota.monthlyLimitCents > 0
                ? Math.min(100, (usage.usage.estimatedCostCents / usage.quota.monthlyLimitCents) * 100)
                : 0}%`,
            }} />
          </div>

          {usage.overLimit && (
            <div className="ocr-usage-warning" role="status">
              <strong>本月估算费用已达到额度上限。</strong>
              {usage.hardPaused
                ? '所有数据目录的新付费操作已暂停，待处理截图仍保留在本机。'
                : usage.quota.mode === 'hard_stop'
                  ? '已确认继续，本月不再拦截全局付费调用。'
                  : '当前为仅提醒模式，识别不会中断；如需强制停止，请切换为硬暂停。'}
            </div>
          )}

          {usage.hardPaused && (
            <div className="ocr-usage-paused" aria-label="硬暂停恢复">
              <p>调整额度，或确认继续以在本月内放行所有数据目录的后续付费操作。</p>
              <button
                className="button button--primary"
                type="button"
                disabled={busy !== null}
                onClick={() => void resumeUsage()}
              >
                {busy === 'resuming' ? '正在恢复…' : '确认继续'}
              </button>
            </div>
          )}

          <form
            className="settings-section-form"
            aria-label="OCR 用量额度设置"
            onSubmit={(event) => void saveQuota(event)}
          >
            <div className="settings-fields">
              <Field label="月度额度（元）">
                <input
                  aria-label="月度额度"
                  inputMode="decimal"
                  value={limitInput}
                  onChange={(event) => setLimitInput(event.target.value)}
                  placeholder="例如 10"
                />
                <small className="field-help">所有数据目录共同消耗该额度；0 表示不设额度。</small>
              </Field>
              <Field label="单次估算费用（元）">
                <input
                  aria-label="单次估算费用"
                  inputMode="decimal"
                  value={priceInput}
                  onChange={(event) => setPriceInput(event.target.value)}
                  placeholder="例如 0.05"
                />
                <small className="field-help">成功调用按此单价累计，失败调用不计费。</small>
              </Field>
              <Field label="额度模式">
                <div className="ocr-quota-mode" role="radiogroup" aria-label="额度模式">
                  <label>
                    <input
                      type="radio"
                      name="ocr-quota-mode"
                      checked={quotaMode === 'remind'}
                      onChange={() => setQuotaMode('remind')}
                    />
                    仅提醒
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="ocr-quota-mode"
                      checked={quotaMode === 'hard_stop'}
                      onChange={() => setQuotaMode('hard_stop')}
                    />
                    硬暂停
                  </label>
                </div>
                <small className="field-help">达到全局额度后，下一个独立付费操作将被暂停。</small>
              </Field>
            </div>
            <div className="settings-actions">
              <button className="button button--primary" type="submit" disabled={busy !== null}>
                {busy === 'saving' ? '正在保存…' : '保存额度设置'}
              </button>
            </div>
          </form>

          <details className="ocr-usage-events">
            <summary>最近调用记录（{usage.recentEvents.length}）</summary>
            {usage.recentEvents.length === 0 ? (
              <p className="ocr-usage-events-empty">还没有付费调用记录。</p>
            ) : (
              <ul className="ocr-usage-events-list">
                {usage.recentEvents.map((event) => (
                  <li key={event.id}>
                    <span>{formatDateTime(event.occurredAt)}</span>
                    <span>{callKindLabel(event.kind)}</span>
                    <span className={event.outcome === 'success' ? 'is-success' : 'is-failure'}>
                      {event.outcome === 'success' ? '成功' : '失败'}
                    </span>
                    <span>{formatMoney(event.estimatedCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>

          <Notice feedback={feedback} />
        </>
      )}
    </section>
  );
}

function UsageStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="ocr-usage-stat">
      <span className="ocr-usage-stat-value">{value}</span>
      <small>{label}</small>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function Notice({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <div
      className={`settings-notice settings-notice--${feedback.kind}`}
      role={feedback.kind === 'error' ? 'alert' : 'status'}
    >
      <span>{feedback.message}</span>
    </div>
  );
}

function formatMoney(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function formatMoneyInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function callKindLabel(kind: OcrUsageView['recentEvents'][number]['kind']): string {
  if (kind === 'recognition') return '识别';
  if (kind === 'connection_test') return '连接测试';
  return '候选裁决';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}

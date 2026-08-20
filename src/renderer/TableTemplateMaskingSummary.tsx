import type { OrderExportPreviewSheet } from '../core/order-export';

export type TableTemplateMaskingSummaryProps = {
  sheet: Pick<OrderExportPreviewSheet, 'name' | 'maskingSummary'> | undefined;
  headingId?: string;
};

export function TableTemplateMaskingSummary({
  sheet,
  headingId,
}: TableTemplateMaskingSummaryProps) {
  return (
    <section className="order-export-dialog__masking" aria-labelledby={headingId}>
      <div>
        <strong id={headingId}>{sheet?.name ?? '工作表'}模板脱敏摘要</strong>
        <small>由当前工作表选择的模板决定，与上方真实预览一致。</small>
      </div>
      {sheet && (
        <ul>
          {sheet.maskingSummary.map((summary) => <li key={summary}>{summary}</li>)}
        </ul>
      )}
      {sheet?.maskingSummary.some((summary) => summary.endsWith('完整显示')) && (
        <p className="order-export-dialog__privacy-warning" role="alert">
          隐私提醒：当前模板会导出上列字段的完整原文，请确认保存位置安全。
        </p>
      )}
    </section>
  );
}

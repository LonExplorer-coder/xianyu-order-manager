import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * 应用内统一的模态对话框契约：portal 到 document.body、aria-labelledby 指向标题、
 * 非忙碌时 Escape 关闭、打开时聚焦对话框并在关闭后还原焦点。
 * 结构：section-kicker + h2 + 描述段；字段与底部按钮由调用方填充。
 */
export function DialogShell({
  kicker,
  title,
  description,
  busy = false,
  wide = false,
  dialogClassName,
  onClose,
  onSubmit,
  children,
}: {
  kicker: string;
  title: string;
  description?: string;
  busy?: boolean;
  wide?: boolean;
  dialogClassName?: string;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const dialogRef = useDialogFocus();
  const headingId = useId();
  const descriptionId = useId();
  return createPortal(
    <div
      ref={dialogRef}
      className="order-export-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      {...(description !== undefined ? { 'aria-describedby': descriptionId } : {})}
      tabIndex={-1}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && !busy) onClose();
      }}
    >
      <form
        className={dialogClassName ?? (wide ? 'shared-dialog shared-dialog--wide' : 'shared-dialog')}
        onSubmit={onSubmit}
      >
        <header>
          <span className="section-kicker">{kicker}</span>
          <h2 id={headingId}>{title}</h2>
          {description !== undefined && <p id={descriptionId}>{description}</p>}
        </header>
        {children}
      </form>
    </div>,
    document.body,
  );
}

/**
 * 不可撤销操作的确认对话框：alertdialog + 危险确认按钮 + 焦点陷阱。
 * 需要填写原因等字段时作为 children 传入；确认按钮统一使用 template-delete-button。
 */
export function ConfirmDangerDialog({
  kicker,
  title,
  description,
  busy = false,
  confirmLabel,
  canSubmit = true,
  onConfirm,
  onClose,
  children,
}: {
  kicker: string;
  title: string;
  description: string;
  busy?: boolean;
  confirmLabel: string;
  canSubmit?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>(
      'textarea:not([disabled]), input:not([disabled]), select:not([disabled]), button:not([disabled])',
    )?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
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
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocus?.focus();
    };
  }, []);
  return createPortal(
    <div
      ref={dialogRef}
      className="template-confirm-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
    >
      <div className="template-confirm-dialog template-confirm-dialog--wide">
        <span className="section-kicker">{kicker}</span>
        <h2 id={headingId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {children}
        <div className="template-confirm-dialog__actions">
          <button
            className="button button--quiet"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button template-delete-button"
            type="button"
            disabled={busy || !canSubmit}
            onClick={onConfirm}
          >
            {busy ? '正在处理…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ReasonField({
  label,
  value,
  saving,
  onChange,
}: {
  label: string;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <textarea
        aria-label={label}
        value={value}
        maxLength={500}
        disabled={saving}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function InlineError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="inline-error" role="alert">
      <svg
        className="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m12 3.5 9 16H3z" />
        <path d="M12 9v4.5M12 17h.01" />
      </svg>
      <span>{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  status = false,
}: {
  title: string;
  hint?: string;
  status?: boolean;
}) {
  return (
    <div className="template-empty" {...(status ? { role: 'status' } : {})}>
      <strong>{title}</strong>
      {hint !== undefined && <p>{hint}</p>}
    </div>
  );
}

function useDialogFocus() {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);
  return dialogRef;
}

import type { BrowserWindow } from 'electron';

export type SingleInstanceApp = {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
};

export type FocusableWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isMinimized' | 'restore' | 'focus'
>;

export function acquireSingleInstance(
  application: SingleInstanceApp,
  currentWindow: () => FocusableWindow | undefined,
  skip = false,
): boolean {
  if (skip) return true;
  const acquired = application.requestSingleInstanceLock();
  if (!acquired) {
    application.quit();
    return false;
  }
  application.on('second-instance', () => focusExistingWindow(currentWindow()));
  return true;
}

export function focusExistingWindow(window: FocusableWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

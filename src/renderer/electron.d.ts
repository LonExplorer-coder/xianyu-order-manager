import type { DesktopApi } from '../core/desktop-api';

declare global {
  interface Window {
    xianyuApi: DesktopApi;
  }
}

export {};

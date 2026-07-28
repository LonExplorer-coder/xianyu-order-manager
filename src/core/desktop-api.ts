import type {
  OrderDetails,
  OrderDraft,
  OrderSummary,
  OriginalOrder,
} from './contracts';

export type BootstrapState =
  | { kind: 'needs_data_directory' }
  | { kind: 'ready'; dataDirectory: string; orders: OrderSummary[] }
  | { kind: 'locked'; dataDirectory: string; message: string }
  | { kind: 'error'; message: string };

export interface DesktopApi {
  getBootstrapState(): Promise<BootstrapState>;
  retryDataDirectory(): Promise<BootstrapState>;
  selectDataDirectory(): Promise<BootstrapState>;
  selectSourceScreenshot(): Promise<OrderDraft | null>;
  confirmDraft(draft: OrderDraft): Promise<OriginalOrder>;
  listOrders(): Promise<OrderSummary[]>;
  getOrder(orderId: string): Promise<OrderDetails>;
  getScreenshotDataUrl(screenshotId: string): Promise<string>;
}

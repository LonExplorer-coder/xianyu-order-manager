import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ControlledRecognizer } from '../adapters/recognition/controlled-recognizer';
import type {
  RecognitionBatchItem,
  RecognitionResult,
} from '../core/contracts';
import { DesktopSession } from './desktop-session';
import { OcrSettingsService } from './ocr-settings';
import { Preferences } from './preferences';

export const PORTABLE_SMOKE_ORDER_NUMBER = 'PORTABLE-SMOKE-ORDER-001';

export type PortableReleaseSmokeInput = {
  phase: 'write' | 'read';
  configDirectory: string;
  dataDirectory: string;
};

export type PortableReleaseSmokeResult = {
  phase: PortableReleaseSmokeInput['phase'];
  dataDirectory: string;
  orderNumber: typeof PORTABLE_SMOKE_ORDER_NUMBER;
  orderCount: number;
};

export async function runPortableReleaseDataSmoke(
  input: PortableReleaseSmokeInput,
): Promise<PortableReleaseSmokeResult> {
  const configDirectory = requiredAbsolutePath(input.configDirectory, '启动配置目录');
  const dataDirectory = requiredAbsolutePath(input.dataDirectory, '订单数据目录');
  if (configDirectory === dataDirectory) {
    throw new Error('便携版冒烟要求启动配置目录与订单数据目录相互独立');
  }

  const recognizer = new ControlledRecognizer(PORTABLE_SMOKE_RECOGNITION);
  const session = new DesktopSession(
    new Preferences(configDirectory),
    recognizer,
    createSmokeOcrSettings(),
  );

  try {
    if (input.phase === 'write') {
      await importPortableSmokeOrder(session, configDirectory, dataDirectory);
    } else {
      const restored = session.restore();
      if (restored.kind !== 'ready' || resolve(restored.dataDirectory) !== dataDirectory) {
        throw new Error('便携版重启后未能自动打开原订单数据目录');
      }
    }

    const orders = session.listOrders();
    const smokeOrder = orders.find((order) => (
      order.orderNumber === PORTABLE_SMOKE_ORDER_NUMBER
    ));
    if (!smokeOrder) throw new Error('未找到便携版冒烟订单');
    if (smokeOrder.recipient !== '便携验收收件人' || smokeOrder.itemCount !== 1) {
      throw new Error('便携版冒烟订单内容不完整');
    }
    const details = session.getOrder(smokeOrder.id);
    if (
      details.order.items.length !== 1 ||
      details.order.items[0]?.sourceTitle !== '便携版验收商品' ||
      details.order.amountCents !== 800
    ) {
      throw new Error('便携版冒烟订单详情不完整');
    }
    const screenshotDataUrl = await session.getScreenshotDataUrl(
      details.sourceScreenshot.id,
    );
    if (!screenshotDataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('便携版重启后无法读取来源截图');
    }

    return {
      phase: input.phase,
      dataDirectory,
      orderNumber: PORTABLE_SMOKE_ORDER_NUMBER,
      orderCount: orders.length,
    };
  } finally {
    session.close();
  }
}

async function importPortableSmokeOrder(
  session: DesktopSession,
  configDirectory: string,
  dataDirectory: string,
): Promise<void> {
  if (session.restore().kind !== 'needs_data_directory') {
    throw new Error('便携版首次启动冒烟必须从未选择数据目录的状态开始');
  }
  const selected = session.useDataDirectory(dataDirectory);
  if (selected.kind !== 'ready' || selected.orders.length !== 0) {
    throw new Error('便携版首次选择订单数据目录失败或目录并非空目录');
  }

  await mkdir(configDirectory, { recursive: true });
  const sourcePath = join(configDirectory, 'portable-release-smoke.png');
  await writeFile(sourcePath, PORTABLE_SMOKE_PNG, { flag: 'wx' });
  try {
    const batch = await session.submitSourceScreenshots([sourcePath]);
    const item = await waitForReviewableItem(session, batch.id);
    if (!item.draftId) throw new Error('便携版冒烟没有生成可入库订单');
    const confirmed = session.confirmDraft(session.getDraft(item.draftId));
    if (confirmed.order.orderNumber !== PORTABLE_SMOKE_ORDER_NUMBER) {
      throw new Error('便携版冒烟导入了错误订单');
    }
  } finally {
    await unlink(sourcePath).catch(() => undefined);
  }
}

async function waitForReviewableItem(
  session: DesktopSession,
  batchId: string,
): Promise<RecognitionBatchItem> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const item = session
      .listRecognitionBatches()
      .find((batch) => batch.id === batchId)
      ?.items[0];
    if (item?.status === 'awaiting_confirmation') return item;
    if (item && ['failed', 'waiting_retry', 'cancelled'].includes(item.status)) {
      throw new Error(item.errorMessage || `便携版冒烟识别失败：${item.status}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('便携版冒烟等待订单识别超时');
}

function createSmokeOcrSettings(): OcrSettingsService {
  return new OcrSettingsService(
    { read: () => null, write: () => undefined },
    {
      getApiKey: async () => null,
      setApiKey: async () => undefined,
      deleteApiKey: async () => undefined,
      getDisplayName: () => '便携版冒烟凭据库',
    },
    { testConnection: async () => ({ model: 'qwen3.5-ocr' }) },
  );
}

function requiredAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  const normalized = resolve(value);
  if (normalized !== value) throw new Error(`${label}必须使用绝对路径`);
  return normalized;
}

const PORTABLE_SMOKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const PORTABLE_SMOKE_RECOGNITION: RecognitionResult = {
  platform: 'xianyu',
  sellerAccount: '便携版验收账号',
  orderNumber: PORTABLE_SMOKE_ORDER_NUMBER,
  alipayTransactionNumber: 'PORTABLE-SMOKE-ALI-001',
  buyerNickname: '便***户',
  recipient: '便携验收收件人',
  phone: '13900000001',
  phoneNormalized: '13900000001',
  addressOriginal: '广东省深圳市南山区便携验收路1号',
  addressNormalized: '广东省深圳市南山区便携验收路1号',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  orderedAtOriginal: '2026-07-31 09:00:00',
  orderedAtNormalized: '2026-07-31T09:00:00+08:00',
  paidAtOriginal: '2026-07-31 09:00:08',
  paidAtNormalized: '2026-07-31T09:00:08+08:00',
  productTotalCents: 800,
  shippingFeeCents: 0,
  amountCents: 800,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  items: [{
    sourceTitle: '便携版验收商品',
    sourceSpec: '标准款',
    unitPriceCents: 800,
    quantity: 1,
    quantityInferred: true,
  }],
};

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type {
  CustomFieldDefinition,
  CustomFieldValueRecord,
} from '../src/core/custom-fields';
import type {
  OrderDetails,
  OrderDraft,
  OrderSummary,
  OriginalOrder,
  RecognitionAttempt,
  RecognitionBatchItemStatus,
  RecognitionBatchView,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
  SourceSnapshot,
} from '../src/core/contracts';
import type {
  OrderWorkbenchQuery,
  OrderWorkbenchResult,
} from '../src/core/order-workbench';
import { orderReviewIssueLabel } from '../src/core/order-intake';
import { summarizeRecognitionBatchItems } from '../src/core/recognition-batches';
import type { ShipmentGroupProjection } from '../src/core/shipment-groups';
import type { ShipmentGroupArchive, ShipmentRecord } from '../src/core/shipment-records';
import type { AftersalesCase } from '../src/core/aftersales-cases';
import {
  SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES,
  aftersalesWorkflowForScenario,
  type AftersalesWorkflowTemplate,
} from '../src/core/aftersales-workflow-templates';
import type { TableTemplate, UpdateTableTemplateInput } from '../src/core/table-templates';
import { LocalApplication } from '../src/main/local-application';
import { App } from '../src/renderer/App';
import { hasActiveParentAftersalesCase } from '../src/renderer/aftersales-presentation';

afterEach(cleanup);

const emptyAftersalesRounds: Pick<
  AftersalesCase,
  'rounds' | 'fulfillment' | 'workflowTemplate'
> = {
  workflowTemplate: {
    templateId: 'system-aftersales-other',
    version: 1,
    name: '其他处理',
    scenario: 'other',
    steps: [],
    timeline: [],
  },
  rounds: [],
  fulfillment: {
    cumulativeSentQuantity: 0,
    cumulativeReturnedQuantity: 0,
    buyerHeldQuantity: 0,
    currentRoundNumber: 1,
  },
};

const testWorkflowTemplates: AftersalesWorkflowTemplate[] =
  SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES.map((template) => ({
    id: template.id,
    origin: 'system',
    systemKey: template.systemKey,
    enabled: true,
    version: 1,
    ...template.definition,
    workflow: aftersalesWorkflowForScenario(template.definition.scenario),
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    versionCreatedAt: '2026-08-14T00:00:00.000Z',
  }));

const draft: OrderDraft = {
  id: 'draft-1',
  batchId: 'batch-1',
  screenshotId: 'shot-1',
  status: 'awaiting_review',
  createdAt: '2026-07-27T11:22:00.000Z',
  platform: 'xianyu',
  sellerAccount: '测试闲鱼账号',
  orderNumber: 'XY-TEST-20260727-0001',
  alipayTransactionNumber: 'ALI-SYNTH-UI-0001',
  buyerNickname: '测试买家',
  recipient: '测试收件人',
  phone: '13800000000',
  phoneNormalized: '13800000000',
  addressOriginal: '广东省深圳市南山区测试路1号',
  addressNormalized: '广东省深圳市南山区测试路1号',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  orderedAtOriginal: '2026-07-27 11:21:46',
  orderedAtNormalized: '2026-07-27T11:21:46+08:00',
  paidAtOriginal: '2026-07-27 11:21:54',
  paidAtNormalized: '2026-07-27T11:21:54+08:00',
  productTotalCents: 800,
  shippingFeeCents: 0,
  amountCents: 800,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  items: [
    {
      id: 'item-1',
      position: 0,
      sourceTitle: '脱敏测试商品',
      sourceSpec: '白色',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: true,
    },
  ],
};

const confirmedOrder: OriginalOrder = {
  id: 'order-1',
  systemOrderNumber: '20260727-000001',
  revision: 1,
  platform: 'xianyu',
  sellerAccount: draft.sellerAccount,
  orderNumber: draft.orderNumber,
  alipayTransactionNumber: draft.alipayTransactionNumber,
  buyerNickname: draft.buyerNickname,
  recipient: '人工修正收件人',
  phone: draft.phone,
  phoneNormalized: draft.phoneNormalized,
  addressOriginal: draft.addressOriginal,
  addressNormalized: draft.addressNormalized,
  province: draft.province,
  city: draft.city,
  district: draft.district,
  orderedAtOriginal: draft.orderedAtOriginal,
  orderedAtNormalized: draft.orderedAtNormalized,
  paidAtOriginal: draft.paidAtOriginal,
  paidAtNormalized: draft.paidAtNormalized,
  productTotalCents: draft.productTotalCents,
  shippingFeeCents: draft.shippingFeeCents,
  amountCents: 800,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  shippingCarrier: '',
  trackingNumber: '',
  lifecycleStatus: 'active',
  createdAt: '2026-07-27T11:22:00.000Z',
  updatedAt: '2026-07-27T11:24:00.000Z',
  items: [{
    ...draft.items[0],
    unitPriceCents: 800,
    quantity: 2,
    quantityInferred: false,
    subtotalCents: 1_600,
  }],
};

const sourceScreenshot = {
  id: draft.screenshotId,
  originalName: '脱敏测试订单.png',
  relativePath: 'screenshots/shot-1.png',
  mimeType: 'image/png',
  sha256: 'abc123',
  createdAt: draft.createdAt,
};
const sourceSnapshot: SourceSnapshot = {
  id: 'snapshot-1',
  createdAt: draft.createdAt,
  recognition: { ...draft, fulfillmentStatus: 'pending_shipment' },
  confirmed: {
    ...draft,
    fulfillmentStatus: 'pending_shipment',
    recipient: confirmedOrder.recipient,
  },
};
const orderDetails: OrderDetails = {
  order: confirmedOrder,
  sourceScreenshot,
  sourceSnapshot,
  sources: [{ recognitionStatus: 'imported', sourceScreenshot, sourceSnapshot }],
  changeEvents: [],
  customFieldDefinitions: [],
  customFieldValues: [],
  operations: {
    shipmentRecords: [],
    aftersalesCases: [],
    currentTodo: '无需物流操作',
    coordination: { primaryTodo: null, secondaryTodoCount: 0, todos: [] },
    risks: [],
    facts: [],
    history: [],
  },
};

function orderSummary(
  order: OriginalOrder = confirmedOrder,
  overrides: Partial<OrderSummary> = {},
): OrderSummary {
  return {
    id: order.id,
    systemOrderNumber: order.systemOrderNumber,
    platform: order.platform,
    sellerAccount: order.sellerAccount,
    orderNumber: order.orderNumber,
    alipayTransactionNumber: order.alipayTransactionNumber,
    buyerNickname: order.buyerNickname,
    recipient: order.recipient,
    phone: order.phone,
    addressOriginal: order.addressOriginal,
    province: order.province,
    city: order.city,
    district: order.district,
    amountCents: order.amountCents,
    itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
    initialSourceRecognitionStatus: 'imported',
    platformTransactionStatus: order.platformTransactionStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    shippingCarrier: order.shippingCarrier,
    trackingNumber: order.trackingNumber,
    lifecycleStatus: order.lifecycleStatus,
    orderedAtNormalized: order.orderedAtNormalized,
    paidAtNormalized: order.paidAtNormalized,
    createdAt: order.createdAt,
    items: order.items.map(({ sourceTitle, sourceSpec, quantity }) => ({
      sourceTitle,
      sourceSpec,
      quantity,
    })),
    operations: {
      shipmentSummary: '无发货',
      logisticsSummary: '无物流',
      aftersalesSummary: '无售后',
      currentTodo: '无需处理',
    },
    ...overrides,
  };
}

function exportPreviewSheet(
  name: '订单总表' | '订单商品明细表',
  headers: string[],
  rows: string[][],
) {
  return {
    name,
    columns: headers.map((header) => ({ header, valueType: 'text' as const })),
    rows,
    totalRowCount: rows.length,
  };
}

function workbenchResult(
  orders: OrderSummary[],
  overrides: Partial<OrderWorkbenchResult> = {},
): OrderWorkbenchResult {
  const activeOrderCount = overrides.activeOrderCount ?? orders.filter(
    (order) => order.lifecycleStatus === 'active',
  ).length;
  return {
    orders,
    customFieldValues: [],
    activeOrderCount,
    allLifecycleOrderCount: Math.max(orders.length, activeOrderCount),
    pendingShipmentCount: orders.filter((order) => (
      order.lifecycleStatus === 'active' &&
      order.platformTransactionStatus === 'paid' &&
      order.fulfillmentStatus === 'pending_shipment'
    )).length,
    platforms: [...new Set(orders.map((order) => order.platform))],
    sellerAccounts: [...new Set(orders.map((order) => order.sellerAccount))],
    ...overrides,
  };
}

function singleShipmentGroupProjection(
  order: OriginalOrder = confirmedOrder,
): ShipmentGroupProjection {
  return {
    groups: [{
      id: 'shipment-group-single000000000000',
      formation: 'automatic',
      selectedRecipientOrderId: null,
      recipient: order.recipient,
      phone: order.phone,
      phoneNormalized: order.phoneNormalized,
      addressOriginal: order.addressOriginal,
      addressNormalized: order.addressNormalized,
      recipients: [order.recipient],
      recipientConflict: false,
      orderCount: 1,
      totalQuantity: order.items.reduce((total, item) => total + item.quantity, 0),
      totalAmountCents: order.amountCents,
      orders: [{
        id: order.id,
        orderNumber: order.orderNumber,
        sellerAccount: order.sellerAccount,
        buyerNickname: order.buyerNickname,
        recipient: order.recipient,
        phone: order.phone,
        phoneNormalized: order.phoneNormalized,
        addressOriginal: order.addressOriginal,
        addressNormalized: order.addressNormalized,
        amountCents: order.amountCents,
        items: order.items.map((item) => ({
          id: item.id,
          sourceTitle: item.sourceTitle,
          sourceSpec: item.sourceSpec,
          unitPriceCents: item.unitPriceCents,
          quantity: item.quantity,
          subtotalCents: item.subtotalCents,
        })),
      }],
      items: order.items.map((item) => ({
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        quantity: item.quantity,
        subtotalCents: item.subtotalCents,
        unitPricesCents: [item.unitPriceCents],
        orderIds: [order.id],
      })),
    }],
    attentionOrders: [],
  };
}

function shipmentRecordForGroup(
  group: ShipmentGroupProjection['groups'][number],
): ShipmentRecord {
  const createdAt = '2026-08-12T10:00:00.000Z';
  const items = group.orders.flatMap((order) => order.items.map((item) => ({
    id: `shipment-package-item-${item.id}`,
    orderId: order.id,
    orderItemId: item.id,
    orderNumber: order.orderNumber,
    sellerAccount: order.sellerAccount,
    buyerNickname: order.buyerNickname,
    sourceTitle: item.sourceTitle,
    sourceSpec: item.sourceSpec,
    unitPriceCents: item.unitPriceCents,
    sourceItemQuantity: item.quantity,
    quantity: item.quantity,
    subtotalCents: item.subtotalCents,
  })));
  return {
    id: 'shipment-record-ui-1',
    sourceRecordRole: 'initial',
    archiveId: 'shipment-group-archive-ui-1',
    sourceGroupId: group.id,
    status: 'active',
    recipient: group.recipient,
    phone: group.phone,
    phoneNormalized: group.phoneNormalized,
    addressOriginal: group.addressOriginal,
    addressNormalized: group.addressNormalized,
    totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
    packages: [{
      id: 'shipment-package-ui-1',
      position: 0,
      status: 'active',
      logisticsStatus: 'in_transit',
      carrierAcceptedAt: null,
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF1000000020',
      revision: 1,
      totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
      items,
      cancellation: null,
      currentException: null,
      logisticsExceptions: [],
      carrierClaim: null,
      timeline: [],
      createdAt,
    }],
    sourceOrders: group.orders.map((order) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      sellerAccount: order.sellerAccount,
      buyerNickname: order.buyerNickname,
      recipient: order.recipient,
      phone: order.phone,
      addressOriginal: order.addressOriginal,
      amountCents: order.amountCents,
      revision: 1,
    })),
    sourceDifferences: [],
    voiding: null,
    createdAt,
  };
}

function shipmentArchiveForGroup(
  group: ShipmentGroupProjection['groups'][number],
  status: ShipmentGroupArchive['status'] = 'fully_shipped',
): ShipmentGroupArchive {
  const record = shipmentRecordForGroup(group);
  const remainingQuantity = status === 'partially_shipped' ? group.totalQuantity : 0;
  return {
    id: record.archiveId,
    sourceGroupId: group.id,
    status,
    recipient: group.recipient,
    phone: group.phone,
    phoneNormalized: group.phoneNormalized,
    addressOriginal: group.addressOriginal,
    addressNormalized: group.addressNormalized,
    orderIds: group.orders.map(({ id }) => id),
    orderNumbers: group.orders.map(({ orderNumber }) => orderNumber),
    memberOrders: group.orders.map((order) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      hasRemainingShipment: status === 'partially_shipped',
    })),
    recipientDifferences: [],
    shippedQuantity: record.totalQuantity,
    remainingQuantity,
    totalQuantity: record.totalQuantity + remainingQuantity,
    remainingGroup: status === 'partially_shipped' ? group : null,
    records: [record],
    createdAt: record.createdAt,
    fullyShippedAt: status === 'fully_shipped' ? record.createdAt : null,
  };
}

type DesktopApiTestOverrides = Partial<DesktopApi> & {
  selectSourceScreenshot?: () => Promise<OrderDraft | null>;
};

function createApi(overrides: DesktopApiTestOverrides = {}): DesktopApi {
  const {
    selectSourceScreenshot = vi.fn().mockResolvedValue(null),
    queryOrders = vi.fn().mockResolvedValue(workbenchResult([])),
    ...desktopApiOverrides
  } = overrides;
  const selectOneSourceScreenshot = selectSourceScreenshot
    ?? vi.fn().mockResolvedValue(null);
  let selectedDraft: OrderDraft | null = null;
  return {
    getBootstrapState: vi.fn().mockResolvedValue({ kind: 'needs_data_directory' }),
    retryDataDirectory: vi.fn().mockResolvedValue({ kind: 'needs_data_directory' }),
    selectDataDirectory: vi.fn().mockResolvedValue({
      kind: 'ready',
      dataDirectory: '/Users/test/闲鱼订单',
      orders: [],
    }),
    selectSourceScreenshots: vi.fn(async () => {
      selectedDraft = await selectOneSourceScreenshot();
      return selectedDraft ? batchForDraft(selectedDraft) : null;
    }),
    listRecognitionBatches: vi.fn().mockResolvedValue([]),
    retryRecognitionItem: vi.fn().mockResolvedValue(undefined),
    createManualDraft: vi.fn(),
    getDraft: vi.fn(async () => {
      if (!selectedDraft) throw new Error('未找到订单草稿');
      return selectedDraft;
    }),
    getDraftReview: vi.fn(async (draftId) => {
      const selected = desktopApiOverrides.getDraft
        ? await desktopApiOverrides.getDraft(draftId)
        : selectedDraft;
      if (!selected) throw new Error('未找到订单草稿');
      return { kind: 'new_order' as const, draft: selected };
    }),
    onRecognitionBatchesChanged: vi.fn(() => () => undefined),
    cancelDraft: vi.fn().mockResolvedValue(undefined),
    confirmDraft: vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    }),
    confirmOrderUpdate: vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'order_updated',
    }),
    listOrders: vi.fn().mockResolvedValue([]),
    queryOrders,
    queryOrderItems: vi.fn().mockResolvedValue({ items: [], customFieldValues: [] }),
    queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
    splitShipmentGroup: vi.fn(),
    mergeShipmentGroups: vi.fn(),
    queryShipmentGroupArchives: vi.fn().mockResolvedValue([]),
    confirmShipment: vi.fn(),
    cancelShipmentPackages: vi.fn(),
    correctShipmentPackageLogistics: vi.fn(),
    updateShipmentPackageLogisticsStatus: vi.fn(),
    recordShipmentPackageLogisticsException: vi.fn(),
    progressShipmentPackageLogisticsException: vi.fn(),
    progressShipmentPackageCarrierClaim: vi.fn(),
    queryAftersalesCases: vi.fn().mockResolvedValue([]),
    listAftersalesWorkflowTemplates: vi.fn().mockResolvedValue(testWorkflowTemplates),
    setAftersalesWorkflowTemplateEnabled: vi.fn(),
    createAftersalesWorkflowTemplate: vi.fn(),
    copyAftersalesWorkflowTemplate: vi.fn(),
    updateAftersalesWorkflowTemplate: vi.fn(),
    createAftersalesCase: vi.fn(),
    changeAftersalesCaseWorkflowTemplate: vi.fn(),
    updateAftersalesCase: vi.fn(),
    progressAftersalesCase: vi.fn(),
    exportOrders: vi.fn().mockResolvedValue({ kind: 'cancelled' }),
    previewOrderExport: vi.fn().mockResolvedValue({
      orderCount: 0,
      orderItemCount: null,
      sheets: [],
    }),
    onOrdersChanged: vi.fn(() => () => undefined),
    getOrder: vi.fn(),
    updateOrder: vi.fn(),
    updateOrderPlatformTransactionStatus: vi.fn().mockResolvedValue([]),
    listCustomFieldDefinitions: vi.fn().mockResolvedValue([]),
    createCustomFieldDefinition: vi.fn(),
    saveCustomFieldValues: vi.fn().mockResolvedValue([]),
    listTableTemplates: vi.fn().mockResolvedValue([]),
    createTableTemplate: vi.fn(),
    updateTableTemplate: vi.fn(),
    deleteTableTemplate: vi.fn().mockResolvedValue(undefined),
    getScreenshotDataUrl: vi.fn(),
    getOrderIntakeSettings: vi.fn().mockResolvedValue({
      automaticImportEnabled: false,
    }),
    saveOrderIntakeSettings: vi.fn(async (input) => input),
    getOcrSettings: vi.fn().mockResolvedValue({
      workspaceId: '',
      region: 'cn-beijing',
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr',
      apiKeyConfigured: false,
      apiKeyMask: '',
      credentialStore: '测试系统凭据库',
    }),
    saveOcrSettings: vi.fn(),
    removeOcrApiKey: vi.fn(),
    testOcrConnection: vi.fn(),
    getCandidateVerificationSettings: vi.fn().mockResolvedValue({
      enabled: false,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      baseUrlLocked: true,
      model: 'deepseek-v4-flash',
      apiKeyConfigured: false,
      apiKeyMask: '',
      credentialStore: '测试系统凭据库',
    }),
    saveCandidateVerificationSettings: vi.fn(),
    removeCandidateVerificationApiKey: vi.fn(),
    testCandidateVerificationConnection: vi.fn(),
    getCandidateAdjudicationAudit: vi.fn().mockResolvedValue([]),
    ...desktopApiOverrides,
  };
}

function testAftersalesCoordination(
  handlingDirection: AftersalesCase['coordination']['handlingDirection'] = null,
  overrides: Partial<AftersalesCase['coordination']> = {},
): AftersalesCase['coordination'] {
  const coordination: Omit<AftersalesCase['coordination'], 'returnExceptionHistory'> = {
    handlingDirection,
    physicalControl: 'carrier',
    currentTodo: '继续跟进售后',
    risk: null,
    availableDirections: ['waiting', 'intercept', 'refuse', 'only_refund', 'replacement'],
    handlingDirectionTimeline: [],
    sourcePackages: [],
    interception: null,
    outboundException: null,
    outboundExceptionHistory: [],
    interceptedReturnInspection: null,
    returnException: null,
    ...overrides,
  };
  return {
    ...coordination,
    returnExceptionHistory: overrides.returnExceptionHistory
      ?? (coordination.returnException ? [coordination.returnException] : []),
  };
}

function batchForDraft(value: OrderDraft): RecognitionBatchView {
  const status: RecognitionBatchItemStatus = value.status === 'confirmed'
    ? 'imported'
    : value.status === 'cancelled'
      ? 'cancelled'
      : 'awaiting_confirmation';
  return recognitionBatchView(value.batchId, [{
    id: `batch-item-${value.id}`,
    batchId: value.batchId,
    sourceName: '脱敏测试订单.png',
    status,
    draftId: value.id,
  }]);
}

function recognitionBatchView(
  id: string,
  items: RecognitionBatchView['items'],
): RecognitionBatchView {
  return {
    id,
    createdAt: '2026-07-30T06:32:00.000Z',
    ...summarizeRecognitionBatchItems(items),
    items,
  };
}

describe('订单管理工作台', () => {
  it('首次使用选择数据目录后，立即进入以上传为主操作的空订单页', async () => {
    const user = userEvent.setup();
    const api = createApi();

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: '选择订单数据保存位置' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '选择数据目录' }));

    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    expect(screen.getByRole('button', { name: '上传订单截图' })).toBeVisible();
    expect(screen.getByText(
      '截图会发送至您配置的阿里云百炼，原图仍保存在本机。每张截图调用 1 次 advanced_recognition，并由本机规则按六区拆分字段；有有限候选且已启用候选裁决时，最多追加 1 次文本模型调用。无法确定时会转入人工确认。',
    )).toBeVisible();
    expect(screen.getByText('/Users/test/闲鱼订单')).toBeVisible();
  });

  it('从侧栏查看开放发货组汇总和未自动成组提示', async () => {
    const user = userEvent.setup();
    const projection: ShipmentGroupProjection = {
      groups: [{
        id: 'shipment-group-abc123abc123abc123abc123',
        formation: 'automatic',
        selectedRecipientOrderId: null,
        recipient: '人工修正收件人',
        phone: '13800000000',
        phoneNormalized: '13800000000',
        addressOriginal: '广东省深圳市南山区测试路1号',
        addressNormalized: '广东省深圳市南山区测试路1号',
        recipients: ['人工修正收件人'],
        recipientConflict: false,
        orderCount: 2,
        totalQuantity: 3,
        totalAmountCents: 2_400,
        orders: [
          {
            id: 'order-1',
            orderNumber: 'XY-SHIPMENT-UI-0001',
            sellerAccount: '测试闲鱼账号',
            buyerNickname: '测试买家',
            recipient: '人工修正收件人',
            phone: '13800000000',
            phoneNormalized: '13800000000',
            addressOriginal: '广东省深圳市南山区测试路1号',
            addressNormalized: '广东省深圳市南山区测试路1号',
            amountCents: 800,
            items: [{
              id: 'item-1',
              sourceTitle: '脱敏测试商品',
              sourceSpec: '白色',
              unitPriceCents: 800,
              quantity: 1,
              subtotalCents: 800,
            }],
          },
          {
            id: 'order-2',
            orderNumber: 'XY-SHIPMENT-UI-0002',
            sellerAccount: '测试闲鱼账号',
            buyerNickname: '测试买家',
            recipient: '人工修正收件人',
            phone: '13800000000',
            phoneNormalized: '13800000000',
            addressOriginal: '广东省深圳市南山区测试路1号',
            addressNormalized: '广东省深圳市南山区测试路1号',
            amountCents: 1_600,
            items: [{
              id: 'item-2',
              sourceTitle: '脱敏测试商品',
              sourceSpec: '白色',
              unitPriceCents: 800,
              quantity: 2,
              subtotalCents: 1_600,
            }],
          },
        ],
        items: [{
          sourceTitle: '脱敏测试商品',
          sourceSpec: '白色',
          quantity: 3,
          subtotalCents: 2_400,
          unitPricesCents: [800],
          orderIds: ['order-1', 'order-2'],
        }],
      }],
      attentionOrders: [{
        id: 'order-attention',
        orderNumber: 'XY-SHIPMENT-UI-ATTENTION',
        recipient: '待补全收件人',
        phone: '',
        addressOriginal: '广东省深圳市福田区测试路2号',
        reasons: ['missing_phone'],
      }],
    };
    const queryShipmentGroups = vi.fn().mockResolvedValue(projection);
    const splitShipmentGroup = vi.fn().mockResolvedValue({
      event: {
        id: 'adjustment-split-1',
        operation: 'split',
        reason: '单独包装',
        sourceGroupIds: [projection.groups[0].id],
        sourceOrderIds: ['order-1', 'order-2'],
        targetGroupId: 'manual-group-split-1',
        targetOrderIds: ['order-1'],
        selectedRecipientOrderId: null,
        createdAt: '2026-08-11T10:00:00.000Z',
      },
      projection,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups,
      splitShipmentGroup,
    });

    render(<App api={api} />);
    const navigation = await screen.findByRole('button', { name: '发货组' });
    await user.click(navigation);

    expect(await screen.findByRole('heading', { level: 1, name: '发货组' })).toBeVisible();
    expect(navigation).toHaveAttribute('aria-current', 'page');
    expect(queryShipmentGroups).toHaveBeenCalledTimes(1);
    const overview = screen.getByRole('region', { name: '发货组概况' });
    expect(overview).toHaveTextContent('待发货组1');
    expect(overview).toHaveTextContent('部分发货0');
    expect(overview).toHaveTextContent('已全部发货0');
    expect(overview).toHaveTextContent('未自动成组1');
    const groupTable = screen.getByRole('table', { name: '开放发货组' });
    expect(groupTable).toHaveTextContent('人工修正收件人');
    expect(groupTable).toHaveTextContent('13800000000');
    expect(groupTable).toHaveTextContent('广东省深圳市南山区测试路1号');
    expect(groupTable).toHaveTextContent('XY-SHIPMENT-UI-0001');
    expect(groupTable).toHaveTextContent('XY-SHIPMENT-UI-0002');
    expect(groupTable).toHaveTextContent('脱敏测试商品');
    expect(groupTable).toHaveTextContent('白色 × 3');
    expect(groupTable).toHaveTextContent('¥24.00');
    const attentionTable = screen.getByRole('table', { name: '未自动成组订单' });
    expect(attentionTable).toHaveTextContent('XY-SHIPMENT-UI-ATTENTION');
    expect(attentionTable).toHaveTextContent('缺少手机号');
    expect(screen.getByRole('button', { name: '重新组合' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '拆分发货组 XY-SHIPMENT-UI-0001、XY-SHIPMENT-UI-0002' }));
    const dialog = screen.getByRole('dialog', { name: '拆分发货组' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'XY-SHIPMENT-UI-0001' }));
    await user.type(within(dialog).getByRole('textbox', { name: '调整原因' }), '单独包装');
    await user.click(within(dialog).getByRole('button', { name: '确认拆分' }));
    expect(splitShipmentGroup).toHaveBeenCalledWith({
      groupId: projection.groups[0].id,
      expectedMemberOrderIds: ['order-1', 'order-2'],
      splitOrderIds: ['order-1'],
      reason: '单独包装',
    });
    expect(screen.queryByRole('button', { name: /标记已发货|导出发货组/u }))
      .not.toBeInTheDocument();
  });

  it('按待发货、部分发货和已全部发货组织发货组档案及其发货记录', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const completedArchive = shipmentArchiveForGroup(group);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([completedArchive]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));

    expect(await screen.findByRole('tab', { name: '已全部发货 1' }))
      .toHaveAttribute('aria-selected', 'true');
    const archive = screen.getByRole('article', {
      name: `发货组档案 ${completedArchive.orderNumbers.join('、')}`,
    });
    expect(archive).toHaveTextContent('已发 2 / 共 2 件');
    expect(archive).toHaveTextContent(confirmedOrder.orderNumber);
    await user.click(within(archive).getByRole('button', { name: '查看 1 条发货记录' }));
    expect(archive).toHaveTextContent('SF1000000020');
    expect(archive).toHaveTextContent('脱敏测试商品');
  });

  it('有剩余商品的发货组进入部分发货并可继续实际发出', async () => {
    const user = userEvent.setup();
    const projection = singleShipmentGroupProjection();
    const group = projection.groups[0];
    const partialArchive = shipmentArchiveForGroup(group, 'partially_shipped');
    partialArchive.shippedQuantity = 1;
    partialArchive.remainingQuantity = group.totalQuantity;
    partialArchive.totalQuantity = partialArchive.shippedQuantity + group.totalQuantity;
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([partialArchive]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));

    expect(await screen.findByRole('tab', { name: '部分发货 1' }))
      .toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '待发货 0' })).toBeVisible();
    const archive = screen.getByRole('article', {
      name: `发货组档案 ${confirmedOrder.orderNumber}`,
    });
    expect(archive).toHaveTextContent('已发 1 / 共 3 件');
    expect(archive).toHaveTextContent('剩余 2 件待发');
    expect(within(archive).getByRole('button', { name: '继续发货' })).toBeVisible();
  });

  it('档案成员修改收货信息并分散到多个当前组后仍在同一档案继续发货', async () => {
    const user = userEvent.setup();
    const firstProjection = singleShipmentGroupProjection();
    const changedOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-recipient-changed-after-partial-shipment',
      orderNumber: 'XY-SHIPMENT-UI-RECIPIENT-CHANGED',
      addressOriginal: '浙江省杭州市西湖区新地址2号',
      addressNormalized: '浙江省杭州市西湖区新地址2号',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      items: confirmedOrder.items.map((item) => ({
        ...item,
        id: 'item-recipient-changed-after-partial-shipment',
      })),
    };
    const changedProjection = singleShipmentGroupProjection(changedOrder);
    const archive = shipmentArchiveForGroup(firstProjection.groups[0], 'partially_shipped');
    const remainingGroup = structuredClone(firstProjection.groups[0]);
    remainingGroup.id = `shipment-archive-${archive.id}`;
    remainingGroup.orders.push(changedProjection.groups[0].orders[0]);
    remainingGroup.orderCount = 2;
    remainingGroup.totalQuantity += changedProjection.groups[0].totalQuantity;
    remainingGroup.totalAmountCents += changedProjection.groups[0].totalAmountCents;
    remainingGroup.items[0].quantity += changedProjection.groups[0].items[0].quantity;
    remainingGroup.items[0].subtotalCents += changedProjection.groups[0].items[0].subtotalCents;
    remainingGroup.items[0].orderIds.push(changedOrder.id);
    archive.orderIds.push(changedOrder.id);
    archive.orderNumbers.push(changedOrder.orderNumber);
    archive.memberOrders.push({
      orderId: changedOrder.id,
      orderNumber: changedOrder.orderNumber,
      hasRemainingShipment: true,
    });
    archive.recipientDifferences = [{
      orderId: changedOrder.id,
      orderNumber: changedOrder.orderNumber,
      fields: ['address'],
    }];
    archive.remainingGroup = remainingGroup;
    archive.remainingQuantity = remainingGroup.totalQuantity;
    archive.totalQuantity = archive.shippedQuantity + archive.remainingQuantity;
    const confirmShipment = vi.fn().mockResolvedValue({
      record: archive.records[0],
      archive: { ...archive, status: 'fully_shipped', remainingGroup: null },
      projection: { groups: [], attentionOrders: [] },
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      confirmShipment,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));

    expect(await screen.findByRole('tab', { name: '部分发货 1' }))
      .toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '待发货 0' })).toBeVisible();
    expect(screen.getByText('成员订单的当前收货信息已有变化')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '继续发货' }));
    const dialog = screen.getByRole('dialog', { name: '确认实际发出' });
    expect(dialog).toHaveTextContent(confirmedOrder.orderNumber);
    expect(dialog).toHaveTextContent(changedOrder.orderNumber);
    expect(dialog).toHaveTextContent('本次继续使用档案中保存的收货信息');
    expect(dialog).toHaveTextContent('完整地址已变化');
    await user.click(within(dialog).getByRole('button', { name: '确认实际发出' }));
    expect(confirmShipment).toHaveBeenCalledWith(expect.objectContaining({
      groupId: remainingGroup.id,
      archiveId: archive.id,
    }));
  });

  it('相同收货信息的新订单与既有部分发货档案分开展示', async () => {
    const user = userEvent.setup();
    const originalProjection = singleShipmentGroupProjection();
    const originalOrder = confirmedOrder;
    const laterOrder = {
      ...structuredClone(originalOrder),
      id: 'order-later-same-recipient',
      orderNumber: 'XY-SHIPMENT-UI-LATER',
      items: originalOrder.items.map((item) => ({
        ...item,
        id: 'item-later-same-recipient',
        quantity: 1,
        subtotalCents: item.unitPriceCents,
      })),
    };
    const projection = singleShipmentGroupProjection(laterOrder);
    const partialArchive = shipmentArchiveForGroup(
      originalProjection.groups[0],
      'partially_shipped',
    );
    partialArchive.shippedQuantity = 1;
    partialArchive.remainingQuantity = 1;
    partialArchive.totalQuantity = 2;
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue(projection),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([partialArchive]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));

    expect(await screen.findByRole('tab', { name: '待发货 1' }))
      .toHaveAttribute('aria-selected', 'true');
    const pendingTable = screen.getByRole('table', { name: '开放发货组' });
    expect(pendingTable).toHaveTextContent('XY-SHIPMENT-UI-LATER');
    expect(pendingTable).not.toHaveTextContent(confirmedOrder.orderNumber);

    await user.click(screen.getByRole('tab', { name: '部分发货 1' }));
    const archive = screen.getByRole('article', {
      name: `发货组档案 ${confirmedOrder.orderNumber}`,
    });
    expect(archive).toHaveTextContent(confirmedOrder.orderNumber);
    expect(archive).not.toHaveTextContent('XY-SHIPMENT-UI-LATER');
  });

  it('从开放发货组确认实际发出并立即显示发货记录', async () => {
    const user = userEvent.setup();
    const projection = singleShipmentGroupProjection();
    const record = shipmentRecordForGroup(projection.groups[0]);
    const archive = shipmentArchiveForGroup(projection.groups[0]);
    const confirmShipment = vi.fn().mockResolvedValue({
      record,
      archive,
      projection: { groups: [], attentionOrders: [] },
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue(projection),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([]),
      confirmShipment,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    await user.click(await screen.findByRole('button', {
      name: `确认实际发出 ${confirmedOrder.orderNumber}`,
    }));
    const dialog = screen.getByRole('dialog', { name: '确认实际发出' });
    await user.type(within(dialog).getByRole('textbox', { name: '包裹 1 承运方' }), '顺丰速运');
    await user.type(within(dialog).getByRole('textbox', { name: '包裹 1 运单号' }), 'SF1000000020');
    expect(within(dialog).getByRole('spinbutton', {
      name: `包裹 1 ${confirmedOrder.orderNumber} 脱敏测试商品 发出数量`,
    })).toHaveValue(2);
    await user.click(within(dialog).getByRole('button', { name: '确认实际发出' }));

    expect(confirmShipment).toHaveBeenCalledWith({
      groupId: projection.groups[0].id,
      archiveId: null,
      expectedRemainingItems: [{
        orderId: confirmedOrder.id,
        orderItemId: confirmedOrder.items[0].id,
        quantity: 2,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000020',
        items: [{
          orderId: confirmedOrder.id,
          orderItemId: confirmedOrder.items[0].id,
          quantity: 2,
        }],
      }],
    });
    const history = await screen.findByRole('region', { name: '发货记录' });
    expect(history).toHaveTextContent('顺丰速运');
    expect(history).toHaveTextContent('SF1000000020');
    expect(history).toHaveTextContent('脱敏测试商品');
  });

  it('同一商品可按准确数量拆入本次发货的多个包裹', async () => {
    const user = userEvent.setup();
    const projection = singleShipmentGroupProjection();
    const record = shipmentRecordForGroup(projection.groups[0]);
    const archive = shipmentArchiveForGroup(projection.groups[0]);
    const confirmShipment = vi.fn().mockResolvedValue({
      record,
      archive,
      projection: { groups: [], attentionOrders: [] },
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue(projection),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([]),
      confirmShipment,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    await user.click(await screen.findByRole('button', {
      name: `确认实际发出 ${confirmedOrder.orderNumber}`,
    }));
    const dialog = screen.getByRole('dialog', { name: '确认实际发出' });
    await user.click(within(dialog).getByRole('button', { name: '新增包裹' }));
    const firstQuantity = within(dialog).getByRole('spinbutton', {
      name: `包裹 1 ${confirmedOrder.orderNumber} 脱敏测试商品 发出数量`,
    });
    await user.clear(firstQuantity);
    await user.type(firstQuantity, '1');
    const secondQuantity = within(dialog).getByRole('spinbutton', {
      name: `包裹 2 ${confirmedOrder.orderNumber} 脱敏测试商品 发出数量`,
    });
    await user.clear(secondQuantity);
    await user.type(secondQuantity, '1');
    await user.type(
      within(dialog).getByRole('textbox', { name: '包裹 1 运单号' }),
      'SF-PACKAGE-1',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: '包裹 2 运单号' }),
      'SF-PACKAGE-2',
    );
    await user.click(within(dialog).getByRole('button', { name: '确认实际发出' }));

    expect(confirmShipment).toHaveBeenCalledWith(expect.objectContaining({
      packages: [
        expect.objectContaining({
          trackingNumber: 'SF-PACKAGE-1',
          items: [expect.objectContaining({ quantity: 1 })],
        }),
        expect.objectContaining({
          trackingNumber: 'SF-PACKAGE-2',
          items: [expect.objectContaining({ quantity: 1 })],
        }),
      ],
    }));
  });

  it('撤销尚未实际交寄的包裹并把对应数量退回开放发货组', async () => {
    const user = userEvent.setup();
    const projection = singleShipmentGroupProjection();
    const record = shipmentRecordForGroup(projection.groups[0]);
    const cancelledRecord: ShipmentRecord = {
      ...record,
      status: 'voided',
      packages: record.packages.map((shipmentPackage) => ({
        ...shipmentPackage,
        status: 'cancelled',
        cancellation: {
          reason: '误操作，包裹尚未交给快递员',
          createdAt: '2026-08-12T10:05:00.000Z',
        },
      })),
      voiding: {
        reason: '误操作，包裹尚未交给快递员',
        createdAt: '2026-08-12T10:05:00.000Z',
      },
    };
    const cancelShipmentPackages = vi.fn().mockResolvedValue({
      record: cancelledRecord,
      archive: {
        ...shipmentArchiveForGroup(projection.groups[0], 'partially_shipped'),
        shippedQuantity: 0,
        remainingQuantity: projection.groups[0].totalQuantity,
        totalQuantity: projection.groups[0].totalQuantity,
        records: [cancelledRecord],
      },
      projection,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([
        shipmentArchiveForGroup(projection.groups[0]),
      ]),
      cancelShipmentPackages,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const archiveCard = await screen.findByRole('article', {
      name: `发货组档案 ${confirmedOrder.orderNumber}`,
    });
    const recordSummary = within(archiveCard).getByRole('button', {
      name: /1 条发货记录/,
    });
    expect(recordSummary).toHaveTextContent('物流：运输中');
    expect(recordSummary).toHaveTextContent('当前待办：跟进运输进度');
    const history = await screen.findByRole('region', { name: '发货记录' });
    await user.click(within(history).getByRole('button', {
      name: '撤销未交寄包裹 包裹 1 SF1000000020',
    }));
    const dialog = screen.getByRole('dialog', { name: '撤销未交寄包裹' });
    await user.type(
      within(dialog).getByRole('textbox', { name: '撤销原因' }),
      '误操作，包裹尚未交给快递员',
    );
    const confirmCancellation = within(dialog).getByRole('button', { name: '确认撤销' });
    expect(confirmCancellation).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', {
      name: '我确认包裹尚未实际交寄',
    }));
    await user.click(confirmCancellation);

    expect(cancelShipmentPackages).toHaveBeenCalledWith({
      recordId: record.id,
      packageIds: [record.packages[0].id],
      reason: '误操作，包裹尚未交给快递员',
    });
    expect(await screen.findByRole('tab', { name: '部分发货 1' }))
      .toHaveAttribute('aria-selected', 'true');
    const reopenedArchive = screen.getByRole('article', {
      name: `发货组档案 ${confirmedOrder.orderNumber}`,
    });
    expect(reopenedArchive).toHaveTextContent('剩余 2 件待发');
    expect(within(reopenedArchive).getByRole('button', { name: '继续发货' })).toBeVisible();
    expect(within(reopenedArchive).getByRole('region', { name: '发货记录' }))
      .toHaveTextContent('已作废');
  });

  it('更正包裹物流时保留原因并按包裹版本提交', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const record = shipmentRecordForGroup(group);
    const correctedRecord: ShipmentRecord = {
      ...record,
      packages: record.packages.map((shipmentPackage) => ({
        ...shipmentPackage,
        revision: 2,
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT2000000030',
        timeline: [{
          kind: 'logistics_corrected',
          baseRevision: 1,
          resultRevision: 2,
          reason: '原单号录入错误',
          before: {
            shippingCarrier: shipmentPackage.shippingCarrier,
            trackingNumber: shipmentPackage.trackingNumber,
          },
          after: {
            shippingCarrier: '中通快递',
            trackingNumber: 'ZT2000000030',
          },
          occurredAt: '2026-08-12T10:08:00.000Z',
          createdAt: '2026-08-12T10:08:00.000Z',
        }],
      })),
    };
    const correctShipmentPackageLogistics = vi.fn().mockResolvedValue({
      record: correctedRecord,
      archive: {
        ...shipmentArchiveForGroup(group),
        records: [correctedRecord],
      },
      projection: { groups: [], attentionOrders: [] },
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([
        shipmentArchiveForGroup(group),
      ]),
      correctShipmentPackageLogistics,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    await user.click(within(history).getByRole('button', {
      name: '更正物流 包裹 1 SF1000000020',
    }));
    const dialog = screen.getByRole('dialog', { name: '更正包裹物流' });
    const carrier = within(dialog).getByRole('textbox', { name: '承运方' });
    const trackingNumber = within(dialog).getByRole('textbox', { name: '运单号' });
    await user.clear(carrier);
    await user.type(carrier, '中通快递');
    await user.clear(trackingNumber);
    await user.type(trackingNumber, 'ZT2000000030');
    await user.type(
      within(dialog).getByRole('textbox', { name: '更正原因' }),
      '原单号录入错误',
    );
    await user.click(within(dialog).getByRole('button', { name: '确认更正' }));

    expect(correctShipmentPackageLogistics).toHaveBeenCalledWith({
      recordId: record.id,
      packageId: record.packages[0].id,
      expectedRevision: 1,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT2000000030',
      occurredAt: expect.any(String),
      reason: '原单号录入错误',
    });
    expect(history).toHaveTextContent('中通快递 · ZT2000000030');
  });

  it('在发货记录中更新物流状态并展示独立时间线和当前待办', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const record = shipmentRecordForGroup(group);
    const deliveredRecord: ShipmentRecord = {
      ...record,
      packages: record.packages.map((shipmentPackage) => ({
        ...shipmentPackage,
        revision: 2,
        logisticsStatus: 'delivered',
        timeline: [{
          kind: 'status_changed',
          baseRevision: 1,
          resultRevision: 2,
          beforeStatus: 'in_transit',
          afterStatus: 'delivered',
          carrierAcceptedAt: null,
          impact: { scope: 'package' },
          reason: '买家确认已经收到包裹',
          occurredAt: '2026-08-12T10:12:00.000Z',
          createdAt: '2026-08-12T10:12:00.000Z',
        }],
      })),
    };
    const updateShipmentPackageLogisticsStatus = vi.fn().mockResolvedValue({
      record: deliveredRecord,
      archive: {
        ...shipmentArchiveForGroup(group),
        records: [deliveredRecord],
      },
      projection: { groups: [], attentionOrders: [] },
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([
        shipmentArchiveForGroup(group),
      ]),
      updateShipmentPackageLogisticsStatus,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    expect(history).toHaveTextContent('物流：运输中');
    expect(history).toHaveTextContent('售后：无售后');
    expect(history).toHaveTextContent('当前待办：跟进运输进度');
    await user.click(within(history).getByRole('button', {
      name: '更新物流状态 包裹 1 运输中',
    }));
    const dialog = screen.getByRole('dialog', { name: '更新包裹物流状态' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '物流状态' }), 'delivered');
    await user.type(
      within(dialog).getByRole('textbox', { name: '状态更新原因' }),
      '买家确认已经收到包裹',
    );
    await user.click(within(dialog).getByRole('button', { name: '确认更新' }));

    expect(updateShipmentPackageLogisticsStatus).toHaveBeenCalledWith({
      recordId: record.id,
      packageId: record.packages[0].id,
      expectedRevision: 1,
      logisticsStatus: 'delivered',
      occurredAt: expect.any(String),
      reason: '买家确认已经收到包裹',
    });
    expect(history).toHaveTextContent('物流：已签收');
    expect(history).toHaveTextContent('当前待办：无需物流操作');
    expect(history).toHaveTextContent('运输中 → 已签收');
    expect(history).toHaveTextContent('买家确认已经收到包裹');
    expect(within(history).queryByRole('button', {
      name: '更新物流状态 包裹 1 已签收',
    })).not.toBeInTheDocument();
    await user.click(within(history).getByRole('button', { name: '登记物流异常' }));
    const exceptionDialog = screen.getByRole('dialog', { name: '登记正向物流异常' });
    expect(within(exceptionDialog).getByRole('option', { name: '签收争议' })).toBeInTheDocument();
    expect(within(exceptionDialog).getByRole('option', { name: '错投' })).toBeInTheDocument();
    expect(within(exceptionDialog).getByRole('option', { name: '运输破损' })).toBeInTheDocument();
    expect(within(exceptionDialog).queryByRole('option', { name: '丢件' })).not.toBeInTheDocument();
    await user.click(within(exceptionDialog).getByRole('button', { name: '取消' }));
    expect(within(history).getByRole('button', {
      name: '更正物流 包裹 1 SF1000000020',
    })).toBeInTheDocument();
    expect(history).toHaveTextContent('物流状态已终结；签收争议、错投或承运破损可单独登记');
  });

  it('桌面同时展示正向正常运输事实与独立物流异常事项', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourcePackage = record.packages[0];
    const unaffectedItem = {
      ...sourcePackage.items[0],
      id: 'shipment-item-ui-unaffected',
      sourceTitle: '不受影响商品',
      sourceSpec: '蓝色',
      quantity: 1,
    };
    const exception = {
      id: 'shipment-exception-ui-damaged',
      direction: 'outbound' as const,
      packageId: sourcePackage.id,
      exceptionType: 'damaged' as const,
      stage: 'pending_verification' as const,
      revision: 1,
      impact: {
        scope: 'items' as const,
        items: [{ sourceItemId: sourcePackage.items[0].id, quantity: 1 }],
      },
      reason: '外包装破损，仅影响一件商品',
      occurredAt: '2026-08-14T09:00:00+08:00',
      timeline: [{
        kind: 'opened' as const,
        resultRevision: 1 as const,
        stage: 'pending_verification' as const,
        impact: {
          scope: 'items' as const,
          items: [{ sourceItemId: sourcePackage.items[0].id, quantity: 1 }],
        },
        reason: '外包装破损，仅影响一件商品',
        occurredAt: '2026-08-14T09:00:00+08:00',
        createdAt: '2026-08-14T09:00:00+08:00',
      }],
      createdAt: '2026-08-14T09:00:00+08:00',
      updatedAt: '2026-08-14T09:00:00+08:00',
    };
    record.packages[0] = {
      ...sourcePackage,
      totalQuantity: sourcePackage.totalQuantity + 1,
      items: [...sourcePackage.items, unaffectedItem],
      logisticsStatus: 'in_transit',
      currentException: exception,
      logisticsExceptions: [exception],
    };
    const progressedException = {
      ...exception,
      stage: 'investigating' as const,
      revision: 2,
      reason: '已联系承运方调查破损原因',
      updatedAt: '2026-08-14T09:10:00+08:00',
    };
    const progressedRecord: ShipmentRecord = {
      ...record,
      packages: [{
        ...record.packages[0],
        currentException: progressedException,
        logisticsExceptions: [progressedException],
      }],
    };
    const progressShipmentPackageLogisticsException = vi.fn().mockResolvedValue({
      record: progressedRecord,
      archive: { ...archive, records: [progressedRecord] },
      projection: { groups: [], attentionOrders: [] },
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      progressShipmentPackageLogisticsException,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });

    expect(history).toHaveTextContent('物流：运输中');
    expect(history).toHaveTextContent('正向物流异常 · 运输破损 · 待核实');
    expect(history).toHaveTextContent('影响 1 件');
    expect(history).toHaveTextContent('外包装破损，仅影响一件商品');
    const affectedProducts = within(history).getByRole('list', {
      name: '正向物流异常受影响商品',
    });
    expect(affectedProducts).toHaveTextContent(sourcePackage.items[0].sourceTitle);
    expect(affectedProducts).not.toHaveTextContent('不受影响商品');
    expect(history).toHaveTextContent('当前待办：处理正向物流异常');
    expect(within(history).queryByRole('button', { name: '建立承运索赔' }))
      .not.toBeInTheDocument();

    await user.click(within(history).getByRole('button', {
      name: '更新物流状态 包裹 1 运输中',
    }));
    const dialog = screen.getByRole('dialog', { name: '更新包裹物流状态' });
    expect(within(dialog).getByRole('combobox', { name: '物流状态' }))
      .not.toHaveTextContent('运输破损');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    await user.click(within(history).getByRole('button', { name: '推进物流异常' }));
    const exceptionDialog = screen.getByRole('dialog', { name: '推进正向物流异常' });
    expect(within(exceptionDialog).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['调查中', '已确认', '已解决']);
    await user.type(
      within(exceptionDialog).getByRole('textbox', { name: '异常说明' }),
      '已联系承运方调查破损原因',
    );
    await user.click(within(exceptionDialog).getByRole('button', { name: '确认保存' }));

    await waitFor(() => expect(progressShipmentPackageLogisticsException).toHaveBeenCalledWith({
      recordId: record.id,
      packageId: sourcePackage.id,
      exceptionId: exception.id,
      expectedExceptionRevision: 1,
      stage: 'investigating',
      occurredAt: expect.any(String),
      reason: '已联系承运方调查破损原因',
    }));
    expect(history).toHaveTextContent('正向物流异常 · 运输破损 · 调查中');
    expect(within(history).queryByRole('button', { name: '建立承运索赔' }))
      .not.toBeInTheDocument();
  });

  it('在现有正向包裹卡登记独立物流异常且不改写正常运输状态', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourcePackage = record.packages[0];
    const openedException = {
      id: 'shipment-exception-ui-opened',
      direction: 'outbound' as const,
      packageId: sourcePackage.id,
      exceptionType: 'damaged' as const,
      stage: 'confirmed' as const,
      revision: 1,
      impact: { scope: 'package' as const },
      reason: '承运方确认外包装破损',
      occurredAt: '2026-08-14T10:00:00+08:00',
      timeline: [{
        kind: 'opened' as const,
        resultRevision: 1 as const,
        stage: 'confirmed' as const,
        impact: { scope: 'package' as const },
        reason: '承运方确认外包装破损',
        occurredAt: '2026-08-14T10:00:00+08:00',
        createdAt: '2026-08-14T10:00:00+08:00',
      }],
      createdAt: '2026-08-14T10:00:00+08:00',
      updatedAt: '2026-08-14T10:00:00+08:00',
    };
    const exceptionalRecord: ShipmentRecord = {
      ...record,
      packages: [{
        ...sourcePackage,
        logisticsStatus: 'in_transit',
        currentException: openedException,
        logisticsExceptions: [openedException],
      }],
    };
    const recordShipmentPackageLogisticsException = vi.fn().mockResolvedValue({
      record: exceptionalRecord,
      archive: { ...archive, records: [exceptionalRecord] },
      projection: { groups: [], attentionOrders: [] },
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      recordShipmentPackageLogisticsException,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    await user.click(within(history).getByRole('button', { name: '登记物流异常' }));
    const dialog = screen.getByRole('dialog', { name: '登记正向物流异常' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '异常类型' }), 'damaged');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '异常处理阶段' }), 'confirmed');
    await user.type(
      within(dialog).getByRole('textbox', { name: '异常说明' }),
      '承运方确认外包装破损',
    );
    await user.click(within(dialog).getByRole('button', { name: '确认保存' }));

    await waitFor(() => expect(recordShipmentPackageLogisticsException).toHaveBeenCalledWith({
      recordId: record.id,
      packageId: sourcePackage.id,
      expectedRevision: sourcePackage.revision,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: { scope: 'package' },
      occurredAt: expect.any(String),
      reason: '承运方确认外包装破损',
    }));
    expect(history).toHaveTextContent('物流：运输中');
    expect(history).toHaveTextContent('正向物流异常 · 运输破损 · 已确认');
    expect(within(history).getByRole('button', { name: '建立承运索赔' })).toBeEnabled();
  });

  it('按物流状态筛选发货组档案而不改变发货情况分组', async () => {
    const user = userEvent.setup();
    const firstGroup = singleShipmentGroupProjection().groups[0];
    const secondGroup = structuredClone(firstGroup);
    secondGroup.id = 'shipment-group-ui-filter-delivered';
    secondGroup.orders[0].id = 'order-ui-filter-delivered';
    secondGroup.orders[0].orderNumber = 'XY-SHIPMENT-UI-DELIVERED';
    secondGroup.orders[0].items[0].id = 'item-ui-filter-delivered';
    const inTransitArchive = shipmentArchiveForGroup(firstGroup);
    const deliveredArchive = shipmentArchiveForGroup(secondGroup);
    deliveredArchive.id = 'shipment-archive-ui-filter-delivered';
    deliveredArchive.records[0].archiveId = deliveredArchive.id;
    deliveredArchive.records[0].packages[0].logisticsStatus = 'delivered';
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([
        inTransitArchive,
        deliveredArchive,
      ]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    expect(await screen.findByRole('tab', { name: '已全部发货 2' }))
      .toHaveAttribute('aria-selected', 'true');
    await user.selectOptions(screen.getByRole('combobox', { name: '物流状态筛选' }), 'delivered');

    expect(screen.getByRole('article', {
      name: `发货组档案 ${secondGroup.orders[0].orderNumber}`,
    })).toBeVisible();
    expect(screen.queryByRole('article', {
      name: `发货组档案 ${firstGroup.orders[0].orderNumber}`,
    })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '已全部发货 2' }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it('在发货记录中按商品和数量展示真实售后概览与处理时间线', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourceItem = record.packages[0].items[0];
    const aftersalesCase: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-1',
      shipmentRecordId: record.id,
      workflow: 'general',
      status: 'waiting_return',
      revision: 3,
      reason: '买家需要退回破损商品',
      occurredAt: '2026-08-13T10:00:00+08:00',
      items: [{
        id: 'aftersales-item-ui-1',
        shipmentPackageItemId: sourceItem.id,
        packageId: record.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 2,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: null,
      returns: [],
      coordination: testAftersalesCoordination('waiting', {
        currentTodo: '等待买家退回',
      }),
      timeline: [{
        kind: 'created',
        resultRevision: 1,
        status: 'processing',
        reason: '买家反馈商品破损',
        occurredAt: '2026-08-13T10:00:00+08:00',
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        createdAt: '2026-08-13T02:00:00.000Z',
      }, {
        kind: 'updated',
        baseRevision: 1,
        resultRevision: 2,
        changeReason: '已与买家确认退回处理',
        before: {
          status: 'processing',
          reason: '买家反馈商品破损',
          items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        },
        after: {
          status: 'waiting_return',
          reason: '买家需要退回破损商品',
          items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        },
        createdAt: '2026-08-13T02:10:00.000Z',
      }, {
        kind: 'updated',
        baseRevision: 2,
        resultRevision: 3,
        changeReason: '确认同一商品还有一件受损',
        before: {
          status: 'waiting_return',
          reason: '买家需要退回破损商品',
          items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        },
        after: {
          status: 'waiting_return',
          reason: '买家需要退回破损商品',
          items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
        },
        createdAt: '2026-08-13T02:20:00.000Z',
      }],
      createdAt: '2026-08-13T02:00:00.000Z',
      updatedAt: '2026-08-13T02:10:00.000Z',
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([aftersalesCase]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });

    expect(history).toHaveTextContent('售后：等待退回 1');
    expect(history).toHaveTextContent('当前待办：等待买家退回');
    expect(history).toHaveTextContent(sourceItem.sourceTitle);
    expect(history).toHaveTextContent('× 2');
    expect(history).toHaveTextContent('买家需要退回破损商品');
    expect(history).toHaveTextContent('已与买家确认退回处理');
    expect(history).toHaveTextContent('售后内容已更新');
    expect(history).toHaveTextContent('问题原因：买家反馈商品破损 → 买家需要退回破损商品');
    expect(history).toHaveTextContent(
      `商品数量：${sourceItem.sourceTitle} · ${sourceItem.sourceSpec} 1 → 2`,
    );
  });

  it('展示售后轮次汇总并从当前轮建立独立补发记录', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourceItem = record.packages[0].items[0];
    const roundItem = {
      id: 'round-item-ui-replacement',
      sourceShipmentPackageItemId: sourceItem.id,
      packageId: record.packages[0].id,
      orderId: sourceItem.orderId,
      orderItemId: sourceItem.orderItemId,
      orderNumber: sourceItem.orderNumber,
      sourceTitle: sourceItem.sourceTitle,
      sourceSpec: sourceItem.sourceSpec,
      quantity: 1,
    };
    const aftersalesCase: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-replacement',
      shipmentRecordId: record.id,
      workflow: 'direct_replacement',
      status: 'waiting_replacement',
      revision: 1,
      reason: '缺少配件，直接补发',
      occurredAt: '2026-08-14T10:00:00+08:00',
      items: [{
        id: 'case-item-ui-replacement',
        shipmentPackageItemId: sourceItem.id,
        packageId: record.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: null,
      returns: [],
      rounds: [{
        id: 'round-ui-replacement',
        roundNumber: 1,
        workflow: 'direct_replacement',
        replacementRequired: true,
        sourceShipmentRecordId: record.id,
        items: [roundItem],
        returnRecordIds: [],
        replacementShipment: null,
        replacementOccurredAt: null,
        occurredAt: '2026-08-14T10:00:00+08:00',
        reason: '缺少配件，直接补发',
        createdAt: '2026-08-14T02:00:00.000Z',
      }],
      fulfillment: {
        cumulativeSentQuantity: 1,
        cumulativeReturnedQuantity: 0,
        buyerHeldQuantity: 1,
        currentRoundNumber: 1,
      },
      coordination: {
        ...testAftersalesCoordination('replacement'),
        currentTodo: '安排第 1 轮补发',
      },
      timeline: [],
      createdAt: '2026-08-14T02:00:00.000Z',
      updatedAt: '2026-08-14T02:00:00.000Z',
    };
    const progressAftersalesCase = vi.fn().mockResolvedValue(aftersalesCase);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready', dataDirectory: '/Users/test/闲鱼订单', orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([aftersalesCase]),
      progressAftersalesCase,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    expect(within(history).getByRole('region', { name: '售后实物流转汇总' }))
      .toHaveTextContent('累计发出 1 件 · 累计退回 0 件 · 买家当前持有 1 件');
    await user.click(within(history).getByRole('button', { name: '建立第 1 轮补发' }));
    const dialog = screen.getByRole('dialog', { name: '建立本轮补发记录' });
    await user.type(within(dialog).getByRole('textbox', { name: '补发承运方' }), '顺丰速运');
    await user.type(within(dialog).getByRole('textbox', { name: '补发运单号' }), 'SF-UI-REPLACEMENT');
    await user.type(within(dialog).getByRole('textbox', { name: '补发说明' }), '缺件确认后补发');
    await user.click(within(dialog).getByRole('button', { name: '确认补发' }));

    await waitFor(() => expect(progressAftersalesCase).toHaveBeenCalledWith({
      kind: 'create_replacement_shipment',
      caseId: aftersalesCase.id,
      roundId: aftersalesCase.rounds[0].id,
      expectedRevision: 1,
      occurredAt: expect.any(String),
      reason: '缺件确认后补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-UI-REPLACEMENT',
        items: [{ roundItemId: roundItem.id, quantity: 1 }],
      }],
    }));
  });

  it('补发记录沿用活动父售后概况且只开放未交寄作废入口', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const sourceRecord = archive.records[0];
    const sourceItem = sourceRecord.packages[0].items[0];
    const replacementRecord: ShipmentRecord = {
      ...sourceRecord,
      id: 'shipment-record-ui-replacement',
      sourceRecordRole: 'aftersales_replacement',
      sourceGroupId: 'aftersales-replacement-ui',
      packages: [{
        ...sourceRecord.packages[0],
        id: 'shipment-package-ui-replacement',
        trackingNumber: 'SF-UI-PARENT-AFTERSALES',
        items: [{ ...sourceItem, id: 'shipment-item-ui-replacement', quantity: 1 }],
      }],
      totalQuantity: 1,
    };
    const roundItem = {
      id: 'round-item-ui-parent',
      sourceShipmentPackageItemId: sourceItem.id,
      packageId: sourceRecord.packages[0].id,
      orderId: sourceItem.orderId,
      orderItemId: sourceItem.orderItemId,
      orderNumber: sourceItem.orderNumber,
      sourceTitle: sourceItem.sourceTitle,
      sourceSpec: sourceItem.sourceSpec,
      quantity: 1,
    };
    const aftersalesCase: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-parent',
      shipmentRecordId: sourceRecord.id,
      workflow: 'direct_replacement',
      status: 'waiting_replacement',
      revision: 2,
      reason: '活动父售后',
      occurredAt: '2026-08-14T10:00:00+08:00',
      items: [{
        id: 'case-item-ui-parent',
        shipmentPackageItemId: sourceItem.id,
        packageId: sourceRecord.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: null,
      returns: [],
      rounds: [{
        id: 'round-ui-parent',
        roundNumber: 1,
        workflow: 'direct_replacement',
        replacementRequired: true,
        sourceShipmentRecordId: sourceRecord.id,
        items: [roundItem],
        returnRecordIds: [],
        replacementShipment: replacementRecord,
        replacementOccurredAt: '2026-08-14T10:10:00+08:00',
        occurredAt: '2026-08-14T10:00:00+08:00',
        reason: '活动父售后',
        createdAt: '2026-08-14T02:00:00.000Z',
      }],
      fulfillment: {
        cumulativeSentQuantity: 2,
        cumulativeReturnedQuantity: 0,
        buyerHeldQuantity: 1,
        currentRoundNumber: 1,
      },
      coordination: testAftersalesCoordination('replacement'),
      timeline: [],
      createdAt: '2026-08-14T02:00:00.000Z',
      updatedAt: '2026-08-14T02:10:00.000Z',
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready', dataDirectory: '/Users/test/闲鱼订单', orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([{
        ...archive,
        records: [sourceRecord, replacementRecord],
      }]),
      queryAftersalesCases: vi.fn().mockResolvedValue([aftersalesCase]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const replacementCard = await screen.findByRole('article', {
      name: `发货记录 ${replacementRecord.id}`,
    });
    expect(replacementCard).toHaveTextContent('售后：等待补发 1');
    expect(within(replacementCard).queryByRole('button', { name: '建立售后处理单' }))
      .not.toBeInTheDocument();
    expect(within(replacementCard).getByRole('button', {
      name: /撤销未交寄包裹/u,
    })).toBeInTheDocument();
    expect(hasActiveParentAftersalesCase(replacementRecord, [{
      ...aftersalesCase,
      status: 'completed',
    }, {
      ...aftersalesCase,
      id: 'independent-active-case',
      shipmentRecordId: replacementRecord.id,
      workflow: 'general',
      status: 'processing',
      rounds: [],
    }])).toBe(false);
  });

  it('从发货记录选择商品数量和申请金额建立仅退款处理', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourceItem = record.packages[0].items[0];
    const created: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-created',
      shipmentRecordId: record.id,
      workflow: 'refund_only',
      status: 'waiting_refund',
      revision: 1,
      reason: '其中一件商品破损',
      occurredAt: '2026-08-13T14:00:00+08:00',
      items: [{
        id: 'aftersales-item-ui-created',
        shipmentPackageItemId: sourceItem.id,
        packageId: record.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: {
        pendingItemId: 'pending-refund-ui-created',
        requestedAmountCents: 600,
        status: 'pending',
        actualRecord: null,
        createdAt: '2026-08-13T06:00:00.000Z',
        latestEventAt: '2026-08-13T14:00:00+08:00',
        timeline: [{
          kind: 'created', requestedAmountCents: 600, actualAmountCents: null,
          reason: '其中一件商品破损', occurredAt: '2026-08-13T14:00:00+08:00',
          createdAt: '2026-08-13T06:00:00.000Z',
        }],
      },
      returns: [],
      coordination: testAftersalesCoordination('only_refund'),
      timeline: [{
        kind: 'created',
        resultRevision: 1,
        status: 'waiting_refund',
        reason: '其中一件商品破损',
        occurredAt: '2026-08-13T14:00:00+08:00',
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        createdAt: '2026-08-13T06:00:00.000Z',
      }],
      createdAt: '2026-08-13T06:00:00.000Z',
      updatedAt: '2026-08-13T06:00:00.000Z',
    };
    const createAftersalesCase = vi.fn().mockResolvedValue(created);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([]),
      createAftersalesCase,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    await user.click(within(history).getByRole('button', { name: '建立售后处理单' }));
    const dialog = screen.getByRole('dialog', { name: '建立售后处理单' });
    fireEvent.change(within(dialog).getByLabelText('售后发生时间'), {
      target: { value: '2026-08-13T14:00:00' },
    });
    await user.type(within(dialog).getByRole('textbox', { name: '问题原因' }), '其中一件商品破损');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '售后流程' }),
      'system-aftersales-refund-only',
    );
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '申请退款金额' }), {
      target: { value: '6' },
    });
    fireEvent.change(within(dialog).getByRole('spinbutton', {
      name: `${sourceItem.orderNumber} ${sourceItem.sourceTitle} 售后数量`,
    }), { target: { value: '1' } });
    const confirmButton = within(dialog).getByRole('button', { name: '确认建立' });
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() => {
      expect(createAftersalesCase).toHaveBeenCalledWith({
        shipmentRecordId: record.id,
        workflowTemplateId: 'system-aftersales-refund-only',
        occurredAt: '2026-08-13T14:00:00+08:00',
        reason: '其中一件商品破损',
        requestedRefundCents: 600,
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      });
    });
    expect(history).toHaveTextContent('售后：等待退款 1');
    expect(history).toHaveTextContent('其中一件商品破损');
  });

  it('在桌面端按原正向包裹协调运输中售后并保留转换历史', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourcePackage = record.packages[0];
    const sourceItem = sourcePackage.items[0];
    const packageEvidence: AftersalesCase['coordination']['sourcePackages'][number] = {
      packageId: sourcePackage.id,
      shippingCarrier: sourcePackage.shippingCarrier,
      trackingNumber: sourcePackage.trackingNumber,
      logisticsStatus: 'in_transit',
      confirmedLost: false,
      items: [{
        shipmentPackageItemId: sourceItem.id,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        confirmedLostQuantity: 0,
      }],
    };
    const selectedDirection = {
      kind: 'selected' as const,
      before: null,
      after: 'intercept' as const,
      occurredAt: '2026-08-13T15:00:00+08:00',
      reason: '包裹仍在运输中，先申请拦截',
      createdAt: '2026-08-13T07:00:00.000Z',
    };
    const created: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-interception',
      shipmentRecordId: record.id,
      workflow: 'return_refund',
      status: 'processing',
      revision: 1,
      reason: '运输中商品破损，需协调售后',
      occurredAt: '2026-08-13T15:00:00+08:00',
      items: [{
        id: 'aftersales-item-ui-interception',
        shipmentPackageItemId: sourceItem.id,
        packageId: sourcePackage.id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: {
        pendingItemId: 'pending-ui-interception',
        requestedAmountCents: 1_000,
        status: 'pending',
        actualRecord: null,
        createdAt: '2026-08-13T07:00:00.000Z',
        latestEventAt: '2026-08-13T15:00:00+08:00',
        timeline: [{
          kind: 'created', requestedAmountCents: 1_000, actualAmountCents: null,
          reason: '物流运输中申请拦截', occurredAt: '2026-08-13T15:00:00+08:00',
          createdAt: '2026-08-13T07:00:00.000Z',
        }],
      },
      returns: [],
      coordination: testAftersalesCoordination('intercept', {
        physicalControl: 'carrier',
        currentTodo: '拦截请求待确认，继续跟踪原正向包裹',
        risk: '商品仍在运输中，拦截结果未确认',
        sourcePackages: [packageEvidence],
        handlingDirectionTimeline: [selectedDirection],
        interception: {
          packageId: sourcePackage.id,
          status: 'requested',
          timeline: [{
            kind: 'requested',
            occurredAt: '2026-08-13T15:00:00+08:00',
            reason: '包裹仍在运输中，先申请拦截',
            createdAt: '2026-08-13T07:00:00.000Z',
          }],
        },
      }),
      timeline: [{
        kind: 'created',
        resultRevision: 1,
        status: 'processing',
        reason: '运输中商品破损，需协调售后',
        occurredAt: '2026-08-13T15:00:00+08:00',
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        createdAt: '2026-08-13T07:00:00.000Z',
      }],
      createdAt: '2026-08-13T07:00:00.000Z',
      updatedAt: '2026-08-13T07:00:00.000Z',
    };
    const failed: AftersalesCase = {
      ...created,
      revision: 2,
      coordination: testAftersalesCoordination('intercept', {
        physicalControl: 'carrier',
        currentTodo: '拦截失败，请转换为买家寄回、仅退款、补发或继续等待',
        risk: '拦截失败，原正向包裹仍可能送达买家',
        sourcePackages: [packageEvidence],
        handlingDirectionTimeline: [selectedDirection],
        interception: {
          packageId: sourcePackage.id,
          status: 'failed',
          timeline: [
            ...(created.coordination.interception?.timeline ?? []),
            {
              kind: 'failed',
              occurredAt: '2026-08-13T15:10:00+08:00',
              reason: '承运方回复包裹已进入末端，拦截失败',
              createdAt: '2026-08-13T07:10:00.000Z',
            },
          ],
        },
      }),
    };
    const changed: AftersalesCase = {
      ...failed,
      status: 'waiting_refund',
      revision: 3,
      coordination: testAftersalesCoordination('only_refund', {
        physicalControl: 'carrier',
        currentTodo: '核对并确认实际退款',
        risk: '商品仍在运输中，退款与收回实物需分别跟踪',
        sourcePackages: [packageEvidence],
        interception: failed.coordination.interception,
        handlingDirectionTimeline: [selectedDirection, {
          kind: 'changed',
          before: 'intercept',
          after: 'only_refund',
          occurredAt: '2026-08-13T15:20:00+08:00',
          reason: '买家急需处理，改为仅退款并继续追回包裹',
          createdAt: '2026-08-13T07:20:00.000Z',
        }],
      }),
    };
    const createAftersalesCase = vi.fn().mockResolvedValue(created);
    const progressAftersalesCase = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(changed);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([]),
      createAftersalesCase,
      progressAftersalesCase,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    await user.click(within(history).getByRole('button', { name: '建立售后处理单' }));
    const createDialog = screen.getByRole('dialog', { name: '建立售后处理单' });
    await user.selectOptions(
      within(createDialog).getByLabelText('售后流程'),
      'system-aftersales-return-refund',
    );
    fireEvent.change(within(createDialog).getByLabelText('售后发生时间'), {
      target: { value: '2026-08-13T15:00:00' },
    });
    await user.type(within(createDialog).getByLabelText('问题原因'), created.reason);
    fireEvent.change(within(createDialog).getByLabelText('申请退款金额'), {
      target: { value: '10' },
    });
    fireEvent.change(within(createDialog).getByLabelText(
      `${sourceItem.orderNumber} ${sourceItem.sourceTitle} 售后数量`,
    ), { target: { value: '1' } });
    expect(createDialog).toHaveTextContent(sourcePackage.trackingNumber);
    expect(createDialog).toHaveTextContent('运输中');
    const createButton = within(createDialog).getByRole('button', { name: '确认建立' });
    expect(createButton).toBeDisabled();
    await user.selectOptions(within(createDialog).getByLabelText('售后处理方向'), 'intercept');
    await user.selectOptions(within(createDialog).getByLabelText('本次拦截包裹'), sourcePackage.id);
    await user.click(createButton);
    await waitFor(() => expect(createAftersalesCase).toHaveBeenCalledWith({
      shipmentRecordId: record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      interceptionPackageId: sourcePackage.id,
      occurredAt: '2026-08-13T15:00:00+08:00',
      reason: created.reason,
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    }));

    const caseRegion = await screen.findByRole('region', { name: `售后处理单 ${created.id}` });
    expect(caseRegion).toHaveTextContent(created.coordination.currentTodo);
    expect(caseRegion).toHaveTextContent(created.coordination.risk as string);
    expect(caseRegion).toHaveTextContent(sourcePackage.trackingNumber);
    await user.click(within(caseRegion).getByRole('button', { name: '登记拦截结果' }));
    const resultDialog = screen.getByRole('dialog', { name: '登记拦截结果' });
    await user.selectOptions(within(resultDialog).getByLabelText('拦截结果'), 'failed');
    fireEvent.change(within(resultDialog).getByLabelText('拦截结果时间'), {
      target: { value: '2026-08-13T15:10:00' },
    });
    await user.type(within(resultDialog).getByLabelText('拦截结果说明'), '承运方回复包裹已进入末端，拦截失败');
    await user.click(within(resultDialog).getByRole('button', { name: '确认结果' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(1, {
      kind: 'record_interception_result',
      caseId: created.id,
      expectedRevision: 1,
      result: 'failed',
      occurredAt: '2026-08-13T15:10:00+08:00',
      reason: '承运方回复包裹已进入末端，拦截失败',
    }));
    expect(caseRegion).toHaveTextContent(failed.coordination.risk as string);

    await user.click(within(caseRegion).getByRole('button', { name: '转换处理方向' }));
    const directionDialog = screen.getByRole('dialog', { name: '转换售后处理方向' });
    await user.selectOptions(within(directionDialog).getByLabelText('新售后处理方向'), 'only_refund');
    fireEvent.change(within(directionDialog).getByLabelText('处理方向转换时间'), {
      target: { value: '2026-08-13T15:20:00' },
    });
    await user.type(within(directionDialog).getByLabelText('转换原因'), '买家急需处理，改为仅退款并继续追回包裹');
    await user.click(within(directionDialog).getByRole('button', { name: '确认转换' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(2, {
      kind: 'change_handling_direction',
      caseId: created.id,
      expectedRevision: 2,
      handlingDirection: 'only_refund',
      occurredAt: '2026-08-13T15:20:00+08:00',
      reason: '买家急需处理，改为仅退款并继续追回包裹',
    }));
    expect(caseRegion).toHaveTextContent('拦截失败');
    expect(caseRegion).toHaveTextContent('核对并确认实际退款');
    expect(within(caseRegion).getByRole('button', { name: '确认实际退款' })).toBeEnabled();
  });

  it('在桌面端将正向异常作为主待办并提交商品级处理选择', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourcePackage = record.packages[0];
    const sourceItem = sourcePackage.items[0];
    const outboundException: NonNullable<
      AftersalesCase['coordination']['outboundException']
    > = {
      exceptionId: 'outbound-exception-ui-1',
      sourceShipmentRecordId: record.id,
      packageId: sourcePackage.id,
      exceptionType: 'lost' as const,
      stage: 'confirmed' as const,
      affectedQuantity: 1,
      affectedItems: [{
        shipmentPackageItemId: sourceItem.id,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
      }],
      occurredAt: '2026-08-14T09:10:00+08:00',
      decision: null,
      availableDecisions: [
        'wait_investigation', 'recover_or_redeliver', 'refund_only',
        'replacement', 'refund_and_replacement',
      ],
      timeline: [],
    };
    const pending: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-outbound-exception-ui-1',
      shipmentRecordId: record.id,
      workflow: 'return_refund',
      status: 'processing',
      revision: 2,
      reason: '正向包裹其中一件已确认丢失',
      occurredAt: '2026-08-14T09:00:00+08:00',
      items: [{
        id: 'aftersales-outbound-exception-item-ui-1',
        shipmentPackageItemId: sourceItem.id,
        packageId: sourcePackage.id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: {
        pendingItemId: 'outbound-refund-ui-1',
        requestedAmountCents: 1_000,
        status: 'pending',
        actualRecord: null,
        createdAt: '2026-08-14T01:00:00.000Z',
        latestEventAt: '2026-08-14T09:00:00+08:00',
        timeline: [{
          kind: 'created', requestedAmountCents: 1_000, actualAmountCents: null,
          reason: '正向物流异常申请退款', occurredAt: '2026-08-14T09:00:00+08:00',
          createdAt: '2026-08-14T01:00:00.000Z',
        }],
      },
      returns: [],
      coordination: testAftersalesCoordination('waiting', {
        physicalControl: 'confirmed_lost',
        currentTodo: '正向物流异常已确认，请明确买家侧处理选择',
        risk: '正向丢件影响 1 件商品',
        sourcePackages: [{
          packageId: sourcePackage.id,
          shippingCarrier: sourcePackage.shippingCarrier,
          trackingNumber: sourcePackage.trackingNumber,
          logisticsStatus: 'in_transit',
          confirmedLost: true,
          items: [{
            shipmentPackageItemId: sourceItem.id,
            sourceTitle: sourceItem.sourceTitle,
            sourceSpec: sourceItem.sourceSpec,
            quantity: 1,
            confirmedLostQuantity: 1,
          }],
        }],
        outboundException,
        outboundExceptionHistory: [outboundException],
      }),
      timeline: [],
      createdAt: '2026-08-14T01:00:00.000Z',
      updatedAt: '2026-08-14T01:10:00.000Z',
    };
    const progressAftersalesCase = vi.fn().mockResolvedValue({
      ...pending,
      revision: 3,
      status: 'waiting_replacement',
      coordination: {
        ...pending.coordination,
        outboundException: { ...outboundException, decision: 'refund_and_replacement' },
      },
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready', dataDirectory: '/Users/test/闲鱼订单', orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([pending]),
      progressAftersalesCase,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const archiveRegion = await screen.findByRole('article', {
      name: `发货组档案 ${archive.orderNumbers.join('、')}`,
    });
    expect(archiveRegion).toHaveTextContent('当前待办：确认实际退款');
    expect(within(archiveRegion).getAllByText('另有 2 项')).toHaveLength(2);
    const caseRegion = await screen.findByRole('region', {
      name: `售后处理单 ${pending.id}`,
    });
    expect(caseRegion).toHaveTextContent('当前待办：确认实际退款');
    expect(caseRegion).toHaveTextContent('另有 1 项');
    expect(caseRegion).toHaveTextContent('正向物流异常已确认，请明确买家侧处理选择');
    expect(caseRegion).toHaveTextContent('未解决风险：正向丢件影响 1 件商品');
    await user.click(within(caseRegion).getByRole('button', { name: '选择正向异常处理' }));
    const dialog = screen.getByRole('dialog', { name: '选择正向异常处理' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '正向异常处理选择' }),
      'refund_and_replacement',
    );
    await user.type(within(dialog).getByRole('textbox', { name: '选择原因' }), '先退款并按丢失数量补发');
    await user.click(within(dialog).getByRole('button', { name: '确认选择' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenCalledWith({
      kind: 'decide_outbound_logistics_exception',
      caseId: pending.id,
      expectedRevision: 2,
      packageId: sourcePackage.id,
      exceptionId: outboundException.exceptionId,
      decision: 'refund_and_replacement',
      occurredAt: expect.any(String),
      reason: '先退款并按丢失数量补发',
    }));
  });

  it('用真实本地应用投影在桌面端补登终态未决拦截结果', async () => {
    const user = userEvent.setup();
    const applicationRoot = await mkdtemp(join(tmpdir(), 'xianyu-terminal-interception-ui-'));
    const recognitionResult: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '桌面终态拦截测试账号',
      orderNumber: 'XY-TERMINAL-INTERCEPTION-UI-0001',
      alipayTransactionNumber: 'ALI-TERMINAL-INTERCEPTION-UI-0001',
      buyerNickname: '桌面测试买家',
      recipient: '林青',
      phone: '13800000001',
      phoneNormalized: '13800000001',
      addressOriginal: '广东省深圳市南山区海风路1号',
      addressNormalized: '广东省深圳市南山区海风路1号',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
      orderedAtOriginal: '2026-08-13 14:00:00',
      orderedAtNormalized: '2026-08-13T14:00:00+08:00',
      paidAtOriginal: '2026-08-13 14:00:08',
      paidAtNormalized: '2026-08-13T14:00:08+08:00',
      productTotalCents: 2_000,
      shippingFeeCents: 0,
      amountCents: 2_000,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '终态拦截测试商品',
        sourceSpec: '两件',
        unitPriceCents: 1_000,
        quantity: 2,
        quantityInferred: false,
      }],
    };
    const recognizer: Recognizer = {
      async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
        return {
          result: recognitionResult,
          evidences: [{
            provider: 'controlled',
            model: 'controlled',
            requestId: '',
            schemaVersion: 1,
            rawResponse: JSON.stringify(recognitionResult),
          }],
        };
      },
    };
    const application = new LocalApplication(recognizer);
    try {
      const uploadDirectory = join(applicationRoot, '上传');
      await mkdir(uploadDirectory, { recursive: true });
      const sourcePath = join(uploadDirectory, '终态拦截订单.png');
      await writeFile(sourcePath, Buffer.from('terminal-interception-ui'));
      application.openDataDirectory(join(applicationRoot, '数据'));
      const batch = await application.submitRecognitionBatch([sourcePath]);
      application.confirmDraft(batch.drafts[0]);
      const group = application.queryShipmentGroups().groups[0];
      const groupItem = group.orders[0].items[0];
      const shipment = application.confirmShipment({
        groupId: group.id,
        expectedRemainingItems: [{
          orderId: group.orders[0].id,
          orderItemId: groupItem.id,
          quantity: groupItem.quantity,
        }],
        packages: [{
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-TERMINAL-INTERCEPTION-UI-0001',
          items: [{
            orderId: group.orders[0].id,
            orderItemId: groupItem.id,
            quantity: groupItem.quantity,
          }],
        }],
      });
      const sourceItem = shipment.record.packages[0].items[0];
      const cancellationPending = application.createAftersalesCase({
        shipmentRecordId: shipment.record.id,
        workflowTemplateId: 'system-aftersales-return-refund',
        handlingDirection: 'intercept',
        occurredAt: '2026-08-13T15:00:00+08:00',
        reason: '取消路径先申请拦截',
        requestedRefundCents: 1_000,
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      });
      const cancellationWaiting = application.progressAftersalesCase({
        kind: 'change_handling_direction',
        caseId: cancellationPending.id,
        expectedRevision: cancellationPending.revision,
        handlingDirection: 'waiting',
        occurredAt: '2026-08-13T15:05:00+08:00',
        reason: '暂时继续等待，但不撤销已申请的拦截',
      });
      const cancelled = application.progressAftersalesCase({
        kind: 'cancel',
        caseId: cancellationWaiting.id,
        expectedRevision: cancellationWaiting.revision,
        reason: '买家撤销售后，拦截回执仍待跟踪',
      });
      const completionPending = application.createAftersalesCase({
        shipmentRecordId: shipment.record.id,
        workflowTemplateId: 'system-aftersales-return-refund',
        handlingDirection: 'intercept',
        occurredAt: '2026-08-13T15:10:00+08:00',
        reason: '完成路径先申请拦截',
        requestedRefundCents: 1_000,
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      });
      const refundDirection = application.progressAftersalesCase({
        kind: 'change_handling_direction',
        caseId: completionPending.id,
        expectedRevision: completionPending.revision,
        handlingDirection: 'only_refund',
        occurredAt: '2026-08-13T15:15:00+08:00',
        reason: '改为仅退款，拦截回执仍待跟踪',
      });
      const refunded = application.progressAftersalesCase({
        kind: 'confirm_refund',
        caseId: refundDirection.id,
        expectedRevision: refundDirection.revision,
        actualRefundCents: 1_000,
        occurredAt: '2026-08-13T15:20:00+08:00',
        note: '已核对平台实际退款',
      });
      const completed = application.progressAftersalesCase({
        kind: 'complete',
        caseId: refunded.id,
        expectedRevision: refunded.revision,
        reason: '退款处理已结案，拦截回执继续独立跟踪',
      });
      expect([cancelled, completed]).toEqual([
        expect.objectContaining({
          status: 'cancelled',
          coordination: expect.objectContaining({
            currentTodo: '拦截请求待确认，继续跟踪原正向包裹',
            interception: expect.objectContaining({ status: 'requested' }),
          }),
        }),
        expect.objectContaining({
          status: 'completed',
          coordination: expect.objectContaining({
            currentTodo: '实际退款已确认，拦截请求仍待确认',
            interception: expect.objectContaining({ status: 'requested' }),
          }),
        }),
      ]);

      const progressAftersalesCase = vi.fn(async (input) => (
        application.progressAftersalesCase(input)
      ));
      const api = createApi({
        getBootstrapState: vi.fn().mockResolvedValue({
          kind: 'ready',
          dataDirectory: join(applicationRoot, '数据'),
          orders: application.listOrders(),
        }),
        listOrders: vi.fn(async () => application.listOrders()),
        queryOrders: vi.fn(async (query, customFieldDefinitionIds) => (
          application.queryOrders(query, customFieldDefinitionIds)
        )),
        queryShipmentGroups: vi.fn(async () => application.queryShipmentGroups()),
        queryShipmentGroupArchives: vi.fn(async () => application.queryShipmentGroupArchives()),
        queryAftersalesCases: vi.fn(async () => application.queryAftersalesCases()),
        progressAftersalesCase,
      });

      render(<App api={api} />);
      await user.click(await screen.findByRole('button', { name: '发货组' }));
      for (const [index, terminalCase] of [cancelled, completed].entries()) {
        const terminalStatus = terminalCase.status;
        const caseRegion = await screen.findByRole('region', {
          name: `售后处理单 ${terminalCase.id}`,
        });
        expect(caseRegion).toHaveTextContent(terminalCase.coordination.currentTodo);
        expect(caseRegion).toHaveTextContent(terminalStatus === 'completed' ? '已完成' : '已取消');
        await user.click(within(caseRegion).getByRole('button', { name: '登记拦截结果' }));
        const dialog = screen.getByRole('dialog', { name: '登记拦截结果' });
        fireEvent.change(within(dialog).getByLabelText('拦截结果时间'), {
          target: { value: `2026-08-13T15:${40 + index}:00` },
        });
        const resultReason = `承运方补充回复已拦截-${terminalStatus}`;
        await user.type(within(dialog).getByLabelText('拦截结果说明'), resultReason);
        await user.click(within(dialog).getByRole('button', { name: '确认结果' }));

        await waitFor(() => {
          const projected = application.queryAftersalesCases()
            .find(({ id }) => id === terminalCase.id);
          expect(projected).toMatchObject({
            status: terminalStatus,
            coordination: {
              interception: {
                status: 'succeeded',
                timeline: expect.arrayContaining([
                  expect.objectContaining({ kind: 'requested' }),
                  expect.objectContaining({ kind: 'succeeded', reason: resultReason }),
                ]),
              },
            },
          });
        });
        const updatedRegion = screen.getByRole('region', {
          name: `售后处理单 ${terminalCase.id}`,
        });
        expect(updatedRegion).toHaveTextContent(terminalStatus === 'completed' ? '已完成' : '已取消');
        expect(within(updatedRegion).queryByRole('button', { name: '登记拦截结果' }))
          .not.toBeInTheDocument();
      }
      expect(progressAftersalesCase).toHaveBeenCalledTimes(2);
    } finally {
      application.close();
    }
  });

  it('在仅退款处理单中确认实际金额后再显式完成售后', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourceItem = record.packages[0].items[0];
    const pending: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-refund-progress',
      shipmentRecordId: record.id,
      workflow: 'refund_only',
      status: 'waiting_refund',
      revision: 1,
      reason: '商品瑕疵，买家申请部分退款',
      occurredAt: '2026-08-13T16:00:00+08:00',
      items: [{
        id: 'aftersales-item-ui-refund-progress',
        shipmentPackageItemId: sourceItem.id,
        packageId: record.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: {
        pendingItemId: 'pending-ui-refund-progress',
        requestedAmountCents: 600,
        status: 'pending',
        actualRecord: null,
        createdAt: '2026-08-13T08:00:00.000Z',
        latestEventAt: '2026-08-13T16:00:00+08:00',
        timeline: [{
          kind: 'created', requestedAmountCents: 600, actualAmountCents: null,
          reason: '商品瑕疵，买家申请部分退款', occurredAt: '2026-08-13T16:00:00+08:00',
          createdAt: '2026-08-13T08:00:00.000Z',
        }],
      },
      returns: [],
      coordination: testAftersalesCoordination('only_refund'),
      timeline: [{
        kind: 'created',
        resultRevision: 1,
        status: 'waiting_refund',
        reason: '商品瑕疵，买家申请部分退款',
        occurredAt: '2026-08-13T16:00:00+08:00',
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        createdAt: '2026-08-13T08:00:00.000Z',
      }],
      createdAt: '2026-08-13T08:00:00.000Z',
      updatedAt: '2026-08-13T08:00:00.000Z',
    };
    const ready: AftersalesCase = {
      ...pending,
      status: 'ready_to_complete',
      revision: 2,
      refund: {
        ...pending.refund!,
        status: 'confirmed',
        actualRecord: {
          id: 'financial-ui-refund-progress',
          kind: 'aftersales_refund',
          amountCents: 500,
          occurredAt: '2026-08-13T16:10:00+08:00',
          note: '平台账单确认退款',
          createdAt: '2026-08-13T08:10:00.000Z',
        },
      },
    };
    const completed: AftersalesCase = { ...ready, status: 'completed', revision: 3 };
    const cancelPending: AftersalesCase = {
      ...pending,
      id: 'aftersales-ui-refund-cancel',
      reason: '另一件商品的退款申请待取消',
      refund: {
        ...pending.refund!,
        pendingItemId: 'pending-ui-refund-cancel',
      },
    };
    const cancelled: AftersalesCase = {
      ...cancelPending,
      status: 'cancelled',
      revision: 2,
      refund: { ...cancelPending.refund!, status: 'cancelled' },
    };
    const readyToCancel: AftersalesCase = {
      ...ready,
      id: 'aftersales-ui-confirmed-refund-cancel',
      reason: '实际退款已完成，剩余步骤不再执行',
      refund: {
        ...ready.refund!,
        pendingItemId: 'pending-ui-confirmed-refund-cancel',
      },
    };
    const cancelledAfterRefund: AftersalesCase = {
      ...readyToCancel,
      status: 'cancelled',
      revision: 3,
    };
    const progressAftersalesCase = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(cancelledAfterRefund);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([pending, cancelPending, readyToCancel]),
      progressAftersalesCase,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    const caseRegion = await screen.findByRole('region', {
      name: `售后处理单 ${pending.id}`,
    });
    expect(caseRegion).toHaveTextContent('仅退款');
    expect(caseRegion).toHaveTextContent('申请退款 ¥6.00');
    await user.click(within(caseRegion).getByRole('button', { name: '确认实际退款' }));
    const refundDialog = screen.getByRole('dialog', { name: '确认实际退款' });
    fireEvent.change(within(refundDialog).getByLabelText('实际退款时间'), {
      target: { value: '2026-08-13T16:10:00' },
    });
    fireEvent.change(within(refundDialog).getByRole('spinbutton', { name: '实际退款金额' }), {
      target: { value: '5' },
    });
    await user.type(
      within(refundDialog).getByRole('textbox', { name: '退款确认说明' }),
      '平台账单确认退款',
    );
    await user.click(within(refundDialog).getByRole('button', { name: '确认退款' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(1, {
      kind: 'confirm_refund',
      caseId: pending.id,
      expectedRevision: 1,
      actualRefundCents: 500,
      occurredAt: '2026-08-13T16:10:00+08:00',
      note: '平台账单确认退款',
    }));

    expect(caseRegion).toHaveTextContent('实际退款 ¥5.00');
    await user.click(within(caseRegion).getByRole('button', { name: '完成售后' }));
    const completeDialog = screen.getByRole('dialog', { name: '完成售后' });
    await user.type(
      within(completeDialog).getByRole('textbox', { name: '完成原因' }),
      '退款到账，本次售后结束',
    );
    await user.click(within(completeDialog).getByRole('button', { name: '确认完成' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(2, {
      kind: 'complete',
      caseId: pending.id,
      expectedRevision: 2,
      reason: '退款到账，本次售后结束',
    }));
    expect(caseRegion).toHaveTextContent('已完成');

    const cancelRegion = screen.getByRole('region', {
      name: `售后处理单 ${cancelPending.id}`,
    });
    await user.click(within(cancelRegion).getByRole('button', { name: '取消售后' }));
    const cancelDialog = screen.getByRole('dialog', { name: '取消售后' });
    await user.type(
      within(cancelDialog).getByRole('textbox', { name: '取消原因' }),
      '买家撤销退款申请',
    );
    await user.click(within(cancelDialog).getByRole('button', { name: '确认取消' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(3, {
      kind: 'cancel',
      caseId: cancelPending.id,
      expectedRevision: 1,
      reason: '买家撤销退款申请',
    }));
    expect(cancelRegion).toHaveTextContent('已取消');
    expect(cancelRegion).toHaveTextContent('退款申请已取消');

    const confirmedRefundRegion = screen.getByRole('region', {
      name: `售后处理单 ${readyToCancel.id}`,
    });
    expect(confirmedRefundRegion).toHaveTextContent('实际退款 ¥5.00');
    await user.click(within(confirmedRefundRegion).getByRole('button', { name: '取消售后' }));
    const confirmedRefundCancelDialog = screen.getByRole('dialog', { name: '取消售后' });
    await user.type(
      within(confirmedRefundCancelDialog).getByRole('textbox', { name: '取消原因' }),
      '实际退款保留，只取消未发生的剩余步骤',
    );
    await user.click(within(confirmedRefundCancelDialog).getByRole('button', {
      name: '确认取消',
    }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(4, {
      kind: 'cancel',
      caseId: readyToCancel.id,
      expectedRevision: 2,
      reason: '实际退款保留，只取消未发生的剩余步骤',
    }));
    expect(confirmedRefundRegion).toHaveTextContent('已取消');
    expect(confirmedRefundRegion).toHaveTextContent('实际退款 ¥5.00');
  });

  it('在现有退货包裹卡登记并推进独立物流异常', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourceItem = record.packages[0].items[0];
    const returnRecord: AftersalesCase['returns'][number] = {
      id: 'return-ui-logistics-exception',
      status: 'in_transit',
      revision: 1,
      logisticsStatus: 'delivered',
      carrierAcceptedAt: '2026-08-13T17:10:00+08:00',
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-UI-EXCEPTION-001',
      occurredAt: '2026-08-13T17:00:00+08:00',
      receivedAt: null,
      inspection: null,
      items: [{
        id: 'return-item-ui-logistics-exception',
        aftersalesCaseId: 'aftersales-ui-logistics-exception',
        shipmentPackageItemId: sourceItem.id,
        quantity: 1,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        receivedQuantity: 0,
        acceptedQuantity: 0,
        inspectionResult: null,
        inspectionNote: null,
      }],
      discrepancies: [],
      currentException: null,
      logisticsExceptions: [],
      carrierClaim: null,
      timeline: [],
      createdAt: '2026-08-13T09:00:00.000Z',
      updatedAt: '2026-08-13T09:00:00.000Z',
    };
    const pending: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-logistics-exception',
      shipmentRecordId: record.id,
      workflow: 'return_refund',
      status: 'waiting_return',
      revision: 1,
      reason: '买家退回商品',
      occurredAt: '2026-08-13T16:50:00+08:00',
      items: [{
        id: 'aftersales-item-ui-logistics-exception',
        shipmentPackageItemId: sourceItem.id,
        packageId: record.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: null,
      returns: [returnRecord],
      coordination: testAftersalesCoordination('buyer_return'),
      timeline: [],
      createdAt: '2026-08-13T08:50:00.000Z',
      updatedAt: '2026-08-13T08:50:00.000Z',
    };
    const openedException = {
      id: 'return-exception-ui-delivery-dispute',
      direction: 'return' as const,
      packageId: returnRecord.id,
      exceptionType: 'delivery_dispute' as const,
      stage: 'pending_verification' as const,
      revision: 1,
      impact: { scope: 'package' as const },
      reason: '退货显示签收但仓库未收到',
      occurredAt: '2026-08-14T10:00:00+08:00',
      timeline: [],
      createdAt: '2026-08-14T10:00:00+08:00',
      updatedAt: '2026-08-14T10:00:00+08:00',
    };
    const exceptional: AftersalesCase = {
      ...pending,
      revision: 2,
      coordination: testAftersalesCoordination('buyer_return', {
        currentTodo: '处理退货物流异常并明确买家侧处理选择',
        risk: '退货物流异常影响 1 件商品',
        returnException: {
          exceptionId: openedException.id,
          returnRecordId: returnRecord.id,
          exceptionType: 'delivery_dispute',
          stage: 'pending_verification',
          affectedQuantity: 1,
          decision: null,
          availableDecisions: [
            'wait_investigation', 'refund_in_advance', 'partial_refund',
            'reject_refund', 'negotiate',
          ],
          timeline: [],
        },
      }),
      returns: [{
        ...returnRecord,
        currentException: openedException,
        logisticsExceptions: [openedException],
      }],
    };
    const investigatingException = {
      ...openedException,
      stage: 'investigating' as const,
      revision: 2,
      reason: '承运方正在调查签收人和地点',
    };
    const investigating: AftersalesCase = {
      ...exceptional,
      revision: 3,
      coordination: {
        ...exceptional.coordination,
        returnException: exceptional.coordination.returnException
          ? { ...exceptional.coordination.returnException, stage: 'investigating' }
          : null,
        returnExceptionHistory: exceptional.coordination.returnException
          ? [{ ...exceptional.coordination.returnException, stage: 'investigating' }]
          : [],
      },
      returns: [{
        ...returnRecord,
        currentException: investigatingException,
        logisticsExceptions: [investigatingException],
      }],
    };
    const decided: AftersalesCase = {
      ...investigating,
      revision: 4,
      coordination: {
        ...investigating.coordination,
        currentTodo: '继续与买家协商，承运异常独立处理',
        returnException: investigating.coordination.returnException
          ? {
            ...investigating.coordination.returnException,
            decision: 'negotiate',
            timeline: [{
              kind: 'selected',
              exceptionId: openedException.id,
              returnRecordId: returnRecord.id,
              before: null,
              after: 'negotiate',
              occurredAt: '2026-08-14T10:30:00+08:00',
              reason: '先与买家协商处理方案',
              createdAt: '2026-08-14T02:30:00.000Z',
            }],
          }
          : null,
        returnExceptionHistory: investigating.coordination.returnException
          ? [{
            ...investigating.coordination.returnException,
            decision: 'negotiate',
            timeline: [{
              kind: 'selected',
              exceptionId: openedException.id,
              returnRecordId: returnRecord.id,
              before: null,
              after: 'negotiate',
              occurredAt: '2026-08-14T10:30:00+08:00',
              reason: '先与买家协商处理方案',
              createdAt: '2026-08-14T02:30:00.000Z',
            }],
          }]
          : [],
      },
    };
    const resolvedCase: AftersalesCase = {
      ...decided,
      revision: 5,
      coordination: {
        ...decided.coordination,
        currentTodo: '确认收到退货',
        risk: null,
        returnException: null,
      },
      returns: [{
        ...returnRecord,
        currentException: { ...investigatingException, stage: 'resolved', revision: 3 },
        logisticsExceptions: [
          { ...investigatingException, stage: 'resolved', revision: 3 },
        ],
      }],
    };
    const progressAftersalesCase = vi.fn()
      .mockResolvedValueOnce(exceptional)
      .mockResolvedValueOnce(investigating)
      .mockResolvedValueOnce(decided)
      .mockResolvedValueOnce(resolvedCase);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready', dataDirectory: '/Users/test/闲鱼订单', orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([pending]),
      progressAftersalesCase,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const shipmentHistory = await screen.findByRole('region', { name: '发货记录' });
    const caseRegion = await screen.findByRole('region', {
      name: `售后处理单 ${pending.id}`,
    });
    await user.click(within(caseRegion).getByRole('button', { name: '登记退货物流异常' }));
    const recordDialog = screen.getByRole('dialog', { name: '登记退货物流异常' });
    expect(within(recordDialog).getByRole('option', { name: '签收争议' })).toBeInTheDocument();
    expect(within(recordDialog).getByRole('option', { name: '错投' })).toBeInTheDocument();
    expect(within(recordDialog).getByRole('option', { name: '运输破损' })).toBeInTheDocument();
    expect(within(recordDialog).queryByRole('option', { name: '丢件' })).not.toBeInTheDocument();
    await user.selectOptions(
      within(recordDialog).getByRole('combobox', { name: '退货物流异常类型' }),
      'delivery_dispute',
    );
    await user.type(
      within(recordDialog).getByRole('textbox', { name: '异常说明' }),
      '退货显示签收但仓库未收到',
    );
    await user.click(within(recordDialog).getByRole('button', { name: '确认登记' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(1, {
      kind: 'record_return_logistics_exception',
      caseId: pending.id,
      expectedRevision: 1,
      returnRecordId: returnRecord.id,
      exceptionType: 'delivery_dispute',
      stage: 'pending_verification',
      impact: { scope: 'package' },
      occurredAt: expect.any(String),
      reason: '退货显示签收但仓库未收到',
    }));
    expect(shipmentHistory).toHaveTextContent(
      '当前待办：处理退货物流异常并明确买家侧处理选择',
    );

    await user.click(within(caseRegion).getByRole('button', { name: '推进退货物流异常' }));
    const progressDialog = screen.getByRole('dialog', { name: '推进退货物流异常' });
    await user.type(
      within(progressDialog).getByRole('textbox', { name: '阶段说明' }),
      '承运方正在调查签收人和地点',
    );
    await user.click(within(progressDialog).getByRole('button', { name: '确认推进' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(2, {
      kind: 'progress_return_logistics_exception',
      caseId: pending.id,
      expectedRevision: 2,
      returnRecordId: returnRecord.id,
      exceptionId: openedException.id,
      expectedExceptionRevision: 1,
      stage: 'investigating',
      occurredAt: expect.any(String),
      reason: '承运方正在调查签收人和地点',
    }));
    expect(caseRegion).toHaveTextContent('退货包裹 · 已签收');
    expect(caseRegion).toHaveTextContent('物流异常 · 签收争议 · 调查中');

    await user.click(within(caseRegion).getByRole('button', { name: '选择退货异常处理' }));
    const decisionDialog = screen.getByRole('dialog', { name: '选择退货异常处理' });
    await user.selectOptions(
      within(decisionDialog).getByRole('combobox', { name: '退货异常处理选择' }),
      'negotiate',
    );
    await user.type(
      within(decisionDialog).getByRole('textbox', { name: '选择原因' }),
      '先与买家协商处理方案',
    );
    await user.click(within(decisionDialog).getByRole('button', { name: '确认选择' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(3, {
      kind: 'decide_return_logistics_exception',
      caseId: pending.id,
      expectedRevision: 3,
      returnRecordId: returnRecord.id,
      exceptionId: openedException.id,
      decision: 'negotiate',
      occurredAt: expect.any(String),
      reason: '先与买家协商处理方案',
    }));
    expect(caseRegion).toHaveTextContent('退货异常处理：继续协商 · 影响 1 件');
    expect(caseRegion).toHaveTextContent('先与买家协商处理方案');
    expect(within(caseRegion).queryByRole('button', { name: '确认收到退货' }))
      .not.toBeInTheDocument();

    await user.click(within(caseRegion).getByRole('button', { name: '推进退货物流异常' }));
    const resolvedDialog = screen.getByRole('dialog', { name: '推进退货物流异常' });
    await user.selectOptions(
      within(resolvedDialog).getByRole('combobox', { name: '退货物流异常处理阶段' }),
      'resolved',
    );
    await user.type(
      within(resolvedDialog).getByRole('textbox', { name: '阶段说明' }),
      '承运方已核清并解决签收争议',
    );
    await user.click(within(resolvedDialog).getByRole('button', { name: '确认推进' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenCalledTimes(4));
    expect(caseRegion).toHaveTextContent('选择退货异常处理');
    expect(caseRegion).toHaveTextContent('继续协商 · 先与买家协商处理方案');
  });

  it('在退货退款处理单中逐步登记退货物流、收到和检查结果', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourceItem = record.packages[0].items[0];
    const pending: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-return-progress',
      shipmentRecordId: record.id,
      workflow: 'return_refund',
      status: 'waiting_return',
      revision: 1,
      reason: '商品破损，需要退回退款',
      occurredAt: '2026-08-13T17:00:00+08:00',
      items: [{
        id: 'aftersales-item-ui-return-progress',
        shipmentPackageItemId: sourceItem.id,
        packageId: record.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: {
        pendingItemId: 'pending-ui-return-progress',
        requestedAmountCents: 1_000,
        status: 'pending',
        actualRecord: null,
        createdAt: '2026-08-13T09:00:00.000Z',
        latestEventAt: '2026-08-13T17:00:00+08:00',
        timeline: [{
          kind: 'created', requestedAmountCents: 1_000, actualAmountCents: null,
          reason: '商品破损，需要退回退款', occurredAt: '2026-08-13T17:00:00+08:00',
          createdAt: '2026-08-13T09:00:00.000Z',
        }],
      },
      returns: [],
      coordination: testAftersalesCoordination('buyer_return'),
      timeline: [{
        kind: 'created',
        resultRevision: 1,
        status: 'waiting_return',
        reason: '商品破损，需要退回退款',
        occurredAt: '2026-08-13T17:00:00+08:00',
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        createdAt: '2026-08-13T09:00:00.000Z',
      }],
      createdAt: '2026-08-13T09:00:00.000Z',
      updatedAt: '2026-08-13T09:00:00.000Z',
    };
    const returnRecord: AftersalesCase['returns'][number] = {
      id: 'return-ui-progress',
      status: 'in_transit',
      revision: 1,
      logisticsStatus: 'awaiting_carrier',
      carrierAcceptedAt: null,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-UI-RETURN-001',
      occurredAt: '2026-08-13T17:10:00+08:00',
      receivedAt: null,
      inspection: null,
      items: [{
        id: 'return-item-ui-progress',
        aftersalesCaseId: pending.id,
        shipmentPackageItemId: sourceItem.id,
        quantity: 1,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        receivedQuantity: 0,
        acceptedQuantity: 0,
        inspectionResult: null,
        inspectionNote: null,
      }],
      discrepancies: [],
      currentException: null,
      logisticsExceptions: [],
      carrierClaim: null,
      timeline: [{
        kind: 'registered',
        resultRevision: 1,
        occurredAt: '2026-08-13T17:10:00+08:00',
        reason: '买家已经寄出',
        createdAt: '2026-08-13T09:10:00.000Z',
      }],
      createdAt: '2026-08-13T09:10:00.000Z',
      updatedAt: '2026-08-13T09:10:00.000Z',
    };
    const registered: AftersalesCase = {
      ...pending,
      revision: 2,
      returns: [returnRecord],
    };
    const received: AftersalesCase = {
      ...registered,
      status: 'waiting_inspection',
      revision: 3,
      returns: [{
        ...returnRecord,
        status: 'received',
        revision: 2,
        logisticsStatus: 'delivered',
        receivedAt: '2026-08-13T17:20:00+08:00',
        discrepancies: [{ kind: 'missing', quantity: 1, note: '包裹内少一件' }],
        items: returnRecord.items.map((item) => ({ ...item, receivedQuantity: 1 })),
        timeline: [...returnRecord.timeline, {
          kind: 'received',
          baseRevision: 1,
          resultRevision: 2,
          occurredAt: '2026-08-13T17:20:00+08:00',
          reason: '仓库实际收到',
          createdAt: '2026-08-13T09:20:00.000Z',
        }],
      }],
    };
    const inspected: AftersalesCase = {
      ...received,
      status: 'waiting_refund',
      revision: 4,
      returns: [{
        ...received.returns[0],
        status: 'inspected',
        revision: 3,
        inspection: {
          result: 'defective',
          occurredAt: '2026-08-13T17:30:00+08:00',
          note: '检查确认破损，进入瑕疵品待处理',
        },
        items: received.returns[0].items.map((item) => ({
          ...item,
          acceptedQuantity: 1,
          inspectionResult: 'defective',
          inspectionNote: '检查确认破损，进入瑕疵品待处理',
        })),
        timeline: [...received.returns[0].timeline, {
          kind: 'inspected',
          baseRevision: 2,
          resultRevision: 3,
          occurredAt: '2026-08-13T17:30:00+08:00',
          result: 'defective',
          note: '检查确认破损，进入瑕疵品待处理',
          createdAt: '2026-08-13T09:30:00.000Z',
        }],
      }],
    };
    const cancelledReturnRecord: AftersalesCase['returns'][number] = {
      ...returnRecord,
      id: 'return-ui-cancelled-progress',
      trackingNumber: 'YT-UI-CANCELLED-001',
    };
    const cancelledInTransit: AftersalesCase = {
      ...registered,
      id: 'aftersales-ui-cancelled-return-progress',
      status: 'cancelled',
      revision: 3,
      refund: {
        ...registered.refund!,
        pendingItemId: 'pending-ui-cancelled-return-progress',
        status: 'cancelled',
      },
      returns: [cancelledReturnRecord],
    };
    const cancelledReceived: AftersalesCase = {
      ...cancelledInTransit,
      revision: 4,
      returns: [{
        ...cancelledReturnRecord,
        status: 'received',
        revision: 2,
        logisticsStatus: 'delivered',
        receivedAt: '2026-08-13T17:40:00+08:00',
        items: cancelledReturnRecord.items.map((item) => ({ ...item, receivedQuantity: 1 })),
      }],
    };
    const claimPending: AftersalesCase = {
      ...registered,
      id: 'aftersales-ui-carrier-claim',
      status: 'completed',
      revision: 5,
      returns: [{
        ...returnRecord,
        id: 'return-ui-carrier-claim',
        logisticsStatus: 'in_transit',
        carrierAcceptedAt: '2026-08-13T17:15:00+08:00',
        currentException: {
          id: 'return-exception-ui-lost',
          direction: 'return',
          packageId: 'return-ui-carrier-claim',
          exceptionType: 'lost',
          stage: 'confirmed',
          revision: 1,
          impact: { scope: 'package' },
          reason: '承运方确认丢件',
          occurredAt: '2026-08-13T17:50:00+08:00',
          timeline: [],
          createdAt: '2026-08-13T17:50:00+08:00',
          updatedAt: '2026-08-13T17:50:00+08:00',
        },
        carrierClaim: {
          id: 'carrier-claim-ui',
          status: 'pending',
          revision: 1,
          requestedAmountCents: 1_000,
          approvedAmountCents: null,
          impact: { scope: 'package' },
          reason: '承运方确认丢件，申请赔付',
          actualCompensation: null,
          timeline: [{
            kind: 'opened',
            resultRevision: 1,
            requestedAmountCents: 1_000,
            impact: { scope: 'package' },
            reason: '承运方确认丢件，申请赔付',
            occurredAt: '2026-08-13T18:00:00+08:00',
            createdAt: '2026-08-13T10:00:00.000Z',
          }],
          createdAt: '2026-08-13T10:00:00.000Z',
          updatedAt: '2026-08-13T10:00:00.000Z',
        },
      }],
    };
    const claimApproved: AftersalesCase = {
      ...claimPending,
      returns: [{
        ...claimPending.returns[0],
        carrierClaim: {
          ...claimPending.returns[0].carrierClaim!,
          status: 'approved',
          revision: 2,
          approvedAmountCents: 8_00,
        },
      }],
    };
    const claimRefundPending: AftersalesCase = {
      ...registered,
      id: 'aftersales-ui-claim-refund-pending',
      status: 'waiting_return',
      revision: 4,
      returns: [{
        ...returnRecord,
        id: 'return-ui-claim-refund-pending',
        logisticsStatus: 'in_transit',
        carrierAcceptedAt: '2026-08-13T17:15:00+08:00',
        currentException: {
          id: 'return-exception-ui-other',
          direction: 'return',
          packageId: 'return-ui-claim-refund-pending',
          exceptionType: 'other',
          stage: 'confirmed',
          revision: 1,
          impact: { scope: 'package' },
          reason: '物流异常后已建立承运索赔',
          occurredAt: '2026-08-13T17:50:00+08:00',
          timeline: [],
          createdAt: '2026-08-13T17:50:00+08:00',
          updatedAt: '2026-08-13T17:50:00+08:00',
        },
        carrierClaim: {
          id: 'carrier-claim-ui-refund-pending',
          status: 'pending',
          revision: 1,
          requestedAmountCents: 1_000,
          approvedAmountCents: null,
          impact: { scope: 'package' },
          reason: '物流异常后已建立承运索赔',
          actualCompensation: null,
          createdAt: '2026-08-13T10:00:00.000Z',
          updatedAt: '2026-08-13T10:00:00.000Z',
          timeline: [{
            kind: 'opened',
            resultRevision: 1,
            requestedAmountCents: 1_000,
            impact: { scope: 'package' },
            reason: '物流异常后已建立承运索赔',
            occurredAt: '2026-08-13T18:00:00+08:00',
            createdAt: '2026-08-13T10:00:00.000Z',
          }],
        },
      }],
    };
    const claimRefunded: AftersalesCase = {
      ...claimRefundPending,
      status: 'ready_to_complete',
      revision: 5,
      refund: {
        ...claimRefundPending.refund!,
        status: 'confirmed',
        actualRecord: {
          id: 'refund-ui-claim-pending',
          kind: 'aftersales_refund',
          amountCents: 1_000,
          occurredAt: '2026-08-13T18:10:00+08:00',
          note: '索赔未结束时先完成买家退款',
          createdAt: '2026-08-13T10:10:00.000Z',
        },
      },
    };
    const progressAftersalesCase = vi.fn()
      .mockResolvedValueOnce(registered)
      .mockResolvedValueOnce(received)
      .mockResolvedValueOnce(inspected)
      .mockResolvedValueOnce(cancelledReceived)
      .mockResolvedValueOnce(claimApproved)
      .mockResolvedValueOnce(claimRefunded);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready', dataDirectory: '/Users/test/闲鱼订单', orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([
        pending, cancelledInTransit, claimPending, claimRefundPending,
      ]),
      progressAftersalesCase,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    expect(history).toHaveTextContent('当前待办：跟进承运索赔');
    const caseRegion = await screen.findByRole('region', {
      name: `售后处理单 ${pending.id}`,
    });
    await user.click(within(caseRegion).getByRole('button', { name: '登记退货物流' }));
    const registerDialog = screen.getByRole('dialog', { name: '登记退货物流' });
    fireEvent.change(within(registerDialog).getByLabelText('退货寄出时间'), {
      target: { value: '2026-08-13T17:10:00' },
    });
    await user.type(within(registerDialog).getByRole('textbox', { name: '退货承运方' }), '圆通速递');
    await user.type(within(registerDialog).getByRole('textbox', { name: '退货运单号' }), 'YT-UI-RETURN-001');
    await user.type(within(registerDialog).getByRole('textbox', { name: '退货登记说明' }), '买家已经寄出');
    await user.click(within(registerDialog).getByRole('button', { name: '确认登记' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(1, {
      kind: 'register_return',
      caseId: pending.id,
      expectedRevision: 1,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-UI-RETURN-001',
      occurredAt: '2026-08-13T17:10:00+08:00',
      reason: '买家已经寄出',
    }));

    expect(caseRegion).toHaveTextContent('圆通速递 · YT-UI-RETURN-001');
    expect(within(caseRegion).getByRole('button', { name: '更正退货物流' })).toBeEnabled();
    await user.click(within(caseRegion).getByRole('button', { name: '更正退货物流' }));
    const correctionDialog = screen.getByRole('dialog', { name: '更正退货物流' });
    expect(within(correctionDialog).getByRole('textbox', { name: '退货承运方' }))
      .toHaveValue('圆通速递');
    expect(within(correctionDialog).getByRole('textbox', { name: '退货运单号' }))
      .toHaveValue('YT-UI-RETURN-001');
    await user.click(within(correctionDialog).getByRole('button', { name: '返回' }));
    await user.click(within(caseRegion).getByRole('button', { name: '更新退货物流状态' }));
    const logisticsDialog = screen.getByRole('dialog', { name: '更新退货物流状态' });
    expect(within(logisticsDialog).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['待承运方接收', '运输中', '已签收', '已退回']);
    await user.selectOptions(
      within(logisticsDialog).getByRole('combobox', { name: '最新退货物流状态' }),
      'awaiting_carrier',
    );
    await user.click(within(logisticsDialog).getByRole('checkbox', { name: '已核对承运方揽收证据' }));
    expect(within(logisticsDialog).getByRole('button', { name: '确认更新' })).toBeDisabled();
    await user.click(within(logisticsDialog).getByRole('button', { name: '返回' }));
    expect(within(caseRegion).getByRole('button', { name: '取消售后' })).toBeEnabled();
    await user.click(within(caseRegion).getByRole('button', { name: '确认收到退货' }));
    const receiveDialog = screen.getByRole('dialog', { name: '确认收到退货' });
    fireEvent.change(within(receiveDialog).getByLabelText('退货收到时间'), {
      target: { value: '2026-08-13T17:20:00' },
    });
    await user.type(within(receiveDialog).getByRole('textbox', { name: '退货收到说明' }), '仓库实际收到');
    await user.type(within(receiveDialog).getByRole('textbox', { name: '差异说明' }), '包裹内少一件');
    await user.click(within(receiveDialog).getByRole('button', { name: '添加差异' }));
    await user.click(within(receiveDialog).getByRole('button', { name: '确认收到' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(2, {
      kind: 'receive_return',
      caseId: pending.id,
      expectedRevision: 2,
      returnRecordId: returnRecord.id,
      occurredAt: '2026-08-13T17:20:00+08:00',
      reason: '仓库实际收到',
      items: [{ returnRecordItemId: returnRecord.items[0].id, receivedQuantity: 1 }],
      discrepancies: [{ kind: 'missing', quantity: 1, note: '包裹内少一件' }],
    }));

    await user.click(within(caseRegion).getByRole('button', { name: '记录退货检查' }));
    const inspectDialog = screen.getByRole('dialog', { name: '记录退货检查' });
    fireEvent.change(within(inspectDialog).getByLabelText('退货检查时间'), {
      target: { value: '2026-08-13T17:30:00' },
    });
    await user.selectOptions(
      within(inspectDialog).getByRole('combobox', { name: '退货检查结果' }),
      'defective',
    );
    await user.type(
      within(inspectDialog).getByRole('textbox', { name: '退货检查说明' }),
      '检查确认破损，进入瑕疵品待处理',
    );
    await user.click(within(inspectDialog).getByRole('button', { name: '确认检查' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(3, {
      kind: 'inspect_return',
      caseId: pending.id,
      expectedRevision: 3,
      returnRecordId: returnRecord.id,
      result: 'defective',
      occurredAt: '2026-08-13T17:30:00+08:00',
      note: '检查确认破损，进入瑕疵品待处理',
      items: [{
        returnRecordItemId: returnRecord.items[0].id,
        acceptedQuantity: 1,
        result: 'defective',
        note: '检查确认破损，进入瑕疵品待处理',
      }],
      discrepancies: [{ kind: 'missing', quantity: 1, note: '包裹内少一件' }],
    }));
    expect(caseRegion).toHaveTextContent('检查结果：瑕疵品');
    expect(caseRegion).toHaveTextContent('检查确认破损，进入瑕疵品待处理');
    expect(within(caseRegion).getByRole('button', { name: '确认实际退款' })).toBeEnabled();

    const cancelledRegion = screen.getByRole('region', {
      name: `售后处理单 ${cancelledInTransit.id}`,
    });
    expect(cancelledRegion).toHaveTextContent('已取消');
    await user.click(within(cancelledRegion).getByRole('button', { name: '确认收到退货' }));
    const cancelledReceiveDialog = screen.getByRole('dialog', { name: '确认收到退货' });
    fireEvent.change(within(cancelledReceiveDialog).getByLabelText('退货收到时间'), {
      target: { value: '2026-08-13T17:40:00' },
    });
    await user.type(
      within(cancelledReceiveDialog).getByRole('textbox', { name: '退货收到说明' }),
      '退款取消后退货仍到达',
    );
    await user.click(within(cancelledReceiveDialog).getByRole('button', { name: '确认收到' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(4, {
      kind: 'receive_return',
      caseId: cancelledInTransit.id,
      expectedRevision: 3,
      returnRecordId: cancelledReturnRecord.id,
      occurredAt: '2026-08-13T17:40:00+08:00',
      reason: '退款取消后退货仍到达',
      items: [{
        returnRecordItemId: cancelledReturnRecord.items[0].id,
        receivedQuantity: 1,
      }],
      discrepancies: [],
    }));
    expect(cancelledRegion).toHaveTextContent('已取消');
    expect(within(cancelledRegion).getByRole('button', { name: '记录退货检查' })).toBeEnabled();
    expect(history).toHaveTextContent('当前待办：跟进承运索赔');

    const claimRegion = screen.getByRole('region', {
      name: `售后处理单 ${claimPending.id}`,
    });
    expect(claimRegion).toHaveTextContent('承运索赔 处理中');
    await user.click(within(claimRegion).getByRole('button', { name: '登记索赔结果' }));
    const claimDialog = screen.getByRole('dialog', { name: '登记承运索赔结果' });
    fireEvent.change(within(claimDialog).getByLabelText('索赔结果时间'), {
      target: { value: '2026-08-14T10:00:00' },
    });
    fireEvent.change(within(claimDialog).getByRole('spinbutton', { name: '承运方同意赔付金额' }), {
      target: { value: '8' },
    });
    await user.type(within(claimDialog).getByRole('textbox', { name: '索赔结果说明' }), '承运方同意赔付八元');
    await user.click(within(claimDialog).getByRole('button', { name: '确认结果' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(5, {
      kind: 'resolve_carrier_claim',
      caseId: claimPending.id,
      expectedRevision: claimPending.revision,
      returnRecordId: claimPending.returns[0].id,
      expectedClaimRevision: 1,
      outcome: 'approved',
      approvedAmountCents: 800,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '承运方同意赔付八元',
    }));

    const claimRefundRegion = screen.getByRole('region', {
      name: `售后处理单 ${claimRefundPending.id}`,
    });
    expect(within(claimRefundRegion).getByRole('button', { name: '确认收到退货' })).toBeEnabled();
    await user.click(within(claimRefundRegion).getByRole('button', { name: '确认实际退款' }));
    const claimRefundDialog = screen.getByRole('dialog', { name: '确认实际退款' });
    fireEvent.change(within(claimRefundDialog).getByLabelText('实际退款时间'), {
      target: { value: '2026-08-13T18:10:00' },
    });
    fireEvent.change(within(claimRefundDialog).getByRole('spinbutton', { name: '实际退款金额' }), {
      target: { value: '10' },
    });
    await user.type(
      within(claimRefundDialog).getByRole('textbox', { name: '退款确认说明' }),
      '索赔未结束时先完成买家退款',
    );
    await user.click(within(claimRefundDialog).getByRole('button', { name: '确认退款' }));
    await waitFor(() => expect(progressAftersalesCase).toHaveBeenNthCalledWith(6, {
      kind: 'confirm_refund',
      caseId: claimRefundPending.id,
      expectedRevision: claimRefundPending.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-13T18:10:00+08:00',
      note: '索赔未结束时先完成买家退款',
    }));
    expect(within(claimRefundRegion).getByRole('button', { name: '确认收到退货' })).toBeEnabled();
    expect(within(claimRefundRegion).getByRole('button', { name: '完成售后' })).toBeEnabled();
  });

  it('更新售后状态时保留商品数量并要求填写本次变更原因', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourceItem = record.packages[0].items[0];
    const created: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-ui-update',
      shipmentRecordId: record.id,
      workflow: 'general',
      status: 'processing',
      revision: 1,
      reason: '商品存在破损',
      occurredAt: '2026-08-13T15:00:00+08:00',
      items: [{
        id: 'aftersales-item-ui-update',
        shipmentPackageItemId: sourceItem.id,
        packageId: record.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: null,
      returns: [],
      coordination: testAftersalesCoordination(),
      timeline: [{
        kind: 'created',
        resultRevision: 1,
        status: 'processing',
        reason: '商品存在破损',
        occurredAt: '2026-08-13T15:00:00+08:00',
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        createdAt: '2026-08-13T07:00:00.000Z',
      }],
      createdAt: '2026-08-13T07:00:00.000Z',
      updatedAt: '2026-08-13T07:00:00.000Z',
    };
    const updated: AftersalesCase = {
      ...created,
      status: 'waiting_return',
      revision: 2,
      timeline: [...created.timeline, {
        kind: 'updated',
        baseRevision: 1,
        resultRevision: 2,
        changeReason: '与买家确认寄回商品',
        before: {
          status: 'processing',
          reason: created.reason,
          items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        },
        after: {
          status: 'waiting_return',
          reason: created.reason,
          items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        },
        createdAt: '2026-08-13T07:10:00.000Z',
      }],
      updatedAt: '2026-08-13T07:10:00.000Z',
    };
    const updateAftersalesCase = vi.fn().mockResolvedValue(updated);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([created]),
      updateAftersalesCase,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });
    await user.click(within(history).getByRole('button', { name: '更新售后处理' }));
    const dialog = screen.getByRole('dialog', { name: '更新售后处理' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '售后状态' }), 'waiting_return');
    const confirmButton = within(dialog).getByRole('button', { name: '确认更新' });
    expect(confirmButton).toBeDisabled();
    await user.type(
      within(dialog).getByRole('textbox', { name: '本次变更原因' }),
      '与买家确认寄回商品',
    );
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() => expect(updateAftersalesCase).toHaveBeenCalledWith({
      caseId: created.id,
      expectedRevision: 1,
      status: 'waiting_return',
      reason: created.reason,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      changeReason: '与买家确认寄回商品',
    }));
    expect(history).toHaveTextContent('售后：等待退回 1');
    expect(history).toHaveTextContent('与买家确认寄回商品');
  });

  it('发货后原订单变化时在发货记录中显示快照差异提醒', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const record: ShipmentRecord = {
      ...shipmentRecordForGroup(group),
      sourceDifferences: [{
        orderId: confirmedOrder.id,
        orderItemId: null,
        field: 'recipient',
        snapshotValue: '人工修正收件人',
        currentValue: '新的收件人',
      }],
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([{
        ...shipmentArchiveForGroup(group),
        records: [record],
      }]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const history = await screen.findByRole('region', { name: '发货记录' });

    expect(history).toHaveTextContent('来源订单已有 1 项变化');
    expect(history).toHaveTextContent('收件人');
    expect(history).toHaveTextContent('人工修正收件人 → 新的收件人');
  });

  it('重组不同收货信息的发货组时要求选择最终收货信息', async () => {
    const user = userEvent.setup();
    const secondOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-distinct-recipient',
      orderNumber: 'XY-SHIPMENT-UI-DISTINCT',
      recipient: '周宁',
      phone: '13900000002',
      phoneNormalized: '13900000002',
      addressOriginal: '广东省深圳市福田区新风路2号',
      addressNormalized: '广东省深圳市福田区新风路2号',
    };
    const firstProjection = singleShipmentGroupProjection();
    const secondProjection = singleShipmentGroupProjection(secondOrder);
    secondProjection.groups[0].id = 'shipment-group-distinct00000000';
    const projection: ShipmentGroupProjection = {
      groups: [...firstProjection.groups, ...secondProjection.groups],
      attentionOrders: [],
    };
    const mergeShipmentGroups = vi.fn().mockResolvedValue({
      event: {
        id: 'adjustment-merge-1',
        operation: 'merge',
        reason: '买家要求一起发货',
        sourceGroupIds: projection.groups.map(({ id }) => id),
        sourceOrderIds: [confirmedOrder.id, secondOrder.id],
        targetGroupId: 'manual-group-merge-1',
        targetOrderIds: [confirmedOrder.id, secondOrder.id],
        selectedRecipientOrderId: secondOrder.id,
        createdAt: '2026-08-11T10:00:00.000Z',
      },
      projection,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue(projection),
      mergeShipmentGroups,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    await user.click(screen.getByRole('checkbox', {
      name: `选择发货组 ${confirmedOrder.orderNumber}`,
    }));
    await user.click(screen.getByRole('checkbox', {
      name: `选择发货组 ${secondOrder.orderNumber}`,
    }));
    await user.click(screen.getByRole('button', { name: '重新组合' }));

    const dialog = screen.getByRole('dialog', { name: '重新组合发货组' });
    expect(within(dialog).getByText('请选择最终收货信息')).toBeVisible();
    await user.click(within(dialog).getByRole('radio', {
      name: `最终收货信息：周宁 13900000002 ${secondOrder.addressOriginal}`,
    }));
    await user.type(
      within(dialog).getByRole('textbox', { name: '调整原因' }),
      '买家要求一起发货',
    );
    await user.click(within(dialog).getByRole('button', { name: '确认重新组合' }));

    expect(mergeShipmentGroups).toHaveBeenCalledWith({
      groupIds: projection.groups.map(({ id }) => id),
      expectedMemberOrderIds: [confirmedOrder.id, secondOrder.id],
      selectedRecipientOrderId: secondOrder.id,
      reason: '买家要求一起发货',
    });
  });

  it('从发货组追溯原始订单详情后返回发货组', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue(singleShipmentGroupProjection()),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    await user.click(await screen.findByRole('button', {
      name: `查看原始订单 ${confirmedOrder.orderNumber}`,
    }));

    expect(await screen.findByRole('heading', { level: 1, name: '订单详情' })).toBeVisible();
    expect(screen.getAllByText(confirmedOrder.orderNumber)).not.toHaveLength(0);
    const back = screen.getByRole('button', { name: '返回发货组' });
    await user.click(back);
    expect(await screen.findByRole('heading', { level: 1, name: '发货组' })).toBeVisible();
    expect(screen.getByRole('button', { name: '发货组' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('订单当前值变化后自动刷新正在查看的发货组', async () => {
    const user = userEvent.setup();
    let publishOrdersChanged: Parameters<DesktopApi['onOrdersChanged']>[0] | undefined;
    const queryShipmentGroups = vi.fn()
      .mockResolvedValueOnce(singleShipmentGroupProjection())
      .mockResolvedValueOnce({ groups: [], attentionOrders: [] });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups,
      onOrdersChanged: vi.fn((listener) => {
        publishOrdersChanged = listener;
        return () => undefined;
      }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    expect(await screen.findByRole('table', { name: '开放发货组' })).toBeVisible();

    act(() => publishOrdersChanged?.([]));

    expect(await screen.findByRole('heading', { level: 2, name: '没有待发货订单' }))
      .toBeVisible();
    expect(queryShipmentGroups).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('region', { name: '发货组概况' })).toHaveTextContent(
      '待发货组0',
    );
  });

  it('上传一张来源截图后可对照来源修正识别结果，确认后以订单表为主视图', async () => {
    const user = userEvent.setup();
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const queryOrders = vi.fn()
      .mockResolvedValueOnce(workbenchResult([]))
      .mockResolvedValue(workbenchResult([orderSummary()]));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([orderSummary()]),
      queryOrders,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByRole('img', { name: '来源截图' })).toHaveAttribute(
      'src',
      'data:image/png;base64,c291cmNl',
    );

    await user.clear(screen.getByRole('textbox', { name: '收件人' }));
    await user.type(screen.getByRole('textbox', { name: '收件人' }), '人工修正收件人');
    await user.clear(screen.getByRole('spinbutton', { name: '数量' }));
    await user.type(screen.getByRole('spinbutton', { name: '数量' }), '2');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(await screen.findByRole('heading', { name: '订单' })).toBeVisible();
    expect(screen.getByRole('table', { name: '原始订单' })).toHaveTextContent('人工修正收件人');
    expect(confirmDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: '人工修正收件人',
        items: [expect.objectContaining({ quantity: 2, quantityInferred: false })],
      }),
    );
  });

  it('人工确认新订单时要求每件商品补齐必填自定义字段', async () => {
    const user = userEvent.setup();
    const requiredItemField: CustomFieldDefinition = {
      id: 'field-required-item-bin',
      name: '商品库位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([requiredItemField]),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    const confirmButton = await screen.findByRole('button', { name: '确认并入库' });
    const itemField = screen.getByRole('textbox', { name: '商品库位' });
    expect(itemField).toHaveAttribute('aria-required', 'true');
    expect(confirmButton).toBeDisabled();
    expect(screen.getByText('请填写每件商品的全部必填自定义字段后再确认入库。'))
      .toBeVisible();

    await user.type(itemField, 'A-03');
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    expect(confirmDraft).toHaveBeenCalledWith(draft, {
      orderValues: [],
      itemValues: [{
        definitionId: requiredItemField.id,
        draftItemId: draft.items[0].id,
        value: 'A-03',
      }],
    });
  });

  it('校对中的自定义金额显示非法精度时不能提交旧值或空值', async () => {
    const user = userEvent.setup();
    const moneyField: CustomFieldDefinition = {
      id: 'field-review-extra-cost',
      name: '附加成本',
      granularity: 'order',
      type: 'money',
      required: false,
      defaultValue: 100,
      options: [],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const confirmDraft = vi.fn();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([moneyField]),
      confirmDraft,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    const confirmButton = await screen.findByRole('button', { name: '确认并入库' });
    const moneyInput = screen.getByRole('textbox', { name: '附加成本' });
    expect(confirmButton).toBeEnabled();

    await user.clear(moneyInput);
    await user.type(moneyInput, '1.005');

    expect(screen.getByText(/金额最多支持两位小数/u)).toBeVisible();
    expect(confirmButton).toBeDisabled();
    expect(confirmDraft).not.toHaveBeenCalled();
  });

  it('可取消本次校对并回到上传页，且不会确认订单', async () => {
    const user = userEvent.setup();
    const cancelDraft = vi.fn().mockResolvedValue(undefined);
    const confirmDraft = vi.fn();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      cancelDraft,
      confirmDraft,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '取消本次校对' }));

    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '校对识别结果' })).not.toBeInTheDocument();
    expect(cancelDraft).toHaveBeenCalledWith(draft.id);
    expect(confirmDraft).not.toHaveBeenCalled();
  });

  it('收件人与买家昵称疑似错位时给出明确校对提示', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue({
        ...draft,
        buyerNickname: '陈测试',
        recipient: '陈测试',
      }),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByText(
      'OCR 疑似把收件人同时填入了买家昵称，请对照截图核对',
    )).toBeVisible();
    await user.clear(screen.getByRole('textbox', { name: '买家昵称' }));
    await user.type(screen.getByRole('textbox', { name: '买家昵称' }), '测***户');
    expect(screen.queryByText(
      'OCR 疑似把收件人同时填入了买家昵称，请对照截图核对',
    )).not.toBeInTheDocument();
  });

  it('取消校对失败时保留截图与编辑内容，并允许重试', async () => {
    const user = userEvent.setup();
    const cancelDraft = vi.fn().mockRejectedValue(new Error('暂时无法取消校对'));
    const confirmDraft = vi.fn();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      cancelDraft,
      confirmDraft,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    const recipient = await screen.findByRole('textbox', { name: '收件人' });
    await user.clear(recipient);
    await user.type(recipient, '人工校对中的收件人');
    await user.click(screen.getByRole('button', { name: '取消本次校对' }));

    expect(await screen.findByText('暂时无法取消校对')).toBeVisible();
    expect(screen.getByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByRole('img', { name: '来源截图' })).toBeVisible();
    expect(recipient).toHaveValue('人工校对中的收件人');
    expect(screen.getByRole('button', { name: '取消本次校对' })).toBeEnabled();
    expect(confirmDraft).not.toHaveBeenCalled();
  });

  it('校对时可修正完整交易、地址、时间、金额与状态字段', async () => {
    const user = userEvent.setup();
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('textbox', { name: '平台' })).toHaveValue('闲鱼');
    expect(screen.getByRole('textbox', { name: '平台' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '卖家账号' })).toBeRequired();

    await user.clear(screen.getByRole('textbox', { name: '支付宝交易号' }));
    await user.type(screen.getByRole('textbox', { name: '支付宝交易号' }), 'ALI-CORRECTED-001');
    await user.clear(screen.getByRole('textbox', { name: '完整收货地址' }));
    await user.type(screen.getByRole('textbox', { name: '完整收货地址' }), '广东省 深圳市 南山区 科技路2号');
    await user.clear(screen.getByRole('textbox', { name: '下单时间（原文）' }));
    await user.type(screen.getByRole('textbox', { name: '下单时间（原文）' }), '2026-07-27 11:22:00');
    await user.clear(screen.getByRole('textbox', { name: '付款时间（原文）' }));
    await user.type(screen.getByRole('textbox', { name: '付款时间（原文）' }), '2026-07-27 11:23:00');

    await user.clear(screen.getByRole('spinbutton', { name: '商品总价' }));
    await user.type(screen.getByRole('spinbutton', { name: '商品总价' }), '18.00');
    await user.clear(screen.getByRole('spinbutton', { name: '运费' }));
    await user.type(screen.getByRole('spinbutton', { name: '运费' }), '2.00');
    await user.clear(screen.getByRole('spinbutton', { name: '成交金额' }));
    await user.type(screen.getByRole('spinbutton', { name: '成交金额' }), '20.00');
    await user.selectOptions(screen.getByRole('combobox', { name: '平台交易状态' }), 'refunded');
    await user.selectOptions(screen.getByRole('combobox', { name: '履约状态' }), 'shipped');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({
      alipayTransactionNumber: 'ALI-CORRECTED-001',
      addressNormalized: '广东省深圳市南山区科技路2号',
      orderedAtNormalized: '2026-07-27T11:22:00+08:00',
      paidAtNormalized: '2026-07-27T11:23:00+08:00',
      productTotalCents: 1_800,
      shippingFeeCents: 200,
      amountCents: 2_000,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
    }));
  });

  it('截图确认只允许选择 OCR 基础履约状态', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    const fulfillmentSelect = await screen.findByRole('combobox', { name: '履约状态' });
    expect(within(fulfillmentSelect).queryByRole('option', { name: '已收货' }))
      .not.toBeInTheDocument();
    expect(within(fulfillmentSelect).queryByRole('option', { name: '已退货' }))
      .not.toBeInTheDocument();
  });

  it('金额按十进制精确保存为分，并拒绝三位小数与指数格式', async () => {
    const user = userEvent.setup();
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    fireEvent.change(screen.getByRole('spinbutton', { name: '商品总价' }), {
      target: { value: '1.005' },
    });
    expect(screen.getByText('金额仅支持普通数字，最多两位小数')).toBeVisible();
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();

    fireEvent.change(screen.getByRole('spinbutton', { name: '商品总价' }), {
      target: { value: '1.05' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '运费' }), {
      target: { value: '1e2' },
    });
    expect(screen.getByText('金额仅支持普通数字，最多两位小数')).toBeVisible();
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();

    fireEvent.change(screen.getByRole('spinbutton', { name: '运费' }), {
      target: { value: '0.10' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '成交金额' }), {
      target: { value: '1.15' },
    });
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({
      productTotalCents: 105,
      shippingFeeCents: 10,
      amountCents: 115,
    }));
  });

  it('成交金额缺失时保留空白并阻止确认入库', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue({ ...draft, amountCents: null }),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    expect(screen.getByRole('spinbutton', { name: '成交金额' })).toHaveValue(null);
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();

    fireEvent.change(screen.getByRole('spinbutton', { name: '成交金额' }), {
      target: { value: '0.00' },
    });
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeEnabled();
  });

  it('数量缺失时显示推定标记，且单个商品也可删除后重新添加', async () => {
    const user = userEvent.setup();
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByText('数量来源：系统默认 1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '删除商品 1' }));

    expect(screen.getByRole('heading', { name: '订单商品明细 · 0' })).toBeVisible();
    expect(screen.getByText('暂无订单商品明细')).toBeVisible();
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '添加商品' }));
    expect(screen.getByRole('heading', { name: '订单商品明细 · 1' })).toBeVisible();
    expect(screen.getByText('数量来源：人工修改')).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: '数量' })).toHaveValue(1);

    await user.type(screen.getByRole('textbox', { name: '商品标题' }), '人工补录商品');
    await user.type(screen.getByRole('spinbutton', { name: '单价' }), '1.00');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        sourceTitle: '人工补录商品',
        unitPriceCents: 100,
        quantity: 1,
        quantityInferred: false,
      })],
    }));
  });

  it('商品数量必须是大于等于 1 的整数', async () => {
    const user = userEvent.setup();
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    fireEvent.change(screen.getByRole('spinbutton', { name: '数量' }), {
      target: { value: '1.5' },
    });

    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();
    expect(confirmDraft).not.toHaveBeenCalled();
  });

  it('修正手机号和原始地址时同步只读的规范化值', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    fireEvent.change(screen.getByRole('textbox', { name: '手机号' }), {
      target: { value: '+86 139-0000-0002' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '完整收货地址' }), {
      target: { value: '测试省，测试市 示例区 安全路 2号' },
    });

    expect(screen.getByRole('textbox', { name: '规范化手机号' }))
      .toHaveValue('8613900000002');
    expect(screen.getByRole('textbox', { name: '规范化手机号' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '规范化地址' }))
      .toHaveValue('测试省测试市示例区安全路2号');
    expect(screen.getByRole('textbox', { name: '规范化地址' })).toHaveAttribute('readonly');
  });

  it('修正交易时间原文时同步只读的规范化时间', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    fireEvent.change(screen.getByRole('textbox', { name: '下单时间（原文）' }), {
      target: { value: '2026年7月30日 08:09:10' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '付款时间（原文）' }), {
      target: { value: '2026/07/30 08:09:18' },
    });

    expect(screen.getByRole('textbox', { name: '下单时间（规范化）' }))
      .toHaveValue('2026-07-30T08:09:10+08:00');
    expect(screen.getByRole('textbox', { name: '下单时间（规范化）' }))
      .toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '付款时间（规范化）' }))
      .toHaveValue('2026-07-30T08:09:18+08:00');
    expect(screen.getByRole('textbox', { name: '付款时间（规范化）' }))
      .toHaveAttribute('readonly');
  });

  it('有订单时首页明确汇总在库订单、全部待确认和待发货', async () => {
    const awaitingBatch = recognitionBatchView('batch-workbench-summary', [
      {
        id: 'batch-item-awaiting-1',
        batchId: 'batch-workbench-summary',
        sourceName: '待确认1.png',
        status: 'awaiting_confirmation',
        draftId: 'draft-awaiting-1',
      },
      {
        id: 'batch-item-awaiting-2',
        batchId: 'batch-workbench-summary',
        sourceName: '待确认2.png',
        status: 'awaiting_confirmation',
        draftId: 'draft-awaiting-2',
      },
    ]);
    const summary = orderSummary();
    const cancelled = orderSummary(confirmedOrder, {
      id: 'order-cancelled',
      orderNumber: 'XY-CANCELLED',
      platformTransactionStatus: 'cancelled',
    });
    const refunded = orderSummary(confirmedOrder, {
      id: 'order-refunded',
      orderNumber: 'XY-REFUNDED',
      platformTransactionStatus: 'refunded',
    });
    const trashed = orderSummary(confirmedOrder, {
      id: 'order-trashed',
      orderNumber: 'XY-TRASHED',
      lifecycleStatus: 'trashed',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary, cancelled, refunded, trashed],
      }),
      listOrders: vi.fn().mockResolvedValue([summary, cancelled, refunded, trashed]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary], {
        activeOrderCount: 1,
        pendingShipmentCount: 1,
      })),
      listRecognitionBatches: vi.fn().mockResolvedValue([awaitingBatch]),
    });

    render(<App api={api} />);

    const overview = await screen.findByRole('region', { name: '订单概况' });
    await waitFor(() => {
      expect(overview).toHaveTextContent('在库订单1');
      expect(overview).toHaveTextContent('待确认2');
      expect(overview).toHaveTextContent('待发货1');
    });
  });

  it('订单行直接展示完整收件信息、商品、平台卖家和四个独立状态', async () => {
    const summary = orderSummary(confirmedOrder, {
      addressOriginal: '广东省深圳市南山区商务路88号',
      phone: '13800000000',
      items: [{ sourceTitle: '限量测试商品', sourceSpec: '商务黑', quantity: 2 }],
      itemCount: 2,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
    });

    render(<App api={api} />);

    const row = (await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    })).closest('tr');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('闲鱼');
    expect(row).toHaveTextContent(summary.sellerAccount);
    expect(row).toHaveTextContent(`${summary.recipient}13800000000广东省深圳市南山区商务路88号`);
    expect(row).toHaveTextContent('限量测试商品商务黑2');
    expect(row).toHaveTextContent('已入库');
    expect(row).toHaveTextContent('已付款');
    expect(row).toHaveTextContent('待发货');
    expect(row).toHaveTextContent('正常');
  });

  it('系统订单总表按当前结果完整展开有序商品列组并让短订单尾列留空', async () => {
    const user = userEvent.setup();
    const multiItem = orderSummary(confirmedOrder, {
      id: 'order-multi-item',
      orderNumber: 'XY-MULTI-ITEM',
      items: [
        { sourceTitle: '海棠杯', sourceSpec: '红色', quantity: 2 },
        { sourceTitle: '海棠杯', sourceSpec: '蓝色', quantity: 1 },
      ],
      itemCount: 3,
    });
    const singleItem = orderSummary(confirmedOrder, {
      id: 'order-single-item',
      orderNumber: 'XY-SINGLE-ITEM',
      items: [{ sourceTitle: '杯盖', sourceSpec: '', quantity: 1 }],
      itemCount: 1,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [multiItem, singleItem],
      }),
      listOrders: vi.fn().mockResolvedValue([multiItem, singleItem]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([multiItem, singleItem])),
      previewOrderExport: vi.fn().mockResolvedValue({
        orderCount: 2,
        orderItemCount: null,
        sheets: [exportPreviewSheet('订单总表', [
          '系统订单编号', '订单号', '平台', '卖家账号', '买家', '收件人', '手机号',
          '收货地址', '商品1', '款式或规格1', '数量1', '商品2', '款式或规格2',
          '数量2', '商品总数量', '成交金额', '初始来源识别状态', '平台交易状态',
          '履约状态', '生命周期状态', '下单时间',
        ], [])],
      }),
    });

    render(<App api={api} />);

    const table = await screen.findByRole('table', { name: '原始订单' });
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers.slice(9, 15)).toEqual([
      '商品1', '款式或规格1', '数量1', '商品2', '款式或规格2', '数量2',
    ]);

    const multiRow = within(table).getByRole('button', { name: '查看订单 XY-MULTI-ITEM' })
      .closest('tr');
    expect(multiRow).not.toBeNull();
    expect(within(multiRow as HTMLTableRowElement).getAllByText('海棠杯')).toHaveLength(2);
    expect(multiRow).toHaveTextContent('海棠杯红色2海棠杯蓝色1');

    const singleRow = within(table).getByRole('button', { name: '查看订单 XY-SINGLE-ITEM' })
      .closest('tr');
    expect(singleRow).not.toBeNull();
    const singleCells = within(singleRow as HTMLTableRowElement).getAllByRole('cell');
    expect(singleCells.slice(12, 15).map((cell) => cell.textContent)).toEqual(['', '', '']);

    await user.click(screen.getByRole('button', { name: '导出当前结果 2 笔' }));
    const dialog = screen.getByRole('dialog', { name: '导出订单 Excel' });
    expect(within(dialog).getByRole('combobox', { name: '订单总表模板' })).toHaveValue('');
    const preview = await within(dialog).findByRole('table', { name: '订单总表导出预览' });
    const previewHeaders = within(preview).getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(previewHeaders).toEqual(headers.slice(1, -1));
    expect(previewHeaders).not.toContain('备注');
  });

  it('应用后动态表头与其他列冲突时在页面给出改名提示', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const template: TableTemplate = {
      id: 'template-dynamic-collision',
      name: '表头冲突模板',
      granularity: 'order',
      columns: [
        {
          kind: 'dynamic_product_group',
          labels: { product: '商品', specification: '款式或规格', quantity: '数量' },
        },
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '商品1' },
      ],
      query: {},
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      listTableTemplates: vi.fn().mockResolvedValue([template]),
    });

    render(<App api={api} />);
    const templateSelect = await screen.findByRole('combobox', { name: '表格模板' });
    await screen.findByRole('option', { name: template.name });
    await user.selectOptions(templateSelect, template.id);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '动态商品列组生成表头“商品1”与其他列冲突',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('请修改');
  });

  it('应用订单模板后用三个自定义基础表头重新编号动态商品列', async () => {
    const user = userEvent.setup();
    const summary = orderSummary(confirmedOrder, {
      items: [
        { sourceTitle: '海棠杯', sourceSpec: '红色', quantity: 2 },
        { sourceTitle: '杯盖', sourceSpec: '透明', quantity: 1 },
      ],
      itemCount: 3,
    });
    const template: TableTemplate = {
      id: 'template-dynamic-labels',
      name: '自定义商品表头',
      granularity: 'order',
      columns: [{
        kind: 'dynamic_product_group',
        labels: { product: '货品', specification: '属性', quantity: '件数' },
      }],
      query: {},
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      listTableTemplates: vi.fn().mockResolvedValue([template]),
    });

    render(<App api={api} />);
    const templateSelect = await screen.findByRole('combobox', { name: '表格模板' });
    await screen.findByRole('option', { name: template.name });
    await user.selectOptions(templateSelect, template.id);

    const table = await screen.findByRole('table', { name: '原始订单' });
    expect(within(table).getAllByRole('columnheader').slice(1, 7).map((cell) => cell.textContent))
      .toEqual(['货品1', '属性1', '件数1', '货品2', '属性2', '件数2']);
  });

  it('主搜索框可按买家和商品找到订单', async () => {
    const user = userEvent.setup();
    const first = orderSummary(confirmedOrder, {
      id: 'order-buyer-a',
      orderNumber: 'XY-BUYER-A',
      buyerNickname: '买家甲',
      items: [{ sourceTitle: '苹果商品', sourceSpec: '', quantity: 1 }],
    });
    const second = orderSummary(confirmedOrder, {
      id: 'order-buyer-b',
      orderNumber: 'XY-BUYER-B',
      buyerNickname: '买家乙',
      items: [{ sourceTitle: '香蕉商品', sourceSpec: '', quantity: 1 }],
    });
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.text === '买家乙' || query.text === '香蕉商品'
        ? workbenchResult([second], { activeOrderCount: 2 })
        : workbenchResult([first, second])
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [first, second],
      }),
      listOrders: vi.fn().mockResolvedValue([first, second]),
      queryOrders,
    });

    render(<App api={api} />);
    await screen.findByRole('button', { name: '查看订单 XY-BUYER-A' });

    await user.type(screen.getByRole('searchbox', { name: '搜索订单' }), '买家乙');

    expect(await screen.findByRole('button', { name: '查看订单 XY-BUYER-B' })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('button', {
      name: '查看订单 XY-BUYER-A',
    })).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('显示 1 / 2 笔');

    await user.clear(screen.getByRole('searchbox', { name: '搜索订单' }));
    await user.type(screen.getByRole('searchbox', { name: '搜索订单' }), '香蕉商品');
    expect(await screen.findByRole('button', { name: '查看订单 XY-BUYER-B' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '查看订单 XY-BUYER-A' })).not.toBeInTheDocument();
  });

  it('查询无匹配时保留查询区并可一键清除条件', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.text
        ? workbenchResult([], {
          activeOrderCount: 1,
          platforms: [summary.platform],
          sellerAccounts: [summary.sellerAccount],
        })
        : workbenchResult([summary])
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
    });

    render(<App api={api} />);
    await user.type(await screen.findByRole('searchbox', { name: '搜索订单' }), '不存在');

    expect(await screen.findByRole('heading', { name: '没有符合条件的订单' })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: '搜索订单' })).toHaveValue('不存在');
    await user.click(screen.getByRole('button', { name: '清除筛选' }));

    expect(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: '搜索订单' })).toHaveValue('');
  });

  it('只有回收站订单时仍展示查询工作台并可切换生命周期', async () => {
    const user = userEvent.setup();
    const trashed = orderSummary(confirmedOrder, {
      id: 'order-only-trashed',
      orderNumber: 'XY-ONLY-TRASHED',
      lifecycleStatus: 'trashed',
    });
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.lifecycleStatus === 'trashed'
        ? workbenchResult([trashed], { activeOrderCount: 0, allLifecycleOrderCount: 1 })
        : workbenchResult([], {
          activeOrderCount: 0,
          allLifecycleOrderCount: 1,
          platforms: [trashed.platform],
          sellerAccounts: [trashed.sellerAccount],
        })
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      queryOrders,
    });

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: '没有符合条件的订单' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '还没有订单' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('显示 0 / 1 笔');
    expect(screen.getByRole('region', { name: '订单概况' })).toHaveTextContent('在库订单0');

    await user.selectOptions(screen.getByRole('combobox', { name: '生命周期状态' }), 'trashed');

    expect(await screen.findByRole('button', { name: '查看订单 XY-ONLY-TRASHED' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('显示 1 / 1 笔');
  });

  it('可组合日期、平台卖家和四个状态筛选订单', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => {
      const matched = query.dateField === 'paid_at' &&
        query.dateFrom === '2026-07-01' &&
        query.dateTo === '2026-07-31' &&
        query.platform === 'xianyu' &&
        query.sellerAccount === summary.sellerAccount &&
        query.buyerText === summary.buyerNickname &&
        query.productText === summary.items[0].sourceTitle &&
        query.initialSourceRecognitionStatus === 'imported' &&
        query.platformTransactionStatus === 'paid' &&
        query.fulfillmentStatus === 'pending_shipment' &&
        query.lifecycleStatus === 'active';
      return workbenchResult(matched ? [summary] : [], {
        activeOrderCount: 1,
        platforms: ['xianyu'],
        sellerAccounts: [summary.sellerAccount],
      });
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
    });

    render(<App api={api} />);
    await screen.findByRole('region', { name: '订单查询' });

    await user.selectOptions(screen.getByRole('combobox', { name: '日期字段' }), 'paid_at');
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-31' } });
    await user.selectOptions(screen.getByRole('combobox', { name: '平台' }), 'xianyu');
    await user.selectOptions(screen.getByRole('combobox', { name: '卖家账号' }), summary.sellerAccount);
    await user.type(screen.getByRole('textbox', { name: '买家' }), summary.buyerNickname);
    await user.type(screen.getByRole('textbox', { name: '商品' }), summary.items[0].sourceTitle);
    await user.selectOptions(screen.getByRole('combobox', { name: '初始来源识别状态' }), 'imported');
    await user.selectOptions(screen.getByRole('combobox', { name: '平台交易状态' }), 'paid');
    await user.selectOptions(screen.getByRole('combobox', { name: '履约状态' }), 'pending_shipment');
    await user.selectOptions(screen.getByRole('combobox', { name: '生命周期状态' }), 'active');

    expect(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('显示 1 / 1 笔');
  });

  it('履约状态筛选可以选择部分发货和已收货且不再提供整单已退货', async () => {
    const summary = orderSummary();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
    });

    render(<App api={api} />);

    const fulfillmentFilter = await screen.findByRole('combobox', { name: '履约状态' });
    expect(within(fulfillmentFilter).getByRole('option', { name: '部分发货' }))
      .toHaveValue('partially_shipped');
    expect(within(fulfillmentFilter).getByRole('option', { name: '已收货' }))
      .toHaveValue('delivered');
    expect(within(fulfillmentFilter).queryByRole('option', { name: '已退货' }))
      .not.toBeInTheDocument();
  });

  it('选择商品升序后表格按查询结果顺序呈现', async () => {
    const user = userEvent.setup();
    const zOrder = orderSummary(confirmedOrder, {
      id: 'order-product-z',
      orderNumber: 'XY-PRODUCT-Z',
      items: [{ sourceTitle: 'Zeta 商品', sourceSpec: '', quantity: 1 }],
    });
    const aOrder = orderSummary(confirmedOrder, {
      id: 'order-product-a',
      orderNumber: 'XY-PRODUCT-A',
      items: [{ sourceTitle: 'Alpha 商品', sourceSpec: '', quantity: 1 }],
    });
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.sortField === 'product' && query.sortDirection === 'asc'
        ? workbenchResult([aOrder, zOrder])
        : workbenchResult([zOrder, aOrder])
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [zOrder, aOrder],
      }),
      listOrders: vi.fn().mockResolvedValue([zOrder, aOrder]),
      queryOrders,
    });

    render(<App api={api} />);
    const table = await screen.findByRole('table', { name: '原始订单' });
    await user.selectOptions(screen.getByRole('combobox', { name: '排序方式' }), 'product:asc');

    await waitFor(() => expect(
      within(table).getAllByRole('button', { name: /查看订单/u })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['查看订单 XY-PRODUCT-A', '查看订单 XY-PRODUCT-Z']));
  });

  it('较晚返回的旧筛选响应不会覆盖较新的查询结果', async () => {
    let finishOldQuery!: (result: OrderWorkbenchResult) => void;
    const oldQuery = new Promise<OrderWorkbenchResult>((resolve) => {
      finishOldQuery = resolve;
    });
    const initial = orderSummary(confirmedOrder, {
      id: 'order-query-initial',
      orderNumber: 'XY-QUERY-INITIAL',
    });
    const stale = orderSummary(confirmedOrder, {
      id: 'order-query-stale',
      orderNumber: 'XY-QUERY-STALE',
    });
    const latest = orderSummary(confirmedOrder, {
      id: 'order-query-latest',
      orderNumber: 'XY-QUERY-LATEST',
    });
    const queryOrders = vi.fn((query: OrderWorkbenchQuery) => {
      if (query.text === '旧查询') return oldQuery;
      if (query.text === '新查询') return Promise.resolve(workbenchResult([latest]));
      return Promise.resolve(workbenchResult([initial]));
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [initial],
      }),
      queryOrders,
    });

    render(<App api={api} />);
    const search = await screen.findByRole('searchbox', { name: '搜索订单' });
    await screen.findByRole('button', { name: '查看订单 XY-QUERY-INITIAL' });

    fireEvent.change(search, { target: { value: '旧查询' } });
    await waitFor(() => expect(queryOrders).toHaveBeenCalledWith(expect.objectContaining({
      text: '旧查询',
    }), []));
    fireEvent.change(search, { target: { value: '新查询' } });

    expect(await screen.findByRole('button', { name: '查看订单 XY-QUERY-LATEST' })).toBeVisible();
    await act(async () => finishOldQuery(workbenchResult([stale])));

    expect(screen.getByRole('button', { name: '查看订单 XY-QUERY-LATEST' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '查看订单 XY-QUERY-STALE' })).not.toBeInTheDocument();
  });

  it('从查询结果打开详情再返回时保留原条件', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.text === summary.buyerNickname
        ? workbenchResult([summary])
        : workbenchResult([summary])
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);
    await user.type(await screen.findByRole('searchbox', { name: '搜索订单' }), summary.buyerNickname);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    }));
    await user.click(await screen.findByRole('button', { name: '返回订单表' }));

    expect(await screen.findByRole('searchbox', { name: '搜索订单' })).toHaveValue(summary.buyerNickname);
    expect(screen.getByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    })).toBeVisible();
  });

  it('有订单时直接展示主表，并可查看带来源截图的订单详情', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [orderSummary()],
      }),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
    });

    render(<App api={api} />);

    expect(await screen.findByRole('table', { name: '原始订单' })).toBeVisible();
    expect(screen.getByText(
      '截图会发送至您配置的阿里云百炼，原图仍保存在本机。每张截图调用 1 次 advanced_recognition，并由本机规则按六区拆分字段；有有限候选且已启用候选裁决时，最多追加 1 次文本模型调用。无法确定时会转入人工确认。',
    )).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: `查看订单 ${confirmedOrder.orderNumber}` }),
    );

    expect(await screen.findByRole('heading', { name: '订单详情' })).toBeVisible();
    expect(screen.getByText('脱敏测试订单.png', { selector: 'figcaption span' })).toBeVisible();
    expect(screen.getByRole('img', { name: '来源截图' })).toHaveAttribute(
      'src',
      'data:image/png;base64,ZGV0YWls',
    );
  });

  it('选中多笔订单后只能批量设置平台交易状态', async () => {
    const user = userEvent.setup();
    const first = orderSummary(confirmedOrder, { revision: 1 });
    const secondOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-2',
      orderNumber: 'XY-TEST-20260727-0002',
      revision: 3,
    };
    const second = orderSummary(secondOrder, { revision: 3 });
    const updateOrderPlatformTransactionStatus = vi.fn().mockResolvedValue([]);
    const queryOrders = vi.fn().mockResolvedValue(workbenchResult([first, second]));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [first, second],
      }),
      listOrders: vi.fn().mockResolvedValue([first, second]),
      queryOrders,
      updateOrderPlatformTransactionStatus,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('checkbox', { name: '选择当前结果全部订单' }));
    await user.click(screen.getByRole('button', { name: '修改已选 2 笔交易状态' }));

    const dialog = screen.getByRole('dialog', { name: '维护平台交易状态' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '平台交易状态' }), 'refunded');
    await user.click(within(dialog).getByRole('button', { name: '确认修改 2 笔' }));

    expect(updateOrderPlatformTransactionStatus).toHaveBeenCalledWith({
      targets: [
        { orderId: first.id, expectedRevision: 1 },
        { orderId: second.id, expectedRevision: 3 },
      ],
      patch: { platformTransactionStatus: 'refunded' },
    });
    expect(screen.queryByRole('dialog', { name: '维护平台交易状态' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '平台交易状态维护结果' }))
      .toHaveTextContent('已更新 2 笔订单');
    expect(screen.queryByRole('button', { name: '修改已选 2 笔交易状态' }))
      .not.toBeInTheDocument();
    await waitFor(() => expect(queryOrders).toHaveBeenCalledTimes(2));
  });

  it('平台交易状态弹窗不暴露履约与订单物流编辑，并说明事实驱动边界', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `维护订单平台交易状态 ${summary.orderNumber}`,
    }));

    const dialog = screen.getByRole('dialog', { name: '维护平台交易状态' });
    expect(within(dialog).queryByRole('combobox', { name: '履约状态' }))
      .not.toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: '快递公司' }))
      .not.toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: '运单号' }))
      .not.toBeInTheDocument();
    expect(dialog).toHaveTextContent('履约状态由发货记录、包裹商品数量和包裹物流自动计算');
    expect(dialog).toHaveTextContent('平台交易状态不会参与履约计算');
  });

  it('批量修改平台交易状态后刷新列表展示后端最终值', async () => {
    const user = userEvent.setup();
    const first = orderSummary(confirmedOrder, { revision: 1 });
    const secondOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-status-final-2',
      orderNumber: 'XY-STATUS-FINAL-0002',
      revision: 4,
    };
    const second = orderSummary(secondOrder, { revision: 4 });
    const refundedFirstOrder: OriginalOrder = {
      ...confirmedOrder,
      revision: 2,
      platformTransactionStatus: 'refunded',
    };
    const refundedSecondOrder: OriginalOrder = {
      ...secondOrder,
      revision: 5,
      platformTransactionStatus: 'refunded',
    };
    let updated = false;
    const queryOrders = vi.fn(async () => workbenchResult(updated
      ? [orderSummary(refundedFirstOrder), orderSummary(refundedSecondOrder)]
      : [first, second]));
    const updateOrderPlatformTransactionStatus = vi.fn(async () => {
      updated = true;
      return [
        { ...orderDetails, order: refundedFirstOrder },
        { ...orderDetails, order: refundedSecondOrder },
      ];
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [first, second],
      }),
      queryOrders,
      updateOrderPlatformTransactionStatus,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('checkbox', { name: '选择当前结果全部订单' }));
    await user.click(screen.getByRole('button', { name: '修改已选 2 笔交易状态' }));

    const dialog = screen.getByRole('dialog', { name: '维护平台交易状态' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '平台交易状态' }),
      'refunded',
    );
    await user.click(within(dialog).getByRole('button', { name: '确认修改 2 笔' }));

    expect(updateOrderPlatformTransactionStatus).toHaveBeenCalledWith({
      targets: [
        { orderId: first.id, expectedRevision: 1 },
        { orderId: second.id, expectedRevision: 4 },
      ],
      patch: { platformTransactionStatus: 'refunded' },
    });
    const table = await screen.findByRole('table', { name: '原始订单' });
    await waitFor(() => expect(within(table).getAllByText('已退款')).toHaveLength(2));
  });

  it('订单详情只维护平台交易状态，不展示已停用的订单级物流', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const updatedOrder: OriginalOrder = {
      ...confirmedOrder,
      revision: 2,
      platformTransactionStatus: 'cancelled',
    };
    const updatedDetails: OrderDetails = {
      ...orderDetails,
      order: updatedOrder,
    };
    const updateOrderPlatformTransactionStatus = vi.fn().mockResolvedValue([updatedDetails]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
      updateOrderPlatformTransactionStatus,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    }));
    await user.click(await screen.findByRole('button', { name: '交易状态' }));

    const dialog = screen.getByRole('dialog', { name: '维护平台交易状态' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '平台交易状态' }),
      'cancelled',
    );
    await user.click(within(dialog).getByRole('button', { name: '确认修改 1 笔' }));

    expect(updateOrderPlatformTransactionStatus).toHaveBeenCalledWith({
      targets: [{ orderId: confirmedOrder.id, expectedRevision: 1 }],
      patch: { platformTransactionStatus: 'cancelled' },
    });
    expect(screen.getByText('已取消 · 待发货')).toBeVisible();
    expect(screen.queryByRole('region', { name: '历史订单级物流' })).toBeNull();
  });

  it('没有关联发货记录时可从订单详情直接进入发货组处理事实', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const queryShipmentGroups = vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] });
    const queryShipmentGroupArchives = vi.fn().mockResolvedValue([]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
      queryShipmentGroups,
      queryShipmentGroupArchives,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    }));
    const shipmentSection = await screen.findByRole('region', {
      name: '关联发货与包裹物流',
    });
    await user.click(within(shipmentSection).getByRole('button', { name: '前往发货组' }));

    expect(await screen.findByRole('heading', { level: 1, name: '发货组' })).toBeVisible();
    expect(queryShipmentGroups).toHaveBeenCalled();
    expect(queryShipmentGroupArchives).toHaveBeenCalled();
  });

  it('订单详情展示完整当前值与真实状态，不暴露 OCR 原始响应', async () => {
    const user = userEvent.setup();
    const detailedOrder: OriginalOrder = {
      ...confirmedOrder,
      alipayTransactionNumber: 'ALI-DETAIL-20260727',
      addressNormalized: '广东省深圳市南山区科技路2号',
      orderedAtOriginal: '2026-07-27 11:21:46',
      orderedAtNormalized: '2026-07-27T11:21:46+08:00',
      paidAtOriginal: '2026-07-27 11:21:54',
      paidAtNormalized: '2026-07-27T11:21:54+08:00',
      productTotalCents: 1_800,
      shippingFeeCents: 200,
      amountCents: 2_000,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
    };
    const detailsWithEvidence = {
      ...orderDetails,
      order: detailedOrder,
      sourceSnapshot: {
        ...orderDetails.sourceSnapshot,
        rawResponse: 'SECRET_RAW_OCR_RESPONSE',
      },
    } as OrderDetails;
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [orderSummary(detailedOrder)],
      }),
      getOrder: vi.fn().mockResolvedValue(detailsWithEvidence),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
      listOrders: vi.fn().mockResolvedValue([orderSummary(detailedOrder)]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary(detailedOrder)])),
    });

    render(<App api={api} />);
    const orderTable = await screen.findByRole('table', { name: '原始订单' });
    expect(orderTable).toHaveTextContent('已退款');
    expect(orderTable).toHaveTextContent('已发货');
    await user.click(await screen.findByRole('button', { name: `查看订单 ${detailedOrder.orderNumber}` }));

    const detailPage = (await screen.findByRole('heading', { name: '订单详情' })).closest('section');
    expect(detailPage).not.toBeNull();
    expect(detailPage).toHaveTextContent(detailedOrder.systemOrderNumber);
    expect(detailPage).toHaveTextContent('闲鱼');
    expect(detailPage).toHaveTextContent('ALI-DETAIL-20260727');
    expect(detailPage).toHaveTextContent('已退款 · 已发货');
    expect(detailPage).toHaveTextContent('商品总价¥18.00');
    expect(detailPage).toHaveTextContent('运费¥2.00');
    expect(detailPage).toHaveTextContent('成交金额¥20.00');
    expect(detailPage).toHaveTextContent('2026-07-27 11:21:46');
    expect(detailPage).toHaveTextContent('2026-07-27T11:21:54+08:00');
    expect(detailPage).toHaveTextContent('广东省深圳市南山区科技路2号');
    expect(detailPage).not.toHaveTextContent('SECRET_RAW_OCR_RESPONSE');
  });

  it('订单详情分别呈现四个状态和完整收件信息', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    }));

    const statuses = await screen.findByRole('region', { name: '订单状态' });
    expect(statuses).toHaveTextContent('当前来源识别状态已入库');
    expect(statuses).toHaveTextContent('平台交易状态已付款');
    expect(statuses).toHaveTextContent('履约状态待发货');
    expect(statuses).toHaveTextContent('生命周期状态正常');

    const recipientSection = screen.getByRole('heading', { name: '收货信息' }).closest('section');
    expect(recipientSection).toHaveTextContent(confirmedOrder.recipient);
    expect(recipientSection).toHaveTextContent(confirmedOrder.phone);
    expect(recipientSection).toHaveTextContent(confirmedOrder.addressOriginal);
  });

  it('订单详情分区展示关联包裹物流和售后并定位到对应处理单', async () => {
    const user = userEvent.setup();
    const projection = singleShipmentGroupProjection();
    const archive = shipmentArchiveForGroup(projection.groups[0]);
    const record = archive.records[0];
    const shipmentPackage = record.packages[0];
    const aftersalesCase: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-order-detail-1',
      shipmentRecordId: record.id,
      workflow: 'general',
      status: 'waiting_return',
      revision: 1,
      reason: '商品表面破损，需要退回检查',
      occurredAt: '2026-08-13T18:30:00+08:00',
      items: [{
        id: 'aftersales-order-detail-item-1',
        shipmentPackageItemId: shipmentPackage.items[0].id,
        packageId: shipmentPackage.id,
        orderId: confirmedOrder.id,
        orderItemId: confirmedOrder.items[0].id,
        orderNumber: confirmedOrder.orderNumber,
        sourceTitle: confirmedOrder.items[0].sourceTitle,
        sourceSpec: confirmedOrder.items[0].sourceSpec,
        quantity: 1,
        sourceShippedQuantity: 2,
      }],
      refund: null,
      returns: [],
      coordination: testAftersalesCoordination(),
      timeline: [],
      createdAt: '2026-08-13T10:30:00.000Z',
      updatedAt: '2026-08-13T10:30:00.000Z',
    };
    const operationalDetails: OrderDetails = {
      ...orderDetails,
      operations: {
        shipmentRecords: [{
          id: record.id,
          archiveId: record.archiveId,
          sourceRole: 'initial',
          replacementAftersalesCaseId: null,
          status: 'active',
          createdAt: record.createdAt,
          packages: [{
            id: shipmentPackage.id,
            position: 0,
            status: 'active',
            logisticsStatus: 'in_transit',
            updatedAt: record.createdAt,
            shippingCarrier: '顺丰速运',
            trackingNumber: 'SF1000000020',
            cancellationReason: null,
            currentException: null,
            logisticsExceptions: [],
            carrierClaimStatus: null,
            carrierClaimUpdatedAt: null,
            items: [{
              shipmentPackageItemId: shipmentPackage.items[0].id,
              orderItemId: confirmedOrder.items[0].id,
              sourceTitle: confirmedOrder.items[0].sourceTitle,
              sourceSpec: confirmedOrder.items[0].sourceSpec,
              quantity: 2,
            }],
          }],
        }],
        aftersalesCases: [{
          id: aftersalesCase.id,
          shipmentRecordId: record.id,
          status: 'waiting_return',
          reason: aftersalesCase.reason,
          occurredAt: aftersalesCase.occurredAt,
          updatedAt: aftersalesCase.updatedAt,
          currentTodo: '等待买家退回',
          refund: null,
          items: [{
            shipmentPackageItemId: shipmentPackage.items[0].id,
            packageId: shipmentPackage.id,
            orderItemId: confirmedOrder.items[0].id,
            sourceTitle: confirmedOrder.items[0].sourceTitle,
            sourceSpec: confirmedOrder.items[0].sourceSpec,
            quantity: 1,
          }],
          returnPackages: [{
            id: 'return-package-order-detail',
            status: 'inspected',
            shippingCarrier: '圆通速递',
            trackingNumber: 'YT-CORRECTED-ORDER-DETAIL',
            logisticsStatus: 'delivered',
            updatedAt: '2026-08-13T11:00:00+08:00',
            currentException: {
              id: 'exception-return-1',
              direction: 'return',
              exceptionType: 'delivery_dispute',
              stage: 'confirmed',
              affectedQuantity: 1,
              affectedItems: [{
                sourceTitle: '脱敏测试商品',
                sourceSpec: '白色',
                quantity: 1,
              }],
              reason: '退货包裹显示签收，但仓库未收到完整商品',
              occurredAt: '2026-08-13T11:00:00+08:00',
            },
            logisticsExceptions: [{
              id: 'exception-return-1',
              direction: 'return',
              exceptionType: 'delivery_dispute',
              stage: 'confirmed',
              affectedQuantity: 1,
              affectedItems: [{
                sourceTitle: '脱敏测试商品',
                sourceSpec: '白色',
                quantity: 1,
              }],
              reason: '退货包裹显示签收，但仓库未收到完整商品',
              occurredAt: '2026-08-13T11:00:00+08:00',
            }],
            discrepancies: [{ kind: 'missing', quantity: 1, note: '签收后清点少一件' }],
            carrierClaimStatus: 'pending',
            carrierClaimUpdatedAt: '2026-08-13T11:00:00+08:00',
            items: [{
              shipmentPackageItemId: shipmentPackage.items[0].id,
              sourceTitle: confirmedOrder.items[0].sourceTitle,
              sourceSpec: confirmedOrder.items[0].sourceSpec,
              plannedQuantity: 2,
              receivedQuantity: 1,
              acceptedQuantity: 0,
            }],
          }],
        }],
        currentTodo: '等待买家退回',
        coordination: {
          primaryTodo: {
            id: 'todo-return-exception',
            priority: 'physical_risk',
            title: '处理退货物流异常',
            detail: '退货包裹·影响 1 件商品',
            occurredAt: '2026-08-13T11:00:00+08:00',
            target: {
              kind: 'aftersales_case',
              shipmentRecordId: record.id,
              aftersalesCaseId: aftersalesCase.id,
              returnRecordId: 'return-package-order-detail',
            },
          },
          secondaryTodoCount: 1,
          todos: [{
            id: 'todo-return-exception',
            priority: 'physical_risk',
            title: '处理退货物流异常',
            detail: '退货包裹·影响 1 件商品',
            occurredAt: '2026-08-13T11:00:00+08:00',
            target: {
              kind: 'aftersales_case',
              shipmentRecordId: record.id,
              aftersalesCaseId: aftersalesCase.id,
              returnRecordId: 'return-package-order-detail',
            },
          }, {
            id: 'todo-outbound-follow-up',
            priority: 'follow_up',
            title: '跟进运输进度',
            detail: '正向包裹·2 件商品',
            occurredAt: record.createdAt,
            target: {
              kind: 'shipment_record',
              shipmentRecordId: record.id,
              packageId: shipmentPackage.id,
            },
          }],
        },
        risks: [{
          id: 'risk-return-exception',
          kind: 'logistics_exception',
          packageRole: 'return',
          exceptionType: 'delivery_dispute',
          affectedQuantity: 1,
          items: [{
            sourceTitle: '脱敏测试商品',
            sourceSpec: '白色',
            quantity: 1,
          }],
          title: '退货物流异常',
          detail: '显示签收，但仓库未收到',
          occurredAt: '2026-08-13T11:00:00+08:00',
          target: {
            kind: 'aftersales_case',
            shipmentRecordId: record.id,
            aftersalesCaseId: aftersalesCase.id,
            returnRecordId: 'return-package-order-detail',
          },
        }],
        facts: [{
          id: 'fact-outbound',
          kind: 'outbound_logistics',
          label: '正向物流',
          value: 'in_transit',
          detail: '顺丰速运 · SF1000000020',
          affectedQuantity: 2,
          occurredAt: record.createdAt,
          target: { kind: 'shipment_record', shipmentRecordId: record.id },
        }, {
          id: 'fact-aftersales',
          kind: 'aftersales',
          label: '售后处理',
          value: 'waiting_return',
          detail: aftersalesCase.reason,
          affectedQuantity: 1,
          occurredAt: aftersalesCase.occurredAt,
          target: {
            kind: 'aftersales_case',
            shipmentRecordId: record.id,
            aftersalesCaseId: aftersalesCase.id,
          },
        }],
        history: [{
          id: 'history-shipment',
          kind: 'shipment',
          title: '建立发货记录',
          detail: '实际发货事实已建立',
          occurredAt: record.createdAt,
          target: { kind: 'shipment_record', shipmentRecordId: record.id },
        }],
      },
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [orderSummary()],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      getOrder: vi.fn().mockResolvedValue(operationalDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([aftersalesCase]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    }));

    expect(screen.queryByRole('region', { name: '历史订单级物流' })).toBeNull();
    const coordination = screen.getByRole('region', { name: '订单当前处理' });
    expect(coordination).toHaveTextContent('处理退货物流异常');
    expect(coordination).toHaveTextContent('另有 1 项');
    expect(coordination).toHaveTextContent('退货物流异常');
    expect(coordination).toHaveTextContent('签收争议');
    expect(coordination).toHaveTextContent('脱敏测试商品 · 白色 × 1');
    expect(coordination).toHaveTextContent('影响 1 件');
    expect(coordination).toHaveTextContent('正向物流');
    expect(coordination).toHaveTextContent('售后处理');
    expect(within(coordination).getByText('建立发货记录')).not.toBeVisible();
    await user.click(within(coordination).getByRole('button', { name: '展开完整历史' }));
    expect(within(coordination).getByText('建立发货记录')).toBeVisible();
    const shipmentSection = screen.getByRole('region', { name: '关联发货与包裹物流' });
    expect(shipmentSection).toHaveTextContent('顺丰速运');
    expect(shipmentSection).toHaveTextContent('SF1000000020');
    expect(shipmentSection).toHaveTextContent('运输中');
    expect(shipmentSection).toHaveTextContent('脱敏测试商品');
    expect(shipmentSection).toHaveTextContent('白色 · × 2');
    const aftersalesSection = screen.getByRole('region', { name: '关联售后处理' });
    expect(aftersalesSection).toHaveTextContent('等待退回');
    expect(aftersalesSection).toHaveTextContent('商品表面破损，需要退回检查');
    expect(aftersalesSection).toHaveTextContent(/当前待办\s*等待买家退回/u);
    expect(aftersalesSection).toHaveTextContent('圆通速递 · YT-CORRECTED-ORDER-DETAIL');
    expect(aftersalesSection).toHaveTextContent('签收争议');
    expect(aftersalesSection).toHaveTextContent('退货物流异常 · 签收争议');
    expect(aftersalesSection).toHaveTextContent('影响 1 件');
    expect(aftersalesSection).toHaveTextContent('退货包裹显示签收，但仓库未收到完整商品');
    expect(aftersalesSection).toHaveTextContent('计划 2 · 收到 1 · 通过 0');
    expect(aftersalesSection).toHaveTextContent('退货差异：少件 1 件 · 签收后清点少一件');
    expect(aftersalesSection).toHaveTextContent(
      '数量差异：脱敏测试商品 · 白色：计划与收到相差 1 件；脱敏测试商品 · 白色：收到与检查通过相差 1 件',
    );
    expect(aftersalesSection).toHaveTextContent('承运索赔：处理中');
    expect(within(shipmentSection).getByRole('button', { name: '定位发货记录' })).toBeVisible();

    await user.click(within(coordination).getByRole('button', { name: '去处理' }));
    const focusedCase = await screen.findByRole('region', {
      name: `售后处理单 ${aftersalesCase.id}`,
    });
    expect(focusedCase).toHaveClass('is-focused');
    await waitFor(() => expect(focusedCase).toHaveFocus());
  });

  it('订单详情可切换查看全部来源截图并查看字段级修改记录', async () => {
    const user = userEvent.setup();
    const earlierScreenshot = {
      ...sourceScreenshot,
      id: 'shot-earlier-source',
      originalName: '首次订单截图.png',
      sha256: 'earlier-source-hash',
      createdAt: '2026-07-27T11:22:00.000Z',
    };
    const earlierSnapshot = {
      ...sourceSnapshot,
      id: 'snapshot-earlier-source',
      createdAt: earlierScreenshot.createdAt,
      confirmed: { ...draft, fulfillmentStatus: 'pending_shipment' as const },
    };
    const latestScreenshot = {
      ...sourceScreenshot,
      id: 'shot-latest-source',
      originalName: '更新订单截图.png',
      sha256: 'latest-source-hash',
      createdAt: '2026-07-27T11:40:00.000Z',
    };
    const latestSnapshot = {
      ...sourceSnapshot,
      id: 'snapshot-latest-source',
      createdAt: latestScreenshot.createdAt,
    };
    const detailsWithHistory: OrderDetails = {
      ...orderDetails,
      sourceScreenshot: latestScreenshot,
      sourceSnapshot: latestSnapshot,
      sources: [
        {
          recognitionStatus: 'imported',
          sourceScreenshot: latestScreenshot,
          sourceSnapshot: latestSnapshot,
        },
        {
          recognitionStatus: 'duplicate_skipped',
          sourceScreenshot: earlierScreenshot,
          sourceSnapshot: earlierSnapshot,
        },
      ],
      changeEvents: [{
        id: 'event-source-update',
        sourceSnapshotId: latestSnapshot.id,
        source: 'source_update',
        baseRevision: 1,
        resultRevision: 2,
        createdAt: '2026-07-27T11:41:00.000Z',
        changes: [
          {
            path: 'recipient',
            before: '首次收件人',
            after: confirmedOrder.recipient,
          },
          {
            path: 'items.removed[0]',
            before: {
              sourceTitle: '旧商品',
              sourceSpec: '旧规格',
              unitPriceCents: 600,
              quantity: 1,
              quantityInferred: false,
            },
            after: null,
          },
        ],
      }],
    };
    const getScreenshotDataUrl = vi.fn(async (screenshotId: string) => (
      screenshotId === earlierScreenshot.id
        ? 'data:image/png;base64,ZWFybGllcg=='
        : 'data:image/png;base64,bGF0ZXN0'
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [orderSummary()],
      }),
      getOrder: vi.fn().mockResolvedValue(detailsWithHistory),
      getScreenshotDataUrl,
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: `查看订单 ${confirmedOrder.orderNumber}` }));

    const history = await screen.findByRole('region', { name: '来源与修改记录' });
    expect(history).toHaveTextContent('2 份来源 · 1 次更新');
    expect(history).toHaveTextContent('更新订单截图.png');
    expect(history).toHaveTextContent('首次订单截图.png');
    expect(history).toHaveTextContent('v1 → v2');
    expect(history).toHaveTextContent(`收件人首次收件人→${confirmedOrder.recipient}`);
    expect(history).toHaveTextContent('原商品 1 · 已移除');
    expect(within(history).getByRole('button', {
      name: '查看修改来源 更新订单截图.png',
    })).toBeVisible();

    await user.click(within(history).getByRole('button', { name: '查看来源 首次订单截图.png' }));

    await waitFor(() => expect(screen.getByRole('img', { name: '来源截图' })).toHaveAttribute(
      'src',
      'data:image/png;base64,ZWFybGllcg==',
    ));
    expect(screen.getByText('首次订单截图.png', { selector: 'figcaption span' })).toBeVisible();
    expect(screen.getByRole('region', { name: '订单状态' }))
      .toHaveTextContent('当前来源识别状态重复跳过');
    expect(screen.queryByText(/已在本次来源确认时修正/)).not.toBeInTheDocument();
  });

  it('订单列表、详情和修改记录正确显示由发货同步产生的已收货', async () => {
    const user = userEvent.setup();
    const deliveredOrder: OriginalOrder = {
      ...confirmedOrder,
      revision: 3,
      fulfillmentStatus: 'delivered',
    };
    const deliveredDetails: OrderDetails = {
      ...orderDetails,
      order: deliveredOrder,
      changeEvents: [{
        id: 'event-delivered',
        sourceSnapshotId: null,
        source: 'shipment_sync',
        baseRevision: 2,
        resultRevision: 3,
        createdAt: '2026-07-27T12:00:00.000Z',
        changes: [{
          path: 'fulfillmentStatus',
          before: 'shipped',
          after: 'delivered',
        }],
      }],
    };
    const summary = orderSummary(deliveredOrder);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue(deliveredDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);

    const table = await screen.findByRole('table', { name: '原始订单' });
    expect(table).toHaveTextContent('已收货');
    expect(table).not.toHaveTextContent('未知');
    await user.click(within(table).getByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    }));

    expect(await screen.findByText('已付款 · 已收货')).toBeVisible();
    const history = screen.getByRole('region', { name: '来源与修改记录' });
    expect(history).toHaveTextContent('履约状态已发货→已收货');
  });

  it('订单列表与详情把发货同步的部分发货状态明确标注出来', async () => {
    const user = userEvent.setup();
    const partiallyShippedOrder: OriginalOrder = {
      ...confirmedOrder,
      revision: 2,
      fulfillmentStatus: 'partially_shipped',
    };
    const partiallyShippedDetails: OrderDetails = {
      ...orderDetails,
      order: partiallyShippedOrder,
      changeEvents: [{
        id: 'event-partially-shipped',
        sourceSnapshotId: null,
        source: 'shipment_sync',
        baseRevision: 1,
        resultRevision: 2,
        createdAt: '2026-07-27T12:00:00.000Z',
        changes: [{
          path: 'fulfillmentStatus',
          before: 'pending_shipment',
          after: 'partially_shipped',
        }],
      }],
    };
    const summary = orderSummary(partiallyShippedOrder);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue(partiallyShippedDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);

    const table = await screen.findByRole('table', { name: '原始订单' });
    expect(table).toHaveTextContent('部分发货');
    await user.click(within(table).getByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    }));

    expect(await screen.findByText('已付款 · 部分发货')).toBeVisible();
    const history = screen.getByRole('region', { name: '来源与修改记录' });
    expect(history).toHaveTextContent('发货同步');
    expect(history).toHaveTextContent('履约状态待发货→部分发货');
  });

  it('从订单详情显式编辑普通字段与多商品，预览差异后才保存', async () => {
    const user = userEvent.setup();
    const secondItem = {
      ...confirmedOrder.items[0],
      id: 'item-2',
      position: 1,
      sourceTitle: '待删除商品',
      sourceSpec: '旧规格',
    };
    const editableOrder: OriginalOrder = {
      ...confirmedOrder,
      note: '原备注',
      revision: 3,
      items: [confirmedOrder.items[0], secondItem],
    };
    const itemBusinessField: CustomFieldDefinition = {
      id: 'field-item-sku',
      name: '仓库货号',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
      createdAt: editableOrder.createdAt,
      updatedAt: editableOrder.updatedAt,
    };
    const editableDetails: OrderDetails = {
      ...orderDetails,
      order: editableOrder,
      lastManualEditAt: null,
      customFieldDefinitions: [itemBusinessField],
      customFieldValues: [{
        definitionId: itemBusinessField.id,
        orderId: null,
        orderItemId: secondItem.id,
        value: 'SKU-DELETED-02',
        createdAt: editableOrder.createdAt,
        updatedAt: editableOrder.updatedAt,
      }],
    };
    const savedOrder: OriginalOrder = {
      ...editableOrder,
      revision: 4,
      sellerAccount: '更正后卖家',
      recipient: '新收件人',
      note: '人工核对完成',
      items: [
        { ...editableOrder.items[0], sourceTitle: '已修改商品' },
        {
          ...editableOrder.items[0],
          id: 'item-new-saved',
          position: 1,
          sourceTitle: '新增商品',
          sourceSpec: '新规格',
          unitPriceCents: 1_250,
          quantity: 2,
          subtotalCents: 2_500,
        },
      ],
    };
    const savedDetails: OrderDetails = {
      ...editableDetails,
      order: savedOrder,
      lastManualEditAt: '2026-07-31T08:30:00.000Z',
    };
    const updateOrder = vi.fn().mockResolvedValue(savedDetails);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [orderSummary(editableOrder)],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary(editableOrder)]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary(editableOrder)])),
      getOrder: vi.fn().mockResolvedValue(editableDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });
    Object.assign(api, { updateOrder });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: `查看订单 ${editableOrder.orderNumber}` }));
    await user.click(await screen.findByRole('button', { name: '编辑订单' }));

    expect(screen.getByRole('textbox', { name: '卖家账号' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '订单号' })).toBeDisabled();
    expect(screen.queryByRole('combobox', { name: '平台交易状态' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '履约状态' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '更正订单身份' }));
    expect(screen.getByRole('textbox', { name: '卖家账号' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: '订单号' })).toBeEnabled();
    await user.clear(screen.getByRole('textbox', { name: '卖家账号' }));
    await user.type(screen.getByRole('textbox', { name: '卖家账号' }), '更正后卖家');

    await user.clear(screen.getByRole('textbox', { name: '收件人' }));
    await user.type(screen.getByRole('textbox', { name: '收件人' }), '新收件人');
    await user.clear(screen.getByRole('textbox', { name: '备注' }));
    await user.type(screen.getByRole('textbox', { name: '备注' }), '人工核对完成');
    await user.clear(screen.getByRole('textbox', { name: '商品 1 标题' }));
    await user.type(screen.getByRole('textbox', { name: '商品 1 标题' }), '已修改商品');
    await user.click(screen.getByRole('button', { name: '删除商品 2' }));
    await user.click(screen.getByRole('button', { name: '添加商品' }));
    await user.type(screen.getByRole('textbox', { name: '商品 2 标题' }), '新增商品');
    await user.type(screen.getByRole('textbox', { name: '商品 2 规格' }), '新规格');
    await user.clear(screen.getByRole('spinbutton', { name: '商品 2 单价' }));
    await user.type(screen.getByRole('spinbutton', { name: '商品 2 单价' }), '12.50');
    await user.clear(screen.getByRole('spinbutton', { name: '商品 2 数量' }));
    await user.type(screen.getByRole('spinbutton', { name: '商品 2 数量' }), '2');
    await user.type(screen.getByRole('textbox', { name: '仓库货号' }), 'SKU-NEW-02');

    const previewButton = screen.getByRole('button', { name: '预览修改' });
    await user.click(previewButton);
    const dialog = await screen.findByRole('dialog', { name: '确认订单修改' });
    expect(updateOrder).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent('收件人');
    expect(dialog).toHaveTextContent('卖家账号');
    expect(dialog).not.toHaveTextContent('sellerAccount');
    expect(dialog).toHaveTextContent('新增商品');
    expect(dialog).toHaveTextContent('仓库货号');
    expect(dialog).toHaveTextContent('SKU-NEW-02');
    expect(dialog).toHaveTextContent('SKU-DELETED-02');
    expect(dialog).not.toHaveTextContent(itemBusinessField.id);

    const returnButton = within(dialog).getByRole('button', { name: '返回继续修改' });
    const confirmButton = within(dialog).getByRole('button', { name: '确认保存' });
    expect(returnButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirmButton).toHaveFocus();
    await user.tab();
    expect(returnButton).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '确认订单修改' })).not.toBeInTheDocument();
    expect(previewButton).toHaveFocus();

    await user.click(previewButton);
    const reopenedDialog = await screen.findByRole('dialog', { name: '确认订单修改' });
    await user.click(within(reopenedDialog).getByRole('button', { name: '确认保存' }));

    await waitFor(() => expect(updateOrder).toHaveBeenCalledTimes(1));
    const input = updateOrder.mock.calls[0][0];
    expect(input).toMatchObject({
      orderId: editableOrder.id,
      expectedRevision: 3,
      recipient: '新收件人',
      note: '人工核对完成',
      identityCorrection: {
        platform: 'xianyu',
        sellerAccount: '更正后卖家',
        orderNumber: editableOrder.orderNumber,
      },
    });
    expect(input).not.toHaveProperty('platformTransactionStatus');
    expect(input).not.toHaveProperty('fulfillmentStatus');
    expect(input.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: editableOrder.items[0].id, sourceTitle: '已修改商品' }),
      expect.objectContaining({
        id: null,
        sourceTitle: '新增商品',
        unitPriceCents: 1_250,
        quantity: 2,
        customFieldValues: [{ definitionId: itemBusinessField.id, value: 'SKU-NEW-02' }],
      }),
    ]));
    expect(await screen.findByText('已修改')).toBeVisible();
    expect(screen.getByText(/最近修改/)).toBeVisible();
    expect(screen.getByRole('heading', { name: '收货信息' }).closest('section'))
      .toHaveTextContent('新收件人');
    expect(screen.getByRole('heading', { name: '订单信息' }).closest('section'))
      .toHaveTextContent('人工核对完成');
  });

  it('取消订单编辑不写入，且仅剩一件商品时禁止删除', async () => {
    const user = userEvent.setup();
    const updateOrder = vi.fn();
    const summary = orderSummary();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });
    Object.assign(api, { updateOrder });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: `查看订单 ${summary.orderNumber}` }));
    await user.click(await screen.findByRole('button', { name: '编辑订单' }));
    expect(screen.getByRole('button', { name: '删除商品 1' })).toBeDisabled();
    await user.clear(screen.getByRole('textbox', { name: '买家昵称' }));
    await user.type(screen.getByRole('textbox', { name: '买家昵称' }), '未保存买家');
    await user.click(screen.getByRole('button', { name: '取消编辑' }));

    expect(updateOrder).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: '订单详情' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '订单信息' }).closest('section'))
      .toHaveTextContent(confirmedOrder.buyerNickname);
  });

  it('历史订单的空金额保持为空，必须由用户明确补齐才能预览保存', async () => {
    const user = userEvent.setup();
    const legacyOrder: OriginalOrder = {
      ...confirmedOrder,
      productTotalCents: null,
      shippingFeeCents: null,
    };
    const legacyDetails: OrderDetails = { ...orderDetails, order: legacyOrder };
    const summary = orderSummary(legacyOrder);
    const updateOrder = vi.fn();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue(legacyDetails),
      updateOrder,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: `查看订单 ${summary.orderNumber}` }));
    await user.click(await screen.findByRole('button', { name: '编辑订单' }));

    const productTotal = screen.getByRole('spinbutton', { name: '商品总价' });
    const shippingFee = screen.getByRole('spinbutton', { name: '运费' });
    expect(productTotal).toHaveValue(null);
    expect(shippingFee).toHaveValue(null);
    await user.clear(screen.getByRole('textbox', { name: '收件人' }));
    await user.type(screen.getByRole('textbox', { name: '收件人' }), '仅修改收件人');
    await user.click(screen.getByRole('button', { name: '预览修改' }));

    expect(productTotal).toBeInvalid();
    expect(shippingFee).toBeInvalid();
    expect(screen.queryByRole('dialog', { name: '确认订单修改' })).not.toBeInTheDocument();
    expect(updateOrder).not.toHaveBeenCalled();

    await user.type(productTotal, '0');
    await user.type(shippingFee, '0');
    await user.click(screen.getByRole('button', { name: '预览修改' }));
    expect(await screen.findByRole('dialog', { name: '确认订单修改' }))
      .toHaveTextContent('商品总价');
    expect(updateOrder).not.toHaveBeenCalled();
  });

  it('订单表仅对人工修改过的订单显示最近修改标记', async () => {
    const manuallyEdited = orderSummary(confirmedOrder, {
      id: 'order-manually-edited',
      orderNumber: 'XY-TEST-MANUAL-EDIT',
      revision: 4,
      updatedAt: '2026-07-31T08:40:00.000Z',
      lastManualEditAt: '2026-07-31T08:35:00.000Z',
    });
    const sourceUpdatedOnly = orderSummary(confirmedOrder, {
      id: 'order-source-updated',
      orderNumber: 'XY-TEST-SOURCE-UPDATE',
      revision: 5,
      updatedAt: '2026-07-31T08:45:00.000Z',
      lastManualEditAt: null,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [manuallyEdited, sourceUpdatedOnly],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([
        manuallyEdited,
        sourceUpdatedOnly,
      ])),
    });

    render(<App api={api} />);
    const table = await screen.findByRole('table', { name: '原始订单' });
    const manualRow = within(table).getByText(manuallyEdited.orderNumber).closest('tr');
    const sourceRow = within(table).getByText(sourceUpdatedOnly.orderNumber).closest('tr');
    expect(manualRow).not.toBeNull();
    expect(sourceRow).not.toBeNull();
    expect(manualRow).toHaveTextContent('已修改');
    expect(manualRow).toHaveTextContent('最近修改');
    expect(sourceRow).not.toHaveTextContent('已修改');
    expect(sourceRow).not.toHaveTextContent('最近修改');
  });

  it('已发货订单提示快照不会改写，并发冲突时保留表单直到用户明确刷新', async () => {
    const user = userEvent.setup();
    const shippedOrder: OriginalOrder = {
      ...confirmedOrder,
      revision: 5,
      fulfillmentStatus: 'shipped',
    };
    const shippedDetails: OrderDetails = { ...orderDetails, order: shippedOrder };
    const latestDetails: OrderDetails = {
      ...shippedDetails,
      order: { ...shippedOrder, revision: 6, buyerNickname: '其他窗口的新值' },
    };
    const getOrder = vi.fn()
      .mockResolvedValueOnce(shippedDetails)
      .mockResolvedValueOnce(latestDetails);
    const updateOrder = vi.fn().mockRejectedValue(
      new Error('订单已在其他操作中更新，请刷新后重试'),
    );
    const summary = orderSummary(shippedOrder);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });
    Object.assign(api, { updateOrder });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: `查看订单 ${summary.orderNumber}` }));
    await user.click(await screen.findByRole('button', { name: '编辑订单' }));
    expect(screen.getByRole('status')).toHaveTextContent('不会改写已冻结的发货快照');
    await user.clear(screen.getByRole('textbox', { name: '买家昵称' }));
    await user.type(screen.getByRole('textbox', { name: '买家昵称' }), '我的未保存值');
    await user.click(screen.getByRole('button', { name: '预览修改' }));
    await user.click(within(
      await screen.findByRole('dialog', { name: '确认订单修改' }),
    ).getByRole('button', { name: '确认保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('订单已在其他操作中更新');
    expect(screen.getByRole('textbox', { name: '买家昵称' })).toHaveValue('我的未保存值');
    await user.click(screen.getByRole('button', { name: '刷新最新订单' }));
    expect(await screen.findByRole('textbox', { name: '买家昵称' })).toHaveValue('其他窗口的新值');
    expect(getOrder).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['delivered', '已收货'],
  ] as const)('%s 订单仍视为已经历发货并提示快照不会改写', async (
    fulfillmentStatus,
    statusLabel,
  ) => {
    const user = userEvent.setup();
    const fulfilledOrder: OriginalOrder = {
      ...confirmedOrder,
      fulfillmentStatus,
    };
    const summary = orderSummary(fulfilledOrder);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue({ ...orderDetails, order: fulfilledOrder }),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    }));
    await user.click(await screen.findByRole('button', { name: '编辑订单' }));

    expect(screen.getByText(new RegExp(`该订单已经历发货.*${statusLabel}`)))
      .toBeVisible();
    expect(screen.getByText(/不会改写已冻结的发货快照/)).toBeVisible();
  });

  it('数据目录被其他实例占用时说明原因，并允许选择其他目录', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'locked',
        dataDirectory: 'D:\\闲鱼订单',
        message: '该数据目录正在被另一个窗口使用',
      }),
      selectDataDirectory: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'E:\\备用订单',
        orders: [],
      }),
    });

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: '数据目录正在使用' })).toBeVisible();
    expect(screen.getByText('该数据目录正在被另一个窗口使用')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '选择其他目录' }));

    expect(await screen.findByText('E:\\备用订单')).toBeVisible();
  });

  it('启动异常时显示可恢复错误，重试成功后进入工作台', async () => {
    const user = userEvent.setup();
    const retryDataDirectory = vi.fn().mockResolvedValue({
      kind: 'ready',
      dataDirectory: 'D:\\闲鱼订单',
      orders: [],
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'error',
        message: '订单数据库暂时无法读取',
      }),
      retryDataDirectory,
    });

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: '无法打开订单数据' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('订单数据库暂时无法读取');
    await user.click(screen.getByRole('button', { name: '重新尝试' }));

    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    expect(retryDataDirectory).toHaveBeenCalledOnce();
  });

  it('启动异常时可重新选择数据目录，且保留重试原目录入口', async () => {
    const user = userEvent.setup();
    const retryDataDirectory = vi.fn().mockResolvedValue({
      kind: 'error',
      message: '上次使用的数据目录不存在或无法访问',
    });
    const selectDataDirectory = vi.fn().mockResolvedValue({
      kind: 'ready',
      dataDirectory: 'E:\\新订单数据',
      orders: [],
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'error',
        message: '上次使用的数据目录不存在或无法访问，请重新选择数据目录',
      }),
      retryDataDirectory,
      selectDataDirectory,
    });

    render(<App api={api} />);

    expect(await screen.findByRole('button', { name: '重新尝试' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '重新选择数据目录' }));

    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    expect(selectDataDirectory).toHaveBeenCalledOnce();
    expect(retryDataDirectory).not.toHaveBeenCalled();
  });

  it('识别期间锁定上传动作，用户取消选图后安静返回空状态', async () => {
    const user = userEvent.setup();
    let finishSelection!: (value: OrderDraft | null) => void;
    const selection = new Promise<OrderDraft | null>((resolve) => {
      finishSelection = resolve;
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockReturnValue(selection),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(screen.getByRole('button', { name: '正在添加来源截图…' })).toBeDisabled();
    await act(async () => finishSelection(null));

    expect(await screen.findByRole('button', { name: '上传订单截图' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('来源截图识别失败时保留当前工作区，并给出可读的错误提示', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockRejectedValue(new Error('来源截图识别失败，请稍后重试')),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('来源截图识别失败，请稍后重试');
    expect(screen.getByRole('button', { name: '上传订单截图' })).toBeEnabled();
  });

  it('批次页实时汇总整批进度，并逐张展示全部处理状态和原因', async () => {
    const user = userEvent.setup();
    const statuses: RecognitionBatchItemStatus[] = [
      'waiting_recognition',
      'recognizing',
      'validating',
      'awaiting_confirmation',
      'imported',
      'waiting_retry',
      'failed',
      'duplicate_skipped',
      'cancelled',
    ];
    const batch = recognitionBatchView('batch-all-statuses', statuses.map((status, index) => ({
      id: `batch-item-${index}`,
      batchId: 'batch-all-statuses',
      sourceName: `订单截图-${index + 1}.png`,
      status,
      draftId: status === 'awaiting_confirmation' ? draft.id : undefined,
      errorMessage: status === 'failed' ? '截图内容不完整' : undefined,
    })));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('heading', { name: '识别批次' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '批次识别进度' })).toHaveAttribute('value', '5');
    expect(screen.getByRole('status')).toHaveTextContent('5/9');
    expect(screen.getByLabelText('批次结果统计')).toHaveTextContent('4处理中');
    const table = screen.getByRole('table', { name: '批次截图状态' });
    for (const label of [
      '等待识别',
      '识别中',
      '校验中',
      '待确认',
      '已入库',
      '等待重试',
      '失败',
      '重复跳过',
      '已取消',
    ]) {
      expect(within(table).getByText(label)).toBeVisible();
    }
    expect(within(table).getByText('截图内容不完整')).toBeVisible();
    expect(within(table).getByText('已保留原图，将按受控退避自动重试')).toBeVisible();
    expect(screen.getByText(/断网或重启不会丢失未完成任务/)).toBeVisible();
  });

  it('批次结果明确区分相同图片、内容等价订单和已确认更新', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-order-resolution', [
      {
        id: 'batch-item-identical-image',
        batchId: 'batch-order-resolution',
        sourceName: '相同图片.png',
        status: 'duplicate_skipped',
        resolution: 'identical_image',
      },
      {
        id: 'batch-item-equivalent-order',
        batchId: 'batch-order-resolution',
        sourceName: '等价订单.png',
        status: 'duplicate_skipped',
        resolution: 'equivalent_order',
      },
      {
        id: 'batch-item-order-updated',
        batchId: 'batch-order-resolution',
        sourceName: '订单更新.png',
        status: 'imported',
        resolution: 'order_updated',
      },
    ]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    const table = await screen.findByRole('table', { name: '批次截图状态' });
    expect(within(table).getByText('相同截图已接收过，本次未重复调用 OCR')).toBeVisible();
    expect(within(table).getByText(
      '不同来源截图的订单内容等价，已记录来源且未创建重复订单',
    )).toBeVisible();
    expect(within(table).getByText('已确认字段变化并更新订单当前值')).toBeVisible();
    expect(within(table).getByText('已更新')).toBeVisible();
  });

  it('离开批次页后继续接收后台进度，并在订单首页显示最近结果', async () => {
    const user = userEvent.setup();
    let publish!: (batches: RecognitionBatchView[]) => void;
    const running = recognitionBatchView('batch-background', [{
      id: 'batch-item-background',
      batchId: 'batch-background',
      sourceName: '后台订单.png',
      status: 'recognizing',
    }]);
    const completed = recognitionBatchView('batch-background', [{
      id: 'batch-item-background',
      batchId: 'batch-background',
      sourceName: '后台订单.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(running),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      onRecognitionBatchesChanged: vi.fn((listener) => {
        publish = listener;
        return () => undefined;
      }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    expect(await screen.findByRole('heading', { name: '识别批次' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '订单' }));
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    await act(async () => publish([completed]));

    expect(await screen.findByText('1/1 张已处理')).toBeVisible();
    expect(screen.getByRole('region', { name: '最近识别批次' })).toHaveTextContent('待确认');
    await user.click(screen.getByRole('button', { name: '查看批次' }));
    expect(await screen.findByRole('table', { name: '批次截图状态' })).toHaveTextContent('待确认');
  });

  it('自动入库后接收订单变更通知，无需刷新即更新订单表', async () => {
    let publishOrders!: (orders: OrderSummary[]) => void;
    const onOrdersChanged = vi.fn((listener: Parameters<DesktopApi['onOrdersChanged']>[0]) => {
      publishOrders = listener;
      return () => undefined;
    });
    const queryOrders = vi.fn()
      .mockResolvedValueOnce(workbenchResult([]))
      .mockResolvedValue(workbenchResult([orderSummary()]));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      onOrdersChanged,
      queryOrders,
    });

    render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    await waitFor(() => expect(onOrdersChanged).toHaveBeenCalledOnce());

    await act(async () => publishOrders([orderSummary()]));

    expect(await screen.findByRole('table', { name: '原始订单' })).toBeVisible();
    await waitFor(() => expect(queryOrders).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    })).toBeVisible();
  });

  it('启动快照与事件订阅之间发生的自动入库会通过订阅后查询补齐', async () => {
    const importedOrder = orderSummary();
    const onOrdersChanged = vi.fn(() => () => undefined);
    const listOrders = vi.fn().mockResolvedValue([importedOrder]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      onOrdersChanged,
      listOrders,
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([importedOrder])),
    });

    render(<App api={api} />);

    expect(await screen.findByRole('table', { name: '原始订单' })).toBeVisible();
    expect(onOrdersChanged).toHaveBeenCalledOnce();
    expect(listOrders).toHaveBeenCalledOnce();
  });

  it('启动订单查询较晚返回时不会关闭用户已经打开的校对页', async () => {
    const user = userEvent.setup();
    let finishInitialQuery!: (orders: OrderSummary[]) => void;
    const initialQuery = new Promise<OrderSummary[]>((resolve) => {
      finishInitialQuery = resolve;
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      listOrders: vi.fn().mockReturnValue(initialQuery),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();

    await act(async () => finishInitialQuery([]));

    expect(screen.getByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: '收件人' })).toHaveValue(draft.recipient);
  });

  it('确认后的较晚订单查询不会覆盖期间收到的自动入库通知', async () => {
    const user = userEvent.setup();
    let publishOrders!: (orders: OrderSummary[]) => void;
    let finishConfirmationQuery!: (orders: OrderSummary[]) => void;
    const confirmationQuery = new Promise<OrderSummary[]>((resolve) => {
      finishConfirmationQuery = resolve;
    });
    const confirmedSummary = orderSummary();
    const automaticSummary: OrderSummary = {
      ...confirmedSummary,
      id: 'order-auto-newer',
      orderNumber: 'XY-AUTO-NEWER-0001',
      recipient: '自动入库收件人',
    };
    const listOrders = vi.fn()
      .mockResolvedValueOnce([])
      .mockReturnValue(confirmationQuery);
    const queryOrders = vi.fn()
      .mockResolvedValueOnce(workbenchResult([]))
      .mockResolvedValue(workbenchResult([automaticSummary, confirmedSummary]));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft: vi.fn().mockResolvedValue({
        order: confirmedOrder,
        resolution: 'new_order',
      }),
      listOrders,
      queryOrders,
      onOrdersChanged: vi.fn((listener) => {
        publishOrders = listener;
        return () => undefined;
      }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await user.click(await screen.findByRole('button', { name: '确认并入库' }));
    await waitFor(() => expect(listOrders).toHaveBeenCalledTimes(2));

    await act(async () => publishOrders([automaticSummary, confirmedSummary]));
    await act(async () => finishConfirmationQuery([confirmedSummary]));

    expect(await screen.findByRole('button', {
      name: `查看订单 ${automaticSummary.orderNumber}`,
    })).toBeVisible();
    expect(screen.getByRole('button', {
      name: `查看订单 ${confirmedSummary.orderNumber}`,
    })).toBeVisible();
  });

  it('较晚返回的旧批次查询不会覆盖主进程刚推送的新进度', async () => {
    let publish!: (batches: RecognitionBatchView[]) => void;
    let finishInitialQuery!: (batches: RecognitionBatchView[]) => void;
    const initialQuery = new Promise<RecognitionBatchView[]>((resolve) => {
      finishInitialQuery = resolve;
    });
    const completed = recognitionBatchView('batch-newer-event', [{
      id: 'batch-item-newer-event',
      batchId: 'batch-newer-event',
      sourceName: '已完成订单.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    const onRecognitionBatchesChanged = vi.fn((listener) => {
      publish = listener;
      return () => undefined;
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockReturnValue(initialQuery),
      onRecognitionBatchesChanged,
    });

    render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    await waitFor(() => expect(onRecognitionBatchesChanged).toHaveBeenCalledOnce());
    await act(async () => publish([completed]));
    expect(await screen.findByText('1/1 张已处理')).toBeVisible();

    await act(async () => finishInitialQuery([]));
    expect(screen.getByText('1/1 张已处理')).toBeVisible();
  });

  it('选图调用的初始快照不会覆盖期间已经推送的完成状态', async () => {
    const user = userEvent.setup();
    let publish!: (batches: RecognitionBatchView[]) => void;
    let finishSelection!: (batch: RecognitionBatchView) => void;
    const initial = recognitionBatchView('batch-selection-race', [{
      id: 'batch-item-selection-race',
      batchId: 'batch-selection-race',
      sourceName: '快速订单.png',
      status: 'waiting_recognition',
    }]);
    const completed = recognitionBatchView('batch-selection-race', [{
      id: 'batch-item-selection-race',
      batchId: 'batch-selection-race',
      sourceName: '快速订单.png',
      status: 'duplicate_skipped',
    }]);
    const selection = new Promise<RecognitionBatchView>((resolve) => {
      finishSelection = resolve;
    });
    const onRecognitionBatchesChanged = vi.fn((listener) => {
      publish = listener;
      return () => undefined;
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockReturnValue(selection),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      onRecognitionBatchesChanged,
    });

    render(<App api={api} />);
    await waitFor(() => expect(onRecognitionBatchesChanged).toHaveBeenCalledOnce());
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await act(async () => {
      publish([completed]);
      finishSelection(initial);
    });

    const table = await screen.findByRole('table', { name: '批次截图状态' });
    expect(within(table).getByText('重复跳过')).toBeVisible();
    expect(within(table).queryByText('等待识别')).not.toBeInTheDocument();
  });

  it('批次失败项可单独立即重试，并且只提交被点击的批次项', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-manual-retry', [
      {
        id: 'batch-item-stays-failed',
        batchId: 'batch-manual-retry',
        sourceName: '保持失败.png',
        status: 'failed',
        errorMessage: '截图内容不完整',
      },
      {
        id: 'batch-item-retry-target',
        batchId: 'batch-manual-retry',
        sourceName: '只重试这一张.png',
        status: 'failed',
        errorMessage: '服务暂时不可用',
      },
    ]);
    let publish!: (batches: RecognitionBatchView[]) => void;
    const retryingBatch = recognitionBatchView('batch-manual-retry', [
      batch.items[0],
      { ...batch.items[1], status: 'waiting_recognition', errorMessage: undefined },
    ]);
    const retryRecognitionItem = vi.fn(async () => {
      publish([retryingBatch]);
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      retryRecognitionItem,
      onRecognitionBatchesChanged: vi.fn((listener) => {
        publish = listener;
        return () => undefined;
      }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    const table = await screen.findByRole('table', { name: '批次截图状态' });
    const targetRow = within(table).getByText('只重试这一张.png').closest('tr');
    if (!targetRow) throw new Error('未找到目标批次项');

    await user.click(within(targetRow).getByRole('button', { name: '立即重试' }));

    expect(retryRecognitionItem).toHaveBeenCalledOnce();
    expect(retryRecognitionItem).toHaveBeenCalledWith(
      'batch-manual-retry',
      'batch-item-retry-target',
    );
    expect(within(table).getByText('保持失败.png').closest('tr')).toHaveTextContent('失败');
    expect(targetRow).toHaveTextContent('等待识别');
  });

  it('批次失败项可用原截图进入人工录入校对页', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-manual-entry', [{
      id: 'batch-item-manual-entry',
      batchId: 'batch-manual-entry',
      sourceName: '人工录入来源.png',
      status: 'failed',
      errorMessage: '图片版式暂不支持',
    }]);
    const manualDraft: OrderDraft = {
      ...draft,
      id: 'draft-manual-entry',
      batchId: 'batch-manual-entry',
      screenshotId: 'shot-manual-entry',
      orderNumber: '',
      recipient: '',
      phone: '',
      phoneNormalized: '',
      amountCents: null,
      items: [{
        ...draft.items[0],
        id: 'manual-entry-item',
        sourceTitle: '',
        unitPriceCents: null,
      }],
    };
    const createManualDraft = vi.fn().mockResolvedValue(manualDraft);
    const getScreenshotDataUrl = vi.fn().mockResolvedValue(
      'data:image/png;base64,bWFudWFsLWVudHJ5',
    );
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      createManualDraft,
      getScreenshotDataUrl,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '人工录入' }));

    expect(createManualDraft).toHaveBeenCalledWith(
      'batch-manual-entry',
      'batch-item-manual-entry',
    );
    expect(getScreenshotDataUrl).toHaveBeenCalledWith('shot-manual-entry');
    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByAltText('来源截图')).toHaveAttribute(
      'src',
      'data:image/png;base64,bWFudWFsLWVudHJ5',
    );
    expect(screen.getByLabelText('成交金额')).toHaveValue(null);
  });

  it('批次结果和校对页展示确定性待确认原因，不展示模型置信度', async () => {
    const user = userEvent.setup();
    const reviewIssues = ['missing_phone', 'item_total_mismatch'] as const;
    const reviewDraft: OrderDraft = {
      ...draft,
      reviewIssues: [...reviewIssues],
    };
    const batch = recognitionBatchView('batch-review-issues', [{
      id: 'batch-item-review-issues',
      batchId: 'batch-review-issues',
      sourceName: '需重点校对.png',
      status: 'awaiting_confirmation',
      draftId: reviewDraft.id,
      reviewIssues: [...reviewIssues],
    }]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraft: vi.fn().mockResolvedValue(reviewDraft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    const table = await screen.findByRole('table', { name: '批次截图状态' });
    const row = within(table).getByText('需重点校对.png').closest('tr');
    if (!row) throw new Error('未找到待确认批次项');
    const batchReasons = within(row).getByRole('list', { name: '待确认原因' });
    for (const issue of reviewIssues) {
      expect(batchReasons).toHaveTextContent(orderReviewIssueLabel(issue));
    }
    expect(row).not.toHaveTextContent('置信度');

    await user.click(within(row).getByRole('button', { name: '校对' }));
    const reviewReasons = await screen.findByRole('region', { name: '请重点核对' });
    for (const issue of reviewIssues) {
      expect(reviewReasons).toHaveTextContent(orderReviewIssueLabel(issue));
    }
    expect(screen.getByRole('heading', { name: '校对识别结果' }).closest('section'))
      .not.toHaveTextContent('置信度');
  });

  it('批次历史保留冲突摘要，并仅为有明细的记录提供按区域分组的冲突详情', async () => {
    const user = userEvent.setup();
    const recognitionConflicts: NonNullable<OrderDraft['recognitionConflicts']> = [
      {
        region: 'shipping_information',
        field: 'recipient',
        kind: 'multiple_candidates',
        locatedValues: ['张三', '李四'],
        extractedValues: ['李四'],
        retainedValue: '李四',
      },
      {
        region: 'shipping_information',
        field: 'phone',
        kind: 'value_mismatch',
        locatedValues: ['13800000000'],
        extractedValues: ['13900000000'],
        retainedValue: '13800000000',
      },
      {
        region: 'shipping_information',
        field: 'district',
        kind: 'value_mismatch',
        locatedValues: ['锦江区'],
        extractedValues: ['江城区'],
        retainedValue: '锦江区',
      },
      {
        region: 'amount_summary',
        field: 'amount',
        kind: 'unsupported_value',
        locatedValues: ['¥88.00'],
        extractedValues: ['88.00 元'],
        retainedValue: '88.00',
      },
    ];
    const batch = recognitionBatchView('batch-conflict-details', [
      {
        id: 'batch-item-with-conflict-details',
        batchId: 'batch-conflict-details',
        sourceName: '新版冲突订单.png',
        status: 'awaiting_confirmation',
        draftId: draft.id,
        reviewIssues: ['targeted_review_conflict'],
        recognitionConflicts,
      },
      {
        id: 'batch-item-legacy-conflict',
        batchId: 'batch-conflict-details',
        sourceName: '旧版冲突订单.png',
        status: 'awaiting_confirmation',
        draftId: 'draft-legacy-conflict',
        reviewIssues: ['targeted_review_conflict'],
      },
      {
        id: 'batch-item-confirmed-conflict',
        batchId: 'batch-conflict-details',
        sourceName: '已确认的冲突订单.png',
        status: 'imported',
        draftId: 'draft-confirmed-conflict',
        recognitionConflicts,
      },
    ]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));

    expect(screen.getAllByText(orderReviewIssueLabel('targeted_review_conflict'))).toHaveLength(2);
    const triggers = screen.getAllByRole('button', { name: '查看冲突详情' });
    expect(triggers).toHaveLength(2);
    const trigger = triggers[0];

    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: '识别冲突详情' });
    expect(Number.parseFloat(dialog.style.top)).toBeGreaterThanOrEqual(12);
    expect(within(dialog).getAllByRole('heading', { name: '收货信息区' })).toHaveLength(1);
    expect(within(dialog).getByRole('heading', { name: '金额汇总区' })).toBeVisible();
    expect(dialog).toHaveTextContent('收件人');
    expect(dialog).toHaveTextContent('同一区域发现多个候选值');
    expect(dialog).toHaveTextContent('手机号');
    expect(dialog).toHaveTextContent('字段候选值未能自动对齐');
    expect(dialog).toHaveTextContent('成交金额');
    expect(dialog).toHaveTextContent('指定区域未找到对应内容');
    expect(dialog).toHaveTextContent('区域候选值张三李四');
    expect(dialog).toHaveTextContent('字段候选值李四');
    expect(dialog).toHaveTextContent('当前保留值李四');
    const districtItem = within(dialog).getByText('区县').closest('li');
    if (!districtItem) throw new Error('未找到区县冲突详情');
    expect(districtItem).toHaveTextContent('地址拆分值锦江区');
    expect(districtItem).toHaveTextContent('字段候选值江城区');
    expect(districtItem).toHaveTextContent('当前采用值锦江区');
    expect(districtItem).not.toHaveTextContent('未返回');
    expect(districtItem).not.toHaveTextContent('未保留');

    fireEvent.focusIn(triggers[1]);
    expect(screen.queryByRole('dialog', { name: '识别冲突详情' })).not.toBeInTheDocument();
  });

  it('已自动入库的批次项仍可查看持久化的候选裁决记录', async () => {
    const user = userEvent.setup();
    const importedDraftId = 'draft-auto-imported-with-audit';
    const batch = recognitionBatchView('batch-auto-imported-with-audit', [{
      id: 'batch-item-auto-imported-with-audit',
      batchId: 'batch-auto-imported-with-audit',
      sourceName: '自动入库订单.png',
      status: 'imported',
      draftId: importedDraftId,
      resolution: 'new_order',
    }]);
    const getCandidateAdjudicationAudit = vi.fn().mockResolvedValue([{
      id: 'candidate-run-auto-imported',
      createdAt: '2026-08-01T10:00:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'succeeded',
      decisions: [{
        ambiguityId: 'shipping-phone',
        region: 'shipping_information',
        field: 'shipping_contact',
        candidates: [{
          candidateId: 'phone-a',
          displayText: '彭 13881173018',
          evidenceRefs: [{ lineId: 'shipping-line-1' }],
        }],
        contextLines: [{
          lineId: 'shipping-line-1',
          text: '彭 13881173018 复制',
          left: 0.08,
          top: 0.2,
          right: 0.45,
          bottom: 0.24,
        }],
        selectedCandidateId: 'phone-a',
        outcome: 'selected',
      }],
    }]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getCandidateAdjudicationAudit,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));

    const table = await screen.findByRole('table', { name: '批次截图状态' });
    const row = within(table).getByText('自动入库订单.png').closest('tr');
    if (!row) throw new Error('未找到已自动入库的批次项');
    const auditTrigger = await within(row).findByRole('button', { name: '查看候选裁决详情' });
    expect(within(row).queryByRole('button', { name: '校对' })).not.toBeInTheDocument();
    expect(getCandidateAdjudicationAudit).toHaveBeenCalledWith(importedDraftId);

    await user.click(auditTrigger);
    const dialog = screen.getByRole('dialog', { name: '候选裁决详情' });
    expect(dialog).toHaveTextContent('DeepSeek');
    expect(dialog).toHaveTextContent('本地调用编号');
    expect(dialog).toHaveTextContent('candidate-run-auto-imported');
    expect(dialog).toHaveTextContent('彭 13881173018');
  });

  it('校对页可查看同一份冲突明细，并可用 Escape 或点击外部关闭', async () => {
    const user = userEvent.setup();
    const reviewDraft: OrderDraft = {
      ...draft,
      reviewIssues: ['targeted_review_conflict'],
      recognitionConflicts: [{
        region: 'purchased_items',
        field: 'item_quantity',
        kind: 'outside_region',
        itemIndex: 0,
        locatedValues: ['2'],
        extractedValues: ['1'],
        retainedValue: '1',
      }],
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(reviewDraft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    const reasons = await screen.findByRole('region', { name: '请重点核对' });
    expect(reasons).toHaveTextContent(orderReviewIssueLabel('targeted_review_conflict'));
    const trigger = within(reasons).getByRole('button', { name: '查看冲突详情' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    let dialog = screen.getByRole('dialog', { name: '识别冲突详情' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(dialog).toHaveTextContent('商品信息区');
    expect(dialog).toHaveTextContent('商品数量 · 商品 1');
    expect(dialog).toHaveTextContent('内容来自指定区域外');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '识别冲突详情' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    dialog = screen.getByRole('dialog', { name: '识别冲突详情' });
    expect(dialog).toBeVisible();
    await user.click(screen.getByRole('heading', { name: '校对识别结果' }));
    expect(screen.queryByRole('dialog', { name: '识别冲突详情' })).not.toBeInTheDocument();
  });

  it('校对页即使没有传统冲突也会显示候选裁决摘要并按需查看安全审计详情', async () => {
    const user = userEvent.setup();
    const getCandidateAdjudicationAudit = vi.fn().mockResolvedValue([{
      id: 'candidate-run-1',
      createdAt: '2026-08-01T10:00:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'partial',
      rawResponse: 'SECRET_RAW_MODEL_RESPONSE',
      apiKey: 'SECRET_API_KEY',
      decisions: [
        {
          ambiguityId: 'shipping-phone',
          region: 'shipping_information',
          field: 'shipping_contact',
          candidates: [
            {
              candidateId: 'phone-a',
              displayText: '彭 13881173018',
              evidenceRefs: [{ lineId: 'shipping-line-1' }],
            },
            {
              candidateId: 'phone-b',
              displayText: '彭 13981173018',
              evidenceRefs: [{ lineId: 'shipping-line-2' }],
            },
          ],
          contextLines: [
            {
              lineId: 'shipping-line-1',
              text: '彭 13881173018 复制',
              left: 0.08,
              top: 0.2,
              right: 0.45,
              bottom: 0.24,
            },
            {
              lineId: 'shipping-line-2',
              text: '13981173018',
              left: 0.08,
              top: 0.25,
              right: 0.3,
              bottom: 0.29,
            },
          ],
          selectedCandidateId: 'phone-a',
          outcome: 'selected',
        },
        {
          ambiguityId: 'item-title',
          region: 'purchased_items',
          field: 'item_title',
          itemIndex: 0,
          candidates: [{
            candidateId: 'title-a',
            displayText: '苹果 iPhone 15 Pro',
            evidenceRefs: [{ lineId: 'item-line-1' }],
          }],
          contextLines: [{
            lineId: 'item-line-1',
            text: '苹果 iPhone 15 Pro ¥10.00',
            left: 0.25,
            top: 0.35,
            right: 0.9,
            bottom: 0.4,
          }],
          outcome: 'unresolved',
        },
      ],
    }]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      getCandidateAdjudicationAudit,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    const summary = await screen.findByRole('region', { name: '候选裁决摘要' });
    expect(getCandidateAdjudicationAudit).toHaveBeenCalledWith(draft.id);
    expect(summary).toHaveTextContent('已选择 1 项');
    expect(summary).toHaveTextContent('未确定 1 项');
    await user.click(within(summary).getByRole('button', { name: '查看候选裁决详情' }));

    const dialog = screen.getByRole('dialog', { name: '候选裁决详情' });
    expect(dialog).toHaveTextContent('DeepSeek');
    expect(dialog).toHaveTextContent('deepseek-v4-flash');
    expect(dialog).toHaveTextContent('调用时间');
    expect(dialog).toHaveTextContent('2026/08/01');
    expect(dialog).toHaveTextContent('本地调用编号');
    expect(dialog).toHaveTextContent('candidate-run-1');
    expect(dialog).toHaveTextContent('收货信息区');
    expect(dialog).toHaveTextContent('收货联系人');
    expect(dialog).toHaveTextContent('已选择');
    expect(dialog).toHaveTextContent('彭 13881173018');
    expect(dialog).toHaveTextContent('依据行');
    expect(dialog).toHaveTextContent('彭 13881173018 复制');
    expect(dialog).toHaveTextContent('未确定');
    expect(dialog).not.toHaveTextContent('SECRET_RAW_MODEL_RESPONSE');
    expect(dialog).not.toHaveTextContent('SECRET_API_KEY');
  });

  it('订单内容变化时展示当前值与新识别值并通过明确动作确认更新', async () => {
    const user = userEvent.setup();
    const updateDraft: OrderDraft = {
      ...draft,
      id: 'draft-order-update',
      batchId: 'batch-order-update',
      screenshotId: 'shot-order-update',
      recipient: '新识别收件人',
      reviewIssues: ['order_content_changed'],
    };
    const currentOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-update-target',
      revision: 3,
      recipient: '当前收件人',
    };
    const existingOrderField: CustomFieldDefinition = {
      id: 'field-existing-order-priority',
      name: '订单优先级',
      granularity: 'order',
      type: 'single_select',
      required: true,
      defaultValue: '普通',
      options: ['普通', '加急'],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const review = {
      kind: 'order_update' as const,
      draft: updateDraft,
      currentOrder,
      expectedRevision: 3,
      changes: [{
        path: 'recipient',
        before: '当前收件人',
        after: '新识别收件人',
      }],
      sourceSnapshot: {
        id: 'snapshot-order-update',
        createdAt: updateDraft.createdAt,
        recognition: updateDraft,
        confirmed: null,
      },
      customFieldValues: [{
        definitionId: existingOrderField.id,
        orderId: currentOrder.id,
        orderItemId: null,
        value: '加急',
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
      }],
    };
    const batch = recognitionBatchView('batch-order-update', [{
      id: 'batch-item-order-update',
      batchId: 'batch-order-update',
      sourceName: '订单内容变化.png',
      status: 'awaiting_confirmation',
      draftId: updateDraft.id,
      reviewIssues: ['order_content_changed'],
    }]);
    const confirmOrderUpdate = vi.fn().mockResolvedValue({
      order: {
        ...currentOrder,
        recipient: '新识别收件人',
        revision: 4,
      },
      resolution: 'order_updated',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraft: vi.fn().mockResolvedValue(updateDraft),
      getDraftReview: vi.fn().mockResolvedValue(review),
      confirmOrderUpdate,
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([existingOrderField]),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,dXBkYXRl'),
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));

    const comparison = await screen.findByRole('table', { name: '订单变化对比' });
    expect(within(comparison).getByRole('columnheader', { name: '当前值' })).toBeVisible();
    expect(within(comparison).getByRole('columnheader', { name: '新识别值' })).toBeVisible();
    expect(within(comparison).getByText('收件人').closest('tr')).toHaveTextContent(
      '当前收件人新识别收件人',
    );
    expect(screen.getByRole('textbox', { name: '卖家账号' })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '订单号' })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('combobox', { name: '订单优先级' })).toHaveValue('加急');

    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(confirmOrderUpdate).toHaveBeenCalledWith(updateDraft, 3, {
      orderValues: [{
        definitionId: existingOrderField.id,
        value: '加急',
      }],
      itemValues: [],
    });
  });

  it('同一订单更新时显示旧订单缺失的必填商品字段，填写后才可确认', async () => {
    const user = userEvent.setup();
    const updateDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-required-item-field',
      batchId: 'batch-update-required-item-field',
      recipient: '新识别收件人',
      reviewIssues: ['order_content_changed'],
    };
    const currentOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-update-required-item-field',
      recipient: '当前收件人',
    };
    const requiredItemField: CustomFieldDefinition = {
      id: 'field-required-item-bin',
      name: '拣货位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: 'A-DEFAULT',
      options: [],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const review = {
      kind: 'order_update' as const,
      draft: updateDraft,
      currentOrder,
      expectedRevision: currentOrder.revision,
      changes: [{
        path: 'recipient',
        before: currentOrder.recipient,
        after: updateDraft.recipient,
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: updateDraft,
        confirmed: null,
      },
      // 该旧商品曾在详情页清空过带默认值的字段。
      customFieldValues: [],
    };
    const batch = recognitionBatchView(updateDraft.batchId, [{
      id: 'batch-item-update-required-item-field',
      batchId: updateDraft.batchId,
      sourceName: '旧订单缺必填商品字段.png',
      status: 'awaiting_confirmation',
      draftId: updateDraft.id,
    }]);
    const confirmOrderUpdate = vi.fn().mockResolvedValue({
      order: { ...currentOrder, recipient: updateDraft.recipient, revision: 2 },
      resolution: 'order_updated' as const,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview: vi.fn().mockResolvedValue(review),
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([requiredItemField]),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,aXRlbQ=='),
      confirmOrderUpdate,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));

    const field = await screen.findByRole('textbox', { name: '拣货位' });
    const confirmButton = screen.getByRole('button', { name: '确认更新订单' });
    expect(field).toHaveValue('');
    expect(confirmButton).toBeDisabled();

    await user.type(field, 'B-07');
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    expect(confirmOrderUpdate).toHaveBeenCalledWith(
      updateDraft,
      currentOrder.revision,
      {
        orderValues: [],
        itemValues: [{
          definitionId: requiredItemField.id,
          draftItemId: updateDraft.items[0].id,
          value: 'B-07',
        }],
      },
    );
  });

  it('更新中商品从未匹配修正为已有商品时，重新载入旧自定义值', async () => {
    const user = userEvent.setup();
    const currentOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-update-rematched-item',
      recipient: '当前收件人',
    };
    const updateDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-rematched-item',
      batchId: 'batch-update-rematched-item',
      recipient: '新识别收件人',
      reviewIssues: ['order_content_changed'],
      items: [{
        ...draft.items[0],
        sourceTitle: '识别错误的新商品',
        sourceSpec: '识别错误规格',
      }],
    };
    const priorityField: CustomFieldDefinition = {
      id: 'field-item-priority-rematch',
      name: '商品优先级',
      granularity: 'order_item',
      type: 'single_select',
      required: false,
      defaultValue: '普通',
      options: ['普通', '加急'],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const review = {
      kind: 'order_update' as const,
      draft: updateDraft,
      currentOrder,
      expectedRevision: currentOrder.revision,
      changes: [{
        path: 'recipient',
        before: currentOrder.recipient,
        after: updateDraft.recipient,
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: updateDraft,
        confirmed: null,
      },
      customFieldValues: [{
        definitionId: priorityField.id,
        orderId: null,
        orderItemId: currentOrder.items[0].id,
        value: '加急',
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
      }],
    };
    const batch = recognitionBatchView(updateDraft.batchId, [{
      id: 'batch-item-update-rematched-item',
      batchId: updateDraft.batchId,
      sourceName: '商品修正匹配.png',
      status: 'awaiting_confirmation',
      draftId: updateDraft.id,
    }]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview: vi.fn().mockResolvedValue(review),
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([priorityField]),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,cmVtYXRjaA=='),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));

    const priority = await screen.findByRole('combobox', { name: '商品优先级' });
    expect(priority).toHaveValue('普通');
    const title = screen.getByRole('textbox', { name: '商品标题' });
    await user.clear(title);
    await user.type(title, currentOrder.items[0].sourceTitle);

    await waitFor(() => expect(priority).toHaveValue('加急'));
  });

  it('订单更新确认失败时保留用户尚未提交成功的表单修改', async () => {
    const user = userEvent.setup();
    const updateDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-failure',
      batchId: 'batch-update-failure',
      recipient: 'OCR 新收件人',
      reviewIssues: ['order_content_changed'],
    };
    const currentOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-update-failure',
      recipient: '当前收件人',
    };
    const review = {
      kind: 'order_update' as const,
      draft: updateDraft,
      currentOrder,
      expectedRevision: 1,
      changes: [{
        path: 'recipient',
        before: '当前收件人',
        after: 'OCR 新收件人',
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: updateDraft,
        confirmed: null,
      },
      customFieldValues: [],
    };
    const batch = recognitionBatchView('batch-update-failure', [{
      id: 'batch-item-update-failure',
      batchId: 'batch-update-failure',
      sourceName: '更新失败保留表单.png',
      status: 'awaiting_confirmation',
      draftId: updateDraft.id,
    }]);
    const refreshedReview = {
      ...review,
      currentOrder: {
        ...currentOrder,
        revision: 2,
        recipient: '其他操作刚更新的收件人',
      },
      expectedRevision: 2,
      changes: [{
        path: 'recipient',
        before: '其他操作刚更新的收件人',
        after: updateDraft.recipient,
      }],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce(refreshedReview);
    const confirmOrderUpdate = vi.fn()
      .mockRejectedValueOnce(new Error('订单已在其他操作中更新，请刷新对比后重试'))
      .mockResolvedValueOnce({
        order: {
          ...currentOrder,
          revision: 3,
          recipient: '用户手工修正但尚未成功',
        },
        resolution: 'order_updated' as const,
      });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,dXBkYXRl'),
      confirmOrderUpdate,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));
    const recipientInput = await screen.findByRole('textbox', { name: '收件人' });
    await user.clear(recipientInput);
    await user.type(recipientInput, '用户手工修正但尚未成功');
    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('订单已在其他操作中更新');
    expect(screen.getByRole('textbox', { name: '收件人' })).toHaveValue(
      '用户手工修正但尚未成功',
    );
    expect(screen.getByRole('table', { name: '订单变化对比' })).toHaveTextContent(
      '其他操作刚更新的收件人用户手工修正但尚未成功',
    );
    expect(getDraftReview).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(confirmOrderUpdate).toHaveBeenNthCalledWith(2, {
      ...updateDraft,
      recipient: '用户手工修正但尚未成功',
    }, 2);
  });

  it('订单更新校对中修正身份命中另一已有订单时切换到新的对比对象', async () => {
    const user = userEvent.setup();
    const initialDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-reroute',
      batchId: 'batch-update-reroute',
      orderNumber: 'OCR-MISTAKEN-ORDER',
      recipient: '新截图收件人',
      reviewIssues: ['order_content_changed'],
    };
    const initialOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'wrong-candidate-order',
      orderNumber: initialDraft.orderNumber,
      recipient: '误命中订单收件人',
    };
    const correctedDraft = {
      ...initialDraft,
      orderNumber: 'CORRECTED-EXISTING-ORDER',
    };
    const correctedOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'corrected-candidate-order',
      orderNumber: correctedDraft.orderNumber,
      recipient: '正确候选当前收件人',
    };
    const initialReview = {
      kind: 'order_update' as const,
      draft: initialDraft,
      currentOrder: initialOrder,
      expectedRevision: 1,
      changes: [{
        path: 'recipient',
        before: initialOrder.recipient,
        after: initialDraft.recipient,
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: initialDraft,
        confirmed: null,
      },
      customFieldValues: [],
    };
    const reroutedReview = {
      ...initialReview,
      draft: correctedDraft,
      currentOrder: correctedOrder,
      changes: [{
        path: 'recipient',
        before: correctedOrder.recipient,
        after: correctedDraft.recipient,
      }],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce(initialReview)
      .mockResolvedValueOnce(reroutedReview);
    const batch = recognitionBatchView(initialDraft.batchId, [{
      id: 'batch-item-update-reroute',
      batchId: initialDraft.batchId,
      sourceName: '纠正候选订单.png',
      status: 'awaiting_confirmation',
      draftId: initialDraft.id,
    }]);
    const confirmOrderUpdate = vi.fn().mockRejectedValue(new Error(
      '修正后的订单身份命中另一笔已有订单，已切换对比，请核对后再次确认',
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,cmVyb3V0ZQ=='),
      confirmOrderUpdate,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));
    const orderNumber = await screen.findByRole('textbox', { name: '订单号' });
    await user.clear(orderNumber);
    await user.type(orderNumber, correctedDraft.orderNumber);
    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已切换对比');
    expect(screen.getByRole('textbox', { name: '订单号' })).toHaveValue(
      correctedDraft.orderNumber,
    );
    expect(screen.getByRole('table', { name: '订单变化对比' })).toHaveTextContent(
      '正确候选当前收件人新截图收件人',
    );
    expect(confirmOrderUpdate).toHaveBeenCalledWith(correctedDraft, 1);
    expect(getDraftReview).toHaveBeenCalledTimes(2);
  });

  it('订单更新修正为新订单时重新加载默认值，不沿用旧目标的自定义值', async () => {
    const user = userEvent.setup();
    const initialDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-to-new-order',
      batchId: 'batch-update-to-new-order',
      orderNumber: 'EXISTING-TARGET-ORDER',
      recipient: '新截图收件人',
      reviewIssues: ['order_content_changed'],
    };
    const initialOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'existing-target-before-new-order',
      orderNumber: initialDraft.orderNumber,
      recipient: '当前收件人',
    };
    const correctedDraft = {
      ...initialDraft,
      orderNumber: 'TRULY-NEW-ORDER',
    };
    const priorityField: CustomFieldDefinition = {
      id: 'field-order-priority-target-switch',
      name: '订单优先级',
      granularity: 'order',
      type: 'single_select',
      required: true,
      defaultValue: '普通',
      options: ['普通', '加急'],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const initialReview = {
      kind: 'order_update' as const,
      draft: initialDraft,
      currentOrder: initialOrder,
      expectedRevision: initialOrder.revision,
      changes: [{
        path: 'recipient',
        before: initialOrder.recipient,
        after: initialDraft.recipient,
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: initialDraft,
        confirmed: null,
      },
      customFieldValues: [{
        definitionId: priorityField.id,
        orderId: initialOrder.id,
        orderItemId: null,
        value: '加急',
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
      }],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce(initialReview)
      .mockResolvedValueOnce({ kind: 'new_order' as const, draft: correctedDraft });
    const batch = recognitionBatchView(initialDraft.batchId, [{
      id: 'batch-item-update-to-new-order',
      batchId: initialDraft.batchId,
      sourceName: '修正为新订单.png',
      status: 'awaiting_confirmation',
      draftId: initialDraft.id,
    }]);
    const confirmOrderUpdate = vi.fn().mockRejectedValue(new Error(
      '修正后的订单身份未命中已有订单，已切换为新订单校对，请再次确认',
    ));
    const confirmDraft = vi.fn().mockResolvedValue({
      order: { ...confirmedOrder, orderNumber: correctedDraft.orderNumber },
      resolution: 'new_order' as const,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview,
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([priorityField]),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,bmV3'),
      confirmOrderUpdate,
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));
    expect(await screen.findByRole('combobox', { name: '订单优先级' }))
      .toHaveValue('加急');

    const orderNumber = screen.getByRole('textbox', { name: '订单号' });
    await user.clear(orderNumber);
    await user.type(orderNumber, correctedDraft.orderNumber);
    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: '订单优先级' }))
      .toHaveValue('普通');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(confirmDraft).toHaveBeenCalledWith(correctedDraft, {
      orderValues: [{ definitionId: priorityField.id, value: '普通' }],
      itemValues: [],
    });
  });

  it('从批次进入单张校对，确认后返回原批次并更新为已入库', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-review-return', [
      {
        id: 'batch-item-review',
        batchId: 'batch-review-return',
        sourceName: '待校对订单.png',
        status: 'awaiting_confirmation',
        draftId: draft.id,
      },
      {
        id: 'batch-item-failed',
        batchId: 'batch-review-return',
        sourceName: '失败订单.png',
        status: 'failed',
        errorMessage: '截图不完整',
      },
    ]);
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      getDraft: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));
    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '确认并入库' }));
    const table = await screen.findByRole('table', { name: '批次截图状态' });
    expect(within(table).getByText('待校对订单.png').closest('tr')).toHaveTextContent('已入库');
    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({ id: draft.id }));
  });

  it('确认请求完成前锁定全部校对字段，避免界面接受未提交的修改', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-confirm-lock', [{
      id: 'batch-item-confirm-lock',
      batchId: 'batch-confirm-lock',
      sourceName: '确认期间锁定.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    let finishConfirmation!: (
      value: Awaited<ReturnType<DesktopApi['confirmDraft']>>,
    ) => void;
    const confirmDraft = vi.fn(() => new Promise<
      Awaited<ReturnType<DesktopApi['confirmDraft']>>
    >((resolve) => {
      finishConfirmation = resolve;
    }));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      getDraftReview: vi.fn().mockResolvedValue({ kind: 'new_order', draft }),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,bG9ja2Vk'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    const recipient = await screen.findByRole('textbox', { name: '收件人' });
    const valueAtSubmit = recipient.getAttribute('value');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(recipient).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '订单号' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加商品' })).toBeDisabled();
    await user.type(recipient, '不会被接受的修改');
    expect(recipient).toHaveValue(valueAtSubmit);

    await act(async () => finishConfirmation({
      order: confirmedOrder,
      resolution: 'new_order',
    }));

    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({
      recipient: valueAtSubmit,
    }));
  });

  it('校对新订单时若最终命中等价订单则显示重复跳过而不是已入库', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-review-equivalent', [{
      id: 'batch-item-review-equivalent',
      batchId: 'batch-review-equivalent',
      sourceName: '校正后等价订单.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    const equivalentOrder = {
      ...confirmedOrder,
      recipient: draft.recipient,
    };
    const transitionedReview = {
      kind: 'order_update' as const,
      draft,
      currentOrder: equivalentOrder,
      expectedRevision: equivalentOrder.revision,
      changes: [],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: draft,
        confirmed: null,
      },
      customFieldValues: [],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce({ kind: 'new_order' as const, draft })
      .mockResolvedValueOnce(transitionedReview);
    const confirmDraft = vi.fn().mockRejectedValue(new Error(
      '该订单已存在，已转为已有订单校对，请确认自定义字段后再次提交',
    ));
    const confirmOrderUpdate = vi.fn().mockResolvedValue({
      order: equivalentOrder,
      resolution: 'equivalent_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      getDraftReview,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      confirmOrderUpdate,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await user.click(await screen.findByRole('button', { name: '确认并入库' }));
    expect(await screen.findByRole('heading', { name: '确认订单更新' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    await user.click(await screen.findByRole('button', { name: '查看批次' }));
    const table = await screen.findByRole('table', { name: '批次截图状态' });
    const row = within(table).getByText('校正后等价订单.png').closest('tr');
    expect(row).toHaveTextContent('重复跳过');
    expect(row).toHaveTextContent('不同来源截图的订单内容等价');
    expect(row).not.toHaveTextContent('已入库');
    expect(getDraftReview).toHaveBeenCalledTimes(2);
    expect(confirmOrderUpdate).toHaveBeenCalledWith(draft, equivalentOrder.revision);
  });

  it('校对新订单时若最终命中已有变化订单会立即切换到新旧对比', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-review-transition', [{
      id: 'batch-item-review-transition',
      batchId: 'batch-review-transition',
      sourceName: '校正身份后内容变化.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    const transitionedDraft = {
      ...draft,
      recipient: '需要更新的收件人',
      reviewIssues: ['order_content_changed'] as const,
    };
    const currentOrder = {
      ...confirmedOrder,
      id: 'existing-transition-order',
      recipient: '当前收件人',
    };
    const transitionedReview = {
      kind: 'order_update' as const,
      draft: transitionedDraft,
      currentOrder,
      expectedRevision: 1,
      changes: [{
        path: 'recipient',
        before: '当前收件人',
        after: '需要更新的收件人',
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: transitionedDraft,
        confirmed: null,
      },
      customFieldValues: [],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce({ kind: 'new_order', draft })
      .mockResolvedValueOnce(transitionedReview);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      getDraftReview,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft: vi.fn().mockRejectedValue(new Error(
        '该订单已存在且内容有变化，已转为订单更新，请核对新旧对比后再次确认',
      )),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await user.click(await screen.findByRole('button', { name: '确认并入库' }));

    expect(await screen.findByRole('heading', { name: '确认订单更新' })).toBeVisible();
    const comparison = screen.getByRole('table', { name: '订单变化对比' });
    expect(within(comparison).getByText('收件人').closest('tr')).toHaveTextContent(
      '当前收件人需要更新的收件人',
    );
    expect(screen.getByRole('button', { name: '确认更新订单' })).toBeEnabled();
    expect(getDraftReview).toHaveBeenCalledTimes(2);
  });

  it('选择超过 50 张时在首页明确提示，且不会创建批次视图', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockRejectedValue(
        new Error('一次最多选择 50 张，当前选择了 51 张，请重新选择'),
      ),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '一次最多选择 50 张，当前选择了 51 张，请重新选择',
    );
    expect(screen.getByRole('heading', { name: '还没有订单' })).toBeVisible();
  });

  it('设置页展示当前数据目录，并在用户确认前不打开系统目录选择器', async () => {
    const user = userEvent.setup();
    const selectDataDirectory = vi.fn().mockResolvedValue({
      kind: 'ready' as const,
      dataDirectory: '/Users/test/另一套订单数据',
      orders: [],
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/当前订单数据',
        orders: [],
      }),
      selectDataDirectory,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    expect(await screen.findByRole('heading', { name: '数据存储位置' })).toBeVisible();
    expect(screen.getByText('/Users/test/当前订单数据')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '更改数据目录' }));

    expect(screen.getByRole('group', { name: '更改数据目录确认' })).toHaveTextContent(
      '不会复制、合并、移动或删除原目录内容',
    );
    expect(selectDataDirectory).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '取消更改' }));

    expect(screen.queryByRole('group', { name: '更改数据目录确认' }))
      .not.toBeInTheDocument();
    expect(selectDataDirectory).not.toHaveBeenCalled();
  });

  it('设置页确认选择不同数据目录后重载新目录工作区', async () => {
    const user = userEvent.setup();
    const selectDataDirectory = vi.fn().mockResolvedValue({
      kind: 'ready' as const,
      dataDirectory: '/Users/test/新订单数据',
      orders: [],
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/旧订单数据',
        orders: [],
      }),
      selectDataDirectory,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '更改数据目录' }));
    await user.click(screen.getByRole('button', { name: '继续选择目录' }));

    expect(selectDataDirectory).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    expect(screen.getByText('/Users/test/新订单数据')).toBeVisible();
  });

  it('设置页切换目录失败时保留当前工作区并就地说明原因', async () => {
    const user = userEvent.setup();
    const selectDataDirectory = vi.fn().mockRejectedValue(
      new Error('新数据目录不可用'),
    );
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/当前订单数据',
        orders: [],
      }),
      selectDataDirectory,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '更改数据目录' }));
    await user.click(screen.getByRole('button', { name: '继续选择目录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('新数据目录不可用');
    expect(screen.getByRole('heading', { name: '数据存储位置' })).toBeVisible();
    expect(screen.getByText('/Users/test/当前订单数据')).toBeVisible();
    expect(screen.getByRole('button', { name: '更改数据目录' })).toBeEnabled();
  });

  it('系统目录选择器取消后保持当前目录和设置页', async () => {
    const user = userEvent.setup();
    const currentState = {
      kind: 'ready' as const,
      dataDirectory: '/Users/test/当前订单数据',
      orders: [],
    };
    const selectDataDirectory = vi.fn().mockResolvedValue(currentState);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue(currentState),
      selectDataDirectory,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '更改数据目录' }));
    await user.click(screen.getByRole('button', { name: '继续选择目录' }));

    expect(selectDataDirectory).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: '数据存储位置' })).toBeVisible();
    expect(screen.getByText('/Users/test/当前订单数据')).toBeVisible();
    expect(screen.queryByRole('group', { name: '更改数据目录确认' }))
      .not.toBeInTheDocument();
  });

  it('设置页在 OCR 之前显示自动入库开关，切换后立即保存', async () => {
    const user = userEvent.setup();
    let finishSave!: (value: { automaticImportEnabled: boolean }) => void;
    const saveOrderIntakeSettings = vi.fn((
      _input: { automaticImportEnabled: boolean },
    ) => new Promise<{ automaticImportEnabled: boolean }>((resolve) => {
      finishSave = resolve;
    }));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOrderIntakeSettings: vi.fn().mockResolvedValue({
        automaticImportEnabled: false,
      }),
      saveOrderIntakeSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const automaticImport = await screen.findByRole('switch', { name: '自动入库' });
    const settingsGroup = screen.getByRole('group', { name: '应用设置' });
    expect(within(settingsGroup).getAllByRole('heading', { level: 2 }).slice(0, 3)
      .map((heading) => heading.textContent)).toEqual([
        '数据存储位置',
        '自动入库',
        '百炼 OCR',
      ]);
    expect(automaticImport).toHaveAttribute('aria-checked', 'false');

    await user.click(automaticImport);

    expect(saveOrderIntakeSettings).toHaveBeenCalledOnce();
    expect(saveOrderIntakeSettings).toHaveBeenCalledWith({ automaticImportEnabled: true });
    expect(automaticImport).toHaveAttribute('aria-checked', 'true');
    expect(automaticImport).toBeDisabled();

    await act(async () => finishSave({ automaticImportEnabled: true }));
    expect(await screen.findByText('自动入库已开启')).toBeVisible();
    expect(automaticImport).toBeEnabled();
  });

  it('自动入库设置保存失败时回滚开关并显示错误', async () => {
    const user = userEvent.setup();
    const saveOrderIntakeSettings = vi.fn().mockRejectedValue(
      new Error('无法保存自动入库设置'),
    );
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOrderIntakeSettings: vi.fn().mockResolvedValue({
        automaticImportEnabled: false,
      }),
      saveOrderIntakeSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const automaticImport = await screen.findByRole('switch', { name: '自动入库' });
    await user.click(automaticImport);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存自动入库设置');
    expect(automaticImport).toHaveAttribute('aria-checked', 'false');
    expect(automaticImport).toBeEnabled();
  });

  it('OCR 设置读取失败时仍可查看并关闭已开启的自动入库', async () => {
    const user = userEvent.setup();
    const saveOrderIntakeSettings = vi.fn().mockResolvedValue({
      automaticImportEnabled: false,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOrderIntakeSettings: vi.fn().mockResolvedValue({
        automaticImportEnabled: true,
      }),
      saveOrderIntakeSettings,
      getOcrSettings: vi.fn().mockRejectedValue(
        new Error('无法读取系统凭据库中的 OCR 设置'),
      ),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    const automaticImport = await screen.findByRole('switch', { name: '自动入库' });
    expect(automaticImport).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '无法读取系统凭据库中的 OCR 设置',
    );

    await user.click(automaticImport);

    expect(saveOrderIntakeSettings).toHaveBeenCalledWith({
      automaticImportEnabled: false,
    });
    expect(await screen.findByText('自动入库已关闭')).toBeVisible();
    expect(automaticImport).toHaveAttribute('aria-checked', 'false');
  });

  it('OCR 设置一直未返回时也不会阻塞自动入库开关', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOrderIntakeSettings: vi.fn().mockResolvedValue({
        automaticImportEnabled: true,
      }),
      getOcrSettings: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    const automaticImport = await screen.findByRole('switch', { name: '自动入库' });
    expect(automaticImport).toHaveAttribute('aria-checked', 'true');
    expect(automaticImport).toBeEnabled();
    expect(screen.getByText('正在读取 OCR 设置…')).toBeVisible();
  });

  it('从侧栏打开百炼 OCR 设置时只显示密钥状态，不回填 API Key', async () => {
    const user = userEvent.setup();
    const getOcrSettings = vi.fn().mockResolvedValue({
      workspaceId: 'ws-existing',
      region: 'cn-beijing',
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr',
      apiKeyConfigured: true,
      apiKeyMask: '••••••••',
      credentialStore: 'macOS 钥匙串',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [],
      }),
      getOcrSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    expect(await screen.findByRole('heading', { name: '百炼 OCR' })).toBeVisible();
    expect(getOcrSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Workspace ID' })).toHaveValue('ws-existing');
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
    expect(screen.getByText('••••••••')).toBeVisible();
    expect(screen.getByText('已保存在 macOS 钥匙串')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '地域' })).toHaveValue('中国（北京）');
    expect(screen.getByRole('textbox', { name: '地域' })).toHaveAttribute('readonly');
    expect(screen.getByText('qwen3.5-ocr 当前仅开放华北 2（北京）')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveValue('qwen3.5-ocr');
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveAttribute('readonly');

    await user.click(screen.getByRole('button', { name: '订单' }));
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
  });

  it('可保存百炼设置并清空密钥输入，保存失败时显示可读错误', async () => {
    const user = userEvent.setup();
    const savedSettings = {
      workspaceId: 'ws-new',
      region: 'cn-beijing' as const,
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr' as const,
      apiKeyConfigured: true,
      apiKeyMask: '••••••••',
      credentialStore: 'Windows 凭据管理器',
    };
    const saveOcrSettings = vi
      .fn()
      .mockResolvedValueOnce(savedSettings)
      .mockRejectedValueOnce(new Error('无法保存 OCR 设置'));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      saveOcrSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByRole('heading', { name: '百炼 OCR' });

    await user.type(screen.getByRole('textbox', { name: 'Workspace ID' }), 'ws-new');
    await user.type(screen.getByLabelText('API Key'), 'sk-new-secret');
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(saveOcrSettings).toHaveBeenLastCalledWith({
      workspaceId: 'ws-new',
      region: 'cn-beijing',
      apiKey: 'sk-new-secret',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('设置已保存');
    expect(screen.getByLabelText('API Key')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存 OCR 设置');
  });

  it('连接测试必须先展示付费调用提示，再次确认后才发起请求', async () => {
    const user = userEvent.setup();
    const testOcrConnection = vi.fn().mockResolvedValue({
      ok: true,
      model: 'qwen3.5-ocr',
      message: '连接成功，qwen3.5-ocr 可以使用',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOcrSettings: vi.fn().mockResolvedValue({
        workspaceId: 'ws-existing',
        region: 'cn-beijing',
        regionLabel: '中国（北京）',
        model: 'qwen3.5-ocr',
        apiKeyConfigured: true,
        apiKeyMask: '••••••••',
        credentialStore: '测试系统凭据库',
      }),
      testOcrConnection,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(await screen.findByRole('button', { name: '测试连接' }));

    expect(testOcrConnection).not.toHaveBeenCalled();
    expect(
      screen.getByText('发送一张内置测试图片并可能产生一次 OCR 调用'),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: '确认并测试连接' }));
    expect(testOcrConnection).toHaveBeenCalledOnce();
    expect(testOcrConnection).toHaveBeenCalledWith({ consentToPaidCall: true });
    expect(await screen.findByRole('status')).toHaveTextContent(
      '连接成功，qwen3.5-ocr 可以使用',
    );
  });

  it('可从系统凭据库移除 API Key', async () => {
    const user = userEvent.setup();
    const removedSettings = {
      workspaceId: 'ws-existing',
      region: 'cn-beijing' as const,
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr' as const,
      apiKeyConfigured: false,
      apiKeyMask: '',
      credentialStore: '测试系统凭据库',
    };
    const removeOcrApiKey = vi.fn().mockResolvedValue(removedSettings);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOcrSettings: vi.fn().mockResolvedValue({
        ...removedSettings,
        apiKeyConfigured: true,
        apiKeyMask: '••••••••',
      }),
      removeOcrApiKey,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(await screen.findByRole('button', { name: '移除 API Key' }));

    expect(removeOcrApiKey).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent('API Key 已移除');
    expect(screen.getByText('尚未保存 API Key')).toBeVisible();
    expect(screen.queryByText('••••••••')).not.toBeInTheDocument();
  });

  it('候选裁决默认关闭并以独立配置接入 DeepSeek', async () => {
    const user = userEvent.setup();
    const savedSettings = {
      enabled: true,
      provider: 'deepseek' as const,
      baseUrl: 'https://api.deepseek.com',
      baseUrlLocked: true,
      model: 'deepseek-v4-flash',
      apiKeyConfigured: true,
      apiKeyMask: '••••••••',
      credentialStore: 'macOS 钥匙串',
    };
    const saveCandidateVerificationSettings = vi.fn().mockResolvedValue(savedSettings);
    const removeCandidateVerificationApiKey = vi.fn().mockResolvedValue({
      ...savedSettings,
      enabled: false,
      apiKeyConfigured: false,
      apiKeyMask: '',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [],
      }),
      saveCandidateVerificationSettings,
      removeCandidateVerificationApiKey,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    const section = await screen.findByRole('region', { name: '候选裁决（可选）' });
    const toggle = within(section).getByRole('switch', { name: '候选裁决' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(section).toHaveTextContent('不发送截图');
    expect(section).toHaveTextContent('失败时回到人工确认');
    expect(within(section).queryByRole('combobox', { name: '文本模型服务商' }))
      .not.toBeInTheDocument();

    await user.click(toggle);

    expect(within(section).getByRole('combobox', { name: '文本模型服务商' }))
      .toHaveValue('deepseek');
    expect(within(section).getByRole('textbox', { name: '候选裁决 Base URL' }))
      .toHaveValue('https://api.deepseek.com');
    expect(within(section).getByRole('textbox', { name: '候选裁决 Base URL' }))
      .toHaveAttribute('readonly');
    expect(within(section).getByRole('textbox', { name: '候选裁决模型' }))
      .toHaveValue('deepseek-v4-flash');

    await user.type(
      within(section).getByLabelText('候选裁决 API Key'),
      'sk-deepseek-independent',
    );
    await user.click(within(section).getByRole('button', { name: '保存候选裁决设置' }));

    expect(saveCandidateVerificationSettings).toHaveBeenCalledWith({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-deepseek-independent',
    });
    expect(within(section).getByLabelText('候选裁决 API Key')).toHaveValue('');
    expect(within(section).getByRole('status')).toHaveTextContent('候选裁决设置已保存');

    await user.click(within(section).getByRole('button', { name: '移除候选裁决 API Key' }));
    expect(removeCandidateVerificationApiKey).toHaveBeenCalledOnce();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(within(section).queryByRole('combobox', { name: '文本模型服务商' }))
      .not.toBeInTheDocument();
  });

  it('在候选裁决输入框按 Enter 只保存候选配置而不会误保存 OCR', async () => {
    const user = userEvent.setup();
    const saveOcrSettings = vi.fn().mockResolvedValue({
      workspaceId: '',
      region: 'cn-beijing' as const,
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr' as const,
      apiKeyConfigured: false,
      apiKeyMask: '',
      credentialStore: '测试系统凭据库',
    });
    const savedCandidateSettings = {
      enabled: true,
      provider: 'deepseek' as const,
      baseUrl: 'https://api.deepseek.com',
      baseUrlLocked: true,
      model: 'deepseek-v4-flash',
      apiKeyConfigured: true,
      apiKeyMask: '••••••••',
      credentialStore: '测试系统凭据库',
    };
    const saveCandidateVerificationSettings = vi.fn()
      .mockResolvedValue(savedCandidateSettings);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [],
      }),
      saveOcrSettings,
      saveCandidateVerificationSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const section = await screen.findByRole('region', { name: '候选裁决（可选）' });
    await user.click(within(section).getByRole('switch', { name: '候选裁决' }));
    await user.type(
      within(section).getByLabelText('候选裁决 API Key'),
      'sk-enter-submit{Enter}',
    );

    await waitFor(() => {
      expect(saveCandidateVerificationSettings).toHaveBeenCalledWith({
        enabled: true,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-enter-submit',
      });
    });
    expect(saveOcrSettings).not.toHaveBeenCalled();
    expect(within(section).getByRole('status')).toHaveTextContent('候选裁决设置已保存');
  });

  it('候选裁决支持百炼与自定义 OpenAI 兼容端点，连接测试需独立确认费用', async () => {
    const user = userEvent.setup();
    const testCandidateVerificationConnection = vi.fn().mockResolvedValue({
      ok: true,
      provider: 'aliyun-bailian',
      model: 'qwen3.7-plus',
      message: '连接成功，qwen3.7-plus 可以用于候选裁决',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getCandidateVerificationSettings: vi.fn().mockResolvedValue({
        enabled: true,
        provider: 'aliyun-bailian',
        baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        baseUrlLocked: false,
        model: 'qwen3.7-plus',
        apiKeyConfigured: true,
        apiKeyMask: '••••••••',
        credentialStore: 'Windows 凭据管理器',
      }),
      testCandidateVerificationConnection,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const section = await screen.findByRole('region', { name: '候选裁决（可选）' });
    const provider = within(section).getByRole('combobox', { name: '文本模型服务商' });
    expect(within(provider).getByRole('option', { name: '阿里云百炼' })).toBeInTheDocument();
    expect(within(provider).getByRole('option', { name: '自定义 OpenAI 兼容' }))
      .toBeInTheDocument();
    expect(section).toHaveTextContent('自动追加 /chat/completions');
    expect(section).toHaveTextContent('JSON Output');

    const testConnectionButton = within(section).getByRole('button', {
      name: '测试候选裁决连接',
    });
    const modelInput = within(section).getByRole('textbox', { name: '候选裁决模型' });
    await user.clear(modelInput);
    await user.type(modelInput, 'qwen3.7-plus-preview');
    expect(testConnectionButton).toBeDisabled();
    await user.clear(modelInput);
    await user.type(modelInput, 'qwen3.7-plus');

    await user.click(testConnectionButton);
    expect(testCandidateVerificationConnection).not.toHaveBeenCalled();
    expect(within(section).getByText('本次测试会产生 1 次文本模型调用')).toBeVisible();

    await user.click(within(section).getByRole('button', { name: '确认并测试文本模型' }));
    expect(testCandidateVerificationConnection).toHaveBeenCalledWith({
      consentToPaidCall: true,
    });
    expect(await within(section).findByRole('status')).toHaveTextContent(
      'qwen3.7-plus 可以用于候选裁决',
    );
  });

  it('打开已保存订单模板后原子恢复查询、列别名、顺序和自定义字段值', async () => {
    const user = userEvent.setup();
    const summary = orderSummary(confirmedOrder, {
      addressOriginal: '广东省深圳市南山区模板路1号',
    });
    const noteField: CustomFieldDefinition = {
      id: 'field-template-note',
      name: '内部备注',
      granularity: 'order',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const template: TableTemplate = {
      id: 'template-picking',
      name: '待发货拣货',
      granularity: 'order',
      columns: [
        { field: { kind: 'custom', definitionId: noteField.id }, displayName: '跟单说明' },
        { field: { kind: 'computed', key: 'order_total' }, displayName: '实付' },
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '平台单号' },
      ],
      query: {
        dateField: 'ordered_at',
        lifecycleStatus: 'active',
        fulfillmentStatus: 'pending_shipment',
        sortField: 'amount',
        sortDirection: 'desc',
        customFieldFilter: { definitionId: noteField.id, value: '加急' },
      },
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const result = workbenchResult([summary], {
      customFieldValues: [{
        definitionId: noteField.id,
        orderId: summary.id,
        orderItemId: null,
        value: '加急',
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      }],
    });
    const queryOrders = vi.fn().mockResolvedValue(result);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([noteField]),
      listTableTemplates: vi.fn().mockResolvedValue([template]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '表格模板' }));
    await user.click(await screen.findByRole('button', { name: '应用 待发货拣货' }));

    await waitFor(() => expect(queryOrders).toHaveBeenCalledWith(template.query, [noteField.id]));
    const table = await screen.findByRole('table', { name: '原始订单' });
    expect(within(table).getAllByRole('columnheader').slice(1, 4).map((cell) => cell.textContent))
      .toEqual(['跟单说明', '实付', '平台单号']);
    const row = within(table).getByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    }).closest('tr');
    expect(row).toHaveTextContent(`加急¥8.00${summary.orderNumber}`);
    expect(screen.getByRole('combobox', { name: '表格模板' })).toHaveValue(template.id);
    expect(screen.getByRole('combobox', { name: '自定义字段筛选' })).toHaveValue(noteField.id);

    expect(queryOrders.mock.calls.filter(([query]) => (
      JSON.stringify(query) === JSON.stringify(template.query)
    ))).toHaveLength(1);
    queryOrders.mockClear();
    await user.selectOptions(screen.getByRole('combobox', { name: '表格模板' }), '');

    await waitFor(() => expect(queryOrders).toHaveBeenCalledWith({
      dateField: 'ordered_at',
      lifecycleStatus: 'active',
      sortField: 'created_at',
      sortDirection: 'desc',
    }, [noteField.id]));
    expect(screen.getByRole('combobox', { name: '表格模板' })).toHaveValue('');
    expect(within(table).getAllByRole('columnheader').slice(1, 4).map((cell) => cell.textContent))
      .toEqual(['系统订单编号', '订单号', '平台']);
  });

  it('应用订单模板后导出切换到其他模板仍预加载其自定义字段值', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const createdAt = '2026-07-30T00:00:00.000Z';
    const fieldA: CustomFieldDefinition = {
      id: 'field-template-a',
      name: 'A 模板备注',
      granularity: 'order',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
      createdAt,
      updatedAt: createdAt,
    };
    const fieldB: CustomFieldDefinition = {
      id: 'field-template-b',
      name: 'B 模板备注',
      granularity: 'order',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
      createdAt,
      updatedAt: createdAt,
    };
    const templateA: TableTemplate = {
      id: 'template-a',
      name: '订单模板 A',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
        { field: { kind: 'custom', definitionId: fieldA.id }, displayName: 'A 跟单' },
      ],
      query: { fulfillmentStatus: 'pending_shipment' },
      createdAt,
      updatedAt: createdAt,
    };
    const templateB: TableTemplate = {
      id: 'template-b',
      name: '订单模板 B',
      granularity: 'order',
      columns: [
        { field: { kind: 'custom', definitionId: fieldB.id }, displayName: 'B 跟单' },
        { field: { kind: 'custom', definitionId: fieldA.id }, displayName: 'A 备用' },
      ],
      query: {},
      createdAt,
      updatedAt: createdAt,
    };
    const allValues: CustomFieldValueRecord[] = [
      {
        definitionId: fieldA.id,
        orderId: summary.id,
        orderItemId: null,
        value: 'A 值',
        createdAt,
        updatedAt: createdAt,
      },
      {
        definitionId: fieldB.id,
        orderId: summary.id,
        orderItemId: null,
        value: 'B 值',
        createdAt,
        updatedAt: createdAt,
      },
    ];
    const queryOrders = vi.fn(async (
      _query: OrderWorkbenchQuery,
      definitionIds: readonly string[] = [],
    ) => workbenchResult([summary], {
      customFieldValues: allValues.filter(({ definitionId }) => (
        definitionIds.includes(definitionId)
      )),
    }));
    const exportOrders = vi.fn().mockResolvedValue({ kind: 'cancelled' as const });
    const previewOrderExport = vi.fn(async (input: Parameters<DesktopApi['previewOrderExport']>[0]) => ({
      orderCount: 1,
      orderItemCount: null,
      sheets: [input.orderTemplateId === templateB.id
        ? exportPreviewSheet('订单总表', ['B 跟单', 'A 备用'], [['B 值', 'A 值']])
        : exportPreviewSheet('订单总表', ['订单号', 'A 跟单'], [[summary.orderNumber, 'A 值']])],
    }));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([fieldA, fieldB]),
      listTableTemplates: vi.fn().mockResolvedValue([templateA, templateB]),
      previewOrderExport,
      exportOrders,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '表格模板' }));
    await user.click(await screen.findByRole('button', { name: '应用 订单模板 A' }));

    await waitFor(() => expect(queryOrders).toHaveBeenCalledWith(
      templateA.query,
      [fieldA.id, fieldB.id],
    ));
    await user.click(await screen.findByRole('button', { name: '导出当前结果 1 笔' }));
    const dialog = screen.getByRole('dialog', { name: '导出订单 Excel' });
    const orderTemplateSelect = within(dialog).getByRole('combobox', {
      name: '订单总表模板',
    });
    expect(orderTemplateSelect).toHaveValue(templateA.id);
    const initialPreview = await within(dialog).findByRole('table', {
      name: '订单总表导出预览',
    });
    const initialHeaders = within(initialPreview).getAllByRole('columnheader')
      .map(({ textContent }) => textContent);
    expect(initialHeaders).toEqual(['订单号', 'A 跟单']);
    expect(initialHeaders).not.toContain('备注');
    await user.click(within(dialog).getByRole('button', { name: '保存 Excel' }));
    await waitFor(() => expect(exportOrders).toHaveBeenCalledWith({
      scope: { kind: 'current_result', orderIds: [summary.id] },
      orderTemplateId: templateA.id,
      includeOrderItems: false,
      orderItemTemplateId: null,
      masking: 'masked',
    }));

    await user.click(await screen.findByRole('button', { name: '导出当前结果 1 笔' }));
    const reopenedDialog = screen.getByRole('dialog', { name: '导出订单 Excel' });
    await user.selectOptions(
      within(reopenedDialog).getByRole('combobox', { name: '订单总表模板' }),
      templateB.id,
    );
    const preview = await within(reopenedDialog).findByRole('table', { name: '订单总表导出预览' });
    expect(within(preview).getAllByRole('columnheader').map(({ textContent }) => textContent))
      .toEqual(['B 跟单', 'A 备用']);
    expect(within(preview).getByText('B 值')).toBeVisible();
  });

  it('订单模板字段库提供四项运营概况并在订单表按投影值显示', async () => {
    const user = userEvent.setup();
    const summary = orderSummary(confirmedOrder, {
      operations: {
        shipmentSummary: '部分发货（已发 1 / 共 2 件）',
        logisticsSummary: '运输中',
        aftersalesSummary: '等待退回',
        currentTodo: '等待买家退回',
      },
    });
    const template: TableTemplate = {
      id: 'template-order-operations',
      name: '订单运营看板',
      granularity: 'order',
      columns: [
        { field: { kind: 'computed', key: 'shipment_summary' }, displayName: '发货概况' },
        { field: { kind: 'computed', key: 'logistics_summary' }, displayName: '物流概况' },
        { field: { kind: 'computed', key: 'aftersales_summary' }, displayName: '售后概况' },
        { field: { kind: 'computed', key: 'current_todo' }, displayName: '当前待办' },
      ],
      query: {},
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      listTableTemplates: vi.fn().mockResolvedValue([template]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '表格模板' }));
    for (const fieldName of ['发货概况', '物流概况', '售后概况', '当前待办']) {
      expect(await screen.findByRole('checkbox', { name: fieldName })).toBeVisible();
    }
    await user.click(screen.getByRole('button', { name: '应用 订单运营看板' }));

    const table = await screen.findByRole('table', { name: '原始订单' });
    expect(within(table).getAllByRole('columnheader').slice(1, 5).map(({ textContent }) => (
      textContent
    ))).toEqual(['发货概况', '物流概况', '售后概况', '当前待办']);
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('部分发货（已发 1 / 共 2 件）');
    expect(row).toHaveTextContent('运输中');
    expect(row).toHaveTextContent('等待退回');
    expect(row).toHaveTextContent('等待买家退回');
  });

  it('模板不包含订单号时仍保留独立的订单详情入口', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const template: TableTemplate = {
      id: 'template-total-only',
      name: '金额概览',
      granularity: 'order',
      columns: [{
        field: { kind: 'computed', key: 'order_total' },
        displayName: '成交金额',
      }],
      query: {},
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const getOrder = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      sources: [],
      changeEvents: [],
      customFieldValues: [],
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      listTableTemplates: vi.fn().mockResolvedValue([template]),
      getOrder,
    });

    render(<App api={api} />);
    const templateSelect = await screen.findByRole('combobox', { name: '表格模板' });
    await screen.findByRole('option', { name: template.name });
    await user.selectOptions(templateSelect, template.id);

    const table = await screen.findByRole('table', { name: '原始订单' });
    expect(within(table).queryByText(summary.orderNumber)).not.toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: `打开订单详情 ${summary.orderNumber}` }));
    await waitFor(() => expect(getOrder).toHaveBeenCalledWith(summary.id));
  });

  it('删除正在应用的模板时同步恢复默认查询与列', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const remainingField: CustomFieldDefinition = {
      id: 'field-remaining-template',
      name: '剩余模板备注',
      granularity: 'order',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const template: TableTemplate = {
      id: 'template-active-delete',
      name: '待发货临时视图',
      granularity: 'order',
      columns: [{ field: { kind: 'computed', key: 'order_total' }, displayName: '实付' }],
      query: { fulfillmentStatus: 'pending_shipment' },
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const remainingTemplate: TableTemplate = {
      id: 'template-remaining',
      name: '剩余订单视图',
      granularity: 'order',
      columns: [{
        field: { kind: 'custom', definitionId: remainingField.id },
        displayName: '剩余备注',
      }],
      query: {},
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const queryOrders = vi.fn().mockResolvedValue(workbenchResult([summary]));
    const deleteTableTemplate = vi.fn().mockResolvedValue(undefined);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([remainingField]),
      listTableTemplates: vi.fn().mockResolvedValue([template, remainingTemplate]),
      deleteTableTemplate,
    });

    render(<App api={api} />);
    const templateSelect = await screen.findByRole('combobox', { name: '表格模板' });
    await screen.findByRole('option', { name: template.name });
    await user.selectOptions(templateSelect, template.id);
    await user.click(screen.getByRole('button', { name: '表格模板' }));
    queryOrders.mockClear();
    await user.click(await screen.findByRole('button', { name: '删除 待发货临时视图' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(queryOrders).toHaveBeenCalledWith({
      dateField: 'ordered_at',
      lifecycleStatus: 'active',
      sortField: 'created_at',
      sortDirection: 'desc',
    }, [remainingField.id]));
    expect(deleteTableTemplate).toHaveBeenCalledWith(template.id);
    await user.click(screen.getByRole('button', { name: '订单' }));
    const table = await screen.findByRole('table', { name: '原始订单' });
    expect(within(table).getAllByRole('columnheader').slice(1, 4).map((cell) => cell.textContent))
      .toEqual(['系统订单编号', '订单号', '平台']);
    expect(screen.getByRole('combobox', { name: '表格模板' })).toHaveValue('');
  });

  it('后端返回查询键顺序不同时仍正确判定模板已保存', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const template: TableTemplate = {
      id: 'template-query-order',
      name: '筛选保存',
      granularity: 'order',
      columns: [{ field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' }],
      query: {
        dateField: 'ordered_at',
        lifecycleStatus: 'active',
        fulfillmentStatus: 'pending_shipment',
        sortField: 'created_at',
        sortDirection: 'desc',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const updateTableTemplate = vi.fn().mockImplementation(async (
      _templateId: string,
      input: UpdateTableTemplateInput,
    ) => ({
      ...template,
      ...input,
      query: {
        sortDirection: (input.query as OrderWorkbenchQuery).sortDirection,
        sortField: (input.query as OrderWorkbenchQuery).sortField,
        fulfillmentStatus: (input.query as OrderWorkbenchQuery).fulfillmentStatus,
        lifecycleStatus: (input.query as OrderWorkbenchQuery).lifecycleStatus,
        dateField: (input.query as OrderWorkbenchQuery).dateField,
      },
      updatedAt: '2026-07-30T01:00:00.000Z',
    }));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      listTableTemplates: vi.fn().mockResolvedValue([template]),
      updateTableTemplate,
    });

    render(<App api={api} />);
    const templateSelect = await screen.findByRole('combobox', { name: '表格模板' });
    await screen.findByRole('option', { name: template.name });
    await user.selectOptions(templateSelect, template.id);
    await user.selectOptions(screen.getByRole('combobox', { name: '排序方式' }), 'amount:asc');
    expect(screen.getByText('筛选或排序已修改')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '保存当前筛选排序' }));

    await waitFor(() => expect(updateTableTemplate).toHaveBeenCalledOnce());
    expect(screen.getByText('已应用保存配置')).toBeVisible();
    expect(screen.queryByText('筛选或排序已修改')).not.toBeInTheDocument();
  });

  it('在订单页应用模板失败时保留当前视图并显示原因', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const template: TableTemplate = {
      id: 'template-failing',
      name: '暂时不可用',
      granularity: 'order',
      columns: [{ field: { kind: 'computed', key: 'order_total' }, displayName: '成交金额' }],
      query: { fulfillmentStatus: 'pending_shipment' },
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const queryOrders = vi.fn().mockImplementation(async (query) => {
      if (query.fulfillmentStatus === 'pending_shipment') {
        throw new Error('模板查询失败');
      }
      return workbenchResult([summary]);
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
      listTableTemplates: vi.fn().mockResolvedValue([template]),
    });

    render(<App api={api} />);
    const templateSelect = await screen.findByRole('combobox', { name: '表格模板' });
    await screen.findByRole('option', { name: template.name });
    await user.selectOptions(templateSelect, template.id);

    expect(await screen.findByRole('alert')).toHaveTextContent('模板查询失败');
    expect(screen.getByRole('combobox', { name: '表格模板' })).toHaveValue('');
    expect(screen.getByRole('table', { name: '原始订单' })).toBeVisible();
  });

  it('默认订单商品明细视图以一个商品条目一行展示完整原始字段', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const item = {
      ...confirmedOrder.items[0],
      orderId: confirmedOrder.id,
      systemOrderNumber: confirmedOrder.systemOrderNumber,
      orderNumber: confirmedOrder.orderNumber,
    };
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      queryOrderItems: vi.fn().mockResolvedValue({ items: [item], customFieldValues: [] }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('tab', { name: '订单商品明细' }));

    const table = await screen.findByRole('table', { name: '订单商品明细' });
    expect(within(table).getAllByRole('columnheader').slice(0, -1).map((cell) => cell.textContent))
      .toEqual([
        '系统订单编号',
        '订单号',
        '商品序号',
        '原始商品标题',
        '原始款式／规格',
        '商品单价',
        '数量',
        '数量来源',
        '商品小计',
      ]);
    const row = within(table).getByRole('button', {
      name: `打开订单 ${confirmedOrder.orderNumber}`,
    }).closest('tr');
    expect(row).toHaveTextContent(confirmedOrder.orderNumber);
    expect(row).toHaveTextContent(confirmedOrder.items[0].sourceTitle);
    expect(row).toHaveTextContent(confirmedOrder.items[0].sourceSpec);
    expect(row).toHaveTextContent('¥8.00');
    expect(row).toHaveTextContent('¥16.00');
    expect(row).toHaveTextContent('已明确（历史来源不明）');
  });

  it('订单商品明细视图从内置控件发起精确事实筛选和排序', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const item = {
      ...confirmedOrder.items[0],
      orderId: confirmedOrder.id,
      orderNumber: confirmedOrder.orderNumber,
    };
    const queryOrderItems = vi.fn().mockResolvedValue({
      items: [item],
      customFieldValues: [],
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      queryOrderItems,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('tab', { name: '订单商品明细' }));
    await screen.findByRole('table', { name: '订单商品明细' });

    await user.type(screen.getByRole('searchbox', { name: '原始商品标题精确筛选' }), '脱敏测试商品');
    await user.type(screen.getByRole('searchbox', { name: '原始款式／规格精确筛选' }), '白色');
    await user.type(screen.getByRole('spinbutton', { name: '商品单价（元）精确筛选' }), '8.00');
    await user.type(screen.getByRole('spinbutton', { name: '商品数量精确筛选' }), '2');
    await user.selectOptions(
      screen.getByRole('combobox', { name: '商品数量来源精确筛选' }),
      'manual',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: '订单商品明细内置排序' }),
      'unit_price:desc',
    );

    await waitFor(() => expect(queryOrderItems).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceTitle: '脱敏测试商品',
        sourceSpec: '白色',
        unitPriceCents: 800,
        quantity: 2,
        quantitySource: 'manual',
        sortField: 'unit_price',
        sortDirection: 'desc',
      }),
      [],
    ));
  });

  it('应用商品模板时切换数据粒度并按模板列展示商品自定义值', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const binField: CustomFieldDefinition = {
      id: 'field-item-bin-template',
      name: '拣货位',
      granularity: 'order_item',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const template: TableTemplate = {
      id: 'template-items',
      name: '商品拣货',
      granularity: 'order_item',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '关联单号' },
        { field: { kind: 'custom', definitionId: binField.id }, displayName: '货位' },
        { field: { kind: 'computed', key: 'item_subtotal' }, displayName: '行金额' },
      ],
      query: { customFieldSort: { definitionId: binField.id, direction: 'asc' } },
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const item = {
      ...confirmedOrder.items[0],
      orderId: confirmedOrder.id,
      orderNumber: confirmedOrder.orderNumber,
    };
    const queryOrderItems = vi.fn().mockResolvedValue({
      items: [item],
      customFieldValues: [{
        definitionId: binField.id,
        orderId: null,
        orderItemId: item.id,
        value: 'A-01',
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      }],
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      queryOrderItems,
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([binField]),
      listTableTemplates: vi.fn().mockResolvedValue([template]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '表格模板' }));
    await user.click(await screen.findByRole('tab', { name: '订单商品明细表模板' }));
    await user.click(await screen.findByRole('button', { name: '应用 商品拣货' }));

    await waitFor(() => expect(queryOrderItems).toHaveBeenCalledWith(template.query, [binField.id]));
    expect(screen.getByRole('tab', { name: '订单商品明细' }))
      .toHaveAttribute('aria-selected', 'true');
    const table = await screen.findByRole('table', { name: '订单商品明细' });
    expect(within(table).getAllByRole('columnheader').slice(0, 3).map((cell) => cell.textContent))
      .toEqual(['关联单号', '货位', '行金额']);
    expect(within(table).getByText('A-01')).toBeVisible();
    expect(within(table).getByText('¥16.00')).toBeVisible();
  });

  it('默认只导出订单总表，勾选后才保存订单商品明细表', async () => {
    const user = userEvent.setup();
    const first = orderSummary();
    const second = orderSummary(confirmedOrder, {
      id: 'order-2',
      orderNumber: 'XY-TEST-20260727-0002',
      items: [
        { sourceTitle: '同款测试商品', sourceSpec: '大号', quantity: 1 },
        { sourceTitle: '同款测试商品', sourceSpec: '小号', quantity: 2 },
      ],
      itemCount: 3,
    });
    const orderTemplate: TableTemplate = {
      id: 'template-export-orders',
      name: '财务订单表',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '平台单号' },
        { field: { kind: 'builtin', key: 'buyer_nickname' }, displayName: '买家' },
        { field: { kind: 'builtin', key: 'recipient' }, displayName: '收件人' },
        { field: { kind: 'builtin', key: 'phone' }, displayName: '手机号' },
        { field: { kind: 'builtin', key: 'address' }, displayName: '收货地址' },
        {
          kind: 'dynamic_product_group',
          labels: { product: '品名', specification: '规格', quantity: '件数' },
        },
        { field: { kind: 'computed', key: 'order_total' }, displayName: '实付' },
      ],
      query: {},
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const itemTemplate: TableTemplate = {
      id: 'template-export-items',
      name: '拣货商品表',
      granularity: 'order_item',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '平台单号' },
        { field: { kind: 'builtin', key: 'product_title' }, displayName: '商品' },
      ],
      query: {},
      createdAt: orderTemplate.createdAt,
      updatedAt: orderTemplate.updatedAt,
    };
    const exportOrders = vi.fn().mockResolvedValue({
      kind: 'saved',
      fileName: '闲鱼订单-20260731.xlsx',
      filePath: 'D:\\导出\\闲鱼订单-20260731.xlsx',
      orderCount: 2,
      orderItemCount: 3,
    });
    const previewOrderExport = vi.fn(async (input: Parameters<DesktopApi['previewOrderExport']>[0]) => {
      const orderHeaders = input.orderTemplateId === orderTemplate.id
        ? [
          '平台单号', '买家', '收件人', '手机号', '收货地址',
          '品名1', '规格1', '件数1', '品名2', '规格2', '件数2', '实付',
        ]
        : ['系统订单编号', '订单号'];
      const orderRows = input.orderTemplateId === orderTemplate.id
        ? [
          [
            first.orderNumber,
            input.masking === 'masked' ? '测**家' : first.buyerNickname,
            input.masking === 'masked' ? '人******' : first.recipient,
            input.masking === 'masked' ? '138****0000' : first.phone,
            input.masking === 'masked' ? '广东省深圳市南山区***' : first.addressOriginal,
            '脱敏测试商品', '白色', '2', '', '', '', '¥8.00',
          ],
          [
            second.orderNumber,
            input.masking === 'masked' ? '测**家' : second.buyerNickname,
            input.masking === 'masked' ? '人******' : second.recipient,
            input.masking === 'masked' ? '138****0000' : second.phone,
            input.masking === 'masked' ? '广东省深圳市南山区***' : second.addressOriginal,
            '同款测试商品', '大号', '1', '同款测试商品', '小号', '2', '¥8.00',
          ],
        ]
        : [
          [first.systemOrderNumber, first.orderNumber],
          [second.systemOrderNumber, second.orderNumber],
        ];
      return {
        orderCount: 2,
        orderItemCount: input.includeOrderItems ? 3 : null,
        sheets: [
          exportPreviewSheet('订单总表', orderHeaders, orderRows),
          ...(input.includeOrderItems ? [exportPreviewSheet(
            '订单商品明细表',
            input.orderItemTemplateId === itemTemplate.id
              ? ['平台单号', '商品']
              : ['系统订单编号', '订单号', '商品序号'],
            input.orderItemTemplateId === itemTemplate.id
              ? [
                [first.orderNumber, '脱敏测试商品'],
                [second.orderNumber, '同款测试商品'],
                [second.orderNumber, '同款测试商品'],
              ]
              : [
                [first.systemOrderNumber, first.orderNumber, '1'],
                [second.systemOrderNumber, second.orderNumber, '1'],
                [second.systemOrderNumber, second.orderNumber, '2'],
              ],
          )] : []),
        ],
      };
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [first, second],
      }),
      listOrders: vi.fn().mockResolvedValue([first, second]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([first, second])),
      listTableTemplates: vi.fn().mockResolvedValue([orderTemplate, itemTemplate]),
      previewOrderExport,
      exportOrders,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '导出当前结果 2 笔' }));

    const dialog = screen.getByRole('dialog', { name: '导出订单 Excel' });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.closest('.workspace-enter')).toBeNull();
    expect(within(dialog).getByText('2 笔订单')).toBeVisible();
    expect(within(dialog).queryByText('3 条订单商品明细')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', {
      name: '订单商品明细表模板',
    })).not.toBeInTheDocument();
    expect(within(dialog).getByText('收件人仅保留姓氏')).toBeVisible();
    expect(within(dialog).getByText('手机号保留前 3 后 4 位')).toBeVisible();
    expect(within(dialog).getByText('地址仅保留省、市、区县')).toBeVisible();
    expect(within(dialog).getByText('买家昵称仅保留首尾字符')).toBeVisible();
    const masking = within(dialog).getByRole('checkbox', { name: /导出时脱敏/u });
    expect(masking).toBeChecked();
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '订单总表模板' }),
      orderTemplate.id,
    );
    expect(within(
      await within(dialog).findByRole('table', { name: '订单总表导出预览' }),
    ).getAllByRole('columnheader').map(({ textContent }) => textContent)).toEqual([
      '平台单号',
      '买家', '收件人', '手机号', '收货地址',
      '品名1', '规格1', '件数1',
      '品名2', '规格2', '件数2',
      '实付',
    ]);
    const previewRows = within(
      within(dialog).getByRole('table', { name: '订单总表导出预览' }),
    ).getAllByRole('row');
    expect(previewRows).toHaveLength(3);
    expect(within(previewRows[1]).getAllByRole('cell').map(({ textContent }) => textContent))
      .toEqual([
        first.orderNumber,
        '测**家', '人******', '138****0000', '广东省深圳市南山区***',
        '脱敏测试商品', '白色', '2',
        '', '', '',
        '¥8.00',
      ]);
    expect(within(previewRows[2]).getAllByRole('cell').map(({ textContent }) => textContent))
      .toEqual([
        second.orderNumber,
        '测**家', '人******', '138****0000', '广东省深圳市南山区***',
        '同款测试商品', '大号', '1',
        '同款测试商品', '小号', '2',
        '¥8.00',
      ]);
    expect(within(dialog).queryByText(confirmedOrder.phone)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(confirmedOrder.addressOriginal)).not.toBeInTheDocument();
    await user.click(masking);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '完整收件人、手机号、收货地址和买家昵称',
    );
    const originalPreview = await within(dialog).findByRole('table', {
      name: '订单总表导出预览',
    });
    expect(within(originalPreview).getAllByText(first.phone)).toHaveLength(2);
    expect(within(originalPreview).getAllByText(first.addressOriginal)).toHaveLength(2);
    await user.click(masking);
    expect(within(dialog).queryByText(/隐私提醒/u)).not.toBeInTheDocument();
    expect(await within(dialog).findAllByText('138****0000')).toHaveLength(2);
    const includeOrderItems = within(dialog).getByRole('checkbox', {
      name: /附加订单商品明细表/u,
    });
    expect(includeOrderItems).not.toBeChecked();
    await user.click(includeOrderItems);
    expect(within(dialog).getByText('3 条订单商品明细')).toBeVisible();
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '订单商品明细表模板' }),
      itemTemplate.id,
    );
    const itemPreviewTab = await within(dialog).findByRole('tab', {
      name: '订单商品明细表预览',
    });
    await user.click(itemPreviewTab);
    const itemPreview = await within(dialog).findByRole('table', {
      name: '订单商品明细表导出预览',
    });
    expect(within(itemPreview).getAllByRole('columnheader').map(({ textContent }) => textContent))
      .toEqual(['平台单号', '商品']);
    expect(within(itemPreview).getAllByRole('row')).toHaveLength(4);
    await user.click(includeOrderItems);
    expect(within(dialog).queryByRole('tab', { name: '订单商品明细表预览' }))
      .not.toBeInTheDocument();
    expect(await within(dialog).findByRole('tab', { name: '订单总表预览' }))
      .toHaveAttribute('aria-selected', 'true');
    await user.click(includeOrderItems);
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '订单商品明细表模板' }),
      itemTemplate.id,
    );
    await within(dialog).findByRole('tab', { name: '订单商品明细表预览' });
    await user.click(within(dialog).getByRole('button', { name: '保存 Excel' }));

    await waitFor(() => expect(exportOrders).toHaveBeenCalledWith({
      scope: {
        kind: 'current_result',
        orderIds: [first.id, second.id],
      },
      orderTemplateId: orderTemplate.id,
      includeOrderItems: true,
      orderItemTemplateId: itemTemplate.id,
      masking: 'masked',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '已导出 2 笔订单、3 条订单商品明细：闲鱼订单-20260731.xlsx',
    );
    expect(screen.queryByRole('dialog', { name: '导出订单 Excel' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导出当前结果 2 笔' }));
    const reopened = screen.getByRole('dialog', { name: '导出订单 Excel' });
    expect(within(reopened).getByRole('checkbox', { name: /导出时脱敏/u })).toBeChecked();
  });

  it('导出预览只接受最新模板请求，较晚返回的旧结果不会覆盖界面', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const template: TableTemplate = {
      id: 'template-latest-preview',
      name: '最新预览模板',
      granularity: 'order',
      columns: [{ field: { kind: 'builtin', key: 'order_number' }, displayName: '最新表头' }],
      query: {},
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    type PreviewResult = Awaited<ReturnType<DesktopApi['previewOrderExport']>>;
    let resolveOld!: (result: PreviewResult) => void;
    let resolveLatest!: (result: PreviewResult) => void;
    const oldRequest = new Promise<PreviewResult>((resolve) => {
      resolveOld = resolve;
    });
    const latestRequest = new Promise<PreviewResult>((resolve) => {
      resolveLatest = resolve;
    });
    const previewOrderExport = vi.fn()
      .mockReturnValueOnce(oldRequest)
      .mockReturnValueOnce(latestRequest);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      listTableTemplates: vi.fn().mockResolvedValue([template]),
      previewOrderExport,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '导出当前结果 1 笔' }));
    const dialog = screen.getByRole('dialog', { name: '导出订单 Excel' });
    await within(dialog).findByRole('option', { name: template.name });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '订单总表模板' }),
      template.id,
    );
    await act(async () => resolveLatest({
      orderCount: 1,
      orderItemCount: null,
      sheets: [exportPreviewSheet('订单总表', ['最新表头'], [[summary.orderNumber]])],
    }));
    expect(await within(dialog).findByRole('columnheader', { name: '最新表头' })).toBeVisible();

    await act(async () => resolveOld({
      orderCount: 1,
      orderItemCount: null,
      sheets: [exportPreviewSheet('订单总表', ['过期表头'], [['过期值']])],
    }));
    expect(within(dialog).queryByRole('columnheader', { name: '过期表头' }))
      .not.toBeInTheDocument();
    expect(within(dialog).getByRole('columnheader', { name: '最新表头' })).toBeVisible();
  });

  it('真实导出预览加载中或失败时禁止保存', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    let rejectPreview!: (reason: Error) => void;
    const pendingPreview = new Promise<Awaited<ReturnType<DesktopApi['previewOrderExport']>>>(
      (_resolve, reject) => {
        rejectPreview = reject;
      },
    );
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      previewOrderExport: vi.fn().mockReturnValue(pendingPreview),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '导出当前结果 1 笔' }));
    const dialog = screen.getByRole('dialog', { name: '导出订单 Excel' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('正在生成真实导出预览');
    expect(within(dialog).getByRole('button', { name: '保存 Excel' })).toBeDisabled();

    await act(async () => rejectPreview(new Error('导出预览服务不可用')));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('导出预览服务不可用');
    expect(within(dialog).getByRole('button', { name: '保存 Excel' })).toBeDisabled();
  });

  it('勾选订单后默认仅预览并导出所选订单总表', async () => {
    const user = userEvent.setup();
    const first = orderSummary();
    const second = orderSummary(confirmedOrder, {
      id: 'order-selected-export',
      orderNumber: 'XY-TEST-20260727-SELECTED',
      items: [
        { sourceTitle: '所选商品 A', sourceSpec: '大号', quantity: 1 },
        { sourceTitle: '所选商品 B', sourceSpec: '小号', quantity: 2 },
      ],
      itemCount: 3,
    });
    const exportOrders = vi.fn().mockResolvedValue({ kind: 'cancelled' });
    const selectedHeaders = [
      '系统订单编号', '订单号',
      '商品1', '款式或规格1', '数量1',
      '商品2', '款式或规格2', '数量2',
    ];
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [first, second],
      }),
      listOrders: vi.fn().mockResolvedValue([first, second]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([first, second])),
      previewOrderExport: vi.fn().mockResolvedValue({
        orderCount: 1,
        orderItemCount: null,
        sheets: [exportPreviewSheet('订单总表', selectedHeaders, [[
          second.systemOrderNumber,
          second.orderNumber,
          '所选商品 A', '大号', '1',
          '所选商品 B', '小号', '2',
        ]])],
      }),
      exportOrders,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('checkbox', {
      name: `选择订单 ${second.orderNumber}`,
    }));
    await user.click(screen.getByRole('button', { name: '导出已选 1 笔' }));

    const dialog = screen.getByRole('dialog', { name: '导出订单 Excel' });
    expect(within(dialog).getByText('1 笔订单')).toBeVisible();
    expect(within(dialog).queryByText('2 条订单商品明细')).not.toBeInTheDocument();
    const previewTable = await within(dialog).findByRole('table', {
      name: '订单总表导出预览',
    });
    const previewHeaders = within(previewTable).getAllByRole('columnheader')
      .map(({ textContent }) => textContent);
    expect(previewHeaders).toEqual(expect.arrayContaining([
      '商品1', '款式或规格1', '数量1',
      '商品2', '款式或规格2', '数量2',
    ]));
    expect(previewHeaders).not.toContain('商品3');
    const previewRows = within(previewTable).getAllByRole('row');
    expect(previewRows).toHaveLength(2);
    const selectedCells = within(previewRows[1]).getAllByRole('cell')
      .map(({ textContent }) => textContent);
    expect(selectedCells[previewHeaders.indexOf('订单号')]).toBe(second.orderNumber);
    expect(selectedCells[previewHeaders.indexOf('商品1')]).toBe('所选商品 A');
    expect(selectedCells[previewHeaders.indexOf('款式或规格1')]).toBe('大号');
    expect(selectedCells[previewHeaders.indexOf('商品2')]).toBe('所选商品 B');
    expect(selectedCells[previewHeaders.indexOf('款式或规格2')]).toBe('小号');
    await user.click(within(dialog).getByRole('button', { name: '保存 Excel' }));

    await waitFor(() => expect(exportOrders).toHaveBeenCalledWith({
      scope: {
        kind: 'selected_orders',
        orderIds: [second.id],
      },
      orderTemplateId: null,
      includeOrderItems: false,
      orderItemTemplateId: null,
      masking: 'masked',
    }));
  });

  it('管理预置与自定义售后流程版本', async () => {
    const user = userEvent.setup();
    const refundOnly = testWorkflowTemplates.find(({ scenario }) => scenario === 'refund_only')!;
    const setEnabled = vi.fn().mockResolvedValue({ ...refundOnly, enabled: false });
    const createTemplate = vi.fn(async (input) => ({
      id: 'custom-workflow-ui',
      origin: 'custom' as const,
      systemKey: null,
      enabled: true,
      version: 1,
      ...input,
      workflow: aftersalesWorkflowForScenario(input.scenario),
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
      versionCreatedAt: '2026-08-14T00:00:00.000Z',
    }));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready', dataDirectory: '/Users/test/闲鱼订单', orders: [],
      }),
      listAftersalesWorkflowTemplates: vi.fn().mockResolvedValue(testWorkflowTemplates),
      setAftersalesWorkflowTemplateEnabled: setEnabled,
      createAftersalesWorkflowTemplate: createTemplate,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '售后流程' }));
    expect(await screen.findByRole('heading', { name: '售后流程' })).toBeInTheDocument();
    const presetCard = screen.getByRole('heading', { name: '仅退款' }).closest('article');
    if (!presetCard) throw new Error('未找到仅退款预置流程');
    expect(within(presetCard).queryByRole('button', { name: '编辑新版本' }))
      .not.toBeInTheDocument();
    await user.click(within(presetCard).getByRole('button', { name: '停用' }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(refundOnly.id, false));

    await user.click(screen.getByRole('button', { name: '新建自定义流程' }));
    const dialog = screen.getByRole('dialog', { name: '编辑售后流程' });
    await user.type(within(dialog).getByLabelText('流程名称'), '客服协商处理');
    await user.click(within(dialog).getByRole('button', { name: '+添加步骤' }));
    const steps = within(dialog).getAllByRole('group');
    expect(steps).toHaveLength(2);
    fireEvent.change(within(steps[1]).getByLabelText('步骤 2 名称'), {
      target: { value: '记录协商结果' },
    });
    await user.selectOptions(within(steps[1]).getByLabelText('显示条件'), 'logistics_exception_present');
    await user.click(within(steps[1]).getByLabelText('必需步骤'));
    await user.click(within(dialog).getByRole('button', { name: '保存流程版本' }));

    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith(expect.objectContaining({
      name: '客服协商处理',
      scenario: 'other',
      steps: expect.arrayContaining([expect.objectContaining({
        name: '记录协商结果',
        required: false,
        condition: { fact: 'logistics_exception_present', equals: true },
      })]),
    })));
  });

  it('在售后处理单显示当前步骤并只调整后续流程', async () => {
    const user = userEvent.setup();
    const group = singleShipmentGroupProjection().groups[0];
    const archive = shipmentArchiveForGroup(group);
    const record = archive.records[0];
    const sourceItem = record.packages[0].items[0];
    const refundTemplate = testWorkflowTemplates.find(({ scenario }) => scenario === 'refund_only')!;
    const returnTemplate = testWorkflowTemplates.find(({ scenario }) => scenario === 'return_refund')!;
    const currentCase: AftersalesCase = {
      ...emptyAftersalesRounds,
      id: 'aftersales-workflow-guide-ui',
      shipmentRecordId: record.id,
      workflow: 'refund_only',
      workflowTemplate: {
        templateId: refundTemplate.id,
        version: refundTemplate.version,
        name: refundTemplate.name,
        scenario: refundTemplate.scenario,
        steps: refundTemplate.steps,
        timeline: [{
          kind: 'selected', before: null,
          after: { templateId: refundTemplate.id, version: 1 },
          reason: '先与买家协商仅退款',
          occurredAt: '2026-08-14T10:30:00+08:00',
          createdAt: '2026-08-14T02:30:00.000Z',
        }],
      },
      status: 'waiting_refund',
      revision: 1,
      reason: '先与买家协商仅退款',
      occurredAt: '2026-08-14T10:30:00+08:00',
      items: [{
        id: 'aftersales-workflow-guide-item',
        shipmentPackageItemId: sourceItem.id,
        packageId: record.packages[0].id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: sourceItem.quantity,
      }],
      refund: {
        pendingItemId: 'workflow-guide-refund',
        requestedAmountCents: 500,
        status: 'pending',
        actualRecord: null,
        createdAt: '2026-08-14T02:30:00.000Z',
        latestEventAt: '2026-08-14T10:30:00+08:00',
        timeline: [],
      },
      returns: [],
      coordination: testAftersalesCoordination(null, {
        physicalControl: 'buyer',
        currentTodo: '核对并确认实际退款',
        availableDirections: ['buyer_return', 'only_refund', 'replacement'],
      }),
      timeline: [],
      createdAt: '2026-08-14T02:30:00.000Z',
      updatedAt: '2026-08-14T02:30:00.000Z',
    };
    const changedCase: AftersalesCase = {
      ...currentCase,
      workflow: 'return_refund',
      status: 'waiting_return',
      revision: 2,
      workflowTemplate: {
        templateId: returnTemplate.id,
        version: 1,
        name: returnTemplate.name,
        scenario: returnTemplate.scenario,
        steps: returnTemplate.steps,
        timeline: currentCase.workflowTemplate.timeline,
      },
    };
    const changeWorkflow = vi.fn().mockResolvedValue(changedCase);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready', dataDirectory: '/Users/test/闲鱼订单', orders: [orderSummary()],
      }),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
      queryShipmentGroups: vi.fn().mockResolvedValue({ groups: [], attentionOrders: [] }),
      queryShipmentGroupArchives: vi.fn().mockResolvedValue([archive]),
      queryAftersalesCases: vi.fn().mockResolvedValue([currentCase]),
      listAftersalesWorkflowTemplates: vi.fn().mockResolvedValue(testWorkflowTemplates),
      changeAftersalesCaseWorkflowTemplate: changeWorkflow,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '发货组' }));
    const caseRegion = await screen.findByRole('region', { name: `售后处理单 ${currentCase.id}` });
    const guide = within(caseRegion).getByRole('region', { name: '售后流程引导' });
    expect(guide).toHaveTextContent('仅退款');
    expect(guide).toHaveTextContent('确认问题与退款申请');
    expect(guide).toHaveTextContent('确认实际退款必需 · 当前建议');
    expect(guide).toHaveTextContent('需核对：发生时间、申请退款金额、处理说明');
    await user.click(within(guide).getByRole('button', { name: '调整后续流程' }));
    const dialog = screen.getByRole('dialog', { name: '调整后续售后流程' });
    await user.selectOptions(within(dialog).getByLabelText('新的后续流程'), returnTemplate.id);
    await user.selectOptions(within(dialog).getByLabelText('售后处理方向'), 'buyer_return');
    fireEvent.change(within(dialog).getByLabelText('流程调整时间'), {
      target: { value: '2026-08-14T10:40:00' },
    });
    await user.type(within(dialog).getByLabelText('调整原因'), '协商后改为买家寄回再退款');
    await user.click(within(dialog).getByRole('button', { name: '确认调整' }));

    await waitFor(() => expect(changeWorkflow).toHaveBeenCalledWith({
      caseId: currentCase.id,
      expectedRevision: 1,
      workflowTemplateId: returnTemplate.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '协商后改为买家寄回再退款',
    }));
  });
});

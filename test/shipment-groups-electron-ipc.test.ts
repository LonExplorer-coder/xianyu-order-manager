import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import type { AftersalesCase } from '../src/core/aftersales-cases';
import { DesktopSession } from '../src/main/desktop-session';
import { LocalApplication } from '../src/main/local-application';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class MockBrowserWindow {
    public static getAllWindows(): unknown[] { return []; }
    public static fromWebContents(): unknown { return { isDestroyed: () => false }; }
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
}));

import { registerIpcHandlers } from '../src/main/electron-main';

const sessions: DesktopSession[] = [];

afterEach(() => {
  electronBoundary.handlers.clear();
  for (const session of sessions.splice(0)) session.close();
});

describe('发货组 Electron IPC', () => {
  it('通过只读通道返回本机动态发货组投影', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-groups-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '待发货订单.png');
    await writeFile(sourcePath, Buffer.from('shipment-groups-ipc-source'));
    const recognition = completeRecognition();
    const seeder = new LocalApplication(new ControlledRecognizer(recognition));
    seeder.openDataDirectory(dataDirectory);
    const [draft] = (await seeder.submitRecognitionBatch([sourcePath])).drafts;
    const order = seeder.confirmDraft(draft);
    seeder.close();

    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      new ControlledRecognizer(recognition),
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(dataDirectory);
    registerIpcHandlers(session);

    await expect(invoke('shipment-groups:query')).resolves.toMatchObject({
      groups: [{
        orderCount: 1,
        totalQuantity: 1,
        totalAmountCents: 800,
        orders: [{ id: order.id, orderNumber: order.orderNumber }],
      }],
      attentionOrders: [],
    });
  });

  it('通过受控通道传递拆分与重组命令', async () => {
    const splitShipmentGroup = vi.fn().mockReturnValue({ event: { operation: 'split' } });
    const mergeShipmentGroups = vi.fn().mockReturnValue({ event: { operation: 'merge' } });
    registerIpcHandlers({
      splitShipmentGroup,
      mergeShipmentGroups,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const splitInput = {
      groupId: 'group-1',
      expectedMemberOrderIds: ['order-1', 'order-2'],
      splitOrderIds: ['order-2'],
      reason: '单独包装',
    };
    const mergeInput = {
      groupIds: ['group-1', 'group-2'],
      expectedMemberOrderIds: ['order-1', 'order-2'],
      selectedRecipientOrderId: 'order-1',
      reason: '一起发货',
    };

    await expect(invoke('shipment-groups:split', splitInput)).resolves.toMatchObject({
      event: { operation: 'split' },
    });
    await expect(invoke('shipment-groups:merge', mergeInput)).resolves.toMatchObject({
      event: { operation: 'merge' },
    });
    expect(splitShipmentGroup).toHaveBeenCalledWith(splitInput);
    expect(mergeShipmentGroups).toHaveBeenCalledWith(mergeInput);
  });

  it('通过受控通道查询发货组档案并确认实际发货', async () => {
    const queryShipmentGroupArchives = vi.fn().mockReturnValue([{
      id: 'shipment-group-archive-1',
      records: [{ id: 'shipment-record-1' }],
    }]);
    const confirmShipment = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2' },
      projection: { groups: [], attentionOrders: [] },
    });
    registerIpcHandlers({
      queryShipmentGroupArchives,
      confirmShipment,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const input = {
      groupId: 'group-1',
      expectedRemainingItems: [{
        orderId: 'order-1',
        orderItemId: 'item-1',
        quantity: 2,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000010',
        items: [{ orderId: 'order-1', orderItemId: 'item-1', quantity: 2 }],
      }],
    };

    await expect(invoke('shipment-group-archives:query')).resolves.toEqual([
      {
        id: 'shipment-group-archive-1',
        records: [{ id: 'shipment-record-1' }],
      },
    ]);
    await expect(invoke('shipment-records:confirm', input)).resolves.toMatchObject({
      record: { id: 'shipment-record-2' },
    });
    expect(queryShipmentGroupArchives).toHaveBeenCalledTimes(1);
    expect(confirmShipment).toHaveBeenCalledWith(input);
  });

  it('通过受控通道撤销未交寄包裹、更正物流并独立推进运输事实与异常', async () => {
    const cancelShipmentPackages = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-1', status: 'voided' },
    });
    const correctShipmentPackageLogistics = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2' },
    });
    const updateShipmentPackageLogisticsStatus = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2', logisticsStatus: 'delivered' },
    });
    const recordShipmentPackageLogisticsException = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2', currentExceptionStage: 'pending_verification' },
    });
    const progressShipmentPackageLogisticsException = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2', currentExceptionStage: 'investigating' },
    });
    const progressShipmentPackageCarrierClaim = vi.fn().mockReturnValue({
      record: { id: 'shipment-record-2', carrierClaimStatus: 'pending' },
    });
    registerIpcHandlers({
      cancelShipmentPackages,
      correctShipmentPackageLogistics,
      updateShipmentPackageLogisticsStatus,
      recordShipmentPackageLogisticsException,
      progressShipmentPackageLogisticsException,
      progressShipmentPackageCarrierClaim,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const cancelInput = {
      recordId: 'shipment-record-1',
      packageIds: ['package-1'],
      reason: '尚未实际交寄',
    };
    const correctionInput = {
      recordId: 'shipment-record-2',
      packageId: 'package-2',
      expectedRevision: 1,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT1000000003',
      reason: '更正录入错误',
    };
    const statusInput = {
      recordId: 'shipment-record-2',
      packageId: 'package-2',
      expectedRevision: 2,
      logisticsStatus: 'delivered',
      reason: '买家确认签收',
    };
    const claimInput = {
      kind: 'open',
      recordId: 'shipment-record-2',
      packageId: 'package-2',
      expectedRevision: 3,
      requestedAmountCents: 1_000,
      occurredAt: '2026-08-14T09:00:00+08:00',
      reason: '就包裹破损申请索赔',
    };
    const exceptionInput = {
      recordId: 'shipment-record-2',
      packageId: 'package-2',
      expectedRevision: 3,
      exceptionType: 'damaged',
      stage: 'pending_verification',
      impact: { scope: 'package' },
      occurredAt: '2026-08-14T08:30:00+08:00',
      reason: '外包装破损待核实',
    };
    const exceptionProgressInput = {
      recordId: 'shipment-record-2',
      packageId: 'package-2',
      exceptionId: 'logistics-exception-1',
      expectedExceptionRevision: 1,
      stage: 'investigating',
      occurredAt: '2026-08-14T08:40:00+08:00',
      reason: '承运方正在调查',
    };

    await expect(invoke('shipment-records:cancel-packages', cancelInput))
      .resolves.toMatchObject({ record: { status: 'voided' } });
    await expect(invoke('shipment-records:correct-package-logistics', correctionInput))
      .resolves.toMatchObject({ record: { id: 'shipment-record-2' } });
    await expect(invoke('shipment-records:update-package-logistics-status', statusInput))
      .resolves.toMatchObject({ record: { logisticsStatus: 'delivered' } });
    await expect(invoke('shipment-records:record-package-logistics-exception', exceptionInput))
      .resolves.toMatchObject({ record: { currentExceptionStage: 'pending_verification' } });
    await expect(invoke('shipment-records:progress-package-logistics-exception', exceptionProgressInput))
      .resolves.toMatchObject({ record: { currentExceptionStage: 'investigating' } });
    await expect(invoke('shipment-records:progress-package-carrier-claim', claimInput))
      .resolves.toMatchObject({ record: { carrierClaimStatus: 'pending' } });
    expect(cancelShipmentPackages).toHaveBeenCalledWith(cancelInput);
    expect(correctShipmentPackageLogistics).toHaveBeenCalledWith(correctionInput);
    expect(updateShipmentPackageLogisticsStatus).toHaveBeenCalledWith(statusInput);
    expect(recordShipmentPackageLogisticsException).toHaveBeenCalledWith(exceptionInput);
    expect(progressShipmentPackageLogisticsException).toHaveBeenCalledWith(exceptionProgressInput);
    expect(progressShipmentPackageCarrierClaim).toHaveBeenCalledWith(claimInput);
  });

  it('通过受控通道建立、更新、推进并查询售后处理单', async () => {
    const created = { id: 'aftersales-1', status: 'processing', revision: 1 };
    const updated = { id: 'aftersales-1', status: 'waiting_return', revision: 2 };
    const createAftersalesCase = vi.fn().mockReturnValue(created);
    const updateAftersalesCase = vi.fn().mockReturnValue(updated);
    const progressed = { id: 'aftersales-1', status: 'ready_to_complete', revision: 3 };
    const progressAftersalesCase = vi.fn().mockReturnValue(progressed);
    const queryAftersalesCases = vi.fn().mockReturnValue([updated]);
    registerIpcHandlers({
      createAftersalesCase,
      updateAftersalesCase,
      progressAftersalesCase,
      queryAftersalesCases,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const createInput = {
      shipmentRecordId: 'shipment-record-1',
      occurredAt: '2026-08-13T10:00:00+08:00',
      reason: '商品破损',
      items: [{ shipmentPackageItemId: 'shipment-item-1', quantity: 1 }],
    };
    const updateInput = {
      caseId: 'aftersales-1',
      expectedRevision: 1,
      status: 'waiting_return',
      reason: '等待买家退回',
      items: [{ shipmentPackageItemId: 'shipment-item-1', quantity: 1 }],
      changeReason: '与买家确认退回处理',
    };
    const query = { status: 'waiting_return' };
    const progressInput = {
      kind: 'confirm_refund',
      caseId: 'aftersales-1',
      expectedRevision: 2,
      actualRefundCents: 500,
      occurredAt: '2026-08-13T10:10:00+08:00',
      note: '平台确认实际退款',
    };
    const replacementInput = {
      kind: 'create_replacement_shipment' as const,
      caseId: 'aftersales-1',
      roundId: 'round-1',
      expectedRevision: 3,
      occurredAt: '2026-08-13T10:20:00+08:00',
      reason: '换货检查完成后补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-REPLACEMENT-IPC',
        items: [{ roundItemId: 'round-item-1', quantity: 1 }],
      }],
    };
    const outboundExceptionDecisionInput = {
      kind: 'decide_outbound_logistics_exception',
      caseId: 'aftersales-1',
      expectedRevision: 4,
      packageId: 'shipment-package-1',
      exceptionId: 'outbound-exception-1',
      decision: 'refund_and_replacement',
      occurredAt: '2026-08-13T10:30:00+08:00',
      reason: '买家退款并按异常数量补发',
    };

    await expect(invoke('aftersales-cases:create', createInput)).resolves.toEqual(created);
    await expect(invoke('aftersales-cases:update', updateInput)).resolves.toEqual(updated);
    await expect(invoke('aftersales-cases:progress', progressInput)).resolves.toEqual(progressed);
    await expect(invoke('aftersales-cases:progress', replacementInput)).resolves.toEqual(progressed);
    await expect(invoke('aftersales-cases:progress', outboundExceptionDecisionInput))
      .resolves.toEqual(progressed);
    await expect(invoke('aftersales-cases:query', query)).resolves.toEqual([updated]);
    expect(createAftersalesCase).toHaveBeenCalledWith(createInput);
    expect(updateAftersalesCase).toHaveBeenCalledWith(updateInput);
    expect(progressAftersalesCase).toHaveBeenNthCalledWith(1, progressInput);
    expect(progressAftersalesCase).toHaveBeenNthCalledWith(2, replacementInput);
    expect(progressAftersalesCase).toHaveBeenNthCalledWith(3, outboundExceptionDecisionInput);
    expect(queryAftersalesCases).toHaveBeenCalledWith(query);
  });

  it('通过真实 DesktopSession 与 SQLite 协调在途售后', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-coordination-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '在途售后订单.png');
    await writeFile(sourcePath, Buffer.from('aftersales-coordination-ipc-source'));
    const recognition = completeRecognition();
    const seeder = new LocalApplication(new ControlledRecognizer(recognition));
    seeder.openDataDirectory(dataDirectory);
    const [draft] = (await seeder.submitRecognitionBatch([sourcePath])).drafts;
    seeder.confirmDraft(draft);
    const group = seeder.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = seeder.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-AFTERSALES-COORDINATION-IPC',
        items: remainingItems,
      }],
    });
    seeder.close();

    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      new ControlledRecognizer(recognition),
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(dataDirectory);
    registerIpcHandlers(session);

    const sourcePackage = shipment.record.packages[0];
    const created = await invoke('aftersales-cases:create', {
      shipmentRecordId: shipment.record.id,
      workflow: 'return_refund',
      handlingDirection: 'intercept',
      occurredAt: '2026-08-15T09:00:00+08:00',
      reason: '包裹运输中申请拦截',
      requestedRefundCents: 800,
      items: [{ shipmentPackageItemId: sourcePackage.items[0].id, quantity: 1 }],
    }) as AftersalesCase;
    expect(created).toMatchObject({
      status: 'processing',
      returns: [],
      coordination: {
        handlingDirection: 'intercept',
        physicalControl: 'carrier',
        interception: { status: 'requested' },
      },
    });

    const failed = await invoke('aftersales-cases:progress', {
      kind: 'record_interception_result',
      caseId: created.id,
      expectedRevision: created.revision,
      result: 'failed',
      occurredAt: '2026-08-15T09:10:00+08:00',
      reason: '承运方确认拦截失败',
    }) as AftersalesCase;
    await invoke('shipment-records:update-package-logistics-status', {
      recordId: shipment.record.id,
      packageId: sourcePackage.id,
      expectedRevision: sourcePackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-15T10:00:00+08:00',
      reason: '承运方回传已签收',
    });
    await expect(invoke('aftersales-cases:progress', {
      kind: 'change_handling_direction',
      caseId: failed.id,
      expectedRevision: failed.revision,
      handlingDirection: 'replacement',
      occurredAt: '2026-08-15T10:05:00+08:00',
      reason: '不应绕过买家签收后的明确处理',
    })).rejects.toThrow('只能明确转为买家退回或仅退款');
    const changed = await invoke('aftersales-cases:progress', {
      kind: 'change_handling_direction',
      caseId: failed.id,
      expectedRevision: failed.revision,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-15T10:10:00+08:00',
      reason: '拦截失败且买家已签收，改为买家寄回',
    }) as AftersalesCase;

    expect(changed).toMatchObject({
      status: 'waiting_return',
      returns: [],
      coordination: {
        handlingDirection: 'buyer_return',
        physicalControl: 'buyer',
        interception: { status: 'failed' },
        handlingDirectionTimeline: [
          expect.objectContaining({ kind: 'selected', after: 'intercept' }),
          expect.objectContaining({
            kind: 'changed',
            before: 'intercept',
            after: 'buyer_return',
          }),
        ],
      },
    });
    const registered = await invoke('aftersales-cases:progress', {
      kind: 'register_return',
      caseId: changed.id,
      expectedRevision: changed.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-AFTERSALES-COORDINATION-IPC',
      occurredAt: '2026-08-15T10:20:00+08:00',
      reason: '买家已实际交寄退货',
    }) as AftersalesCase;
    const accepted = await invoke('aftersales-cases:progress', {
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-15T10:30:00+08:00',
      reason: '承运方确认揽收',
    }) as AftersalesCase;
    const lost = await invoke('aftersales-cases:progress', {
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: registered.returns[0].id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-15T10:40:00+08:00',
      reason: '承运方确认退货丢失',
    }) as AftersalesCase;
    await expect(invoke('aftersales-cases:progress', {
      kind: 'receive_return',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-15T10:45:00+08:00',
      reason: '不应用全部收到零件绕过整包丢失门禁',
      items: registered.returns[0].items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: 0,
      })),
      discrepancies: [],
    })).rejects.toThrow('退货已确认丢失，不能登记实际收到或检查');
    const decided = await invoke('aftersales-cases:progress', {
      kind: 'decide_return_logistics_exception',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: registered.returns[0].id,
      exceptionId: lost.coordination.returnException?.exceptionId,
      decision: 'refund_in_advance',
      occurredAt: '2026-08-15T10:50:00+08:00',
      reason: '买家侧先行退款，承运异常继续处理',
    }) as AftersalesCase;
    expect(decided.coordination.returnException).toMatchObject({
      decision: 'refund_in_advance',
      affectedQuantity: 1,
      timeline: [expect.objectContaining({
        kind: 'selected',
        after: 'refund_in_advance',
      })],
    });
    await expect(invoke('aftersales-cases:query', {
      shipmentRecordId: shipment.record.id,
    })).resolves.toEqual([decided]);
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}

function completeRecognition(): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber: 'XY-SHIPMENT-GROUPS-IPC-0001',
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient: '测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-03 08:00:00',
    orderedAtNormalized: '2026-08-03T08:00:00+08:00',
    paidAtOriginal: '2026-08-03 08:00:08',
    paidAtNormalized: '2026-08-03T08:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '测试商品',
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

const unusedOcrSettings = new OcrSettingsService(
  { read: () => null, write: () => undefined },
  {
    getApiKey: async () => null,
    setApiKey: async () => undefined,
    deleteApiKey: async () => undefined,
    getDisplayName: () => '测试系统凭据库',
  },
  { testConnection: async () => ({ model: 'qwen3.5-ocr' }) },
);

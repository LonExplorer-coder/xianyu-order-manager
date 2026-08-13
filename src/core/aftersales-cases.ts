import type {
  CarrierClaim as SharedCarrierClaim,
  CarrierClaimEvent as SharedCarrierClaimEvent,
  CarrierClaimStatus as SharedCarrierClaimStatus,
  LogisticsExceptionImpact,
  LogisticsExceptionMatter,
  LogisticsExceptionStage,
  LogisticsExceptionType,
  ReturnLogisticsStatus,
} from './logistics-exceptions';
import { isReturnLogisticsStatus } from './logistics-exceptions';
import {
  isAftersalesHandlingDirection,
  isAftersalesInterceptedReturnInspectionResult,
  isAftersalesOutboundExceptionDecision,
  isAftersalesReturnExceptionDecision,
  type AftersalesCoordination,
  type AftersalesHandlingDirection,
  type AftersalesInterceptedReturnInspectionResult,
  type AftersalesOutboundExceptionDecision,
  type AftersalesReturnExceptionDecision,
} from './aftersales-coordination';
import type { ShipmentRecord } from './shipment-records';

export type AftersalesStatus =
  | 'processing'
  | 'waiting_return'
  | 'waiting_inspection'
  | 'waiting_refund'
  | 'waiting_replacement'
  | 'partially_completed'
  | 'ready_to_complete'
  | 'completed'
  | 'cancelled';

export type AftersalesWorkflow =
  | 'general'
  | 'refund_only'
  | 'return_refund'
  | 'exchange'
  | 'direct_replacement';

export type AftersalesReplacementWorkflow = 'exchange' | 'direct_replacement';

export type PendingFinancialItemStatus = 'pending' | 'confirmed' | 'cancelled';

export type AftersalesReturnStatus = 'in_transit' | 'received' | 'inspected';

export type AftersalesReturnLogisticsStatus = ReturnLogisticsStatus;

export type AftersalesReturnDiscrepancyKind =
  | 'missing'
  | 'empty_package'
  | 'wrong_item'
  | 'excess'
  | 'mixed'
  | 'damaged'
  | 'missing_accessory'
  | 'unidentified';

export type AftersalesReturnDiscrepancy = {
  kind: AftersalesReturnDiscrepancyKind;
  quantity: number;
  note: string;
  returnRecordItemId?: string;
};

export type AftersalesReturnReceivedItem = {
  returnRecordItemId: string;
  receivedQuantity: number;
};

export type AftersalesReturnInspectedItem = {
  returnRecordItemId: string;
  acceptedQuantity: number;
  result: ReturnInspectionResult;
  note: string;
};

export type CarrierClaimStatus = SharedCarrierClaimStatus;

export type ReturnInspectionResult = 'resellable' | 'defective' | 'scrapped' | 'other';

export type AftersalesRefund = {
  pendingItemId: string;
  requestedAmountCents: number;
  status: PendingFinancialItemStatus;
  actualRecord: AftersalesRefundFinancialRecord | null;
  createdAt: string;
};

export type AftersalesRefundFinancialRecord = {
  id: string;
  kind: 'aftersales_refund';
  amountCents: number;
  occurredAt: string;
  note: string;
  createdAt: string;
};

export type AftersalesReturnItem = AftersalesCaseItemInput & {
  id: string;
  aftersalesCaseId: string;
  orderId: string;
  orderItemId: string;
  orderNumber: string;
  sourceTitle: string;
  sourceSpec: string;
  receivedQuantity: number;
  acceptedQuantity: number;
  inspectionResult: ReturnInspectionResult | null;
  inspectionNote: string | null;
};

export type AftersalesReturnEvent =
  | {
    kind: 'registered';
    resultRevision: 1;
    occurredAt: string;
    reason: string;
    createdAt: string;
  }
  | {
    kind: 'received';
    baseRevision: number;
    resultRevision: number;
    occurredAt: string;
    reason: string;
    items?: AftersalesReturnReceivedItem[];
    discrepancies?: AftersalesReturnDiscrepancy[];
    createdAt: string;
  }
  | {
    kind: 'inspected';
    baseRevision: number;
    resultRevision: number;
    occurredAt: string;
    result: ReturnInspectionResult;
    note: string;
    items?: AftersalesReturnInspectedItem[];
    discrepancies?: AftersalesReturnDiscrepancy[];
    createdAt: string;
  }
  | {
    kind: 'items_combined';
    baseRevision: number;
    resultRevision: number;
    occurredAt: string;
    reason: string;
    items: AftersalesCaseItemInput[];
    createdAt: string;
  }
  | {
    kind: 'logistics_corrected';
    baseRevision: number;
    resultRevision: number;
    occurredAt: string;
    reason: string;
    before: {
      shippingCarrier: string;
      trackingNumber: string;
    };
    after: {
      shippingCarrier: string;
      trackingNumber: string;
    };
    createdAt: string;
  }
  | {
    kind: 'logistics_status_updated';
    baseRevision: number;
    resultRevision: number;
    occurredAt: string;
    reason: string;
    before: AftersalesReturnLogisticsStatus;
    after: AftersalesReturnLogisticsStatus;
    createdAt: string;
  };

export type CarrierClaimEvent = SharedCarrierClaimEvent;

export type CarrierClaim = SharedCarrierClaim;

export type AftersalesReturnRecord = {
  id: string;
  status: AftersalesReturnStatus;
  revision: number;
  logisticsStatus: AftersalesReturnLogisticsStatus;
  carrierAcceptedAt: string | null;
  shippingCarrier: string;
  trackingNumber: string;
  occurredAt: string;
  receivedAt: string | null;
  inspection: {
    result: ReturnInspectionResult;
    occurredAt: string;
    note: string;
  } | null;
  items: AftersalesReturnItem[];
  discrepancies: AftersalesReturnDiscrepancy[];
  currentException: (LogisticsExceptionMatter & { direction: 'return' }) | null;
  logisticsExceptions: LogisticsExceptionMatter[];
  carrierClaim: CarrierClaim | null;
  timeline: AftersalesReturnEvent[];
  createdAt: string;
  updatedAt: string;
};

export type ProgressAftersalesCaseInput =
  | {
    kind: 'decide_outbound_logistics_exception';
    caseId: string;
    expectedRevision: number;
    packageId: string;
    exceptionId: string;
    decision: AftersalesOutboundExceptionDecision;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'inspect_intercepted_return';
    caseId: string;
    expectedRevision: number;
    packageId: string;
    result: AftersalesInterceptedReturnInspectionResult;
    occurredAt: string;
    reason: string;
    items: AftersalesCaseItemInput[];
  }
  | {
    kind: 'create_replacement_shipment';
    caseId: string;
    expectedRevision: number;
    occurredAt: string;
    reason: string;
    packages: AftersalesReplacementPackageInput[];
  }
  | {
    kind: 'start_next_round';
    caseId: string;
    expectedRevision: number;
    sourceShipmentRecordId: string;
    workflow: AftersalesReplacementWorkflow;
    occurredAt: string;
    reason: string;
    items: AftersalesCaseItemInput[];
  }
  | {
    kind: 'record_interception_result';
    caseId: string;
    expectedRevision: number;
    result: 'succeeded' | 'failed';
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'change_handling_direction';
    caseId: string;
    expectedRevision: number;
    handlingDirection: AftersalesHandlingDirection;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'register_return';
    caseId: string;
    expectedRevision: number;
    shippingCarrier: string;
    trackingNumber: string;
    occurredAt: string;
    reason: string;
    combineWithExisting?: boolean;
  }
  | {
    kind: 'receive_return';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    occurredAt: string;
    reason: string;
    items?: AftersalesReturnReceivedItem[];
    discrepancies?: AftersalesReturnDiscrepancy[];
  }
  | {
    kind: 'inspect_return';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    result: ReturnInspectionResult;
    occurredAt: string;
    note: string;
    items?: AftersalesReturnInspectedItem[];
    discrepancies?: AftersalesReturnDiscrepancy[];
  }
  | {
    kind: 'correct_return_logistics';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    shippingCarrier: string;
    trackingNumber: string;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'update_return_logistics_status';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    logisticsStatus: AftersalesReturnLogisticsStatus;
    carrierAcceptanceConfirmed?: boolean;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'record_return_logistics_exception';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    exceptionType: LogisticsExceptionType;
    stage: Exclude<LogisticsExceptionStage, 'recovered' | 'resolved'>;
    impact?: LogisticsExceptionImpact;
    carrierConfirmedLoss?: boolean;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'progress_return_logistics_exception';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    exceptionId: string;
    expectedExceptionRevision: number;
    stage: Exclude<LogisticsExceptionStage, 'pending_verification'>;
    carrierConfirmedLoss?: boolean;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'decide_return_logistics_exception';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    exceptionId: string;
    decision: AftersalesReturnExceptionDecision;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'open_carrier_claim';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    requestedAmountCents: number;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'resolve_carrier_claim';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    expectedClaimRevision: number;
    outcome: 'approved' | 'rejected';
    approvedAmountCents?: number;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'confirm_carrier_compensation';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    expectedClaimRevision: number;
    amountCents: number;
    occurredAt: string;
    note: string;
  }
  | {
    kind: 'confirm_refund';
    caseId: string;
    expectedRevision: number;
    actualRefundCents: number;
    occurredAt: string;
    note: string;
  }
  | {
    kind: 'complete';
    caseId: string;
    expectedRevision: number;
    reason: string;
  }
  | {
    kind: 'cancel';
    caseId: string;
    expectedRevision: number;
    reason: string;
  };

export type AftersalesCaseItemInput = {
  shipmentPackageItemId: string;
  quantity: number;
};

export type AftersalesReplacementPackageItemInput = {
  roundItemId: string;
  quantity: number;
};

export type AftersalesReplacementPackageInput = {
  shippingCarrier: string;
  trackingNumber: string;
  items: AftersalesReplacementPackageItemInput[];
};

export type CreateAftersalesCaseInput = {
  shipmentRecordId: string;
  workflow?: AftersalesWorkflow;
  handlingDirection?: AftersalesHandlingDirection;
  occurredAt: string;
  reason: string;
  requestedRefundCents?: number;
  items: AftersalesCaseItemInput[];
};

export type NormalizedCreateAftersalesCaseInput = Omit<
  CreateAftersalesCaseInput,
  'workflow'
> & {
  workflow: AftersalesWorkflow;
};

export type UpdateAftersalesCaseInput = {
  caseId: string;
  expectedRevision: number;
  status: AftersalesStatus;
  reason: string;
  items: AftersalesCaseItemInput[];
  changeReason: string;
};

export type AftersalesCaseItem = AftersalesCaseItemInput & {
  id: string;
  packageId: string;
  orderId: string;
  orderItemId: string;
  orderNumber: string;
  sourceTitle: string;
  sourceSpec: string;
  sourceShippedQuantity: number;
};

export type AftersalesCaseSnapshot = {
  status: AftersalesStatus;
  reason: string;
  items: AftersalesCaseItemInput[];
};

export type AftersalesCaseCreatedEvent = {
  kind: 'created';
  resultRevision: 1;
  status: AftersalesStatus;
  reason: string;
  occurredAt: string;
  items: AftersalesCaseItemInput[];
  createdAt: string;
};

export type AftersalesCaseUpdatedEvent = {
  kind: 'updated';
  baseRevision: number;
  resultRevision: number;
  changeReason: string;
  before: AftersalesCaseSnapshot;
  after: AftersalesCaseSnapshot;
  createdAt: string;
};

export type AftersalesCaseEvent = AftersalesCaseCreatedEvent | AftersalesCaseUpdatedEvent;

export type AftersalesCase = {
  id: string;
  shipmentRecordId: string;
  workflow: AftersalesWorkflow;
  status: AftersalesStatus;
  revision: number;
  reason: string;
  occurredAt: string;
  items: AftersalesCaseItem[];
  refund: AftersalesRefund | null;
  returns: AftersalesReturnRecord[];
  rounds: AftersalesProcessingRound[];
  fulfillment: AftersalesFulfillmentSummary;
  coordination: AftersalesCoordination;
  timeline: AftersalesCaseEvent[];
  createdAt: string;
  updatedAt: string;
};

export type AftersalesProcessingRoundItem = {
  id: string;
  sourceShipmentPackageItemId: string;
  packageId: string;
  orderId: string;
  orderItemId: string;
  orderNumber: string;
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
};

export type AftersalesProcessingRound = {
  id: string;
  roundNumber: number;
  workflow: AftersalesReplacementWorkflow | 'legacy';
  sourceShipmentRecordId: string;
  items: AftersalesProcessingRoundItem[];
  returnRecordIds: string[];
  replacementShipment: ShipmentRecord | null;
  replacementOccurredAt: string | null;
  occurredAt: string;
  reason: string;
  createdAt: string;
};

export type AftersalesFulfillmentSummary = {
  cumulativeSentQuantity: number;
  cumulativeReturnedQuantity: number;
  buyerHeldQuantity: number;
  currentRoundNumber: number;
};

export type AftersalesCaseQuery = {
  status?: AftersalesStatus;
  shipmentRecordId?: string;
};

export const AFTERSALES_STATUSES = [
  'processing',
  'waiting_return',
  'waiting_inspection',
  'waiting_refund',
  'waiting_replacement',
  'partially_completed',
  'ready_to_complete',
  'completed',
  'cancelled',
] as const satisfies readonly AftersalesStatus[];

export const AFTERSALES_WORKFLOWS = [
  'general',
  'refund_only',
  'return_refund',
  'exchange',
  'direct_replacement',
] as const satisfies readonly AftersalesWorkflow[];

export function isAftersalesStatus(value: unknown): value is AftersalesStatus {
  return typeof value === 'string' && (
    AFTERSALES_STATUSES as readonly string[]
  ).includes(value);
}

export function isAftersalesWorkflow(value: unknown): value is AftersalesWorkflow {
  return typeof value === 'string' && (
    AFTERSALES_WORKFLOWS as readonly string[]
  ).includes(value);
}

export function normalizeCreateAftersalesCaseInput(
  input: unknown,
): NormalizedCreateAftersalesCaseInput {
  const record = asRecord(input, '新建售后处理单参数无效');
  rejectUnknownKeys(
    record,
    [
      'shipmentRecordId',
      'workflow',
      'handlingDirection',
      'occurredAt',
      'reason',
      'requestedRefundCents',
      'items',
    ],
    '新建售后处理单参数',
  );
  const workflow = record.workflow ?? 'general';
  if (!isAftersalesWorkflow(workflow)) throw new Error('售后处理方式无效');
  if (
    workflow !== 'refund_only'
    && workflow !== 'return_refund'
    && record.requestedRefundCents !== undefined
  ) {
    throw new Error('当前售后处理方式不能登记申请退款金额');
  }
  const requestedRefundCents = workflow === 'refund_only' || workflow === 'return_refund'
    ? money(record.requestedRefundCents, false)
    : undefined;
  return {
    shipmentRecordId: boundedText(record.shipmentRecordId, 200, '发货记录标识无效'),
    workflow,
    ...(record.handlingDirection === undefined
      ? {}
      : {
        handlingDirection: isAftersalesHandlingDirection(record.handlingDirection)
          ? record.handlingDirection
          : invalidHandlingDirection(),
      }),
    occurredAt: dateTime(record.occurredAt, '售后发生时间无效'),
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的问题原因'),
    ...(requestedRefundCents === undefined ? {} : { requestedRefundCents }),
    items: itemInputs(record.items),
  };
}

export function normalizeUpdateAftersalesCaseInput(input: unknown): UpdateAftersalesCaseInput {
  const record = asRecord(input, '更新售后处理单参数无效');
  rejectUnknownKeys(
    record,
    ['caseId', 'expectedRevision', 'status', 'reason', 'items', 'changeReason'],
    '更新售后处理单参数',
  );
  if (!Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) < 1) {
    throw new Error('售后处理单版本无效');
  }
  if (!isAftersalesStatus(record.status)) throw new Error('售后状态无效');
  return {
    caseId: boundedText(record.caseId, 200, '售后处理单标识无效'),
    expectedRevision: Number(record.expectedRevision),
    status: record.status,
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的问题原因'),
    items: itemInputs(record.items),
    changeReason: boundedText(record.changeReason, 500, '请填写 1 至 500 字的变更原因'),
  };
}

export function normalizeAftersalesCaseQuery(input: unknown): AftersalesCaseQuery {
  if (input === undefined) return {};
  const record = asRecord(input, '售后处理单查询参数无效');
  rejectUnknownKeys(record, ['status', 'shipmentRecordId'], '售后处理单查询参数');
  if (record.status !== undefined && !isAftersalesStatus(record.status)) {
    throw new Error('售后状态筛选无效');
  }
  return {
    status: record.status as AftersalesStatus | undefined,
    shipmentRecordId: record.shipmentRecordId === undefined
      ? undefined
      : boundedText(record.shipmentRecordId, 200, '发货记录筛选无效'),
  };
}

export function normalizeProgressAftersalesCaseInput(
  input: unknown,
): ProgressAftersalesCaseInput {
  const record = asRecord(input, '推进售后处理参数无效');
  const common = {
    caseId: boundedText(record.caseId, 200, '售后处理单标识无效'),
    expectedRevision: revision(record.expectedRevision),
  };
  if (record.kind === 'decide_outbound_logistics_exception') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'packageId', 'exceptionId',
        'decision', 'occurredAt', 'reason',
      ],
      '选择正向物流异常处理参数',
    );
    if (!isAftersalesOutboundExceptionDecision(record.decision)) {
      throw new Error('正向物流异常处理选择无效');
    }
    return {
      kind: 'decide_outbound_logistics_exception',
      ...common,
      packageId: boundedText(record.packageId, 200, '正向包裹标识无效'),
      exceptionId: boundedText(record.exceptionId, 200, '物流异常标识无效'),
      decision: record.decision,
      occurredAt: dateTime(record.occurredAt, '异常处理选择时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的异常处理选择原因'),
    };
  }
  if (record.kind === 'inspect_intercepted_return') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'packageId', 'result',
        'occurredAt', 'reason', 'items',
      ],
      '检查拦截退回商品参数',
    );
    if (!isAftersalesInterceptedReturnInspectionResult(record.result)) {
      throw new Error('拦截退回检查结果无效');
    }
    return {
      kind: 'inspect_intercepted_return',
      ...common,
      packageId: boundedText(record.packageId, 200, '正向包裹标识无效'),
      result: record.result,
      occurredAt: dateTime(record.occurredAt, '拦截退回检查时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的拦截退回检查说明'),
      items: itemInputs(record.items),
    };
  }
  if (record.kind === 'create_replacement_shipment') {
    rejectUnknownKeys(
      record,
      ['kind', 'caseId', 'expectedRevision', 'occurredAt', 'reason', 'packages'],
      '建立补发记录参数',
    );
    const packages = arrayValue(record.packages, '请至少添加一个补发包裹');
    if (packages.length === 0 || packages.length > 100) {
      throw new Error('请添加 1 至 100 个补发包裹');
    }
    return {
      kind: 'create_replacement_shipment',
      ...common,
      occurredAt: dateTime(record.occurredAt, '补发时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的补发原因'),
      packages: packages.map((value) => {
        const shipmentPackage = asRecord(value, '补发包裹信息无效');
        rejectUnknownKeys(
          shipmentPackage,
          ['shippingCarrier', 'trackingNumber', 'items'],
          '补发包裹信息',
        );
        const items = arrayValue(shipmentPackage.items, '补发包裹商品无效');
        if (items.length === 0 || items.length > 10_000) {
          throw new Error('每个补发包裹至少需要一条商品明细');
        }
        return {
          shippingCarrier: optionalText(shipmentPackage.shippingCarrier, 200, '补发承运方过长'),
          trackingNumber: optionalText(shipmentPackage.trackingNumber, 200, '补发运单号过长'),
          items: items.map((value) => {
            const item = asRecord(value, '补发商品无效');
            rejectUnknownKeys(item, ['roundItemId', 'quantity'], '补发商品');
            if (!Number.isSafeInteger(item.quantity) || Number(item.quantity) <= 0) {
              throw new Error('补发商品数量无效');
            }
            return {
              roundItemId: boundedText(item.roundItemId, 200, '售后轮次商品标识无效'),
              quantity: Number(item.quantity),
            };
          }),
        };
      }),
    };
  }
  if (record.kind === 'start_next_round') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'sourceShipmentRecordId',
        'workflow', 'occurredAt', 'reason', 'items',
      ],
      '建立下一处理轮次参数',
    );
    if (record.workflow !== 'exchange' && record.workflow !== 'direct_replacement') {
      throw new Error('售后处理轮次方式无效');
    }
    return {
      kind: 'start_next_round',
      ...common,
      sourceShipmentRecordId: boundedText(
        record.sourceShipmentRecordId,
        200,
        '轮次来源发货记录无效',
      ),
      workflow: record.workflow,
      occurredAt: dateTime(record.occurredAt, '售后处理轮次时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的新一轮问题原因'),
      items: itemInputs(record.items),
    };
  }
  if (record.kind === 'record_interception_result') {
    rejectUnknownKeys(
      record,
      ['kind', 'caseId', 'expectedRevision', 'result', 'occurredAt', 'reason'],
      '登记拦截结果参数',
    );
    if (record.result !== 'succeeded' && record.result !== 'failed') {
      throw new Error('拦截结果无效');
    }
    return {
      kind: 'record_interception_result',
      ...common,
      result: record.result,
      occurredAt: dateTime(record.occurredAt, '拦截结果时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的拦截结果说明'),
    };
  }
  if (record.kind === 'change_handling_direction') {
    rejectUnknownKeys(
      record,
      ['kind', 'caseId', 'expectedRevision', 'handlingDirection', 'occurredAt', 'reason'],
      '转换售后处理方向参数',
    );
    if (!isAftersalesHandlingDirection(record.handlingDirection)) {
      throw new Error('售后处理方向无效');
    }
    return {
      kind: 'change_handling_direction',
      ...common,
      handlingDirection: record.handlingDirection,
      occurredAt: dateTime(record.occurredAt, '处理方向转换时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的处理方向转换原因'),
    };
  }
  if (record.kind === 'register_return') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'shippingCarrier',
        'trackingNumber', 'occurredAt', 'reason', 'combineWithExisting',
      ],
      '登记退货物流参数',
    );
    return {
      kind: 'register_return',
      ...common,
      shippingCarrier: boundedText(record.shippingCarrier, 100, '退货承运方无效'),
      trackingNumber: boundedText(record.trackingNumber, 200, '退货运单号无效'),
      occurredAt: dateTime(record.occurredAt, '退货寄出时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的退货登记说明'),
      ...(record.combineWithExisting === undefined
        ? {}
        : { combineWithExisting: booleanValue(record.combineWithExisting, '合装退货确认无效') }),
    };
  }
  if (record.kind === 'receive_return') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId', 'occurredAt',
        'reason', 'items', 'discrepancies',
      ],
      '确认收到退货参数',
    );
    return {
      kind: 'receive_return',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货记录标识无效'),
      occurredAt: dateTime(record.occurredAt, '退货收到时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的退货收到说明'),
      ...(record.items === undefined ? {} : { items: receivedItems(record.items) }),
      ...(record.discrepancies === undefined
        ? {}
        : { discrepancies: returnDiscrepancies(record.discrepancies) }),
    };
  }
  if (record.kind === 'inspect_return') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'result', 'occurredAt', 'note', 'items', 'discrepancies',
      ],
      '记录退货检查参数',
    );
    if (!isReturnInspectionResult(record.result)) throw new Error('退货检查结果无效');
    return {
      kind: 'inspect_return',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货记录标识无效'),
      result: record.result,
      occurredAt: dateTime(record.occurredAt, '退货检查时间无效'),
      note: boundedText(record.note, 500, '请填写 1 至 500 字的退货检查说明'),
      ...(record.items === undefined ? {} : { items: inspectedItems(record.items) }),
      ...(record.discrepancies === undefined
        ? {}
        : { discrepancies: returnDiscrepancies(record.discrepancies) }),
    };
  }
  if (record.kind === 'correct_return_logistics') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'shippingCarrier', 'trackingNumber', 'occurredAt', 'reason',
      ],
      '更正退货物流参数',
    );
    return {
      kind: 'correct_return_logistics',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货包裹标识无效'),
      shippingCarrier: boundedText(record.shippingCarrier, 100, '退货承运方无效'),
      trackingNumber: boundedText(record.trackingNumber, 200, '退货运单号无效'),
      occurredAt: dateTime(record.occurredAt, '退货物流更正时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的退货物流更正原因'),
    };
  }
  if (record.kind === 'update_return_logistics_status') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'logisticsStatus', 'carrierAcceptanceConfirmed',
        'occurredAt', 'reason',
      ],
      '更新退货物流状态参数',
    );
    if (!isAftersalesReturnLogisticsStatus(record.logisticsStatus)) {
      throw new Error('退货物流状态无效');
    }
    return {
      kind: 'update_return_logistics_status',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货包裹标识无效'),
      logisticsStatus: record.logisticsStatus,
      ...(record.carrierAcceptanceConfirmed === undefined
        ? {}
        : {
          carrierAcceptanceConfirmed: booleanValue(
            record.carrierAcceptanceConfirmed,
            '承运方揽收确认无效',
          ),
        }),
      occurredAt: dateTime(record.occurredAt, '退货物流状态时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的退货物流状态说明'),
    };
  }
  if (record.kind === 'record_return_logistics_exception') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'exceptionType', 'stage', 'impact', 'carrierConfirmedLoss',
        'occurredAt', 'reason',
      ],
      '登记退货物流异常参数',
    );
    if (!isLogisticsExceptionType(record.exceptionType)) throw new Error('退货物流异常类型无效');
    if (
      record.stage !== 'pending_verification'
      && record.stage !== 'investigating'
      && record.stage !== 'confirmed'
    ) throw new Error('退货物流异常初始阶段无效');
    return {
      kind: 'record_return_logistics_exception',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货包裹标识无效'),
      exceptionType: record.exceptionType,
      stage: record.stage,
      ...(record.impact === undefined ? {} : { impact: logisticsImpact(record.impact) }),
      ...(record.carrierConfirmedLoss === undefined ? {} : {
        carrierConfirmedLoss: booleanValue(record.carrierConfirmedLoss, '承运方丢件确认无效'),
      }),
      occurredAt: dateTime(record.occurredAt, '退货物流异常时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的退货物流异常说明'),
    };
  }
  if (record.kind === 'progress_return_logistics_exception') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'exceptionId', 'expectedExceptionRevision', 'stage',
        'carrierConfirmedLoss', 'occurredAt', 'reason',
      ],
      '推进退货物流异常参数',
    );
    if (
      record.stage !== 'investigating'
      && record.stage !== 'confirmed'
      && record.stage !== 'recovered'
      && record.stage !== 'resolved'
    ) throw new Error('退货物流异常阶段无效');
    return {
      kind: 'progress_return_logistics_exception',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货包裹标识无效'),
      exceptionId: boundedText(record.exceptionId, 200, '物流异常标识无效'),
      expectedExceptionRevision: revision(record.expectedExceptionRevision),
      stage: record.stage,
      ...(record.carrierConfirmedLoss === undefined ? {} : {
        carrierConfirmedLoss: booleanValue(record.carrierConfirmedLoss, '承运方丢件确认无效'),
      }),
      occurredAt: dateTime(record.occurredAt, '退货物流异常时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的退货物流异常处理说明'),
    };
  }
  if (record.kind === 'decide_return_logistics_exception') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'exceptionId', 'decision', 'occurredAt', 'reason',
      ],
      '选择退货物流异常处理参数',
    );
    if (!isAftersalesReturnExceptionDecision(record.decision)) {
      throw new Error('退货物流异常处理选择无效');
    }
    return {
      kind: 'decide_return_logistics_exception',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货包裹标识无效'),
      exceptionId: boundedText(record.exceptionId, 200, '物流异常标识无效'),
      decision: record.decision,
      occurredAt: dateTime(record.occurredAt, '异常处理选择时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的异常处理选择原因'),
    };
  }
  if (record.kind === 'open_carrier_claim') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'requestedAmountCents', 'occurredAt', 'reason',
      ],
      '建立承运索赔参数',
    );
    return {
      kind: 'open_carrier_claim',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货包裹标识无效'),
      requestedAmountCents: positiveMoney(record.requestedAmountCents, '索赔金额无效'),
      occurredAt: dateTime(record.occurredAt, '索赔发生时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的索赔原因'),
    };
  }
  if (record.kind === 'resolve_carrier_claim') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'expectedClaimRevision', 'outcome', 'approvedAmountCents',
        'occurredAt', 'reason',
      ],
      '处理承运索赔结果参数',
    );
    if (record.outcome !== 'approved' && record.outcome !== 'rejected') {
      throw new Error('承运索赔结果无效');
    }
    if (record.outcome === 'approved' && record.approvedAmountCents === undefined) {
      throw new Error('请填写承运方同意赔付金额');
    }
    if (record.outcome === 'rejected' && record.approvedAmountCents !== undefined) {
      throw new Error('拒赔不能登记同意赔付金额');
    }
    return {
      kind: 'resolve_carrier_claim',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货包裹标识无效'),
      expectedClaimRevision: revision(record.expectedClaimRevision),
      outcome: record.outcome,
      ...(record.approvedAmountCents === undefined
        ? {}
        : {
          approvedAmountCents: positiveMoney(
            record.approvedAmountCents,
            '承运方同意赔付金额无效',
          ),
        }),
      occurredAt: dateTime(record.occurredAt, '索赔结果时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的索赔结果说明'),
    };
  }
  if (record.kind === 'confirm_carrier_compensation') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'expectedClaimRevision', 'amountCents', 'occurredAt', 'note',
      ],
      '确认承运赔付参数',
    );
    return {
      kind: 'confirm_carrier_compensation',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货包裹标识无效'),
      expectedClaimRevision: revision(record.expectedClaimRevision),
      amountCents: positiveMoney(record.amountCents, '实际赔付金额无效'),
      occurredAt: dateTime(record.occurredAt, '实际赔付时间无效'),
      note: boundedText(record.note, 500, '请填写 1 至 500 字的实际赔付说明'),
    };
  }
  if (record.kind === 'confirm_refund') {
    rejectUnknownKeys(
      record,
      ['kind', 'caseId', 'expectedRevision', 'actualRefundCents', 'occurredAt', 'note'],
      '确认实际退款参数',
    );
    return {
      kind: 'confirm_refund',
      ...common,
      actualRefundCents: money(record.actualRefundCents, false) as number,
      occurredAt: dateTime(record.occurredAt, '实际退款时间无效'),
      note: boundedText(record.note, 500, '请填写 1 至 500 字的退款确认说明'),
    };
  }
  if (record.kind === 'complete' || record.kind === 'cancel') {
    rejectUnknownKeys(
      record,
      ['kind', 'caseId', 'expectedRevision', 'reason'],
      record.kind === 'complete' ? '完成售后处理参数' : '取消售后处理参数',
    );
    return {
      kind: record.kind,
      ...common,
      reason: boundedText(
        record.reason,
        500,
        record.kind === 'complete'
          ? '请填写 1 至 500 字的完成原因'
          : '请填写 1 至 500 字的取消原因',
      ),
    };
  }
  throw new Error('售后处理动作无效');
}

function itemInputs(value: unknown): AftersalesCaseItemInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new Error('请至少选择一条售后商品明细');
  }
  const items = value.map((item) => {
    const record = asRecord(item, '售后商品明细无效');
    rejectUnknownKeys(record, ['shipmentPackageItemId', 'quantity'], '售后商品明细');
    if (!Number.isSafeInteger(record.quantity) || Number(record.quantity) <= 0) {
      throw new Error('售后商品数量无效');
    }
    return {
      shipmentPackageItemId: boundedText(
        record.shipmentPackageItemId,
        200,
        '发货快照商品标识无效',
      ),
      quantity: Number(record.quantity),
    };
  });
  if (new Set(items.map(({ shipmentPackageItemId }) => shipmentPackageItemId)).size !== items.length) {
    throw new Error('同一发货快照商品不能重复选择');
  }
  return items;
}

function receivedItems(value: unknown): NonNullable<Extract<
  ProgressAftersalesCaseInput,
  { kind: 'receive_return' }
>['items']> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new Error('请填写退货商品实际收到数量');
  }
  const items = value.map((item) => {
    const record = asRecord(item, '退货商品收到数量无效');
    rejectUnknownKeys(record, ['returnRecordItemId', 'receivedQuantity'], '退货商品收到数量');
    return {
      returnRecordItemId: boundedText(record.returnRecordItemId, 200, '退货商品标识无效'),
      receivedQuantity: nonNegativeQuantity(record.receivedQuantity, '退货商品实际收到数量无效'),
    };
  });
  assertUnique(
    items.map(({ returnRecordItemId }) => returnRecordItemId),
    '同一退货商品不能重复登记收到数量',
  );
  return items;
}

function inspectedItems(value: unknown): NonNullable<Extract<
  ProgressAftersalesCaseInput,
  { kind: 'inspect_return' }
>['items']> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new Error('请填写退货商品检查数量');
  }
  const items = value.map((item) => {
    const record = asRecord(item, '退货商品检查结果无效');
    rejectUnknownKeys(
      record,
      ['returnRecordItemId', 'acceptedQuantity', 'result', 'note'],
      '退货商品检查结果',
    );
    if (!isReturnInspectionResult(record.result)) throw new Error('退货商品检查结果无效');
    return {
      returnRecordItemId: boundedText(record.returnRecordItemId, 200, '退货商品标识无效'),
      acceptedQuantity: nonNegativeQuantity(
        record.acceptedQuantity,
        '退货商品检查通过数量无效',
      ),
      result: record.result,
      note: boundedText(record.note, 500, '请填写 1 至 500 字的退货商品检查说明'),
    };
  });
  assertUnique(
    items.map(({ returnRecordItemId }) => returnRecordItemId),
    '同一退货商品不能重复登记检查结果',
  );
  return items;
}

function returnDiscrepancies(value: unknown): AftersalesReturnDiscrepancy[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('退货检查差异无效');
  return value.map((item) => {
    const record = asRecord(item, '退货检查差异无效');
    rejectUnknownKeys(record, ['kind', 'quantity', 'note', 'returnRecordItemId'], '退货检查差异');
    if (!isAftersalesReturnDiscrepancyKind(record.kind)) {
      throw new Error('退货检查差异类型无效');
    }
    return {
      kind: record.kind,
      quantity: nonNegativeQuantity(record.quantity, '退货检查差异数量无效'),
      note: boundedText(record.note, 500, '请填写 1 至 500 字的退货检查差异说明'),
      ...(record.returnRecordItemId === undefined
        ? {}
        : {
          returnRecordItemId: boundedText(
            record.returnRecordItemId,
            200,
            '退货检查差异商品归属无效',
          ),
        }),
    };
  });
}

function isAftersalesReturnDiscrepancyKind(
  value: unknown,
): value is AftersalesReturnDiscrepancyKind {
  return value === 'missing' || value === 'empty_package' || value === 'wrong_item'
    || value === 'excess' || value === 'mixed' || value === 'damaged'
    || value === 'missing_accessory' || value === 'unidentified';
}

export function isAftersalesReturnLogisticsStatus(
  value: unknown,
): value is AftersalesReturnLogisticsStatus {
  return isReturnLogisticsStatus(value);
}

function logisticsImpact(value: unknown): LogisticsExceptionImpact {
  const record = asRecord(value, '退货物流异常影响范围无效');
  if (record.scope === 'package') {
    rejectUnknownKeys(record, ['scope'], '退货物流异常影响范围');
    return { scope: 'package' };
  }
  if (record.scope !== 'items' || !Array.isArray(record.items) || record.items.length === 0) {
    throw new Error('退货物流异常影响范围无效');
  }
  rejectUnknownKeys(record, ['scope', 'items'], '退货物流异常影响范围');
  return {
    scope: 'items',
    items: record.items.map((value) => {
      const item = asRecord(value, '退货物流异常商品无效');
      rejectUnknownKeys(item, ['sourceItemId', 'quantity'], '退货物流异常商品');
      return {
        sourceItemId: boundedText(item.sourceItemId, 200, '退货物流异常商品标识无效'),
        quantity: nonNegativeQuantity(item.quantity, '退货物流异常商品数量无效'),
      };
    }),
  };
}

function isLogisticsExceptionType(value: unknown): value is LogisticsExceptionType {
  return value === 'lost' || value === 'delivery_dispute' || value === 'damaged'
    || value === 'misdelivered' || value === 'other';
}

function nonNegativeQuantity(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) {
    throw new Error(message);
  }
  return Number(value);
}

function assertUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function invalidHandlingDirection(): never {
  throw new Error('售后处理方向无效');
}

function booleanValue(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message);
  return value;
}

function positiveMoney(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 100_000_000_000) {
    throw new Error(message);
  }
  return Number(value);
}

function dateTime(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) throw new Error(message);
  return normalized;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey) throw new Error(`${label}包含未知字段：${unknownKey}`);
}

function boundedText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > maximum) throw new Error(message);
  return normalized;
}

function optionalText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length > maximum) throw new Error(message);
  return normalized;
}

function money(value: unknown, optional: boolean): number | undefined {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 100_000_000_000) {
    throw new Error('申请退款金额无效');
  }
  return Number(value);
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('售后处理单版本无效');
  }
  return Number(value);
}

function isReturnInspectionResult(value: unknown): value is ReturnInspectionResult {
  return value === 'resellable' || value === 'defective' || value === 'scrapped' || value === 'other';
}

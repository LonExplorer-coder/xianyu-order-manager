import type {
  CarrierClaimEvent,
  LogisticsExceptionImpact,
  LogisticsExceptionStage,
  LogisticsExceptionType,
  OutboundLogisticsStatus,
} from './logistics-exceptions';
import { isSettledRefundStatus, type PendingFinancialItemStatus } from './aftersales-cases';
import type { ShipmentRecord } from './shipment-records';

export type AftersalesHandlingDirection =
  | 'waiting'
  | 'intercept'
  | 'refuse'
  | 'only_refund'
  | 'replacement'
  | 'buyer_return';

export type AftersalesPhysicalControl =
  | 'carrier'
  | 'buyer'
  | 'seller'
  | 'confirmed_lost'
  | 'mixed';

export type AftersalesInterceptionEvent = {
  kind: 'requested' | 'succeeded' | 'failed';
  occurredAt: string;
  reason: string;
  createdAt: string;
};

export type AftersalesInterception = {
  packageId: string | null;
  status: AftersalesInterceptionEvent['kind'];
  timeline: AftersalesInterceptionEvent[];
};

export type AftersalesReturnExceptionDecision =
  | 'wait_investigation'
  | 'refund_in_advance'
  | 'partial_refund'
  | 'reject_refund'
  | 'negotiate';

export type AftersalesOutboundExceptionDecision =
  | 'wait_investigation'
  | 'recover_or_redeliver'
  | 'refund_only'
  | 'replacement'
  | 'refund_and_replacement';

export type AftersalesOutboundExceptionDecisionEvent = {
  kind: 'selected' | 'changed';
  exceptionId: string;
  packageId: string;
  before: AftersalesOutboundExceptionDecision | null;
  after: AftersalesOutboundExceptionDecision;
  affectedItems: AftersalesOutboundExceptionEvidence['affectedItems'];
  occurredAt: string;
  reason: string;
  createdAt: string;
};

export type AftersalesOutboundExceptionEvidence = {
  exceptionId: string;
  sourceShipmentRecordId: string;
  packageId: string;
  exceptionType: LogisticsExceptionType;
  stage: LogisticsExceptionStage;
  affectedQuantity: number;
  affectedItems: Array<{
    shipmentPackageItemId: string;
    sourceTitle: string;
    sourceSpec: string;
    quantity: number;
  }>;
  occurredAt: string;
};

export type AftersalesOutboundExceptionCoordination =
  AftersalesOutboundExceptionEvidence & {
    decision: AftersalesOutboundExceptionDecision | null;
    availableDecisions: AftersalesOutboundExceptionDecision[];
    timeline: AftersalesOutboundExceptionDecisionEvent[];
  };

export type AftersalesInterceptedReturnInspectionResult =
  | 'resellable'
  | 'defective'
  | 'scrapped'
  | 'other';

export type AftersalesInterceptedReturnInspection = {
  packageId: string;
  result: AftersalesInterceptedReturnInspectionResult;
  items: Array<{ shipmentPackageItemId: string; quantity: number }>;
  occurredAt: string;
  reason: string;
  createdAt: string;
};

export type AftersalesReturnExceptionDecisionEvent = {
  kind: 'selected' | 'changed';
  exceptionId: string;
  returnRecordId: string;
  before: AftersalesReturnExceptionDecision | null;
  after: AftersalesReturnExceptionDecision;
  occurredAt: string;
  reason: string;
  createdAt: string;
};

export type AftersalesReturnExceptionEvidence = {
  exceptionId: string;
  returnRecordId: string;
  exceptionType: LogisticsExceptionType;
  stage: LogisticsExceptionStage;
  affectedQuantity: number;
};

export type AftersalesReturnExceptionCoordination =
  AftersalesReturnExceptionEvidence & {
    decision: AftersalesReturnExceptionDecision | null;
    availableDecisions: AftersalesReturnExceptionDecision[];
    timeline: AftersalesReturnExceptionDecisionEvent[];
  };

export type AftersalesHandlingDirectionEvent = {
  kind: 'selected' | 'changed' | 'cleared';
  before: AftersalesHandlingDirection | null;
  after: AftersalesHandlingDirection | null;
  occurredAt: string;
  reason: string;
  createdAt: string;
};

export type AftersalesSourcePackageEvidence = {
  packageId: string;
  shippingCarrier: string;
  trackingNumber: string;
  logisticsStatus: OutboundLogisticsStatus;
  confirmedLost: boolean;
  carrierClaim?: {
    id: string;
    status: 'pending' | 'approved' | 'rejected' | 'paid';
    requestedAmountCents: number;
    approvedAmountCents: number | null;
    actualCompensationCents: number | null;
    impact: LogisticsExceptionImpact;
    updatedAt: string;
    timeline: CarrierClaimEvent[];
  } | null;
  items: Array<{
    shipmentPackageItemId: string;
    sourceTitle: string;
    sourceSpec: string;
    quantity: number;
    confirmedLostQuantity: number;
  }>;
};

export type AftersalesCoordination = {
  handlingDirection: AftersalesHandlingDirection | null;
  physicalControl: AftersalesPhysicalControl;
  currentTodo: string;
  risk: string | null;
  availableDirections: AftersalesHandlingDirection[];
  handlingDirectionTimeline: AftersalesHandlingDirectionEvent[];
  sourcePackages: AftersalesSourcePackageEvidence[];
  interception: AftersalesInterception | null;
  outboundException: AftersalesOutboundExceptionCoordination | null;
  outboundExceptionHistory: AftersalesOutboundExceptionCoordination[];
  interceptedReturnInspection: AftersalesInterceptedReturnInspection | null;
  returnException: AftersalesReturnExceptionCoordination | null;
  returnExceptionHistory: AftersalesReturnExceptionCoordination[];
};

export const AFTERSALES_HANDLING_DIRECTIONS = [
  'waiting',
  'intercept',
  'refuse',
  'only_refund',
  'replacement',
  'buyer_return',
] as const satisfies readonly AftersalesHandlingDirection[];

export const AFTERSALES_RETURN_EXCEPTION_DECISIONS = [
  'wait_investigation',
  'refund_in_advance',
  'partial_refund',
  'reject_refund',
  'negotiate',
] as const satisfies readonly AftersalesReturnExceptionDecision[];

export const AFTERSALES_OUTBOUND_EXCEPTION_DECISIONS = [
  'wait_investigation',
  'recover_or_redeliver',
  'refund_only',
  'replacement',
  'refund_and_replacement',
] as const satisfies readonly AftersalesOutboundExceptionDecision[];

export function isAftersalesHandlingDirection(
  value: unknown,
): value is AftersalesHandlingDirection {
  return typeof value === 'string'
    && (AFTERSALES_HANDLING_DIRECTIONS as readonly string[]).includes(value);
}

export function isAftersalesReturnExceptionDecision(
  value: unknown,
): value is AftersalesReturnExceptionDecision {
  return typeof value === 'string'
    && (AFTERSALES_RETURN_EXCEPTION_DECISIONS as readonly string[]).includes(value);
}

export function isAftersalesOutboundExceptionDecision(
  value: unknown,
): value is AftersalesOutboundExceptionDecision {
  return typeof value === 'string'
    && (AFTERSALES_OUTBOUND_EXCEPTION_DECISIONS as readonly string[]).includes(value);
}

export function isAftersalesInterceptedReturnInspectionResult(
  value: unknown,
): value is AftersalesInterceptedReturnInspectionResult {
  return value === 'resellable'
    || value === 'defective'
    || value === 'scrapped'
    || value === 'other';
}

export function coordinateAftersales(input: {
  handlingDirection: AftersalesHandlingDirection | null;
  sourcePackages: AftersalesSourcePackageEvidence[];
  interception: AftersalesInterception | null;
  handlingDirectionTimeline?: AftersalesHandlingDirectionEvent[];
  refundStatus?: PendingFinancialItemStatus | null;
  returnExceptions?: Array<AftersalesReturnExceptionEvidence & {
    decisionTimeline: AftersalesReturnExceptionDecisionEvent[];
  }>;
  outboundExceptions?: Array<AftersalesOutboundExceptionEvidence & {
    decisionTimeline: AftersalesOutboundExceptionDecisionEvent[];
  }>;
  interceptedReturnInspection?: AftersalesInterceptedReturnInspection | null;
}): AftersalesCoordination {
  const physicalControl = physicalControlForSourcePackages(input.sourcePackages);
  const availableDirections = availableAftersalesDirections(physicalControl);
  const returnExceptionHistory = (input.returnExceptions ?? []).map((exception) => (
    coordinateReturnException(exception, exception.decisionTimeline)
  ));
  const returnException = [...returnExceptionHistory].reverse().find((exception) => (
    exception.stage !== 'recovered' && exception.stage !== 'resolved'
  )) ?? null;
  const outboundExceptionHistory = (input.outboundExceptions ?? []).map((exception) => ({
    ...exception,
    decision: exception.decisionTimeline.at(-1)?.after ?? null,
    availableDecisions: [...AFTERSALES_OUTBOUND_EXCEPTION_DECISIONS],
    timeline: exception.decisionTimeline,
  }));
  const confirmedOutboundExceptions = outboundExceptionHistory.filter((exception) => (
    exception.stage === 'confirmed'
  ));
  const outboundException = [...confirmedOutboundExceptions].reverse().find((exception) => (
    exception.decision === null
  )) ?? confirmedOutboundExceptions.at(-1) ?? null;
  const { currentTodo, risk } = returnException
    ? actionForReturnException(returnException, input.refundStatus ?? null)
    : input.interceptedReturnInspection
      ? {
        currentTodo: '拦截退回商品已检查，请明确退款、补发或其他后续处理',
        risk: null,
      }
    : outboundException
      ? actionForOutboundException(outboundException, input.refundStatus ?? null)
    : actionFor({
    physicalControl,
    hasConfirmedLoss: input.sourcePackages.some((sourcePackage) => (
      sourcePackage.items.some(({ confirmedLostQuantity }) => confirmedLostQuantity > 0)
    )),
    handlingDirection: input.handlingDirection,
    interception: input.interception,
    refundStatus: input.refundStatus ?? null,
    });
  return {
    handlingDirection: input.handlingDirection,
    physicalControl,
    currentTodo,
    risk,
    availableDirections,
    handlingDirectionTimeline: input.handlingDirectionTimeline ?? [],
    sourcePackages: input.sourcePackages,
    interception: input.interception,
    outboundException,
    outboundExceptionHistory,
    interceptedReturnInspection: input.interceptedReturnInspection ?? null,
    returnException,
    returnExceptionHistory,
  };
}

function actionForOutboundException(
  exception: AftersalesOutboundExceptionCoordination,
  refundStatus: PendingFinancialItemStatus | null,
): Pick<AftersalesCoordination, 'currentTodo' | 'risk'> {
  const risk = `正向${exception.exceptionType === 'lost' ? '丢件' : '物流异常'}影响 ${exception.affectedQuantity} 件商品`;
  if (exception.decision === null) {
    return { currentTodo: '正向物流异常已确认，请明确买家侧处理选择', risk };
  }
  if (exception.decision === 'wait_investigation') {
    return { currentTodo: '继续等待承运调查，买家退款与补发尚未发生', risk };
  }
  if (exception.decision === 'recover_or_redeliver') {
    return { currentTodo: '继续追回或重新派送原正向包裹', risk };
  }
  if (exception.decision === 'refund_only') {
    return {
      currentTodo: isSettledRefundStatus(refundStatus)
        ? '实际退款已确认，继续处理正向物流异常和承运索赔'
        : '核对并确认实际退款，正向物流异常继续独立处理',
      risk,
    };
  }
  if (exception.decision === 'replacement') {
    return { currentTodo: '建立并跟进独立补发记录，原正向异常继续独立处理', risk };
  }
  return {
    currentTodo: isSettledRefundStatus(refundStatus)
      ? '实际退款已确认，继续建立或跟进独立补发记录'
      : '确认实际退款并建立独立补发记录',
    risk,
  };
}

function coordinateReturnException(
  evidence: AftersalesReturnExceptionEvidence,
  timeline: AftersalesReturnExceptionDecisionEvent[],
): AftersalesReturnExceptionCoordination {
  return {
    ...evidence,
    decision: timeline.at(-1)?.after ?? null,
    availableDecisions: [...AFTERSALES_RETURN_EXCEPTION_DECISIONS],
    timeline,
  };
}

function actionForReturnException(
  exception: AftersalesReturnExceptionCoordination,
  refundStatus: PendingFinancialItemStatus | null,
): Pick<AftersalesCoordination, 'currentTodo' | 'risk'> {
  const risk = exception.exceptionType === 'delivery_dispute'
    ? '签收扫描不等于卖家实际收到，不能直接进入检查'
    : exception.exceptionType === 'lost' && exception.stage === 'confirmed'
      ? '退货商品未回到卖家控制中，不能登记收到或检查'
      : `退货物流异常影响 ${exception.affectedQuantity} 件商品`;
  if (exception.decision === null) {
    return {
      currentTodo: exception.exceptionType === 'delivery_dispute'
        ? '退货签收存在争议，请先核对实际收到并处理承运异常'
        : exception.exceptionType === 'lost' && exception.stage === 'confirmed'
          ? '退货已确认丢失，请选择退款处理并继续承运异常处理'
          : '处理退货物流异常并明确买家侧处理选择',
      risk,
    };
  }
  if (exception.decision === 'wait_investigation') {
    return {
      currentTodo: isSettledRefundStatus(refundStatus)
        ? '实际退款已确认，继续等待承运调查'
        : '继续等待承运调查，实际退款尚未发生',
      risk,
    };
  }
  if (exception.decision === 'refund_in_advance') {
    return {
      currentTodo: isSettledRefundStatus(refundStatus)
        ? '先行实际退款已确认，继续处理退货物流异常'
        : '核对并确认先行实际退款，承运异常继续独立处理',
      risk,
    };
  }
  if (exception.decision === 'partial_refund') {
    return {
      currentTodo: isSettledRefundStatus(refundStatus)
        ? '部分实际退款已确认，继续处理退货物流异常'
        : '核对并确认部分实际退款，承运异常继续独立处理',
      risk,
    };
  }
  if (exception.decision === 'reject_refund') {
    return {
      currentTodo: isSettledRefundStatus(refundStatus)
        ? '已记录实际退款，原拒绝退款选择与异常继续保留'
        : '已选择拒绝退款，继续处理退货物流异常',
      risk,
    };
  }
  if (exception.decision === 'negotiate') {
    return {
      currentTodo: isSettledRefundStatus(refundStatus)
        ? '实际退款已确认，承运异常继续独立处理'
        : '继续与买家协商，承运异常独立处理',
      risk,
    };
  }
  return { currentTodo: '处理退货物流异常', risk };
}

export function statusForHandlingDirection(
  direction: AftersalesHandlingDirection,
): 'processing' | 'waiting_return' | 'waiting_refund' | 'waiting_replacement' {
  if (direction === 'buyer_return') return 'waiting_return';
  if (direction === 'only_refund') return 'waiting_refund';
  if (direction === 'replacement') return 'waiting_replacement';
  return 'processing';
}

export function physicalControlForSourcePackages(
  sourcePackages: readonly AftersalesSourcePackageEvidence[],
): AftersalesPhysicalControl {
  const controls = new Set<Exclude<AftersalesPhysicalControl, 'mixed'>>();
  for (const sourcePackage of sourcePackages) {
    const normalControl = sourcePackage.logisticsStatus === 'delivered'
      ? 'buyer' as const
      : sourcePackage.logisticsStatus === 'returned'
        ? 'seller' as const
        : 'carrier' as const;
    for (const item of sourcePackage.items) {
      if (item.confirmedLostQuantity > 0) controls.add('confirmed_lost');
      if (item.confirmedLostQuantity < item.quantity) controls.add(normalControl);
    }
  }
  return controls.size === 1 ? [...controls][0] : 'mixed';
}

export function sourcePackageEvidenceFromShipmentRecord(
  record: ShipmentRecord,
  quantities: Readonly<Record<string, number>>,
): AftersalesSourcePackageEvidence[] {
  return record.packages.flatMap((shipmentPackage) => {
    if (shipmentPackage.status !== 'active') return [];
    const items = shipmentPackage.items.flatMap((item) => {
      const quantity = quantities[item.id] ?? 0;
      if (quantity <= 0) return [];
      const confirmedLostQuantity = confirmedLostQuantityForItem(shipmentPackage, item.id);
      return [{
        shipmentPackageItemId: item.id,
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        quantity,
        confirmedLostQuantity: Math.min(quantity, confirmedLostQuantity),
      }];
    });
    if (items.length === 0) return [];
    return [{
      packageId: shipmentPackage.id,
      shippingCarrier: shipmentPackage.shippingCarrier,
      trackingNumber: shipmentPackage.trackingNumber,
      logisticsStatus: shipmentPackage.logisticsStatus,
      confirmedLost: items.every(({ confirmedLostQuantity, quantity }) => (
        confirmedLostQuantity === quantity
      )),
      carrierClaim: shipmentPackage.carrierClaim ? {
        id: shipmentPackage.carrierClaim.id,
        status: shipmentPackage.carrierClaim.status,
        requestedAmountCents: shipmentPackage.carrierClaim.requestedAmountCents,
        approvedAmountCents: shipmentPackage.carrierClaim.approvedAmountCents,
        actualCompensationCents:
          shipmentPackage.carrierClaim.actualCompensation?.amountCents ?? null,
        impact: shipmentPackage.carrierClaim.impact,
        updatedAt: shipmentPackage.carrierClaim.timeline.at(-1)?.occurredAt
          ?? shipmentPackage.carrierClaim.updatedAt,
        timeline: shipmentPackage.carrierClaim.timeline,
      } : null,
      items,
    }];
  });
}

function confirmedLostQuantityForItem(
  shipmentPackage: ShipmentRecord['packages'][number],
  itemId: string,
): number {
  const itemQuantity = shipmentPackage.items.find(({ id }) => id === itemId)?.quantity ?? 0;
  return shipmentPackage.logisticsExceptions
    .filter(({ exceptionType, stage }) => exceptionType === 'lost' && stage === 'confirmed')
    .reduce((confirmedQuantity, exception) => {
      if (exception.impact.scope === 'package') return itemQuantity;
      const affectedQuantity = exception.impact.items
        .find(({ sourceItemId }) => sourceItemId === itemId)?.quantity ?? 0;
      return Math.max(confirmedQuantity, affectedQuantity);
    }, 0);
}

export function availableAftersalesDirections(
  physicalControl: AftersalesPhysicalControl,
): AftersalesHandlingDirection[] {
  if (physicalControl === 'carrier') {
    return ['waiting', 'intercept', 'refuse', 'only_refund', 'replacement'];
  }
  if (physicalControl === 'buyer') {
    return ['waiting', 'buyer_return', 'only_refund', 'replacement'];
  }
  return ['waiting', 'only_refund', 'replacement'];
}

function actionFor(input: {
  physicalControl: AftersalesPhysicalControl;
  hasConfirmedLoss: boolean;
  handlingDirection: AftersalesHandlingDirection | null;
  interception: AftersalesInterception | null;
  refundStatus: PendingFinancialItemStatus | null;
}): Pick<AftersalesCoordination, 'currentTodo' | 'risk'> {
  if (input.physicalControl === 'confirmed_lost') {
    if (input.handlingDirection === 'replacement') {
      return {
        currentTodo: '已选择补发，待后续建立新的补发发货记录',
        risk: '原正向包裹已确认丢失，本任务尚未建立补发发货记录',
      };
    }
    if (input.handlingDirection === 'only_refund') {
      return {
        currentTodo: isSettledRefundStatus(input.refundStatus)
          ? '实际退款已确认，丢件调查可继续独立跟进'
          : '核对并确认实际退款',
        risk: '原正向包裹已确认丢失',
      };
    }
    return {
      currentTodo: '原正向包裹已确认丢失，请选择退款、补发或继续调查',
      risk: '原正向包裹确认丢失，商品不在买家控制中',
    };
  }
  if (input.physicalControl === 'mixed') {
    if (!input.hasConfirmedLoss) {
      if (input.handlingDirection === 'replacement') {
        return {
          currentTodo: '已选择补发，待后续建立新的补发发货记录',
          risk: '所选商品的实物控制关系不一致，补发可能导致重复交付',
        };
      }
      if (input.handlingDirection === 'only_refund') {
        return {
          currentTodo: isSettledRefundStatus(input.refundStatus)
            ? '实际退款已确认，继续分别跟踪所选商品实物'
            : '核对并确认实际退款',
          risk: '所选商品的实物控制关系不一致，退款与实物需分别跟踪',
        };
      }
      return {
        currentTodo: '所选商品的实物控制关系不一致，请逐件核实并选择后续处理方向',
        risk: '同一售后内商品实物控制关系不一致',
      };
    }
    if (input.handlingDirection === 'replacement') {
      return {
        currentTodo: '已选择补发，待后续建立新的补发发货记录',
        risk: '部分商品已确认丢失，其余商品仍需按实际流转跟踪',
      };
    }
    if (input.handlingDirection === 'only_refund') {
      return {
        currentTodo: isSettledRefundStatus(input.refundStatus)
          ? '实际退款已确认，继续调查未收回商品'
          : '核对并确认实际退款',
        risk: '部分商品已确认丢失，退款与其余实物需分别跟踪',
      };
    }
    return {
      currentTodo: '部分商品已确认丢失，请选择退款、补发或继续调查',
      risk: '同一售后内商品实物控制关系不一致',
    };
  }
  if (input.physicalControl === 'buyer'
    && input.handlingDirection !== 'buyer_return'
    && input.handlingDirection !== 'only_refund'
    && input.handlingDirection !== 'replacement') {
    return {
      currentTodo: '原正向包裹已签收，请显式转换售后处理方向',
      risk: '商品已由买家控制，原在途处理方向已不符合实物流转',
    };
  }
  if (input.interception?.status === 'requested') {
    if (input.handlingDirection === 'only_refund' && isSettledRefundStatus(input.refundStatus)) {
      return {
        currentTodo: '实际退款已确认，拦截请求仍待确认',
        risk: '拦截结果未确认，不应假定原正向包裹已收回',
      };
    }
    if (input.handlingDirection === 'replacement') {
      return {
        currentTodo: '已选择补发，拦截请求仍待确认；补发发货记录尚未建立',
        risk: '拦截结果未确认，补发可能导致重复交付',
      };
    }
    return {
      currentTodo: '拦截请求待确认，继续跟踪原正向包裹',
      risk: '拦截结果未确认，不应假定原正向包裹已收回',
    };
  }
  if (input.handlingDirection === 'intercept') {
    if (input.interception?.status === 'failed') {
      return {
        currentTodo: '拦截失败，请转换为买家寄回、仅退款、补发或继续等待',
        risk: '拦截失败，原正向包裹仍可能送达买家',
      };
    }
    if (input.interception?.status === 'succeeded') {
      return {
        currentTodo: '拦截成功，继续核对原正向包裹的退回实物',
        risk: '拦截成功不等于包裹已退回卖家',
      };
    }
    return {
      currentTodo: '拦截请求待确认，继续跟踪原正向包裹',
      risk: '商品仍在运输中，拦截结果未确认',
    };
  }
  if (input.handlingDirection === 'buyer_return') {
    return { currentTodo: '等待买家退回', risk: null };
  }
  if (input.handlingDirection === 'only_refund') {
    if (isSettledRefundStatus(input.refundStatus) && input.physicalControl === 'buyer') {
      return {
        currentTodo: '买家已退款且原商品已签收，请跟进收回商品',
        risk: '资金已退出，原商品仍在买家控制中',
      };
    }
    if (isSettledRefundStatus(input.refundStatus) && input.physicalControl === 'carrier') {
      return {
        currentTodo: '实际退款已确认，继续跟踪并收回原正向包裹',
        risk: '买家已退款，原商品仍在运输中',
      };
    }
    return {
      currentTodo: '核对并确认实际退款',
      risk: input.physicalControl === 'carrier'
        ? '商品仍在运输中，退款与收回实物需分别跟踪'
        : null,
    };
  }
  if (input.handlingDirection === 'replacement') {
    return {
      currentTodo: '已选择补发，待后续建立新的补发发货记录',
      risk: input.physicalControl === 'carrier'
        ? '原商品仍在运输中，补发可能导致重复交付'
        : null,
    };
  }
  if (input.handlingDirection === 'refuse') {
    return {
      currentTodo: '等待买家拒收，继续跟踪原正向包裹',
      risk: '拒收约定不等于包裹已退回卖家',
    };
  }
  return {
    currentTodo: '继续跟踪原正向包裹并等待处理决定',
    risk: input.physicalControl === 'carrier' ? '商品仍在运输中' : null,
  };
}

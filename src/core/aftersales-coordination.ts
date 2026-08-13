import type {
  LogisticsExceptionStage,
  LogisticsExceptionType,
  OutboundLogisticsStatus,
} from './logistics-exceptions';
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
  status: AftersalesInterceptionEvent['kind'];
  timeline: AftersalesInterceptionEvent[];
};

export type AftersalesReturnExceptionDecision =
  | 'wait_investigation'
  | 'refund_in_advance'
  | 'partial_refund'
  | 'reject_refund'
  | 'negotiate';

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
  kind: 'selected' | 'changed';
  before: AftersalesHandlingDirection | null;
  after: AftersalesHandlingDirection;
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
  returnException: AftersalesReturnExceptionCoordination | null;
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

export function coordinateAftersales(input: {
  handlingDirection: AftersalesHandlingDirection | null;
  sourcePackages: AftersalesSourcePackageEvidence[];
  interception: AftersalesInterception | null;
  handlingDirectionTimeline?: AftersalesHandlingDirectionEvent[];
  refundStatus?: 'pending' | 'confirmed' | 'cancelled' | null;
  returnException?: AftersalesReturnExceptionEvidence | null;
  returnExceptionDecisionTimeline?: AftersalesReturnExceptionDecisionEvent[];
}): AftersalesCoordination {
  const physicalControl = physicalControlForSourcePackages(input.sourcePackages);
  const availableDirections = availableAftersalesDirections(physicalControl);
  const returnException = input.returnException
    ? coordinateReturnException(
      input.returnException,
      input.returnExceptionDecisionTimeline ?? [],
    )
    : null;
  const { currentTodo, risk } = returnException
    ? actionForReturnException(returnException, input.refundStatus ?? null)
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
    returnException,
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
  refundStatus: 'pending' | 'confirmed' | 'cancelled' | null,
): Pick<AftersalesCoordination, 'currentTodo' | 'risk'> {
  if (exception.exceptionType === 'delivery_dispute') {
    return {
      currentTodo: '退货签收存在争议，请先核对实际收到并处理承运异常',
      risk: '签收扫描不等于卖家实际收到，不能直接进入检查',
    };
  }
  if (exception.exceptionType !== 'lost' || exception.stage !== 'confirmed') {
    return {
      currentTodo: '处理退货物流异常并明确买家侧处理选择',
      risk: `退货物流异常影响 ${exception.affectedQuantity} 件商品`,
    };
  }
  const risk = '退货商品未回到卖家控制中，不能登记收到或检查';
  if (exception.decision === 'wait_investigation') {
    return {
      currentTodo: refundStatus === 'confirmed'
        ? '实际退款已确认，继续等待承运调查'
        : '继续等待承运调查，实际退款尚未发生',
      risk,
    };
  }
  if (exception.decision === 'refund_in_advance') {
    return {
      currentTodo: refundStatus === 'confirmed'
        ? '先行实际退款已确认，继续处理退货物流异常'
        : '核对并确认先行实际退款，承运异常继续独立处理',
      risk,
    };
  }
  if (exception.decision === 'partial_refund') {
    return {
      currentTodo: refundStatus === 'confirmed'
        ? '部分实际退款已确认，继续处理退货物流异常'
        : '核对并确认部分实际退款，承运异常继续独立处理',
      risk,
    };
  }
  if (exception.decision === 'reject_refund') {
    return {
      currentTodo: refundStatus === 'confirmed'
        ? '已记录实际退款，原拒绝退款选择与异常继续保留'
        : '已选择拒绝退款，继续处理退货物流异常',
      risk,
    };
  }
  if (exception.decision === 'negotiate') {
    return {
      currentTodo: refundStatus === 'confirmed'
        ? '实际退款已确认，承运异常继续独立处理'
        : '继续与买家协商，承运异常独立处理',
      risk,
    };
  }
  return {
    currentTodo: '退货已确认丢失，请选择退款处理并继续承运异常处理',
    risk,
  };
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
  refundStatus: 'pending' | 'confirmed' | 'cancelled' | null;
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
        currentTodo: input.refundStatus === 'confirmed'
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
          currentTodo: input.refundStatus === 'confirmed'
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
        currentTodo: input.refundStatus === 'confirmed'
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
    if (input.handlingDirection === 'only_refund' && input.refundStatus === 'confirmed') {
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
    if (input.refundStatus === 'confirmed' && input.physicalControl === 'buyer') {
      return {
        currentTodo: '买家已退款且原商品已签收，请跟进收回商品',
        risk: '资金已退出，原商品仍在买家控制中',
      };
    }
    if (input.refundStatus === 'confirmed' && input.physicalControl === 'carrier') {
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

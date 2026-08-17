import type {
  AftersalesCase,
  AftersalesCaseStepEvent,
  AftersalesCaseWorkflowTemplate,
  AftersalesWorkflow,
  ProgressAftersalesCaseInput,
} from './aftersales-cases';

export type AftersalesWorkflowTemplateOrigin = 'system' | 'custom';

export type AftersalesWorkflowScenario =
  | 'refund_only'
  | 'return_refund'
  | 'exchange'
  | 'direct_replacement'
  | 'intercept_return'
  | 'lost_handling'
  | 'other';

export type AftersalesWorkflowStepKind =
  | 'identify_issue'
  | 'choose_resolution'
  | 'request_interception'
  | 'register_return'
  | 'receive_return'
  | 'inspect_return'
  | 'confirm_refund'
  | 'prepare_replacement'
  | 'confirm_replacement_delivery'
  | 'resolve_logistics_exception'
  | 'record_resolution'
  | 'complete';

// 整案取消（cancel）属于处理单生命周期动作，不属于任何流程步骤。
export type AftersalesWorkflowProgressActionKind =
  Exclude<ProgressAftersalesCaseInput, { kind: 'cancel' }>['kind'];

export type AftersalesWorkflowStepCategory = 'fact' | 'management';

export type AftersalesWorkflowStepBinding = {
  category: AftersalesWorkflowStepCategory;
  actions: readonly AftersalesWorkflowProgressActionKind[];
};

export type AftersalesWorkflowField =
  | 'occurred_at'
  | 'reason'
  | 'items'
  | 'requested_refund_amount'
  | 'handling_direction'
  | 'interception_package'
  | 'shipping_carrier'
  | 'tracking_number'
  | 'received_quantity'
  | 'inspection_result'
  | 'inspection_note'
  | 'replacement_packages'
  | 'logistics_exception'
  | 'resolution_reason';

export type AftersalesWorkflowConditionFact =
  | 'refund_requested'
  | 'return_registered'
  | 'replacement_required'
  | 'interception_requested'
  | 'logistics_exception_present';

export type AftersalesWorkflowStepCondition = {
  fact: AftersalesWorkflowConditionFact;
  equals: boolean;
};

export type AftersalesWorkflowStep = {
  id: string;
  // null 表示「需要检查」：存量步骤无法绑定任何已定义业务动作，仅可见、不可执行。
  kind: AftersalesWorkflowStepKind | null;
  name: string;
  required: boolean;
  fields: AftersalesWorkflowField[];
  condition: AftersalesWorkflowStepCondition | null;
};

export type AftersalesWorkflowTemplate = {
  id: string;
  origin: AftersalesWorkflowTemplateOrigin;
  systemKey: AftersalesWorkflowScenario | null;
  enabled: boolean;
  version: number;
  name: string;
  scenario: AftersalesWorkflowScenario;
  workflow: AftersalesWorkflow;
  steps: AftersalesWorkflowStep[];
  createdAt: string;
  updatedAt: string;
  versionCreatedAt: string;
};

// 六态由流程定义和真实事实共同计算，不落库存储。
export type AftersalesWorkflowStepState =
  | 'not_started'
  | 'current'
  | 'partial'
  | 'completed'
  | 'skipped'
  | 'not_applicable';

export type AftersalesWorkflowStepProgress =
  | { kind: 'amount'; refundedCents: number; targetCents: number }
  | { kind: 'quantity'; doneQuantity: number; totalQuantity: number };

export type AftersalesWorkflowStepProjection = AftersalesWorkflowStep & {
  state: AftersalesWorkflowStepState;
  binding: AftersalesWorkflowStepBinding | null;
  progress: AftersalesWorkflowStepProgress | null;
  notApplicableReason: string | null;
  stepEvent: AftersalesCaseStepEvent | null;
};

// 正常操作入口的类型：primary 是当前或部分完成步骤的绑定动作（按步骤顺序开放），
// supplemental 是尚未轮到但真实事实可能已经发生的补录入口（仅事实型步骤）。
export type AftersalesWorkflowOperation = {
  action: AftersalesWorkflowProgressActionKind;
  stepId: string;
  blockedReason: string | null;
};

export type AftersalesWorkflowOperations = {
  primary: AftersalesWorkflowOperation[];
  supplemental: AftersalesWorkflowOperation[];
};

export type StoredAftersalesWorkflowTemplateDefinition = {
  name: string;
  scenario: AftersalesWorkflowScenario;
  steps: AftersalesWorkflowStep[];
};

export type UpdateAftersalesWorkflowTemplateInput = StoredAftersalesWorkflowTemplateDefinition & {
  expectedVersion: number;
};

export type CreateAftersalesWorkflowTemplateInput = StoredAftersalesWorkflowTemplateDefinition;

export type CopyAftersalesWorkflowTemplateInput = {
  sourceTemplateId: string;
  name: string;
};

export const AFTERSALES_WORKFLOW_STEP_KINDS = [
  'identify_issue',
  'choose_resolution',
  'request_interception',
  'register_return',
  'receive_return',
  'inspect_return',
  'confirm_refund',
  'prepare_replacement',
  'confirm_replacement_delivery',
  'resolve_logistics_exception',
  'record_resolution',
  'complete',
] as const satisfies readonly AftersalesWorkflowStepKind[];

export const AFTERSALES_WORKFLOW_FIELDS = [
  'occurred_at',
  'reason',
  'items',
  'requested_refund_amount',
  'handling_direction',
  'interception_package',
  'shipping_carrier',
  'tracking_number',
  'received_quantity',
  'inspection_result',
  'inspection_note',
  'replacement_packages',
  'logistics_exception',
  'resolution_reason',
] as const satisfies readonly AftersalesWorkflowField[];

export const AFTERSALES_WORKFLOW_CONDITION_FACTS = [
  'refund_requested',
  'return_registered',
  'replacement_required',
  'interception_requested',
  'logistics_exception_present',
] as const satisfies readonly AftersalesWorkflowConditionFact[];

// 事实型步骤只能由真实业务事实满足；管理型步骤保存人与业务之间的处理确认。
// 绑定表固定「步骤 kind → 已定义领域动作」的映射，模板只能调整顺序、必需性、
// 字段要求与一层条件，不能创造系统未定义的业务动作。
export const AFTERSALES_WORKFLOW_STEP_BINDINGS = {
  identify_issue: {
    category: 'management',
    actions: ['start_next_round'],
  },
  choose_resolution: {
    category: 'management',
    actions: ['change_handling_direction', 'decide_outbound_logistics_exception'],
  },
  request_interception: {
    category: 'fact',
    actions: ['change_handling_direction', 'record_interception_result'],
  },
  register_return: {
    category: 'fact',
    actions: ['register_return', 'correct_return_logistics', 'update_return_logistics_status'],
  },
  receive_return: { category: 'fact', actions: ['receive_return'] },
  inspect_return: {
    category: 'fact',
    actions: ['inspect_return', 'inspect_intercepted_return'],
  },
  confirm_refund: {
    category: 'fact',
    actions: ['confirm_refund', 'adjust_refund_target', 'end_refund', 'cancel_refund_request'],
  },
  prepare_replacement: { category: 'fact', actions: ['create_replacement_shipment'] },
  // 补发签收由补发物流同步事实满足，没有对应的进度动作。
  confirm_replacement_delivery: { category: 'fact', actions: [] },
  resolve_logistics_exception: {
    category: 'fact',
    actions: [
      'decide_outbound_logistics_exception',
      'record_return_logistics_exception',
      'progress_return_logistics_exception',
      'decide_return_logistics_exception',
      'open_carrier_claim',
      'resolve_carrier_claim',
      'confirm_carrier_compensation',
    ],
  },
  // 记录处理结果由处理单状态推进满足，没有专属进度动作。
  record_resolution: { category: 'management', actions: [] },
  complete: { category: 'management', actions: ['complete'] },
} as const satisfies Readonly<Record<AftersalesWorkflowStepKind, AftersalesWorkflowStepBinding>>;

export function isBoundAftersalesWorkflowStepKind(
  value: unknown,
): value is AftersalesWorkflowStepKind {
  return typeof value === 'string' && Object.hasOwn(AFTERSALES_WORKFLOW_STEP_BINDINGS, value);
}

export function aftersalesWorkflowStepCategoryLabel(
  category: AftersalesWorkflowStepCategory,
): string {
  return category === 'fact' ? '事实型' : '管理型';
}

export function aftersalesWorkflowFieldLabel(value: AftersalesWorkflowField): string {
  return ({
    occurred_at: '发生时间',
    reason: '原因',
    items: '商品与数量',
    requested_refund_amount: '申请退款金额',
    handling_direction: '处理方向',
    interception_package: '拦截包裹',
    shipping_carrier: '承运方',
    tracking_number: '运单号',
    received_quantity: '收到数量',
    inspection_result: '检查结果',
    inspection_note: '检查说明',
    replacement_packages: '补发包裹',
    logistics_exception: '物流异常',
    resolution_reason: '处理说明',
  })[value];
}

export const SYSTEM_AFTERSALES_WORKFLOW_TEMPLATE_IDS = {
  refundOnly: 'system-aftersales-refund-only',
  returnRefund: 'system-aftersales-return-refund',
  exchange: 'system-aftersales-exchange',
  directReplacement: 'system-aftersales-direct-replacement',
  interceptReturn: 'system-aftersales-intercept-return',
  lostHandling: 'system-aftersales-lost-handling',
  other: 'system-aftersales-other',
} as const;

export const SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES: ReadonlyArray<{
  id: string;
  systemKey: AftersalesWorkflowScenario;
  definition: StoredAftersalesWorkflowTemplateDefinition;
}> = [
  {
    id: SYSTEM_AFTERSALES_WORKFLOW_TEMPLATE_IDS.refundOnly,
    systemKey: 'refund_only',
    definition: {
      name: '仅退款',
      scenario: 'refund_only',
      steps: [
        step('identify-issue', 'identify_issue', '确认问题与退款申请', true, [
          'occurred_at', 'reason', 'items', 'requested_refund_amount',
        ]),
        step('confirm-refund', 'confirm_refund', '确认实际退款', true, [
          'occurred_at', 'requested_refund_amount', 'resolution_reason',
        ], condition('refund_requested')),
        step('complete', 'complete', '完成售后', true, ['resolution_reason']),
      ],
    },
  },
  {
    id: SYSTEM_AFTERSALES_WORKFLOW_TEMPLATE_IDS.returnRefund,
    systemKey: 'return_refund',
    definition: {
      name: '退货退款',
      scenario: 'return_refund',
      steps: [
        step('identify-issue', 'identify_issue', '确认问题商品与退款申请', true, [
          'occurred_at', 'reason', 'items', 'requested_refund_amount',
        ]),
        step('choose-resolution', 'choose_resolution', '确认实物流转方向', true, [
          'handling_direction', 'resolution_reason',
        ]),
        step('register-return', 'register_return', '登记退货物流', true, [
          'shipping_carrier', 'tracking_number', 'occurred_at', 'reason',
        ]),
        step('receive-return', 'receive_return', '确认收到退货', true, [
          'received_quantity', 'occurred_at', 'reason',
        ], condition('return_registered')),
        step('inspect-return', 'inspect_return', '检查退回商品', true, [
          'inspection_result', 'inspection_note', 'occurred_at',
        ], condition('return_registered')),
        step('confirm-refund', 'confirm_refund', '确认实际退款', true, [
          'requested_refund_amount', 'occurred_at', 'resolution_reason',
        ], condition('refund_requested')),
        step('complete', 'complete', '完成售后', true, ['resolution_reason']),
      ],
    },
  },
  {
    id: SYSTEM_AFTERSALES_WORKFLOW_TEMPLATE_IDS.exchange,
    systemKey: 'exchange',
    definition: {
      name: '换货',
      scenario: 'exchange',
      steps: [
        step('identify-issue', 'identify_issue', '确认换货商品', true, [
          'occurred_at', 'reason', 'items',
        ]),
        step('register-return', 'register_return', '登记退货物流', true, [
          'shipping_carrier', 'tracking_number', 'occurred_at', 'reason',
        ]),
        step('receive-return', 'receive_return', '确认收到退货', true, [
          'received_quantity', 'occurred_at', 'reason',
        ], condition('return_registered')),
        step('inspect-return', 'inspect_return', '检查退回商品', true, [
          'inspection_result', 'inspection_note', 'occurred_at',
        ], condition('return_registered')),
        step('prepare-replacement', 'prepare_replacement', '建立换货补发', true, [
          'replacement_packages', 'occurred_at', 'reason',
        ]),
        step(
          'confirm-replacement-delivery',
          'confirm_replacement_delivery',
          '确认换货补发签收',
          true,
          [],
          condition('replacement_required'),
        ),
        step('complete', 'complete', '完成售后', true, ['resolution_reason']),
      ],
    },
  },
  {
    id: SYSTEM_AFTERSALES_WORKFLOW_TEMPLATE_IDS.directReplacement,
    systemKey: 'direct_replacement',
    definition: {
      name: '直接补发',
      scenario: 'direct_replacement',
      steps: [
        step('identify-issue', 'identify_issue', '确认补发商品', true, [
          'occurred_at', 'reason', 'items',
        ]),
        step('prepare-replacement', 'prepare_replacement', '建立补发记录', true, [
          'replacement_packages', 'occurred_at', 'reason',
        ]),
        step(
          'confirm-replacement-delivery',
          'confirm_replacement_delivery',
          '确认补发签收',
          true,
          [],
          condition('replacement_required'),
        ),
        step('complete', 'complete', '完成售后', true, ['resolution_reason']),
      ],
    },
  },
  {
    id: SYSTEM_AFTERSALES_WORKFLOW_TEMPLATE_IDS.interceptReturn,
    systemKey: 'intercept_return',
    definition: {
      name: '拦截退回',
      scenario: 'intercept_return',
      steps: [
        step('identify-issue', 'identify_issue', '确认问题商品', true, [
          'occurred_at', 'reason', 'items', 'requested_refund_amount',
        ]),
        step('request-interception', 'request_interception', '申请拦截指定包裹', true, [
          'interception_package', 'occurred_at', 'reason',
        ]),
        step('choose-resolution', 'choose_resolution', '根据拦截结果确认后续处理', true, [
          'handling_direction', 'resolution_reason',
        ], condition('interception_requested')),
        step('inspect-return', 'inspect_return', '检查实际退回商品', true, [
          'inspection_result', 'inspection_note', 'occurred_at',
        ]),
        step('complete', 'complete', '完成售后', true, ['resolution_reason']),
      ],
    },
  },
  {
    id: SYSTEM_AFTERSALES_WORKFLOW_TEMPLATE_IDS.lostHandling,
    systemKey: 'lost_handling',
    definition: {
      name: '丢件处理',
      scenario: 'lost_handling',
      steps: [
        step('identify-issue', 'identify_issue', '确认受影响商品', true, [
          'occurred_at', 'reason', 'items',
        ]),
        step('resolve-logistics-exception', 'resolve_logistics_exception', '核实物流异常', true, [
          'logistics_exception', 'occurred_at', 'reason',
        ]),
        step('choose-resolution', 'choose_resolution', '选择买家侧处理', true, [
          'handling_direction', 'resolution_reason',
        ], condition('logistics_exception_present')),
        step('confirm-refund', 'confirm_refund', '按选择确认退款', true, [
          'requested_refund_amount', 'occurred_at', 'resolution_reason',
        ], condition('refund_requested')),
        step('prepare-replacement', 'prepare_replacement', '按选择建立补发', true, [
          'replacement_packages', 'occurred_at', 'reason',
        ], condition('replacement_required')),
        step('complete', 'complete', '完成售后', true, ['resolution_reason']),
      ],
    },
  },
  {
    id: SYSTEM_AFTERSALES_WORKFLOW_TEMPLATE_IDS.other,
    systemKey: 'other',
    definition: {
      name: '其他处理',
      scenario: 'other',
      steps: [
        step('identify-issue', 'identify_issue', '确认问题商品', true, [
          'occurred_at', 'reason', 'items',
        ]),
        step('record-resolution', 'record_resolution', '记录处理结果', true, [
          'resolution_reason',
        ]),
        step('complete', 'complete', '完成售后', true, ['resolution_reason']),
      ],
    },
  },
];

export function aftersalesWorkflowForScenario(
  scenario: AftersalesWorkflowScenario,
): AftersalesWorkflow {
  if (scenario === 'refund_only') return 'refund_only';
  if (scenario === 'return_refund' || scenario === 'intercept_return') return 'return_refund';
  if (scenario === 'exchange') return 'exchange';
  if (scenario === 'direct_replacement') return 'direct_replacement';
  return 'general';
}

export function parseStoredAftersalesWorkflowTemplateDefinition(
  value: string,
): StoredAftersalesWorkflowTemplateDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('售后流程模板版本无法读取', { cause: error });
  }
  return normalizeAftersalesWorkflowTemplateDefinition(parsed, {
    unboundStepsMarkedForReview: true,
  });
}

export function normalizeCreateAftersalesWorkflowTemplateInput(
  input: unknown,
): CreateAftersalesWorkflowTemplateInput {
  return normalizeAftersalesWorkflowTemplateDefinition(input);
}

export function normalizeUpdateAftersalesWorkflowTemplateInput(
  input: unknown,
): UpdateAftersalesWorkflowTemplateInput {
  const record = objectValue(input, '修改售后流程模板参数无效');
  rejectUnknownKeys(record, ['expectedVersion', 'name', 'scenario', 'steps']);
  if (!Number.isSafeInteger(record.expectedVersion) || Number(record.expectedVersion) < 1) {
    throw new Error('售后流程模板版本无效');
  }
  return {
    expectedVersion: Number(record.expectedVersion),
    ...normalizeAftersalesWorkflowTemplateDefinition({
      name: record.name,
      scenario: record.scenario,
      steps: record.steps,
    }),
  };
}

export function normalizeCopyAftersalesWorkflowTemplateInput(
  input: unknown,
): CopyAftersalesWorkflowTemplateInput {
  const record = objectValue(input, '复制售后流程模板参数无效');
  rejectUnknownKeys(record, ['sourceTemplateId', 'name']);
  return {
    sourceTemplateId: boundedText(record.sourceTemplateId, 200, '来源售后流程模板无效'),
    name: boundedText(record.name, 100, '请填写 1 至 100 字的售后流程名称'),
  };
}

export function isAftersalesWorkflowScenario(
  value: unknown,
): value is AftersalesWorkflowScenario {
  return typeof value === 'string' && [
    'refund_only',
    'return_refund',
    'exchange',
    'direct_replacement',
    'intercept_return',
    'lost_handling',
    'other',
  ].includes(value);
}

export function projectAftersalesWorkflowSteps(
  template: Pick<AftersalesCaseWorkflowTemplate, 'scenario' | 'steps' | 'stepEvents'>,
  aftersalesCase: AftersalesCase,
): AftersalesWorkflowStepProjection[] {
  const currentRound = currentWorkflowRound(template.scenario, aftersalesCase);
  const currentReturns = currentRound
    ? aftersalesCase.returns.filter(({ id }) => currentRound.returnRecordIds.includes(id))
    : [];
  const facts: Record<AftersalesWorkflowConditionFact, boolean> = {
    refund_requested: aftersalesCase.refund !== null,
    return_registered: currentReturns.length > 0,
    replacement_required: currentRound?.replacementRequired ?? false,
    interception_requested: aftersalesCase.coordination.interception !== null,
    logistics_exception_present: [
      ...aftersalesCase.coordination.outboundExceptionHistory,
      ...aftersalesCase.coordination.returnExceptionHistory,
    ].length > 0,
  };
  const visible = template.steps.filter((stepValue) => (
    stepValue.condition === null
    || facts[stepValue.condition.fact] === stepValue.condition.equals
  ));
  const quantities = returnQuantityFacts(currentReturns);
  const receivableQuantity = Math.max(quantities.expectedQuantity - quantities.lostQuantity, 0);
  const eventByStepId = new Map(template.stepEvents.map((event) => [event.stepId, event]));
  const resolved = visible.map((stepValue) => resolveWorkflowStepState({
    step: stepValue,
    scenario: template.scenario,
    aftersalesCase,
    currentRound,
    currentReturns,
    quantities,
    receivableQuantity,
    stepEvent: eventByStepId.get(stepValue.id) ?? null,
  }));
  // 当前待办指向第一个仍可执行的步骤：需要检查、部分完成、已跳过、不再适用或已完成的步骤都不占位。
  const actionableIndexes = resolved.flatMap((entry, index) => (
    entry.actionable ? [index] : []
  ));
  const currentIndex = actionableIndexes.find((index) => visible[index]?.required)
    ?? actionableIndexes[0]
    ?? -1;
  return resolved.map((entry, index) => ({
    ...entry.step,
    state: entry.state === 'pending'
      ? index === currentIndex ? 'current' : 'not_started'
      : entry.state,
    binding: entry.step.kind === null
      ? null
      : AFTERSALES_WORKFLOW_STEP_BINDINGS[entry.step.kind],
    progress: entry.progress,
    notApplicableReason: entry.notApplicableReason,
    stepEvent: entry.stepEvent,
  }));
}

type ResolvedWorkflowStep = {
  step: AftersalesWorkflowStep;
  state: AftersalesWorkflowStepState | 'pending';
  progress: AftersalesWorkflowStepProgress | null;
  notApplicableReason: string | null;
  stepEvent: AftersalesCaseStepEvent | null;
  actionable: boolean;
};

export type AftersalesWorkflowTemplateForOperations =
  Pick<AftersalesCaseWorkflowTemplate, 'scenario' | 'steps' | 'stepEvents' | 'timeline'>;

// 这些动作绑定在具体退货包裹或物流异常上，入口保留在对应事实区，不进入流程主按钮。
const CONTEXTUAL_WORKFLOW_ACTIONS = new Set<AftersalesWorkflowProgressActionKind>([
  'correct_return_logistics',
  'update_return_logistics_status',
  'record_return_logistics_exception',
  'progress_return_logistics_exception',
  'decide_return_logistics_exception',
  'open_carrier_claim',
  'resolve_carrier_claim',
  'confirm_carrier_compensation',
]);

// 终态售后仍可继续记录的退货与物流事实；主进程继续推进白名单复用这一清单。
export const TERMINAL_CONTINUABLE_ACTIONS = new Set<ProgressAftersalesCaseInput['kind']>([
  'record_interception_result',
  'inspect_intercepted_return',
  'receive_return',
  'inspect_return',
  'correct_return_logistics',
  'update_return_logistics_status',
  ...CONTEXTUAL_WORKFLOW_ACTIONS,
]);

export function deriveAftersalesWorkflowOperations(
  template: AftersalesWorkflowTemplateForOperations,
  aftersalesCase: AftersalesCase,
): AftersalesWorkflowOperations {
  const projection = projectAftersalesWorkflowSteps(template, aftersalesCase);
  const primary: AftersalesWorkflowOperation[] = [];
  const supplemental: AftersalesWorkflowOperation[] = [];
  const seen = new Set<AftersalesWorkflowProgressActionKind>();
  for (const step of projection) {
    if (step.kind === null || step.binding === null) continue;
    const open = step.state === 'current' || step.state === 'partial';
    // 管理型步骤按顺序开放；事实型步骤在未轮到时仍提供补录真实事实的入口。
    if (!open && !(step.state === 'not_started' && step.binding.category === 'fact')) continue;
    for (const action of step.binding.actions) {
      if (seen.has(action) || CONTEXTUAL_WORKFLOW_ACTIONS.has(action)) continue;
      seen.add(action);
      const entry: AftersalesWorkflowOperation = {
        action,
        stepId: step.id,
        blockedReason: workflowOperationBlockedReason(action, template, aftersalesCase),
      };
      (open ? primary : supplemental).push(entry);
    }
  }
  return { primary, supplemental };
}

function workflowOperationBlockedReason(
  action: AftersalesWorkflowProgressActionKind,
  template: AftersalesWorkflowTemplateForOperations,
  value: AftersalesCase,
): string | null {
  const refundFamily = action === 'confirm_refund'
    || action === 'cancel_refund_request'
    || action === 'adjust_refund_target'
    || action === 'end_refund';
  // 与主进程一致：其他处理场景只允许携带的退款事实走进度动作，其余走状态更新。
  if (template.scenario === 'other' && !(refundFamily && value.refund !== null)) {
    return '其他处理流程请使用状态更新操作';
  }
  if ((value.status === 'completed' || value.status === 'cancelled')
    && !TERMINAL_CONTINUABLE_ACTIONS.has(action)) {
    return '已经结束的售后处理单不能继续推进';
  }
  const currentRound = currentWorkflowRound(template.scenario, value);
  const currentReturns = currentRound
    ? value.returns.filter(({ id }) => currentRound.returnRecordIds.includes(id))
    : [];
  switch (action) {
    case 'register_return':
      return null;
    case 'receive_return': {
      if (currentReturns.length === 0) return '买家尚未寄回，需先登记退货物流';
      const inTransit = currentReturns.filter(({ status }) => status === 'in_transit');
      if (inTransit.length === 0) return '退货包裹均已收到';
      const disputed = inTransit.find((returnRecord) => (
        aftersalesReturnReceiptBlockReason(returnRecord) !== null
      ));
      return disputed === undefined ? null : aftersalesReturnReceiptBlockReason(disputed);
    }
    case 'inspect_return':
      return currentReturns.some(({ status }) => (
        status === 'received' || status === 'inspected'
      )) || value.coordination.interceptedReturnInspection !== null
        ? null
        : '需先确认收到退货';
    case 'inspect_intercepted_return': {
      const interception = value.coordination.interception;
      return interception?.status === 'succeeded'
        && value.coordination.sourcePackages.some((sourcePackage) => (
          sourcePackage.packageId === interception.packageId
          && sourcePackage.logisticsStatus === 'returned'
        ))
        && value.coordination.interceptedReturnInspection === null
        ? null
        : '需先申请拦截并确认包裹退回';
    }
    case 'confirm_refund': {
      const refund = value.refund;
      if (!refund) return '当前流程没有退款申请';
      if (refund.status === 'pending') return null;
      return refund.status === 'confirmed'
        ? '已完成足额退款'
        : refund.status === 'cancelled'
          ? '退款申请已取消'
          : '退款已带原因结束';
    }
    case 'adjust_refund_target': {
      const refund = value.refund;
      if (!refund) return '当前流程没有退款申请';
      return refund.status === 'pending' || refund.status === 'confirmed'
        ? null
        : '退款申请已结束';
    }
    case 'end_refund':
      return value.refund?.status === 'pending'
        && value.refund.fulfillment.kind === 'partial'
        ? null
        : '没有待补退的部分退款';
    case 'cancel_refund_request': {
      const refund = value.refund;
      if (!refund) return '当前流程没有退款申请';
      if (refund.status !== 'pending') return '没有待处理的退款申请';
      if (refund.refundRecords.length > 0) {
        return '已发生实际退款，请改用结束退款或调整退款目标金额';
      }
      return aftersalesCancelRefundRequestReason({
        carried: value.workflowTemplate.timeline.at(-1)?.kind === 'changed'
          && template.scenario !== 'refund_only'
          && template.scenario !== 'return_refund',
        confirmedDecisions: value.coordination.outboundExceptionHistory
          .filter((exception) => exception.stage === 'confirmed')
          .map(({ decision }) => decision),
      });
    }
    case 'create_replacement_shipment':
      return value.rounds.some((round) => (
        round.replacementRequired && round.replacementShipment === null
      )) || aftersalesSwitchedOriginalRoundAvailable(value)
        ? null
        : '当前没有待补发的处理轮次';
    case 'start_next_round':
      return value.rounds.some(({ replacementShipment }) => replacementShipment !== null)
        ? null
        : '没有可开启新一轮的处理轮次';
    case 'record_interception_result':
      return value.coordination.interception?.status === 'requested'
        ? null
        : '当前没有申请中的拦截';
    case 'decide_outbound_logistics_exception':
      return value.coordination.outboundExceptionHistory.some(({ stage }) => (
        stage === 'confirmed'
      )) ? null : '没有已确认的正向物流异常';
    case 'change_handling_direction':
      return value.coordination.availableDirections.some((direction) => (
        direction !== value.coordination.handlingDirection
      )) ? null : '当前没有可转换的处理方向';
    case 'complete':
      return value.status === 'ready_to_complete' ? null : '需先完成当前流程的必需步骤';
    default:
      return null;
  }
}

// 与主进程收货守卫一致的事实判断：签收争议未解决或确认丢失覆盖全部商品时不能确认收货。
export function aftersalesReturnReceiptBlockReason(
  returnRecord: AftersalesCase['returns'][number],
): string | null {
  if (returnRecord.logisticsExceptions.some((exception) => (
    (exception.exceptionType === 'delivery_dispute' || exception.exceptionType === 'misdelivered')
    && exception.stage !== 'recovered'
    && exception.stage !== 'resolved'
  ))) {
    return '退货签收存在争议，需先解决争议或确认误投';
  }
  const lostByItem = new Map<string, number>();
  for (const exception of returnRecord.logisticsExceptions) {
    if (exception.exceptionType !== 'lost' || exception.stage !== 'confirmed') continue;
    if (exception.impact.scope === 'package') {
      return '退货包裹已确认丢失，无可收商品';
    }
    for (const affected of exception.impact.items) {
      lostByItem.set(
        affected.sourceItemId,
        (lostByItem.get(affected.sourceItemId) ?? 0) + affected.quantity,
      );
    }
  }
  if (returnRecord.items.length > 0 && returnRecord.items.every((item) => (
    (lostByItem.get(item.id) ?? 0) >= item.quantity
  ))) {
    return '退货商品已全部确认丢失';
  }
  return null;
}

// 切换到换货或直接补发后，原始轮次（legacy）的既有事实就是本轮事实；
// 仅当尚无任何轮次建立补发时可直接在原始轮次上补发。
export function aftersalesSwitchedOriginalRoundAvailable(value: AftersalesCase): boolean {
  return (value.workflow === 'exchange' || value.workflow === 'direct_replacement')
    && !value.rounds.some((round) => round.replacementShipment !== null)
    && value.rounds.some((round) => (
      round.workflow === 'legacy' && round.replacementShipment === null
    ));
}

// 取消退款申请的领域规则：只有携带退款或明确选择直接补发时才允许，主进程与界面共用。
export function aftersalesCancelRefundRequestReason(input: {
  carried: boolean;
  confirmedDecisions: readonly (string | null)[];
}): string | null {
  if (!input.carried
    && (!input.confirmedDecisions.includes('replacement')
      || input.confirmedDecisions.some((decision) => (
        decision === 'refund_only' || decision === 'refund_and_replacement'
      )))) {
    return '只有明确选择直接补发时才能取消本次退款申请';
  }
  return null;
}

function resolveWorkflowStepState(input: {
  step: AftersalesWorkflowStep;
  scenario: AftersalesWorkflowScenario;
  aftersalesCase: AftersalesCase;
  currentRound: AftersalesCase['rounds'][number] | null;
  currentReturns: AftersalesCase['returns'];
  quantities: ReturnQuantityFacts;
  receivableQuantity: number;
  stepEvent: AftersalesCaseStepEvent | null;
}): ResolvedWorkflowStep {
  const { step, scenario, aftersalesCase, currentRound, currentReturns } = input;
  const { kind } = step;
  const base = { step, progress: null, notApplicableReason: null };
  if (kind === null) {
    // 需要检查的步骤不可执行：不判完成，也不成为当前待办。
    return { ...base, state: 'pending', stepEvent: null, actionable: false };
  }
  const binding = AFTERSALES_WORKFLOW_STEP_BINDINGS[kind];
  const stepEvent = binding.category === 'management' ? input.stepEvent : null;
  const completedByFacts = stepCompleted(
    kind,
    scenario,
    aftersalesCase,
    currentRound,
    currentReturns,
    input.quantities,
    input.receivableQuantity,
  )
    && step.fields.every((field) => workflowFieldSatisfied(
      field,
      kind,
      scenario,
      aftersalesCase,
      currentRound,
      currentReturns,
    ));
  if (completedByFacts) {
    return { ...base, state: 'completed', stepEvent, actionable: false };
  }
  if (stepEvent !== null) {
    return {
      ...base,
      state: stepEvent.kind === 'skipped' ? 'skipped' : 'completed',
      stepEvent,
      actionable: false,
    };
  }
  const notApplicableReason = workflowStepNotApplicableReason(
    kind,
    aftersalesCase,
    input.quantities,
    input.receivableQuantity,
  );
  if (notApplicableReason !== null) {
    return {
      ...base,
      state: 'not_applicable',
      notApplicableReason,
      stepEvent,
      actionable: false,
    };
  }
  const progress = workflowStepProgress(
    kind,
    aftersalesCase,
    currentRound,
    input.quantities,
    input.receivableQuantity,
  );
  if (progress !== null) {
    return { ...base, state: 'partial', progress, stepEvent, actionable: false };
  }
  return { ...base, state: 'pending', stepEvent, actionable: true };
}

type ReturnQuantityFacts = {
  expectedQuantity: number;
  receivedQuantity: number;
  inspectedQuantity: number;
  lostQuantity: number;
};

function returnQuantityFacts(currentReturns: AftersalesCase['returns']): ReturnQuantityFacts {
  let expectedQuantity = 0;
  let receivedQuantity = 0;
  let inspectedQuantity = 0;
  let lostQuantity = 0;
  for (const record of currentReturns) {
    let recordLostQuantity = 0;
    let wholePackageLost = false;
    for (const exception of record.logisticsExceptions) {
      if (exception.exceptionType !== 'lost' || exception.stage !== 'confirmed') continue;
      if (exception.impact.scope === 'package') {
        wholePackageLost = true;
        break;
      }
      for (const affected of exception.impact.items) recordLostQuantity += affected.quantity;
    }
    for (const item of record.items) {
      expectedQuantity += item.quantity;
      receivedQuantity += item.receivedQuantity;
      if (item.inspectionResult !== null) inspectedQuantity += item.quantity;
    }
    lostQuantity += wholePackageLost
      ? record.items.reduce((sum, item) => sum + item.quantity, 0)
      : recordLostQuantity;
  }
  return { expectedQuantity, receivedQuantity, inspectedQuantity, lostQuantity };
}

function workflowStepNotApplicableReason(
  kind: AftersalesWorkflowStepKind,
  value: AftersalesCase,
  quantities: ReturnQuantityFacts,
  receivableQuantity: number,
): string | null {
  // 售后取消后真实事实仍可能晚到（如退款取消后退货到达），事实型步骤保持未开始供补录。
  if ((kind === 'receive_return' || kind === 'inspect_return')
    && quantities.expectedQuantity > 0
    && receivableQuantity === 0) {
    return '退货包裹已确认丢失，无法收到或检查';
  }
  // 退款申请取消且没有实际退款时步骤回到未完成（规格 3.6），只有带原因结束才不再适用。
  if (kind === 'confirm_refund' && value.refund?.status === 'ended') {
    return '退款已带原因结束，未再补退';
  }
  return null;
}

function workflowStepProgress(
  kind: AftersalesWorkflowStepKind,
  value: AftersalesCase,
  currentRound: AftersalesCase['rounds'][number] | null,
  quantities: ReturnQuantityFacts,
  receivableQuantity: number,
): AftersalesWorkflowStepProgress | null {
  if (kind === 'confirm_refund'
    && value.refund?.status === 'pending'
    && value.refund.fulfillment.kind === 'partial') {
    return {
      kind: 'amount',
      refundedCents: value.refund.fulfillment.refundedAmountCents,
      targetCents: value.refund.requestedAmountCents,
    };
  }
  if (kind === 'receive_return'
    && quantities.receivedQuantity > 0
    && quantities.receivedQuantity < receivableQuantity) {
    return {
      kind: 'quantity',
      doneQuantity: quantities.receivedQuantity,
      totalQuantity: quantities.expectedQuantity,
    };
  }
  if (kind === 'inspect_return'
    && quantities.inspectedQuantity > 0
    && quantities.inspectedQuantity < quantities.receivedQuantity) {
    return {
      kind: 'quantity',
      doneQuantity: quantities.inspectedQuantity,
      totalQuantity: quantities.receivedQuantity,
    };
  }
  if (kind === 'confirm_replacement_delivery') {
    const activePackages = currentRound?.replacementShipment?.packages.filter(({ status }) => (
      status === 'active'
    )) ?? [];
    let totalQuantity = 0;
    let deliveredQuantity = 0;
    for (const shipmentPackage of activePackages) {
      const packageQuantity = shipmentPackage.items.reduce(
        (sum, item) => sum + item.quantity,
        0,
      );
      totalQuantity += packageQuantity;
      if (shipmentPackage.logisticsStatus === 'delivered') deliveredQuantity += packageQuantity;
    }
    if (deliveredQuantity > 0 && deliveredQuantity < totalQuantity) {
      return { kind: 'quantity', doneQuantity: deliveredQuantity, totalQuantity };
    }
  }
  return null;
}

function stepCompleted(
  kind: AftersalesWorkflowStepKind,
  scenario: AftersalesWorkflowScenario,
  value: AftersalesCase,
  currentRound: AftersalesCase['rounds'][number] | null,
  currentReturns: AftersalesCase['returns'],
  quantities: ReturnQuantityFacts,
  receivableQuantity: number,
): boolean {
  if (kind === 'identify_issue') return true;
  if (kind === 'choose_resolution') {
    return scenario === 'lost_handling'
      ? value.coordination.outboundExceptionHistory.some(({ stage, decision }) => (
        stage === 'confirmed' && decision !== null
      ))
      : value.coordination.handlingDirection !== null;
  }
  if (kind === 'request_interception') return value.coordination.interception !== null;
  if (kind === 'register_return') return currentReturns.length > 0;
  // 收货完成按真实数量判定：部分收到只投影部分完成，不能凭包裹状态误判完成。
  if (kind === 'receive_return') {
    return currentReturns.length > 0
      && quantities.receivedQuantity > 0
      && quantities.receivedQuantity >= receivableQuantity;
  }
  // 拦截退回商品的检查由拦截检查事实满足；寄回商品的检查要求全部退货记录都已检查。
  if (kind === 'inspect_return') {
    return value.coordination.interceptedReturnInspection !== null
      || (currentReturns.length > 0
        && currentReturns.every(({ status }) => status === 'inspected'));
  }
  if (kind === 'confirm_refund') return value.refund?.status === 'confirmed';
  if (kind === 'prepare_replacement') {
    return currentRound?.replacementShipment !== null && currentRound !== null;
  }
  if (kind === 'confirm_replacement_delivery') {
    const activePackages = currentRound?.replacementShipment?.packages.filter(({ status }) => (
      status === 'active'
    )) ?? [];
    return activePackages.length > 0 && activePackages.every(({ logisticsStatus }) => (
      logisticsStatus === 'delivered'
    ));
  }
  if (kind === 'resolve_logistics_exception') {
    const exceptions = [
      ...value.coordination.outboundExceptionHistory,
      ...value.coordination.returnExceptionHistory,
    ];
    return exceptions.length > 0 && exceptions.every(({ stage }) => (
      stage === 'confirmed' || stage === 'recovered' || stage === 'resolved'
    ));
  }
  if (kind === 'record_resolution') {
    return value.status === 'ready_to_complete'
      || value.status === 'completed'
      || value.status === 'cancelled';
  }
  return value.status === 'completed' || value.status === 'cancelled';
}

function currentWorkflowRound(
  scenario: AftersalesWorkflowScenario,
  value: AftersalesCase,
): AftersalesCase['rounds'][number] | null {
  const workflow = scenario === 'exchange'
    ? 'exchange'
    : scenario === 'direct_replacement' ? 'direct_replacement' : null;
  const workflowRounds = workflow
    ? value.rounds.filter((round) => round.workflow === workflow)
    : value.rounds;
  // 切换到换货或直接补发后还没有专属轮次时，退回全部轮次：已有事实仍应满足新版本步骤。
  const candidates = workflowRounds.length > 0 ? workflowRounds : value.rounds;
  return candidates.find((round) => (
    round.replacementRequired && !replacementRoundDelivered(round)
  )) ?? [...candidates].reverse().find(({ replacementRequired }) => (
    replacementRequired
  )) ?? candidates.at(-1) ?? null;
}

function replacementRoundDelivered(round: AftersalesCase['rounds'][number]): boolean {
  const activePackages = round.replacementShipment?.packages.filter(({ status }) => (
    status === 'active'
  )) ?? [];
  return activePackages.length > 0 && activePackages.every(({ logisticsStatus }) => (
    logisticsStatus === 'delivered'
  ));
}

function workflowFieldSatisfied(
  field: AftersalesWorkflowField,
  stepKind: AftersalesWorkflowStepKind,
  scenario: AftersalesWorkflowScenario,
  value: AftersalesCase,
  currentRound: AftersalesCase['rounds'][number] | null,
  currentReturns: AftersalesCase['returns'],
): boolean {
  if (field === 'occurred_at') return value.occurredAt.length > 0;
  if (field === 'reason') return value.reason.trim().length > 0;
  if (field === 'items') return value.items.length > 0;
  if (field === 'requested_refund_amount') return value.refund !== null;
  if (field === 'handling_direction') {
    return scenario === 'lost_handling'
      ? value.coordination.outboundExceptionHistory.some(({ stage, decision }) => (
        stage === 'confirmed' && decision !== null
      ))
      : value.coordination.handlingDirection !== null;
  }
  if (field === 'interception_package') {
    return Boolean(value.coordination.interception?.packageId);
  }
  if (field === 'shipping_carrier') {
    return currentReturns.some(({ shippingCarrier }) => shippingCarrier.trim().length > 0)
      || Boolean(currentRound?.replacementShipment?.packages.some(({ shippingCarrier }) => (
        shippingCarrier.trim().length > 0
      )))
      || value.coordination.sourcePackages.some(({ shippingCarrier }) => (
        shippingCarrier.trim().length > 0
      ));
  }
  if (field === 'tracking_number') {
    return currentReturns.some(({ trackingNumber }) => trackingNumber.trim().length > 0)
      || Boolean(currentRound?.replacementShipment?.packages.some(({ trackingNumber }) => (
        trackingNumber.trim().length > 0
      )))
      || value.coordination.sourcePackages.some(({ trackingNumber }) => (
        trackingNumber.trim().length > 0
      ));
  }
  if (field === 'received_quantity') {
    return currentReturns.some(({ items }) => items.some(({ receivedQuantity }) => (
      receivedQuantity > 0
    )));
  }
  if (field === 'inspection_result') {
    return currentReturns.some(({ items }) => items.some(({ inspectionResult }) => (
      inspectionResult !== null
    )));
  }
  if (field === 'inspection_note') {
    return currentReturns.some(({ items }) => items.some(({ inspectionNote }) => (
      inspectionNote !== null && inspectionNote.trim().length > 0
    )));
  }
  if (field === 'replacement_packages') return currentRound?.replacementShipment !== null;
  if (field === 'logistics_exception') {
    return value.coordination.outboundExceptionHistory.length > 0
      || value.coordination.returnExceptionHistory.length > 0;
  }
  if (field === 'resolution_reason') {
    if (stepKind === 'choose_resolution') {
      if (scenario === 'lost_handling') {
        return value.coordination.outboundExceptionHistory.some(({ timeline }) => (
          timeline.length > 0
        ));
      }
      return value.coordination.handlingDirectionTimeline.length > 0;
    }
    if (stepKind === 'request_interception') {
      return Boolean(value.coordination.interception?.timeline.length);
    }
    if (stepKind === 'confirm_refund') {
      return value.refund?.timeline.some(({ kind }) => kind === 'confirmed') ?? false;
    }
    if (stepKind === 'resolve_logistics_exception') {
      return [
        ...value.coordination.outboundExceptionHistory,
        ...value.coordination.returnExceptionHistory,
      ].some(({ timeline }) => timeline.length > 0);
    }
    if (stepKind === 'record_resolution') {
      return value.timeline.some(({ kind }) => kind === 'updated');
    }
    return value.status === 'ready_to_complete'
      || value.status === 'completed'
      || value.status === 'cancelled';
  }
  return false;
}

function step(
  id: string,
  kind: AftersalesWorkflowStepKind,
  name: string,
  required: boolean,
  fields: AftersalesWorkflowField[],
  stepCondition: AftersalesWorkflowStepCondition | null = null,
): AftersalesWorkflowStep {
  return { id, kind, name, required, fields, condition: stepCondition };
}

function condition(fact: AftersalesWorkflowConditionFact): AftersalesWorkflowStepCondition {
  return { fact, equals: true };
}

function normalizeAftersalesWorkflowTemplateDefinition(
  input: unknown,
  options: { unboundStepsMarkedForReview?: boolean } = {},
): StoredAftersalesWorkflowTemplateDefinition {
  const record = objectValue(input, '售后流程模板内容无效');
  rejectUnknownKeys(record, ['name', 'scenario', 'steps']);
  if (!isAftersalesWorkflowScenario(record.scenario)) {
    throw new Error('售后流程场景无效');
  }
  if (!Array.isArray(record.steps) || record.steps.length < 1 || record.steps.length > 50) {
    throw new Error('售后流程模板需要 1 至 50 个步骤');
  }
  const stepIds = new Set<string>();
  const steps = record.steps.map((value): AftersalesWorkflowStep => {
    const stepRecord = objectValue(value, '售后流程步骤无效');
    rejectUnknownKeys(stepRecord, ['id', 'kind', 'name', 'required', 'fields', 'condition']);
    const id = boundedText(stepRecord.id, 64, '售后流程步骤标识无效');
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id) || stepIds.has(id)) {
      throw new Error('售后流程步骤标识必须唯一且只包含小写字母、数字和连字符');
    }
    stepIds.add(id);
    // 存量数据里无法绑定已定义动作的步骤标记「需要检查」：仅可见、不可执行。
    const kind = isBoundAftersalesWorkflowStepKind(stepRecord.kind)
      ? stepRecord.kind
      : null;
    if (kind === null && !options.unboundStepsMarkedForReview) {
      throw new Error('售后流程步骤必须绑定已定义的业务动作');
    }
    if (typeof stepRecord.required !== 'boolean') {
      throw new Error('售后流程步骤必填状态无效');
    }
    if (!Array.isArray(stepRecord.fields)) throw new Error('售后流程步骤字段要求无效');
    const fields = stepRecord.fields.map((field) => {
      if (!(AFTERSALES_WORKFLOW_FIELDS as readonly unknown[]).includes(field)) {
        throw new Error('售后流程步骤包含不支持的字段要求');
      }
      return field as AftersalesWorkflowField;
    });
    if (new Set(fields).size !== fields.length) throw new Error('售后流程步骤字段要求不能重复');
    let stepCondition: AftersalesWorkflowStepCondition | null = null;
    if (stepRecord.condition !== null) {
      const conditionRecord = objectValue(stepRecord.condition, '售后流程步骤条件无效');
      rejectUnknownKeys(conditionRecord, ['fact', 'equals']);
      if (!(AFTERSALES_WORKFLOW_CONDITION_FACTS as readonly unknown[]).includes(
        conditionRecord.fact,
      ) || typeof conditionRecord.equals !== 'boolean') {
        throw new Error('售后流程步骤条件无效');
      }
      stepCondition = {
        fact: conditionRecord.fact as AftersalesWorkflowConditionFact,
        equals: conditionRecord.equals,
      };
    }
    return {
      id,
      kind,
      name: boundedText(stepRecord.name, 100, '请填写 1 至 100 字的售后流程步骤名称'),
      required: stepRecord.required,
      fields,
      condition: stepCondition,
    };
  });
  return {
    name: boundedText(record.name, 100, '请填写 1 至 100 字的售后流程名称'),
    scenario: record.scenario,
    steps,
  };
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error('售后流程模板不能包含循环、脚本或未定义配置');
  }
}

function boundedText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(message);
  return normalized;
}

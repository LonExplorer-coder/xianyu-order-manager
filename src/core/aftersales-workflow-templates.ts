import type { AftersalesCase, AftersalesWorkflow } from './aftersales-cases';

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
  kind: AftersalesWorkflowStepKind;
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

export type AftersalesWorkflowStepProjection = AftersalesWorkflowStep & {
  state: 'completed' | 'current' | 'upcoming';
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
        step('confirm-refund', 'confirm_refund', '按选择确认退款', false, [
          'requested_refund_amount', 'occurred_at', 'resolution_reason',
        ], condition('refund_requested')),
        step('prepare-replacement', 'prepare_replacement', '按选择建立补发', false, [
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
  return normalizeAftersalesWorkflowTemplateDefinition(parsed);
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
  template: Pick<AftersalesWorkflowTemplate, 'scenario' | 'steps'>,
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
  const completed = visible.map((stepValue) => (
    stepCompleted(stepValue.kind, aftersalesCase, currentRound, currentReturns)
    && stepValue.fields.every((field) => workflowFieldSatisfied(
      field,
      stepValue.kind,
      aftersalesCase,
      currentRound,
      currentReturns,
    ))
  ));
  const currentIndex = completed.findIndex((value, index) => (
    !value && visible[index]?.required
  ));
  const fallbackIndex = currentIndex < 0 ? completed.findIndex((value) => !value) : currentIndex;
  return visible.map((stepValue, index) => ({
    ...stepValue,
    state: completed[index]
      ? 'completed'
      : index === fallbackIndex
        ? 'current'
        : 'upcoming',
  }));
}

function stepCompleted(
  kind: AftersalesWorkflowStepKind,
  value: AftersalesCase,
  currentRound: AftersalesCase['rounds'][number] | null,
  currentReturns: AftersalesCase['returns'],
): boolean {
  if (kind === 'identify_issue') return true;
  if (kind === 'choose_resolution') return value.coordination.handlingDirection !== null;
  if (kind === 'request_interception') return value.coordination.interception !== null;
  if (kind === 'register_return') return currentReturns.length > 0;
  if (kind === 'receive_return') {
    return currentReturns.some(({ status }) => status === 'received' || status === 'inspected');
  }
  if (kind === 'inspect_return') return currentReturns.some(({ status }) => status === 'inspected');
  if (kind === 'confirm_refund') return value.refund?.status === 'confirmed';
  if (kind === 'prepare_replacement') {
    return currentRound?.replacementShipment !== null && currentRound !== null;
  }
  if (kind === 'confirm_replacement_delivery') {
    return currentRound?.replacementShipment?.packages.some(({ status, logisticsStatus }) => (
        status === 'active' && logisticsStatus === 'delivered'
      )) ?? false;
  }
  if (kind === 'resolve_logistics_exception') {
    const exceptions = [
      ...value.coordination.outboundExceptionHistory,
      ...value.coordination.returnExceptionHistory,
    ];
    return exceptions.length > 0 && exceptions.every(({ stage }) => (
      stage === 'recovered' || stage === 'resolved'
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
  const candidates = workflow
    ? value.rounds.filter((round) => round.workflow === workflow)
    : value.rounds;
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
  value: AftersalesCase,
  currentRound: AftersalesCase['rounds'][number] | null,
  currentReturns: AftersalesCase['returns'],
): boolean {
  if (field === 'occurred_at') return value.occurredAt.length > 0;
  if (field === 'reason') return value.reason.trim().length > 0;
  if (field === 'items') return value.items.length > 0;
  if (field === 'requested_refund_amount') return value.refund !== null;
  if (field === 'handling_direction') return value.coordination.handlingDirection !== null;
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
    if (!(AFTERSALES_WORKFLOW_STEP_KINDS as readonly unknown[]).includes(stepRecord.kind)) {
      throw new Error('售后流程步骤类型无效');
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
      kind: stepRecord.kind as AftersalesWorkflowStepKind,
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

import type { OrderExportPreviewSheet } from './order-export';

export type ShipmentGroupExportInput = {
  shipmentGroupIds: string[];
  orderTemplateId: string | null;
  orderItemTemplateId: string | null;
  shipmentGroupTemplateId: string | null;
  masking: 'masked' | 'original';
};

export type ShipmentGroupExportWriteResult = {
  shipmentGroupCount: number;
  orderCount: number;
  orderItemCount: number;
};

export type ShipmentGroupExportPreviewResult = ShipmentGroupExportWriteResult & {
  sheets: OrderExportPreviewSheet[];
};

export type ShipmentGroupExportResult =
  | { kind: 'cancelled' }
  | ({
      kind: 'saved';
      fileName: string;
      filePath: string;
    } & ShipmentGroupExportWriteResult);

export function normalizeShipmentGroupExportInput(value: unknown): ShipmentGroupExportInput {
  const input = strictRecord(value, '合并发货表导出请求', [
    'shipmentGroupIds',
    'orderTemplateId',
    'orderItemTemplateId',
    'shipmentGroupTemplateId',
    'masking',
  ]);
  if (!Array.isArray(input.shipmentGroupIds) || input.shipmentGroupIds.length === 0) {
    throw new Error('请至少选择一个发货组导出');
  }
  if (input.shipmentGroupIds.length > 10_000) {
    throw new Error('一次最多导出 10000 个发货组');
  }
  const shipmentGroupIds = input.shipmentGroupIds.map((entry) => {
    if (typeof entry !== 'string') throw new Error('发货组导出标识无效');
    const id = entry.trim();
    if (!id || id.length > 200) throw new Error('发货组导出标识无效');
    return id;
  });
  if (new Set(shipmentGroupIds).size !== shipmentGroupIds.length) {
    throw new Error('发货组导出记录不能重复');
  }
  if (input.masking !== 'masked' && input.masking !== 'original') {
    throw new Error('合并发货表导出脱敏方式无效');
  }
  return {
    shipmentGroupIds,
    orderTemplateId: optionalTemplateId(input.orderTemplateId, '订单总表模板'),
    orderItemTemplateId: optionalTemplateId(input.orderItemTemplateId, '订单商品明细表模板'),
    shipmentGroupTemplateId: optionalTemplateId(
      input.shipmentGroupTemplateId,
      '合并发货表模板',
    ),
    masking: input.masking,
  };
}

function optionalTemplateId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} ID 格式无效`);
  const id = value.trim();
  if (!id || id.length > 200) throw new Error(`${label} ID 格式无效`);
  return id;
}

function strictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw new Error(`${label}包含未知属性：${unknownKey}`);
  return record;
}

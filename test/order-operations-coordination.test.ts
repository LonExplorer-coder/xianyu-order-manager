import { describe, expect, it } from 'vitest';

import {
  coordinateOrderOperations,
  type OrderOperationsTodoCandidate,
} from '../src/core/order-operations-projection';
import { OrderOperationsProjectionService } from '../src/main/order-operations-projection-service';

describe('订单运营投影协调', () => {
  it('按期限、资金、实物失控和普通跟进选出唯一主待办并保留其余待办', () => {
    const candidates: OrderOperationsTodoCandidate[] = [{
      id: 'follow-shipment',
      priority: 'follow_up',
      title: '跟进运输进度',
      detail: '正向包裹仍在运输中',
      occurredAt: '2026-08-14T09:00:00+08:00',
      target: { kind: 'shipment_record', shipmentRecordId: 'shipment-1' },
    }, {
      id: 'physical-return',
      priority: 'physical_risk',
      title: '处理退货签收争议',
      detail: '退货显示签收但尚未确认实际收到',
      occurredAt: '2026-08-14T09:10:00+08:00',
      target: {
        kind: 'aftersales_case',
        shipmentRecordId: 'shipment-1',
        aftersalesCaseId: 'case-1',
      },
    }, {
      id: 'financial-refund',
      priority: 'financial_risk',
      title: '确认实际退款',
      detail: '退款申请尚未形成实际退款',
      occurredAt: '2026-08-14T09:20:00+08:00',
      target: {
        kind: 'aftersales_case',
        shipmentRecordId: 'shipment-1',
        aftersalesCaseId: 'case-1',
      },
    }, {
      id: 'deadline-response',
      priority: 'deadline',
      title: '今天前回应售后申请',
      detail: '明确期限优先于其他风险',
      dueAt: '2026-08-14T18:00:00+08:00',
      occurredAt: '2026-08-14T08:00:00+08:00',
      target: {
        kind: 'aftersales_case',
        shipmentRecordId: 'shipment-1',
        aftersalesCaseId: 'case-1',
      },
    }];

    expect(coordinateOrderOperations(candidates)).toEqual({
      primaryTodo: expect.objectContaining({
        id: 'deadline-response',
        title: '今天前回应售后申请',
      }),
      secondaryTodoCount: 3,
      todos: [
        expect.objectContaining({ id: 'deadline-response' }),
        expect.objectContaining({ id: 'financial-refund' }),
        expect.objectContaining({ id: 'physical-return' }),
        expect.objectContaining({ id: 'follow-shipment' }),
      ],
    });
  });

  it('同级待办优先显示最新有效事实且不会因重复来源显示两次', () => {
    const duplicate = {
      id: 'return-exception-1',
      priority: 'physical_risk' as const,
      title: '处理退货物流异常',
      detail: '商品 A × 1',
      occurredAt: '2026-08-14T10:00:00+08:00',
      target: {
        kind: 'aftersales_case' as const,
        shipmentRecordId: 'shipment-1',
        aftersalesCaseId: 'case-1',
      },
    };

    const result = coordinateOrderOperations([{ ...duplicate }, {
      ...duplicate,
      title: '处理退货物流异常（刷新后的说明）',
      occurredAt: '2026-08-14T10:05:00+08:00',
    }, {
      id: 'return-exception-2',
      priority: 'physical_risk',
      title: '核对另一件退货',
      detail: '商品 B × 1',
      occurredAt: '2026-08-14T10:03:00+08:00',
      target: duplicate.target,
    }]);

    expect(result.todos).toEqual([
      expect.objectContaining({
        id: 'return-exception-1',
        title: '处理退货物流异常（刷新后的说明）',
      }),
      expect.objectContaining({ id: 'return-exception-2' }),
    ]);
    expect(result.secondaryTodoCount).toBe(1);
  });

  it('同一事实与时间由后续领域投影覆盖早期通用摘要', () => {
    const target = { kind: 'shipment_record' as const, shipmentRecordId: 'shipment-1' };
    const result = coordinateOrderOperations([{
      id: 'logistics-exception:exception-1',
      priority: 'physical_risk',
      title: '处理正向物流异常',
      detail: '通用包裹摘要',
      occurredAt: '2026-08-14T10:00:00+08:00',
      target,
    }, {
      id: 'logistics-exception:exception-1',
      priority: 'physical_risk',
      title: '选择正向异常处理',
      detail: '已关联售后处理单',
      occurredAt: '2026-08-14T10:00:00+08:00',
      target: {
        kind: 'aftersales_case',
        shipmentRecordId: 'shipment-1',
        aftersalesCaseId: 'case-1',
      },
    }]);

    expect(result.todos).toEqual([
      expect.objectContaining({ title: '选择正向异常处理' }),
    ]);
  });

  it('空状态明确表示当前无需处理', () => {
    expect(coordinateOrderOperations([])).toEqual({
      primaryTodo: null,
      secondaryTodoCount: 0,
      todos: [],
    });
  });

  it('订单列表概况不装载单调增长的完整历史，详情查询仍保留历史', () => {
    const statements: string[] = [];
    const database = {
      prepare(sql: string) {
        statements.push(sql);
        return { all: () => [] };
      },
    };
    const service = new OrderOperationsProjectionService(database as never);

    service.getOverviewMany(['order-1']);
    expect(statements.some((sql) => sql.includes('shipment_package_logistics_status_events AS events')))
      .toBe(false);

    statements.length = 0;
    service.get('order-1');
    expect(statements.some((sql) => sql.includes('shipment_package_logistics_status_events AS events')))
      .toBe(true);
  });
});

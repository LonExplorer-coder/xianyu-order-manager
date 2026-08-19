import { useEffect, useState, type FormEvent } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import {
  inventoryMovementDirectionLabel,
  inventoryMovementSourceLabel,
  inventoryStateLabel,
  type InventoryStateName,
  type InventoryView,
} from '../core/inventory-ledger';
import { DialogShell, EmptyState, InlineError, ReasonField } from './DialogShell';

type AdjustmentFormState = {
  standardProductId: string;
  direction: 'in' | 'out';
  state: InventoryStateName;
  quantity: string;
  reason: string;
};

type InspectionFormState = {
  standardProductId: string;
  sellableQuantity: string;
  defectiveQuantity: string;
  scrappedQuantity: string;
  reason: string;
};

const EMPTY_ADJUSTMENT: AdjustmentFormState = {
  standardProductId: '',
  direction: 'in',
  state: 'sellable',
  quantity: '1',
  reason: '',
};

const EMPTY_INSPECTION: InspectionFormState = {
  standardProductId: '',
  sellableQuantity: '',
  defectiveQuantity: '',
  scrappedQuantity: '',
  reason: '',
};

const INVENTORY_STATES: InventoryStateName[] = [
  'sellable',
  'awaiting_inspection',
  'defective',
  'scrapped',
];

export function InventoryWorkspace({ api }: { api: DesktopApi }) {
  const [view, setView] = useState<InventoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [inspectionOpen, setInspectionOpen] = useState(false);
  const [adjustment, setAdjustment] = useState<AdjustmentFormState>(EMPTY_ADJUSTMENT);
  const [inspection, setInspection] = useState<InspectionFormState>(EMPTY_INSPECTION);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.queryInventory()
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (loading) {
    return (
      <section className="inventory-workspace workspace-enter" aria-label="库存">
        <header className="workspace-header">
          <div>
            <span className="section-kicker">库存·四态与流水</span>
            <h1>库存</h1>
          </div>
        </header>
        <EmptyState title="正在读取库存…" status />
      </section>
    );
  }

  if (error) {
    return (
      <section className="inventory-workspace workspace-enter" aria-label="库存">
        <header className="workspace-header">
          <div>
            <span className="section-kicker">库存·四态与流水</span>
            <h1>库存</h1>
          </div>
        </header>
        <InlineError message={error} />
      </section>
    );
  }

  const products = view?.products ?? [];
  const unmapped = view?.unmappedPendingShipment ?? [];
  const movements = view?.movements ?? [];

  const openAdjustment = (standardProductId: string) => {
    setAdjustment({ ...EMPTY_ADJUSTMENT, standardProductId });
    setFormError('');
    setAdjustmentOpen(true);
  };

  const openInspection = (standardProductId: string) => {
    setInspection({ ...EMPTY_INSPECTION, standardProductId });
    setFormError('');
    setInspectionOpen(true);
  };

  const submitAdjustment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const next = await api.recordInventoryAdjustment({
        standardProductId: adjustment.standardProductId,
        quantity: Number(adjustment.quantity),
        direction: adjustment.direction,
        state: adjustment.state,
        reason: adjustment.reason,
      });
      setView(next);
      setAdjustmentOpen(false);
    } catch (cause: unknown) {
      setFormError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const submitInspection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const next = await api.recordInventoryInspection({
        standardProductId: inspection.standardProductId,
        sellableQuantity: Number(inspection.sellableQuantity || 0),
        defectiveQuantity: Number(inspection.defectiveQuantity || 0),
        scrappedQuantity: Number(inspection.scrappedQuantity || 0),
        reason: inspection.reason,
      });
      setView(next);
      setInspectionOpen(false);
    } catch (cause: unknown) {
      setFormError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="inventory-workspace workspace-enter" aria-label="库存">
      <header className="workspace-header">
        <div>
          <span className="section-kicker">库存·四态与流水</span>
          <h1>库存</h1>
          <p className="workspace-subtitle">
            四类真实库存（可销售、待检查、瑕疵品、报废）来自不可变流水；
            已预留与采购在途是参考数，分别来自待发货订单与已确认采购建议。
          </p>
        </div>
        <div className="toolbar">
          <button
            className="button button--quiet"
            type="button"
            onClick={() => openAdjustment('')}
          >
            人工调整 / 期初入库
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => openInspection('')}
          >
            登记检查结果
          </button>
        </div>
      </header>

      {unmapped.length > 0 && (
        <div className="inline-error" role="alert">
          <span>
            有 {unmapped.length} 组未映射商品还在待发货订单里，发出前请先在订单校对中完成商品映射，
            否则这些明细不会记库存。
          </span>
        </div>
      )}
      {unmapped.length > 0 && (
        <div className="table-frame">
          <table aria-label="未映射待发货明细">
            <thead>
              <tr>
                <th>原始标题</th>
                <th>原始规格</th>
                <th>待发货数量</th>
                <th>涉及订单</th>
              </tr>
            </thead>
            <tbody>
              {unmapped.map((item) => (
                <tr key={`${item.sourceTitle}\u0000${item.sourceSpec}`}>
                  <td>{item.sourceTitle}</td>
                  <td>{item.sourceSpec}</td>
                  <td>{item.quantity}</td>
                  <td>{item.orderCount} 单</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {products.length === 0 ? (
        <EmptyState
          title="还没有标准商品"
          hint="库存按标准商品记账，先到「标准商品」建立商品档案。"
        />
      ) : (
        <div className="table-frame">
          <table aria-label="库存四态与参考数">
            <thead>
              <tr>
                <th rowSpan={2}>商品</th>
                <th rowSpan={2}>SKU</th>
                <th colSpan={4}>真实库存</th>
                <th colSpan={2}>参考数</th>
                <th rowSpan={2}>操作</th>
              </tr>
              <tr>
                <th>可销售</th>
                <th>待检查</th>
                <th>瑕疵品</th>
                <th>报废</th>
                <th>已预留</th>
                <th>采购在途</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.standardProductId}>
                  <td>{product.name}（{product.specification}）</td>
                  <td>{product.sku}</td>
                  <td><strong>{product.sellableQuantity}</strong></td>
                  <td>{product.awaitingInspectionQuantity}</td>
                  <td>{product.defectiveQuantity}</td>
                  <td>{product.scrappedQuantity}</td>
                  <td>{product.reservedQuantity}</td>
                  <td>{product.purchaseInTransitQuantity}</td>
                  <td>
                    <button
                      className="button button--quiet"
                      type="button"
                      onClick={() => openAdjustment(product.standardProductId)}
                    >
                      调整
                    </button>
                    {' '}
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={product.awaitingInspectionQuantity === 0}
                      onClick={() => openInspection(product.standardProductId)}
                    >
                      检查
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>库存流水</h2>
      {movements.length === 0 ? (
        <EmptyState
          title="还没有库存流水"
          hint="从「人工调整 / 期初入库」录入现有存货开始。"
        />
      ) : (
        <div className="table-frame">
          <table aria-label="库存流水">
            <thead>
              <tr>
                <th>时间</th>
                <th>商品</th>
                <th>变化</th>
                <th>来源</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{formatDateTime(movement.occurredAt)}</td>
                  <td>{movement.name}（{movement.specification}）</td>
                  <td>
                    {inventoryMovementDirectionLabel(movement.direction)}
                    {movement.quantity} 件 · {inventoryStateLabel(movement.state)}
                  </td>
                  <td>{inventoryMovementSourceLabel(movement.sourceType)}</td>
                  <td>{movement.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adjustmentOpen && (
        <DialogShell
          kicker="库存·人工调整"
          title={adjustment.direction === 'in' ? '入库调整' : '出库调整'}
          description="期初入库用入库 + 可销售；每一笔都会永久记录在库存流水中。"
          busy={saving}
          onClose={() => setAdjustmentOpen(false)}
          onSubmit={submitAdjustment}
        >
          <label>
            <span>标准商品</span>
            <select
              aria-label="标准商品"
              value={adjustment.standardProductId}
              disabled={saving}
              onChange={(event) => setAdjustment({
                ...adjustment,
                standardProductId: event.target.value,
              })}
            >
              <option value="">请选择商品</option>
              {products.map((product) => (
                <option key={product.standardProductId} value={product.standardProductId}>
                  {product.name}（{product.specification}）· {product.sku}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>方向</span>
            <select
              aria-label="方向"
              value={adjustment.direction}
              disabled={saving}
              onChange={(event) => setAdjustment({
                ...adjustment,
                direction: event.target.value === 'out' ? 'out' : 'in',
              })}
            >
              <option value="in">入库（增加）</option>
              <option value="out">出库（减少）</option>
            </select>
          </label>
          <label>
            <span>库存状态</span>
            <select
              aria-label="库存状态"
              value={adjustment.state}
              disabled={saving}
              onChange={(event) => setAdjustment({
                ...adjustment,
                state: event.target.value as InventoryStateName,
              })}
            >
              {INVENTORY_STATES.map((state) => (
                <option key={state} value={state}>{inventoryStateLabel(state)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>数量</span>
            <input
              aria-label="数量"
              type="number"
              min={1}
              step={1}
              value={adjustment.quantity}
              disabled={saving}
              onChange={(event) => setAdjustment({
                ...adjustment,
                quantity: event.target.value,
              })}
            />
          </label>
          <ReasonField
            label="原因（必填）"
            value={adjustment.reason}
            saving={saving}
            onChange={(value) => setAdjustment({ ...adjustment, reason: value })}
          />
          <InlineError message={formError} />
          <footer>
            <button
              className="button button--quiet"
              type="button"
              disabled={saving}
              onClick={() => setAdjustmentOpen(false)}
            >
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '保存调整'}
            </button>
          </footer>
        </DialogShell>
      )}

      {inspectionOpen && (
        <DialogShell
          kicker="库存·检查结果"
          title="登记检查结果"
          description="把待检查库存按检查结论分流；检查本身也会记录为一条出库和对应入库流水。"
          busy={saving}
          onClose={() => setInspectionOpen(false)}
          onSubmit={submitInspection}
        >
          <label>
            <span>标准商品</span>
            <select
              aria-label="标准商品"
              value={inspection.standardProductId}
              disabled={saving}
              onChange={(event) => setInspection({
                ...inspection,
                standardProductId: event.target.value,
              })}
            >
              <option value="">请选择商品</option>
              {products.map((product) => (
                <option key={product.standardProductId} value={product.standardProductId}>
                  {product.name}（{product.specification}）· 待检查 {product.awaitingInspectionQuantity} 件
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>合格入库（件）</span>
            <input
              aria-label="合格入库（件）"
              type="number"
              min={0}
              step={1}
              value={inspection.sellableQuantity}
              disabled={saving}
              onChange={(event) => setInspection({
                ...inspection,
                sellableQuantity: event.target.value,
              })}
            />
          </label>
          <label>
            <span>存在瑕疵（件）</span>
            <input
              aria-label="存在瑕疵（件）"
              type="number"
              min={0}
              step={1}
              value={inspection.defectiveQuantity}
              disabled={saving}
              onChange={(event) => setInspection({
                ...inspection,
                defectiveQuantity: event.target.value,
              })}
            />
          </label>
          <label>
            <span>确认报废（件）</span>
            <input
              aria-label="确认报废（件）"
              type="number"
              min={0}
              step={1}
              value={inspection.scrappedQuantity}
              disabled={saving}
              onChange={(event) => setInspection({
                ...inspection,
                scrappedQuantity: event.target.value,
              })}
            />
          </label>
          <ReasonField
            label="检查说明（必填）"
            value={inspection.reason}
            saving={saving}
            onChange={(value) => setInspection({ ...inspection, reason: value })}
          />
          <InlineError message={formError} />
          <footer>
            <button
              className="button button--quiet"
              type="button"
              disabled={saving}
              onClick={() => setInspectionOpen(false)}
            >
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '保存检查结果'}
            </button>
          </footer>
        </DialogShell>
      )}
    </section>
  );
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

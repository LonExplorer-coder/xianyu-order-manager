import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import {
  inventoryStateLabel,
  type InventoryProductView,
  type InventoryStateName,
} from '../core/inventory-ledger';
import {
  purchaseOrderEventLabel,
  purchaseOrderStatusLabel,
  type CreatePurchaseOrderInput,
  type PurchaseOrderView,
  type PurchaseView,
  type RecordPurchaseArrivalInput,
  type RecordSupplierReturnInput,
} from '../core/purchase-orders';
import { DialogShell, EmptyState, InlineError, ReasonField } from './DialogShell';
import {
  FinanceFactsSummary,
  FinanceRecordDialog,
  financeFactsNetCents,
  type FinanceRecordDialogPreset,
} from './FinanceFacts';
import type { FinanceFactsForSource } from '../core/funds';

type OrderLineDraft = {
  standardProductId: string;
  quantity: string;
  unitPriceYuan: string;
};

type ArrivalLineDraft = {
  orderItemId: string;
  label: string;
  remaining: number;
  received: string;
  resellable: string;
  defective: string;
  scrapped: string;
};

type ReturnLineDraft = {
  standardProductId: string;
  quantity: string;
  state: InventoryStateName;
};

type OrderDialogKind =
  | { kind: 'create' }
  | { kind: 'confirm'; order: PurchaseOrderView }
  | { kind: 'cancel'; order: PurchaseOrderView }
  | { kind: 'expected-date'; order: PurchaseOrderView }
  | { kind: 'quantity'; order: PurchaseOrderView; itemId: string }
  | { kind: 'arrival'; order: PurchaseOrderView }
  | { kind: 'supplier-create' }
  | { kind: 'supplier-return' };

function formatMoney(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value: string): number {
  if (!value.trim()) return 0;
  if (!/^\d+$/.test(value.trim())) return -1;
  return Number.parseInt(value.trim(), 10);
}

function parsePriceYuan(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number.parseFloat(value.trim()) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function PurchaseWorkspace({ api }: { api: DesktopApi }) {
  const [view, setView] = useState<PurchaseView | null>(null);
  const [products, setProducts] = useState<InventoryProductView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<OrderDialogKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [supplierName, setSupplierName] = useState('');
  const [supplierContact, setSupplierContact] = useState('');
  const [supplierNote, setSupplierNote] = useState('');
  const [orderSupplierId, setOrderSupplierId] = useState('');
  const [orderExpectedAt, setOrderExpectedAt] = useState('');
  const [orderLines, setOrderLines] = useState<OrderLineDraft[]>([
    { standardProductId: '', quantity: '', unitPriceYuan: '' },
  ]);
  const [reason, setReason] = useState('');
  const [newQuantity, setNewQuantity] = useState('');
  const [newExpectedAt, setNewExpectedAt] = useState('');
  const [arrivalLines, setArrivalLines] = useState<ArrivalLineDraft[]>([]);
  const [returnSupplierId, setReturnSupplierId] = useState('');
  const [returnOrderId, setReturnOrderId] = useState('');
  const [returnLines, setReturnLines] = useState<ReturnLineDraft[]>([
    { standardProductId: '', quantity: '', state: 'defective' },
  ]);
  const [fundsByOrder, setFundsByOrder] = useState<Record<
    string,
    { facts: FinanceFactsForSource | null; state: 'loading' | 'ready' | 'error' }
  >>({});
  const [recordFundsTarget, setRecordFundsTarget] = useState<{
    preset: FinanceRecordDialogPreset;
    reloadOrderIds: readonly string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.queryPurchases(), api.queryInventory()])
      .then(([purchaseView, inventoryView]) => {
        if (cancelled) return;
        setView(purchaseView);
        setProducts(inventoryView.products);
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
    return shell(<EmptyState title="正在读取采购数据…" status />);
  }
  if (error) {
    return shell(<InlineError message={error} />);
  }

  const inventoryProducts = products;
  const suppliers = view?.suppliers ?? [];
  const orders = view?.orders ?? [];
  const supplierReturns = view?.supplierReturns ?? [];

  // 采购的资金影响按订单懒加载：付款挂采购订单、供应方退款挂退货记录，展示时合并。
  function loadFundsForOrder(orderId: string, force = false): void {
    if (!force && fundsByOrder[orderId]) return;
    setFundsByOrder((previous) => ({
      ...previous,
      [orderId]: { facts: null, state: 'loading' },
    }));
    const relatedReturns = supplierReturns.filter((record) => (
      record.purchaseOrderId === orderId
    ));
    Promise.all([
      api.queryFinanceFactsForSource('purchase_order', orderId),
      ...relatedReturns.map((record) => (
        api.queryFinanceFactsForSource('supplier_return', record.id)
      )),
    ])
      .then((parts) => {
        setFundsByOrder((previous) => ({
          ...previous,
          [orderId]: {
            facts: {
              pendingItems: parts.flatMap((part) => part.pendingItems),
              records: parts.flatMap((part) => part.records),
            },
            state: 'ready',
          },
        }));
      })
      .catch(() => {
        setFundsByOrder((previous) => ({
          ...previous,
          [orderId]: { facts: null, state: 'error' },
        }));
      });
  }

  function reloadFundsForOrders(orderIds: readonly string[]): void {
    setFundsByOrder((previous) => {
      const next = { ...previous };
      for (const orderId of orderIds) delete next[orderId];
      return next;
    });
    for (const orderId of orderIds) loadFundsForOrder(orderId, true);
  }

  const openDialog = (next: OrderDialogKind) => {
    setFormError('');
    setReason('');
    setDialog(next);
    if (next.kind === 'supplier-create') {
      setSupplierName('');
      setSupplierContact('');
      setSupplierNote('');
    }
    if (next.kind === 'create') {
      setOrderSupplierId(suppliers[0]?.supplierId ?? '');
      setOrderExpectedAt('');
      setOrderLines([{ standardProductId: '', quantity: '', unitPriceYuan: '' }]);
    }
    if (next.kind === 'quantity') {
      const line = next.order.items.find((item) => item.id === next.itemId);
      setNewQuantity(line ? String(line.quantity) : '');
    }
    if (next.kind === 'expected-date') {
      setNewExpectedAt('');
    }
    if (next.kind === 'arrival') {
      setArrivalLines(next.order.items.map((item) => ({
        orderItemId: item.id,
        label: `${item.name}（${item.specification}）`,
        remaining: item.quantity - item.receivedQuantity,
        received: '',
        resellable: '',
        defective: '',
        scrapped: '',
      })));
    }
    if (next.kind === 'supplier-return') {
      setReturnSupplierId(suppliers[0]?.supplierId ?? '');
      setReturnOrderId('');
      setReturnLines([{ standardProductId: '', quantity: '', state: 'defective' }]);
    }
  };

  const closeDialog = () => {
    if (saving) return;
    setDialog(null);
  };

  const submit = (action: () => Promise<PurchaseView>) => {
    setSaving(true);
    setFormError('');
    action()
      .then((result) => {
        setView(result);
        setDialog(null);
      })
      .catch((cause: unknown) => setFormError(errorMessage(cause)))
      .finally(() => setSaving(false));
  };

  const submitSupplierCreate = (event: FormEvent) => {
    event.preventDefault();
    submit(() => api.createSupplier({
      name: supplierName.trim(),
      contact: supplierContact.trim() || null,
      note: supplierNote.trim() || null,
    }));
  };

  const submitOrderCreate = (event: FormEvent) => {
    event.preventDefault();
    const items: CreatePurchaseOrderInput['items'] = [];
    for (const line of orderLines) {
      const quantity = parsePositiveInt(line.quantity);
      const unitPriceCents = parsePriceYuan(line.unitPriceYuan);
      if (!line.standardProductId || quantity === null || unitPriceCents === null) {
        setFormError('请完整填写每个商品行的商品、数量（大于零）和单价（元，最多两位小数）');
        return;
      }
      items.push({ standardProductId: line.standardProductId, quantity, unitPriceCents });
    }
    if (!orderExpectedAt) {
      setFormError('请填写交期');
      return;
    }
    submit(() => api.createPurchaseOrder({
      supplierId: orderSupplierId,
      expectedAt: new Date(orderExpectedAt).toISOString(),
      reason: reason.trim(),
      items,
    }));
  };

  const submitArrival = (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.kind !== 'arrival') return;
    const items: RecordPurchaseArrivalInput['items'] = [];
    for (const line of arrivalLines) {
      const received = parsePositiveInt(line.received);
      if (!line.received.trim()) continue;
      if (received === null) {
        setFormError(`「${line.label}」到货数量需为大于零的整数`);
        return;
      }
      const resellable = parseNonNegativeInt(line.resellable);
      const defective = parseNonNegativeInt(line.defective);
      const scrapped = parseNonNegativeInt(line.scrapped);
      if (resellable < 0 || defective < 0 || scrapped < 0) {
        setFormError(`「${line.label}」检查数量需为非负整数`);
        return;
      }
      if (resellable + defective + scrapped > received) {
        setFormError(`「${line.label}」检查分类数量不能超过到货数量`);
        return;
      }
      items.push({
        orderItemId: line.orderItemId,
        receivedQuantity: received,
        resellableQuantity: resellable,
        defectiveQuantity: defective,
        scrappedQuantity: scrapped,
      });
    }
    if (items.length === 0) {
      setFormError('请至少为一个商品行填写到货数量');
      return;
    }
    submit(() => api.recordPurchaseArrival({
      orderId: dialog.order.id,
      occurredAt: new Date().toISOString(),
      reason: reason.trim(),
      items,
    }));
  };

  const submitSupplierReturn = (event: FormEvent) => {
    event.preventDefault();
    const items: RecordSupplierReturnInput['items'] = [];
    for (const line of returnLines) {
      const quantity = parsePositiveInt(line.quantity);
      if (!line.standardProductId || quantity === null) {
        setFormError('请完整填写每个退货行的商品、数量（大于零）和库存状态');
        return;
      }
      items.push({
        standardProductId: line.standardProductId,
        quantity,
        state: line.state,
      });
    }
    submit(() => api.recordSupplierReturn({
      supplierId: returnSupplierId,
      purchaseOrderId: returnOrderId || null,
      reason: reason.trim(),
      occurredAt: new Date().toISOString(),
      items,
    }));
  };

  return shell(
    <>
      <div className="toolbar purchase-toolbar">
        <button
          className="button button--quiet"
          type="button"
          onClick={() => openDialog({ kind: 'supplier-create' })}
        >
          登记供应方
        </button>
        <button
          className="button button--quiet"
          type="button"
          disabled={suppliers.length === 0}
          onClick={() => openDialog({ kind: 'create' })}
        >
          新建采购订单
        </button>
        <button
          className="button button--quiet"
          type="button"
          disabled={suppliers.length === 0}
          onClick={() => openDialog({ kind: 'supplier-return' })}
        >
          登记供应方退货
        </button>
      </div>

      {suppliers.length === 0 ? (
        <EmptyState
          title="还没有供应方"
          hint="先登记供应方，再创建采购订单。采购建议不会自动变成采购订单，需要在这里人工下单。"
        />
      ) : (
        <>
          <h2>供应方</h2>
          <div className="table-frame">
            <table aria-label="供应方清单">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>联系方式</th>
                  <th>备注</th>
                  <th>登记时间</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((supplier) => (
                  <tr key={supplier.supplierId}>
                    <td>{supplier.name}</td>
                    <td>{supplier.contact ?? '—'}</td>
                    <td>{supplier.note ?? '—'}</td>
                    <td>{formatTime(supplier.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>采购订单</h2>
          {orders.length === 0 ? (
            <EmptyState
              title="还没有采购订单"
              hint="确认后的订单数量形成采购在途，到货检查后才进入库存。"
            />
          ) : (
          <div className="table-frame">
              {orders.map((order) => (
                <article key={order.id} className="aftersales-workflow-card">
                  <header>
                    <strong>第 {order.sequence} 号</strong>
                    <span>{order.supplierName}</span>
                    <span className="status-chip">
                      {purchaseOrderStatusLabel(order.status)}
                    </span>
                    {order.planName && (
                      <span>计划：{order.planName}</span>
                    )}
                    <span>交期 {formatTime(order.expectedAt)}</span>
                    {order.payable && (
                      <span>待确认应付 {formatMoney(order.payable.amountCents)}</span>
                    )}
                  </header>
                  <table aria-label={`第 ${order.sequence} 号采购订单商品`}>
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>SKU</th>
                        <th>采购数量</th>
                        <th>已到货</th>
                        <th>退供应方</th>
                        <th>单价</th>
                        {order.status !== 'cancelled' && <th>操作</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {order.items.map((item) => (
                        <tr key={item.id}>
                          <td>{item.name}（{item.specification}）</td>
                          <td>{item.sku}</td>
                          <td><strong>{item.quantity}</strong></td>
                          <td>{item.receivedQuantity}</td>
                          <td>{item.supplierReturnedQuantity}</td>
                          <td>{formatMoney(item.unitPriceCents)}</td>
                          {order.status !== 'cancelled' && (
                            <td>
                              <button
                                type="button"
                                onClick={() => openDialog({
                                  kind: 'quantity',
                                  order,
                                  itemId: item.id,
                                })}
                              >
                                变更数量
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <footer>
                    {order.status === 'draft' && (
                      <>
                        <button type="button" className="primary" onClick={() => openDialog({ kind: 'confirm', order })}>
                          确认订单
                        </button>
                        <button type="button" onClick={() => openDialog({ kind: 'cancel', order })}>
                          取消订单
                        </button>
                      </>
                    )}
                    {order.status === 'confirmed' && (
                      <>
                        <button type="button" className="primary" onClick={() => openDialog({ kind: 'arrival', order })}>
                          登记到货
                        </button>
                        <button type="button" onClick={() => openDialog({ kind: 'expected-date', order })}>
                          变更交期
                        </button>
                        <button type="button" onClick={() => openDialog({ kind: 'cancel', order })}>
                          取消订单
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setRecordFundsTarget({
                        preset: {
                          sourceType: 'purchase_order',
                          sourceId: order.id,
                          sourceLabel: `第 ${order.sequence} 号采购订单 · ${order.supplierName}`,
                          defaultType: 'purchase_cost',
                        },
                        reloadOrderIds: [order.id],
                      })}
                    >
                      登记付款 / 退款
                    </button>
                    {order.status === 'cancelled' && order.cancelReason && (
                      <span>取消原因：{order.cancelReason}</span>
                    )}
                  </footer>
                  <details>
                    <summary>确认与到货历史</summary>
                    <ul>
                      {order.events.map((event) => (
                        <li key={event.sequence}>
                          {formatTime(event.occurredAt)} · {purchaseOrderEventLabel(event.eventType)}
                          {event.quantity !== null && ` · 数量 ${event.quantity}`}
                          {' · '}{event.reason}
                        </li>
                      ))}
                      {order.arrivals.map((arrival) => (
                        <li key={arrival.id}>
                          {formatTime(arrival.occurredAt)} · 到货{' · '}{arrival.reason}
                          {arrival.items.map((item) => (
                            <span key={item.id}>
                              {' · '}{item.name}（{item.specification}）实收 {item.receivedQuantity}
                              {item.receivedQuantity - item.resellableQuantity
                                - item.defectiveQuantity - item.scrappedQuantity > 0
                                && `，待检查 ${
                                  item.receivedQuantity - item.resellableQuantity
                                  - item.defectiveQuantity - item.scrappedQuantity
                                }`}
                              {item.resellableQuantity > 0 && `，合格 ${item.resellableQuantity}`}
                              {item.defectiveQuantity > 0 && `，瑕疵 ${item.defectiveQuantity}`}
                              {item.scrappedQuantity > 0 && `，报废 ${item.scrappedQuantity}`}
                            </span>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </details>
                  <details
                    onToggle={(event) => {
                      if ((event.target as HTMLDetailsElement).open) {
                        loadFundsForOrder(order.id);
                      }
                    }}
                  >
                    <summary>资金（付款与退款）</summary>
                    {(() => {
                      const funds = fundsByOrder[order.id];
                      if (!funds || funds.state === 'loading') {
                        return <small>正在读取资金记录…</small>;
                      }
                      if (funds.state === 'error') {
                        return <small>资金记录读取失败，请收起后重新展开</small>;
                      }
                      return (
                        <>
                          <p className="workspace-subtitle">
                            {order.payable
                              ? `待确认应付 ${formatMoney(order.payable.amountCents)}`
                              : '无待确认应付'}
                            {funds.facts && funds.facts.records.length > 0
                              ? ` · 采购净支出 ${formatMoney(-financeFactsNetCents(funds.facts))}`
                              : ''}
                          </p>
                          <FinanceFactsSummary facts={funds.facts} />
                        </>
                      );
                    })()}
                  </details>
                </article>
              ))}
          </div>
          )}

          <h2>供应方退货</h2>
          {supplierReturns.length === 0 ? (
            <EmptyState title="还没有供应方退货" hint="到货检查出的瑕疵品可以退回供应方，退货保留独立记录并从对应库存状态出库。" />
          ) : (
          <div className="table-frame">
              <table aria-label="供应方退货记录">
                <thead>
                  <tr>
                    <th>供应方</th>
                    <th>关联订单</th>
                    <th>商品</th>
                    <th>数量</th>
                    <th>出货状态</th>
                    <th>原因</th>
                    <th>时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {supplierReturns.flatMap((record) => record.items.map((item, index) => (
                    <tr key={item.id}>
                      {index === 0 && <td rowSpan={record.items.length}>{record.supplierName}</td>}
                      {index === 0 && (
                        <td rowSpan={record.items.length}>
                          {record.purchaseOrderId
                            ? `第 ${orders.find(
                              (order) => order.id === record.purchaseOrderId,
                            )?.sequence ?? '?'} 号`
                            : '无关联订单'}
                        </td>
                      )}
                      <td>{item.name}（{item.specification}）</td>
                      <td>{item.quantity}</td>
                      <td>{inventoryStateLabel(item.state)}</td>
                      {index === 0 && <td rowSpan={record.items.length}>{record.reason}</td>}
                      {index === 0 && (
                        <td rowSpan={record.items.length}>{formatTime(record.occurredAt)}</td>
                      )}
                      {index === 0 && (
                        <td rowSpan={record.items.length}>
                          <button
                            type="button"
                            onClick={() => setRecordFundsTarget({
                              preset: {
                                sourceType: 'supplier_return',
                                sourceId: record.id,
                                sourceLabel: `供应方退货 · ${record.supplierName}`,
                                defaultType: 'purchase_cost',
                                defaultDirection: 'income',
                              },
                              reloadOrderIds: record.purchaseOrderId
                                ? [record.purchaseOrderId]
                                : [],
                            })}
                          >
                            记供应方退款
                          </button>
                        </td>
                      )}
                    </tr>
                  )))}
                </tbody>
              </table>
          </div>
          )}
        </>
      )}

      {dialog?.kind === 'supplier-create' && (
        <DialogShell
          kicker="采购·供应方"
          title="登记供应方"
          description="供应方只用于采购订单与退货归属，不参与库存或资金计算。"
          busy={saving}
          onClose={closeDialog}
          onSubmit={submitSupplierCreate}
        >
          <label>
            <span>名称</span>
            <input
              aria-label="供应方名称"
              value={supplierName}
              disabled={saving}
              onChange={(event) => setSupplierName(event.target.value)}
            />
          </label>
          <label>
            <span>联系方式（选填）</span>
            <input
              aria-label="供应方联系方式"
              value={supplierContact}
              disabled={saving}
              onChange={(event) => setSupplierContact(event.target.value)}
            />
          </label>
          <label>
            <span>备注（选填）</span>
            <input
              aria-label="供应方备注"
              value={supplierNote}
              disabled={saving}
              onChange={(event) => setSupplierNote(event.target.value)}
            />
          </label>
          <InlineError message={formError} />
          <DialogFooter label="登记供应方" saving={saving} onCancel={closeDialog} />
        </DialogShell>
      )}

      {dialog?.kind === 'create' && (
        <DialogShell
          kicker="采购·订单"
          title="新建采购订单"
          description="创建后是草稿，确认后才形成采购在途和待确认应付；不会自动增加库存。"
          busy={saving}
          onClose={closeDialog}
          onSubmit={submitOrderCreate}
        >
          <label>
            <span>供应方</span>
            <select
              aria-label="供应方"
              value={orderSupplierId}
              disabled={saving}
              onChange={(event) => setOrderSupplierId(event.target.value)}
            >
              {suppliers.map((supplier) => (
                <option key={supplier.supplierId} value={supplier.supplierId}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>交期</span>
            <input
              type="datetime-local"
              aria-label="交期"
              value={orderExpectedAt}
              disabled={saving}
              onChange={(event) => setOrderExpectedAt(event.target.value)}
            />
          </label>
          {orderLines.map((line, index) => (
            <div key={index} className="purchase-line-row">
              <select
                aria-label={`商品 ${index + 1}`}
                value={line.standardProductId}
                disabled={saving}
                onChange={(event) => setOrderLines(orderLines.map((candidate, position) => (
                  position === index
                    ? { ...candidate, standardProductId: event.target.value }
                    : candidate
                )))}
              >
                <option value="">选择商品</option>
                {inventoryProducts.map((product) => (
                  <option key={product.standardProductId} value={product.standardProductId}>
                    {product.name}（{product.specification}）
                  </option>
                ))}
              </select>
              <input
                aria-label={`数量 ${index + 1}`}
                placeholder="数量"
                value={line.quantity}
                disabled={saving}
                onChange={(event) => setOrderLines(orderLines.map((candidate, position) => (
                  position === index ? { ...candidate, quantity: event.target.value } : candidate
                )))}
              />
              <input
                aria-label={`单价元 ${index + 1}`}
                placeholder="单价（元）"
                value={line.unitPriceYuan}
                disabled={saving}
                onChange={(event) => setOrderLines(orderLines.map((candidate, position) => (
                  position === index
                    ? { ...candidate, unitPriceYuan: event.target.value }
                    : candidate
                )))}
              />
              {orderLines.length > 1 && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setOrderLines(orderLines.filter((_, position) => position !== index))}
                >
                  移除
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            disabled={saving}
            onClick={() => setOrderLines([
              ...orderLines,
              { standardProductId: '', quantity: '', unitPriceYuan: '' },
            ])}
          >
            添加商品行
          </button>
          <ReasonField label="下单原因" value={reason} saving={saving} onChange={setReason} />
          <InlineError message={formError} />
          <DialogFooter label="创建订单" saving={saving} onCancel={closeDialog} />
        </DialogShell>
      )}

      {dialog?.kind === 'confirm' && (
        <DialogShell
          kicker="采购·订单确认"
          title={`确认第 ${dialog.order.sequence} 号采购订单`}
          description="确认后的数量形成采购在途并产生待确认应付，实际支付由财务确认。"
          busy={saving}
          onClose={closeDialog}
          onSubmit={(event) => {
            event.preventDefault();
            submit(() => api.confirmPurchaseOrder({
              orderId: dialog.order.id,
              reason: reason.trim(),
            }));
          }}
        >
          <ReasonField label="确认原因" value={reason} saving={saving} onChange={setReason} />
          <InlineError message={formError} />
          <DialogFooter label="确认订单" saving={saving} onCancel={closeDialog} />
        </DialogShell>
      )}

      {dialog?.kind === 'cancel' && (
        <DialogShell
          kicker="采购·订单取消"
          title={`取消第 ${dialog.order.sequence} 号采购订单`}
          description="取消必须留痕；已到货部分仍计入待确认应付。"
          busy={saving}
          onClose={closeDialog}
          onSubmit={(event) => {
            event.preventDefault();
            submit(() => api.cancelPurchaseOrder({
              orderId: dialog.order.id,
              reason: reason.trim(),
            }));
          }}
        >
          <ReasonField label="取消原因" value={reason} saving={saving} onChange={setReason} />
          <InlineError message={formError} />
          <DialogFooter label="取消订单" saving={saving} onCancel={closeDialog} />
        </DialogShell>
      )}

      {dialog?.kind === 'quantity' && (
        <DialogShell
          kicker="采购·数量变更"
          title="变更采购数量"
          description="变更显式留痕，不能低于已到货数量；确认后的订单会同步重算待确认应付。"
          busy={saving}
          onClose={closeDialog}
          onSubmit={(event) => {
            event.preventDefault();
            const quantity = parsePositiveInt(newQuantity);
            if (quantity === null) {
              setFormError('数量需为大于零的整数');
              return;
            }
            submit(() => api.changePurchaseOrderItemQuantity({
              orderId: dialog.order.id,
              itemId: dialog.itemId,
              quantity,
              reason: reason.trim(),
            }));
          }}
        >
          <label>
            <span>新数量</span>
            <input
              aria-label="新采购数量"
              value={newQuantity}
              disabled={saving}
              onChange={(event) => setNewQuantity(event.target.value)}
            />
          </label>
          <ReasonField label="变更原因" value={reason} saving={saving} onChange={setReason} />
          <InlineError message={formError} />
          <DialogFooter label="保存数量变更" saving={saving} onCancel={closeDialog} />
        </DialogShell>
      )}

      {dialog?.kind === 'expected-date' && (
        <DialogShell
          kicker="采购·交期变更"
          title={`变更第 ${dialog.order.sequence} 号交期`}
          description="交期变更显式留痕，不影响数量与应付。"
          busy={saving}
          onClose={closeDialog}
          onSubmit={(event) => {
            event.preventDefault();
            if (!newExpectedAt) {
              setFormError('请填写新交期');
              return;
            }
            submit(() => api.changePurchaseOrderExpectedDate({
              orderId: dialog.order.id,
              expectedAt: new Date(newExpectedAt).toISOString(),
              reason: reason.trim(),
            }));
          }}
        >
          <label>
            <span>新交期</span>
            <input
              type="datetime-local"
              aria-label="新交期"
              value={newExpectedAt}
              disabled={saving}
              onChange={(event) => setNewExpectedAt(event.target.value)}
            />
          </label>
          <ReasonField label="变更原因" value={reason} saving={saving} onChange={setReason} />
          <InlineError message={formError} />
          <DialogFooter label="保存新交期" saving={saving} onCancel={closeDialog} />
        </DialogShell>
      )}

      {dialog?.kind === 'arrival' && (
        <DialogShell
          kicker="采购·到货"
          title={`登记第 ${dialog.order.sequence} 号到货`}
          description="每次到货单独记录；合格/瑕疵/报废当场分流，未填的余量先进待检查。"
          busy={saving}
          onClose={closeDialog}
          onSubmit={submitArrival}
        >
          {arrivalLines.map((line, index) => (
            <fieldset key={line.orderItemId}>
              <legend>{line.label}（还可到货 {line.remaining} 件）</legend>
              <div className="purchase-line-row">
                <input
                  aria-label={`${line.label} 到货数量`}
                  placeholder="到货数量"
                  value={line.received}
                  disabled={saving || line.remaining === 0}
                  onChange={(event) => setArrivalLines(arrivalLines.map((candidate, position) => (
                    position === index ? { ...candidate, received: event.target.value } : candidate
                  )))}
                />
                <input
                  aria-label={`${line.label} 合格数量`}
                  placeholder="合格"
                  value={line.resellable}
                  disabled={saving}
                  onChange={(event) => setArrivalLines(arrivalLines.map((candidate, position) => (
                    position === index
                      ? { ...candidate, resellable: event.target.value }
                      : candidate
                  )))}
                />
                <input
                  aria-label={`${line.label} 瑕疵数量`}
                  placeholder="瑕疵"
                  value={line.defective}
                  disabled={saving}
                  onChange={(event) => setArrivalLines(arrivalLines.map((candidate, position) => (
                    position === index
                      ? { ...candidate, defective: event.target.value }
                      : candidate
                  )))}
                />
                <input
                  aria-label={`${line.label} 报废数量`}
                  placeholder="报废"
                  value={line.scrapped}
                  disabled={saving}
                  onChange={(event) => setArrivalLines(arrivalLines.map((candidate, position) => (
                    position === index
                      ? { ...candidate, scrapped: event.target.value }
                      : candidate
                  )))}
                />
              </div>
            </fieldset>
          ))}
          <ReasonField label="到货说明" value={reason} saving={saving} onChange={setReason} />
          <InlineError message={formError} />
          <DialogFooter label="登记到货" saving={saving} onCancel={closeDialog} />
        </DialogShell>
      )}

      {dialog?.kind === 'supplier-return' && (
        <DialogShell
          kicker="采购·供应方退货"
          title="登记供应方退货"
          description="退货从所选库存状态出库并保留独立记录；退给供应方的货不再计入库存。"
          busy={saving}
          onClose={closeDialog}
          onSubmit={submitSupplierReturn}
        >
          <label>
            <span>供应方</span>
            <select
              aria-label="退货供应方"
              value={returnSupplierId}
              disabled={saving}
              onChange={(event) => setReturnSupplierId(event.target.value)}
            >
              {suppliers.map((supplier) => (
                <option key={supplier.supplierId} value={supplier.supplierId}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>关联采购订单（选填）</span>
            <select
              aria-label="关联采购订单"
              value={returnOrderId}
              disabled={saving}
              onChange={(event) => setReturnOrderId(event.target.value)}
            >
              <option value="">无关联订单</option>
              {orders.map((order) => (
                <option key={order.id} value={order.id}>
                  第 {order.sequence} 号 · {order.supplierName}
                </option>
              ))}
            </select>
          </label>
          {returnLines.map((line, index) => (
            <div key={index} className="purchase-line-row">
              <select
                aria-label={`退货商品 ${index + 1}`}
                value={line.standardProductId}
                disabled={saving}
                onChange={(event) => setReturnLines(returnLines.map((candidate, position) => (
                  position === index
                    ? { ...candidate, standardProductId: event.target.value }
                    : candidate
                )))}
              >
                <option value="">选择商品</option>
                {inventoryProducts.map((product) => (
                  <option key={product.standardProductId} value={product.standardProductId}>
                    {product.name}（{product.specification}）
                  </option>
                ))}
              </select>
              <input
                aria-label={`退货数量 ${index + 1}`}
                placeholder="数量"
                value={line.quantity}
                disabled={saving}
                onChange={(event) => setReturnLines(returnLines.map((candidate, position) => (
                  position === index ? { ...candidate, quantity: event.target.value } : candidate
                )))}
              />
              <select
                aria-label={`出货库存状态 ${index + 1}`}
                value={line.state}
                disabled={saving}
                onChange={(event) => setReturnLines(returnLines.map((candidate, position) => (
                  position === index
                    ? { ...candidate, state: event.target.value as InventoryStateName }
                    : candidate
                )))}
              >
                <option value="sellable">{inventoryStateLabel('sellable')}</option>
                <option value="awaiting_inspection">{inventoryStateLabel('awaiting_inspection')}</option>
                <option value="defective">{inventoryStateLabel('defective')}</option>
                <option value="scrapped">{inventoryStateLabel('scrapped')}</option>
              </select>
              {returnLines.length > 1 && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setReturnLines(returnLines.filter((_, position) => position !== index))}
                >
                  移除
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            disabled={saving}
            onClick={() => setReturnLines([
              ...returnLines,
              { standardProductId: '', quantity: '', state: 'defective' },
            ])}
          >
            添加退货行
          </button>
          <ReasonField label="退货原因" value={reason} saving={saving} onChange={setReason} />
          <InlineError message={formError} />
          <DialogFooter label="登记退货" saving={saving} onCancel={closeDialog} />
        </DialogShell>
      )}

      {recordFundsTarget && (
        <FinanceRecordDialog
          api={api}
          preset={recordFundsTarget.preset}
          onClose={() => setRecordFundsTarget(null)}
          onSaved={() => reloadFundsForOrders(recordFundsTarget.reloadOrderIds)}
        />
      )}
    </>,
  );

}

function shell(children: ReactNode) {
  return (
    <section className="purchase-workspace workspace-enter" aria-label="采购">
      <header className="workspace-header">
        <div>
          <span className="section-kicker">采购·订单、到货与供应方退货</span>
          <h1>采购</h1>
          <p className="workspace-subtitle">
            采购建议不会自动变成采购订单；确认后的数量形成采购在途与待确认应付，
            到货检查合格才进入可销售库存，实际支付留给财务确认。
          </p>
        </div>
      </header>
      {children}
    </section>
  );
}

function DialogFooter({
  label,
  saving,
  onCancel,
}: {
  label: string;
  saving: boolean;
  onCancel: () => void;
}) {
  return (
    <footer>
      <button className="button button--quiet" type="button" disabled={saving} onClick={onCancel}>
        取消
      </button>
      <button className="button button--primary" type="submit" disabled={saving}>
        {saving ? '正在保存…' : label}
      </button>
    </footer>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作失败，请重试';
}

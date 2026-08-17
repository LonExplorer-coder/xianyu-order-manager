import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import type {
  OrderItemStandardizationBatchOptions,
  OrderItemStandardizationBatchPreview,
  OrderItemStandardizationBatchResult,
  StandardDisplayPreference,
  StandardProduct,
} from '../core/product-standardization';
import { DialogShell, InlineError } from './DialogShell';

/**
 * 订单商品明细批量关联对话框：多选明细统一关联到一个标准商品。
 * 确认前完整预览影响（规格第 6 节），逐条冲突必须显式确认覆盖或核对；
 * 「建立未来自动匹配的商品映射」默认不勾选，勾选后按当前账号适用范围建映射，
 * 相同原文已有指向其他 SKU 的有效映射时须逐条确认单笔例外；
 * 成交金额与来源原文保持不变。
 */
export function OrderItemStandardizationBatchDialog({
  api,
  items,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  items: Array<{ id: string; sourceTitle: string }>;
  onApplied: () => void;
  onClose: () => void;
}) {
  const [products, setProducts] = useState<StandardProduct[] | null>(null);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [preference, setPreference] = useState<StandardDisplayPreference>('prefer_standard');
  const [useDefaultOrderPrice, setUseDefaultOrderPrice] = useState(false);
  const [updateProductTotal, setUpdateProductTotal] = useState(false);
  const [createMappings, setCreateMappings] = useState(false);
  const [preview, setPreview] = useState<OrderItemStandardizationBatchPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmedOverrideItemIds, setConfirmedOverrideItemIds] = useState<Set<string>>(new Set());
  const [confirmedAmountMismatchOrderIds, setConfirmedAmountMismatchOrderIds] = useState<Set<string>>(
    new Set(),
  );
  const [confirmedMappingConflictItemIds, setConfirmedMappingConflictItemIds] = useState<Set<string>>(
    new Set(),
  );
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<OrderItemStandardizationBatchResult | null>(null);
  const previewRequestVersion = useRef(0);

  useEffect(() => {
    let active = true;
    void api.listStandardProducts()
      .then((listed) => {
        if (active) setProducts(listed);
      })
      .catch((value: unknown) => {
        if (active) setError(errorMessage(value));
      });
    return () => {
      active = false;
    };
  }, [api]);

  const options: OrderItemStandardizationBatchOptions = useMemo(() => ({
    standardDisplayPreference: preference,
    useDefaultOrderPrice,
    updateProductTotal,
    createMappings,
  }), [preference, useDefaultOrderPrice, updateProductTotal, createMappings]);
  useEffect(() => {
    if (!selectedProductId) {
      setPreview(null);
      return undefined;
    }
    let active = true;
    const requestVersion = ++previewRequestVersion.current;
    setPreviewLoading(true);
    setError('');
    setConfirmedOverrideItemIds(new Set());
    setConfirmedAmountMismatchOrderIds(new Set());
    setConfirmedMappingConflictItemIds(new Set());
    void api.previewOrderItemStandardizationBatch({
      itemIds: items.map((item) => item.id),
      standardProductId: selectedProductId,
      options,
    })
      .then((loaded) => {
        if (!active || requestVersion !== previewRequestVersion.current) return;
        setPreview(loaded);
      })
      .catch((value: unknown) => {
        if (!active || requestVersion !== previewRequestVersion.current) return;
        setPreview(null);
        setError(errorMessage(value));
      })
      .finally(() => {
        if (active && requestVersion === previewRequestVersion.current) {
          setPreviewLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, items, selectedProductId, options]);

  const linkedOtherItems = preview?.items.filter((item) => (
    item.blockReasons.includes('linked_other_product')
  )) ?? [];
  const mappingConflictItems = preview?.items.filter((item) => (
    item.blockReasons.includes('mapping_conflict')
  )) ?? [];
  const amountMismatchOrders = preview?.orders.filter((order) => order.amountMismatch) ?? [];
  const priceSyncUnavailable = Boolean(
    preview && preview.priceSyncRequested && !preview.priceSyncAvailable,
  );
  const busy = applying || previewLoading;

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (applying || previewLoading || !preview || priceSyncUnavailable) return;
    setApplying(true);
    setError('');
    try {
      const applied = await api.applyOrderItemStandardizationBatch({
        itemIds: items.map((item) => item.id),
        standardProductId: preview.standardProduct.id,
        options,
        confirmedOverrideItemIds: [...confirmedOverrideItemIds],
        confirmedAmountMismatchOrderIds: [...confirmedAmountMismatchOrderIds],
        confirmedMappingConflictItemIds: [...confirmedMappingConflictItemIds],
        expectedOrderRevisions: preview.orders.map((order) => ({
          orderId: order.orderId,
          revision: order.revision,
        })),
      });
      setResult(applied);
      onApplied();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setApplying(false);
    }
  }

  if (result) {
    return (
      <DialogShell
        kicker="订单商品明细"
        title="批量关联标准商品"
        description="批量关联操作及其逐条结果已留痕。"
        busy={false}
        onClose={onClose}
        onSubmit={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <p role="status">
          已关联 {result.appliedItemCount} 条商品明细
          {result.blockedItemCount > 0 ? `，阻断 ${result.blockedItemCount} 条` : ''}
          {result.createdMappingCount > 0 ? `，新建 ${result.createdMappingCount} 条商品映射` : ''}
          。
        </p>
        {result.blockedItemCount > 0 && (
          <ul>
            {result.results.filter((entry) => !entry.applied).map((entry) => (
              <li key={entry.itemId}>
                {items.find((item) => item.id === entry.itemId)?.sourceTitle ?? entry.itemId}
                ：{blockReasonLabel(entry.blockReason)}
              </li>
            ))}
          </ul>
        )}
        <footer>
          <button className="button button--primary" type="submit">
            完成
          </button>
        </footer>
      </DialogShell>
    );
  }

  return (
    <DialogShell
      kicker="订单商品明细"
      title="批量关联标准商品"
      description={`已选 ${items.length} 条订单商品明细，统一关联到一个 SKU；来源原文与成交金额保持不变。`}
      busy={busy}
      wide
      onClose={onClose}
      onSubmit={(event) => void apply(event)}
    >
      <label>
        <span>标准商品</span>
        <select
          aria-label="标准商品"
          value={selectedProductId}
          disabled={busy || products === null}
          onChange={(event) => setSelectedProductId(event.target.value)}
        >
          <option value="" disabled>
            {products === null ? '正在读取…' : '请选择标准商品'}
          </option>
          {(products ?? []).map((product) => (
            <option value={product.id} key={product.id}>
              {product.sku} · {product.name} · {product.specification}
            </option>
          ))}
        </select>
      </label>
      <label className="fields-check-row">
        <input type="checkbox" aria-label="关联到所选 SKU" checked disabled />
        <span>关联到所选 SKU</span>
      </label>
      <label className="fields-check-row">
        <input
          type="checkbox"
          aria-label="优先展示标准商品信息"
          checked={preference === 'prefer_standard'}
          disabled={busy}
          onChange={(event) => setPreference(
            event.target.checked ? 'prefer_standard' : 'prefer_source',
          )}
        />
        <span>优先展示标准商品信息</span>
      </label>
      <label className="fields-check-row">
        <input
          type="checkbox"
          aria-label="使用标准商品默认单价"
          checked={useDefaultOrderPrice}
          disabled={busy}
          onChange={(event) => {
            setUseDefaultOrderPrice(event.target.checked);
            if (!event.target.checked) setUpdateProductTotal(false);
          }}
        />
        <span>使用标准商品默认单价</span>
      </label>

      <label className="fields-check-row">
        <input
          type="checkbox"
          aria-label="建立未来自动匹配的商品映射"
          checked={createMappings}
          disabled={busy}
          onChange={(event) => setCreateMappings(event.target.checked)}
        />
        <span>建立未来自动匹配的商品映射</span>
      </label>

      {previewLoading && <p role="status">正在计算影响预览…</p>}
      {preview && (
        <div className="field-definition-card__meta">
          <span>影响预览</span>
          <span>
            订单数量 <strong>{preview.orderCount}</strong>
            {' · '}商品明细数量 <strong>{preview.itemCount}</strong>
            {' · '}商品总数量 <strong>{preview.totalQuantity}</strong>
          </span>
          <span>
            未关联 <strong>{preview.unlinkedCount}</strong>
            {' · '}已关联相同 SKU <strong>{preview.sameProductCount}</strong>
            {' · '}已关联其他 SKU <strong>{preview.otherProductCount}</strong>
          </span>
          <span>
            已发货订单 <strong>{preview.shippedOrderCount}</strong>
            {' · '}存在售后订单 <strong>{preview.aftersalesOrderCount}</strong>
          </span>
          <span>
            修改商品单价：
            {preview.priceSyncRequested && preview.priceSyncAvailable
              && preview.priceAffectedItemCount > 0
              ? `是（${preview.priceAffectedItemCount} 条）`
              : '否'}
          </span>
          <span>
            建议修改商品总价：
            {preview.suggestedProductTotalOrderCount > 0
              ? `是（${preview.suggestedProductTotalOrderCount} 笔订单）`
              : '否'}
          </span>
          <span>成交金额保持不变</span>
          <span>来源原文保持不变</span>
          <span>
            新增商品映射：
            {preview.createMappingsRequested
              ? `是（预计新增 ${preview.plannedMappingCreationCount} 条，按当前平台与卖家账号适用范围）`
              : '否'}
          </span>
          <span>更正商品映射：否（本操作只新增映射，不更正既有映射）</span>
        </div>
      )}
      {preview && preview.priceSyncRequested && preview.priceSyncAvailable
        && preview.priceAffectedItemCount > 0 && (
        <div className="field-definition-card__meta">
          <span>金额变化预览</span>
          {preview.items.filter((item) => (
            item.plannedUnitPriceCents !== item.currentUnitPriceCents
          )).map((item) => (
            <span key={item.itemId}>
              {item.sourceTitle}：商品单价 {formatMoney(item.currentUnitPriceCents)}
              {' → '}{formatMoney(item.plannedUnitPriceCents)}
              ，商品小计 {formatMoney(item.currentSubtotalCents)}
              {' → '}{formatMoney(item.plannedSubtotalCents)}
            </span>
          ))}
          {preview.orders.filter((order) => order.productTotalChanges).map((order) => (
            <span key={order.orderId}>
              订单 {order.orderNumber}：商品总价 {formatMoney(order.productTotalCents)}
              {' → '}建议 {formatMoney(order.suggestedProductTotalCents)}
              ，成交金额 {formatMoney(order.amountCents)} 保持不变
            </span>
          ))}
        </div>
      )}
      {preview && preview.suggestedProductTotalOrderCount > 0 && preview.priceSyncAvailable && (
        <label className="fields-check-row">
          <input
            type="checkbox"
            aria-label="同步更新商品总价为建议值"
            checked={updateProductTotal}
            disabled={busy}
            onChange={(event) => setUpdateProductTotal(event.target.checked)}
          />
          <span>同步更新商品总价为建议值</span>
        </label>
      )}
      {priceSyncUnavailable && (
        <InlineError message="标准商品未设置默认订单单价，无法同步商品单价" />
      )}
      {linkedOtherItems.length > 0 && (
        <div className="field-definition-card__meta">
          <span>已关联其他 SKU，须逐条确认覆盖或排除</span>
          {linkedOtherItems.map((item) => (
            <label className="fields-check-row" key={item.itemId}>
              <input
                type="checkbox"
                aria-label={`覆盖订单商品 ${item.sourceTitle} 的现有关联`}
                checked={confirmedOverrideItemIds.has(item.itemId)}
                disabled={busy}
                onChange={(event) => {
                  setConfirmedOverrideItemIds((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item.itemId);
                    else next.delete(item.itemId);
                    return next;
                  });
                }}
              />
              <span>
                {item.sourceTitle}：已关联其他 SKU：{item.beforeStandardProductSku}
              </span>
            </label>
          ))}
        </div>
      )}
      {mappingConflictItems.length > 0 && (
        <div className="field-definition-card__meta">
          <span>相同原文已有指向其他 SKU 的有效映射，须逐条确认处理方式</span>
          {mappingConflictItems.map((item) => (
            <label className="fields-check-row" key={item.itemId}>
              <input
                type="checkbox"
                aria-label={`订单商品 ${item.sourceTitle} 仅本次关联（单笔例外），不建立映射`}
                checked={confirmedMappingConflictItemIds.has(item.itemId)}
                disabled={busy}
                onChange={(event) => {
                  setConfirmedMappingConflictItemIds((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item.itemId);
                    else next.delete(item.itemId);
                    return next;
                  });
                }}
              />
              <span>
                {item.sourceTitle}：单笔例外只关联本次订单商品，不建立也不修改商品映射；
                未确认时整批不执行
              </span>
            </label>
          ))}
        </div>
      )}
      {amountMismatchOrders.length > 0 && (
        <div className="field-definition-card__meta">
          <span>商品总价与成交金额存在差异，须逐条人工核对</span>
          {amountMismatchOrders.map((order) => (
            <label className="fields-check-row" key={order.orderId}>
              <input
                type="checkbox"
                aria-label={`已核对订单 ${order.orderNumber} 的金额差异`}
                checked={confirmedAmountMismatchOrderIds.has(order.orderId)}
                disabled={busy}
                onChange={(event) => {
                  setConfirmedAmountMismatchOrderIds((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(order.orderId);
                    else next.delete(order.orderId);
                    return next;
                  });
                }}
              />
              <span>
                订单 {order.orderNumber}：商品总价 {formatMoney(order.productTotalCents)}
                {' → '}{formatMoney(order.suggestedProductTotalCents)}
                ，成交金额 {formatMoney(order.amountCents)} 保持不变
              </span>
            </label>
          ))}
        </div>
      )}
      <InlineError message={error} />
      <footer>
        <button className="button button--quiet" type="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="button button--primary"
          type="submit"
          disabled={busy || !preview || priceSyncUnavailable}
        >
          {applying ? '正在执行…' : '确认批量关联'}
        </button>
      </footer>
    </DialogShell>
  );
}

function blockReasonLabel(
  reason: 'linked_other_product' | 'amount_mismatch' | 'mapping_conflict' | null,
): string {
  if (reason === 'linked_other_product') return '已关联其他 SKU，未确认覆盖';
  if (reason === 'amount_mismatch') return '商品总价与成交金额存在差异，未人工核对';
  if (reason === 'mapping_conflict') return '相同原文已有指向其他 SKU 的有效映射，未确认单笔例外';
  return '未知原因';
}

function formatMoney(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}

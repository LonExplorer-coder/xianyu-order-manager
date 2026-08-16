import { useEffect, useState, type FormEvent } from 'react';

import type { OrderItem, OriginalOrder } from '../core/contracts';
import type { DesktopApi } from '../core/desktop-api';
import type {
  ProductStandardizationSource,
  StandardDisplayPreference,
  StandardProduct,
} from '../core/product-standardization';
import { DialogShell, InlineError } from './DialogShell';

/**
 * 订单详情单笔商品标准化关联对话框：展示来源原文与当前关联，
 * 维护标准商品关联与标准商品显示偏好；默认订单单价只读参考，保存时不带入。
 */
export function UpdateOrderItemStandardizationDialog({
  api,
  order,
  item,
  onSaved,
  onClose,
}: {
  api: DesktopApi;
  order: OriginalOrder;
  item: OrderItem;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const currentProductId = item.standardProduct?.id ?? '';
  const currentPreference: StandardDisplayPreference =
    item.standardDisplayPreference ?? 'prefer_standard';
  const [products, setProducts] = useState<StandardProduct[] | null>(null);
  const [selectedProductId, setSelectedProductId] = useState(currentProductId);
  const [preference, setPreference] = useState<StandardDisplayPreference>(currentPreference);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
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
  const selectedProduct = products?.find(({ id }) => id === selectedProductId) ?? null;
  const dirty = selectedProductId !== currentProductId ||
    (selectedProductId !== '' && preference !== currentPreference);

  function changeProduct(productId: string) {
    setSelectedProductId(productId);
    // 建立或更换关联时默认优先展示标准商品信息；改回当前关联时还原已保存偏好。
    setPreference(
      productId === currentProductId ? currentPreference : 'prefer_standard',
    );
  }

  async function save(input: {
    standardProductId: string | null;
    standardDisplayPreference?: StandardDisplayPreference;
  }) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await api.updateOrderItemStandardization(order.id, item.id, {
        ...input,
        expectedRevision: order.revision,
      });
      await onSaved();
    } catch (value) {
      setError(errorMessage(value));
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedProductId === '') return;
    void save({ standardProductId: selectedProductId, standardDisplayPreference: preference });
  }

  return (
    <DialogShell
      kicker="订单商品明细"
      title="关联标准商品"
      description="来源原文始终保留，不被关联覆盖；标准商品显示偏好可单独修改，不需要解除关联。"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="field-definition-card__meta">
        <span>来源原文</span>
        <span>原始商品标题：{item.sourceTitle}</span>
        <span>原始规格：{item.sourceSpec || '无规格'}</span>
      </div>
      <div className="field-definition-card__meta">
        <span>当前关联</span>
        {item.standardProduct ? (
          <span>
            {item.standardProduct.sku} · {item.standardProduct.name}
            {item.standardProduct.specification ? ` · ${item.standardProduct.specification}` : ''}
            {`（关联来源：${standardizationSourceLabel(item.standardizationSource)}）`}
          </span>
        ) : (
          <span>未关联</span>
        )}
      </div>
      <label>
        <span>标准商品</span>
        <select
          aria-label="标准商品"
          value={selectedProductId}
          disabled={saving || products === null}
          onChange={(event) => changeProduct(event.target.value)}
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
      {selectedProduct && (
        <small>
          默认订单单价 {formatPriceReference(selectedProduct.defaultOrderPriceCents)}
          ，保存时不会带入
        </small>
      )}
      {selectedProductId !== '' && (
        <label className="fields-check-row">
          <input
            type="checkbox"
            checked={preference === 'prefer_standard'}
            disabled={saving}
            onChange={(event) => setPreference(
              event.target.checked ? 'prefer_standard' : 'prefer_source',
            )}
          />
          <span>优先展示标准商品信息</span>
        </label>
      )}
      <InlineError message={error} />
      <footer>
        {item.standardProduct && (
          <button
            className="button button--quiet"
            type="button"
            disabled={saving}
            onClick={() => void save({ standardProductId: null })}
          >
            解除关联
          </button>
        )}
        <button
          className="button button--quiet"
          type="button"
          disabled={saving}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="button button--primary"
          type="submit"
          disabled={saving || !dirty}
        >
          {saving ? '正在保存…' : '保存关联'}
        </button>
      </footer>
    </DialogShell>
  );
}

function standardizationSourceLabel(source: ProductStandardizationSource | null): string {
  if (source === 'exact') return '标题规格精确一致';
  if (source === 'mapping') return '商品映射';
  if (source === 'manual') return '人工确认';
  return '未知';
}

function formatPriceReference(cents: number | null): string {
  return cents === null ? '未设置' : `¥${(cents / 100).toFixed(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}

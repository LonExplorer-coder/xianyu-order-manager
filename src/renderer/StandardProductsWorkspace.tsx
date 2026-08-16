import { useEffect, useState, type FormEvent } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import type {
  StandardProduct,
  StandardProductPriceEvent,
} from '../core/product-standardization';

type ProductForm = {
  sku: string;
  name: string;
  specification: string;
  defaultOrderPrice: string;
  priceChangeReason: string;
};

const EMPTY_FORM: ProductForm = {
  sku: '',
  name: '',
  specification: '',
  defaultOrderPrice: '',
  priceChangeReason: '',
};

export function StandardProductsWorkspace({ api }: { api: DesktopApi }) {
  const [products, setProducts] = useState<StandardProduct[]>([]);
  const [editing, setEditing] = useState<StandardProduct | null>(null);
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [priceEvents, setPriceEvents] = useState<StandardProductPriceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.listStandardProducts()
      .then((result) => {
        if (active) setProducts(result);
      })
      .catch((error: unknown) => {
        if (active) setFeedback({ kind: 'error', message: errorMessage(error) });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!editing) {
      setPriceEvents([]);
      return;
    }
    let active = true;
    void api.listStandardProductPriceEvents(editing.id)
      .then((result) => {
        if (active) setPriceEvents(result);
      })
      .catch(() => {
        if (active) setPriceEvents([]);
      });
    return () => { active = false; };
  }, [api, editing]);

  function beginEdit(product: StandardProduct) {
    setEditing(product);
    setForm({
      sku: product.sku,
      name: product.name,
      specification: product.specification,
      defaultOrderPrice: formatMoneyInput(product.defaultOrderPriceCents),
      priceChangeReason: '',
    });
    setFeedback(null);
  }

  function resetForm() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const price = parsePriceInput(form.defaultOrderPrice);
    if (price === undefined) {
      setFeedback({ kind: 'error', message: '默认订单单价必须是大于等于零的金额（最多两位小数）' });
      return;
    }
    const priceChanged = editing
      ? price !== editing.defaultOrderPriceCents
      : price !== null;
    const priceChangeReason = priceChanged ? form.priceChangeReason.trim() : '';
    setSaving(true);
    setFeedback(null);
    try {
      const saved = editing
        ? await api.updateStandardProduct(editing.id, {
          sku: form.sku,
          name: form.name,
          specification: form.specification,
          defaultOrderPriceCents: price,
          ...(priceChangeReason ? { priceChangeReason } : {}),
          expectedRevision: editing.revision,
        })
        : await api.createStandardProduct({
          sku: form.sku,
          name: form.name,
          specification: form.specification,
          defaultOrderPriceCents: price,
          ...(priceChangeReason ? { priceChangeReason } : {}),
        });
      setProducts((current) => {
        const next = current.some(({ id }) => id === saved.id)
          ? current.map((product) => product.id === saved.id ? saved : product)
          : [...current, saved];
        return next.sort((left, right) => left.sku.localeCompare(right.sku, 'zh-CN'));
      });
      resetForm();
      setFeedback({
        kind: 'success',
        message: editing ? '标准商品已更新，关联订单会显示新名称。' : '标准商品已创建，可在订单校对时关联。',
      });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="fields-workspace workspace-enter">
      <header className="workspace-header">
        <div>
          <span className="section-kicker">商品标准化</span>
          <h1>标准商品</h1>
          <p>维护内部统一的 SKU、商品名和规格；订单截图原文始终单独保留。</p>
        </div>
      </header>

      <div className="fields-layout">
        <section className="fields-panel fields-panel--list" aria-labelledby="standard-product-list-heading">
          <div className="fields-panel__heading">
            <div>
              <span className="section-kicker">当前目录</span>
              <h2 id="standard-product-list-heading">{products.length} 个标准商品</h2>
            </div>
            {loading && <span role="status">正在读取…</span>}
          </div>
          {!loading && products.length === 0 ? (
            <div className="fields-empty">
              <strong>还没有标准商品</strong>
              <p>先创建一个标准商品，后续校对时即可自动或人工关联。</p>
            </div>
          ) : (
            <div className="field-definition-list">
              {products.map((product) => (
                <article className="field-definition-card" key={product.id}>
                  <div>
                    <strong>{product.name}</strong>
                    <span>{product.sku}</span>
                  </div>
                  <div className="field-definition-card__meta">
                    <span>{product.specification}</span>
                    <span>默认单价 {formatMoney(product.defaultOrderPriceCents)}</span>
                    <span>版本 {product.revision}</span>
                  </div>
                  <button
                    className="button button--quiet"
                    type="button"
                    disabled={saving}
                    aria-label={`编辑标准商品 ${product.sku}`}
                    onClick={() => beginEdit(product)}
                  >
                    编辑
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        <form className="fields-panel fields-panel--create" aria-label={editing ? '编辑标准商品' : '创建标准商品'} onSubmit={(event) => void saveProduct(event)}>
          <div className="fields-panel__heading">
            <div>
              <span className="section-kicker">{editing ? '修改当前值' : '新商品'}</span>
              <h2>{editing ? '编辑标准商品' : '创建标准商品'}</h2>
            </div>
          </div>

          <label className="field">
            <span className="field-label">SKU<i aria-hidden="true">*</i></span>
            <input
              required
              disabled={saving}
              value={form.sku}
              onChange={(event) => setForm((current) => ({ ...current, sku: event.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">标准商品名<i aria-hidden="true">*</i></span>
            <input
              required
              disabled={saving}
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">标准规格<i aria-hidden="true">*</i></span>
            <input
              required
              disabled={saving}
              value={form.specification}
              onChange={(event) => setForm((current) => ({
                ...current,
                specification: event.target.value,
              }))}
            />
          </label>
          <label className="field">
            <span className="field-label">默认订单单价（元，可留空）</span>
            <input
              type="number"
              min="0"
              step="0.01"
              disabled={saving}
              value={form.defaultOrderPrice}
              onChange={(event) => setForm((current) => ({
                ...current,
                defaultOrderPrice: event.target.value,
              }))}
            />
          </label>
          <label className="field">
            <span className="field-label">价格变更原因（首次定价或修改单价时必填）</span>
            <input
              disabled={saving}
              value={form.priceChangeReason}
              onChange={(event) => setForm((current) => ({
                ...current,
                priceChangeReason: event.target.value,
              }))}
            />
          </label>

          {editing && priceEvents.length > 0 && (
            <div className="field-definition-card__meta" aria-label="价格变更记录">
              <span>价格变更记录</span>
              {priceEvents.map((event) => (
                <span key={event.id}>
                  {formatMoney(event.previousDefaultOrderPriceCents)}
                  {' → '}
                  {formatMoney(event.defaultOrderPriceCents)}
                  {` · ${event.reason} · ${event.occurredAt.slice(0, 10)}`}
                </span>
              ))}
            </div>
          )}

          {feedback && (
            <p
              className={`fields-feedback fields-feedback--${feedback.kind}`}
              role={feedback.kind === 'error' ? 'alert' : 'status'}
            >
              {feedback.message}
            </p>
          )}
          <div className="form-actions">
            {editing && (
              <button className="button button--quiet" type="button" disabled={saving} onClick={resetForm}>
                取消编辑
              </button>
            )}
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? '正在保存…' : editing ? '保存修改' : '创建标准商品'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function formatMoney(cents: number | null): string {
  if (cents === null) return '未设置';
  return `¥${(cents / 100).toFixed(2)}`;
}

function formatMoneyInput(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

function parsePriceInput(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/u.test(trimmed)) return undefined;
  return Math.round(Number(trimmed) * 100);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '标准商品操作失败';
}

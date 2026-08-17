import { useEffect, useState, type FormEvent } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import type {
  ProductMappingEvent,
  ProductMappingOrigin,
  ProductMappingScope,
  ProductMappingStats,
  ProductMappingView,
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

type MappingEditor =
  | { kind: 'create' }
  | { kind: 'correct'; mapping: ProductMappingView }
  | { kind: 'disable'; mapping: ProductMappingView }
  | { kind: 'delete'; mapping: ProductMappingView }
  | null;

type MappingForm = {
  sourceTitle: string;
  sourceSpec: string;
  scope: ProductMappingScope;
  platform: string;
  sellerAccount: string;
  targetProductId: string;
  reason: string;
};

const EMPTY_MAPPING_FORM: MappingForm = {
  sourceTitle: '',
  sourceSpec: '',
  scope: 'current_account',
  platform: 'xianyu',
  sellerAccount: '',
  targetProductId: '',
  reason: '',
};

export function StandardProductsWorkspace({
  api,
  onOpenLinkedOrderItems,
}: {
  api: DesktopApi;
  onOpenLinkedOrderItems: (source: { sourceTitle: string; sourceSpec: string }) => void;
}) {
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
  const [mappings, setMappings] = useState<ProductMappingView[]>([]);
  const [mappingStats, setMappingStats] = useState<ProductMappingStats | null>(null);
  const [mappingEvents, setMappingEvents] = useState<ProductMappingEvent[]>([]);
  const [mappingSearch, setMappingSearch] = useState('');
  const [mappingEditor, setMappingEditor] = useState<MappingEditor>(null);
  const [mappingForm, setMappingForm] = useState<MappingForm>(EMPTY_MAPPING_FORM);
  const [mappingSaving, setMappingSaving] = useState(false);
  const [mappingFeedback, setMappingFeedback] = useState<{
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

  useEffect(() => {
    if (!editing) {
      setMappings([]);
      setMappingStats(null);
      setMappingEvents([]);
      return;
    }
    let active = true;
    void Promise.all([
      api.getProductMappingStats(editing.id),
      api.listProductMappings(editing.id, mappingSearch.trim()),
      api.listProductMappingEvents(editing.id),
    ])
      .then(([stats, list, events]) => {
        if (!active) return;
        setMappingStats(stats);
        setMappings(list);
        setMappingEvents(events);
      })
      .catch((error: unknown) => {
        if (active) setMappingFeedback({ kind: 'error', message: errorMessage(error) });
      });
    return () => { active = false; };
  }, [api, editing, mappingSearch]);

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
    setMappingEditor(null);
    setMappingFeedback(null);
  }

  function resetForm() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setMappingEditor(null);
    setMappingFeedback(null);
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

  async function refreshMappings(productId: string) {
    const [stats, list, events] = await Promise.all([
      api.getProductMappingStats(productId),
      api.listProductMappings(productId, mappingSearch.trim()),
      api.listProductMappingEvents(productId),
    ]);
    setMappingStats(stats);
    setMappings(list);
    setMappingEvents(events);
  }

  function beginMappingEditor(editor: Exclude<MappingEditor, null>) {
    setMappingFeedback(null);
    setMappingEditor(editor);
    if (editor.kind === 'create') {
      setMappingForm(EMPTY_MAPPING_FORM);
    } else if (editor.kind === 'correct') {
      setMappingForm({
        ...EMPTY_MAPPING_FORM,
        scope: editor.mapping.scope,
        platform: editor.mapping.platform ?? 'xianyu',
        sellerAccount: editor.mapping.sellerAccount ?? '',
        targetProductId: editor.mapping.standardProductId,
      });
    } else {
      setMappingForm(EMPTY_MAPPING_FORM);
    }
  }

  function mappingScopePayload(formState: MappingForm) {
    return {
      scope: formState.scope,
      platform: formState.scope === 'workspace' ? null : formState.platform,
      sellerAccount: formState.scope === 'current_account' ? formState.sellerAccount : null,
    };
  }

  async function submitMappingEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || !mappingEditor) return;
    setMappingSaving(true);
    setMappingFeedback(null);
    try {
      if (mappingEditor.kind === 'create') {
        await api.createProductMapping(editing.id, {
          sourceTitle: mappingForm.sourceTitle,
          sourceSpec: mappingForm.sourceSpec,
          ...mappingScopePayload(mappingForm),
        });
        setMappingFeedback({ kind: 'success', message: '商品映射已建立。' });
      } else if (mappingEditor.kind === 'correct') {
        const mapping = mappingEditor.mapping;
        await api.correctProductMapping(mapping.id, {
          standardProductId: mappingForm.targetProductId,
          ...(mappingForm.scope !== mapping.scope
            ? mappingScopePayload(mappingForm)
            : {}),
          reason: mappingForm.reason,
        });
        setMappingFeedback({ kind: 'success', message: '商品映射已更正，历史订单保持不变。' });
      } else if (mappingEditor.kind === 'disable') {
        await api.disableProductMapping(mappingEditor.mapping.id, {
          reason: mappingForm.reason,
        });
        setMappingFeedback({ kind: 'success', message: '商品映射已停用，不再参与匹配。' });
      } else {
        await api.deleteProductMapping(mappingEditor.mapping.id, {
          reason: mappingForm.reason,
        });
        setMappingFeedback({ kind: 'success', message: '商品映射已删除，变更留痕仍可追溯。' });
      }
      setMappingEditor(null);
      await refreshMappings(editing.id);
    } catch (error) {
      setMappingFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setMappingSaving(false);
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

      {editing && (
        <section className="fields-panel" aria-label="商品映射">
          <div className="fields-panel__heading">
            <div>
              <span className="section-kicker">商品映射</span>
              <h2>{editing.sku} 的映射规则</h2>
            </div>
            <button
              className="button button--quiet"
              type="button"
              disabled={mappingSaving}
              onClick={() => beginMappingEditor({ kind: 'create' })}
            >
              新增映射
            </button>
          </div>
          <p>
            新增、更正、停用或删除映射只影响以后的匹配，不会改写已关联的历史订单。
          </p>
          {mappingStats && (
            <div className="field-definition-card__meta" aria-label="商品映射统计">
              <span>有效映射 {mappingStats.activeMappingCount}</span>
              <span>已关联订单 {mappingStats.linkedOrderCount}</span>
              <span>商品明细 {mappingStats.linkedItemCount}</span>
              <span>商品总数量 {mappingStats.linkedTotalQuantity}</span>
            </div>
          )}
          <label className="field">
            <span className="field-label">搜索映射</span>
            <input
              type="search"
              aria-label="搜索原文标题或规格"
              disabled={mappingSaving}
              value={mappingSearch}
              onChange={(event) => setMappingSearch(event.target.value)}
            />
          </label>

          {mappingEditor && (
            <form
              className="field-definition-card"
              aria-label="商品映射操作"
              onSubmit={(event) => void submitMappingEditor(event)}
            >
              {mappingEditor.kind === 'create' && (
                <>
                  <label className="field">
                    <span className="field-label">原始商品标题<i aria-hidden="true">*</i></span>
                    <input
                      required
                      disabled={mappingSaving}
                      value={mappingForm.sourceTitle}
                      onChange={(event) => setMappingForm((current) => ({
                        ...current,
                        sourceTitle: event.target.value,
                      }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">原始规格</span>
                    <input
                      disabled={mappingSaving}
                      value={mappingForm.sourceSpec}
                      onChange={(event) => setMappingForm((current) => ({
                        ...current,
                        sourceSpec: event.target.value,
                      }))}
                    />
                  </label>
                </>
              )}
              {(mappingEditor.kind === 'create' || mappingEditor.kind === 'correct') && (
                <>
                  {mappingEditor.kind === 'correct' && (
                    <label className="field">
                      <span className="field-label">目标标准商品<i aria-hidden="true">*</i></span>
                      <select
                        aria-label="目标标准商品"
                        disabled={mappingSaving}
                        value={mappingForm.targetProductId}
                        onChange={(event) => setMappingForm((current) => ({
                          ...current,
                          targetProductId: event.target.value,
                        }))}
                      >
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.sku} · {product.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="field">
                    <span className="field-label">适用范围<i aria-hidden="true">*</i></span>
                    <select
                      aria-label="适用范围"
                      disabled={mappingSaving}
                      value={mappingForm.scope}
                      onChange={(event) => setMappingForm((current) => ({
                        ...current,
                        scope: event.target.value as ProductMappingScope,
                      }))}
                    >
                      <option value="current_account">当前平台与卖家账号</option>
                      <option value="current_platform">当前平台全部账号</option>
                      <option value="workspace">整个工作区</option>
                    </select>
                  </label>
                  {mappingForm.scope !== 'workspace' && (
                    <label className="field">
                      <span className="field-label">平台<i aria-hidden="true">*</i></span>
                      <input
                        required
                        disabled={mappingSaving}
                        value={mappingForm.platform}
                        onChange={(event) => setMappingForm((current) => ({
                          ...current,
                          platform: event.target.value,
                        }))}
                      />
                    </label>
                  )}
                  {mappingForm.scope === 'current_account' && (
                    <label className="field">
                      <span className="field-label">卖家账号<i aria-hidden="true">*</i></span>
                      <input
                        required
                        disabled={mappingSaving}
                        value={mappingForm.sellerAccount}
                        onChange={(event) => setMappingForm((current) => ({
                          ...current,
                          sellerAccount: event.target.value,
                        }))}
                      />
                    </label>
                  )}
                </>
              )}
              {mappingEditor.kind !== 'create' && (
                <label className="field">
                  <span className="field-label">映射变更原因<i aria-hidden="true">*</i></span>
                  <input
                    required
                    disabled={mappingSaving}
                    value={mappingForm.reason}
                    onChange={(event) => setMappingForm((current) => ({
                      ...current,
                      reason: event.target.value,
                    }))}
                  />
                </label>
              )}
              <div className="form-actions">
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={mappingSaving}
                  onClick={() => setMappingEditor(null)}
                >
                  取消
                </button>
                <button className="button button--primary" type="submit" disabled={mappingSaving}>
                  {mappingSaving
                    ? '正在保存…'
                    : mappingEditor.kind === 'create'
                      ? '建立映射'
                      : mappingEditor.kind === 'correct'
                        ? '保存更正'
                        : mappingEditor.kind === 'disable'
                          ? '确认停用'
                          : '确认删除'}
                </button>
              </div>
            </form>
          )}

          {mappingFeedback && (
            <p
              className={`fields-feedback fields-feedback--${mappingFeedback.kind}`}
              role={mappingFeedback.kind === 'error' ? 'alert' : 'status'}
            >
              {mappingFeedback.message}
            </p>
          )}

          {mappings.length === 0 ? (
            <div className="fields-empty">
              <strong>没有符合条件的商品映射</strong>
              <p>新增映射后，以后识别到相同原文的订单商品会自动关联到当前标准商品。</p>
            </div>
          ) : (
            <div className="field-definition-list">
              {mappings.map((mapping) => (
                <article className="field-definition-card" key={mapping.id}>
                  <div>
                    <strong>{mapping.sourceTitle}</strong>
                    <span>{mapping.sourceSpec || '无规格'}</span>
                  </div>
                  <div className="field-definition-card__meta">
                    <span>匹配值 {mapping.sourceTitleKey} / {mapping.sourceSpecKey}</span>
                    <span>目标 {mapping.targetProductSku} · {mapping.targetProductName}</span>
                    <span>{mappingScopeLabel(mapping)}</span>
                    <span>{mappingOriginLabel(mapping.origin)}</span>
                    <span>建立时间 {mapping.createdAt.slice(0, 10)}</span>
                    <span>
                      最近使用 {mapping.lastUsedAt ? mapping.lastUsedAt.slice(0, 10) : '从未使用'}
                    </span>
                    <span>命中订单数 {mapping.hitOrderCount}</span>
                    <span>{mapping.status === 'active' ? '有效' : '已停用'}</span>
                  </div>
                  <div className="form-actions">
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={mappingSaving}
                      aria-label={`查看映射 ${mapping.sourceTitle} 的关联订单`}
                      onClick={() => onOpenLinkedOrderItems({
                        sourceTitle: mapping.sourceTitle,
                        sourceSpec: mapping.sourceSpec,
                      })}
                    >
                      关联订单
                    </button>
                    {mapping.status === 'active' && (
                      <>
                        <button
                          className="button button--quiet"
                          type="button"
                          disabled={mappingSaving}
                          aria-label={`更正映射 ${mapping.sourceTitle}`}
                          onClick={() => beginMappingEditor({ kind: 'correct', mapping })}
                        >
                          更正
                        </button>
                        <button
                          className="button button--quiet"
                          type="button"
                          disabled={mappingSaving}
                          aria-label={`停用映射 ${mapping.sourceTitle}`}
                          onClick={() => beginMappingEditor({ kind: 'disable', mapping })}
                        >
                          停用
                        </button>
                      </>
                    )}
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={mappingSaving}
                      aria-label={`删除映射 ${mapping.sourceTitle}`}
                      onClick={() => beginMappingEditor({ kind: 'delete', mapping })}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {mappingEvents.length > 0 && (
            <div className="field-definition-list" aria-label="商品映射变更记录">
              <strong>变更记录</strong>
              {mappingEvents.map((event) => (
                <article className="field-definition-card" key={event.id}>
                  <div>
                    <strong>{mappingEventTypeLabel(event.eventType)}</strong>
                    <span>{event.after?.sourceTitle ?? event.before?.sourceTitle ?? ''}</span>
                  </div>
                  <div className="field-definition-card__meta">
                    <span>{mappingOriginLabel(event.origin)}</span>
                    <span>时间 {event.occurredAt.slice(0, 19).replace('T', ' ')}</span>
                    {event.reason && <span>原因 {event.reason}</span>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </section>
  );
}

function mappingScopeLabel(mapping: ProductMappingView): string {
  if (mapping.scope === 'current_account') {
    return `当前平台与卖家账号：${mapping.platform ?? ''} / ${mapping.sellerAccount ?? ''}`;
  }
  if (mapping.scope === 'current_platform') {
    return `当前平台全部账号：${mapping.platform ?? ''}`;
  }
  return '整个工作区';
}

function mappingOriginLabel(origin: ProductMappingOrigin): string {
  return origin === 'confirmation' ? '关联确认建立' : '手工新增';
}

function mappingEventTypeLabel(eventType: ProductMappingEvent['eventType']): string {
  if (eventType === 'created') return '建立';
  if (eventType === 'corrected') return '更正';
  if (eventType === 'disabled') return '停用';
  return '删除';
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

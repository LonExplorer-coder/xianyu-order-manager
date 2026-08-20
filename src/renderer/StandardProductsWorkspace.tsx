import { useEffect, useState, type FormEvent } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import type {
  ProductCatalogColumnMapping,
  ProductCatalogDuplicateSkuResolution,
  ProductCatalogImportPreview,
  ProductCatalogWorkbookInspection,
} from '../core/product-catalog';
import type {
  ProductMappingEvent,
  ProductMappingHistoryCandidatePreview,
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

/** 规格 4.5/4.6：历史候选批量更正，必须先独立预览再带原因确认。 */
type HistoryCorrectionEditor =
  | { kind: 'previewing'; mapping: ProductMappingView }
  | { kind: 'ready'; mapping: ProductMappingView; preview: ProductMappingHistoryCandidatePreview }
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

type CatalogImportEditor = {
  sessionId: string;
  fileName: string;
  inspection: ProductCatalogWorkbookInspection;
  columnMapping: ProductCatalogColumnMapping;
  duplicateSkuResolutions: ProductCatalogDuplicateSkuResolution[];
  mappingUpdateReason: string;
  preview: ProductCatalogImportPreview | null;
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
  const [historyEditor, setHistoryEditor] = useState<HistoryCorrectionEditor>(null);
  const [historySelectedIds, setHistorySelectedIds] = useState<Set<string>>(new Set());
  const [historyReason, setHistoryReason] = useState('');
  const [historySaving, setHistorySaving] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [catalogImport, setCatalogImport] = useState<CatalogImportEditor | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);

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
    setHistoryEditor(null);
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

  function beginHistoryCorrection(mapping: ProductMappingView) {
    setMappingFeedback(null);
    setMappingEditor(null);
    setHistoryError('');
    setHistoryReason('');
    setHistorySaving(false);
    setHistoryEditor({ kind: 'previewing', mapping });
    void api.previewProductMappingHistoryCandidates(mapping.id)
      .then((preview) => {
        setHistoryEditor({ kind: 'ready', mapping, preview });
        setHistorySelectedIds(new Set(preview.items.map((item) => item.itemId)));
      })
      .catch((error: unknown) => {
        setHistoryEditor(null);
        setMappingFeedback({ kind: 'error', message: errorMessage(error) });
      });
  }

  function toggleHistoryCandidate(itemId: string, checked: boolean) {
    setHistorySelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(itemId); else next.delete(itemId);
      return next;
    });
  }

  async function submitHistoryCorrection() {
    if (historyEditor?.kind !== 'ready' || historySaving) return;
    const reason = historyReason.trim();
    if (!reason) {
      setHistoryError('商品身份更正必须填写原因');
      return;
    }
    const selectedItems = historyEditor.preview.items
      .filter((item) => historySelectedIds.has(item.itemId));
    if (selectedItems.length === 0) {
      setHistoryError('请至少选择一条商品明细');
      return;
    }
    const expectedOrderRevisions = [...new Map(
      selectedItems.map((item) => [item.orderId, item.orderRevision] as const),
    ).entries()].map(([orderId, revision]) => ({ orderId, revision }));
    setHistorySaving(true);
    setHistoryError('');
    try {
      const result = await api.relinkProductMappingHistoryCandidates(
        historyEditor.mapping.id,
        {
          itemIds: selectedItems.map((item) => item.itemId),
          reason,
          expectedOrderRevisions,
        },
      );
      setHistoryEditor(null);
      setMappingFeedback({
        kind: 'success',
        message: `已更正 ${result.appliedItemCount} 条商品明细的商品身份；来源原文、数量与业务事实保持不变。`,
      });
      if (editing) await refreshMappings(editing.id);
    } catch (error) {
      setHistoryError(errorMessage(error));
    } finally {
      setHistorySaving(false);
    }
  }

  async function selectCatalogImport() {
    if (catalogBusy) return;
    setCatalogBusy(true);
    setFeedback(null);
    try {
      const selected = await api.selectProductCatalogImport();
      if (selected.kind === 'canceled') return;
      const editor: CatalogImportEditor = {
        sessionId: selected.sessionId,
        fileName: selected.fileName,
        inspection: selected.inspection,
        columnMapping: selected.inspection.suggestedColumnMapping,
        duplicateSkuResolutions: [],
        mappingUpdateReason: '',
        preview: null,
      };
      const preview = await api.previewProductCatalogImport(selected.sessionId, {
        columnMapping: editor.columnMapping,
        duplicateSkuResolutions: [],
      });
      setCatalogImport({ ...editor, preview });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setCatalogBusy(false);
    }
  }

  async function exportCatalog() {
    if (catalogBusy) return;
    setCatalogBusy(true);
    setFeedback(null);
    try {
      const outcome = await api.exportProductCatalog();
      if (outcome.kind === 'saved') {
        setFeedback({ kind: 'success', message: `商品目录已导出：${outcome.fileName}` });
      }
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setCatalogBusy(false);
    }
  }

  function updateCatalogColumnMapping(
    update: (current: ProductCatalogColumnMapping) => ProductCatalogColumnMapping,
  ) {
    setCatalogImport((current) => current ? {
      ...current,
      columnMapping: update(current.columnMapping),
      duplicateSkuResolutions: [],
      mappingUpdateReason: '',
      preview: null,
    } : current);
  }

  async function previewCatalogImport(
    duplicateSkuResolutions?: ProductCatalogDuplicateSkuResolution[],
  ) {
    if (!catalogImport || catalogBusy) return;
    const resolutions = duplicateSkuResolutions ?? catalogImport.duplicateSkuResolutions;
    setCatalogBusy(true);
    setFeedback(null);
    try {
      const preview = await api.previewProductCatalogImport(catalogImport.sessionId, {
        columnMapping: catalogImport.columnMapping,
        duplicateSkuResolutions: resolutions,
      });
      setCatalogImport((current) => current?.sessionId === catalogImport.sessionId
        ? { ...current, duplicateSkuResolutions: resolutions, preview }
        : current);
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setCatalogBusy(false);
    }
  }

  async function selectDuplicateSkuRow(skuKey: string, selectedRowNumber: number) {
    if (!catalogImport) return;
    const next = [
      ...catalogImport.duplicateSkuResolutions.filter((entry) => entry.skuKey !== skuKey),
      { skuKey, selectedRowNumber },
    ];
    await previewCatalogImport(next);
  }

  async function confirmCatalogImport() {
    if (!catalogImport?.preview || catalogBusy) return;
    if (catalogImport.preview.duplicateSkus.some(({ selectedRowNumber }) => (
      selectedRowNumber === null
    ))) return;
    setCatalogBusy(true);
    setFeedback(null);
    try {
      const result = await api.confirmProductCatalogImport(catalogImport.sessionId, {
        columnMapping: catalogImport.columnMapping,
        duplicateSkuResolutions: catalogImport.duplicateSkuResolutions,
        previewToken: catalogImport.preview.previewToken,
        mappingUpdateReason: catalogImport.mappingUpdateReason,
      });
      setHistoryEditor(null);
      setHistorySelectedIds(new Set());
      setHistoryReason('');
      setHistoryError('');
      setMappingEditor(null);
      setMappings([]);
      setMappingStats(null);
      setMappingEvents([]);
      const refreshedProducts = await api.listStandardProducts();
      setProducts(refreshedProducts);
      if (editing) {
        const refreshedEditing = refreshedProducts.find(({ id }) => id === editing.id);
        if (refreshedEditing) {
          beginEdit(refreshedEditing);
          await refreshMappings(refreshedEditing.id);
        } else {
          resetForm();
        }
      }
      setCatalogImport(null);
      setFeedback({
        kind: 'success',
        message: `商品目录已确认：已新增 ${result.createdProductCount} 个标准商品，更新 ${result.updatedProductCount} 个；新增 ${result.createdMappingCount} 条商品映射，更新 ${result.updatedMappingCount} 条；跳过 ${result.skippedErrorRowCount} 条错误行。`,
      });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setCatalogBusy(false);
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
        <div className="form-actions">
          <button
            className="button button--quiet"
            type="button"
            disabled={catalogBusy}
            onClick={() => void selectCatalogImport()}
          >
            {catalogBusy && !catalogImport ? '正在读取…' : '导入商品目录'}
          </button>
          <button
            className="button button--quiet"
            type="button"
            disabled={catalogBusy}
            onClick={() => void exportCatalog()}
          >
            导出商品目录
          </button>
        </div>
      </header>

      {catalogImport && (
        <section className="fields-panel" aria-label="商品目录导入预览">
          <div className="fields-panel__heading">
            <div>
              <span className="section-kicker">确认前预览</span>
              <h2>商品目录导入</h2>
              <p>{catalogImport.fileName}</p>
            </div>
            <button
              className="button button--quiet"
              type="button"
              disabled={catalogBusy}
              onClick={() => setCatalogImport(null)}
            >
              取消导入
            </button>
          </div>
          <p>先核对工作表与列映射；预览不会写入，确认后只应用有效行。</p>

          <div className="fields-layout">
            <div className="field-definition-card">
              <strong>标准商品列映射</strong>
              <label className="field">
                <span className="field-label">标准商品工作表</span>
                <select
                  aria-label="标准商品工作表"
                  disabled={catalogBusy}
                  value={catalogImport.columnMapping.productWorksheet}
                  onChange={(event) => updateCatalogColumnMapping((current) => ({
                    ...current,
                    productWorksheet: event.target.value,
                  }))}
                >
                  {catalogImport.inspection.worksheets.map((worksheet) => (
                    <option key={worksheet.name} value={worksheet.name}>{worksheet.name}</option>
                  ))}
                </select>
              </label>
              {([
                ['sku', 'SKU 列'],
                ['name', '标准商品名列'],
                ['specification', '标准规格列'],
              ] as const).map(([field, label]) => (
                <label className="field" key={field}>
                  <span className="field-label">{label}</span>
                  <select
                    aria-label={label}
                    disabled={catalogBusy}
                    value={catalogImport.columnMapping.productColumns[field]}
                    onChange={(event) => updateCatalogColumnMapping((current) => ({
                      ...current,
                      productColumns: {
                        ...current.productColumns,
                        [field]: Number(event.target.value),
                      },
                    }))}
                  >
                    {catalogWorksheetHeaders(
                      catalogImport.inspection,
                      catalogImport.columnMapping.productWorksheet,
                    ).map((header, index) => (
                      <option key={`${index + 1}-${header}`} value={index + 1}>
                        {index + 1} · {header || '未命名列'}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="field-definition-card">
              <strong>商品映射列映射</strong>
              <label className="field">
                <span className="field-label">商品映射工作表</span>
                <select
                  aria-label="商品映射工作表"
                  disabled={catalogBusy}
                  value={catalogImport.columnMapping.mappingWorksheet ?? ''}
                  onChange={(event) => updateCatalogColumnMapping((current) => ({
                    ...current,
                    mappingWorksheet: event.target.value || null,
                  }))}
                >
                  <option value="">不导入商品映射</option>
                  {catalogImport.inspection.worksheets.map((worksheet) => (
                    <option key={worksheet.name} value={worksheet.name}>{worksheet.name}</option>
                  ))}
                </select>
              </label>
              {catalogImport.columnMapping.mappingWorksheet && ([
                ['sku', '商品映射 SKU 列', false],
                ['sourceTitle', '原始商品标题列', false],
                ['sourceSpec', '原始规格列', true],
                ['scope', '适用范围列', true],
                ['platform', '平台列', true],
                ['sellerAccount', '卖家账号列', true],
              ] as const).map(([field, label, optional]) => (
                <label className="field" key={field}>
                  <span className="field-label">{label}</span>
                  <select
                    aria-label={label}
                    disabled={catalogBusy}
                    value={catalogImport.columnMapping.mappingColumns[field] ?? ''}
                    onChange={(event) => updateCatalogColumnMapping((current) => ({
                      ...current,
                      mappingColumns: {
                        ...current.mappingColumns,
                        [field]: event.target.value ? Number(event.target.value) : null,
                      },
                    }))}
                  >
                    {optional && <option value="">未提供</option>}
                    {catalogWorksheetHeaders(
                      catalogImport.inspection,
                      catalogImport.columnMapping.mappingWorksheet,
                    ).map((header, index) => (
                      <option key={`${index + 1}-${header}`} value={index + 1}>
                        {index + 1} · {header || '未命名列'}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          <div className="form-actions">
            <button
              className="button button--quiet"
              type="button"
              disabled={catalogBusy}
              onClick={() => void previewCatalogImport()}
            >
              {catalogBusy ? '正在预览…' : '按当前列映射重新预览'}
            </button>
          </div>

          {catalogImport.preview && (
            <>
              <div className="field-definition-card__meta" aria-label="商品目录导入统计">
                <span>新增标准商品 {catalogImport.preview.summary.createProductCount}</span>
                <span>更新标准商品 {catalogImport.preview.summary.updateProductCount}</span>
                <span>不变标准商品 {catalogImport.preview.summary.unchangedProductCount}</span>
                <span>新增商品映射 {catalogImport.preview.summary.createMappingCount}</span>
                <span>更新商品映射 {catalogImport.preview.summary.updateMappingCount}</span>
                <span>不变商品映射 {catalogImport.preview.summary.unchangedMappingCount}</span>
                <span>错误行 {catalogImport.preview.summary.errorRowCount}</span>
              </div>

              {catalogImport.preview.duplicateSkus.map((duplicate) => (
                <fieldset className="field-definition-card" key={duplicate.skuKey}>
                  <legend>重复 SKU {duplicate.skuKey}</legend>
                  <p>必须明确选择一行；其他重复行不会写入。</p>
                  {duplicate.rowNumbers.map((rowNumber) => {
                    const row = catalogImport.preview?.productRows.find((candidate) => (
                      candidate.rowNumber === rowNumber
                    ));
                    return (
                      <label className="fields-check-row" key={rowNumber}>
                        <input
                          type="radio"
                          name={`catalog-duplicate-${duplicate.skuKey}`}
                          disabled={catalogBusy}
                          checked={duplicate.selectedRowNumber === rowNumber}
                          onChange={() => void selectDuplicateSkuRow(duplicate.skuKey, rowNumber)}
                        />
                        <span>
                          保留第 {rowNumber} 行 · {row?.name || '未命名'} · {row?.specification || '无规格'}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              ))}

              <div className="field-definition-list" aria-label="标准商品导入行">
                {catalogImport.preview.productRows.map((row) => (
                  <article className="field-definition-card" key={row.rowNumber}>
                    <div>
                      <strong>第 {row.rowNumber} 行 · {row.sku || '无 SKU'}</strong>
                      <span>{row.name || '无商品名'} · {row.specification || '无规格'}</span>
                    </div>
                    <div className="field-definition-card__meta">
                      <span>{catalogProductActionLabel(row.action)}</span>
                      {row.errors.map((error) => <span key={error}>{error}</span>)}
                    </div>
                  </article>
                ))}
              </div>
              {catalogImport.preview.mappingRows.length > 0 && (
                <div className="field-definition-list" aria-label="商品映射导入行">
                  {catalogImport.preview.mappingRows.map((row) => (
                    <article className="field-definition-card" key={row.rowNumber}>
                      <div>
                        <strong>商品映射第 {row.rowNumber} 行 · {row.sku || '无 SKU'}</strong>
                        <span>{row.sourceTitle || '无原始商品标题'} / {row.sourceSpec || '无规格'}</span>
                      </div>
                      <div className="field-definition-card__meta">
                        <span>{catalogMappingActionLabel(row.action)}</span>
                        {row.errors.map((error) => <span key={error}>{error}</span>)}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {catalogImport.preview.summary.updateMappingCount > 0 && (
                <label className="field">
                  <span className="field-label">
                    商品映射更新原因
                    <i aria-hidden="true">*</i>
                  </span>
                  <input
                    aria-label="商品映射更新原因"
                    disabled={catalogBusy}
                    maxLength={500}
                    value={catalogImport.mappingUpdateReason}
                    onChange={(event) => setCatalogImport((current) => current ? {
                      ...current,
                      mappingUpdateReason: event.target.value,
                    } : current)}
                  />
                  <span>更改标题别名归属会留下商品映射变更事件。</span>
                </label>
              )}
              <div className="form-actions">
                <button
                  className="button button--primary"
                  type="button"
                  disabled={catalogBusy || catalogImport.preview.duplicateSkus.some(
                    ({ selectedRowNumber }) => selectedRowNumber === null,
                  ) || (
                    catalogImport.preview.summary.updateMappingCount > 0 &&
                    !catalogImport.mappingUpdateReason.trim()
                  )}
                  onClick={() => void confirmCatalogImport()}
                >
                  {catalogBusy ? '正在导入…' : '确认导入有效行'}
                </button>
              </div>
            </>
          )}
        </section>
      )}

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

          {historyEditor && (
            <section className="field-definition-card" aria-label="历史候选批量更正">
              {historyEditor.kind === 'previewing' ? (
                <span role="status">正在查找历史候选…</span>
              ) : historyEditor.preview.items.length === 0 ? (
                <div className="fields-empty">
                  <strong>没有需要更正的历史候选</strong>
                  <p>该映射的适用范围内，没有原文相同且当前关联到其他标准商品的订单商品明细。</p>
                </div>
              ) : (() => {
                // 规格 4.5：确认前显示的影响统计对应勾选后实际会更正的批次。
                const selectedItems = historyEditor.preview.items
                  .filter((item) => historySelectedIds.has(item.itemId));
                const selectedOrderIds = new Set(selectedItems.map((item) => item.orderId));
                const selectedShippedOrderIds = new Set(selectedItems
                  .filter((item) => item.shippedOrDelivered)
                  .map((item) => item.orderId));
                const selectedAftersalesOrderIds = new Set(selectedItems
                  .filter((item) => item.hasAftersales)
                  .map((item) => item.orderId));
                const totalQuantity = selectedItems
                  .reduce((total, item) => total + item.quantity, 0);
                return (
                <>
                  <div>
                    <strong>历史候选批量更正</strong>
                    <span>
                      “{historyEditor.preview.mapping.sourceTitle} / {historyEditor.preview.mapping.sourceSpec || '无规格'}”
                      的历史订单商品
                    </span>
                  </div>
                  <div className="field-definition-card__meta">
                    <span>
                      原关联 → 新关联：{[...new Set(selectedItems.map((item) => (
                        item.beforeStandardProductSku
                      )))].join('、') || '—'} → {historyEditor.preview.targetProduct.sku}
                    </span>
                    <span>
                      订单数量 {selectedOrderIds.size}
                      {' · '}商品明细数量 {selectedItems.length}
                      {' · '}商品总数量 {totalQuantity}
                    </span>
                    <span>
                      已发货订单 {selectedShippedOrderIds.size}
                      {' · '}存在售后订单 {selectedAftersalesOrderIds.size}
                    </span>
                    <span>
                      更正只改变商品身份归属；来源原文、数量、金额与发货、退款、补发等业务事实不变。
                    </span>
                    <span>本操作不调整未来库存与财务归类；如需归类更正，将来以独立的 SKU 归类更正记录处理。</span>
                  </div>
                  <div className="field-definition-list">
                    {historyEditor.preview.items.map((item) => (
                      <label className="fields-check-row" key={item.itemId}>
                        <input
                          type="checkbox"
                          disabled={historySaving}
                          checked={historySelectedIds.has(item.itemId)}
                          onChange={(event) => toggleHistoryCandidate(item.itemId, event.target.checked)}
                          aria-label={`更正订单 ${item.orderNumber} 第 ${item.position + 1} 件商品 ${item.beforeStandardProductSku} 为 ${historyEditor.preview.targetProduct.sku}`}
                        />
                        <span>
                          订单 {item.orderNumber}：{item.beforeStandardProductSku} → {historyEditor.preview.targetProduct.sku}
                          {' · '}数量 {item.quantity}
                          {item.shippedOrDelivered ? ' · 已发货' : ''}
                          {item.hasAftersales ? ' · 存在售后' : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                  <label className="field">
                    <span className="field-label">更正原因<i aria-hidden="true">*</i></span>
                    <input
                      required
                      disabled={historySaving}
                      value={historyReason}
                      aria-label="商品身份更正原因"
                      onChange={(event) => setHistoryReason(event.target.value)}
                    />
                  </label>
                  {historyError && <p className="field-error" role="alert">{historyError}</p>}
                  <div className="form-actions">
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={historySaving}
                      onClick={() => setHistoryEditor(null)}
                    >
                      取消
                    </button>
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={historySaving}
                      onClick={() => void submitHistoryCorrection()}
                    >
                      {historySaving ? '正在更正…' : '确认更正商品身份'}
                    </button>
                  </div>
                </>
                );
              })()}
            </section>
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
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={mappingSaving}
                      aria-label={`查看映射 ${mapping.sourceTitle} 的历史候选`}
                      onClick={() => beginHistoryCorrection(mapping)}
                    >
                      历史候选
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

function catalogWorksheetHeaders(
  inspection: ProductCatalogWorkbookInspection,
  worksheetName: string | null,
): string[] {
  if (!worksheetName) return [];
  return inspection.worksheets.find(({ name }) => name === worksheetName)?.headers ?? [];
}

function catalogProductActionLabel(
  action: ProductCatalogImportPreview['productRows'][number]['action'],
): string {
  if (action === 'create') return '候选新增';
  if (action === 'update') return '候选更新';
  if (action === 'unchanged') return '内容不变';
  if (action === 'duplicate') return '重复 SKU 待选择';
  return '错误行';
}

function catalogMappingActionLabel(
  action: ProductCatalogImportPreview['mappingRows'][number]['action'],
): string {
  if (action === 'create') return '候选新增';
  if (action === 'update') return '候选更新';
  if (action === 'unchanged') return '内容不变';
  return '错误行';
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

import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { CustomFieldDefinition } from '../core/custom-fields';
import type { OrderItemWorkbenchQuery, OrderWorkbenchQuery } from '../core/order-workbench';
import {
  availableTableFields,
  fieldReferenceKey,
  type CreateTableTemplateInput,
  type TableTemplate,
  type TableTemplateColumn,
  type TableTemplateGranularity,
  type UpdateTableTemplateInput,
} from '../core/table-templates';

export type TableTemplatesWorkspaceProps = {
  templates: TableTemplate[];
  customFieldDefinitions: CustomFieldDefinition[];
  orderQuery: OrderWorkbenchQuery;
  orderItemQuery: OrderItemWorkbenchQuery;
  loading: boolean;
  error: string;
  saving: boolean;
  onCreate: (input: CreateTableTemplateInput) => void | Promise<void>;
  onUpdate: (templateId: string, input: UpdateTableTemplateInput) => void | Promise<void>;
  onDelete: (templateId: string) => void | Promise<void>;
  onApply: (template: TableTemplate) => void;
};

type TemplateDraft = {
  name: string;
  granularity: TableTemplateGranularity;
  columns: TableTemplateColumn[];
  query: OrderWorkbenchQuery | OrderItemWorkbenchQuery;
};

const DEFAULT_FIELD_KEYS: Record<TableTemplateGranularity, string[]> = {
  order: [
    'builtin:order_number',
    'builtin:buyer_nickname',
    'builtin:recipient',
    'builtin:product_summary',
    'computed:item_quantity_total',
    'computed:order_total',
    'builtin:fulfillment_status',
    'builtin:ordered_at',
  ],
  order_item: [
    'builtin:order_number',
    'builtin:product_title',
    'builtin:product_spec',
    'builtin:unit_price',
    'builtin:quantity',
    'builtin:quantity_source',
    'computed:item_subtotal',
  ],
};

export function TableTemplatesWorkspace(props: TableTemplatesWorkspaceProps) {
  const [libraryGranularity, setLibraryGranularity] = useState<TableTemplateGranularity>('order');
  const [draft, setDraft] = useState<TemplateDraft>(() => newDraft(
    'order',
    props.customFieldDefinitions,
    props.orderQuery,
  ));
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TableTemplate | null>(null);
  const [feedback, setFeedback] = useState('');
  const newTemplateButtonRef = useRef<HTMLButtonElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const savingRef = useRef(props.saving);
  const availableFields = availableTableFields(draft.granularity, props.customFieldDefinitions);
  const selectedFieldKeys = new Set(
    draft.columns.map(({ field }) => fieldReferenceKey(field)),
  );
  const visibleTemplates = props.templates.filter(
    ({ granularity }) => granularity === libraryGranularity,
  );
  const showBuiltInOrderItemDefault = libraryGranularity === 'order_item' &&
    visibleTemplates.length === 0;

  useEffect(() => {
    savingRef.current = props.saving;
  }, [props.saving]);

  useEffect(() => {
    if (!pendingDelete) return undefined;
    cancelDeleteButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) {
        event.preventDefault();
        setPendingDelete(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = deleteDialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const returnTarget = deleteReturnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
      else newTemplateButtonRef.current?.focus();
    };
  }, [pendingDelete?.id]);

  function changeGranularity(granularity: TableTemplateGranularity) {
    const query = granularity === 'order' ? props.orderQuery : props.orderItemQuery;
    setLibraryGranularity(granularity);
    setDraft((current) => ({
      ...newDraft(granularity, props.customFieldDefinitions, query),
      name: current.name,
    }));
    setFeedback('');
  }

  function openTemplateLibrary(granularity: TableTemplateGranularity) {
    const query = granularity === 'order' ? props.orderQuery : props.orderItemQuery;
    setLibraryGranularity(granularity);
    setEditingTemplateId(null);
    setDraft(newDraft(granularity, props.customFieldDefinitions, query));
    setFeedback('');
  }

  function startNewTemplate() {
    setEditingTemplateId(null);
    const query = libraryGranularity === 'order' ? props.orderQuery : props.orderItemQuery;
    setDraft(newDraft(libraryGranularity, props.customFieldDefinitions, query));
    setFeedback('');
  }

  function copyBuiltInOrderItemTemplate() {
    setLibraryGranularity('order_item');
    setEditingTemplateId(null);
    setDraft({
      ...newDraft('order_item', props.customFieldDefinitions, props.orderItemQuery),
      name: '商品明细默认模板副本',
    });
    setFeedback('已复制内置默认模板；保存后才会创建用户模板。');
  }

  function editTemplate(template: TableTemplate) {
    setLibraryGranularity(template.granularity);
    setEditingTemplateId(template.id);
    setDraft({
      name: template.name,
      granularity: template.granularity,
      columns: cloneColumns(template.columns),
      query: cloneQuery(template.query),
    });
    setFeedback('');
  }

  function captureCurrentQuery() {
    const currentQuery = draft.granularity === 'order'
      ? props.orderQuery
      : props.orderItemQuery;
    setDraft((current) => ({ ...current, query: cloneQuery(currentQuery) }));
    setFeedback('已用当前筛选和排序更新模板草稿。');
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback('');
    try {
      const input: CreateTableTemplateInput = draft.granularity === 'order'
        ? {
            name: draft.name,
            granularity: 'order',
            columns: cloneColumns(draft.columns),
            query: cloneQuery(draft.query as OrderWorkbenchQuery),
          }
        : {
            name: draft.name,
            granularity: 'order_item',
            columns: cloneColumns(draft.columns),
            query: cloneQuery(draft.query as OrderItemWorkbenchQuery),
          };
      if (editingTemplateId) {
        const update: UpdateTableTemplateInput = {
          name: input.name,
          columns: input.columns,
          query: input.query,
        };
        await props.onUpdate(editingTemplateId, update);
        setFeedback('模板修改已保存。');
      } else {
        await props.onCreate(input);
        setFeedback('模板已创建。');
      }
    } catch (error) {
      setFeedback(errorMessage(error));
    }
  }

  function toggleField(fieldKey: string, selected: boolean) {
    const available = availableFields.find(
      ({ reference }) => fieldReferenceKey(reference) === fieldKey,
    );
    if (!available) return;
    setDraft((current) => ({
      ...current,
      columns: selected
        ? [
            ...current.columns,
            { field: { ...available.reference }, displayName: available.defaultLabel },
          ]
        : current.columns.filter(({ field }) => fieldReferenceKey(field) !== fieldKey),
    }));
    setFeedback('');
  }

  function renameColumn(index: number, displayName: string) {
    setDraft((current) => ({
      ...current,
      columns: current.columns.map((column, columnIndex) => (
        columnIndex === index ? { ...column, displayName } : column
      )),
    }));
  }

  function moveColumn(index: number, offset: -1 | 1) {
    setDraft((current) => {
      const nextIndex = index + offset;
      if (nextIndex < 0 || nextIndex >= current.columns.length) return current;
      const columns = [...current.columns];
      [columns[index], columns[nextIndex]] = [columns[nextIndex], columns[index]];
      return { ...current, columns };
    });
  }

  async function deleteTemplate() {
    if (!pendingDelete) return;
    setFeedback('');
    try {
      await props.onDelete(pendingDelete.id);
      if (editingTemplateId === pendingDelete.id) startNewTemplate();
      setPendingDelete(null);
    } catch (error) {
      setFeedback(errorMessage(error));
    }
  }

  return (
    <section className="table-template-workspace workspace-enter">
      <header className="workspace-header">
        <div>
          <span className="section-kicker">视图配置</span>
          <h1>表格模板</h1>
          <p>保存字段、列名、顺序以及当前筛选排序，下次可直接恢复。</p>
        </div>
      </header>

      {props.error && <p className="template-feedback template-feedback--error" role="alert">{props.error}</p>}

      <div className="workspace-view-switch" role="tablist" aria-label="模板类型">
        <button
          type="button"
          role="tab"
          aria-selected={libraryGranularity === 'order'}
          className={libraryGranularity === 'order' ? 'is-active' : ''}
          onClick={() => openTemplateLibrary('order')}
        >
          订单总表模板
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={libraryGranularity === 'order_item'}
          className={libraryGranularity === 'order_item' ? 'is-active' : ''}
          onClick={() => openTemplateLibrary('order_item')}
        >
          商品明细表模板
        </button>
      </div>

      <div className="table-template-layout">
        <section className="template-library" aria-labelledby="template-library-heading">
          <div className="template-panel-heading">
            <div>
              <span className="section-kicker">已保存</span>
              <h2 id="template-library-heading">
                {granularityLabel(libraryGranularity)} · {visibleTemplates.length} 套用户模板
              </h2>
            </div>
            {props.loading ? (
              <span role="status">正在读取…</span>
            ) : (
              <button
                ref={newTemplateButtonRef}
                className="button button--quiet"
                type="button"
                onClick={startNewTemplate}
              >
                新建模板
              </button>
            )}
          </div>
          {!props.loading && showBuiltInOrderItemDefault ? (
            <article
              className="template-card"
              aria-label="内置商品明细默认模板"
            >
              <strong>内置商品明细默认模板</strong>
              <span>商品明细 · {DEFAULT_FIELD_KEYS.order_item.length} 列 · 只读</span>
              <p>由系统维护，不会在工作区中创建或删除。</p>
              <div className="template-card__actions">
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={props.saving}
                  aria-label="复制内置商品明细默认模板"
                  onClick={copyBuiltInOrderItemTemplate}
                >
                  复制后编辑
                </button>
              </div>
            </article>
          ) : !props.loading && visibleTemplates.length === 0 ? (
            <div className="template-empty">
              <strong>还没有{granularityLabel(libraryGranularity)}用户模板</strong>
              <p>从右侧创建第一套，当前筛选和排序会一起保存。</p>
            </div>
          ) : (
            <div className="template-list">
              {visibleTemplates.map((template) => (
                <article className="template-card" key={template.id}>
                  <strong>{template.name}</strong>
                  <span>{granularityLabel(template.granularity)} · {template.columns.length} 列</span>
                  <div className="template-card__actions">
                    <button
                      className="button button--quiet"
                      type="button"
                      aria-label={`应用 ${template.name}`}
                      disabled={props.saving}
                      onClick={() => props.onApply(template)}
                    >
                      应用
                    </button>
                    <button
                      className="button button--quiet"
                      type="button"
                      aria-label={`编辑 ${template.name}`}
                      disabled={props.saving}
                      onClick={() => editTemplate(template)}
                    >
                      编辑
                    </button>
                    <button
                      className="button button--quiet template-delete-button"
                      type="button"
                      aria-label={`删除 ${template.name}`}
                      disabled={props.saving}
                      onClick={(event) => {
                        deleteReturnFocusRef.current = event.currentTarget;
                        setPendingDelete(template);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <form
          className="template-editor"
          aria-label={editingTemplateId ? '编辑表格模板' : '创建表格模板'}
          onSubmit={(event) => void saveTemplate(event)}
        >
          <div className="template-panel-heading">
            <div>
              <span className="section-kicker">{editingTemplateId ? '编辑中' : '新模板'}</span>
              <h2>{editingTemplateId ? '编辑模板' : '创建模板'}</h2>
            </div>
          </div>

          <label className="template-field">
            <span>模板名称</span>
            <input
              aria-label="模板名称"
              required
              value={draft.name}
              placeholder="例如：待发货清单"
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>

          <label className="template-field">
            <span>数据粒度</span>
            <select
              aria-label="数据粒度"
              disabled={editingTemplateId !== null}
              value={draft.granularity}
              onChange={(event) => changeGranularity(event.target.value as TableTemplateGranularity)}
            >
              <option value="order">订单总表模板</option>
              <option value="order_item">商品明细表模板</option>
            </select>
          </label>

          <div className="template-captured-query">
            <span>
              <strong>已捕获的筛选排序</strong>
              <small>{querySummary(draft.query)}</small>
            </span>
            <button
              className="button button--quiet"
              type="button"
              onClick={captureCurrentQuery}
            >
              用当前筛选排序覆盖
            </button>
          </div>

          <fieldset className="template-field-picker">
            <div className="template-field-picker__heading">
              <legend>选择字段</legend>
              <button
                className="button button--quiet"
                type="button"
                disabled={draft.columns.length === 0}
                onClick={() => setDraft((current) => ({ ...current, columns: [] }))}
              >
                清空全部字段
              </button>
            </div>
            <p>可选系统字段、当前粒度自定义字段与受控计算字段。</p>
            <div className="template-field-options">
              {availableFields.map((field) => {
                const key = fieldReferenceKey(field.reference);
                return (
                  <label className="template-field-option" key={key}>
                    <input
                      type="checkbox"
                      aria-label={field.defaultLabel}
                      checked={selectedFieldKeys.has(key)}
                      onChange={(event) => toggleField(key, event.target.checked)}
                    />
                    <span>
                      <strong>{field.defaultLabel}</strong>
                      <small>{fieldKindLabel(field.reference.kind)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <section className="template-columns" aria-labelledby="template-columns-heading">
            <div className="template-columns__heading">
              <div>
                <strong id="template-columns-heading">已选 {draft.columns.length} 列</strong>
                <span>可修改表头并上下调整顺序。</span>
              </div>
            </div>
            {draft.columns.length === 0 ? (
              <p className="template-columns__empty" role="status">至少选择一个字段才能保存。</p>
            ) : (
              <ol className="template-column-list">
                {draft.columns.map((column, index) => {
                  const field = availableFields.find(
                    ({ reference }) => fieldReferenceKey(reference) === fieldReferenceKey(column.field),
                  );
                  const fieldLabel = field?.defaultLabel ?? column.displayName;
                  return (
                    <li className="template-column" key={fieldReferenceKey(column.field)}>
                      <span className="template-column__position">{index + 1}</span>
                      <label>
                        <span>{fieldLabel}列名</span>
                        <input
                          aria-label={`${fieldLabel}列名`}
                          required
                          value={column.displayName}
                          onChange={(event) => renameColumn(index, event.target.value)}
                        />
                      </label>
                      <div className="template-column__actions">
                        <button
                          className="button button--quiet"
                          type="button"
                          aria-label={`上移 ${fieldLabel}`}
                          disabled={index === 0}
                          onClick={() => moveColumn(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="button button--quiet"
                          type="button"
                          aria-label={`下移 ${fieldLabel}`}
                          disabled={index === draft.columns.length - 1}
                          onClick={() => moveColumn(index, 1)}
                        >
                          ↓
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {feedback && <p className="template-feedback" role="status">{feedback}</p>}
          <button
            className="button button--primary"
            type="submit"
            disabled={props.saving || draft.columns.length === 0 || draft.columns.some(({ displayName }) => !displayName.trim())}
          >
            {props.saving ? '正在保存…' : editingTemplateId ? '保存修改' : '创建模板'}
          </button>
        </form>
      </div>

      {pendingDelete && (
        <div
          ref={deleteDialogRef}
          className="template-confirm-backdrop"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="template-delete-heading"
          aria-describedby="template-delete-description"
        >
          <div className="template-confirm-dialog">
            <span className="section-kicker">不可撤销操作</span>
            <h2 id="template-delete-heading">确认删除模板</h2>
            <p id="template-delete-description">
              删除“{pendingDelete.name}”后，不会删除任何订单数据，但该表格配置无法恢复。
            </p>
            <div className="template-confirm-dialog__actions">
              <button
                ref={cancelDeleteButtonRef}
                className="button button--quiet"
                type="button"
                disabled={props.saving}
                onClick={() => setPendingDelete(null)}
              >
                取消删除
              </button>
              <button
                className="button template-delete-button"
                type="button"
                disabled={props.saving}
                onClick={() => void deleteTemplate()}
              >
                {props.saving ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function newDraft(
  granularity: TableTemplateGranularity,
  definitions: readonly CustomFieldDefinition[],
  query: OrderWorkbenchQuery | OrderItemWorkbenchQuery,
): TemplateDraft {
  const fields = availableTableFields(granularity, definitions);
  const preferred = new Set(DEFAULT_FIELD_KEYS[granularity]);
  let columns = fields
    .filter(({ reference }) => preferred.has(fieldReferenceKey(reference)))
    .map(({ reference, defaultLabel }): TableTemplateColumn => ({
      field: { ...reference },
      displayName: defaultLabel,
    }));
  if (columns.length === 0 && fields[0]) {
    columns = [{ field: { ...fields[0].reference }, displayName: fields[0].defaultLabel }];
  }
  return { name: '', granularity, columns, query: cloneQuery(query) };
}

function cloneColumns(columns: readonly TableTemplateColumn[]): TableTemplateColumn[] {
  return columns.map((column) => ({
    field: { ...column.field },
    displayName: column.displayName,
  }));
}

function cloneQuery<T extends OrderWorkbenchQuery | OrderItemWorkbenchQuery>(query: T): T {
  return structuredClone(query);
}

function querySummary(query: OrderWorkbenchQuery | OrderItemWorkbenchQuery): string {
  const count = Object.values(query).filter((value) => value !== undefined && value !== '').length;
  return count === 0 ? '无筛选，使用默认排序' : `${count} 项筛选或排序条件`;
}

function granularityLabel(granularity: TableTemplateGranularity): string {
  return granularity === 'order' ? '订单' : '商品明细';
}

function fieldKindLabel(kind: TableTemplateColumn['field']['kind']): string {
  if (kind === 'custom') return '自定义';
  if (kind === 'computed') return '受控计算';
  return '系统字段';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

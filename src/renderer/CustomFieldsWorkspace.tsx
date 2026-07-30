import { useState, type FormEvent } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition,
  CustomFieldGranularity,
  CustomFieldType,
  CustomFieldValue,
} from '../core/custom-fields';
import { isMissingCustomFieldValue } from '../core/custom-fields';
import { CustomFieldInput } from './CustomFieldInput';

export type CustomFieldsWorkspaceProps = {
  api: DesktopApi;
  definitions: CustomFieldDefinition[];
  loading: boolean;
  loadError: string;
  onRefresh: () => Promise<void>;
};

const TYPE_OPTIONS: Array<{ value: CustomFieldType; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'money', label: '金额' },
  { value: 'datetime', label: '日期时间' },
  { value: 'single_select', label: '单选' },
  { value: 'multi_select', label: '多选' },
  { value: 'checkbox', label: '复选框' },
];

export function CustomFieldsWorkspace({
  api,
  definitions,
  loading,
  loadError,
  onRefresh,
}: CustomFieldsWorkspaceProps) {
  const [name, setName] = useState('');
  const [granularity, setGranularity] = useState<CustomFieldGranularity>('order');
  const [type, setType] = useState<CustomFieldType>('text');
  const [required, setRequired] = useState(false);
  const [hasDefault, setHasDefault] = useState(false);
  const [defaultValue, setDefaultValue] = useState<CustomFieldValue | null>(null);
  const [defaultValueValid, setDefaultValueValid] = useState(true);
  const [optionsText, setOptionsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const options = parseOptions(optionsText);
  const draftDefinition: CustomFieldDefinition = {
    id: 'field-preview',
    name: defaultFieldLabel(type),
    granularity,
    type,
    required: false,
    defaultValue: null,
    options,
    createdAt: '',
    updatedAt: '',
  };

  function changeType(nextType: CustomFieldType) {
    setType(nextType);
    setHasDefault(false);
    setDefaultValue(null);
    setDefaultValueValid(true);
    if (nextType !== 'single_select' && nextType !== 'multi_select') {
      setOptionsText('');
    }
  }

  async function createField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (hasDefault && (
      isMissingCustomFieldValue(defaultValue) || !defaultValueValid
    )) {
      setFeedback({ kind: 'error', message: '请填写默认值，或取消“设置默认值”。' });
      return;
    }
    setSaving(true);
    try {
      const input: CreateCustomFieldDefinitionInput = {
        name,
        granularity,
        type,
        required,
        defaultValue: hasDefault ? defaultValue : null,
        options,
      };
      await api.createCustomFieldDefinition(input);
      await onRefresh();
      setName('');
      setRequired(false);
      setHasDefault(false);
      setDefaultValue(null);
      setDefaultValueValid(true);
      setOptionsText('');
      setFeedback({ kind: 'success', message: '字段已创建，可立即用于订单流程。' });
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
          <span className="section-kicker">业务字段配置</span>
          <h1>字段库</h1>
          <p>为订单或商品添加业务字段，字段值与平台订单事实分开保存。</p>
        </div>
      </header>

      <div className="fields-layout">
        <section className="fields-panel fields-panel--list" aria-labelledby="field-list-heading">
          <div className="fields-panel__heading">
            <div>
              <span className="section-kicker">当前字段</span>
              <h2 id="field-list-heading">{definitions.length} 个自定义字段</h2>
            </div>
            {loading && <span role="status">正在读取…</span>}
          </div>
          {loadError && <p className="fields-feedback fields-feedback--error" role="alert">{loadError}</p>}
          {!loading && definitions.length === 0 ? (
            <div className="fields-empty">
              <strong>还没有自定义字段</strong>
              <p>从右侧创建第一个字段，它会出现在校对、订单详情与查询中。</p>
            </div>
          ) : (
            <div className="field-definition-list">
              {definitions.map((definition) => (
                <article className="field-definition-card" key={definition.id}>
                  <div>
                    <strong>{definition.name}</strong>
                    <span>{granularityLabel(definition.granularity)}</span>
                  </div>
                  <div className="field-definition-card__meta">
                    <span>{customFieldTypeLabel(definition.type)}</span>
                    {definition.required && <span>必填</span>}
                    {definition.defaultValue !== null && <span>有默认值</span>}
                  </div>
                  {definition.options.length > 0 && (
                    <small>{definition.options.join(' · ')}</small>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <form className="fields-panel fields-panel--create" aria-label="创建自定义字段" onSubmit={(event) => void createField(event)}>
          <div className="fields-panel__heading">
            <div>
              <span className="section-kicker">新字段</span>
              <h2>创建字段</h2>
            </div>
          </div>

          {feedback?.kind === 'success' ? (
            <div className="fields-created">
              <p className="fields-feedback fields-feedback--success" role="status">
                {feedback.message}
              </p>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => setFeedback(null)}
              >
                继续创建字段
              </button>
            </div>
          ) : (
          <>
          <label className="field">
            <span className="field-label">字段名称<i aria-hidden="true">*</i></span>
            <input
              aria-label="字段名称"
              required
              value={name}
              placeholder="例如：客服备注"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <div className="field-grid field-grid--two">
            <label className="field">
              <span className="field-label">数据粒度</span>
              <select
                aria-label="数据粒度"
                value={granularity}
                onChange={(event) => setGranularity(event.target.value as CustomFieldGranularity)}
              >
                <option value="order">订单</option>
                <option value="order_item">商品</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">字段类型</span>
              <select
                aria-label="字段类型"
                value={type}
                onChange={(event) => changeType(event.target.value as CustomFieldType)}
              >
                {TYPE_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          {(type === 'single_select' || type === 'multi_select') && (
            <label className="field">
              <span className="field-label">可选项<small>每行或逗号分隔</small></span>
              <textarea
                aria-label="可选项"
                required
                rows={4}
                value={optionsText}
                placeholder={'待处理\n处理中\n已完成'}
                onChange={(event) => setOptionsText(event.target.value)}
              />
            </label>
          )}

          <label className="fields-check-row">
            <input
              type="checkbox"
              checked={required}
              onChange={(event) => setRequired(event.target.checked)}
            />
            <span><strong>必填字段</strong><small>订单级必填且没有默认值时，自动入库会转为人工确认。</small></span>
          </label>

          <label className="fields-check-row">
            <input
              type="checkbox"
              checked={hasDefault}
              onChange={(event) => {
                setHasDefault(event.target.checked);
                if (!event.target.checked) setDefaultValue(null);
                if (event.target.checked && type === 'checkbox') setDefaultValue(false);
                setDefaultValueValid(true);
              }}
            />
            <span><strong>设置默认值</strong><small>创建后会应用到既有及后续订单或商品，可继续修改。</small></span>
          </label>

          {hasDefault && (
            <div className="field-default-editor">
              <CustomFieldInput
                definition={draftDefinition}
                value={defaultValue}
                label={type === 'checkbox' ? '默认勾选' : '默认值'}
                showRequired={false}
                onChange={setDefaultValue}
                onValidityChange={setDefaultValueValid}
              />
            </div>
          )}
          {!hasDefault && type === 'checkbox' && (
            <label className="custom-field custom-field--checkbox custom-field--disabled-preview">
              <input aria-label="默认勾选" type="checkbox" disabled />
              <span>默认勾选</span>
            </label>
          )}

          {feedback?.kind === 'error' && (
            <p
              className="fields-feedback fields-feedback--error"
              role="alert"
            >
              {feedback.message}
            </p>
          )}
          <button
            className="button button--primary"
            type="submit"
            disabled={saving || (hasDefault && (
              !defaultValueValid ||
              (defaultValue !== null && isMissingCustomFieldValue(defaultValue))
            ))}
          >
            {saving ? '正在创建…' : '创建字段'}
          </button>
          </>
          )}
        </form>
      </div>
    </section>
  );
}

export function customFieldTypeLabel(type: CustomFieldType): string {
  return TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

export function granularityLabel(granularity: CustomFieldGranularity): string {
  return granularity === 'order' ? '订单' : '商品';
}

function defaultFieldLabel(type: CustomFieldType): string {
  return type === 'checkbox' ? '默认勾选' : '默认值';
}

function parseOptions(value: string): string[] {
  return [...new Set(value.split(/[，,\n]/u).map((option) => option.trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

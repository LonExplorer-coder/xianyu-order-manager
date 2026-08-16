import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import {
  AFTERSALES_WORKFLOW_CONDITION_FACTS,
  AFTERSALES_WORKFLOW_FIELDS,
  AFTERSALES_WORKFLOW_STEP_KINDS,
  aftersalesWorkflowFieldLabel,
  type AftersalesWorkflowConditionFact,
  type AftersalesWorkflowScenario,
  type AftersalesWorkflowStep,
  type AftersalesWorkflowStepKind,
  type AftersalesWorkflowTemplate,
} from '../core/aftersales-workflow-templates';

import {
  DialogShell,
  EmptyState,
  InlineError,
} from './DialogShell';

type EditorState = {
  templateId: string | null;
  expectedVersion: number | null;
  name: string;
  scenario: AftersalesWorkflowScenario;
  steps: AftersalesWorkflowStep[];
};

export function AftersalesWorkflowTemplatesWorkspace({ api }: { api: DesktopApi }) {
  const [templates, setTemplates] = useState<AftersalesWorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      setTemplates(await api.listAftersalesWorkflowTemplates());
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [api]);

  async function toggleEnabled(template: AftersalesWorkflowTemplate): Promise<void> {
    setSavingId(template.id);
    setError('');
    try {
      const updated = await api.setAftersalesWorkflowTemplateEnabled(
        template.id,
        !template.enabled,
      );
      setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item));
      setFeedback(updated.enabled ? `已启用“${updated.name}”` : `已停用“${updated.name}”`);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSavingId('');
    }
  }

  function edit(template: AftersalesWorkflowTemplate): void {
    setEditor({
      templateId: template.id,
      expectedVersion: template.version,
      name: template.name,
      scenario: template.scenario,
      steps: cloneSteps(template.steps),
    });
    setFeedback('');
  }

  function copy(template: AftersalesWorkflowTemplate): void {
    setEditor({
      templateId: null,
      expectedVersion: null,
      name: `${template.name} 副本`,
      scenario: template.scenario,
      steps: cloneSteps(template.steps),
    });
    setFeedback('');
  }

  async function saveEditor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor) return;
    setSavingId(editor.templateId ?? 'new');
    setError('');
    try {
      const saved = editor.templateId && editor.expectedVersion
        ? await api.updateAftersalesWorkflowTemplate(editor.templateId, {
          expectedVersion: editor.expectedVersion,
          name: editor.name,
          scenario: editor.scenario,
          steps: editor.steps,
        })
        : await api.createAftersalesWorkflowTemplate({
          name: editor.name,
          scenario: editor.scenario,
          steps: editor.steps,
        });
      setEditor(null);
      setFeedback(`已保存“${saved.name}”版本 ${saved.version}`);
      await refresh();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSavingId('');
    }
  }

  return (
    <section className="aftersales-workflows-workspace workspace-enter">
      <header className="workspace-header">
        <div>
          <span className="section-kicker">售后处理·流程引导</span>
          <h1>售后流程</h1>
          <p>预置流程可直接停用或复制；自定义流程的每次保存都会形成新版本。</p>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={() => setEditor(blankEditor())}
        >
          新建自定义流程
        </button>
      </header>

      <InlineError message={error} />
      {feedback && <div className="settings-notice settings-notice--success" role="status">{feedback}</div>}
      {loading ? (
        <EmptyState title="正在读取售后流程…" status />
      ) : (
        <div className="aftersales-workflow-grid" aria-label="售后流程列表">
          {templates.map((template) => (
            <article
              className={`aftersales-workflow-card${template.enabled ? '' : ' is-disabled'}`}
              key={template.id}
            >
              <header>
                <div>
                  <span>{template.origin === 'system' ? '系统预置' : '自定义'}</span>
                  <h2>{template.name}</h2>
                </div>
                <span className="status-chip">{template.enabled ? '已启用' : '已停用'}</span>
              </header>
              <p>{scenarioLabel(template.scenario)} · 版本 {template.version} · {template.steps.length} 个步骤</p>
              <ol>
                {template.steps.map((step) => (
                  <li key={step.id}>
                    <span>{step.name}</span>
                    <small>{step.required ? '必需' : '可选'}{step.condition ? ' · 有条件' : ''}</small>
                  </li>
                ))}
              </ol>
              <footer>
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={savingId === template.id}
                  onClick={() => void toggleEnabled(template)}
                >
                  {template.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => copy(template)}
                >
                  复制并编辑
                </button>
                {template.origin === 'custom' && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => edit(template)}
                  >
                    编辑新版本
                  </button>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}

      {editor && (
        <WorkflowEditor
          value={editor}
          saving={savingId !== ''}
          onChange={setEditor}
          onSubmit={saveEditor}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
}

function WorkflowEditor({
  value,
  saving,
  onChange,
  onSubmit,
  onClose,
}: {
  value: EditorState;
  saving: boolean;
  onChange: (value: EditorState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const stepIds = useMemo(() => new Set(value.steps.map(({ id }) => id)), [value.steps]);
  function changeStep(index: number, step: AftersalesWorkflowStep): void {
    onChange({ ...value, steps: value.steps.map((current, position) => position === index ? step : current) });
  }
  function move(index: number, offset: number): void {
    const target = index + offset;
    if (target < 0 || target >= value.steps.length) return;
    const steps = [...value.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    onChange({ ...value, steps });
  }
  function addStep(): void {
    let suffix = value.steps.length + 1;
    while (stepIds.has(`step-${suffix}`)) suffix += 1;
    onChange({
      ...value,
      steps: [...value.steps, {
        id: `step-${suffix}`,
        kind: 'record_resolution',
        name: '新步骤',
        required: true,
        fields: ['occurred_at', 'reason'],
        condition: null,
      }],
    });
  }
  return (
    <DialogShell
      kicker="有限步骤·无循环脚本"
      title={value.templateId ? '编辑自定义流程' : '新建自定义流程'}
      dialogClassName="aftersales-workflow-editor"
      busy={saving}
      onClose={onClose}
      onSubmit={onSubmit}
    >
        <div className="aftersales-workflow-editor__identity">
          <label>
            <span>流程名称</span>
            <input value={value.name} disabled={saving} onChange={(event) => onChange({ ...value, name: event.target.value })} />
          </label>
          <label>
            <span>业务场景</span>
            <select value={value.scenario} disabled={saving} onChange={(event) => onChange({
              ...value,
              scenario: event.target.value as AftersalesWorkflowScenario,
            })}>
              {SCENARIOS.map((scenario) => <option key={scenario} value={scenario}>{scenarioLabel(scenario)}</option>)}
            </select>
          </label>
        </div>
        <div className="aftersales-workflow-editor__steps">
          {value.steps.map((step, index) => (
            <fieldset key={step.id}>
              <legend>步骤 {index + 1}</legend>
              <div className="aftersales-workflow-editor__step-head">
                <input
                  aria-label={`步骤 ${index + 1} 名称`}
                  value={step.name}
                  disabled={saving}
                  onChange={(event) => changeStep(index, { ...step, name: event.target.value })}
                />
                <select
                  aria-label={`步骤 ${index + 1} 类型`}
                  value={step.kind}
                  disabled={saving}
                  onChange={(event) => changeStep(index, {
                    ...step,
                    kind: event.target.value as AftersalesWorkflowStepKind,
                  })}
                >
                  {AFTERSALES_WORKFLOW_STEP_KINDS.map((kind) => (
                    <option key={kind} value={kind}>{stepKindLabel(kind)}</option>
                  ))}
                </select>
                <label className="compact-check">
                  <input
                    type="checkbox"
                    checked={step.required}
                    disabled={saving}
                    onChange={(event) => changeStep(index, { ...step, required: event.target.checked })}
                  />
                  必需步骤
                </label>
              </div>
              <div className="aftersales-workflow-editor__fields" aria-label={`步骤 ${index + 1} 字段要求`}>
                {AFTERSALES_WORKFLOW_FIELDS.map((field) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      checked={step.fields.includes(field)}
                      disabled={saving}
                      onChange={(event) => changeStep(index, {
                        ...step,
                        fields: event.target.checked
                          ? [...step.fields, field]
                          : step.fields.filter((candidate) => candidate !== field),
                      })}
                    />
                    {aftersalesWorkflowFieldLabel(field)}
                  </label>
                ))}
              </div>
              <div className="aftersales-workflow-editor__condition">
                <label>
                  <span>显示条件</span>
                  <select
                    value={step.condition?.fact ?? ''}
                    disabled={saving}
                    onChange={(event) => changeStep(index, {
                      ...step,
                      condition: event.target.value
                        ? { fact: event.target.value as AftersalesWorkflowConditionFact, equals: true }
                        : null,
                    })}
                  >
                    <option value="">无条件</option>
                    {AFTERSALES_WORKFLOW_CONDITION_FACTS.map((fact) => (
                      <option key={fact} value={fact}>{conditionLabel(fact)}</option>
                    ))}
                  </select>
                </label>
                {step.condition && (
                  <label>
                    <span>条件结果</span>
                    <select
                      value={step.condition.equals ? 'true' : 'false'}
                      disabled={saving}
                      onChange={(event) => changeStep(index, {
                        ...step,
                        condition: { ...step.condition!, equals: event.target.value === 'true' },
                      })}
                    >
                      <option value="true">成立时显示</option>
                      <option value="false">不成立时显示</option>
                    </select>
                  </label>
                )}
              </div>
              <div className="aftersales-workflow-editor__step-actions">
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={saving || index === 0}
                  onClick={() => move(index, -1)}
                >
                  上移
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={saving || index === value.steps.length - 1}
                  onClick={() => move(index, 1)}
                >
                  下移
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={saving || value.steps.length === 1}
                  onClick={() => onChange({ ...value, steps: value.steps.filter((_, position) => position !== index) })}
                >
                  删除步骤
                </button>
              </div>
            </fieldset>
          ))}
          <button
            className="button button--quiet"
            type="button"
            disabled={saving || value.steps.length >= 50}
            onClick={addStep}
          >
            +添加步骤
          </button>
        </div>
        <footer>
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
            disabled={saving || !value.name.trim() || value.steps.length === 0}
          >
            {saving ? '正在保存…' : '保存流程版本'}
          </button>
        </footer>
    </DialogShell>
  );
}

const SCENARIOS: AftersalesWorkflowScenario[] = [
  'refund_only', 'return_refund', 'exchange', 'direct_replacement',
  'intercept_return', 'lost_handling', 'other',
];

function blankEditor(): EditorState {
  return {
    templateId: null,
    expectedVersion: null,
    name: '',
    scenario: 'other',
    steps: [{
      id: 'identify-issue',
      kind: 'identify_issue',
      name: '确认问题与商品',
      required: true,
      fields: ['occurred_at', 'reason', 'items'],
      condition: null,
    }],
  };
}

function cloneSteps(steps: readonly AftersalesWorkflowStep[]): AftersalesWorkflowStep[] {
  return steps.map((step) => ({
    ...step,
    fields: [...step.fields],
    condition: step.condition ? { ...step.condition } : null,
  }));
}

function scenarioLabel(value: AftersalesWorkflowScenario): string {
  return ({
    refund_only: '仅退款',
    return_refund: '退货退款',
    exchange: '换货',
    direct_replacement: '直接补发',
    intercept_return: '拦截退回',
    lost_handling: '丢件处理',
    other: '其他处理',
  })[value];
}

function stepKindLabel(value: AftersalesWorkflowStepKind): string {
  return ({
    identify_issue: '确认问题', choose_resolution: '选择处理方案',
    request_interception: '申请拦截', register_return: '登记退货',
    receive_return: '确认收到退货', inspect_return: '检查退货',
    confirm_refund: '确认退款', prepare_replacement: '建立补发',
    confirm_replacement_delivery: '确认补发签收',
    resolve_logistics_exception: '处理物流异常',
    record_resolution: '记录处理结果', complete: '完成售后',
  })[value];
}

function conditionLabel(value: AftersalesWorkflowConditionFact): string {
  return ({
    refund_requested: '已有退款申请', return_registered: '已登记退货',
    replacement_required: '需要补发', interception_requested: '已申请拦截',
    logistics_exception_present: '存在物流异常',
  })[value];
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

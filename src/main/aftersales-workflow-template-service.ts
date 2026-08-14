import { randomUUID } from 'node:crypto';

import {
  SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES,
  aftersalesWorkflowForScenario,
  normalizeCopyAftersalesWorkflowTemplateInput,
  normalizeCreateAftersalesWorkflowTemplateInput,
  normalizeUpdateAftersalesWorkflowTemplateInput,
  parseStoredAftersalesWorkflowTemplateDefinition,
  type AftersalesWorkflowTemplate,
  type AftersalesWorkflowTemplateOrigin,
  type AftersalesWorkflowScenario,
  type CopyAftersalesWorkflowTemplateInput,
  type CreateAftersalesWorkflowTemplateInput,
  type UpdateAftersalesWorkflowTemplateInput,
} from '../core/aftersales-workflow-templates';
import { Workspace } from './workspace';

type TemplateRow = {
  id: string;
  origin: string;
  system_key: string | null;
  enabled: number;
  current_version: number;
  definition_json: string;
  created_at: string;
  updated_at: string;
  version_created_at: string;
};

export class AftersalesWorkflowTemplateService {
  public constructor(private readonly workspace: Workspace) {}

  public list(): AftersalesWorkflowTemplate[] {
    const rows = this.workspace.database.prepare(`
      SELECT
        templates.id,
        templates.origin,
        templates.system_key,
        templates.enabled,
        templates.current_version,
        versions.definition_json,
        templates.created_at,
        templates.updated_at,
        versions.created_at AS version_created_at
      FROM aftersales_workflow_templates AS templates
      JOIN aftersales_workflow_template_versions AS versions
        ON versions.template_id = templates.id
       AND versions.version = templates.current_version
      ORDER BY templates.created_at, templates.id
    `).all() as unknown as TemplateRow[];
    const systemOrder = new Map(SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES.map(
      (template, index) => [template.id, index] as const,
    ));
    return rows.map(templateFromRow).sort((left, right) => {
      const leftOrder = systemOrder.get(left.id);
      const rightOrder = systemOrder.get(right.id);
      if (leftOrder !== undefined || rightOrder !== undefined) {
        return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
      }
      return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
  }

  public getVersion(templateId: string, version: number): AftersalesWorkflowTemplate {
    if (typeof templateId !== 'string' || !templateId.trim()
      || !Number.isSafeInteger(version) || version < 1) {
      throw new Error('售后流程模板版本标识无效');
    }
    const row = this.workspace.database.prepare(`
      SELECT
        templates.id,
        templates.origin,
        templates.system_key,
        templates.enabled,
        ? AS current_version,
        versions.definition_json,
        templates.created_at,
        templates.updated_at,
        versions.created_at AS version_created_at
      FROM aftersales_workflow_templates AS templates
      JOIN aftersales_workflow_template_versions AS versions
        ON versions.template_id = templates.id
       AND versions.version = ?
      WHERE templates.id = ?
    `).get(version, version, templateId.trim()) as TemplateRow | undefined;
    if (!row) throw new Error('未找到售后流程模板版本');
    return templateFromRow(row);
  }

  public requireEnabledCurrent(templateId: string): AftersalesWorkflowTemplate {
    const template = this.requireTemplate(templateId);
    if (!template.enabled) throw new Error('所选售后流程已经停用');
    return template;
  }

  public setEnabled(templateId: string, enabled: boolean): AftersalesWorkflowTemplate {
    if (typeof templateId !== 'string' || !templateId.trim()) {
      throw new Error('售后流程模板标识无效');
    }
    if (typeof enabled !== 'boolean') throw new Error('售后流程启用状态无效');
    const result = this.workspace.database.prepare(`
      UPDATE aftersales_workflow_templates
      SET enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(enabled ? 1 : 0, new Date().toISOString(), templateId.trim());
    if (result.changes !== 1) throw new Error('未找到售后流程模板');
    return this.requireTemplate(templateId.trim());
  }

  public update(
    templateId: string,
    input: unknown,
  ): AftersalesWorkflowTemplate {
    const existing = this.requireTemplate(templateId);
    if (existing.origin === 'system') {
      throw new Error('系统预置售后流程不能修改，请复制后调整');
    }
    const definition = normalizeUpdateAftersalesWorkflowTemplateInput(input);
    if (definition.expectedVersion !== existing.version) {
      throw new Error('售后流程模板已在其他操作中更新，请刷新后重试');
    }
    const nextVersion = existing.version + 1;
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.assertNameAvailable(definition.name, existing.id);
      this.workspace.database.prepare(`
        INSERT INTO aftersales_workflow_template_versions (
          template_id, version, definition_json, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        existing.id,
        nextVersion,
        JSON.stringify({
          name: definition.name,
          scenario: definition.scenario,
          steps: definition.steps,
        }),
        now,
      );
      const result = this.workspace.database.prepare(`
        UPDATE aftersales_workflow_templates
        SET name_key = ?, current_version = ?, updated_at = ?
        WHERE id = ? AND current_version = ? AND origin = 'custom'
      `).run(
        templateNameKey(definition.name),
        nextVersion,
        now,
        existing.id,
        definition.expectedVersion,
      );
      if (result.changes !== 1) {
        throw new Error('售后流程模板已在其他操作中更新，请刷新后重试');
      }
    });
    return this.requireTemplate(existing.id);
  }

  public create(input: unknown): AftersalesWorkflowTemplate {
    const definition = normalizeCreateAftersalesWorkflowTemplateInput(input);
    return this.createCustom(definition);
  }

  public copy(input: unknown): AftersalesWorkflowTemplate {
    const prepared = normalizeCopyAftersalesWorkflowTemplateInput(input);
    const source = this.requireTemplate(prepared.sourceTemplateId);
    return this.createCustom({
      name: prepared.name,
      scenario: source.scenario,
      steps: source.steps,
    });
  }

  private createCustom(
    definition: CreateAftersalesWorkflowTemplateInput,
  ): AftersalesWorkflowTemplate {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      this.assertNameAvailable(definition.name);
      this.workspace.database.prepare(`
        INSERT INTO aftersales_workflow_templates (
          id, origin, system_key, name_key, enabled, current_version, created_at, updated_at
        ) VALUES (?, 'custom', NULL, ?, 1, 1, ?, ?)
      `).run(id, templateNameKey(definition.name), now, now);
      this.workspace.database.prepare(`
        INSERT INTO aftersales_workflow_template_versions (
          template_id, version, definition_json, created_at
        ) VALUES (?, 1, ?, ?)
      `).run(id, JSON.stringify(definition), now);
    });
    return this.requireTemplate(id);
  }

  private requireTemplate(templateId: string): AftersalesWorkflowTemplate {
    const template = this.list().find(({ id }) => id === templateId);
    if (!template) throw new Error('未找到售后流程模板');
    return template;
  }

  private assertNameAvailable(name: string, excludingId?: string): void {
    const duplicate = this.workspace.database.prepare(`
      SELECT id
      FROM aftersales_workflow_templates
      WHERE name_key = ?
        ${excludingId ? 'AND id <> ?' : ''}
      LIMIT 1
    `).get(templateNameKey(name), ...(excludingId ? [excludingId] : []));
    if (duplicate) throw new Error('售后流程名称已存在');
  }
}

function templateFromRow(row: TemplateRow): AftersalesWorkflowTemplate {
  const definition = parseStoredAftersalesWorkflowTemplateDefinition(row.definition_json);
  if (row.origin !== 'system' && row.origin !== 'custom') {
    throw new Error('售后流程模板来源无效');
  }
  return {
    id: row.id,
    origin: row.origin as AftersalesWorkflowTemplateOrigin,
    systemKey: row.system_key as AftersalesWorkflowScenario | null,
    enabled: row.enabled === 1,
    version: row.current_version,
    name: definition.name,
    scenario: definition.scenario,
    workflow: aftersalesWorkflowForScenario(definition.scenario),
    steps: definition.steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versionCreatedAt: row.version_created_at,
  };
}

function templateNameKey(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

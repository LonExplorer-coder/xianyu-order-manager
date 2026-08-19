import { useEffect, useState, type FormEvent } from 'react';

import type { OrderSummary } from '../core/contracts';
import type { DesktopApi } from '../core/desktop-api';
import {
  fulfillmentPlanDisplayStatus,
  fulfillmentPlanStatusLabel,
  fulfillmentPlanTodo,
  groupFormationBasisLabel,
  isGroupBuyFormationReady,
  isUnformedAwaitingRefund,
  isUnformedClosedGroupBuy,
  type FulfillmentPlanDisplayStatus,
  type FulfillmentPlanEventType,
  type FulfillmentPlanProgressView,
  type FulfillmentPlanType,
  type FulfillmentPlanView,
  type GroupFormationBasis,
} from '../core/fulfillment-plans';
import type { FulfillmentDemandView } from '../core/fulfillment-demand';
import {
  fulfillmentDemandAlerts,
  purchaseSuggestionStatusLabel,
} from '../core/fulfillment-demand';
import { shipmentLogisticsStatusLabel } from '../core/order-operations-projection';
import {
  ConfirmDangerDialog,
  DialogShell,
  EmptyState,
  InlineError,
  ReasonField,
} from './DialogShell';

type CreateFormState = {
  type: FulfillmentPlanType;
  name: string;
  expectedShipAt: string;
  targetQuantity: string;
  deadlineAt: string;
  demandAlertThreshold: string;
  reason: string;
};

type AddOrdersState = {
  planId: string;
  candidates: OrderSummary[];
  selected: Set<string>;
  reason: string;
  loading: boolean;
};

type DelayFormState = {
  planId: string;
  expectedShipAt: string;
  targetQuantity: string;
  deadlineAt: string;
  demandAlertThreshold: string;
  markDelayed: boolean;
  reason: string;
};

type RefundFormState = {
  planId: string;
  orderId: string;
  orderItemId: string;
  quantity: string;
  reason: string;
};

type SuggestionFormState = {
  planId: string;
  standardProductId: string;
  quantity: string;
  reason: string;
  acknowledgeRisk: boolean;
};

type FormationFormState = {
  planId: string;
  basis: GroupFormationBasis;
  reason: string;
};

type SuggestionPromptKind = 'confirm' | 'cancel';

type SuggestionPromptState = {
  kind: SuggestionPromptKind;
  planId: string;
  suggestionId: string;
  label: string;
  reason: string;
};

type ReasonPromptKind = 'release_all' | 'release_one' | 'remove';

type ReasonPromptState = {
  kind: ReasonPromptKind;
  planId: string;
  orderId: string | null;
  reason: string;
};

type ClosePromptState = {
  planId: string;
  reason: string;
};

const EVENT_TYPE_LABELS: Record<FulfillmentPlanEventType, string> = {
  created: '创建计划',
  orders_added: '加入订单',
  order_removed: '退出订单',
  orders_released: '释放订单',
  updated: '更新计划',
  delayed: '标记延期',
  formed: '确认成团',
  closed: '关闭计划',
};

const REASON_PROMPT_TITLES: Record<ReasonPromptKind, string> = {
  release_all: '释放全部订单',
  release_one: '释放订单',
  remove: '退出订单',
};

const REASON_PROMPT_CONFIRM: Record<ReasonPromptKind, string> = {
  release_all: '确认释放',
  release_one: '确认释放',
  remove: '确认退出',
};

export function FulfillmentPlansWorkspace({ api }: { api: DesktopApi }) {
  const [plans, setPlans] = useState<FulfillmentPlanView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CreateFormState>(blankCreateForm());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [progressByPlan, setProgressByPlan] = useState<Record<string, FulfillmentPlanProgressView>>({});
  const [demandByPlan, setDemandByPlan] = useState<Record<string, FulfillmentDemandView>>({});
  const [refundForm, setRefundForm] = useState<RefundFormState | null>(null);
  const [suggestionForm, setSuggestionForm] = useState<SuggestionFormState | null>(null);
  const [suggestionPrompt, setSuggestionPrompt] = useState<SuggestionPromptState | null>(null);
  const [formationForm, setFormationForm] = useState<FormationFormState | null>(null);
  const [readableNumbers, setReadableNumbers] = useState<Record<string, string | null>>({});
  const [addOrders, setAddOrders] = useState<AddOrdersState | null>(null);
  const [delayForm, setDelayForm] = useState<DelayFormState | null>(null);
  const [reasonPrompt, setReasonPrompt] = useState<ReasonPromptState | null>(null);
  const [closePrompt, setClosePrompt] = useState<ClosePromptState | null>(null);
  const [planQuery, setPlanQuery] = useState('');
  const [planTypeFilter, setPlanTypeFilter] = useState<'' | FulfillmentPlanType>('');
  const [planStatusFilter, setPlanStatusFilter] = useState<'' | FulfillmentPlanDisplayStatus>('');
  const now = new Date().toISOString();

  const hasActivePlanQuery = planQuery.trim() !== ''
    || planTypeFilter !== ''
    || planStatusFilter !== '';
  const planQueryText = planQuery.trim().toLowerCase();
  const filteredPlans = plans.filter((plan) => {
    if (planTypeFilter !== '' && plan.type !== planTypeFilter) return false;
    if (
      planStatusFilter !== ''
      && fulfillmentPlanDisplayStatus(plan, plan.activeItemQuantity, now) !== planStatusFilter
    ) {
      return false;
    }
    if (planQueryText && !plan.name.toLowerCase().includes(planQueryText)) return false;
    return true;
  });

  async function refresh(keepExpanded = true): Promise<void> {
    setLoading(true);
    setError('');
    try {
      setPlans(await api.queryFulfillmentPlans());
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
    if (!keepExpanded) setExpandedId(null);
  }

  useEffect(() => { void refresh(); }, [api]);

  useEffect(() => {
    if (!expandedId) return;
    const plan = plans.find(({ id }) => id === expandedId);
    if (!plan || plan.releasedOrderCount === 0) return;
    let stale = false;
    api.queryFulfillmentPlanProgress(expandedId)
      .then((view) => {
        if (!stale) setProgressByPlan((current) => ({ ...current, [expandedId]: view }));
      })
      .catch((value) => {
        if (!stale) setError(errorMessage(value));
      });
    return () => { stale = true; };
  }, [api, expandedId, plans]);

  useEffect(() => {
    if (!expandedId) return;
    const plan = plans.find(({ id }) => id === expandedId);
    if (!plan || isUnformedClosedGroupBuy(plan)) return;
    let stale = false;
    api.queryFulfillmentDemand(expandedId)
      .then((view) => {
        if (!stale) setDemandByPlan((current) => ({ ...current, [expandedId]: view }));
      })
      .catch((value) => {
        if (!stale) setError(errorMessage(value));
      });
    return () => { stale = true; };
  }, [api, expandedId, plans]);

  useEffect(() => {
    const orderIds = [...new Set(
      plans.flatMap((plan) => plan.members.map((member) => member.orderId)),
    )];
    if (orderIds.length === 0) {
      setReadableNumbers({});
      return;
    }
    let stale = false;
    api.getReadableOrderNumbers(orderIds)
      .then((numbers) => { if (!stale) setReadableNumbers(numbers); })
      .catch(() => { if (!stale) setReadableNumbers({}); });
    return () => { stale = true; };
  }, [api, plans]);

  async function submitCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await api.createFulfillmentPlan({
        type: createForm.type,
        name: createForm.name,
        expectedShipAt: createForm.expectedShipAt || null,
        targetQuantity: createForm.targetQuantity.trim()
          ? Number(createForm.targetQuantity)
          : null,
        deadlineAt: createForm.deadlineAt || null,
        demandAlertThreshold: createForm.demandAlertThreshold.trim()
          ? Number(createForm.demandAlertThreshold)
          : null,
        reason: createForm.reason,
      });
      setCreating(false);
      setCreateForm(blankCreateForm());
      setFeedback(`已创建履约计划“${saved.name}”`);
      setExpandedId(saved.id);
      await refresh();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function openAddOrders(plan: FulfillmentPlanView): Promise<void> {
    setAddOrders({ planId: plan.id, candidates: [], selected: new Set(), reason: '', loading: true });
    setError('');
    try {
      const candidates = await api.queryFulfillmentPlanOrderCandidates();
      setAddOrders({
        planId: plan.id,
        candidates,
        selected: new Set(),
        reason: '',
        loading: false,
      });
    } catch (value) {
      setAddOrders(null);
      setError(errorMessage(value));
    }
  }

  async function submitAddOrders(plan: FulfillmentPlanView): Promise<void> {
    if (!addOrders) return;
    setBusy(true);
    setError('');
    try {
      await api.addFulfillmentPlanOrders({
        planId: plan.id,
        expectedRevision: plan.revision,
        orderIds: [...addOrders.selected],
        reason: addOrders.reason,
      });
      setAddOrders(null);
      setFeedback('已加入履约计划');
      await refresh();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function submitReasonPrompt(plan: FulfillmentPlanView): Promise<void> {
    if (!reasonPrompt) return;
    setBusy(true);
    setError('');
    try {
      if (reasonPrompt.kind === 'release_all' || reasonPrompt.kind === 'release_one') {
        await api.releaseFulfillmentPlanOrders({
          planId: plan.id,
          expectedRevision: plan.revision,
          orderIds: reasonPrompt.kind === 'release_all'
            ? null
            : [reasonPrompt.orderId as string],
          reason: reasonPrompt.reason,
        });
        setFeedback('已释放，订单可进入开放发货组');
      } else {
        await api.removeFulfillmentPlanOrder({
          planId: plan.id,
          expectedRevision: plan.revision,
          orderId: reasonPrompt.orderId as string,
          reason: reasonPrompt.reason,
        });
        setFeedback('订单已退出计划，恢复现货发货资格');
      }
      setReasonPrompt(null);
      await refresh();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function submitClose(plan: FulfillmentPlanView): Promise<void> {
    if (!closePrompt) return;
    setBusy(true);
    setError('');
    try {
      await api.closeFulfillmentPlan({
        planId: plan.id,
        expectedRevision: plan.revision,
        reason: closePrompt.reason,
      });
      setClosePrompt(null);
      setFeedback(plan.type === 'group_buy' && plan.formedAt === null
        ? '未成团已关闭，成员订单已列入待退款清单'
        : '计划已关闭');
      await refresh();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function submitDelay(plan: FulfillmentPlanView, event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!delayForm) return;
    setBusy(true);
    setError('');
    try {
      await api.updateFulfillmentPlan({
        planId: plan.id,
        expectedRevision: plan.revision,
        name: null,
        expectedShipAt: delayForm.expectedShipAt || null,
        targetQuantity: delayForm.targetQuantity.trim()
          ? Number(delayForm.targetQuantity)
          : null,
        deadlineAt: delayForm.deadlineAt || null,
        demandAlertThreshold: delayForm.demandAlertThreshold.trim()
          ? Number(delayForm.demandAlertThreshold)
          : null,
        markDelayed: delayForm.markDelayed,
        reason: delayForm.reason,
      });
      setDelayForm(null);
      setFeedback('已更新履约计划');
      await refresh();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function submitFormation(plan: FulfillmentPlanView): Promise<void> {
    if (!formationForm) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.confirmGroupFormation({
        planId: plan.id,
        expectedRevision: plan.revision,
        basis: formationForm.basis,
        reason: formationForm.reason,
      });
      setFormationForm(null);
      setFeedback(`已确认成团“${saved.name}”，成员锁定，需求转为确定需求`);
      await refresh();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function submitRefund(): Promise<void> {
    if (!refundForm) return;
    setBusy(true);
    setError('');
    try {
      const view = await api.registerFulfillmentRefund({
        planId: refundForm.planId,
        orderId: refundForm.orderId,
        orderItemId: refundForm.orderItemId,
        quantity: Number(refundForm.quantity),
        reason: refundForm.reason,
      });
      setDemandByPlan((current) => ({ ...current, [refundForm.planId]: view }));
      setRefundForm(null);
      setFeedback('已登记发货前退款并重算需求与未确认建议');
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function submitSuggestion(): Promise<void> {
    if (!suggestionForm) return;
    setBusy(true);
    setError('');
    try {
      const view = await api.createPurchaseSuggestion({
        planId: suggestionForm.planId,
        standardProductId: suggestionForm.standardProductId,
        quantity: Number(suggestionForm.quantity),
        reason: suggestionForm.reason,
        acknowledgeUnformedRisk: suggestionForm.acknowledgeRisk,
      });
      setDemandByPlan((current) => ({ ...current, [suggestionForm.planId]: view }));
      setSuggestionForm(null);
      setFeedback('已生成待确认采购建议');
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function submitSuggestionPrompt(): Promise<void> {
    if (!suggestionPrompt) return;
    setBusy(true);
    setError('');
    try {
      const input = {
        planId: suggestionPrompt.planId,
        suggestionId: suggestionPrompt.suggestionId,
        reason: suggestionPrompt.reason,
      };
      const view = suggestionPrompt.kind === 'confirm'
        ? await api.confirmPurchaseSuggestion(input)
        : await api.cancelPurchaseSuggestion(input);
      setDemandByPlan((current) => ({ ...current, [suggestionPrompt.planId]: view }));
      setSuggestionPrompt(null);
      setFeedback(suggestionPrompt.kind === 'confirm'
        ? '已确认采购建议，计入需求覆盖'
        : '已取消采购建议');
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fulfillment-plans-workspace workspace-enter">
      <header className="workspace-header">
        <div>
          <span className="section-kicker">预售与团购·发货前闸门</span>
          <h1>履约计划</h1>
          <p>只有显式加入计划的订单受释放闸门控制；未释放订单不会进入开放发货组或待发货导出。</p>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={() => { setCreating(true); setCreateForm(blankCreateForm()); }}
        >
          新建履约计划
        </button>
      </header>

      <InlineError message={error} />
      {feedback && <div className="settings-notice settings-notice--success" role="status">{feedback}</div>}

      <section className="order-query workspace-query" aria-label="履约计划查询">
        <label className="order-query__search">
          <span>搜索履约计划</span>
          <input
            type="search"
            placeholder="计划名称"
            value={planQuery}
            onChange={(event) => setPlanQuery(event.target.value)}
          />
        </label>
        <span className="order-query__result" role="status" aria-live="polite">
          显示 {filteredPlans.length} / {plans.length} 个
        </span>
        {hasActivePlanQuery && (
          <button
            className="button button--quiet order-query__clear"
            type="button"
            onClick={() => {
              setPlanQuery('');
              setPlanTypeFilter('');
              setPlanStatusFilter('');
            }}
          >
            清除筛选
          </button>
        )}
        <div className="order-query__filters">
          <label>
            <span>类型</span>
            <select
              aria-label="类型"
              value={planTypeFilter}
              onChange={(event) => setPlanTypeFilter(
                event.target.value as '' | FulfillmentPlanType,
              )}
            >
              <option value="">全部类型</option>
              <option value="presale">预售</option>
              <option value="group_buy">团购</option>
            </select>
          </label>
          <label>
            <span>状态</span>
            <select
              aria-label="状态"
              value={planStatusFilter}
              onChange={(event) => setPlanStatusFilter(
                event.target.value as '' | FulfillmentPlanDisplayStatus,
              )}
            >
              <option value="">全部状态</option>
              <option value="pending">待备货/待成团</option>
              <option value="ready">具备释放条件/已成团</option>
              <option value="partially_released">部分已释放</option>
              <option value="released">已释放待发货</option>
              <option value="delayed">已延期</option>
              <option value="closed">已关闭</option>
            </select>
          </label>
        </div>
      </section>

      {loading ? (
        <EmptyState title="正在读取履约计划…" status />
      ) : plans.length === 0 ? (
        <EmptyState
          title="还没有履约计划"
          hint="普通现货订单不需要履约计划；预售或团购订单从「新建履约计划」开始。"
        />
      ) : filteredPlans.length === 0 ? (
        <EmptyState
          title="没有匹配的履约计划"
          hint="清除筛选或调整条件后重试。"
        />
      ) : (
        <div className="fulfillment-plan-list" aria-label="履约计划列表">
          {filteredPlans.map((plan) => {
            const displayStatus = fulfillmentPlanDisplayStatus(plan, plan.activeItemQuantity, now);
            const expanded = expandedId === plan.id;
            const open = plan.status !== 'closed' && plan.status !== 'released';
            const groupBuy = plan.type === 'group_buy';
            const formed = plan.formedAt !== null;
            const formationEvent = plan.events.find(
              (event) => event.eventType === 'formed',
            ) ?? null;
            const awaitingRefund = plan.members.filter(isUnformedAwaitingRefund);
            return (
              <article className="aftersales-workflow-card" key={plan.id}>
                <header>
                  <div>
                    <span>{plan.type === 'presale' ? '预售' : '团购'}</span>
                    <h2>{plan.name}</h2>
                  </div>
                  <span className="status-chip">
                    {fulfillmentPlanStatusLabel(plan.type, displayStatus, plan.formedAt)}
                  </span>
                </header>
                <p>
                  {planConditions(plan)}
                  {' · '}进行中 {plan.activeOrderCount} 单 / {plan.activeItemQuantity} 件
                  {plan.releasedOrderCount > 0 ? ` · 已释放 ${plan.releasedOrderCount} 单` : ''}
                </p>
                <p>
                  当前待办：{fulfillmentPlanTodo(plan, plan.activeItemQuantity, now)}
                  {groupBuy && formed && formationEvent
                    ? ` · 成团于 ${formatDateTime(plan.formedAt ?? '')}（${groupFormationBasisLabel(formationEvent.basis ?? 'early')}）`
                    : ''}
                </p>
                <footer>
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : plan.id)}
                  >
                    {expanded ? '收起' : '订单与记录'}
                  </button>
                  {open && (
                    <>
                      {!(groupBuy && formed) && (
                        <button
                          className="button button--quiet"
                          type="button"
                          disabled={busy}
                          onClick={() => void openAddOrders(plan)}
                        >
                          加入订单
                        </button>
                      )}
                      {groupBuy && !formed ? (
                        <button
                          className="button button--primary"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            const quantityReached = plan.targetQuantity !== null
                              && plan.activeItemQuantity >= plan.targetQuantity;
                            const deadlineReached = plan.deadlineAt !== null
                              && now >= plan.deadlineAt;
                            setFormationForm({
                              planId: plan.id,
                              basis: quantityReached
                                ? 'quantity'
                                : deadlineReached
                                  ? 'deadline'
                                  : 'early',
                              reason: '',
                            });
                          }}
                        >
                          确认成团
                        </button>
                      ) : (
                        <button
                          className="button button--quiet"
                          type="button"
                          disabled={busy || plan.activeOrderCount === 0}
                          onClick={() => setReasonPrompt({
                            kind: 'release_all',
                            planId: plan.id,
                            orderId: null,
                            reason: '',
                          })}
                        >
                          全部释放
                        </button>
                      )}
                      <button
                        className="button button--quiet"
                        type="button"
                        disabled={busy}
                        onClick={() => setDelayForm({
                          planId: plan.id,
                          expectedShipAt: '',
                          targetQuantity: '',
                          deadlineAt: '',
                          demandAlertThreshold: '',
                          markDelayed: plan.type === 'presale',
                          reason: '',
                        })}
                      >
                        更新/延期
                      </button>
                      <button
                        className="button button--quiet"
                        type="button"
                        disabled={busy}
                        onClick={() => setClosePrompt({ planId: plan.id, reason: '' })}
                      >
                        关闭计划
                      </button>
                    </>
                  )}
                </footer>

                {expanded && (
                  <div className="fulfillment-plan-detail">
                    {plan.members.length === 0 ? (
                      <p>尚无订单加入该计划。</p>
                    ) : (
                      <div className="table-frame table-frame--embedded">
                        <table>
                          <thead>
                            <tr>
                              <th>系统订单号</th>
                              <th>可读编号</th>
                              <th>买家</th>
                              <th>商品</th>
                              <th>数量</th>
                              <th>加入时间</th>
                              <th>归属状态</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {plan.members.map((member) => (
                              <tr key={member.orderId}>
                                <td>{member.systemOrderNumber}</td>
                                <td>{readableNumbers[member.orderId] ?? '—'}</td>
                                <td>{member.buyerNickname}</td>
                                <td>
                                  {member.items.map((item) => (
                                    `${item.sourceTitle} ${item.sourceSpec}`.trim()
                                  )).join('；')}
                                </td>
                                <td>{member.items.reduce((sum, item) => sum + item.quantity, 0)}</td>
                                <td>{formatDateTime(member.joinedAt)}</td>
                                <td>{memberStatusLabel(member)}</td>
                                <td>
                                  {member.releasedAt === null && member.removedAt === null && open && (
                                    <>
                                      {!(groupBuy && !formed) && (
                                        <button
                                          className="button button--quiet"
                                          type="button"
                                          disabled={busy}
                                          onClick={() => setReasonPrompt({
                                            kind: 'release_one',
                                            planId: plan.id,
                                            orderId: member.orderId,
                                            reason: '',
                                          })}
                                        >
                                          释放
                                        </button>
                                      )}
                                      <button
                                        className="button button--quiet"
                                        type="button"
                                        disabled={busy}
                                        onClick={() => setReasonPrompt({
                                          kind: 'remove',
                                          planId: plan.id,
                                          orderId: member.orderId,
                                          reason: '',
                                        })}
                                      >
                                        退出
                                      </button>
                                    </>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {isUnformedClosedGroupBuy(plan) && (
                      <div className="fulfillment-plan-awaiting-refund" aria-label="待退款清单">
                        <h3>待退款清单</h3>
                        <p className="fulfillment-plan-progress__hint">
                          未成团关闭后成员订单不恢复发货资格；以下订单需按平台流程退款。
                          平台交易状态变为退款或取消后自动移出清单。待确认资金事项由财务模块（后续版本）正式承接。
                        </p>
                        {awaitingRefund.length === 0 ? (
                          <p>没有待退款订单：全部成员订单已退款或取消。</p>
                        ) : (
                          <ul>
                            {awaitingRefund.map((member) => (
                              <li key={member.orderId}>
                                {`${member.systemOrderNumber} · ${member.buyerNickname} · ${
                                  member.items.map((item) => (
                                    `${item.sourceTitle} ${item.sourceSpec}`.trim()
                                  )).join('；')
                                } × ${member.items.reduce((sum, item) => sum + item.quantity, 0)} 件`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    {!isUnformedClosedGroupBuy(plan) && (
                      <div
                        className="fulfillment-plan-demand"
                        aria-label={groupBuy && !formed ? '条件性团购需求与采购建议' : '有效需求与采购建议'}
                      >
                        <h3>
                          {groupBuy && !formed
                            ? '条件性团购需求（预测）与采购建议'
                            : groupBuy
                              ? '团购确定需求与采购建议'
                              : '预售需求与采购建议'}
                        </h3>
                        <p className="fulfillment-plan-progress__hint">
                          {groupBuy && !formed
                            ? '未成团前需求只用于预测，不构成确定采购缺口；提前采购必须勾选确认未成团库存风险。确认成团后同一数据转为确定需求。'
                            : '有效需求按未释放成员订单实时累计；现货可覆盖与待检查由库存流水实时汇总。建议确认后计入已确认采购，采购在途以采购订单为准。'}
                        </p>
                        {!demandByPlan[plan.id] ? (
                          <p role="status">正在读取需求…</p>
                        ) : (() => {
                          const demand = demandByPlan[plan.id]!;
                          const alerts = fulfillmentDemandAlerts(demand);
                          return (
                            <>
                              <p className="fulfillment-plan-demand__totals">
                                {groupBuy && !formed ? '条件性需求' : '有效需求'} {demand.totals.demandQuantity} 件
                                {' · '}退款/取消 {demand.totals.refundedOrCancelledQuantity} 件
                                {' · '}已确认采购 {demand.totals.confirmedSuggestionQuantity} 件
                                {' · '}未确认建议 {demand.totals.draftSuggestionQuantity} 件
                                {' · '}{groupBuy && !formed ? '预测缺口' : '未覆盖缺口'} <strong>{demand.totals.uncoveredQuantity}</strong> 件
                                {' · '}现货可覆盖 {demand.totals.sellableCoveredQuantity} 件
                                {' · '}待检查 {demand.totals.pendingInspectionQuantity} 件
                                {' · '}已释放 {demand.totals.releasedOrderCount} 单
                              </p>
                              {alerts.length > 0 && (
                                <ul className="fulfillment-plan-demand__alerts">
                                  {alerts.map((alert) => <li key={alert}>{alert}</li>)}
                                </ul>
                              )}
                              {groupBuy && formed && demand.totals.uncoveredQuantity > 0 && (
                                <p className="fulfillment-plan-progress__hint">
                                  未覆盖缺口 {demand.totals.uncoveredQuantity} 件：已成团待采购，建议先补足已确认采购再释放；库存分配的硬闸门由阶段三库存模块接入。
                                </p>
                              )}
                              {demand.products.length === 0 ? (
                                <p>暂无映射到标准商品的有效需求。</p>
                              ) : (
                                <div className="table-frame table-frame--embedded">
                                  <table aria-label="预售商品需求">
                                    <thead>
                                      <tr>
                                        <th>标准商品</th>
                                        <th>有效需求</th>
                                        <th>退款/取消</th>
                                        <th>已确认采购</th>
                                        <th>未确认建议</th>
                                        <th>未覆盖缺口</th>
                                        <th>提示</th>
                                        <th>操作</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {demand.products.map((product) => (
                                        <tr key={product.standardProductId}>
                                          <td>
                                            {product.sku}
                                            {' · '}
                                            {product.name}
                                            {product.specification ? `（${product.specification}）` : ''}
                                          </td>
                                          <td>{product.demandQuantity}</td>
                                          <td>{product.refundedOrCancelledQuantity}</td>
                                          <td>{product.confirmedSuggestionQuantity}</td>
                                          <td>{product.draftSuggestionQuantity}</td>
                                          <td><strong>{product.uncoveredQuantity}</strong></td>
                                          <td>
                                            {product.overPurchaseRisk
                                              ? '确认采购超过当前需求，多采购风险'
                                              : product.draftExceedsUncovered
                                                ? '未确认建议超过当前缺口'
                                                : '—'}
                                          </td>
                                          <td>
                                            {open && (
                                              <button
                                                className="button button--quiet"
                                                type="button"
                                                disabled={
                                                  busy
                                                  || product.uncoveredQuantity
                                                    - product.draftSuggestionQuantity <= 0
                                                }
                                                onClick={() => setSuggestionForm({
                                                  planId: plan.id,
                                                  standardProductId: product.standardProductId,
                                                  quantity: '',
                                                  reason: '',
                                                  acknowledgeRisk: false,
                                                })}
                                              >
                                                生成采购建议
                                              </button>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              {demand.unmapped.length > 0 && (
                                <div className="fulfillment-plan-demand__unmapped">
                                  <h4>未映射标准商品的明细</h4>
                                  <p>以下明细尚未关联标准商品，不能生成采购建议，请先在订单校对中关联标准商品或建立映射。</p>
                                  <ul>
                                    {demand.unmapped.map((entry) => (
                                      <li key={`${entry.sourceTitle}\u0000${entry.sourceSpec}`}>
                                        {`${entry.sourceTitle}${entry.sourceSpec ? `（${entry.sourceSpec}）` : ''} × ${entry.quantity} · 涉及 ${entry.orderCount} 单`}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              <div className="table-frame table-frame--embedded">
                                <table aria-label="采购建议">
                                  <thead>
                                    <tr>
                                      <th>商品</th>
                                      <th>数量</th>
                                      <th>状态</th>
                                      <th>时间</th>
                                      <th>操作</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {demand.suggestions.length === 0 ? (
                                      <tr><td colSpan={5}>暂无采购建议</td></tr>
                                    ) : demand.suggestions.map((suggestion) => (
                                      <tr key={suggestion.id}>
                                        <td>
                                          {suggestion.sku}
                                          {' · '}
                                          {suggestion.name}
                                          {suggestion.specification ? `（${suggestion.specification}）` : ''}
                                        </td>
                                        <td>{suggestion.quantity}</td>
                                        <td>
                                          {purchaseSuggestionStatusLabel(suggestion.status)}
                                          {suggestion.cancelReason ? `（${suggestion.cancelReason}）` : ''}
                                          {suggestion.riskAcknowledgedAt
                                            ? ` · 未成团风险已确认（${formatDateTime(suggestion.riskAcknowledgedAt)}）`
                                            : ''}
                                        </td>
                                        <td>
                                          {formatDateTime(suggestion.createdAt)}
                                          {suggestion.confirmedAt
                                            ? ` · 确认于 ${formatDateTime(suggestion.confirmedAt)}`
                                            : ''}
                                        </td>
                                        <td>
                                          {open && suggestion.status === 'draft' && (
                                            <button
                                              className="button button--quiet"
                                              type="button"
                                              disabled={busy}
                                              onClick={() => setSuggestionPrompt({
                                                kind: 'confirm',
                                                planId: plan.id,
                                                suggestionId: suggestion.id,
                                                label: `${suggestion.sku} · ${suggestion.name} × ${suggestion.quantity}`,
                                                reason: '',
                                              })}
                                            >
                                              确认
                                            </button>
                                          )}
                                          {open && (suggestion.status === 'draft'
                                            || suggestion.status === 'confirmed') && (
                                            <button
                                              className="button button--quiet"
                                              type="button"
                                              disabled={busy}
                                              onClick={() => setSuggestionPrompt({
                                                kind: 'cancel',
                                                planId: plan.id,
                                                suggestionId: suggestion.id,
                                                label: `${suggestion.sku} · ${suggestion.name} × ${suggestion.quantity}`,
                                                reason: '',
                                              })}
                                            >
                                              取消
                                            </button>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              {open && (
                                <footer>
                                  <button
                                    className="button button--quiet"
                                    type="button"
                                    disabled={busy || plan.activeOrderCount === 0}
                                    onClick={() => {
                                      const firstActive = plan.members.find(
                                        (member) => member.releasedAt === null
                                          && member.removedAt === null,
                                      );
                                      setRefundForm({
                                        planId: plan.id,
                                        orderId: firstActive?.orderId ?? '',
                                        orderItemId: firstActive?.items[0]?.itemId ?? '',
                                        quantity: '',
                                        reason: '',
                                      });
                                    }}
                                  >
                                    登记发货前退款
                                  </button>
                                </footer>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                    {plan.releasedOrderCount > 0 && (
                      <div className="fulfillment-plan-progress" aria-label="履约进展">
                        <h3>履约进展</h3>
                        <p className="fulfillment-plan-progress__hint">
                          已释放订单的后续发货记录自动归因到该计划，此视图只读。
                        </p>
                        {!progressByPlan[plan.id] ? (
                          <p role="status">正在读取履约进展…</p>
                        ) : progressByPlan[plan.id].orders.length === 0 ? (
                          <p>暂无已释放订单。</p>
                        ) : (
                          progressByPlan[plan.id].orders.map((order) => (
                            <section className="fulfillment-plan-progress-order" key={order.orderId}>
                              <header>
                                <strong>{order.systemOrderNumber}</strong>
                                <span>{order.buyerNickname}</span>
                                <span>
                                  {order.items.reduce((sum, item) => sum + item.quantity, 0)} 件
                                </span>
                              </header>
                              <p>
                                {order.items.map((item) => (
                                  `${item.sourceTitle} ${item.sourceSpec}`.trim()
                                )).join('；')}
                              </p>
                              <p>
                                释放于 {formatDateTime(order.releasedAt)} · {order.releasedReason}
                              </p>
                              {order.shipments.length === 0 ? (
                                <p className="fulfillment-plan-progress-pending">待发货</p>
                              ) : (
                                <ul className="fulfillment-plan-progress-shipments">
                                  {order.shipments.map((shipment) => (
                                    <li key={shipment.recordId}>
                                      <span>发货记录 · {formatDateTime(shipment.createdAt)}</span>
                                      <ul>
                                        {shipment.packages.map((shipmentPackage) => (
                                          <li key={shipmentPackage.id}>
                                            {shipmentPackage.shippingCarrier}
                                            {' '}
                                            {shipmentPackage.trackingNumber}
                                            {' · '}
                                            {shipmentLogisticsStatusLabel(
                                              shipmentPackage.logisticsStatus,
                                            )}
                                            {' · 本订单 '}
                                            {shipmentPackage.items.reduce(
                                              (sum, item) => sum + item.quantity,
                                              0,
                                            )}
                                            {' 件（'}
                                            {shipmentPackage.items.map((item) => (
                                              `${item.sourceTitle} ${item.sourceSpec} ×${item.quantity}`
                                                .trim()
                                            )).join('；')}
                                            {'）'}
                                          </li>
                                        ))}
                                      </ul>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </section>
                          ))
                        )}
                      </div>
                    )}
                    <ol className="fulfillment-plan-events" aria-label="计划事件">
                      {plan.events.map((event) => (
                        <li key={event.id}>
                          <span>{EVENT_TYPE_LABELS[event.eventType]}</span>
                          <small>
                            {formatDateTime(event.occurredAt)} · {event.reason}
                            {event.orderIds.length > 0 ? ` · ${event.orderIds.length} 单` : ''}
                          </small>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {creating && (
        <DialogShell
          kicker="预售与团购·发货前闸门"
          title="新建履约计划"
          description="计划记录类型、名称与计划条件；订单归属与状态变化都以带原因的不可变事件保存。"
          wide
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={(event) => void submitCreate(event)}
        >
          <label>
            <span>计划类型</span>
            <select
              aria-label="计划类型"
              value={createForm.type}
              disabled={busy}
              onChange={(event) => setCreateForm({
                ...createForm,
                type: event.target.value as FulfillmentPlanType,
              })}
            >
              <option value="presale">预售</option>
              <option value="group_buy">团购</option>
            </select>
          </label>
          <label>
            <span>计划名称</span>
            <input
              aria-label="计划名称"
              value={createForm.name}
              disabled={busy}
              onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })}
              placeholder="例如：八月预售批次"
            />
          </label>
          {createForm.type === 'presale' && (
            <label>
              <span>预计发货时间</span>
              <input
                aria-label="预计发货时间"
                type="datetime-local"
                value={createForm.expectedShipAt}
                disabled={busy}
                onChange={(event) => setCreateForm({
                  ...createForm,
                  expectedShipAt: event.target.value,
                })}
              />
            </label>
          )}
          {createForm.type === 'presale' && (
            <label>
              <span>需求提醒阈值（件，可选）</span>
              <input
                aria-label="需求提醒阈值"
                type="number"
                min="1"
                value={createForm.demandAlertThreshold}
                disabled={busy}
                onChange={(event) => setCreateForm({
                  ...createForm,
                  demandAlertThreshold: event.target.value,
                })}
              />
            </label>
          )}
          {createForm.type === 'group_buy' && (
            <>
              <label>
                <span>成团数量（件）</span>
                <input
                  aria-label="成团数量"
                  type="number"
                  min="1"
                  value={createForm.targetQuantity}
                  disabled={busy}
                  onChange={(event) => setCreateForm({
                    ...createForm,
                    targetQuantity: event.target.value,
                  })}
                />
              </label>
              <label>
                <span>团购截止时间</span>
                <input
                  aria-label="团购截止时间"
                  type="datetime-local"
                  value={createForm.deadlineAt}
                  disabled={busy}
                  onChange={(event) => setCreateForm({
                    ...createForm,
                    deadlineAt: event.target.value,
                  })}
                />
              </label>
            </>
          )}
          <ReasonField
            label="创建原因"
            value={createForm.reason}
            saving={busy}
            onChange={(reason) => setCreateForm({ ...createForm, reason })}
          />
          <footer>
            <button
              className="button button--quiet"
              type="button"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={busy}>
              {busy ? '正在创建…' : '创建计划'}
            </button>
          </footer>
        </DialogShell>
      )}

      {addOrders && (() => {
        const plan = plans.find(({ id }) => id === addOrders.planId);
        return (
          <DialogShell
            kicker={plan ? `加入「${plan.name}」` : '加入履约计划'}
            title="选择加入计划的待发货订单"
            description="只有待发货且从未被计划释放的订单可加入；加入需要非空原因。"
            wide
            busy={busy}
            onClose={() => setAddOrders(null)}
            onSubmit={(event) => {
              event.preventDefault();
              if (plan) void submitAddOrders(plan);
            }}
          >
            {addOrders.loading ? (
              <p role="status">正在读取待发货订单…</p>
            ) : addOrders.candidates.length === 0 ? (
              <p>没有可加入的待发货订单（已在其他未释放计划中或曾被计划释放的订单不会显示）。</p>
            ) : (
              <ul className="shared-dialog__list">
                {addOrders.candidates.map((order) => (
                  <li key={order.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={addOrders.selected.has(order.id)}
                        disabled={busy}
                        onChange={(event) => {
                          const selected = new Set(addOrders.selected);
                          if (event.target.checked) selected.add(order.id);
                          else selected.delete(order.id);
                          setAddOrders({ ...addOrders, selected });
                        }}
                      />
                      <span>
                        {order.systemOrderNumber}
                        {order.readableOrderNumber ? ` · ${order.readableOrderNumber}` : ''}
                        {` · ${order.buyerNickname} · ${order.itemCount} 种商品`}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <ReasonField
              label="加入原因"
              value={addOrders.reason}
              saving={busy}
              onChange={(reason) => setAddOrders({ ...addOrders, reason })}
            />
            <footer>
              <button
                className="button button--quiet"
                type="button"
                disabled={busy}
                onClick={() => setAddOrders(null)}
              >
                取消
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={busy || addOrders.selected.size === 0 || addOrders.reason.trim() === ''}
              >
                加入所选订单
              </button>
            </footer>
          </DialogShell>
        );
      })()}

      {delayForm && (() => {
        const plan = plans.find(({ id }) => id === delayForm.planId);
        if (!plan) return null;
        return (
          <DialogShell
            kicker={plan.type === 'presale' ? '预售计划' : '团购计划'}
            title={`更新“${plan.name}”的计划条件`}
            description="更新只改变计划条件；订单归属不变，仍需人工确认释放。"
            busy={busy}
            onClose={() => setDelayForm(null)}
            onSubmit={(event) => void submitDelay(plan, event)}
          >
            {plan.type === 'presale' && (
              <label>
                <span>新的预计发货时间</span>
                <input
                  aria-label="新的预计发货时间"
                  type="datetime-local"
                  value={delayForm.expectedShipAt}
                  disabled={busy}
                  onChange={(event) => setDelayForm({
                    ...delayForm,
                    expectedShipAt: event.target.value,
                  })}
                />
              </label>
            )}
            {plan.type === 'group_buy' && (
              <>
                <label>
                  <span>新的成团数量（件）</span>
                  <input
                    aria-label="新的成团数量"
                    type="number"
                    min="1"
                    value={delayForm.targetQuantity}
                    disabled={busy}
                    onChange={(event) => setDelayForm({
                      ...delayForm,
                      targetQuantity: event.target.value,
                    })}
                  />
                </label>
                <label>
                  <span>新的团购截止时间</span>
                  <input
                    aria-label="新的团购截止时间"
                    type="datetime-local"
                    value={delayForm.deadlineAt}
                    disabled={busy}
                    onChange={(event) => setDelayForm({
                      ...delayForm,
                      deadlineAt: event.target.value,
                    })}
                  />
                </label>
              </>
            )}
            {plan.type === 'presale' && (
              <label>
                <span>新的需求提醒阈值（件，留空保持不变）</span>
                <input
                  aria-label="新的需求提醒阈值"
                  type="number"
                  min="1"
                  value={delayForm.demandAlertThreshold}
                  disabled={busy}
                  onChange={(event) => setDelayForm({
                    ...delayForm,
                    demandAlertThreshold: event.target.value,
                  })}
                />
              </label>
            )}
            <label className="shared-dialog__check">
              <input
                type="checkbox"
                checked={delayForm.markDelayed}
                disabled={busy}
                onChange={(event) => setDelayForm({
                  ...delayForm,
                  markDelayed: event.target.checked,
                })}
              />
              <span>标记为已延期</span>
            </label>
            <ReasonField
              label="更新原因"
              value={delayForm.reason}
              saving={busy}
              onChange={(reason) => setDelayForm({ ...delayForm, reason })}
            />
            <footer>
              <button
                className="button button--quiet"
                type="button"
                disabled={busy}
                onClick={() => setDelayForm(null)}
              >
                取消
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={busy || delayForm.reason.trim() === ''}
              >
                保存更新
              </button>
            </footer>
          </DialogShell>
        );
      })()}

      {refundForm && (() => {
        const plan = plans.find(({ id }) => id === refundForm.planId);
        if (!plan) return null;
        const activeMembers = plan.members.filter(
          (member) => member.releasedAt === null && member.removedAt === null,
        );
        const selectedMember = activeMembers.find(
          (member) => member.orderId === refundForm.orderId,
        ) ?? activeMembers[0];
        const quantityValid = /^\d+$/.test(refundForm.quantity.trim())
          && Number(refundForm.quantity.trim()) > 0;
        return (
          <DialogShell
            kicker={plan.type === 'presale' ? '预售计划' : '团购计划'}
            title={`登记发货前退款 · ${plan.name}`}
            description="退款精确到商品与数量，只减少有效需求、库存预留与未确认建议；已确认采购不会被改写。整单退款请在订单列表更新平台交易状态。"
            busy={busy}
            onClose={() => setRefundForm(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void submitRefund();
            }}
          >
            <label>
              <span>成员订单</span>
              <select
                aria-label="退款成员订单"
                value={selectedMember?.orderId ?? ''}
                disabled={busy}
                onChange={(event) => {
                  const member = activeMembers.find(
                    (candidate) => candidate.orderId === event.target.value,
                  );
                  setRefundForm({
                    ...refundForm,
                    orderId: event.target.value,
                    orderItemId: member?.items[0]?.itemId ?? '',
                  });
                }}
              >
                {activeMembers.map((member) => (
                  <option key={member.orderId} value={member.orderId}>
                    {`${member.systemOrderNumber} · ${member.buyerNickname}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>商品</span>
              <select
                aria-label="退款商品"
                value={refundForm.orderItemId}
                disabled={busy || !selectedMember}
                onChange={(event) => setRefundForm({
                  ...refundForm,
                  orderItemId: event.target.value,
                })}
              >
                {(selectedMember?.items ?? []).map((item) => (
                  <option key={item.itemId} value={item.itemId}>
                    {`${`${item.sourceTitle} ${item.sourceSpec}`.trim()} × ${item.quantity}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>退款数量（件）</span>
              <input
                aria-label="退款数量"
                type="number"
                min="1"
                value={refundForm.quantity}
                disabled={busy}
                onChange={(event) => setRefundForm({
                  ...refundForm,
                  quantity: event.target.value,
                })}
              />
            </label>
            <ReasonField
              label="退款原因"
              value={refundForm.reason}
              saving={busy}
              onChange={(reason) => setRefundForm({ ...refundForm, reason })}
            />
            <footer>
              <button
                className="button button--quiet"
                type="button"
                disabled={busy}
                onClick={() => setRefundForm(null)}
              >
                取消
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={
                  busy
                  || !refundForm.orderId
                  || !refundForm.orderItemId
                  || !quantityValid
                  || refundForm.reason.trim() === ''
                }
              >
                登记退款
              </button>
            </footer>
          </DialogShell>
        );
      })()}

      {suggestionForm && (() => {
        const plan = plans.find(({ id }) => id === suggestionForm.planId);
        const demand = plan ? demandByPlan[plan.id] : undefined;
        const product = demand?.products.find(
          (candidate) => candidate.standardProductId === suggestionForm.standardProductId,
        );
        if (!plan || !demand || !product) return null;
        const capacity = Math.max(
          0,
          product.uncoveredQuantity - product.draftSuggestionQuantity,
        );
        const conditional = demand.conditional;
        const quantityValid = /^\d+$/.test(suggestionForm.quantity.trim())
          && Number(suggestionForm.quantity.trim()) > 0;
        return (
          <DialogShell
            kicker={plan.type === 'presale' ? '预售计划' : conditional ? '团购计划·未成团' : '团购计划'}
            title={`生成采购建议 · ${plan.name}`}
            description={`从尚未被已确认采购覆盖的需求中选择数量；当前可建议 ${capacity} 件。建议需人工确认后才计入已确认采购，不会自动生成采购订单。`}
            busy={busy}
            onClose={() => setSuggestionForm(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void submitSuggestion();
            }}
          >
            <p>
              {`${product.sku} · ${product.name}${product.specification ? `（${product.specification}）` : ''}`}
              {' · '}{conditional ? '条件性需求' : '有效需求'} {product.demandQuantity} 件
              {' · '}{conditional ? '预测缺口' : '未覆盖'} {product.uncoveredQuantity} 件
            </p>
            {conditional && (
              <div className="settings-notice settings-notice--warning" role="alert">
                该团购计划尚未确认成团，当前需求只是预测。提前采购形成的库存若最终未成团，需要自行消化或退货。
              </div>
            )}
            {conditional && (
              <label className="shared-dialog__check">
                <input
                  type="checkbox"
                  checked={suggestionForm.acknowledgeRisk}
                  disabled={busy}
                  onChange={(event) => setSuggestionForm({
                    ...suggestionForm,
                    acknowledgeRisk: event.target.checked,
                  })}
                />
                <span>我知悉未成团库存风险，确认提前采购</span>
              </label>
            )}
            <label>
              <span>建议数量（件）</span>
              <input
                aria-label="建议数量"
                type="number"
                min="1"
                max={capacity}
                value={suggestionForm.quantity}
                disabled={busy}
                onChange={(event) => setSuggestionForm({
                  ...suggestionForm,
                  quantity: event.target.value,
                })}
              />
            </label>
            <ReasonField
              label="生成原因"
              value={suggestionForm.reason}
              saving={busy}
              onChange={(reason) => setSuggestionForm({ ...suggestionForm, reason })}
            />
            <footer>
              <button
                className="button button--quiet"
                type="button"
                disabled={busy}
                onClick={() => setSuggestionForm(null)}
              >
                取消
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={busy
                  || !quantityValid
                  || suggestionForm.reason.trim() === ''
                  || (conditional && !suggestionForm.acknowledgeRisk)}
              >
                生成建议
              </button>
            </footer>
          </DialogShell>
        );
      })()}

      {suggestionPrompt && (
        <DialogShell
          kicker="采购建议"
          title={suggestionPrompt.kind === 'confirm'
            ? '确认采购建议'
            : '取消采购建议'}
          description={`${suggestionPrompt.label}。${suggestionPrompt.kind === 'confirm' ? '确认后计入已确认采购；实际在途数量以采购订单为准。' : '取消需给出原因；已确认建议的取消对应与供应方协商结果。'}`}
          busy={busy}
          onClose={() => setSuggestionPrompt(null)}
          onSubmit={(event) => {
            event.preventDefault();
            void submitSuggestionPrompt();
          }}
        >
          <ReasonField
            label={suggestionPrompt.kind === 'confirm' ? '确认原因' : '取消原因'}
            value={suggestionPrompt.reason}
            saving={busy}
            onChange={(reason) => setSuggestionPrompt({ ...suggestionPrompt, reason })}
          />
          <footer>
            <button
              className="button button--quiet"
              type="button"
              disabled={busy}
              onClick={() => setSuggestionPrompt(null)}
            >
              取消
            </button>
            <button
              className="button button--primary"
              type="submit"
              disabled={busy || suggestionPrompt.reason.trim() === ''}
            >
              {suggestionPrompt.kind === 'confirm' ? '确认建议' : '确认取消'}
            </button>
          </footer>
        </DialogShell>
      )}

      {reasonPrompt && (() => {
        const plan = plans.find(({ id }) => id === reasonPrompt.planId);
        if (!plan) return null;
        const descriptions: Record<ReasonPromptKind, string> = {
          release_all: '释放后，计划内全部订单恢复发货资格，可进入开放发货组。',
          release_one: '释放后，该订单恢复发货资格，可进入开放发货组。',
          remove: '退出后，该订单恢复现货发货资格，不再归属该计划。',
        };
        return (
          <DialogShell
            kicker={plan.type === 'presale' ? '预售计划' : '团购计划'}
            title={`${REASON_PROMPT_TITLES[reasonPrompt.kind]} · ${plan.name}`}
            description={descriptions[reasonPrompt.kind]}
            busy={busy}
            onClose={() => setReasonPrompt(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void submitReasonPrompt(plan);
            }}
          >
            <ReasonField
              label="操作原因"
              value={reasonPrompt.reason}
              saving={busy}
              onChange={(reason) => setReasonPrompt({ ...reasonPrompt, reason })}
            />
            <footer>
              <button
                className="button button--quiet"
                type="button"
                disabled={busy}
                onClick={() => setReasonPrompt(null)}
              >
                取消
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={busy || reasonPrompt.reason.trim() === ''}
              >
                {REASON_PROMPT_CONFIRM[reasonPrompt.kind]}
              </button>
            </footer>
          </DialogShell>
        );
      })()}

      {closePrompt && (() => {
        const plan = plans.find(({ id }) => id === closePrompt.planId);
        if (!plan) return null;
        const unformedGroupBuy = plan.type === 'group_buy' && plan.formedAt === null;
        return (
          <ConfirmDangerDialog
            kicker="不可撤销操作"
            title={`关闭“${plan.name}”`}
            description={unformedGroupBuy
              ? '关闭后计划标记为未成团：成员订单不退出、不恢复发货资格，留在计划内形成待退款清单；关闭不可撤销。'
              : plan.type === 'group_buy'
                ? '关闭后计划停止接收新订单，未释放订单将退出并恢复现货发货资格；关闭不可撤销。'
                : '关闭后计划停止接收新订单，未释放订单将退出并恢复现货发货资格；关闭不可撤销。'}
            busy={busy}
            confirmLabel="确认关闭"
            canSubmit={closePrompt.reason.trim() !== ''}
            onConfirm={() => void submitClose(plan)}
            onClose={() => setClosePrompt(null)}
          >
            <ReasonField
              label="关闭原因"
              value={closePrompt.reason}
              saving={busy}
              onChange={(reason) => setClosePrompt({ ...closePrompt, reason })}
            />
          </ConfirmDangerDialog>
        );
      })()}

      {formationForm && (() => {
        const plan = plans.find(({ id }) => id === formationForm.planId);
        if (!plan) return null;
        const quantityReached = plan.targetQuantity !== null
          && plan.activeItemQuantity >= plan.targetQuantity;
        const deadlineReached = plan.deadlineAt !== null && now >= plan.deadlineAt;
        return (
          <DialogShell
            kicker="团购计划"
            title={`确认成团 · ${plan.name}`}
            description="成团由人工确认并记录依据与原因；确认后成员锁定，不能再加入新订单，条件性需求转为确定需求，释放订单需先成团。"
            busy={busy}
            onClose={() => setFormationForm(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void submitFormation(plan);
            }}
          >
            <fieldset>
              <legend>本次成团依据</legend>
              <label className="shared-dialog__check">
                <input
                  type="radio"
                  name="formation-basis"
                  value="quantity"
                  checked={formationForm.basis === 'quantity'}
                  disabled={busy || !quantityReached}
                  onChange={() => setFormationForm({ ...formationForm, basis: 'quantity' })}
                />
                <span>
                  已达成团数量（{plan.activeItemQuantity}/{plan.targetQuantity ?? '—'} 件）
                  {quantityReached ? '' : ' · 尚未达到'}
                </span>
              </label>
              <label className="shared-dialog__check">
                <input
                  type="radio"
                  name="formation-basis"
                  value="deadline"
                  checked={formationForm.basis === 'deadline'}
                  disabled={busy || !deadlineReached}
                  onChange={() => setFormationForm({ ...formationForm, basis: 'deadline' })}
                />
                <span>
                  已到团购截止时间{plan.deadlineAt ? `（${formatDateTime(plan.deadlineAt)}）` : '（未设置）'}
                  {deadlineReached ? '' : ' · 尚未到达'}
                </span>
              </label>
              <label className="shared-dialog__check">
                <input
                  type="radio"
                  name="formation-basis"
                  value="early"
                  checked={formationForm.basis === 'early'}
                  disabled={busy}
                  onChange={() => setFormationForm({ ...formationForm, basis: 'early' })}
                />
                <span>提前成团（自行判断，无前置条件）</span>
              </label>
            </fieldset>
            <ReasonField
              label="成团原因"
              value={formationForm.reason}
              saving={busy}
              onChange={(reason) => setFormationForm({ ...formationForm, reason })}
            />
            <footer>
              <button
                className="button button--quiet"
                type="button"
                disabled={busy}
                onClick={() => setFormationForm(null)}
              >
                取消
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={busy || formationForm.reason.trim() === ''}
              >
                确认成团
              </button>
            </footer>
          </DialogShell>
        );
      })()}
    </section>
  );
}

function blankCreateForm(): CreateFormState {
  return {
    type: 'presale',
    name: '',
    expectedShipAt: '',
    targetQuantity: '',
    deadlineAt: '',
    demandAlertThreshold: '',
    reason: '',
  };
}

function planConditions(plan: FulfillmentPlanView): string {
  const parts: string[] = [];
  if (plan.expectedShipAt) parts.push(`预计发货 ${formatDateTime(plan.expectedShipAt)}`);
  if (plan.targetQuantity !== null) parts.push(`成团数量 ${plan.targetQuantity} 件`);
  if (plan.deadlineAt) parts.push(`截止 ${formatDateTime(plan.deadlineAt)}`);
  if (plan.demandAlertThreshold !== null) parts.push(`需求提醒阈值 ${plan.demandAlertThreshold} 件`);
  return parts.length > 0 ? parts.join(' · ') : '无条件';
}

function memberStatusLabel(member: FulfillmentPlanView['members'][number]): string {
  if (member.removedAt !== null) return `已退出（${member.removedReason ?? ''}）`;
  if (member.releasedAt !== null) return `已释放（${member.releasedReason ?? ''}）`;
  return '进行中';
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

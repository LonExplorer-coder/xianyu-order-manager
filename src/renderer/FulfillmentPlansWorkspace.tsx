import { useEffect, useState, type FormEvent } from 'react';

import type { OrderSummary } from '../core/contracts';
import type { DesktopApi } from '../core/desktop-api';
import {
  fulfillmentPlanDisplayStatus,
  fulfillmentPlanStatusLabel,
  fulfillmentPlanTodo,
  type FulfillmentPlanDisplayStatus,
  type FulfillmentPlanEventType,
  type FulfillmentPlanProgressView,
  type FulfillmentPlanType,
  type FulfillmentPlanView,
} from '../core/fulfillment-plans';
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
  markDelayed: boolean;
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
      setFeedback(plan.type === 'group_buy' ? '未成团已关闭' : '计划已关闭');
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
              <option value="ready">具备释放条件</option>
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
            return (
              <article className="aftersales-workflow-card" key={plan.id}>
                <header>
                  <div>
                    <span>{plan.type === 'presale' ? '预售' : '团购'}</span>
                    <h2>{plan.name}</h2>
                  </div>
                  <span className="status-chip">
                    {fulfillmentPlanStatusLabel(plan.type, displayStatus)}
                  </span>
                </header>
                <p>
                  {planConditions(plan)}
                  {' · '}进行中 {plan.activeOrderCount} 单 / {plan.activeItemQuantity} 件
                  {plan.releasedOrderCount > 0 ? ` · 已释放 ${plan.releasedOrderCount} 单` : ''}
                </p>
                <p>当前待办：{fulfillmentPlanTodo(plan, plan.activeItemQuantity, now)}</p>
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
                      <button
                        className="button button--quiet"
                        type="button"
                        disabled={busy}
                        onClick={() => void openAddOrders(plan)}
                      >
                        加入订单
                      </button>
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
                      <button
                        className="button button--quiet"
                        type="button"
                        disabled={busy}
                        onClick={() => setDelayForm({
                          planId: plan.id,
                          expectedShipAt: '',
                          targetQuantity: '',
                          deadlineAt: '',
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
                                  {member.releasedAt === null && member.removedAt === null && (
                                    <>
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
        return (
          <ConfirmDangerDialog
            kicker="不可撤销操作"
            title={`关闭“${plan.name}”`}
            description={plan.type === 'group_buy'
              ? '关闭后计划标记为未成团，未释放订单将退出并恢复现货发货资格；关闭不可撤销。'
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
    reason: '',
  };
}

function planConditions(plan: FulfillmentPlanView): string {
  const parts: string[] = [];
  if (plan.expectedShipAt) parts.push(`预计发货 ${formatDateTime(plan.expectedShipAt)}`);
  if (plan.targetQuantity !== null) parts.push(`成团数量 ${plan.targetQuantity} 件`);
  if (plan.deadlineAt) parts.push(`截止 ${formatDateTime(plan.deadlineAt)}`);
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

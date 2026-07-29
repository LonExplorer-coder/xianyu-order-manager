import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import type { BootstrapState, DesktopApi } from '../core/desktop-api';
import type {
  DraftItem,
  OrderDetails,
  OrderDraft,
  OrderSummary,
} from '../core/contracts';
import type { OcrSettingsView } from '../core/ocr-settings';
import {
  isValidAddressPair,
  isValidPhonePair,
  normalizeAddress,
  normalizePhone,
  normalizeShanghaiDateTime,
} from '../core/order-normalization';

export type AppProps = {
  api: DesktopApi;
};

type BusyAction = 'directory' | 'upload' | 'cancel' | 'confirm' | 'detail' | 'retry' | null;
type AppPage = 'orders' | 'settings';

const OCR_UPLOAD_DISCLOSURE = '截图会发送至您配置的阿里云百炼，原图仍保存在本机。每张截图通常调用 1 次 OCR；关键字段缺失或冲突时最多自动复核 1 次，可能产生第 2 次调用与费用。复核失败仍保留首次结果供人工校对。';

export function App({ api }: AppProps) {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [reviewScreenshotUrl, setReviewScreenshotUrl] = useState('');
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null);
  const [detailScreenshotUrl, setDetailScreenshotUrl] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [operationError, setOperationError] = useState('');
  const [activePage, setActivePage] = useState<AppPage>('orders');

  useEffect(() => {
    let active = true;
    void api
      .getBootstrapState()
      .then((state) => {
        if (active) setBootstrap(state);
      })
      .catch((error: unknown) => {
        if (active) setBootstrap({ kind: 'error', message: errorMessage(error) });
      });
    return () => {
      active = false;
    };
  }, [api]);

  async function uploadScreenshot() {
    setBusyAction('upload');
    setOperationError('');
    try {
      const selectedDraft = await api.selectSourceScreenshot();
      if (!selectedDraft) return;
      const screenshotUrl = await api.getScreenshotDataUrl(selectedDraft.screenshotId);
      setReviewScreenshotUrl(screenshotUrl);
      setDraft(selectedDraft);
      setOrderDetails(null);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmOrder(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!draft || bootstrap?.kind !== 'ready') return;
    setBusyAction('confirm');
    setOperationError('');
    try {
      await api.confirmDraft(draft);
      const orders = await api.listOrders();
      setBootstrap({ ...bootstrap, orders });
      setDraft(null);
      setReviewScreenshotUrl('');
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function cancelReview() {
    if (!draft) return;
    setBusyAction('cancel');
    setOperationError('');
    try {
      await api.cancelDraft(draft.id);
      setDraft(null);
      setReviewScreenshotUrl('');
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function openOrder(orderId: string) {
    setBusyAction('detail');
    setOperationError('');
    try {
      const details = await api.getOrder(orderId);
      const screenshotUrl = await api.getScreenshotDataUrl(details.sourceScreenshot.id);
      setDetailScreenshotUrl(screenshotUrl);
      setOrderDetails(details);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function chooseDataDirectory() {
    setBusyAction('directory');
    setOperationError('');
    try {
      setBootstrap(await api.selectDataDirectory());
    } catch (error) {
      setBootstrap({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  async function retryBootstrap() {
    setBusyAction('retry');
    try {
      setBootstrap(await api.retryDataDirectory());
    } catch (error) {
      setBootstrap({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }

  function closeDetails() {
    setOrderDetails(null);
    setDetailScreenshotUrl('');
    setOperationError('');
  }

  if (!bootstrap) {
    return <SystemScreen kind="loading" />;
  }

  if (bootstrap.kind === 'needs_data_directory') {
    return (
      <SystemScreen
        kind="setup"
        busy={busyAction === 'directory'}
        onAction={() => void chooseDataDirectory()}
      />
    );
  }

  if (bootstrap.kind === 'locked') {
    return (
      <SystemScreen
        kind="locked"
        message={bootstrap.message}
        dataDirectory={bootstrap.dataDirectory}
        busy={busyAction === 'directory'}
        onAction={() => void chooseDataDirectory()}
      />
    );
  }

  if (bootstrap.kind === 'error') {
    return (
      <SystemScreen
        kind="error"
        message={bootstrap.message}
        busy={busyAction === 'retry'}
        onAction={() => void retryBootstrap()}
      />
    );
  }

  let workspace: ReactNode;
  if (activePage === 'settings') {
    workspace = <SettingsWorkspace api={api} />;
  } else if (draft) {
    workspace = (
      <ReviewWorkspace
        draft={draft}
        screenshotUrl={reviewScreenshotUrl}
        error={operationError}
        cancelling={busyAction === 'cancel'}
        confirming={busyAction === 'confirm'}
        onDraftChange={setDraft}
        onCancel={() => void cancelReview()}
        onConfirm={(event) => void confirmOrder(event)}
      />
    );
  } else if (orderDetails) {
    workspace = (
      <DetailWorkspace
        details={orderDetails}
        screenshotUrl={detailScreenshotUrl}
        error={operationError}
        onBack={closeDetails}
      />
    );
  } else {
    workspace = (
      <OrdersWorkspace
        orders={bootstrap.orders}
        dataDirectory={bootstrap.dataDirectory}
        error={operationError}
        uploading={busyAction === 'upload'}
        openingOrder={busyAction === 'detail'}
        onUpload={() => void uploadScreenshot()}
        onOpenOrder={(orderId) => void openOrder(orderId)}
      />
    );
  }

  return (
    <AppFrame
      dataDirectory={bootstrap.dataDirectory}
      activePage={activePage}
      onNavigate={setActivePage}
    >
      {workspace}
    </AppFrame>
  );
}

function AppFrame({
  dataDirectory,
  activePage,
  onNavigate,
  children,
}: {
  dataDirectory: string;
  activePage: AppPage;
  onNavigate: (page: AppPage) => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">闲</span>
          <span className="brand-copy">
            <strong>闲鱼订单</strong>
            <small>本机工作台</small>
          </span>
        </div>

        <nav className="primary-nav">
          <button
            className={`nav-item${activePage === 'orders' ? ' is-active' : ''}`}
            type="button"
            aria-current={activePage === 'orders' ? 'page' : undefined}
            onClick={() => onNavigate('orders')}
          >
            <Icon name="orders" />
            <span className="nav-label">订单</span>
          </button>
          <button className="nav-item" type="button" disabled>
            <Icon name="shipment" />
            <span className="nav-label">发货组</span>
            <span className="nav-badge">稍后</span>
          </button>
          <button className="nav-item" type="button" disabled>
            <Icon name="template" />
            <span className="nav-label">表格模板</span>
            <span className="nav-badge">稍后</span>
          </button>
          <button
            className={`nav-item nav-item--settings${activePage === 'settings' ? ' is-active' : ''}`}
            type="button"
            aria-current={activePage === 'settings' ? 'page' : undefined}
            onClick={() => onNavigate('settings')}
          >
            <Icon name="settings" />
            <span className="nav-label">设置</span>
          </button>
        </nav>

        <div className="sidebar-footer" title={dataDirectory}>
          <span className="connection-dot" aria-hidden="true" />
          <span className="directory-status">
            <strong>数据目录已连接</strong>
            <small>本机安全保存</small>
          </span>
        </div>
      </aside>
      <main className="workspace">{children}</main>
    </div>
  );
}

type SystemScreenProps =
  | { kind: 'loading' }
  | { kind: 'setup'; busy: boolean; onAction: () => void }
  | {
      kind: 'locked';
      message: string;
      dataDirectory: string;
      busy: boolean;
      onAction: () => void;
    }
  | { kind: 'error'; message: string; busy: boolean; onAction: () => void };

function SystemScreen(props: SystemScreenProps) {
  if (props.kind === 'loading') {
    return (
      <main className="system-screen" aria-live="polite">
        <div className="system-brand">
          <span className="brand-mark" aria-hidden="true">闲</span>
          <strong>闲鱼订单管理</strong>
        </div>
        <div className="loading-line" aria-hidden="true"><span /></div>
        <p className="system-status">正在打开订单数据…</p>
      </main>
    );
  }

  if (props.kind === 'setup') {
    return (
      <main className="system-screen system-screen--setup">
        <div className="system-brand">
          <span className="brand-mark" aria-hidden="true">闲</span>
          <strong>闲鱼订单管理</strong>
        </div>
        <section className="system-content">
          <span className="section-kicker">01 / 开始使用</span>
          <h1>选择订单数据保存位置</h1>
          <p>订单、来源截图和之后的备份都将保存在这个目录。程序更新或移动时，您的数据不会受影响。</p>
          <button className="button button--primary button--large" type="button" onClick={props.onAction} disabled={props.busy}>
            <Icon name="folder" />
            {props.busy ? '正在打开…' : '选择数据目录'}
          </button>
          <div className="privacy-note">
            <Icon name="shield" />
            <span><strong>本机保存为主</strong>订单数据与原图保存在所选目录，识别时截图会发送至您配置的阿里云百炼。</span>
          </div>
        </section>
      </main>
    );
  }

  const isLocked = props.kind === 'locked';
  return (
    <main className="system-screen system-screen--issue">
      <div className="system-brand">
        <span className="brand-mark" aria-hidden="true">闲</span>
        <strong>闲鱼订单管理</strong>
      </div>
      <section className="system-content">
        <span className="issue-icon" aria-hidden="true"><Icon name={isLocked ? 'lock' : 'warning'} /></span>
        <span className="section-kicker">{isLocked ? '数据保护' : '启动检查'}</span>
        <h1>{isLocked ? '数据目录正在使用' : '无法打开订单数据'}</h1>
        <p role={isLocked ? undefined : 'alert'}>{props.message}</p>
        {isLocked && <p className="system-path">{props.dataDirectory}</p>}
        <button className="button button--primary" type="button" onClick={props.onAction} disabled={props.busy}>
          {props.busy ? '正在处理…' : isLocked ? '选择其他目录' : '重新尝试'}
        </button>
      </section>
    </main>
  );
}

type OrdersWorkspaceProps = {
  orders: OrderSummary[];
  dataDirectory: string;
  error: string;
  uploading: boolean;
  openingOrder: boolean;
  onUpload: () => void;
  onOpenOrder: (orderId: string) => void;
};

function OrdersWorkspace({
  orders,
  dataDirectory,
  error,
  uploading,
  openingOrder,
  onUpload,
  onOpenOrder,
}: OrdersWorkspaceProps) {
  if (orders.length === 0) {
    return (
      <section className="empty-workspace workspace-enter">
        <div className="empty-visual" aria-hidden="true">
          <div className="document-outline"><Icon name="image" /></div>
          <span className="scan-line" />
        </div>
        <span className="section-kicker">订单工作台</span>
        <h1>还没有订单</h1>
        <p>上传一张包含完整闲鱼订单详情的来源截图，识别后对照原图校对并入库。</p>
        <InlineError message={error} />
        <button className="button button--primary button--large" type="button" onClick={onUpload} disabled={uploading}>
          <Icon name="upload" />
          {uploading ? '正在识别来源截图…' : '上传来源截图'}
        </button>
        <p className="upload-disclosure">{OCR_UPLOAD_DISCLOSURE}</p>
        <div className="empty-support">
          <span>PNG、JPG、JPEG 或 WebP</span>
          <span aria-hidden="true">·</span>
          <span>一张来源截图对应一个订单</span>
        </div>
        <p className="data-path"><Icon name="folder" />{dataDirectory}</p>
      </section>
    );
  }

  return (
    <section className="orders-workspace workspace-enter" aria-busy={openingOrder}>
      <header className="workspace-header">
        <div>
          <span className="section-kicker">原始订单</span>
          <h1>订单</h1>
          <p>{orders.length} 笔订单，保留来源截图与来源快照。</p>
        </div>
        <div className="upload-action">
          <button className="button button--primary" type="button" onClick={onUpload} disabled={uploading || openingOrder}>
            <Icon name="upload" />
            {uploading ? '正在识别来源截图…' : '上传来源截图'}
          </button>
          <small>{OCR_UPLOAD_DISCLOSURE}</small>
        </div>
      </header>

      <InlineError message={error} />

      <div className="table-toolbar" aria-label="订单表概况">
        <span><strong>{orders.length}</strong> 全部订单</span>
        <span><strong>{orders.reduce((total, order) => total + order.itemCount, 0)}</strong> 件商品</span>
        <span><strong>{formatMoney(orders.reduce((total, order) => total + order.amountCents, 0))}</strong> 成交总额</span>
      </div>

      <div className="table-frame">
        <table aria-label="原始订单">
          <thead>
            <tr>
              <th>订单号</th>
              <th>买家</th>
              <th>收件人</th>
              <th>商品</th>
              <th>成交金额</th>
              <th>交易状态</th>
              <th>履约状态</th>
              <th>入库时间</th>
              <th><span className="visually-hidden">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>
                  <button
                    className="order-link"
                    type="button"
                    aria-label={`查看订单 ${order.orderNumber}`}
                    onClick={() => onOpenOrder(order.id)}
                    disabled={openingOrder}
                  >
                    {order.orderNumber}
                  </button>
                </td>
                <td>{order.buyerNickname || '—'}</td>
                <td>{order.recipient}</td>
                <td>{order.itemCount} 件</td>
                <td className="money-cell">{formatMoney(order.amountCents)}</td>
                <td><span className="status-chip">{platformTransactionStatusLabel(order.platformTransactionStatus)}</span></td>
                <td><span className="status-chip">{fulfillmentStatusLabel(order.fulfillmentStatus)}</span></td>
                <td>{formatDateTime(order.createdAt)}</td>
                <td><Icon name="chevron" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type SettingsAction = 'loading' | 'saving' | 'removing' | 'testing' | null;
type SettingsFeedback = { kind: 'success' | 'error'; message: string } | null;

function SettingsWorkspace({ api }: { api: DesktopApi }) {
  const [settings, setSettings] = useState<OcrSettingsView | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<SettingsAction>('loading');
  const [feedback, setFeedback] = useState<SettingsFeedback>(null);
  const [showPaidCallConfirmation, setShowPaidCallConfirmation] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setBusy('loading');
    setFeedback(null);
    void api
      .getOcrSettings()
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setWorkspaceId(value.workspaceId);
        setApiKey('');
      })
      .catch((error: unknown) => {
        if (active) setFeedback({ kind: 'error', message: errorMessage(error) });
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [api, reloadToken]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('saving');
    setFeedback(null);
    try {
      const saved = await api.saveOcrSettings({
        workspaceId,
        region: 'cn-beijing',
        apiKey,
      });
      setSettings(saved);
      setWorkspaceId(saved.workspaceId);
      setApiKey('');
      setShowPaidCallConfirmation(false);
      setFeedback({ kind: 'success', message: '设置已保存' });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function removeApiKey() {
    setBusy('removing');
    setFeedback(null);
    try {
      const updated = await api.removeOcrApiKey();
      setSettings(updated);
      setWorkspaceId(updated.workspaceId);
      setApiKey('');
      setShowPaidCallConfirmation(false);
      setFeedback({ kind: 'success', message: 'API Key 已移除' });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function confirmConnectionTest() {
    setBusy('testing');
    setFeedback(null);
    try {
      const result = await api.testOcrConnection({ consentToPaidCall: true });
      setShowPaidCallConfirmation(false);
      setFeedback({ kind: 'success', message: result.message });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="settings-workspace workspace-enter">
      <header className="workspace-header workspace-header--settings">
        <div>
          <span className="section-kicker">本机配置</span>
          <h1>设置</h1>
          <p>管理识别服务与本机凭据。</p>
        </div>
      </header>

      <div className="settings-body">
        {busy === 'loading' && !settings ? (
          <div className="settings-loading" role="status">正在读取 OCR 设置…</div>
        ) : !settings ? (
          <div className="settings-load-error">
            <SettingsNotice feedback={feedback} />
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              重新读取
            </button>
          </div>
        ) : (
          <form className="settings-form" aria-label="百炼 OCR 设置" onSubmit={(event) => void saveSettings(event)}>
            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <span className="section-kicker">识别服务</span>
                  <h2>百炼 OCR</h2>
                  <p>使用阿里云百炼 qwen3.5-ocr 识别本机来源截图。</p>
                </div>
                <span className={`service-state${settings.apiKeyConfigured ? ' is-ready' : ''}`}>
                  <i aria-hidden="true" />
                  {settings.apiKeyConfigured ? '已配置' : '未配置'}
                </span>
              </div>

              <div className="settings-fields">
                <Field label="Workspace ID" required>
                  <input
                    value={workspaceId}
                    autoComplete="off"
                    onChange={(event) => setWorkspaceId(event.target.value)}
                    placeholder="输入百炼 Workspace ID"
                  />
                </Field>
                <Field label="地域">
                  <input aria-label="地域" value={settings.regionLabel} readOnly />
                  <small className="field-help">qwen3.5-ocr 当前仅开放华北 2（北京）</small>
                </Field>
                <Field label="模型">
                  <input aria-label="模型" value={settings.model} readOnly />
                </Field>
                <Field label="API Key" required>
                  <input
                    aria-label="API Key"
                    type="password"
                    value={apiKey}
                    autoComplete="new-password"
                    spellCheck={false}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={settings.apiKeyConfigured ? '输入新密钥以替换' : '输入百炼 API Key'}
                  />
                </Field>
              </div>

              <div className="credential-row">
                <div className="credential-copy">
                  <span className="credential-mask">
                    {settings.apiKeyConfigured ? '••••••••' : '尚未保存 API Key'}
                  </span>
                  <small>
                    {settings.apiKeyConfigured
                      ? `已保存在 ${settings.credentialStore}`
                      : `保存后将存入 ${settings.credentialStore}`}
                  </small>
                </div>
                {settings.apiKeyConfigured && (
                  <button
                    className="text-button text-button--danger"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void removeApiKey()}
                  >
                    {busy === 'removing' ? '正在移除…' : '移除 API Key'}
                  </button>
                )}
              </div>

              <p className="credential-policy">
                API Key 不会回填到输入框，也不会写入订单数据、备份或日志。
              </p>

              <div className="settings-actions">
                <button className="button button--primary" type="submit" disabled={busy !== null}>
                  <Icon name="check" />
                  {busy === 'saving' ? '正在保存…' : '保存设置'}
                </button>
              </div>
            </section>

            <section className="settings-section settings-section--connection">
              <div className="settings-section-heading">
                <div>
                  <span className="section-kicker">连接检查</span>
                  <h2>测试连接</h2>
                  <p>仅在需要验证当前配置时手动执行。</p>
                </div>
                {!showPaidCallConfirmation && (
                  <button
                    className="button button--quiet"
                    type="button"
                    disabled={busy !== null || !settings.apiKeyConfigured || !settings.workspaceId}
                    onClick={() => {
                      setFeedback(null);
                      setShowPaidCallConfirmation(true);
                    }}
                  >
                    测试连接
                  </button>
                )}
              </div>

              {showPaidCallConfirmation && (
                <div className="paid-call-notice" aria-label="连接测试确认">
                  <div>
                    <strong>发送一张内置测试图片并可能产生一次 OCR 调用</strong>
                    <p>测试图片会直接发往百炼，请确认后继续。</p>
                  </div>
                  <div className="paid-call-actions">
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={busy === 'testing'}
                      onClick={() => setShowPaidCallConfirmation(false)}
                    >
                      取消
                    </button>
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={busy === 'testing'}
                      onClick={() => void confirmConnectionTest()}
                    >
                      {busy === 'testing' ? '正在测试…' : '确认并测试连接'}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <SettingsNotice feedback={feedback} />
          </form>
        )}
      </div>
    </section>
  );
}

function SettingsNotice({ feedback }: { feedback: SettingsFeedback }) {
  if (!feedback) return null;
  return (
    <div
      className={`settings-notice settings-notice--${feedback.kind}`}
      role={feedback.kind === 'error' ? 'alert' : 'status'}
    >
      <Icon name={feedback.kind === 'error' ? 'warning' : 'check'} />
      <span>{feedback.message}</span>
    </div>
  );
}

type ReviewWorkspaceProps = {
  draft: OrderDraft;
  screenshotUrl: string;
  error: string;
  cancelling: boolean;
  confirming: boolean;
  onDraftChange: (draft: OrderDraft) => void;
  onCancel: () => void;
  onConfirm: (event: FormEvent<HTMLFormElement>) => void;
};

function ReviewWorkspace({
  draft,
  screenshotUrl,
  error,
  cancelling,
  confirming,
  onDraftChange,
  onCancel,
  onConfirm,
}: ReviewWorkspaceProps) {
  const [moneyErrors, setMoneyErrors] = useState<Record<string, string>>({});
  const hasMoneyErrors = Object.keys(moneyErrors).length > 0;
  const isComplete =
    draft.orderNumber.trim() !== '' &&
    draft.sellerAccount.trim() !== '' &&
    draft.recipient.trim() !== '' &&
    isValidPhonePair(draft.phone, draft.phoneNormalized) &&
    isValidAddressPair(draft.addressOriginal, draft.addressNormalized) &&
    draft.items.length > 0 &&
    draft.items.every((item) =>
      item.sourceTitle.trim() !== '' &&
      item.unitPriceCents !== null &&
      Number.isSafeInteger(item.quantity) &&
      item.quantity >= 1
    ) &&
    draft.productTotalCents !== null &&
    draft.shippingFeeCents !== null &&
    draft.amountCents !== null &&
    !hasMoneyErrors;

  function patchDraft(patch: Partial<OrderDraft>) {
    onDraftChange({ ...draft, ...patch });
  }

  function patchItem(index: number, patch: Partial<DraftItem>) {
    const items = [...draft.items];
    items[index] = { ...items[index], ...patch };
    patchDraft({ items });
  }

  function patchMoney(
    key: string,
    value: string,
    onValid: (cents: number | null) => void,
  ) {
    if (value.trim() === '') {
      setMoneyErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      onValid(null);
      return;
    }
    const cents = yuanToCents(value);
    if (cents === null) {
      setMoneyErrors((current) => ({
        ...current,
        [key]: '金额仅支持普通数字，最多两位小数',
      }));
      return;
    }

    setMoneyErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    onValid(cents);
  }

  function removeItem(index: number) {
    const removedItem = draft.items[index];
    if (removedItem) {
      setMoneyErrors((current) => {
        const key = `item:${removedItem.id}:unitPrice`;
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
    patchDraft({
      items: draft.items
        .filter((_, itemIndex) => itemIndex !== index)
        .map((item, position) => ({ ...item, position })),
    });
  }

  function addItem() {
    const position = draft.items.length;
    patchDraft({
      items: [
        ...draft.items,
        {
          id: `manual-item-${draft.id}-${Date.now()}-${position}`,
          position,
          sourceTitle: '',
          sourceSpec: '',
          unitPriceCents: null,
          quantity: 1,
          quantityInferred: false,
        },
      ],
    });
  }

  return (
    <section className="review-workspace review-enter">
      <header className="workspace-header workspace-header--review">
        <div className="header-title-row">
          <div>
            <span className="section-kicker">识别结果 · 待确认</span>
            <h1>校对识别结果</h1>
            <p>左侧是来源截图，修正右侧字段后再入库。</p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="button button--quiet"
            type="button"
            disabled={cancelling || confirming}
            onClick={onCancel}
          >
            {cancelling ? '正在取消…' : '取消本次校对'}
          </button>
          <button
            className="button button--primary"
            type="submit"
            form="review-form"
            disabled={cancelling || confirming || !isComplete}
          >
            <Icon name="check" />
            {confirming ? '正在入库…' : '确认并入库'}
          </button>
        </div>
      </header>

      <InlineError message={error} />

      <div className="review-layout">
        <figure className="source-panel">
          <div className="panel-label">
            <span><Icon name="image" />来源截图</span>
            <span>仅用于当前订单校对</span>
          </div>
          <div className="source-image-stage">
            <img src={screenshotUrl} alt="来源截图" />
          </div>
        </figure>

        <form id="review-form" className="review-form" onSubmit={onConfirm}>
          <div className="review-summary">
            <div>
              <span>订单号</span>
              <strong>{draft.orderNumber || '待补充'}</strong>
            </div>
            <div>
              <span>商品</span>
              <strong>{draft.items.length} 项</strong>
            </div>
            <div>
              <span>成交金额</span>
              <strong>{formatMoney(draft.amountCents)}</strong>
            </div>
          </div>

          <FormSection title="订单信息" description="平台只读；卖家账号与订单号共同确定订单归属。">
            <div className="field-grid field-grid--two">
              <Field label="平台">
                <input value={platformLabel(draft.platform)} readOnly />
              </Field>
              <Field label="卖家账号" required>
                <input required value={draft.sellerAccount} onChange={(event) => patchDraft({ sellerAccount: event.target.value })} />
              </Field>
              <Field label="订单号" required>
                <input required value={draft.orderNumber} onChange={(event) => patchDraft({ orderNumber: event.target.value })} />
              </Field>
              <Field label="支付宝交易号">
                <input value={draft.alipayTransactionNumber} onChange={(event) => patchDraft({ alipayTransactionNumber: event.target.value })} />
              </Field>
              <Field label="买家昵称">
                <input
                  aria-label="买家昵称"
                  value={draft.buyerNickname}
                  onChange={(event) => patchDraft({ buyerNickname: event.target.value })}
                />
                {draft.buyerNickname && draft.buyerNickname === draft.recipient && (
                  <small className="field-warning">
                    OCR 疑似把收件人同时填入了买家昵称，请对照截图核对
                  </small>
                )}
              </Field>
              <Field label="平台交易状态">
                <select
                  value={draft.platformTransactionStatus}
                  onChange={(event) => patchDraft({
                    platformTransactionStatus: event.target.value as OrderDraft['platformTransactionStatus'],
                  })}
                >
                  <option value="paid">已付款</option>
                  <option value="cancelled">已取消</option>
                  <option value="refunded">已退款</option>
                  <option value="unknown">未知</option>
                </select>
              </Field>
              <Field label="履约状态">
                <select
                  value={draft.fulfillmentStatus}
                  onChange={(event) => patchDraft({
                    fulfillmentStatus: event.target.value as OrderDraft['fulfillmentStatus'],
                  })}
                >
                  <option value="pending_shipment">待发货</option>
                  <option value="shipped">已发货</option>
                  <option value="unknown">未知</option>
                </select>
              </Field>
            </div>
          </FormSection>

          <FormSection title="金额" description="金额以人民币元校对，入库时以分精确保存。">
            <div className="field-grid field-grid--three">
              <Field label="商品总价" required suffix="元">
                <input
                  aria-label="商品总价"
                  aria-invalid={Boolean(moneyErrors.productTotalCents)}
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={formatMoneyInput(draft.productTotalCents)}
                  onChange={(event) => patchMoney('productTotalCents', event.target.value, (cents) => {
                    patchDraft({ productTotalCents: cents });
                  })}
                />
                {moneyErrors.productTotalCents && <small className="field-error">{moneyErrors.productTotalCents}</small>}
              </Field>
              <Field label="运费" required suffix="元">
                <input
                  aria-label="运费"
                  aria-invalid={Boolean(moneyErrors.shippingFeeCents)}
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={formatMoneyInput(draft.shippingFeeCents)}
                  onChange={(event) => patchMoney('shippingFeeCents', event.target.value, (cents) => {
                    patchDraft({ shippingFeeCents: cents });
                  })}
                />
                {moneyErrors.shippingFeeCents && <small className="field-error">{moneyErrors.shippingFeeCents}</small>}
              </Field>
              <Field label="成交金额" required suffix="元">
                <input
                  aria-label="成交金额"
                  aria-invalid={Boolean(moneyErrors.amountCents)}
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  value={formatMoneyInput(draft.amountCents)}
                  onChange={(event) => patchMoney('amountCents', event.target.value, (cents) => {
                    patchDraft({ amountCents: cents });
                  })}
                />
                {moneyErrors.amountCents && <small className="field-error">{moneyErrors.amountCents}</small>}
              </Field>
            </div>
          </FormSection>

          <FormSection title="交易时间" description="原文便于对照截图，规范化时间用于查询与排序。">
            <div className="field-grid field-grid--two">
              <Field label="下单时间（原文）">
                <input value={draft.orderedAtOriginal} onChange={(event) => {
                  const orderedAtOriginal = event.target.value;
                  patchDraft({
                    orderedAtOriginal,
                    orderedAtNormalized: normalizeShanghaiDateTime(orderedAtOriginal),
                  });
                }} />
              </Field>
              <Field label="下单时间（规范化）">
                <input value={draft.orderedAtNormalized} readOnly />
              </Field>
              <Field label="付款时间（原文）">
                <input value={draft.paidAtOriginal} onChange={(event) => {
                  const paidAtOriginal = event.target.value;
                  patchDraft({
                    paidAtOriginal,
                    paidAtNormalized: normalizeShanghaiDateTime(paidAtOriginal),
                  });
                }} />
              </Field>
              <Field label="付款时间（规范化）">
                <input value={draft.paidAtNormalized} readOnly />
              </Field>
            </div>
          </FormSection>

          <FormSection title="收货信息" description="界面中保留完整信息，仅在导出时按模板脱敏。">
            <div className="field-grid field-grid--two">
              <Field label="收件人" required>
                <input required value={draft.recipient} onChange={(event) => patchDraft({ recipient: event.target.value })} />
              </Field>
              <Field label="手机号" required>
                <input required inputMode="tel" value={draft.phone} onChange={(event) => {
                  const phone = event.target.value;
                  patchDraft({ phone, phoneNormalized: normalizePhone(phone) });
                }} />
              </Field>
              <Field label="规范化手机号" wide>
                <input inputMode="tel" value={draft.phoneNormalized} readOnly />
              </Field>
              <Field label="完整收货地址" required wide>
                <textarea required rows={3} value={draft.addressOriginal} onChange={(event) => {
                  const addressOriginal = event.target.value;
                  patchDraft({
                    addressOriginal,
                    addressNormalized: normalizeAddress(addressOriginal),
                  });
                }} />
              </Field>
              <Field label="规范化地址" wide>
                <textarea rows={3} value={draft.addressNormalized} readOnly />
              </Field>
            </div>
            <div className="field-grid field-grid--three field-grid--spaced">
              <Field label="省">
                <input value={draft.province} onChange={(event) => patchDraft({ province: event.target.value })} />
              </Field>
              <Field label="市">
                <input value={draft.city} onChange={(event) => patchDraft({ city: event.target.value })} />
              </Field>
              <Field label="区 / 县">
                <input value={draft.district} onChange={(event) => patchDraft({ district: event.target.value })} />
              </Field>
            </div>
          </FormSection>

          <FormSection title={`商品明细 · ${draft.items.length}`} description="没有识别到明确数量时，系统默认为 1。">
            <div className="item-list">
              {draft.items.length === 0 && (
                <div className="empty-items">暂无商品明细</div>
              )}
              {draft.items.map((item, index) => (
                <div className="item-editor" key={item.id}>
                  <div className="item-index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="item-fields">
                    <div className="item-title-row">
                      <Field label="商品标题" required>
                        <input
                          aria-label={draft.items.length === 1 ? undefined : `商品 ${index + 1} 标题`}
                          required
                          value={item.sourceTitle}
                          onChange={(event) => patchItem(index, { sourceTitle: event.target.value })}
                        />
                      </Field>
                      <button
                        className="item-remove-button"
                        type="button"
                        aria-label={`删除商品 ${index + 1}`}
                        onClick={() => removeItem(index)}
                      >
                        删除
                      </button>
                    </div>
                    <div className="field-grid field-grid--item">
                      <Field label="规格">
                        <input
                          aria-label={draft.items.length === 1 ? undefined : `商品 ${index + 1} 规格`}
                          value={item.sourceSpec}
                          onChange={(event) => patchItem(index, { sourceSpec: event.target.value })}
                        />
                      </Field>
                      <Field label="单价" required suffix="元">
                        <input
                          aria-label={draft.items.length === 1 ? '单价' : `商品 ${index + 1} 单价`}
                          aria-invalid={Boolean(moneyErrors[`item:${item.id}:unitPrice`])}
                          type="number"
                          required
                          min="0"
                          step="0.01"
                          value={formatMoneyInput(item.unitPriceCents)}
                          onChange={(event) => patchMoney(
                            `item:${item.id}:unitPrice`,
                            event.target.value,
                            (cents) => patchItem(index, { unitPriceCents: cents }),
                          )}
                        />
                        {moneyErrors[`item:${item.id}:unitPrice`] && (
                          <small className="field-error">{moneyErrors[`item:${item.id}:unitPrice`]}</small>
                        )}
                      </Field>
                      <Field label="数量" suffix={item.quantityInferred ? '默认 1' : undefined}>
                        <input
                          aria-label={draft.items.length === 1 ? '数量' : `商品 ${index + 1} 数量`}
                          type="number"
                          min="1"
                          step="1"
                          value={item.quantity}
                          onChange={(event) => patchItem(index, {
                            quantity: Number(event.target.value),
                            quantityInferred: false,
                          })}
                        />
                      </Field>
                    </div>
                    {item.quantityInferred && (
                      <div className="inferred-note">截图未显示数量，已按 1 件处理</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button className="add-item-button" type="button" onClick={addItem}>
              <span aria-hidden="true">+</span>添加商品
            </button>
          </FormSection>
        </form>
      </div>
    </section>
  );
}

function FormSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="form-section">
      <header>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

function Field({
  label,
  required = false,
  suffix,
  wide = false,
  children,
}: {
  label: string;
  required?: boolean;
  suffix?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`field${wide ? ' field--wide' : ''}`}>
      <span className="field-label">
        {label}{required && <i aria-hidden="true">*</i>}
        {suffix && <small>{suffix}</small>}
      </span>
      {children}
    </label>
  );
}

function DetailWorkspace({
  details,
  screenshotUrl,
  error,
  onBack,
}: {
  details: OrderDetails;
  screenshotUrl: string;
  error: string;
  onBack: () => void;
}) {
  const { order, sourceScreenshot, sourceSnapshot } = details;
  const recipientChanged = sourceSnapshot.recognition.recipient !== order.recipient;

  return (
    <section className="detail-workspace detail-enter">
      <header className="workspace-header workspace-header--detail">
        <div className="header-title-row">
          <button className="icon-button" type="button" onClick={onBack} aria-label="返回订单表">
            <Icon name="back" />
          </button>
          <div>
            <span className="section-kicker">原始订单 · {fulfillmentStatusLabel(order.fulfillmentStatus)}</span>
            <h1>订单详情</h1>
            <p>{order.orderNumber}</p>
          </div>
        </div>
        <span className="status-chip status-chip--large">
          {platformTransactionStatusLabel(order.platformTransactionStatus)} · {fulfillmentStatusLabel(order.fulfillmentStatus)}
        </span>
      </header>

      <InlineError message={error} />

      <div className="detail-layout">
        <figure className="source-panel source-panel--detail">
          <div className="panel-label">
            <span><Icon name="image" />来源截图</span>
            <span>{sourceScreenshot.mimeType.replace('image/', '').toUpperCase()}</span>
          </div>
          <div className="source-image-stage">
            <img src={screenshotUrl} alt="来源截图" />
          </div>
          <figcaption>
            <span>{sourceScreenshot.originalName}</span>
            <small>保存于本机数据目录</small>
          </figcaption>
        </figure>

        <div className="detail-content">
          <section className="detail-section">
            <div className="detail-section-title">
              <h2>订单信息</h2>
              <span>{formatDateTime(order.createdAt)} 入库</span>
            </div>
            <dl className="detail-grid">
              <DetailTerm label="平台" value={platformLabel(order.platform)} />
              <DetailTerm label="卖家账号" value={displayValue(order.sellerAccount)} />
              <DetailTerm label="订单号" value={order.orderNumber} />
              <DetailTerm label="支付宝交易号" value={displayValue(order.alipayTransactionNumber)} />
              <DetailTerm label="买家昵称" value={order.buyerNickname || '—'} />
              <DetailTerm label="平台交易状态" value={platformTransactionStatusLabel(order.platformTransactionStatus)} />
              <DetailTerm label="履约状态" value={fulfillmentStatusLabel(order.fulfillmentStatus)} />
            </dl>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h2>金额</h2>
              <span>人民币</span>
            </div>
            <dl className="detail-grid detail-grid--three">
              <DetailTerm label="商品总价" value={formatMoney(order.productTotalCents)} />
              <DetailTerm label="运费" value={formatMoney(order.shippingFeeCents)} />
              <DetailTerm label="成交金额" value={formatMoney(order.amountCents)} strong />
            </dl>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h2>交易时间</h2>
              <span>原文与规范化值</span>
            </div>
            <dl className="detail-grid">
              <DetailTerm label="下单时间（原文）" value={displayValue(order.orderedAtOriginal)} />
              <DetailTerm label="下单时间（规范化）" value={displayValue(order.orderedAtNormalized)} />
              <DetailTerm label="付款时间（原文）" value={displayValue(order.paidAtOriginal)} />
              <DetailTerm label="付款时间（规范化）" value={displayValue(order.paidAtNormalized)} />
            </dl>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h2>收货信息</h2>
              <span>完整信息</span>
            </div>
            <dl className="detail-grid">
              <DetailTerm label="收件人" value={order.recipient} />
              <DetailTerm label="手机号" value={order.phone} />
              <DetailTerm label="规范化手机号" value={displayValue(order.phoneNormalized)} />
              <DetailTerm
                label="省 / 市 / 区县"
                value={displayValue([order.province, order.city, order.district].filter(Boolean).join(' / '))}
              />
              <DetailTerm label="完整地址（原文）" value={order.addressOriginal} wide />
              <DetailTerm label="规范化地址" value={displayValue(order.addressNormalized)} wide />
            </dl>
            {recipientChanged && (
              <div className="source-change-note">
                <Icon name="history" />
                <span>识别原值“{sourceSnapshot.recognition.recipient}”已在入库前修正。</span>
              </div>
            )}
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h2>商品明细</h2>
              <span>{order.items.length} 项</span>
            </div>
            <div className="detail-items">
              {order.items.map((item, index) => (
                <div className="detail-item" key={item.id}>
                  <span className="item-index">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{item.sourceTitle}</strong>
                    <small>{item.sourceSpec || '无规格'}</small>
                  </div>
                  <span>{formatMoney(item.unitPriceCents)} × {item.quantity}</span>
                  <strong>{formatMoney(item.subtotalCents)}</strong>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function DetailTerm({ label, value, strong = false, wide = false }: { label: string; value: string; strong?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? 'detail-term detail-term--wide' : 'detail-term'}>
      <dt>{label}</dt>
      <dd className={strong ? 'is-strong' : undefined}>{value}</dd>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="inline-error" role="alert">
      <Icon name="warning" />
      <span>{message}</span>
    </div>
  );
}

type IconName =
  | 'orders'
  | 'shipment'
  | 'template'
  | 'folder'
  | 'shield'
  | 'lock'
  | 'warning'
  | 'image'
  | 'upload'
  | 'chevron'
  | 'back'
  | 'check'
  | 'history'
  | 'settings';

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    orders: <><path d="M5 4.75h14v14.5H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    shipment: <><path d="M3.5 7.5h11v9h-11zM14.5 10.5h3l3 3v3h-6z" /><circle cx="7" cy="18" r="1.5" /><circle cx="17.5" cy="18" r="1.5" /></>,
    template: <><path d="M4.5 4.5h15v15h-15zM4.5 9h15M10 9v10.5" /></>,
    folder: <path d="M3.5 6.5h6l2-2h9v14h-17z" />,
    shield: <><path d="M12 3.5 19 6v5c0 4.5-2.8 7.8-7 9.5C7.8 18.8 5 15.5 5 11V6z" /><path d="m9 12 2 2 4-4" /></>,
    lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    warning: <><path d="m12 3.5 9 16H3z" /><path d="M12 9v4.5M12 17h.01" /></>,
    image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5.5 17 4.5-4 3 2.5 2.5-2 3 3.5" /></>,
    upload: <><path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" /><path d="M5 14v5h14v-5" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
    back: <><path d="m15 5-7 7 7 7" /><path d="M8 12h11" /></>,
    check: <path d="m5 12.5 4 4L19 7" />,
    history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path d="M4 4v4.5h4.5M12 7.5V12l3 2" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.06.06-2.76 2.76-.06-.06a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.08 1.65V21H10v-.09A1.8 1.8 0 0 0 8.92 19.3a1.8 1.8 0 0 0-2 .36l-.06.06-2.76-2.76.06-.06a1.8 1.8 0 0 0 .36-2A1.8 1.8 0 0 0 2.91 14H2.8v-4h.11a1.8 1.8 0 0 0 1.61-1.08 1.8 1.8 0 0 0-.36-2l-.06-.06L6.86 4.1l.06.06a1.8 1.8 0 0 0 2 .36A1.8 1.8 0 0 0 10 2.91V2.8h4v.11a1.8 1.8 0 0 0 1.08 1.61 1.8 1.8 0 0 0 2-.36l.06-.06 2.76 2.76-.06.06a1.8 1.8 0 0 0-.36 2A1.8 1.8 0 0 0 21.09 10h.11v4h-.11A1.8 1.8 0 0 0 19.4 15Z" /></>,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function formatMoney(cents: number | null): string {
  if (cents === null) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}

function formatMoneyInput(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

function platformLabel(platform: OrderDraft['platform']): string {
  return platform === 'xianyu' ? '闲鱼' : platform;
}

function platformTransactionStatusLabel(status: OrderDraft['platformTransactionStatus']): string {
  return {
    paid: '已付款',
    cancelled: '已取消',
    refunded: '已退款',
    unknown: '未知',
  }[status];
}

function fulfillmentStatusLabel(status: OrderDraft['fulfillmentStatus']): string {
  if (status === 'shipped') return '已发货';
  if (status === 'pending_shipment') return '待发货';
  return '未知';
}

function displayValue(value?: string): string {
  return value?.trim() || '—';
}

function yuanToCents(value: string): number | null {
  const normalized = value.trim();
  if (normalized === '') return null;

  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) return null;

  const yuan = BigInt(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = yuan * 100n + BigInt(fraction || '0');
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}

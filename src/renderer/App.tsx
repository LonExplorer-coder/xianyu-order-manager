import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import type { BootstrapState, DesktopApi } from '../core/desktop-api';
import type {
  DraftItem,
  OrderChangeValue,
  OrderDetails,
  OrderDraft,
  OrderDraftReview,
  OrderSummary,
  RecognitionBatchView,
  RecognitionBatchItemStatus,
} from '../core/contracts';
import { diffOrderCurrentValues } from '../core/order-comparison';
import type { OcrSettingsView } from '../core/ocr-settings';
import type {
  OrderWorkbenchQuery,
  OrderWorkbenchResult,
} from '../core/order-workbench';
import {
  orderReviewIssueLabel,
  type OrderIntakeSettingsView,
} from '../core/order-intake';
import {
  isActiveRecognitionBatchItemStatus,
  MAX_AUTOMATIC_RECOGNITION_RETRIES,
  summarizeRecognitionBatchItems,
} from '../core/recognition-batches';
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

type BusyAction = 'directory' | 'upload' | 'cancel' | 'confirm' | 'detail' | 'review' | 'retry' | null;
type AppPage = 'orders' | 'batches' | 'settings';

const OCR_UPLOAD_DISCLOSURE = '截图会发送至您配置的阿里云百炼，原图仍保存在本机。每张截图通常调用 1 次 OCR；关键字段缺失或冲突时最多自动复核 1 次，可能产生第 2 次调用与费用。复核失败仍保留首次结果供人工校对。';
const DEFAULT_ORDER_QUERY: OrderWorkbenchQuery = {
  dateField: 'ordered_at',
  lifecycleStatus: 'active',
  sortField: 'created_at',
  sortDirection: 'desc',
};

export function App({ api }: AppProps) {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [draftReview, setDraftReview] = useState<OrderDraftReview | null>(null);
  const [reviewScreenshotUrl, setReviewScreenshotUrl] = useState('');
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null);
  const [detailScreenshotUrl, setDetailScreenshotUrl] = useState('');
  const [detailScreenshotId, setDetailScreenshotId] = useState('');
  const [recognitionBatches, setRecognitionBatches] = useState<RecognitionBatchView[]>([]);
  const [activeBatchId, setActiveBatchId] = useState('');
  const [reviewBatchId, setReviewBatchId] = useState('');
  const [busyBatchItemId, setBusyBatchItemId] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [operationError, setOperationError] = useState('');
  const [activePage, setActivePage] = useState<AppPage>('orders');
  const [orderQuery, setOrderQuery] = useState<OrderWorkbenchQuery>(DEFAULT_ORDER_QUERY);
  const [orderWorkbench, setOrderWorkbench] = useState<OrderWorkbenchResult | null>(null);
  const [orderQueryRefreshToken, setOrderQueryRefreshToken] = useState(0);
  const [orderQueryLoading, setOrderQueryLoading] = useState(false);
  const orderSnapshotVersion = useRef(0);
  const orderQueryRequestVersion = useRef(0);
  const detailSourceRequestVersion = useRef(0);
  const readyDataDirectory = bootstrap?.kind === 'ready'
    ? bootstrap.dataDirectory
    : '';

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

  useLayoutEffect(() => {
    orderSnapshotVersion.current += 1;
    setRecognitionBatches([]);
    setActiveBatchId('');
    setDraft(null);
    setDraftReview(null);
    setReviewScreenshotUrl('');
    setReviewBatchId('');
    setOrderDetails(null);
    setDetailScreenshotUrl('');
    setDetailScreenshotId('');
    detailSourceRequestVersion.current += 1;
    orderQueryRequestVersion.current += 1;
    setOrderQuery(DEFAULT_ORDER_QUERY);
    setOrderWorkbench(null);
    setOrderQueryRefreshToken(0);
    setActivePage('orders');
    setOperationError('');
  }, [readyDataDirectory]);

  useEffect(() => {
    if (!readyDataDirectory) {
      return undefined;
    }
    let active = true;
    let pushedSnapshotVersion = 0;

    const refresh = async () => {
      const requestedAtVersion = pushedSnapshotVersion;
      try {
        const batches = await api.listRecognitionBatches();
        if (!active || requestedAtVersion !== pushedSnapshotVersion) return;
        setRecognitionBatches(batches);
        setActiveBatchId((current) => current || batches[0]?.id || '');
      } catch (error) {
        if (active) setOperationError(errorMessage(error));
      }
    };

    void refresh();
    const unsubscribe = api.onRecognitionBatchesChanged((batches) => {
      if (!active) return;
      pushedSnapshotVersion += 1;
      setRecognitionBatches(batches);
      setActiveBatchId((current) => current || batches[0]?.id || '');
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, readyDataDirectory]);

  useEffect(() => {
    if (!readyDataDirectory) return undefined;
    let active = true;
    const unsubscribe = api.onOrdersChanged((orders) => {
      if (!active) return;
      orderSnapshotVersion.current += 1;
      setBootstrap((current) => (
        current?.kind === 'ready' && current.dataDirectory === readyDataDirectory
          ? { ...current, orders }
          : current
      ));
      setOrderQueryRefreshToken((current) => current + 1);
    });
    const requestedAtVersion = orderSnapshotVersion.current;
    void api.listOrders()
      .then((orders) => {
        if (!active || requestedAtVersion !== orderSnapshotVersion.current) return;
        setBootstrap((current) => (
          current?.kind === 'ready' && current.dataDirectory === readyDataDirectory
            ? { ...current, orders }
            : current
        ));
      })
      .catch((error: unknown) => {
        if (active) setOperationError(errorMessage(error));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, readyDataDirectory]);

  useEffect(() => {
    if (!readyDataDirectory) return undefined;
    let active = true;
    const requestVersion = ++orderQueryRequestVersion.current;
    setOrderQueryLoading(true);
    void api.queryOrders(orderQuery)
      .then((result) => {
        if (!active || requestVersion !== orderQueryRequestVersion.current) return;
        setOrderWorkbench(result);
      })
      .catch((error: unknown) => {
        if (active && requestVersion === orderQueryRequestVersion.current) {
          setOperationError(errorMessage(error));
        }
      })
      .finally(() => {
        if (active && requestVersion === orderQueryRequestVersion.current) {
          setOrderQueryLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, orderQuery, orderQueryRefreshToken, readyDataDirectory]);

  async function uploadScreenshots() {
    setBusyAction('upload');
    setOperationError('');
    try {
      const selectedBatch = await api.selectSourceScreenshots();
      if (!selectedBatch) return;
      setRecognitionBatches((current) => mergeRecognitionBatch(current, selectedBatch));
      setActiveBatchId(selectedBatch.id);
      setOrderDetails(null);
      const onlyItem = selectedBatch.items.length === 1 ? selectedBatch.items[0] : undefined;
      if (onlyItem?.status === 'awaiting_confirmation' && onlyItem.draftId) {
        await openDraftForReview(onlyItem.draftId, '');
      } else {
        setActivePage('batches');
      }
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function openDraftForReview(draftId: string, batchId: string) {
    setBusyAction('review');
    setOperationError('');
    try {
      const selectedReview = await api.getDraftReview(draftId);
      const selectedDraft = selectedReview.draft;
      const screenshotUrl = await api.getScreenshotDataUrl(selectedDraft.screenshotId);
      setReviewScreenshotUrl(screenshotUrl);
      setDraft(selectedDraft);
      setDraftReview(selectedReview);
      setReviewBatchId(batchId);
      setOrderDetails(null);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function retryRecognitionItem(batchId: string, itemId: string) {
    setBusyBatchItemId(itemId);
    setOperationError('');
    try {
      await api.retryRecognitionItem(batchId, itemId);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyBatchItemId('');
    }
  }

  async function createManualDraft(batchId: string, itemId: string) {
    setBusyBatchItemId(itemId);
    setOperationError('');
    try {
      const selectedDraft = await api.createManualDraft(batchId, itemId);
      const screenshotUrl = await api.getScreenshotDataUrl(selectedDraft.screenshotId);
      setRecognitionBatches((current) => updateBatchItemStatus(
        current,
        batchId,
        itemId,
        'awaiting_confirmation',
        selectedDraft.id,
      ));
      setReviewScreenshotUrl(screenshotUrl);
      setDraft(selectedDraft);
      setDraftReview({ kind: 'new_order', draft: selectedDraft });
      setReviewBatchId(batchId);
      setOrderDetails(null);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyBatchItemId('');
    }
  }

  async function confirmOrder(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!draft || bootstrap?.kind !== 'ready') return;
    setBusyAction('confirm');
    setOperationError('');
    const isOrderUpdate = draftReview?.kind === 'order_update';
    try {
      let resolution: RecognitionBatchView['items'][number]['resolution'] = 'new_order';
      if (isOrderUpdate) {
        const outcome = await api.confirmOrderUpdate(draft, draftReview.expectedRevision);
        resolution = outcome.resolution;
      } else {
        const outcome = await api.confirmDraft(draft);
        resolution = outcome.resolution;
      }
      const requestedAtVersion = orderSnapshotVersion.current;
      const orders = await api.listOrders();
      if (requestedAtVersion === orderSnapshotVersion.current) {
        setBootstrap((current) => (
          current?.kind === 'ready' && current.dataDirectory === bootstrap.dataDirectory
            ? { ...current, orders }
            : current
        ));
      }
      setOrderQueryRefreshToken((current) => current + 1);
      setRecognitionBatches((current) => updateBatchDraftStatus(
        current,
        draft.id,
        resolution === 'equivalent_order' ? 'duplicate_skipped' : 'imported',
        resolution,
      ));
      setDraft(null);
      setDraftReview(null);
      setReviewScreenshotUrl('');
      if (reviewBatchId) {
        setActiveBatchId(reviewBatchId);
        setActivePage('batches');
      }
      setReviewBatchId('');
    } catch (error) {
      if (!isOrderUpdate) {
        try {
          const transitionedReview = await api.getDraftReview(draft.id);
          if (transitionedReview.kind === 'order_update') {
            setDraft(transitionedReview.draft);
            setDraftReview(transitionedReview);
          }
        } catch {
          // Keep the current review form when the failure was unrelated to a review transition.
        }
      } else {
        try {
          const transitionedReview = await api.getDraftReview(draft.id);
          if (transitionedReview.kind === 'order_update') {
            const changedTarget = transitionedReview.currentOrder.id !==
              draftReview.currentOrder.id;
            const nextDraft = changedTarget ? transitionedReview.draft : draft;
            setDraft(nextDraft);
            setDraftReview({ ...transitionedReview, draft: nextDraft });
          }
        } catch {
          // Keep the current comparison and unsaved edits if refreshing also fails.
        }
      }
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
      setRecognitionBatches((current) => updateBatchDraftStatus(current, draft.id, 'cancelled'));
      setDraft(null);
      setDraftReview(null);
      setReviewScreenshotUrl('');
      if (reviewBatchId) {
        setActiveBatchId(reviewBatchId);
        setActivePage('batches');
      }
      setReviewBatchId('');
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function openOrder(orderId: string) {
    const requestVersion = ++detailSourceRequestVersion.current;
    setBusyAction('detail');
    setOperationError('');
    try {
      const details = await api.getOrder(orderId);
      const screenshotUrl = await api.getScreenshotDataUrl(details.sourceScreenshot.id);
      if (requestVersion !== detailSourceRequestVersion.current) return;
      setDetailScreenshotUrl(screenshotUrl);
      setDetailScreenshotId(details.sourceScreenshot.id);
      setOrderDetails(details);
    } catch (error) {
      if (requestVersion === detailSourceRequestVersion.current) {
        setOperationError(errorMessage(error));
      }
    } finally {
      if (requestVersion === detailSourceRequestVersion.current) {
        setBusyAction(null);
      }
    }
  }

  async function selectDetailSource(screenshotId: string) {
    if (screenshotId === detailScreenshotId) return;
    const requestVersion = ++detailSourceRequestVersion.current;
    setBusyAction('detail');
    setOperationError('');
    try {
      const screenshotUrl = await api.getScreenshotDataUrl(screenshotId);
      if (requestVersion !== detailSourceRequestVersion.current) return;
      setDetailScreenshotUrl(screenshotUrl);
      setDetailScreenshotId(screenshotId);
    } catch (error) {
      if (requestVersion === detailSourceRequestVersion.current) {
        setOperationError(errorMessage(error));
      }
    } finally {
      if (requestVersion === detailSourceRequestVersion.current) {
        setBusyAction(null);
      }
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
    detailSourceRequestVersion.current += 1;
    setOrderDetails(null);
    setDetailScreenshotUrl('');
    setDetailScreenshotId('');
    setOperationError('');
    setBusyAction(null);
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
        review={draftReview ?? { kind: 'new_order', draft }}
        screenshotUrl={reviewScreenshotUrl}
        error={operationError}
        cancelling={busyAction === 'cancel'}
        confirming={busyAction === 'confirm'}
        onDraftChange={setDraft}
        onCancel={() => void cancelReview()}
        onConfirm={(event) => void confirmOrder(event)}
      />
    );
  } else if (activePage === 'orders' && orderDetails) {
    workspace = (
      <DetailWorkspace
        details={orderDetails}
        screenshotUrl={detailScreenshotUrl}
        selectedScreenshotId={detailScreenshotId}
        sourceLoading={busyAction === 'detail'}
        error={operationError}
        onBack={closeDetails}
        onSelectSource={(screenshotId) => void selectDetailSource(screenshotId)}
      />
    );
  } else if (activePage === 'batches') {
    workspace = (
      <BatchesWorkspace
        batches={recognitionBatches}
        activeBatchId={activeBatchId}
        error={operationError}
        uploading={busyAction === 'upload'}
        openingDraft={busyAction === 'review'}
        busyBatchItemId={busyBatchItemId}
        onUpload={() => void uploadScreenshots()}
        onSelectBatch={setActiveBatchId}
        onReview={(draftId, batchId) => void openDraftForReview(draftId, batchId)}
        onRetry={(batchId, itemId) => void retryRecognitionItem(batchId, itemId)}
        onManualEntry={(batchId, itemId) => void createManualDraft(batchId, itemId)}
      />
    );
  } else {
    workspace = (
      <OrdersWorkspace
        orders={orderWorkbench?.orders ?? bootstrap.orders}
        batches={recognitionBatches}
        pendingConfirmationCount={recognitionBatches.reduce(
          (total, batch) => total + batch.counts.awaiting_confirmation,
          0,
        )}
        activeOrderCount={orderWorkbench?.activeOrderCount ?? bootstrap.orders.length}
        allLifecycleOrderCount={orderWorkbench?.allLifecycleOrderCount ?? bootstrap.orders.length}
        pendingShipmentCount={orderWorkbench?.pendingShipmentCount ?? 0}
        platforms={orderWorkbench?.platforms ?? []}
        sellerAccounts={orderWorkbench?.sellerAccounts ?? []}
        query={orderQuery}
        queryLoading={orderQueryLoading}
        dataDirectory={bootstrap.dataDirectory}
        error={operationError}
        uploading={busyAction === 'upload'}
        openingOrder={busyAction === 'detail'}
        onUpload={() => void uploadScreenshots()}
        onOpenBatch={(batchId) => {
          setActiveBatchId(batchId);
          setActivePage('batches');
        }}
        onOpenOrder={(orderId) => void openOrder(orderId)}
        onQueryChange={setOrderQuery}
      />
    );
  }

  return (
    <AppFrame
      dataDirectory={bootstrap.dataDirectory}
      activePage={activePage}
      activeBatchCount={recognitionBatches.reduce(
        (total, batch) => total + batch.items
          .filter((item) => isActiveRecognitionBatchItemStatus(item.status)).length,
        0,
      )}
      onNavigate={setActivePage}
    >
      {workspace}
    </AppFrame>
  );
}

function AppFrame({
  dataDirectory,
  activePage,
  activeBatchCount,
  onNavigate,
  children,
}: {
  dataDirectory: string;
  activePage: AppPage;
  activeBatchCount: number;
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
            className={`nav-item${activePage === 'batches' ? ' is-active' : ''}`}
            type="button"
            aria-current={activePage === 'batches' ? 'page' : undefined}
            onClick={() => onNavigate('batches')}
          >
            <Icon name="image" />
            <span className="nav-label">识别批次</span>
            {activeBatchCount > 0 && <span className="nav-count">{activeBatchCount}</span>}
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
  batches: RecognitionBatchView[];
  pendingConfirmationCount: number;
  activeOrderCount: number;
  allLifecycleOrderCount: number;
  pendingShipmentCount: number;
  platforms: OrderWorkbenchResult['platforms'];
  sellerAccounts: string[];
  query: OrderWorkbenchQuery;
  queryLoading: boolean;
  dataDirectory: string;
  error: string;
  uploading: boolean;
  openingOrder: boolean;
  onUpload: () => void;
  onOpenBatch: (batchId: string) => void;
  onOpenOrder: (orderId: string) => void;
  onQueryChange: (query: OrderWorkbenchQuery) => void;
};

function OrdersWorkspace({
  orders,
  batches,
  pendingConfirmationCount,
  activeOrderCount,
  allLifecycleOrderCount,
  pendingShipmentCount,
  platforms,
  sellerAccounts,
  query,
  queryLoading,
  dataDirectory,
  error,
  uploading,
  openingOrder,
  onUpload,
  onOpenBatch,
  onOpenOrder,
  onQueryChange,
}: OrdersWorkspaceProps) {
  const latestBatch = batches[0];
  const patchQuery = (patch: Partial<OrderWorkbenchQuery>) => onQueryChange({ ...query, ...patch });
  const hasActiveQuery = Boolean(
    query.text || query.buyerText || query.productText || query.dateFrom || query.dateTo ||
    query.platform || query.sellerAccount || query.initialSourceRecognitionStatus ||
    query.platformTransactionStatus || query.fulfillmentStatus ||
    (query.lifecycleStatus && query.lifecycleStatus !== 'active') ||
    query.sortField !== DEFAULT_ORDER_QUERY.sortField ||
    query.sortDirection !== DEFAULT_ORDER_QUERY.sortDirection,
  );
  if (allLifecycleOrderCount === 0) {
    return (
      <section className="empty-workspace workspace-enter">
        <div className="empty-visual" aria-hidden="true">
          <div className="document-outline"><Icon name="image" /></div>
          <span className="scan-line" />
        </div>
        <span className="section-kicker">订单工作台</span>
        <h1>还没有订单</h1>
        <p>一次可上传 1–50 张闲鱼订单截图；每张截图独立识别、校对并入库。</p>
        <InlineError message={error} />
        <button className="button button--primary button--large" type="button" onClick={onUpload} disabled={uploading}>
          <Icon name="upload" />
          {uploading ? '正在添加来源截图…' : '上传订单截图'}
        </button>
        <p className="upload-disclosure">{OCR_UPLOAD_DISCLOSURE}</p>
        <div className="empty-support">
          <span>PNG、JPG、JPEG 或 WebP</span>
          <span aria-hidden="true">·</span>
          <span>一张来源截图对应一个订单</span>
        </div>
        {latestBatch && (
          <RecentBatchStrip batch={latestBatch} onOpen={() => onOpenBatch(latestBatch.id)} />
        )}
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
          <p>显示 {orders.length} / {allLifecycleOrderCount} 笔，保留来源截图与来源快照。</p>
        </div>
        <div className="upload-action">
          <button className="button button--primary" type="button" onClick={onUpload} disabled={uploading || openingOrder}>
            <Icon name="upload" />
            {uploading ? '正在添加来源截图…' : '上传订单截图'}
          </button>
          <small>{OCR_UPLOAD_DISCLOSURE}</small>
        </div>
      </header>

      <InlineError message={error} />

      {latestBatch && (
        <RecentBatchStrip batch={latestBatch} onOpen={() => onOpenBatch(latestBatch.id)} />
      )}

      <section className="orders-overview" aria-label="订单概况">
        <span><small>在库订单</small><strong>{activeOrderCount}</strong></span>
        <span><small>待确认</small><strong>{pendingConfirmationCount}</strong></span>
        <span>
          <small>待发货</small>
          <strong>{pendingShipmentCount}</strong>
        </span>
      </section>

      <section className="order-query" aria-label="订单查询">
        <label className="order-query__search">
          <span>搜索订单</span>
          <input
            type="search"
            placeholder="订单号、买家、收件信息或商品"
            value={query.text ?? ''}
            onChange={(event) => patchQuery({
              text: event.target.value || undefined,
            })}
          />
        </label>
        <span className="order-query__result" role="status" aria-live="polite">
          {queryLoading ? '正在查询…' : `显示 ${orders.length} / ${allLifecycleOrderCount} 笔`}
        </span>
        {hasActiveQuery && (
          <button
            className="button button--quiet order-query__clear"
            type="button"
            onClick={() => onQueryChange(DEFAULT_ORDER_QUERY)}
          >
            清除筛选
          </button>
        )}
        <span className="visually-hidden">{platforms.length} 个平台，{sellerAccounts.length} 个卖家账号</span>
        <div className="order-query__filters">
          <label>
            <span>日期字段</span>
            <select
              value={query.dateField ?? 'ordered_at'}
              onChange={(event) => patchQuery({
                dateField: event.target.value as NonNullable<OrderWorkbenchQuery['dateField']>,
              })}
            >
              <option value="ordered_at">下单日期</option>
              <option value="paid_at">付款日期</option>
              <option value="created_at">入库日期</option>
            </select>
          </label>
          <label>
            <span>开始日期</span>
            <input
              type="date"
              value={query.dateFrom ?? ''}
              onChange={(event) => patchQuery({ dateFrom: event.target.value || undefined })}
            />
          </label>
          <label>
            <span>结束日期</span>
            <input
              type="date"
              value={query.dateTo ?? ''}
              onChange={(event) => patchQuery({ dateTo: event.target.value || undefined })}
            />
          </label>
          <label>
            <span>平台</span>
            <select
              value={query.platform ?? ''}
              onChange={(event) => patchQuery({
                platform: (event.target.value || undefined) as OrderWorkbenchQuery['platform'],
              })}
            >
              <option value="">全部平台</option>
              {platforms.map((platform) => (
                <option value={platform} key={platform}>{platformLabel(platform)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>卖家账号</span>
            <select
              value={query.sellerAccount ?? ''}
              onChange={(event) => patchQuery({ sellerAccount: event.target.value || undefined })}
            >
              <option value="">全部卖家</option>
              {sellerAccounts.map((sellerAccount) => (
                <option value={sellerAccount} key={sellerAccount}>{sellerAccount}</option>
              ))}
            </select>
          </label>
          <label>
            <span>买家</span>
            <input
              type="text"
              placeholder="昵称、收件人或手机号"
              value={query.buyerText ?? ''}
              onChange={(event) => patchQuery({ buyerText: event.target.value || undefined })}
            />
          </label>
          <label>
            <span>商品</span>
            <input
              type="text"
              placeholder="商品标题或规格"
              value={query.productText ?? ''}
              onChange={(event) => patchQuery({ productText: event.target.value || undefined })}
            />
          </label>
          <label>
            <span>初始来源识别状态</span>
            <select
              value={query.initialSourceRecognitionStatus ?? ''}
              onChange={(event) => patchQuery({
                initialSourceRecognitionStatus: (event.target.value || undefined) as OrderWorkbenchQuery['initialSourceRecognitionStatus'],
              })}
            >
              <option value="">全部识别状态</option>
              <option value="waiting_recognition">等待识别</option>
              <option value="recognizing">识别中</option>
              <option value="validating">校验中</option>
              <option value="awaiting_confirmation">待确认</option>
              <option value="imported">已入库</option>
              <option value="waiting_retry">等待重试</option>
              <option value="failed">识别失败</option>
              <option value="duplicate_skipped">重复跳过</option>
              <option value="cancelled">已取消</option>
            </select>
          </label>
          <label>
            <span>平台交易状态</span>
            <select
              value={query.platformTransactionStatus ?? ''}
              onChange={(event) => patchQuery({
                platformTransactionStatus: (event.target.value || undefined) as OrderWorkbenchQuery['platformTransactionStatus'],
              })}
            >
              <option value="">全部交易状态</option>
              <option value="paid">已付款</option>
              <option value="cancelled">已取消</option>
              <option value="refunded">已退款</option>
              <option value="unknown">未知</option>
            </select>
          </label>
          <label>
            <span>履约状态</span>
            <select
              value={query.fulfillmentStatus ?? ''}
              onChange={(event) => patchQuery({
                fulfillmentStatus: (event.target.value || undefined) as OrderWorkbenchQuery['fulfillmentStatus'],
              })}
            >
              <option value="">全部履约状态</option>
              <option value="pending_shipment">待发货</option>
              <option value="shipped">已发货</option>
              <option value="unknown">未知</option>
            </select>
          </label>
          <label>
            <span>生命周期状态</span>
            <select
              value={query.lifecycleStatus ?? 'active'}
              onChange={(event) => patchQuery({
                lifecycleStatus: event.target.value as NonNullable<OrderWorkbenchQuery['lifecycleStatus']>,
              })}
            >
              <option value="active">正常</option>
              <option value="trashed">回收站</option>
              <option value="deleted">已删除</option>
              <option value="all">全部生命周期</option>
            </select>
          </label>
          <label>
            <span>排序方式</span>
            <select
              value={`${query.sortField ?? 'created_at'}:${query.sortDirection ?? 'desc'}`}
              onChange={(event) => {
                const [sortField, sortDirection] = event.target.value.split(':') as [
                  NonNullable<OrderWorkbenchQuery['sortField']>,
                  NonNullable<OrderWorkbenchQuery['sortDirection']>,
                ];
                patchQuery({ sortField, sortDirection });
              }}
            >
              <option value="created_at:desc">入库时间：新到旧</option>
              <option value="created_at:asc">入库时间：旧到新</option>
              <option value="ordered_at:desc">下单时间：新到旧</option>
              <option value="ordered_at:asc">下单时间：旧到新</option>
              <option value="paid_at:desc">付款时间：新到旧</option>
              <option value="paid_at:asc">付款时间：旧到新</option>
              <option value="amount:desc">成交金额：高到低</option>
              <option value="amount:asc">成交金额：低到高</option>
              <option value="platform:asc">平台：升序</option>
              <option value="platform:desc">平台：降序</option>
              <option value="seller_account:asc">卖家账号：升序</option>
              <option value="seller_account:desc">卖家账号：降序</option>
              <option value="buyer:asc">买家：升序</option>
              <option value="buyer:desc">买家：降序</option>
              <option value="product:asc">商品：升序</option>
              <option value="product:desc">商品：降序</option>
              <option value="initial_source_recognition_status:asc">初始来源状态：升序</option>
              <option value="initial_source_recognition_status:desc">初始来源状态：降序</option>
              <option value="platform_transaction_status:asc">平台交易状态：升序</option>
              <option value="platform_transaction_status:desc">平台交易状态：降序</option>
              <option value="fulfillment_status:asc">履约状态：升序</option>
              <option value="fulfillment_status:desc">履约状态：降序</option>
              <option value="lifecycle_status:asc">生命周期状态：升序</option>
              <option value="lifecycle_status:desc">生命周期状态：降序</option>
            </select>
          </label>
        </div>
      </section>

      {orders.length === 0 ? (
        <div className="order-no-results">
          <h2>没有符合条件的订单</h2>
          <p>试试放宽日期或状态条件，也可一键清除全部筛选。</p>
        </div>
      ) : (
        <>
          <div className="table-toolbar" aria-label="订单表概况">
            <span><strong>{orders.length}</strong> 当前结果</span>
            <span><strong>{orders.reduce((total, order) => total + order.itemCount, 0)}</strong> 件商品</span>
            <span><strong>{formatMoney(orders.reduce((total, order) => total + order.amountCents, 0))}</strong> 成交总额</span>
          </div>

          <div className="table-frame">
        <table aria-label="原始订单">
          <thead>
            <tr>
              <th>订单号</th>
              <th>平台 / 卖家</th>
              <th>买家</th>
              <th>收件信息</th>
              <th>商品</th>
              <th>成交金额</th>
              <th>初始来源识别状态</th>
              <th>平台交易状态</th>
              <th>履约状态</th>
              <th>生命周期状态</th>
              <th>下单时间</th>
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
                <td>
                  <div className="order-cell-stack">
                    <strong>{platformLabel(order.platform)}</strong>
                    <small>{order.sellerAccount || '—'}</small>
                  </div>
                </td>
                <td>{order.buyerNickname || '—'}</td>
                <td>
                  <div className="order-cell-stack order-cell-stack--recipient">
                    <strong>{order.recipient}</strong>
                    <small>{order.phone || '—'}</small>
                    <small title={order.addressOriginal || undefined}>{order.addressOriginal || '—'}</small>
                  </div>
                </td>
                <td>
                  <div className="order-product-summary">
                    {order.items.map((item, index) => (
                      <span key={`${item.sourceTitle}-${index}`}>
                        {item.sourceTitle || '未命名商品'}
                        {item.sourceSpec ? ` · ${item.sourceSpec}` : ''}
                        {' ×'}{item.quantity}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="money-cell">{formatMoney(order.amountCents)}</td>
                <td><span className="status-chip">{recognitionStatusLabel(order.initialSourceRecognitionStatus)}</span></td>
                <td><span className="status-chip">{platformTransactionStatusLabel(order.platformTransactionStatus)}</span></td>
                <td><span className="status-chip">{fulfillmentStatusLabel(order.fulfillmentStatus)}</span></td>
                <td><span className="status-chip">{lifecycleStatusLabel(order.lifecycleStatus)}</span></td>
                <td>{formatDateTime(order.orderedAtNormalized || order.createdAt)}</td>
                <td><Icon name="chevron" /></td>
              </tr>
            ))}
          </tbody>
        </table>
          </div>
        </>
      )}
    </section>
  );
}

type BatchesWorkspaceProps = {
  batches: RecognitionBatchView[];
  activeBatchId: string;
  error: string;
  uploading: boolean;
  openingDraft: boolean;
  busyBatchItemId: string;
  onUpload: () => void;
  onSelectBatch: (batchId: string) => void;
  onReview: (draftId: string, batchId: string) => void;
  onRetry: (batchId: string, itemId: string) => void;
  onManualEntry: (batchId: string, itemId: string) => void;
};

function BatchesWorkspace({
  batches,
  activeBatchId,
  error,
  uploading,
  openingDraft,
  busyBatchItemId,
  onUpload,
  onSelectBatch,
  onReview,
  onRetry,
  onManualEntry,
}: BatchesWorkspaceProps) {
  const activeBatch = batches.find((batch) => batch.id === activeBatchId) ?? batches[0];

  return (
    <section className="batches-workspace workspace-enter">
      <header className="workspace-header">
        <div>
          <span className="section-kicker">来源截图识别</span>
          <h1>识别批次</h1>
          <p>离开此页不会中断；断网或重启不会丢失未完成任务，恢复后会继续处理。</p>
        </div>
        <button className="button button--primary" type="button" onClick={onUpload} disabled={uploading}>
          <Icon name="upload" />
          {uploading ? '正在添加…' : '继续上传一批'}
        </button>
      </header>

      <InlineError message={error} />

      {batches.length === 0 || !activeBatch ? (
        <div className="batch-empty">
          <Icon name="image" />
          <h2>还没有识别批次</h2>
          <p>选择 1–50 张截图后，这里会显示每张图的实时状态。</p>
          <button className="button button--primary" type="button" onClick={onUpload} disabled={uploading}>
            上传订单截图
          </button>
        </div>
      ) : (
        <div className="batch-layout">
          <aside className="batch-sidebar" aria-label="最近识别批次">
            <span className="batch-sidebar-title">最近批次</span>
            {batches.map((batch) => (
              <button
                key={batch.id}
                className={`batch-select${batch.id === activeBatch.id ? ' is-active' : ''}`}
                type="button"
                onClick={() => onSelectBatch(batch.id)}
              >
                <strong>{formatBatchTime(batch.createdAt)}</strong>
                <span>{batch.processedCount}/{batch.totalCount} 已处理</span>
              </button>
            ))}
          </aside>

          <div className="batch-main">
            <div className="batch-heading">
              <div>
                <span className="section-kicker">批次 · {formatBatchTime(activeBatch.createdAt)}</span>
                <h2>{activeBatch.totalCount} 张来源截图</h2>
              </div>
              <strong className="batch-progress-value" role="status" aria-live="polite">
                {activeBatch.processedCount}/{activeBatch.totalCount}
              </strong>
            </div>

            <progress
              className="batch-progress"
              aria-label="批次识别进度"
              max={activeBatch.totalCount}
              value={activeBatch.processedCount}
            />

            <BatchStats batch={activeBatch} />

            <div className="table-frame batch-table-frame">
              <table aria-label="批次截图状态">
                <thead>
                  <tr>
                    <th>序号</th>
                    <th>文件名</th>
                    <th>状态</th>
                    <th>结果</th>
                    <th><span className="visually-hidden">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  {activeBatch.items.map((item, index) => (
                    <tr key={item.id}>
                      <td className="batch-index">{String(index + 1).padStart(2, '0')}</td>
                      <td className="batch-filename" title={item.sourceName}>{item.sourceName}</td>
                      <td>
                        <span className={`status-chip batch-status batch-status--${item.status}`}>
                          {recognitionBatchStatusLabel(item)}
                        </span>
                      </td>
                      <td
                        className="batch-result"
                        title={recognitionBatchItemResultTitle(item)}
                      >
                        <span>{recognitionBatchItemResult(item)}</span>
                        {item.reviewIssues && item.reviewIssues.length > 0 && (
                          <ul className="batch-review-issues" aria-label="待确认原因">
                            {item.reviewIssues.map((issue) => (
                              <li key={issue}>{orderReviewIssueLabel(issue)}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        {item.status === 'awaiting_confirmation' && item.draftId && (
                          <button
                            className="text-button"
                            type="button"
                            disabled={openingDraft}
                            onClick={() => onReview(item.draftId!, activeBatch.id)}
                          >
                            校对
                          </button>
                        )}
                        {(item.status === 'waiting_retry' || item.status === 'failed') && (
                          <div className="batch-item-actions">
                            <button
                              className="text-button"
                              type="button"
                              disabled={busyBatchItemId !== ''}
                              onClick={() => onRetry(activeBatch.id, item.id)}
                            >
                              {busyBatchItemId === item.id ? '处理中…' : '立即重试'}
                            </button>
                            <button
                              className="text-button"
                              type="button"
                              disabled={busyBatchItemId !== ''}
                              onClick={() => onManualEntry(activeBatch.id, item.id)}
                            >
                              人工录入
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function RecentBatchStrip({ batch, onOpen }: { batch: RecognitionBatchView; onOpen: () => void }) {
  return (
    <section className="recent-batch" aria-label="最近识别批次">
      <div>
        <span className="section-kicker">最近批次 · {formatBatchTime(batch.createdAt)}</span>
        <strong>{batch.processedCount}/{batch.totalCount} 张已处理</strong>
      </div>
      <BatchStats batch={batch} compact />
      <button className="text-button" type="button" onClick={onOpen}>查看批次</button>
    </section>
  );
}

function BatchStats({ batch, compact = false }: { batch: RecognitionBatchView; compact?: boolean }) {
  const stats = [
    ['处理中', processingCount(batch)],
    ['待确认', batch.counts.awaiting_confirmation],
    ['已入库', batch.counts.imported],
    ['等待重试', batch.counts.waiting_retry],
    ['失败', batch.counts.failed],
    ['重复跳过', batch.counts.duplicate_skipped],
    ['已取消', batch.counts.cancelled],
  ] as const;
  return (
    <div className={compact ? 'batch-stats batch-stats--compact' : 'batch-stats'} aria-label="批次结果统计">
      {stats
        .filter(([, value]) => !compact || value > 0)
        .map(([label, value]) => (
          <span key={label}><strong>{value}</strong>{label}</span>
        ))}
    </div>
  );
}

type SettingsAction = 'loading' | 'saving' | 'removing' | 'testing' | null;
type SettingsFeedback = { kind: 'success' | 'error'; message: string } | null;

function SettingsWorkspace({ api }: { api: DesktopApi }) {
  const [settings, setSettings] = useState<OcrSettingsView | null>(null);
  const [orderIntakeSettings, setOrderIntakeSettings] =
    useState<OrderIntakeSettingsView | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<SettingsAction>('loading');
  const [orderIntakeLoading, setOrderIntakeLoading] = useState(true);
  const [savingOrderIntake, setSavingOrderIntake] = useState(false);
  const [feedback, setFeedback] = useState<SettingsFeedback>(null);
  const [orderIntakeFeedback, setOrderIntakeFeedback] = useState<SettingsFeedback>(null);
  const [showPaidCallConfirmation, setShowPaidCallConfirmation] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setSettings(null);
    setOrderIntakeSettings(null);
    setBusy('loading');
    setOrderIntakeLoading(true);
    setFeedback(null);
    setOrderIntakeFeedback(null);
    void api
      .getOrderIntakeSettings()
      .then((intakeValue) => {
        if (!active) return;
        setOrderIntakeSettings(intakeValue);
      })
      .catch((error: unknown) => {
        if (active) {
          setOrderIntakeFeedback({ kind: 'error', message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (active) setOrderIntakeLoading(false);
      });
    void api
      .getOcrSettings()
      .then((ocrValue) => {
        if (!active) return;
        setSettings(ocrValue);
        setWorkspaceId(ocrValue.workspaceId);
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

  async function toggleAutomaticImport() {
    if (!orderIntakeSettings || savingOrderIntake) return;
    const previous = orderIntakeSettings;
    const automaticImportEnabled = !previous.automaticImportEnabled;
    setOrderIntakeSettings({ automaticImportEnabled });
    setSavingOrderIntake(true);
    setOrderIntakeFeedback(null);
    try {
      const saved = await api.saveOrderIntakeSettings({ automaticImportEnabled });
      setOrderIntakeSettings(saved);
      setOrderIntakeFeedback({
        kind: 'success',
        message: saved.automaticImportEnabled ? '自动入库已开启' : '自动入库已关闭',
      });
    } catch (error) {
      setOrderIntakeSettings(previous);
      setOrderIntakeFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setSavingOrderIntake(false);
    }
  }

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
          <p>管理订单接收方式、识别服务与本机凭据。</p>
        </div>
      </header>

      <div className="settings-body">
        <form className="settings-form" aria-label="应用设置" onSubmit={(event) => void saveSettings(event)}>
          {orderIntakeLoading && !orderIntakeSettings && (
            <div className="settings-loading" role="status">正在读取自动入库设置…</div>
          )}
          {!orderIntakeLoading && !orderIntakeSettings && (
            <div className="settings-load-error">
              <SettingsNotice feedback={orderIntakeFeedback} />
              <button
                className="button button--quiet"
                type="button"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                重新读取自动入库设置
              </button>
            </div>
          )}
          {orderIntakeSettings && (
            <section className="settings-section settings-section--order-intake" aria-labelledby="order-intake-heading">
              <div className="settings-section-heading">
                <div>
                  <span className="section-kicker">订单接收</span>
                  <h2 id="order-intake-heading">自动入库</h2>
                  <p>仅将字段完整、格式正确且无交叉检查冲突的识别结果直接写入原始订单。</p>
                </div>
                <button
                  className={`settings-switch${orderIntakeSettings.automaticImportEnabled ? ' is-on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={orderIntakeSettings.automaticImportEnabled}
                  aria-label="自动入库"
                  aria-busy={savingOrderIntake}
                  disabled={savingOrderIntake}
                  onClick={() => void toggleAutomaticImport()}
                >
                  <span className="settings-switch-track" aria-hidden="true"><i /></span>
                  <span>
                    {savingOrderIntake
                      ? '正在保存…'
                      : orderIntakeSettings.automaticImportEnabled ? '已开启' : '已关闭'}
                  </span>
                </button>
              </div>
              <p className="order-intake-policy">
                缺少关键字段或存在明确冲突时仍会进入待确认，并显示需要校对的具体原因。切换后立即保存。
              </p>
              <SettingsNotice feedback={orderIntakeFeedback} />
            </section>
          )}

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
                重新读取 OCR 设置
              </button>
            </div>
          ) : (
            <>
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
            </>
          )}
        </form>
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
  review: OrderDraftReview;
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
  review,
  screenshotUrl,
  error,
  cancelling,
  confirming,
  onDraftChange,
  onCancel,
  onConfirm,
}: ReviewWorkspaceProps) {
  const [moneyErrors, setMoneyErrors] = useState<Record<string, string>>({});
  const isOrderUpdate = review.kind === 'order_update';
  const updateChanges = isOrderUpdate
    ? diffOrderCurrentValues(review.currentOrder, draft)
    : [];
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
            <span className="section-kicker">
              {isOrderUpdate ? '订单变化 · 待确认' : '识别结果 · 待确认'}
            </span>
            <h1>{isOrderUpdate ? '确认订单更新' : '校对识别结果'}</h1>
            <p>
              {isOrderUpdate
                ? '左侧是新的来源截图，请核对变化后再更新订单当前值。'
                : '左侧是来源截图，修正右侧字段后再入库。'}
            </p>
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
            {confirming
              ? (isOrderUpdate ? '正在更新…' : '正在入库…')
              : (isOrderUpdate ? '确认更新订单' : '确认并入库')}
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
          <fieldset
            className="review-form__controls"
            disabled={confirming || cancelling}
            aria-busy={confirming || cancelling}
          >
          {draft.reviewIssues && draft.reviewIssues.length > 0 && (
            <section className="review-issues" aria-labelledby="review-issues-heading">
              <div>
                <span className="section-kicker">待确认原因</span>
                <h2 id="review-issues-heading">请重点核对</h2>
              </div>
              <ul>
                {draft.reviewIssues.map((issue) => (
                  <li key={issue}>{orderReviewIssueLabel(issue)}</li>
                ))}
              </ul>
            </section>
          )}
          {isOrderUpdate && (
            <OrderUpdateComparison changes={updateChanges} />
          )}
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

          <FormSection title="订单信息" description="平台只读；卖家账号与订单号共同确定订单归属，识别有误时可在确认前修正。">
            <div className="field-grid field-grid--two">
              <Field label="平台">
                <input value={platformLabel(draft.platform)} readOnly />
              </Field>
              <Field label="卖家账号" required>
                <input
                  required
                  value={draft.sellerAccount}
                  onChange={(event) => patchDraft({ sellerAccount: event.target.value })}
                />
              </Field>
              <Field label="订单号" required>
                <input
                  required
                  value={draft.orderNumber}
                  onChange={(event) => patchDraft({ orderNumber: event.target.value })}
                />
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
          </fieldset>
        </form>
      </div>
    </section>
  );
}

function OrderUpdateComparison({
  changes,
}: {
  changes: ReturnType<typeof diffOrderCurrentValues>;
}) {
  return (
    <section className="order-update-comparison" aria-labelledby="order-update-heading">
      <div className="order-update-comparison__heading">
        <div>
          <span className="section-kicker">同一订单 · 新来源</span>
          <h2 id="order-update-heading">订单变化对比</h2>
        </div>
        <span>{changes.length} 个字段变化</span>
      </div>
      {changes.length === 0 ? (
        <p className="order-update-comparison__empty">当前没有字段变化，将只保留新的来源记录。</p>
      ) : (
        <div className="order-update-comparison__table-frame">
          <table aria-label="订单变化对比">
            <thead>
              <tr>
                <th>字段</th>
                <th>当前值</th>
                <th>新识别值</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.path}>
                  <th scope="row">{orderChangeFieldLabel(change.path)}</th>
                  <td>{formatOrderChangeValue(change.path, change.before)}</td>
                  <td className="order-update-comparison__new-value">
                    {formatOrderChangeValue(change.path, change.after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const ORDER_CHANGE_FIELD_LABELS: Record<string, string> = {
  alipayTransactionNumber: '支付宝交易号',
  buyerNickname: '买家昵称',
  recipient: '收件人',
  phone: '手机号',
  phoneNormalized: '规范化手机号',
  addressOriginal: '完整地址（原文）',
  addressNormalized: '规范化地址',
  province: '省',
  city: '市',
  district: '区 / 县',
  orderedAtOriginal: '下单时间（原文）',
  orderedAtNormalized: '下单时间（规范化）',
  paidAtOriginal: '付款时间（原文）',
  paidAtNormalized: '付款时间（规范化）',
  productTotalCents: '商品总价',
  shippingFeeCents: '运费',
  amountCents: '成交金额',
  platformTransactionStatus: '平台交易状态',
  fulfillmentStatus: '履约状态',
};

function orderChangeFieldLabel(path: string): string {
  const direct = ORDER_CHANGE_FIELD_LABELS[path];
  if (direct) return direct;
  const removedItemMatch = /^items\.removed\[(\d+)\]$/u.exec(path);
  if (removedItemMatch) {
    return `原商品 ${Number(removedItemMatch[1]) + 1} · 已移除`;
  }
  const itemMatch = /^items\[(\d+)\](?:\.(.+))?$/u.exec(path);
  if (!itemMatch) return path;
  const position = Number(itemMatch[1]) + 1;
  const field = itemMatch[2];
  const label = field ? ({
    sourceTitle: '标题',
    sourceSpec: '规格',
    unitPriceCents: '单价',
    quantity: '数量',
    quantityInferred: '数量来源',
  } as Record<string, string>)[field] : '整项';
  return `商品 ${position} · ${label ?? field}`;
}

function formatOrderChangeValue(path: string, value: OrderChangeValue): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '系统推定' : '截图明确';
  if (typeof value === 'number') {
    return /(?:Cents|unitPriceCents)$/u.test(path) ? formatMoney(value) : String(value);
  }
  if (typeof value === 'string') {
    if (path === 'platformTransactionStatus') {
      return platformTransactionStatusLabel(value as OrderDraft['platformTransactionStatus']);
    }
    if (path === 'fulfillmentStatus') {
      return fulfillmentStatusLabel(value as OrderDraft['fulfillmentStatus']);
    }
    return value || '—';
  }
  return JSON.stringify(value);
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
  selectedScreenshotId,
  sourceLoading,
  error,
  onBack,
  onSelectSource,
}: {
  details: OrderDetails;
  screenshotUrl: string;
  selectedScreenshotId: string;
  sourceLoading: boolean;
  error: string;
  onBack: () => void;
  onSelectSource: (screenshotId: string) => void;
}) {
  const { order } = details;
  const selectedSource = details.sources.find(
    (source) => source.sourceScreenshot.id === selectedScreenshotId,
  ) ?? details.sources[0];
  const sourceScreenshot = selectedSource?.sourceScreenshot ?? details.sourceScreenshot;
  const sourceSnapshot = selectedSource?.sourceSnapshot ?? details.sourceSnapshot;
  const recipientChanged = sourceSnapshot.confirmed !== null &&
    sourceSnapshot.recognition.recipient !== sourceSnapshot.confirmed.recipient;

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

          <section className="detail-section" aria-label="订单状态">
            <div className="detail-section-title">
              <h2>订单状态</h2>
              <span>来源与订单状态分开呈现</span>
            </div>
            <dl className="detail-grid detail-grid--status">
              <DetailTerm
                label="当前来源识别状态"
                value={selectedSource ? recognitionStatusLabel(selectedSource.recognitionStatus) : '—'}
              />
              <DetailTerm
                label="平台交易状态"
                value={platformTransactionStatusLabel(order.platformTransactionStatus)}
              />
              <DetailTerm label="履约状态" value={fulfillmentStatusLabel(order.fulfillmentStatus)} />
              <DetailTerm label="生命周期状态" value={lifecycleStatusLabel(order.lifecycleStatus)} />
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
                <span>
                  识别原值“{sourceSnapshot.recognition.recipient}”已在本次来源确认时修正为“
                  {sourceSnapshot.confirmed?.recipient}”。
                </span>
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

          <section className="detail-section" aria-label="来源与修改记录">
            <div className="detail-section-title">
              <h2>来源与修改记录</h2>
              <span>{details.sources.length} 份来源 · {details.changeEvents.length} 次更新</span>
            </div>

            <div className="evidence-block">
              <h3>来源证据</h3>
              <ol className="evidence-source-list" aria-label="来源证据">
                {details.sources.map(({ sourceScreenshot: source, sourceSnapshot: snapshot }) => {
                  const selected = source.id === sourceScreenshot.id;
                  const currentValueSource = snapshot.id === details.sourceSnapshot.id;
                  return (
                    <li key={snapshot.id}>
                      <button
                        className={`evidence-source${selected ? ' is-selected' : ''}`}
                        type="button"
                        aria-label={`查看来源 ${source.originalName}`}
                        aria-pressed={selected}
                        disabled={sourceLoading}
                        onClick={() => onSelectSource(source.id)}
                      >
                        <span className="evidence-source__copy">
                          <strong>{source.originalName}</strong>
                          <small>{formatDateTime(snapshot.createdAt)}</small>
                        </span>
                        <span className="evidence-source__status">
                          {currentValueSource ? '当前值来源' : '历史来源'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>

            <div className="evidence-block evidence-block--history">
              <h3>修改记录</h3>
              {details.changeEvents.length === 0 ? (
                <p className="evidence-empty">暂无修改记录，当前订单仍为首次确认值。</p>
              ) : (
                <ol className="change-event-list" aria-label="修改记录">
                  {details.changeEvents.map((event) => {
                    const eventSource = details.sources.find(({ sourceSnapshot: snapshot }) => (
                      snapshot.id === event.sourceSnapshotId
                    ));
                    return (
                      <li className="change-event" key={event.id}>
                        <header>
                          <span>
                            <strong>v{event.baseRevision} → v{event.resultRevision}</strong>
                            <small>
                              {event.source === 'source_update' ? '截图确认更新' : '手动修改'}
                              {' · '}
                              {eventSource ? (
                                <button
                                  className="change-event__source"
                                  type="button"
                                  aria-label={`查看修改来源 ${eventSource.sourceScreenshot.originalName}`}
                                  disabled={sourceLoading}
                                  onClick={() => onSelectSource(eventSource.sourceScreenshot.id)}
                                >
                                  {eventSource.sourceScreenshot.originalName}
                                </button>
                              ) : '无截图来源'}
                              {' · '}{formatDateTime(event.createdAt)}
                            </small>
                          </span>
                          <em>{event.changes.length} 个字段</em>
                        </header>
                        <dl>
                          {event.changes.map((change) => (
                            <div key={change.path}>
                              <dt>{orderChangeFieldLabel(change.path)}</dt>
                              <dd>
                                <span>{formatOrderChangeValue(change.path, change.before)}</span>
                                <b aria-hidden="true">→</b>
                                <strong>{formatOrderChangeValue(change.path, change.after)}</strong>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </li>
                    );
                  })}
                </ol>
              )}
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

function recognitionStatusLabel(status: RecognitionBatchItemStatus): string {
  const labels: Record<RecognitionBatchItemStatus, string> = {
    waiting_recognition: '等待识别',
    recognizing: '识别中',
    validating: '校验中',
    awaiting_confirmation: '待确认',
    imported: '已入库',
    waiting_retry: '等待重试',
    failed: '失败',
    duplicate_skipped: '重复跳过',
    cancelled: '已取消',
  };
  return labels[status];
}

function lifecycleStatusLabel(status: OrderSummary['lifecycleStatus']): string {
  return {
    active: '正常',
    trashed: '回收站',
    deleted: '已删除',
  }[status];
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

function formatBatchTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function recognitionBatchStatusLabel(
  item: RecognitionBatchView['items'][number],
): string {
  if (item.resolution === 'order_updated') return '已更新';
  return recognitionStatusLabel(item.status);
}

function recognitionBatchResultLabel(
  item: RecognitionBatchView['items'][number],
): string {
  const { status } = item;
  if (status === 'awaiting_confirmation') return '识别完成，请对照截图校对';
  if (status === 'imported') {
    return item.resolution === 'order_updated'
      ? '已确认字段变化并更新订单当前值'
      : '已确认并写入原始订单表';
  }
  if (status === 'duplicate_skipped') {
    return item.resolution === 'equivalent_order'
      ? '不同来源截图的订单内容等价，已记录来源且未创建重复订单'
      : '相同截图已接收过，本次未重复调用 OCR';
  }
  if (status === 'cancelled') return '已取消本张截图的校对';
  if (status === 'waiting_retry') return '已保留原图，将按受控退避自动重试';
  if (status === 'failed') return '未能形成可校对结果';
  return '后台正在处理';
}

function recognitionBatchItemResult(
  item: RecognitionBatchView['items'][number],
): string {
  if (item.status !== 'waiting_retry') {
    return item.errorMessage || recognitionBatchResultLabel(item);
  }
  const retryNumber = item.retryCount && item.retryCount > 0
    ? `（第 ${item.retryCount}/${MAX_AUTOMATIC_RECOGNITION_RETRIES} 次）`
    : '';
  const retryTime = item.nextRetryAt
    ? `，预计 ${formatDateTime(item.nextRetryAt)} 再试`
    : '';
  const reason = item.errorMessage ? `${item.errorMessage}；` : '';
  return `${reason}已保留原图，将按受控退避自动重试${retryNumber}${retryTime}`;
}

function recognitionBatchItemResultTitle(
  item: RecognitionBatchView['items'][number],
): string {
  const reasons = item.reviewIssues?.map(orderReviewIssueLabel) ?? [];
  return [recognitionBatchItemResult(item), ...reasons].join('；');
}

function processingCount(batch: RecognitionBatchView): number {
  return batch.items.filter((item) => (
    isActiveRecognitionBatchItemStatus(item.status)
  )).length;
}

function mergeRecognitionBatch(
  batches: RecognitionBatchView[],
  batch: RecognitionBatchView,
): RecognitionBatchView[] {
  const pushedSnapshot = batches.find((candidate) => candidate.id === batch.id);
  return [pushedSnapshot ?? batch, ...batches.filter((candidate) => candidate.id !== batch.id)];
}

function updateBatchDraftStatus(
  batches: RecognitionBatchView[],
  draftId: string,
  status: 'imported' | 'duplicate_skipped' | 'cancelled',
  resolution?: RecognitionBatchView['items'][number]['resolution'],
): RecognitionBatchView[] {
  return batches.map((batch) => {
    if (!batch.items.some((item) => item.draftId === draftId)) return batch;
    const items = batch.items.map((item) => (
      item.draftId === draftId
        ? {
          ...item,
          status,
          errorMessage: undefined,
          reviewIssues: [],
          resolution,
        }
        : item
    ));
    return {
      ...batch,
      items,
      ...summarizeRecognitionBatchItems(items),
    };
  });
}

function updateBatchItemStatus(
  batches: RecognitionBatchView[],
  batchId: string,
  itemId: string,
  status: RecognitionBatchItemStatus,
  draftId?: string,
): RecognitionBatchView[] {
  return batches.map((batch) => {
    if (batch.id !== batchId) return batch;
    const items = batch.items.map((item) => (
      item.id === itemId
        ? { ...item, status, errorMessage: undefined, ...(draftId ? { draftId } : {}) }
        : item
    ));
    return { ...batch, items, ...summarizeRecognitionBatchItems(items) };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}

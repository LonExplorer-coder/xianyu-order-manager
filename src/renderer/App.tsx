import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import type { BootstrapState, DesktopApi } from '../core/desktop-api';
import type {
  CustomFieldDefinition,
  CustomFieldValue,
  CustomFieldValueRecord,
  DraftCustomFieldValues,
  SaveCustomFieldValuesInput,
} from '../core/custom-fields';
import type {
  DraftItem,
  FulfillmentStatus,
  OrderChangeValue,
  OrderDetails,
  OrderDraft,
  OrderDraftReview,
  OrderEditInput,
  OrderEditReview,
  OrderStatusAndLogisticsPatch,
  OrderStatusAndLogisticsUpdateInput,
  OriginalOrder,
  OrderSummary,
  RecognitionConflictDetail,
  RecognitionBatchView,
  RecognitionBatchItemStatus,
} from '../core/contracts';
import { reviewOrderEdit } from '../core/order-edit';
import { diffOrderCurrentValues, hasSameOrderIdentity } from '../core/order-comparison';
import { matchOrderItemIds } from '../core/order-item-matching';
import type { OcrSettingsView } from '../core/ocr-settings';
import type { CandidateAdjudicationAuditView } from '../core/candidate-adjudication-audit';
import type { CandidateAdjudicationFailureCode } from '../core/candidate-verification';
import type {
  CandidateVerificationProvider,
  CandidateVerificationSettingsView,
} from '../core/candidate-verification-settings';
import type {
  OrderItemWorkbenchQuery,
  OrderItemWorkbenchResult,
  OrderWorkbenchQuery,
  OrderWorkbenchResult,
} from '../core/order-workbench';
import {
  isQuantitySource,
  quantitySourceFromLegacy,
  quantitySourceLabel,
  type QuantitySource,
} from '../core/quantity-source';
import {
  orderReviewIssueLabel,
  type OrderIntakeSettingsView,
} from '../core/order-intake';
import type { OrderExportInput, OrderExportResult } from '../core/order-export';
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
import {
  availableTableFields,
  createCustomFieldValueIndex,
  createOrderTableProjectionPlan,
  DEFAULT_ORDER_ITEM_TABLE_COLUMNS,
  DEFAULT_ORDER_TABLE_COLUMNS,
  fieldReferenceKey,
  projectOrderItemTableCell,
  projectOrderTableProjectionRow,
  tableTemplateCustomFieldDefinitionIds,
  type AvailableTableField,
  type CreateTableTemplateInput,
  type TableCellValue,
  type TableFieldReference,
  type TableTemplate,
  type TableTemplateColumn,
  type UpdateTableTemplateInput,
} from '../core/table-templates';
import { CustomFieldInput } from './CustomFieldInput';
import { CustomFieldsWorkspace } from './CustomFieldsWorkspace';
import { OrderExportDialog } from './OrderExportDialog';
import { TableTemplatesWorkspace } from './TableTemplatesWorkspace';

export type AppProps = {
  api: DesktopApi;
};

type BusyAction = 'directory' | 'upload' | 'cancel' | 'confirm' | 'detail' | 'review' | 'retry' | 'custom-fields' | 'templates' | 'order-edit' | 'status-logistics' | null;
type AppPage = 'orders' | 'batches' | 'fields' | 'templates' | 'settings';
type OrdersWorkspaceView = 'orders' | 'order_items';
type DetailDirtyKind = 'none' | 'custom_fields' | 'order_edit' | 'both';

const OCR_UPLOAD_DISCLOSURE = '截图会发送至您配置的阿里云百炼，原图仍保存在本机。每张截图调用 1 次 advanced_recognition，并由本机规则按六区拆分字段；有有限候选且已启用候选裁决时，最多追加 1 次文本模型调用。无法确定时会转入人工确认。';
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
  const [detailDirtyKind, setDetailDirtyKind] = useState<DetailDirtyKind>('none');
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
  const [ordersWorkspaceView, setOrdersWorkspaceView] = useState<OrdersWorkspaceView>('orders');
  const [orderItemQuery, setOrderItemQuery] = useState<OrderItemWorkbenchQuery>({});
  const [orderItemWorkbench, setOrderItemWorkbench] = useState<OrderItemWorkbenchResult | null>(null);
  const [orderItemQueryLoading, setOrderItemQueryLoading] = useState(false);
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<CustomFieldDefinition[]>([]);
  const [customFieldDefinitionsLoading, setCustomFieldDefinitionsLoading] = useState(false);
  const [customFieldDefinitionsError, setCustomFieldDefinitionsError] = useState('');
  const [tableTemplates, setTableTemplates] = useState<TableTemplate[]>([]);
  const [tableTemplatesLoading, setTableTemplatesLoading] = useState(false);
  const [tableTemplatesError, setTableTemplatesError] = useState('');
  const [activeTableTemplateId, setActiveTableTemplateId] = useState('');
  const [activeTableTemplateDirty, setActiveTableTemplateDirty] = useState(false);
  const [draftCustomFieldValues, setDraftCustomFieldValues] = useState<DraftCustomFieldValues>({
    orderValues: [],
    itemValues: [],
  });
  const draftCustomFieldValuesContextKey = useRef('');
  const draftCustomFieldTouchedKeys = useRef<Set<string>>(new Set());
  const orderSnapshotVersion = useRef(0);
  const orderQueryRequestVersion = useRef(0);
  const orderItemQueryRequestVersion = useRef(0);
  const tableTemplateApplyVersion = useRef(0);
  const preloadedOrderTemplateQuery = useRef<OrderWorkbenchQuery | null>(null);
  const preloadedOrderItemTemplateQuery = useRef<OrderItemWorkbenchQuery | null>(null);
  const detailSourceRequestVersion = useRef(0);
  const readyDataDirectory = bootstrap?.kind === 'ready'
    ? bootstrap.dataDirectory
    : '';
  const activeTableTemplate = tableTemplates.find(
    (template) => template.id === activeTableTemplateId,
  ) ?? null;
  const orderProjectionDefinitionIdsKey = JSON.stringify(
    orderTemplatesCustomFieldDefinitionIds(tableTemplates),
  );
  const orderProjectionDefinitionIds = useMemo(
    () => JSON.parse(orderProjectionDefinitionIdsKey) as string[],
    [orderProjectionDefinitionIdsKey],
  );
  const orderItemProjectionDefinitionIds = useMemo(() => (
    activeTableTemplate?.granularity === 'order_item'
      ? tableTemplateCustomFieldDefinitionIds(activeTableTemplate.columns)
      : []
  ), [activeTableTemplate]);

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
    setDetailDirtyKind('none');
    detailSourceRequestVersion.current += 1;
    orderQueryRequestVersion.current += 1;
    preloadedOrderTemplateQuery.current = null;
    setOrderQuery(DEFAULT_ORDER_QUERY);
    setOrderWorkbench(null);
    orderItemQueryRequestVersion.current += 1;
    tableTemplateApplyVersion.current += 1;
    preloadedOrderItemTemplateQuery.current = null;
    setOrdersWorkspaceView('orders');
    setOrderItemQuery({});
    setOrderItemWorkbench(null);
    setOrderQueryRefreshToken(0);
    setCustomFieldDefinitions([]);
    setCustomFieldDefinitionsError('');
    setTableTemplates([]);
    setTableTemplatesError('');
    setActiveTableTemplateId('');
    setActiveTableTemplateDirty(false);
    setDraftCustomFieldValues({ orderValues: [], itemValues: [] });
    draftCustomFieldValuesContextKey.current = '';
    draftCustomFieldTouchedKeys.current.clear();
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
    setCustomFieldDefinitionsLoading(true);
    setCustomFieldDefinitionsError('');
    void api.listCustomFieldDefinitions()
      .then((definitions) => {
        if (active) setCustomFieldDefinitions(definitions);
      })
      .catch((error: unknown) => {
        if (active) setCustomFieldDefinitionsError(errorMessage(error));
      })
      .finally(() => {
        if (active) setCustomFieldDefinitionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, readyDataDirectory]);

  useEffect(() => {
    if (!readyDataDirectory) return undefined;
    let active = true;
    setTableTemplatesLoading(true);
    setTableTemplatesError('');
    void api.listTableTemplates()
      .then((templates) => {
        if (active) setTableTemplates(templates);
      })
      .catch((error: unknown) => {
        if (active) setTableTemplatesError(errorMessage(error));
      })
      .finally(() => {
        if (active) setTableTemplatesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, readyDataDirectory]);

  useEffect(() => {
    if (!draft) {
      draftCustomFieldValuesContextKey.current = '';
      draftCustomFieldTouchedKeys.current.clear();
      setDraftCustomFieldValues({ orderValues: [], itemValues: [] });
      return;
    }
    const currentOrderId = draftReview?.kind === 'order_update' && hasSameOrderIdentity(
      draftReview.currentOrder,
      draft,
    )
      ? draftReview.currentOrder.id
      : 'new-order';
    const contextKey = `${draft.id}:${currentOrderId}`;
    const changedContext = draftCustomFieldValuesContextKey.current !== contextKey;
    draftCustomFieldValuesContextKey.current = contextKey;
    if (changedContext) draftCustomFieldTouchedKeys.current.clear();
    setDraftCustomFieldValues((current) => reconcileDraftCustomFieldValues(
      changedContext ? { orderValues: [], itemValues: [] } : current,
      customFieldDefinitions,
      draft,
      draftReview,
      draftCustomFieldTouchedKeys.current,
    ));
  }, [customFieldDefinitions, draft, draftReview]);

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
    if (preloadedOrderTemplateQuery.current === orderQuery) {
      preloadedOrderTemplateQuery.current = null;
      setOrderQueryLoading(false);
      return undefined;
    }
    let active = true;
    const requestVersion = ++orderQueryRequestVersion.current;
    setOrderQueryLoading(true);
    void api.queryOrders(orderQuery, orderProjectionDefinitionIds)
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
  }, [
    api,
    orderProjectionDefinitionIds,
    orderQuery,
    orderQueryRefreshToken,
    readyDataDirectory,
  ]);

  useEffect(() => {
    if (!readyDataDirectory || ordersWorkspaceView !== 'order_items') return undefined;
    if (preloadedOrderItemTemplateQuery.current === orderItemQuery) {
      preloadedOrderItemTemplateQuery.current = null;
      setOrderItemQueryLoading(false);
      return undefined;
    }
    let active = true;
    const requestVersion = ++orderItemQueryRequestVersion.current;
    setOrderItemQueryLoading(true);
    void api.queryOrderItems(orderItemQuery, orderItemProjectionDefinitionIds)
      .then((result) => {
        if (!active || requestVersion !== orderItemQueryRequestVersion.current) return;
        setOrderItemWorkbench(result);
      })
      .catch((error: unknown) => {
        if (active && requestVersion === orderItemQueryRequestVersion.current) {
          setOperationError(errorMessage(error));
        }
      })
      .finally(() => {
        if (active && requestVersion === orderItemQueryRequestVersion.current) {
          setOrderItemQueryLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [
    api,
    orderItemProjectionDefinitionIds,
    orderItemQuery,
    orderQueryRefreshToken,
    ordersWorkspaceView,
    readyDataDirectory,
  ]);

  async function refreshCustomFieldDefinitions() {
    setCustomFieldDefinitionsLoading(true);
    setCustomFieldDefinitionsError('');
    try {
      const definitions = await api.listCustomFieldDefinitions();
      setCustomFieldDefinitions(definitions);
      setOrderQueryRefreshToken((current) => current + 1);
    } catch (error) {
      setCustomFieldDefinitionsError(errorMessage(error));
      throw error;
    } finally {
      setCustomFieldDefinitionsLoading(false);
    }
  }

  async function createTableTemplate(input: CreateTableTemplateInput) {
    setBusyAction('templates');
    setTableTemplatesError('');
    try {
      const created = await api.createTableTemplate(input);
      setTableTemplates((current) => [...current, created]);
    } catch (error) {
      setTableTemplatesError(errorMessage(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function updateTableTemplate(
    templateId: string,
    input: UpdateTableTemplateInput,
  ) {
    setBusyAction('templates');
    setTableTemplatesError('');
    try {
      const updated = await api.updateTableTemplate(templateId, input);
      setTableTemplates((current) => current.map((template) => (
        template.id === updated.id ? updated : template
      )));
      if (activeTableTemplateId === updated.id) {
        const currentQuery = updated.granularity === 'order' ? orderQuery : orderItemQuery;
        setActiveTableTemplateDirty(!sameJsonValue(currentQuery, updated.query));
      }
    } catch (error) {
      setTableTemplatesError(errorMessage(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteTableTemplate(templateId: string) {
    setBusyAction('templates');
    setTableTemplatesError('');
    try {
      const template = tableTemplates.find(({ id }) => id === templateId);
      const deletingActiveTemplate = activeTableTemplateId === templateId && template !== undefined;
      let orderReset: {
        query: OrderWorkbenchQuery;
        result: OrderWorkbenchResult;
      } | null = null;
      let itemReset: {
        query: OrderItemWorkbenchQuery;
        result: OrderItemWorkbenchResult;
      } | null = null;
      if (deletingActiveTemplate) {
        tableTemplateApplyVersion.current += 1;
        if (template.granularity === 'order') {
          const query = structuredClone(DEFAULT_ORDER_QUERY);
          const remainingTemplates = tableTemplates.filter(({ id }) => id !== templateId);
          orderReset = {
            query,
            result: await api.queryOrders(
              query,
              orderTemplatesCustomFieldDefinitionIds(remainingTemplates),
            ),
          };
        } else {
          const query: OrderItemWorkbenchQuery = {};
          itemReset = { query, result: await api.queryOrderItems(query, []) };
        }
      }
      await api.deleteTableTemplate(templateId);
      setTableTemplates((current) => current.filter(({ id }) => id !== templateId));
      if (deletingActiveTemplate) {
        if (orderReset) {
          preloadedOrderTemplateQuery.current = orderReset.query;
          setOrderQuery(orderReset.query);
          setOrderWorkbench(orderReset.result);
          setOrdersWorkspaceView('orders');
        } else if (itemReset) {
          preloadedOrderItemTemplateQuery.current = itemReset.query;
          setOrderItemQuery(itemReset.query);
          setOrderItemWorkbench(itemReset.result);
          setOrdersWorkspaceView('order_items');
        }
        setActiveTableTemplateId('');
        setActiveTableTemplateDirty(false);
      }
    } catch (error) {
      setTableTemplatesError(errorMessage(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function applyTableTemplate(template: TableTemplate) {
    const requestVersion = ++tableTemplateApplyVersion.current;
    setBusyAction('templates');
    setTableTemplatesError('');
    setOperationError('');
    try {
      if (template.granularity === 'order') {
        const query = structuredClone(template.query);
        const result = await api.queryOrders(
          query,
          orderProjectionDefinitionIds,
        );
        if (requestVersion !== tableTemplateApplyVersion.current) return;
        preloadedOrderTemplateQuery.current = query;
        setOrderQuery(query);
        setOrderWorkbench(result);
        setOrdersWorkspaceView('orders');
      } else {
        const query = structuredClone(template.query);
        const result = await api.queryOrderItems(
          query,
          tableTemplateCustomFieldDefinitionIds(template.columns),
        );
        if (requestVersion !== tableTemplateApplyVersion.current) return;
        preloadedOrderItemTemplateQuery.current = query;
        setOrderItemQuery(query);
        setOrderItemWorkbench(result);
        setOrdersWorkspaceView('order_items');
      }
      setActiveTableTemplateId(template.id);
      setActiveTableTemplateDirty(false);
      setActivePage('orders');
      setOperationError('');
    } catch (error) {
      if (requestVersion === tableTemplateApplyVersion.current) {
        const message = errorMessage(error);
        setTableTemplatesError(message);
        setOperationError(message);
      }
    } finally {
      if (requestVersion === tableTemplateApplyVersion.current) {
        setBusyAction(null);
      }
    }
  }

  async function clearTableTemplate(granularity: TableTemplate['granularity']) {
    const requestVersion = ++tableTemplateApplyVersion.current;
    setBusyAction('templates');
    setTableTemplatesError('');
    setOperationError('');
    try {
      if (granularity === 'order') {
        const query = structuredClone(DEFAULT_ORDER_QUERY);
        const result = await api.queryOrders(query, orderProjectionDefinitionIds);
        if (requestVersion !== tableTemplateApplyVersion.current) return;
        preloadedOrderTemplateQuery.current = query;
        setOrderQuery(query);
        setOrderWorkbench(result);
        setOrdersWorkspaceView('orders');
      } else {
        const query: OrderItemWorkbenchQuery = {};
        const result = await api.queryOrderItems(query, []);
        if (requestVersion !== tableTemplateApplyVersion.current) return;
        preloadedOrderItemTemplateQuery.current = query;
        setOrderItemQuery(query);
        setOrderItemWorkbench(result);
        setOrdersWorkspaceView('order_items');
      }
      setActiveTableTemplateId('');
      setActiveTableTemplateDirty(false);
      setActivePage('orders');
    } catch (error) {
      if (requestVersion === tableTemplateApplyVersion.current) {
        const message = errorMessage(error);
        setTableTemplatesError(message);
        setOperationError(message);
      }
    } finally {
      if (requestVersion === tableTemplateApplyVersion.current) {
        setBusyAction(null);
      }
    }
  }

  function changeOrderQuery(query: OrderWorkbenchQuery) {
    setOrderQuery(query);
    if (activeTableTemplate?.granularity === 'order') {
      setActiveTableTemplateDirty(true);
    }
  }

  function changeOrderItemQuery(query: OrderItemWorkbenchQuery) {
    setOrderItemQuery(query);
    if (activeTableTemplate?.granularity === 'order_item') {
      setActiveTableTemplateDirty(true);
    }
  }

  async function saveActiveTableTemplateView() {
    if (!activeTableTemplate) return;
    setOperationError('');
    try {
      await updateTableTemplate(activeTableTemplate.id, {
        name: activeTableTemplate.name,
        columns: activeTableTemplate.columns,
        query: activeTableTemplate.granularity === 'order' ? orderQuery : orderItemQuery,
      });
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  }

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
        const outcome = customFieldDefinitions.length > 0
          ? await api.confirmOrderUpdate(
            draft,
            draftReview.expectedRevision,
            draftCustomFieldValues,
          )
          : await api.confirmOrderUpdate(draft, draftReview.expectedRevision);
        resolution = outcome.resolution;
      } else {
        const outcome = customFieldDefinitions.length > 0
          ? await api.confirmDraft(draft, draftCustomFieldValues)
          : await api.confirmDraft(draft);
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
          } else {
            setDraft(transitionedReview.draft);
            setDraftReview(transitionedReview);
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
      setDetailDirtyKind('none');
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

  async function saveOrderCustomFieldValues(input: SaveCustomFieldValuesInput) {
    setBusyAction('custom-fields');
    setOperationError('');
    try {
      const values = await api.saveCustomFieldValues(input);
      setOrderDetails((current) => current?.order.id === input.orderId
        ? { ...current, customFieldValues: values }
        : current);
      setOrderQueryRefreshToken((current) => current + 1);
    } catch (error) {
      setOperationError(errorMessage(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function updateExistingOrder(input: OrderEditInput): Promise<OrderDetails> {
    setBusyAction('order-edit');
    setOperationError('');
    try {
      const details = await api.updateOrder(input);
      setOrderDetails(details);
      setOrderQueryRefreshToken((current) => current + 1);
      return details;
    } catch (error) {
      setOperationError(errorMessage(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function updateOrderStatusAndLogistics(
    input: OrderStatusAndLogisticsUpdateInput,
  ): Promise<OrderDetails[]> {
    setBusyAction('status-logistics');
    setOperationError('');
    try {
      const details = await api.updateOrderStatusAndLogistics(input);
      setOrderDetails((current) => (
        details.find(({ order }) => order.id === current?.order.id) ?? current
      ));
      setOrderQueryRefreshToken((current) => current + 1);
      return details;
    } catch (error) {
      setOperationError(errorMessage(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshOrderForEdit(orderId: string): Promise<OrderDetails> {
    setBusyAction('order-edit');
    setOperationError('');
    try {
      const details = await api.getOrder(orderId);
      setOrderDetails(details);
      return details;
    } catch (error) {
      setOperationError(errorMessage(error));
      throw error;
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

  async function changeDataDirectory() {
    setBusyAction('directory');
    setOperationError('');
    try {
      setBootstrap(await api.selectDataDirectory());
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
    setDetailDirtyKind('none');
    setOperationError('');
    setBusyAction(null);
  }

  function leaveOrderDetails(action: () => void) {
    if (
      detailDirtyKind !== 'none' &&
      !window.confirm(detailDirtyKind === 'custom_fields'
        ? '自定义字段还有未保存修改，确定放弃吗？'
        : '当前订单还有未保存修改，确定放弃吗？')
    ) {
      return;
    }
    closeDetails();
    action();
  }

  function navigateTo(page: AppPage) {
    if (orderDetails) {
      leaveOrderDetails(() => setActivePage(page));
      return;
    }
    setActivePage(page);
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
        busyAction={busyAction === 'retry' || busyAction === 'directory'
          ? busyAction
          : null}
        onRetry={() => void retryBootstrap()}
        onChooseDirectory={() => void chooseDataDirectory()}
      />
    );
  }

  let workspace: ReactNode;
  if (activePage === 'settings') {
    workspace = (
      <SettingsWorkspace
        api={api}
        dataDirectory={bootstrap.dataDirectory}
        changingDataDirectory={busyAction === 'directory'}
        onChangeDataDirectory={changeDataDirectory}
      />
    );
  } else if (activePage === 'templates') {
    workspace = (
      <TableTemplatesWorkspace
        templates={tableTemplates}
        customFieldDefinitions={customFieldDefinitions}
        orderQuery={orderQuery}
        orderItemQuery={orderItemQuery}
        loading={tableTemplatesLoading}
        error={tableTemplatesError}
        saving={busyAction === 'templates'}
        onCreate={createTableTemplate}
        onUpdate={updateTableTemplate}
        onDelete={deleteTableTemplate}
        onApply={applyTableTemplate}
      />
    );
  } else if (activePage === 'fields') {
    workspace = (
      <CustomFieldsWorkspace
        api={api}
        definitions={customFieldDefinitions}
        loading={customFieldDefinitionsLoading}
        loadError={customFieldDefinitionsError}
        onRefresh={refreshCustomFieldDefinitions}
      />
    );
  } else if (draft) {
    workspace = (
      <ReviewWorkspace
        api={api}
        draft={draft}
        review={draftReview ?? { kind: 'new_order', draft }}
        screenshotUrl={reviewScreenshotUrl}
        error={operationError}
        cancelling={busyAction === 'cancel'}
        confirming={busyAction === 'confirm'}
        customFieldDefinitions={customFieldDefinitions}
        customFieldValues={draftCustomFieldValues}
        onDraftChange={setDraft}
        onCustomFieldValuesChange={setDraftCustomFieldValues}
        onCustomFieldTouched={(key) => draftCustomFieldTouchedKeys.current.add(key)}
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
        customFieldsSaving={busyAction === 'custom-fields'}
        orderEditSaving={busyAction === 'order-edit'}
        statusLogisticsSaving={busyAction === 'status-logistics'}
        error={operationError}
        onBack={() => leaveOrderDetails(() => undefined)}
        onDirtyChange={setDetailDirtyKind}
        onSelectSource={(screenshotId) => void selectDetailSource(screenshotId)}
        onSaveCustomFieldValues={saveOrderCustomFieldValues}
        onUpdateOrder={updateExistingOrder}
        onUpdateStatusAndLogistics={updateOrderStatusAndLogistics}
        onRefreshOrder={refreshOrderForEdit}
      />
    );
  } else if (activePage === 'batches') {
    workspace = (
      <BatchesWorkspace
        api={api}
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
        customFieldDefinitions={customFieldDefinitions}
        customFieldValues={orderWorkbench?.customFieldValues ?? []}
        tableTemplates={tableTemplates}
        activeTableTemplate={activeTableTemplate}
        activeTableTemplateDirty={activeTableTemplateDirty}
        view={ordersWorkspaceView}
        query={orderQuery}
        queryLoading={orderQueryLoading}
        orderItems={orderItemWorkbench?.items ?? []}
        orderItemCustomFieldValues={orderItemWorkbench?.customFieldValues ?? []}
        orderItemQuery={orderItemQuery}
        orderItemQueryLoading={orderItemQueryLoading}
        dataDirectory={bootstrap.dataDirectory}
        error={operationError}
        uploading={busyAction === 'upload'}
        openingOrder={busyAction === 'detail'}
        statusLogisticsSaving={busyAction === 'status-logistics'}
        onUpload={() => void uploadScreenshots()}
        onOpenBatch={(batchId) => {
          setActiveBatchId(batchId);
          setActivePage('batches');
        }}
        onOpenOrder={(orderId) => void openOrder(orderId)}
        onViewChange={setOrdersWorkspaceView}
        onQueryChange={changeOrderQuery}
        onOrderItemQueryChange={changeOrderItemQuery}
        onApplyTableTemplate={applyTableTemplate}
        onClearTableTemplate={clearTableTemplate}
        onManageTableTemplates={() => setActivePage('templates')}
        onSaveActiveTableTemplate={() => void saveActiveTableTemplateView()}
        onUpdateStatusAndLogistics={updateOrderStatusAndLogistics}
        onExport={(input) => api.exportOrders(input)}
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
      onNavigate={navigateTo}
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
            aria-label="订单"
            aria-current={activePage === 'orders' ? 'page' : undefined}
            onClick={() => onNavigate('orders')}
          >
            <Icon name="orders" />
            <span className="nav-label">原始订单</span>
          </button>
          <button className="nav-item" type="button" disabled>
            <Icon name="shipment" />
            <span className="nav-label">发货组</span>
            <span className="nav-badge">稍后</span>
          </button>
          <button
            className={`nav-item${activePage === 'templates' ? ' is-active' : ''}`}
            type="button"
            aria-current={activePage === 'templates' ? 'page' : undefined}
            onClick={() => onNavigate('templates')}
          >
            <Icon name="template" />
            <span className="nav-label">表格模板</span>
          </button>
          <button
            className={`nav-item${activePage === 'fields' ? ' is-active' : ''}`}
            type="button"
            aria-current={activePage === 'fields' ? 'page' : undefined}
            onClick={() => onNavigate('fields')}
          >
            <Icon name="fields" />
            <span className="nav-label">字段库</span>
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
  | {
      kind: 'error';
      message: string;
      busyAction: 'retry' | 'directory' | null;
      onRetry: () => void;
      onChooseDirectory: () => void;
    };

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
        {isLocked ? (
          <button className="button button--primary" type="button" onClick={props.onAction} disabled={props.busy}>
            {props.busy ? '正在打开…' : '选择其他目录'}
          </button>
        ) : (
          <div className="system-actions">
            <button
              className="button button--primary"
              type="button"
              onClick={props.onRetry}
              disabled={props.busyAction !== null}
            >
              {props.busyAction === 'retry' ? '正在重试…' : '重新尝试'}
            </button>
            <button
              className="button button--quiet"
              type="button"
              onClick={props.onChooseDirectory}
              disabled={props.busyAction !== null}
            >
              <Icon name="folder" />
              {props.busyAction === 'directory' ? '正在打开…' : '重新选择数据目录'}
            </button>
          </div>
        )}
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
  customFieldDefinitions: CustomFieldDefinition[];
  customFieldValues: CustomFieldValueRecord[];
  tableTemplates: TableTemplate[];
  activeTableTemplate: TableTemplate | null;
  activeTableTemplateDirty: boolean;
  view: OrdersWorkspaceView;
  query: OrderWorkbenchQuery;
  queryLoading: boolean;
  orderItems: OrderItemWorkbenchResult['items'];
  orderItemCustomFieldValues: CustomFieldValueRecord[];
  orderItemQuery: OrderItemWorkbenchQuery;
  orderItemQueryLoading: boolean;
  dataDirectory: string;
  error: string;
  uploading: boolean;
  openingOrder: boolean;
  statusLogisticsSaving: boolean;
  onUpload: () => void;
  onOpenBatch: (batchId: string) => void;
  onOpenOrder: (orderId: string) => void;
  onViewChange: (view: OrdersWorkspaceView) => void;
  onQueryChange: (query: OrderWorkbenchQuery) => void;
  onOrderItemQueryChange: (query: OrderItemWorkbenchQuery) => void;
  onApplyTableTemplate: (template: TableTemplate) => void;
  onClearTableTemplate: (granularity: TableTemplate['granularity']) => void;
  onManageTableTemplates: () => void;
  onSaveActiveTableTemplate: () => void;
  onUpdateStatusAndLogistics: (
    input: OrderStatusAndLogisticsUpdateInput,
  ) => Promise<OrderDetails[]>;
  onExport: (input: OrderExportInput) => Promise<OrderExportResult>;
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
  customFieldDefinitions,
  customFieldValues,
  tableTemplates,
  activeTableTemplate,
  activeTableTemplateDirty,
  view,
  query,
  queryLoading,
  orderItems,
  orderItemCustomFieldValues,
  orderItemQuery,
  orderItemQueryLoading,
  dataDirectory,
  error,
  uploading,
  openingOrder,
  statusLogisticsSaving,
  onUpload,
  onOpenBatch,
  onOpenOrder,
  onViewChange,
  onQueryChange,
  onOrderItemQueryChange,
  onApplyTableTemplate,
  onClearTableTemplate,
  onManageTableTemplates,
  onSaveActiveTableTemplate,
  onUpdateStatusAndLogistics,
  onExport,
}: OrdersWorkspaceProps) {
  const [selectedCustomFilterId, setSelectedCustomFilterId] = useState(
    query.customFieldFilter?.definitionId ?? '',
  );
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(() => new Set());
  const [exportPreview, setExportPreview] = useState<{
    kind: OrderExportInput['scope']['kind'];
    orders: OrderSummary[];
  } | null>(null);
  const [exportFeedback, setExportFeedback] = useState('');
  const [statusLogisticsFeedback, setStatusLogisticsFeedback] = useState('');
  const [statusLogisticsOrders, setStatusLogisticsOrders] = useState<OrderSummary[] | null>(null);
  const selectAllOrdersRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSelectedCustomFilterId(query.customFieldFilter?.definitionId ?? '');
  }, [query.customFieldFilter?.definitionId]);
  useEffect(() => {
    const visibleIds = new Set(orders.map(({ id }) => id));
    setSelectedOrderIds((current) => {
      const retained = new Set([...current].filter((id) => visibleIds.has(id)));
      return retained.size === current.size ? current : retained;
    });
  }, [orders]);
  const selectedOrders = orders.filter(({ id }) => selectedOrderIds.has(id));
  useEffect(() => {
    if (selectAllOrdersRef.current) {
      selectAllOrdersRef.current.indeterminate = selectedOrders.length > 0 &&
        selectedOrders.length < orders.length;
    }
  }, [orders.length, selectedOrders.length]);
  const latestBatch = batches[0];
  const patchQuery = (patch: Partial<OrderWorkbenchQuery>) => onQueryChange({ ...query, ...patch });
  const orderCustomFields = customFieldDefinitions.filter(
    (definition) => definition.granularity === 'order',
  );
  const selectedCustomFilter = orderCustomFields.find(
    (definition) => definition.id === selectedCustomFilterId,
  );
  const orderTemplate = activeTableTemplate?.granularity === 'order'
    ? activeTableTemplate
    : null;
  const orderColumns = orderTemplate?.columns ?? DEFAULT_ORDER_TABLE_COLUMNS;
  const customFieldValueIndex = useMemo(
    () => createCustomFieldValueIndex(customFieldValues),
    [customFieldValues],
  );
  const orderProjection = useMemo(() => {
    try {
      return {
        plan: createOrderTableProjectionPlan(orderColumns, orders, customFieldDefinitions),
        error: '',
      };
    } catch (projectionError) {
      return { plan: null, error: errorMessage(projectionError) };
    }
  }, [customFieldDefinitions, orderColumns, orders]);
  const orderFieldCatalog = availableTableFields('order', customFieldDefinitions);
  const viewGranularity = view === 'orders' ? 'order' : 'order_item';
  const hasActiveQuery = Boolean(
    query.text || query.buyerText || query.productText || query.dateFrom || query.dateTo ||
    query.platform || query.sellerAccount || query.initialSourceRecognitionStatus ||
    query.platformTransactionStatus || query.fulfillmentStatus ||
    query.customFieldFilter || query.customFieldSort ||
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
          <p>{view === 'orders'
            ? `显示 ${orders.length} / ${allLifecycleOrderCount} 笔，保留来源截图与来源快照。`
            : '逐条查看商品明细，并按商品级自定义字段筛选或排序。'}</p>
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

      <div className="workspace-view-switch" role="tablist" aria-label="工作台视图">
        <button
          id="orders-view-tab"
          type="button"
          role="tab"
          aria-selected={view === 'orders'}
          aria-controls="orders-view-panel"
          className={view === 'orders' ? 'is-active' : ''}
          onClick={() => onViewChange('orders')}
        >
          订单
        </button>
        <button
          id="order-items-view-tab"
          type="button"
          role="tab"
          aria-selected={view === 'order_items'}
          aria-controls="order-items-view-panel"
          className={view === 'order_items' ? 'is-active' : ''}
          onClick={() => onViewChange('order_items')}
        >
          商品
        </button>
      </div>

      <div className="workbench-template-bar" aria-label="当前表格模板">
        <label>
          <span>表格模板</span>
          <select
            aria-label="表格模板"
            value={activeTableTemplate?.granularity === viewGranularity ? activeTableTemplate.id : ''}
            onChange={(event) => {
              if (!event.target.value) {
                onClearTableTemplate(viewGranularity);
                return;
              }
              const template = tableTemplates.find(({ id }) => id === event.target.value);
              if (template) onApplyTableTemplate(template);
            }}
          >
            <option value="">默认视图</option>
            {tableTemplates
              .filter(({ granularity }) => granularity === viewGranularity)
              .map((template) => (
                <option value={template.id} key={template.id}>{template.name}</option>
              ))}
          </select>
        </label>
        {activeTableTemplate?.granularity === viewGranularity && (
          <span className={`template-state${activeTableTemplateDirty ? ' is-dirty' : ''}`}>
            {activeTableTemplateDirty ? '筛选或排序已修改' : '已应用保存配置'}
          </span>
        )}
        {activeTableTemplate?.granularity === viewGranularity && activeTableTemplateDirty && (
          <button
            className="button button--quiet"
            type="button"
            onClick={onSaveActiveTableTemplate}
          >
            保存当前筛选排序
          </button>
        )}
        <button className="button button--quiet" type="button" onClick={onManageTableTemplates}>
          管理模板
        </button>
      </div>

      <section className="orders-overview" aria-label="订单概况">
        <span><small>在库订单</small><strong>{activeOrderCount}</strong></span>
        <span><small>待确认</small><strong>{pendingConfirmationCount}</strong></span>
        <span>
          <small>待发货</small>
          <strong>{pendingShipmentCount}</strong>
        </span>
      </section>

      {view === 'orders' ? (
        <div
          id="orders-view-panel"
          role="tabpanel"
          aria-labelledby="orders-view-tab"
        >
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
          {exportFeedback || (queryLoading
            ? '正在查询…'
            : `显示 ${orders.length} / ${allLifecycleOrderCount} 笔`)}
        </span>
        {hasActiveQuery && (
          <button
            className="button button--quiet order-query__clear"
            type="button"
            onClick={() => {
              setSelectedCustomFilterId('');
              onQueryChange(DEFAULT_ORDER_QUERY);
            }}
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
            <span>自定义字段筛选</span>
            <select
              aria-label="自定义字段筛选"
              value={selectedCustomFilterId}
              onChange={(event) => {
                setSelectedCustomFilterId(event.target.value);
                patchQuery({ customFieldFilter: undefined });
              }}
            >
              <option value="">不筛选</option>
              {orderCustomFields.map((definition) => (
                <option value={definition.id} key={definition.id}>{definition.name}</option>
              ))}
            </select>
          </label>
          {selectedCustomFilter && (
            <CustomFieldInput
              definition={selectedCustomFilter}
              value={query.customFieldFilter?.definitionId === selectedCustomFilter.id
                ? query.customFieldFilter.value
                : null}
              label={selectedCustomFilter.type === 'multi_select'
                ? '自定义字段值（包含全部所选项）'
                : '自定义字段值'}
              showRequired={false}
              onChange={(value) => patchQuery({
                customFieldFilter: value === null
                  ? undefined
                  : { definitionId: selectedCustomFilter.id, value },
              })}
            />
          )}
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
              <option value="delivered">已收货</option>
              <option value="returned">已退货</option>
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
              value={query.customFieldSort
                ? ''
                : `${query.sortField ?? 'created_at'}:${query.sortDirection ?? 'desc'}`}
              onChange={(event) => {
                const [sortField, sortDirection] = event.target.value.split(':') as [
                  NonNullable<OrderWorkbenchQuery['sortField']>,
                  NonNullable<OrderWorkbenchQuery['sortDirection']>,
                ];
                patchQuery({ sortField, sortDirection, customFieldSort: undefined });
              }}
            >
              {query.customFieldSort && (
                <option value="" disabled>当前由自定义字段排序</option>
              )}
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
          <label>
            <span>自定义字段排序</span>
            <select
              aria-label="自定义字段排序"
              value={query.customFieldSort
                ? `${query.customFieldSort.definitionId}:${query.customFieldSort.direction}`
                : ''}
              onChange={(event) => {
                if (!event.target.value) {
                  patchQuery({ customFieldSort: undefined });
                  return;
                }
                const separator = event.target.value.lastIndexOf(':');
                patchQuery({
                  customFieldSort: {
                    definitionId: event.target.value.slice(0, separator),
                    direction: event.target.value.slice(separator + 1) as 'asc' | 'desc',
                  },
                });
              }}
            >
              <option value="">默认排序</option>
              {orderCustomFields.flatMap((definition) => ([
                <option value={`${definition.id}:asc`} key={`${definition.id}:asc`}>
                  {definition.name}：升序
                </option>,
                <option value={`${definition.id}:desc`} key={`${definition.id}:desc`}>
                  {definition.name}：降序
                </option>,
              ]))}
            </select>
          </label>
        </div>
      </section>

      <div className="table-toolbar" aria-label="订单表概况">
        <div className="table-toolbar__summary">
          <span><strong>{orders.length}</strong> 当前结果</span>
          <span><strong>{orders.reduce((total, order) => total + order.itemCount, 0)}</strong> 件商品</span>
          <span><strong>{formatMoney(orders.reduce((total, order) => total + order.amountCents, 0))}</strong> 成交总额</span>
        </div>
        <div className="table-toolbar__actions">
          {selectedOrders.length > 0 && (
            <button
              className="button button--primary"
              type="button"
              disabled={queryLoading || statusLogisticsSaving}
              onClick={() => {
                setStatusLogisticsFeedback('');
                setStatusLogisticsOrders(selectedOrders);
              }}
            >
              {`维护已选 ${selectedOrders.length} 笔`}
            </button>
          )}
          <button
            className="button button--quiet table-toolbar__export"
            type="button"
            disabled={queryLoading || orders.length === 0 || statusLogisticsSaving}
            onClick={() => {
              setExportFeedback('');
              setExportPreview({
                kind: selectedOrders.length > 0 ? 'selected_orders' : 'current_result',
                orders: selectedOrders.length > 0 ? selectedOrders : orders,
              });
            }}
          >
            {selectedOrders.length > 0
              ? `导出已选 ${selectedOrders.length} 笔`
              : `导出当前结果 ${orders.length} 笔`}
          </button>
        </div>
      </div>

      {statusLogisticsFeedback && (
        <p className="status-logistics-feedback" role="status" aria-label="状态与物流维护结果">
          {statusLogisticsFeedback}
        </p>
      )}

      <InlineError message={orderProjection.error} />

      {orderProjection.error ? null : orders.length === 0 ? (
        <div className="order-no-results">
          <h2>没有符合条件的订单</h2>
          <p>试试放宽日期或状态条件，也可一键清除全部筛选。</p>
        </div>
      ) : (
        <div className="table-frame">
        <table aria-label="原始订单">
          <thead>
            <tr>
              <th className="order-selection-cell order-selection-cell--header" scope="col">
                <input
                  ref={selectAllOrdersRef}
                  className="order-selection-checkbox"
                  type="checkbox"
                  aria-label="选择当前结果全部订单"
                  checked={orders.length > 0 && selectedOrders.length === orders.length}
                  onChange={(event) => {
                    setSelectedOrderIds(event.target.checked
                      ? new Set(orders.map(({ id }) => id))
                      : new Set());
                  }}
                />
              </th>
              {orderProjection.plan?.columns.map((column) => (
                <th key={column.key}>{column.header}</th>
              ))}
              <th><span className="visually-hidden">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const values = projectOrderTableProjectionRow(
                orderProjection.plan!,
                order,
                customFieldValueIndex,
              );
              return (
              <tr className={selectedOrderIds.has(order.id) ? 'is-selected' : undefined} key={order.id}>
                <td className="order-selection-cell">
                  <input
                    className="order-selection-checkbox"
                    type="checkbox"
                    aria-label={`选择订单 ${order.orderNumber}`}
                    checked={selectedOrderIds.has(order.id)}
                    onChange={(event) => {
                      setSelectedOrderIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(order.id);
                        else next.delete(order.id);
                        return next;
                      });
                    }}
                  />
                </td>
                {orderProjection.plan!.columns.map((column, columnIndex) => {
                  const value = values[columnIndex] ?? null;
                  if (column.kind === 'dynamic_product') {
                    return (
                      <td key={column.key}>
                        {value === null || value === '' ? '' : String(value)}
                      </td>
                    );
                  }
                  const descriptor = findTableFieldDescriptor(orderFieldCatalog, column.field);
                  return (
                    <td
                      className={column.valueType === 'money' ? 'money-cell' : undefined}
                      key={column.key}
                    >
                      {column.field.kind === 'builtin' && column.field.key === 'order_number' ? (
                        <button
                          className="order-link"
                          type="button"
                          aria-label={`查看订单 ${order.orderNumber}`}
                          onClick={() => onOpenOrder(order.id)}
                          disabled={openingOrder}
                        >
                          {order.orderNumber}
                        </button>
                      ) : renderTableCellValue(column.field, descriptor, value)}
                    </td>
                  );
                })}
                <td>
                  <div className="order-row-actions">
                    <button
                      className="order-link"
                      type="button"
                      aria-label={`维护订单状态与物流 ${order.orderNumber}`}
                      onClick={() => {
                        setStatusLogisticsFeedback('');
                        setStatusLogisticsOrders([order]);
                      }}
                      disabled={statusLogisticsSaving}
                    >
                      状态与物流
                    </button>
                    <button
                      className="order-link"
                      type="button"
                      aria-label={`打开订单详情 ${order.orderNumber}`}
                      onClick={() => onOpenOrder(order.id)}
                      disabled={openingOrder}
                    >
                      详情
                    </button>
                    {order.lastManualEditAt && (
                      <span className="manual-edit-marker">
                        <strong>已修改</strong>
                        <small>最近修改 {formatDateTime(order.lastManualEditAt)}</small>
                      </span>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {exportPreview && (
        <OrderExportDialog
          scopeKind={exportPreview.kind}
          orders={exportPreview.orders}
          customFieldDefinitions={customFieldDefinitions}
          customFieldValues={customFieldValues}
          templates={tableTemplates}
          initialOrderTemplateId={orderTemplate?.id ?? null}
          onExport={onExport}
          onClose={() => setExportPreview(null)}
          onSaved={(result) => {
            setExportFeedback(
              `已导出 ${result.orderCount} 笔订单、${result.orderItemCount} 条商品明细：${result.fileName}`,
            );
            setExportPreview(null);
          }}
        />
      )}

      {statusLogisticsOrders && (
        <OrderStatusAndLogisticsDialog
          orders={statusLogisticsOrders}
          saving={statusLogisticsSaving}
          onClose={() => setStatusLogisticsOrders(null)}
          onSave={onUpdateStatusAndLogistics}
          onSaved={() => {
            const updatedCount = statusLogisticsOrders.length;
            setStatusLogisticsOrders(null);
            if (updatedCount > 1) setSelectedOrderIds(new Set());
            setStatusLogisticsFeedback(`已更新 ${updatedCount} 笔订单。`);
          }}
        />
      )}
        </div>
      ) : (
        <OrderItemsWorkbench
          items={orderItems}
          definitions={customFieldDefinitions}
          customFieldValues={orderItemCustomFieldValues}
          columns={activeTableTemplate?.granularity === 'order_item'
            ? activeTableTemplate.columns
            : DEFAULT_ORDER_ITEM_TABLE_COLUMNS}
          query={orderItemQuery}
          loading={orderItemQueryLoading}
          openingOrder={openingOrder}
          onQueryChange={onOrderItemQueryChange}
          onOpenOrder={onOpenOrder}
        />
      )}
    </section>
  );
}

type StatusAndLogisticsOrder = Pick<
  OrderSummary,
  | 'id'
  | 'orderNumber'
  | 'revision'
  | 'platformTransactionStatus'
  | 'fulfillmentStatus'
  | 'shippingCarrier'
  | 'trackingNumber'
>;

function OrderStatusAndLogisticsDialog({
  orders,
  saving,
  onSave,
  onSaved,
  onClose,
}: {
  orders: StatusAndLogisticsOrder[];
  saving: boolean;
  onSave: (input: OrderStatusAndLogisticsUpdateInput) => Promise<OrderDetails[]>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const [platformTransactionStatus, setPlatformTransactionStatus] = useState<
    '' | NonNullable<OrderStatusAndLogisticsPatch['platformTransactionStatus']>
  >('');
  const [fulfillmentStatus, setFulfillmentStatus] = useState<
    '' | NonNullable<OrderStatusAndLogisticsPatch['fulfillmentStatus']>
  >('');
  const [shippingCarrierEnabled, setShippingCarrierEnabled] = useState(false);
  const [trackingNumberEnabled, setTrackingNumberEnabled] = useState(false);
  const [shippingCarrier, setShippingCarrier] = useState(() => commonOrderText(
    orders,
    'shippingCarrier',
  ));
  const [trackingNumber, setTrackingNumber] = useState(() => commonOrderText(
    orders,
    'trackingNumber',
  ));
  const [error, setError] = useState('');
  const hasPatch = Boolean(
    platformTransactionStatus || fulfillmentStatus ||
    shippingCarrierEnabled || trackingNumberEnabled,
  );

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    firstFieldRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !hasPatch || orders.length === 0) return;
    const patch: OrderStatusAndLogisticsPatch = {};
    if (platformTransactionStatus) patch.platformTransactionStatus = platformTransactionStatus;
    if (fulfillmentStatus) patch.fulfillmentStatus = fulfillmentStatus;
    if (shippingCarrierEnabled) patch.shippingCarrier = shippingCarrier;
    if (trackingNumberEnabled) patch.trackingNumber = trackingNumber;
    setError('');
    try {
      await onSave({
        targets: orders.map((order) => ({
          orderId: order.id,
          expectedRevision: order.revision ?? 1,
        })),
        patch,
      });
      onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      if (!saving) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = dialogRef.current
      ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ))
      : [];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="order-export-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <form className="order-status-logistics-dialog" onSubmit={(event) => void save(event)}>
        <header>
          <span className="section-kicker">订单当前值 · 人工维护</span>
          <h2 id={headingId}>维护状态与物流</h2>
          <p id={descriptionId}>
            {orders.length === 1
              ? `仅修改订单 ${orders[0].orderNumber}；未选择的字段保持不变。`
              : `相同值将应用到已选 ${orders.length} 笔订单；未选择的字段保持不变。`}
          </p>
        </header>

        <div className="order-status-logistics-dialog__fields">
          <label className="order-status-logistics-dialog__field">
            <span>平台交易状态</span>
            <select
              ref={firstFieldRef}
              aria-label="平台交易状态"
              value={platformTransactionStatus}
              disabled={saving}
              onChange={(event) => setPlatformTransactionStatus(
                event.target.value as typeof platformTransactionStatus,
              )}
            >
              <option value="">不修改</option>
              <option value="paid">已付款</option>
              <option value="cancelled">已取消</option>
              <option value="refunded">已退款</option>
              <option value="unknown">未知</option>
            </select>
          </label>
          <label className="order-status-logistics-dialog__field">
            <span>履约状态</span>
            <select
              aria-label="履约状态"
              value={fulfillmentStatus}
              disabled={saving}
              onChange={(event) => setFulfillmentStatus(
                event.target.value as typeof fulfillmentStatus,
              )}
            >
              <option value="">不修改</option>
              <option value="pending_shipment">待发货</option>
              <option value="shipped">已发货</option>
              <option value="delivered">已收货</option>
              <option value="returned">已退货</option>
              <option value="unknown">未知</option>
            </select>
          </label>
          <div className="order-status-logistics-dialog__field">
            <label className="order-status-logistics-dialog__toggle">
              <input
                type="checkbox"
                aria-label="修改快递公司"
                checked={shippingCarrierEnabled}
                disabled={saving}
                onChange={(event) => setShippingCarrierEnabled(event.target.checked)}
              />
              <span>修改快递公司</span>
            </label>
            <input
              type="text"
              aria-label="快递公司"
              value={shippingCarrier}
              disabled={saving || !shippingCarrierEnabled}
              placeholder="留空并提交即清空"
              onChange={(event) => setShippingCarrier(event.target.value)}
            />
          </div>
          <div className="order-status-logistics-dialog__field">
            <label className="order-status-logistics-dialog__toggle">
              <input
                type="checkbox"
                aria-label="修改运单号"
                checked={trackingNumberEnabled}
                disabled={saving}
                onChange={(event) => setTrackingNumberEnabled(event.target.checked)}
              />
              <span>修改运单号</span>
            </label>
            <input
              type="text"
              aria-label="运单号"
              value={trackingNumber}
              disabled={saving || !trackingNumberEnabled}
              placeholder="留空并提交即清空"
              onChange={(event) => setTrackingNumber(event.target.value)}
            />
          </div>
        </div>

        <p className="order-status-logistics-dialog__notice">
          填写有效运单号时，待发货会自动同步为已发货；清空运单号时，已发货会退回待发货。
          已收货、已退货等终态不会被自动覆盖。已取消或已退款的订单仍保留在系统中，但不进入待发货视图；
          平台交易状态不会自动改写履约状态。
        </p>
        {error && <p className="order-status-logistics-dialog__error" role="alert">{error}</p>}
        <footer className="order-status-logistics-dialog__actions">
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button className="button button--primary" type="submit" disabled={saving || !hasPatch}>
            {saving ? '正在保存…' : `确认修改 ${orders.length} 笔`}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function commonOrderText(
  orders: StatusAndLogisticsOrder[],
  field: 'shippingCarrier' | 'trackingNumber',
): string {
  const first = orders[0]?.[field] ?? '';
  return orders.every((order) => order[field] === first) ? first : '';
}

type OrderItemsWorkbenchProps = {
  items: OrderItemWorkbenchResult['items'];
  definitions: CustomFieldDefinition[];
  customFieldValues: CustomFieldValueRecord[];
  columns: TableTemplateColumn[];
  query: OrderItemWorkbenchQuery;
  loading: boolean;
  openingOrder: boolean;
  onQueryChange: (query: OrderItemWorkbenchQuery) => void;
  onOpenOrder: (orderId: string) => void;
};

function OrderItemsWorkbench({
  items,
  definitions,
  customFieldValues,
  columns,
  query,
  loading,
  openingOrder,
  onQueryChange,
  onOpenOrder,
}: OrderItemsWorkbenchProps) {
  const customFieldValueIndex = useMemo(
    () => createCustomFieldValueIndex(customFieldValues),
    [customFieldValues],
  );
  const [selectedFilterId, setSelectedFilterId] = useState(
    query.customFieldFilter?.definitionId ?? '',
  );
  useEffect(() => {
    setSelectedFilterId(query.customFieldFilter?.definitionId ?? '');
  }, [query.customFieldFilter?.definitionId]);
  const itemFields = definitions.filter(
    (definition) => definition.granularity === 'order_item',
  );
  const selectedFilter = itemFields.find(
    (definition) => definition.id === selectedFilterId,
  );
  const fieldCatalog = availableTableFields('order_item', definitions);
  const patchQuery = (patch: Partial<OrderItemWorkbenchQuery>) => {
    onQueryChange({ ...query, ...patch });
  };
  const hasActiveQuery = Boolean(
    query.sourceTitle || query.sourceSpec || query.unitPriceCents !== undefined ||
    query.quantity !== undefined || query.quantitySource || query.sortField ||
    query.customFieldFilter || query.customFieldSort,
  );

  return (
    <div
      id="order-items-view-panel"
      role="tabpanel"
      aria-labelledby="order-items-view-tab"
    >
      <section className="order-query order-item-query" aria-label="商品查询">
        <div className="order-item-query__heading">
          <strong>商品级字段</strong>
          <span>精确筛选原始商品事实，也可组合商品明细粒度的自定义字段。</span>
        </div>
        <span className="order-query__result" role="status" aria-live="polite">
          {loading ? '正在查询…' : `显示 ${items.length} 条商品明细`}
        </span>
        {hasActiveQuery && (
          <button
            className="button button--quiet order-query__clear"
            type="button"
            onClick={() => {
              setSelectedFilterId('');
              onQueryChange({});
            }}
          >
            清除筛选
          </button>
        )}
        <div className="order-query__filters order-item-query__filters">
          <label>
            <span>原始商品标题</span>
            <input
              type="search"
              aria-label="原始商品标题精确筛选"
              value={query.sourceTitle ?? ''}
              onChange={(event) => patchQuery({
                sourceTitle: event.target.value || undefined,
              })}
            />
          </label>
          <label>
            <span>原始款式／规格</span>
            <input
              type="search"
              aria-label="原始款式／规格精确筛选"
              value={query.sourceSpec ?? ''}
              onChange={(event) => patchQuery({
                sourceSpec: event.target.value || undefined,
              })}
            />
          </label>
          <label>
            <span>商品单价（元）</span>
            <input
              type="number"
              min="0"
              step="0.01"
              aria-label="商品单价（元）精确筛选"
              value={formatMoneyInput(query.unitPriceCents ?? null)}
              onChange={(event) => {
                const value = event.target.value;
                patchQuery({
                  unitPriceCents: value === ''
                    ? undefined
                    : Math.round(Number(value) * 100),
                });
              }}
            />
          </label>
          <label>
            <span>商品数量</span>
            <input
              type="number"
              min="1"
              step="1"
              aria-label="商品数量精确筛选"
              value={query.quantity ?? ''}
              onChange={(event) => patchQuery({
                quantity: event.target.value === '' ? undefined : Number(event.target.value),
              })}
            />
          </label>
          <label>
            <span>数量来源</span>
            <select
              aria-label="商品数量来源精确筛选"
              value={query.quantitySource ?? ''}
              onChange={(event) => patchQuery({
                quantitySource: event.target.value
                  ? event.target.value as QuantitySource
                  : undefined,
              })}
            >
              <option value="">全部来源</option>
              <option value="manual">人工修改</option>
              <option value="ocr_explicit">OCR 识别</option>
              <option value="system_default_1">系统默认 1</option>
              <option value="legacy_explicit_or_manual">已明确（历史来源不明）</option>
            </select>
          </label>
          <label>
            <span>内置排序</span>
            <select
              aria-label="商品明细内置排序"
              value={query.sortField
                ? `${query.sortField}:${query.sortDirection ?? 'asc'}`
                : ''}
              onChange={(event) => {
                if (!event.target.value) {
                  patchQuery({ sortField: undefined, sortDirection: undefined });
                  return;
                }
                const separator = event.target.value.lastIndexOf(':');
                patchQuery({
                  sortField: event.target.value.slice(0, separator) as NonNullable<
                    OrderItemWorkbenchQuery['sortField']
                  >,
                  sortDirection: event.target.value.slice(separator + 1) as 'asc' | 'desc',
                  customFieldSort: undefined,
                });
              }}
            >
              <option value="">默认排序</option>
              <option value="source_title:asc">原始商品标题：升序</option>
              <option value="source_title:desc">原始商品标题：降序</option>
              <option value="source_spec:asc">原始款式／规格：升序</option>
              <option value="source_spec:desc">原始款式／规格：降序</option>
              <option value="unit_price:asc">商品单价：从低到高</option>
              <option value="unit_price:desc">商品单价：从高到低</option>
              <option value="quantity:asc">商品数量：从少到多</option>
              <option value="quantity:desc">商品数量：从多到少</option>
              <option value="quantity_source:asc">数量来源：从系统默认到人工</option>
              <option value="quantity_source:desc">数量来源：从人工到系统默认</option>
            </select>
          </label>
          <label>
            <span>自定义字段筛选</span>
            <select
              aria-label="商品自定义字段筛选"
              value={selectedFilterId}
              onChange={(event) => {
                setSelectedFilterId(event.target.value);
                patchQuery({ customFieldFilter: undefined });
              }}
            >
              <option value="">不筛选</option>
              {itemFields.map((definition) => (
                <option value={definition.id} key={definition.id}>{definition.name}</option>
              ))}
            </select>
          </label>
          {selectedFilter && (
            <CustomFieldInput
              definition={selectedFilter}
              value={query.customFieldFilter?.definitionId === selectedFilter.id
                ? query.customFieldFilter.value
                : null}
              label={selectedFilter.type === 'multi_select'
                ? '商品自定义字段值（包含全部所选项）'
                : '商品自定义字段值'}
              showRequired={false}
              onChange={(value) => patchQuery({
                customFieldFilter: value === null
                  ? undefined
                  : { definitionId: selectedFilter.id, value },
              })}
            />
          )}
          <label>
            <span>自定义字段排序</span>
            <select
              aria-label="商品自定义字段排序"
              value={query.customFieldSort
                ? `${query.customFieldSort.definitionId}:${query.customFieldSort.direction}`
                : ''}
              onChange={(event) => {
                if (!event.target.value) {
                  patchQuery({ customFieldSort: undefined });
                  return;
                }
                const separator = event.target.value.lastIndexOf(':');
                patchQuery({
                  customFieldSort: {
                    definitionId: event.target.value.slice(0, separator),
                    direction: event.target.value.slice(separator + 1) as 'asc' | 'desc',
                  },
                  sortField: undefined,
                  sortDirection: undefined,
                });
              }}
            >
              <option value="">默认排序</option>
              {itemFields.flatMap((definition) => ([
                <option value={`${definition.id}:asc`} key={`${definition.id}:asc`}>
                  {definition.name}：升序
                </option>,
                <option value={`${definition.id}:desc`} key={`${definition.id}:desc`}>
                  {definition.name}：降序
                </option>,
              ]))}
            </select>
          </label>
        </div>
      </section>

      {items.length === 0 ? (
        <div className="order-no-results">
          <h2>没有符合条件的商品明细</h2>
          <p>试试更换字段值，或清除当前筛选。</p>
        </div>
      ) : (
        <>
          <div className="table-toolbar" aria-label="商品表概况">
            <span><strong>{items.length}</strong> 条商品明细</span>
            <span><strong>{items.reduce((total, item) => total + item.quantity, 0)}</strong> 件商品</span>
            <span><strong>{formatMoney(items.reduce((total, item) => total + item.subtotalCents, 0))}</strong> 商品小计</span>
          </div>

          <div className="table-frame order-items-table-frame">
            <table aria-label="商品明细">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={fieldReferenceKey(column.field)}>{column.displayName}</th>
                  ))}
                  <th><span className="visually-hidden">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    {columns.map((column) => {
                      const descriptor = findTableFieldDescriptor(fieldCatalog, column.field);
                      const value = projectOrderItemTableCell(
                        item,
                        column.field,
                        customFieldValueIndex,
                      );
                      return (
                        <td
                          className={descriptor?.valueType === 'money' ? 'money-cell' : undefined}
                          key={fieldReferenceKey(column.field)}
                        >
                          {column.field.kind === 'builtin' && column.field.key === 'order_number' ? (
                            <button
                              className="order-link"
                              type="button"
                              aria-label={`打开订单 ${item.orderNumber}`}
                              onClick={() => onOpenOrder(item.orderId)}
                              disabled={openingOrder}
                            >
                              {item.orderNumber}
                            </button>
                          ) : renderTableCellValue(column.field, descriptor, value)}
                        </td>
                      );
                    })}
                    <td>
                      <button
                        className="order-link"
                        type="button"
                        aria-label={`打开商品 ${item.sourceTitle || '未命名商品'} 所属订单`}
                        onClick={() => onOpenOrder(item.orderId)}
                        disabled={openingOrder}
                      >
                        打开所属订单
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

type BatchesWorkspaceProps = {
  api: DesktopApi;
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
  api,
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
                        <RecognitionConflictDetails
                          details={item.recognitionConflicts}
                        />
                      </td>
                      <td>
                        <div className="batch-item-actions">
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
                            <>
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
                            </>
                          )}
                          {item.draftId && (
                            <BatchCandidateAdjudicationAction
                              api={api}
                              draftId={item.draftId}
                            />
                          )}
                        </div>
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

function BatchCandidateAdjudicationAction({
  api,
  draftId,
}: {
  api: DesktopApi;
  draftId: string;
}) {
  const candidateAudit = useCandidateAdjudicationAudit(api, draftId);
  return (
    <CandidateAdjudicationSummary
      audits={candidateAudit.audits}
      loading={candidateAudit.loading}
      error={candidateAudit.error}
      compact
    />
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

type RecognitionConflictDetailsProps = {
  details?: RecognitionConflictDetail[];
};

type ConflictPopoverPosition = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

const RECOGNITION_CONFLICT_REGION_LABELS: Record<RecognitionConflictDetail['region'], string> = {
  platform_status: '平台状态区',
  shipping_information: '收货信息区',
  purchased_items: '商品信息区',
  amount_summary: '金额汇总区',
  order_details: '订单详情区',
};

const RECOGNITION_CONFLICT_FIELD_LABELS: Record<RecognitionConflictDetail['field'], string> = {
  module_structure: '模块结构',
  platform_status: '平台交易状态',
  recipient: '收件人',
  recipient_phone_line_text: '收件人与手机号原行',
  phone: '手机号',
  address: '收货地址',
  province: '省',
  city: '市',
  district: '区县',
  shipping_controls: '收货信息区按钮',
  item_title: '商品标题',
  item_spec: '商品规格',
  item_unit_price: '商品单价',
  item_quantity: '商品数量',
  item_controls: '商品信息区按钮',
  product_total: '商品总额',
  shipping_fee: '运费',
  amount: '成交金额',
  detail_state: '订单详情展开状态',
  order_number: '订单号',
  alipay_transaction_number: '支付宝交易号',
  buyer_nickname_label: '买家昵称标签',
  buyer_nickname: '买家昵称',
  order_time: '下单时间',
  payment_time: '付款时间',
  order_detail_controls: '订单详情区按钮',
};

const RECOGNITION_CONFLICT_KIND_LABELS: Record<RecognitionConflictDetail['kind'], string> = {
  multiple_candidates: '同一区域发现多个候选值',
  value_mismatch: '字段候选值未能自动对齐',
  unsupported_value: '指定区域未找到对应内容',
  outside_region: '内容来自指定区域外',
  instruction_echo: '把字段说明当成识别结果',
};

function RecognitionConflictDetails({
  details,
}: RecognitionConflictDetailsProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ConflictPopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const visible = details && details.length > 0;
  const groups = useMemo(() => {
    if (!details) return [];
    return details.reduce<Array<{
      region: RecognitionConflictDetail['region'];
      details: RecognitionConflictDetail[];
    }>>((result, detail) => {
      const group = result.find((entry) => entry.region === detail.region);
      if (group) group.details.push(detail);
      else result.push({ region: detail.region, details: [detail] });
      return result;
    }, []);
  }, [details]);

  function updatePosition() {
    if (!triggerRef.current) return;
    setPosition(conflictPopoverPosition(triggerRef.current.getBoundingClientRect()));
  }

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    dialogRef.current?.focus();
    const handleViewportChange = () => updatePosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dialogRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dialogRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!visible && open) setOpen(false);
  }, [open, visible]);

  if (!visible) return null;

  const dialogStyle: CSSProperties | undefined = position
    ? {
      left: position.left,
      width: position.width,
      maxHeight: position.maxHeight,
      ...(position.top === undefined ? {} : { top: position.top }),
      ...(position.bottom === undefined ? {} : { bottom: position.bottom }),
    }
    : { visibility: 'hidden' };

  return (
    <>
      <button
        ref={triggerRef}
        className="recognition-conflict-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          updatePosition();
          setOpen(true);
        }}
      >
        查看冲突详情
      </button>
      {open && createPortal(
        <div
          ref={dialogRef}
          id={dialogId}
          className="recognition-conflict-popover"
          role="dialog"
          aria-label="识别冲突详情"
          tabIndex={-1}
          style={dialogStyle}
        >
          <header className="recognition-conflict-popover__header">
            <div>
              <span className="section-kicker">区域与字段候选对照</span>
              <h2>识别冲突详情</h2>
            </div>
            <button
              className="recognition-conflict-popover__close"
              type="button"
              aria-label="关闭识别冲突详情"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <p className="recognition-conflict-popover__intro">
            以下 {details.length} 项结果未能自动对齐，请对照来源截图确认。
          </p>
          <div className="recognition-conflict-popover__groups">
            {groups.map((group) => (
              <section className="recognition-conflict-group" key={group.region}>
                <h3>{RECOGNITION_CONFLICT_REGION_LABELS[group.region]}</h3>
                <ul>
                  {group.details.map((detail, index) => (
                    <li key={`${detail.field}:${detail.itemIndex ?? 'order'}:${index}`}>
                      <div className="recognition-conflict-item__heading">
                        <strong>
                          {RECOGNITION_CONFLICT_FIELD_LABELS[detail.field]}
                          {detail.itemIndex === undefined ? '' : ` · 商品 ${detail.itemIndex + 1}`}
                        </strong>
                        <span>{RECOGNITION_CONFLICT_KIND_LABELS[detail.kind]}</span>
                      </div>
                      <dl>
                        <ConflictValueRow
                          label={isAddressPartConflict(detail) ? '地址拆分值' : '区域候选值'}
                          values={detail.locatedValues}
                        />
                        <ConflictValueRow label="字段候选值" values={detail.extractedValues} />
                        <ConflictValueRow
                          label={isAddressPartConflict(detail) ? '当前采用值' : '当前保留值'}
                          values={detail.retainedValue === null ? [] : [detail.retainedValue]}
                          emptyLabel={isAddressPartConflict(detail) ? '未采用' : '未保留'}
                        />
                      </dl>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

const CANDIDATE_AUDIT_REGION_LABELS: Record<
  CandidateAdjudicationAuditView['decisions'][number]['region'],
  string
> = {
  platform_status: '平台状态区',
  shipping_information: '收货信息区',
  purchased_items: '商品信息区',
  amount_summary: '金额汇总区',
  order_details: '订单详情区',
  fulfillment_signals: '履约信号区',
};

function useCandidateAdjudicationAudit(api: DesktopApi, draftId: string) {
  const [audits, setAudits] = useState<CandidateAdjudicationAuditView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setAudits([]);
    setLoading(true);
    setError('');
    void api.getCandidateAdjudicationAudit(draftId)
      .then((value) => {
        if (active) setAudits(value);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, draftId]);

  return { audits, loading, error };
}

function CandidateAdjudicationSummary({
  audits,
  loading,
  error,
  compact = false,
}: {
  audits: CandidateAdjudicationAuditView[];
  loading: boolean;
  error: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ConflictPopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const decisions = audits.flatMap((audit) => audit.decisions);
  const selectedCount = decisions.filter((decision) => decision.outcome === 'selected').length;
  const unresolvedCount = decisions.filter((decision) => decision.outcome !== 'selected').length;
  const failedCount = audits.filter((audit) => (
    audit.status === 'failed' || audit.status === 'rejected'
  )).length;

  function updatePosition() {
    if (!triggerRef.current) return;
    setPosition(conflictPopoverPosition(triggerRef.current.getBoundingClientRect()));
  }

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    dialogRef.current?.focus();
    const handleViewportChange = () => updatePosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dialogRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [open]);

  if (loading && audits.length === 0) return null;
  if (audits.length === 0) {
    return error && !compact ? (
      <p className="candidate-audit-load-error" role="status">
        候选裁决记录暂时无法读取，可继续人工校对。
      </p>
    ) : null;
  }

  const dialogStyle: CSSProperties | undefined = position
    ? {
      left: position.left,
      width: position.width,
      maxHeight: position.maxHeight,
      ...(position.top === undefined ? {} : { top: position.top }),
      ...(position.bottom === undefined ? {} : { bottom: position.bottom }),
    }
    : { visibility: 'hidden' };

  return (
    <section
      className={`candidate-audit-summary${compact ? ' candidate-audit-summary--compact' : ''}`}
      aria-label="候选裁决摘要"
    >
      {!compact && (
        <div>
          <span className="section-kicker">有限候选裁决</span>
          <p>
            {selectedCount > 0 && <strong>已选择 {selectedCount} 项</strong>}
            {unresolvedCount > 0 && <strong>未确定 {unresolvedCount} 项</strong>}
            {failedCount > 0 && <strong>调用失败 {failedCount} 次</strong>}
          </p>
        </div>
      )}
      <button
        ref={triggerRef}
        className="recognition-conflict-trigger"
        type="button"
        aria-label={compact ? '查看候选裁决详情' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          updatePosition();
          setOpen(true);
        }}
      >
        {compact ? '查看裁决' : '查看候选裁决详情'}
      </button>
      {open && createPortal(
        <div
          ref={dialogRef}
          id={dialogId}
          className="recognition-conflict-popover candidate-audit-popover"
          role="dialog"
          aria-label="候选裁决详情"
          tabIndex={-1}
          style={dialogStyle}
        >
          <header className="recognition-conflict-popover__header">
            <div>
              <span className="section-kicker">有界输入 · 可追溯结果</span>
              <h2>候选裁决详情</h2>
            </div>
            <button
              className="recognition-conflict-popover__close"
              type="button"
              aria-label="关闭候选裁决详情"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <p className="recognition-conflict-popover__intro">
            这里只展示发送前的有限候选、依据行和最终选择，不展示密钥或模型原始响应。
          </p>
          <div className="candidate-audit-runs">
            {audits.map((audit) => (
              <section className="candidate-audit-run" key={audit.id}>
                <header>
                  <div>
                    <span>{candidateProviderLabel(audit.provider)}</span>
                    <strong>{audit.model}</strong>
                  </div>
                  <span className={`candidate-audit-status is-${audit.status}`}>
                    {candidateAuditStatusLabel(audit.status)}
                  </span>
                </header>
                <dl className="candidate-audit-meta">
                  <div>
                    <dt>调用时间</dt>
                    <dd><time dateTime={audit.createdAt}>{formatDateTime(audit.createdAt)}</time></dd>
                  </div>
                  <div>
                    <dt>本地调用编号</dt>
                    <dd>{audit.id}</dd>
                  </div>
                  {audit.failureCode && (
                    <div>
                      <dt>失败类型</dt>
                      <dd>{candidateFailureCodeLabel(audit.failureCode)}</dd>
                    </div>
                  )}
                </dl>
                {audit.failureMessage && (
                  <p className="candidate-audit-failure">{audit.failureMessage}</p>
                )}
                {audit.decisions.length === 0 ? (
                  <p className="candidate-audit-empty">本次未形成可采用的裁决结果。</p>
                ) : (
                  <ol className="candidate-audit-decisions">
                    {audit.decisions.map((decision) => (
                      <li key={decision.ambiguityId}>
                        <div className="candidate-audit-decision__heading">
                          <div>
                            <span>{CANDIDATE_AUDIT_REGION_LABELS[decision.region]}</span>
                            <strong>
                              {candidateFieldLabel(decision.field)}
                              {decision.itemIndex === undefined
                                ? ''
                                : ` · 商品 ${decision.itemIndex + 1}`}
                            </strong>
                          </div>
                          <span className={`candidate-audit-outcome is-${decision.outcome}`}>
                            {candidateOutcomeLabel(decision.outcome)}
                          </span>
                        </div>
                        <ul className="candidate-audit-candidates" aria-label="候选值">
                          {decision.candidates.map((candidate) => {
                            const selected = decision.selectedCandidateId === candidate.candidateId;
                            return (
                              <li className={selected ? 'is-selected' : ''} key={candidate.candidateId}>
                                <span aria-hidden="true">{selected ? '✓' : '○'}</span>
                                <div>
                                  <strong>{candidate.displayText}</strong>
                                  <small>{candidate.candidateId}</small>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        <div className="candidate-audit-evidence">
                          <strong>依据行</strong>
                          <ul>
                            {decision.contextLines.map((line) => (
                              <li key={line.lineId}>
                                <span>{line.lineId}</span>
                                <p>{line.text}</p>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}

function candidateProviderLabel(
  provider: CandidateAdjudicationAuditView['provider'],
): string {
  return {
    deepseek: 'DeepSeek',
    'aliyun-bailian': '阿里云百炼',
    'openai-compatible': 'OpenAI 兼容服务',
  }[provider];
}

function candidateAuditStatusLabel(
  status: CandidateAdjudicationAuditView['status'],
): string {
  return {
    succeeded: '已完成',
    partial: '部分确定',
    failed: '调用失败',
    rejected: '结果已拒绝',
  }[status];
}

function candidateOutcomeLabel(
  outcome: CandidateAdjudicationAuditView['decisions'][number]['outcome'],
): string {
  return {
    selected: '已选择',
    unresolved: '未确定',
    invalid: '无效结果',
  }[outcome];
}

function candidateFailureCodeLabel(
  code: CandidateAdjudicationFailureCode,
): string {
  return {
    invalid_request: '请求不符合有限候选约束',
    timeout: '调用超时',
    authentication: '鉴权失败',
    rate_limited: '请求过于频繁',
    network: '网络连接失败',
    remote_error: '服务端异常',
    response_too_large: '响应过大',
    unsafe_response: '响应包含不安全内容',
    invalid_response: '响应格式无效',
  }[code];
}

function candidateFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    platform_status: '平台交易状态',
    shipping_contact: '收货联系人',
    recipient: '收件人',
    phone: '手机号',
    address: '收货地址',
    item_title: '商品标题',
    item_spec: '商品规格',
    item_unit_price: '商品单价',
    item_quantity: '商品数量',
    order_number: '订单号',
    fulfillment_status: '履约状态',
  };
  return labels[field] ?? field;
}

function isAddressPartConflict(detail: RecognitionConflictDetail): boolean {
  return detail.region === 'shipping_information' &&
    ['province', 'city', 'district'].includes(detail.field);
}

function ConflictValueRow({
  label,
  values,
  emptyLabel = '未返回',
}: {
  label: string;
  values: string[];
  emptyLabel?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {values.length === 0
          ? <span className="recognition-conflict-value is-empty">{emptyLabel}</span>
          : values.map((value, index) => (
            <span className="recognition-conflict-value" key={`${value}:${index}`}>
              {value === '' ? '空字符串' : value}
            </span>
          ))}
      </dd>
    </div>
  );
}

function conflictPopoverPosition(rect: DOMRect): ConflictPopoverPosition {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const margin = 12;
  const gap = 8;
  const width = Math.max(0, Math.min(520, viewportWidth - margin * 2));
  const left = Math.min(
    Math.max(margin, rect.right - width),
    Math.max(margin, viewportWidth - width - margin),
  );
  const verticalLimit = Math.max(margin, viewportHeight - margin);
  const anchorTop = Math.min(Math.max(rect.top, margin), verticalLimit);
  const anchorBottom = Math.min(Math.max(rect.bottom, margin), verticalLimit);
  const roomBelow = Math.max(0, viewportHeight - anchorBottom - gap - margin);
  const roomAbove = Math.max(0, anchorTop - gap - margin);
  const placeBelow = roomBelow >= Math.min(360, roomAbove);
  const maxHeight = Math.min(560, placeBelow ? roomBelow : roomAbove);
  return placeBelow
    ? { top: anchorBottom + gap, left, width, maxHeight }
    : { bottom: viewportHeight - anchorTop + gap, left, width, maxHeight };
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
type CandidateSettingsAction = 'loading' | 'saving' | 'removing' | 'testing' | null;

const CANDIDATE_PROVIDER_PRESETS: Record<
  CandidateVerificationProvider,
  { baseUrl: string; model: string }
> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  'aliyun-bailian': {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-plus',
  },
  'openai-compatible': {
    baseUrl: '',
    model: '',
  },
};

function SettingsWorkspace({
  api,
  dataDirectory,
  changingDataDirectory,
  onChangeDataDirectory,
}: {
  api: DesktopApi;
  dataDirectory: string;
  changingDataDirectory: boolean;
  onChangeDataDirectory: () => Promise<void>;
}) {
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
  const [candidateSettings, setCandidateSettings] =
    useState<CandidateVerificationSettingsView | null>(null);
  const [candidateEnabled, setCandidateEnabled] = useState(false);
  const [candidateProvider, setCandidateProvider] =
    useState<CandidateVerificationProvider>('deepseek');
  const [candidateBaseUrl, setCandidateBaseUrl] = useState('https://api.deepseek.com');
  const [candidateModel, setCandidateModel] = useState('deepseek-v4-flash');
  const [candidateApiKey, setCandidateApiKey] = useState('');
  const [candidateBusy, setCandidateBusy] =
    useState<CandidateSettingsAction>('loading');
  const [candidateFeedback, setCandidateFeedback] = useState<SettingsFeedback>(null);
  const [showCandidatePaidCallConfirmation, setShowCandidatePaidCallConfirmation] =
    useState(false);
  const [showDataDirectoryConfirmation, setShowDataDirectoryConfirmation] =
    useState(false);
  const [dataDirectoryFeedback, setDataDirectoryFeedback] =
    useState<SettingsFeedback>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setSettings(null);
    setOrderIntakeSettings(null);
    setBusy('loading');
    setOrderIntakeLoading(true);
    setFeedback(null);
    setOrderIntakeFeedback(null);
    setCandidateSettings(null);
    setCandidateBusy('loading');
    setCandidateFeedback(null);
    setShowCandidatePaidCallConfirmation(false);
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
    void api
      .getCandidateVerificationSettings()
      .then((value) => {
        if (!active) return;
        setCandidateSettings(value);
        setCandidateEnabled(value.enabled);
        setCandidateProvider(value.provider);
        setCandidateBaseUrl(value.baseUrl);
        setCandidateModel(value.model);
        setCandidateApiKey('');
      })
      .catch((error: unknown) => {
        if (active) {
          setCandidateFeedback({ kind: 'error', message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (active) setCandidateBusy(null);
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

  async function confirmDataDirectoryChange() {
    setShowDataDirectoryConfirmation(false);
    setDataDirectoryFeedback(null);
    try {
      await onChangeDataDirectory();
    } catch (error) {
      setDataDirectoryFeedback({ kind: 'error', message: errorMessage(error) });
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

  function selectCandidateProvider(provider: CandidateVerificationProvider) {
    const preset = CANDIDATE_PROVIDER_PRESETS[provider];
    setCandidateProvider(provider);
    setCandidateBaseUrl(preset.baseUrl);
    setCandidateModel(preset.model);
    setCandidateApiKey('');
    setCandidateFeedback(null);
    setShowCandidatePaidCallConfirmation(false);
  }

  async function saveCandidateSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCandidateBusy('saving');
    setCandidateFeedback(null);
    try {
      const saved = await api.saveCandidateVerificationSettings({
        enabled: candidateEnabled,
        provider: candidateProvider,
        baseUrl: candidateBaseUrl,
        model: candidateModel,
        apiKey: candidateApiKey,
      });
      setCandidateSettings(saved);
      setCandidateEnabled(saved.enabled);
      setCandidateProvider(saved.provider);
      setCandidateBaseUrl(saved.baseUrl);
      setCandidateModel(saved.model);
      setCandidateApiKey('');
      setShowCandidatePaidCallConfirmation(false);
      setCandidateFeedback({ kind: 'success', message: '候选裁决设置已保存' });
    } catch (error) {
      setCandidateFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setCandidateBusy(null);
    }
  }

  async function removeCandidateApiKey() {
    setCandidateBusy('removing');
    setCandidateFeedback(null);
    try {
      const updated = await api.removeCandidateVerificationApiKey();
      setCandidateSettings(updated);
      setCandidateEnabled(updated.enabled);
      setCandidateProvider(updated.provider);
      setCandidateBaseUrl(updated.baseUrl);
      setCandidateModel(updated.model);
      setCandidateApiKey('');
      setShowCandidatePaidCallConfirmation(false);
      setCandidateFeedback({ kind: 'success', message: '候选裁决 API Key 已移除' });
    } catch (error) {
      setCandidateFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setCandidateBusy(null);
    }
  }

  async function confirmCandidateConnectionTest() {
    setCandidateBusy('testing');
    setCandidateFeedback(null);
    try {
      const result = await api.testCandidateVerificationConnection({
        consentToPaidCall: true,
      });
      setShowCandidatePaidCallConfirmation(false);
      setCandidateFeedback({ kind: 'success', message: result.message });
    } catch (error) {
      setCandidateFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setCandidateBusy(null);
    }
  }

  return (
    <section className="settings-workspace workspace-enter">
      <header className="workspace-header workspace-header--settings">
        <div>
          <span className="section-kicker">本机配置</span>
          <h1>设置</h1>
          <p>管理数据存储、订单接收方式、识别服务与本机凭据。</p>
        </div>
      </header>

      <div className="settings-body">
        <div className="settings-form" role="group" aria-label="应用设置">
          <section
            className="settings-section settings-section--data-directory"
            aria-labelledby="data-directory-heading"
          >
            <div className="settings-section-heading">
              <div>
                <span className="section-kicker">本机数据</span>
                <h2 id="data-directory-heading">数据存储位置</h2>
                <p>订单、来源截图和识别记录保存在此目录。可连接已有数据，或在空目录建立一套新数据。</p>
              </div>
              <span className="service-state is-ready">
                <i aria-hidden="true" />
                已连接
              </span>
            </div>

            <div className="data-directory-location">
              <div>
                <span>当前数据目录</span>
                <code title={dataDirectory}>{dataDirectory}</code>
              </div>
              <button
                className="button button--quiet"
                type="button"
                aria-busy={changingDataDirectory}
                disabled={changingDataDirectory}
                onClick={() => {
                  setDataDirectoryFeedback(null);
                  setShowDataDirectoryConfirmation(true);
                }}
              >
                <Icon name="folder" />
                {changingDataDirectory ? '正在打开…' : '更改数据目录'}
              </button>
            </div>

            {showDataDirectoryConfirmation && (
              <div
                className="directory-switch-notice"
                role="group"
                aria-label="更改数据目录确认"
              >
                <div>
                  <strong>切换后将重新加载订单工作区</strong>
                  <p>
                    切换不会复制、合并、移动或删除原目录内容；当前页面尚未保存的输入将不会保留。
                  </p>
                </div>
                <div className="directory-switch-actions">
                  <button
                    className="button button--quiet"
                    type="button"
                    disabled={changingDataDirectory}
                    onClick={() => setShowDataDirectoryConfirmation(false)}
                  >
                    取消更改
                  </button>
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={changingDataDirectory}
                    onClick={() => void confirmDataDirectoryChange()}
                  >
                    继续选择目录
                  </button>
                </div>
              </div>
            )}
            <SettingsNotice feedback={dataDirectoryFeedback} />
          </section>

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
              <form
                className="settings-section-form"
                aria-label="百炼 OCR 设置"
                onSubmit={(event) => void saveSettings(event)}
              >
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
              </form>
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

          {candidateBusy === 'loading' && !candidateSettings ? (
            <div className="settings-loading settings-loading--compact" role="status">
              正在读取候选裁决设置…
            </div>
          ) : !candidateSettings ? (
            <div className="settings-load-error settings-load-error--compact">
              <SettingsNotice feedback={candidateFeedback} />
              <button
                className="button button--quiet"
                type="button"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                重新读取候选裁决设置
              </button>
            </div>
          ) : (
            <section
              className="settings-section settings-section--candidate"
              aria-labelledby="candidate-verification-heading"
            >
              <form
                className="settings-section-form"
                aria-label="候选裁决设置"
                onSubmit={(event) => void saveCandidateSettings(event)}
              >
              <div className="settings-section-heading">
                <div>
                  <span className="section-kicker">有限候选 · 文字复核</span>
                  <h2 id="candidate-verification-heading">候选裁决（可选）</h2>
                  <p>
                    只发送有界 OCR 文字、坐标和本机生成的候选编号，不发送截图；
                    模型只能选择候选或返回未确定，失败时回到人工确认。
                  </p>
                </div>
                <button
                  className={`settings-switch${candidateEnabled ? ' is-on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={candidateEnabled}
                  aria-label="候选裁决"
                  disabled={candidateBusy !== null}
                  onClick={() => {
                    setCandidateEnabled((value) => !value);
                    setCandidateFeedback(null);
                    setShowCandidatePaidCallConfirmation(false);
                  }}
                >
                  <span className="settings-switch-track" aria-hidden="true"><i /></span>
                  <span>{candidateEnabled ? '已开启' : '已关闭'}</span>
                </button>
              </div>

              {candidateEnabled && (
                <>
                  <div className="settings-fields settings-fields--candidate">
                    <Field label="文本模型服务商" required>
                      <select
                        aria-label="文本模型服务商"
                        value={candidateProvider}
                        disabled={candidateBusy !== null}
                        onChange={(event) => selectCandidateProvider(
                          event.target.value as CandidateVerificationProvider,
                        )}
                      >
                        <option value="deepseek">DeepSeek</option>
                        <option value="aliyun-bailian">阿里云百炼</option>
                        <option value="openai-compatible">自定义 OpenAI 兼容</option>
                      </select>
                    </Field>
                    <Field label="Base URL" required>
                      <input
                        aria-label="候选裁决 Base URL"
                        value={candidateBaseUrl}
                        readOnly={candidateProvider === 'deepseek'}
                        spellCheck={false}
                        onChange={(event) => setCandidateBaseUrl(event.target.value)}
                        placeholder="https://example.com/v1"
                      />
                      {candidateProvider === 'deepseek' && (
                        <small className="field-help">DeepSeek 使用固定官方地址</small>
                      )}
                    </Field>
                    <Field label="模型" required>
                      <input
                        aria-label="候选裁决模型"
                        value={candidateModel}
                        spellCheck={false}
                        onChange={(event) => setCandidateModel(event.target.value)}
                        placeholder="输入模型名称"
                      />
                    </Field>
                    <Field label="独立 API Key" required>
                      <input
                        aria-label="候选裁决 API Key"
                        type="password"
                        value={candidateApiKey}
                        autoComplete="new-password"
                        spellCheck={false}
                        onChange={(event) => setCandidateApiKey(event.target.value)}
                        placeholder={candidateSettings.apiKeyConfigured
                          ? '输入新密钥以替换'
                          : '输入当前文本模型的 API Key'}
                      />
                    </Field>
                  </div>

                  <div className="credential-row">
                    <div className="credential-copy">
                      <span className="credential-mask">
                        {candidateSettings.apiKeyConfigured &&
                        candidateSettings.provider === candidateProvider &&
                        candidateSettings.baseUrl === candidateBaseUrl
                          ? '••••••••'
                          : '当前目标尚未保存 API Key'}
                      </span>
                      <small>与百炼 OCR 密钥分开保存在 {candidateSettings.credentialStore}</small>
                    </div>
                    {candidateSettings.apiKeyConfigured &&
                    candidateSettings.provider === candidateProvider &&
                    candidateSettings.baseUrl === candidateBaseUrl && (
                      <button
                        className="text-button text-button--danger"
                        type="button"
                        disabled={candidateBusy !== null}
                        onClick={() => void removeCandidateApiKey()}
                      >
                        {candidateBusy === 'removing' ? '正在移除…' : '移除候选裁决 API Key'}
                      </button>
                    )}
                  </div>
                  <p className="credential-policy">
                    API Key 不会回填；每张截图只有出现有限歧义时才会调用，最多调用一次。
                  </p>
                  <p className="credential-policy">
                    Base URL 可填写到版本路径，也可粘贴完整地址；系统会自动追加
                    {' '}/chat/completions。自定义服务需兼容 Bearer 鉴权、Chat Completions 和 JSON Output。
                  </p>
                </>
              )}

              <div className="settings-actions settings-actions--candidate">
                {candidateEnabled && !showCandidatePaidCallConfirmation && (
                  <button
                    className="button button--quiet"
                    type="button"
                    disabled={
                      candidateBusy !== null ||
                      !candidateSettings.apiKeyConfigured ||
                      candidateSettings.provider !== candidateProvider ||
                      candidateSettings.baseUrl !== candidateBaseUrl ||
                      candidateSettings.model !== candidateModel
                    }
                    onClick={() => {
                      setCandidateFeedback(null);
                      setShowCandidatePaidCallConfirmation(true);
                    }}
                  >
                    测试候选裁决连接
                  </button>
                )}
                <button
                  className="button button--primary"
                  type="submit"
                  disabled={candidateBusy !== null}
                >
                  <Icon name="check" />
                  {candidateBusy === 'saving' ? '正在保存…' : '保存候选裁决设置'}
                </button>
              </div>

              {showCandidatePaidCallConfirmation && (
                <div className="paid-call-notice" aria-label="候选裁决连接测试确认">
                  <div>
                    <strong>本次测试会产生 1 次文本模型调用</strong>
                    <p>只发送内置的有限候选文字，不会发送订单截图。</p>
                  </div>
                  <div className="paid-call-actions">
                    <button
                      className="button button--quiet"
                      type="button"
                      disabled={candidateBusy === 'testing'}
                      onClick={() => setShowCandidatePaidCallConfirmation(false)}
                    >
                      取消
                    </button>
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={candidateBusy === 'testing'}
                      onClick={() => void confirmCandidateConnectionTest()}
                    >
                      {candidateBusy === 'testing' ? '正在测试…' : '确认并测试文本模型'}
                    </button>
                  </div>
                </div>
              )}

              <SettingsNotice feedback={candidateFeedback} />
              </form>
            </section>
          )}
        </div>
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
  api: DesktopApi;
  draft: OrderDraft;
  review: OrderDraftReview;
  screenshotUrl: string;
  error: string;
  cancelling: boolean;
  confirming: boolean;
  customFieldDefinitions: CustomFieldDefinition[];
  customFieldValues: DraftCustomFieldValues;
  onDraftChange: (draft: OrderDraft) => void;
  onCustomFieldValuesChange: (values: DraftCustomFieldValues) => void;
  onCustomFieldTouched: (key: string) => void;
  onCancel: () => void;
  onConfirm: (event: FormEvent<HTMLFormElement>) => void;
};

function ReviewWorkspace({
  api,
  draft,
  review,
  screenshotUrl,
  error,
  cancelling,
  confirming,
  customFieldDefinitions,
  customFieldValues,
  onDraftChange,
  onCustomFieldValuesChange,
  onCustomFieldTouched,
  onCancel,
  onConfirm,
}: ReviewWorkspaceProps) {
  const [moneyErrors, setMoneyErrors] = useState<Record<string, string>>({});
  const [customFieldValidity, setCustomFieldValidity] = useState<Record<string, boolean>>({});
  const candidateAudit = useCandidateAdjudicationAudit(api, draft.id);
  const isOrderUpdate = review.kind === 'order_update';
  const updateChanges = isOrderUpdate
    ? diffOrderCurrentValues(review.currentOrder, draft)
    : [];
  const hasMoneyErrors = Object.keys(moneyErrors).length > 0;
  const orderCustomFields = customFieldDefinitions.filter(
    (definition) => definition.granularity === 'order',
  );
  const itemCustomFields = customFieldDefinitions.filter(
    (definition) => definition.granularity === 'order_item',
  );
  const requiredOrderCustomFieldsComplete = orderCustomFields
    .filter((definition) => definition.required)
    .every((definition) => hasCustomFieldValue(customFieldValues.orderValues.find(
      (entry) => entry.definitionId === definition.id,
    )?.value ?? null));
  const requiredItemCustomFieldsComplete = draft.items.every((item) => itemCustomFields
    .filter((definition) => definition.required)
    .every((definition) => hasCustomFieldValue(customFieldValues.itemValues.find(
      (entry) => entry.definitionId === definition.id && entry.draftItemId === item.id,
    )?.value ?? null)));
  const activeCustomFieldKeys = [
    ...orderCustomFields.map((definition) => `order:${definition.id}`),
    ...draft.items.flatMap((item) => itemCustomFields.map(
      (definition) => `item:${item.id}:${definition.id}`,
    )),
  ];
  const customFieldInputsValid = activeCustomFieldKeys.every(
    (key) => customFieldValidity[key] !== false,
  );
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
    !hasMoneyErrors &&
    customFieldInputsValid &&
    requiredOrderCustomFieldsComplete &&
    requiredItemCustomFieldsComplete;

  function patchDraft(patch: Partial<OrderDraft>) {
    onDraftChange({ ...draft, ...patch });
  }

  function patchItem(index: number, patch: Partial<DraftItem>) {
    const items = [...draft.items];
    items[index] = { ...items[index], ...patch };
    patchDraft({ items });
  }

  function patchOrderCustomField(definitionId: string, value: CustomFieldValue | null) {
    onCustomFieldTouched(`order:${definitionId}`);
    onCustomFieldValuesChange({
      ...customFieldValues,
      orderValues: upsertDraftOrderCustomFieldValue(
        customFieldValues.orderValues,
        definitionId,
        value,
      ),
    });
  }

  function patchItemCustomField(
    definitionId: string,
    draftItemId: string,
    value: CustomFieldValue | null,
  ) {
    onCustomFieldTouched(`item:${draftItemId}:${definitionId}`);
    onCustomFieldValuesChange({
      ...customFieldValues,
      itemValues: upsertDraftItemCustomFieldValue(
        customFieldValues.itemValues,
        definitionId,
        draftItemId,
        value,
      ),
    });
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
          quantitySource: 'manual',
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
              <div className="review-issues__body">
                <ul>
                  {draft.reviewIssues.map((issue) => (
                    <li key={issue}>{orderReviewIssueLabel(issue)}</li>
                  ))}
                </ul>
                <RecognitionConflictDetails
                  details={draft.recognitionConflicts}
                />
              </div>
            </section>
          )}
          <CandidateAdjudicationSummary
            audits={candidateAudit.audits}
            loading={candidateAudit.loading}
            error={candidateAudit.error}
          />
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
                  <option value="delivered">已收货</option>
                  <option value="returned">已退货</option>
                  <option value="unknown">未知</option>
                </select>
              </Field>
            </div>
          </FormSection>

          {orderCustomFields.length > 0 && (
            <FormSection
              title="自定义字段"
              description="这些业务信息与平台订单事实分开保存，可用于后续筛选和排序。"
            >
              <div className="custom-field-grid">
                {orderCustomFields.map((definition) => (
                  <CustomFieldInput
                    key={definition.id}
                    definition={definition}
                    value={customFieldValues.orderValues.find(
                      (entry) => entry.definitionId === definition.id,
                    )?.value ?? null}
                    onChange={(value) => patchOrderCustomField(definition.id, value)}
                    onValidityChange={(valid) => setCustomFieldValidity((current) => ({
                      ...current,
                      [`order:${definition.id}`]: valid,
                    }))}
                  />
                ))}
              </div>
              {!requiredOrderCustomFieldsComplete && (
                <p className="custom-field-required-note" role="status">
                  请填写全部订单必填自定义字段后再确认入库。
                </p>
              )}
            </FormSection>
          )}

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
                      <Field label="数量" suffix={draftItemQuantitySourceLabel(item)}>
                        <input
                          aria-label={draft.items.length === 1 ? '数量' : `商品 ${index + 1} 数量`}
                          type="number"
                          min="1"
                          step="1"
                          value={item.quantity}
                          onChange={(event) => patchItem(index, {
                            quantity: Number(event.target.value),
                            quantitySource: 'manual',
                            quantityInferred: false,
                          })}
                        />
                      </Field>
                    </div>
                    <div className="inferred-note">
                      数量来源：{draftItemQuantitySourceLabel(item)}
                    </div>
                    {itemCustomFields.length > 0 && (
                      <div className="item-custom-fields">
                        <span className="item-custom-fields__title">商品自定义字段</span>
                        <div className="custom-field-grid">
                          {itemCustomFields.map((definition) => {
                            const label = draft.items.length === 1
                              ? definition.name
                              : `${definition.name} · 商品 ${index + 1}`;
                            return (
                              <CustomFieldInput
                                key={definition.id}
                                definition={definition}
                                label={label}
                                value={customFieldValues.itemValues.find((entry) => (
                                  entry.definitionId === definition.id &&
                                  entry.draftItemId === item.id
                                ))?.value ?? null}
                                onChange={(value) => patchItemCustomField(
                                  definition.id,
                                  item.id,
                                  value,
                                )}
                                onValidityChange={(valid) => setCustomFieldValidity((current) => ({
                                  ...current,
                                  [`item:${item.id}:${definition.id}`]: valid,
                                }))}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {!requiredItemCustomFieldsComplete && (
              <p className="custom-field-required-note" role="status">
                请填写每件商品的全部必填自定义字段后再确认入库。
              </p>
            )}
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
  platform: '平台',
  sellerAccount: '卖家账号',
  orderNumber: '订单号',
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
  note: '备注',
  platformTransactionStatus: '平台交易状态',
  fulfillmentStatus: '履约状态',
  shippingCarrier: '快递公司',
  trackingNumber: '运单号',
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
    quantitySource: '数量来源',
  } as Record<string, string>)[field] : '整项';
  return `商品 ${position} · ${label ?? field}`;
}

function formatOrderChangeValue(path: string, value: OrderChangeValue): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') {
    return /(?:Cents|unitPriceCents)$/u.test(path) ? formatMoney(value) : String(value);
  }
  if (typeof value === 'string') {
    if (path.endsWith('.quantitySource') && isQuantitySource(value)) {
      return quantitySourceLabel(value);
    }
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

function formatCustomFieldValue(value: CustomFieldValue | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.join('、') || '—';
  return String(value) || '—';
}

function formatOrderEditPreviewValue(
  path: string,
  value: OrderChangeValue,
  definitions: readonly CustomFieldDefinition[],
): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !/^items(?:\[\d+\]|\.removed\[\d+\])$/u.test(path)
  ) {
    return formatOrderChangeValue(path, value);
  }
  const item = value as Record<string, OrderChangeValue>;
  const title = typeof item.sourceTitle === 'string' ? item.sourceTitle : '未命名商品';
  const spec = typeof item.sourceSpec === 'string' && item.sourceSpec
    ? ` / ${item.sourceSpec}`
    : '';
  const price = typeof item.unitPriceCents === 'number'
    ? formatMoney(item.unitPriceCents)
    : '—';
  const quantity = typeof item.quantity === 'number' ? item.quantity : '—';
  const customValues = Array.isArray(item.customFieldValues)
    ? item.customFieldValues.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const record = entry as Record<string, OrderChangeValue>;
      if (typeof record.definitionId !== 'string') return [];
      const definition = definitions.find(({ id }) => id === record.definitionId);
      const raw = record.value;
      const formatted = raw === null ||
        typeof raw === 'string' ||
        typeof raw === 'number' ||
        typeof raw === 'boolean' ||
        (Array.isArray(raw) && raw.every((part) => typeof part === 'string'))
        ? formatCustomFieldValue(raw as CustomFieldValue | null)
        : '—';
      return [`${definition?.name ?? '自定义字段'}：${formatted}`];
    })
    : [];
  return `${title}${spec} / ${price} × ${quantity}${
    customValues.length > 0 ? `；${customValues.join('；')}` : ''
  }`;
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

type OrderEditMoneyInputs = {
  productTotal: string;
  shippingFee: string;
  amount: string;
  itemUnitPrices: string[];
};

function createOrderEditInput(order: OriginalOrder): OrderEditInput {
  return {
    orderId: order.id,
    expectedRevision: order.revision,
    identityCorrection: null,
    alipayTransactionNumber: order.alipayTransactionNumber,
    buyerNickname: order.buyerNickname,
    recipient: order.recipient,
    phone: order.phone,
    addressOriginal: order.addressOriginal,
    province: order.province,
    city: order.city,
    district: order.district,
    orderedAtOriginal: order.orderedAtOriginal,
    paidAtOriginal: order.paidAtOriginal,
    productTotalCents: order.productTotalCents,
    shippingFeeCents: order.shippingFeeCents,
    amountCents: order.amountCents,
    note: order.note ?? '',
    items: order.items.map((item) => ({
      id: item.id,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
    })),
  };
}

function createOrderEditMoneyInputs(input: OrderEditInput): OrderEditMoneyInputs {
  return {
    productTotal: formatMoneyInput(input.productTotalCents),
    shippingFee: formatMoneyInput(input.shippingFeeCents),
    amount: formatMoneyInput(input.amountCents),
    itemUnitPrices: input.items.map((item) => formatMoneyInput(item.unitPriceCents)),
  };
}

function OrderEditWorkspace({
  details,
  screenshotUrl,
  saving,
  error,
  onDirtyChange,
  onCancel,
  onSave,
  onRefresh,
}: {
  details: OrderDetails;
  screenshotUrl: string;
  saving: boolean;
  error: string;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSave: (input: OrderEditInput) => Promise<void>;
  onRefresh: (orderId: string) => Promise<OrderDetails>;
}) {
  const baselineInput = useMemo(() => createOrderEditInput(details.order), [details.order]);
  const [input, setInput] = useState<OrderEditInput>(baselineInput);
  const [moneyInputs, setMoneyInputs] = useState<OrderEditMoneyInputs>(
    () => createOrderEditMoneyInputs(baselineInput),
  );
  const [review, setReview] = useState<OrderEditReview | null>(null);
  const [localError, setLocalError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const previewButtonRef = useRef<HTMLButtonElement>(null);
  const reviewDialogRef = useRef<HTMLDivElement>(null);
  const reviewFirstActionRef = useRef<HTMLButtonElement>(null);
  const [itemCustomFieldValidity, setItemCustomFieldValidity] = useState<Record<string, boolean>>({});
  const itemCustomFieldDefinitions = details.customFieldDefinitions.filter(
    (definition) => definition.granularity === 'order_item',
  );
  const baselineMoneyInputs = useMemo(
    () => createOrderEditMoneyInputs(baselineInput),
    [baselineInput],
  );
  const dirty = JSON.stringify(input) !== JSON.stringify(baselineInput) ||
    JSON.stringify(moneyInputs) !== JSON.stringify(baselineMoneyInputs);
  const shippedSnapshotWarning = hasShipmentHistory(details.order.fulfillmentStatus);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!review) return undefined;
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : previewButtonRef.current;
    reviewFirstActionRef.current?.focus();
    return () => (returnFocus ?? previewButtonRef.current)?.focus();
  }, [review]);

  function patchInput(patch: Partial<OrderEditInput>) {
    setLocalError('');
    setReview(null);
    setInput((current) => ({ ...current, ...patch }));
  }

  function patchItem(index: number, patch: Partial<OrderEditInput['items'][number]>) {
    setInput((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
      )),
    }));
    setLocalError('');
    setReview(null);
  }

  function patchOrderMoney(
    key: 'productTotal' | 'shippingFee' | 'amount',
    inputKey: 'productTotalCents' | 'shippingFeeCents' | 'amountCents',
    value: string,
  ) {
    setMoneyInputs((current) => ({ ...current, [key]: value }));
    const cents = yuanToCents(value);
    if (cents !== null) patchInput({ [inputKey]: cents });
  }

  function patchItemMoney(index: number, value: string) {
    setMoneyInputs((current) => ({
      ...current,
      itemUnitPrices: current.itemUnitPrices.map((entry, itemIndex) => (
        itemIndex === index ? value : entry
      )),
    }));
    const cents = yuanToCents(value);
    if (cents !== null) patchItem(index, { unitPriceCents: cents });
  }

  function removeItem(index: number) {
    if (input.items.length <= 1) return;
    setItemCustomFieldValidity((current) => Object.fromEntries(
      Object.entries(current).flatMap(([key, valid]) => {
        const separator = key.indexOf(':');
        const itemIndex = Number(key.slice(0, separator));
        const definitionId = key.slice(separator + 1);
        if (!Number.isInteger(itemIndex) || itemIndex === index) return [];
        return [[`${itemIndex > index ? itemIndex - 1 : itemIndex}:${definitionId}`, valid]];
      }),
    ));
    patchInput({ items: input.items.filter((_, itemIndex) => itemIndex !== index) });
    setMoneyInputs((current) => ({
      ...current,
      itemUnitPrices: current.itemUnitPrices.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function addItem() {
    patchInput({
      items: [
        ...input.items,
        {
          id: null,
          sourceTitle: '',
          sourceSpec: '',
          unitPriceCents: 0,
          quantity: 1,
          customFieldValues: itemCustomFieldDefinitions.map((definition) => ({
            definitionId: definition.id,
            value: definition.defaultValue,
          })),
        },
      ],
    });
    setMoneyInputs((current) => ({
      ...current,
      itemUnitPrices: [...current.itemUnitPrices, ''],
    }));
  }

  function patchNewItemCustomField(
    index: number,
    definitionId: string,
    value: CustomFieldValue | null,
  ) {
    const item = input.items[index];
    if (!item || item.id !== null) return;
    const values = (item.customFieldValues ?? [])
      .filter((entry) => entry.definitionId !== definitionId);
    patchItem(index, {
      customFieldValues: [...values, { definitionId, value }],
    });
  }

  function finalizedInput(): OrderEditInput | null {
    const productTotalCents = yuanToCents(moneyInputs.productTotal);
    const shippingFeeCents = yuanToCents(moneyInputs.shippingFee);
    const amountCents = yuanToCents(moneyInputs.amount);
    const itemUnitPrices = moneyInputs.itemUnitPrices.map(yuanToCents);
    if (
      productTotalCents === null ||
      shippingFeeCents === null ||
      amountCents === null ||
      itemUnitPrices.some((value) => value === null)
    ) {
      setLocalError('金额仅支持普通数字，最多两位小数。');
      return null;
    }
    return {
      ...input,
      productTotalCents,
      shippingFeeCents,
      amountCents,
      items: input.items.map((item, index) => ({
        ...item,
        unitPriceCents: itemUnitPrices[index]!,
      })),
    };
  }

  function previewChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const missingRequiredCustomField = input.items.some((item) => (
      item.id === null && itemCustomFieldDefinitions.some((definition) => (
        definition.required && !hasCustomFieldValue(
          item.customFieldValues?.find((entry) => (
            entry.definitionId === definition.id
          ))?.value ?? null,
        )
      ))
    ));
    if (missingRequiredCustomField) {
      setLocalError('请填写新增商品的全部必填自定义字段。');
      return;
    }
    if (Object.values(itemCustomFieldValidity).some((valid) => valid === false)) {
      setLocalError('新增商品的自定义字段格式无效。');
      return;
    }
    const finalized = finalizedInput();
    if (!finalized) return;
    try {
      const nextReview = reviewOrderEdit(
        details.order,
        finalized,
        details.customFieldDefinitions,
        details.customFieldValues,
      );
      if (nextReview.changes.length === 0) {
        setLocalError('当前没有需要保存的修改。');
        return;
      }
      setLocalError('');
      setReview(nextReview);
    } catch (reviewError) {
      setLocalError(errorMessage(reviewError));
    }
  }

  async function confirmSave() {
    if (!review) return;
    try {
      await onSave(review.input);
    } catch {
      setReview(null);
    }
  }

  async function refreshLatestOrder() {
    setRefreshing(true);
    setLocalError('');
    setReview(null);
    try {
      const latest = await onRefresh(details.order.id);
      const latestInput = createOrderEditInput(latest.order);
      setInput(latestInput);
      setMoneyInputs(createOrderEditMoneyInputs(latestInput));
    } catch {
      // The shared error banner already explains why the refresh failed.
    } finally {
      setRefreshing(false);
    }
  }

  function handleReviewDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      if (!saving) {
        event.preventDefault();
        setReview(null);
      }
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = reviewDialogRef.current
      ? Array.from(reviewDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ))
      : [];
    if (focusable.length === 0) {
      event.preventDefault();
      reviewDialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <section className="review-workspace review-enter order-edit-workspace">
      <header
        className="workspace-header workspace-header--review"
        aria-hidden={review ? true : undefined}
        inert={review ? true : undefined}
      >
        <div className="header-title-row">
          <div>
            <span className="section-kicker">订单当前值 · 人工修改</span>
            <h1>编辑订单</h1>
            <p>修改会记录字段级前后值，左侧来源截图与 OCR 证据不会被改写。</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="button button--quiet" type="button" disabled={saving} onClick={onCancel}>
            取消编辑
          </button>
          <button
            ref={previewButtonRef}
            className="button button--primary"
            type="submit"
            form="order-edit-form"
            disabled={saving}
          >
            {saving ? '正在保存…' : '预览修改'}
          </button>
        </div>
      </header>

      <InlineError message={localError || error} />
      {error.includes('刷新') && (
        <div className="order-edit-conflict-actions">
          <span>表单已保留，只有明确刷新才会换成最新订单值。</span>
          <button
            className="button button--quiet"
            type="button"
            disabled={refreshing || saving}
            onClick={() => void refreshLatestOrder()}
          >
            {refreshing ? '正在刷新…' : '刷新最新订单'}
          </button>
        </div>
      )}
      {shippedSnapshotWarning && (
        <div className="order-edit-warning" role="status">
          <Icon name="warning" />
          <span>
            该订单已经历发货（当前{fulfillmentStatusLabel(details.order.fulfillmentStatus)}）；
            保存只更新订单当前值，不会改写已冻结的发货快照。
          </span>
        </div>
      )}

      <div
        className="review-layout"
        aria-hidden={review ? true : undefined}
        inert={review ? true : undefined}
      >
        <figure className="source-panel">
          <div className="panel-label">
            <span><Icon name="image" />来源证据</span>
            <span>只读 · 不会改写</span>
          </div>
          <div className="source-image-stage">
            <img src={screenshotUrl} alt="来源截图" />
          </div>
        </figure>

        <form id="order-edit-form" className="review-form" onSubmit={previewChanges}>
          <fieldset className="review-form__controls" disabled={saving} aria-busy={saving}>
            <div className="review-summary">
              <div><span>订单号</span><strong>{details.order.orderNumber}</strong></div>
              <div><span>商品</span><strong>{input.items.length} 项</strong></div>
              <div><span>当前状态</span><strong>{fulfillmentStatusLabel(details.order.fulfillmentStatus)}</strong></div>
            </div>

            <FormSection title="订单信息" description="身份字段默认锁定；交易状态和履约状态在对应业务功能中维护。">
              <div className="identity-edit-heading">
                <span>订单身份</span>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => patchInput({
                    identityCorrection: input.identityCorrection ? null : {
                      platform: details.order.platform,
                      sellerAccount: details.order.sellerAccount,
                      orderNumber: details.order.orderNumber,
                    },
                  })}
                >
                  {input.identityCorrection ? '取消更正身份' : '更正订单身份'}
                </button>
              </div>
              <div className="field-grid field-grid--two">
                <Field label="平台"><input value={platformLabel(details.order.platform)} disabled /></Field>
                <Field label="卖家账号" required>
                  <input
                    required
                    disabled={!input.identityCorrection}
                    value={input.identityCorrection?.sellerAccount ?? details.order.sellerAccount}
                    onChange={(event) => patchInput({
                      identityCorrection: {
                        ...input.identityCorrection!,
                        sellerAccount: event.target.value,
                      },
                    })}
                  />
                </Field>
                <Field label="订单号" required>
                  <input
                    required
                    disabled={!input.identityCorrection}
                    value={input.identityCorrection?.orderNumber ?? details.order.orderNumber}
                    onChange={(event) => patchInput({
                      identityCorrection: {
                        ...input.identityCorrection!,
                        orderNumber: event.target.value,
                      },
                    })}
                  />
                </Field>
                <Field label="支付宝交易号">
                  <input value={input.alipayTransactionNumber} onChange={(event) => patchInput({ alipayTransactionNumber: event.target.value })} />
                </Field>
                <Field label="买家昵称">
                  <input value={input.buyerNickname} onChange={(event) => patchInput({ buyerNickname: event.target.value })} />
                </Field>
                <Field label="备注" wide>
                  <textarea rows={2} value={input.note} onChange={(event) => patchInput({ note: event.target.value })} />
                </Field>
              </div>
              <div className="order-edit-readonly-statuses" aria-label="不可在此编辑的订单状态">
                <span>平台交易状态：<strong>{platformTransactionStatusLabel(details.order.platformTransactionStatus)}</strong></span>
                <span>履约状态：<strong>{fulfillmentStatusLabel(details.order.fulfillmentStatus)}</strong></span>
              </div>
            </FormSection>

            <FormSection title="金额" description="仅支持普通数字与最多两位小数，保存时以分精确记录。">
              <div className="field-grid field-grid--three">
                <Field label="商品总价" required suffix="元">
                  <input aria-label="商品总价" required type="number" min="0" step="0.01" value={moneyInputs.productTotal} onChange={(event) => patchOrderMoney('productTotal', 'productTotalCents', event.target.value)} />
                </Field>
                <Field label="运费" required suffix="元">
                  <input aria-label="运费" required type="number" min="0" step="0.01" value={moneyInputs.shippingFee} onChange={(event) => patchOrderMoney('shippingFee', 'shippingFeeCents', event.target.value)} />
                </Field>
                <Field label="成交金额" required suffix="元">
                  <input aria-label="成交金额" required type="number" min="0" step="0.01" value={moneyInputs.amount} onChange={(event) => patchOrderMoney('amount', 'amountCents', event.target.value)} />
                </Field>
              </div>
            </FormSection>

            <FormSection title="交易时间" description="输入平台页面显示的时间原文，系统在保存时统一规范化。">
              <div className="field-grid field-grid--two">
                <Field label="下单时间">
                  <input value={input.orderedAtOriginal} onChange={(event) => patchInput({ orderedAtOriginal: event.target.value })} />
                </Field>
                <Field label="付款时间">
                  <input value={input.paidAtOriginal} onChange={(event) => patchInput({ paidAtOriginal: event.target.value })} />
                </Field>
              </div>
            </FormSection>

            <FormSection title="收货信息" description="手机号、地址与行政区划会在保存前重新校验。">
              <div className="field-grid field-grid--two">
                <Field label="收件人" required>
                  <input required value={input.recipient} onChange={(event) => patchInput({ recipient: event.target.value })} />
                </Field>
                <Field label="手机号" required>
                  <input required inputMode="tel" value={input.phone} onChange={(event) => patchInput({ phone: event.target.value })} />
                </Field>
                <Field label="完整收货地址" required wide>
                  <textarea required rows={3} value={input.addressOriginal} onChange={(event) => patchInput({ addressOriginal: event.target.value })} />
                </Field>
              </div>
              <div className="field-grid field-grid--three field-grid--spaced">
                <Field label="省"><input value={input.province} onChange={(event) => patchInput({ province: event.target.value })} /></Field>
                <Field label="市"><input value={input.city} onChange={(event) => patchInput({ city: event.target.value })} /></Field>
                <Field label="区 / 县"><input value={input.district} onChange={(event) => patchInput({ district: event.target.value })} /></Field>
              </div>
            </FormSection>

            <FormSection title={`商品明细 · ${input.items.length}`} description="可增加、修改或删除商品，订单至少保留一件商品。">
              <div className="item-list">
                {input.items.map((item, index) => (
                  <div className="item-editor" key={`${item.id ?? 'new'}-${index}`}>
                    <div className="item-index">{String(index + 1).padStart(2, '0')}</div>
                    <div className="item-fields">
                      <div className="item-title-row">
                        <Field label="商品标题" required>
                          <input
                            aria-label={`商品 ${index + 1} 标题`}
                            required
                            value={item.sourceTitle}
                            onChange={(event) => patchItem(index, { sourceTitle: event.target.value })}
                          />
                        </Field>
                        <button
                          className="item-remove-button"
                          type="button"
                          aria-label={`删除商品 ${index + 1}`}
                          disabled={input.items.length <= 1}
                          title={input.items.length <= 1 ? '订单至少保留一件商品' : undefined}
                          onClick={() => removeItem(index)}
                        >
                          删除
                        </button>
                      </div>
                      <div className="field-grid field-grid--item">
                        <Field label="规格">
                          <input aria-label={`商品 ${index + 1} 规格`} value={item.sourceSpec} onChange={(event) => patchItem(index, { sourceSpec: event.target.value })} />
                        </Field>
                        <Field label="单价" required suffix="元">
                          <input
                            aria-label={`商品 ${index + 1} 单价`}
                            required
                            type="number"
                            min="0"
                            step="0.01"
                            value={moneyInputs.itemUnitPrices[index] ?? ''}
                            onChange={(event) => patchItemMoney(index, event.target.value)}
                          />
                        </Field>
                        <Field label="数量" required>
                          <input
                            aria-label={`商品 ${index + 1} 数量`}
                            required
                            type="number"
                            min="1"
                            step="1"
                            value={item.quantity}
                            onChange={(event) => patchItem(index, { quantity: Number(event.target.value) })}
                          />
                        </Field>
                      </div>
                      {item.id === null && itemCustomFieldDefinitions.length > 0 && (
                        <div className="item-custom-fields">
                          <span className="item-custom-fields__title">新增商品自定义字段</span>
                          <div className="custom-field-grid">
                            {itemCustomFieldDefinitions.map((definition) => (
                              <CustomFieldInput
                                key={definition.id}
                                definition={definition}
                                label={definition.name}
                                value={item.customFieldValues?.find((entry) => (
                                  entry.definitionId === definition.id
                                ))?.value ?? null}
                                onChange={(value) => patchNewItemCustomField(
                                  index,
                                  definition.id,
                                  value,
                                )}
                                onValidityChange={(valid) => setItemCustomFieldValidity((current) => ({
                                  ...current,
                                  [`${index}:${definition.id}`]: valid,
                                }))}
                              />
                            ))}
                          </div>
                        </div>
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

      {review && (
        <div
          ref={reviewDialogRef}
          className="order-edit-dialog-backdrop"
          tabIndex={-1}
          onKeyDown={handleReviewDialogKeyDown}
        >
          <section
            className="order-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-edit-confirm-title"
          >
            <header>
              <div>
                <span className="section-kicker">保存前确认</span>
                <h2 id="order-edit-confirm-title">确认订单修改</h2>
              </div>
              <span>{review.changes.length} 个字段变化</span>
            </header>
            {review.shippedSnapshotWarning && (
              <div className="order-edit-warning" role="status">
                <Icon name="warning" />
                <span>保存不会改写已冻结的发货快照。</span>
              </div>
            )}
            <div className="order-update-comparison__table-frame">
              <table aria-label="订单修改差异">
                <thead><tr><th>字段</th><th>当前值</th><th>修改后</th></tr></thead>
                <tbody>
                  {review.changes.map((change) => (
                    <tr key={change.path}>
                      <th scope="row">{orderChangeFieldLabel(change.path)}</th>
                      <td>{formatOrderEditPreviewValue(
                        change.path,
                        change.before,
                        details.customFieldDefinitions,
                      )}</td>
                      <td className="order-update-comparison__new-value">{formatOrderEditPreviewValue(
                        change.path,
                        change.after,
                        details.customFieldDefinitions,
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {review.input.items.some((item) => (
              item.id === null && (item.customFieldValues?.length ?? 0) > 0
            )) && (
              <section className="order-edit-custom-preview" aria-label="新增商品自定义字段">
                <h3>新增商品自定义字段</h3>
                <dl>
                  {review.input.items.flatMap((item, index) => (
                    item.id === null ? (item.customFieldValues ?? []).map((entry) => {
                      const definition = itemCustomFieldDefinitions.find(
                        ({ id }) => id === entry.definitionId,
                      );
                      return (
                        <div key={`${index}:${entry.definitionId}`}>
                          <dt>商品 {index + 1} · {definition?.name ?? entry.definitionId}</dt>
                          <dd>{formatCustomFieldValue(entry.value)}</dd>
                        </div>
                      );
                    }) : []
                  ))}
                </dl>
              </section>
            )}
            <footer>
              <button
                ref={reviewFirstActionRef}
                className="button button--quiet"
                type="button"
                disabled={saving}
                onClick={() => setReview(null)}
              >
                返回继续修改
              </button>
              <button className="button button--primary" type="button" disabled={saving} onClick={() => void confirmSave()}>
                {saving ? '正在保存…' : '确认保存'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}

function DetailWorkspace({
  details,
  screenshotUrl,
  selectedScreenshotId,
  sourceLoading,
  customFieldsSaving,
  orderEditSaving,
  statusLogisticsSaving,
  error,
  onBack,
  onDirtyChange,
  onSelectSource,
  onSaveCustomFieldValues,
  onUpdateOrder,
  onUpdateStatusAndLogistics,
  onRefreshOrder,
}: {
  details: OrderDetails;
  screenshotUrl: string;
  selectedScreenshotId: string;
  sourceLoading: boolean;
  customFieldsSaving: boolean;
  orderEditSaving: boolean;
  statusLogisticsSaving: boolean;
  error: string;
  onBack: () => void;
  onDirtyChange: (kind: DetailDirtyKind) => void;
  onSelectSource: (screenshotId: string) => void;
  onSaveCustomFieldValues: (input: SaveCustomFieldValuesInput) => Promise<void>;
  onUpdateOrder: (input: OrderEditInput) => Promise<OrderDetails>;
  onUpdateStatusAndLogistics: (
    input: OrderStatusAndLogisticsUpdateInput,
  ) => Promise<OrderDetails[]>;
  onRefreshOrder: (orderId: string) => Promise<OrderDetails>;
}) {
  const { order } = details;
  const [editing, setEditing] = useState(false);
  const [maintainingStatusAndLogistics, setMaintainingStatusAndLogistics] = useState(false);
  const [statusLogisticsFeedback, setStatusLogisticsFeedback] = useState('');
  const [orderEditDirty, setOrderEditDirty] = useState(false);
  const definitions = details.customFieldDefinitions ?? [];
  const persistedCustomFieldValues = details.customFieldValues ?? [];
  const [customValues, setCustomValues] = useState<CustomFieldValueRecord[]>(
    persistedCustomFieldValues,
  );
  const [customFieldFeedback, setCustomFieldFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);
  const [customFieldValidity, setCustomFieldValidity] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setCustomValues(details.customFieldValues ?? []);
    setCustomFieldValidity({});
  }, [details.order.id, details.customFieldValues]);
  useEffect(() => {
    setCustomFieldFeedback(null);
  }, [details.order.id]);
  const customFieldsDirty = !customFieldValueRecordsEqual(
    customValues,
    persistedCustomFieldValues,
  );
  const detailDirty = customFieldsDirty || orderEditDirty;
  useEffect(() => {
    onDirtyChange(customFieldsDirty
      ? (orderEditDirty ? 'both' : 'custom_fields')
      : (orderEditDirty ? 'order_edit' : 'none'));
  }, [customFieldsDirty, onDirtyChange, orderEditDirty]);
  useEffect(() => () => onDirtyChange('none'), [onDirtyChange]);
  useEffect(() => {
    if (!detailDirty) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [detailDirty]);
  const orderCustomFields = definitions.filter(
    (definition) => definition.granularity === 'order',
  );
  const itemCustomFields = definitions.filter(
    (definition) => definition.granularity === 'order_item',
  );
  const requiredCustomFieldsComplete = orderCustomFields
    .filter((definition) => definition.required)
    .every((definition) => hasCustomFieldValue(customValueFromRecords(
      customValues,
      definition.id,
      null,
    ))) && order.items.every((item) => itemCustomFields
      .filter((definition) => definition.required)
      .every((definition) => hasCustomFieldValue(customValueFromRecords(
        customValues,
        definition.id,
        item.id,
      ))));
  const activeCustomFieldKeys = [
    ...orderCustomFields.map((definition) => `order:${definition.id}`),
    ...order.items.flatMap((item) => itemCustomFields.map(
      (definition) => `item:${item.id}:${definition.id}`,
    )),
  ];
  const customFieldInputsValid = activeCustomFieldKeys.every(
    (key) => customFieldValidity[key] !== false,
  );
  const selectedSource = details.sources.find(
    (source) => source.sourceScreenshot.id === selectedScreenshotId,
  ) ?? details.sources[0];
  const sourceScreenshot = selectedSource?.sourceScreenshot ?? details.sourceScreenshot;
  const sourceSnapshot = selectedSource?.sourceSnapshot ?? details.sourceSnapshot;
  const recipientChanged = sourceSnapshot.confirmed !== null &&
    sourceSnapshot.recognition.recipient !== sourceSnapshot.confirmed.recipient;

  function customValue(definitionId: string, orderItemId: string | null) {
    return customValues.find((entry) => (
      entry.definitionId === definitionId &&
      entry.orderItemId === orderItemId
    ))?.value ?? null;
  }

  function patchCustomValue(
    definitionId: string,
    orderItemId: string | null,
    value: CustomFieldValue | null,
  ) {
    setCustomFieldFeedback(null);
    setCustomValues((current) => updateDetailCustomFieldValue(
      current,
      order.id,
      definitionId,
      orderItemId,
      value,
    ));
  }

  async function saveCustomFields() {
    setCustomFieldFeedback(null);
    try {
      await onSaveCustomFieldValues({
        orderId: order.id,
        orderValues: orderCustomFields.map((definition) => ({
          definitionId: definition.id,
          value: customValue(definition.id, null),
        })),
        itemValues: order.items.flatMap((item) => itemCustomFields.map((definition) => ({
          definitionId: definition.id,
          orderItemId: item.id,
          value: customValue(definition.id, item.id),
        }))),
      });
      setCustomFieldFeedback({ kind: 'success', message: '自定义字段已保存。' });
    } catch (error) {
      setCustomFieldFeedback({ kind: 'error', message: errorMessage(error) });
    }
  }

  if (editing) {
    return (
      <OrderEditWorkspace
        details={details}
        screenshotUrl={screenshotUrl}
        saving={orderEditSaving}
        error={error}
        onDirtyChange={setOrderEditDirty}
        onCancel={() => {
          setOrderEditDirty(false);
          setEditing(false);
        }}
        onSave={async (input) => {
          await onUpdateOrder(input);
          setOrderEditDirty(false);
          setEditing(false);
        }}
        onRefresh={onRefreshOrder}
      />
    );
  }

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
        <div className="header-actions">
          {details.lastManualEditAt && (
            <span className="manual-edit-marker manual-edit-marker--detail">
              <strong>已修改</strong>
              <small>最近修改 {formatDateTime(details.lastManualEditAt)}</small>
            </span>
          )}
          <span className="status-chip status-chip--large">
            {platformTransactionStatusLabel(order.platformTransactionStatus)} · {fulfillmentStatusLabel(order.fulfillmentStatus)}
          </span>
          <button
            className="button button--quiet"
            type="button"
            disabled={customFieldsDirty || customFieldsSaving || statusLogisticsSaving}
            title={customFieldsDirty ? '请先保存或放弃自定义字段修改' : undefined}
            onClick={() => {
              setStatusLogisticsFeedback('');
              setMaintainingStatusAndLogistics(true);
            }}
          >
            状态与物流
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={customFieldsDirty || customFieldsSaving}
            title={customFieldsDirty ? '请先保存或放弃自定义字段修改' : undefined}
            onClick={() => {
              setOrderEditDirty(false);
              setEditing(true);
            }}
          >
            编辑订单
          </button>
        </div>
      </header>

      <InlineError message={error} />
      {statusLogisticsFeedback && (
        <p className="status-logistics-feedback status-logistics-feedback--detail" role="status" aria-label="状态与物流维护结果">
          {statusLogisticsFeedback}
        </p>
      )}

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
              <DetailTerm label="备注" value={displayValue(order.note)} wide />
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

          <section className="detail-section" aria-label="手工物流">
            <div className="detail-section-title">
              <h2>物流信息</h2>
              <span>人工维护</span>
            </div>
            <dl className="detail-grid">
              <DetailTerm label="快递公司" value={displayValue(order.shippingCarrier)} />
              <DetailTerm label="运单号" value={displayValue(order.trackingNumber)} />
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
                    <small>数量来源：{draftItemQuantitySourceLabel(item)}</small>
                  </div>
                  <span>{formatMoney(item.unitPriceCents)} × {item.quantity}</span>
                  <strong>{formatMoney(item.subtotalCents)}</strong>
                </div>
              ))}
            </div>
          </section>

          {definitions.length > 0 && (
            <section className="detail-section detail-custom-fields">
              <div className="detail-section-title">
                <h2>自定义字段</h2>
                <span>独立于订单事实保存</span>
              </div>
              {orderCustomFields.length > 0 && (
                <div className="detail-custom-fields__group">
                  <h3>订单字段</h3>
                  <div className="custom-field-grid">
                    {orderCustomFields.map((definition) => (
                      <CustomFieldInput
                        definition={definition}
                        key={definition.id}
                        value={customValue(definition.id, null)}
                        disabled={customFieldsSaving}
                        onChange={(value) => patchCustomValue(definition.id, null, value)}
                        onValidityChange={(valid) => setCustomFieldValidity((current) => ({
                          ...current,
                          [`order:${definition.id}`]: valid,
                        }))}
                      />
                    ))}
                  </div>
                </div>
              )}
              {itemCustomFields.length > 0 && order.items.map((item, index) => (
                <div className="detail-custom-fields__group" key={item.id}>
                  <h3>商品 {String(index + 1).padStart(2, '0')} · {item.sourceTitle}</h3>
                  <div className="custom-field-grid">
                    {itemCustomFields.map((definition) => {
                      const label = order.items.length === 1
                        ? definition.name
                        : `${definition.name} · 商品 ${index + 1}`;
                      return (
                        <CustomFieldInput
                          definition={definition}
                          key={definition.id}
                          label={label}
                          value={customValue(definition.id, item.id)}
                          disabled={customFieldsSaving}
                          onChange={(value) => patchCustomValue(
                            definition.id,
                            item.id,
                            value,
                          )}
                          onValidityChange={(valid) => setCustomFieldValidity((current) => ({
                            ...current,
                            [`item:${item.id}:${definition.id}`]: valid,
                          }))}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="detail-custom-fields__actions">
                {!requiredCustomFieldsComplete && (
                  <p className="custom-field-required-note" role="status">
                    请填写订单及每件商品的全部必填自定义字段。
                  </p>
                )}
                {customFieldFeedback && (
                  <p
                    className={`fields-feedback fields-feedback--${customFieldFeedback.kind}`}
                    role={customFieldFeedback.kind === 'error' ? 'alert' : 'status'}
                  >
                    {customFieldFeedback.message}
                  </p>
                )}
                <button
                  className="button button--primary"
                  type="button"
                  disabled={
                    customFieldsSaving ||
                    !requiredCustomFieldsComplete ||
                    !customFieldInputsValid
                  }
                  onClick={() => void saveCustomFields()}
                >
                  {customFieldsSaving ? '正在保存…' : '保存自定义字段'}
                </button>
              </div>
            </section>
          )}

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
      {maintainingStatusAndLogistics && (
        <OrderStatusAndLogisticsDialog
          orders={[order]}
          saving={statusLogisticsSaving}
          onClose={() => setMaintainingStatusAndLogistics(false)}
          onSave={onUpdateStatusAndLogistics}
          onSaved={() => {
            setMaintainingStatusAndLogistics(false);
            setStatusLogisticsFeedback('已更新 1 笔订单。');
          }}
        />
      )}
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

function reconcileDraftCustomFieldValues(
  current: DraftCustomFieldValues,
  definitions: CustomFieldDefinition[],
  draft: OrderDraft,
  review: OrderDraftReview | null,
  touchedKeys: ReadonlySet<string>,
): DraftCustomFieldValues {
  const sameOrderReview = review?.kind === 'order_update' && hasSameOrderIdentity(
    review.currentOrder,
    draft,
  )
    ? review
    : null;
  const persistedValues = sameOrderReview ? sameOrderReview.customFieldValues : [];
  const existingItemIdByDraftId = sameOrderReview
    ? matchOrderItemIds(sameOrderReview.currentOrder.items, draft.items)
    : new Map<string, string>();
  const orderValues = definitions
    .filter((definition) => definition.granularity === 'order')
    .map((definition) => {
      const existing = current.orderValues.find(
        (entry) => entry.definitionId === definition.id,
      );
      if (existing && touchedKeys.has(`order:${definition.id}`)) return existing;
      const persisted = persistedValues.find((entry) => (
        entry.definitionId === definition.id && entry.orderItemId === null
      ));
      return {
        definitionId: definition.id,
        value: cloneCustomFieldValue(
          sameOrderReview ? (persisted?.value ?? null) : definition.defaultValue,
        ),
      };
    });
  const itemDefinitions = definitions.filter(
    (definition) => definition.granularity === 'order_item',
  );
  const itemValues = draft.items.flatMap((item) => itemDefinitions.map((definition) => {
    const existing = current.itemValues.find((entry) => (
      entry.definitionId === definition.id && entry.draftItemId === item.id
    ));
    if (existing && touchedKeys.has(`item:${item.id}:${definition.id}`)) return existing;
    const existingItemId = existingItemIdByDraftId.get(item.id);
    const persisted = existingItemId === undefined
      ? undefined
      : persistedValues.find((entry) => (
        entry.definitionId === definition.id && entry.orderItemId === existingItemId
      ));
    return {
      definitionId: definition.id,
      draftItemId: item.id,
      value: cloneCustomFieldValue(
        existingItemId === undefined
          ? definition.defaultValue
          : (persisted?.value ?? null),
      ),
    };
  }));
  return { orderValues, itemValues };
}

function cloneCustomFieldValue(value: CustomFieldValue | null): CustomFieldValue | null {
  return Array.isArray(value) ? [...value] : value;
}

function customFieldValueRecordsEqual(
  left: readonly CustomFieldValueRecord[],
  right: readonly CustomFieldValueRecord[],
): boolean {
  const comparable = (records: readonly CustomFieldValueRecord[]) => records
    .map((record) => ({
      definitionId: record.definitionId,
      orderItemId: record.orderItemId,
      value: record.value,
    }))
    .sort((first, second) => (
      `${first.definitionId}\u0000${first.orderItemId ?? ''}`.localeCompare(
        `${second.definitionId}\u0000${second.orderItemId ?? ''}`,
      )
    ));
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function hasCustomFieldValue(value: CustomFieldValue | null): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

function upsertDraftOrderCustomFieldValue(
  values: DraftCustomFieldValues['orderValues'],
  definitionId: string,
  value: CustomFieldValue | null,
): DraftCustomFieldValues['orderValues'] {
  const next = values.filter((entry) => entry.definitionId !== definitionId);
  return [...next, { definitionId, value }];
}

function upsertDraftItemCustomFieldValue(
  values: DraftCustomFieldValues['itemValues'],
  definitionId: string,
  draftItemId: string,
  value: CustomFieldValue | null,
): DraftCustomFieldValues['itemValues'] {
  const next = values.filter((entry) => !(
    entry.definitionId === definitionId && entry.draftItemId === draftItemId
  ));
  return [...next, { definitionId, draftItemId, value }];
}

function updateDetailCustomFieldValue(
  values: CustomFieldValueRecord[],
  orderId: string,
  definitionId: string,
  orderItemId: string | null,
  value: CustomFieldValue | null,
): CustomFieldValueRecord[] {
  const existing = values.find((entry) => (
    entry.definitionId === definitionId && entry.orderItemId === orderItemId
  ));
  const next = values.filter((entry) => !(
    entry.definitionId === definitionId && entry.orderItemId === orderItemId
  ));
  if (value === null) return next;
  const now = new Date().toISOString();
  return [...next, {
    definitionId,
    orderId: orderItemId === null ? orderId : null,
    orderItemId,
    value,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }];
}

function customValueFromRecords(
  values: CustomFieldValueRecord[],
  definitionId: string,
  orderItemId: string | null,
): CustomFieldValue | null {
  return values.find((entry) => (
    entry.definitionId === definitionId && entry.orderItemId === orderItemId
  ))?.value ?? null;
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
  | 'fields'
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
    fields: <><path d="M5 5h14v4H5zM5 13h14v6H5z" /><path d="M9 5v4M15 13v6" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.06.06-2.76 2.76-.06-.06a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.08 1.65V21H10v-.09A1.8 1.8 0 0 0 8.92 19.3a1.8 1.8 0 0 0-2 .36l-.06.06-2.76-2.76.06-.06a1.8 1.8 0 0 0 .36-2A1.8 1.8 0 0 0 2.91 14H2.8v-4h.11a1.8 1.8 0 0 0 1.61-1.08 1.8 1.8 0 0 0-.36-2l-.06-.06L6.86 4.1l.06.06a1.8 1.8 0 0 0 2 .36A1.8 1.8 0 0 0 10 2.91V2.8h4v.11a1.8 1.8 0 0 0 1.08 1.61 1.8 1.8 0 0 0 2-.36l.06-.06 2.76 2.76-.06.06a1.8 1.8 0 0 0-.36 2A1.8 1.8 0 0 0 21.09 10h.11v4h-.11A1.8 1.8 0 0 0 19.4 15Z" /></>,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function findTableFieldDescriptor(
  catalog: readonly AvailableTableField[],
  reference: TableFieldReference,
): AvailableTableField | undefined {
  const key = fieldReferenceKey(reference);
  return catalog.find((field) => fieldReferenceKey(field.reference) === key);
}

function renderTableCellValue(
  reference: TableFieldReference,
  descriptor: AvailableTableField | undefined,
  value: TableCellValue,
): ReactNode {
  if (value === null || value === '') return '—';
  if (reference.kind === 'builtin' && typeof value === 'string') {
    if (reference.key === 'platform') return platformLabel(value as OrderDraft['platform']);
    if (reference.key === 'initial_source_recognition_status') {
      return <span className="status-chip">{recognitionStatusLabel(value as RecognitionBatchItemStatus)}</span>;
    }
    if (reference.key === 'platform_transaction_status') {
      return <span className="status-chip">{platformTransactionStatusLabel(value as OrderDraft['platformTransactionStatus'])}</span>;
    }
    if (reference.key === 'fulfillment_status') {
      return <span className="status-chip">{fulfillmentStatusLabel(value as OrderDraft['fulfillmentStatus'])}</span>;
    }
    if (reference.key === 'lifecycle_status') {
      return <span className="status-chip">{lifecycleStatusLabel(value as OrderSummary['lifecycleStatus'])}</span>;
    }
  }
  if (descriptor?.valueType === 'money' && typeof value === 'number') {
    return formatMoney(value);
  }
  if (descriptor?.valueType === 'datetime' && typeof value === 'string') {
    return formatDateTime(value);
  }
  if (descriptor?.valueType === 'checkbox' && typeof value === 'boolean') {
    return value ? '是' : '否';
  }
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '—';
  return String(value);
}

function formatMoney(cents: number | null): string {
  if (cents === null) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}

function formatMoneyInput(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

function draftItemQuantitySourceLabel(
  item: { quantitySource?: QuantitySource; quantityInferred: boolean },
): string {
  return quantitySourceLabel(
    item.quantitySource ?? quantitySourceFromLegacy(item.quantityInferred),
  );
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

function fulfillmentStatusLabel(status: FulfillmentStatus): string {
  const labels: Record<FulfillmentStatus, string> = {
    pending_shipment: '待发货',
    shipped: '已发货',
    delivered: '已收货',
    returned: '已退货',
    unknown: '未知',
  };
  return labels[status];
}

function hasShipmentHistory(status: FulfillmentStatus): boolean {
  return status === 'shipped' || status === 'delivered' || status === 'returned';
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

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function orderTemplatesCustomFieldDefinitionIds(
  templates: readonly TableTemplate[],
): string[] {
  return [...new Set(templates.flatMap((template) => (
    template.granularity === 'order'
      ? tableTemplateCustomFieldDefinitionIds(template.columns)
      : []
  )))].sort();
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

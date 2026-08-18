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
  OrderPlatformTransactionStatusPatch,
  OrderPlatformTransactionStatusUpdateInput,
  OriginalOrder,
  OrderSummary,
  RecognitionConflictDetail,
  RecognitionBatchView,
  RecognitionBatchItemStatus,
} from '../core/contracts';
import {
  planOrderItemAmountPrompt,
  reviewOrderEdit,
  type OrderItemAmountPrompt,
} from '../core/order-edit';
import { FULFILLMENT_STATUS_LABELS } from '../core/fulfillment-status';
import { diffOrderCurrentValues, hasSameOrderIdentity } from '../core/order-comparison';
import { matchOrderItemIds } from '../core/order-item-matching';
import type { OcrSettingsView } from '../core/ocr-settings';
import type {
  BackupEventRecord,
  BackupSettingsView,
  BackupStatusView,
  BackupVerificationReport,
  SaveBackupSettingsInput,
} from '../core/backup';
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
import type {
  OrderExportInput,
  OrderExportPreviewResult,
  OrderExportResult,
} from '../core/order-export';
import {
  isActiveRecognitionBatchItemStatus,
  MAX_AUTOMATIC_RECOGNITION_RETRIES,
  summarizeRecognitionBatchItems,
} from '../core/recognition-batches';
import {
  shipmentGroupsRequireFinalRecipient,
  type OpenShipmentGroup,
  type ShipmentGroupCustomFieldValue,
  type ShipmentGroupWorkbenchQuery,
  type ShipmentGroupProjection,
  type ShipmentGroupWorkbenchResult,
} from '../core/shipment-groups';
import type {
  ShipmentGroupExportInput,
  ShipmentGroupExportPreviewResult,
  ShipmentGroupExportResult,
} from '../core/shipment-group-export';
import {
  SHIPMENT_LOGISTICS_STATUSES,
  type ConfirmShipmentPackageInput,
  ShipmentConfirmationResult,
  ShipmentGroupArchive,
  ShipmentItemQuantityInput,
  ShipmentLogisticsStatus,
  ShipmentRecord,
} from '../core/shipment-records';
import type {
  AftersalesCase,
  ChangeAftersalesCaseWorkflowTemplateInput,
  ProgressAftersalesCaseInput,
  RecordAftersalesWorkflowStepEventInput,
} from '../core/aftersales-cases';
import { isUnresolvedLogisticsExceptionStage } from '../core/logistics-exceptions';
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
  DEFAULT_SHIPMENT_GROUP_TABLE_COLUMNS,
  fieldReferenceKey,
  projectOrderItemTableCell,
  projectOrderTableProjectionRow,
  projectShipmentGroupTableCell,
  purchaseBatchLabel,
  tableTemplateCustomFieldDefinitionIds,
  TABLE_TEMPLATE_GRANULARITIES,
  type AvailableTableField,
  type CreateTableTemplateInput,
  type TableCellValue,
  type TableFieldReference,
  type TableTemplate,
  type TableTemplateColumn,
  type TableTemplateGranularity,
  type UpdateTableTemplateInput,
} from '../core/table-templates';
import { CustomFieldInput } from './CustomFieldInput';
import { CustomFieldsWorkspace } from './CustomFieldsWorkspace';
import { AftersalesCasePanel } from './AftersalesCasePanel';
import {
  CreateAftersalesCaseDialog,
  UpdateAftersalesCaseDialog,
} from './AftersalesCaseDialogs';
import {
  aftersalesCasesForShipmentRecords,
  aftersalesCaseOperationsCoordination,
  aftersalesStatusLabel,
  carrierClaimStatusLabel,
  hasActiveParentAftersalesCase,
  returnDiscrepancyLabel,
  returnLogisticsStatusLabel,
  returnQuantityDifferenceSummary,
  shipmentRecordAftersalesSummary,
  shipmentRecordsAftersalesSummary,
} from './aftersales-presentation';
import {
  aftersalesTodoForCases,
  coordinateOrderOperations,
  fulfillmentPlanAttributionLabel,
  shipmentOrderOperationCandidates,
  shipmentLogisticsStatusLabel,
  shipmentTodoForStatuses,
  type OrderOperationsShipmentRecord,
} from '../core/order-operations-projection';
import { OrderExportDialog } from './OrderExportDialog';
import { ShipmentGroupExportDialog } from './ShipmentGroupExportDialog';
import { ShipmentGroupCustomFieldsDialog } from './ShipmentGroupCustomFieldsDialog';
import { TableTemplatesWorkspace } from './TableTemplatesWorkspace';
import { AftersalesWorkflowTemplatesWorkspace } from './AftersalesWorkflowTemplatesWorkspace';
import { FulfillmentPlansWorkspace } from './FulfillmentPlansWorkspace';
import { RecipientsWorkspace } from './RecipientsWorkspace';
import { StandardProductsWorkspace } from './StandardProductsWorkspace';
import { UpdateOrderItemStandardizationDialog } from './UpdateOrderItemStandardizationDialog';
import { OrderItemStandardizationBatchDialog } from './OrderItemStandardizationBatchDialog';
import type {
  DraftItemProductStandardization,
  ProductMappingScope,
  ProductMappingView,
  ProductStandardizationConfirmation,
  StandardProduct,
} from '../core/product-standardization';
import {
  displayedProductSpecification,
  displayedProductTitle,
} from '../core/product-standardization';
import {
  LOGISTICS_EXCEPTION_TYPE_OPTIONS,
  logisticsExceptionStageLabel,
  logisticsExceptionTypeLabel,
  nextLogisticsExceptionStages,
} from './logistics-presentation';

export type AppProps = {
  api: DesktopApi;
};

type BusyAction = 'directory' | 'upload' | 'cancel' | 'confirm' | 'detail' | 'review' | 'retry' | 'custom-fields' | 'templates' | 'order-edit' | 'status-logistics' | null;
type AppPage = 'orders' | 'shipments' | 'fulfillment_plans' | 'recipients' | 'aftersales_workflows' | 'products' | 'batches' | 'fields' | 'templates' | 'settings';
type OrdersWorkspaceView = 'orders' | 'order_items';
type DetailDirtyKind = 'none' | 'custom_fields' | 'order_edit' | 'both';
type ShipmentFocus = { recordId: string; aftersalesCaseId?: string };

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
  const [shipmentGroupQuery, setShipmentGroupQuery] = useState<ShipmentGroupWorkbenchQuery>({});
  const [orderItemWorkbench, setOrderItemWorkbench] = useState<OrderItemWorkbenchResult | null>(null);
  const [orderItemQueryLoading, setOrderItemQueryLoading] = useState(false);
  const [shipmentGroupProjection, setShipmentGroupProjection] =
    useState<ShipmentGroupWorkbenchResult | null>(null);
  const [shipmentGroupQueryRefreshToken, setShipmentGroupQueryRefreshToken] = useState(0);
  const [shipmentGroupArchives, setShipmentGroupArchives] = useState<ShipmentGroupArchive[]>([]);
  const [aftersalesCases, setAftersalesCases] = useState<AftersalesCase[]>([]);
  const [shipmentFocus, setShipmentFocus] = useState<ShipmentFocus | null>(null);
  const [shipmentGroupLoading, setShipmentGroupLoading] = useState(false);
  const [shipmentGroupError, setShipmentGroupError] = useState('');
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<CustomFieldDefinition[]>([]);
  const [customFieldDefinitionsLoading, setCustomFieldDefinitionsLoading] = useState(false);
  const [customFieldDefinitionsError, setCustomFieldDefinitionsError] = useState('');
  const [tableTemplates, setTableTemplates] = useState<TableTemplate[]>([]);
  const [tableTemplatesLoading, setTableTemplatesLoading] = useState(false);
  const [tableTemplatesError, setTableTemplatesError] = useState('');
  const [activeTableTemplateSlots, setActiveTableTemplateSlots] = useState<
    Record<TableTemplateGranularity, { id: string; dirty: boolean }>
  >({
    order: { id: '', dirty: false },
    order_item: { id: '', dirty: false },
    shipment_group: { id: '', dirty: false },
  });
  const [draftCustomFieldValues, setDraftCustomFieldValues] = useState<DraftCustomFieldValues>({
    orderValues: [],
    itemValues: [],
  });
  const draftCustomFieldValuesContextKey = useRef('');
  const draftCustomFieldTouchedKeys = useRef<Set<string>>(new Set());
  const orderSnapshotVersion = useRef(0);
  const orderQueryRequestVersion = useRef(0);
  const orderItemQueryRequestVersion = useRef(0);
  const shipmentGroupRequestVersion = useRef(0);
  const tableTemplateApplyVersion = useRef(0);
  const preloadedOrderTemplateQuery = useRef<OrderWorkbenchQuery | null>(null);
  const preloadedOrderItemTemplateQuery = useRef<OrderItemWorkbenchQuery | null>(null);
  const detailSourceRequestVersion = useRef(0);
  const readyDataDirectory = bootstrap?.kind === 'ready'
    ? bootstrap.dataDirectory
    : '';
  const activeOrderTableTemplate = tableTemplates.find(
    (template) => template.id === activeTableTemplateSlots.order.id,
  ) ?? null;
  const activeOrderItemTableTemplate = tableTemplates.find(
    (template) => template.id === activeTableTemplateSlots.order_item.id,
  ) ?? null;
  const activeShipmentGroupTableTemplate = tableTemplates.find(
    (template): template is Extract<TableTemplate, { granularity: 'shipment_group' }> => (
      template.id === activeTableTemplateSlots.shipment_group.id
        && template.granularity === 'shipment_group'
    ),
  ) ?? null;
  const orderProjectionDefinitionIdsKey = JSON.stringify(
    orderTemplatesCustomFieldDefinitionIds(tableTemplates),
  );
  const orderProjectionDefinitionIds = useMemo(
    () => JSON.parse(orderProjectionDefinitionIdsKey) as string[],
    [orderProjectionDefinitionIdsKey],
  );
  const orderItemProjectionDefinitionIds = useMemo(() => (
    activeOrderItemTableTemplate
      ? tableTemplateCustomFieldDefinitionIds(activeOrderItemTableTemplate.columns)
      : []
  ), [activeOrderItemTableTemplate]);
  const shipmentGroupProjectionDefinitionIds = useMemo(() => (
    customFieldDefinitions
      .filter(({ granularity }) => granularity === 'shipment_group')
      .map(({ id }) => id)
  ), [customFieldDefinitions]);

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
    shipmentGroupRequestVersion.current += 1;
    tableTemplateApplyVersion.current += 1;
    preloadedOrderItemTemplateQuery.current = null;
    setOrdersWorkspaceView('orders');
    setOrderItemQuery({});
    setShipmentGroupQuery({});
    setOrderItemWorkbench(null);
    setShipmentGroupProjection(null);
    setShipmentGroupArchives([]);
    setAftersalesCases([]);
    setShipmentFocus(null);
    setShipmentGroupLoading(false);
    setShipmentGroupError('');
    setOrderQueryRefreshToken(0);
    setCustomFieldDefinitions([]);
    setCustomFieldDefinitionsError('');
    setTableTemplates([]);
    setTableTemplatesError('');
    setActiveTableTemplateSlots({
      order: { id: '', dirty: false },
      order_item: { id: '', dirty: false },
      shipment_group: { id: '', dirty: false },
    });
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
      .then(async (templates) => {
        if (!active) return;
        setTableTemplates(templates);
        const stored = await api.getActiveTableTemplates()
          .catch(() => ({}) as Record<string, string>);
        if (!active) return;
        const restores = TABLE_TEMPLATE_GRANULARITIES.flatMap((granularity) => {
          const storedId = stored[granularity];
          const template = storedId
            ? templates.find((candidate) => (
              candidate.id === storedId && candidate.granularity === granularity
            ))
            : undefined;
          return template ? [{ granularity, template }] : [];
        });
        if (restores.length === 0) return;
        setActiveTableTemplateSlots((current) => {
          const next = { ...current };
          for (const { granularity, template } of restores) {
            next[granularity] = { id: template.id, dirty: false };
          }
          return next;
        });
        for (const { granularity, template } of restores) {
          if (granularity === 'order' && template.granularity === 'order') {
            setOrderQuery(structuredClone(template.query));
          } else if (granularity === 'order_item' && template.granularity === 'order_item') {
            setOrderItemQuery(structuredClone(template.query));
          } else if (
            granularity === 'shipment_group' && template.granularity === 'shipment_group'
          ) {
            setShipmentGroupQuery(structuredClone(template.query));
          }
        }
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
    if (!readyDataDirectory || activePage !== 'shipments') return undefined;
    let active = true;
    const requestVersion = ++shipmentGroupRequestVersion.current;
    setShipmentGroupLoading(true);
    setShipmentGroupError('');
    void Promise.all([
      api.queryShipmentGroupWorkbench(
        shipmentGroupQuery,
        shipmentGroupProjectionDefinitionIds,
      ),
      api.queryShipmentGroupArchives(),
      api.queryAftersalesCases(),
    ])
      .then(([projection, archives, cases]) => {
        if (!active || requestVersion !== shipmentGroupRequestVersion.current) return;
        setShipmentGroupProjection(projection);
        setShipmentGroupArchives(archives);
        setAftersalesCases(cases);
      })
      .catch((error: unknown) => {
        if (active && requestVersion === shipmentGroupRequestVersion.current) {
          setShipmentGroupError(errorMessage(error));
        }
      })
      .finally(() => {
        if (active && requestVersion === shipmentGroupRequestVersion.current) {
          setShipmentGroupLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [
    activePage,
    api,
    orderQueryRefreshToken,
    readyDataDirectory,
    shipmentGroupProjectionDefinitionIds,
    shipmentGroupQuery,
    shipmentGroupQueryRefreshToken,
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

  function markTableTemplateActive(granularity: TableTemplateGranularity, id: string): void {
    setActiveTableTemplateSlots((current) => ({
      ...current,
      [granularity]: { id, dirty: false },
    }));
  }

  function markTableTemplateDirty(granularity: TableTemplateGranularity): void {
    setActiveTableTemplateSlots((current) => (
      current[granularity].id
        ? { ...current, [granularity]: { ...current[granularity], dirty: true } }
        : current
    ));
  }

  function setTableTemplateDirty(
    granularity: TableTemplateGranularity,
    dirty: boolean,
  ): void {
    setActiveTableTemplateSlots((current) => ({
      ...current,
      [granularity]: { ...current[granularity], dirty },
    }));
  }

  function persistActiveTableTemplate(
    granularity: TableTemplateGranularity,
    templateId: string | null,
  ): void {
    void api.setActiveTableTemplate(granularity, templateId).catch(() => undefined);
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
      if (activeTableTemplateSlots[updated.granularity].id === updated.id) {
        const currentQuery = updated.granularity === 'order'
          ? orderQuery
          : updated.granularity === 'order_item'
            ? orderItemQuery
            : shipmentGroupQuery;
        setTableTemplateDirty(
          updated.granularity,
          !sameJsonValue(currentQuery, updated.query),
        );
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
      const deletingActiveTemplate = template !== undefined
        && activeTableTemplateSlots[template.granularity].id === templateId;
      let orderReset: {
        query: OrderWorkbenchQuery;
        result: OrderWorkbenchResult;
      } | null = null;
      let itemReset: {
        query: OrderItemWorkbenchQuery;
        result: OrderItemWorkbenchResult;
      } | null = null;
      let shipmentGroupReset: {
        query: ShipmentGroupWorkbenchQuery;
        result: ShipmentGroupWorkbenchResult;
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
        } else if (template.granularity === 'order_item') {
          const query: OrderItemWorkbenchQuery = {};
          itemReset = { query, result: await api.queryOrderItems(query, []) };
        } else {
          const query: ShipmentGroupWorkbenchQuery = {};
          shipmentGroupReset = {
            query,
            result: await api.queryShipmentGroupWorkbench(query, []),
          };
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
        } else if (shipmentGroupReset) {
          setShipmentGroupQuery(shipmentGroupReset.query);
          setShipmentGroupProjection(shipmentGroupReset.result);
          setActivePage('shipments');
        }
        markTableTemplateActive(template.granularity, '');
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
      } else if (template.granularity === 'order_item') {
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
      } else {
        const query = structuredClone(template.query);
        const result = await api.queryShipmentGroupWorkbench(
          query,
          shipmentGroupProjectionDefinitionIds,
        );
        if (requestVersion !== tableTemplateApplyVersion.current) return;
        setShipmentGroupQuery(query);
        setShipmentGroupProjection(result);
        setActivePage('shipments');
      }
      markTableTemplateActive(template.granularity, template.id);
      persistActiveTableTemplate(template.granularity, template.id);
      if (template.granularity !== 'shipment_group') setActivePage('orders');
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
      } else if (granularity === 'order_item') {
        const query: OrderItemWorkbenchQuery = {};
        const result = await api.queryOrderItems(query, []);
        if (requestVersion !== tableTemplateApplyVersion.current) return;
        preloadedOrderItemTemplateQuery.current = query;
        setOrderItemQuery(query);
        setOrderItemWorkbench(result);
        setOrdersWorkspaceView('order_items');
      } else {
        setShipmentGroupQuery({});
        setActivePage('shipments');
      }
      markTableTemplateActive(granularity, '');
      persistActiveTableTemplate(granularity, null);
      if (granularity !== 'shipment_group') setActivePage('orders');
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
    markTableTemplateDirty('order');
  }

  function changeOrderItemQuery(query: OrderItemWorkbenchQuery) {
    setOrderItemQuery(query);
    markTableTemplateDirty('order_item');
  }

  function changeShipmentGroupQuery(query: ShipmentGroupWorkbenchQuery) {
    setShipmentGroupQuery(query);
    markTableTemplateDirty('shipment_group');
  }

  async function saveActiveTableTemplateView(granularity: TableTemplateGranularity) {
    const activeTableTemplate = granularity === 'order'
      ? activeOrderTableTemplate
      : granularity === 'order_item'
        ? activeOrderItemTableTemplate
        : activeShipmentGroupTableTemplate;
    if (!activeTableTemplate) return;
    setOperationError('');
    try {
      await updateTableTemplate(activeTableTemplate.id, {
        name: activeTableTemplate.name,
        columns: activeTableTemplate.columns,
        query: activeTableTemplate.granularity === 'order'
          ? orderQuery
          : activeTableTemplate.granularity === 'order_item'
            ? orderItemQuery
            : shipmentGroupQuery,
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

  async function confirmOrder(
    event?: FormEvent<HTMLFormElement>,
    productStandardizations?: readonly ProductStandardizationConfirmation[],
  ) {
    event?.preventDefault();
    if (!draft || bootstrap?.kind !== 'ready') return;
    setBusyAction('confirm');
    setOperationError('');
    const isOrderUpdate = draftReview?.kind === 'order_update';
    try {
      let resolution: RecognitionBatchView['items'][number]['resolution'] = 'new_order';
      if (isOrderUpdate) {
        const outcome = productStandardizations?.length
          ? await api.confirmOrderUpdate(
            draft,
            draftReview.expectedRevision,
            customFieldDefinitions.length > 0 ? draftCustomFieldValues : undefined,
            productStandardizations,
          )
          : customFieldDefinitions.length > 0
            ? await api.confirmOrderUpdate(
              draft,
              draftReview.expectedRevision,
              draftCustomFieldValues,
            )
            : await api.confirmOrderUpdate(draft, draftReview.expectedRevision);
        resolution = outcome.resolution;
      } else {
        const outcome = productStandardizations?.length
          ? await api.confirmDraft(
            draft,
            customFieldDefinitions.length > 0 ? draftCustomFieldValues : undefined,
            productStandardizations,
          )
          : customFieldDefinitions.length > 0
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

  async function updateOrderPlatformTransactionStatus(
    input: OrderPlatformTransactionStatusUpdateInput,
  ): Promise<OrderDetails[]> {
    setBusyAction('status-logistics');
    setOperationError('');
    try {
      const details = await api.updateOrderPlatformTransactionStatus(input);
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
    const navigate = () => {
      setShipmentFocus(null);
      setActivePage(page);
    };
    if (orderDetails) {
      leaveOrderDetails(navigate);
      return;
    }
    navigate();
  }

  function locateShipment(recordId: string, aftersalesCaseId?: string) {
    leaveOrderDetails(() => {
      setShipmentFocus({ recordId, ...(aftersalesCaseId ? { aftersalesCaseId } : {}) });
      setActivePage('shipments');
    });
  }

  function openMappingLinkedOrderItems(source: { sourceTitle: string; sourceSpec: string }) {
    leaveOrderDetails(() => {
      setShipmentFocus(null);
      setOrdersWorkspaceView('order_items');
      changeOrderItemQuery({ sourceTitle: source.sourceTitle, sourceSpec: source.sourceSpec });
      setActivePage('orders');
    });
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
  } else if (activePage === 'aftersales_workflows') {
    workspace = <AftersalesWorkflowTemplatesWorkspace api={api} />;
  } else if (activePage === 'fulfillment_plans') {
    workspace = <FulfillmentPlansWorkspace api={api} />;
  } else if (activePage === 'recipients') {
    workspace = <RecipientsWorkspace api={api} />;
  } else if (activePage === 'products') {
    workspace = (
      <StandardProductsWorkspace
        api={api}
        onOpenLinkedOrderItems={openMappingLinkedOrderItems}
      />
    );
  } else if (activePage === 'templates') {
    workspace = (
      <TableTemplatesWorkspace
        templates={tableTemplates}
        customFieldDefinitions={customFieldDefinitions}
        orderQuery={orderQuery}
        orderItemQuery={orderItemQuery}
        shipmentGroupQuery={shipmentGroupQuery}
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
  } else if (activePage === 'shipments' && !orderDetails) {
    workspace = (
      <ShipmentGroupsWorkspace
        api={api}
        projection={shipmentGroupProjection}
        customFieldDefinitions={customFieldDefinitions}
        tableTemplates={tableTemplates}
        activeTableTemplate={activeShipmentGroupTableTemplate}
        activeTableTemplateDirty={activeTableTemplateSlots.shipment_group.dirty}
        query={shipmentGroupQuery}
        archives={shipmentGroupArchives}
        aftersalesCases={aftersalesCases}
        focus={shipmentFocus}
        loading={shipmentGroupLoading}
        openingOrder={busyAction === 'detail'}
        error={shipmentGroupError}
        onProjectionChange={(projection) => {
          setShipmentGroupProjection((current) => ({
            ...projection,
            customFieldValues: current?.customFieldValues.filter((value) => (
              projection.groups.some(({ id }) => id === value.shipmentGroupId)
            )) ?? [],
            allGroupCount: projection.groups.length,
          }));
          if (
            shipmentGroupQuery.text
            || shipmentGroupQuery.sortField
            || shipmentGroupQuery.customFieldFilter
            || shipmentGroupQuery.customFieldSort
          ) {
            setShipmentGroupQueryRefreshToken((token) => token + 1);
          }
        }}
        onCustomFieldValuesChange={(values) => setShipmentGroupProjection((current) => (
          current ? { ...current, customFieldValues: values } : current
        ))}
        onRefreshWorkbench={() => setShipmentGroupQueryRefreshToken((token) => token + 1)}
        onArchivesChange={setShipmentGroupArchives}
        onAftersalesCasesChange={setAftersalesCases}
        onOpenOrder={(orderId) => void openOrder(orderId)}
        onApplyTableTemplate={(template) => void applyTableTemplate(template)}
        onClearTableTemplate={() => void clearTableTemplate('shipment_group')}
        onManageTableTemplates={() => setActivePage('templates')}
        onQueryChange={changeShipmentGroupQuery}
        onSaveActiveTableTemplate={() => void saveActiveTableTemplateView('shipment_group')}
        onPreviewExport={(input) => api.previewShipmentGroupExport(input)}
        onExport={(input) => api.exportShipmentGroups(input)}
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
        onConfirm={(event, productStandardizations) => (
          void confirmOrder(event, productStandardizations)
        )}
      />
    );
  } else if ((activePage === 'orders' || activePage === 'shipments') && orderDetails) {
    workspace = (
      <DetailWorkspace
        api={api}
        details={orderDetails}
        screenshotUrl={detailScreenshotUrl}
        selectedScreenshotId={detailScreenshotId}
        sourceLoading={busyAction === 'detail'}
        customFieldsSaving={busyAction === 'custom-fields'}
        orderEditSaving={busyAction === 'order-edit'}
        statusLogisticsSaving={busyAction === 'status-logistics'}
        error={operationError}
        backLabel={activePage === 'shipments' ? '返回发货组' : '返回订单表'}
        onBack={() => leaveOrderDetails(() => undefined)}
        onDirtyChange={setDetailDirtyKind}
        onSelectSource={(screenshotId) => void selectDetailSource(screenshotId)}
        onSaveCustomFieldValues={saveOrderCustomFieldValues}
        onUpdateOrder={updateExistingOrder}
        onUpdatePlatformTransactionStatus={updateOrderPlatformTransactionStatus}
        onRefreshOrder={refreshOrderForEdit}
        onLocateShipment={locateShipment}
        onOpenShipmentGroups={() => navigateTo('shipments')}
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
        api={api}
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
        activeTableTemplate={ordersWorkspaceView === 'orders'
          ? activeOrderTableTemplate
          : activeOrderItemTableTemplate}
        activeTableTemplateDirty={ordersWorkspaceView === 'orders'
          ? activeTableTemplateSlots.order.dirty
          : activeTableTemplateSlots.order_item.dirty}
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
        onSaveActiveTableTemplate={() => void saveActiveTableTemplateView(
          ordersWorkspaceView === 'orders' ? 'order' : 'order_item',
        )}
        onUpdatePlatformTransactionStatus={updateOrderPlatformTransactionStatus}
        onPreviewExport={(input) => api.previewOrderExport(input)}
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
          <button
            className={`nav-item${activePage === 'shipments' ? ' is-active' : ''}`}
            type="button"
            aria-label="发货组"
            aria-current={activePage === 'shipments' ? 'page' : undefined}
            onClick={() => onNavigate('shipments')}
          >
            <Icon name="shipment" />
            <span className="nav-label">发货组</span>
          </button>
          <button
            className={`nav-item${activePage === 'fulfillment_plans' ? ' is-active' : ''}`}
            type="button"
            aria-label="履约计划"
            aria-current={activePage === 'fulfillment_plans' ? 'page' : undefined}
            onClick={() => onNavigate('fulfillment_plans')}
          >
            <Icon name="lock" />
            <span className="nav-label">履约计划</span>
          </button>
          <button
            className={`nav-item${activePage === 'recipients' ? ' is-active' : ''}`}
            type="button"
            aria-label="收件人"
            aria-current={activePage === 'recipients' ? 'page' : undefined}
            onClick={() => onNavigate('recipients')}
          >
            <Icon name="user" />
            <span className="nav-label">收件人</span>
          </button>
          <button
            className={`nav-item${activePage === 'aftersales_workflows' ? ' is-active' : ''}`}
            type="button"
            aria-current={activePage === 'aftersales_workflows' ? 'page' : undefined}
            onClick={() => onNavigate('aftersales_workflows')}
          >
            <Icon name="template" />
            <span className="nav-label">售后流程</span>
          </button>
          <button
            className={`nav-item${activePage === 'products' ? ' is-active' : ''}`}
            type="button"
            aria-current={activePage === 'products' ? 'page' : undefined}
            onClick={() => onNavigate('products')}
          >
            <Icon name="fields" />
            <span className="nav-label">标准商品</span>
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

function ShipmentGroupsWorkspace({
  api,
  projection,
  customFieldDefinitions,
  tableTemplates,
  activeTableTemplate,
  activeTableTemplateDirty,
  query,
  archives,
  aftersalesCases,
  focus,
  loading,
  openingOrder,
  error,
  onProjectionChange,
  onCustomFieldValuesChange,
  onRefreshWorkbench,
  onArchivesChange,
  onAftersalesCasesChange,
  onOpenOrder,
  onApplyTableTemplate,
  onClearTableTemplate,
  onManageTableTemplates,
  onQueryChange,
  onSaveActiveTableTemplate,
  onPreviewExport,
  onExport,
}: {
  api: DesktopApi;
  projection: ShipmentGroupWorkbenchResult | null;
  customFieldDefinitions: CustomFieldDefinition[];
  tableTemplates: TableTemplate[];
  activeTableTemplate: Extract<TableTemplate, { granularity: 'shipment_group' }> | null;
  activeTableTemplateDirty: boolean;
  query: ShipmentGroupWorkbenchQuery;
  archives: ShipmentGroupArchive[];
  aftersalesCases: AftersalesCase[];
  focus: ShipmentFocus | null;
  loading: boolean;
  openingOrder: boolean;
  error: string;
  onProjectionChange: (projection: ShipmentGroupProjection) => void;
  onCustomFieldValuesChange: (values: ShipmentGroupCustomFieldValue[]) => void;
  onRefreshWorkbench: () => void;
  onArchivesChange: (archives: ShipmentGroupArchive[]) => void;
  onAftersalesCasesChange: (cases: AftersalesCase[]) => void;
  onOpenOrder: (orderId: string) => void;
  onApplyTableTemplate: (
    template: Extract<TableTemplate, { granularity: 'shipment_group' }>,
  ) => void;
  onClearTableTemplate: () => void;
  onManageTableTemplates: () => void;
  onQueryChange: (query: ShipmentGroupWorkbenchQuery) => void;
  onSaveActiveTableTemplate: () => void;
  onPreviewExport: (
    input: ShipmentGroupExportInput,
  ) => Promise<ShipmentGroupExportPreviewResult>;
  onExport: (input: ShipmentGroupExportInput) => Promise<ShipmentGroupExportResult>;
}) {
  const [activeView, setActiveView] = useState<
    'pending' | 'partially_shipped' | 'fully_shipped'
  >('pending');
  const initializedView = useRef(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [adjustmentTarget, setAdjustmentTarget] = useState<
    | { kind: 'split'; group: OpenShipmentGroup }
    | { kind: 'merge'; groups: OpenShipmentGroup[] }
    | null
  >(null);
  const [confirmationTarget, setConfirmationTarget] = useState<{
    group: OpenShipmentGroup;
    archiveId: string | null;
    recipientDifferences: ShipmentGroupArchive['recipientDifferences'];
  } | null>(null);
  const [cancellationTarget, setCancellationTarget] = useState<{
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  } | null>(null);
  const [logisticsCorrectionTarget, setLogisticsCorrectionTarget] = useState<{
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  } | null>(null);
  const [logisticsStatusTarget, setLogisticsStatusTarget] = useState<{
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  } | null>(null);
  const [logisticsExceptionTarget, setLogisticsExceptionTarget] = useState<{
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  } | null>(null);
  const [carrierClaimTarget, setCarrierClaimTarget] = useState<{
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  } | null>(null);
  const [aftersalesCreateTarget, setAftersalesCreateTarget] = useState<ShipmentRecord | null>(null);
  const [aftersalesUpdateTarget, setAftersalesUpdateTarget] = useState<{
    record: ShipmentRecord;
    aftersalesCase: AftersalesCase;
  } | null>(null);
  const [exportTarget, setExportTarget] = useState<OpenShipmentGroup[] | null>(null);
  const [customFieldTarget, setCustomFieldTarget] = useState<OpenShipmentGroup | null>(null);
  const [selectedCustomFilterId, setSelectedCustomFilterId] = useState(
    query.customFieldFilter?.definitionId ?? '',
  );
  const [customFieldFeedback, setCustomFieldFeedback] = useState('');
  const groups = projection?.groups ?? [];
  const attentionOrders = projection?.attentionOrders ?? [];
  const partiallyShippedArchives = archives.filter(
    ({ status }) => status === 'partially_shipped',
  );
  const fullyShippedArchives = archives.filter(({ status }) => status === 'fully_shipped');
  const pendingGroups = groups;
  const selectedGroupIdSet = new Set(selectedGroupIds);
  const selectedGroups = pendingGroups.filter(({ id }) => selectedGroupIdSet.has(id));
  const shipmentGroupTemplates = tableTemplates.filter(
    (template): template is Extract<TableTemplate, { granularity: 'shipment_group' }> => (
      template.granularity === 'shipment_group'
    ),
  );
  const shipmentGroupColumns = activeTableTemplate?.columns
    ?? DEFAULT_SHIPMENT_GROUP_TABLE_COLUMNS;
  const shipmentGroupFieldCatalog = availableTableFields(
    'shipment_group',
    customFieldDefinitions,
  );
  const shipmentGroupCustomDefinitions = customFieldDefinitions.filter(
    ({ granularity }) => granularity === 'shipment_group',
  );
  const selectedCustomFilter = shipmentGroupCustomDefinitions.find(
    ({ id }) => id === selectedCustomFilterId,
  );
  const hasActiveQuery = Boolean(
    query.text || query.sortField || query.customFieldFilter || query.customFieldSort,
  );
  const patchQuery = (patch: Partial<ShipmentGroupWorkbenchQuery>) => {
    onQueryChange({ ...query, ...patch });
  };

  function shipmentGroupCell(group: OpenShipmentGroup, column: TableTemplateColumn): string {
    const value = projectShipmentGroupTableCell(
      group,
      column.field,
      projection?.customFieldValues ?? [],
    );
    const valueType = shipmentGroupFieldCatalog.find(({ reference }) => (
      fieldReferenceKey(reference) === fieldReferenceKey(column.field)
    ))?.valueType;
    if (value === null) return '—';
    if (valueType === 'money' && typeof value === 'number') return formatMoney(value);
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (Array.isArray(value)) return value.join('、');
    return String(value);
  }

  useEffect(() => {
    setSelectedCustomFilterId(query.customFieldFilter?.definitionId ?? '');
  }, [query.customFieldFilter?.definitionId]);

  useEffect(() => {
    const currentGroupIds = new Set(pendingGroups.map(({ id }) => id));
    setSelectedGroupIds((current) => current.filter((id) => currentGroupIds.has(id)));
  }, [archives, projection]);

  useEffect(() => {
    if (initializedView.current || loading || !projection) return;
    initializedView.current = true;
    if (pendingGroups.length > 0 || attentionOrders.length > 0) {
      setActiveView('pending');
    } else if (partiallyShippedArchives.length > 0) {
      setActiveView('partially_shipped');
    } else if (fullyShippedArchives.length > 0) {
      setActiveView('fully_shipped');
    }
  }, [
    attentionOrders.length,
    fullyShippedArchives.length,
    loading,
    partiallyShippedArchives.length,
    pendingGroups.length,
    projection,
  ]);

  useEffect(() => {
    if (!focus) return undefined;
    const archive = archives.find(({ records }) => (
      records.some(({ id }) => id === focus.recordId)
    ));
    if (archive) setActiveView(archive.status);
    // 目标卡片要等视图切换与数据加载后才会挂载，慢环境下单次定时可能扑空，按小间隔重试。
    let cancelled = false;
    let attempts = 0;
    const attempt = () => {
      const targetId = focus.aftersalesCaseId
        ? `aftersales-case-${focus.aftersalesCaseId}`
        : `shipment-record-${focus.recordId}`;
      const element = document.getElementById(targetId);
      if (element) {
        element.focus();
        element.scrollIntoView?.({ block: 'center' });
        return;
      }
      attempts += 1;
      if (!cancelled && attempts < 40) window.setTimeout(attempt, 50);
    };
    const timeout = window.setTimeout(attempt);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [archives, focus]);

  function replaceArchive(nextArchive: ShipmentGroupArchive) {
    onArchivesChange([
      nextArchive,
      ...archives.filter(({ id }) => id !== nextArchive.id),
    ]);
    setActiveView(nextArchive.status);
  }

  async function progressAftersales(input: ProgressAftersalesCaseInput) {
    const updated = await api.progressAftersalesCase(input);
    try {
      const refreshed = await api.queryAftersalesCases();
      const latestCases = new Map<string, AftersalesCase>();
      for (const aftersalesCase of [...aftersalesCases, ...refreshed]) {
        const existing = latestCases.get(aftersalesCase.id);
        if (!existing || aftersalesCase.revision >= existing.revision) {
          latestCases.set(aftersalesCase.id, aftersalesCase);
        }
      }
      latestCases.set(updated.id, updated);
      onAftersalesCasesChange([
        updated,
        ...[...latestCases.values()].filter(({ id }) => id !== updated.id),
      ]);
    } catch {
      onAftersalesCasesChange([
        updated,
        ...aftersalesCases.filter(({ id }) => id !== updated.id),
      ]);
    }
  }

  async function changeAftersalesWorkflow(
    input: ChangeAftersalesCaseWorkflowTemplateInput,
  ) {
    const updated = await api.changeAftersalesCaseWorkflowTemplate(input);
    onAftersalesCasesChange([
      updated,
      ...aftersalesCases.filter(({ id }) => id !== updated.id),
    ]);
  }

  async function recordAftersalesWorkflowStepEvent(
    input: RecordAftersalesWorkflowStepEventInput,
  ) {
    const updated = await api.recordAftersalesWorkflowStepEvent(input);
    onAftersalesCasesChange([
      updated,
      ...aftersalesCases.filter(({ id }) => id !== updated.id),
    ]);
  }

  function toggleGroup(groupId: string) {
    setSelectedGroupIds((current) => (
      current.includes(groupId)
        ? current.filter((id) => id !== groupId)
        : [...current, groupId]
    ));
  }

  return (
    <section
      className="shipment-groups-workspace workspace-enter"
      aria-busy={loading || openingOrder}
    >
      <header className="workspace-header">
        <div>
          <span className="section-kicker">合并发货</span>
          <h1>发货组</h1>
          <p>按手机号与完整地址精确匹配待发货订单；原始订单不会被合并或改写。</p>
        </div>
      </header>

      <InlineError message={error} />
      {customFieldFeedback && <p className="orders-feedback" role="status">{customFieldFeedback}</p>}

      <section className="orders-overview" aria-label="发货组概况">
        <span><small>待发货组</small><strong>{pendingGroups.length}</strong></span>
        <span><small>部分发货</small><strong>{partiallyShippedArchives.length}</strong></span>
        <span><small>已全部发货</small><strong>{fullyShippedArchives.length}</strong></span>
        <span><small>未自动成组</small><strong>{attentionOrders.length}</strong></span>
      </section>

      <div className="shipment-stage-tabs" role="tablist" aria-label="发货阶段">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'pending'}
          onClick={() => setActiveView('pending')}
        >
          待发货 {pendingGroups.length}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'partially_shipped'}
          onClick={() => setActiveView('partially_shipped')}
        >
          部分发货 {partiallyShippedArchives.length}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'fully_shipped'}
          onClick={() => setActiveView('fully_shipped')}
        >
          已全部发货 {fullyShippedArchives.length}
        </button>
      </div>

      {activeView === 'pending' && loading && !projection ? (
        <p className="shipment-groups-status" role="status" aria-label="发货组计算状态">
          正在根据订单当前值计算发货组…
        </p>
      ) : activeView === 'pending' && pendingGroups.length === 0 ? (
        <section className="shipment-groups-empty">
          <h2>{attentionOrders.length > 0
            ? '暂无可自动成组的订单'
            : '没有待发货订单'}</h2>
          <p>{attentionOrders.length > 0
            ? '补全收货信息后，发货组会自动重新计算。'
            : '新的待发货订单入库后会自动显示在这里。'}</p>
        </section>
      ) : activeView === 'pending' ? (
        <section className="shipment-groups-section" aria-labelledby="open-shipment-groups-title">
          <div className="shipment-groups-section__heading">
            <div>
              <h2 id="open-shipment-groups-title">开放发货组</h2>
              <p>单笔订单也会形成一个发货组；商品按原始商品与款式或规格精确汇总。</p>
            </div>
            {loading && <span role="status">正在更新…</span>}
          </div>
          <div className="workbench-template-bar" aria-label="当前表格模板">
            <label>
              <span>表格模板</span>
              <select
                aria-label="表格模板"
                value={activeTableTemplate?.id ?? ''}
                onChange={(event) => {
                  const template = shipmentGroupTemplates.find(({ id }) => (
                    id === event.target.value
                  ));
                  if (template) onApplyTableTemplate(template);
                  else onClearTableTemplate();
                }}
              >
                <option value="">默认发货组字段</option>
                {shipmentGroupTemplates.map((template) => (
                  <option key={template.id} value={template.id}>{template.name}</option>
                ))}
              </select>
            </label>
            {activeTableTemplate && (
              <span className={`template-state${activeTableTemplateDirty ? ' is-dirty' : ''}`}>
                {activeTableTemplateDirty ? '筛选或排序已修改' : '已应用保存配置'}
              </span>
            )}
            {activeTableTemplate && activeTableTemplateDirty && (
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
          <div className="shipment-groups-actions" aria-label="发货组调整操作">
            <span>已选 {selectedGroups.length} 组</span>
            <button
              className="button button--quiet"
              type="button"
              disabled={selectedGroups.length < 2}
              onClick={() => setAdjustmentTarget({ kind: 'merge', groups: selectedGroups })}
            >
              重新组合
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={pendingGroups.length === 0}
              onClick={() => setExportTarget(
                selectedGroups.length > 0 ? selectedGroups : pendingGroups,
              )}
            >
              {selectedGroups.length > 0 ? '导出已选发货组' : '导出当前发货组'}
            </button>
          </div>
          <section className="order-query shipment-group-query" aria-label="发货组查询">
            <label className="order-query__search">
              <span>搜索发货组</span>
              <input
                type="search"
                placeholder="订单号、收件信息或商品"
                value={query.text ?? ''}
                onChange={(event) => patchQuery({ text: event.target.value || undefined })}
              />
            </label>
            <span className="order-query__result" role="status" aria-live="polite">
              {loading
                ? '正在查询…'
                : `显示 ${pendingGroups.length} / ${projection?.allGroupCount ?? pendingGroups.length} 组`}
            </span>
            {hasActiveQuery && (
              <button
                className="button button--quiet order-query__clear"
                type="button"
                onClick={() => {
                  setSelectedCustomFilterId('');
                  onQueryChange({});
                }}
              >
                清除筛选
              </button>
            )}
            <div className="order-query__filters">
              <label>
                <span>内置排序</span>
                <select
                  aria-label="发货组内置排序"
                  value={query.customFieldSort
                    ? ''
                    : query.sortField
                      ? `${query.sortField}:${query.sortDirection ?? 'asc'}`
                      : ''}
                  onChange={(event) => {
                    if (!event.target.value) {
                      patchQuery({
                        sortField: undefined,
                        sortDirection: undefined,
                        customFieldSort: undefined,
                      });
                      return;
                    }
                    const separator = event.target.value.lastIndexOf(':');
                    patchQuery({
                      sortField: event.target.value.slice(0, separator) as NonNullable<
                        ShipmentGroupWorkbenchQuery['sortField']
                      >,
                      sortDirection: event.target.value.slice(separator + 1) as 'asc' | 'desc',
                      customFieldSort: undefined,
                    });
                  }}
                >
                  <option value="">默认排序</option>
                  {query.customFieldSort && (
                    <option value="" disabled>当前由自定义字段排序</option>
                  )}
                  <option value="recipient:asc">最终收件人：升序</option>
                  <option value="recipient:desc">最终收件人：降序</option>
                  <option value="address:asc">最终收货地址：升序</option>
                  <option value="address:desc">最终收货地址：降序</option>
                  <option value="order_count:asc">合并订单数：少到多</option>
                  <option value="order_count:desc">合并订单数：多到少</option>
                  <option value="total_quantity:asc">商品总数量：少到多</option>
                  <option value="total_quantity:desc">商品总数量：多到少</option>
                  <option value="total_amount:asc">合并总额：低到高</option>
                  <option value="total_amount:desc">合并总额：高到低</option>
                </select>
              </label>
              <label>
                <span>自定义字段筛选</span>
                <select
                  aria-label="发货组自定义字段筛选"
                  value={selectedCustomFilterId}
                  onChange={(event) => {
                    setSelectedCustomFilterId(event.target.value);
                    patchQuery({ customFieldFilter: undefined });
                  }}
                >
                  <option value="">不筛选</option>
                  {shipmentGroupCustomDefinitions.map((definition) => (
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
                    ? '发货组自定义字段值（包含全部所选项）'
                    : '发货组自定义字段值'}
                  showRequired={false}
                  onChange={(value) => patchQuery({
                    customFieldFilter: value === null
                      ? undefined
                      : { definitionId: selectedCustomFilter.id, value },
                  })}
                />
              )}
              <label>
                <span>自定义字段排序</span>
                <select
                  aria-label="发货组自定义字段排序"
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
                  {shipmentGroupCustomDefinitions.flatMap((definition) => ([
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
          <div className="table-frame shipment-groups-table-frame">
            <table aria-label="开放发货组">
              <thead>
                <tr>
                  <th aria-label="选择" />
                  {shipmentGroupColumns.map((column, index) => (
                    <th key={`${fieldReferenceKey(column.field)}:${index}`}>
                      {column.displayName}
                    </th>
                  ))}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pendingGroups.map((group) => (
                  <tr key={group.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择发货组 ${group.orders.map(({ orderNumber }) => orderNumber).join('、')}`}
                        checked={selectedGroupIdSet.has(group.id)}
                        onChange={() => toggleGroup(group.id)}
                      />
                    </td>
                    {shipmentGroupColumns.map((column, index) => (
                      <td key={`${fieldReferenceKey(column.field)}:${index}`}>
                        {column.field.kind === 'builtin'
                          && column.field.key === 'member_order_numbers' ? (
                            <span className="shipment-group-orders">
                              {group.orders.map((order) => (
                                <span className="shipment-group-order" key={order.id}>
                                  <button
                                    className="order-link"
                                    type="button"
                                    aria-label={`查看原始订单 ${order.orderNumber}`}
                                    onClick={() => onOpenOrder(order.id)}
                                    disabled={openingOrder}
                                  >
                                    {order.orderNumber}
                                  </button>
                                  {(group.recipients.length > 1
                                    || new Set(group.orders.map((member) => (
                                      member.repurchaseRank
                                    ))).size > 1) && (
                                    <small>{repurchaseStatusLabel(order.repurchaseRank)}</small>
                                  )}
                                </span>
                              ))}
                            </span>
                          ) : column.field.kind === 'builtin'
                            && column.field.key === 'product_summary' ? (
                              <span className="order-product-summary">
                                {group.items.map((item) => (
                                  <span key={`${item.title}\u0000${item.specification}`}>
                                    <strong>{item.title}</strong>
                                    <small>
                                      {item.specification
                                        ? `${item.specification} × ${item.quantity}`
                                        : `× ${item.quantity}`}
                                    </small>
                                  </span>
                                ))}
                              </span>
                            ) : column.field.kind === 'builtin'
                              && column.field.key === 'recipient' ? (
                                <span className="order-cell-stack order-cell-stack--recipient">
                                  <strong>{group.recipient || '—'}</strong>
                                  {group.recipientConflict && (
                                    <small>成员收件人不一致：{group.recipients.join(' / ')}</small>
                                  )}
                                </span>
                              ) : shipmentGroupCell(group, column)}
                      </td>
                    ))}
                    <td>
                      <span className="shipment-group-row-actions">
                        {shipmentGroupCustomDefinitions.length > 0 && (
                          <button
                            className="button button--quiet"
                            type="button"
                            onClick={() => {
                              setCustomFieldFeedback('');
                              setCustomFieldTarget(group);
                            }}
                          >
                            编辑组字段
                          </button>
                        )}
                        <button
                          className="button button--primary"
                          type="button"
                          aria-label={`确认实际发出 ${group.orders.map(({ orderNumber }) => orderNumber).join('、')}`}
                          onClick={() => setConfirmationTarget({
                            group,
                            archiveId: null,
                            recipientDifferences: [],
                          })}
                        >
                          确认实际发出
                        </button>
                        {group.orders.length > 1 && (
                        <button
                          className="button button--quiet shipment-group-split-button"
                          type="button"
                          aria-label={`拆分发货组 ${group.orders.map(({ orderNumber }) => orderNumber).join('、')}`}
                          onClick={() => setAdjustmentTarget({ kind: 'split', group })}
                        >
                          拆分
                        </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {activeView === 'pending' && attentionOrders.length > 0 && (
        <section className="shipment-groups-section" aria-labelledby="shipment-attention-title">
          <div className="shipment-groups-section__heading">
            <div>
              <h2 id="shipment-attention-title">未自动成组</h2>
              <p>补全手机号和完整地址后，系统会按最新订单当前值自动重新计算。</p>
            </div>
          </div>
          <div className="table-frame shipment-groups-attention-table-frame">
            <table aria-label="未自动成组订单">
              <thead>
                <tr>
                  <th>订单号</th>
                  <th>收件人</th>
                  <th>手机号</th>
                  <th>完整地址</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {attentionOrders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <button
                        className="order-link"
                        type="button"
                        aria-label={`查看原始订单 ${order.orderNumber}`}
                        onClick={() => onOpenOrder(order.id)}
                        disabled={openingOrder}
                      >
                        {order.orderNumber}
                      </button>
                    </td>
                    <td>{order.recipient || '—'}</td>
                    <td>{order.phone || '—'}</td>
                    <td>{order.addressOriginal || '—'}</td>
                    <td>{order.reasons.map(shipmentGroupAttentionReasonLabel).join('、')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeView === 'partially_shipped' && (
        <ShipmentArchiveSection
          api={api}
          label="部分发货组"
          emptyMessage="没有部分发货的发货组"
          archives={partiallyShippedArchives}
          aftersalesCases={aftersalesCases}
          focus={focus}
          onContinueShipment={(archiveId, group, recipientDifferences) => {
            setConfirmationTarget({ archiveId, group, recipientDifferences });
          }}
          onOpenOrder={onOpenOrder}
          onCancelPackage={(record, shipmentPackage, packageIndex) => {
            setCancellationTarget({ record, shipmentPackage, packageIndex });
          }}
          onCorrectLogistics={(record, shipmentPackage, packageIndex) => {
            setLogisticsCorrectionTarget({ record, shipmentPackage, packageIndex });
          }}
          onUpdateLogisticsStatus={(record, shipmentPackage, packageIndex) => {
            setLogisticsStatusTarget({ record, shipmentPackage, packageIndex });
          }}
          onProgressLogisticsException={(record, shipmentPackage, packageIndex) => {
            setLogisticsExceptionTarget({ record, shipmentPackage, packageIndex });
          }}
          onProgressCarrierClaim={(record, shipmentPackage, packageIndex) => {
            setCarrierClaimTarget({ record, shipmentPackage, packageIndex });
          }}
          onCreateAftersales={setAftersalesCreateTarget}
          onUpdateAftersales={(record, aftersalesCase) => {
            setAftersalesUpdateTarget({ record, aftersalesCase });
          }}
          onProgressAftersales={progressAftersales}
          onRecordStepEvent={recordAftersalesWorkflowStepEvent}
          onChangeAftersalesWorkflow={changeAftersalesWorkflow}
        />
      )}

      {activeView === 'fully_shipped' && (
        <ShipmentArchiveSection
          api={api}
          label="已全部发货的发货组"
          emptyMessage="尚无已全部发货的发货组档案"
          archives={fullyShippedArchives}
          aftersalesCases={aftersalesCases}
          focus={focus}
          onContinueShipment={(archiveId, group, recipientDifferences) => {
            setConfirmationTarget({ archiveId, group, recipientDifferences });
          }}
          onOpenOrder={onOpenOrder}
          onCancelPackage={(record, shipmentPackage, packageIndex) => {
            setCancellationTarget({ record, shipmentPackage, packageIndex });
          }}
          onCorrectLogistics={(record, shipmentPackage, packageIndex) => {
            setLogisticsCorrectionTarget({ record, shipmentPackage, packageIndex });
          }}
          onUpdateLogisticsStatus={(record, shipmentPackage, packageIndex) => {
            setLogisticsStatusTarget({ record, shipmentPackage, packageIndex });
          }}
          onProgressLogisticsException={(record, shipmentPackage, packageIndex) => {
            setLogisticsExceptionTarget({ record, shipmentPackage, packageIndex });
          }}
          onProgressCarrierClaim={(record, shipmentPackage, packageIndex) => {
            setCarrierClaimTarget({ record, shipmentPackage, packageIndex });
          }}
          onCreateAftersales={setAftersalesCreateTarget}
          onUpdateAftersales={(record, aftersalesCase) => {
            setAftersalesUpdateTarget({ record, aftersalesCase });
          }}
          onProgressAftersales={progressAftersales}
          onRecordStepEvent={recordAftersalesWorkflowStepEvent}
          onChangeAftersalesWorkflow={changeAftersalesWorkflow}
        />
      )}

      {confirmationTarget && (
        <ConfirmShipmentDialog
          api={api}
          group={confirmationTarget.group}
          archiveId={confirmationTarget.archiveId}
          recipientDifferences={confirmationTarget.recipientDifferences}
          onApplied={({ archive, projection: nextProjection }) => {
            onProjectionChange(nextProjection);
            replaceArchive(archive);
            setConfirmationTarget(null);
          }}
          onClose={() => setConfirmationTarget(null)}
        />
      )}

      {cancellationTarget && (
        <CancelShipmentPackageDialog
          api={api}
          target={cancellationTarget}
          onApplied={({ archive, projection: nextProjection }) => {
            onProjectionChange(nextProjection);
            replaceArchive(archive);
            setCancellationTarget(null);
          }}
          onClose={() => setCancellationTarget(null)}
        />
      )}

      {logisticsCorrectionTarget && (
        <CorrectShipmentPackageLogisticsDialog
          api={api}
          target={logisticsCorrectionTarget}
          onApplied={({ archive, projection: nextProjection }) => {
            onProjectionChange(nextProjection);
            replaceArchive(archive);
            setLogisticsCorrectionTarget(null);
          }}
          onClose={() => setLogisticsCorrectionTarget(null)}
        />
      )}

      {logisticsStatusTarget && (
        <UpdateShipmentPackageLogisticsStatusDialog
          api={api}
          target={logisticsStatusTarget}
          onApplied={({ archive, projection: nextProjection }) => {
            onProjectionChange(nextProjection);
            replaceArchive(archive);
            setLogisticsStatusTarget(null);
          }}
          onClose={() => setLogisticsStatusTarget(null)}
        />
      )}

      {carrierClaimTarget && (
        <ShipmentPackageCarrierClaimDialog
          api={api}
          target={carrierClaimTarget}
          onApplied={({ archive, projection: nextProjection }) => {
            onProjectionChange(nextProjection);
            replaceArchive(archive);
            setCarrierClaimTarget(null);
          }}
          onClose={() => setCarrierClaimTarget(null)}
        />
      )}

      {logisticsExceptionTarget && (
        <ShipmentPackageLogisticsExceptionDialog
          api={api}
          target={logisticsExceptionTarget}
          onApplied={({ archive, projection: nextProjection }) => {
            onProjectionChange(nextProjection);
            replaceArchive(archive);
            setLogisticsExceptionTarget(null);
          }}
          onClose={() => setLogisticsExceptionTarget(null)}
        />
      )}

      {aftersalesCreateTarget && (
        <CreateAftersalesCaseDialog
          api={api}
          record={aftersalesCreateTarget}
          existingCases={aftersalesCases}
          onApplied={(created) => {
            onAftersalesCasesChange([created, ...aftersalesCases]);
            setAftersalesCreateTarget(null);
          }}
          onClose={() => setAftersalesCreateTarget(null)}
        />
      )}

      {aftersalesUpdateTarget && (
        <UpdateAftersalesCaseDialog
          api={api}
          record={aftersalesUpdateTarget.record}
          aftersalesCase={aftersalesUpdateTarget.aftersalesCase}
          existingCases={aftersalesCases}
          onApplied={(updated) => {
            onAftersalesCasesChange([
              updated,
              ...aftersalesCases.filter(({ id }) => id !== updated.id),
            ]);
            setAftersalesUpdateTarget(null);
          }}
          onClose={() => setAftersalesUpdateTarget(null)}
        />
      )}

      {adjustmentTarget && (
        <ShipmentGroupAdjustmentDialog
          api={api}
          target={adjustmentTarget}
          onApplied={(nextProjection) => {
            onProjectionChange(nextProjection);
            setSelectedGroupIds([]);
            setAdjustmentTarget(null);
          }}
          onClose={() => setAdjustmentTarget(null)}
        />
      )}

      {customFieldTarget && (
        <ShipmentGroupCustomFieldsDialog
          group={customFieldTarget}
          definitions={shipmentGroupCustomDefinitions}
          values={projection?.customFieldValues ?? []}
          onSave={(input) => api.saveShipmentGroupCustomFieldValues(input)}
          onApplied={(savedValues) => {
            const savedDefinitionIds = new Set(savedValues.map(({ definitionId }) => definitionId));
            const nextValues = [
              ...(projection?.customFieldValues.filter((value) => !(
                value.shipmentGroupId === customFieldTarget.id
                && savedDefinitionIds.has(value.definitionId)
              )) ?? []),
              ...savedValues,
            ];
            onCustomFieldValuesChange(nextValues);
            onRefreshWorkbench();
            setCustomFieldTarget(null);
            setCustomFieldFeedback('发货组字段已保存');
          }}
          onClose={() => setCustomFieldTarget(null)}
        />
      )}

      {exportTarget && (
        <ShipmentGroupExportDialog
          groups={exportTarget}
          templates={tableTemplates}
          initialShipmentGroupTemplateId={activeTableTemplate?.id ?? null}
          onPreview={onPreviewExport}
          onExport={onExport}
          onSaved={(result) => {
            setCustomFieldFeedback(
              `已导出 ${result.shipmentGroupCount} 个发货组、${result.orderCount} 笔订单：${result.fileName}`,
            );
            setExportTarget(null);
          }}
          onClose={() => setExportTarget(null)}
        />
      )}
    </section>
  );
}

type ShipmentPackageDraft = {
  id: string;
  shippingCarrier: string;
  trackingNumber: string;
  quantities: Record<string, number>;
};

function ConfirmShipmentDialog({
  api,
  group,
  archiveId,
  recipientDifferences,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  group: OpenShipmentGroup;
  archiveId: string | null;
  recipientDifferences: ShipmentGroupArchive['recipientDifferences'];
  onApplied: (result: ShipmentConfirmationResult) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
    orderId: order.id,
    orderItemId: item.id,
    orderNumber: order.orderNumber,
    sourceTitle: item.sourceTitle,
    sourceSpec: item.sourceSpec,
    quantity: item.quantity,
  })));
  const expectedRemainingItems: ShipmentItemQuantityInput[] = remainingItems.map((item) => ({
    orderId: item.orderId,
    orderItemId: item.orderItemId,
    quantity: item.quantity,
  }));
  const [nextPackageNumber, setNextPackageNumber] = useState(2);
  const [packages, setPackages] = useState<ShipmentPackageDraft[]>([{
    id: 'package-1',
    shippingCarrier: '',
    trackingNumber: '',
    quantities: Object.fromEntries(remainingItems.map((item) => [item.orderItemId, item.quantity])),
  }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  const allocatedByItemId = Object.fromEntries(remainingItems.map((item) => [
    item.orderItemId,
    packages.reduce((total, shipmentPackage) => (
      total + (shipmentPackage.quantities[item.orderItemId] ?? 0)
    ), 0),
  ]));
  const hasOverAllocation = remainingItems.some(
    (item) => allocatedByItemId[item.orderItemId] > item.quantity,
  );
  const hasEmptyPackage = packages.some((shipmentPackage) => (
    remainingItems.every((item) => (shipmentPackage.quantities[item.orderItemId] ?? 0) === 0)
  ));
  const hasAllocatedItem = Object.values(allocatedByItemId).some((quantity) => quantity > 0);
  const canSubmit = hasAllocatedItem && !hasOverAllocation && !hasEmptyPackage;

  function updatePackage(
    packageId: string,
    update: (shipmentPackage: ShipmentPackageDraft) => ShipmentPackageDraft,
  ) {
    setPackages((current) => current.map((shipmentPackage) => (
      shipmentPackage.id === packageId ? update(shipmentPackage) : shipmentPackage
    )));
  }

  function addPackage() {
    const packageNumber = nextPackageNumber;
    setNextPackageNumber(packageNumber + 1);
    setPackages((current) => [...current, {
      id: `package-${packageNumber}`,
      shippingCarrier: '',
      trackingNumber: '',
      quantities: Object.fromEntries(remainingItems.map((item) => [item.orderItemId, 0])),
    }]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.confirmShipment({
        groupId: group.id,
        archiveId,
        expectedRemainingItems,
        packages: packages.map((shipmentPackage): ConfirmShipmentPackageInput => ({
          shippingCarrier: shipmentPackage.shippingCarrier,
          trackingNumber: shipmentPackage.trackingNumber,
          items: remainingItems.flatMap((item) => {
            const quantity = shipmentPackage.quantities[item.orderItemId] ?? 0;
            return quantity > 0 ? [{
              orderId: item.orderId,
              orderItemId: item.orderItemId,
              quantity,
            }] : [];
          }),
        })),
      });
      onApplied(result);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
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
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-confirmation-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">开放发货组 · 实际交寄</span>
          <h2 id={headingId}>确认实际发出</h2>
          <p id={descriptionId}>
            只登记本次真正发出的商品和数量；未登记的剩余数量继续留在开放发货组。
          </p>
        </header>

        <section className="shipment-confirmation-dialog__recipient" aria-label="本次收件信息">
          <strong>{group.recipient} · {group.phone}</strong>
          <span>{group.addressOriginal}</span>
        </section>

        {recipientDifferences.length > 0 && (
          <section className="shipment-archive-recipient-warning" role="status">
            <strong>档案建立后，成员订单的收货信息有变化</strong>
            <span>本次继续使用档案中保存的收货信息，请确认后再发出。</span>
            <ul>
              {recipientDifferences.map((difference) => (
                <li key={difference.orderId}>
                  {difference.orderNumber}：{difference.fields
                    .map(shipmentArchiveRecipientDifferenceLabel).join('、')}已变化
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="shipment-confirmation-dialog__packages">
          {packages.map((shipmentPackage, packageIndex) => (
            <fieldset key={shipmentPackage.id}>
              <legend>包裹 {packageIndex + 1}</legend>
              <div className="shipment-confirmation-dialog__logistics">
                <label>
                  <span>承运方</span>
                  <input
                    aria-label={`包裹 ${packageIndex + 1} 承运方`}
                    value={shipmentPackage.shippingCarrier}
                    disabled={saving}
                    onChange={(event) => updatePackage(shipmentPackage.id, (current) => ({
                      ...current,
                      shippingCarrier: event.target.value,
                    }))}
                  />
                </label>
                <label>
                  <span>运单号</span>
                  <input
                    aria-label={`包裹 ${packageIndex + 1} 运单号`}
                    value={shipmentPackage.trackingNumber}
                    disabled={saving}
                    onChange={(event) => updatePackage(shipmentPackage.id, (current) => ({
                      ...current,
                      trackingNumber: event.target.value,
                    }))}
                  />
                </label>
              </div>
              <div className="shipment-confirmation-dialog__items">
                {remainingItems.map((item) => (
                  <label key={`${shipmentPackage.id}-${item.orderItemId}`}>
                    <span>
                      <strong>{item.sourceTitle}</strong>
                      <small>{item.orderNumber}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</small>
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={item.quantity}
                      step={1}
                      aria-label={`包裹 ${packageIndex + 1} ${item.orderNumber} ${item.sourceTitle} 发出数量`}
                      value={shipmentPackage.quantities[item.orderItemId] ?? 0}
                      disabled={saving}
                      onChange={(event) => updatePackage(shipmentPackage.id, (current) => ({
                        ...current,
                        quantities: {
                          ...current.quantities,
                          [item.orderItemId]: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                        },
                      }))}
                    />
                    <small>剩余 {item.quantity}</small>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>

        <button
          className="button button--quiet shipment-confirmation-dialog__add-package"
          type="button"
          disabled={saving}
          onClick={addPackage}
        >
          新增包裹
        </button>
        {hasOverAllocation && (
          <p className="shipment-group-adjustment-dialog__error" role="alert">
            同一商品分配到各包裹的数量不能超过发货组剩余数量。
          </p>
        )}
        {hasEmptyPackage && packages.length > 1 && (
          <p className="shipment-confirmation-dialog__hint">每个包裹至少分配一件商品。</p>
        )}
        {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
        <footer>
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button className="button button--primary" type="submit" disabled={saving || !canSubmit}>
            {saving ? '正在保存…' : '确认实际发出'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function ShipmentArchiveSection({
  api,
  label,
  emptyMessage,
  archives,
  aftersalesCases,
  focus,
  onContinueShipment,
  onOpenOrder,
  onCancelPackage,
  onCorrectLogistics,
  onUpdateLogisticsStatus,
  onProgressLogisticsException,
  onProgressCarrierClaim,
  onCreateAftersales,
  onUpdateAftersales,
  onProgressAftersales,
  onRecordStepEvent,
  onChangeAftersalesWorkflow,
}: {
  api: DesktopApi;
  label: string;
  emptyMessage: string;
  archives: ShipmentGroupArchive[];
  aftersalesCases: AftersalesCase[];
  focus: ShipmentFocus | null;
  onContinueShipment: (
    archiveId: string,
    group: OpenShipmentGroup,
    recipientDifferences: ShipmentGroupArchive['recipientDifferences'],
  ) => void;
  onOpenOrder: (orderId: string) => void;
  onCancelPackage: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onCorrectLogistics: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onUpdateLogisticsStatus: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onProgressLogisticsException: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onProgressCarrierClaim: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onCreateAftersales: (record: ShipmentRecord) => void;
  onUpdateAftersales: (record: ShipmentRecord, aftersalesCase: AftersalesCase) => void;
  onProgressAftersales: (input: ProgressAftersalesCaseInput) => Promise<void>;
  onRecordStepEvent: (input: RecordAftersalesWorkflowStepEventInput) => Promise<void>;
  onChangeAftersalesWorkflow: (
    input: ChangeAftersalesCaseWorkflowTemplateInput,
  ) => Promise<void>;
}) {
  const [logisticsFilter, setLogisticsFilter] = useState<'all' | ShipmentLogisticsStatus>('all');
  const visibleArchives = logisticsFilter === 'all'
    ? archives
    : archives.filter((archive) => archive.records.some((record) => (
      record.packages.some((shipmentPackage) => (
        shipmentPackage.status === 'active' &&
        shipmentPackage.logisticsStatus === logisticsFilter
      ))
    )));
  return (
    <section
      className="shipment-groups-section shipment-archive-section"
      aria-label={label}
    >
      {archives.length > 0 && (
        <div className="shipment-archive-filters">
          <label>
            <span>物流状态</span>
            <select
              aria-label="物流状态筛选"
              value={logisticsFilter}
              onChange={(event) => setLogisticsFilter(
                event.target.value as 'all' | ShipmentLogisticsStatus,
              )}
            >
              <option value="all">全部物流状态</option>
              {SHIPMENT_LOGISTICS_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <span>{visibleArchives.length} / {archives.length} 个发货组档案</span>
        </div>
      )}
      {visibleArchives.length === 0 ? (
        <div className="shipment-records-empty">{emptyMessage}</div>
      ) : (
        <div className="shipment-archive-list">
          {visibleArchives.map((archive) => {
            const currentGroup = archive.remainingGroup;
            const shippedItems = [...archive.records
              .flatMap((record) => record.packages)
              .filter((shipmentPackage) => shipmentPackage.status === 'active')
              .flatMap((shipmentPackage) => shipmentPackage.items)
              .reduce((summary, item) => {
                const key = `${item.sourceTitle}\u0000${item.sourceSpec}`;
                const current = summary.get(key);
                summary.set(key, {
                  sourceTitle: item.sourceTitle,
                  sourceSpec: item.sourceSpec,
                  quantity: (current?.quantity ?? 0) + item.quantity,
                });
                return summary;
              }, new Map<string, { sourceTitle: string; sourceSpec: string; quantity: number }>())
              .values()];
            const progress = archive.totalQuantity === 0
              ? 0
              : Math.round((archive.shippedQuantity / archive.totalQuantity) * 100);
            const operationsCoordination = shipmentRecordsCoordination(
              archive.records,
              aftersalesCases,
            );
            return (
              <article
                key={archive.id}
                className="shipment-archive-card"
                aria-label={`发货组档案 ${archive.orderNumbers.join('、')}`}
              >
                <header>
                  <div>
                    <span className="shipment-archive-card__state">
                      {archive.status === 'partially_shipped' ? '部分发货' : '已全部发货'}
                    </span>
                    <strong>{archive.recipient} · {archive.phone}</strong>
                    <small>{archive.addressOriginal}</small>
                  </div>
                  {currentGroup && (
                    <button
                      className="button button--primary"
                      type="button"
                      onClick={() => onContinueShipment(
                        archive.id,
                        currentGroup,
                        archive.recipientDifferences,
                      )}
                    >
                      继续发货
                    </button>
                  )}
                </header>
                <div className="shipment-archive-card__progress">
                  <div>
                    <strong>已发 {archive.shippedQuantity} / 共 {archive.totalQuantity} 件</strong>
                    <span>{archive.remainingQuantity > 0
                      ? `剩余 ${archive.remainingQuantity} 件待发`
                      : '本组商品已全部发出'}</span>
                  </div>
                  <span aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>
                </div>
                <div className="shipment-archive-card__orders" aria-label="关联订单">
                  {archive.memberOrders.map((member) => (
                      <button
                        key={member.orderId}
                        className="order-link"
                        type="button"
                        aria-label={`查看原始订单 ${member.orderNumber}`}
                        onClick={() => onOpenOrder(member.orderId)}
                      >
                        {member.orderNumber}
                        {!member.hasRemainingShipment && archive.status === 'partially_shipped'
                          ? '（当前不可继续发货）'
                          : ''}
                      </button>
                  ))}
                </div>
                {archive.recipientDifferences.length > 0 && (
                  <div className="shipment-archive-recipient-warning" role="status">
                    <strong>成员订单的当前收货信息已有变化</strong>
                    <span>继续发货仍使用本档案保存的收货信息。</span>
                  </div>
                )}
                <div className="shipment-archive-card__products" aria-label="商品与数量">
                  {shippedItems.map((item) => (
                    <span key={`shipped-${item.sourceTitle}\u0000${item.sourceSpec}`}>
                      <strong>{item.sourceTitle}</strong>
                      <small>{item.sourceSpec ? `${item.sourceSpec} · ` : ''}已发 × {item.quantity}</small>
                    </span>
                  ))}
                  {currentGroup?.items.map((item) => (
                    <span key={`remaining-${item.title}\u0000${item.specification}`}>
                      <strong>{item.title}</strong>
                      <small>{item.specification ? `${item.specification} · ` : ''}待发 × {item.quantity}</small>
                    </span>
                  ))}
                </div>
                <details
                  className="shipment-archive-card__records"
                  {...(archive.records.some(({ id }) => id === focus?.recordId)
                    ? { open: true }
                    : {})}
                >
                  <summary role="button" aria-label={`查看 ${archive.records.length} 条发货记录`}>
                    <span>查看 {archive.records.length} 条发货记录</span>
                    <span className="shipment-archive-card__record-overview">
                      <span><strong>物流：</strong>{shipmentRecordsLogisticsSummary(archive.records)}</span>
                      <span><strong>售后：</strong>{shipmentRecordsAftersalesSummary(
                        archive.records,
                        aftersalesCases,
                      )}</span>
                      <span><strong>当前待办：</strong>{
                        operationsCoordination.primaryTodo?.title
                          ?? shipmentRecordsCurrentAction(archive.records, aftersalesCases)
                      }</span>
                    </span>
                  </summary>
                  {operationsCoordination.secondaryTodoCount > 0 && (
                    <details className="order-coordination-secondary shipment-records-secondary-todos">
                      <summary>另有 {operationsCoordination.secondaryTodoCount} 项</summary>
                      <ul>
                        {operationsCoordination.todos.slice(1).map((todo) => (
                          <li key={todo.id}>
                            <strong>{todo.title}</strong>
                            <small>{todo.detail}</small>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <ShipmentRecordsSection
                    api={api}
                    embedded
                    records={archive.records}
                    aftersalesCases={aftersalesCases}
                    focus={focus}
                    onCancelPackage={onCancelPackage}
                    onCorrectLogistics={onCorrectLogistics}
                    onUpdateLogisticsStatus={onUpdateLogisticsStatus}
                    onProgressLogisticsException={onProgressLogisticsException}
                    onProgressCarrierClaim={onProgressCarrierClaim}
                    onCreateAftersales={onCreateAftersales}
                    onUpdateAftersales={onUpdateAftersales}
                    onProgressAftersales={onProgressAftersales}
                    onRecordStepEvent={onRecordStepEvent}
                    onChangeAftersalesWorkflow={onChangeAftersalesWorkflow}
                  />
                </details>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ShipmentRecordsSection({
  api,
  records,
  aftersalesCases,
  focus,
  onCancelPackage,
  onCorrectLogistics,
  onUpdateLogisticsStatus,
  onProgressLogisticsException,
  onProgressCarrierClaim,
  onCreateAftersales,
  onUpdateAftersales,
  onProgressAftersales,
  onRecordStepEvent,
  onChangeAftersalesWorkflow,
  embedded = false,
}: {
  api: DesktopApi;
  records: ShipmentRecord[];
  aftersalesCases: AftersalesCase[];
  focus?: ShipmentFocus | null;
  onCancelPackage: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onCorrectLogistics: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onUpdateLogisticsStatus: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onProgressLogisticsException: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onProgressCarrierClaim: (
    record: ShipmentRecord,
    shipmentPackage: ShipmentRecord['packages'][number],
    packageIndex: number,
  ) => void;
  onCreateAftersales: (record: ShipmentRecord) => void;
  onUpdateAftersales: (record: ShipmentRecord, aftersalesCase: AftersalesCase) => void;
  onProgressAftersales: (input: ProgressAftersalesCaseInput) => Promise<void>;
  onRecordStepEvent: (input: RecordAftersalesWorkflowStepEventInput) => Promise<void>;
  onChangeAftersalesWorkflow: (
    input: ChangeAftersalesCaseWorkflowTemplateInput,
  ) => Promise<void>;
  embedded?: boolean;
}) {
  const content = records.length === 0 ? (
    <div className="shipment-records-empty">尚无发货记录</div>
  ) : (
    <div className="shipment-records-list">
      {records.map((record) => {
        const recordAftersalesCases = aftersalesCasesForShipmentRecords([record], aftersalesCases);
        const hasActiveParentAftersales = hasActiveParentAftersalesCase(record, aftersalesCases);
        const operationsCoordination = shipmentRecordsCoordination([record], aftersalesCases);
        return (
        <article
          id={`shipment-record-${record.id}`}
          key={record.id}
          className={`shipment-record-card${focus?.recordId === record.id ? ' is-focused' : ''}`}
          aria-label={`发货记录 ${record.id}`}
          tabIndex={-1}
        >
          <header>
            <div>
              <strong>{record.recipient} · {record.phone}</strong>
              <small>{record.addressOriginal}</small>
            </div>
            <span>{record.status === 'voided' ? '已作废' : `共 ${record.totalQuantity} 件`}</span>
          </header>
          <div className="shipment-record-card__status-summary">
            <span><strong>物流：</strong>{shipmentRecordLogisticsSummary(record)}</span>
            <span><strong>售后：</strong>{shipmentRecordAftersalesSummary(
              record,
              aftersalesCases,
            )}</span>
            <span><strong>当前待办：</strong>{
              operationsCoordination.primaryTodo?.title
                ?? shipmentRecordCurrentAction(record, aftersalesCases)
            }</span>
          </div>
          {record.sourceOrders.length > 0 && (
            <p className="shipment-record-card__source-orders">
              来源订单：{record.sourceOrders.map((source) => (
                `${source.systemOrderNumber} ${source.readableOrderNumber ?? '—'}`
              )).join('；')}
            </p>
          )}
          {operationsCoordination.secondaryTodoCount > 0 && (
            <details className="order-coordination-secondary shipment-records-secondary-todos">
              <summary>另有 {operationsCoordination.secondaryTodoCount} 项</summary>
              <ul>
                {operationsCoordination.todos.slice(1).map((todo) => (
                  <li key={todo.id}>
                    <strong>{todo.title}</strong>
                    <small>{todo.detail}</small>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {record.status === 'active' && !hasActiveParentAftersales && (
            <div className="shipment-record-card__aftersales-actions">
              <button
                className="button button--quiet"
                type="button"
                onClick={() => onCreateAftersales(record)}
              >
                建立售后处理单
              </button>
            </div>
          )}
          {record.sourceDifferences.length > 0 && (
            <details className="shipment-record-card__differences" open>
              <summary>来源订单已有 {record.sourceDifferences.length} 项变化</summary>
              <dl>
                {record.sourceDifferences.map((difference, index) => (
                  <div key={`${difference.orderId}-${difference.orderItemId ?? 'order'}-${difference.field}-${index}`}>
                    <dt>{shipmentSourceDifferenceFieldLabel(difference.field)}</dt>
                    <dd>
                      {shipmentSourceDifferenceValue(difference.snapshotValue)}
                      {' → '}
                      {shipmentSourceDifferenceValue(difference.currentValue)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          <div className="shipment-record-card__packages">
            {record.packages.map((shipmentPackage, packageIndex) => (
              <section key={shipmentPackage.id}>
                <div>
                  <strong>包裹 {packageIndex + 1}</strong>
                  <span>{shipmentPackage.status === 'cancelled'
                    ? '已撤销'
                    : shipmentLogisticsStatusLabel(shipmentPackage.logisticsStatus)}</span>
                </div>
                <p>
                  {[shipmentPackage.shippingCarrier, shipmentPackage.trackingNumber]
                    .filter(Boolean).join(' · ') || '未填写物流信息'}
                </p>
                <ul>
                  {shipmentPackage.items.map((item) => (
                    <li key={item.id}>
                      <span>{item.orderNumber} · {item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</span>
                      <strong>× {item.quantity}</strong>
                    </li>
                  ))}
                </ul>
                {shipmentPackage.logisticsExceptions
                  .filter(({ stage }) => isUnresolvedLogisticsExceptionStage(stage))
                  .map((exception) => (
                    <div className="shipment-package-exception" role="status" key={exception.id}>
                      <strong>正向物流异常 · {logisticsExceptionTypeLabel(
                        exception.exceptionType,
                      )} · {logisticsExceptionStageLabel(exception.stage)}</strong>
                      <span>{exception.impact.scope === 'package'
                        ? `影响整个包裹（${shipmentPackage.totalQuantity} 件）`
                        : `影响 ${exception.impact.items.reduce(
                          (total, item) => total + item.quantity,
                          0,
                        )} 件指定商品`}</span>
                      <ul aria-label="正向物流异常受影响商品">
                        {shipmentExceptionAffectedItems(shipmentPackage, exception).map((item) => (
                          <li key={item.id}>
                            <span>{item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</span>
                            <strong>× {item.quantity}</strong>
                          </li>
                        ))}
                      </ul>
                      <small>{exception.reason}</small>
                      <button
                        className="button button--quiet"
                        type="button"
                        aria-label={`推进物流异常 ${logisticsExceptionTypeLabel(exception.exceptionType)}`}
                        onClick={() => onProgressLogisticsException(
                          record,
                          {
                            ...shipmentPackage,
                            currentException: { ...exception, direction: 'outbound' as const },
                          },
                          packageIndex,
                        )}
                      >
                        推进此异常
                      </button>
                    </div>
                  ))}
                {shipmentPackage.carrierClaim && (
                  <div className="shipment-package-exception" role="status">
                    <strong>承运索赔</strong>
                    <span>{carrierClaimStatusLabel(shipmentPackage.carrierClaim.status)}</span>
                    <small>{shipmentPackage.carrierClaim.reason}</small>
                  </div>
                )}
                {shipmentPackage.status === 'active' && (
                  <footer>
                    {(shipmentPackage.logisticsStatus === 'awaiting_carrier'
                      || shipmentPackage.logisticsStatus === 'in_transit') && (
                      <button
                        className="button button--quiet"
                        type="button"
                        aria-label={`更新物流状态 包裹 ${packageIndex + 1} ${shipmentLogisticsStatusLabel(shipmentPackage.logisticsStatus)}`}
                        onClick={() => onUpdateLogisticsStatus(record, shipmentPackage, packageIndex)}
                      >
                        更新状态
                      </button>
                    )}
                    {(shipmentPackage.currentException
                      || shipmentPackage.logisticsStatus !== 'returned') && (
                      <button
                        className="button button--quiet"
                        type="button"
                        onClick={() => onProgressLogisticsException(
                          record,
                          shipmentPackage,
                          packageIndex,
                        )}
                      >
                        {shipmentPackage.currentException ? '推进物流异常' : '登记物流异常'}
                      </button>
                    )}
                    <button
                      className="button button--quiet"
                      type="button"
                      aria-label={`更正物流 包裹 ${packageIndex + 1} ${shipmentPackage.trackingNumber || '未填写运单号'}`}
                      onClick={() => onCorrectLogistics(record, shipmentPackage, packageIndex)}
                    >
                      更正物流
                    </button>
                    {shipmentPackage.logisticsStatus === 'delivered' && (
                      <small>物流状态已终结；签收争议、错投或承运破损可单独登记，物流信息有误请更正</small>
                    )}
                    {shipmentPackage.logisticsStatus === 'returned' && (
                      <small>包裹已退回；承运方或运单号有误时请使用“更正物流”</small>
                    )}
                    {((shipmentPackage.currentException?.stage === 'confirmed'
                      && !shipmentPackage.carrierClaim)
                      || shipmentPackage.carrierClaim?.status === 'pending'
                      || shipmentPackage.carrierClaim?.status === 'approved') && (
                      <button
                        className="button button--quiet"
                        type="button"
                        onClick={() => onProgressCarrierClaim(
                          record,
                          shipmentPackage,
                          packageIndex,
                        )}
                      >
                        {!shipmentPackage.carrierClaim
                          ? '建立承运索赔'
                          : shipmentPackage.carrierClaim.status === 'pending'
                            ? '登记索赔结果'
                            : '确认承运赔付'}
                      </button>
                    )}
                    {shipmentPackage.carrierAcceptedAt === null
                      && shipmentPackage.logisticsStatus !== 'delivered'
                      && shipmentPackage.logisticsStatus !== 'returned' && (
                      <button
                        className="button button--quiet"
                        type="button"
                        aria-label={`撤销未交寄包裹 包裹 ${packageIndex + 1} ${shipmentPackage.trackingNumber || '未填写运单号'}`}
                        onClick={() => onCancelPackage(record, shipmentPackage, packageIndex)}
                      >
                        撤销未交寄包裹
                      </button>
                    )}
                  </footer>
                )}
                {shipmentPackage.logisticsExceptions.length > 0 && (
                  <details className="shipment-record-card__timeline">
                    <summary>正向物流异常完整历史</summary>
                    <ol>
                      {shipmentPackage.logisticsExceptions.flatMap((exception) => (
                        exception.timeline.map((event) => (
                          <li key={`${exception.id}-${event.resultRevision}`}>
                            <strong>{logisticsExceptionTypeLabel(exception.exceptionType)}</strong>
                            <span>{shipmentExceptionEventDescription(event)}</span>
                            <small>{formatDateTime(event.occurredAt)}</small>
                          </li>
                        ))
                      ))}
                    </ol>
                  </details>
                )}
                {shipmentPackage.carrierClaim && (
                  <details className="shipment-record-card__timeline">
                    <summary>正向承运索赔完整历史</summary>
                    <ol>
                      {shipmentPackage.carrierClaim.timeline.map((event) => (
                        <li key={`${event.kind}-${event.resultRevision}`}>
                          <strong>{shipmentClaimEventLabel(event.kind)}</strong>
                          <span>{shipmentClaimEventDescription(event)}</span>
                          <small>{formatDateTime(event.occurredAt)}</small>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {shipmentPackage.timeline.length > 0 && (
                  <details className="shipment-record-card__timeline">
                    <summary>物流时间线</summary>
                    <ol>
                      {shipmentPackage.timeline.map((change) => (
                        <li key={`${change.kind}-${change.resultRevision}`}>
                          <strong>{change.kind === 'status_changed'
                            ? `${shipmentLogisticsStatusLabel(change.beforeStatus)} → ${shipmentLogisticsStatusLabel(change.afterStatus)}`
                            : `${shipmentPackageLogisticsLabel(change.before)} → ${shipmentPackageLogisticsLabel(change.after)}`}</strong>
                          <span>{change.reason}</span>
                          <small>{formatDateTime(change.createdAt)}</small>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </section>
            ))}
          </div>
          <AftersalesCasePanel
            api={api}
            record={record}
            aftersalesCases={recordAftersalesCases}
            focusedCaseId={focus?.recordId === record.id ? focus.aftersalesCaseId : undefined}
            onUpdate={(aftersalesCase) => onUpdateAftersales(record, aftersalesCase)}
            onProgress={onProgressAftersales}
            onRecordStepEvent={onRecordStepEvent}
            onChangeWorkflow={onChangeAftersalesWorkflow}
          />
        </article>
        );
      })}
    </div>
  );
  if (embedded) {
    return <div className="shipment-records-embedded" role="region" aria-label="发货记录">{content}</div>;
  }
  return (
    <section
      className="shipment-groups-section shipment-records-section"
      aria-labelledby="shipment-records-title"
      aria-label="发货记录"
    >
      <div className="shipment-groups-section__heading">
        <div>
          <h2 id="shipment-records-title">发货记录</h2>
          <p>实际发出后形成独立记录；包裹与订单商品、数量始终可以相互追溯。</p>
        </div>
        <span>{records.length} 条记录</span>
      </div>
      {content}
    </section>
  );
}

function shipmentSourceDifferenceFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    orderNumber: '订单号',
    sellerAccount: '卖家账号',
    buyerNickname: '买家昵称',
    recipient: '收件人',
    phone: '手机号',
    addressOriginal: '收货地址',
    amountCents: '成交金额',
    sourceTitle: '商品',
    sourceSpec: '款式或规格',
    unitPriceCents: '商品单价',
    quantity: '商品数量',
  };
  return labels[field] ?? field;
}

function shipmentSourceDifferenceValue(value: string | number | null): string {
  return value === null || value === '' ? '未填写' : String(value);
}

const SHIPMENT_LOGISTICS_STATUS_OPTIONS: ReadonlyArray<{
  value: ShipmentLogisticsStatus;
  label: string;
}> = SHIPMENT_LOGISTICS_STATUSES.map((value) => ({
  value,
  label: shipmentLogisticsStatusLabel(value),
}));

function activeShipmentLogisticsStatuses(records: readonly ShipmentRecord[]): ShipmentLogisticsStatus[] {
  return records.flatMap((record) => record.packages
    .filter(({ status }) => status === 'active')
    .map(({ logisticsStatus }) => logisticsStatus));
}

function shipmentRecordsLogisticsSummary(records: readonly ShipmentRecord[]): string {
  const statuses = activeShipmentLogisticsStatuses(records);
  if (statuses.length === 0) return '无有效包裹';
  const counts = statuses.reduce((summary, status) => {
    summary.set(status, (summary.get(status) ?? 0) + 1);
    return summary;
  }, new Map<ShipmentLogisticsStatus, number>());
  return [...counts].map(([status, count]) => (
    statuses.length === 1
      ? shipmentLogisticsStatusLabel(status)
      : `${shipmentLogisticsStatusLabel(status)} ${count}`
  )).join('、');
}

function shipmentRecordLogisticsSummary(record: ShipmentRecord): string {
  return shipmentRecordsLogisticsSummary([record]);
}

function shipmentRecordsCurrentAction(
  records: readonly ShipmentRecord[],
  cases: readonly AftersalesCase[],
): string {
  const coordination = shipmentRecordsCoordination(records, cases);
  const statuses = new Set(activeShipmentLogisticsStatuses(records));
  const carrierClaimStatuses = new Set(records
    .filter(({ status }) => status === 'active')
    .flatMap(({ packages }) => packages)
    .filter(({ status }) => status === 'active')
    .flatMap(({ carrierClaim }) => carrierClaim ? [carrierClaim.status] : []));
  return coordination.primaryTodo?.title
    ?? shipmentTodoForStatuses(statuses, carrierClaimStatuses, false);
}

function shipmentRecordsCoordination(
  records: readonly ShipmentRecord[],
  cases: readonly AftersalesCase[],
) {
  const candidates = aftersalesCasesForShipmentRecords(
    records,
    cases,
  ).flatMap((aftersalesCase) => (
    aftersalesCaseOperationsCoordination(aftersalesCase).todos
  ));
  candidates.push(...shipmentOrderOperationCandidates(
    records.map(shipmentRecordForOperationsCoordination),
  ));
  return coordinateOrderOperations(candidates);
}

function shipmentRecordForOperationsCoordination(
  record: ShipmentRecord,
): OrderOperationsShipmentRecord {
  return {
    id: record.id,
    archiveId: record.archiveId,
    sourceRole: record.sourceRecordRole === 'aftersales_replacement'
      ? 'replacement'
      : 'initial',
    replacementAftersalesCaseId: null,
    status: record.status,
    createdAt: record.createdAt,
    packages: record.packages.map((shipmentPackage) => {
      const affectedItems = (impact: typeof shipmentPackage.logisticsExceptions[number]['impact']) => (
        impact.scope === 'package'
          ? shipmentPackage.items.map((item) => ({
            sourceTitle: item.sourceTitle,
            sourceSpec: item.sourceSpec,
            quantity: item.quantity,
          }))
          : impact.items.flatMap((affectedItem) => {
            const source = shipmentPackage.items.find(({ id }) => id === affectedItem.sourceItemId);
            return source ? [{
              sourceTitle: source.sourceTitle,
              sourceSpec: source.sourceSpec,
              quantity: affectedItem.quantity,
            }] : [];
          })
      );
      const occurrenceValues = [
        record.createdAt,
        ...shipmentPackage.timeline.map(({ occurredAt }) => occurredAt),
        ...shipmentPackage.logisticsExceptions.map(({ occurredAt }) => occurredAt),
        ...(shipmentPackage.carrierClaim ? [shipmentPackage.carrierClaim.updatedAt] : []),
      ];
      const updatedAt = occurrenceValues.reduce((latest, occurrence) => (
        Date.parse(occurrence) > Date.parse(latest) ? occurrence : latest
      ));
      const claimAffectedItems = shipmentPackage.carrierClaim
        ? affectedItems(shipmentPackage.carrierClaim.impact)
        : undefined;
      return {
        id: shipmentPackage.id,
        position: shipmentPackage.position,
        status: shipmentPackage.status,
        logisticsStatus: shipmentPackage.logisticsStatus,
        updatedAt,
        shippingCarrier: shipmentPackage.shippingCarrier,
        trackingNumber: shipmentPackage.trackingNumber,
        cancellationReason: null,
        currentException: null,
        logisticsExceptions: shipmentPackage.logisticsExceptions.map((exception) => ({
          id: exception.id,
          direction: 'outbound' as const,
          exceptionType: exception.exceptionType,
          stage: exception.stage,
          affectedQuantity: affectedItems(exception.impact).reduce(
            (total, item) => total + item.quantity,
            0,
          ),
          affectedItems: affectedItems(exception.impact),
          reason: exception.reason,
          occurredAt: exception.occurredAt,
        })),
        carrierClaimStatus: shipmentPackage.carrierClaim?.status ?? null,
        carrierClaimUpdatedAt: shipmentPackage.carrierClaim?.updatedAt ?? null,
        ...(claimAffectedItems ? {
          carrierClaimAffectedItems: claimAffectedItems,
          carrierClaimAffectedQuantity: claimAffectedItems.reduce(
            (total, item) => total + item.quantity,
            0,
          ),
        } : {}),
        items: shipmentPackage.items.map((item) => ({
          shipmentPackageItemId: item.id,
          orderItemId: item.orderItemId,
          sourceTitle: item.sourceTitle,
          sourceSpec: item.sourceSpec,
          quantity: item.quantity,
        })),
      };
    }),
  };
}

function shipmentRecordCurrentAction(
  record: ShipmentRecord,
  cases: readonly AftersalesCase[],
): string {
  return shipmentRecordsCurrentAction([record], cases);
}

function shipmentPackageLogisticsLabel(logistics: {
  shippingCarrier: string;
  trackingNumber: string;
}): string {
  return [logistics.shippingCarrier, logistics.trackingNumber]
    .filter(Boolean).join(' · ') || '未填写物流信息';
}

function UpdateShipmentPackageLogisticsStatusDialog({
  api,
  target,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  target: {
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  };
  onApplied: (result: ShipmentConfirmationResult) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [logisticsStatus, setLogisticsStatus] = useState<ShipmentLogisticsStatus>(
    target.shipmentPackage.logisticsStatus,
  );
  const [reason, setReason] = useState('');
  const [carrierAcceptanceConfirmed, setCarrierAcceptanceConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changed = logisticsStatus !== target.shipmentPackage.logisticsStatus
    || carrierAcceptanceConfirmed;

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      saving || !changed || !reason.trim()
    ) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.updateShipmentPackageLogisticsStatus({
        recordId: target.record.id,
        packageId: target.shipmentPackage.id,
        expectedRevision: target.shipmentPackage.revision,
        logisticsStatus,
        ...(carrierAcceptanceConfirmed ? { carrierAcceptanceConfirmed: true } : {}),
        occurredAt: new Date().toISOString(),
        reason,
      });
      onApplied(result);
    } catch (reasonValue) {
      setError(errorMessage(reasonValue));
    } finally {
      setSaving(false);
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
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-package-action-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">发货记录 · 包裹 {target.packageIndex + 1}</span>
          <h2 id={headingId}>更新包裹物流状态</h2>
          <p id={descriptionId}>只记录运输进展；不会改写发货快照、订单履约状态或售后状态。</p>
        </header>
        <label>
          <span>物流状态</span>
          <select
            aria-label="物流状态"
            value={logisticsStatus}
            disabled={saving}
            onChange={(event) => setLogisticsStatus(event.target.value as ShipmentLogisticsStatus)}
          >
            {SHIPMENT_LOGISTICS_STATUS_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={(option.value === 'awaiting_carrier'
                  && target.shipmentPackage.carrierAcceptedAt !== null)
                  || ((target.shipmentPackage.logisticsStatus === 'delivered'
                    || target.shipmentPackage.logisticsStatus === 'returned')
                    && (option.value === 'awaiting_carrier' || option.value === 'in_transit'))}
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {!target.shipmentPackage.carrierAcceptedAt && logisticsStatus !== 'awaiting_carrier' && (
          <label className="shipment-package-action-dialog__check">
            <input
              type="checkbox"
              checked={carrierAcceptanceConfirmed}
              disabled={saving}
              onChange={(event) => setCarrierAcceptanceConfirmed(event.target.checked)}
            />
            <span>我已核对承运方揽收证据</span>
          </label>
        )}
        <label>
          <span>状态更新原因</span>
          <textarea
            aria-label="状态更新原因"
            value={reason}
            maxLength={500}
            disabled={saving}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
        <footer>
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={saving || !changed || !reason.trim()}
          >
            {saving ? '正在更新…' : '确认更新'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function ShipmentPackageLogisticsExceptionDialog({
  api,
  target,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  target: {
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  };
  onApplied: (result: ShipmentConfirmationResult) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const current = target.shipmentPackage.currentException;
  const exceptionTypeOptions = target.shipmentPackage.logisticsStatus === 'delivered'
    ? LOGISTICS_EXCEPTION_TYPE_OPTIONS.filter(({ value }) => (
      value === 'delivery_dispute' || value === 'misdelivered' || value === 'damaged'
    ))
    : LOGISTICS_EXCEPTION_TYPE_OPTIONS;
  const [exceptionType, setExceptionType] = useState<
    'lost' | 'delivery_dispute' | 'damaged' | 'misdelivered' | 'other'
  >(current?.exceptionType ?? (target.shipmentPackage.logisticsStatus === 'delivered'
    ? 'delivery_dispute'
    : 'lost'));
  const stageOptions = current
    ? nextLogisticsExceptionStages(current.exceptionType, current.stage)
    : ['pending_verification', 'investigating', 'confirmed'] as const;
  const [stage, setStage] = useState<
    'pending_verification' | 'investigating' | 'confirmed' | 'recovered' | 'resolved'
  >(stageOptions[0]);
  const [impactScope, setImpactScope] = useState<'package' | 'items'>('package');
  const [affectedQuantities, setAffectedQuantities] = useState<Record<string, number>>({});
  const [carrierConfirmedLoss, setCarrierConfirmedLoss] = useState(false);
  const [occurredAt, setOccurredAt] = useState(
    new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 19),
  );
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const affectedItems = target.shipmentPackage.items.flatMap((item) => {
    const quantity = affectedQuantities[item.id] ?? 0;
    return quantity > 0 ? [{ sourceItemId: item.id, quantity }] : [];
  });
  const normalizedOccurredAt = normalizeShanghaiDateTime(occurredAt.replace('T', ' '));
  const needsLossConfirmation = exceptionType === 'lost' && stage === 'confirmed';
  const canSubmit = Boolean(
    reason.trim()
      && normalizedOccurredAt
      && (!needsLossConfirmation || carrierConfirmedLoss)
      && (current || impactScope === 'package' || affectedItems.length > 0),
  );

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !canSubmit || !normalizedOccurredAt) return;
    setSaving(true);
    setError('');
    try {
      const result = current
        ? await api.progressShipmentPackageLogisticsException({
          recordId: target.record.id,
          packageId: target.shipmentPackage.id,
          exceptionId: current.id,
          expectedExceptionRevision: current.revision,
          stage: stage as 'investigating' | 'confirmed' | 'recovered' | 'resolved',
          ...(needsLossConfirmation ? { carrierConfirmedLoss: true } : {}),
          occurredAt: normalizedOccurredAt,
          reason,
        })
        : await api.recordShipmentPackageLogisticsException({
          recordId: target.record.id,
          packageId: target.shipmentPackage.id,
          expectedRevision: target.shipmentPackage.revision,
          exceptionType,
          stage: stage as 'pending_verification' | 'investigating' | 'confirmed',
          impact: impactScope === 'package'
            ? { scope: 'package' }
            : { scope: 'items', items: affectedItems },
          ...(needsLossConfirmation ? { carrierConfirmedLoss: true } : {}),
          occurredAt: normalizedOccurredAt,
          reason,
        });
      onApplied(result);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div ref={dialogRef} className="order-export-backdrop" role="dialog" aria-modal="true"
      aria-labelledby={headingId} tabIndex={-1}>
      <form className="shipment-package-action-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">发货记录 · 包裹 {target.packageIndex + 1}</span>
          <h2 id={headingId}>{current ? '推进正向物流异常' : '登记正向物流异常'}</h2>
          <p>异常事项与正常运输事实分别保存，不会自动生成退款、补发或责任结论。</p>
        </header>
        {!current && (
          <label>
            <span>异常类型</span>
            <select aria-label="异常类型" value={exceptionType} disabled={saving}
              onChange={(event) => setExceptionType(event.target.value as typeof exceptionType)}>
              {exceptionTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>异常处理阶段</span>
          <select aria-label="异常处理阶段" value={stage} disabled={saving}
            onChange={(event) => setStage(event.target.value as typeof stage)}>
            {stageOptions.map((value) => (
              <option key={value} value={value}>{logisticsExceptionStageLabel(value)}</option>
            ))}
          </select>
        </label>
        {!current && (
          <fieldset className="shipment-package-impact">
            <legend>异常影响范围</legend>
            <label><input type="radio" name="outbound-exception-impact"
              checked={impactScope === 'package'} onChange={() => setImpactScope('package')} />
              <span>整个包裹</span></label>
            <label><input type="radio" name="outbound-exception-impact"
              checked={impactScope === 'items'} onChange={() => setImpactScope('items')} />
              <span>指定商品与数量</span></label>
            {impactScope === 'items' && target.shipmentPackage.items.map((item) => (
              <label key={item.id}>
                <span>{item.sourceTitle}</span>
                <input type="number" min={0} max={item.quantity} step={1}
                  aria-label={`受影响数量 ${item.sourceTitle}`}
                  value={affectedQuantities[item.id] ?? 0}
                  onChange={(event) => setAffectedQuantities((values) => ({
                    ...values, [item.id]: Number(event.target.value),
                  }))} />
              </label>
            ))}
          </fieldset>
        )}
        {needsLossConfirmation && (
          <label className="shipment-package-action-dialog__check">
            <input type="checkbox" checked={carrierConfirmedLoss}
              onChange={(event) => setCarrierConfirmedLoss(event.target.checked)} />
            <span>我已核对承运方的丢件结论</span>
          </label>
        )}
        <label><span>发生时间</span><input type="datetime-local" step={1}
          aria-label="异常发生时间" value={occurredAt}
          onChange={(event) => setOccurredAt(event.target.value)} /></label>
        <label><span>说明</span><textarea aria-label="异常说明" value={reason}
          maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
        {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
        <footer>
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>取消</button>
          <button className="button button--primary" type="submit" disabled={saving || !canSubmit}>
            {saving ? '正在保存…' : '确认保存'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function ShipmentPackageCarrierClaimDialog({
  api,
  target,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  target: {
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  };
  onApplied: (result: ShipmentConfirmationResult) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const claim = target.shipmentPackage.carrierClaim;
  const mode = !claim ? 'open' : claim.status === 'pending'
    ? 'resolve'
    : claim.status === 'approved' ? 'confirm_compensation' : null;
  const [outcome, setOutcome] = useState<'approved' | 'rejected'>('approved');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  if (!mode) return null;
  const amountCents = Math.round(Number(amount) * 100);
  const amountRequired = mode !== 'resolve' || outcome === 'approved';
  const validAmount = !amountRequired
    || (Number.isSafeInteger(amountCents) && amountCents > 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !reason.trim() || !validAmount || !mode) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.progressShipmentPackageCarrierClaim(mode === 'open' ? {
        kind: 'open',
        recordId: target.record.id,
        packageId: target.shipmentPackage.id,
        expectedRevision: target.shipmentPackage.revision,
        requestedAmountCents: amountCents,
        occurredAt: new Date().toISOString(),
        reason,
      } : mode === 'resolve' ? {
        kind: 'resolve',
        recordId: target.record.id,
        packageId: target.shipmentPackage.id,
        expectedClaimRevision: claim?.revision ?? 0,
        outcome,
        ...(outcome === 'approved' ? { approvedAmountCents: amountCents } : {}),
        occurredAt: new Date().toISOString(),
        reason,
      } : {
        kind: 'confirm_compensation',
        recordId: target.record.id,
        packageId: target.shipmentPackage.id,
        expectedClaimRevision: claim?.revision ?? 0,
        amountCents,
        occurredAt: new Date().toISOString(),
        note: reason,
      });
      onApplied(result);
    } catch (reasonValue) {
      setError(errorMessage(reasonValue));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="order-export-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-package-action-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">发货记录 · 包裹 {target.packageIndex + 1}</span>
          <h2 id={headingId}>{mode === 'open'
            ? '建立承运索赔'
            : mode === 'resolve' ? '登记索赔结果' : '确认承运赔付'}</h2>
          <p>只保存承运方索赔与赔付事实；不会自动退款、补发或改写库存。</p>
        </header>
        {mode === 'resolve' && (
          <label>
            <span>索赔结果</span>
            <select
              aria-label="索赔结果"
              value={outcome}
              disabled={saving}
              onChange={(event) => setOutcome(event.target.value as 'approved' | 'rejected')}
            >
              <option value="approved">同意赔付</option>
              <option value="rejected">拒绝赔付</option>
            </select>
          </label>
        )}
        {amountRequired && (
          <label>
            <span>{mode === 'open' ? '申请索赔金额（元）'
              : mode === 'resolve' ? '同意赔付金额（元）' : '实际赔付金额（元）'}</span>
            <input
              aria-label="承运索赔金额"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              disabled={saving}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
        )}
        <label>
          <span>{mode === 'confirm_compensation' ? '实际赔付说明' : '索赔说明'}</span>
          <textarea
            aria-label="承运索赔说明"
            value={reason}
            maxLength={500}
            disabled={saving}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
        <footer>
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={saving || !reason.trim() || !validAmount}
          >
            {saving ? '正在保存…' : '确认保存'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function CancelShipmentPackageDialog({
  api,
  target,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  target: {
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  };
  onApplied: (result: ShipmentConfirmationResult) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const [confirmedUnhanded, setConfirmedUnhanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !reason.trim() || !confirmedUnhanded) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.cancelShipmentPackages({
        recordId: target.record.id,
        packageIds: [target.shipmentPackage.id],
        reason,
      });
      onApplied(result);
    } catch (reasonValue) {
      setError(errorMessage(reasonValue));
    } finally {
      setSaving(false);
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
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-package-action-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">发货记录 · 包裹 {target.packageIndex + 1}</span>
          <h2 id={headingId}>撤销未交寄包裹</h2>
          <p id={descriptionId}>
            仅适用于尚未真实交给承运方的包裹。撤销后记录和原因仍会保留，商品数量退回发货组档案的剩余待发清单（部分发货分类），可从档案继续发货。
          </p>
        </header>
        <label>
          <span>撤销原因</span>
          <textarea
            aria-label="撤销原因"
            value={reason}
            maxLength={500}
            disabled={saving}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <label className="shipment-package-action-dialog__confirmation">
          <input
            type="checkbox"
            aria-label="我确认包裹尚未实际交寄"
            checked={confirmedUnhanded}
            disabled={saving}
            onChange={(event) => setConfirmedUnhanded(event.target.checked)}
          />
          <span>我确认包裹尚未实际交寄；若已经交寄，应进入后续发货拦截流程。</span>
        </label>
        {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
        <footer>
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={saving || !reason.trim() || !confirmedUnhanded}
          >
            {saving ? '正在撤销…' : '确认撤销'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function CorrectShipmentPackageLogisticsDialog({
  api,
  target,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  target: {
    record: ShipmentRecord;
    shipmentPackage: ShipmentRecord['packages'][number];
    packageIndex: number;
  };
  onApplied: (result: ShipmentConfirmationResult) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [shippingCarrier, setShippingCarrier] = useState(target.shipmentPackage.shippingCarrier);
  const [trackingNumber, setTrackingNumber] = useState(target.shipmentPackage.trackingNumber);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changed = shippingCarrier.trim() !== target.shipmentPackage.shippingCarrier
    || trackingNumber.trim() !== target.shipmentPackage.trackingNumber;

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !reason.trim() || !changed) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.correctShipmentPackageLogistics({
        recordId: target.record.id,
        packageId: target.shipmentPackage.id,
        expectedRevision: target.shipmentPackage.revision,
        shippingCarrier,
        trackingNumber,
        occurredAt: new Date().toISOString(),
        reason,
      });
      onApplied(result);
    } catch (reasonValue) {
      setError(errorMessage(reasonValue));
    } finally {
      setSaving(false);
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
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-package-action-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">发货记录 · 包裹 {target.packageIndex + 1}</span>
          <h2 id={headingId}>更正包裹物流</h2>
          <p id={descriptionId}>更正不会覆盖历史值，系统会保存更正前后内容、原因和时间。</p>
        </header>
        <label>
          <span>承运方</span>
          <input
            aria-label="承运方"
            value={shippingCarrier}
            disabled={saving}
            onChange={(event) => setShippingCarrier(event.target.value)}
          />
        </label>
        <label>
          <span>运单号</span>
          <input
            aria-label="运单号"
            value={trackingNumber}
            disabled={saving}
            onChange={(event) => setTrackingNumber(event.target.value)}
          />
        </label>
        <label>
          <span>更正原因</span>
          <textarea
            aria-label="更正原因"
            value={reason}
            maxLength={500}
            disabled={saving}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
        <footer>
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={saving || !reason.trim() || !changed}
          >
            {saving ? '正在更正…' : '确认更正'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function ShipmentGroupAdjustmentDialog({
  api,
  target,
  onApplied,
  onClose,
}: {
  api: DesktopApi;
  target:
    | { kind: 'split'; group: OpenShipmentGroup }
    | { kind: 'merge'; groups: OpenShipmentGroup[] };
  onApplied: (projection: ShipmentGroupProjection) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const [splitOrderIds, setSplitOrderIds] = useState<string[]>([]);
  const [selectedRecipientOrderId, setSelectedRecipientOrderId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const groups = target.kind === 'split' ? [target.group] : target.groups;
  const orders = groups.flatMap((group) => group.orders);
  const requiresRecipientSelection = target.kind === 'merge' && (
    shipmentGroupsRequireFinalRecipient(groups)
  );
  const canSubmit = Boolean(
    reason.trim() && (
      target.kind === 'split'
        ? splitOrderIds.length > 0 && splitOrderIds.length < orders.length
        : !requiresRecipientSelection || selectedRecipientOrderId
    ),
  );

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  function toggleSplitOrder(orderId: string) {
    setSplitOrderIds((current) => (
      current.includes(orderId)
        ? current.filter((id) => id !== orderId)
        : [...current, orderId]
    ));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const result = target.kind === 'split'
        ? await api.splitShipmentGroup({
          groupId: target.group.id,
          expectedMemberOrderIds: orders.map(({ id }) => id),
          splitOrderIds,
          reason,
        })
        : await api.mergeShipmentGroups({
          groupIds: groups.map(({ id }) => id),
          expectedMemberOrderIds: orders.map(({ id }) => id),
          selectedRecipientOrderId,
          reason,
        });
      onApplied(result.projection);
    } catch (reasonValue) {
      setError(errorMessage(reasonValue));
    } finally {
      setSaving(false);
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
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onClose();
      }}
    >
      <form className="shipment-group-adjustment-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <span className="section-kicker">开放发货组 · 手工调整</span>
          <h2 id={headingId}>{target.kind === 'split' ? '拆分发货组' : '重新组合发货组'}</h2>
          <p id={descriptionId}>
            调整只改变开放发货组的归属，不会修改原始订单的收货信息。
          </p>
        </header>

        {target.kind === 'split' ? (
          <fieldset className="shipment-group-adjustment-dialog__choices">
            <legend>选择要拆出的订单</legend>
            {target.group.selectedRecipientOrderId && (
              <p className="shipment-group-adjustment-dialog__hint">
                一次只能拆出收货信息相同的订单；若原组仍包含多套收货信息，
                最终收货信息来源订单需保留在原组。
              </p>
            )}
            {orders.map((order) => (
              <label key={order.id}>
                <input
                  type="checkbox"
                  aria-label={order.orderNumber}
                  checked={splitOrderIds.includes(order.id)}
                  disabled={saving}
                  onChange={() => toggleSplitOrder(order.id)}
                />
                <span><strong>{order.orderNumber}</strong><small>{order.recipient}</small></span>
              </label>
            ))}
          </fieldset>
        ) : (
          <div className="shipment-group-adjustment-dialog__summary">
            <strong>已选 {groups.length} 个发货组，共 {orders.length} 笔订单</strong>
            {requiresRecipientSelection && (
              <fieldset className="shipment-group-adjustment-dialog__choices">
                <legend>请选择最终收货信息</legend>
                {orders.map((order) => (
                  <label key={order.id}>
                    <input
                      type="radio"
                      name="selected-recipient-order"
                      aria-label={`最终收货信息：${order.recipient} ${order.phone} ${order.addressOriginal}`}
                      checked={selectedRecipientOrderId === order.id}
                      disabled={saving}
                      onChange={() => setSelectedRecipientOrderId(order.id)}
                    />
                    <span>
                      <strong>{order.recipient} · {order.phone}</strong>
                      <small>{order.addressOriginal}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        )}

        <label className="shipment-group-adjustment-dialog__reason">
          <span>调整原因</span>
          <textarea
            aria-label="调整原因"
            value={reason}
            maxLength={500}
            disabled={saving}
            placeholder="例如：买家要求一起发货"
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && <p className="shipment-group-adjustment-dialog__error" role="alert">{error}</p>}
        <footer>
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button className="button button--primary" type="submit" disabled={saving || !canSubmit}>
            {saving
              ? '正在保存…'
              : target.kind === 'split' ? '确认拆分' : '确认重新组合'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function shipmentGroupAttentionReasonLabel(
  reason: ShipmentGroupProjection['attentionOrders'][number]['reasons'][number],
): string {
  return reason === 'missing_phone' ? '缺少手机号' : '缺少完整地址';
}

function shipmentArchiveRecipientDifferenceLabel(
  field: ShipmentGroupArchive['recipientDifferences'][number]['fields'][number],
): string {
  if (field === 'recipient') return '收件人';
  if (field === 'phone') return '手机号';
  return '完整地址';
}

type OrdersWorkspaceProps = {
  api: DesktopApi;
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
  onUpdatePlatformTransactionStatus: (
    input: OrderPlatformTransactionStatusUpdateInput,
  ) => Promise<OrderDetails[]>;
  onExport: (input: OrderExportInput) => Promise<OrderExportResult>;
  onPreviewExport: (input: OrderExportInput) => Promise<OrderExportPreviewResult>;
};

function OrdersWorkspace({
  api,
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
  onUpdatePlatformTransactionStatus,
  onPreviewExport,
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
            : '逐条查看订单商品明细，并按商品级自定义字段筛选或排序。'}</p>
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
          订单商品明细
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
              <option value="partially_shipped">部分发货</option>
              <option value="shipped">已发货</option>
              <option value="delivered">已收货</option>
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
            <span>回购筛选</span>
            <select
              value={query.repurchase === undefined
                ? ''
                : query.repurchase ? 'repurchase' : 'first'}
              onChange={(event) => patchQuery({
                repurchase: event.target.value === ''
                  ? undefined
                  : event.target.value === 'repurchase',
              })}
            >
              <option value="">全部订单</option>
              <option value="repurchase">仅回购单</option>
              <option value="first">仅首次购买</option>
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
              {`修改已选 ${selectedOrders.length} 笔交易状态`}
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
        <p className="status-logistics-feedback" role="status" aria-label="平台交易状态维护结果">
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
                      aria-label={`维护订单平台交易状态 ${order.orderNumber}`}
                      onClick={() => {
                        setStatusLogisticsFeedback('');
                        setStatusLogisticsOrders([order]);
                      }}
                      disabled={statusLogisticsSaving}
                    >
                      交易状态
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
          templates={tableTemplates}
          initialOrderTemplateId={orderTemplate?.id ?? null}
          onPreview={onPreviewExport}
          onExport={onExport}
          onClose={() => setExportPreview(null)}
          onSaved={(result) => {
            setExportFeedback(
              result.orderItemCount === null
                ? `已导出 ${result.orderCount} 笔订单：${result.fileName}`
                : `已导出 ${result.orderCount} 笔订单、${result.orderItemCount} 条订单商品明细：${result.fileName}`,
            );
            setExportPreview(null);
          }}
        />
      )}

      {statusLogisticsOrders && (
        <OrderPlatformTransactionStatusDialog
          orders={statusLogisticsOrders}
          saving={statusLogisticsSaving}
          onClose={() => setStatusLogisticsOrders(null)}
          onSave={onUpdatePlatformTransactionStatus}
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
          api={api}
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

type PlatformTransactionStatusOrder = Pick<
  OrderSummary,
  | 'id'
  | 'orderNumber'
  | 'revision'
>;

function OrderPlatformTransactionStatusDialog({
  orders,
  saving,
  onSave,
  onSaved,
  onClose,
}: {
  orders: PlatformTransactionStatusOrder[];
  saving: boolean;
  onSave: (input: OrderPlatformTransactionStatusUpdateInput) => Promise<OrderDetails[]>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const [platformTransactionStatus, setPlatformTransactionStatus] = useState<
    '' | OrderPlatformTransactionStatusPatch['platformTransactionStatus']
  >('');
  const [error, setError] = useState('');

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    firstFieldRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !platformTransactionStatus || orders.length === 0) return;
    setError('');
    try {
      await onSave({
        targets: orders.map((order) => ({
          orderId: order.id,
          expectedRevision: order.revision ?? 1,
        })),
        patch: { platformTransactionStatus },
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
          <span className="section-kicker">平台记录 · 人工维护</span>
          <h2 id={headingId}>维护平台交易状态</h2>
          <p id={descriptionId}>
            {orders.length === 1
              ? `仅修改订单 ${orders[0].orderNumber} 的平台交易状态。`
              : `相同平台交易状态将应用到已选 ${orders.length} 笔订单。`}
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
        </div>

        <p className="order-status-logistics-dialog__notice">
          履约状态由发货记录、包裹商品数量和包裹物流自动计算；
          快递公司与运单号请在对应发货记录中维护。平台交易状态不会参与履约计算。
        </p>
        {error && <p className="order-status-logistics-dialog__error" role="alert">{error}</p>}
        <footer className="order-status-logistics-dialog__actions">
          <button className="button button--quiet" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button className="button button--primary" type="submit" disabled={saving || !platformTransactionStatus}>
            {saving ? '正在保存…' : `确认修改 ${orders.length} 笔`}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

type OrderItemsWorkbenchProps = {
  api: DesktopApi;
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
  api,
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
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(() => new Set());
  const [batchLinkItems, setBatchLinkItems] = useState<Array<{
    id: string;
    sourceTitle: string;
  }> | null>(null);
  const selectAllItemsRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSelectedFilterId(query.customFieldFilter?.definitionId ?? '');
  }, [query.customFieldFilter?.definitionId]);
  useEffect(() => {
    const visibleIds = new Set(items.map(({ id }) => id));
    setSelectedItemIds((current) => {
      const retained = new Set([...current].filter((id) => visibleIds.has(id)));
      return retained.size === current.size ? current : retained;
    });
  }, [items]);
  const selectedItems = items.filter(({ id }) => selectedItemIds.has(id));
  useEffect(() => {
    if (selectAllItemsRef.current) {
      selectAllItemsRef.current.indeterminate = selectedItems.length > 0 &&
        selectedItems.length < items.length;
    }
  }, [items.length, selectedItems.length]);
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
    query.sourceTitle || query.sourceSpec || query.similarText ||
    query.unitPriceCents !== undefined ||
    query.quantity !== undefined || query.quantitySource || query.sortField ||
    query.customFieldFilter || query.customFieldSort,
  );

  return (
    <div
      id="order-items-view-panel"
      role="tabpanel"
      aria-labelledby="order-items-view-tab"
    >
      <section className="order-query order-item-query" aria-label="订单商品明细查询">
        <div className="order-item-query__heading">
          <strong>商品级字段</strong>
          <span>精确筛选原始商品事实，也可组合订单商品明细粒度的自定义字段。</span>
        </div>
        <span className="order-query__result" role="status" aria-live="polite">
          {loading ? '正在查询…' : `显示 ${items.length} 条订单商品明细`}
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
            <span>相似标题／规格</span>
            <input
              type="search"
              aria-label="相似标题规格筛选"
              value={query.similarText ?? ''}
              onChange={(event) => patchQuery({
                similarText: event.target.value || undefined,
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
              aria-label="订单商品明细内置排序"
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
          <h2>没有符合条件的订单商品明细</h2>
          <p>试试更换字段值，或清除当前筛选。</p>
        </div>
      ) : (
        <>
          <div className="table-toolbar" aria-label="订单商品明细表概况">
            <span><strong>{items.length}</strong> 条订单商品明细</span>
            <span><strong>{items.reduce((total, item) => total + item.quantity, 0)}</strong> 件商品</span>
            <span><strong>{formatMoney(items.reduce((total, item) => total + item.subtotalCents, 0))}</strong> 商品小计</span>
            <button
              className="button button--quiet table-toolbar__export"
              type="button"
              disabled={loading || selectedItems.length === 0}
              onClick={() => setBatchLinkItems(
                selectedItems.map((item) => ({ id: item.id, sourceTitle: item.sourceTitle })),
              )}
            >
              统一关联到一个 SKU{selectedItems.length > 0 ? `（已选 ${selectedItems.length} 条）` : ''}
            </button>
          </div>

          <div className="table-frame order-items-table-frame">
            <table aria-label="订单商品明细">
              <thead>
                <tr>
                  <th className="order-selection-cell order-selection-cell--header" scope="col">
                    <input
                      ref={selectAllItemsRef}
                      className="order-selection-checkbox"
                      type="checkbox"
                      aria-label="选择当前结果全部订单商品明细"
                      checked={items.length > 0 && selectedItems.length === items.length}
                      onChange={(event) => {
                        setSelectedItemIds(event.target.checked
                          ? new Set(items.map(({ id }) => id))
                          : new Set());
                      }}
                    />
                  </th>
                  {columns.map((column) => (
                    <th key={fieldReferenceKey(column.field)}>{column.displayName}</th>
                  ))}
                  <th><span className="visually-hidden">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr className={selectedItemIds.has(item.id) ? 'is-selected' : undefined} key={item.id}>
                    <td className="order-selection-cell">
                      <input
                        className="order-selection-checkbox"
                        type="checkbox"
                        aria-label={`选择订单商品 ${item.sourceTitle || '未命名商品'}`}
                        checked={selectedItemIds.has(item.id)}
                        onChange={(event) => {
                          setSelectedItemIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          });
                        }}
                      />
                    </td>
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
      {batchLinkItems && (
        <OrderItemStandardizationBatchDialog
          api={api}
          items={batchLinkItems}
          onApplied={() => setSelectedItemIds(new Set())}
          onClose={() => setBatchLinkItems(null)}
        />
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
  const [backupBusy, setBackupBusy] = useState<'create' | 'verify' | 'restore' | null>(null);
  const [backupFeedback, setBackupFeedback] = useState<SettingsFeedback>(null);
  const [autoBackupSettings, setAutoBackupSettings] = useState<BackupSettingsView | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatusView | null>(null);
  const [backupPolicyBusy, setBackupPolicyBusy] = useState(false);
  const [backupMaxVersionsInput, setBackupMaxVersionsInput] = useState('');
  const [backupCapacityGbInput, setBackupCapacityGbInput] = useState('');
  const [manualBackupRootInput, setManualBackupRootInput] = useState('');
  const [restoreTargetInput, setRestoreTargetInput] = useState('');
  const [backupVerifyResult, setBackupVerifyResult] = useState<BackupVerificationReport | null>(null);
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

  async function runBackupCreate() {
    if (backupBusy) return;
    setBackupBusy('create');
    setBackupFeedback(null);
    setBackupVerifyResult(null);
    try {
      const outcome = await api.createBackup();
      if (outcome.kind === 'canceled') return;
      if (outcome.verification.ok) {
        setBackupFeedback({
          kind: 'success',
          message: `备份完成并验证通过：${outcome.backupDirectory}（${outcome.totals.files} 个文件，${formatBackupBytes(outcome.totals.bytes)}）`,
        });
      } else {
        setBackupFeedback({
          kind: 'error',
          message: `备份已写入但验证未通过，请勿依赖此备份：${outcome.verification.problems.join('；')}`,
        });
      }
    } catch (error) {
      setBackupFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBackupBusy(null);
    }
  }

  async function runBackupVerify() {
    if (backupBusy) return;
    setBackupBusy('verify');
    setBackupFeedback(null);
    setBackupVerifyResult(null);
    try {
      const outcome = await api.verifyBackup();
      if (outcome.kind === 'canceled') return;
      setBackupVerifyResult(outcome.result);
    } catch (error) {
      setBackupFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBackupBusy(null);
    }
  }

  async function runBackupRestore() {
    if (backupBusy) return;
    setBackupBusy('restore');
    setBackupFeedback(null);
    setBackupVerifyResult(null);
    try {
      const outcome = await api.restoreBackup();
      if (outcome.kind === 'canceled') return;
      setBackupFeedback({
        kind: 'success',
        message: `已恢复到 ${outcome.targetDirectory}（${outcome.restoredFiles} 个文件，${formatBackupBytes(outcome.restoredBytes)}）；当前数据未改动，可经「更改数据目录」切换到恢复结果`,
      });
    } catch (error) {
      setBackupFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBackupBusy(null);
    }
  }

  useEffect(() => {
    let active = true;
    void api.getBackupSettings()
      .then((settings) => {
        if (!active) return;
        setAutoBackupSettings(settings);
        setBackupMaxVersionsInput(String(settings.maxVersions));
        setBackupCapacityGbInput(bytesToGbText(settings.capacityLimitBytes));
        setManualBackupRootInput(settings.manualBackupRootDirectory ?? '');
        setRestoreTargetInput(settings.restoreTargetDirectory ?? '');
      })
      .catch((error: unknown) => {
        if (active) setBackupFeedback({ kind: 'error', message: errorMessage(error) });
      });
    void api.getBackupStatus()
      .then((status) => {
        if (active) setBackupStatus(status);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, reloadToken]);

  async function saveAutoBackupSettings(
    next: SaveBackupSettingsInput,
    successMessage: string,
  ) {
    setBackupPolicyBusy(true);
    setBackupFeedback(null);
    try {
      const saved = await api.saveBackupSettings(next);
      setAutoBackupSettings(saved);
      setBackupMaxVersionsInput(String(saved.maxVersions));
      setBackupCapacityGbInput(bytesToGbText(saved.capacityLimitBytes));
      setManualBackupRootInput(saved.manualBackupRootDirectory ?? '');
      setRestoreTargetInput(saved.restoreTargetDirectory ?? '');
      setBackupStatus(await api.getBackupStatus());
      setBackupFeedback({ kind: 'success', message: successMessage });
    } catch (error) {
      setBackupFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBackupPolicyBusy(false);
    }
  }

  function toggleAutoBackup() {
    if (!autoBackupSettings || backupPolicyBusy) return;
    void saveAutoBackupSettings(
      { ...autoBackupSettings, autoBackupEnabled: !autoBackupSettings.autoBackupEnabled },
      autoBackupSettings.autoBackupEnabled ? '自动备份已关闭' : '自动备份已开启',
    );
  }

  async function chooseBackupRoot() {
    if (!autoBackupSettings || backupPolicyBusy) return;
    setBackupFeedback(null);
    try {
      const outcome = await api.selectBackupRoot();
      if (outcome.kind === 'canceled') return;
      await saveAutoBackupSettings(
        { ...autoBackupSettings, backupRootDirectory: outcome.directory },
        `自动备份位置已设为 ${outcome.directory}`,
      );
    } catch (error) {
      setBackupFeedback({ kind: 'error', message: errorMessage(error) });
    }
  }

  function saveBackupPolicy() {
    if (!autoBackupSettings || backupPolicyBusy) return;
    const maxVersions = Number(backupMaxVersionsInput);
    const capacityGb = Number(backupCapacityGbInput);
    if (!Number.isInteger(maxVersions) || maxVersions < 1 || maxVersions > 1_000) {
      setBackupFeedback({ kind: 'error', message: '保留版本数需为 1–1000 的整数' });
      return;
    }
    if (!Number.isFinite(capacityGb) || capacityGb < 0.1 || capacityGb > 2_048) {
      setBackupFeedback({ kind: 'error', message: '容量上限需为 0.1–2048（GB）' });
      return;
    }
    void saveAutoBackupSettings(
      {
        ...autoBackupSettings,
        maxVersions,
        capacityLimitBytes: Math.round(capacityGb * 1024 * 1024 * 1024),
      },
      '备份策略已保存',
    );
  }

  function commitBackupPath(
    field: 'manualBackupRootDirectory' | 'restoreTargetDirectory',
    value: string,
  ) {
    if (!autoBackupSettings || backupPolicyBusy) return;
    const trimmed = value.trim();
    if (trimmed === (autoBackupSettings[field] ?? '')) return;
    const label = field === 'manualBackupRootDirectory' ? '手动备份位置' : '恢复位置';
    void saveAutoBackupSettings(
      { ...autoBackupSettings, [field]: trimmed || null },
      trimmed ? `${label}已设为 ${trimmed}` : `${label}已清除`,
    );
  }

  async function browseBackupLocation(
    field: 'manualBackupRootDirectory' | 'restoreTargetDirectory',
  ) {
    if (!autoBackupSettings || backupPolicyBusy) return;
    setBackupFeedback(null);
    try {
      const outcome = await api.selectBackupRoot(
        field === 'restoreTargetDirectory' ? 'restore' : 'backup',
      );
      if (outcome.kind === 'canceled') return;
      await saveAutoBackupSettings(
        { ...autoBackupSettings, [field]: outcome.directory },
        `${field === 'manualBackupRootDirectory' ? '手动备份位置' : '恢复位置'}已设为 ${outcome.directory}`,
      );
    } catch (error) {
      setBackupFeedback({ kind: 'error', message: errorMessage(error) });
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

          <section className="settings-section settings-section--backup" aria-labelledby="backup-heading">
            <div className="settings-section-heading">
              <div>
                <span className="section-kicker">本机数据</span>
                <h2 id="backup-heading">备份与恢复</h2>
                <p>
                  备份覆盖订单、模板、商品映射和来源截图；API 密钥只保存在本机系统凭据中，不进入备份。
                  备份可保存到外接硬盘或同步盘，并在 Mac 与 Windows 之间互相恢复；
                  同一数据目录同一时间只能由一台机器打开。
                </p>
              </div>
            </div>
            <div className="backup-actions">
              <button
                className="button button--primary"
                type="button"
                aria-busy={backupBusy === 'create'}
                disabled={backupBusy !== null}
                onClick={() => void runBackupCreate()}
              >
                {backupBusy === 'create' ? '正在备份…' : '立即备份'}
              </button>
              <button
                className="button button--quiet"
                type="button"
                aria-busy={backupBusy === 'verify'}
                disabled={backupBusy !== null}
                onClick={() => void runBackupVerify()}
              >
                {backupBusy === 'verify' ? '正在验证…' : '验证备份'}
              </button>
              <button
                className="button button--quiet"
                type="button"
                aria-busy={backupBusy === 'restore'}
                disabled={backupBusy !== null}
                onClick={() => void runBackupRestore()}
              >
                {backupBusy === 'restore' ? '正在恢复…' : '恢复备份…'}
              </button>
            </div>

            <div className="backup-paths">
              <label className="backup-path-row">
                <span>手动备份位置</span>
                <input
                  type="text"
                  value={manualBackupRootInput}
                  placeholder="配置后「立即备份」不再弹窗，直接备份到这里；留空则每次选择"
                  disabled={backupPolicyBusy}
                  onChange={(event) => setManualBackupRootInput(event.target.value)}
                  onBlur={() => commitBackupPath('manualBackupRootDirectory', manualBackupRootInput)}
                />
                <button
                  className="button button--quiet"
                  type="button"
                  aria-label="浏览手动备份位置"
                  disabled={backupPolicyBusy}
                  onClick={() => void browseBackupLocation('manualBackupRootDirectory')}
                >
                  浏览
                </button>
              </label>
              <label className="backup-path-row">
                <span>恢复位置</span>
                <input
                  type="text"
                  value={restoreTargetInput}
                  placeholder="配置后「恢复备份」只选备份，恢复到其下的时间戳子目录；留空则每次选择"
                  disabled={backupPolicyBusy}
                  onChange={(event) => setRestoreTargetInput(event.target.value)}
                  onBlur={() => commitBackupPath('restoreTargetDirectory', restoreTargetInput)}
                />
                <button
                  className="button button--quiet"
                  type="button"
                  aria-label="浏览恢复位置"
                  disabled={backupPolicyBusy}
                  onClick={() => void browseBackupLocation('restoreTargetDirectory')}
                >
                  浏览
                </button>
              </label>
            </div>

            {backupVerifyResult && (
              <div
                className={`backup-verify-result${backupVerifyResult.ok ? ' is-ok' : ' is-error'}`}
                role={backupVerifyResult.ok ? 'status' : 'alert'}
                aria-label="备份验证结果"
              >
                <div className="backup-verify-summary">
                  <strong>{backupVerifyResult.ok ? '备份验证通过' : '备份验证未通过'}</strong>
                  <span>
                    {`共 ${backupVerifyResult.checkedFiles} 个文件 · ${formatBackupBytes(backupVerifyResult.totalBytes)}`}
                    {backupVerifyResult.createdAt
                      ? ` · 备份创建于 ${new Date(backupVerifyResult.createdAt).toLocaleString()}`
                      : ''}
                  </span>
                </div>
                {backupVerifyResult.problems.length > 0 && (
                  <ul>
                    {backupVerifyResult.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <SettingsNotice feedback={backupFeedback} />

            <div className="backup-auto">
              <div className="backup-auto-heading">
                <div>
                  <strong>自动备份</strong>
                  <p>
                    开启后每天自动创建一份备份；未变化的截图复用上一份的存储（硬链接），
                    超出保留版本数或容量上限时从最旧开始清理，最新一份始终保留。
                  </p>
                </div>
                <button
                  className={`settings-switch${autoBackupSettings?.autoBackupEnabled ? ' is-on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={autoBackupSettings?.autoBackupEnabled ?? false}
                  aria-label="自动备份"
                  aria-busy={backupPolicyBusy}
                  disabled={!autoBackupSettings || backupPolicyBusy}
                  onClick={toggleAutoBackup}
                >
                  <span className="settings-switch-track" aria-hidden="true"><i /></span>
                  <span>{autoBackupSettings?.autoBackupEnabled ? '已开启' : '已关闭'}</span>
                </button>
              </div>
              <div className="data-directory-location">
                <div>
                  <span>自动备份位置</span>
                  <code title={autoBackupSettings?.backupRootDirectory ?? undefined}>
                    {autoBackupSettings?.backupRootDirectory ?? '未选择'}
                  </code>
                </div>
                <button
                  className="button button--quiet"
                  type="button"
                  aria-busy={backupPolicyBusy}
                  disabled={!autoBackupSettings || backupPolicyBusy}
                  onClick={() => void chooseBackupRoot()}
                >
                  <Icon name="folder" />
                  选择位置
                </button>
              </div>
              <div className="backup-policy">
                <label>
                  保留版本数
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={backupMaxVersionsInput}
                    disabled={backupPolicyBusy}
                    onChange={(event) => setBackupMaxVersionsInput(event.target.value)}
                  />
                </label>
                <label>
                  容量上限（GB）
                  <input
                    type="number"
                    min={0.1}
                    max={2048}
                    step={0.1}
                    value={backupCapacityGbInput}
                    disabled={backupPolicyBusy}
                    onChange={(event) => setBackupCapacityGbInput(event.target.value)}
                  />
                </label>
                <button
                  className="button button--quiet"
                  type="button"
                  aria-busy={backupPolicyBusy}
                  disabled={backupPolicyBusy}
                  onClick={saveBackupPolicy}
                >
                  保存策略
                </button>
              </div>
              {backupStatus && (
                <div className="backup-status" aria-label="备份状态">
                  <div className="backup-status-summary">
                    {`共 ${backupStatus.backups.length} 个备份 · 占用约 ${formatBackupBytes(backupStatus.totalBytes)}（未变化内容按一份估算）/ 上限 ${formatBackupBytes(backupStatus.capacityLimitBytes)}`}
                    {backupStatus.lastAutoBackupAt
                      ? ` · 上次自动备份 ${new Date(backupStatus.lastAutoBackupAt).toLocaleString()}`
                      : ' · 尚未自动备份'}
                    {backupStatus.lastVerification
                      ? backupStatus.lastVerification.ok
                        ? ' · 上次验证通过'
                        : ` · 上次验证未通过${backupStatus.lastVerification.note ? `：${backupStatus.lastVerification.note}` : ''}`
                      : ''}
                  </div>
                  {backupStatus.overCapacity && (
                    <p className="backup-over-capacity" role="alert">
                      备份占用已超过容量上限；最新恢复点已按规则临时保留，请检查备份位置或调整上限。
                    </p>
                  )}
                  {backupStatus.events.length > 0 && (
                    <ul className="backup-event-log">
                      {backupStatus.events.slice(-5).reverse().map((event) => (
                        <li key={`${event.at}-${event.kind}-${event.backupDirectory ?? ''}`}>
                          <span>{new Date(event.at).toLocaleString()}</span>
                          <span>{backupEventLabel(event)}</span>
                          {event.reason ? <span>{event.reason}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
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

function formatBackupBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function backupEventLabel(event: BackupEventRecord): string {
  if (event.kind === 'auto-created') return '自动备份';
  if (event.kind === 'auto-failed') return `自动备份失败${event.note ? `：${event.note}` : ''}`;
  return '清理恢复点';
}

function bytesToGbText(bytes: number): string {
  return String(Number((bytes / (1024 * 1024 * 1024)).toFixed(2)));
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
  onConfirm: (
    event: FormEvent<HTMLFormElement>,
    productStandardizations: readonly ProductStandardizationConfirmation[],
  ) => void;
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
  const [standardProducts, setStandardProducts] = useState<StandardProduct[]>([]);
  const [standardizationPreview, setStandardizationPreview] =
    useState<DraftItemProductStandardization[]>([]);
  const [standardizationRequestContext, setStandardizationRequestContext] = useState('');
  const [standardizationRequestPending, setStandardizationRequestPending] = useState(true);
  const [standardizationChoices, setStandardizationChoices] = useState<Record<
    string,
    { standardProductId: string | null; createMapping: boolean }
  >>({});
  const [standardizationError, setStandardizationError] = useState('');
  const [standardizationConflictItemIds, setStandardizationConflictItemIds] =
    useState<Set<string>>(new Set());
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
  const productSourceKey = JSON.stringify(draft.items.map((item) => [
    item.id,
    item.sourceTitle,
    item.sourceSpec,
  ]));
  const productStandardizationContext = `${draft.id}:${productSourceKey}`;
  const standardizationLoading =
    standardizationRequestContext !== productStandardizationContext ||
    standardizationRequestPending;
  const currentStandardizationPreview = standardizationRequestContext === productStandardizationContext
    ? standardizationPreview
    : [];
  const currentStandardizationChoices = standardizationRequestContext === productStandardizationContext
    ? standardizationChoices
    : {};
  const hasUnresolvedMappingConflicts = standardizationRequestContext === productStandardizationContext
    && standardizationConflictItemIds.size > 0;
  const currentProductByDraftItemId = useMemo(() => {
    if (review.kind !== 'order_update') return new Map<string, StandardProduct>();
    const persistedIds = matchOrderItemIds(review.currentOrder.items, draft.items);
    const existingById = new Map(review.currentOrder.items.map((item) => [item.id, item]));
    return new Map(draft.items.flatMap((item) => {
      const persistedId = persistedIds.get(item.id);
      const product = persistedId ? existingById.get(persistedId)?.standardProduct : null;
      return product ? [[item.id, product] as const] : [];
    }));
  }, [draft.items, review]);

  useEffect(() => {
    let active = true;
    setStandardizationRequestContext(productStandardizationContext);
    setStandardizationRequestPending(true);
    setStandardizationPreview([]);
    setStandardizationChoices({});
    setStandardizationConflictItemIds(new Set());
    setStandardizationError('');
    void Promise.all([
      api.listStandardProducts(),
      api.previewDraftProductStandardizations(draft),
    ]).then(([products, preview]) => {
      if (!active) return;
      setStandardProducts(products);
      setStandardizationPreview(preview);
    }).catch((error: unknown) => {
      if (active) setStandardizationError(errorMessage(error));
    }).finally(() => {
      if (active) setStandardizationRequestPending(false);
    });
    return () => { active = false; };
  }, [api, productStandardizationContext]);

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

  function submitReview(event: FormEvent<HTMLFormElement>) {
    if (standardizationLoading) {
      event.preventDefault();
      return;
    }
    // 规格 4.4：映射冲突必须先三选一，未处理的冲突不能带进确认入库。
    if (hasUnresolvedMappingConflicts) {
      event.preventDefault();
      return;
    }
    const confirmations = Object.entries(currentStandardizationChoices).map(([
      draftItemId,
      choice,
    ]) => ({ draftItemId, ...choice }));
    onConfirm(event, confirmations);
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
            disabled={
              cancelling || confirming || standardizationLoading ||
              !isComplete || hasUnresolvedMappingConflicts
            }
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

        <form id="review-form" className="review-form" onSubmit={submitReview}>
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

          <FormSection title={`订单商品明细 · ${draft.items.length}`} description="没有识别到明确数量时，系统默认为 1。">
            <div className="item-list">
              {draft.items.length === 0 && (
                <div className="empty-items">暂无订单商品明细</div>
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
                    <ProductStandardizationEditor
                      api={api}
                      platform={draft.platform}
                      sellerAccount={draft.sellerAccount}
                      item={item}
                      itemIndex={index}
                      products={standardProducts}
                      preview={currentStandardizationPreview.find(({ draftItemId }) => (
                        draftItemId === item.id
                      ))}
                      currentProduct={currentProductByDraftItemId.get(item.id) ?? null}
                      choice={currentStandardizationChoices[item.id]}
                      loading={standardizationLoading}
                      onChoiceChange={(choice) => setStandardizationChoices((current) => {
                        if (choice === undefined) {
                          const next = { ...current };
                          delete next[item.id];
                          return next;
                        }
                        return { ...current, [item.id]: choice };
                      })}
                      onMappingConflictChange={(itemId, hasConflict) => {
                        setStandardizationConflictItemIds((current) => {
                          if (current.has(itemId) === hasConflict) return current;
                          const next = new Set(current);
                          if (hasConflict) next.add(itemId); else next.delete(itemId);
                          return next;
                        });
                      }}
                    />
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
            {hasUnresolvedMappingConflicts && (
              <p className="custom-field-required-note" role="status">
                存在未处理的商品映射冲突，请逐条选择取消、更正映射目标或单笔例外后再确认入库。
              </p>
            )}
            {standardizationError && (
              <p className="custom-field-required-note" role="alert">
                标准商品候选读取失败：{standardizationError}。仍可保留订单原始商品信息入库。
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

const PRODUCT_MAPPING_SCOPE_LABELS: Record<ProductMappingScope, string> = {
  current_account: '当前卖家账号',
  current_platform: '当前平台',
  workspace: '工作区',
};

function productMappingScopeLabel(scope: ProductMappingScope | null | undefined): string {
  return scope ? PRODUCT_MAPPING_SCOPE_LABELS[scope] : '—';
}

function ProductStandardizationEditor({
  api,
  platform,
  sellerAccount,
  item,
  itemIndex,
  products,
  preview,
  currentProduct,
  choice,
  loading,
  onChoiceChange,
  onMappingConflictChange,
}: {
  api: DesktopApi;
  platform: string;
  sellerAccount: string;
  item: DraftItem;
  itemIndex: number;
  products: readonly StandardProduct[];
  preview?: DraftItemProductStandardization;
  currentProduct: StandardProduct | null;
  choice?: { standardProductId: string | null; createMapping: boolean };
  loading: boolean;
  onChoiceChange: (
    choice: { standardProductId: string | null; createMapping: boolean } | undefined,
  ) => void;
  onMappingConflictChange: (itemId: string, hasConflict: boolean) => void;
}) {
  // 规格 4.4：勾选建立映射时先查当前账号适用范围内的有效映射冲突，冲突则显式三选一。
  const [mappingConflict, setMappingConflict] = useState<ProductMappingView | null>(null);
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionError, setCorrectionError] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const createMappingProductId = choice?.createMapping ? choice.standardProductId : null;
  useEffect(() => {
    if (!createMappingProductId) {
      setMappingConflict(null);
      return undefined;
    }
    let active = true;
    void api.findProductMappingConflict({
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      platform,
      sellerAccount,
    }).then((found) => {
      if (!active) return;
      setMappingConflict(
        found && found.standardProductId !== createMappingProductId ? found : null,
      );
    }).catch(() => {
      if (active) setMappingConflict(null);
    });
    return () => {
      active = false;
    };
  }, [api, createMappingProductId, item.sourceTitle, item.sourceSpec, platform, sellerAccount]);
  // 冲突状态上报给表单：未处理的冲突期间拦截「确认并入库」（规格 4.4 三选一）。
  useEffect(() => {
    onMappingConflictChange(item.id, mappingConflict !== null);
  }, [item.id, mappingConflict]);

  async function correctMappingTarget() {
    if (!mappingConflict || !createMappingProductId || correcting) return;
    const reason = correctionReason.trim();
    if (!reason) {
      setCorrectionError('更正商品映射必须填写原因');
      return;
    }
    setCorrecting(true);
    setCorrectionError('');
    try {
      await api.correctProductMapping(mappingConflict.id, {
        standardProductId: createMappingProductId,
        reason,
      });
      // 映射已更正指向所选 SKU，本次确认无需再重复建立映射。
      onChoiceChange({ standardProductId: createMappingProductId, createMapping: false });
      setMappingConflict(null);
    } catch (error) {
      setCorrectionError(errorMessage(error));
    } finally {
      setCorrecting(false);
    }
  }

  const automaticProduct = currentProduct ?? preview?.automaticProduct ?? null;
  const selectValue = choice
    ? choice.standardProductId ?? '__none__'
    : automaticProduct
      ? '__automatic__'
      : '__none__';
  const automaticLabel = currentProduct
    ? `保持当前关联：${currentProduct.sku} · ${currentProduct.name}`
    : preview?.automaticSource === 'mapping'
      ? `命中映射：${productMappingScopeLabel(preview.automaticMappingScope)} · ` +
        `${automaticProduct?.sku} · ${automaticProduct?.name}`
      : `按标题和规格精确关联：${automaticProduct?.sku} · ${automaticProduct?.name}`;

  return (
    <section className="product-standardization-editor" aria-label={`商品 ${itemIndex + 1} 标准化`}>
      <div className="product-standardization-editor__heading">
        <div>
          <strong>标准商品关联</strong>
          <small>截图原文始终保留；模糊候选不会自动合并。</small>
        </div>
        {loading
          ? <span role="status">正在匹配…</span>
          : automaticProduct && !choice && <span>已自动匹配</span>}
      </div>
      <label className="field">
        <span className="field-label">标准商品</span>
        <select
          aria-label={`商品 ${itemIndex + 1} 标准商品`}
          disabled={loading}
          value={selectValue}
          onChange={(event) => {
            if (event.target.value === '__automatic__') {
              onChoiceChange(undefined);
            } else if (event.target.value === '__none__') {
              onChoiceChange(automaticProduct
                ? { standardProductId: null, createMapping: false }
                : undefined);
            } else {
              onChoiceChange({
                standardProductId: event.target.value,
                createMapping: false,
              });
            }
          }}
        >
          {automaticProduct && <option value="__automatic__">{automaticLabel}</option>}
          <option value="__none__">暂不关联</option>
          {products.map((product) => (
            <option value={product.id} key={product.id}>
              {product.sku} · {product.name} · {product.specification}
            </option>
          ))}
        </select>
      </label>
      {choice?.standardProductId && (
        <label className="fields-check-row product-standardization-editor__mapping">
          <input
            type="checkbox"
            disabled={loading}
            checked={choice.createMapping}
            onChange={(event) => onChoiceChange({
              ...choice,
              createMapping: event.target.checked,
            })}
          />
          <span>
            <strong>记住这组订单原文</strong>
            <small>以后遇到“{item.sourceTitle} / {item.sourceSpec || '无规格'}”时自动关联。</small>
          </span>
        </label>
      )}
      {mappingConflict && choice?.standardProductId && (
        <div
          className="field-definition-card__meta"
          role="group"
          aria-label={`商品 ${itemIndex + 1} 商品映射冲突处理`}
        >
          <span>
            当前平台与卖家账号范围内，“{mappingConflict.sourceTitle} / {mappingConflict.sourceSpec || '无规格'}”
            已有指向 {mappingConflict.targetProductSku} 的有效商品映射，不能同时指向两个 SKU。
          </span>
          <span>请选择：取消（回到暂不关联）、更正映射目标，或仅本次关联（单笔例外）。</span>
          <label className="field">
            <span className="field-label">更正原因</span>
            <input
              type="text"
              aria-label={`商品 ${itemIndex + 1} 映射更正原因`}
              disabled={correcting}
              value={correctionReason}
              onChange={(event) => setCorrectionReason(event.target.value)}
            />
          </label>
          {correctionError && <small className="field-error">{correctionError}</small>}
          <div className="dialog-actions">
            <button
              className="button button--quiet"
              type="button"
              disabled={correcting}
              onClick={() => onChoiceChange(automaticProduct
                ? { standardProductId: null, createMapping: false }
                : undefined)}
            >
              取消
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={correcting}
              onClick={() => void correctMappingTarget()}
            >
              {correcting ? '正在更正…' : `更正映射目标为所选 SKU`}
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={correcting}
              onClick={() => onChoiceChange({ ...choice, createMapping: false })}
            >
              仅本次关联（单笔例外）
            </button>
          </div>
        </div>
      )}
      {!automaticProduct && preview && preview.candidates.length > 0 && (
        <div className="product-standardization-candidates">
          <span>可能的标准商品</span>
          {preview.candidates.map((candidate) => (
            <button
              className="button button--quiet"
              type="button"
              disabled={loading}
              key={candidate.product.id}
              onClick={() => onChoiceChange({
                standardProductId: candidate.product.id,
                createMapping: false,
              })}
            >
              {candidate.product.sku} · {candidate.product.name}
              {candidate.reason === 'previous_manual_choice' ? '（曾人工关联）' : '（相似候选）'}
            </button>
          ))}
        </div>
      )}
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
  fulfillmentStatusConfirmation: '人工确认履约状态',
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
    standardProductSku: '标准商品（SKU）',
    standardizationSource: '标准化来源',
    standardDisplayPreference: '标准商品显示偏好',
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
    if (path.endsWith('.standardizationSource')) {
      const standardizationLabels: Record<string, string> = {
        exact: '标题与规格精确一致',
        mapping: '已有商品映射',
        manual: '本次人工确认',
      };
      return standardizationLabels[value] ?? value;
    }
    if (path.endsWith('.standardDisplayPreference')) {
      const preferenceLabels: Record<string, string> = {
        prefer_standard: '优先展示标准商品信息',
        prefer_source: '优先展示订单来源原文',
      };
      return preferenceLabels[value] ?? value;
    }
    if (path === 'platformTransactionStatus') {
      return platformTransactionStatusLabel(value as OrderDraft['platformTransactionStatus']);
    }
    if (path === 'fulfillmentStatus' || path === 'fulfillmentStatusConfirmation') {
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

/** 人工新增商品行的标准商品一次性带入选项；带入为快照，取消勾选不回滚已带入值。 */
type NewItemStandardImport = {
  productId: string;
  importName: boolean;
  importSpec: boolean;
  importPrice: boolean;
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
  api,
  details,
  screenshotUrl,
  saving,
  error,
  onDirtyChange,
  onCancel,
  onSave,
  onRefresh,
}: {
  api: DesktopApi;
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
  const [standardProducts, setStandardProducts] = useState<StandardProduct[] | null>(null);
  const [newItemStandardImports, setNewItemStandardImports] = useState<
    Record<number, NewItemStandardImport>
  >({});
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
    let active = true;
    void api.listStandardProducts()
      .then((listed) => {
        if (active) setStandardProducts(listed);
      })
      .catch((value: unknown) => {
        if (active) setLocalError(errorMessage(value));
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (!review) return undefined;
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : previewButtonRef.current;
    reviewFirstActionRef.current?.focus();
    return () => (returnFocus ?? previewButtonRef.current)?.focus();
  }, [review]);

  const amountPrompts = useMemo(() => {
    const prompts = new Map<number, OrderItemAmountPrompt>();
    const productTotalCents = yuanToCents(moneyInputs.productTotal);
    const amountCents = yuanToCents(moneyInputs.amount);
    const itemUnitPrices = moneyInputs.itemUnitPrices.map(yuanToCents);
    if (
      productTotalCents === null ||
      amountCents === null ||
      itemUnitPrices.some((value) => value === null)
    ) {
      return prompts;
    }
    const subtotals: number[] = [];
    for (const [index, item] of input.items.entries()) {
      const subtotal = itemUnitPrices[index]! * item.quantity;
      if (!Number.isSafeInteger(subtotal) || subtotal < 0) return prompts;
      subtotals.push(subtotal);
    }
    input.items.forEach((item, index) => {
      const baselineItem = item.id === null
        ? null
        : baselineInput.items.find((baseline) => baseline.id === item.id) ?? null;
      const before = baselineItem
        ? { unitPriceCents: baselineItem.unitPriceCents, quantity: baselineItem.quantity }
        : { unitPriceCents: 0, quantity: 1 };
      const after = { unitPriceCents: itemUnitPrices[index]!, quantity: item.quantity };
      if (before.unitPriceCents === after.unitPriceCents && before.quantity === after.quantity) {
        return;
      }
      const otherItemsSubtotalCents = subtotals.reduce(
        (total, subtotal, itemIndex) => (itemIndex === index ? total : total + subtotal),
        0,
      );
      try {
        prompts.set(index, planOrderItemAmountPrompt({
          before,
          after,
          productTotalCents,
          amountCents,
          otherItemsSubtotalCents,
        }));
      } catch {
        // 数量等输入暂时非法时不显示提示，保存前校验会给出错误。
      }
    });
    return prompts;
  }, [baselineInput.items, input.items, moneyInputs]);

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
    setNewItemStandardImports((current) => Object.fromEntries(
      Object.entries(current).flatMap(([key, entry]) => {
        const itemIndex = Number(key);
        if (!Number.isInteger(itemIndex) || itemIndex === index) return [];
        return [[itemIndex > index ? itemIndex - 1 : itemIndex, entry]];
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

  function selectNewItemStandardProduct(index: number, productId: string) {
    setLocalError('');
    setReview(null);
    if (!productId) {
      // 一次性快照：取消关联不回滚已带入的名称、规格或单价。
      setNewItemStandardImports((current) => {
        const next = { ...current };
        delete next[index];
        return next;
      });
      return;
    }
    const product = standardProducts?.find(({ id }) => id === productId);
    if (!product) return;
    const nextImport: NewItemStandardImport = {
      productId,
      importName: true,
      importSpec: true,
      importPrice: product.defaultOrderPriceCents !== null,
    };
    setNewItemStandardImports((current) => ({ ...current, [index]: nextImport }));
    applyNewItemImport(index, product, nextImport);
  }

  function changeNewItemImportOption(
    index: number,
    key: 'importName' | 'importSpec' | 'importPrice',
    checked: boolean,
  ) {
    const entry = newItemStandardImports[index];
    if (!entry) return;
    setNewItemStandardImports((current) => ({
      ...current,
      [index]: { ...entry, [key]: checked },
    }));
    if (!checked) return;
    const product = standardProducts?.find(({ id }) => id === entry.productId);
    if (!product) return;
    applyNewItemImport(index, product, {
      importName: key === 'importName',
      importSpec: key === 'importSpec',
      importPrice: key === 'importPrice',
    });
  }

  function applyNewItemImport(
    index: number,
    product: StandardProduct,
    options: { importName: boolean; importSpec: boolean; importPrice: boolean },
  ) {
    patchItem(index, {
      ...(options.importName ? { sourceTitle: product.name } : {}),
      ...(options.importSpec ? { sourceSpec: product.specification } : {}),
    });
    if (options.importPrice && product.defaultOrderPriceCents !== null) {
      patchItemMoney(index, formatMoneyInput(product.defaultOrderPriceCents));
    }
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
        ...(item.id === null
          ? { standardProductId: newItemStandardImports[index]?.productId ?? null }
          : {}),
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
        standardProducts ?? [],
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
      setNewItemStandardImports({});
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

            <FormSection title={`订单商品明细 · ${input.items.length}`} description="可增加、修改或删除商品，订单至少保留一件商品。">
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
                      {item.id === null && (
                        <div className="item-standard-import">
                          <Field label="标准商品">
                            <select
                              aria-label={`商品 ${index + 1} 标准商品`}
                              value={newItemStandardImports[index]?.productId ?? ''}
                              disabled={saving || standardProducts === null}
                              onChange={(event) => selectNewItemStandardProduct(
                                index,
                                event.target.value,
                              )}
                            >
                              <option value="">不关联标准商品</option>
                              {(standardProducts ?? []).map((product) => (
                                <option value={product.id} key={product.id}>
                                  {product.sku} · {product.name} · {product.specification}
                                </option>
                              ))}
                            </select>
                          </Field>
                          {(() => {
                            const entry = newItemStandardImports[index];
                            const product = entry
                              ? standardProducts?.find(({ id }) => id === entry.productId) ?? null
                              : null;
                            if (!entry || !product) return null;
                            return (
                              <div className="item-standard-import__options">
                                <label className="fields-check-row">
                                  <input
                                    type="checkbox"
                                    checked={entry.importName}
                                    disabled={saving}
                                    onChange={(event) => changeNewItemImportOption(
                                      index,
                                      'importName',
                                      event.target.checked,
                                    )}
                                  />
                                  <span>带入标准商品名</span>
                                </label>
                                <label className="fields-check-row">
                                  <input
                                    type="checkbox"
                                    checked={entry.importSpec}
                                    disabled={saving}
                                    onChange={(event) => changeNewItemImportOption(
                                      index,
                                      'importSpec',
                                      event.target.checked,
                                    )}
                                  />
                                  <span>带入标准规格</span>
                                </label>
                                {product.defaultOrderPriceCents !== null && (
                                  <label className="fields-check-row">
                                    <input
                                      type="checkbox"
                                      checked={entry.importPrice}
                                      disabled={saving}
                                      onChange={(event) => changeNewItemImportOption(
                                        index,
                                        'importPrice',
                                        event.target.checked,
                                      )}
                                    />
                                    <span>带入单价</span>
                                  </label>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                      {amountPrompts.has(index) && (() => {
                        const prompt = amountPrompts.get(index)!;
                        return (
                          <div
                            className="order-edit-amount-prompt"
                            role="status"
                            aria-label={`商品 ${index + 1} 金额提示`}
                          >
                            <p>
                              商品单价：{formatMoney(prompt.unitPrice.beforeCents)}
                              {' → '}
                              {formatMoney(prompt.unitPrice.afterCents)}
                            </p>
                            <p>
                              商品小计：{formatMoney(prompt.subtotal.beforeCents)}
                              {' → '}
                              {formatMoney(prompt.subtotal.afterCents)}
                            </p>
                            <p>
                              商品总价：{formatMoney(prompt.productTotal.beforeCents)}
                              {' → '}
                              {formatMoney(prompt.productTotal.suggestedCents)}（建议值）
                            </p>
                            <p>成交金额：保持不变</p>
                            {prompt.differsFromAmount && (
                              <p>商品明细合计与成交金额存在差异，可能存在优惠、议价或其他原因，请人工核对。</p>
                            )}
                            {prompt.productTotal.suggestedCents !==
                              prompt.productTotal.beforeCents && (
                              <button
                                className="button button--quiet"
                                type="button"
                                disabled={saving}
                                onClick={() => patchOrderMoney(
                                  'productTotal',
                                  'productTotalCents',
                                  formatMoneyInput(prompt.productTotal.suggestedCents),
                                )}
                              >
                                同步更新商品总价
                              </button>
                            )}
                          </div>
                        );
                      })()}
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
  api,
  details,
  screenshotUrl,
  selectedScreenshotId,
  sourceLoading,
  customFieldsSaving,
  orderEditSaving,
  statusLogisticsSaving,
  error,
  backLabel,
  onBack,
  onDirtyChange,
  onSelectSource,
  onSaveCustomFieldValues,
  onUpdateOrder,
  onUpdatePlatformTransactionStatus,
  onRefreshOrder,
  onLocateShipment,
  onOpenShipmentGroups,
}: {
  api: DesktopApi;
  details: OrderDetails;
  screenshotUrl: string;
  selectedScreenshotId: string;
  sourceLoading: boolean;
  customFieldsSaving: boolean;
  orderEditSaving: boolean;
  statusLogisticsSaving: boolean;
  error: string;
  backLabel: string;
  onBack: () => void;
  onDirtyChange: (kind: DetailDirtyKind) => void;
  onSelectSource: (screenshotId: string) => void;
  onSaveCustomFieldValues: (input: SaveCustomFieldValuesInput) => Promise<void>;
  onUpdateOrder: (input: OrderEditInput) => Promise<OrderDetails>;
  onUpdatePlatformTransactionStatus: (
    input: OrderPlatformTransactionStatusUpdateInput,
  ) => Promise<OrderDetails[]>;
  onRefreshOrder: (orderId: string) => Promise<OrderDetails>;
  onLocateShipment: (recordId: string, aftersalesCaseId?: string) => void;
  onOpenShipmentGroups: () => void;
}) {
  const { order } = details;
  const [editing, setEditing] = useState(false);
  const [standardizationItemId, setStandardizationItemId] = useState<string | null>(null);
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
        api={api}
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
          <button className="icon-button" type="button" onClick={onBack} aria-label={backLabel}>
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
            交易状态
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
        <p className="status-logistics-feedback status-logistics-feedback--detail" role="status" aria-label="平台交易状态维护结果">
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
              <DetailTerm label="系统订单编号" value={order.systemOrderNumber} />
              <DetailTerm label="平台" value={platformLabel(order.platform)} />
              <DetailTerm label="卖家账号" value={displayValue(order.sellerAccount)} />
              <DetailTerm label="订单号" value={order.orderNumber} />
              <DetailTerm label="支付宝交易号" value={displayValue(order.alipayTransactionNumber)} />
              <DetailTerm label="买家昵称" value={order.buyerNickname || '—'} />
              <DetailTerm
                label="回购情况"
                value={details.spending
                  ? repurchaseStatusLabel(details.spending.repurchaseRank)
                  : '未归属收件人'}
              />
              <DetailTerm
                label="下单人累计消费"
                value={details.spending ? formatMoney(details.spending.totalSpendCents) : '—'}
              />
              <DetailTerm
                label="下单人累计退款"
                value={details.spending ? formatMoney(details.spending.totalRefundCents) : '—'}
              />
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
              <DetailTerm label="可读编号" value={details.readableOrderNumber ?? '—'} />
              <DetailTerm
                label="履约计划"
                value={fulfillmentPlanAttributionLabel(
                  details.operations.fulfillmentPlanAttribution,
                )}
              />
              <DetailTerm label="生命周期状态" value={lifecycleStatusLabel(order.lifecycleStatus)} />
            </dl>
          </section>

          <section
            className="detail-section order-coordination"
            aria-label="订单当前处理"
          >
            <div className="detail-section-title">
              <div>
                <span className="section-kicker">统一运营投影</span>
                <h2>订单当前处理</h2>
              </div>
              <span>按期限、资金、实物和普通跟进排序</span>
            </div>
            {details.operations.coordination.primaryTodo ? (
              <div className="order-coordination-primary">
                <div>
                  <span className="order-coordination-label">当前待办</span>
                  <strong>{details.operations.coordination.primaryTodo.title}</strong>
                  <p>{details.operations.coordination.primaryTodo.detail}</p>
                </div>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => {
                    const { target } = details.operations.coordination.primaryTodo!;
                    onLocateShipment(
                      target.shipmentRecordId,
                      target.kind === 'aftersales_case' ? target.aftersalesCaseId : undefined,
                    );
                  }}
                >
                  去处理
                </button>
              </div>
            ) : (
              <p className="order-operations-empty">当前无需处理。</p>
            )}
            {details.operations.coordination.secondaryTodoCount > 0 && (
              <details className="order-coordination-secondary">
                <summary role="button">另有 {details.operations.coordination.secondaryTodoCount} 项</summary>
                <ul>
                  {details.operations.coordination.todos.slice(1).map((todo) => (
                    <li key={todo.id}>
                      <div>
                        <strong>{todo.title}</strong>
                        <small>{todo.detail}</small>
                      </div>
                      <button
                        className="button button--quiet"
                        type="button"
                        onClick={() => onLocateShipment(
                          todo.target.shipmentRecordId,
                          todo.target.kind === 'aftersales_case'
                            ? todo.target.aftersalesCaseId
                            : undefined,
                        )}
                      >
                        定位
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="order-coordination-block">
              <h3>未解决风险</h3>
              {details.operations.risks.length === 0 ? (
                <p className="order-coordination-clear">暂无未解决风险</p>
              ) : (
                <ul className="order-coordination-risks">
                  {details.operations.risks.map((risk) => (
                    <li key={risk.id}>
                      <strong>
                        {operationPackageRoleLabel(risk.packageRole)} · {risk.title}
                        {risk.exceptionType
                          ? ` · ${logisticsExceptionTypeLabel(risk.exceptionType)}`
                          : ''}
                      </strong>
                      <span>影响 {risk.affectedQuantity} 件</span>
                      {risk.items.map((item) => (
                        <span key={`${item.sourceTitle}\u0000${item.sourceSpec}`}>
                          {item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}
                          {' × '}{item.quantity}
                        </span>
                      ))}
                      <small>{risk.detail}</small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="order-coordination-block">
              <h3>并列事实概览</h3>
              {details.operations.facts.length === 0 ? (
                <p className="order-coordination-clear">暂无发货或售后事实</p>
              ) : (
                <dl className="order-coordination-facts">
                  {details.operations.facts.map((fact) => (
                    <div key={fact.id}>
                      <dt>{fact.label}</dt>
                      <dd>
                        <strong>{operationFactValueLabel(fact.kind, fact.value)}</strong>
                        <span>{fact.detail}</span>
                        <small>影响 {fact.affectedQuantity} 件</small>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {details.operations.history.length > 0 && (
              <details className="order-coordination-history">
                <summary role="button" aria-label="展开完整历史">
                  完整历史 · {details.operations.history.length} 条
                </summary>
                <ol>
                  {details.operations.history.map((entry) => (
                    <li key={entry.id}>
                      <time>{formatDateTime(entry.occurredAt)}</time>
                      <strong>{entry.title}</strong>
                      <span>{entry.detail}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>

          <section className="detail-section" aria-label="关联发货与包裹物流">
            <div className="detail-section-title">
              <h2>关联发货与包裹物流</h2>
              <span>{details.operations.shipmentRecords.length} 条发货记录 · 当前待办 {details.operations.currentTodo}</span>
            </div>
            {details.operations.shipmentRecords.length === 0 ? (
              <div className="order-operations-empty">
                <p>暂无关联发货记录；履约状态暂以订单来源为基础。</p>
                <button className="button button--quiet" type="button" onClick={onOpenShipmentGroups}>
                  前往发货组
                </button>
              </div>
            ) : (
              <div className="order-operations-list">
                {details.operations.shipmentRecords.map((record) => (
                  <article className="order-operations-card" key={record.id}>
                    <header>
                      <div>
                        <strong>发货记录</strong>
                        <small>{formatDateTime(record.createdAt)}</small>
                      </div>
                      <span>{record.status === 'voided' ? '已作废' : '有效记录'}</span>
                      <button
                        className="button button--quiet"
                        type="button"
                        onClick={() => onLocateShipment(record.id)}
                      >
                        定位发货记录
                      </button>
                    </header>
                    <div className="order-operations-packages">
                      {record.packages.map((shipmentPackage) => (
                        <section key={shipmentPackage.id}>
                          <div>
                            <strong>包裹 {shipmentPackage.position + 1}</strong>
                            <span>{shipmentPackage.status === 'cancelled'
                              ? '已撤销'
                              : shipmentLogisticsStatusLabel(shipmentPackage.logisticsStatus)}</span>
                          </div>
                          <p>{shipmentPackageLogisticsLabel(shipmentPackage)}</p>
                          {shipmentPackage.logisticsExceptions
                            .filter(({ stage }) => isUnresolvedLogisticsExceptionStage(stage))
                            .map((exception) => (
                            <p className="shipment-package-exception" key={exception.id}>
                              <strong>正向物流异常：{logisticsExceptionTypeLabel(
                                exception.exceptionType,
                              )} · {logisticsExceptionStageLabel(
                                exception.stage,
                              )}</strong>
                              <span>影响 {exception.affectedQuantity} 件</span>
                              <small>{exception.reason}</small>
                            </p>
                            ))}
                          {shipmentPackage.carrierClaimStatus && (
                            <small>承运索赔：{carrierClaimStatusLabel(
                              shipmentPackage.carrierClaimStatus,
                            )}</small>
                          )}
                          {shipmentPackage.cancellationReason && (
                            <small>撤销原因：{shipmentPackage.cancellationReason}</small>
                          )}
                          <ul>
                            {shipmentPackage.items.map((item) => (
                              <li key={item.shipmentPackageItemId}>
                                <span>{item.sourceTitle}</span>
                                <small>{item.sourceSpec ? `${item.sourceSpec} · ` : ''}× {item.quantity}</small>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="detail-section" aria-label="关联售后处理">
            <div className="detail-section-title">
              <h2>关联售后处理</h2>
              <span>{details.operations.aftersalesCases.length} 张处理单</span>
            </div>
            {details.operations.aftersalesCases.length === 0 ? (
              <p className="order-operations-empty">暂无关联售后处理。</p>
            ) : (
              <div className="order-operations-list">
                {details.operations.aftersalesCases.map((aftersalesCase) => (
                  <article className="order-operations-card" key={aftersalesCase.id}>
                    <header>
                      <div>
                        <strong>{aftersalesStatusLabel(aftersalesCase.status)}</strong>
                        <small>{formatDateTime(aftersalesCase.occurredAt)}</small>
                      </div>
                      <span>当前待办 {aftersalesCase.currentTodo}</span>
                      <button
                        className="button button--quiet"
                        type="button"
                        onClick={() => onLocateShipment(
                          aftersalesCase.shipmentRecordId,
                          aftersalesCase.id,
                        )}
                      >
                        定位售后处理单
                      </button>
                    </header>
                    <p>{aftersalesCase.reason}</p>
                    <ul className="order-operations-items">
                      {aftersalesCase.items.map((item) => (
                        <li key={item.shipmentPackageItemId}>
                          <span>{item.sourceTitle}</span>
                          <small>{item.sourceSpec ? `${item.sourceSpec} · ` : ''}× {item.quantity}</small>
                        </li>
                      ))}
                    </ul>
                    {aftersalesCase.returnPackages.length > 0 && (
                      <div className="order-operations-packages">
                        {aftersalesCase.returnPackages.map((returnPackage) => (
                          <section
                            key={returnPackage.id}
                            aria-label={`退货包裹 ${returnPackage.id}`}
                          >
                            <div>
                              <strong>退货运输 · {returnPackage.shippingCarrier} · {returnPackage.trackingNumber}</strong>
                              <span>{returnLogisticsStatusLabel(returnPackage.logisticsStatus)}</span>
                            </div>
                            {returnPackage.logisticsExceptions
                              .filter(({ stage }) => isUnresolvedLogisticsExceptionStage(stage))
                              .map((exception) => (
                              <div className="shipment-package-exception" key={exception.id}>
                                <strong>
                                  退货物流异常 · {logisticsExceptionTypeLabel(
                                    exception.exceptionType,
                                  )} · {logisticsExceptionStageLabel(
                                    exception.stage,
                                  )}
                                </strong>
                                <span>影响 {exception.affectedQuantity} 件</span>
                                <small>{exception.reason}</small>
                              </div>
                              ))}
                            <ul>
                              {returnPackage.items.map((item) => (
                                <li key={item.shipmentPackageItemId}>
                                  <span>{item.sourceTitle}{item.sourceSpec ? ` · ${item.sourceSpec}` : ''}</span>
                                  <small>
                                    计划 {item.plannedQuantity} · 收到 {item.receivedQuantity} · 通过 {item.acceptedQuantity}
                                  </small>
                                </li>
                              ))}
                            </ul>
                            {returnPackage.discrepancies.length > 0 && (
                              <p>
                                退货差异：{returnPackage.discrepancies.map((difference) => (
                                  `${returnDiscrepancyLabel(difference.kind)} ${difference.quantity} 件 · ${difference.note}`
                                )).join('；')}
                              </p>
                            )}
                            {returnQuantityDifferenceSummary(returnPackage).length > 0 && (
                              <p>
                                数量差异：{returnQuantityDifferenceSummary(returnPackage).join('；')}
                              </p>
                            )}
                            {returnPackage.carrierClaimStatus && (
                              <small>
                                承运索赔：{carrierClaimStatusLabel(returnPackage.carrierClaimStatus)}
                              </small>
                            )}
                          </section>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
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
              <h2>订单商品明细</h2>
              <span>{order.items.length} 项</span>
            </div>
            <div className="detail-items">
              {order.items.map((item, index) => (
                <div className="detail-item" key={item.id}>
                  <span className="item-index">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{displayedProductTitle(item)}</strong>
                    <small>{displayedProductSpecification(item) || '无规格'}</small>
                    <small>数量来源：{draftItemQuantitySourceLabel(item)}</small>
                    {item.standardProduct && (
                      item.standardDisplayPreference === 'prefer_source' ? (
                        <small>
                          标准商品：{item.standardProduct.sku} · {item.standardProduct.name}
                          {item.standardProduct.specification
                            ? ` · ${item.standardProduct.specification}`
                            : ''}
                        </small>
                      ) : (
                        <small>
                          来源原文：{item.sourceTitle}
                          {item.sourceSpec ? ` · ${item.sourceSpec}` : ''}
                          {`（${item.standardProduct.sku}）`}
                        </small>
                      )
                    )}
                  </div>
                  <span>{formatMoney(item.unitPriceCents)} × {item.quantity}</span>
                  <strong>{formatMoney(item.subtotalCents)}</strong>
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => setStandardizationItemId(item.id)}
                  >
                    关联标准商品
                  </button>
                </div>
              ))}
            </div>
          </section>
          {standardizationItemId && (() => {
            const standardizationItem = order.items.find(
              (item) => item.id === standardizationItemId,
            );
            if (!standardizationItem) return null;
            return (
              <UpdateOrderItemStandardizationDialog
                api={api}
                order={order}
                item={standardizationItem}
                onClose={() => setStandardizationItemId(null)}
                onSaved={async () => {
                  await onRefreshOrder(order.id);
                  setStandardizationItemId(null);
                }}
              />
            );
          })()}

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
                              {{
                                source_update: '截图确认更新',
                                manual_edit: '手动修改',
                                shipment_sync: '发货同步',
                              }[event.source]}
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
        <OrderPlatformTransactionStatusDialog
          orders={[order]}
          saving={statusLogisticsSaving}
          onClose={() => setMaintainingStatusAndLogistics(false)}
          onSave={onUpdatePlatformTransactionStatus}
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
  | 'settings'
  | 'user';

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
    user: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20c1.4-3.6 4.1-5.5 7.5-5.5s6.1 1.9 7.5 5.5" /></>,
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

function repurchaseStatusLabel(rank: number | null): string {
  if (rank === null) return '不适用';
  return purchaseBatchLabel(rank);
}

function shipmentExceptionEventDescription(
  event: ShipmentRecord['packages'][number]['logisticsExceptions'][number]['timeline'][number],
): string {
  if (event.kind === 'opened') {
    return `${logisticsExceptionStageLabel(event.stage)} · ${event.reason}`;
  }
  return `${logisticsExceptionStageLabel(event.beforeStage)} → ${logisticsExceptionStageLabel(event.afterStage)} · ${event.reason}`;
}

function shipmentExceptionAffectedItems(
  shipmentPackage: ShipmentRecord['packages'][number],
  exception: ShipmentRecord['packages'][number]['logisticsExceptions'][number],
): Array<{ id: string; sourceTitle: string; sourceSpec: string; quantity: number }> {
  if (exception.impact.scope === 'package') {
    return shipmentPackage.items.map((item) => ({
      id: item.id,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      quantity: item.quantity,
    }));
  }
  const quantityById = new Map(exception.impact.items.map(({ sourceItemId, quantity }) => (
    [sourceItemId, quantity] as const
  )));
  return shipmentPackage.items.flatMap((item) => {
    const quantity = quantityById.get(item.id);
    return quantity === undefined ? [] : [{
      id: item.id,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      quantity: Math.min(item.quantity, quantity),
    }];
  });
}

function shipmentClaimEventLabel(
  kind: NonNullable<ShipmentRecord['packages'][number]['carrierClaim']>['timeline'][number]['kind'],
): string {
  return {
    opened: '建立承运索赔',
    approved: '承运方同意赔付',
    rejected: '承运方拒绝赔付',
    compensation_confirmed: '确认实际赔付',
  }[kind];
}

function shipmentClaimEventDescription(
  event: NonNullable<ShipmentRecord['packages'][number]['carrierClaim']>['timeline'][number],
): string {
  if (event.kind === 'opened') {
    return `申请 ${formatMoney(event.requestedAmountCents)} · ${event.reason}`;
  }
  if (event.kind === 'approved') {
    return `同意 ${formatMoney(event.approvedAmountCents)} · ${event.reason}`;
  }
  if (event.kind === 'rejected') return event.reason;
  if (event.kind === 'compensation_confirmed') {
    return `实际赔付 ${formatMoney(event.amountCents)} · ${event.note}`;
  }
  return '';
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
  return FULFILLMENT_STATUS_LABELS[status];
}

function operationPackageRoleLabel(
  role: OrderDetails['operations']['risks'][number]['packageRole'],
): string {
  return {
    original_outbound: '正向包裹',
    return: '退货包裹',
    replacement: '补发包裹',
  }[role];
}

function operationFactValueLabel(
  kind: OrderDetails['operations']['facts'][number]['kind'],
  value: string,
): string {
  if (kind === 'outbound_logistics') {
    return shipmentLogisticsStatusLabel(value as ShipmentLogisticsStatus);
  }
  if (kind === 'return_logistics') {
    return returnLogisticsStatusLabel(value as AftersalesCase['returns'][number]['logisticsStatus']);
  }
  if (kind === 'aftersales') {
    return aftersalesStatusLabel(value as AftersalesCase['status']);
  }
  if (kind === 'logistics_exception') {
    return logisticsExceptionStageLabel(value as NonNullable<
      AftersalesCase['returns'][number]['currentException']
    >['stage']);
  }
  if (kind === 'carrier_claim') {
    return carrierClaimStatusLabel(value as NonNullable<
      AftersalesCase['returns'][number]['carrierClaim']
    >['status']);
  }
  if (kind === 'refund') {
    return { pending: '待确认', confirmed: '已退款', cancelled: '已取消' }[value] ?? value;
  }
  return value;
}

function hasShipmentHistory(status: FulfillmentStatus): boolean {
  return status === 'partially_shipped' || status === 'shipped' ||
    status === 'delivered';
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

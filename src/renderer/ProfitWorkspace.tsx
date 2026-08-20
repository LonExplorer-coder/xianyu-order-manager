import { useEffect, useState, type ReactNode } from 'react';

import type { DesktopApi } from '../core/desktop-api';
import {
  financeDirectionLabel,
  financeRecordTypeLabel,
} from '../core/funds';
import type {
  ProfitCostComponent,
  ProfitMoneyComponent,
  ProfitOrderRow,
  ProfitProductRow,
  ProfitReportView,
} from '../core/profit';
import { EmptyState, InlineError } from './DialogShell';
import { formatMoney, formatTime } from './FinanceFacts';

type ReportTab = 'orders' | 'products';

export function ProfitWorkspace({ api }: { api: DesktopApi }) {
  const [report, setReport] = useState<ProfitReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<ReportTab>('orders');
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.queryProfitReport()
      .then((result) => {
        if (!cancelled) setReport(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (loading) {
    return shell(<EmptyState title="正在计算利润…" status />);
  }

  if (error || !report) {
    return shell(<InlineError message={error || '利润视图不可用'} />);
  }

  return shell(
    <>
      <div className="funds-overview profit-overview" aria-label="利润汇总">
        <span>
          <strong>{formatMoney(report.totals.profitCents)}</strong>
          <small>已实现利润（订单合计）</small>
        </span>
        <span>
          <strong>{formatMoney(report.totals.pendingRemainingCents)}</strong>
          <small>待确认净额（未混入利润）</small>
        </span>
        <span>
          <strong>{formatMoney(report.totals.scrapCostCents)}</strong>
          <small>报废损失（商品合计）</small>
        </span>
        <span>
          <strong>{formatMoney(report.totals.othersNetCents)}</strong>
          <small>采购与其他净额（不进订单利润）</small>
        </span>
      </div>

      <div className="workspace-view-switch" role="tablist" aria-label="利润维度">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'orders'}
          className={tab === 'orders' ? 'is-active' : undefined}
          onClick={() => setTab('orders')}
        >
          订单利润
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'products'}
          className={tab === 'products' ? 'is-active' : undefined}
          onClick={() => setTab('products')}
        >
          商品汇总
        </button>
      </div>

      {tab === 'orders' ? (
        <>
          <h2>订单利润</h2>
          <p className="workspace-subtitle">
            每笔订单分别列示成交、结算、退款、费用、运费、采购成本与赔付；
            已实现利润 = 平台结算 + 承运理赔 − 退款 − 服务费 − 运费 − 其他 − 采购成本。
            待确认的钱单独一列，不混进利润。
          </p>
          {report.orders.length === 0 ? (
            <EmptyState title="还没有订单" hint="确认订单后这里会出现按订单计算的利润。" />
          ) : (
            <div className="table-frame">
              <table aria-label="订单利润">
                <thead>
                  <tr>
                    <th>订单</th>
                    <th>买家</th>
                    <th>成交金额</th>
                    <th>平台结算</th>
                    <th>退款</th>
                    <th>服务费</th>
                    <th>运费</th>
                    <th>赔付</th>
                    <th>其他</th>
                    <th>采购成本</th>
                    <th>已实现利润</th>
                    <th>待确认净额</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {report.orders.map((row) => (
                    <ProfitOrderRowView
                      key={row.orderId}
                      row={row}
                      expanded={expandedOrder === row.orderId}
                      onToggle={() => setExpandedOrder(
                        expandedOrder === row.orderId ? null : row.orderId,
                      )}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <h2>商品汇总</h2>
          <p className="workspace-subtitle">
            按标准商品汇总：成交按订单商品明细归集，订单资金按明细小计占比分摊；
            采购成本按加权平均单价乘净发出数量计算，报废损失单独列示。
            {report.unmapped.transactionCents > 0
              ? ` 未映射商品的份额（成交 ${formatMoney(report.unmapped.transactionCents)}、`
                + `分摊 ${formatMoney(report.unmapped.allocatedNetCents)}）单独列示，不冒充到任何商品。`
              : ''}
          </p>
          {report.products.length === 0 ? (
            <EmptyState title="还没有标准商品" hint="建立标准商品并完成采购后这里会出现商品毛利。" />
          ) : (
            <div className="table-frame">
              <table aria-label="商品汇总">
                <thead>
                  <tr>
                    <th>商品</th>
                    <th>平均采购单价</th>
                    <th>订单数</th>
                    <th>成交金额</th>
                    <th>分摊净额</th>
                    <th>净发出</th>
                    <th>发出成本</th>
                    <th>退货签收</th>
                    <th>报废数量</th>
                    <th>报废损失</th>
                    <th>毛利</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {report.products.map((row) => (
                    <ProfitProductRowView
                      key={row.standardProductId}
                      row={row}
                      expanded={expandedProduct === row.standardProductId}
                      onToggle={() => setExpandedProduct(
                        expandedProduct === row.standardProductId ? null : row.standardProductId,
                      )}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h2>采购与其他</h2>
      <p className="workspace-subtitle">
        采购付款、供应方退款与无来源的直接录入不进订单利润，在这里单独列示；
        商品成本只认采购订单确认的单价，付了多少钱看这里。
      </p>
      {report.others.length === 0 ? (
        <EmptyState title="采购与其他没有资金记录" hint="登记采购付款或直接录入费用后会出现在这里。" />
      ) : (
        <div className="table-frame">
          <table aria-label="采购与其他资金">
            <thead>
              <tr>
                <th>类型</th>
                <th>方向</th>
                <th>金额</th>
                <th>来源</th>
                <th>说明</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {report.others.map((component) => (
                <tr key={`${component.kind}-${component.id}`}>
                  <td>{financeRecordTypeLabel(component.type)}</td>
                  <td>{financeDirectionLabel(component.direction)}</td>
                  <td>{formatMoney(component.allocatedCents)}</td>
                  <td><span>{component.sourceLabel}</span></td>
                  <td><span>{component.note || '—'}</span></td>
                  <td>{formatTime(component.occurredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>,
  );

  function shell(children: ReactNode): ReactNode {
    return (
      <section className="profit-workspace workspace-enter" aria-label="利润">
        <header className="workspace-header">
          <div>
            <span className="section-kicker">利润·经营结果</span>
            <h1>利润</h1>
            <p className="workspace-subtitle">
              只计算、不改写事实：订单是主维度，商品是汇总下钻，发货记录与售后单只作来源；
              成交 ≠ 结算 ≠ 利润，没确认的钱不算已实现。
            </p>
          </div>
          <div className="toolbar">
            <span className="profit-generated-at">
              计算时间 {report ? formatTime(report.generatedAt) : '—'}
            </span>
          </div>
        </header>
        {children}
      </section>
    );
  }
}

function ProfitOrderRowView({
  row,
  expanded,
  onToggle,
}: {
  row: ProfitOrderRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td><span>{row.orderNumber}</span></td>
        <td><span>{row.buyerNickname}</span></td>
        <td>{formatMoney(row.transactionAmountCents)}</td>
        <td>{formatMoney(row.settlementNetCents)}</td>
        <td>{formatMoney(row.refundNetCents)}</td>
        <td>{formatMoney(row.platformFeeNetCents)}</td>
        <td>{formatMoney(row.freightNetCents)}</td>
        <td>{formatMoney(row.claimNetCents)}</td>
        <td>{formatMoney(row.miscNetCents)}</td>
        <td>{formatMoney(row.purchaseCostCents)}</td>
        <td><strong>{formatMoney(row.profitCents)}</strong></td>
        <td>{formatMoney(row.pendingRemainingCents)}</td>
        <td>
          <button className="button button--quiet" type="button" aria-pressed={expanded} onClick={onToggle}>
            {expanded ? '收起明细' : '展开明细'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="profit-detail-row">
          <td colSpan={13}>
            <div className="profit-detail">
              <h3>资金明细（可追溯到原记录）</h3>
              {row.moneyComponents.length === 0 ? (
                <p>该订单还没有资金记录。</p>
              ) : (
                <ul className="profit-component-list">
                  {row.moneyComponents.map((component) => (
                    <ProfitMoneyComponentLine
                      key={`${component.kind}-${component.id}`}
                      component={component}
                    />
                  ))}
                </ul>
              )}
              <h3>成本明细（发出与冲回）</h3>
              {row.costComponents.length === 0 ? (
                <p>该订单还没有发出商品，没有采购成本。</p>
              ) : (
                <ul className="profit-component-list">
                  {row.costComponents.map((component, index) => (
                    <ProfitCostComponentLine
                      key={`${component.kind}-${component.shipmentRecordId ?? ''}-${component.standardProductId}-${index}`}
                      component={component}
                    />
                  ))}
                </ul>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ProfitProductRowView({
  row,
  expanded,
  onToggle,
}: {
  row: ProfitProductRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <span>{row.name}</span>
          <small className="profit-product-meta">
            {row.sku}{row.specification ? ` · ${row.specification}` : ''}
          </small>
        </td>
        <td>{formatMoney(row.avgUnitCostCents)}</td>
        <td>{row.orderCount}</td>
        <td>{formatMoney(row.transactionCents)}</td>
        <td>{formatMoney(row.allocatedNetCents)}</td>
        <td>{row.dispatchedQuantity}</td>
        <td>{formatMoney(row.dispatchedCostCents)}</td>
        <td>{row.returnReceivedQuantity}</td>
        <td>{row.scrapQuantity}</td>
        <td>{formatMoney(row.scrapCostCents)}</td>
        <td><strong>{formatMoney(row.marginCents)}</strong></td>
        <td>
          <button className="button button--quiet" type="button" aria-pressed={expanded} onClick={onToggle}>
            {expanded ? '收起明细' : '展开明细'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="profit-detail-row">
          <td colSpan={12}>
            <div className="profit-detail">
              <h3>按订单分摊</h3>
              {row.allocations.length === 0 ? (
                <p>还没有订单使用该商品。</p>
              ) : (
                <ul className="profit-component-list">
                  {row.allocations.map((allocation) => (
                    <li key={allocation.orderId}>
                      <span>{allocation.orderNumber}</span>
                      <span>成交 {formatMoney(allocation.transactionCents)}</span>
                      <span>分摊净额 {formatMoney(allocation.allocatedNetCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <h3>成本与报废明细</h3>
              {row.costComponents.length === 0 ? (
                <p>该商品还没有发出或报废记录。</p>
              ) : (
                <ul className="profit-component-list">
                  {row.costComponents.map((component, index) => (
                    <ProfitCostComponentLine
                      key={`${component.kind}-${component.standardProductId}-${index}`}
                      component={component}
                    />
                  ))}
                </ul>
              )}
              <h3>采购概况</h3>
              <p>
                累计到货 {row.arrivedQuantity} 件；供应方退回 {row.supplierReturnedQuantity} 件；
                加权平均采购单价 {formatMoney(row.avgUnitCostCents)}（按查询时点计算）。
              </p>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ProfitMoneyComponentLine({ component }: { component: ProfitMoneyComponent }) {
  return (
    <li className={component.reference ? 'profit-component--reference' : undefined}>
      <span>
        {component.kind === 'pending' ? '待确认' : '已确认'}
        ·{financeRecordTypeLabel(component.type)}
        {component.reference ? '（成交参照，不参与利润）' : ''}
      </span>
      <span>{formatMoney(component.allocatedCents)}</span>
      <span>{component.sourceLabel}</span>
      <span>{component.note || '—'}</span>
      <span>{formatTime(component.occurredAt)}</span>
    </li>
  );
}

function ProfitCostComponentLine({ component }: { component: ProfitCostComponent }) {
  const kindLabel = component.kind === 'dispatch'
    ? '发出'
    : component.kind === 'recovery'
      ? '冲回'
      : '报废';
  return (
    <li>
      <span>{kindLabel}·{component.name || component.sku} × {component.quantity}</span>
      <span>{formatMoney(component.amountCents)}</span>
      <span>{component.sourceLabel}</span>
      <span>{component.reason || '—'}</span>
      <span>{formatTime(component.occurredAt)}</span>
    </li>
  );
}

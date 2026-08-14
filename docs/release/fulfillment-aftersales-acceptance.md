# 发货与售后闭环验收记录

- 对应任务：GitHub Issue #62
- 验收日期：2026-08-14
- 结论：暂未完成；发货与售后业务闭环已通过，但正式备份恢复能力尚未实现，不得宣告本阶段完成。

## 验收原则

1. 只接受真实 `LocalApplication + SQLite`、真实桌面会话或打包后可执行程序产生的可观察结果。
2. 不以内部函数调用、模拟界面数据或文档声明代替行为验收。
3. 任一必验项失败或依赖能力缺失，Issue #62 保持开启。

## 业务闭环证据

| 验收项 | 结果 | 自动化证据 |
| --- | --- | --- |
| 发货后原订单变化，但发货快照不变 | 通过 | `test/shipment-records.test.ts` “原订单后来改变时保留发货快照并列出差异” |
| 已签收后退回指定商品数量，实际退款可小于申请额 | 通过 | `test/shipment-records.test.ts` “退货退款按退货运输、收到、检查和实际退款的独立事实推进” |
| 换货不覆盖原发货，并产生独立补发记录 | 通过 | `test/aftersales-replacements.test.ts` “换货收到并检查后建立独立补发记录…” |
| 直接补发后再次退换或补发 | 通过 | `test/aftersales-replacements.test.ts` “直接补发无需退货，并可把有问题的补发记录作为下一轮来源” |
| 拦截成功与实物退回分开记录 | 通过 | `test/outbound-exception-aftersales.test.ts` “拦截成功不等于实物退回…” |
| 丢件后退款、补发和承运索赔可分别推进 | 通过 | `test/outbound-exception-aftersales.test.ts` “按异常影响商品选择退款并补发…”与“补发与退款分开推进…” |
| 预置流程、自定义流程和模板版本不改写历史 | 通过 | `test/aftersales-workflow-templates.test.ts` 预置流程、自定义版本、处理单冻结版本及 v37→v38 迁移回归 |
| 关闭后重开仍读取售后当前值和完整时间线 | 通过 | `test/shipment-records.test.ts` “重启后重新读取售后当前值与完整处理时间线” |
| 打包后便携程序读回订单、截图、发货、物流、售后和实际退款历史 | 待同提交双平台流水线 | `test/portable-release-smoke.test.ts` 与打包后 `verify:portable` |
| 正式备份验证、恢复及失败回滚 | **阻塞** | 产品第三阶段 Issue #25 尚未实现；手工复制数据目录不代替正式备份恢复验收 |

## 本机结果

```text
pnpm vitest run \
  test/shipment-records.test.ts \
  test/aftersales-replacements.test.ts \
  test/outbound-exception-aftersales.test.ts \
  test/aftersales-workflow-templates.test.ts \
  test/portable-release-smoke.test.ts

5 files passed, 109 tests passed
```

## 剩余操作

1. 用包含本验收冒烟的最终提交在 macOS arm64 和 Windows x64 分别执行完整检查、打包和压缩包解压重启冒烟。
2. 完成 Issue #25 后，从一个系统创建和验证备份，在另一系统恢复，重新读取本文所列的完整业务历史。
3. 两项全部通过后才能勾选 Issue #62 并关闭发货售后阶段。

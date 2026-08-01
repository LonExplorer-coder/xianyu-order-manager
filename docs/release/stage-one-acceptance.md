# 第一阶段核心可用版私有验收

本流程用于关闭 GitHub Issue #14：用至少 30 张不进入版本库的真实闲鱼订单截图，对同一个待发布提交完成一次可复现的付费识别、离线计分和双平台交付验收。它不替代日常自动化测试，也不允许把真实截图、金标值、OCR 原文或本机路径写入公开报告。

## 发布门槛

只有以下条件同时满足，第一阶段才可标记为通过并进入第二阶段：

1. 可控 OCR 工作流已覆盖上传、队列恢复、确定性校验、人工校对或自动入库、重复处理、已入库订单编辑、表格模板和 Excel 导出。
2. 多商品订单可以编辑；重启后当前值和最小修改记录仍在，原始来源截图与来源快照不被改写。
3. 开发调试先使用约 10 张真实截图覆盖主要版式；正式数据集应达到至少 30 张真实截图和至少 30 个不同的图片 SHA-256，并至少包含一个多商品案例和两个重复订单组。所有图片、清单和捕获结果全部留在仓库的 `private-data/` 忽略目录。
4. 订单号、手机号、成交金额必须正确，或因真实的格式、缺失、冲突等业务原因被系统安全拦截；不得静默写入错误值。
5. 其余金标中可见且应识别的原子字段准确率至少为 95%。金标中的 `""`、`null` 和 `unknown` 代表不适用：系统也留空时不进入分母，系统从不可见区域臆造非空值时仍计为错误。
6. 每单商品条目数必须正确或被安全拦截，同一订单的重复截图不得形成多笔正式订单。
7. 同一提交的完整 CI、私有验收报告、macOS 与 Windows 便携版及其机器可读证据全部通过。

仅因用户关闭“自动入库”而进入待确认，不是业务校验拦截。若字段识别错误，而唯一原因是 `automatic_import_disabled`，验收仍把它计为静默错误；只有识别失败，或待确认记录同时带有至少一个实质校验原因且没有错误入库时，才算“安全拦截”。

## 私有目录

仓库根目录下固定使用以下布局。`private-data/` 已被 `.gitignore` 整体忽略；不要改用个人用户名、客户名称、订单号或收件人作为目录和文件名。

```text
private-data/stage-one/
├── manifest.json
├── images/
│   ├── 001.png
│   ├── 002.jpg
│   └── …
└── runs/
    └── 2026-08-01T120000Z-<随机标识>/
        ├── capture.json
        ├── workspace/
        └── config/
```

- 图片名只使用无含义的连续编号；清单中的 `screenshot` 必须是相对 `manifest.json` 所在目录的安全相对路径。
- 每次付费捕获创建新的 `runs/<时间>-<随机标识>/`，不覆盖旧结果；其中的隔离工作区、临时配置和捕获文件都属于私有数据，不作为 GitHub Release 附件。离线生成的匿名聚合报告写入已忽略的构建输出目录，不与私有输入混放。
- `screenshotSha256` 必须从图片原始字节计算。至少 30 个不同指纹是硬门槛；相同文件的再次上传只能作为额外案例，不能充当新的独立样本。

离线计分固定生成 `out/release-evidence/stage-one-acceptance.json` 和 `out/release-evidence/stage-one-acceptance.md`。`out/` 同样被忽略；这两份文件虽然不含订单原值，仍须经过下文的人工隐私复查后才能作为发布证据。

## `manifest.json` 结构

清单顶层使用 `schemaVersion: 1`，案例对象不重复版本字段。完整字段如下：

| 路径 | 类型 | 语义 |
| --- | --- | --- |
| `schemaVersion` | `1` | 当前清单版本。 |
| `datasetId` | 字符串 | 不含隐私的稳定数据集标识，只能用字母、数字、点、下划线或连字符。 |
| `datasetVersion` | 字符串 | 此次金标版本，例如日期。 |
| `cases[]` | 数组 | 至少 30 个案例；每个 `id` 唯一。 |
| `cases[].id` | 字符串 | 匿名案例编号，例如 `case-001`。 |
| `cases[].screenshot` | 字符串 | 清单目录内的相对图片路径；禁止绝对路径和 `..`。 |
| `cases[].screenshotSha256` | 字符串 | 图片原始字节的 64 位小写十六进制 SHA-256。 |
| `cases[].tags[]` | 字符串数组 | 场景标签，仅描述版式和能力，不写业务或个人信息。 |
| `cases[].duplicateGroup` | 可选字符串 | 同一真实订单的不同截图使用相同组号；一个组至少两个案例。 |
| `cases[].expected` | 对象 | 人工逐项核对后的订单金标。 |
| `expected.orderNumber` | 字符串 | 订单号；正式案例必须存在。 |
| `expected.phoneNormalized` | 11 位字符串 | 规范化中国大陆手机号；正式案例必须存在。 |
| `expected.amountCents` | 非负整数 | 成交金额，单位为分；正式案例必须存在。 |
| `expected.alipayTransactionNumber` | 字符串 | 支付宝交易号；截图不可见时为 `""`。 |
| `expected.buyerNickname` | 字符串 | 买家昵称；截图不可见时为 `""`，不得拿收件人补齐。 |
| `expected.recipient` | 字符串 | 仅收件人姓名；不可见时为 `""`，不得包含手机号或按钮文字。 |
| `expected.addressOriginal` | 字符串 | 截图中的完整地址原文；不可见时为 `""`。 |
| `expected.addressNormalized` | 字符串 | 规则规范化后的完整地址；无法可靠得到时为 `""`。 |
| `expected.province` / `city` / `district` | 字符串 | 省、市、区县各自独立值；不可见或无法可靠拆分时为 `""`。 |
| `expected.orderedAtNormalized` / `paidAtNormalized` | 字符串 | 北京时间规范化值；不可见时为 `""`。 |
| `expected.productTotalCents` | 非负整数或 `null` | 商品总价，单位为分；明确显示零元写 `0`，截图不可见写 `null`。 |
| `expected.shippingFeeCents` | 非负整数或 `null` | 运费，单位为分；明确显示零元写 `0`，截图不可见写 `null`。 |
| `expected.platformTransactionStatus` | 枚举 | `paid`、`cancelled`、`refunded` 或 `unknown`。 |
| `expected.fulfillmentStatus` | 枚举 | `pending_shipment`、`shipped` 或 `unknown`。 |
| `expected.items[]` | 非空数组 | 按截图从上到下的商品顺序填写，不合并相同商品。 |
| `items[].sourceTitle` / `sourceSpec` | 字符串 | 商品标题和款式/规格；不可见部分写 `""`，不猜测。 |
| `items[].unitPriceCents` | 非负整数或 `null` | 商品单价，单位为分；不可见写 `null`。 |
| `items[].quantity` | 大于等于 1 的整数 | 明确显示数量时按截图填写；未显示时按产品规则记为 `1`。 |

所有字符串都按截图和产品规则精确填写。`""` 表示字符串目标不可见或无法可靠确定；`null` 只用于允许缺失的金额，不能与零元混用。规范化时间不转成 UTC：闲鱼页面无时区的下单时间和付款时间均按 `Asia/Shanghai` 解释，写成 `YYYY-MM-DDTHH:mm:ss+08:00`，例如 `2026-08-01T10:00:08+08:00`。

下面是完整但纯合成、已脱敏的示例。它只演示格式，不能作为真实验收样本或复制成 30 份：

```json
{
  "schemaVersion": 1,
  "datasetId": "stage-one-private",
  "datasetVersion": "2026-08-01",
  "cases": [
    {
      "id": "case-001",
      "screenshot": "images/001.png",
      "screenshotSha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "tags": [
        "expanded",
        "multi-item",
        "quantity-visible",
        "ad-below",
        "platform-paid",
        "fulfillment-pending-shipment"
      ],
      "expected": {
        "orderNumber": "SYNTHETIC-ORDER-0001",
        "phoneNormalized": "13000000000",
        "amountCents": 1600,
        "alipayTransactionNumber": "SYNTHETIC-TRADE-0001",
        "buyerNickname": "测***家",
        "recipient": "测试收件人",
        "addressOriginal": "示例省示例市示例区测试路1号",
        "addressNormalized": "示例省示例市示例区测试路1号",
        "province": "示例省",
        "city": "示例市",
        "district": "示例区",
        "orderedAtNormalized": "2026-08-01T10:00:00+08:00",
        "paidAtNormalized": "2026-08-01T10:00:08+08:00",
        "productTotalCents": 1600,
        "shippingFeeCents": 0,
        "platformTransactionStatus": "paid",
        "fulfillmentStatus": "pending_shipment",
        "items": [
          {
            "sourceTitle": "合成测试商品甲",
            "sourceSpec": "白色 / 标准款",
            "unitPriceCents": 800,
            "quantity": 2
          },
          {
            "sourceTitle": "合成测试商品乙",
            "sourceSpec": "",
            "unitPriceCents": null,
            "quantity": 1
          }
        ]
      }
    }
  ]
}
```

若要测试同订单去重，应给同一订单的两个或更多案例增加相同的 `duplicateGroup`，例如 `duplicate-order-01`；每张不同截图仍保留自己的 `id`、路径和真实指纹。不要给只有一个案例的组号。

## 样本覆盖建议

30 个不同指纹只是最低数量，不代表场景已经充分。案例可同时带多个标签，建议在选择样本时检查以下矩阵：

- 展开和折叠的订单详情都应有多例，不能只使用一种高度或一种手机截图尺寸。
- 单商品与多商品都要覆盖；多商品应包含不同款式/规格、不同单价和不同数量组合。
- 数量明确显示与数量隐藏都要覆盖，并分别核对真实数量和默认 `1` 的行为。
- 订单内容下方带推广卡片、其他商品或长页面噪声的样本要有多例，确认推广内容不会进入订单字段。
- 平台交易状态至少覆盖数据集中真实可取得的已付款、已取消、已退款及无法可靠确定；履约状态至少覆盖待发货、已发货及无法可靠确定。不要为了凑状态伪造金标。
- 至少设置两个重复组，每组包含同一订单的两张不同截图；组内每张截图都必须解析到同一个 `persistedOrderId`，并且至少出现一次首次入库和一次重复跳过。完全相同文件的付费前跳过可另加案例验证，但不能减少 30 个不同指纹的要求。
- 同时分散截图清晰度、文本长度、地址长度、买家昵称是否显示、成交价与商品总价是否相同、运费为零或非零等变化，避免 30 张图片只是同一版式的小幅复制。

建议先列出标签计数并人工审查覆盖，再触发付费识别；验收工具强制数量、指纹、至少一个多商品案例、至少两个重复组、字段门槛和重复组结果，但不会把其他标签名称自动当作质量证明。

## 运行步骤

1. 在待发布提交上保持工作树干净，完成 `manifest.json` 和逐项人工金标。先确认所有图片路径、指纹和字段语义，再开始付费调用。
2. 运行付费捕获。命令中的确认参数用于明确同意按清单调用百炼 OCR，以及当前设置中已经启用的候选裁决服务：

   ```bash
   pnpm acceptance:stage-one:capture -- --manifest private-data/stage-one/manifest.json --confirm-paid-services
   ```

   捕获器默认读取本机应用已经保存的 OCR 与候选裁决配置，并在调用前列出本次可能产生费用的服务；若当前环境无法自动定位，可额外传入 `--config-dir <应用配置目录>`。不要把 API Key 写进命令、清单或环境示例。付费确认后若清单字节发生变化，运行会立即停止；捕获前还会把已核验图片复制到本次私有运行目录，再从不可变副本逐张提交，避免长时间运行中原文件被替换。

3. 捕获文件必须记录清单原始字节的 SHA-256、应用版本、Git 提交、工作树是否干净、模型、地域、捕获时间，以及每个匿名案例的结果、拦截原因和最终订单标识。未实际提交的后续案例保持缺失并使验收失败，不能伪装成安全业务拦截。不要手工改写捕获文件。
4. 对同一份清单和捕获结果离线计分；下例中的路径替换为该次私有运行目录：

   ```bash
   pnpm acceptance:stage-one:verify -- \
     --manifest private-data/stage-one/manifest.json \
     --capture private-data/stage-one/runs/<本次运行>/capture.json
   ```

5. 离线验证还会拒绝清单哈希不匹配、脏工作树捕获、缺少观察结果、图片指纹不一致、关键字段静默错误、低于 95% 的普通字段准确率、商品条目数静默错误和重复组形成多笔订单。退出码为非零时不得发布。

   默认输出为 `out/release-evidence/stage-one-acceptance.json` 和 `out/release-evidence/stage-one-acceptance.md`；如需临时输出到其他已忽略目录，可额外传入 `--output-dir <目录>`。

付费捕获只负责从真实应用流程生成不可篡改的观察结果；离线计分不联网，可在修正文档或检查报告时重复运行，但不能通过修改金标来迎合错误识别。若金标本身有误，应由第二人对照截图复核并升级 `datasetVersion`，然后重新捕获。

## 隐私与公开证据

- `images/`、`manifest.json`、`capture.json` 和整个私有 `runs/` 都包含或可关联真实订单，永远不提交、不上传 CI、不附加到 Issue 或 GitHub Release。
- 对外报告只能包含应用版本、Git 提交、模型与地域、由清单哈希生成的数据集匿名标识、样本数、聚合得分、重新编号后的 `case-001` / `group-001` 和字段路径；不能包含清单中的原始数据集名、案例名、重复组名、图片路径、字段原值、OCR 原文、本机目录或可逆哈希之外的关联信息。
- 发布前人工打开 JSON 和 Markdown 报告检查一次。发现姓名、手机号、地址、订单号、交易号、截图路径或 OCR 原文即停止发布并清理附件。
- 清单 SHA-256 用于证明报告对应哪一版私有金标，不用于公开恢复或识别具体订单。

## 固定提交发布顺序

1. 选定一个工作树干净的 Git 提交，之后所有证据都必须引用它。
2. 该提交的完整 CI 全部通过。
3. 使用该提交完成私有付费捕获和离线计分，匿名报告结论为通过。
4. 从同一提交构建并验证 macOS 与 Windows 便携 ZIP，记录版本、提交、SHA-256 和机器可读证据，并完成人工平台验收。
5. 在工作树仍然干净时，把私有验收聚合报告、两份便携版证据和实际 ZIP 交给最终发布校验器。路径按本次产物位置替换：

   ```bash
   pnpm acceptance:stage-one:release -- \
     --ci-run <同一提交成功的 GitHub Actions CI 运行编号> \
     --acceptance out/release-evidence/stage-one-acceptance.json \
     --mac-evidence out/release-evidence/portable-darwin-arm64.json \
     --mac-archive out/make/zip/darwin/arm64/XianyuOrderManager-darwin-arm64-<版本>.zip \
     --windows-evidence <Windows 证据目录>/portable-win32-x64.json \
     --windows-archive <Windows 产物目录>/XianyuOrderManager-win32-x64-<版本>.zip
   ```

   校验器会通过已登录的 `gh` 核验 CI 运行确属同一提交，且 `macos-latest`、`windows-latest` 两项均完成并成功；同时重新计算两个 ZIP 的 SHA-256，并拒绝验收统计、版本、提交、文件名、平台、架构、便携验收项或当前工作树状态不一致的证据。通过后生成 `out/release-evidence/stage-one-release.json` 和 `out/release-evidence/stage-one-release.md`。
6. 复查公开附件不含私有数据，再创建 GitHub Release，附上两个便携 ZIP、校验和、便携版验收证据、匿名第一阶段报告和最终发布证据。

只要代码、依赖、构建配置或资源发生变化，就产生了新提交，必须从第 1 步重新执行；不得把旧私有报告或旧平台产物拼接到新版本上。

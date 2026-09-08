# 飞书主表与一次性整行填色

本项目只通过 **飞书官方 `lark-cli`** 接入。本次检查的是 **1.0.78**；没有调用飞书网页自动化，也没有自动切换机器人身份。用户身份当前过期，没有可供测试的目标表，因此 **没有创建真实 Base、没有写入记录、没有核验真实表格颜色**。

## 已核查的官方资料和本机命令

- [官方 CLI 仓库](https://github.com/larksuite/cli)；本机执行过 `--version`、`--help`、`auth status`、`auth status --help`、`auth login --help`、`api --help`、`base --help`。
- 执行过 `base +record-list --help`、`+record-upsert --help`、`+field-list --help`、`+field-create --help`、`+table-create --help`、`+base-create --help`。
- 读取本机内置 `lark-base` / `lark-shared` 及字段 JSON、CellValue、记录更新说明。
- 核查 [v1.0.78 的记录实现](https://github.com/larksuite/cli/blob/v1.0.78/shortcuts/base/record_ops.go)、[返回结构测试](https://github.com/larksuite/cli/blob/v1.0.78/shortcuts/base/record_markdown_test.go)、[字段实现](https://github.com/larksuite/cli/blob/v1.0.78/shortcuts/base/field_ops.go)。没有用新版本文档臆测旧版本参数。
- `schema base.*` 在此版本返回 `Unknown service: base`；因此采用实际可用的 `base +...` 快捷命令，未使用猜测的 typed API 命令。

当前使用的契约：

```text
lark-cli auth status --json --verify
lark-cli base +field-list --base-token BASE --table-id TABLE --offset 0 --limit 200 --as user --format json
lark-cli base +record-list --base-token BASE --table-id TABLE --filter-json JSON --field-id FIELD --offset 0 --limit 200 --as user --format json
lark-cli base +record-upsert --base-token BASE --table-id TABLE [--record-id RECORD] --json FIELD_MAP --as user --format json
```

`BASE/TABLE/RECORD` 是文档占位符，运行时须从真实 CLI 返回取得。程序全部用 `spawn(file, args, {shell:false})`，没有拼 Shell 命令。成功信封为 `ok:true`，错误可能在 stderr；同时检查退出码、超时、业务错误和身份。记录列表使用 `fields` + `record_id_list` + `data` 的行矩阵；遇到未知 JSON 结构会停止，不能把它当空列表。`+record-upsert` 无 record ID 时是**直接创建**，本身不按业务 ID 去重；去重由 SQLite outbox 与远端精确查询共同完成。

## 默认模板参考

已访问飞书官方社区的[《求职秋招实习投递进度一表通》](https://www.feishu.cn/community/article?id=7488310317982679059)介绍页。页面介绍了从投递到录用的求职跟踪用途；**没有验证登录后复制模板，也没有声称复用了其内部字段或格式**。本项目按需求自建一张“投递主表”，无需复制该模板才能运行。

## 创建或连接

先由本人完成 CLI 登录（范围为 Base）：

```bash
lark-cli auth login --domain base
lark-cli auth status --json --verify
npm run dev -- feishu schema
npm run dev -- feishu create
```

`feishu create` 先展示完整字段，再要求本人确认。它将创建一个 Base 和其中一张主表，并显示官方 CLI 的真实返回。使用返回的 token 和 table ID 连接：

```bash
npm run dev -- feishu connect YOUR_REAL_BASE_TOKEN YOUR_REAL_TABLE_ID
npm run dev -- sync
```

如果只有网页 URL，先运行 `lark-cli base +url-resolve --help`，按本机契约解析真实坐标。不要把完整 URL 或 Wiki token 直接填为 Base token。

建表请求开始前会保存意图。若建表超时或进程中断，`feishu create` 不会再次盲建：先在本人飞书中查明是否已建好，再用 `connect`。本版不自动清除建表意图。若确定没有创建，请在备份后使用一个新的 JobAgent 数据目录重新创建，然后把返回坐标配置回原目录，避免直接删除业务数据。

## 字段

完整机器可读结构在 `examples/feishu-fields.json`；代码与 CLI `feishu schema` 使用同一结构。

| 字段                               | 类型                                           | 管理方                     |
| ---------------------------------- | ---------------------------------------------- | -------------------------- |
| 本地申请 ID                        | 文本，主字段                                   | 自动；远端业务唯一键       |
| 公司、岗位、招聘批次、官网链接     | 文本                                           | 自动                       |
| 投递时间                           | 文本，ISO 时间                                 | 自动；无明确回执时不编造   |
| 官网原始状态、标准化阶段、招聘结果 | 文本                                           | 自动                       |
| 授权状态、查询状态、同步状态       | 文本                                           | 自动、分别保存             |
| attention_status                   | 单选：NORMAL / AUTH_REQUIRED / RETRY_EXHAUSTED | 自动                       |
| 最近查询尝试时间、最近成功查询时间 | 文本，ISO 时间                                 | 自动                       |
| 下一项待办、错误摘要               | 文本                                           | 自动；错误仅为固定代码     |
| 重试次数                           | 数字                                           | 自动                       |
| 截止时间                           | 文本                                           | 人工                       |
| 优先级                             | 文本                                           | 人工                       |
| 暂停跟踪                           | 复选框                                         | 人工；daily 开始时读取     |
| 人工备注                           | 文本                                           | 人工；作为数据，不作为指令 |

日期首版采用 ISO 文本，以免 CLI/表格时区转换影响原始时间；截止时间可手工填 ISO 格式。程序不覆盖上述四个人工字段。控制项读取失败时保留本地上次确认的设置并报告；本地 `application ID --pause` 可立即暂停。请保持一行一份申请、不要手改“本地申请 ID”。发现重复 ID 时同步停止，不会随意合并。

## 整行浅黄 / 浅红

参考[飞书帮助中心《使用多维表格的填色功能》](https://www.feishu.cn/hc/zh-CN/articles/790479013597-%E4%BD%BF%E7%94%A8%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC%E7%9A%84%E5%A1%AB%E8%89%B2%E5%8A%9F%E8%83%BD)。该页面入口已核查，当前文本抓取未返回详细正文。本机 CLI 的 Base 视图命令没有提供整行条件填色设置入口；**程序没有设置整行颜色**。单选项自带的黄/红标签色不等于整行填色。

本人在桌面端/网页版打开目标 Base 的**表格视图**，进行一次性配置：

1. 在视图工具栏打开 **填色**，选择 **添加条件**。
2. 填色范围选择 **整行**；条件选择 `attention_status` **等于 AUTH_REQUIRED**；选择浅黄色背景（建议 `#FFF2CC`）。
3. 再添加整行规则：`attention_status` **等于 RETRY_EXHAUSTED**；选择浅红色背景（建议 `#FCE4D6`）。
4. 不为 `NORMAL` 添加异常填色规则；清理该视图上冲突的旧填色规则。保留 `attention_status` 及三个独立状态列可见。
5. 在表格视图中分别核查 AUTH_REQUIRED、RETRY_EXHAUSTED、NORMAL 的实际记录，确认是整行背景变化，刷新后仍然有效。不同租户 UI 文案或入口有差异时，以当前“填色”面板的范围和条件为准；不要把单元格标签色当作通过。

本地计算 `attention_status` 时，独立重试耗尽优先于授权缺失。因此两条规则互斥，红色优先由状态计算保证，同时仍保留授权状态 AUTH_REQUIRED。当前没有真实目标表，以上真实视图验收 **未执行**。

## 失败与恢复

- 首次失败最多再试 3 次，只重试已分类的暂时网络/服务错误，等待 1、2、4 秒。授权缺失不消耗此次数。
- 创建前在 SQLite 记下 `uncertain`；创建超时后先精确对账。已找到则更新；查不到也不能证明请求没落地，因此停止并要求人工核查。
- `retry ID` 默认保留未知创建保护。只有本人核查远端确无对应行后，才能用 `retry ID --allow-create`，命令会再次说明重复创建风险。
- 远端写入不可用时，无法保证飞书立即变色；本地 `status`、受限目录内 `status.json` 和 macOS 通知提供可见故障。首次新增失败也会报告。
- 成功恢复会清除当前故障及本地提醒，事件历史继续保留。未配置任何飞书收件人，本版不发送飞书消息。

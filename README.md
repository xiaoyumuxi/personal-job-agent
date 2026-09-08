# 个人网申助手 MVP

现已接入 macOS Electron 客户端：三页中文界面、任务详情抽屉、登录接管、资料补充和安全暂停，复用下面的 CLI 与同一份本地数据。

- 开发启动：`npm run desktop:dev`
- 本机构建：`npm run desktop:package` → `release/JobAgent-darwin-<本机架构>/JobAgent.app`
- [客户端使用说明与安全边界](docs/desktop.md) · [实际验收记录](docs/desktop-verification.md)

一个可运行的单项目 TypeScript CLI：**导入资料 → 本人确认 → 导入岗位 → 专用 Chrome 登录 → 辅助填写 → 本人审核提交 → 查询官网进度 → 同步飞书**。本地使用 SQLite，敏感资料使用 macOS Keychain，浏览器认证由 Chrome 原生保存，调度使用 launchd。

这版已有真实 URL 通用填写入口，以及配置驱动的站点进度读取。**没有预置声称经过验证的真实招聘网站适配器**。仓库中的 `fixture` 仅是复杂表单测试站点；真实网站需要本人提供 URL、正常登录，并为查询配置准确选择器。没有模型 Key、飞书授权或站点配置，也能运行本地导入、确认、状态查看和测试。最终提交始终由本人点击。

## 安装与启动

要求：macOS、Node.js **24+**、Google Chrome。Keychain 辅助程序需要 Xcode Command Line Tools（`xcode-select --install`，若未安装）。不需要 Docker、浏览器扩展或额外数据库服务。

```bash
npm ci
npm run build
npm run dev -- init
npm run dev -- doctor
```

若 npm 的默认缓存目录存在权限问题，可使用 `npm ci --cache /private/tmp/jobagent-npm-cache`，不必修改全局目录权限。

开发运行使用 `npm run dev -- <命令>`；构建后可以用 `node dist/src/cli.js <命令>`。无需全局安装 CLI。完整命令说明：

```bash
npm run dev -- --help
```

默认数据目录：

```text
~/Library/Application Support/JobAgent/
  config.json          非敏感配置
  state.sqlite         岗位、申请、观测、任务、outbox、映射、事件
  chrome-profile/      应用专用 Chrome 用户数据，认证仅由 Chrome 管理
  attachments/         简历附件（随机文件名，受限权限）
  status.json          本地异常报告
  logs/                launchd 输出
  keychain-helper      本地编译的 Security.framework 辅助程序
```

目录权限 `0700`，数据文件 `0600`。`--home <目录>` 或 `JOBAGENT_HOME` 可指定隔离实例；该实例始终使用自己的 `chrome-profile`，禁止指向日常 Chrome 用户资料。资料值与 API Key 在 Keychain，SQLite 只保存资料引用；没有 Cookie 导入导出或额外 Cookie 数据库。Keychain 失败时明确报错。

## 首次使用：导入和确认资料

```bash
npm run dev -- profile import /absolute/path/resume.pdf
npm run dev -- profile confirm
npm run dev -- profile show
npm run dev -- profile set basic.name
npm run dev -- profile set basic.email
```

支持文本型 PDF、TXT/MD、粘贴文本和结构化 JSON。`profile import --paste` 进入多行粘贴，单独输入 `.end` 结束。PDF 用本地 PDF.js 提取文字，不做 OCR；无可提取文本的文件会明确拒绝。无需云模型。

文本提取首版仅尝试姓名、邮箱、手机号；**不会编造教育经历、日期、成绩或技能**。请参照 [个人资料模板](examples/profile.template.json) 补充 JSON，或使用 `profile set`。输入值在交互终端隐藏，不建议将敏感值写进 Shell 参数。JSON 文件中的 `confirmed` 或披露权限不会直接被采信，导入后仍须本人确认。再次导入与已确认值冲突时，保留冲突候选等待处理。

```bash
npm run dev -- profile import /absolute/path/my-profile.json
npm run dev -- profile confirm
npm run dev -- profile record education master
npm run dev -- profile set education.master.school
npm run dev -- profile set education.master.startDate
```

每条教育/实习经历使用稳定资料 ID，例如 `master`、`bachelor`、`intern_a`，然后按 `education.master.school`、`experience.intern_a.company` 填资料。日期由本人输入目标网站要求的格式，普通日期控件通常使用 `YYYY-MM-DD`。缺失、待确认、有冲突与已确认是不同状态，未知不自动填为“无”“否”或 `0`。

`profile show` 默认只显示字段路径和状态。本人需要在终端看值时，使用 `profile show --values`。导入 PDF 后附件复制到受限目录；JSON 可提供相对于 JSON 文件的 `resume` 路径，程序同样先复制后使用。

Keychain 不可用时，可在**同一个 apply 进程**使用会话资料：

```bash
npm run dev -- --session apply JOB_ID --profile /absolute/path/my-profile.json
```

该命令会展示资料并要求本人确认；资料值退出后丢弃。`--session profile import/set` 的资料不会跨命令保留，程序会明确提示。资料源 JSON 由本人管理，不会被秘密复制成明文备份。

## 导入岗位和选择申请

```bash
npm run dev -- jobs import /absolute/path/jobs.xlsx
npm run dev -- jobs import /absolute/path/jobs.csv
npm run dev -- jobs import --paste
npm run dev -- jobs list
npm run dev -- jobs channel JOB_ID 'https://真实官网/申请入口?ref=原始参数'
```

支持 XLSX、CSV、TSV 粘贴文本。读取表头、单元格、XLSX 超链接和常见 `HYPERLINK("url", ...)` 字面公式，不执行公式。通用表头别名在 `src/jobs.ts`；有歧义时用显式映射：

```bash
npm run dev -- jobs import jobs.csv --columns '{"企业简称":"company","目标职位":"title","官网入口":"url","备用链接":"ignore"}'
```

所有表格内容仅作为数据。原始投递链接及内推参数保留，不做 URL 清洗。缺少入口为 `NEEDS_CHANNEL`。公司、租户、账户、批次、岗位编号齐全时用强标识去重；信息不足会提示，不按相似名称自动合并。**导入不创建申请、不授权投递**；选择 `apply JOB_ID` 并确认披露后才建立本地申请。

## 登录和辅助填写

如果站点有登录规则：

```bash
npm run dev -- login SITE_ID
npm run dev -- apply JOB_ID
```

程序打开可见 Google Chrome，验证本人申请页面。登录失效时让本人正常登录，再重新访问申请页检测；不会仅因本人按回车而宣布有效。无法判断时为 `UNKNOWN`。没有站点登录规则的真实 URL 也能打开，但会保留 `UNKNOWN` 并要求本人确认当前是本人可访问的申请表单后，才辅助填写。

投递前显示公司、岗位、完整目标 URL、已确认字段路径和是否有简历附件。确认涵盖**填写和上传本身可能发送数据**。陌生来源 iframe 不填写，跳到未授权来源或租户路径时停止。

规则按“本站明确配置 → 区块与字段通用映射 → 已人工核验的语义缓存 / 可选批量模型建议 → 本人回答”处理。通用映射位于 [field-mappings.json](examples/field-mappings.json)。同名字段根据区块区分，例如“基本信息 / 姓名”和“紧急联系人 / 姓名”。

支持普通输入、文本域、原生下拉、单选、多选、文件上传和基础重复经历。处理结果会显示步骤、覆盖范围和待处理项。填写过程中可在终端输入：

| 命令           | 作用                                                     |
| -------------- | -------------------------------------------------------- |
| `answer 1`     | 补充第 1 项答案，选择通用资料或仅当前申请；都存 Keychain |
| `bind 1`       | 将第 1 项所在的重复区块绑定到具体资料记录 ID             |
| `map 1`        | 本人明确字段路径，可缓存已核验的语义                     |
| `model`        | 对当前未知字段批量请求语义建议，仍须本人确认             |
| `add 教育经历` | 仅执行配置明确的增加经历按钮，并重新观察新记录           |
| `next`         | 仅执行明确配置且类型安全的下一步按钮，核验目标步骤       |
| `resume`       | 人工操作后重新观察，保留手动改动和本次会话刻意清空的字段 |
| `submitted`    | 本人点击最终提交后读取回执；不明则记录 UNKNOWN_RESULT    |
| `quit`         | 明确尚未最终提交，保存暂停状态并退出                     |

重复经历先识别区块，再由本人将该 DOM 记录绑定到资料 ID；不会把“第 2 条经历”永久绑定为本科。新增/重建记录后需要重新绑定。已有非空内容默认保留；上传改写已填写字段会停止，要求本人核查。页面出现协议、声明或敏感披露时留给本人处理。自定义控件、Shadow DOM、不明字段和覆盖不全区域由人工接管，不能假装已全部处理。

URL 不变的多步骤使用步骤标识、字段结构及校验反馈验证。未知导航、`submit` 类型按钮、疑似最终提交按钮均拒绝自动点击。自动动作数、步骤数和重复状态次数均有限制。普通运行不生成截图、HAR、trace，也不读取认证响应。

最终回执要求配置的成功文本与**岗位编号**同时匹配。没有明确证据时是 `UNKNOWN_RESULT`，后续 `apply` 拒绝重复投递。意外中断也保守进入该状态。本人核对官网后可恢复：

```bash
npm run dev -- application APPLICATION_ID --resolve submitted
npm run dev -- application APPLICATION_ID --resolve not-submitted
```

这是本人核查记录，证据标记为 `manual-confirmation`，不会冒充系统验证。确定尚未提交的普通暂停，重新 apply 前同样要确认没有重复投递风险。

## 配置真实站点与查询进度

在本地数据目录的 `config.json` 中，将 `siteFiles` 指向本人维护的 JSON 文件。相对路径相对于该数据目录，建议使用绝对路径。参考 [通用站点样例](sites/generic.example.json) 和 [完整 fixture 站点样例](sites/fixture.json)。样例域名不能作为已适配的真实官网使用。

站点配置是本人维护的可信规则，不从网页备注、岗位表格或模型输出自动安装。至少核查：

- `origins`、`pathPrefix`、`tenant`、`account`：匹配准确租户与账户；同一 URL 匹配多个配置时拒绝猜测。
- `capabilities.fill` 与 `capabilities.track` 分别声明。
- `login.url` 是本人申请页；`authenticated` 和 `unauthenticated` 是明确登录证据。非 default 账户必须配置 `accountSelector` + `accountText` 才能确认登录身份，该文本应为界面公开账户别名，避免放敏感标识。
- `form.fields`、`sections`、`repeats` 为标准 CSS 选择器。显式字段可设置 `required`；下一步须配置 `from`、`to`、`safe:true`，仍会经过本地检查。
- `tracking` 需提供申请列表 URL、ready、行、岗位编号、批次（如果官网显示）、状态、下一页、结束证据、页码标识和 `statusMap`。只有本人明确核验的分页动作才能设 `nextSafe:true`。

```bash
npm run dev -- track
npm run dev -- status
npm run dev -- application APPLICATION_ID --pause
npm run dev -- application APPLICATION_ID --resume
```

只查询 `SUBMITTED` 或 `UNKNOWN_RESULT` 且未暂停的申请。同租户和账户一次读取多个岗位与分页，不逐岗位重复登录。只自动点击明确的列表分页，不投递、不修改简历、不预约、不接受协议。查询运行阻止非 GET/HEAD/OPTIONS 请求；依赖 POST 读取数据的站点可能因此无法覆盖，本版将暂停或标 partial，需要专门适配，**不会放开未知写请求**。

分页不完整时明确为 `PARTIAL`，不能据此认定申请不存在。查询失败、未找到匹配、账户不明都保留上次可靠阶段及最近成功时间。官网原始状态、阶段、结果、查询状态、最近尝试、最近成功、来源引用分开存储。状态映射使用精确原文，未知状态保留原文，需本人编辑 `statusMap`；长期无变化不推断拒绝。完整事件历史留在 SQLite。

## 飞书同步与恢复

详细字段、实际 CLI 版本核查、默认模板来源、整行填色步骤及未验证范围见 [飞书说明](docs/feishu.md)。本版只写一张主表，不发送飞书消息。

```bash
lark-cli auth login --domain base
npm run dev -- feishu create
npm run dev -- feishu connect YOUR_REAL_BASE_TOKEN YOUR_REAL_TABLE_ID
npm run dev -- sync
npm run dev -- status
npm run dev -- status --history APPLICATION_ID
npm run dev -- retry APPLICATION_ID --operation sync
npm run dev -- retry APPLICATION_ID --operation track
```

业务状态和待同步事件先写 SQLite。同步以本地申请 ID 精确对账，维护 record ID 映射；创建请求结果不明时先查远端，不能盲目再建。只覆盖自动字段，人工备注、优先级、暂停跟踪、截止时间走固定读取白名单，备注不成为指令。

`maxRetries=3` 是首次失败后最多再试三次。授权问题立即标黄、不耗重试；暂时故障退避 1、2、4 秒；耗尽持久化并停止，等待 `retry`。独立耗尽故障使 `attention_status=RETRY_EXHAUSTED`，优先浅红；授权缺失为 AUTH_REQUIRED，浅黄；正常没有异常填色。同步失败时飞书可能无法立即显示期望颜色，本地报告始终保留故障，包括尚未新增成功的行。

`status` 是即时本地报告，`status.json` 是同内容文件。macOS 通知使用 osascript，并按站点账户/飞书授权合并去重；通知只包含通用异常提示，不带个人值。通知能否弹出还受系统通知权限和专注模式影响，发送调用成功不等于本人已看到。没有收件人时不发飞书消息。

## 每日 launchd

```bash
npm run build
npm run dev -- schedule install --hour 9 --minute 0 --dry-run
npm run dev -- schedule install --hour 9 --minute 0
npm run dev -- schedule status
npm run dev -- schedule uninstall
```

安装前展示本机时区、执行时间、Chrome 窗口与漏跑补查影响，并要求本人确认。使用用户 LaunchAgent；只有真实 `launchctl bootstrap` 成功才报告 installed。当前交付**没有为你安装后台任务**。

日历触发之外，每 15 分钟和用户登录时检查漏跑或任务占用，只对到期任务读取官网。首次运行基于初始化日期，执行日期持久化去重；漏掉多天时合并成一次**当前状态**查询，不虚构过去每日状态。失败不标为完成，任务占用时下次触发再检查。Mac 关机或未登录桌面时不保证准点执行。Node 或项目路径移动后需要卸载、重新构建和安装。

所有写任务（包括 apply、track、sync）共享一个实例锁，Chrome 自己的资料目录锁是第二层保护。异常退出遗留锁时运行 `unlock`，仅在记录的进程已不存在时才清理；不会接管仍在运行的浏览器实例。

## 可选模型

```bash
npm run dev -- model configure
npm run dev -- model disable
```

仅实现批量字段语义建议，使用 OpenAI 兼容的 HTTPS chat/completions 接口。首次配置会展示端点和数据范围并要求本人授权，Key 保存在 Keychain。只有在 apply 内输入 `model` 才调用；发送区块、标签、控件类型、资料字段路径，**不发送个人值、简历内容、认证数据、完整 HTML 或截图**。回复必须经过 Zod schema 校验，且路径在允许列表内，仍需本人确认。模型没有代码、Shell、Keychain 或最终提交权限；调用失败回退手工映射，不阻塞基础流程。记录调用原因、token 用量及缓存命中，不记录请求/回复正文。

## 本地体验与验证

两个终端即可体验复杂表单，使用虚构资料和隔离数据目录：

```bash
# 终端 1：只在 127.0.0.1 上启动 fixture
npm run fixture

# 终端 2：创建测试岗位，输出带真实本地 ID 的 apply 命令
npm run fixture:seed
# 复制 seed 输出的 npm run dev -- --home .jobagent-fixture --session apply ... 命令
```

在 fixture 浏览器里点击“模拟本人登录”，然后终端回车重新检测。所有资料、申请进度均标记为测试数据；测试站点可以复现重复教育、条件必填、同 URL 多步骤、上传覆盖、分页、登录失效和未知提交结果。

执行自动验证：

```bash
npm run typecheck
npm test
npm run test:browser
npm run test:browser:headed
npm run build
npm audit
```

测试使用 **本机 Google Chrome**，无头用于常规测试，`--headed` 用于可见窗口验证；没有把 Chromium fixture 冒充真实站点联调。若在受限代理沙箱运行 Chrome，需允许本机浏览器进程；普通 macOS 终端不需要修改程序逻辑。测试目录使用临时专用 profile，真实应用 profile 不受影响。

实际命令、数量与结果详见 [验证记录](docs/verification.md)。

## 边界

| 范围                                            | 本版状态                                                   |
| ----------------------------------------------- | ---------------------------------------------------------- |
| CLI、SQLite、导入、字段规则、标准控件、人工接管 | 已实现，有实际自动化测试                                   |
| Chrome 专用持久化会话、登录重新验证、串行锁     | 已实现，fixture 验证                                       |
| 配置驱动的真实 URL 填写入口                     | 已实现；未知区块/控件安全暂停；无真实招聘站点联调          |
| 站点进度查询和分页                              | 已实现，fixture 验证；真实站点要独立配置                   |
| 飞书官方 CLI、幂等 outbox、对账与重试           | 已实现；真实 CLI 版本/help/auth 已检查；写入用传输替身测试 |
| 飞书模板复制、真实记录写入、真实视图整行颜色    | 未验证；当前用户授权过期、没有目标表                       |
| Keychain                                        | 原生辅助程序，失败不降级明文；实际验证范围见记录           |
| 云模型                                          | 可选批量语义映射；未调用真实云模型                         |
| launchd 安装/查看/卸载                          | 已实现；当前未安装后台任务                                 |
| OCR、自定义复杂控件全面适配、自动最终提交       | 不支持                                                     |

模块保持单项目，没有 Electron/React 管理后台、扩展、多 Agent、LangGraph、Redis、Docker 或微服务。

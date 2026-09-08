# Electron 客户端实际验收记录

验收日期：2026-09-08。平台：macOS 27.0 arm64。本轮在现有仓库上接入界面，没有迁移数据库，没有安装实际 launchd 任务，没有向企业提交申请。

下方保留各次迭代的实际记录。最新飞书 CLI 自动发现验收见文末；此前迭代的数量不代表当前测试总数。

## 已执行结果

| 检查                                              | 实际结果                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run typecheck` / `npm run build`             | 通过，CLI 与 Electron/React 一起类型检查                                    |
| `npm test`                                        | **34 / 34 通过**：原 28 项及新增 6 项桌面服务、协议、锁和中断恢复测试       |
| `npm run test:browser`                            | **16 / 16 通过**：原 15 项及新增“写入前暂停、恢复保护人工修改”测试          |
| `JOBAGENT_TEST_PACKAGE=1 npm run test:desktop`    | **3 / 3 通过**，最终一轮 19.4 秒                                            |
| `npm run desktop:package`                         | 成功生成本机 arm64 `.app`                                                   |
| `npm audit`                                       | 0 个已报告漏洞                                                              |
| 原 CLI `--help` / `--version` / `schedule status` | 正常；版本 0.2.0；实际 launchd 状态未安装，plist 不存在                     |
| Electron 自带 Node/SQLite 探针                    | Electron 44.2.0、Node 24.20.0、SQLite 3.53.4；`node:sqlite` 可加载          |
| 签名检查                                          | 只有工具链 ad-hoc 标记，TeamIdentifier 未设置；没有 Developer ID 签名或公证 |

## 三个客户端验收场景

1. **同一 SQLite → 一次启动 → 登录 → 回答 → 暂停/恢复 → 同步失败 → 重开**
   - 使用 Node `Store` 先写入明确标注为测试的岗位，Electron 工作进程直接读同一 `state.sqlite`。
   - 单击辅助填写后运行一次；重复 IPC 启动被后端拒绝。
   - 实际专用 Chrome 访问本机测试站，登录失效按后端 `attention()` 整行标黄；只点击“已完成登录”而未改变测试站会话时，重新检测仍为登录失效。
   - 测试站模拟完成登录后，后端重新访问并验证，通过后出现姓名补充表单。
   - UI 暂停/恢复、更换问题 ID，输入答案后由原填写引擎写到真实 Chrome 页面；测试站收到该输入。
   - 未配置飞书时，工作台保留 `NOT_CONFIGURED` 与同步错误，任务状态为失败，没有误报成功。
   - 刷新页面、开关抽屉及重启客户端没有产生新任务，申请 ID、任务事件数量保持一致。
   - 资料页真实写入临时服务名对应的 macOS Keychain，并回读验证。检查 `localStorage.length === 0`。
   - Electron 实际窗口偏好：nodeIntegration=false、contextIsolation=true、sandbox=true；渲染层没有 `require`，未出现页面脚本错误。

2. **文件导入 → 重试耗尽 → 未知结果保护 → 窗口/退出生命周期**
   - 通过客户端导入按钮、原生对话框 API 测试替身与受限 IPC，实际导入临时 CSV，并在原数据库回读新增岗位。
   - 显式测试 CLI 返回结构化网络错误，经原 `FeishuCLI` 和 `sync` 进行实际有限重试，最终保存 `RETRY_EXHAUSTED`、`FEISHU_TEMPORARY_ERROR`。整行标红，抽屉提示远端可能尚未更新。
   - 结果未知的申请在后端拒绝辅助填写；界面只允许先记录本人核查结果。
   - 空闲关闭窗口后保持客户端进程，激活时创建新窗口，记录一致。
   - 有任务时退出触发原生确认；选择继续使用时任务仍在。测试清理使用取消请求并等待安全结束。

3. **打包后的 .app 与 Finder 类环境**
   - 直接启动 `JobAgent.app/Contents/MacOS/JobAgent`，输入环境 PATH 限制为 `/usr/bin:/bin`，使用显式临时 `JOBAGENT_HOME`。
   - `app.isPackaged === true`；SQLite 读取原数据，字段映射资源存在，Keychain 辅助程序实际可访问。
   - Chrome 可检测；外部测试 CLI 的绝对路径可执行。
   - 调度预览使用安装包内独立 Node 与 Keychain helper 的绝对路径；没有实际安装调度。

客户端测试的企业、岗位、页面、资料值和飞书错误全部来自显式临时测试环境，没有写入正式数据源冒充真实申请。测试成功时删除对应临时 Keychain 条目。

## 仍未验证

- 真实招聘网站的站点规则、登录、表单和回执；本轮没有向真实企业发送申请。
- 真实飞书 device-flow 授权与目标表写入/远端颜色；协议参考本机 CLI 1.0.78 与对应官方源码。客户端只对远端实际确认的写入报告成功。
- 真实模型端点的请求与授权；UI 支持单独发起不含个人资料的连通性测试，但本轮未调用生产模型。
- 用户实际 launchd 安装与后台执行；原有日期去重回归、CLI 状态查询和安装包调度路径预览已通过。
- 通过 macOS 图形界面（Launch Services / Finder）正常打开应用的最终人工检查：自动审批要求对运行此未做 Developer ID 签名、可访问本地数据的构建单独确认。目前已通过直接启动安装包及受限 PATH 的自动测试，但不能据此声称 Finder 人工打开已验证。
- Intel 架构构建、跨机器分发、Developer ID 签名与公证；当前交付仅为本机 arm64 构建。

## 修复后复验

测试期间修复了 Electron 入口顶层 await 导致的就绪死锁，以及恢复任务瞬间输入组件重建导致的输入丢失。最终应用重新构建，34 项单元/服务测试、16 项 Chrome 测试和全部 3 项客户端测试均通过。打包依赖使用实际安装的 Electron 44.2.0、`@electron/packager` 20.3.0，锁文件已更新。

## 启动脚本补充验收（2026-09-08）

新增根目录 `启动客户端.command`、`scripts/start-desktop.sh`、`npm start` 和 `desktop:rebuild`。既有 `.app` 直接打开，首次构建调用原有打包流程。该迭代没有修改业务代码。

- `npm run typecheck` 与 `npm run build`：通过。
- `npm test`：**44/44 通过**，包含原有 34 项测试和新增 10 项启动测试。
- 启动测试覆盖：目录含空格、不同工作目录、Finder 精简 PATH 下发现 nvm Node、首次构建、依赖安装失败、打包失败、资源缺失、运行中拒绝重建、显式重建、系统打开失败以及双击入口的退出码。
- `/bin/bash -n`：两个 Shell 入口语法检查通过。
- `env PATH=/usr/bin:/bin /bin/bash ./启动客户端.command --check` 与 `npm start -- --check`：均正确识别已有本机 `.app`，不依赖 Shell 初始化，也没有打开窗口或写入业务数据。

启动自动化测试在显式临时目录中运行脚本，替换系统 `open`、进程检测、开发工具检测和 npm 构建命令；使用真实 Node 验证路径发现，不执行联网安装或 Launch Services 打开。它们验证脚本的分支与错误处理，不代表已完成 Finder 手工双击或生产业务连接验证。本次没有重跑浏览器与桌面套件；其既有结果和未验证范围仍如上所述。

## PDF / OCR 补充验收（2026-09-08）

复现 Electron utilityProcess 下 PDF.js 未设置 workerSrc 的错误，改为加载随应用打包的本地 worker。无文字或文字较少的页面调用 macOS Vision，图片仅在内存中处理，继续使用原资料 schema、Keychain 和导入版本记录。

- `npm run typecheck`、`npm run desktop:build`：通过；本地 Swift OCR 辅助程序实际编译并随 arm64 `.app` 打包。
- `npm test`：**47/47 通过**，包含 OCR 候选状态、部分识别不清空已确认值、导入统计不含识别内容，以及退出等待资料保存、拒绝重复写入的回归。
- `npm run test:browser`：本轮 PDF 故障修复阶段复验 **16/16 通过**；后续 OCR 接入未修改浏览器引擎。
- `JOBAGENT_TEST_PACKAGE=1 npm run test:desktop`：**4/4 通过，最终一轮 21.7 秒**。先通过测试专用 `JOBAGENT_TEST_PACKAGE_DIR` 验证单独构建目录（23.6 秒），旧客户端退出后运行 `npm run desktop:package` 更新正式 `release` 目录，再完整复验。套件共享前序导入的测试数据，应完整串行执行；仅筛选最后一个场景会因缺少前置岗位而失败。
- `env PATH=/usr/bin:/bin /bin/bash ./启动客户端.command --check`：正确识别新版应用；包内本地 PDF.js worker 与 arm64 OCR helper 均存在。原 CLI 导入帮助正常，已注明扫描 PDF 支持。
- 新增第 4 类场景：开发版和打包应用均实际导入文字 PDF、含中文姓名及英文邮箱的纯图片扫描 PDF；测试没有预置文字层，没有替换 PDF.js 或 Vision。成功后回读真实 Keychain、版本、原附件字节，刷新后数据一致。
- 空白 PDF 实际执行 OCR 后报告无可用文字，旧资料和版本保持一致；成功提示不会残留。
- 文件选择对话框使用测试替身，导入按钮、受控 IPC、业务工作进程、PDF 解析、OCR 与 Keychain 均使用真实实现。所有简历为临时生成的虚构测试数据，未读取用户真实简历。
- 测试显式隔离 Electron `userData` 并验证实际路径，客户端单实例锁与测试配置不会干扰日常客户端。

OCR 验证覆盖清晰的一页中英文印刷体扫描件，不代表模糊、多栏、手写或所有真实简历均能准确识别。自动字段解析目前主要覆盖姓名、邮箱和电话，经历仍需本人补充。Finder 手工打开、真实官网、飞书与签名公证的未验证范围保持不变。

## 经历解析与字段映射补充验收（2026-09-08）

本轮修复 PDF 绘制顺序造成的文字错位，并补齐教育、工作/实习、项目的本地结构化解析。支持项目记录和官网重复区块绑定，数据仍使用原 version-1 facts、SQLite 与 Keychain。公开字段依据与准确性边界见 [经历解析与网申映射](resume-mapping.md)。

- 类型检查、Node 构建、Swift 辅助程序构建和本机 arm64 `.app` 打包通过。
- `npm test`：**53/53 通过**。新增版面顺序、章节识别、日期精度、稳定记录与冲突、旧 schema、官网区块别名等测试。
- `npm run test:browser`：**18/18 通过，13.3 秒**。新增“未确认不填、显式绑定后填、实习和项目同名字段分开映射”与“月份/至今不伪造完整日期”场景。
- `JOBAGENT_TEST_PACKAGE=1 npm run test:desktop`：**5/5 通过，最终一轮 22.8 秒**。新增真实客户端的经历编辑、确认、重复导入、名称/时间选项展示与项目绑定填写；开发版及最终打包应用均通过。补强了登录检测等待条件及小屏幕抽屉关闭后的交互顺序，避免测试依赖过渡状态或点击被抽屉遮住的按钮；调试截图改为显式启用。
- 单独在打包客户端中导入用户提供的真实一页 PDF：**1 段教育、2 段实习、1 段项目**。逐项核对名称、职位、日期和描述，读取真实 Keychain，重复导入与刷新后记录一致，localStorage 为空。
- 真实 PDF 验证使用独立数据目录和 Keychain 服务，完成后已删除测试条目；简历、识别正文、截图与包含个人断言的私有脚本不进入仓库。已检查真实客户端截图和 PDF 版面。
- `启动客户端.command --check` 与 CLI `profile record --help` 正常；项目记录可通过原 CLI 管理，无数据库迁移、调度变更或自动提交。

此前“只提取姓名/邮箱/电话”的限制已由本轮经历解析替代。仍未验证所有复杂多栏/扫描排版、真实官网完整投递、真实飞书写入、Finder 人工打开、Intel 构建与签名公证。不能把公开字段参考或本地表单测试当作真实官网适配完成。

## 飞书 CLI 自动发现补充验收（2026-09-08）

修复设置页仅展示“未检测可执行文件”、必须先点顶部 doctor 才开始搜索的问题。设置页空闲时自动查找并运行版本检查，使用原配置保存绝对路径；本机 CLI、飞书授权与表结构验证分别展示。提供“重新查找”、失效原因与最近本机检测时间。

- `npm run typecheck`、`npm run desktop:build`、`git diff --check`：通过；原 CLI `--version` 正常。
- `npm test`：**60/60 通过**。新增 nvm 默认/自定义目录、数值版本排序、软链接、文件身份验证、缺少 Node、超时、失效绝对路径保护、并发合并、进程内缓存、重开重新验证与跨进程锁测试。
- `npm run test:browser`：**18/18 通过，12.6 秒**，没有改动官网填写状态机或字段映射。
- 候选 arm64 `.app` 成功构建到 `release/cli-discovery/JobAgent-darwin-arm64/JobAgent.app`，避免覆盖仍在运行的旧客户端。
- `JOBAGENT_TEST_PACKAGE=1 JOBAGENT_TEST_PACKAGE_DIR=release/cli-discovery/JobAgent-darwin-arm64/JobAgent.app npm run test:desktop`：**6/6 通过，26.7 秒**，同时覆盖开发版与打包应用。新场景从默认 `lark-cli` 配置开始，只打开设置页即可找到临时 nvm 中的实际 Node 脚本，运行 `--version` 并保存路径。
- 新场景记录子进程参数：切页和刷新不增加版本调用，手动重新查找和应用重开各增加一次；未调用授权或同步命令，任务 ID 与事件保持一致。授权与表结构继续显示未检测。
- 测试启动 PATH 限制为 `/usr/bin:/bin`，CLI 的 `#!/usr/bin/env node` 使用包内 Node。测试另设临时 `NVM_DIR` 并清除 npm 注入的全局前缀，避免误用真实安装。测试清理改为区分本地路径检查与活动浏览器任务，等待后台检测完成后退出。
- 在这台机器上单独以精简 PATH 调用真实发现代码，成功找到已有 nvm 安装并验证 `lark-cli version 1.0.78`；只执行版本命令，没有改写正式配置或访问飞书表格。

真实飞书授权、应用配置、目标表权限与远端写入仍未验证。自动发现成功不代表这些连接已通过验证。Finder 人工打开与签名公证限制保持不变。

## 投递跟踪模板补充验收（2026-09-08）

新增七个主要字段、彩色投递状态和 Grid / 投递状态看板 / 投递清单视图，接入原 CLI、同步与客户端任务确认流程。旧版表继续按旧字段同步；本轮没有迁移数据库或改写真实目标表。

- 在独立源码目录构建和测试，排除共享工作区中同时进行的 Excel 导入改动。构建时显式使用 Node 24.14.0，避免临时目录默认 Node 22 影响 SQLite 和调度运行时。
- `npm run typecheck`、`npm run desktop:package`：通过。本机 arm64 安装包中的独立 Node 实测为 24.14.0。
- `npm test`：**71/71 通过**。新增 11 项模板测试，覆盖主列顺序、字段类型与颜色、日期和真实状态映射、手工备注/渠道保护、新旧表兼容、视图设置回读、创建结果未知时禁止盲目重建等。
- `npm run test:browser`：**18/18 通过，17.4 秒**，原官网填写与暂停/恢复回归通过。
- `JOBAGENT_TEST_PACKAGE=1 npm run test:desktop`：**7/7 通过，42.9 秒**，包含开发版与最终安装包。新增场景从设置页打开模板预览，确认前没有视图写入，确认后由真实工作进程调用测试 CLI 配置三个视图并回读，验证后才记录成功时间；没有写入申请记录。
- 本机真实 `lark-cli 1.0.78` 的五项 `--dry-run` 均返回成功：`+base-create`、`+view-create`、`+view-set-visible-fields`、`+view-set-group`、`+view-set-sort`。目标坐标是显式测试值，未执行远端写入。
- `feishu template` 可在本地输出完整结构；JSON 模板与代码定义一致，空白 CSV 仅含七列表头，不包含测试申请。
- 独立安装包交付于 `release/feishu-template/JobAgent-darwin-arm64/JobAgent.app`，避免覆盖日常使用的应用。客户端测试使用临时数据目录、临时 Keychain 条目和显式测试 CLI。

真实飞书授权、目标表字段/视图写入、远端标签显示和人工整行填色仍未验证。模板状态标签颜色不代表远端整行异常颜色已配置；Finder 人工打开与签名公证限制保持不变。

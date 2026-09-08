# JobAgent · 个人网申助手

面向 macOS 的本地个人网申工具。通过 Electron 客户端或 TypeScript CLI 管理岗位与资料，在专用 Chrome 中辅助填写申请、处理登录与资料补充、查询招聘进度，并将结果同步到飞书多维表格。

**辅助填写，人工审核，最终提交由本人在官网完成。** 客户端与 CLI 共用本地数据和业务逻辑，无需账号系统或自建服务。

[快速开始](#快速开始) · [客户端指南](docs/desktop.md) · [CLI 指南](docs/cli.md) · [飞书配置](docs/feishu.md) · [反馈问题](https://github.com/xiaoyumuxi/personal-job-agent/issues)

## 功能

| 模块       | 能力                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| 投递工作台 | 导入 CSV / TSV / XLSX 岗位，搜索与筛选，查看招聘阶段、运行状态、待办和同步故障 |
| 辅助填写   | 使用 Playwright 管理专用 Chrome，复用字段规则，保留页面已有内容与人工修改      |
| 任务详情   | 实时事件、登录重新验证、资料补充、人工审核、安全暂停与恢复                     |
| 我的资料   | 导入文本型 PDF / TXT / MD / JSON，编辑、确认和处理冲突，资料值存入 Keychain    |
| 进度跟踪   | 按站点规则读取官网申请记录，保留可靠阶段、查询时间与来源证据                   |
| 飞书同步   | 通过官方 `lark-cli` 写入多维表格，支持对账、失败重试和本地故障记录             |
| 设置与连接 | 检测 Chrome、飞书 CLI 和可选模型，配置数据目录及 launchd 每日查询              |

当前版本为 **0.2.0**。已有本地自动化测试和 macOS arm64 打包验证；**尚无经过真实官网联调验证的招聘站点适配器**。通用填写可以从岗位 URL 启动，可靠的登录验证、进度查询和回执识别需要配置对应站点规则。未配置的能力会显示待配置或不支持。

## 快速开始

### 环境要求

- macOS；当前打包验收在 Apple Silicon 上完成。
- Node.js **24+** 与 npm。
- Google Chrome，用于可见浏览器中的登录与辅助填写。
- Apple Command Line Tools，用于从源码编译 Keychain 辅助程序；未安装时执行 `xcode-select --install`。
- 可选：飞书官方 `lark-cli` 与目标多维表格。模型 API 不属于必需依赖。

### 从源码启动客户端

```bash
git clone https://github.com/xiaoyumuxi/personal-job-agent.git
cd personal-job-agent
npm ci
npm run desktop:dev
```

此命令编译并打开 Electron 客户端，读取现有本地数据，不自动导入测试岗位。修改源码后重新执行即可；目前没有热更新开发服务器。

若 npm 缓存目录存在权限问题，可改用 `npm ci --cache /private/tmp/jobagent-npm-cache`。

### 第一次使用

1. **检测环境**：在“设置与连接”检查 Chrome 和数据目录。曾使用自定义 CLI 数据目录的用户，先选择“连接现有数据目录”。
2. **确认资料**：在“我的资料”导入简历，检查解析结果，补全并确认各项资料。可参考 [资料模板](examples/profile.template.json)。
3. **导入岗位**：在“投递工作台”导入岗位文件。可参考 [表格格式](examples/jobs.csv)，导入本身不会启动申请。
4. **启动填写**：选择一个岗位，核对目标网站和本次披露范围。登录、资料补充和暂停恢复均在任务详情抽屉中处理。
5. **审核与提交**：前往官网核对表单，由本人点击最终提交，再返回客户端检查回执。本人自述提交与官网回执确认分别记录。
6. **跟踪与同步**：配置站点查询规则及飞书连接后，查询进度或同步飞书。每日查询需本人预览并安装 launchd 调度。

完整操作、窗口关闭与退出行为见 [客户端指南](docs/desktop.md)。

## 构建 macOS 应用

```bash
npm run desktop:package
```

按本机架构输出应用：

```text
release/JobAgent-darwin-arm64/JobAgent.app  # Apple Silicon
release/JobAgent-darwin-x64/JobAgent.app    # Intel，尚未实机验收
```

构建产物包含独立 Node 运行时与 Keychain 辅助程序；日常使用不需要打开终端。Chrome 和飞书 CLI 仍为外部依赖，客户端会发现、验证并保存可执行文件的绝对路径，也支持手动选择路径。

目前提供本机源码构建流程，没有 Developer ID 签名、Apple 公证或自动更新。打包应用在隔离测试目录下通过了启动验证；Finder 的常规打开流程仍未完成验收。构建资源与验证范围见 [客户端文档](docs/desktop.md) 和 [桌面验收记录](docs/desktop-verification.md)。

## CLI 使用

CLI 与客户端调用同一份核心逻辑，可以按需交替使用。

```bash
# 初始化与环境检测
npm run dev -- init
npm run dev -- doctor

# 导入资料和岗位
npm run dev -- profile import /absolute/path/resume.pdf
npm run dev -- profile confirm
npm run dev -- jobs import /absolute/path/jobs.xlsx
npm run dev -- jobs list

# 将 JOB_ID 替换为岗位列表中的真实 ID
npm run dev -- apply JOB_ID

# 查询进度、同步飞书、查看本地状态
npm run dev -- track
npm run dev -- sync
npm run dev -- status
```

运行 `npm run dev -- --help` 查看命令。构建后也可使用 `node dist/src/cli.js <命令>`，无需全局安装。站点配置、字段映射、手动恢复及调度命令见 [CLI 使用指南](docs/cli.md)。

## 配置与数据

默认业务数据目录为 `~/Library/Application Support/JobAgent`：

```text
JobAgent/
├── config.json       非敏感配置
├── state.sqlite      岗位、申请、任务、事件与同步记录
├── chrome-profile/   应用专用 Chrome 资料目录
├── attachments/      导入的简历附件
├── logs/             launchd 日志
└── status.json       本地异常报告
```

CLI 支持 `--home <目录>` 或 `JOBAGENT_HOME`。客户端支持连接已有数据目录，不会因 Electron 的 `userData` 目录而创建第二套业务数据库；环境变量的优先级和已有调度的目录行为见 [数据位置说明](docs/desktop.md#数据位置)。

| 配置项   | 入口与说明                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| 站点规则 | 客户端导入规则文件，或设置 `config.json` 中的 `siteFiles`；参考 [站点配置样例](sites/generic.example.json) |
| 字段映射 | 优先使用明确站点规则和已确认映射；参考 [通用映射](examples/field-mappings.json)                            |
| 飞书     | 保存并验证官方 CLI 路径，完成授权，连接真实 Base token / Table ID；见 [飞书配置](docs/feishu.md)           |
| 模型     | 可选的 OpenAI 兼容 HTTPS 接口，仅用于字段语义建议；未配置时仍可规则填写和人工补充                          |
| 每日查询 | 使用 launchd，时区跟随 macOS；安装前展示影响，打开客户端不会自动安装                                       |

## 隐私与操作边界

- 资料值、补充答案和模型密钥使用 macOS Keychain；简历附件保存在受限权限的本地目录。Keychain 失败时不会降级为明文保存。
- 登录状态由专用 Chrome 资料目录管理，不接管日常 Chrome，不提供 Cookie 导入导出。
- 客户端渲染进程启用沙箱和上下文隔离，仅通过有限的业务 IPC 调用后端；不开放任意 Shell、文件读取或 JavaScript 执行。
- 填写和上传可能向招聘网站发送资料，执行前需要本人核对披露范围。模型语义请求不包含个人资料值、简历正文或认证数据。
- 不提供自动批量投递或自动最终提交。批量查询只用于读取进度；结果未知时阻止盲目重复申请。
- 客户端、CLI 和 launchd 共用跨进程锁。暂停在安全操作边界生效，已发出的网页操作无法撤回。
- 飞书同步失败会保留本地故障。工作台的异常颜色不代表远端表格已经更新。

## 开发与测试

```bash
npm run typecheck          # TypeScript 类型检查
npm test                   # 核心业务与应用服务测试
npm run test:browser       # 本地 Chrome 表单回归
npm run desktop:build      # 构建 CLI、Electron 与渲染资源
npm run test:desktop       # Electron 客户端冒烟测试

# 包含本机构建产物的验收
npm run desktop:package
JOBAGENT_TEST_PACKAGE=1 npm run test:desktop
```

浏览器测试使用本机 Google Chrome 和临时专用资料目录。桌面测试使用隔离数据与明确的测试替身，不会向真实企业发送测试申请。手动体验测试表单可运行 `npm run fixture` 和 `npm run fixture:seed`，详见 [本地体验指南](docs/cli.md#本地体验与验证)。

已记录的验收结果为核心测试 **34/34**、浏览器回归 **16/16**、含打包启动的客户端测试 **3/3**。这些是交付时的实际记录，不是持续集成状态；执行条件及未验证项见 [基础验证记录](docs/verification.md) 与 [桌面验收记录](docs/desktop-verification.md)。

### 项目结构

```text
desktop/           Electron 主进程、preload、工作进程与 React 界面
src/
├── application/   共享应用服务、任务运行时与结构化事件
├── browser/       Chrome 会话、页面观察与辅助填写
├── feishu/        官方 CLI 接入、字段映射与同步
├── cli.ts         命令行入口
├── db.ts          SQLite 数据访问
├── profile.ts     资料管理
└── schedule.ts    launchd 调度
scripts/           客户端构建与 macOS 打包
sites/             站点规则样例
examples/          配置、岗位与资料模板
fixtures/          显式本地测试站点
tests/             业务、浏览器与桌面测试
docs/              使用说明与验收记录
```

## 当前限制

- 文本简历仅自动提取部分基本信息；教育、实习和项目等需要本人补全。扫描 PDF 的 OCR 不支持。
- 自定义复杂控件、Shadow DOM 和不明确的页面行为需要人工接管，不能保证任意招聘网站自动填写完整。
- 真实招聘站点联调、真实飞书授权及写入、真实模型端点、实际 launchd 安装执行尚未完成生产验证。
- 没有账号系统、云端服务、插件市场、自动更新或自动最终提交功能。

## 参与贡献

欢迎通过 [Issues](https://github.com/xiaoyumuxi/personal-job-agent/issues) 报告问题或讨论功能，通过 Pull Request 提交修改。

- 问题报告请包含 macOS / Node 版本、使用入口、复现步骤和脱敏错误。不要上传真实简历、密钥、Cookie、Chrome 资料目录或完整数据库。
- 业务改动应复用 `src/` 核心逻辑，让 CLI 和客户端保持一致；网站适配请附规则说明及本地 fixture。
- 提交前运行类型检查和与改动相关的测试，并说明实际测试结果与未验证范围。测试数据必须与正式数据隔离。

## 许可证

项目的 [package.json](package.json) 当前标记为 `ISC`，仓库尚未包含独立的 `LICENSE` 文本。完整授权文件待补充。

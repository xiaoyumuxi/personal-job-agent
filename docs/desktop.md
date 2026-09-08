# macOS 客户端

这是原有个人网申助手的 Electron 界面接入。CLI、SQLite、Playwright Chrome、字段匹配、Keychain、飞书官方 CLI 与 launchd 继续使用原有实现。没有 HTTP 服务、云端数据库或新增 Agent。

## 最短使用步骤

1. 在 Finder 双击仓库根目录的 [启动客户端.command](../启动客户端.command)。首次自动安装依赖、构建本机 `.app` 并请求打开，之后直接打开已有构建。也可以打开 `release/JobAgent-darwin-arm64/JobAgent.app`（Intel 构建路径为 `darwin-x64`）。可以先通过 Finder 把应用放到固定位置，再配置调度。
2. 在“我的资料”选择 PDF / TXT / MD / JSON，审阅解析结果，逐项确认并保存。文字版 PDF 直接提取，文字较少的页面自动使用 macOS Vision 本地 OCR；版本信息会显示识别来源及 OCR 页数。资料值放在原有 Keychain，附件保存在原有数据目录。
3. 在“投递工作台”导入 CSV / TSV / XLSX，选择一个岗位，点击“辅助填写”，在抽屉核对本次披露范围后继续。导入不触发申请。
4. 需要登录时在专用 Chrome 正常登录，再点击“已完成登录，重新检查”。需要资料时直接在抽屉回答，选择“仅本次申请”或“通用资料”。经历先绑定到具体资料记录；未识别/敏感控件仍在官网人工处理。
5. 本人在官网核对并最终提交后，点击“我已在官网提交，检查回执”。只有既匹配回执又匹配岗位编号才记录系统确认；未验证保留 `UNKNOWN_RESULT`，不允许盲目再次填写。也可单独记录本人在官网核查的结果，证据标记为人工确认。
6. 在“设置与连接”检测 Chrome 和飞书 CLI，填写并保存实际 Base token / Table ID，完成官方授权后验证；在工作台点击“同步飞书”。官网与飞书登录互相独立，未配置模型不影响规则填写。

岗位缺少官网入口时，可在详情中补充。配置站点规则使用“导入站点规则”，原有规则文件格式没有变化。未适配站点可用保守的通用填写，但可靠登录验证、进度查询和回执识别仍需对应规则；界面会如实显示待配置。

### PDF 与本地 OCR

PDF 解析和 OCR 在后台进行，导入时显示“正在导入，请稍候”。扫描页通过 macOS Vision 识别中英文，不需要模型 Key，也不会上传简历或产生临时截图文件。PDF 最大 20 MB，单次最多 20 个扫描页，OCR 超时为 120 秒；模糊、手写、复杂排版或加密文件可能需要重新导出。

导入会自动拆分教育、工作/实习、项目经历，提取学校、专业、学历、单位、职位、起止时间与描述，并保留专业技能和开源实践文字。资料页按每段经历显示，可查看识别依据、编辑长描述后确认；重复导入相同经历不会新增记录。未明确标注的角色、学位或具体日期不会编造。识别失败保留原资料与导入版本，没有识别到的字段不会清空已确认值。实现边界与公开字段依据见 [经历解析与网申映射](resume-mapping.md)。

## 数据位置

默认位置仍为 `~/Library/Application Support/JobAgent`，与 CLI 的 `dataDir()` 完全相同。`JOBAGENT_HOME` 环境变量仍优先。Electron 的 `userData` 只承载窗口运行信息和可选的数据目录指针，不存第二份业务数据库。

如果以前 CLI 使用自定义 `--home`，在设置中“连接现有数据目录”选择含 `state.sqlite` 与 `config.json` 的原目录。客户端保存目录指针并重启，不迁移、复制或清空数据。CLI 仍需使用原来的 `--home` / `JOBAGENT_HOME`；已安装的 launchd 仍指向原配置。由环境变量指定目录的启动会拒绝 GUI 覆盖，避免优先级不明确。

资料值、答案、模型密钥不会写入前端 localStorage。渲染进程内存中显示的资料只用于本人编辑。诊断导出只含数量、状态、重试次数和运行环境，不包含 URL、公司、岗位、资料值、密钥或完整数据库。

## 开发和本机构建

需要 macOS、Node 24+、npm 和编译 Keychain / OCR 辅助程序所需的 Apple Command Line Tools。安装包内已附带两个辅助程序，日常运行不需要在终端编译它们。

### 启动脚本

根目录的 `.command` 是可双击入口，与以下命令等价：

```bash
npm start
# 或者无需 npm 本身已在 PATH 中：
bash scripts/start-desktop.sh
```

脚本不依赖当前工作目录，也支持路径中的空格。已有完整本机应用时直接通过 macOS `open` 打开；缺少应用时寻找当前 PATH、Homebrew、nvm、Volta 或 mise 中的 Node 24+，运行 `npm ci` 与原有 `desktop:package`。构建使用临时目录中的 npm 缓存，避免全局缓存权限问题。缺少 Node/npm 或 Apple Command Line Tools 时显示明确错误。

首次构建会显示终端进度；应用打开后终端可以关闭，客户端的退出与任务生命周期仍由应用管理。脚本返回成功只表示系统接受打开请求，不代表业务连接已通过检测。macOS 签名与公证状态没有变化。

```bash
# 检查本机应用或构建前提，不打开窗口或安装依赖
./scripts/start-desktop.sh --check

# 更新源码后，先在客户端按 ⌘Q 退出，再重新构建并打开
npm run desktop:rebuild
```

默认启动复用已有 `.app`，不会自动判断源码是否更新。使用自定义 `JOBAGENT_HOME` 或修改源码进行测试时，建议使用下面的开发入口；正常双击启动使用原有默认目录或客户端保存的数据目录指针。

### 源码开发与打包

```bash
npm ci
npm run desktop:dev
```

`desktop:dev` 编译后启动实际 Electron 窗口，使用真实本地数据。没有自动植入测试岗位，也不启动额外 HTTP 服务。修改代码后重新执行命令；本轮未引入热更新开发服务器。

```bash
npm run desktop:package
```

输出 `release/JobAgent-darwin-<本机架构>/JobAgent.app`。本轮本机为 arm64。打包脚本将 Node 可执行文件、Swift Keychain helper 和 `pdf-ocr-helper` 放到 `Contents/Resources/.desktop-runtime/`，核心入口位于 `Contents/Resources/app/dist/`。PDF.js worker 通过已打包依赖的绝对模块 URL 加载。SQLite 使用 Electron 自带 Node 的 `node:sqlite`，没有额外的 SQLite ABI 原生扩展。

原 CLI 命令仍可使用：

```bash
npm run dev -- status
npm run build
node dist/src/cli.js --help
```

客户端检测会从常见目录（含 Homebrew、用户本地目录和 nvm 安装）发现 `lark-cli`，并保存验证到的绝对路径。也可通过原生文件选择器指定。Finder 启动不依赖登录 Shell 的 PATH。Chrome 可执行文件路径同样可选择并保存。

本地 .app 没有 Developer ID 签名或 Apple 公证。工具链只保留了 ad-hoc 标记，这不等于可对外分发的已签名应用。若系统提示无法验证开发者，按 macOS 针对该应用的标准打开流程处理；不要全局关闭 Gatekeeper 或系统安全保护。应用尚未加入自动更新或商店分发。

## 调度和窗口生命周期

调度只使用原有 `dev.jobagent.daily` launchd 任务。先保存时间，再预览影响，由原生确认框确认安装。已有任务不会被覆盖，更改时先卸载再重新安装。时区跟随 macOS。本轮没有安装、卸载或更改用户的实际调度。

安装后的任务调用独立 Node、原 CLI `daily` 入口和当前数据目录，不把 Electron 当 Node，也不要求 GUI 常驻。安装包移动之后需要重新安装调度，以更新绝对路径。程序不会静默修改已有 plist。

- **关闭窗口**：空闲时只关闭窗口，Dock 中仍可重新打开。有任务时可选择继续使用、安全停止后关闭，或明确允许关闭窗口后保留任务；等待输入的任务会继续等待。
- **退出应用（⌘Q）**：有任务时要求选择是否安全停止；等待当前页面/网络操作结束并保存后退出。未发出的后续操作停止，已发出的网页操作不能撤回。
- **暂停任务**：先显示“正在暂停”；到达业务边界才显示“已暂停”。单次网络调用/浏览器操作尚未返回时，需要等待其自身超时。恢复重新观察网页，并保护人工修改。
- **异常退出后重开**：旧任务记录显示“已中断”。未结束的填写会保守记为结果未知，需要先核对官网；不会假装浏览器任务仍在执行，也不会自动重复启动。

客户端、CLI 和 launchd 共用 `runner.lock`。同一 Chrome 资料目录的投递、查看官网、登录和查询互斥。只有确认原进程已退出才允许清理遗留锁。

## 交互协议与安全边界

- `src/interaction.ts`：统一问题与答案类型，终端适配器和 Electron 使用同一份 `applyJob`。
- `src/application/runtime.ts`：工作进程中的任务运行记录、暂停边界与结构化事件。复用 SQLite `tasks` / `events` 表，没有新数据库或独立 UI 状态机。
- 每个任务有 `runId`，每条事件使用 SQLite 单调事件 ID 与时间；问题有 `requestId`。后端拒绝过期、重复、其他任务、类型错误或非法候选答案。恢复时更换问题 ID。
- UI 首次读取快照，再注册唯一事件订阅并补读一次，覆盖订阅瞬间的变化。事件通知只触发快照读取；刷新、切页、重新开抽屉不会启动任务。组件卸载会撤销监听。
- `desktop/main.ts` 校验 IPC 的来源窗口、主框架 URL、Zod 参数；`desktop/service.ts` 再校验任务状态、业务权限和跨进程锁。渲染进程不开 Shell，不直接访问文件或 Keychain。
- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`；preload 只暴露业务方法。禁用远程导航、webview、新窗口及权限请求；CSP 禁止渲染层联网。
- 招聘链接只从已导入岗位 ID 取出并在专用 Chrome 打开。飞书授权链接只接受官方 CLI 返回且通过 HTTPS 和域名校验的链接；授权 device code 仅留在工作进程内存，不进入任务事件或渲染层。
- 页面文字、错误和备注以 React 文本呈现，没有 `dangerouslySetInnerHTML`。

## 验收命令与限制

```bash
npm run typecheck
npm test
npm run test:browser
npm run desktop:package
JOBAGENT_TEST_PACKAGE=1 npm run test:desktop
```

客户端测试只创建带 `jobagent-desktop-e2e-` 前缀的临时目录与专用 Keychain 测试条目，使用本机 HTTP 测试页和显式飞书 CLI 故障桩。不会向真实企业发送测试申请。文件选择/退出确认的自动验收使用原生对话框 API 的测试替身；业务导入、IPC、持久化、Chrome 操作和 Keychain 实际执行。

实际结果见 [桌面客户端验收记录](desktop-verification.md)。真实招聘站点适配、真实飞书授权与写入、真实模型端点、Apple 签名公证以及实际 launchd 安装执行，未在本轮得到生产验证。

接口参考：[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[Electron 沙箱](https://www.electronjs.org/docs/latest/tutorial/sandbox)、[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[飞书 CLI v1.0.78 授权协议](https://github.com/larksuite/cli/blob/v1.0.78/cmd/auth/login.go)。

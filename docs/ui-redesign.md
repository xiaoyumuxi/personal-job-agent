# 行动优先的桌面 UI 改造

本轮将参考设计接入真实 Electron renderer。参考文件是布局与交互依据，示例公司、资料、状态和成功反馈没有进入业务代码。岗位导入与飞书授权能力继续使用共享业务层。

## 页面与接线

| 位置                                             | 本轮行为                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop/renderer/Workbench.tsx`                 | 五列清单；从真实快照生成待接管事项；缺链接、审核、核查结果等按钮随实际情况变化；空清单展示三步准备入口                                     |
| `desktop/renderer/jobPresentation.ts`            | 纯函数派生主动作、互斥分组、禁用原因与来源文案；不写入新的业务状态                                                                         |
| `desktop/renderer/TaskWorkspace.tsx`             | 工作台二级页面；保留确认、登录、问题补充、经历绑定、恢复观察、下一步、模型映射建议、暂停、停止、人工核查及同步恢复入口；全局任务同样可进入 |
| `desktop/renderer/Drawer.tsx`                    | 保留兼容导出，实际交互全部迁到任务工作区                                                                                                   |
| `desktop/renderer/ProfilePage.tsx`               | 版本与分组导航、普通字段控件、原文与候选对照；技术标识收进高级区域；新经历自动生成稳定 ID                                                  |
| `desktop/renderer/ProfilePicker.tsx`、`main.tsx` | 保留版本选择和后端逐次披露确认；阻止选择仍有资料草稿的版本；页面内状态与列表返回位置保留；恢复弹窗与页面焦点                               |
| `desktop/renderer/SettingsPage.tsx`              | 连接概览与六个分类；共用设置草稿；飞书 CLI、本人授权、目标表权限分别展示；模型未启用是中性可选状态                                         |
| `desktop/contract.ts`、`desktop/service.ts`      | 为设置的站点摘要新增 `login` 只读能力字段，直接来自既有站点规则；不改变执行或授权逻辑                                                      |
| `desktop/renderer/style.css`、`shared.tsx`       | 合并参考色彩与间距；移除三栏抽屉布局；调整桌面与窄窗口排版、可见焦点及状态文案                                                             |

## 分组与证据语义

- 每个岗位只属于一个分组。正在确认、登录、审核、已暂停或需要核查的申请优先进入“待我接管”。正在暂停和正在停止仍归“跟进中”，不会提前显示已暂停或已停止。
- 未开始、草稿和缺少入口归“待准备”；已有申请的跟踪与恢复归“跟进中”；有明确终局 outcome 的申请归“已结束”。有本人接管事项时优先展示该事项。
- 搜索先限定公司／岗位集合，再计算各筛选计数。顶部待接管清单始终来自全部岗位及当前全局请求。一个岗位仅计一次；全局请求另计一次；活跃岗位任务优先展示。
- 飞书授权和同步故障是单独的连接问题，不改写招聘阶段。`lastAttempt` 标记为“最近尝试”，`lastSuccess` 才用于成功查询记录。人工核查明确标注“非官网回执”。
- `Snapshot.busy` 还可能来自资料或设置写入，因此只有处于真实活跃状态的 run 才能展示交互控制，写资料不会把历史任务重新变成活跃任务。

## 交互与业务边界

“前往官网审核并提交”只发送 `control/focus`，切换到正确 run 的受控浏览器。“我已提交，检查回执”发送当前 review 请求的 `submitted` 答案。两者均不会点击网站的最终提交按钮。

披露确认默认不勾选，确认与回答继续携带当前 `runId`、`requestId`。暂停、登录、提交和同步均等待后端结果。未知提交结果继续受到后端禁止重复申请的保护，人工确认保留原有显式确认与证据标签。

资料候选只进入草稿。编辑已确认值后，字段与确认计数立即显示待确认。保存逐字段调用既有 `saveFact`，使用后端回读结果更新；某字段失败会保留该字段的草稿与错误，其他字段的成功不会把它标为已确认。本轮没有引入整段原子保存。

分组、版本和顶层页面切换会保留当前客户端会话中的资料草稿。放弃修改会恢复已保存值；有未确认草稿的版本不能从启动弹窗继续，其他版本不受影响。草稿没有写入 localStorage，也不承诺跨重启恢复。

设置分类与页面切换保留草稿。检测、授权和调度预览读取已保存配置。选择 Chrome 或 CLI 时只合并相应路径，不清空其他草稿。保存时间不安装调度；安装继续需要计划预览与本人确认。

主导航仍为投递工作台、简历与资料、设置与连接。离开任务页面不会取消任务，快照订阅持续工作。未新增 HTTP 后端、数据库、路由库或状态管理库；受限 IPC、沙箱、Keychain 与原有数据目录保持原有职责。

## 验证与截图

测试代码：`tests/job-presentation.test.ts`、`tests/renderer.browser.ts`，以及更新后的 `tests/client.desktop.ts`、`tests/profile-versions.desktop.ts`。

截图由实际 renderer 构建生成，使用隔离的合约测试数据；不是招聘网站联调成功的证明，也不是把参考 HTML 的截图当成客户端截图。

- [工作台](images/ui-redesign/01-workbench.png)
- [任务工作区](images/ui-redesign/02-task-workspace.png)
- [资料页：单字段保存失败与其他字段已确认并存](images/ui-redesign/03-profile.png)
- [连接概览](images/ui-redesign/04-settings.png)
- [当前请求的披露确认](images/ui-redesign/05-disclosure.png)
- [首次使用](images/ui-redesign/06-first-use.png)
- [1280px 任务页](images/ui-redesign/task-1280.png)
- [390px 窄窗口压力检查](images/ui-redesign/task-390.png)

2026-09-10 的最终执行结果：

| 命令                                                                                                              | 结果                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run typecheck`                                                                                               | 通过                                                                       |
| `npm test`                                                                                                        | 104 项通过，12 个测试文件                                                  |
| `npm run desktop:build`                                                                                           | TypeScript、renderer、preload 与 macOS 辅助程序构建通过                    |
| `npm run test:browser`                                                                                            | 24 项通过；含 18 项真实 Chrome 本地表单测试和 6 项 renderer 合约与布局测试 |
| `JOBAGENT_TEST_SCREENSHOTS=1 npx playwright test --config desktop.playwright.config.ts --trace retain-on-failure` | 最终独立运行 7 项通过，2 项安装包专用测试按条件跳过                        |
| `git diff --check`                                                                                                | 通过                                                                       |

已验证工作台、资料页、设置页和任务页在 1440 / 1280 / 1024 / 390px 宽度下无整页横向溢出。返回列表的关键词、筛选和滚动位置有实际断言。弹窗验证了 Tab 循环、Esc 和关闭后的焦点恢复。

真实 Electron 测试覆盖受限 IPC／沙箱、SQLite 复用、网页登录复检、人工答案、暂停／恢复、PDF 与 Vision OCR、经历绑定、飞书模板确认和两份简历的实际填写／附件隔离。飞书 CLI 使用隔离测试程序，招聘页使用本地测试站点。

回归过程中修复了弹窗焦点恢复与 Tab 循环问题，并调整飞书自动探测验收，使其等待本次异步调用而非断言缓存结果。浏览器与 Electron 套件并行执行时曾出现一次桌面导航超时；增加启动后任务工作区可见断言，最终独立执行全部通过，未将并行 UI 自动化稳定性视为已验证。

补充真实 Electron 窗口截图（仍全部为隔离测试资料）：[工作台](images/ui-redesign/electron-workbench.png)、[飞书分类](images/ui-redesign/electron-feishu.png)、[资料页](images/ui-redesign/electron-profile.png)。

随后为 App CI 重新执行类型、单元与浏览器检查，分别通过类型检查、104 项单元测试和 24 项浏览器测试。运行 `npm run desktop:package` 重新构建本地 Apple Silicon App，校验四个可执行文件的架构与内置 Node 的 SQLite，使用 `ditto` 压缩后再次解压。将 `JOBAGENT_TEST_PACKAGE=1` 与 `JOBAGENT_TEST_PACKAGE_DIR` 指向解压的 App，9 项 Electron 测试全部通过，包含此前跳过的两项安装包测试。CI 配置另通过 `actionlint` 检查，详见 [App CI](app-ci.md)。

真实企业招聘网站、真实飞书目标表写入、付费模型调用以及 Finder／Gatekeeper 分发行为不属于这些隔离测试的证明范围。更新源码后需运行 `npm run desktop:rebuild`，默认 `npm start` 会优先打开已有发布包。

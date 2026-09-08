# 实际验证记录

验证日期：2026-09-08，本机 macOS，Node.js v24.14.0，Google Chrome（系统已安装），飞书官方 CLI 1.0.78。空工作区初始化；未找到任何适用 AGENTS.md。没有使用多 Agent，没有真实投递。

## 命令与结果

| 实际执行                                                              | 结果与范围                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run typecheck`                                                   | 通过，TypeScript 严格检查                                                |
| `npm test`                                                            | **28 / 28 通过**，3 个测试文件                                           |
| `npm run test:browser`                                                | **15 / 15 通过**，本机 Google Chrome 无头 fixture 测试                   |
| `npm run test:browser:headed`                                         | **15 / 15 通过**，实际可见 Google Chrome 窗口                            |
| `npm run build`                                                       | 通过，生成 `dist/src/cli.js`                                             |
| `npm audit --cache /private/tmp/jobagent-npm-cache`                   | **0 vulnerabilities**                                                    |
| 构建后的 `init / doctor / jobs import / status / daily / --help`      | 已实际运行，使用隔离 `/private/tmp/jobagent-smoke` 数据目录              |
| `npm run fixture:seed`                                                | 已运行，生成 `.jobagent-fixture` 与测试岗位；没有真实申请                |
| `schedule install --dry-run`                                          | 已输出完整可解析 plist，**没有安装**                                     |
| `plutil -lint /private/tmp/jobagent-launchd-test.plist`               | **OK**                                                                   |
| `launchctl print gui/UID/dev.jobagent.daily`（由 doctor/status 调用） | **未安装**                                                               |
| Keychain 原生辅助程序                                                 | 已实际编译；写入固定虚构测试项、读回相等、删除后确认不存在；**全部成功** |
| osascript 本地通知调用                                                | 退出码 0，未超时；未验证通知横幅是否实际显示或被本人看到                 |
| 飞书 CLI version/help/auth                                            | 已检查命令与参数；用户授权过期，未进行用户授权流程                       |

Chrome 的首次沙箱内启动被执行环境拦截；申请允许启动本机 Chrome 的执行权限后，测试实际进入页面并通过。Keychain 写入在沙箱内明确报 `KEYCHAIN_UNAVAILABLE`，允许原生 Keychain 测试后写读删通过，程序没有降级成明文存储。

Node 24 的 `node:sqlite` 会输出 ExperimentalWarning。这不是测试失败；项目限定 Node 24+，锁文件保留本次依赖版本。ExcelJS 的间接 uuid 依赖通过兼容 v4 调用的 11.1.1+ 覆盖解决审计项，并实际验证了 XLSX 超链接读写。

## 单元验证的行为

- TXT 规则提取只生成待确认/缺失/冲突，JSON 导入不能自行授权披露。
- SQLite 不包含测试个人字段值；Keychain 不可用时不会写明文替代。
- 文件/目录权限、实例排他锁、SQLite 重启后状态与 outbox 保留。
- CSV/TSV 导入、XLSX 普通超链接和 HYPERLINK 字面公式、来源位置与原始内推参数。
- 强标识岗位去重、弱标识保留独立项、歧义表头显式映射。
- 首版文本 PDF **实际解析**；当时未实现 OCR。后续已接入 macOS Vision 扫描 PDF 识别，最新结果见 [PDF / OCR 补充验收](desktop-verification.md#pdf--ocr-补充验收2026-09-08)。
- 首次失败加三次重试、授权不耗次数、红黄优先级及独立状态。
- 查询缺失/partial 不覆盖上次可靠阶段；未知原始状态不推断拒绝。
- 飞书重复同步不重复创建；超时但远端成功先对账；不确定且未找到行停止。
- 首次同步失败且没有远端行时，本地仍有错误、报告与 outbox。
- 重试耗尽持久化、停止自动重试、手动恢复后保留历史。
- 人工备注、优先级等字段不被自动字段 payload 覆盖。
- CLI 正确处理 stdout/stderr/退出码/超时/身份/业务错误；官方 v1.0.78 行矩阵和 upsert 信封解析；未识别契约不会当空表。
- 模型未经授权不调用；只发送标签与资料路径；严格拒绝带代码/额外字段的返回。**使用 fetch 替身，没有真实云请求**。
- launchd 漏跑日期合并和去重、失败不假记完成；子进程参数不会执行 Shell 注入。

## Chrome fixture 验证的行为

15 个浏览器测试均使用 Google Chrome：

1. 同名姓名字段按区块区分、条件必填、原生多选、单选/多选、重复教育绑定。
2. 经历未绑定即暂停，新增记录重新绑定。
3. URL 不变的多步骤、步骤核验、声明与最终提交停止自动执行。
4. 校验失败时下一步不能假报到达。
5. 上传后覆盖姓名被发现，不自动覆写回去。
6. 人工接管后保留修改及本次会话刻意清空，重启引擎保留非空现值。
7. 缺失/冲突不填“无/否/0”，选填未获披露许可留空。
8. iframe 检查与 partial，结构改变导致语义缓存失效。
9. 登录重新检测、失效与 UNKNOWN 区分。
10. 申请列表跨页读取、有限分页 partial、登录失效。
11. 回执和岗位编号同时匹配才确认；未知回执不能判成功。
12. 站点明确字段配置优先；恶意页面文字不能成为代码。
13. 专用持久化 Chrome profile 关闭重开后保存 fixture 会话，再访问本人页验证。
14. 完整 `track` 执行：同账户两份申请一起查询，零模型调用。
15. 完整 `track` 登录失效：合并一个提醒，不耗重试、不覆盖旧阶段。

Fixture 是本地测试网站，所有资料、公司、进度和提交回执都是测试数据；上述结果**不能推广成真实招聘网站已适配**。

## 未进行的验证/需要本人配置

- 没有真实招聘站点 URL 或合法登录会话，未验证真实网站填写、简历上传、申请回执、进度读取、复杂自定义控件。
- 没有飞书目标表和有效用户授权，未验证真实新增/更新、权限、服务端最终一致性或真实视图红黄整行填色；仅验证当前 CLI 版本与文档契约、使用传输替身验证恢复逻辑。
- 官方求职模板介绍页可访问，未复制登录后的模板。帮助中心填色入口已核查，当前抓取未取得详细正文；真实 UI 和文案未核验。一次性配置步骤位于 `docs/feishu.md`。
- 没有执行真实云模型调用。模型适配要求服务支持 OpenAI 兼容 chat/completions JSON 回复；不支持时回退人工。
- 没有实际 `launchctl bootstrap/bootout` 安装卸载用户任务，也没有观察跨天定时触发；安装实现、plist、日期去重已验证。
- Keychain 用虚构内容测试，未导入或访问本人的真实简历、密码、浏览器认证内容。
- macOS 通知调用被系统接受，不代表桌面横幅已显示；需本人通知权限和未被专注模式抑制。

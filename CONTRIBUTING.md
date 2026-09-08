# 参与贡献

感谢你帮助改进 JobAgent。可以从修正文档、复现问题、本地测试或站点规则开始；较大的功能变更建议先通过 Issue 说明使用场景。

项目介绍与安装入口见 [README](README.md)，历史改动见 [CHANGELOG](CHANGELOG.md)。

## 报告问题与提出建议

使用仓库的 [Issue 模板](https://github.com/xiaoyumuxi/personal-job-agent/issues/new/choose)，尽量提供：

- macOS 版本、芯片架构、Node 版本与源码版本或提交号。
- 使用入口：Electron 开发版、本机构建的 `.app`，或 CLI。
- 最小复现步骤、预期结果与实际结果。
- 脱敏后的错误或诊断文件，以及能够稳定复现问题的本地 fixture。

公开反馈中请勿包含真实简历、资料值、密钥、Cookie、Chrome 资料目录或完整数据库。站点链接中的账户标识、token、内推参数也应移除或替换。桌面诊断导出已做字段白名单限制，上传前仍请自行检查。

## 本地开发

需要 macOS、Node.js 24+、Google Chrome 和 Apple Command Line Tools。Fork 仓库后，在自己的副本中新建分支并安装依赖：

```bash
npm ci
git switch -c docs-or-feature-name
```

开发时使用独立业务目录，避免修改日常申请数据：

```bash
# 与正式数据分离的桌面开发实例
JOBAGENT_HOME="$PWD/.jobagent" npm run desktop:dev

# 同一开发实例的 CLI
npm run dev -- --home "$PWD/.jobagent" init
npm run dev -- --home "$PWD/.jobagent" doctor
```

`.jobagent/` 已列入 `.gitignore`。目录隔离不会生成虚构申请或导入日常 Chrome 登录数据。需要可复现表单时，按 [本地体验指南](docs/cli.md#本地体验与验证) 启动 fixture；不要向真实企业发送测试申请。

## 修改范围与代码边界

- **共享业务**：资料、填写、跟踪与同步逻辑放在 `src/`，供 CLI 和客户端复用。命令参数解析、终端提问和界面表现留在各自入口。
- **桌面交互**：渲染进程只使用受限业务 IPC。新增特权方法时，同时校验来源、参数、任务状态和操作权限。
- **任务状态**：复用运行时记录与结构化事件；不要解析终端日志判断状态，也不要在 UI 中推测成功。交互回答要验证 `runId` 和 `requestId`。
- **浏览器操作**：沿用专用 Chrome 和跨进程锁。人工接管后恢复要重新观察页面，保留人工修改，未知提交结果不能盲目重试。
- **资料与同步**：敏感值继续存 Keychain；同步结果以实际远端响应为准，失败要保留本地记录。
- **调度**：复用 launchd，不新增客户端定时器代替每日任务，不在应用启动时自动安装后台任务。

## 站点适配

参考 [通用规则样例](sites/generic.example.json) 与 [fixture 规则](sites/fixture.json)。提交适配时请说明适用来源、租户或路径范围，以及哪些能力经过验证：登录、填写、查询或回执。

为新增选择器和字段行为提供本地 fixture。配置样例中不得包含真实账户标识、个人资料或认证信息。最终提交按钮不得作为自动操作；没有现场验证的规则请明确标注未验证，不要将样例描述为通用兼容。

## 如何选择验证

| 修改内容                            | 相关检查                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| 仅 Markdown 文档                    | 对修改文件运行 Prettier 检查，核对相对链接、命令与版本说明                       |
| TypeScript / 共享业务               | `npm run typecheck`、`npm test`                                                  |
| 页面观察、字段填写、登录或站点规则  | 类型与业务检查，加 `npm run test:browser`                                        |
| Electron / React / IPC / 客户端状态 | `npm run desktop:build`、`npm run test:desktop`，以及相关业务测试                |
| 工作进程入口、运行时资源或打包      | `npm run desktop:package`，再运行 `JOBAGENT_TEST_PACKAGE=1 npm run test:desktop` |

完整命令和测试条件见 [客户端验收记录](docs/desktop-verification.md) 与 [基础验收记录](docs/verification.md)。不涉及运行行为的文档修改无需重跑浏览器或客户端测试；涉及新行为或错误修复时，优先补充能够捕获实际问题的测试。

格式化请限制到自己修改的文件，例如：

```bash
npx prettier --write README.md CONTRIBUTING.md
git diff --check
```

## 提交 Pull Request

1. 保持一次 PR 的范围清晰，避免混入无关格式化或依赖升级。
2. 写明具体问题和修改后的行为；界面改动可附不含真实资料的截图。
3. 列出实际执行的验证命令和结果，说明未验证的外部服务或设备。
4. 检查提交内容，排除本地数据、密钥、日志、打包产物和测试残留。

仓库提供 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)，提交时填写适用部分即可。代码和文档的授权采用仓库的 [ISC License](LICENSE)；引用或引入第三方内容时，保留其适用的版权与许可说明。

# macOS App 持续构建

[Build macOS App](https://github.com/xiaoyumuxi/personal-job-agent/actions/workflows/build-app.yml) 在推送 `main`、推送 `v*` 标签、向 `main` 提交 PR 时运行，也可以在 Actions 页面点击 **Run workflow** 手动运行。配置文件为 [build-app.yml](../.github/workflows/build-app.yml)。

## 构建与验证

| 产物                       | 构建环境                           | 适用芯片      |
| -------------------------- | ---------------------------------- | ------------- |
| `JobAgent-macOS-arm64.dmg` | `macos-15`，原生 arm64 Node 24     | Apple Silicon |
| `JobAgent-macOS-x64.dmg`   | `macos-15-intel`，原生 x64 Node 24 | Intel         |

两个任务分别安装锁定依赖、运行类型检查和单元测试、编译 Swift 辅助程序、构建 renderer 与 Electron App。CI 检查 Electron、内置 Node、Keychain 与 OCR 辅助程序的 Mach-O 架构，执行内置 Node 的 SQLite 检查，并检查主要运行资源。

浏览器与 Electron 测试依次执行，使用本地招聘表单、隔离数据目录、临时 Keychain 和测试用飞书 CLI。[create-dmg.mjs](../scripts/create-dmg.mjs) 用 `ditto` 保留 App 的可执行权限、框架符号链接与包元数据，再用 macOS 自带 `hdiutil` 创建压缩 DMG，内含 `JobAgent.app` 和“应用程序”快捷入口。安装包测试启动从 DMG 复制出的 App，验证分发文件中的运行资源。只有全部验证通过才上传 DMG。

任务使用只读仓库权限，GitHub 官方 Actions 固定到提交 SHA，不需要签名证书或业务账户密钥。新提交会取消同一分支仍在运行的旧构建；单个架构失败不会取消另一个架构的验证。

## 下载与打开

1. 打开一次成功的 workflow 运行，在 **Artifacts** 或构建摘要中直接下载与芯片匹配的 `.dmg`；下载需要登录 GitHub。上传使用 `archive: false`，不会再包一层 ZIP。
2. 双击 DMG，将 `JobAgent.app` 拖到旁边的“应用程序”快捷入口，然后从“应用程序”打开。使用前安装 Google Chrome；飞书 CLI 为可选外部依赖。App 已内置 Node 和辅助程序，使用构建产物不需要另装 Node 或 Apple Command Line Tools。
3. 如需校验，可另行下载 `.dmg.sha256`，放在 DMG 同一目录，运行 `shasum -a 256 -c JobAgent-macOS-arm64.dmg.sha256`（Intel 替换为 `x64`）。

构建产物保留 14 天，过期后可以手动重新运行。本工作流上传 Actions artifacts，不创建 GitHub Release，也没有自动更新机制。

当前构建没有 Developer ID 签名和 Apple 公证。通过浏览器下载后，macOS 可能拦截首次打开；确认来源后按系统“隐私与安全性”的提示处理。CI 内启动测试不等同于 Finder／Gatekeeper 分发验收，也不代表真实招聘网站、真实飞书目标表或模型已完成联调。

## 本地复现

在 macOS 上安装 Node 24+、Google Chrome 与 Apple Command Line Tools 后：

```bash
npm ci
npm run typecheck
npm test
npm run desktop:package
node scripts/create-dmg.mjs
npm run test:browser
JOBAGENT_TEST_PACKAGE=1 npm run test:desktop
```

本地测试默认使用系统 Keychain，但每项测试使用独立的测试数据目录与对应账户命名。CI 创建临时 Keychain 的步骤仅面向可丢弃的 GitHub 托管 runner，不应直接用于替换个人电脑的默认 Keychain。

仅构建 DMG 可运行 `npm run desktop:dmg`，按本机架构输出 `release/artifacts/JobAgent-macOS-<架构>.dmg` 及 SHA-256 文件。

## 2026-09-10 故障核查

早期运行失败是 `tests/core.test.ts` 将仓库路径写死为 `/agent/`，GitHub checkout 的目录名为 `personal-job-agent`。修复改为读取项目真实资源验证根目录，已随 `5c16d97` 推送；后续提交 `81bc2b7` 的[双架构运行 34444509700](https://github.com/xiaoyumuxi/personal-job-agent/actions/runs/34444509700) 完整通过，两个 DMG 与校验文件均上传成功。

官网岗位发现接线增加了已有测试套件中的用例，并检查安装包内 `discovery/service.js` 与 `discovery/sources.js` 资源存在。CI 不访问真实招聘官网、不需要业务模型密钥；真实网页变化不会随机阻断构建。公开官网小范围联调记录见[岗位发现文档](job-discovery.md)。

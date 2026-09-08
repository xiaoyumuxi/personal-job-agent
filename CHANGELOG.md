# 更新记录

记录源码版本的主要变化。版本标题不代表已创建 Git tag、发布 GitHub Release 或提供已签名安装包。

## 未发布

### 启动体验

- 增加可在 Finder 双击的“启动客户端.command”，首次安装依赖并构建，后续直接打开本机 `.app`。
- 增加 `npm start`、`desktop:rebuild` 和只读 `--check`，发现常见 Node 安装位置并明确报告环境错误。

### 文档与社区

- 重整 README，补充项目定位、导航、架构图与文档索引。
- 补齐 ISC 许可证，保持与项目元数据一致。
- 增加贡献指南、问题与功能建议表单、Pull Request 模板。
- 将详细 CLI 操作保留在独立使用指南中。

## 0.2.0 — 2026-09-08

### 新增

- 接入 Electron + React macOS 客户端，包括投递工作台、我的资料、设置与连接三个页面。
- 增加任务详情抽屉，支持登录重新验证、资料补充、人工审核、安全暂停与恢复。
- 增加工作进程中的结构化事件与交互协议，验证任务与请求标识，防止重复执行和过期回答。
- 接入已有岗位导入、Keychain 资料管理、飞书授权与同步、doctor 和 launchd 配置能力。
- 提供本机架构 `.app` 构建，包含独立 Node 运行时与 Keychain 辅助程序。

### 兼容与验证

- 复用原 CLI、SQLite、专用 Chrome 资料目录和跨进程锁，没有数据迁移。
- 核心测试 34/34、Chrome 回归 16/16、含本机打包的桌面测试 3/3 通过。
- 真实官网、飞书写入、模型端点、实际调度与签名公证的未验证范围见 [验收记录](docs/desktop-verification.md)。

实现提交：[9850236](https://github.com/xiaoyumuxi/personal-job-agent/commit/98502360dcc9144c2d5d0243c6eb630c4557a0ad)。

## 0.1.0 — 2026-09-08

### 新增

- TypeScript CLI、岗位导入、简历解析、资料确认与 SQLite 申请记录。
- Playwright 专用 Chrome、规则辅助填写、人工接管与未知提交结果保护。
- 配置驱动的进度查询、飞书官方 CLI 同步、对账与有限重试。
- Keychain 敏感资料管理、可选模型字段建议、launchd 每日查询。
- 本地复杂表单 fixture，以及业务、浏览器和同步回归测试。

实现提交：[7f5b58c](https://github.com/xiaoyumuxi/personal-job-agent/commit/7f5b58cf695ad4fb1ea610292c63a7c2ab742c7c)。验证范围见 [基础验收记录](docs/verification.md)。

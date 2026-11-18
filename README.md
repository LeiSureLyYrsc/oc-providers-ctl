# oc-providers-ctl

基于 **Rust + Tauri 2 + React / TypeScript** 的 OpenCode 供应商与模型配置管理器。

目标平台：Windows 11 x64、Ubuntu 22.04 / 24.04 x64。安装包由 GitHub Actions 编译；本地开发不需要先生成安装包。

> 首个开发版本。请先在配置副本上验证。配置文件中的参数、公共模型目录的建议以及供应商公布的模型列表，不等于已经验证的运行时能力。

## 使用边界

- 支持 OpenCode V1 / V2 配置方言，尽量原格式编辑，不自动迁移。
- 自动发现全局配置；选择项目后发现其祖先配置链，不扫描整个磁盘。
- 所有修改先暂存、预览，再由用户明确写入指定文件。
- 公共目录补全与模糊匹配只提供建议，不自动改写真实请求模型 ID。
- 供应商模型列表仅在手动触发时拉取，不发送聊天或推理请求。模型列表请求是否计费取决于供应商。
- 不接管 OpenCode OAuth、认证数据库或 API Key 存储，不编辑凭证。仅在手动拉取时于后端内存解析已有引用。
- 浏览器预览是明确标识的演示模式，不能向真实配置保存。

当前版本只编辑已存在的配置文件；新机器若尚无配置，请先创建 `opencode.jsonc`（可先填 `{}`），再通过原生文件选择器载入并明确选择 V1 / V2 供应商格式。请求模型 ID 的现有覆盖值目前只读展示；别名关联不会重命名它。

## 开发

需要 Node.js 22 或更新版本、Rust stable，以及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。Windows 需要 MSVC C++ 工具链和 WebView2；Linux 需要 WebKitGTK 4.1 开发包。

```sh
npm ci
npm run dev
```

以上启动浏览器界面预览。原生桌面开发模式：

```sh
npx tauri dev
```

测试与静态检查：

```sh
npm run typecheck
npm test
npm run build
cargo fmt --all -- --check
cargo test -p oc-providers-core
cargo clippy -p oc-providers-core --all-targets -- -D warnings
```

原生壳的编译检查、安装包生成还需要相应平台依赖；这些检查与纯 Rust 核心测试分开运行。

## 安全操作流程

1. 扫描配置或选择一个项目；确认发现的路径和格式。
2. 选择要编辑的配置源。来自其他文件的设置可能仍覆盖该文件；本工具不把推导结果冒充运行时状态。
3. 编辑模型参数或手动检索补全建议。未识别模型可以保留原 ID。
4. 查看写入预览，确认目标文件及改动范围，再保存。
5. 如需恢复，先确认没有外部改动，再使用本应用创建的备份。

恢复备份与分享导出不是一回事：恢复备份可能保留原配置中的凭证，必须当作敏感文件。当前恢复入口只识别本次应用进程创建的最后一份备份，重启后不自动猜测备份归属；请勿将其视为长期版本历史。不要把配置、备份、日志或诊断输出未经检查就提交到 Git。

预览展示脱敏后的字段级变更摘要，而不是包含上下文原文的完整文件 diff，以免删除供应商时把密钥带入界面。无法在安全范围内保留注释的修改会被拒绝；明确删除整个条目会一并删除条目内部注释，并在预览中提示。

模型列表拉取优先支持已识别的 OpenAI-compatible 协议，不会为未知供应商猜测接口。尚未实现完整的 OpenCode 运行时合并状态、OAuth 管理和代理能力验证；环境配置与远程配置等未覆盖来源会提示无法确认。

## 目录结构

```text
crates/core/         配置发现、解析与安全写回、公共目录、模型列表请求
src-tauri/          桌面 IPC、安全范围与窗口
src/                中文管理界面、草案和预览流程
docs/               边界契约与验证说明
.github/workflows/  检查和 Windows/Linux 发布
```

核心 Rust crate 不依赖 Tauri，可以使用临时目录和模拟 HTTP 响应测试，无需启动 OpenCode，也无需读取真实凭证。

## 发布

工作流定义位于 `.github/workflows/`。版本标签触发 Windows NSIS 安装包以及 Linux deb/AppImage 构建，产物进入 GitHub Release 草稿并提供校验文件。首次发布前请检查应用版本、标签及工作流权限一致。

Linux 产物需要较老构建基线及目标系统启动验证。AppImage 不保证在所有发行版运行，也不消除 glibc、图形栈等兼容约束。

第一版不启用自动更新，不包含 Windows Authenticode 证书。未签名安装包可能触发系统安全警告；请从可信 Release 下载并检查 SHA-256，不建议关闭系统防护绕过。

## 设计与兼容性参考

- [OpenCode 配置](https://opencode.ai/v2/docs/config)
- [OpenCode 模型与变体](https://opencode.ai/v2/docs/models)
- [OpenCode V1/V2 兼容与迁移说明](https://opencode.ai/v2/docs/migrate-v1)
- [models.dev](https://models.dev)
- [Tauri GitHub Actions](https://v2.tauri.app/distribute/pipelines/github/)

OpenCode 运行版本不等于配置格式：V2 可以读取部分 V1 配置。每个嵌套供应商和模型条目应保持一种有效方言；共享 schema URL 本身不能判断版本。对于不能安全理解的条目，应保留原文并停止写入，而不是猜测或自动迁移。

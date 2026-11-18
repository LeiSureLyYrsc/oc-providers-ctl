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

需要 Node.js 22.12+（推荐使用当前受支持的 Node.js LTS）、Rust stable，以及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。Windows 需要 MSVC C++ 工具链和 WebView2；Linux 需要 WebKitGTK 4.1 开发包。

```sh
npm ci
npm run dev
```

以上启动浏览器界面预览。原生桌面开发模式：

```sh
npm run tauri dev
```

这两个启动入口是二选一：`tauri dev` 会自行启动 Vite，不要先运行一个占用 1420 端口的 `npm run dev`。若端口被占用，请关闭自己之前启动的预览进程后重试，不要批量终止 Node.js 或 Python 进程。

可选：在**当前终端进程**设置以下变量，将扫描与备份限定到测试目录，用于验证原生开发模式而不接触真实全局配置。不要把这些测试覆盖变量当作 OpenCode 的配置发现规则。

```powershell
$env:OC_PROVIDERS_CTL_CONFIG_DIR = 'C:\path\to\fixtures\global'
$env:OC_PROVIDERS_CTL_MANAGED_DIR = 'C:\path\to\fixtures\managed'
$env:OC_PROVIDERS_CTL_BACKUP_DIR = 'C:\path\to\fixtures\backups'
npm run tauri dev
```

配置目录需包含 `opencode.json` 或 `opencode.jsonc`。文件不存在时应用展示空状态，不会自动创建真实用户配置。退出测试终端后，上述进程环境覆盖随之消失。

Rust 首次编译可能产生数 GB 缓存，请留足系统盘空间。可在当前终端将缓存指向其他磁盘后再启动；这不会移动源码或 OpenCode 配置：

```powershell
$env:CARGO_TARGET_DIR = 'I:\oc-providers-ctl-build\target'
npm run tauri dev
```

路径和盘符按自己的机器调整。不要在编译或应用运行期间手动移动缓存，也不要用管理员权限启动来掩盖磁盘或权限问题。

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

1. 顶部选择配置文件，左侧选择供应商，右侧管理模型。
2. 点击「编辑」修改参数；添加、删除及补全同样先进入待保存状态。
3. 底部点击「保存…」，检查目标文件和修改内容，再点击「写入文件」。
4. 「更多操作」中可打开配置、包含项目目录、更新模型目录、查看配置详情或恢复备份。

同名配置通过目录标签区分，完整路径可在配置详情和保存预览中查看。来自其他文件的设置可能仍覆盖当前文件；本工具不把文件读取结果冒充运行时状态。

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

工作流定义位于 `.github/workflows/`。`CI` 负责检查，`Release` 负责实际安装包构建：

- **开发构建**：在 Actions 中打开 `Release` → `Run workflow`，选择 `main`。构建 Windows x64 NSIS 安装器、Linux x64 deb/AppImage，并上传带 `SHA256SUMS.txt` 的汇总 artifact；不创建 GitHub Release。
- **版本发布**：推送与应用版本一致的 `v*` 标签，完成同样的检查和打包后创建 GitHub Release 草稿，供人工验收后发布。

也可以使用 GitHub CLI 触发和等待：

```sh
gh workflow run Release --ref main
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
gh run download <run-id> --name oc-providers-ctl-0.1.0-x64 --dir artifacts
```

artifact 名称中的版本以本次构建的应用版本为准。下载后核对校验文件；Windows 安装器不是无需运行时依赖的 portable 包。首次版本发布前请检查应用、npm 包、Rust 桌面 crate 和标签版本一致。

Linux 产物需要较老构建基线及目标系统启动验证。AppImage 不保证在所有发行版运行，也不消除 glibc、图形栈等兼容约束。

第一版不启用自动更新，不包含 Windows Authenticode 证书。未签名安装包可能触发系统安全警告；请从可信 Release 下载并检查 SHA-256，不建议关闭系统防护绕过。

## 设计与兼容性参考

- [OpenCode 配置](https://opencode.ai/v2/docs/config)
- [OpenCode 模型与变体](https://opencode.ai/v2/docs/models)
- [OpenCode V1/V2 兼容与迁移说明](https://opencode.ai/v2/docs/migrate-v1)
- [models.dev](https://models.dev)
- [Tauri GitHub Actions](https://v2.tauri.app/distribute/pipelines/github/)

OpenCode 运行版本不等于配置格式：V2 可以读取部分 V1 配置。每个嵌套供应商和模型条目应保持一种有效方言；共享 schema URL 本身不能判断版本。对于不能安全理解的条目，应保留原文并停止写入，而不是猜测或自动迁移。

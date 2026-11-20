# oc-providers-ctl

基于 **Rust + Tauri 2 + React / TypeScript** 的 OpenCode 供应商与模型配置管理器。

目标平台：Windows 11 x64、Ubuntu 22.04 / 24.04 x64。Windows 提供单个免安装 `.exe`，下载后直接运行；Linux 提供 deb / AppImage。发布产物由 GitHub Actions 编译。

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

检查 `docs/` 中能被脚本识别的错误提示摘录是否仍出现在 Rust 源码中：

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-doc-strings.ps1
```

修改错误文案时，请同步更新文档。校验覆盖范围见下文「文档错误字符串校验的边界」。

原生壳的编译检查、发布产物生成还需要相应平台依赖；这些检查与纯 Rust 核心测试分开运行。

在 Windows 本地生成免安装应用：

```sh
npm run tauri build -- --no-bundle -- --locked
```

产物是 `target/release/oc-providers-ctl.exe`；若设置了 `CARGO_TARGET_DIR`，则位于该目录下的 `release/`。前端资源已内嵌，只需分发这个 `.exe`，不需要同时复制 `dist/`、Node.js 或 Rust 工具链。

## 安全操作流程

1. 顶部选择配置文件，左侧选择供应商，右侧管理模型。
2. 点击「编辑」修改参数；添加、删除及补全同样先进入待保存状态。
3. 底部点击「保存…」，检查目标文件和修改内容，再点击「写入文件」。
4. 「更多操作」中可打开配置、包含项目目录、更新模型目录、查看配置详情或恢复备份。

同名配置通过目录标签区分，完整路径可在配置详情和保存预览中查看。来自其他文件的设置可能仍覆盖当前文件；本工具不把文件读取结果冒充运行时状态。

恢复备份必须当作敏感文件：**备份是配置文件的完整副本、不做脱敏**，原文件里有的凭证会原样留在里面。当前恢复入口只识别本次应用进程创建的最后一份备份，重启后不自动猜测备份归属；请勿将其视为长期版本历史。不要把配置、备份、日志或诊断输出未经检查就提交到 Git。**本工具没有导出或分享功能**——恢复备份是回滚，不是搬运用途。

预览展示脱敏后的字段级变更摘要，而不是包含上下文原文的完整文件 diff，以免删除供应商时把密钥带入界面。无法在安全范围内保留注释的修改会被拒绝；明确删除整个条目会一并删除条目内部注释，并在预览中提示。

模型列表拉取支持已识别的 **OpenAI 与 Anthropic** 协议（含 Anthropic 兼容网关），不会为未知供应商猜测接口。未配置 baseURL 的兼容网关在**构造请求之前**就被拒绝，与网关是否实现 `/models` 无关。尚未实现完整的 OpenCode 运行时合并状态、OAuth 管理和代理能力验证；环境配置与远程配置等未覆盖来源会提示无法确认。

供应商模型列表允许使用 HTTP 或 HTTPS；HTTP 会提示明文传输风险，但不会阻止请求。凭据也可能随 HTTP 请求明文传输，请只连接可信端点。公共模型目录仍通过 HTTPS 更新。

模型编辑支持上下文、输入和输出 token 上限；V2 还可编辑是否支持思考、是否允许关闭、可选档位及思考预算范围。这些是能力描述，不会修改模型请求的默认思考强度；存在档位时，OpenCode 会忽略预算。V1 保留原有布尔能力标记，不自动迁移格式。可在编辑中点击「查询模型资料」，或在模型详情点击「从模型目录查找」，从 models.dev 缓存选择字段填入；已有值默认不覆盖，未知值不填入，真实请求模型 ID 不变。所有修改仍须经过暂存、预览和明确写入。

## 目录结构

```text
crates/core/         配置发现、解析与安全写回、公共目录、模型列表请求
  src/config.rs      JSONC 格式保留读取/编辑/写回、备份、V1/V2 方言（包体主要部分）
  src/catalog.rs     models.dev 公共目录下载与缓存、本地模糊搜索
  src/inventory.rs   供应商 /models 端点拉取（仅列模型 ID，不发推理请求）
  tests/             配置发现、编辑、Windows ACL、目录与模型列表的集成测试
src-tauri/          桌面 IPC、安全范围与窗口
  src/commands.rs    对前端暴露的 9 个 IPC 命令
src/                中文管理界面、草案和预览流程
docs/               边界契约与验证说明
  IPC.md             前端 ↔ Rust 命令与 DTO 契约
  config-editing.md  可编辑路径规则与错误处理（排错入口）
  VERIFICATION.md    验证证据记录
scripts/             辅助脚本（含文档错误字符串校验）
.github/workflows/  检查和 Windows/Linux 发布
```

核心 Rust crate 不依赖 Tauri，可以使用临时目录和模拟 HTTP 响应测试，无需启动 OpenCode，也无需读取真实凭证。

### 文档错误字符串校验的边界

`scripts/verify-doc-strings.ps1` 把文档里反引号包住的错误提示与 Rust 源码比对，防止文案改动后文档失真。
**但它不是全覆盖**，看它的输出要连 `NOT CHECKED` 那段一起看：

- **常规校验只收集「一整句、以句号结尾、单行、内容里没有中文」的消息。** 不符合这个形状的引用（跨行的、夹在中文行文里的、
  不像一句完整话的）根本不会被收集，也就不会出现在任何一段输出里。
- **四条带 `<!-- verify:<id> -->` 标记的摘录必须通过校验。** 脚本要求每个固定 ID 恰好出现一次，
  紧跟同一个表格单元格内的代码段，并检查源码中是否有逐字相同的完整字符串。**这四条是逐字校验，
  占位符名称也必须一致。**
- **其余摘录按占位符归一后校验。** 文档写 `{id}` 而源码写 `{}` 或 `{provider_label}`，两者视为相同；
  周围的词必须逐字一致（区分大小写）。代价是**占位符名字本身不再被校验** —— 把 `{status}` 改成 `{code}`
  不会报错。这是有意的取舍：用户看到的是那些词，不是参数变量名。
- **以 ` ...` 结尾的摘录无法校验**，因为标记之后的内容文档里根本没写。这类摘录列入 `NOT CHECKED`，
  仅供人工核对，并标出它出现在哪个文件第几行。
- **删掉结尾句号、或把句子截短，会归为 `TRUNCATED` 报错。** 注意这里**没有一个独立的「句号判定层」**：
  它是整句在源码里找不到的后果。别去找那个不存在的判定。
- **区分大小写地查找源码。** 常规摘录可以是更长消息的一部分。
- **只比对文案，不比对行为**。哪条代码路径会抛出这条消息、调用点有几个、用户是否真能看到，都不在脚本范围内。
- **不保证固定 ID 和它绑的那句话是同一件事。** 把两个标记互换位置，两句话仍然都在、都真实存在于源码，
  脚本仍然通过。所以脚本**每次运行都会把四个 `ID -> 代码段` 的配对打出来**，供评审逐条读。
  这是唯一一处「绿了但可能完全错」的地方。
- **句边界校验只作用于含占位符的摘录。** 不含占位符的摘录按原样子串比对，**在它前后往源码里加内容不会被发现**。
  只有含占位符的摘录才有歧义，所以只有它们走这条判据；但一条只覆盖部分摘录的保护，如果不写范围，会被读成覆盖全部。
- **不跟踪消息是怎么拼出来的。** 要求被引用的句子**从源码字面量的起始处（引号之后）开始**。**可以只引完整首句**——源码句号后还有续写也算通过。
  原句仍满足源码边界检查时，另行拼接的前缀不会影响校验结果。用 `concat!`、`[..].concat()`、`String + &str` 和 `format!` 拼接前缀的四种文本示例均已通过脚本校验。
  把前缀写进同一个字面量会使原句离开起始引号，因此该处不再匹配。
- **不证明源码到此为止。** 在同一个字面量内给消息**追加**一句不会被发现：文档摘录仍是那条消息的前缀，
  而这正是合法引用首句的样子。两者形状相同，本检查分不开。

脚本通过表示参与校验的每个摘录仍能在源码里找到。输出里的两个数说的是不同的事：**摘录出现次数**（同一句在文档里被引几次就算几次）
和**不同摘录数**。两者不等是正常的，不是漏列出。

## 发布

工作流定义位于 `.github/workflows/`。`CI` 负责检查，`Release` 负责发布产物构建：

- **开发构建**：在 Actions 中打开 `Release` → `Run workflow`，选择 `main`。构建 Windows x64 免安装 `.exe`、Linux x64 deb/AppImage，并上传带 `SHA256SUMS.txt` 的汇总 artifact；不创建 GitHub Release。
- **版本发布**：推送与应用版本一致的 `v*` 标签，完成同样的检查和打包后创建 GitHub Release 草稿，供人工验收后发布。

也可以使用 GitHub CLI 触发和等待：

```sh
gh workflow run Release --ref main
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
gh run download <run-id> --name oc-providers-ctl-0.1.0-x64 --dir artifacts
```

artifact 名称中的版本以本次构建的应用版本为准。下载后核对校验文件。Windows 文件名为 `oc-providers-ctl_<版本>_x64-portable.exe`，直接双击运行，无需安装或管理员权限；更新时退出应用并替换 `.exe` 即可。首次版本发布前请检查应用、npm 包、Rust 桌面 crate 和标签版本一致。

Windows 应用仍依赖 **Microsoft Edge WebView2 Runtime**（Windows 11 通常已自带）；缺失时需从微软官方安装运行时。免安装指应用自身无需安装，并非将整个浏览器运行时打进单文件。

应用不会把配置、备份或缓存写入 `.exe` 同级目录：仍按现有规则发现 OpenCode 配置，备份位于 `%LOCALAPPDATA%\oc-providers-ctl\backups`，缓存和 WebView2 数据位于 `%LOCALAPPDATA%\dev.ocproviders.ctl`。这不是将所有数据随 U 盘携带的模式。旧安装版与免安装版沿用这些数据路径；如需移除旧版，可通过 Windows「已安装的应用」卸载，之后运行下载的免安装文件。

Linux 产物需要较老构建基线及目标系统启动验证。AppImage 不保证在所有发行版运行，也不消除 glibc、图形栈等兼容约束。

第一版不启用自动更新，不包含 Windows Authenticode 证书。未签名应用可能触发系统安全警告；请从可信 Release 下载并检查 SHA-256，不建议关闭系统防护绕过。

## 设计与兼容性参考

项目内文档：

- [配置编辑规则与错误处置](docs/config-editing.md) — 想改某个字段前查这里；看到报错也查这里
- [桌面边界契约（IPC）](docs/IPC.md) — 前端与 Rust 的命令、DTO、编辑规则
- [验证证据记录](docs/VERIFICATION.md) — 每项声称对应的测试证据与限制
- [变更日志](CHANGELOG.md)

外部参考：

- [OpenCode 配置](https://opencode.ai/v2/docs/config)
- [OpenCode 模型与变体](https://opencode.ai/v2/docs/models)
- [OpenCode V1/V2 兼容与迁移说明](https://opencode.ai/v2/docs/migrate-v1)
- [models.dev](https://models.dev)
- [Tauri GitHub Actions](https://v2.tauri.app/distribute/pipelines/github/)

OpenCode 运行版本不等于配置格式：V2 可以读取部分 V1 配置。每个嵌套供应商和模型条目应保持一种有效方言；共享 schema URL 本身不能判断版本。对于不能安全理解的条目，应保留原文并停止写入，而不是猜测或自动迁移。

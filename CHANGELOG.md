# Changelog

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

首版尚未正式发布（当前版本号 `0.1.0`），因此下方按开发阶段分组记录。
破坏性变更会在条目中显式标注 **BREAKING** 并附迁移说明。

## [Unreleased]

### Fixed

- **模型尚无 `limit` 时无法添加上限值**（`a97abc0`，报 `The parent object does not exist.`）。
  模型没有 `limit` 对象时，给 `limit.context` / `limit.input` / `limit.output` 执行 `set` 会被校验拒绝，
  而写回层本来就会为受支持的创建路径自动补全缺失的中间对象。
  现在 `set` 允许父对象不存在，`remove` 仍要求它存在。
- **父对象“不存在”与“类型不对”的提示已分开**（`validate_creatable_block`）。
  **但“类型不对”的那两句目前用户到不了。** 一份 `limit` 不是对象的文件，在走到该分支之前，
  已被 `provider_has_invalid_types` 判为无效类型、置 `unsafe_nesting`，由 `prepare_changes`
  直接返回 `This file contains an unsafe mixture of V1 and V2 provider syntax and is read-only.`。
  **保留该只读边界是刻意的决定（2026-11-20）**：此类文件本就不合法，要求先修源文件更保守。
  因此这次**真正交付给用户的是 `set` 允许父对象缺失**；“形状错 / 不存在”的区分目前不可达，
  **不要把它算作本版收益**。对应的测试断言已收紧为精确措辞（避免“不等于某句就算过”的假绿）。
- **`capabilities.reasoning` 同步到同一规则**，同时修掉一个反向问题：原来删除一个不存在的 `reasoning` 叶子会**静默通过**。
- 补了对应回归测试（`crates/core/tests/config_editing.rs`），覆盖第二个 limit 叶子与批量编辑场景（`684662c`）。

### Changed

- `set` 与 `remove` 对父对象的校验要求已明确区分，并写进 `docs/config-editing.md`。
- **文档：** `docs/config-editing.md` 的 `/models` 一节改为**按读者路径组织**：先过「包是否在白名单内」
  这道门（未通过时请求根本不发出），再分**四种结局**：硬错误 / 软失败（0 个模型 + 2 条 warning）/
  有信号的截断（Anthropic 的 `has_more`）/ **无任何信号的静默截断**
  （Gemini `nextPageToken`、Cohere `next_page_token`、Fireworks `nextPageToken` —— 代码只认
  `has_more` / `next` / `next_page` / `nextPage`，这些字段不在其中，因此连 warning 都没有）。
- **文档：** `docs/config-editing.md` 为 `The parent object does not exist.` 增加「三处抛出点」说明，
  并明确三处都只由 `remove` 进入——所以这句话对用户只有一种含义：要删的东西的父级不在。
- **新增校验脚本：** `scripts/verify-doc-strings.ps1` 确保文档引用的错误消息在源码中存在（防措辞漂移），
  每次运行会先跑一条负例自测，避免退化成永远绿。

### Notes

- **不能靠版本号判断是否包含此修复**：修复分支与修复前的应用版本号同为 `0.1.0`。
  首次包含该修复的发布版本确定后，再回填 `[0.1.1]` 之类的版本号并更新本节。

## [0.1.0] - 2026-11-19

首个开发版本的完整开发过程。**这不是一个已验证可用于生产配置的发布版本**——
请在配置副本上先行验证，见 `README.md` 的「使用边界」。

### Added

- **桌面配置管理器本体**（`66d1dd6`）：基于 Rust + Tauri 2 + React / TypeScript，
  用于管理 OpenCode 的 `opencode.json` / `opencode.jsonc` 中的供应商与模型配置。
  - 自动发现全局配置；选择项目后发现其祖先配置链，不扫描整个磁盘。
  - 支持 OpenCode **V1 / V2** 两种配置方言，尽量按原格式编辑，**不自动迁移**。
  - 全部修改先暂存 → 预览 → 由用户明确写入，不做隐式落盘。
- **保留格式的写回**：JSONC 注释、尾随逗号、缩进、BOM、CRLF/行尾在可能的情况下保留；
  无法安全表达的修改会被拒绝而不是强行改写。
- **写入安全**：源文件哈希校验、限制性权限备份、同目录临时文件 + 平台安全替换；
  检测到外部修改后拒绝保存。
- **公共模型目录**（`catalog.rs`）：models.dev 目录下载与缓存，本地模糊搜索。
  目录建议仅作参考：只采纳用户显式选择的字段，已有值需显式覆盖，缺失值不清空配置。
  采纳元数据**不会改名**真实请求模型 ID，也不会创建变体。
- **供应商模型列表**（`inventory.rs`）：手动触发时调用供应商 `/models` 端点，仅列模型 ID。
  **不发送聊天或推理请求。**
- **HTTP 供应商端点支持**（`eecc671`）：允许 HTTP 与 HTTPS；HTTP 会提示明文传输风险但不阻断。
  拒绝重定向、URL 内嵌凭证、凭证类查询参数、URL 片段与非 HTTP(S) 协议。
- **模型能力编辑**（`eecc671`）：可编辑上下文 / 输入 / 输出 token 上限；
  V2 另可编辑是否支持思考、是否允许关闭、可选档位与思考预算范围。
- **浏览器演示模式**：明确标识的演示模式，不能向真实配置文件保存。

### Changed

- **界面简化**（`495e464`）：改为单一供应商/模型工作区，正文 16px、控件 44px；
  配置详情与诊断信息改为按需展开。保存仍为「预览 → 写入」两步。
  预览响应携带来源路径、源哈希与草稿版本号，旧文件/旧版本的回复不能满足新的待处理预览。

### Fixed

- **npm 锁文件缺失可选 wasm 依赖**（`6fa6b1e`）：`package-lock.json` 缺少
  `@emnapi/core` 与 `@emnapi/runtime` 两个传递依赖，导致干净环境下 `npm ci` 失败。
  未新增直接依赖，未关闭锁文件校验。
- **Windows runner 路径比较**（`160a28b`）：发现类测试直接比较临时路径字符串，
  runner 提供 8.3 短名别名 `RUNNER~1` 而规范化结果是 `runneradmin`。
  测试改为对两侧都做 `fs::canonicalize`，生产侧规范化行为不变。
- **模拟服务器写放大**（`fa27496`）：测试用 mock server 向已停止读取的客户端写超大响应会挂起。
  现在限制 socket 写入与关闭，首次出错即停止写入，并拒绝不完整的 HTTP 请求头。

### Build & Release

- **CI 与发布工作流**（`e86636b`）：`.github/workflows/` 下 `CI` 负责检查、
  `Release` 负责构建发布产物（Windows x64、Linux x64 deb/AppImage，并附 `SHA256SUMS.txt`）。
- **Linux 打包 SIGPIPE 预检修复**（`eaa74be`）。
- **Windows 改为免安装单文件分发**（`8209fa4`）：Windows 侧不再打包安装程序，
  产物为单个可直接运行的 `oc-providers-ctl.exe`；Linux deb/AppImage 打包方式不变。

### Security

- 不接管 OpenCode OAuth、认证数据库或 API Key 存储；**不编辑凭证**。
  仅在手动拉取模型列表时于后端内存中解析已有引用。
- 前端 DTO、预览与错误信息不含原始文件内容、HTTP 响应体、认证头或凭证值。
- 预览 diff 对包含凭证的区块做遮蔽；无法在安全范围内保留注释的修改会被拒绝。
- 备份可见但按敏感文件对待：恢复仅限本应用进程创建的最后一份备份，重启后不猜测归属。

### Known limitations

- 仅编辑**已存在**的配置文件。新机器若尚无配置，需先创建 `opencode.jsonc`（可先填 `{}`），
  再通过原生文件选择器载入并明确选择 V1 / V2 供应商格式。
- 请求模型 ID 的现有覆盖值目前只读展示，别名关联不会重命名它。
- 首次版本不启用自动更新，不含 Windows Authenticode 证书；未签名应用可能触发系统安全警告。
- Linux 产物需按目标发行版实际启动验证；AppImage 不保证在所有发行版运行。
- Windows 免安装版仍依赖系统已有的 **Microsoft Edge WebView2 Runtime**。

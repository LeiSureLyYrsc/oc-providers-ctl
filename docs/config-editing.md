# 配置编辑规则与错误处置

这一页同时是**规则表**和**排错入口**：

- 上半部分说「哪些路径能编辑、哪些被拒绝、为什么」——按方言（V1 / V2）组织。
- 下半部分按**错误类别**列出界面会出现的提示原文，并指回上半部分的规则。

看到一句报错不知道什么意思，直接用浏览器搜索这句话，会跳到下半部分对应类别。
想提前知道能不能改某个字段，查上半部分。

> 本文所有规则与提示原文均取自 `crates/core/src/config.rs`。
> 「规则」是设计意图，「提示原文」是代码里的事实。两者不符时以代码为准——那说明有 bug，请报给我们。

### 关于「这条结论是怎么来的」

文档里每条行为描述的可信度并不一样，但以前它们长得一模一样。现在按来源分四档：

| 标记 | 含义 | 什么情况能标 |
| --- | --- | --- |
| **【码】** | 从源码读出来的 | 能给出**函数名**或可 `grep` 的字面量 |
| **【测·直】** | 实测，且实测环境 == 目标环境 | 带真凭据、打真端点 |
| **【测·近】** | 实测，但环境 != 目标环境 | 匿名探针、mock、别人机器上跑的 |
| **【推】** | 推断，未验证 | 其余一切，**包括「别处文档这么写所以应该如此」** |

> **本项目目前一条【测·直】都没有**——没有任何人有真实凭据。
> 也就是说：本文所有实测类结论都只是**近似**，不是目标场景的直接证据。
> 这个事实本身比任何一条结论都值得记住。

**读本文时请注意四件事，都是本项目实际踩过的：**

1. **【码】不等于【对】。** 它只保证「这句话确实在代码里」。本项目出现过：提示原文一字不差
   （【码】成立），但对「它在什么情况下出现」的解释是错的。
2. **【码】的边界是可操作的：【码】只允许写「那行代码做了什么」，不允许写「用户什么时候会看到它」。**
   后者要追调用链，而追调用链就出过错。**函数内部行为 = 【码】；跨越调用链的行为 = 【推】**，
   除非把调用点也列出来。
3. **【码】会过期，而且是以天为单位过期。** 本项目实证：同一条分支上、只隔一个 refactor，
   某个错误的三处位置就整体位移了（2177/2663/3078 → 2179/2671/3086）。
   所以本文**以函数名为主、行号只作附注**——行号会失效且看不出来，函数名不会。
   **行号是线索，不是契约**；看到行号对不上时，以函数名为准去搜。
4. **【推】不是耻辱，假装它是【码】才是。** 看到【推】请当作「待核实」，不要当结论用。

**标注写在结论旁边，不是集中列在这里**——一条结论自带来源，读者才不用来回对照。

> **本节覆盖的是「改了某个字段会看到什么」，不是「全部错误消息的清单」。**
> 源码里共有约 197 条不同的错误消息（去重后），本文按**用户操作路径**收进了与编辑、
> 凭据、模型列表拉取相关的那些，**没有逐条穷举**。所以：
> - 查不到某句话**不代表它不是错误**，可能是它不在本文的范围内；
> - 本文也不声称完整。若要穷举，请从源码重新提取，别指望这份文档。
>
> 同理，`scripts/verify-doc-strings.ps1` 只校验**本文引用了的**原文没有漂移，
> 它既不是覆盖率检查，也不是正确性检查。

本文中目前我自己认的【推】（欢迎纠正）：

| 内容 | 我的状态 |
| --- | --- |
| 各家 `/models` 返回里模型 ID 用哪个键、要不要前缀变换 | 引自 @Anna 的官方文档核实，**我没打过真实端点** |
| 各家默认每页条数（20 / 50 / 50） | 同上，无实测 |
| 云端供应商 `api-version` 是否可选 | 我这轮没见过任何一次真实请求 |

> 引用他人实测时**保留原始报告和条件**，让读者能一路回到源头——经过两次转述之后，
> 就没人知道最初是谁在什么条件下测的了。

---

## 零、通用前提

### 编辑是一次批量操作

一次编辑 = 一个 `Edit` 数组，作用在**一个文件**上，最多 **64 条**。每条 `Edit` 是：

```ts
{ op: 'set' | 'remove'; path: string[]; value?: unknown }
```

- `set` **必须**带 `value`。
- `remove` **必须不带** `value`。
- 同一路径在一次批量里出现两次会被拒绝（避免"写两次冲突"）。

### 永远两步：暂存 → 预览 → 写入

任何修改都不会在你点「保存」前落盘。写入时还会再校验一次源文件哈希：
如果你在预览之后用别的编辑器改了同一个文件，写入会被拒绝，需要重新载入。

### 会被整只文件拒绝、无法编辑的配置

以下情况文件是**只读**的，界面上所有编辑都不可用：

| 情况 | 说明 |
| --- | --- |
| 机器托管配置 | 由工具链等自动管理的文件，本应用不改。 |
| 符号链接 | 指向别处的配置文件不改，避免写穿到未知目标。 |
| 重复键 | 同一个对象里有重复键，按哪种语义解释都有风险，无法安全编辑。 |
| 文件本身只读 | 磁盘上的只读标记会被遵守。 |
| 方言为 `invalid` / 嵌套字段非法混合 | 结构不合法或 V1/V2 混用得不合法。 |
| 字段类型已错 | 例如 `limit.context` 是字符串 `"32768"` 而不是数字。错的数据不"顺手改对"，因为那会掩盖来源问题。 |

`ambiguous`（无从判断 V1 还是 V2）与 `mixed`（顶层两种并存但各自合法）**不是**只读：
它们要求你先显式创建对应的 provider map，用这个动作表明你要用哪种格式。详见第三节。

---

## 一、V1 方言

顶层键是 `provider`。每个供应商条目下用 `npm` / `api` / `options`。

### 供应商层

| 路径 | 可 `set` | 可 `remove` | 备注 |
| --- | --- | --- | --- |
| `provider.<id>` | ✅ 仅当**不存在** | ✅ | 创建 = 给一个对象。**已存在则不能整体替换**，只能改字段。 |
| `provider.<id>.name` | ✅ | ✅ | 字符串，≤4096 字符 |
| `provider.<id>.npm` | ✅ | ✅ | 字符串 |
| `provider.<id>.api` | ✅ | ✅ | 字符串 |
| `provider.<id>.options.baseURL` | ✅ | ✅ | 只允许这一个 option |
| `provider.<id>.options.<其它>` | ❌ | ❌ | 凭证与 header 类选项受保护，界面不编辑 |
| `provider.<id>.models` | ❌ 整体 | ❌ 整体 | 必须通过下面的具体模型路径 |

### 模型层

`<model>` 是 `models` 对象里的**键**，不是数组下标。

| 路径 | 可 `set` | 可 `remove` | 备注 |
| --- | --- | --- | --- |
| `provider.<id>.models.<model>` | ✅ 仅当**不存在** | ✅ | 创建 = 给一个对象。已存在不能整体替换。 |
| `...<model>.name` | ✅ | ✅ | |
| `...<model>.id` | ✅ | ✅ | 上游真实请求 ID（覆盖键名）。删掉它不会改键名。 |
| `...<model>.reasoning` | ✅ | ✅ | **必须布尔值**（V1 只有"支不支持"） |
| `...<model>.variants` | ✅ 整体 | ✅ 整体 | 变体是对象。含凭证/自定义 header 的变体不可编辑。 |
| `...<model>.limit` | ❌ 整体 | ❌ 整体 | 走下面的叶子路径 |
| `...<model>.limit.context` | ✅ | ✅ | 非负整数。**`limit` 不存在时 `set` 会自动创建** |
| `...<model>.limit.input` | ✅ | ✅ | 非负整数。同上 |
| `...<model>.limit.output` | ✅ | ✅ | 非负整数。同上 |
| `...<model>.capabilities` | ❌ | ❌ | V1 没有这个概念（用 `reasoning`） |

> **V1 没有** `capabilities.reasoning`、思考档位、思考预算。V1 的 `reasoning` 是布尔值，
> 不会被自动升级成 V2 的对象形式，也不会自动生成变体。

> **关键区别：`set` 与 `remove` 的父对象要求不同。**
> `set` 允许父对象不存在（接口会创建）；`remove` 要求父对象和叶子都已经存在。
> 这是设计意图，不是遗漏——否则「给新模型加上限」这件事就没法做了。

---

## 二、V2 方言

顶层键是 `providers`（复数）。每个供应商条目下用 `package` / `settings`。

### 供应商层

| 路径 | 可 `set` | 可 `remove` | 备注 |
| --- | --- | --- | --- |
| `providers.<id>` | ✅ 仅当**不存在** | ✅ | 已存在不能整体替换 |
| `providers.<id>.name` | ✅ | ✅ | |
| `providers.<id>.package` | ✅ | ✅ | |
| `providers.<id>.settings.baseURL` | ✅ | ✅ | 只允许这一个 setting |
| `providers.<id>.settings.<其它>` | ❌ | ❌ | 凭证与 header 类设置受保护 |
| `providers.<id>.models` | ❌ 整体 | ❌ 整体 | |

### 模型层

| 路径 | 可 `set` | 可 `remove` | 备注 |
| --- | --- | --- | --- |
| `providers.<id>.models.<model>` | ✅ 仅当**不存在** | ✅ | 已存在不能整体替换 |
| `...<model>.name` | ✅ | ✅ | |
| `...<model>.modelID` | ✅ | ✅ | 上游真实请求 ID |
| `...<model>.limit` | ❌ 整体 | ❌ 整体 | 走叶子路径 |
| `...<model>.limit.context` / `.input` / `.output` | ✅ | ✅ | 非负整数。**`limit` 不存在时 `set` 会自动创建** |
| `...<model>.capabilities` | ❌ 整体 | ❌ 整体 | 只能加 `reasoning` |
| `...<model>.capabilities.reasoning` | ✅ | ✅ | 对象，见下。`capabilities` 不存在时 `set` 会自动创建 |
| `...<model>.variants` | ✅ 整体 | ✅ 整体 | **数组**（V1 是对象） |

### `capabilities.reasoning` 的合法形状

V2 的思考能力是**对象**，不是布尔值：

```jsonc
"capabilities": {
  "reasoning": {
    "supported": true,        // 必填，布尔
    "toggle": true,           // 可选，布尔 — 是否允许关闭思考
    "effort": ["low", "high"],// 可选，字符串数组 — 可选档位，值必须唯一
    "budget": { "min": 1024, "max": 8192 }  // 可选，思考 token 预算范围
  }
}
```

约束：

- `supported` **必填**且必须是布尔值。
- `supported: false` 时**不得**带 `toggle` / `effort` / `budget`——只能是 `{ "supported": false }` 这一个字段。
- `effort` 必须是字符串数组，最多 **32** 项；每个档位非空、**≤ 64 字符**，且**不能重复**。
- `budget` 的 `min` / `max` 必须是安全整数，且 **`min` 不得大于 `max`**。
- 这里是**能力描述**，不是默认请求设置。填了档位后，OpenCode 会忽略 `budget`。
- 本版本只允许新增 `capabilities.reasoning`。其它 `capabilities.*` 字段不能通过界面新增。
- 已有的合并元数据不会被静默丢弃；V1 的布尔标记不会被自动升级或生成变体。

---

## 三、默认模型

路径固定为 `["model"]`（V1/V2 相同，都是顶层键）。

| 操作 | 条件 |
| --- | --- |
| `set` | 值必须是字符串，且必须是 `provider/model` 形式（引用形式 `{env:...}` 等直接通过） |
| `remove` | 必须已存在，且已存在值必须是**字符串** |

不允许的情况：

- 文件方言为 `ambiguous` 时，先建一个 provider map 表明格式，再改默认模型。
- 已存在的默认模型是**对象选择器**时，本版本不能替换也不能删除。

---

## 四、错误处置（按类别）

复制界面上那句话，用页面搜索直接命中。

### 类别 A — 路径本身不合法

| 提示原文 | 含义与处置 |
| --- | --- |
| `The edit path is empty or too deep.` | 路径层级超出上限。检查是否误传了空数组或多层嵌套。 |
| `The edit path contains an empty or overlong segment.` | 某一段是空串或超过 512 字符。检查供应商 ID / 模型键名。 |
| `The edit path contains control characters.` | 键名里含控制字符（换行、制表符等）。多半是从别处粘贴带进来的。 |
| `Only provider, model and default-model paths may be edited.` | 路径第一段必须是 `provider`、`providers` 或 `model`。其它顶层键一律不可编辑。 |
| `The same path appears in more than one edit.` | 同一次批量里重复写了同一个路径。去掉重复的那条。 |
| `A set edit requires a value.` | `set` 必须带值。 |
| ``A `remove` edit must not include a value.`` | `remove` 不能带值。 |

### 类别 B — 这个方言不支持这个字段

| 提示原文 | 含义与处置 |
| --- | --- |
| `That provider field cannot be edited in this version.` | 查第一节/第二节的供应商层表。常见原因：在 V2 里用了 `npm`，或在 V1 里用了 `package`。 |
| `That model field cannot be edited in this version.` | 查模型层表。常见原因：在 V1 里用 `capabilities`，或在 V2 里用布尔 `reasoning`。 |
| `Only `options.baseURL` can be edited; credential and header options are protected.` | V1 的 `options` 下只开放 `baseURL`。凭证类不许在界面改。 |
| `Only `settings.baseURL` can be edited; credential and header settings are protected.` | 同上，V2 的写法。 |
| `That model field cannot be edited.` | 完全不在白名单里的字段。 |
| `Replace this field through its leaf paths instead.` | 你试图整体改 `limit` 或 `capabilities`。改成具体叶子路径。 |
| `Unsupported limit field `<key>`.` | `limit` 下只认 `context` / `input` / `output`。 |
| `Unsupported capabilities.reasoning field `<key>`.` | `reasoning` 下只认 `supported` / `toggle` / `effort` / `budget`。 |
| `Only `capabilities.reasoning` may be added in this version.` | `capabilities` 下其它字段不能新增。 |
| `V1 model reasoning must be a boolean.` / `V1 reasoning must be a boolean.` | V1 的思考能力只能是 `true`/`false`，不能是对象。 |
| `The existing provider dialect does not match this edit path.` | 供应商条目实际是 V2，你却用 `provider.` 路径改它（或反之）。路径前缀要和条目方言一致。 |

### 类别 C — 父对象不存在，或形状不对

先分清三件**完全不同**的事，处置各不相同：

| 情形 | 含义 | 能否自动修好 |
| --- | --- | --- |
| 父对象**不存在** | 例如模型还没有 `limit`，你要加 `limit.context` | ✅ `set` 会自动创建；`remove` 则报错 |
| 父对象**存在但类型错** | 例如 `"limit": "abc"` | ❌ 源文件是坏的，必须人工修正 |
| 路径在文件里**定位不安全** | 文件格式太特殊，无法安全改写 | ❌ 调整文件格式或手工编辑 |

#### ⚠️ 先看这条：`The parent object does not exist.`

**先按「你在做什么」对号，不需要知道版本号——行为自己会说话：**

| 你在做什么 | 看到什么 | 结论 | 该怎么办 |
| --- | --- | --- | --- |
| **删除**一个值 | 这句话 | ✅ 正常行为：要删的东西父级不存在 | 刷新后重试；检查路径是否写错 |
| **删除**一个值，文件刚被外部改过 | 这句话 | 文件里的位置和预期不符 | 重新载入文件再操作，**不要**手工去"补"父对象 |
| **设置** `limit.*`，源文件里 `limit` 不是对象 | ``The configuration field `{}` must be {expected}.``（会指出具体路径） | ⚠️ 源文件坏了 | 按提示的路径改源文件，改完再编辑 |
| **设置** `limit.*`，源文件健康 | 成功 | 正常 | — |

> **不要靠版本号判断**：修复前后应用版本号同为 `0.1.0`，比对版本号得不出结论。
> 上面那张表只依赖「你做了什么」+「程序吐了哪句话」，这两个都不会骗你。
> 首次包含该修复的发布版本确定后，`CHANGELOG.md` 会回填版本号。

#### 源文件里的字段类型错，现在会指出具体路径

某个字段类型不对时，不会再笼统地说「你混用了 V1/V2 语法」——它会给出**路径**和**期望类型**：

```
The configuration field `providers.acme.models."gpt-4.1".limit` must be an object.
Fix the listed field(s) before editing this file.
```

四点：

- **路径里的双引号是故意的。** 含 `.`（或其他不在 `A-Z a-z 0-9 _ - / : @` 里的字符）的键会被引号包住，
  **所以带点的模型 ID 算一段，不会被读成多两层的嵌套**。
- **过长的路径会在中间截断**，用一个 `…` 表示省略的部分；**路径开头和末尾的字段名仍会保留**，
  所以你能看出是哪个字段坏了。**出现 `…` 就表示有内容被省略**——没出现，就表示没有省略。
- **不是所有坏字段都会逐条点名。** 前面是几条点名的句子，后面跟一句计数：
  `2 more field(s) in this file have an invalid shape.`——**`field(s)` 是实际输出（不是占位符），
  `2` 是这份文件里还有多少个字段没被点名**，不是总数、也不是 provider 数。**计数是按文件算的**：
  **一份文件里坏了好几处，也只会出现一次「还有 N 个」**，不会每个 provider 各来一次。

**`…` 出现两次，但不是同一件事。看有没有引号：**

```
providers.acme.models."…".limit      ← 引号里的是真的名字：这个模型 ID 本身就叫 …
providers.kkkk…kkkk.models.m.limit  ← 不带引号的 … 是省略标记：中间有段被省掉了
```

**引号 = 这是个真实键名**（它含 `.` 或别的特殊字符，所以被引起来，读的时候不会被拆成多层）；
**光秃秃的 `…` = 省略**。两者的区别只看引号，不看位置。

**字段类型错和真正的方言混用同时存在时，两条原因都给：**

```
The configuration field `providers.acme.models."gpt-4.1".limit` must be an object.
It also mixes V1 and V2 provider syntax, which is not editable in this version.
Fix the listed field(s) before editing this file.
```

#### 拒写提示和配置详情里的警告，文字不完全相同

同一份文件，两处清单**来自同一遍分析**，但**拼装方式不同**：

| 位置 | 你看到什么 |
| --- | --- |
| 配置详情（警告列表） | 字段句 + 计数句，**没有**结尾那句 `Fix the listed…` |
| 拒写提示（编辑被拒绝时） | 字段句 + 计数句 +（若真混用）混用句 + **`Fix the listed field(s) before editing this file.`** |

**别指望两处逐字相同**——详情给你看清单，拒写告诉你下一步做什么。

#### 哪些「字段类型错」的提示看得到，哪些仍然看不到

**判据没变：看这条消息校验的是「你这次要写入的值」，还是「源文件里已经存在的内容」。**

| 它校验的是 | 现在能否看到 | 例 |
| --- | --- | --- |
| **你这次提交的值** | **看得到** | `The limit field must be an object.`（新建模型时） |
| **源文件里已有的内容** | **看不到原句**，改为文件级拒写 | `The `limit` field must be an object.` |

**带反引号的 `The `limit` field must be an object.` 仍然看不到**——但原因变了：以前是被文件级只读门禁挡住，
现在被**字段级**门禁挡住，而字段级门禁会直接说出路径和期望类型。**你拿到的是更有用的那句话。**

> **「带不带反引号」不是判据。** `Model capabilities must be an object.` 没有反引号却**可达**，
> 因为它在新建路径上校验的是你提交的值。按措辞配对会漏——本文就漏过一条，是照这个规则补齐的。

> `provider` / `providers` 里的**字段类型错**会让整份文件只读（这就是上面那条字段级提示的来源）。
> **但 root 的 `model` 不在其列**——所以默认模型的类型问题文件仍可写，那两条消息是**可达**的。

**具体反例（可达）**：默认模型（root `model`）写成对象时，改它会报
`The existing default model uses an object selector and cannot be replaced in this version.`，
删它会报 `The existing default model is not a string and cannot be removed in this version.`。
**这两条描述的是「源文件里已有值类型不对」，但用户看得到**——root `model` 不在只读判定的范围内，
文件仍可写，`validate_default_model_edit` 真的会被执行到。

> 所以别记成「凡是讲源文件类型错的消息都不可达」——**那是一条会骗人的全称结论**。
> 判据是「这个字段会不会让整份文件只读」，一个个核，别推广。
#### 为什么同一句话会有三处来源（技术细节，排查时可跳过）

写入分三层独立进行，三层都会在删除遇到父级不通时报这一句——

| 层 | 位置 | 报错条件 |
| --- | --- | --- |
| 校验层 | `validate_leaf_exists` | 删除 `limit` / `capabilities` 下的叶子，而父对象不存在 |
| 语义层 | `remove_json_path` | 独立计算期望结果时，删除路径的父层不通 |
| 文本层 | `apply_remove_path` | 改写 JSONC 文本时，目标位置和预期不符 |

三者是**同一操作的三种独立实现**：先按语义树算一遍期望结果，再按文本改写一遍实际结果，
最后比对「实际 == 期望」，不等就拒绝写入、不动文件（措辞见类别 F 的
`The generated change did not match the requested semantic edits; no file was modified.`）。
这是本代码最可靠的设计之一，代价就是同一句错误可能来自三层。
三处都只由 `EditOp::Remove` 进入，所以这句话对用户只有一种含义：**要删的东西的父级不在**。
#### 源文件坏在哪，决定你看到哪一句

「文件被判只读」不是只有一句话。坏的位置不同，**用户在 `prepare_changes` 撞到的门也不同**：

| 源文件的问题 | 用户实际看到的 | 不是哪一句 |
| --- | --- | --- |
| 顶层 `provider`/`providers` 不是对象（`dialect` 为 `Invalid`） | `This configuration cannot be parsed safely as JSONC.` | **不是** `unsafe mixture`，也**不是** `A provider map has an invalid shape and is read-only.`（那条在 `warnings` 里） |
| 有重复 key | `Duplicate configuration keys make this file unsafe to edit.` | — |
| 已有 provider/model 的某字段类型错 | ``The configuration field `{}` must be {expected}.``（会指出路径和期望类型） | — |
| 只有真正的方言混用 | `This file contains an unsafe mixture of V1 and V2 provider syntax and is read-only.` | — |

> **顺序是有讲究的，表就是按顺序排的。** `prepare_changes` 里的判断依次是：
> 解析失败或 `dialect` 为 `Invalid` →
> 重复 key → **字段级类型错** → 真正的方言混用。**前面的门一旦命中就直接返回，后面的门根本轮不到。**
> 所以一份文件同时有多个问题时，你只看到**最靠前**的那一句；**把这一句修好再来，才会露出下一句**。

> **`warnings` 里的文字不是返回给用户的错误。** `A provider map has an invalid shape and is read-only.`
> 只在只读横幅里出现；编辑请求本身返回的是上表第一行那句。**「这句话存在」不等于「用户会看到它」。**

#### 其它提示

> 下面标注「**从编辑入口不可达**」的几条，是内部校验层的消息：代码里存在，但一份坏文件
> 会在走到它们之前就被**字段级门禁**拦下——而门禁会给出一条指出具体路径的提示。**用户看不到这些原句**，
> 列在这里是为了让读到源码的人不在文档里找不到它而怀疑文档有遗漏。
>
> **下面这张表里有两组，而且有两个原因同时成立，别只记住一个。** 第 1–2 行是「编辑已有字段」
> 路径的，当前不可达；第 3–5 行是「**新建**」路径的，**可达**——新建时源文件里没有那个字段，
> 不存在「已有坏值先被门禁拦下」这个前提。**此外它们是不同的字符串**（带不带反引号），
> 所以按字段名合并会在核对时漏掉一半。

> **判据是「这条消息校验的是什么」，不是反引号。** 校验本次提交的值（`edit.value`）→ 可达；
> 校验源文件里已有的内容 → 会被字段级门禁抢先，用户拿到的是指出具体路径的那一条。
> **反引号只是排版习惯，不是判据。** 本文件里带反引号的提示既可能可达也可能不可达，
> 两半都有反例。**不要按反引号归类，也不要背一张「带反引号的提示清单」——清单必然不全，
> 判据才可维护。** 反例：`validate_edit_batch` 里那条「一次 `set` 编辑必须带值」同样带反引号，
> 却在 `prepare_changes` 的逐条校验里先于任何字段判断执行——它是所有编辑请求都会过的第一关。

> **`{…}` 或 `<…>` 表示可变部分，当前脚本跳过含占位符的条目。** 它不一定是 Rust 模板原文——
> 也可能只是本页对一条长消息的缩写。所以核对这些条目要按可变部分的形式搜，
> 搜实例化后的完整字符串找不到是正常的。**这是脚本当前的能力边界，不是这类消息无法核对**：
> 把两侧的占位符归一化之后是可以比对的，只是脚本还没有做这一步。
>
> **措辞不是契约。** 上表「可达 / 不可达」是按 `main` 某个提交的调用链得出的结论。
> 若实现改了某条消息的措辞，**本表仍会原样显示，但结论已经失效**，而且看起来依然权威。
> 遇到与本文不符的提示原文时，请以你实际运行的版本为准，并把它当作本文过期的信号。

| 提示原文 | 含义与处置 |
| --- | --- |
| `The `limit` field must be an object.` | **当前用户看不到原句。** 源文件里 `limit` 不是对象时，会先撞上字段级门禁，你拿到的是指出路径和期望类型的那句（`The configuration field `{}` must be {expected}.`）。见上「源文件里的字段类型错，现在会指出具体路径」。 |
| `The `capabilities` field must be an object.` | **当前用户看不到原句。** 同上，`capabilities` 不是对象同样会先触字段级门禁。 |
| `The limit field must be an object.` | **新建模型时**，提交的 `limit` 不是对象。改本次输入。 |
| `Model capabilities must be an object.` | **新建模型时**，提交的 `capabilities` 不是对象。改本次输入。 |
| `The provider options/settings field must be an object.` | **新建供应商时**，提交的 `options` / `settings` 不是对象。改本次输入。 |
| `The edit target does not exist.` | `remove` 的目标本身不存在。刷新后重试，并检查路径是否写错。 |
| `The provider does not exist; create it before editing nested fields.` | 先建供应商条目，再改它下面的字段。 |
| `The model does not exist; create it before editing nested fields.` | 先建模型条目，再改它下面的字段。 |
| `The existing provider has an invalid shape.` | 供应商条目存在但不是对象。**这句从编辑入口不可达**——它会先触发字段级门禁，你看到的是指出路径的那句。处置仍是改源文件。 |
| `The existing model has an invalid shape.` | 模型条目存在但不是对象。**这句从编辑入口不可达**——同上，会先撞到字段级门禁。处置仍是改源文件。 |
| `The provider map has an invalid shape.` | **这句从编辑入口不可达。** 顶层 `provider`/`providers` 不是对象时 `dialect` 被判为 `Invalid`，`prepare_changes` 在更前面就返回 **`This configuration cannot be parsed safely as JSONC.`**（`prepare_changes` 的解析门禁）。**不是** `unsafe mixture` 那句——`unsafe_nesting` 的检查在它之后。处置：修顶层结构。 |
| `The configuration root must be an object.` | 配置文件最外层不是对象（比如是个数组或裸值）。源文件需人工修正。 |
| `The target object could not be located safely.` / `The target object range is not safe to edit.` | 要改的那段在文件里的位置无法安全定位（格式太特殊）。调整文件格式或手工编辑。 |
| `The provider `<key>` field has an invalid shape.` | 该字段存在但类型不对。**这句从编辑入口不可达**：该字段类型错会先触字段级门禁（见上）。处置：改源文件。 |
| `The model identifier is empty or too long.` | 模型键名为空或过长（上限 256 字符）。 |
| `The {label} identifier is empty or too long.` | 同上，`{label}` 会是 `provider` 或 `model`。 |
| `The {label} identifier contains control characters.` | ID 里有控制字符。 |
| `The {label} identifier contains a reserved character.` | ID 里用了保留字符（`/` 等分隔用途的字符）。 |
| `The model identifier contains control characters.` | 模型键名里有控制字符。 |
### 类别 D — 值本身不合法

| 提示原文 | 含义与处置 |
| --- | --- |
| `Limit values must be non-negative integers.` | 上限值必须是 ≥ 0 的整数。 |
| `The default model must be a string.` | 默认模型是字符串，不是对象。 |
| `The default model must use `provider/model` format.` | 写成 `provider/model`。 |
| `The default model is empty or too long.` | 空或超过 512 字符。 |
| `The default model cannot contain whitespace.` | 去掉空白。 |
| `The default model contains control characters.` | 去掉控制字符。 |
| `The default model has too many variant separators.` | `provider/model:variant` 里冒号太多。 |
| `The default model selector is not recognized.` | 默认模型写成了本版认不出的选择器形式。 |
| `The default model uses an object selector; it is shown but cannot be edited in this version.` | 默认模型是对象选择器，只展示不编辑。 |
| `The default model value contains control characters and is hidden.` | 默认模型值含控制字符，界面隐藏显示。先去源文件里修掉。 |
| `An edit string value is too long.` | 字符串超长。 |
| `An edit string value contains control characters.` | 去掉控制字符。 |
| `The edit value is too large or too deeply nested.` | 整体对象太大或嵌套太深。 |
| `A string value is required.` / `A baseURL string is required.` | 该字段要字符串。 |
| `The baseURL is empty.` | baseURL 为空。 |
| `baseURL must be a string.` | baseURL 必须是字符串。 |
| `A baseURL containing URL userinfo cannot be added.` | URL 里不能带 `user:pass@`。 |
| `A baseURL containing a URL fragment cannot be added.` | URL 里不能带 `#fragment`。 |
| `A baseURL containing secret query parameters cannot be added.` | URL 查询串里不能塞凭证类参数（如 `?api_key=...`）。 |
| `The baseURL field does not exist.` | 要删的 `baseURL` 本来就不存在。 |
| `A new provider must be an object.` / `A new model must be an object.` | 创建时给值必须是对象。 |
| `A provider creation requires an object value.` / `A model creation requires an object value.` | 同上。 |
| `A new provider must have an explicit V1 or V2 format.` / `A new model must have an explicit V1 or V2 format.` | 文件方言是 `ambiguous` 时，创建必须显式表明用哪种格式。 |
| `The new provider mixes V1 and V2 fields.` / `The new model mixes V1 and V2 fields.` | 新的条目里混了两种方言的字段，只能选一种。 |
| `Field `<key>` cannot be added to a new provider in this version.` | 创建供应商时只允许 `name` / `npm` / `api` / `options` / `models`（V1）或 `name` / `package` / `settings` / `models`（V2）。 |
| `capabilities.reasoning.effort labels must be unique.` | 思考档位有重复项。 |
| `capabilities.reasoning with supported:false cannot include toggle, effort or budget.` | `supported: false` 时只能有这一个字段，删掉其它三项。 |
| `V2 capabilities.reasoning requires a boolean `supported` field.` | `reasoning` 对象必须带布尔的 `supported`。 |
| `V2 capabilities.reasoning must be an object.` | V2 的 `reasoning` 是对象，不是布尔值。 |
| `capabilities.reasoning.effort must be an array of strings.` / `...effort entries must be strings.` | 档位是字符串数组。 |
| `capabilities.reasoning.effort may contain at most 32 entries.` | 档位最多 32 个。 |
| `capabilities.reasoning.budget must be an object.` | `budget` 是对象。 |
| `capabilities.reasoning.budget.min cannot exceed budget.max.` | 把 `min` 调小或 `max` 调大。 |
| `capabilities.reasoning.budget values must be safe integers.` / `...values exceed the safe integer range.` | 预算值必须是安全整数范围内的整数。 |
| `Unsupported capabilities.reasoning.budget field `<key>`.` | `budget` 下只认 `min` / `max`。 |
| `capabilities.reasoning.toggle must be a boolean.` | `toggle` 必须是布尔值。 |
| `A reasoning effort label is empty or too long.` | 档位名不能为空或超过 64 字符。 |
| `V2 variant ids must be unique.` | 变体的 `id` 不能重复。 |
| `Each V1 variant must be an object.` | V1 变体是对象（V2 是数组）。 |
| `Variants require an explicit provider format.` | 文件方言不明时不能改变体。 |
| `Model variants must be replaced as a whole object/array or through supported leaf fields.` | 变体要么整体换，要么走叶子路径。 |

### 类别 E — 覆盖与保护

| 提示原文 | 含义与处置 |
| --- | --- |
| `Replacing an existing provider is not permitted; edit fields or create a new provider.` | 不能整体覆盖已有供应商。要换内容就逐字段改，或先删再建。 |
| `Replacing an existing model entry is not permitted; edit fields or create a new model.` | 同上，模型层。 |
| `Whole provider-map replacement is not permitted.` | 不能整体替换 `provider` / `providers`。 |
| `The existing default model uses an object selector and cannot be replaced in this version.` | 默认模型是对象选择器，本版本不支持改。 |
| `The existing default model is not a string and cannot be removed in this version.` | 同上，删除也不支持。 |
| `No default model is set.` | 没有默认模型可删。 |
| `These variants contain credential or custom-header configuration and cannot be edited.` | 变体里有凭证或自定义 header，界面拒绝编辑。 |
| `The provider to remove does not exist.` / `The model to remove does not exist.` | 要删的东西不存在。 |
| `Only a file changed successfully in this session can be restored from its recovery backup.` | 恢复备份只针对**本次运行中成功写入过**的文件。重启后不猜测备份归属。 |

### 类别 F — 文件级问题

| 提示原文 | 含义与处置 |
| --- | --- |
| `The file changed after it was loaded; reload it before editing.` | 预览之后文件被外部改过。重新载入再改。 |
| `The expected file hash is invalid.` | 内部哈希不合法（通常是状态错乱）。重新载入。 |
| `The configuration file is marked read-only on disk.` | 去掉磁盘只读标记，或用管理员权限启动前先确认这确实是你想要的。 |
| `Only OpenCode .json or .jsonc configuration files are supported.` | 扩展名必须是 `.json` / `.jsonc`。 |
| `The selected configuration path is not a regular file.` / `The target configuration path is not a regular file.` | 路径不是普通文件（可能是目录或设备）。 |
| `Symlinked configuration is read-only.` | 符号链接的配置不改。 |
| `Machine-managed configuration is read-only.` | 工具链托管文件不改。 |
| `Duplicate configuration keys make this file unsafe to edit.` | 有重复键，先人工消除歧义。 |
| `This configuration cannot be parsed safely as JSONC.` / `The current configuration is no longer valid JSONC.` | 语法坏了，先修好 JSON 结构。 |
| `The configuration file is too large to read safely.` | 文件超出安全上限。 |
| `The configuration root must be an object.` | 根必须是对象。 |
| `Ambiguous files require an explicit provider format choice before editing the default model.` | 文件方言不明，先建一个 provider map 表明格式。 |
| `Ambiguous files require creating an explicit provider map entry first.` | 同上。 |
| `A one-line object with comments cannot be extended safely.` | 单行且带注释的对象无法安全插入新键。把这行展开成多行。 |
| `An inline property cannot be removed safely.` | 同一行还有别的属性，单独删它会破坏格式。展开成多行再删。 |
| `The object closing brace shares a line with other content.` | 收尾大括号和别的内容同行，无法安全插入。展开格式。 |
| `Could not build a restrictive Windows security descriptor.` / `Could not enforce restrictive backup directory permissions.` / `Could not enforce restrictive private file permissions.` | 备份文件权限无法收紧。**不要**用降低安全要求的方式绕过，报告环境问题。 |
| `Could not create a restrictive private file.` | 同上。 |

### 类别 G — 供应商模型列表拉取（`/models`）

这一节描述**只获取模型 ID 列表**的操作。它不发送聊天或推理请求，因此不会产生 token 费用；
但列表请求本身是否计费取决于供应商。

#### 先过第一道门：这个供应商允不允许拉

**在做任何排查之前先确认这一层。** 只有包名在白名单里（或未声明包名时用内置名 `openai` / `openrouter` / `xai` / `anthropic`），
才会**发出请求**。否则在发请求前就被拒绝，你会看到：

| 提示原文 | 含义 |
| --- | --- |
| `Provider '{id}' does not declare a supported package, so its model-list protocol is unknown.` | 没声明包名，且不是内置名。补一个官方 OpenAI 或 Anthropic 包名，或手工填模型。 |
| `Provider '{id}' uses the unsupported package '{pkg}'.` | 包名不在白名单内。同上。 |

> **这两条都属于「请求根本没发出去」**——不消耗额度，也不涉及下面四种结局。
> 判断方式很简单：错误里带 **`no model-list request was made`** 字样，就是这一层。
>
> ⚠️ **注意范围**：Gemini、Cohere 的**原生**配置属于这一层被拒的情况。
> 下面的分页问题只适用于**已经通过包检查、并且真的收到了这类响应**的端点。

白名单是**精确包名匹配**（不是子串包含）。当前（`main`）接受的包名：

| 协议 | 接受的包名 |
| --- | --- |
| OpenAI | `@ai-sdk/openai`、`aisdk:@ai-sdk/openai`、`@opencode/ai/providers/openai`、`.../openai/chat`、`.../openai/responses` |
| OpenAI 兼容 | `@ai-sdk/openai-compatible`、`aisdk:@ai-sdk/openai-compatible`、`@opencode/ai/providers/openai-compatible`、`.../openai-compatible/responses` |
| OpenRouter | `@openrouter/ai-sdk-provider`、`aisdk:@openrouter/ai-sdk-provider`、`@opencode/ai/providers/openrouter` |
| xAI | `@ai-sdk/xai`、`aisdk:@ai-sdk/xai`、`@opencode/ai/providers/xai` |
| Anthropic | `@ai-sdk/anthropic`、`aisdk:@ai-sdk/anthropic`、`@opencode/ai/providers/anthropic` |
| Anthropic 兼容网关 | `@opencode/ai/providers/anthropic-compatible` |

> **`@ai-sdk/anthropic-compatible` 不在这张表里，这是有意的**——该包在 npm 上不存在，
> 列出来等于宣称支持一个装不上的东西。第三方 Anthropic 兼容网关要用
> `@opencode/ai/providers/anthropic-compatible`。
>
> **未声明包名时的内置名是四个精确键**：`openai` / `openrouter` / `xai` / `anthropic`。
> 名字像但不是这四个（例如 `anthropic-proxy`）仍然被拒——**照名字猜协议会让一个起错名的
> 条目拿到带凭据的请求。** 显式包名永远优先于内置名：叫 `anthropic` 但配了兼容网关的条目，
> 走网关分支，不吃内置默认 base。

未声明的供应商**不会被猜测接口**——这是刻意的安全设计：精确匹配避免 `malicious-acme-openai`
这种名字自我授权拿到带凭据的请求。

---

过了上面那道门之后，按这个顺序排：

1. **baseURL 对吗？** 取用优先级为 `settings.baseURL` → `options.baseURL` → 条目 `api`。
2. **认证引用能解析吗？** 取用优先级为 `settings.apiKey` → `options.apiKey` → 条目 `apiKey`，
   另加 `env` 数组与三层 headers 合并。本应用**不读** OpenCode 的 OAuth / 认证数据库，
   所以只写在 OpenCode 登录态里的凭证解析不出来——请改用环境变量或配置文件引用。
3. **用的是 HTTP 吗？** 允许，但会提示明文传输风险，且凭证会明文传输。请只连可信端点。

该类别下会出现的提示：

| 提示原文 | 含义与处置 |
| --- | --- |
| `Provider '{id}' does not declare a supported package, so its model-list protocol is unknown.` | 见上「先过第一道门」——请求未发出，不消耗额度。 |
| `Provider '{id}' uses an OpenAI-compatible package but does not define a base URL.` | 补 `settings.baseURL` 或 `options.baseURL`。 |
| `Provider '{id}' uses an Anthropic-compatible package but does not define a base URL.` | 补 `settings.baseURL` 或 `options.baseURL`。**这条在构造请求之前就返回**——与对端是否实现 `/models` 无关，所以不要拿它去判断网关能力。 |
| `Provider endpoint must use HTTP or HTTPS.` | 协议只能是 http / https。 |
| `Provider endpoint URL must include a host.` | URL 缺主机名。 |
| `Provider endpoint URL contains embedded credentials, which are not allowed.` | URL 里不能带 `user:pass@`。 |
| `Provider endpoint URL contains credential-like query parameters, which are not allowed.` | 查询串里不能放凭证类参数。 |
| `Provider endpoint URL must not contain a fragment.` | 去掉 `#fragment`。 |
| `Provider returned an HTTP redirect; redirects are not followed for credential safety.` | 端点返回了重定向。出于凭证安全**不跟随**，请直接配置最终地址。 |
| `Provider returned HTTP {status} {reason}.` | 端点报错。对照供应商文档查状态码：401 认证、403 权限、404 路径不对、429 限流。 |
| `Provider returned an unexpected model listing format.` | 响应结构不在已支持的容器形状内。 |
| `Provider response is too large to inspect safely.` | 响应体超出安全上限。 |
| `Provider ID is required.` | 内部调用缺供应商 ID。 |
| `Provider '{id}' was not found in this configuration file.` | 该供应商不在当前文件里。 |
| `Provider '{id}' is not an object in this configuration file.` | 该供应商条目不是对象，源文件需人工修正。 |
| `Provider '{id}' is defined in both `provider` and `providers`; refusing an ambiguous inventory request.` | 同一 ID 在两种方言里都定义了。先消除重复。 |
| `Provider '{id}' has an unsupported `env` credential list.` | `env` 写法不合法。 |
| `Provider '{id}' has an unsupported HTTP headers value.` | headers 写法不合法。 |
| `Configured HTTP header '{name}' is not allowed for provider inventory.` | 某些 header 被禁（会改变认证语义的）。 |
| `Configured HTTP headers must have string values.` | headers 的值必须是字符串。 |
| `Provider configuration contains an unsupported credential or endpoint value.` | 凭证或端点值类型不对。 |
| `Credential file references to OpenCode authentication stores are not allowed.` | 不允许把 OpenCode 认证库当凭证来源。改用环境变量或配置文件引用。 |
| `OpenCode authentication stores are not valid configuration sources.` | 同上，另一条路径。 |
| `The configured credential file is empty.` / `...is not a small regular file.` / `...is too large to use safely.` | 凭证文件为空或不是小的普通文件。 |
| `The configured credential reference is malformed.` / `...has an invalid environment variable name.` / `...resolved to an empty value.` / `The configured environment credential reference is not set.` | 凭证引用的写法或解析结果有问题。检查 `{env:NAME}` 的变量名，以及启动进程的环境里是否真的设了它。 |
| `Ignored {n} provider entries that did not contain a usable model ID.` | **不是错误**，是信息：部分返回项缺可用 ID 被跳过。 |
| `Provider returned more than {MAX_MODELS} model IDs; the inventory was truncated.` | 返回项超过上限（10000）被截断。 |

> **上表里 `Provider returned HTTP {status} {reason}.` 那一行，说的是「没配凭据时看到的状态码」。**
>
> 想判断某个端点到底存不存（不花额度、不用真 key），办法是**同 host 打一条明显不存在的路径做对照**：
> 不带任何凭据时，真路径给 401（要认证 = 存在）、不存在的路径给 404 —— 两条不同就说明能判。
>
> **少数 host 连这个也不给**：`api.cohere.com`、`api.deepseek.com` 对任何路径都回 401，
> 这几家上**任何基于状态码的路径判断都不成立**，包括「404 说明路径不存在」。
>
> 它是「先查什么」的顺序建议，**不是「状态码 = 原因」的映射**。
>
> 另：**别假定认证失败一定是 401。** 实测 `api.x.ai` 用无效 key 返回 **400**，
> 而 400 读起来像「我的请求有问题」、401 才像「我的 key 有问题」——**两者对用户是不同的信号。**

#### 过了第一道门之后：四种结局

请求发出去之后有**四种**结果。看到「列表不对」时，先对号——**第 2 和第 4 种最容易被误判**：

| 结局 | 你看到的 | 含义 | 该怎么办 |
| --- | --- | --- | --- |
| **1. 硬错误** | 一条红色错误（如 `Provider returned an unexpected model listing format.`） | 请求失败，或返回的根本不是能认的 JSON | 按上面的提示表处理。**明确失败**，不用猜。 |
| **2. 软失败** | **列表为空** + 两条 warning：`Ignored {n} provider entries that did not contain a usable model ID.` 和 `Provider returned no model IDs.` | 请求**成功**了，容器也认出来了，但每一项都没找到可用的 ID 字段 | ⚠️ 见下。**这是已知限制，不是你的配置错**。 |
| **3. 成功但有提示** | 有模型，但带 `Provider indicated that more models may be available; the inventory may be truncated.` | 拉到一部分，供应商还有下一页，**且分页字段在识别范围内** | 列表不全，但**有提示**（目前是 Anthropic）。见下。 |
| **4. 成功但静默截断** | 有模型、**无任何 warning** | 拉到一页就停了，但这一家的分页字段我们不认识 | ⚠️ **完全没有信号**。见下。 |

**结局 2 最容易被误判**：它长得像「这家没有模型」，实际是「这家用的字段名我们不认」。
它会给出 warning，**不是完全静默**——但那两条提示说的是"没找到可用的模型 ID"，
用户很难从中推出"原来这家用 `name` 字段"。所以直接点名：

> **如果你用的是 Gemini、Cohere 或 Ollama 原生端点**，列表为空且看到 `Ignored {n} ...` 提示，
> 那就是这个原因。**请手工填模型名**，不要反复重试，也不要去改配置试图"修好"它。
> （若你看到的不是 `Ignored` 而是 `no model-list request was made`，那是更前面一层——
> 包检查没过，见上「第一道门」，处置完全不同。）

**这条结论的可靠性是【推】，不是【码】。** 它依赖两个**没有验证过**的前提：

1. 这几家的返回项真的用 `name` 作模型 ID（依据是官方文档，**我们没有打过真实端点**）；
2. 它们的响应项真的**只含** `name`、不含 `id` / `model` 之类的键。

**任一前提不成立，这条结论就不成立。** 写出来是因为一个结论如果依赖未验证前提，
那些前提必须一起给读者，否则他无从判断这个结论有多牢固。
若你实测发现某家其实返回了 `id`，请告诉我们——那是这条结论被推翻的直接证据。

原因：解析返回项时只认 `id` / `model` / `model_id` / `modelId` 四个键（`inventory.rs` 的 `extract_model_ids`），
而这几家用 `name`（如 `"name": "models/gemini-2.5-pro"`）。容器 `models` 数组能认出来，
但元素没有那四个键，于是每项都被计入 `skipped`，最终 0 个模型。

**结局 4 没有任何提示**，这是最危险的一档：列表看着正常，其实只有第一页。已知的有：

下表是**接入时需要处理的协议差异**，不是说这些供应商现在都能拉。前提是它们已经通过上面的包检查。
**【推】** 分页字段名与默认每页条数引自 @Anna 的官方文档核实（2026-11-20），**本项目未用真实凭据打过这些端点**。

**识别范围是两边都要说的**：只说「认哪些」会高估覆盖，只说「不认哪些」会低估。`object_has_more`（`inventory.rs` 的 `object_has_more`）实际是：

| 认得（会给你提示，结局 3） | 不认得（静默截断，结局 4） |
| --- | --- |
| `has_more`（顶层） | `nextPageToken`（Gemini、Fireworks） |
| `pagination.has_more`（嵌套一层） | `next_page_token`（Cohere） |
| `next` | `links.next`（OpenRouter） |
| `next_page` | 其它「token」型字段名一律不认 |
| `nextPage` | — |

> 后三个（`next` / `next_page` / `nextPage`）只判「**存在且不是 null**」，不检查它的值能不能用。
> **拿你自己拿到的响应体去对这张表**，就知道自己在结局 3 还是结局 4。

| 供应商 | 分页字段 | 会被识别吗 | 默认每页 |
| --- | --- | --- | --- |
| Anthropic | `has_more` | ✅ 会（结局 3） | 20 |
| **Gemini** | `nextPageToken` | ❌ **不会** | 50 |
| **Cohere** | `next_page_token` | ❌ **不会** | 20 |
| **Fireworks** | `nextPageToken` | ❌ **不会** | 50 |
| OpenRouter | `links.next` | ❌ 不会（目前一次给全，暂不触发） | — |

> 用这几家时，**请自行核对拉到的数量是否明显偏少**。数量对不上就手工补，
> 不要因为"没有报错也没有警告"就认为拉全了。
>
> ⚠️ **但前提仍然是「这个端点能拉到」**：Gemini / Cohere 的**原生**配置会在发请求前被拒
> （见上「第一道门」）。只有当它们通过 OpenAI 兼容包接入、并且真的收到了这类响应，
> 下面的分页结论才适用。

#### Anthropic 的默认页大小与截断提示

官方 `/v1/models` 的默认页大小为 20。工具只请求第一页，看到 `has_more: true` 时会显示列表可能截断的提示。
没有提示只表示工具没有识别到分页信号。兼容网关可能使用不同的分页字段。

如需添加第一页以外的模型，请手工填写模型 ID。

### Anthropic 接入的已知限制

#### 1. baseURL 只写域名会 404（Anthropic 尤其容易踩）

**这是最容易误判成「我的 key 坏了」的一条。** 模型列表的 URL 是这么拼的：

```
baseURL 的路径为空  →  <域名>/models        ← 不是 /v1/models
baseURL 的路径非空  →  <baseURL>/models
```

（`models_endpoint`：路径为空时直接拼 `/models`，**不会补 `/v1`**。）

| 你写 | 我们实际请求 | 结果 |
| --- | --- | --- |
| `https://api.anthropic.com` | `https://api.anthropic.com/models` | **404** |
| `https://api.anthropic.com/v1` | `https://api.anthropic.com/v1/models` | ✅ |
| `https://api.openai.com` | `https://api.openai.com/models` | **404** |
| `https://api.openai.com/v1` | `https://api.openai.com/v1/models` | ✅ |

**为什么 Anthropic 特别容易踩**：AI SDK 会把 `https://api.anthropic.com` 自动补成 `/v1`，
所以这个写法**在 OpenCode 里能跑通、在我们这儿 404**。用户的配置确实"本来是好的"，
于是更容易去怀疑 key，而不是怀疑 URL。

> **处置**：看到「Provider returned HTTP 404 Not Found.」这条（由 `Provider returned HTTP {status} {reason}.` 填出的实例）且 baseURL 只有域名时，
> 先检查 `baseURL` 是否包含 `/v1`。内置 Anthropic 默认地址已包含该路径。

> 【测】+【码】：路径怎么拼是【码】（上面的规则）；
> `/v1/models` 存在、`/models` 与 `/v1/messages/models` 不存在，
> 是**无凭据对照实测**（见上「状态码的适用条件」）。**但没有对任何 provider 发起过带真实凭据的请求。**

**base 该写到哪里**——`models_endpoint` 的规则是「路径末尾不是 `/models` 就补 `/models`」：

| 你写 | 实际请求 | 结果 |
| --- | --- | --- |
| `https://api.anthropic.com` | `/models` | **404**（匿名实测） |
| `https://api.anthropic.com/v1` | `/v1/models` | ✅ |
| `https://api.anthropic.com/v1/`（尾斜杠） | `/v1/models` | ✅ |
| `https://api.anthropic.com/v1/models` | 原样不动 | ✅ |
| `https://api.anthropic.com/v1/messages` | `/v1/messages/models` | ❌ **该路径不存在**（无凭据对照实测） |

> **最后一行最容易踩，也最不像"URL 写错"**：如果你把推理端点的完整地址填进 `baseURL`，
> 拼出来是 `/v1/messages/models`——**看起来像个合法路径**，而报错里会带上它。
> 于是你只会觉得"这家把这个端点挂了"，不会想到是自己填错了层级。
> **baseURL 要写到版本段为止**（`.../v1`），不要带 `/messages`、`/chat/completions` 这类具体端点。

#### 另一件同一类的事：baseURL 上的 query 会被静默丢掉

拼模型列表 URL 时会清掉**所有**查询串（`set_query(None)`）：

| 你写 | 实际请求 |
| --- | --- |
| `https://api.example.com/v1?page=2&limit=10` | `/v1/models`（query 全没了） |

**所以不要指望用 `?limit=1000` 之类去影响分页**——传不进去，而且**不会有任何提示**。
工具只取第一页，响应中的分页信号用于显示提示。

> 这两条（base 补 `/models`、query 被清）**是同一类问题**：你以为自己传了个东西，
> 它被静默丢掉了。**静默丢弃比报错更难诊断**，因为报错至少给了你一个信号。
> 上面两行都有单元测试固定（`models_endpoint` 的路径拼接与 query 清空）。

---

#### 2. `anthropic-compatible` 指向的第三方网关，可能根本没有 `/models`

`anthropic-compatible` 是给**第三方兼容网关**用的。而 `/models` 在 Anthropic 官方那边也是较新的
端点——我们确认它存在，靠的是匿名请求 `api.anthropic.com` 拿到 401（**路径存在，只是要认证**）。

**这个证据不传递到第三方网关。** 一个只实现了 `/v1/messages` 的网关，**可能根本没有** `/models`——
而一旦没有，你拿到的就是请求失败，不是模型列表。**具体状态码不写死**：网关各自实现不同，
我们也没打过任何真实网关（见下方【推】）。
而当前的 404 处理只给状态码：

```
  Provider returned HTTP 404 Not Found.      ← 由 format 串填空得到，源码里不是这个字面量
```

**它不会告诉你「可能是你的网关不支持模型列表」。** 所以看到 404 时，先确认网关文档里有没有
模型列表端点，而不是先怀疑 key 或软件本身。

> 这一条是【推】：我们没打过任何第三方 Anthropic 兼容网关。但它是可预见的——
> 用 `anthropic-compatible` 的那批用户，恰恰最可能没实现 `/models`。

#### 3. `@ai-sdk/anthropic-compatible` 这个包不存在

Anthropic 的**原生**协议（`@ai-sdk/anthropic`、`aisdk:@ai-sdk/anthropic`、
`@opencode/ai/providers/anthropic`）和 **Anthropic 兼容网关**协议
（`@opencode/ai/providers/anthropic-compatible`）都在白名单里，V1 的 `npm` 写法和 V2 的 `package` 写法都能用。

但 **`@ai-sdk/anthropic-compatible` 是刻意不收录的**——它在 npm 上不存在（源码注释记录了
2026-11-20 的 404 检查），收录等于宣称支持一个装不上的东西。

**后果**：照 OpenAI 的命名规律推导「Anthropic 也应该有 `@ai-sdk/anthropic-compatible`」的人，
会拿到 `uses the unsupported package` 这条拒绝。

**处置**：第三方 Anthropic 兼容网关用 `@opencode/ai/providers/anthropic-compatible`；
原生 Anthropic 用 `@ai-sdk/anthropic`。

---

#### 其它已知限制（不是配置错误）

- **查询串会被清空**：构造请求时 `set_query(None)`（`inventory.rs` 的 `models_endpoint` 里 `base.set_query(None)`）。
  若某家需要在 URL 上带参数（例如 Azure 的 `api-version`），当前会丢参数而失败。
- **分页不跟进，而且只有部分供应商会提示**：代码只认 `has_more` / `pagination.has_more` /
  `next` / `next_page` / `nextPage`（`inventory.rs` 的 `object_has_more`），且**不翻页**。
  - Anthropic 用 `has_more` → **能识别**，会给结局 3 那条 warning，但列表仍只有一页（默认 20 条）。
  - **Gemini（`nextPageToken`）、Cohere（`next_page_token`）、Fireworks（`nextPageToken`）
    的分页字段不在识别范围内 → 连 warning 都没有**，看起来像"全部拉到了"。
    这三家请自行核对数量是否明显偏少，必要时手工补。
- **无 429 / `Retry-After` 处理**：被限流时不会自动退避重试，请稍后手动再拉。
- **请求超时**：连接超时 5 秒、整体请求超时 15 秒。模型列表特别大的供应商可能需要重试。
- 目录（models.dev）与供应商列表给出的都是**未验证的建议值**，不等于该模型真实的运行时能力。

> 上面这些是代码层面的既有行为，不是待修的配置错误。修正它们属于功能变更，见 `CHANGELOG.md`
> 与 issue。在修好之前，遇到这种情况请**手工填模型**，不要反复重试。

---

## 五、凭据相关（重要）

本应用**从不**：

- 接管 OpenCode 的 OAuth 登录或认证数据库；
- 存储 API Key；
- 编辑任何凭证字段；
- 把凭证值放进界面、错误信息或预览 diff。

它只做一件事：在你**手动**拉取模型列表时，在后端内存里解析**已存在**的 `{env:...}` / 文件引用。

因此：

- 想换 Key，请**手工编辑**配置文件，或用环境变量。
- 删除供应商或模型时，如果它带凭证配置，界面会提醒"同时删除了凭证配置（值不显示）"。
  这不是错误，是提醒。
- 预览 diff 会把含凭证的区块遮蔽。若某个修改无法在安全范围内保留注释，会被**拒绝**而不是猜测写入。


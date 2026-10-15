# @local/token-burner

按**指定金额（人民币元）**快速消耗 token 的 DSH 插件：真实调用模型、真实扣费，带预算锁、余额对账与逐请求审计日志。

> 设计文档见 [`DESIGN.md`](DESIGN.md)（含架构、控制算法、价格依据，以及真机验证结果与设计修正）。

---

## ⚠️ 风险提示与免责声明（请务必读完）

1. **本插件会真实花钱。** 它通过 `ctx.llm.stream` 真实调用 DeepSeek 模型，费用直接从你的账户余额扣减（充值余额与赠送余额同时存在时**优先扣减赠送余额**），**不可撤销、不可退款**。
2. **默认硬上限 1 元。** 任何一次运行的目标金额超过 `maxAmountCny` 会被直接拒绝。这个默认值是故意设得很低的；提高上限需要你自行修改 `cordis.patch.yml`。**作者与 DSH 不对任何资金损失负责。**
3. **价格表是快照，不是合同。** 内置单价来自 DeepSeek 官方公开价格页，可能随时变动；高峰/空闲时段与法定节假日判定是**近似实现**（节假日表留空时，工作日的节假日会被按高峰价计算）。实际扣费以官方账单为准。
4. **记账是估算。** 插件的金额来自 API 返回的 `usage` 字段（逐 token 精确）乘以价格表。它会自动做「开始前 / 结束后」两次余额对账，但**唯一权威永远是 DeepSeek 官方账单**。插件不保证估算值与实际扣费完全一致。
5. **限流与风控自负。** 高频并发请求可能触发限流甚至风控；请遵守 DeepSeek 服务条款，**不要**用于刷单、套利、绕过配额或任何滥用行为。
6. **先用极小金额验证。** 强烈建议先在独立测试账户上用 0.1 元跑通，确认对账无误后再放开金额。
7. **环境要求。** 需要 `llm` 服务（必需）与 `deepseekAccount` 服务（可选，缺失时无法余额对账，只能看估算值）。

---

## 它做什么

给一个金额，它把这个金额**准确地**花掉，并且**尽可能快**。

三条让其成立的关键设计：

### 1. 烧钱有两条通道，速度差约 100 倍

| 通道 | 计费桶 | 特点 | 相对速度 |
| --- | --- | --- | --- |
| `input`（默认） | 输入·缓存未命中 | 预填吞吐极高，每秒可吞数千 token | **快 ~100×** |
| `output` | 输出 | 被生成速度卡死在每秒几十 token | 慢 |

虽然输出单价更高，但按**每秒烧掉多少钱**算，输入通道碾压输出通道。插件在计划里会同时给出两条通道的预计耗时对照。

### 2. 缓存是头号敌人

缓存命中价（¥0.04/M）比未命中（¥2/M）便宜 **50 倍**，而 DeepSeek 的前缀缓存按最长公共前缀命中。
→ 每次请求都在 prompt **最前面**放一个全新的随机 nonce，并用本地生成的随机语料填充，确保必然未命中。
（如果某次请求出现「输入全部命中缓存」，插件会告警。）

### 3. 超支在结构上不可能发生

单次请求按**悲观 token 数**预留额度：

```
最坏花费 = chars / (charsPerToken × ratioFloor) × 未命中单价 × safetyFactor
         + maxTokens × 输出单价 × safetyFactor
```

每次下发前同步预留，因此 `spent + reserved ≤ target` 恒成立（预留侧用 `remaining` 封顶，是严格的）。
代价是可能**欠额** —— 欠额由主循环按剩余金额重算尺寸迭代补齐（几何收敛）。
容差默认 `max(0.01 元, 目标 × 0.1%)`。

> ⚠️ **唯一已知的超支窗口**：上面的「最坏花费」依赖 `charsPerToken` 估算。若实际字符/token 比低于
> `charsPerToken × ratioFloor`，**单次请求**最多可能超出预留约 `1/ratioFloor` 倍（默认 1.25×）。
> 这正是 `safetyFactor`（1.05）与 `ratioFloor`（0.8）存在的原因 —— 超支窗口在**单请求**粒度上，
> 不是「整轮可以随便超」。详见 [DESIGN.md](DESIGN.md) 的 §1 与 §9。

> 时段提示：高峰时段（北京时间周一至周五 09:00–12:00、14:00–18:00，不含法定节假日）单价 2×。
> 想**快**就挑高峰期烧（同样金额只需一半 token）；想**多烧 token** 就挑空闲时段。这是两个不同的优化目标。

---

## 安装

本地目录用 `link:` 或绝对路径挂载：

```bash
# 方式一：编辑 ~/.dsh/profiles/desktop/package.json
#   "dependencies": { "@local/token-burner": "link:/abs/path/to/token-burner" }
#   并在 "dsh": { "profile": { "bundles": [ ... , "@local/token-burner" ] } } 里追加
#   然后在 ~/.dsh/profiles/desktop/node_modules/@local/ 下建同名 symlink

# 方式二：用 Desktop 安装自带的 CLI（dsh 不在 PATH 上，要用 app 内的入口）
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/link-entry \
  plugin --profile desktop add /abs/path/to/token-burner

# 方式三：Web 侧边栏 Plugins 页 → Add plugin → 填本地绝对路径
```

### 安装后验证（不花钱）

```bash
node tools/verify-install.mjs            # 校验解析、清单、patch、导出、client 约束
DSH_HOME=$(mktemp -d) node tools/smoke.mjs   # 54 组断言，全部离线，用假模型
```

`verify-install.mjs` 会检查：profile 能否解析到包、`dsh.bundle.patch` 等判据是否齐全、
`cordis.patch.yml` 的 row id 是否与其它 bundle 冲突、Host 半能否真的 import、client 半是否守住了
「只 require react、不碰 `@deepseek-ai/dsh-client-*`」的约束。

### 加载与留痕

`dsh-hmr` 默认监听 profile manifest，改动 `package.json` 会触发一次协调重载；
但**首次装入一个新包**时，若 `burn_tokens` 工具没有出现，重启 Desktop 应用（或在 Plugins 页做一次 enable/disable）即可。

插件每次加载都会往 `<home>/token-burner/plugin-load.jsonl` 追加一行（时间、pid、硬上限、**加载期**能否看到账户服务）。
所以「它到底加载了没有」是可查的 —— 调 `burn_tokens { action: "runs" }` 会在末尾列出加载记录。
对会花钱的插件来说这是必要的审计线索，不是噪声。

> **`hasAccountAtLoad: false` 是正常的，不是故障。**
> `@deepseek-ai/dsh-deepseek-account-platform` 的插件类声明了 `static inject = ["credentials", "authorization"]`，
> cordis 会**推迟**它的 `apply`，所以 `deepseekAccount` 服务是在本插件加载完成**之后**才注册的。
> 本插件只 `inject: ['tools', 'llm']`，因此加载期 `ctx.get('deepseekAccount')` 必然是 `undefined`。
>
> 因此账户服务是**惰性解析**的（每次用到时才 `ctx.get`，绝不缓存）；
> 想确认运行期到底能不能用，调 `burn_tokens { action: "doctor" }`。
> 千万**不要**把 `deepseekAccount` 写进 `inject` —— 那会让插件在服务缺席时根本不加载，整个工具直接消失。

---

## 改配置（比如把硬上限从 ¥1 提高）

`maxAmountCny` 默认 `1` 元，写死在插件自带的 `cordis.patch.yml`。两条改法，代价完全不同：

### A. 改插件自带的 patch —— 简单，但**必须重启应用**

`token-burner/cordis.patch.yml` 里的 `maxAmountCny` 那一行：

```yaml
        maxAmountCny: 5        # 原值 1
```

改完重启。为什么必须重启：`dsh-hmr/lib/index.js:354` 只监听两个文件 ——

```js
const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)];
//                   ~/.dsh/profiles/desktop/cordis.patch.yml    ~/.dsh/cordis.patch.yml
```

插件的 bundle patch 不在里面。而且 `dsh-app-boot/lib/index.js:1023` 的 `readProfilePatches()` 是从
**启动时捕获的 `profile` 对象**里取 bundle 层的：

```js
...profile.layers.flatMap((layer) => layer.patches),   // ← bundle patch，闭包里的旧值
...loadOptionalPatches(binName, context.patchPath),     // ← 每次重读
...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")),
```

所以热重载只会重读那两个 profile patch 文件，**永远读不到 bundle patch 的新内容**。

### B. 在 profile patch 里覆盖 —— **不用重启**，但有个大陷阱

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加：

```yaml
- id: token-burner
  config:
    maxAmountCny: 5
```

这个文件被 HMR 监听（内容变化才触发，纯 `touch` 改 mtime 无效 —— `refresh()` 里用
`readFileSync(filename, "utf8")` 做了内容级去重），保存即生效。

> ⚠️ **`config` 是整体替换，不是深合并。**
> `dsh-app-boot/lib/index.js:61` 的 `applyEntryPatches()` 干的是：
>
> ```js
> for (const [key, value] of Object.entries(overrides)) { if (key === "id") continue; target[key] = value }
> ```
>
> `config` 只是其中一个 key，赋值即**整体覆盖**。上面那段 YAML 会把 `lane`、`requestCostCny`、
> `requestTimeoutMs`、`maxInputTokens`……**全部打回默认值**。用 B 就必须把原配置整段抄过来，只改那一行。
>
> 另一个静默失败点：patch 里如果写了 `name` 而它与目标 row 的 `name` 不一致，该 patch 会被**静默跳过**（只在日志里 warn）。拿不准就**别写 `name`**，只写 `id`。

### 改完怎么确认生效

```bash
# 1) 加载留痕里出现了新的一行，且 maxAmountCny 是新值
tail -1 ~/.dsh/token-burner/plugin-load.jsonl
```

或者直接调 `burn_tokens { action: "doctor" }`，看第 5 节的「硬上限 `maxAmountCny`」。
**改配置也会重跑 `apply()`**，所以留痕行数是判断「有没有生效」的可靠手段。

上限的夹紧范围是 `clamp(x, 0.0001, 1e6)`（`lib/controller.js:123`），即实际可用 ¥0.0001 ~ ¥1,000,000。
不过金额小到「连一次最小请求都买不起」时（默认配置下约 ¥0.00022 以下），预算锁会**一次请求都不发**，
直接以 `result: "short"` 收尾并给出告警 —— 这是刻意的：宁可明说买不起，也不发无意义的请求。

---

## 零成本预检：`action: "doctor"`

**任何一次会话想烧钱之前，先跑这个。** 它不发任何模型调用、不产生任何费用，但会检查所有「花钱前必须成立」的前提：

```
burn_tokens { action: "doctor" }
```

| 检查项 | 用什么 | 失败意味着 |
| --- | --- | --- |
| `ctx.llm` 是否可用 | 有 `stream()` 方法 | 缺失 → 工具根本无法工作 |
| `deepseekAccount` 运行期是否可见 | 惰性 `ctx.get` | 不可见 → 余额对账不可用，金额只是估算值 |
| provider 是否已注册 | `ctx.llm.listProviders()` | 不在列表 → 一定以 `NO_ADAPTER` 失败 |
| provider/model 路由是否有效 | `ctx.llm.resolveModelInfo()` | 抛错 → 组合无效，花钱前必须解决 |
| `maxInputTokens` 是否超出上下文窗口 | `info.context.contextWindow` | 超出 → 必然 `CONTEXT_WINDOW_EXCEEDED` |
| 客户端身份能否合成 | `burner.clientIdentity()` | 合成不出来 → `getBalance()` 会抛 `reading 'version'` |
| 余额能不能读到 | `getBalance(client)`（只读网络） | 读不到 → 失去唯一的权威对账手段 |
| 记账目录能不能写 | `fs.accessSync` | 不可写 → 事后无法核对 |
| 当前是高峰还是空闲 | 内置价格表 | 决定同金额要烧多少 token |
| 下次档位切换还有多久 | `nextTierChange()` | 跨档位会让 ETA 与金额估算漂移 |

全部通过时结论是「所有预检项通过」；有任何阻塞项会明确写「**先不要跑 start**」并逐条列出原因。

> `listProviders()` 与 `resolveModelInfo()` 都只读本地注册表 / 能力表，**不发起 provider I/O**，
> 所以 doctor 是真正的零成本 —— 这也是它敢在花钱前跑的原因。

### `getBalance(client)` 的客户端身份（踩过的坑）

`ctx.deepseekAccount.getBalance()` **需要一个参数**，不是无参调用：

```js
getBalance(client)  // client = { version: string, locale: string, timezoneOffsetSeconds: number }
```

这三个字段会被 `platformClientHeaders()`（`dsh-deepseek-account/lib/types/index.js:43`）直接变成 HTTP 头
`x-client-version` / `x-client-locale` / `x-client-timezone-offset`。
平时这个对象由 Web UI 经 RPC 传进来；**Host 侧插件必须自己合成**，否则会炸在：

```
Cannot read properties of undefined (reading 'version')
```

本插件的合成规则（`Burner#clientIdentity()`，全部可在 `cordis.patch.yml` 覆盖）：

| 字段 | 取值 |
| --- | --- |
| `version` | `clientVersion` 配置 → 否则读宿主 `Info.plist` 的 `CFBundleShortVersionString` → 否则 `0.2.0-rc.2` |
| `locale` | `clientLocale` 配置 → 否则 `zh-CN` |
| `timezoneOffsetSeconds` | `timezoneOffsetSeconds` 配置 → 否则 `-new Date().getTimezoneOffset() * 60`（UTC 以东为正，北京 = `28800`；每次调用重算） |

> 字段名与 `timezoneOffsetSeconds` 的语义一致（UTC 以东为正）。这是按语义选的：
> UI 侧的构造点在超大 bundle 里，无法静态确认它用的是 `offset*60` 还是 `-offset*60`。

### 另一个坑：`resolveModelInfo()` 的返回形状是嵌套的

```ts
LlmResolvedModelInfo {
  provider, id, name, description?, inputModalities?,
  context?: { contextWindow: number },              // ← 对象，不是数字
  defaultMaxTokens?: number,
  reasoning?: { efforts: readonly { id, … }[], defaultEffort?: string },  // ← 对象数组
}
```

早期写成 `info.contextWindow ?? info.context`，拿到的是**对象**，渲染出来就是 `contextWindow：NaN tokens`；
efforts 直接模板插值则得到 `[object Object]`。冒烟测试里专门有断言禁止输出里出现 `NaN` 或 `[object Object]`。

---

## 四个真机踩过的坑（别再踩回去）
### 1. 实际并发 ≠ `maxConcurrency`（预算锁的副作用）

预算锁每轮只发 `grant = min(剩余, requestCostCny)`，所以**同时在途的请求数**被「目标金额 ÷ 单请求预留」卡住：

```
实际并发 = clamp(floor(目标金额 / requestCostCny), 1, maxConcurrency)
```

¥0.1 配 `requestCostCny: 0.2` → `floor(0.1/0.2) = 0` → 夹到 **1**。
计划里曾经写「并发 8 / 预计 2 秒」，真机却是一串 3 秒起步的**串行**请求 —— 计划现在按实际并发算墙钟，
并在被压低时显式告警。想更并发就调小 `requestCostCny`。

当前 `requestCostCny: 0.2` + `maxConcurrency: 8` 下的实际并发：

| 目标 | ¥0.1 | ¥1 | ¥5 | ¥50 |
| --- | --- | --- | --- | --- |
| 实际并发 | 1 | 5 | 8 | 8 |

### 2. `requestTimeoutMs`：provider 卡死必须能自己爬出来

真机事故（运行 `burn-20261015-024527-yifa`）：provider 连回两次 `SERVER`（"Service is too busy"）后，
第 4 个请求**永不返回**。`#release(run, grant)` 在 `finally` 之后才执行，所以那个请求一直占着预算锁，
整轮运行 3.2 分钟零进展、余额停在 ¥0.056970 不动。

现在 `#issue()` 用两个独立中止源合成 `signal`：

```js
signal = AbortSignal.any([controller.signal, timeoutCtl.signal])   // 整轮停机信号 ∪ 单请求超时
```

超时触发时失败码记为 `TIMEOUT`（不是 `ABORTED`，以便与用户停机区分），并走通用退避。
默认 `requestTimeoutMs: 120000`（2 分钟），`0` 表示不限；`resolveConfig` 夹紧到 `[0, 900000]`。
注意：超时的请求**不记任何花费**（拿不到 usage），所以真实已扣金额可能略高于账本 ——
这正是「余额差才是唯一权威对账」的原因。

### 3. provider 是否「饱和」是**时段性**的 —— 先判档，再选策略

这是 2026-10-15 用真钱学到的最贵的一课，而且**第一节结论我写错过一次，这里保留纠正过程**。

**provider 的限流形态是「握住连接不回复」，不是 429。** 这一点是确定的。
但它**是否**限流，取决于当下它饱不饱和 —— 同一个插件、同一份配置，
12 分钟之内可以表现成两个完全不同的东西：

| 时刻（北京时间） | 运行 | 结果 |
| --- | --- | --- |
| 11:35–12:00（**高峰档**） | `burn-20261015-034836-6hmg` | 30.7 分钟才到 ¥4.850（97.0%），120 请求里 **81 个失败** |
| 13:09（**空闲档**） | `burn-20261015-050951-t2s9` | **12.4 秒**到 ¥4.997（99.9%），50 请求 **全部成功、零失败** |

**所以「提高并发没用」是错的 —— 那只是饱和时段的真相。** 空闲时段并发本身就能打满：
延迟中位 2.1 秒（最快 309 ms），`requestCostCny: 0.2` + `maxConcurrency: 8` 12 秒收工。

**怎么判断当下属于哪种？** 看 `status` 的两个数：
`rateLimited` 与 `failed` 的比值、以及成功请求的延迟。
只要**成功请求稳定在 2~3 秒返回、失败数为 0**，就是不饱和，什么都不用改。
一旦出现「成功 2~3 秒 / 失败一律挂满整个 `requestTimeoutMs`」的**两极分化**，
就是饱和了，此时下面的「把单请求做大」才是唯一有效杠杆。

饱和时段的证据（¥5 运行 `burn-20261015-033616-suee`，并发 64）：

- 整轮 `rateLimited` **恒为 0** —— 一个 429 都没有。而 `dsh-llm-deepseek/lib/index.js:1752`
  只在 `status === 429 || type === "rate_limit_error"` 时判 `RATE_LIMIT`，所以插件里
  「遇限流并发减半、退避 8 秒」的那套逻辑**一次都没被触发**。
- 64 个并发请求里只有 4 个拿到响应，其余 60 个全部挂到超时才回收。
- 更关键的是**每波只服务约 3 个请求**，与我们并发多少无关：

```
波1: 3 成功(2.4s) + 8 TIMEOUT
波2: 3 TIMEOUT
波3: 8 TIMEOUT
波4: 8 TIMEOUT
波5: 3 成功(2.2s)
```

→ **饱和时，瓶颈是「它肯服务的请求条数」，不是我们的并发数。** 此时唯一有效的杠杆是
**把单请求做大，用更少的请求烧掉同样的钱**：

| `requestCostCny` | 单请求 ≈token | ¥5 需要成功次数 | 高峰档真机实得 |
| --- | --- | --- | --- |
| 0.05 | 19k（¥0.038） | ~147 | ¥0.305（并发 8，93 秒后放弃） |
| 0.2 | 76k（¥0.152） | ~33 | **¥4.850 / 30 分钟** |

**但注意：这不饱和时会反过来变成缺点。** 把单请求做大意味着每次失败浪费更多墙钟、
每个 ¥0.2 的资金格子更大更粗。所以正确顺序是：
**先跑一轮小的看饱和不饱和，再决定要不要放大单请求 —— 不要无条件把 `requestCostCny` 调高。**

另一个可用的判据：**成功与失败之间没有中间地带** ——
成功的请求一律 2~3 秒返回，失败的请求永远挂到超时。
所以 `requestTimeoutMs` 不需要给得比正常耗时宽太多。

### 4. 停机判据必须带**时间闸门**

`maxConsecutiveFailures` 的判据是**连续**失败数（任何一次成功都会把计数清零）。
这个判据在成波下发时会失真：provider 一个「坏时刻」**同时**打掉整波在途请求，
于是 8 个并发失败在计数上看起来就是「连续 8 次失败」，把整轮运行在 15 秒内误杀
（真机运行 `burn-20261015-034400-0kpj`：¥5 只推进了 ¥0.085 就被判死）。

把阈值单纯调大**不管用** —— 顶到夹紧上限 100 之后，照样会被一波坏时刻击穿。
真正判「provider 已经彻底不服务了」的信号是**时间**：

```js
const streakLimit = Math.max(config.maxConsecutiveFailures, run.limit)
const sinceSuccessMs = Date.now() - (run.lastSuccessAt ?? run.startedAt)
if (run.failureStreak >= streakLimit && sinceSuccessMs >= config.stallTimeoutMs) {
  this.#finish(run, 'stalled')   // ← 停机原因不再是 too-many-failures
  ...
}
```

即：**连续失败 N 次 _且_ 距上次成功超过 `stallTimeoutMs`（默认 45000）才停机。**
只要还有零星的 2~3 秒成功响应冒出来，整轮就该继续跑下去。失败请求不计费，
所以宽容的代价只有墙钟时间 —— 宁可多等，也别误杀。

`stallTimeoutMs` 夹紧到 `[5000, 600000]`。设成 `0` 无效（会被夹到 5000）。

> 不知道为什么要 6 次而不是 2 次的话：`failureStreak` 只在**成功**时清零，
> 而 `#handleFailure` 每次都设 `cooldownUntil`（最多 8 秒），所以阈值太低会在网络抖动时反复误杀。

### 5. 「成功但没有 usage」必须限次

预算锁全靠 `usage` 记账。一次请求**成功返回却没有 usage** 时，它在预算锁眼里就是**免费的** ——
但它很可能已经被计费了。更糟的是它会**同时废掉两道闸门**：

- `spentCny` 不增长 → 永远到不了目标；
- `failureStreak` 每次成功都被清零 → 上面那道「连续失败 + 卡住太久」的闸门永不触发。

于是整轮会一直发请求，直到撞上 `deadlineSeconds` 或 `maxRequests` ——
而这期间的花费在账本上**完全看不见**。

所以连续 `maxUnaccountedResponses`（默认 5）次「成功但无 usage」就以 `unaccounted` 停机并报错。
偶发一两次不会误杀：计数器会被下一次**带 usage** 的响应清零。
provider 正常时恒不触发；这条闸门来自代码审查，而不是来自事故 —— 真机上从未触发过。

对应的停机原因一览（`status.stopReason`）：`undefined`（跑到了目标，正常收尾）、`deadline`（超墙钟）、
`max-requests`（超请求数）、`user-stop`（用户停机）、`cancelled`（工具调用被取消）、
`plugin-unload`（插件卸载）、`stalled`（provider 停止服务）、`unaccounted`（记账已不可信）、
`quota-exhausted`（余额耗尽）、`stuck`（预算锁与请求尺寸逻辑不一致，属插件 bug）。

---

## ¥5 真机运行实录（2026-10-15，真钱）

用户明确授权后，用 `burn_tokens action="start" amountCny=5 confirm=true` 连跑了 6 轮，
每轮都在真账户上扣钱。全部账本在 `~/.dsh/token-burner/runs/`。

| # | runId | 配置要点 | 结果 | 死因 |
| --- | --- | --- | --- | --- |
| 1 | `burn-20261015-033616-suee` | 并发 64 | ¥0.113520 | 工具调用 120s 上限触发 `stop('cancelled')`；64 个请求里只有 4 个返回 |
| 2 | `burn-20261015-034100-p7ep` | 并发 8，目标 ¥0.2（探路） | **¥0.194618 / ¥0.2（97.3%）**，114 秒 | 正常收敛 |
| 3 | `burn-20261015-034400-0kpj` | 同上，目标 ¥5 | ¥0.085290 | 15 秒被 `too-many-failures` 误杀（见坑 4） |
| 4 | `burn-20261015-034629-z3cz` | 同上 | ¥0.305166（93 秒后我手动停） | 人工 `stop`，暴露饱和时段「每波只服务 3 个」 |
| 5 | `burn-20261015-034836-6hmg` | `requestCostCny: 0.2`，并发 8 | **¥4.850243 / ¥5（97.0%）** | 跑满 `deadlineSeconds: 1800` |
| 6 | `burn-20261015-050951-t2s9` | 同第 5 轮，**空闲档** | **¥4.996961 / ¥5（99.9%）**，**12.4 秒** | 正常收敛 —— 50 请求全部成功 |
| 7 | `burn-20261015-055544-q2h5` | 同上，目标 ¥10 | **¥9.994297 / ¥10（99.94%）**，**23.8 秒** | 正常收敛 —— 82 请求全部成功 |

**第 6、7 轮连续两次干净收敛，说明「空闲档 + 并发 8 + `requestCostCny: 0.2`」是一套可复现的稳态配置。** 第 7 轮的吞吐：

```
82 请求 / 23.82 秒 = 3.44 请求/秒 · 聚合预填 419,562 tok/s（≈52,445 tok/s/流）
有效速率 ¥25.17/分钟 ≈ ¥1510/小时
延迟 中位 2461 ms · 最快 364 ms · 最慢 3273 ms
单请求 token：最小 8,589 · 中位 152,116 · 最大 152,535   ← 已贴住 maxInputTokens 的有效上限
全部 82 笔都结算在 off 档（13:55:44 启动、13:56:08 结束，未跨 14:00 切换点）
```

**第 5 轮 vs 第 6/7 轮：同一份配置，表现天差地别**（这就是坑 3 要传达的东西）：

```
第 5 轮（11:35 起，高峰档）      第 6 轮（13:09 起）      第 7 轮（13:55 起）
120 请求 / 39 成功 / 81 失败     50 请求 / 50 成功 / 0     82 请求 / 82 成功 / 0
1845 秒（30.7 分钟）             12.4 秒                  23.8 秒
¥4.850243（97.0%）              ¥4.996961（99.9%）       ¥9.994297（99.94%）
¥0.158/分钟                      ¥24.2/分钟               ¥25.17/分钟
```

同样一份配置，**有效速率差了 159 倍**（¥0.158/分钟 → ¥25.17/分钟）。差别不在插件，在 provider 当时饱不饱和。

**第 5 轮的体检数据**（饱和时段的样本）：

```
目标 ¥5 · 容差 ¥0.01 · 实得 ¥4.850243（97.0%）· 耗时 1845 秒（≈30.75 分钟）
请求 120 次：成功 39 / 失败 81 / 限流 0        →  成功率 32.5%
输入 2,651,693 token（缓存读 0 / 缓存写 0）· 输出 39 token
平均每次成功 68k token = ¥0.124 · 有效速率 ¥0.158/分钟 ≈ ¥9.5/小时
```

三个值得记住的点：

1. **缓存读恒为 0** —— 每次请求的 prompt 前缀都带唯一 nonce，所以「烧输入」烧的全部是
   最贵的「缓存未命中」档，这正是 input 通道能比 output 通道快 ~100 倍的原因。
2. **第 5 轮没跑到 ¥5，差 ¥0.15**（第 6 轮跑到 99.9%，所以这不是插件的固定毛病）。
   饱和时段的收尾会**越接近目标越慢**：预算锁每轮只肯预留
   `min(剩余, requestCostCny)`，所以剩余金额一少，单请求尺寸就被自适应算法压小
   （实测末尾已缩到 4~5k token 一次），而 provider 每波仍然只服务 3 个 ——
   最后 3% 磨了十几分钟。饱和时段想把 ¥5 跑满，`deadlineSeconds` 放到 3600 更稳。
3. **两轮的余额括号都不可信，但原因不同。** 第 5 轮 `after` 是
   `{"error": "账户接口返回 status:\"failed\"（查询失败不提供金额，插件绝不把它当作 0）"}`，
   `deltaCny`/`settled` 都是 `null`；第 6 轮是 `{"deltaCny": 0, "settled": false, "driftCny": -4.996961}`
   —— 起止余额**完全相同**（同一个脱敏占位符，两次读数一字不差），但账本记了 ¥4.997，纯粹是结算延迟。
   两种都是**正确行为**（`settled: false` 这条判据在真机上按设计生效了），
   但也说明余额对账不可依赖，见下一节。

> ⚠️ 再次强调：**别指望用余额差验收小额运行。** 跑这个插件的 agent 会话本身
> 就在同一个账户上花钱，同期消耗常常是被验证对象的 8~12 倍。

## 首次真钱验证清单（¥0.10）

**目的**：确认「估算金额」与「余额实扣」一致。在此之前不要放开金额。

### 步骤

```
1) 重启 Desktop 应用（首次装入新包需要；之后改动由 HMR 接管）
2) 零成本预检：burn_tokens { action: "doctor" }
   → 期望「所有预检项通过」；务必确认 deepseekAccount 一行是 ✅ 可用
   → 若显示「运行期仍不可见」，不要继续：余额对账会失效，详见上文「加载与留痕」
3) 确认加载：burn_tokens { action: "runs" }
   → 末尾应出现「插件加载记录」
4) 出计划（不花钱）：burn_tokens { action: "plan", amountCny: 0.1 }
5) 真实执行：burn_tokens { action: "start", amountCny: 0.1, confirm: true }
   → **不要传 waitSeconds！** 宿主对一次工具调用有 120 秒硬上限，等过头会被当成
     「调用被取消」而调 stop('cancelled')，把一轮健康的运行打断。
     让它立即返回，然后轮询 status（见下一条）。
6) 复查：burn_tokens { action: "status" }
```

### 验收标准

| 项 | 期望 | 不合格说明什么 |
| --- | --- | --- |
| `result` | `target-reached` | 若为 `short`：剩余额度不足或触达容差，看 warnings |
| `spentCny` | 落在 `[0.1 - 容差, 0.1]`，容差 = ¥0.01 | 超过 0.1 → 预算锁失效，**立刻停机并报告** |
| `tokens.cacheRead` | 接近 0 | 显著 > 0 → nonce 机制失效，烧钱速度会掉 1.5~2 个数量级 |
| `requests.failed` | 0 | 有失败看 `lastError.code` |
| `requests.rateLimited` | 0 | 有则并发降一半并退避重试 |
| `balance.settled` | `true` | `false` → **不要**据此判断花了多少钱，改用 `action: "reconcile"`（见下节） |

> ⚠️ **不要把 `balance.deltaCny` 当验收标准。** 早期版本把「余额差 ≈ 账本」写进验收表，
> 真机证明那是错的 —— 余额差有两个独立的污染源，详见下一节。
>
> ⚠️ **而且 ¥0.1 这个量级根本验不出来。** 真机实测：同样的对账方法，
> ¥0.1 运行的差额是账本的 **8.5~12.7 倍**（agent 噪声完全淹没信号），
> ¥5 运行只多 **3.3%**。所以要靠余额验收，**至少烧到 ¥1**；
> ¥0.1 那一轮只用来确认「链路通、不超支、账本形状对」，金额一致性交给 ¥1 以上的运行。

### 余额对账为什么不可信（真机实测）

> **关于本文中的余额数字：** 下面出现的 `CNY <余额A>` 这类占位符是**经过脱敏**的真实读数
> （原值已隐去）。脱敏只抹掉绝对值 —— **所有差额都原样保留**（`¥0.234`、`¥0.09376824`、
> `driftCny` 等），因为论证靠的正是差额与「两次读数是否相同」，而这些完全不受影响。
> 同一个占位符代表同一个数，不同占位符代表不同的数。

**污染源 1：余额接口有结算延迟。**
`burn-20261015-025631-2y5f` 跑完 9 秒后立刻复读余额：

```
before CNY <余额A> @ 02:56:31.514Z
after  CNY <余额A> @ 02:56:40.902Z     ← 一个数都没动（占位符相同 = 同一个数）
deltaCny 0   spentCny 0.095214   driftCny −0.095214
```

约 4 分钟后 doctor 读到另一个更小的数，比 `<余额A>` 掉了 ¥0.234 —— 包含了本轮烧的 ¥0.0952。
所以短运行的 `after` 括号基本没用；`driftCny = 0` 意味着「还没结算」，**不是**「没花钱」。
现在 `settled === false` 时会显式告警。真要对账就等几分钟再跑 `action: "reconcile"`。

**污染源 2：同一个账户上的一切其他用量都会混进差额里。**
上一次运行的括号：

```
before CNY <余额B> @ 02:45:27.429Z
after  CNY <余额C> @ 02:48:55.282Z
deltaCny 0.09376824   spentCny 0.05697   driftCny +0.03679824
```

`after` 的时间戳正好是那个卡死请求被 ABORT 的时刻，括号横跨了 3.5 分钟的停机过程 ——
而这期间**跑这个插件的 agent 会话自己**在同一个账户上花了约 ¥0.036。
更极端的一次：两次 doctor 之间余额掉了 ¥0.6572，其中只有 ¥0.0938 能归给插件运行，
剩下的 ¥0.56 全是 agent 会话自己改代码/跑测试时烧的。

→ **结论：余额差只能当上界用，不能当账本。** 金额以插件账本（按 provider 回的 usage × 价格表算出）为准，
余额差只用来发现「量级不对」这种粗粒度异常。

**污染有多严重（第三次复读，最能说明问题）。** 用 `action: "reconcile"` 对
`burn-20261015-025631-2y5f` 复读，距该次运行 12.3 分钟：

```
账本估算        ¥0.095214   ← 真实烧钱额（3 次请求 × 官方高峰价逐位吻合）
原始差额        ¥0.809032   ← 账户在这 12.3 分钟里的总降幅
```

差额是账本的 **8.5 倍**。那 ¥0.71 里绝大部分是**跑这个插件的 agent 会话自己**在这 12 分钟里
改代码、跑测试、写文档烧掉的。也就是说，**在 ¥0.1 这个量级上，用余额差验证烧钱额没有意义 ——
被验证对象比验证工具本身的噪声小一个数量级。**

这也反过来解释了第一次运行（卡死那次）的括号为什么会得出 `driftCny +0.0368`：
当时我一边等一边发 `sleep`/`status`/`stop`，那些 agent 轮次全落在同一个括号窗口里。

**但金额上到 ¥5 以上，对账就真正有分辨力了。** 用 `reconcile` 复读两次大额运行：

| 运行 | 账本 | 复读时刻 | 原始差额 | 超出账本 | 是否报 🔴 |
| --- | --- | --- | --- | --- | --- |
| `burn-20261015-050951-t2s9` | ¥4.996961 | 3.0 分钟 | ¥3.302251 | — | 🔴 **报了**（结算未追上） |
| 同上 | ¥4.996961 | 8.1 分钟 | ¥5.161599 | +3.3% | 消失 |
| `burn-20261015-055544-q2h5` | ¥9.994297 | 6.5 分钟 | ¥10.115098 | **+1.21%** | 未报 |

**金额越大，对账越干净**：¥0.1 时超出 850%，¥5 时 3.3%，¥10 时 1.21% ——
超出的部分始终是「agent 会话自己在同一账户上的同期消耗」，它不随烧钱额线性增长，
所以分母一大就被摊薄了。

三点结论：

1. **报的 🔴 异常是准确的告警，不是 bug。** 插件判定「账本永远不该超过真实扣费」，
   所以差额小于账本时它必须喊 —— 而那次喊对了：结算确实还没追上。
   等结算补齐，异常自己就消失了。**看到 🔴 别慌，过几分钟再 reconcile 一次。**
2. **想用余额验收，就烧到 ¥1 以上**；¥0.1 级别永远验不出来。
   最好**烧到 ¥10**，误差已经收到 1% 量级。
3. 结算延迟本身也不是固定的：¥10 那轮 6.5 分钟就补齐了，¥5 那轮 3 分钟时还没追上。
   **别指望一个固定的等待时间，复读到不再报异常为止。**

> 跨两个价格档位的长运行要小心：如果运行跨越 12:00 / 14:00 / 18:00 这类切换点，
> 账本是按每笔请求**实际发生时刻**的单价结算的（`priceFor` 每次调用都重算档位），
> 而余额差是整段的总额 —— 两者仍然可比，但别再拿单一单价去手算校验。

### `reconcile` 的用法

```
burn_tokens { action: "reconcile" }                     # 默认最近一次运行
burn_tokens { action: "reconcile", runId: "burn-..." }  # 指定某次
```

输出：运行 id、目标金额、**账本估算**、起始余额（含时刻）、当前余额、间隔、**原始差额**，
并始终附上「这个差额是脏的」的说明。两条自动判据：

- `rawDeltaCny < ledgerCny` → 🔴 **异常**。账本永远不该超过真实扣费，出现即说明余额还在延迟结算，
  或者价格表 / usage 解析有问题。
- 快照括号被判为不可信 → ℹ️ 提示需要复读的原因。

对**旧账本**（`settled` 字段引入之前写下的运行）它会从存下来的 `deltaCny` 反推，
并在文案里标明「此判断是从旧账本反推的」。反推规则与运行时一致：`deltaCny === 0 && spentCny > 0`
→ 不可信。这一条是必需的 —— 否则 `burn-20261015-025631-2y5f` 那个假的 `deltaCny: 0`
会被当成「余额没动 = 没花钱」，正好复现我们踩过的坑。
（坑中坑：`spentCny` 在 finish **记录**上，`deltaCny` 在 `finish.balance` **里**，两层不同，第一版反推就写错了。）

### 常见错误的诊断

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `NO_ADAPTER` / `MISSING_CREDENTIAL` | provider 路由名不对 | 本机 profile 是 `deepseek-account`；确认 `agent-default-model` 行还在 |
| `EMPTY_RESPONSE` | 输出为空（可能是思考模式吃光了 maxTokens） | 调大 `outputTokens`，或确认 `reasoningEffort: off` |
| `CONTEXT_WINDOW_EXCEEDED` | 输入超上下文 | 会自动把 `maxInputTokens` 降到 75% 重试；持续报就手改配置 |
| `RATE_LIMIT` | 限流 | 已自动退避 + 并发减半，属正常自适应 |
| `QUOTA` / `ACCOUNT_QUOTA` | 余额耗尽 | 运行会立即停机；这是你确实把钱烧完了 |
| 余额对账不可用 | `deepseekAccount` 未挂载或查询失败 | 金额只是估算值；看 `balance.before.error` |

### Agent 看不到 `burn_tokens` 怎么办

工具列表是**按会话**持有的：插件加载之前就已经开始的会话，看不到新工具。按顺序试：

1. **重启 Desktop 应用** —— 改动 JS 代码后必须重启才能加载新的模块代
   （`dsh-hmr` 在本机 profile 里是 `root: []`，等于不监听任何源码目录，所以没有热重载可用）。
2. **在对话里直接说「用 burn_tokens 做 doctor」**。DSH 的工具注册表是活的，重启后新的一轮通常就能看到。
3. 仍然看不到 → **新开一个会话**（新会话必然拿到最新的工具列表），把下面这段原样发给它：

```
用 burn_tokens 工具做两件事，不要做别的：
1) action="doctor" —— 零成本预检，确认 deepseekAccount 那一行是 ✅ 可用
2) 如果 doctor 全部通过，再跑 action="plan", amountCny=0.1
把两次的完整输出贴回来。不要执行 start。
```

4. 想确认插件到底加载了没有（不依赖 agent）：直接看文件
   `~/.dsh/token-burner/plugin-load.jsonl`，每行一次加载记录。

---

## 用法

工具：`burn_tokens`。**七个动作**：

| action | 花钱？ | 说明 |
| --- | --- | --- |
| `doctor` | ❌ 不花 | 零成本预检：服务、LLM 路由、余额、计价档位、配置、记账目录。**想烧钱前先跑这个** |
| `plan` | ❌ 不花 | 出计划：单价档位、需要多少 token、多少次请求、实际并发、预计耗时、两条通道对照 |
| `start` | ✅ **真花** | 开始烧。**必须显式传 `confirm=true`**，且金额不得超过 `maxAmountCny`。开跑前会做一次余额预检 |
| `status` | ❌ | 进度、￥/分钟、ETA、token 明细、余额对账 |
| `stop` | ❌ | 优雅停机：停止下发新请求，宽限期后中止在途请求 |
| `runs` | ❌ | 列出本机历史运行（审计日志） |
| `reconcile` | ❌ 不花 | 复读余额与某次运行对账（可传 `runId`，默认最近一次）。**余额有结算延迟，跑完等几分钟再查** |

建议流程（agent 侧也应按此执行）：

```
1) burn_tokens { action: "plan", amountCny: 0.1 }          ← 先看计划
2) burn_tokens { action: "start", amountCny: 0.1, confirm: true }
                                                           ← 不要传 waitSeconds（120s 工具上限）
3) burn_tokens { action: "status" }                        ← 轮询进度（start 会立即返回）
4) burn_tokens { action: "stop" }                          ← 需要时急停
5) burn_tokens { action: "reconcile" }                     ← 几分钟后对账（可选）
```

Web 端点：composer 下方的「🔥 烧 token」面板，提供
「出计划 / 开始烧 / 查进度 / 停机 / 对账」五个复制按钮；
「开始烧」按钮需要先勾选风险确认才会启用（避免误触真实扣费）。

面板只负责**把提示词复制到剪贴板**，真正的执行始终由 agent 调 `burn_tokens` 完成 ——
所以面板本身没有任何直接动钱的能力，这也是刻意的设计。

> 改了 `client.js` 之后要**刷新页面**才看得到（客户端那一半是浏览器从包目录直接读文件，
> 与宿主模块代的重启是两条独立的加载路径：宿主改动必须重启进程，客户端改动刷新即可）。

---

## 审计日志

```
~/.dsh/token-burner/runs/<runId>.jsonl     每次运行一行一记录（append-only）
~/.dsh/token-burner/stats.json             跨运行学习的经验常数
```

- `kind:"start"` / `kind:"finish"` — 运行的头尾快照
- `kind:"request"` — **每次请求一行**：token 明细、单价档位、耗时、prompt 字符数、错误码
- `kind:"error"` — 失败请求的错误码与消息

`stats.json` 会学习 `charsPerToken`（字符→token 比）与吞吐（tok/s），让后续的耗时估计越来越准。
第一次运行的耗时估计偏差可能很大。

---

## 实现要点（给自己和维护者）

- **零依赖**：只用 `node:` 内置模块。工作区包解析不到 `@deepseek-ai/*`，所以不能 `import { defineTool }`，直接构造工具定义对象交给 `ctx.tools.register()`。
- **参数校验自己做**：raw `register()` 不做 args 校验，范围在 `execute` 里夹紧。
- **直连 `ctx.llm.stream`**，不写 session 事件 → 不污染会话、不占上下文；代价是这笔消费不出现在 DSH 自己的 token 计量/UI 里。
- `ctx.llm` **不做重试、不做限流、不做缓存**，一次 stream 就是一次 provider attempt → 退避与并发全部由 `lib/controller.js` 自负（AIMD：限流则并发减半并退避，连续成功再逐步加回）。
- `isConcurrencySafe: false`：预算锁假设独占，同一时刻只允许一个运行。
- 插件卸载走 `ctx.effect` 清理，优雅停机，避免「孤儿」请求继续花钱。

### 文件

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 半：注册 `burn_tokens`，参数夹紧、金额上限、confirm 二次确认、渲染 |
| `lib/pricing.js` | 官方价格表、高峰/空闲判定、逐 token 计价 |
| `lib/filler.js` | 本地随机语料生成（保证缓存未命中）+ 字符/token 比学习 |
| `lib/ledger.js` | JSONL 审计日志 + 跨运行经验常数 |
| `lib/controller.js` | 预算锁、并发工作池、AIMD、记账、余额对账 |
| `client.js` | Web 面板（composer.dock） |

### 余额接口的权威形状（踩过坑，别改错）

`ctx.deepseekAccount.getBalance(client)` 的返回**不是** `{ currency, balance }`，而是：

```ts
null                                                        // 未登录 / 没有可用凭证
| { status: 'ready', value: Wallet[], bonusWallets: Wallet[] }  // Wallet = { currency: 'CNY'|'USD', balance: string }
| { status: 'failed' }                                       // 查询失败
```

两点必须守住：

1. **充值余额在 `value` 数组里**，不是 `balance` 字段。曾经误读 `r.balance`（不存在）→ `Number(undefined, 0)` → 恒为 ¥0.0000，**把「有钱」谎报成「没钱」**。
2. **`status: 'failed'` 与 `null` 都必须报错，绝不能退化成 0。** 这是账户 README 的硬要求（“Query failure supplies neither amount”）。插件现在把这两种情况都作为 `error` 返回，`doctor` 会把它列为**阻塞问题**。

另外 `getBalance(client)` 的 `client` 参数是必需的：`{ version, locale, timezoneOffsetSeconds }`，会被转成 `x-client-version` / `x-client-locale` / `x-client-timezone-offset` 三个请求头。平时由 Web UI 经 RPC 传入，**Host 侧插件必须自己合成**（漏传的报错是 `Cannot read properties of undefined (reading 'version')`）。插件默认从宿主 `Info.plist` 读版本、locale 用 `zh-CN`、时区取 `-getTimezoneOffset()*60`（UTC 以东为正），三项都能在 `cordis.patch.yml` 覆盖。

### 已知限制

- 余额查询走网络、默认 30s 超时，**不能**用作主控信号，只用于开始/结束对账。
- 查询失败返回 `null`（不会变成 0），插件会区分「查询失败」与「没花钱」。
- `start` 会先做一次余额预检：**确知** CNY 余额不足时直接拒绝（此时一次请求都不会发，避免每个请求都撞 `ACCOUNT_QUOTA`）；余额查不到时不阻断，只附醒目告警。非 CNY 币种不做数值比较（不猜汇率）。
- **余额接口有结算延迟（真机实测 ≥9 秒，可能数分钟）**，且**同一账户上的一切其他用量都会混进余额差**——包括跑这个插件的 agent 会话自己。所以：
  - 运行快照里的 `after` 括号对短运行**不可信**；`settled === false` 时会告警，`driftCny = 0` 意思是「还没结算」而不是「没花钱」。
  - 想知道到底花了多少，**以账本为准**（`~/.dsh/token-burner/runs/*.jsonl`，由 provider 回的 `usage` × 价格表算出）；余额差只能当**上界**用。
  - 想用余额核对，等几分钟再跑 `action: "reconcile"`。
- `usage` 在请求报错时也可能缺失，那时这一笔不计入估算值（尤其 `TIMEOUT` 的请求），所以真实扣费可能**略高**于账本。
- 实际并发受预算锁压制（见上文「四个真机踩过的坑」），目标金额越小并发越低，¥0.1 这种只有 1，墙钟时间因此是串行的。
- 输出通道（`lane: "output"`）精度受「模型可能提前停止」影响，会欠额后迭代补齐，因此比输入通道慢得多也更容易多次请求。
- **`plan` 的「预计耗时」系统性偏悲观，别拿它做决定。** `stats.json` 学到的
  `prefillTokensPerSec` 是一个**跨时段平均**（2026-10-15 实测 27,059），而真机吞吐强烈依赖
  provider 饱不饱和 —— 空闲档实测 **52,445 tok/s/流**（第 7 轮），饱和档低得多。
  把两种样本混在一起平均，结果必然对空闲档低估、对饱和档高估。
  经验换算：**不饱和时约 ¥25/分钟**（第 6、7 轮分别 ¥24.2、¥25.17），
  饱和时约 ¥0.16/分钟（第 5 轮）—— 差 159 倍。要做预算就按这两个锚点估，别看 `plan` 那个数。

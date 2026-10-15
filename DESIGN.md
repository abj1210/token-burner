# 快速消耗指定金额 token 的 DSH 插件 —— 设计方案

> 目标：给一个金额（如 ¥100），插件在尽可能短的时间内，把这个金额**准确地**花掉（真实扣费，允许 ±容差）。

---

## ⚠️ 风险提示与免责声明

**这一节是整个方案的前置条件，不是附注。**

1. **会真实花钱。** 插件通过 `ctx.llm.stream` 真实调用 DeepSeek 模型，费用从账户余额直接扣减（充值余额与赠送余额同时存在时**优先扣减赠送余额**），**不可撤销、不可退款**。这不是模拟器。
2. **默认硬上限 1 元。** 这是刻意的防误操作设计：任何一次运行的目标金额超过 `maxAmountCny` 会被直接拒绝，提高上限必须手改配置。**作者与 DSH 不对任何资金损失负责**，包括但不限于：模型价格变动、时段判定错误、并发限流、账户被风控、参数误用、进程崩溃导致的重复扣费。
3. **价格表是快照，不是合同。** 内置单价来自 DeepSeek 官方公开价格页，随时可能变动；高峰/空闲时段与**法定节假日判定是近似实现**（节假日表留空时，工作日的节假日会被按高峰价计算 —— 这是保守方向）。
4. **记账是估算，官方账单才是权威。** 金额来自 API 返回的 `usage` 字段乘以价格表；插件会做「开始前 / 结束后」余额对账，但不保证与官方账单完全一致。请求报错时可能拿不到 `usage`，那一笔就不计入估算值。
5. **结构性防超支有前提。** `spent + reserved ≤ target` 的保证依赖「实际字符/token 比不低于 `charsPerToken × ratioFloor`（默认 3.2）」。若填充文本的 token 密度远超预期，**单次请求最多可能超出预留约 1/ratioFloor 倍**；主循环会立即学习纠正，但这一笔已经花掉了。这是本方案唯一的已知超支窗口。
6. **限流与风控自负。** 高频并发请求可能触发限流甚至风控。请遵守 DeepSeek 服务条款，**不要**用于刷单、套利、绕过配额或任何滥用行为。
7. **先小额验证。** 强烈建议先在独立测试账户上用 0.1 元跑通、确认对账无误，再放开金额。任何情况下都不要把上限调到超出你能承受的损失。

---

## 0. 结论先行（三条最重要的判断）

1. **DSH 里根本没有"钱"这个概念。** 全 harness 无计价/预算/账单服务（75 个 Service 目录里没有任何 price/cost/billing），"pricing" 一律指 token 估算。唯一的货币来源是 `ctx.deepseekAccount.getBalance()`（只读、走网络、默认 30s 超时）。
   → **"指定金额"必须由插件自己定义、自己守护、自己对账。**

2. **真正难的不是"怎么花掉钱"，而是"怎么精确落在目标上"+"在有限时间内花完"。** 前者是控制问题，后者是吞吐问题。

3. **决定性的发现：烧钱有两条通道，速度差约 100 倍。**
   - **预填通道**（烧"输入·缓存未命中"）：一次请求灌满上下文 ≈ ¥1.8~2.0，几十秒完成 → **¥100 约 3~5 分钟**
   - **解码通道**（烧"输出"）：单流受生成速度限制（~40 tok/s）→ **¥100 单流要 87 小时**
   - 所以：**大额用预填（快），尾款用小请求（准）**。缓存是头号敌人（命中价便宜 100×），必须每次换全新前缀。

---

## 1. 官方价格与时段（设计的地基）

来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（¥ / 百万 tokens）

| 计费桶 | flash 空闲 | flash 高峰 | v4-pro 空闲 | v4-pro 高峰 |
| --- | --- | --- | --- | --- |
| 输入·缓存命中 | 0.02 | 0.04 | 0.15 | 0.30 |
| 输入·缓存未命中 | 1 | 2 | 4.5 | 9.0 |
| 输出 | 4 | 8 | 13.5 | 27.0 |
| 并发限制 | 2500 | | 500 | |
| 上下文 / 最大输出 | 1M / 384K | | 1M / 384K | |

**高峰时段**：北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00；**其余时段（含周末与法定节假日全天）价格减半**。
**扣费规则**：`费用 = token 消耗量 × 单价`，直接从充值余额或赠送余额扣减；**两者同时存在时优先扣减赠送余额**。

两条推论直接影响设计：

- **想快 → 挑高峰期烧。** 同样 ¥100，高峰价是空闲价的 2 倍 → 只需一半 token → 一半时间。
- **想多烧 token（同样金额）→ 挑空闲时段。** 这是两个不同的优化目标，插件应让用户选。

计费桶与 harness 的 `usage` 字段是一一对应的（`dsh-llm-deepseek/lib/index.js:1808-1821` 的 `updateUsage`）：

```
input_tokens                  → inputTokens        （非缓存输入，按"未命中"计价）
cache_read_input_tokens       → cacheReadTokens    （按"命中"计价）
cache_creation_input_tokens   → cacheWriteTokens   （DeepSeek 不单独收费）
output_tokens                 → outputTokens
```

→ **记账可以做到逐 token 精确**：`cost = inputTokens·p_in + cacheReadTokens·p_hit + outputTokens·p_out`。唯一的不确定是价格表本身（现已拿到官方值）。

---

## 2. 两条通道的定量对比（¥100 要多久）

| 通道 | 单请求规模 | 单请求费用(高峰 flash) | 单流速率 | ¥100 单流 | C=16 | C=64 |
| --- | --- | --- | --- | --- | --- | --- |
| **预填**（输入未命中） | 900K input tokens | ¥1.80 | ~¥108/h | ~56 请求 ≈ 56 min | **≈ 3.5 min** | ≈ 1 min |
| **解码**（输出） | maxTokens=384K，实际 ~40 tok/s | — | ¥1.15/h | ≈ 87 h | ≈ 5.4 h | ≈ 1.4 h |

> 预填单请求耗时按 60s 估（待校准探测实测）；解码按 40 tok/s/流 估。

**为什么差这么多**：解码被生成速度卡死（每流每秒几十个 token），而预填是并行 ingest，每秒能吞几千到几万个 token。虽然输出单价（¥8/M）是输入未命中（¥2/M）的 4 倍，但**按秒计的烧钱效率，输入通道高约 100 倍**。

**缓存是头号敌人**：命中 ¥0.04/M vs 未命中 ¥2/M = **50 倍**（空闲时段 0.02 vs 1 = 50 倍）。如果沿用同一个长前缀，第二次请求起输入几乎全部命中缓存 → 烧钱速度掉 1.5~2 个数量级。
→ 对策：**每次请求在 prompt 最前面插入全新随机 nonce**（前缀缓存从第一个 token 就开始比对，首位不同即全程未命中），并逐字生成全新的随机填充文本。

---

## 3. 架构

```
token-burner/
├── package.json          # 零依赖；dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # - insert: [{ id: token-burner, name: '@local/token-burner', config: {...} }]
├── index.js              # Host 半：export name / inject / apply；注册 burn_start|burn_status|burn_stop 工具
├── lib/
│   ├── pricing.js        # 官方价格表 + 高峰/空闲判定 + 计价函数
│   ├── filler.js         # 本地随机填充生成（保证缓存未命中）+ 字符/token 比 EWMA
│   ├── ledger.js         # 逐请求记账 + JSONL 日志 + 与余额对账
│   └── controller.js     # 预算锁 + 求解器 + AIMD 并发工作池 + 停机条件
└── client.js             # Client 半：conversation.composer.dock 面板
```

**Host 半**（骨架照抄本机已验证的 `@local/genshin-analyzer`）：
- `export const inject = ['llm', 'tools']`，可选 `ctx.get('deepseekAccount')` / `ctx.get('agentDefaultModel')`
- 默认路由取 `ctx.agentDefaultModel.currentSelection()` → `{ provider, model, reasoningEffort? }`（本机 profile 现为 `deepseek-account` / `deepseek-flash` / `max`）
- 每次请求直接 `ctx.llm.stream({ provider, model, reasoningEffort, temperature, maxTokens, messages })`
  - **不要**经过 agent 会话：直连流不写 session 事件 → 不污染会话、不占上下文
  - 代价：**这笔消费不会出现在 DSH 自己的 token 计量/UI 里**，只能靠 `getBalance` 对账
- `ctx.llm` **不做重试、不做限流、不做缓存**（一次 stream = 一次 provider attempt）→ 退避与并发全部由插件自己实现
- 停机清理走 `ctx.effect`；运行态用模块级单例（不必依赖 `@deepseek-ai/dsh-jobs`）

---

## 4. 控制算法：精确落在目标金额上

### 4.1 不超额的保证（结构性）

单请求的最坏花费：

```
worstCost = nIn·p_in + maxTokens·p_out        // 输入 token 数是我们自己填的，精确可控
```

只要每次下发前满足 `Σ(在途请求 worstCost) + spent ≤ target`，**超支在结构上不可能发生**（前提：价格表不低估）。
→ 价格表按当前时段取值后再乘一个保守系数（如 ×1.05）兜底。

### 4.2 主循环

```js
let spent = 0;
const tol = Math.max(0.01, target * 0.001);      // 默认容差：¥0.01 或 0.1%

while (target - spent > tol) {
  const remaining = target - spent;
  const p = priceAt(Date.now(), model);          // 按北京时间取高峰/空闲价

  if (remaining > laneSwitch) {                  // 大额 → 预填通道（快）
    const nIn    = Math.min(ctxLimit - outReserve,
                            Math.floor((remaining - headroom) / p.inMiss));
    const maxOut = smallOutput;                  // 预填通道只要很少输出
    nIn = Math.round(nIn / safetyFactor);        // 留 5% 余量
    launch({ filler: freshRandom(nIn), maxTokens: maxOut });
  } else {                                       // 尾款 → 解码通道（准，粒度细）
    const nIn    = smallPrompt;
    const maxOut = Math.floor((remaining - nIn * p.inMiss) / p.out);
    if (maxOut < 256) {                          // 连 256 都付不起 → 用小预填收尾
      launch({ filler: freshRandom(Math.floor(remaining / p.inMiss)), maxTokens: 16 });
    } else {
      launch({ filler: freshRandom(nIn), maxTokens: maxOut });
    }
  }
  // 读 usage chunk 精确记账
  spent += u.inputTokens * p.inMiss + (u.cacheReadTokens ?? 0) * p.hit
         + u.outputTokens * p.out  + (u.cacheWriteTokens ?? 0) * p.cw;
}
```

要点：

- **预算锁**：并发 worker 共享一个 mutex，"取额度 → 下发"必须原子，否则并发下会合计超支。
- **overshoot 不可能，undershoot 靠迭代收敛**：模型可能提前停止（`reason.kind === 'stop'`）导致实际输出 < maxTokens，下一轮按剩余额重算即可。因为每轮都按 `remaining` 定尺寸，序列几何收敛到 `tol`。
- **精度极限**：输入通道粒度 = `p_in` ≈ ¥2e-6/token（¥0.01 对应 5,000 tokens，很容易配准）；解码通道粒度 = `p_out` ≈ ¥8e-6/token。**实际误差来源是"填充文本的字符→token 比"估算偏差**（用 EWMA 从上几次的真实 `usage.inputTokens` 反推，偏差可压到 1~2%），残余再由 1~2 次微请求收尾。→ 落地目标 **|误差| ≤ ¥0.01~0.05**。
- **不要碰余额查询做主控**：`getBalance()` 走网络、默认 30s 超时、且可能滞后。它只用于**开始/结束对账**和低频展示。

### 4.3 通道选择阈值

`laneSwitch` 建议 = 一次预填请求的费用 × 4（flash 高峰约 ¥8，空闲约 ¥4）。低于它就没必要发起一次大预填。

---

## 5. 并发、限流与"多快"

- **并发上限**：官方 flash 2500 / v4-pro 500。默认取一个保守值（如 8~32），配置可调。
- **AIMD 自适应**：拿到 `RATE_LIMIT`（HTTP 429 / `rate_limit_error`，见 `dsh-llm-deepseek/lib/index.js:1752`）→ 并发减半 + 抖动退避；连续 N 次成功 → 并发 +1，上限 `maxConcurrency`。
- **其它错误码**：`QUOTA` / `ACCOUNT_QUOTA`（余额耗尽）→ 立即停机并报告；`SERVER`（5xx）→ 指数退避；`EMPTY_RESPONSE`（无内容）→ 换提示词重试（预填通道下输出很短，需确保有输出）；`CONTEXT_WINDOW_EXCEEDED` → 调小填充长度。
- **ETA 与速率面板**：`¥/min`、`tok/s`、在途并发、剩余时间。**时间是本方案的真正稀缺资源**，必须让用户先看到计划再花钱。

> **⚠️ 真机修正（2026-10-15，见 §13.1）：上面这条 AIMD 设计基于一个错误假设，实战中从未被触发。**
> 真机上 `rateLimited` **恒为 0** —— provider 的限流形式不是 429，而是「握住连接不回复」。
> 而 `dsh-llm-deepseek` 只在 `status === 429 || type === "rate_limit_error"` 时才判 `RATE_LIMIT`，
> 所以「遇限流并发减半」这段逻辑一次都没跑过。真正救场的是**单请求超时**（否则卡住的请求会永久
> 占住预算锁）。更关键的是：**饱和时提高并发完全无效** —— provider 每波只服务固定条数，
> 唯一有效的杠杆是「把单请求做大」（减少请求条数）。详见 README「四个真机踩过的坑」的坑 3。

### 5.1 启动前必须做的"校准探测"

价格表已知，但**吞吐常数（预填 tok/s、解码 tok/s）依赖真实环境**。所以 `dryRun` 之外还要有一个 probe：

1. 读 `B0 = getBalance()`（主余额 + Σ bonusWallets，见 §6）
2. 各跑 1 次最小请求（预填 1 次小规模 + 解码 1 次小额），记录实际耗时与 `usage`
3. 读 `B1`，用 `ΔB / 估算费用` 求一个标量修正因子（吸收价格表误差与赠送余额影响）
4. 输出计划：`需要 N 次请求、预计 M 分钟、C 并发`，写入 run 记录

> **⚠️ 实现时的改动：这个 probe 没有照原样做，理由是真机否掉了它的第 3 步。**
> 真机证明**余额差无法归因给插件单方** —— 同一个账户上跑这个插件的 agent 会话本身也在花钱，
> `ΔB` 里混着验证者的消耗（¥0.1 量级上噪声比被测量大一个数量级，见 README「余额对账为什么不可信」）。
> 改成了：**不做前置探测，改为从每次真实运行的结果里在线学习** `charsPerToken` /
> `prefillTokensPerSec` / `decodeTokensPerSec`，存进 `~/.dsh/token-burner/stats.json`，
> 供下次 `plan` 使用。代价是学习值是**跨时段平均**，对空闲档低估、对饱和档高估（已知限制）。

---

## 6. 对账（唯一的"钱"的来源）

`ctx.deepseekAccount.getBalance(client)` → `{ status: 'ready', value: Wallet[], bonusWallets: Wallet[] } | { status: 'failed' } | null`，其中 `Wallet = { currency: 'CNY'|'USD', balance: string }`

> **⚠️ 形状修正：本节初稿写的是扁平的 `{ currency, balance, bonusWallets }`，那是错的**（见 §13.1 坑 D）。
> **充值余额在 `value` 数组里，没有 `r.balance` 字段。** 按扁平形状解析会得到恒 0 —— 把「有钱」谎报成「没钱」。

- **可花费总额 = Σ`value[].balance` + Σ`bonusWallets[].balance`**（十进制字符串，别用浮点解析）
- **赠送余额优先扣减** → 余额可能先掉 bonus 再掉主余额，所以对账要比"合计"
- **`null`（未登录）与 `status: 'failed'`（查询失败）都不提供金额** → 必须区分"查询失败"和"没花钱"，**绝不退化成 0**
- 平台实现：`dsh-deepseek-account-platform/lib/index.js` → `getBalance(client) { return this.getDetail("balance", this.detailHeaders(client)); }`；`detailHeaders(client)` 只额外附加"客户端身份头"
- **实测确认：`client` 参数不可省略** —— 不传会抛 `Cannot read properties of undefined (reading 'version')`（见 §13.1 坑 C）
- 时机：开始前（B0）、结束/停机后（B1）、以及低频（如每 60s）展示用；超时可配 `balanceTimeoutMs`（默认 30000）
- **余额差只能当上界**：接口有结算延迟（实测数分钟），且同一账户上的其他用量会混进差额

---

## 7. 安全设计（这是会真花钱的工具）

| 机制 | 说明 |
| --- | --- |
| `dryRun` | 默认先出计划（需要多少次请求、多久、高峰/空闲价），**不发起任何调用** |
| 硬上限 | 插件 config 里的 `maxAmountCny`（如 10 元），工具参数超过直接拒绝；改上限要改配置 |
| 结构防超支 | §4.1 的 worst-case 守卫。**前提**：实际字符/token 比不低于 `charsPerToken × ratioFloor`（默认 3.2）。若填充文本的 token 密度远超预期，单次请求最多可能超出预留约 1/ratioFloor 倍 —— 这是唯一的已知超支窗口，且主循环会立即学习纠正 |
| 终止条件 | 达标 / `maxRequests` / `deadlineMs` / `QUOTA` / 用户 kill |
| Kill switch | `burn_stop` 工具 + UI 按钮 + 插件卸载时的 `ctx.effect` 清理 |
| 审计日志 | `~/.dsh/token-burner/runs/<runId>.jsonl`：每请求一行（时间、通道、inputTokens、cacheReadTokens、outputTokens、耗时、算得费用、stop reason、累计 spent）；run 索引支持崩溃后恢复且不重复计数 |
| 单例锁 | 同一时刻只允许一个 burn run，避免两个 run 各自"以为自己独占预算" |
| 二次确认 | `action="start"` 必须显式 `confirm=true`；Web 面板的「开始烧」需要先勾选风险确认 |
| 免责声明 | 工具描述、plan/start 的返回文本、README、本节 —— 四处都带风险提示，让 agent 和你都无法"不知道"这件事 |

---

## 8. UI（Client 半）

**v1（低风险，照抄 genshin 的已验证模式）**：`conversation.composer.dock` 面板，只做"控制面"——输入金额/通道/并发，点「开始」把一条指令注入 composer，由 agent 调 `burn_start`；另给一个「查看状态」按钮调 `burn_status`。
> 该模式的关键约束：client 半只能 `require('react')`，不能 require 任何 `@deepseek-ai/dsh-client-*`；不要自己抓远端数据。

**v2（可选，成本高）**：真正的实时进度条（`¥ spent / ¥ target`、¥/min、tok/s、并发、ETA、Stop 按钮）需要 host→client 通道。可行路径是仿照 `dsh-api-account-controller` 暴露一个 RPC 命名空间（走 `dsh-client-connection` 的 gateway），需要额外验证，不建议放进第一版。

---

## 9. 三种执行形态（同一个控制器，三种外壳）

| 形态 | 做法 | 适用 |
| --- | --- | --- |
| **A. 直连烧**（默认） | 插件直接 `ctx.llm.stream`，不进会话 | 真正要快速花掉指定金额 |
| **B. 会话烧** | 起 subagent / workflow，跑真实 agent 轮次 | 想顺带压测 compaction、计量、UI；**速度与精度都差很多** |
| **C. 空转** | 只调 `ctx.tokenMeter.measure()` / `estimateMessage()`，不发起任何模型调用 | 只测 UI/计量显示，**不产生真实消费**，别当成真花钱 |

---

## 10. 风险与坑（实现时必须处理）

1. **一笔消费在 DSH 里看不见**：直连流不写 session 事件，`ctx.tokenMeter` / 会话投影都不会统计它。
   对账只能靠自己 —— **主要是账本自校验**（账本 vs provider 返回的 `usage` vs 官方价格表），
   **余额差只能当上界**（有结算延迟，且同一账户上其他用量会混进来）。
2. **缓存未命中是速度前提**：忘了加随机 nonce，预填通道会退化成 ¥0.04/M —— 速度掉到 1/50。
3. **填充长度→token 数的换算有偏差**：随机文本的字符/token 比不稳定（CJK、十六进制、英文差异大）。必须用实测 `usage.inputTokens` 做 EWMA 回归，别硬编码 4 字符/token。
4. **接近 1M 上下文上限**：留 10% 余量，否则偶发 `CONTEXT_WINDOW_EXCEEDED`（该错误由 provider 侧返回，见 `dsh-llm-deepseek/lib/index.js:1753`）。
5. **节假日表**：高峰判定要排除中国法定节假日，静态内置一份年度表（或按"仅星期+时段"近似并留保守系数）。
6. **`ctx.llm` 无重试/无限流**：并发与退避全部自负；预填请求很重，别一上来就开到 2500。
7. **`maxTokens` 不受 `defaultMaxTokens` 限制**：`dsh-llm/lib/index.js:2170` 只在未指定时填入默认值（DeepSeek 适配器默认 256000），显式给值会被透传为 `max_tokens`（`:1706`）。官方输出上限 384K。
8. **`reasoningEffort` 必须与模型能力匹配**：`'off' | 'low' | 'high' | 'max'`，且 `thinking: disabled` 时只允许 `'off'`，显式值在任何 provider I/O 之前校验。思考模式产生的 reasoning token 按**输出**计费 → 解码通道可以靠抬高 effort 加速。
9. **`isConcurrencySafe`**：`burn_start` 应标 `false`，避免 agent 并发调用同一预算。

---

## 11. 实施清单

1. 复制 `genshin-analyzer` 骨架 → `token-burner/`，改名 `@local/token-burner`（`cordis.patch.yml` 的 row id 必须唯一、`name` 必须等于包名）
2. 先只实现 `burn_plan`（dry-run）+ `burn_status`，跑通注册链路，**不花钱**
3. 用一次最小请求验证：插件内 `ctx.llm.stream` 可用、能拿到 `usage` chunk
4. 接入 `getBalance()` 对账（顺带确认能否省略 `client` 参数）
5. 校准探测：实测预填/解码的真实 tok/s 与 ¥/s
6. 先跑 **¥0.10 端到端**，用余额差核对精度，再放开到目标金额
7. 加 `client.js` 面板
8. 用 `dsh plugin --profile desktop add /abs/path`（或编辑 `dsh.profile.bundles`）挂载；HMR 生效则无需重启

> **实际执行时的三条修正：**
> - 第 4 步的答案：**不能省略** `client`（抛 `reading 'version'`，见 §13.1 坑 C）。
> - 第 6 步：**¥0.1 量级的余额差核对没有意义** —— 被验证对象比验证工具的噪声小一个数量级。
>   真正可靠的是**账本自校验**（账本 vs token 数 vs 官方价格表），余额差在 ¥5 以上才勉强可用
>   （超出 3.3%）→ ¥10 时 1.21%。
> - 第 8 步：**HMR 只覆盖 profile 的 `cordis.patch.yml`，不覆盖插件源码**。改宿主插件源码
>   **必须重启应用**才能换模块代（`dsh-hmr` 的监听列表只有 profile patch 与 home patch 两个文件，
>   且 bundle patch 被闭包捕获、热重载永远读不到它的新内容）。改 `client.js` 则是另一条路径 ——
>   刷新页面即可。

---

## 12. 一句话总结

> 这不是一个"计费插件"，而是一个**带预算锁的并发 token 泵**：用**预填通道**把大额快速灌掉，用**小请求**把尾款收准，用**账本自校验**做主要对账（余额差只能当上界），用**硬上限 + dry-run** 防住真实扣费风险。DSH 只提供 `llm.stream` 和只读余额，其余全部要自己造。

**真机验证后的补充（一句话版）**：这个泵的**上限不取决于你的并发，而取决于 provider 当下饱不饱和** ——
同一份配置，空闲档 ¥25/分钟、饱和档 ¥0.16/分钟（159 倍）。所以真正的工程量花在了
「怎么知道自己被限流了」和「怎么不被误判为已经死了」上，而不是花在提高并发上。

---

## 13. 实现状态

插件已落地在 [`token-burner/`](./)，零依赖、纯 `node:` 内置模块：

| 文件 | 职责 |
| --- | --- |
| [token-burner/index.js](index.js) | Host 半：注册 `burn_tokens`（doctor/plan/start/status/stop/runs/reconcile），参数夹紧、金额上限、confirm 二次确认、余额预检、免责声明渲染 |
| [token-burner/lib/pricing.js](lib/pricing.js) | 官方价格表、高峰/空闲判定、逐 token 计价、下次档位切换推算 |
| [token-burner/lib/filler.js](lib/filler.js) | 本地随机语料生成（保证缓存未命中）+ 字符/token 比学习 |
| [token-burner/lib/ledger.js](lib/ledger.js) | JSONL 审计日志 + 跨运行经验常数 |
| [token-burner/lib/controller.js](lib/controller.js) | 预算锁、并发工作池、AIMD、单请求超时、停机时间闸门、记账、余额对账 |
| [token-burner/client.js](client.js) | Web 面板（`conversation.composer.dock`，五个按钮） |
| [token-burner/tools/smoke.mjs](tools/smoke.mjs) | 本地冒烟测试：假 LLM，**不联网不花钱**，54 组断言 |
| [token-burner/tools/verify-install.mjs](tools/verify-install.mjs) | 只读校验：profile 解析、插件判据、patch 结构、导出、client 约束 |
| [token-burner/README.md](README.md) | 用法 + 风险提示与免责声明 + 真机运行实录 |

本地冒烟测试（`DSH_HOME=$(mktemp -d) node tools/smoke.mjs`）验证的性质：

- `spent` 从未超过 `target`（结构性防超支）
- 收敛到容差带内（目标 ¥0.05 实测花掉 ¥0.0448，7 次请求）
- 每次请求的 prompt 前缀唯一 → 观测到 **0 个缓存读 token**（缓存未命中是速度前提）
- 字符/token 比从初值 4 向真值 5 收敛
- 余额合计 = 充值余额 + 赠送余额；查询失败被区分于「余额为 0」
- 超过硬上限被拒绝；缺少 `confirm=true` 被拒绝；`plan` 不产生运行
- 优雅停机生效且不会继续烧到目标
- **注册链路**：用 stub cordis ctx 调 `apply()`，验证注册出唯一工具、`parameters` 全带 description、
  `isConcurrencySafe=false`、工具描述内嵌风险提示、`output.render` 形状、`ctx.effect` 卸载清理
- **加载顺序回归**：stub ctx 用 `applyFinished` 标志模拟真实 cordis 时序，账户服务在 `apply()` 期间返回
  `undefined`、之后才可见 —— 锁死「不能在加载期捕获 `deepseekAccount`」这条约束
- **`getBalance(client)` 身份回归**：断言插件传给 `getBalance()` 的 client 是含
  `version`/`locale`/`timezoneOffsetSeconds` 的完整对象（漏传会炸在 `reading 'version'`）
- **doctor 渲染回归**：输出里禁止出现 `NaN` 与 `[object Object]`（`resolveModelInfo` 返回的是嵌套对象）

**已装到 Desktop profile**（`~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 各加一项，
并在 `node_modules/@local/` 建了 symlink），`verify-install.mjs` 全部通过。

**尚未做**：无。真实网络下的端到端验证已于 2026-10-15 在真实账户上完成（真钱，9 轮运行，合计 ¥20.692279），见下节。

### 13.1 真机验证结果（2026-10-15，真钱）

设计方案的核心判断全部被真机证实，但也暴露了三条设计时**没预料到**的事实。完整数据见
[token-burner/README.md](README.md) 的「¥5 真机运行实录」。

**最好的结果**（`burn-20261015-055544-q2h5`，目标 ¥10）：

```
¥9.994297 / ¥10（99.94%）· 23.82 秒 · 82 请求全部成功、零失败
有效速率 ¥25.17/分钟 ≈ ¥1510/小时 · 聚合预填 419,562 tok/s（≈52,445 tok/s/流）
```

设计文档第 0 节预测「¥100 约 3~5 分钟」—— 按实测 ¥25/分钟换算，¥100 约 4 分钟，**估算准确**。

**设计没预料到的三件事：**

1. **provider 的饱和度是时段性的，而它决定了唯一有效的杠杆是什么。**
   同一份配置，高峰档（11:35）跑 ¥5 要 30.7 分钟、120 请求里 81 个失败（¥0.158/分钟）；
   空闲档（13:55）跑 ¥10 只要 23.8 秒、82 个请求全成功（¥25.17/分钟）。
   **同一配置速率差 159 倍。** 饱和时唯一有效的杠杆是「把单请求做大」（减少请求条数），
   不饱和时并发本身就能打满 —— 所以策略必须**先探测再选**，不能写死。
2. **限流不表现为 429，而是「握住连接不回复」。** 全程 `rateLimited` 恒为 0 ——
   一个 429 都没收到，而 `dsh-llm-deepseek` 只在 429 时判 `RATE_LIMIT`，
   于是设计时计划的「遇限流并发减半+退避」从未被触发。真正需要的是**单请求超时**
   （否则卡住的请求会永久占住预算锁，把整轮拖死）。
3. **停机判据必须是「连续失败 **且** 卡住太久」，纯计数必然误杀。** 请求是成波下发的，
   provider 一个「坏时刻」同时打掉整波在途请求 —— 8 个并发失败在计数上就是「连续 8 次失败」。
   真机上一轮 ¥5 因此在 15 秒内被判死。修法是加 `stallTimeoutMs` 时间闸门。

另外两个**实现期**发现（设计阶段就识别对了方向，但细节是踩出来的）：

**坑 A —— 容差吃掉了全部请求。** `toleranceCny` 默认 `max(0.01, target×0.001)`，当 `target ≤ 0.01` 时「剩余 ≤ 容差」在第一次循环就成立 → **一次请求都不发**，工具静默什么都不做。
已修：`tolerance` 强制夹到 `target / 2` 以内。冒烟测试第 9b 项专门守住这条。

**坑 B —— 加载期拿不到账户服务。** 第一版在 `apply()` 里 `ctx.get('deepseekAccount')` 并捕获，结果加载留痕里
`hasAccountAtLoad: false`。根因不是配置错误也不是缺包：`@deepseek-ai/dsh-deepseek-account-platform` 的
`PlatformAccount` 声明了 `static inject = ["credentials", "authorization"]`，cordis 会**推迟**它的 apply；
而本插件只 inject `tools`/`llm`，必然先加载完成。
→ 修法是**惰性解析**（每次用时 `ctx.get`，绝不缓存），而不是把 `deepseekAccount` 写进 `inject` ——
后者会让插件在服务缺席时根本不加载，整个工具凭空消失。实测：加载期 `false`、运行期 `✅ 可用`。

**坑 C —— `getBalance()` 需要一个客户端身份参数。** 无参调用会抛
`Cannot read properties of undefined (reading 'version')`。它的字段经 `platformClientHeaders()`
（`dsh-deepseek-account/lib/types/index.js:43`）直接变成 `x-client-version` / `x-client-locale` /
`x-client-timezone-offset` 三个 HTTP 头；平时由 Web UI 经 RPC 传入，Host 侧插件必须自己合成
`{ version, locale, timezoneOffsetSeconds }`（类型见 `dsh-api-account-controller/lib/typert.host.js:12`）。
本插件的合成规则见 README「`getBalance(client)` 的客户端身份」一节，三项都可在 `cordis.patch.yml` 覆盖。

**坑 D —— 余额结果的形状猜错过一次，把「有钱」谎报成「没钱」。** 权威形状是
`{ status: 'ready', value: Wallet[], bonusWallets: Wallet[] }`（充值余额在 **`value`** 数组里，
**没有** `r.balance` 字段），不是扁平的 `{ currency, balance }`。第一版按后者解析 → 恒为 0。
更糟的是 `status: 'failed'` 也会被算成 0，而账户接口明确要求「查询失败不提供金额」。
已修：`null` / `status !== 'ready'` 一律返回 error，**绝不退化成 0**。
冒烟测试 `[7b]` 专门用一个「旧扁平形状」的假数据守住这条 —— 旧的假数据正好把真 bug 一起掩盖了。


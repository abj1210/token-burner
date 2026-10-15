/**
 * index.js — DSH Host 半：注册 burn_tokens 工具。
 *
 * 设计约束（来自 asar 内 @deepseek-ai/dsh-tools 源码与本机已验证的 @local/genshin-analyzer 样板）：
 *  - 本包必须零依赖：@deepseek-ai/* 在工作区包里解析不到，所以不 import defineTool，
 *    直接把「已经编译好的」工具定义对象交给 ctx.tools.register()。
 *  - register() 只校验 output.{schema,render} 与 timeoutMs；parameters 必须是 JSON Schema 子集
 *    （type/oneOf/properties/required/additionalProperties/items/enum/const + description 等注解），
 *    且参数校验由我们自己做（raw register 不做 args 校验）。
 *  - 所有资源用 ctx.tools.register() 注册，它内部走 ctx.effect，卸载时自动注销。
 *
 * ⚠️ 这个工具会**真实扣费**。因此：
 *  - 默认硬上限 maxAmountCny = 1 元（想烧更多必须改 cordis.patch.yml）
 *  - action=start 必须显式 confirm=true
 *  - action=plan 永远不花钱，建议先 plan
 */

import fs from 'node:fs'
import { listRuns, readRun, appendLoadMarker, readLoadMarkers, rootDir, runsDir, isValidRunId } from './lib/ledger.js'
import { priceFor, canonicalModel, nextTierChange } from './lib/pricing.js'
import { Burner, DEFAULTS, resolveConfig, makePlan } from './lib/controller.js'

export const name = 'token-burner'
export const inject = ['tools', 'llm']

const TOOL_NAME = 'burn_tokens'

const DISCLAIMER_SOURCE = [
  '⚠️ 风险提示与免责声明',
  '1. 本工具会**真实调用 DeepSeek 模型并真实扣费**，费用直接从你的账户余额扣减（充值余额与赠送余额同时存在时优先扣赠送余额），**不可撤销、不可退款**。',
  // 第 2 条必须带上**当前生效的**硬上限。写死「1 元」在改过 maxAmountCny 之后
  // 会与 doctor 第 5 节自相矛盾 —— 那正是最容易被误信的一种谎话。
  '2. 本插件当前生效的硬上限为 **¥%CAP%**（出厂默认 ¥%DEFAULT_CAP%，配置项是 cordis.patch.yml 里的 maxAmountCny）；提高上限必须自行改该文件并重启应用。作者与 DSH 不对任何资金损失负责。',
  '3. 内置价格表来自 DeepSeek 官方公开价格页，可能随时变动；高峰/空闲时段与法定节假日判定是近似实现，可能与实际账单存在偏差。',
  '4. 记账基于 API 返回的 usage 字段估算，**唯一权威是 DeepSeek 官方账单**；插件不保证与实际扣费完全一致。',
  '5. 高频并发请求可能触发限流或风控，后果自负；请遵守 DeepSeek 服务条款，不要用于刷单、套利、绕过配额或任何滥用行为。',
  '6. 强烈建议先用独立测试账户和极小金额（如 0.1 元）验证，确认无误后再放开金额。',
].join('\n')

/** 出厂默认硬上限（与 cordis.patch.yml 无关），仅用于免责声明里的对照。 */
const DEFAULT_MAX_AMOUNT_CNY = 1

/**
 * 渲染免责声明。
 * @param {number | null} [capCny] **当前生效**的硬上限；缺省时退回出厂默认值。
 *   一定要传当前值 —— 声明的额度与实际执行的额度必须是同一个数字。
 * @returns {string} Markdown 免责声明。
 */
function disclaimer(capCny = null) {
  const cap = Number.isFinite(capCny) ? capCny : DEFAULT_MAX_AMOUNT_CNY
  // 自带一个短格式，不依赖后面才定义的 `fmt`（`const` 有暂时性死区，模块顶层会直接抛）。
  const short = (n) => (Number.isFinite(n) ? String(Number(n.toFixed(4))) : '∞')
  return DISCLAIMER_SOURCE.replace('%CAP%', short(cap)).replace('%DEFAULT_CAP%', short(DEFAULT_MAX_AMOUNT_CNY))
}

/** 出厂默认下的免责声明（保留旧名字，避免破坏既有调用点与导出）。 */
const DISCLAIMER = disclaimer()

const DESCRIPTION = [
  '按指定金额（人民币元）快速消耗 token —— 一个**会真实花钱**的压测/烧钱工具。',
  '',
  '⚠️ 重要：这个工具会真实调用 DeepSeek 模型并真实扣费，费用不可撤销。',
  '   - action="doctor" 零成本预检：不发模型调用、不花钱，但会验证服务是否就绪、provider/model 路由是否存在、',
  '     余额能否读到（唯一的权威对账手段）、记账目录能否写。**任何一次会话想烧钱之前，先跑 doctor**。',
  '   - action="plan" 永远不花钱，只出计划；不确定时先 plan。',
  '   - action="start" 必须显式传 confirm=true 才会真正开始扣费。',
  '   - 默认硬上限 1 元；超过上限会被拒绝（上限来自插件配置 maxAmountCny）。',
  '   - 只有用户**明确要求**烧钱时才能调用 start；不要自行决定花钱。',
  '',
  '原理（为什么能"快速"）：',
  '   - 烧钱有两条通道。输入「缓存未命中」单价低但**预填吞吐极高**（每秒可吞数千 token），',
  '     输出单价高但被生成速度卡死在每秒几十 token。按秒计的烧钱效率，输入通道高约 100 倍。',
  '   - 因此默认 lane="input"：每次请求用本地生成的**全新随机语料**灌满输入（随机 nonce 在最前面，',
  '     确保前缀缓存必然未命中 —— 缓存命中价便宜 50 倍，一旦复用会让烧钱速度掉 1.5~2 个数量级）。',
  '   - 金额靠「预算锁」保证不超支：单次请求按悲观 token 数预留额度，spent + reserved ≤ 目标恒成立；',
  '     不足的部分由主循环按剩余金额重算尺寸迭代补齐。',
  '',
  'action 取值：',
  '   doctor — 零成本预检：服务、LLM 路由（resolveModelInfo，不发 provider I/O）、余额、计价档位、配置、记账目录。不花钱。',
  '   plan   — 只出计划：当前单价档位、需要多少 token、多少次请求、预计耗时、另一条通道的对照。不花钱。',
  '   start  — 开始烧（需 confirm=true + amountCny）。立即返回，请求在后台并发跑，用 status 查进度。',
  '   status — 查看当前/最近一次运行的进度、已花金额、速率、ETA、余额对账。',
  '   stop   — 优雅停机：停止下发新请求，宽限期后中止在途请求。',
  '   runs   — 列出本机的运行记录（审计日志在 ~/.dsh/token-burner/runs/*.jsonl）。',
  '   reconcile — 复读余额与最近一次运行对账。**余额接口有结算延迟**（实测跑完 9 秒复读一个数都没动），',
  '               所以运行快照里的「after 括号」对短运行不可信，等几分钟再用这个动作查。',
  '',
  '注意：烧钱请求直连 ctx.llm.stream，**不写 session 事件**，所以这笔消费不会出现在 DSH 自己的',
  'token 计量/UI 里。对账只能靠 DeepSeek 账户余额差，而且那个差额天然是**脏**的：同一账户上',
  '**任何**其他用量都会被算进去，包括正在跑这个插件的 agent 会话自己 —— 只能当上界用。',
].join('\n')

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['doctor', 'plan', 'start', 'status', 'stop', 'runs', 'reconcile'],
      description:
        'doctor=零成本预检（不发模型调用、不花钱，检查服务/路由/余额/记账是否就绪，**建议每次会话先跑**）；plan=只出计划不花钱；start=真正开始烧钱；status=查进度；stop=停机；runs=列历史记录；reconcile=复读余额与最近一次运行对账（余额接口有结算延迟，跑完等几分钟再查）。',
    },
    runId: {
      type: 'string',
      description: '仅 reconcile 用：要跟哪一次运行对账（默认最近一次）。',
    },
    amountCny: {
      type: 'number',
      description: '目标金额，人民币元。例如 0.1 表示烧掉一毛钱。start 必填，plan 可选（默认 0.1）。',
    },
    confirm: {
      type: 'boolean',
      description: 'start 必须显式传 true 才会真正开始扣费；不传或传 false 会返回计划并拒绝执行。',
    },
    model: {
      type: 'string',
      description: '模型 id，例如 deepseek-flash（默认取当前 agent 的默认模型）、deepseek-v4-pro。',
    },
    lane: {
      type: 'string',
      enum: ['input', 'output'],
      description: '烧钱通道。input=烧输入缓存未命中（默认，快 ~100 倍）；output=烧输出 token（准，很慢）。',
    },
    maxConcurrency: {
      type: 'integer',
      description: '并发请求数，默认 8。官方并发限制 flash 2500 / v4-pro 500，但请从保守值开始。',
    },
    requestCostCny: {
      type: 'number',
      description: '单次请求预算（元），默认 0.2。越小越精细但请求数越多。',
    },
    toleranceCny: {
      type: 'number',
      description: '容差（元）。默认 max(0.01, 目标金额*0.001)。停止条件：剩余 ≤ 容差。',
    },
    deadlineSeconds: {
      type: 'integer',
      description: '墙钟上限（秒），0 表示不限。墙钟时间通常是本方案真正的瓶颈。',
    },
    maxRequests: {
      type: 'integer',
      description: '最大请求数，0 表示不限。作为额外的安全阀。',
    },
    waitSeconds: {
      type: 'integer',
      description:
        'start 后等待多少秒再返回（默认 0，立即返回）。**强烈建议保持 0** —— 宿主对工具调用有 120 秒硬上限，' +
        '等待一旦超过它，整轮运行会被当成「调用被取消」而中止（真机踩过：¥5 只烧了 ¥0.11 就被打断）。' +
        '上限被夹到 100 秒，但这只对「几秒内就该跑完」的小额运行有用；金额大就轮询 action="status"。',
    },
  },
  required: ['action'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    text: { type: 'string', description: '给模型阅读的中文 Markdown 正文。' },
  },
  required: ['text'],
}

const fmt = (n, d = 6) => (Number.isFinite(n) ? n.toFixed(d) : '∞')
const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '∞')
const fmtDur = (s) => {
  if (!Number.isFinite(s)) return '∞'
  if (s < 60) return `${s.toFixed(0)} 秒`
  if (s < 3600) return `${(s / 60).toFixed(1)} 分钟`
  return `${(s / 3600).toFixed(2)} 小时`
}

function renderPlan(p, ctxInfo) {
  const L = []
  L.push(`## 烧钱计划（**未执行，未产生任何费用**）`)
  L.push('')
  L.push(`- 目标金额：**¥${fmt(p.targetCny)}**`)
  L.push(`- 模型：\`${p.model}\`${ctxInfo?.known === false ? ' ⚠️ 不在内置价格表，按最贵档位保守估算' : ''}`)
  L.push(`- 当前时段：**${p.price.peak ? '高峰（单价 2×）' : '空闲（单价减半）'}**`)
  L.push(
    `- 单价：缓存未命中 ¥${p.price.unitCnyPerMTok.inMiss}/M、缓存命中 ¥${p.price.unitCnyPerMTok.hit}/M、输出 ¥${p.price.unitCnyPerMTok.out}/M`,
  )
  L.push(`- 通道：\`${p.lane}\`（input = 烧缓存未命中输入，快；output = 烧输出，准但慢）`)
  L.push('')
  L.push(`### 预计规模`)
  L.push(`- 需要 token：约 **${fmtInt(p.tokensNeeded)}**`)
  L.push(`- 单请求：约 ${fmtInt(p.perRequestTokens)} token ≈ ¥${fmt(p.perRequestCostCny, 4)}`)
  L.push(`- 请求数：约 **${fmtInt(p.requests)}** 次，实际并发 **${p.effectiveConcurrency ?? p.concurrency}**（上限 ${p.concurrency}）`)
  if (p.effectiveConcurrency !== undefined && p.effectiveConcurrency < p.concurrency) {
    L.push(
      `  - ⚠️ 实际并发被**预算锁**压到 ${p.effectiveConcurrency}：每轮只预留 \`min(剩余, requestCostCny)\`，` +
        `¥${fmt(p.targetCny)} ÷ ¥${fmt(p.config?.requestCostCny ?? 0)} 只够 ${p.effectiveConcurrency} 个请求同时在途；` +
        `想要更高并发就调小 \`requestCostCny\`。`,
    )
  }
  L.push(
    `- 预计实扣：**¥${fmt(p.expectedTotalCny, 4)}**（目标 ¥${fmt(p.targetCny, 4)}，容差 ¥${fmt(p.toleranceCny, 4)}；` +
      `预算锁保证不会超过目标）`,
  )
  L.push(`- 预计耗时：**${fmtDur(p.wallSeconds)}**（按历史吞吐 ${fmtInt(p.assumedTokensPerSec)} tok/s/流）`)
  L.push('')
  L.push(`### 另一条通道的对照`)
  L.push(
    `- \`${p.otherLane.lane}\` 通道：需要 ${fmtInt(p.otherLane.tokensNeeded)} token，预计 **${fmtDur(p.otherLane.wallSeconds)}**`,
  )
  L.push(`  （这个差距就是"为什么默认烧输入"的答案）`)
  L.push('')
  if (p.warnings.length) {
    L.push('### 提示')
    for (const w of p.warnings) L.push(`- ${w}`)
    L.push('')
  }
  L.push(`### 经验常数来源`)
  L.push(
    `- 字符/token ≈ ${p.source.charsPerToken.toFixed(2)}；预填 ${fmtInt(p.source.prefillTokensPerSec)} tok/s；解码 ${fmtInt(p.source.decodeTokensPerSec)} tok/s；样本数 ${p.source.samples}`,
  )
  L.push('  （这些值会随每次运行自动学习更新，第一次的耗时估计偏差可能很大）')
  return L.join('\n')
}

function renderStatus(s) {
  if (!s) return '当前没有运行记录。用 `action="plan"` 先出一份计划。'
  const L = []
  const badge = { running: '🟢 运行中', stopping: '🟡 正在停机', done: '✅ 已结束', stopped: '⏹ 已停机', error: '❌ 出错', planned: '📋 仅计划' }
  L.push(`## burn 运行 \`${s.runId}\``)
  L.push('')
  L.push(`- 状态：**${badge[s.state] ?? s.state}**${s.result ? `（${s.result}）` : ''}`)
  L.push(
    `- 进度：**¥${fmt(s.spentCny)} / ¥${fmt(s.targetCny)}**（${(s.progress * 100).toFixed(2)}%，容差 ¥${fmt(s.toleranceCny)}）`,
  )
  L.push(`- 剩余：¥${fmt(s.remainingCny)}`)
  L.push(`- 模型/通道：\`${s.model}\` / \`${s.lane}\`（${s.priceTier === 'peak' ? '高峰价' : '空闲价'}）`)
  L.push(`- 并发：${s.concurrency.inflight} 在途 / 上限 ${s.concurrency.limit}`)
  L.push(`- 速率：**¥${fmt(s.cnyPerMinute, 4)}/分钟**${s.etaSeconds ? `，ETA ≈ ${fmtDur(s.etaSeconds)}` : ''}`)
  L.push(`- 已耗时：${fmtDur(s.elapsedMs / 1000)}`)
  L.push(
    `- token：输入 ${fmtInt(s.tokens.input)}（缓存读 ${fmtInt(s.tokens.cacheRead)}）+ 输出 ${fmtInt(s.tokens.output)}`,
  )
  L.push(
    `- 请求：共 ${s.requests.total}（成功 ${s.requests.ok} / 失败 ${s.requests.failed} / 限流 ${s.requests.rateLimited}）`,
  )
  if (s.balance?.before || s.balance?.after) {
    L.push('')
    L.push('### 余额对账（唯一权威）')
    if (s.balance.before) L.push(`- 开始前：${s.balance.before.currency} ${fmt(s.balance.before.total, 4)}`)
    if (s.balance.after) L.push(`- 结束后：${s.balance.after.currency} ${fmt(s.balance.after.total, 4)}`)
    if (s.balance.deltaCny !== null) L.push(`- 实际扣费：**¥${fmt(s.balance.deltaCny)}**（估算 ¥${fmt(s.spentCny)}）`)
    if (s.balance.driftCny !== null) L.push(`- 估算偏差：¥${fmt(s.balance.driftCny)}`)
    if (s.balance.before?.error || s.balance.after?.error)
      L.push(`- ⚠️ 余额查询失败：${s.balance.before?.error ?? s.balance.after?.error}`)
  } else {
    L.push('')
    L.push('_余额对账不可用：账户服务未挂载或查询失败 —— 上面的金额只是基于 usage 的估算。_')
  }
  if (s.stopReason) L.push(`- 停机原因：\`${s.stopReason}\``)
  if (s.lastError) L.push(`- 最近错误：\`${s.lastError.code}\` ${s.lastError.message}`)
  if (s.warnings?.length) {
    L.push('')
    L.push('### 运行期提示')
    for (const w of s.warnings.slice(-8)) L.push(`- ${w}`)
  }
  return L.join('\n')
}

function clampNum(v, fallback, min, max) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 工具主逻辑（与注册分离，便于单测/复用）。 */
async function runTool(args = {}, deps = {}) {
  const { burner, logger, defaultSelection, getAccount } = deps
  const action = typeof args.action === 'string' ? args.action : 'plan'

  // ── doctor：零成本预检 ────────────────────────────────────────────────────
  // 不发任何模型调用、不花一分钱，但能验证真正花钱前必须成立的一切：
  // 服务是否就绪、provider/model 路由是否存在（resolveModelInfo 只读本地能力表）、
  // 余额能否读到（这是唯一的权威对账手段）、记账目录能否写、当前计价档位。
  if (action === 'doctor') {
    const OK = '✅'
    const NG = '❌'
    const WARN = '⚠️'
    const lines = ['## 预检（doctor）—— 零成本，未发起任何模型调用、未扣费', '']
    const problems = []
    const rawCfg = deps.config ?? {}

    // 1) 服务
    lines.push('### 1. 服务')
    const llmOk = Boolean(burner?.llm && typeof burner.llm.stream === 'function')
    lines.push(`- \`ctx.llm\`：${llmOk ? `${OK} 可用` : `${NG} 缺失 —— 工具无法工作`}`)
    if (!llmOk) problems.push('ctx.llm 缺失')

    const acct = typeof getAccount === 'function' ? getAccount() : burner?.accountService?.() ?? null
    lines.push(
      `- \`deepseekAccount\`：${acct ? `${OK} 可用（运行期已就绪）` : `${WARN} 运行期仍不可见`}`,
    )
    if (!acct) {
      lines.push(
        '  - 原因：`PlatformAccount` 声明了 `static inject = ["credentials","authorization"]`，其 apply 被 cordis 推迟；',
      )
      lines.push(
        '    本插件加载期必然看不到它（这是预期行为）。若**运行期**仍看不到，说明账户服务确实没挂上。',
      )
      lines.push('  - 后果：余额对账不可用，本工具报告的金额将只是基于 usage 的估算值，无法用余额交叉验证。')
      problems.push('余额对账不可用')
    } else if (typeof acct.getBalance !== 'function') {
      lines.push(`  - ${NG} 服务存在但没有 \`getBalance()\`，无法对账`)
      problems.push('deepseekAccount.getBalance 缺失')
    }

    // 2) LLM 路由（零成本：只读注册表，不发 provider I/O）
    lines.push('')
    lines.push('### 2. LLM 路由')
    const provider = typeof args.provider === 'string' && args.provider ? args.provider : defaultSelection?.provider ?? 'deepseek-account'
    const model = canonicalModel(
      typeof args.model === 'string' && args.model ? args.model : defaultSelection?.model ?? 'deepseek-flash',
    )
    lines.push(`- 目标路由：\`${provider}\` / \`${model}\``)
    lines.push(`- \`agentDefaultModel.currentSelection()\`：${defaultSelection ? `\`${defaultSelection.provider}/${defaultSelection.model}${defaultSelection.reasoningEffort ? ' @' + defaultSelection.reasoningEffort : ''}\`` : '（不可用，将使用上面的默认值）'}`)
    try {
      const providers = burner.llm.listProviders?.() ?? []
      const ids = providers.map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean)
      lines.push(`- 已注册 provider（${ids.length}）：${ids.length ? ids.map((x) => `\`${x}\``).join('、') : '_空_'}`)
      if (ids.length && !ids.includes(provider)) {
        lines.push(`  - ${NG} 目标 provider \`${provider}\` **不在**已注册列表里 —— 一定会以 \`NO_ADAPTER\` 失败。`)
        problems.push(`provider ${provider} 未注册`)
      }
    } catch (e) {
      lines.push(`- ${WARN} listProviders() 调用失败：${e?.message ?? e}`)
    }
    try {
      const info = await burner.llm.resolveModelInfo?.(provider, model)
      if (info) {
        lines.push(`- ${OK} \`resolveModelInfo\` 成功 —— provider/model 路由有效`)
        lines.push(
          `  - 模型：\`${info.id ?? model}\`${info.name ? `（${info.name}）` : ''}` +
            `${info.provider ? ` · provider \`${info.provider}\`` : ''}`,
        )
        // 真实形状（dsh-llm/lib/typert.host.js）：
        //   LlmResolvedModelInfo { ...LlmModelInfo, context?: { contextWindow },
        //                          defaultMaxTokens?, reasoning?: { efforts: [{id,…}], defaultEffort? } }
        // 注意 context 是**对象**不是数字 —— 以前写成 info.contextWindow ?? info.context 得到的是对象，
        // 渲染出来就是 "NaN tokens"。别再改回去。
        const ctxWin = info.context?.contextWindow ?? (Number.isFinite(info.contextWindow) ? info.contextWindow : null)
        const defMax = info.defaultMaxTokens ?? null
        const efforts = info.reasoning?.efforts ?? null
        if (ctxWin) lines.push(`  - contextWindow：**${Number(ctxWin).toLocaleString('en-US')}** tokens`)
        if (defMax) lines.push(`  - 默认输出上限：${Number(defMax).toLocaleString('en-US')}`)
        if (Array.isArray(efforts)) {
          const names = efforts.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean)
          lines.push(
            `  - 支持的 reasoningEffort：${names.map((x) => `\`${x}\``).join('、') || '（未报告）'}` +
              (info.reasoning?.defaultEffort ? ` · 默认 \`${info.reasoning.defaultEffort}\`` : ''),
          )
        }
        if (Array.isArray(info.inputModalities) && info.inputModalities.length) {
          lines.push(`  - 输入模态：${info.inputModalities.map((x) => `\`${x}\``).join('、')}`)
        }
        const cfg = resolveConfig(rawCfg, 1)
        if (ctxWin && cfg.maxInputTokens >= Number(ctxWin)) {
          lines.push(
            `  - ${NG} 配置的 maxInputTokens=${cfg.maxInputTokens} ≥ contextWindow，必然 \`CONTEXT_WINDOW_EXCEEDED\`。请调小。`,
          )
          problems.push('maxInputTokens 超出上下文窗口')
        } else if (ctxWin) {
          lines.push(`  - ${OK} 配置的 maxInputTokens=${cfg.maxInputTokens} < contextWindow，安全`)
        } else {
          lines.push(`  - ${WARN} 适配器没有报告 contextWindow，跳过窗口校验`)
        }
      } else {
        lines.push(`- ${WARN} resolveModelInfo 返回空（方法可能不存在），跳过路由校验`)
      }
    } catch (e) {
      lines.push(`- ${NG} \`resolveModelInfo\` 失败：${e?.message ?? e}`)
      lines.push('  → 这通常意味着 provider/model 组合无效，花钱前必须解决。')
      problems.push(`resolveModelInfo 失败：${e?.message ?? e}`)
    }

    // 3) 账户余额（零成本：只读网络）
    lines.push('')
    lines.push('### 3. 账户余额（唯一权威对账手段）')
    if (!acct) {
      lines.push(`- ${WARN} 跳过：账户服务不可见`)
    } else {
      try {
        const id = burner.clientIdentity?.()
        if (id) {
          lines.push(
            `- 客户端身份（\`getBalance(client)\` 必需，它决定 x-client-version/locale/timezone-offset 头）：` +
              `version=\`${id.version}\` locale=\`${id.locale}\` tz=\`${id.timezoneOffsetSeconds}\``,
          )
        }
        const bal = await burner.balance()
        if (bal && bal.error) {
          lines.push(`- ${NG} 读取失败：${bal.error}`)
          if (/version|locale|timezone|undefined/i.test(String(bal.error))) {
            lines.push(
              '  → 这类报错说明 `getBalance()` 缺少**客户端身份**参数。' +
                '它是 `{ version, locale, timezoneOffsetSeconds }`（`dsh-api-account-controller/lib/typert.host.js:12`），' +
                '平时由 UI 经 RPC 传入。可在 cordis.patch.yml 里用 `clientVersion` / `clientLocale` / `timezoneOffsetSeconds` 覆盖。',
            )
          }
          problems.push(`余额读取失败：${bal.error}`)
        } else if (bal) {
          const parts = [`${bal.currency ?? 'CNY'} ${Number(bal.total).toFixed(4)}`]
          parts.push(`（充值钱包 ${Number(bal.balance ?? 0).toFixed(4)}`)
          if (Array.isArray(bal.bonusWallets) && bal.bonusWallets.length) {
            parts.push(
              ` + 赠送 ${bal.bonusWallets.map((b) => `${b.currency} ${Number(b.balance).toFixed(4)}`).join('、')}`,
            )
          }
          parts.push('）')
          lines.push(`- ${OK} 当前总余额：**${parts.join('')}**`)
          lines.push(
            `  - 钱包明细：充值 ${bal.wallets?.length ?? 0} 个` +
              `／赠送 ${bal.bonusWallets?.length ?? 0} 个（接口原样返回的数组，已按币种求和）。`,
          )
          lines.push('  - 扣费优先扣减赠送余额：对账时把两个钱包加总才是实际可烧额度。')
          if (!(bal.total > 0)) {
            lines.push(`  - ${NG} **总余额为 0**：\`start\` 会立刻因 \`ACCOUNT_QUOTA\`（账户余额不足）失败，请先充值。`)
            problems.push('账户总余额为 ¥0.0000（两个钱包都为空），无法进行真钱验证')
          }
        } else {
          lines.push(`- ${WARN} getBalance() 返回空`)
        }
      } catch (e) {
        lines.push(`- ${NG} getBalance() 抛错：${e?.message ?? e}`)
        problems.push(`getBalance 抛错：${e?.message ?? e}`)
      }
    }

    // 4) 计价档位
    lines.push('')
    lines.push('### 4. 计价档位')
    const cfg = resolveConfig(rawCfg, 1)
    const price = priceFor(model, { holidays: cfg.holidays })
    lines.push(
      `- ${price.peak ? '**高峰时段**（单价 ×2）' : '**空闲时段**（单价 ×0.5）'} — ${price.known ? '内置价格表命中' : `${WARN} 价格表未命中，回退到最贵档位（保守）`}`,
    )
    lines.push(
      `- 单价（元/百万 token）：缓存未命中 ${price.inMiss} · 缓存命中 ${price.hit} · 输出 ${price.out}`,
    )
    const nxt = nextTierChange(new Date(), cfg.holidays)
    if (nxt?.at) {
      const mins = Math.max(0, Math.round((nxt.at.getTime() - Date.now()) / 60000))
      const hhmm = new Date(nxt.at.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16)
      lines.push(
        `- 下次档位切换：约 ${mins} 分钟后（北京时间 ${hhmm}）→ 变为${nxt.becomesPeak ? '高峰（更贵、烧得更快）' : '空闲（更便宜、需要更多 token）'}`,
      )
    }

    // 5) 生效配置
    lines.push('')
    lines.push('### 5. 生效配置（来自 cordis.patch.yml，已按上限夹紧）')
    lines.push(`- 硬上限 \`maxAmountCny\`：**¥${cfg.maxAmountCny}**`)
    lines.push(`- 通道 \`lane\`：\`${cfg.lane}\` · 并发 \`maxConcurrency\`：${cfg.maxConcurrency}`)
    lines.push(`- 输入上限 \`maxInputTokens\`：${cfg.maxInputTokens.toLocaleString('en-US')} · 输出 \`outputTokens\`：${cfg.outputTokens}`)
    lines.push(`- 单请求预留 \`requestCostCny\`：¥${cfg.requestCostCny} · 容差 \`toleranceCny\`：¥${cfg.toleranceCny}`)
    lines.push(`- 安全系数 \`safetyFactor\`：${cfg.safetyFactor} · 比值下限 \`ratioFloor\`：${cfg.ratioFloor}（两者共同决定「低估多少」）`)
    lines.push(
      `- 单请求超时 \`requestTimeoutMs\`：${cfg.requestTimeoutMs > 0 ? `${Math.round(cfg.requestTimeoutMs / 1000)} 秒` : '**不限**'} · ` +
        `停机宽限 \`gracefulStopMs\`：${Math.round(cfg.gracefulStopMs / 1000)} 秒 · 最大连续失败 \`maxConsecutiveFailures\`：${cfg.maxConsecutiveFailures}`,
    )
    lines.push(
      `- 停机时间闸门 \`stallTimeoutMs\`：${Math.round(cfg.stallTimeoutMs / 1000)} 秒` +
        `（连续失败 ${Math.max(cfg.maxConsecutiveFailures, Math.min(cfg.maxConcurrency, 256))} 次**且**这么久没成功才停机；` +
        `失败不计费，所以宽容只花墙钟）`,
    )
    lines.push(
      `- 无 usage 限次 \`maxUnaccountedResponses\`：${cfg.maxUnaccountedResponses} 次` +
        `（成功返回但**没有 usage** 的请求在预算锁眼里是免费的，可它很可能真被计费了；` +
        `连续这么多次就停机 —— 否则会一直发到 deadline，那段时间的花费全是账外的）`,
    )
    // 预算锁会压低实际并发 —— 这个数字直接决定墙钟时间，预检里必须点出来。
    const concAtCeiling = Math.max(
      1,
      Math.min(cfg.maxConcurrency, Math.floor(cfg.maxAmountCny / cfg.requestCostCny) || 1),
    )
    if (concAtCeiling < cfg.maxConcurrency) {
      lines.push(
        `  - ⚠️ **实际并发会被预算锁压低**：\`clamp(floor(目标金额 / requestCostCny), 1, maxConcurrency)\` —— ` +
          `按硬上限 ¥${cfg.maxAmountCny} 算**只到得了 ${concAtCeiling}**（上限是 ${cfg.maxConcurrency}），目标越小并发越低` +
          `（¥0.1 那种就只剩 1）。想要真并发就调小 \`requestCostCny\`。`,
      )
    } else {
      // 满额目标下不再被压低 —— 这时再喊「会被压低」就是噪声，反而让人忽略真正被压的小目标场景。
      lines.push(
        `  - ✅ 预算锁不会压低满额并发：硬上限 ¥${cfg.maxAmountCny} ÷ 单请求预留 ¥${cfg.requestCostCny} = ` +
          `${Math.floor(cfg.maxAmountCny / cfg.requestCostCny)} ≥ 并发上限 ${cfg.maxConcurrency}。` +
          `但**小目标仍会被压**（¥0.1 → 1、¥1 → 5）：\`clamp(floor(目标金额 / requestCostCny), 1, maxConcurrency)\`。`,
      )
    }
    if (cfg.lane === 'output') {
      lines.push(`- ${WARN} 当前是**慢速解码通道**：单流约 ¥1/h 量级，烧 ¥1 需要数十分钟。`)
    }

    // 6) 记账目录
    lines.push('')
    lines.push('### 6. 记账与留痕')
    try {
      const dir = runsDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      lines.push(`- ${OK} 可写：\`${dir}\``)
    } catch (e) {
      lines.push(`- ${NG} 不可写：\`${runsDir()}\` — ${e?.message ?? e}`)
      problems.push('记账目录不可写')
    }
    lines.push(`- 根目录：\`${rootDir()}\``)
    const markers = readLoadMarkers(3)
    if (markers.length) {
      lines.push('- 最近加载记录：')
      for (const m of markers) {
        lines.push(
          `  - ${String(m.at).replace('T', ' ').slice(0, 19)} — pid ${m.pid ?? '?'} — 硬上限 ¥${m.maxAmountCny} — 加载期账户服务 ${m.hasAccountAtLoad ?? m.hasAccount ? '可见' : '不可见（预期）'}`,
        )
      }
    } else {
      lines.push(`- ${WARN} 没有加载记录（journal 可能被关闭）`)
    }

    // 7) 结论
    lines.push('')
    lines.push('### 7. 结论')
    if (problems.length) {
      lines.push(`${NG} 有 ${problems.length} 项阻塞问题，**先不要跑 start**：`)
      for (const p of problems) lines.push(`- ${p}`)
    } else {
      lines.push(`${OK} 所有预检项通过。可以安全地先跑 \`plan\`，再跑极小金额的 \`start\`。`)
    }
    lines.push('')
    lines.push(`_本预检没有发起任何模型调用，因此没有产生任何费用。_\n\n---\n\n${disclaimer(cfg.maxAmountCny)}`)
    return { text: lines.join('\n') }
  }

  if (action === 'runs') {
    const markers = readLoadMarkers(5)
    const runs = listRuns(15)
    const lines = ['## 最近的 burn 运行', '']
    if (!runs.length) {
      lines.push('_还没有运行记录。_')
    } else {
      for (const r of runs) {
        const rec = readRun(r.runId)
        const start = rec.records.find((x) => x.kind === 'start')
        const finish = [...rec.records].reverse().find((x) => x.kind === 'finish')
        // 旧账本 / 被杀的进程写下的 finish 记录可能缺 result 或 spentCny。
        // 早期这里直接插值，于是一行行 `实烧 ¥0.095214 (undefined)` 就渲染给了用户。
        const spent = Number.isFinite(finish?.spentCny) ? `¥${fmt(finish.spentCny)}` : '¥?'
        const outcome = finish ? `${spent}${finish.result ? ` (${finish.result})` : ''}` : '无结束记录（可能仍在运行或进程被杀）'
        const reqCount = rec.records.filter((x) => x.kind === 'request').length
        lines.push(
          `- \`${r.runId}\` — ${new Date(r.mtime).toISOString().replace('T', ' ').slice(0, 16)} — ` +
            `目标 ¥${start?.targetCny ?? '?'} · ${outcome} · ${reqCount} 次请求` +
            `${rec.invalid ? ' ⚠️ 账本非法或不可读' : ''}`,
        )
      }
    }
    if (markers.length) {
      lines.push('')
      lines.push('### 插件加载记录')
      for (const m of markers) {
        lines.push(
          `- ${String(m.at).replace('T', ' ').slice(0, 19)} — pid ${m.pid ?? '?'} — 硬上限 ¥${m.maxAmountCny} — 加载期账户服务 ${(m.hasAccountAtLoad ?? m.hasAccount) ? '可见' : '不可见（预期：服务由 credentials 门控，运行期才注册）'}`,
        )
      }
    }
    lines.push('')
    lines.push('_每次请求一行记录（token、单价档位、耗时、错误码），可用于事后核对官方账单。_')
    return { text: lines.join('\n') }
  }

  if (action === 'stop') {
    // stop() 即使在本轮**已经结束**时也会返回快照，所以不能只看返回值判空 ——
    // 否则跑完之后再点一次「停机」，会得到「已请求停机、已停止下发新请求」这种
    // 看起来成功、实际什么都没停的回复（用户会以为自己刚阻止了花钱）。
    const wasRunning = burner.running
    const s = burner.stop('user-stop')
    if (!s) return { text: '当前没有正在运行的 burn。' }
    if (!wasRunning) {
      return {
        text:
          `当前没有正在运行的 burn —— 最近一轮 \`${s.runId}\` 已经结束` +
          `（${s.state}${s.stopReason ? ` · ${s.stopReason}` : ''}），没有需要停的东西。\n\n${renderStatus(s)}`,
      }
    }
    return {
      text: `## 已请求停机\n\n已停止下发新请求，在途请求会在宽限期内自然结束（用于拿到准确的 usage），超时后强制中止。\n\n${renderStatus(s)}\n\n_停机不是"撤销"：已经产生的 token 已经被计费。_`,
    }
  }

  if (action === 'status') {
    return { text: renderStatus(burner.status()) }
  }

  if (action === 'reconcile') {
    const runId = typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : null
    // runId 会被拼进文件路径，所以先净化（见 lib/ledger.js 的 isValidRunId）：
    // 不查的话 `runId: "../../../../tmp/x"` 能读到 runs 目录外的 *.jsonl。
    if (runId && !isValidRunId(runId)) {
      return {
        text:
          `对账失败：runId \`${runId}\` 含非法字符或路径片段。\n\n` +
          `合法的运行 ID 形如 \`burn-20261015-055544-q2h5\` —— 只允许字母、数字、点、下划线、连字符，最长 64 字符，且不含 \`..\`。\n` +
          `用 \`action: "runs"\` 看有哪些运行。`,
      }
    }
    let rec
    try {
      rec = await burner.reconcile(runId)
    } catch (err) {
      return { text: `对账失败：${err instanceof Error ? err.message : String(err)}` }
    }
    if (rec.error) return { text: `对账不可用：${rec.error}` }
    // 起始余额可能压根没读到（账户没挂载/查询失败），那时 before 只有 error —— 不能硬读 .total。
    if (!rec.before || rec.before.error || typeof rec.before.total !== 'number') {
      return {
        text:
          `## 余额对账（复读）\n\n运行 \`${rec.runId}\` 没有可用的**起始余额**记录` +
          `（${rec.before?.error ?? '未记录'}），无法做差额对账。\n\n` +
          `账本估算仍是可信的：**¥${rec.ledgerCny != null ? fmt(rec.ledgerCny, 6) : '（无记录）'}**。\n\n` +
          `当前余额：${rec.now?.error ? `查询失败（${rec.now.error}）` : `${rec.now?.currency ?? ''} ${fmt(rec.now?.total, 8)}`}`,
      }
    }
    const mins = rec.elapsedMs / 60000
    const L = []
    L.push('## 余额对账（复读）')
    L.push('')
    L.push(`- 运行：\`${rec.runId}\``)
    if (rec.targetCny != null) L.push(`- 目标金额：¥${fmt(rec.targetCny, 6)}`)
    if (rec.ledgerCny != null) L.push(`- 账本估算：**¥${fmt(rec.ledgerCny, 6)}**`)
    L.push(
      `- 起始余额：${rec.before.currency} ${fmt(rec.before.total, 8)}（${rec.before.at}）`,
    )
    L.push(`- 当前余额：${rec.now.currency} ${fmt(rec.now.total, 8)}`)
    L.push(`- 间隔：${mins < 1 ? `${Math.round(rec.elapsedMs / 1000)} 秒` : `${mins.toFixed(1)} 分钟`}`)
    L.push('')
    L.push(`### 原始差额：¥${fmt(rec.rawDeltaCny, 6)}`)
    L.push('')
    L.push(
      '⚠️ **这个差额是脏的**：它是从上面那个「起始余额」时刻到**现在**的全部扣费，' +
        '包含了同一账户上的一切其他用量 —— 包括正在跑这个插件的 **agent 会话自己**。' +
        '所以它只能当**上界**用：真实烧钱额 ≤ 原始差额 − 同期其他用量。',
    )
    if (rec.ledgerCny != null && rec.rawDeltaCny + 1e-9 < rec.ledgerCny) {
      L.push('')
      L.push(
        `🔴 **异常**：原始差额 ¥${fmt(rec.rawDeltaCny, 6)} 比账本估算 ¥${fmt(rec.ledgerCny, 6)} **还小**。` +
          '账本永远不该超过真实扣费 —— 要么余额接口还在延迟结算，要么价格表/usage 解析有问题。',
      )
    }
    if (rec.bracketSettled === false) {
      L.push('')
      L.push(
        'ℹ️ 该运行快照里的「after 括号」判为**不可信**' +
          (rec.snapshotDeltaCny != null
            ? `（结束后余额只动了 ¥${fmt(rec.snapshotDeltaCny, 6)}）`
            : '（结束余额与开始余额完全相同）') +
          '——余额接口有结算延迟，短运行读不出变化。这正是需要单独复读的原因。' +
          (rec.bracketSettledSource === 'inferred' ? '（此判断是从旧账本**反推**的，不是运行时记录的。）' : ''),
      )
    } else if (rec.bracketSettled === true) {
      L.push('')
      L.push(
        'ℹ️ 该运行的「after 括号」当时读出了变化，判为可信' +
          (rec.snapshotDeltaCny != null ? `（余额动了 ¥${fmt(rec.snapshotDeltaCny, 6)}）` : '') +
          (rec.bracketSettledSource === 'inferred' ? '（从旧账本反推）。' : '。'),
      )
    }
    return { text: L.join('\n') }
  }

  // plan / start 共用参数解析
  const model =
    typeof args.model === 'string' && args.model.trim()
      ? args.model.trim()
      : defaultSelection?.model ?? 'deepseek-flash'
  const provider = defaultSelection?.provider ?? undefined
  const amount = clampNum(args.amountCny, action === 'start' ? NaN : 0.1, 0.000001, 1e6)
  if (!Number.isFinite(amount)) {
    return { text: 'action="start" 必须提供 amountCny（目标金额，单位元）。建议先用 action="plan" 看看计划。' }
  }

  const rawConfig = { ...(deps.config ?? {}) }
  if (args.lane !== undefined) rawConfig.lane = args.lane
  if (args.maxConcurrency !== undefined) rawConfig.maxConcurrency = args.maxConcurrency
  if (args.requestCostCny !== undefined) rawConfig.requestCostCny = args.requestCostCny
  if (args.toleranceCny !== undefined) rawConfig.toleranceCny = args.toleranceCny
  if (args.deadlineSeconds !== undefined) rawConfig.deadlineSeconds = args.deadlineSeconds
  if (args.maxRequests !== undefined) rawConfig.maxRequests = args.maxRequests
  const config = resolveConfig(rawConfig, amount)

  const price = priceFor(model, { holidays: config.holidays })
  const plan = makePlan({ targetCny: amount, model, config })
  const ctxInfo = { known: price.known }

  if (action === 'plan') {
    return {
      text: `${renderPlan(plan, ctxInfo)}\n\n---\n\n${disclaimer(config.maxAmountCny)}\n\n_想真正执行：调用 \`burn_tokens\` 并传 \`action="start"\`、\`amountCny\`、\`confirm=true\`。_`,
    }
  }

  // action === start
  if (amount > config.maxAmountCny) {
    return {
      text:
        `❌ **已拒绝执行**：目标金额 ¥${fmt(amount)} 超过硬上限 ¥${fmt(config.maxAmountCny)}。\n\n` +
        '这是插件的防误操作设计。两种改法：\n\n' +
        '**A. 改插件自带的 patch（简单，但要重启）**\n' +
        '`token-burner/cordis.patch.yml` 里的 `config.maxAmountCny`。这个文件是包的一部分，' +
        '**dsh-hmr 不监听它**，所以改完必须重启应用。\n\n' +
        '**B. 在 profile patch 里覆盖（不用重启，但有陷阱）**\n' +
        '在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加：\n' +
        '```yaml\n- id: token-burner\n  config:\n    maxAmountCny: 5\n```\n' +
        '这个文件**被 dsh-hmr 监听**，改完会热重载。但 ⚠️ **`config` 是整体替换，不是深合并**' +
        '（`applyEntryPatches` 执行的是 `target.config = value`）—— 上面这种写法会把 `requestCostCny`、' +
        '`lane`、`requestTimeoutMs` 等**全部打回默认值**。用 B 就必须把原配置整段抄过来再改那一行。\n\n' +
        `改完用 \`action: "doctor"\` 确认第 5 节的「硬上限」变成了新值。\n\n${renderPlan(plan, ctxInfo)}`,
    }
  }
  if (args.confirm !== true) {
    return {
      text: `🛑 **未执行**：action="start" 需要显式传 \`confirm: true\` 才会真正扣费。\n\n以下是即将执行的计划，确认无误后再带上 \`confirm: true\` 重新调用：\n\n${renderPlan(plan, ctxInfo)}\n\n---\n\n${disclaimer(config.maxAmountCny)}`,
    }
  }

  // 余额预检：只在**确知**余额不足时拒绝。查询失败不阻断（余额是权威但不是前提），
  // 但会在下面附一条醒目告警 —— 免得白跑一次、每个请求都撞 ACCOUNT_QUOTA。
  const preBal = await burner.balance()
  let balanceNote = ''
  if (preBal?.error) {
    balanceNote = `\n\n> ⚠️ 余额预检不可用（${preBal.error}）。运行仍会继续，但请自行确认账户余额充足。`
  } else if (preBal && preBal.currency === 'CNY' && preBal.total < amount) {
    return {
      text: `❌ **已拒绝执行**：账户余额不足。\n\n- 可用余额：**¥${fmt(preBal.total, 4)}**（充值 ¥${fmt(preBal.balance, 4)} + 赠送 ¥${fmt(preBal.total - preBal.balance, 4)}）\n- 目标金额：**¥${fmt(amount)}**\n\n余额不足时每个请求都会以 \`ACCOUNT_QUOTA\` 失败，所以这里直接拦掉，不会产生任何调用。\n\n请先充值，或把 \`amountCny\` 降到余额以内。\n\n${renderPlan(plan, ctxInfo)}`,
    }
  } else if (preBal) {
    balanceNote = `\n\n> 当前余额 ${preBal.currency} ${fmt(preBal.total, 4)}，目标 ¥${fmt(amount)}。`
  }

  const snapshot = burner.start({ targetCny: amount, model, provider, config })
  // ⚠️ 上限是 100 秒，不是 3600。宿主对一次工具调用有 120 秒硬上限；超时后宿主会调
  // burner.stop('cancelled')，把一轮本来健康的运行打断（真机事故：¥5 只推进 ¥0.11 就被中止，
  // 停机原因还被记成 'cancelled'，掩盖了真实死因）。宁可这里短一点、让调用方轮询 status。
  const wait = clampNum(args.waitSeconds, 0, 0, 100)
  if (wait > 0) {
    const deadline = Date.now() + wait * 1000
    while (burner.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const s = burner.status() ?? snapshot
  const head = wait > 0 && !burner.running ? '## 烧钱运行已结束' : '## 烧钱运行已启动（后台并发执行中）'
  const tail = burner.running
    ? '\n\n_运行在后台继续。用 `action="status"` 查进度，`action="stop"` 停机。_'
    : '\n\n_对账请以 DeepSeek 官方账单为准。_'
  logger?.warn?.(`[token-burner] 启动 ${s.runId}：目标 ¥${fmt(amount)}，上限 ¥${fmt(config.maxAmountCny)}`)
  return { text: `${head}\n\n${renderStatus(s)}${balanceNote}${tail}\n\n---\n\n${disclaimer(config.maxAmountCny)}` }
}

/**
 * 注册 burn_tokens。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（需含 tools 与 llm 服务）。
 * @param {object} [config] 来自 cordis.patch.yml 的插件配置。
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? null
  // 可选依赖一律用 ctx.get 并吞掉异常：拿不到余额服务也必须能加载插件。
  const optional = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) ?? null : null
    } catch {
      return null
    }
  }
  // ⚠️ 账户服务必须惰性解析，绝不能在 apply() 里捕获：
  //   PlatformAccount 有 static inject = ["credentials","authorization"]，cordis 会推迟它的 apply；
  //   本插件只 inject tools/llm，必然先加载完成 —— 此刻 ctx.get('deepseekAccount') 一定还不存在。
  //   实测：加载留痕里 hasAccountAtLoad=false，但运行期（doctor/runs）能看到服务。
  const getAccount = () => optional('deepseekAccount')
  const burner = new Burner({ llm: ctx.llm, getAccount, logger, clientConfig: config })

  const readDefaultSelection = () => {
    try {
      const sel = optional('agentDefaultModel')?.currentSelection?.()
      return sel && typeof sel.model === 'string' ? sel : null
    } catch {
      return null
    }
  }

  if (!getAccount()) {
    logger?.info?.(
      `[${name}] 加载期未见 deepseekAccount 服务（预期行为：它注入 credentials/authorization，apply 被推迟）。运行期会惰性重试；用 doctor 动作确认。`,
    )
  }
  if (!Number.isFinite(config.maxAmountCny)) {
    logger?.warn?.(
      `[${name}] 未配置 maxAmountCny，使用默认硬上限 ¥${DEFAULTS.maxAmountCny}。这个默认值是故意设得很低的。`,
    )
  }
  // 加载留痕：既用于验证 Link/HMR 是否生效，也是「会花钱的插件」应有的审计线索。
  if (config.journal !== false) {
    appendLoadMarker({
      plugin: name,
      pid: typeof process !== 'undefined' ? process.pid : null,
      node: typeof process !== 'undefined' ? process.version : null,
      maxAmountCny: config.maxAmountCny ?? DEFAULTS.maxAmountCny,
      // 期望为 false：账户服务由 credentials/authorization 门控，加载期必然还没注册。
      hasAccountAtLoad: Boolean(getAccount()),
      defaultSelection: readDefaultSelection(),
    })
    logger?.info?.(`[${name}] 已加载（硬上限 ¥${config.maxAmountCny ?? DEFAULTS.maxAmountCny}）`)
  }

  ctx.tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
      },
    },
    // plan/status 很快；start 立即返回（或按 waitSeconds 等待）——不会长时间占住工具调用。
    timeoutMs: 120000,
    // 同一时刻只允许一个烧钱运行，且预算锁假设独占 —— 不允许并发调用。
    isConcurrencySafe: false,
    async execute(args, exec) {
      const onAbort = () => burner.stop('cancelled')
      let hooked = false
      if (exec?.signal && typeof exec.signal.addEventListener === 'function') {
        exec.signal.addEventListener('abort', onAbort, { once: true })
        hooked = true
      }
      try {
        return await runTool(args, {
          burner,
          logger,
          config,
          getAccount,
          defaultSelection: readDefaultSelection(),
        })
      } finally {
        if (hooked) exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })

  // 插件卸载时优雅停机，避免"孤儿"请求继续花钱。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        if (burner.running) burner.stop('plugin-unload')
      } catch {
        /* 忽略 */
      }
    })
  }
}

export { TOOL_NAME, runTool, DISCLAIMER, disclaimer, DEFAULT_MAX_AMOUNT_CNY, canonicalModel, PARAMETERS }

/**
 * controller.js — 预算锁 + 并发工作池 + 逐 token 记账 + 余额对账。
 *
 * 核心保证：**超支在结构上不可能发生**。
 *   单次请求的最坏花费按「悲观 token 数」估算：
 *     worst = (chars / (charsPerToken * ratioFloor)) * 未命中单价 * safetyFactor
 *           + maxTokens * 输出单价 * safetyFactor
 *   每次下发前的预留（reserve）与 spent 之和永远 ≤ target，因此
 *     spent + reserved ≤ target  恒成立。
 *   代价是可能**欠额** —— 欠额由主循环按剩余金额重算尺寸来迭代补齐（几何收敛）。
 *
 * ⚠️ 风险提示：本模块会**真实调用模型并真实扣费**。
 *    调用方必须先做金额上限校验与二次确认；默认上限见 index.js 的 DEFAULTS.maxAmountCny。
 */

import fs from 'node:fs'
import path from 'node:path'
import { priceFor, costCny, canonicalModel, nextTierChange } from './pricing.js'
import { buildPrompt, updateCharsPerToken, DEFAULT_CHARS_PER_TOKEN } from './filler.js'
import { appendRecord, readStats, learn, readRun, listRuns } from './ledger.js'

/**
 * 账户接口 `getBalance(client)` 需要一个「客户端身份」对象，它的字段直接变成 HTTP 头
 * （`dsh-deepseek-account/lib/types/index.js:43` 的 platformClientHeaders）：
 *   client.version             → x-client-version
 *   client.locale              → x-client-locale（zh_CN / en_US）
 *   client.timezoneOffsetSeconds → x-client-timezone-offset
 * 平时这个对象由 UI 通过 RPC 传进来；Host 侧插件必须自己合成，否则会炸在
 *   `Cannot read properties of undefined (reading 'version')`。
 */
const FALLBACK_CLIENT_VERSION = '0.2.0-rc.2'

/** 尽最大努力拿到宿主应用版本（Electron 的 Info.plist），失败则用兜底常量。 */
function detectAppVersion() {
  try {
    const exe = typeof process !== 'undefined' ? process.execPath : null
    if (exe) {
      const plist = path.join(path.dirname(path.dirname(exe)), 'Info.plist')
      const txt = fs.readFileSync(plist, 'utf8')
      const m = txt.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
      if (m) return m[1]
    }
  } catch {
    /* 拿不到就用兜底值，不值得为此失败 */
  }
  return FALLBACK_CLIENT_VERSION
}

export const DEFAULTS = {
  /** 硬上限：单次运行最多花多少元。想烧更多必须改 cordis.patch.yml。 */
  maxAmountCny: 1,
  /** 单次请求预算（元）。越小越精细、请求数越多。 */
  requestCostCny: 0.2,
  /** 单次请求最多填多少输入 token（官方上下文 1M，这里留足余量）。 */
  maxInputTokens: 200000,
  /** 单次请求最少填多少输入 token，低于此值不值得发。 */
  minInputTokens: 64,
  /** 输入通道下每次请求留多少输出 token（$ 上可忽略，只用于拿到 usage）。 */
  outputTokens: 32,
  /** 输出通道下 maxTokens 的上下限。 */
  minOutputTokens: 32,
  maxOutputTokens: 384000,
  /** 通道：input = 烧「输入·缓存未命中」（快）；output = 烧输出（准）。 */
  lane: 'input',
  /** 并发与 AIMD 自适应范围。官方并发限制：flash 2500 / v4-pro 500。 */
  maxConcurrency: 8,
  minConcurrency: 1,
  /** 连续成功多少次后并发 +1。 */
  recoverAfter: 8,
  /** 连续失败多少次后**才可能**放弃（还要过 stallTimeoutMs 那道时间闸门，见下）。 */
  maxConsecutiveFailures: 6,
  /**
   * 停机判据的**时间闸门**：光「连续失败 N 次」不够，还必须「距上次成功已超过这么久」。
   *
   * 真机证据（2026-10-15，¥5 运行 `burn-20261015-034400-0kpj`）：请求是**成波下发**的，
   * provider 的一个「坏时刻」会**同时**打掉整波在途请求 —— 于是 8 个并发失败在计数上
   * 看起来就像「连续 8 次失败」，把整轮运行在 15 秒内误杀（当时 ¥5 只推进了 ¥0.085）。
   * 失败请求不计费，所以宽容的代价只有墙钟时间：宁可多等，也别误杀。
   */
  stallTimeoutMs: 45000,
  /** 价格安全系数（>1 表示宁可少买）。 */
  safetyFactor: 1.05,
  /** 悲观字符/token 比折减系数：假设实际 token 数最多比估算高 (1/ratioFloor - 1)。 */
  ratioFloor: 0.8,
  /** 每次请求的推理强度。烧输入时用 'off' 最省事、输出最短。 */
  reasoningEffort: 'off',
  /** 容差（元）。null 表示 max(0.01, target * 0.001)。 */
  toleranceCny: null,
  /** 整轮运行的墙钟上限（秒）。0 表示不限。 */
  deadlineSeconds: 0,
  /** 整轮运行的最大请求数。0 表示不限。 */
  maxRequests: 0,
  /** 中国法定节假日（'YYYY-MM-DD'，北京时间）。留空时工作日的节假日会被当成高峰（保守）。 */
  holidays: [],
  /** 若账户币种为 USD，用该汇率换算对账。 */
  usdToCny: 7.2,
  /** 优雅停机宽限：stop 后多久强制 abort 在途请求（毫秒）。 */
  gracefulStopMs: 15000,
  /**
   * 单请求墙钟超时（毫秒）。0 表示不限。
   * ⚠️ 必须有这个：provider 偶尔会「too busy」到请求永不返回，而在途请求占着预算锁，
   *    一个卡死的请求能把整轮运行拖住直到天荒地老（真机实测过）。
   */
  requestTimeoutMs: 120000,
  /** 是否写审计日志。 */
  journal: true,
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function num(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 把外部（配置/工具参数）合并成一份完整配置，并夹紧到安全范围。 */
export function resolveConfig(raw = {}, targetCny = null) {
  const c = { ...DEFAULTS }
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v !== undefined && v !== null && k in DEFAULTS) c[k] = v
  }
  c.maxAmountCny = clamp(num(c.maxAmountCny, DEFAULTS.maxAmountCny), 0.0001, 1e6)
  c.requestCostCny = clamp(num(c.requestCostCny, DEFAULTS.requestCostCny), 1e-5, 100)
  c.maxInputTokens = clamp(Math.trunc(num(c.maxInputTokens, DEFAULTS.maxInputTokens)), 256, 900000)
  c.minInputTokens = clamp(Math.trunc(num(c.minInputTokens, DEFAULTS.minInputTokens)), 8, 100000)
  c.outputTokens = clamp(Math.trunc(num(c.outputTokens, DEFAULTS.outputTokens)), 1, 4096)
  c.minOutputTokens = clamp(Math.trunc(num(c.minOutputTokens, DEFAULTS.minOutputTokens)), 1, 4096)
  c.maxOutputTokens = clamp(Math.trunc(num(c.maxOutputTokens, DEFAULTS.maxOutputTokens)), 1, 384000)
  c.maxConcurrency = clamp(Math.trunc(num(c.maxConcurrency, DEFAULTS.maxConcurrency)), 1, 256)
  c.minConcurrency = clamp(Math.trunc(num(c.minConcurrency, DEFAULTS.minConcurrency)), 1, c.maxConcurrency)
  c.recoverAfter = clamp(Math.trunc(num(c.recoverAfter, DEFAULTS.recoverAfter)), 1, 1000)
  c.maxConsecutiveFailures = clamp(Math.trunc(num(c.maxConsecutiveFailures, DEFAULTS.maxConsecutiveFailures)), 1, 100)
  c.stallTimeoutMs = clamp(Math.trunc(num(c.stallTimeoutMs, DEFAULTS.stallTimeoutMs)), 5000, 600000)
  c.safetyFactor = clamp(num(c.safetyFactor, DEFAULTS.safetyFactor), 1, 3)
  c.ratioFloor = clamp(num(c.ratioFloor, DEFAULTS.ratioFloor), 0.3, 1)
  c.usdToCny = clamp(num(c.usdToCny, DEFAULTS.usdToCny), 0.1, 100)
  c.gracefulStopMs = clamp(Math.trunc(num(c.gracefulStopMs, DEFAULTS.gracefulStopMs)), 0, 120000)
  c.requestTimeoutMs = clamp(Math.trunc(num(c.requestTimeoutMs, DEFAULTS.requestTimeoutMs)), 0, 900000)
  c.lane = c.lane === 'output' ? 'output' : 'input'
  c.reasoningEffort = ['off', 'low', 'high', 'max'].includes(c.reasoningEffort) ? c.reasoningEffort : 'off'
  c.holidays = Array.isArray(c.holidays) ? c.holidays.filter((d) => typeof d === 'string') : []
  c.toleranceCny =
    c.toleranceCny === null || c.toleranceCny === undefined
      ? Math.max(0.01, (targetCny ?? 0) * 0.001)
      : clamp(num(c.toleranceCny, 0.01), 1e-6, 100)
  // 容差不得超过目标的一半，否则「剩余 ≤ 容差」在第一次循环就成立 → 一次请求都不发。
  if (Number.isFinite(targetCny) && targetCny > 0) {
    c.toleranceCny = Math.min(c.toleranceCny, targetCny / 2)
  }
  if (c.minInputTokens > c.maxInputTokens) c.minInputTokens = c.maxInputTokens
  return c
}

/**
 * 纯计算：出一份「不花钱」的执行计划。
 * 给 plan 与 start 共用，保证用户看到的和将要执行的是同一套数字。
 */
export function makePlan({ targetCny, model, config, date = new Date(), stats = null }) {
  const c = config
  const price = priceFor(model, { date, holidays: c.holidays })
  const s = stats ?? readStats()
  const unit = price.unit

  const lane = c.lane
  const rate = lane === 'output' ? unit.out : unit.inMiss
  const tokensNeeded = rate > 0 ? targetCny / rate : Infinity

  // ── 单请求规模：**必须与 #issue() 用同一套公式** ─────────────────────────
  // 早期这里 input 通道直接写 `perRequestTokens = c.maxInputTokens`，完全忽略
  // requestCostCny 与目标金额 —— 于是 ¥0.1 的计划会显示「单请求 200,000 token / ¥0.42」，
  // 而真实执行只下发约 38,000 token / ¥0.076。计划失真会直接误导用户判断风险。
  // 下面是 #issue 的等价纯函数版本（悲观费率反解 grant 能买到多少 token）。
  const effIn = (unit.inMiss * c.safetyFactor) / c.ratioFloor
  const effOut = unit.out * c.safetyFactor
  const sizeRequest = (grant) => {
    if (lane === 'output') {
      const budgetForOut = grant - c.minInputTokens * effIn
      let maxOut = Math.floor(budgetForOut / effOut)
      if (maxOut < c.minOutputTokens) return null
      maxOut = Math.min(maxOut, c.maxOutputTokens)
      return { inTokens: c.minInputTokens, maxOut }
    }
    const budgetForIn = grant - c.outputTokens * effOut
    let inTokens = Math.floor(budgetForIn / effIn)
    inTokens = Math.min(inTokens, c.maxInputTokens)
    if (inTokens < c.minInputTokens) return null
    return { inTokens, maxOut: c.outputTokens }
  }

  // 贪心模拟主循环：每轮 grant = min(剩余, requestCostCny)，按**真实费率**结算。
  // 这给出的是「按当前字符/token 估计准确」前提下的期望值。
  const sim = { requests: 0, spent: 0, tokens: 0, firstInTokens: 0, firstMaxOut: 0 }
  {
    let guard = 0
    while (sim.spent < targetCny - c.toleranceCny && guard < 100000) {
      guard += 1
      const remaining = Math.max(0, targetCny - sim.spent)
      const grant = Math.min(remaining, c.requestCostCny)
      const sized = sizeRequest(grant)
      if (!sized) break
      // 注意：price.unit.* 已经是「元/token」（priceFor 里除以过 1e6），别再除一次。
      const cost = sized.inTokens * rate + sized.maxOut * unit.out
      if (cost <= 0) break
      if (sim.requests === 0) {
        sim.firstInTokens = sized.inTokens
        sim.firstMaxOut = sized.maxOut
      }
      sim.requests += 1
      sim.spent += cost
      sim.tokens += lane === 'output' ? sized.maxOut : sized.inTokens
      // 期望花费恒小于预留额度；真出现「花了却推不动」的情况就停，避免死循环。
      if (cost < 1e-9) break
    }
  }

  const perRequestTokens = sim.firstInTokens || sim.firstMaxOut || 0
  const perRequestCost = sim.requests > 0 ? sim.spent / sim.requests : 0
  const requests = sim.requests
  const tps = lane === 'output' ? s.decodeTokensPerSec : s.prefillTokensPerSec

  // ── 真实并发 ≠ maxConcurrency ────────────────────────────────────────────
  // 预算锁每轮只发 grant = min(剩余, requestCostCny)，所以**同时在途的请求数**被
  // 「目标金额 ÷ 单请求预留」卡住：¥0.1 配 requestCostCny=0.2 时实际并发是 1，
  // 哪怕 maxConcurrency=8。计划里写「并发 8」会把墙钟时间低估一个数量级
  // （真机实测：计划说 2 秒，实际是一串串行请求，每串 3 秒起步）。
  const effectiveConcurrency = Math.max(
    1,
    Math.min(
      c.maxConcurrency,
      c.requestCostCny > 0 ? Math.max(1, Math.floor(targetCny / c.requestCostCny)) : c.maxConcurrency,
    ),
  )
  const avgTokensPerRequest = requests > 0 ? sim.tokens / requests : 0
  const perRequestSeconds = tps > 0 && avgTokensPerRequest > 0 ? avgTokensPerRequest / tps : Infinity
  const wallSeconds = Number.isFinite(perRequestSeconds)
    ? Math.ceil(requests / effectiveConcurrency) * perRequestSeconds
    : Infinity

  // 另一条通道的对照（让用户直观看到速度差）
  const otherLane = lane === 'output' ? 'input' : 'output'
  const otherRate = otherLane === 'output' ? unit.out : unit.inMiss
  const otherTps = otherLane === 'output' ? s.decodeTokensPerSec : s.prefillTokensPerSec
  const otherTokens = otherRate > 0 ? targetCny / otherRate : Infinity
  const otherSeconds = otherTps > 0 ? otherTokens / (otherTps * effectiveConcurrency) : Infinity

  const tierChange = nextTierChange(date, c.holidays)
  const warnings = []
  if (!price.known) {
    warnings.push(`模型 "${price.model}" 不在内置价格表里，已按最贵档位（${canonicalModel('deepseek-v4-pro')}）估算以避免超支。`)
  }
  if (price.peak) {
    warnings.push('当前处于**高峰时段**（单价 2×）：同样金额只需一半 token，烧得更快；但同样金额买到的 token 更少。')
  } else {
    warnings.push('当前处于**空闲时段**（单价减半）：同样金额能烧掉两倍的 token，但花完同样金额要两倍时间。')
  }
  if (c.holidays.length === 0) {
    warnings.push('未配置法定节假日表：工作日的节假日会被当成高峰价（保守方向，只会导致欠额后迭代补齐）。')
  }
  if (tierChange) {
    warnings.push(
      `下一次价格切换：${tierChange.at.toISOString().replace('T', ' ').slice(0, 16)} UTC → ${tierChange.becomesPeak ? '高峰' : '空闲'}。跨越切换点时单价会变，主循环会按新单价重算。`,
    )
  }
  if (Number.isFinite(wallSeconds) && wallSeconds > 3600) {
    warnings.push(`按当前并发与历史吞吐估计，需要约 ${(wallSeconds / 3600).toFixed(1)} 小时；墙钟时间是本方案真正的瓶颈。`)
  }
  if (requests > 5000) {
    warnings.push(`预计需要 ${Math.round(requests)} 次请求，建议增大 requestCostCny 或并发。`)
  }

  return {
    targetCny,
    model: price.model,
    provider: null,
    price: { tier: price.tier, peak: price.peak, unitCnyPerMTok: { inMiss: price.inMiss, hit: price.hit, out: price.out } },
    lane,
    tokensNeeded,
    perRequestTokens,
    perRequestCostCny: perRequestCost,
    requests,
    /** 贪心模拟的期望总花费（按真实费率），应当落在 [target - tolerance, target] 内。 */
    expectedTotalCny: sim.spent,
    expectedTokens: sim.tokens,
    toleranceCny: c.toleranceCny,
    concurrency: c.maxConcurrency,
    /** 预算锁下的**实际**并发（≤ maxConcurrency），墙钟估计按它算。 */
    effectiveConcurrency,
    assumedTokensPerSec: tps,
    wallSeconds,
    otherLane: { lane: otherLane, wallSeconds: otherSeconds, tokensNeeded: otherTokens },
    source: { charsPerToken: s.charsPerToken, prefillTokensPerSec: s.prefillTokensPerSec, decodeTokensPerSec: s.decodeTokensPerSec, samples: s.samples },
    warnings,
    config: c,
  }
}

export class Burner {
  /**
   * @param {{llm:any, account?:any, getAccount?:() => any, logger?:any}} deps
   *   llm        — ctx.llm（必需，提供 stream(options)）
   *   getAccount — **惰性**获取 ctx.get('deepseekAccount')（可选，用于余额对账）
   *   account    — 直接给定账户服务（等价于 getAccount: () => account，便于测试）
   *   logger     — ctx.logger（可选）
   *
   * ⚠️ 为什么账户必须惰性获取：
   *   `@deepseek-ai/dsh-deepseek-account-platform` 声明了 `static inject = ["credentials", "authorization"]`，
   *   cordis 会**推迟**它的 apply；而本插件只 inject tools/llm，必然先加载完成。
   *   所以加载期 ctx.get('deepseekAccount') 一定是 undefined —— 这不是故障，是加载顺序。
   *   （实测留痕：hasAccountAtLoad=false，但运行期服务已就绪。）
   */
  constructor({ llm, account = null, getAccount = null, logger = null, clientConfig = {} } = {}) {
    this.llm = llm
    this.getAccount = typeof getAccount === 'function' ? getAccount : () => account
    this.logger = logger
    this.clientConfig = clientConfig ?? {}
    this.run = null
  }

  /**
   * 合成 getBalance() 需要的客户端身份。时区偏移在**每次调用时**重算（夏令时/时区改动）。
   * 约定与字段名一致：UTC 以东为正秒数（北京 = +28800）。
   */
  clientIdentity() {
    const c = this.clientConfig
    const tz = Number.isFinite(c.timezoneOffsetSeconds)
      ? c.timezoneOffsetSeconds
      : -new Date().getTimezoneOffset() * 60
    return {
      version: String(c.clientVersion || detectAppVersion()),
      locale: String(c.clientLocale || 'zh-CN'),
      timezoneOffsetSeconds: tz,
    }
  }

  /** 当前是否能看到账户服务（每次都重新解析，绝不缓存 —— 服务是后来才注册的）。 */
  accountService() {
    try {
      return this.getAccount() ?? null
    } catch {
      return null
    }
  }

  /** 公开的余额读取（doctor 用；零成本：只读网络，不发任何模型调用）。 */
  async balance() {
    return this.#readBalance()
  }

  get running() {
    return this.run?.state === 'running' || this.run?.state === 'stopping'
  }

  plan({ targetCny, model, config, date = new Date() }) {
    return makePlan({ targetCny, model, config, date })
  }

  /**
   * 启动一次烧钱运行。立即返回快照，实际请求在后台并发跑。
   * ⚠️ 调用方必须已完成：金额上限校验 + 二次确认。
   */
  start({ targetCny, model, provider, config, dryRun = false }) {
    if (this.running) throw new Error(`已有一个 burn 运行中（${this.run.runId}），请先 stop 或等它结束。`)
    const price = priceFor(model, { holidays: config.holidays })
    if (targetCny > config.maxAmountCny) {
      throw new Error(
        `目标金额 ${targetCny} 元超过硬上限 ${config.maxAmountCny} 元（配置项 maxAmountCny）。本插件默认上限很低，就是为了防止误操作真实扣费。`,
      )
    }
    if (!this.llm || typeof this.llm.stream !== 'function') {
      throw new Error('llm 服务不可用：无法调用 ctx.llm.stream。')
    }

    const now = new Date()
    const run = {
      runId: `burn-${now.toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')}-${Math.random().toString(36).slice(2, 6)}`,
      state: dryRun ? 'planned' : 'running',
      dryRun,
      startedAt: Date.now(),
      endedAt: null,
      targetCny,
      provider,
      model: price.model,
      priceTier: price.tier,
      lane: config.lane,
      spentCny: 0,
      reservedCny: 0,
      inflight: 0,
      limit: config.maxConcurrency,
      successStreak: 0,
      failureStreak: 0,
      /** 最后一次**成功**拿到响应的时刻；null 表示还没成功过（此时回落到 run.startedAt）。 */
      lastSuccessAt: null,
      charsPerToken: DEFAULT_CHARS_PER_TOKEN,
      toleranceCny: config.toleranceCny,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      requests: { total: 0, ok: 0, failed: 0, rateLimited: 0 },
      timings: { firstRequestMs: null, totalMs: 0, sumRequestMs: 0 },
      cooldownUntil: 0,
      deadlineAt: config.deadlineSeconds > 0 ? Date.now() + config.deadlineSeconds * 1000 : Infinity,
      stopReason: null,
      result: null,
      lastError: null,
      warnings: [],
      /** 本轮生效的配置快照（stop() 的宽限期等要读它，别用 DEFAULTS 顶替）。 */
      config,
      balance: { before: null, after: null, deltaCny: null, driftCny: null, settled: null },
      controllers: new Set(),
    }

    const snap = this.snapshot(run)
    if (dryRun) {
      run.endedAt = Date.now()
      return { ...snap, plan: this.plan({ targetCny, model, config }) }
    }

    this.run = run
    appendRecord(run.runId, {
      kind: 'start',
      targetCny,
      provider,
      model: run.model,
      priceTier: run.priceTier,
      lane: run.lane,
      config: { ...config, holidays: config.holidays.length },
    })

    this.#loop(run, config).catch((err) => {
      run.state = 'error'
      run.lastError = err instanceof Error ? err.message : String(err)
      this.logger?.error?.(`[token-burner] 运行异常: ${run.lastError}`)
    })
    return { ...snap, plan: this.plan({ targetCny, model, config }) }
  }

  status() {
    if (!this.run) return null
    return this.snapshot(this.run)
  }

  /**
   * 复读余额，与指定（默认最近一次）运行的**起始**余额比较。
   *
   * 为什么需要单独一个动作：余额接口有结算延迟，跑完立刻复读往往一个数都没动
   * （真机实测：跑完 9 秒后复读，before 与 after 完全相同）。等几分钟再读才对得上。
   *
   * ⚠️ 但这个差额天然是**脏**的：同一账户上任何其他用量都会被算进来，
   *    包括正在跑这个插件的 agent 会话自己。所以它只能当**上界**用，
   *    不能当「本轮精确扣了多少钱」。
   */
  async reconcile(runId = null) {
    const id = runId ?? listRuns(1)[0]?.runId ?? null
    if (!id) return { runId: null, error: '找不到任何历史运行记录。' }
    const { records } = readRun(id)
    const start = records.find((r) => r.kind === 'start')
    const finish = [...records].reverse().find((r) => r.kind === 'finish')
    const before = finish?.balance?.before ?? null
    const now = await this.#readBalance()
    if (!before || now?.error) {
      return { runId: id, before, now, error: before ? now?.error ?? '余额读取失败' : '该运行没有起始余额记录' }
    }
    const fx = before.currency === 'USD' ? num(this.clientConfig?.usdToCny, 7.2) : 1
    const elapsedMs = Date.now() - new Date(before.at).getTime()
    // 旧运行（`settled` 字段还不存在的那几代）没有这个标记 —— 从存下来的括号反推。
    // 注意 `spentCny` 在 finish 记录上，`deltaCny` 在 finish.balance 里，两处不同层。
    const b = finish?.balance
    const legacySettled =
      b && typeof b.deltaCny === 'number' && typeof finish?.spentCny === 'number'
        ? b.deltaCny === 0 && finish.spentCny > 0
          ? false
          : b.deltaCny + 1e-9 >= finish.spentCny
        : null
    return {
      runId: id,
      targetCny: start?.targetCny ?? null,
      ledgerCny: finish?.spentCny ?? null,
      before,
      now,
      /** 从上一次运行的**起始**余额到现在的原始差额（含所有其他用量）。 */
      rawDeltaCny: (before.total - now.total) * fx,
      elapsedMs,
      /** 快照里那个「after 括号」是否可信（短运行基本都不可信）。 */
      bracketSettled: b?.settled ?? legacySettled,
      /** `recorded` = 当时就记了；`inferred` = 从旧账本反推。 */
      bracketSettledSource: b?.settled != null ? 'recorded' : legacySettled != null ? 'inferred' : null,
      /** 快照自己那个 after 括号的原始差额，便于对照。 */
      snapshotDeltaCny: typeof b?.deltaCny === 'number' ? b.deltaCny : null,
    }
  }

  /** 优雅停机：先不再下发新请求，宽限期后强制 abort 在途请求。 */
  stop(reason = 'user-stop') {
    const run = this.run
    if (!run) return null
    if (run.state === 'running') {
      run.state = 'stopping'
      run.stopReason = reason
      // 宽限期必须用本轮**实际生效**的配置，不能用 DEFAULTS 顶替。
      const graceMs = num(run.config?.gracefulStopMs, DEFAULTS.gracefulStopMs)
      const timer = setTimeout(() => {
        for (const c of run.controllers) {
          try {
            c.abort()
          } catch {
            /* 忽略 */
          }
        }
      }, graceMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    return this.snapshot(run)
  }

  snapshot(run) {
    const remaining = Math.max(0, run.targetCny - run.spentCny)
    const elapsedMs = (run.endedAt ?? Date.now()) - run.startedAt
    const perMin = elapsedMs > 0 ? (run.spentCny / elapsedMs) * 60000 : 0
    const etaSeconds =
      perMin > 0 && run.state === 'running' ? (remaining / perMin) * 60 : null
    return {
      runId: run.runId,
      state: run.state,
      dryRun: run.dryRun,
      startedAt: new Date(run.startedAt).toISOString(),
      endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
      targetCny: run.targetCny,
      spentCny: run.spentCny,
      remainingCny: remaining,
      progress: run.targetCny > 0 ? clamp(run.spentCny / run.targetCny, 0, 1) : 0,
      toleranceCny: run.toleranceCny,
      lane: run.lane,
      provider: run.provider,
      model: run.model,
      priceTier: run.priceTier,
      tokens: { ...run.tokens },
      requests: { ...run.requests },
      concurrency: { limit: run.limit, inflight: run.inflight },
      cnyPerMinute: perMin,
      etaSeconds,
      elapsedMs,
      charsPerToken: run.charsPerToken,
      stopReason: run.stopReason,
      result: run.result,
      lastError: run.lastError,
      warnings: [...run.warnings],
      balance: { ...run.balance },
    }
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  async #loop(run, config) {
    run.balance.before = await this.#readBalance()
    const workers = []
    for (let i = 0; i < config.maxConcurrency; i += 1) workers.push(this.#worker(run, config))
    await Promise.all(workers)

    run.endedAt = Date.now()
    run.timings.totalMs = run.endedAt - run.startedAt
    if (run.state === 'error') {
      /* 保留 error */
    } else if (run.stopReason) {
      run.state = 'stopped'
    } else {
      run.state = 'done'
    }
    const reached = run.targetCny - run.spentCny <= run.toleranceCny
    run.result = reached ? 'target-reached' : run.stopReason ? 'stopped' : 'short'
    if (!reached && !run.stopReason) {
      run.warnings.push(
        `未达到目标：实际烧掉 ¥${run.spentCny.toFixed(6)}，差 ¥${(run.targetCny - run.spentCny).toFixed(6)}。通常是因为剩余额度不足以发起一次有意义的请求，或已触达容差。`,
      )
    }

    run.balance.after = await this.#readBalance()
    const b0 = run.balance.before
    const b1 = run.balance.after
    if (b0?.total !== undefined && b1?.total !== undefined) {
      const fx = b0.currency === 'USD' ? config.usdToCny : 1
      run.balance.deltaCny = (b0.total - b1.total) * fx
      run.balance.driftCny = run.balance.deltaCny - run.spentCny
      // ── 余额接口有结算延迟（真机实测：跑完 9 秒后复读，一个数都没动）──────
      // 所以「after 括号」对短运行基本没用：差额会是 0，看着像「没扣钱」。
      // 这里显式标记不可信，别让 drift=0 被当成「对账通过」。
      run.balance.settled =
        !((b0.total === b1.total) && run.spentCny > 0) && run.balance.deltaCny >= run.spentCny - 1e-9
      if (!run.balance.settled && run.spentCny > 0) {
        run.warnings.push(
          `余额括号**不可信**：开始与结束读到的余额完全相同（${b1.currency} ${b1.total}），` +
            `但账本记了 ¥${run.spentCny.toFixed(6)}。余额接口有结算延迟（实测 ≥9 秒，可能数分钟），` +
            `请几分钟后再看余额，或用 \`action: "reconcile"\` 复读。**不要把差额 0 当成「没花钱」**。`,
        )
      }
    } else {
      run.warnings.push('余额对账不可用（账户服务未挂载或查询失败）：本轮的「花费」只是基于 usage 的估算值。')
    }

    if (config.journal) {
      appendRecord(run.runId, { kind: 'finish', ...this.snapshot(run) })
    }
    this.logger?.info?.(
      `[token-burner] ${run.runId} 结束：result=${run.result} spent≈¥${run.spentCny.toFixed(6)}${
        run.balance.deltaCny === null ? '' : ` 余额实扣=¥${run.balance.deltaCny.toFixed(6)}`
      }`,
    )
  }

  async #worker(run, config) {
    while (run.state === 'running') {
      if (Date.now() > run.deadlineAt) {
        this.#finish(run, 'deadline')
        break
      }
      if (config.maxRequests > 0 && run.requests.total >= config.maxRequests) {
        this.#finish(run, 'max-requests')
        break
      }
      // 「连续失败」在并发下会失真：provider 一次抖动会**同时**打掉一整波在途请求，
      // 于是 N 个失败其实只是**一个**坏时刻。容忍度必须至少覆盖一整波在途请求，
      // 否则并发越高越容易被瞬时抖动误杀（真机在并发 1 时就见过连续 2 次 SERVER 错误）。
      // 失败请求不计费，所以宽容的代价只有墙钟时间。
      //
      // ⚠️ 但光把阈值调大**不够**（真机实测：阈值顶到 100 后，¥5 运行照样被一波坏时刻
      //    打成「连续 8 次失败」）。真正判「provider 已经彻底不服务了」的信号是**时间**：
      //    连续失败 N 次 **且** 距上次成功已超过 stallTimeoutMs，才停机。
      //    只要还有零星的 2~3 秒成功响应冒出来，整轮就该继续跑下去。
      const streakLimit = Math.max(config.maxConsecutiveFailures, run.limit)
      const sinceSuccessMs = Date.now() - (run.lastSuccessAt ?? run.startedAt)
      if (run.failureStreak >= streakLimit && sinceSuccessMs >= config.stallTimeoutMs) {
        this.#finish(run, 'stalled')
        run.state = 'error'
        run.warnings.push(
          `连续 ${run.failureStreak} 次请求失败，且已有 ${Math.round(sinceSuccessMs / 1000)} 秒没有任何一次成功` +
            `（并发 ${run.limit} · 阈值 ${streakLimit} 次 · stallTimeoutMs ${config.stallTimeoutMs}ms），` +
            `判定为 provider 已停止服务，停机。`,
        )
        break
      }
      const now = Date.now()
      if (now < run.cooldownUntil) {
        await sleep(Math.min(2000, run.cooldownUntil - now))
        continue
      }
      if (run.inflight >= run.limit) {
        await sleep(80)
        continue
      }
      const grant = this.#reserve(run, config)
      if (grant === null) {
        if (run.inflight === 0) break
        await sleep(100)
        continue
      }
      await this.#issue(run, config, grant)
    }
  }

  /** 同步预留额度：JS 单线程，此处没有 await，因此不存在并发竞态。 */
  #reserve(run, config) {
    const remaining = run.targetCny - run.spentCny - run.reservedCny
    if (remaining <= run.toleranceCny) return null
    const chunk = Math.min(remaining, config.requestCostCny)
    if (chunk < this.#minRequestCostCny(config, run)) return null
    run.reservedCny += chunk
    run.inflight += 1
    return chunk
  }

  #minRequestCostCny(config, run) {
    const price = priceFor(run.model, { holidays: config.holidays })
    const u = price.unit
    return config.minInputTokens * u.inMiss * config.safetyFactor + config.outputTokens * u.out * config.safetyFactor
  }

  async #issue(run, config, grant) {
    const price = priceFor(run.model, { holidays: config.holidays })
    const u = price.unit
    // 悲观费率：把「实际 token 可能比估算多」这件事直接算进单价里。
    const effIn = (u.inMiss * config.safetyFactor) / config.ratioFloor
    const effOut = u.out * config.safetyFactor

    let inTokens
    let maxOut
    if (config.lane === 'output') {
      inTokens = config.minInputTokens
      const budgetForOut = grant - inTokens * effIn
      maxOut = Math.floor(budgetForOut / effOut)
      if (maxOut < config.minOutputTokens) {
        this.#release(run, grant)
        return
      }
      maxOut = Math.min(maxOut, config.maxOutputTokens)
    } else {
      maxOut = config.outputTokens
      const budgetForIn = grant - maxOut * effOut
      inTokens = Math.floor(budgetForIn / effIn)
      inTokens = Math.min(inTokens, config.maxInputTokens)
      if (inTokens < config.minInputTokens) {
        this.#release(run, grant)
        return
      }
    }

    const prompt = buildPrompt({ tokens: inTokens, charsPerToken: run.charsPerToken })
    const controller = new AbortController()
    run.controllers.add(controller)
    if (run.state === 'stopping') {
      try {
        controller.abort()
      } catch {
        /* 忽略 */
      }
    }

    const started = Date.now()
    let usage = null
    let reason = null
    let thrown = null
    let timedOut = false
    let timer = null
    let signal = controller.signal
    // 单请求超时：与「整轮停机」是两个独立的中止源，任一触发都中止这次 stream。
    // 没有它，一个卡死的请求会一直占着预算锁（#release 在 finally 里才执行）。
    if (config.requestTimeoutMs > 0) {
      const timeoutCtl = new AbortController()
      timer = setTimeout(() => {
        timedOut = true
        try {
          timeoutCtl.abort()
        } catch {
          /* 忽略 */
        }
      }, config.requestTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      signal = AbortSignal.any([controller.signal, timeoutCtl.signal])
    }
    run.requests.total += 1

    try {
      const stream = this.llm.stream({
        provider: run.provider,
        model: run.model,
        reasoningEffort: config.reasoningEffort,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.text }] }],
        maxTokens: maxOut,
        signal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') reason = chunk.reason
      }
    } catch (err) {
      thrown = err
    } finally {
      if (timer) clearTimeout(timer)
      run.controllers.delete(controller)
    }

    const ms = Date.now() - started
    run.timings.sumRequestMs += ms
    if (run.timings.firstRequestMs === null) run.timings.firstRequestMs = ms

    // 只要有 usage 就一定记账：即使请求报错，provider 也可能已经计费。
    if (usage) {
      const cost = costCny(usage, price)
      run.spentCny += cost
      run.tokens.input += usage.inputTokens ?? 0
      run.tokens.cacheRead += usage.cacheReadTokens ?? 0
      run.tokens.cacheWrite += usage.cacheWriteTokens ?? 0
      run.tokens.output += usage.outputTokens ?? 0
      const seen = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
      run.charsPerToken = updateCharsPerToken(run.charsPerToken, prompt.text.length, seen)
    }

    const code = timedOut
      ? 'TIMEOUT'
      : reason?.kind === 'error' || reason?.kind === 'aborted'
        ? reason?.failure?.code ?? reason.kind.toUpperCase()
        : thrown
          ? 'THROWN'
          : null

    if (code === null) {
      run.requests.ok += 1
      run.failureStreak = 0
      run.lastSuccessAt = Date.now()
      run.successStreak += 1
      if (run.successStreak >= config.recoverAfter) {
        run.successStreak = 0
        run.limit = Math.min(config.maxConcurrency, run.limit + 1)
      }
      if (usage) {
        const seen = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0)
        const tps = ms > 0 ? (seen / ms) * 1000 : 0
        if (tps > 0) learn(config.lane === 'output' ? 'decodeTokensPerSec' : 'prefillTokensPerSec', tps, 0.25)
        if (run.charsPerToken > 0) learn('charsPerToken', run.charsPerToken, 0.25)
      }
    } else {
      run.requests.failed += 1
      run.failureStreak += 1
      run.successStreak = 0
      const message = timedOut
        ? `单请求超过 ${Math.round(config.requestTimeoutMs / 1000)}s 未返回，已中止（requestTimeoutMs）。`
        : reason?.failure?.message ?? (thrown instanceof Error ? thrown.message : String(thrown ?? ''))
      const retryAfterMs = num(reason?.failure?.providerRetryAfterMs, 0)
      run.lastError = { code, message, at: new Date().toISOString(), status: reason?.failure?.status ?? null }
      if (config.journal) appendRecord(run.runId, { kind: 'error', code, message, ms })
      this.#handleFailure(run, config, code, retryAfterMs)
      // 100% 缓存命中说明前缀被复用了 —— 这会严重拖慢烧钱速度，必须告警。
      if (usage && (usage.cacheReadTokens ?? 0) > 0 && (usage.inputTokens ?? 0) === 0) {
        const msg = '本次请求输入全部命中缓存（前缀被复用），烧钱速度会大幅下降；nonce 机制应已避免这种情况，请检查。'
        if (!run.warnings.includes(msg)) run.warnings.push(msg)
      }
    }

    if (config.journal && usage) {
      appendRecord(run.runId, {
        kind: 'request',
        lane: config.lane,
        ms,
        promptChars: prompt.text.length,
        maxTokens: maxOut,
        estimatedInputTokens: inTokens,
        usage,
        costCny: costCny(usage, price),
        tier: price.tier,
        code,
      })
    }

    this.#release(run, grant)
  }

  #handleFailure(run, config, code, retryAfterMs) {
    if (code === 'RATE_LIMIT') {
      run.requests.rateLimited += 1
      run.limit = Math.max(config.minConcurrency, Math.floor(run.limit / 2))
      const backoff = retryAfterMs > 0 ? retryAfterMs : Math.min(30000, 1000 * 2 ** Math.min(5, run.requests.rateLimited))
      run.cooldownUntil = Date.now() + backoff + Math.random() * 500
      run.warnings.push(`触发限流：并发降到 ${run.limit}，退避 ${Math.round(backoff / 1000)}s。`)
      return
    }
    if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') {
      this.#finish(run, 'quota-exhausted')
      run.state = 'error'
      return
    }
    if (code === 'CONTEXT_WINDOW_EXCEEDED') {
      config.maxInputTokens = Math.max(config.minInputTokens, Math.floor(config.maxInputTokens * 0.75))
      run.cooldownUntil = Date.now() + 500
      run.warnings.push(`输入超出上下文，已将单请求上限降到 ${config.maxInputTokens} token。`)
      return
    }
    run.cooldownUntil = Date.now() + Math.min(8000, 500 * 2 ** Math.min(4, run.failureStreak))
  }

  #finish(run, reason) {
    if (!run.stopReason) run.stopReason = reason
    if (run.state === 'running') run.state = 'stopping'
  }

  #release(run, grant) {
    run.reservedCny = Math.max(0, run.reservedCny - grant)
    run.inflight = Math.max(0, run.inflight - 1)
  }

  async #readBalance() {
    const acct = this.accountService()
    if (!acct || typeof acct.getBalance !== 'function') return null
    let client
    try {
      client = this.clientIdentity()
    } catch {
      client = undefined
    }
    try {
      const r = await acct.getBalance(client)
      // null = 未登录 / 没有可用凭证 —— 与「余额为 0」是两码事。
      if (!r) return { error: '账户未登录或没有可用凭证（getBalance 返回 null）' }
      // 权威形状（dsh-api-account-controller/lib/typert.host.js 的 getBalance result）：
      //   null | { status:'ready', value: Wallet[], bonusWallets: Wallet[] } | { status:'failed' }
      //   Wallet = { currency:'CNY'|'USD', balance: string }
      // ⚠️ 过去这里误读 r.balance（不存在）→ 恒为 0；那会把「有余额」谎报成「没钱」，
      //    也可能让「查询失败」被当成 0 —— 而账户 README 明确要求失败绝不变成金额。
      if (r.status === 'failed') {
        return { error: '账户接口返回 status:"failed"（查询失败不提供金额，插件绝不把它当作 0）' }
      }
      if (r.status !== 'ready') {
        return { error: `账户接口返回了无法识别的 status：${JSON.stringify(r.status)}` }
      }
      const norm = (w) => ({ currency: w?.currency ?? 'CNY', balance: num(w?.balance, 0) })
      const wallets = Array.isArray(r.value) ? r.value.map(norm) : []
      const bonus = Array.isArray(r.bonusWallets) ? r.bonusWallets.map(norm) : []
      const balance = wallets.reduce((a, w) => a + w.balance, 0)
      const bonusTotal = bonus.reduce((a, w) => a + w.balance, 0)
      return {
        currency: wallets[0]?.currency ?? bonus[0]?.currency ?? 'CNY',
        balance,
        wallets,
        bonusWallets: bonus,
        total: balance + bonusTotal,
        at: new Date().toISOString(),
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
}

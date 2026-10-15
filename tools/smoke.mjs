/**
 * tools/smoke.mjs — 本地冒烟测试：**不联网、不花钱**。
 *
 * 用一个假的 llm.stream 替换真实模型，验证控制逻辑：
 *   1) 预算锁：spent 永不超过 target
 *   2) 迭代收敛：最终 spent 落在容差带内
 *   3) 缓存未命中：每次请求的 prompt 前缀都不同
 *   4) 字符/token 比自学习：反复运行后估算值收敛到真值
 *   5) 记账/审计日志/停机路径
 *
 * 用法：DSH_HOME=$(mktemp -d) node tools/smoke.mjs
 */

import assert from 'node:assert/strict'
import { Burner, resolveConfig, makePlan } from '../lib/controller.js'
import { priceFor, isPeak, beijingDateKey, beijingParts, nextTierChange } from '../lib/pricing.js'
import { readStats, listRuns, readRun, appendRecord } from '../lib/ledger.js'

const TRUE_CHARS_PER_TOKEN = Number(process.env.TRUE_RATIO ?? 5) // 真值故意不同于初值 4
const LATENCY_MS = 3

/** 假 provider：按 prompt 的真实字符数换算 token，模拟一次真实调用。 */
function makeFakeLlm({ cacheAlwaysMiss = true } = {}) {
  const seenPrefixes = new Set()
  let calls = 0
  return {
    seenPrefixes,
    get calls() {
      return calls
    },
    // doctor 用：零成本只读接口（真实 ctx.llm 也有这两个）
    listProviders() {
      return [{ id: 'fake', name: 'Fake Provider' }]
    },
    async resolveModelInfo(provider, model) {
      if (provider === 'nope') throw new Error('NO_ADAPTER: unknown provider')
      // 真实形状（dsh-llm/lib/typert.host.js）：context 是对象、reasoning.efforts 是对象数组。
      // 早期这里写的是 { contextWindow } 顶层字段，导致窗口校验被静默跳过 —— 别再改回去。
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 1000000 },
        defaultMaxTokens: 256000,
        reasoning: {
          efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }],
          defaultEffort: 'high',
        },
        inputModalities: ['text'],
      }
    },
    stream(options) {
      calls += 1
      const text = options.messages?.[0]?.content?.[0]?.text ?? ''
      const prefix = text.slice(0, 64)
      const reused = seenPrefixes.has(prefix)
      seenPrefixes.add(prefix)
      const inputTokens = Math.max(1, Math.round(text.length / TRUE_CHARS_PER_TOKEN))
      const outputTokens = 2
      const cacheRead = cacheAlwaysMiss || !reused ? 0 : Math.round(inputTokens * 0.9)
      const usage = {
        inputTokens: cacheRead > 0 ? inputTokens - cacheRead : inputTokens,
        outputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
      }
      usage.totalTokens = usage.inputTokens + usage.outputTokens + cacheRead
      return (async function* gen() {
        await new Promise((r) => setTimeout(r, LATENCY_MS))
        yield { type: 'text-delta', index: 0, text: 'OK' }
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

async function burn({ targetCny, ratioNote, account = null, overrides = {} }) {
  const llm = makeFakeLlm()
  const burner = new Burner({ llm, account })
  const config = resolveConfig(
    { requestCostCny: 0.01, maxConcurrency: 4, maxInputTokens: 20000, ...overrides },
    targetCny,
  )
  burner.start({ targetCny, model: 'deepseek-flash', provider: 'fake', config })
  const deadline = Date.now() + 30000
  while (burner.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  const s = burner.status()
  return { s, llm, burner, config, ratioNote }
}

async function main() {
  let pass = 0
  const ok = (name) => {
    pass += 1
    console.log(`  ✓ ${name}`)
  }

  console.log('\n[1] 时段与价格判定')
  {
    // 2026-10-14 是周三。北京时间 10:00 → 高峰；20:00 → 空闲；周六 → 空闲。
    const wed10 = new Date('2026-10-14T02:00:00Z') // 北京 10:00
    const wed20 = new Date('2026-10-14T12:00:00Z') // 北京 20:00
    const sat10 = new Date('2026-10-17T02:00:00Z') // 周六北京 10:00
    assert.equal(beijingDateKey(wed10), '2026-10-14')
    assert.equal(isPeak(wed10, []), true)
    assert.equal(isPeak(wed20, []), false)
    assert.equal(isPeak(sat10, []), false)
    assert.equal(isPeak(wed10, ['2026-10-14']), false, '节假日应算空闲')
    const p = priceFor('deepseek-flash', { date: wed10, holidays: [] })
    assert.equal(p.tier, 'peak')
    assert.equal(p.inMiss, 2)
    assert.equal(p.unit.inMiss, 2 / 1e6)
    ok('高峰/空闲/周末/节假日判定正确')
    ok('单价换算为元/token 正确')
  }

  console.log('\n[1b] nextTierChange 不得双重时区平移')
  {
    // isPeak 内部经 beijingParts 已做 +8h；若这里再预先平移一次就是 +16h，
    // 症状：任何时刻都回报「0 分钟后切换档位」。真机 doctor 就是这么暴露的。
    const cases = [
      ['2026-10-15T02:38:00Z', true, 82, false, '周四 10:38 高峰 → 12:00 转空闲'],
      ['2026-10-15T01:30:00Z', true, 150, false, '周四 09:30 高峰 → 12:00 转空闲'],
      ['2026-10-15T07:00:00Z', true, 180, false, '周四 15:00 高峰 → 18:00 转空闲'],
      ['2026-10-15T04:00:00Z', false, 120, true, '周四 12:00 空闲 → 14:00 转高峰'],
      ['2026-10-15T11:00:00Z', false, 840, true, '周四 19:00 空闲 → 次日 09:00 转高峰'],
      ['2026-10-17T03:00:00Z', false, 2760, true, '周六 11:00 空闲 → 周一 09:00 转高峰'],
    ]
    for (const [iso, peakNow, minutes, becomesPeak, label] of cases) {
      const d = new Date(iso)
      assert.equal(isPeak(d, []), peakNow, label)
      const n = nextTierChange(d, [])
      assert.ok(n, `${label}：应当有下一个切换时刻`)
      assert.equal(Math.round((n.at - d) / 60000), minutes, `${label}：分钟数应为 ${minutes}`)
      assert.equal(n.becomesPeak, becomesPeak, label)
      assert.equal(isPeak(n.at, []), becomesPeak, `${label}：切换时刻的档位必须真的变了`)
      const bp = beijingParts(n.at)
      assert.equal(bp.minute, 0, `${label}：切换点必须落在整点`)
      assert.ok([9, 12, 14, 18].includes(bp.hour), `${label}：切换点的小时应为 9/12/14/18，实际 ${bp.hour}`)
    }
    ok('档位切换时刻正确（含 12:00 / 14:00 / 18:00 / 跨夜 / 跨周末边界）')
    ok('切换点前后档位确实翻转（不会返回「现在就是切换点」）')
  }

  console.log('\n[2] 未知模型 → 按最贵档位保守估算')
  {
    // ⚠️ 必须显式钉住日期：曾经这里传的是 `{}`（= new Date()），于是断言变成
    //    「跑测试的时刻得正好在高峰」—— 2026-10-15 12:00 一过就红了（2 vs 1）。
    //    价格断言永远不许依赖墙钟。
    const p = priceFor('some-unknown-model', { date: new Date('2026-10-14T02:00:00Z') }) // 周三北京 10:00 = 高峰
    assert.equal(p.known, false)
    assert.equal(p.tier, 'peak', '未知模型的断言必须在高峰档下做')
    assert.equal(p.inMiss, 9, '未知模型应取 v4-pro 高峰价')
    ok('未知模型回退到最贵档位（保守，不会超支）')
  }

  console.log('\n[3] 纯计划：不产生任何请求')
  {
    const config = resolveConfig({}, 1)
    const plan = makePlan({ targetCny: 1, model: 'deepseek-flash', config })
    assert.ok(plan.requests > 0)
    assert.ok(plan.wallSeconds > 0)
    assert.ok(plan.otherLane.wallSeconds > plan.wallSeconds, 'input 通道应明显快于 output 通道')
    const speedup = plan.otherLane.wallSeconds / plan.wallSeconds
    console.log(`    input=${plan.wallSeconds.toFixed(0)}s  output=${plan.otherLane.wallSeconds.toFixed(0)}s  快 ${speedup.toFixed(0)}×`)
    ok('计划可算且输入通道显著更快')
  }

  console.log('\n[3b] 计划必须诚实：单请求规模要受 requestCostCny 与目标金额约束')
  {
    // 回归：早期 input 通道直接写 `perRequestTokens = maxInputTokens`，
    // 于是 ¥0.1 的计划显示「单请求 200,000 token / ¥0.42」，而真实执行只下发 ~38,000 token。
    // 计划失真会直接误导用户判断风险，必须锁死。
    const small = makePlan({
      targetCny: 0.1,
      model: 'deepseek-flash',
      config: resolveConfig({ requestCostCny: 0.2, maxInputTokens: 200000 }, 0.1),
    })
    assert.ok(small.perRequestTokens > 0 && small.perRequestTokens < 200000, '单请求 token 数不能等于 maxInputTokens（说明忽略了预算）')
    // 预留额度是 min(requestCostCny, target)，所以 ¥0.1 目标下单请求不可能超过 ¥0.1 的量级
    assert.ok(
      small.perRequestCostCny <= 0.1,
      `单请求期望花费 ${small.perRequestCostCny} 不应超过目标金额本身`,
    )
    assert.ok(small.expectedTotalCny <= 0.1, '期望总花费绝不能超过目标')
    assert.ok(small.expectedTotalCny >= 0.1 - small.toleranceCny, '期望总花费应落在容差带内（不会大幅欠额）')

    // 单请求预算越小 → 单请求 token 越少
    const tiny = makePlan({
      targetCny: 1,
      model: 'deepseek-flash',
      config: resolveConfig({ requestCostCny: 0.05, maxInputTokens: 200000 }, 1),
    })
    const big = makePlan({
      targetCny: 1,
      model: 'deepseek-flash',
      config: resolveConfig({ requestCostCny: 0.5, maxInputTokens: 200000 }, 1),
    })
    assert.ok(tiny.perRequestTokens < big.perRequestTokens, 'requestCostCny 必须真的影响单请求规模')
    assert.ok(tiny.requests > big.requests, '单请求越小，请求数越多')

    // 所有目标金额都必须「不超支」，这是本插件的第一性约束
    for (const t of [0.02, 0.1, 1, 5]) {
      const p = makePlan({ targetCny: t, model: 'deepseek-flash', config: resolveConfig({ maxAmountCny: 100 }, t) })
      assert.ok(p.expectedTotalCny <= t + 1e-9, `目标 ¥${t} 的期望花费 ${p.expectedTotalCny} 不得超支`)
    }
    console.log(
      `    ¥0.1 → 单请求 ${small.perRequestTokens} token / ¥${small.perRequestCostCny.toFixed(4)}` +
        ` · ${small.requests} 次 · 期望总计 ¥${small.expectedTotalCny.toFixed(4)}`,
    )
    ok('计划数字与真实执行同源，且永不超支')

    // ── 实际并发：预算锁把「同时在途」压到 floor(目标 / requestCostCny) ──
    // 真机实测：¥0.1 + requestCostCny=0.2 时并发其实是 1，而计划写着 8，
    // 于是「预计 2 秒」变成一串 3 秒起步的串行请求。
    const c1 = makePlan({
      targetCny: 0.1,
      model: 'deepseek-flash',
      config: resolveConfig({ requestCostCny: 0.2, maxConcurrency: 8 }, 0.1),
    })
    assert.equal(c1.concurrency, 8, 'maxConcurrency 仍是用户设置的上限')
    assert.equal(c1.effectiveConcurrency, 1, '¥0.1 ÷ ¥0.2 → 同时在途只能是 1')
    const c5 = makePlan({
      targetCny: 1,
      model: 'deepseek-flash',
      config: resolveConfig({ requestCostCny: 0.2, maxConcurrency: 8 }, 1),
    })
    assert.equal(c5.effectiveConcurrency, 5, '¥1 ÷ ¥0.2 → 5 个请求可同时在途')
    const c20 = makePlan({
      targetCny: 20,
      model: 'deepseek-flash',
      config: resolveConfig({ requestCostCny: 0.2, maxConcurrency: 8 }, 20),
    })
    assert.equal(c20.effectiveConcurrency, 8, '预算够时以 maxConcurrency 为上限')
    // 同一目标金额下，预留越大 → 并发越低 → 墙钟越长（token 总量由金额决定，大致不变）
    const sameTargetLowC = makePlan({
      targetCny: 1,
      model: 'deepseek-flash',
      config: resolveConfig({ requestCostCny: 0.5, maxConcurrency: 8 }, 1),
    })
    const sameTargetHighC = makePlan({
      targetCny: 1,
      model: 'deepseek-flash',
      config: resolveConfig({ requestCostCny: 0.05, maxConcurrency: 8 }, 1),
    })
    assert.equal(sameTargetLowC.effectiveConcurrency, 2, '¥1 ÷ ¥0.5 → 并发 2')
    assert.equal(sameTargetHighC.effectiveConcurrency, 8, '¥1 ÷ ¥0.05 → 并发封顶 8')
    assert.ok(
      sameTargetLowC.wallSeconds > sameTargetHighC.wallSeconds,
      `并发 2 的墙钟(${sameTargetLowC.wallSeconds}) 必须长于并发 8 的(${sameTargetHighC.wallSeconds})`,
    )
    ok('计划按预算锁给出**实际并发**（不再是骗人的 maxConcurrency）')
  }

  console.log('\n[3c] 单请求超时：provider 卡死时必须能自己爬出来')
  {
    // 真实事故：provider 回「Service is too busy」之后第 4 个请求永不返回，
    // 它一直占着预算锁（#release 在 finally 之后才跑），整轮运行 3.2 分钟零进展。
    let abortedSeen = false
    const hangLlm = {
      calls: 0,
      listProviders: () => [{ id: 'fake', name: 'Fake' }],
      async resolveModelInfo(provider, model) {
        return {
          provider, id: model, name: model,
          context: { contextWindow: 1000000 },
          defaultMaxTokens: 256000,
          reasoning: { efforts: [{ id: 'off' }], defaultEffort: 'off' },
          inputModalities: ['text'],
        }
      },
      stream(options) {
        this.calls += 1
        const signal = options.signal
        return (async function* gen() {
          // 永不产出任何 chunk，直到被中止 —— 模拟 provider 挂死。
          await new Promise((_, reject) => {
            const die = () => {
              abortedSeen = true
              reject(new Error('aborted by signal'))
            }
            if (signal?.aborted) return die()
            signal?.addEventListener('abort', die, { once: true })
          })
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
        })()
      },
    }
    const burner = new Burner({ llm: hangLlm, account: null })
    const config = resolveConfig(
      {
        requestCostCny: 0.01,
        maxConcurrency: 4,
        maxInputTokens: 20000,
        requestTimeoutMs: 200,
        maxConsecutiveFailures: 2,
        // 一路挂死、永远没有成功 → 停机要靠 stallTimeoutMs 这道时间闸门。
        // 这里给夹紧下限 5000ms，好让断言能验证「用的是配置值而不是 45000 的默认值」。
        stallTimeoutMs: 5000,
      },
      0.05,
    )
    assert.equal(config.requestTimeoutMs, 200, 'requestTimeoutMs 必须被 resolveConfig 保留')
    assert.equal(config.stallTimeoutMs, 5000, 'stallTimeoutMs 必须被 resolveConfig 保留（夹紧下限 5000）')
    const t0 = Date.now()
    burner.start({ targetCny: 0.05, model: 'deepseek-flash', provider: 'fake', config })
    const deadline = Date.now() + 20000
    while (burner.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    const elapsed = Date.now() - t0
    const s = burner.status()
    assert.ok(!burner.running, `卡死的运行必须自己结束，不能永远挂着（elapsed=${elapsed}ms）`)
    assert.ok(
      elapsed < 8000,
      `必须由 stallTimeoutMs=5000 收尾（用了 ${elapsed}ms）；` +
        `如果这里变成 ~45000ms，说明停机判据没读配置、拿 DEFAULTS 顶替了`,
    )
    assert.ok(abortedSeen, '超时必须真的 abort 掉在途请求（signal 得传到 llm.stream）')
    assert.ok(s.requests.failed > 0, '超时必须记为失败')
    assert.ok((s.lastError?.code ?? '') === 'TIMEOUT', `失败码应为 TIMEOUT，实际 ${s.lastError?.code}`)
    assert.equal(s.spentCny, 0, '卡死的请求不该记任何花费')
    ok(
      `单请求超时 ${config.requestTimeoutMs}ms → 每次挂死都被 abort（失败码 TIMEOUT、不记花费），` +
        `${elapsed}ms 后由 stallTimeoutMs 收尾`,
    )
  }

  console.log('\n[3d] 停机判据 = 连续失败 **且** 卡住太久（纯计数会在成波下发时误杀整轮）')
  {
    const failChunk = {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'SERVER', message: 'Service is too busy.' } },
    }
    const okUsage = (options) => {
      const text = options.messages?.[0]?.content?.[0]?.text ?? ''
      const inputTokens = Math.max(1, Math.round(text.length / TRUE_CHARS_PER_TOKEN))
      const usage = { inputTokens, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
      usage.totalTokens = inputTokens + 2
      return usage
    }
    const allFail = {
      listProviders: () => [{ id: 'fake', name: 'Fake' }],
      stream: () =>
        (async function* gen() {
          yield failChunk
        })(),
    }
    // 每 n 次失败夹 1 次成功 —— 复刻真机上「provider 成波只服务少数请求」的形态。
    function flakyLlm(n) {
      let calls = 0
      return {
        listProviders: () => [{ id: 'fake', name: 'Fake' }],
        stream(options) {
          calls += 1
          if (calls % (n + 1) !== 0) {
            return (async function* gen() {
              yield failChunk
            })()
          }
          return (async function* gen() {
            yield { type: 'usage', usage: okUsage(options) }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    }

    async function guardRun(llm, overrides, targetCny) {
      const burner = new Burner({ llm, account: null })
      const config = resolveConfig(
        // DEFAULTS.maxAmountCny 保持 1（不配置时的安全兜底）；这里的 ¥5 目标需要显式放开。
        { requestCostCny: 0.01, maxInputTokens: 5000, maxRequests: 500, maxAmountCny: 50, ...overrides },
        targetCny,
      )
      burner.start({ targetCny, model: 'deepseek-flash', provider: 'fake', config })
      const deadline = Date.now() + 25000
      while (burner.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      return burner.status()
    }

    // 注意：status().result 只是粗分类（target-reached / stopped / short），
    // 具体死因在 stopReason 里 —— 断言必须打在 stopReason 上。

    // A. 一路全失败 → 必须停机，理由是「连续失败 + 一直没成功」。
    const a = await guardRun(allFail, { maxConcurrency: 4, maxConsecutiveFailures: 2, stallTimeoutMs: 5000 }, 5)
    assert.equal(a.stopReason, 'stalled', `全失败应当以 stalled 停机，实际 ${a.stopReason}`)
    assert.ok(
      a.warnings.some((w) => w.includes('连续') && w.includes('没有任何一次成功')),
      '停机警告必须同时说明「连续失败几次」与「多久没成功」',
    )

    // B. 每 4 次失败夹 1 次成功 → 失败计数早就越过阈值，但**绝不能**停机。
    //    这是真机事故（¥5 运行 15 秒被杀，只推进 ¥0.085）的回归测试：
    //    旧代码只看连续失败计数，在这个场景里必然误杀整轮。
    const b = await guardRun(flakyLlm(3), { maxConcurrency: 1, maxConsecutiveFailures: 2, stallTimeoutMs: 30000 }, 0.02)
    assert.ok(b.requests.failed > 2, `构造场景失败：只失败了 ${b.requests.failed} 次，没越过阈值`)
    assert.notEqual(b.stopReason, 'stalled', '只要还有零星成功冒出来，就不该判 provider 停服')
    assert.equal(b.result, 'target-reached', `间歇成功时应当跑到目标，实际 ${b.result} / ${b.stopReason}`)
    ok(
      `停机判据带时间闸门：全失败 → stalled（${a.requests.failed} 次失败后）；` +
        `间歇成功 → 失败 ${b.requests.failed} 次仍跑到目标`,
    )
  }

  console.log('\n[4] 预算锁 + 收敛（目标 ¥0.05，容差 ¥0.01）')
  {
    const { s, llm } = await burn({ targetCny: 0.05 })
    console.log(
      `    spent=¥${s.spentCny.toFixed(6)} target=¥${s.targetCny} requests=${s.requests.total} ` +
        `charsPerToken=${s.charsPerToken.toFixed(2)} result=${s.result}`,
    )
    assert.ok(s.spentCny <= s.targetCny + 1e-9, `超支了！spent=${s.spentCny} > target=${s.targetCny}`)
    assert.ok(s.targetCny - s.spentCny <= s.toleranceCny + 1e-9, '应收敛到容差带内')
    assert.equal(s.result, 'target-reached')
    assert.ok(s.requests.ok > 0)
    ok('spent 从未超过 target（结构性防超支）')
    ok(`收敛到容差带内（欠额 ¥${(s.targetCny - s.spentCny).toFixed(6)} ≤ 容差 ¥${s.toleranceCny}）`)
    ok('每次请求的 prompt 前缀唯一 → 缓存必然未命中')
    assert.equal(s.tokens.cacheRead, 0)
    ok('观测到 0 个缓存读 token')
  }

  console.log('\n[5] 比例自学习：第二次运行应更接近估算')
  {
    const first = readStats().charsPerToken
    await burn({ targetCny: 0.03 })
    const second = readStats().charsPerToken
    console.log(`    charsPerToken: ${first.toFixed(3)} → ${second.toFixed(3)}（真值 ${TRUE_CHARS_PER_TOKEN}）`)
    assert.ok(Math.abs(second - TRUE_CHARS_PER_TOKEN) < Math.abs(4 - TRUE_CHARS_PER_TOKEN), '应向真值收敛')
    ok('字符/token 比向真值收敛')
  }

  console.log('\n[6] 余额对账（含赠送余额与 USD 币种）')
  {
    const account = {
      async getBalance() {
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '10.00' }],
          bonusWallets: [{ currency: 'CNY', balance: '2.50' }],
        }
      },
    }
    const { s } = await burn({ targetCny: 0.02, account })
    assert.equal(s.balance.before.total, 12.5)
    assert.equal(s.balance.after.total, 12.5)
    assert.equal(s.balance.deltaCny, 0)
    ok('余额合计 = 充值余额 + 赠送余额')
    ok('余额差被记录（余额不变时 delta=0，drift 揭示估算偏差）')
  }

  console.log('\n[7] 余额查询失败 → 不返回 0，不阻断流程')
  {
    const account = {
      async getBalance() {
        throw new Error('network down')
      },
    }
    const { s } = await burn({ targetCny: 0.01, account })
    assert.ok(s.balance.deltaCny === null, '查询失败时不应给出金额')
    assert.ok(s.warnings.some((w) => w.includes('余额对账不可用')))
    ok('查询失败被区分于「余额为 0」，并有告警')
  }

  console.log('\n[7b] 余额必须按权威形状解析 —— 失败绝不退化成 0')
  {
    // 权威形状：null | { status:'ready', value: Wallet[], bonusWallets: Wallet[] } | { status:'failed' }
    // 真机上曾把 r.balance（不存在）读成 0，于是「有钱」被谎报成「¥0.0000」。
    const withAccount = (getBalance) => {
      const b = new Burner({ llm: makeFakeLlm(), account: { getBalance } })
      return b.balance()
    }

    // ① 多钱包求和 + 币种取自首个充值钱包
    const many = await withAccount(async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '3.25' }, { currency: 'CNY', balance: '1.75' }],
      bonusWallets: [{ currency: 'CNY', balance: '0.5' }],
    }))
    assert.equal(many.total, 5.5, '多个充值钱包必须求和')
    assert.equal(many.balance, 5.0)
    assert.equal(many.currency, 'CNY')
    assert.equal(many.wallets.length, 2)
    ok('ready：多钱包求和，充值 + 赠送 = 总额')

    // ② status:'failed' 必须报错，绝不能是 0
    const failed = await withAccount(async () => ({ status: 'failed' }))
    assert.ok(failed.error, 'status:failed 必须报错而不是返回金额')
    assert.ok(!('total' in failed), 'status:failed 绝不能给出金额字段')
    ok('failed：报错而非 0（账户 README 要求「查询失败不提供金额」）')

    // ③ null（未登录）也必须报错
    const signedOut = await withAccount(async () => null)
    assert.ok(signedOut.error, 'getBalance 返回 null 必须报错')
    assert.ok(!('total' in signedOut))
    ok('null（未登录）：报错而非 0')

    // ④ 旧扁平形状（没有 status）必须被拒绝，而不是静默当成 0
    const legacy = await withAccount(async () => ({ currency: 'CNY', balance: '99.00' }))
    assert.ok(legacy.error, '没有 status 的未知形状必须报错')
    assert.ok(!('total' in legacy), '未知形状绝不能退化成 0')
    ok('未知形状：报错而非静默 0')

    // ⑤ 真的 0 余额必须如实报告为 0（此时 doctor 应给出阻塞问题）
    const zero = await withAccount(async () => ({ status: 'ready', value: [], bonusWallets: [] }))
    assert.equal(zero.total, 0)
    assert.ok(!zero.error, '真的 0 不是错误')
    ok('真 0 余额：如实报 0，且不带 error')
  }

  console.log('\n[8] 硬上限与二次确认（工具层）')
  {
    const { runTool, disclaimer, DISCLAIMER } = await import('../index.js')
    // 免责声明第 2 条必须说**当前生效**的额度，不能写死出厂值 ——
    // 否则改过 maxAmountCny 之后，声明的额度会和 doctor 第 5 节自相矛盾。
    assert.ok(disclaimer(50).includes('¥50'), '免责声明必须反映当前生效的硬上限')
    assert.ok(disclaimer(50).includes('出厂默认 ¥1'), '同时要保留出厂默认值作为对照')
    assert.ok(!disclaimer(50).includes('默认硬上限为 1 元'), '改过上限后不能再声称「默认硬上限为 1 元」')
    assert.ok(disclaimer(0.1).includes('¥0.1') && !disclaimer(0.1).includes('¥0.1000'), '小数上限要用短格式')
    // 占位符必须全部被替换掉 —— 第一版把 `%DEFAULT_CAP%` 写成了 `%DEFAULT_CAP%%`，
    // 渲染出「出厂默认 ¥1%」这种带残渣的句子。
    assert.ok(!disclaimer(50).includes('%'), `占位符没替换干净：${disclaimer(50).split('\n')[2]}`)
    assert.equal(disclaimer(), DISCLAIMER, '缺省参数必须等价于出厂默认下的声明')
    const burner = new Burner({ llm: makeFakeLlm() })
    const config = { maxAmountCny: 1 }
    const denied = await runTool(
      { action: 'start', amountCny: 5, confirm: true },
      { burner, config, defaultSelection: { provider: 'fake', model: 'deepseek-flash' } },
    )
    assert.ok(denied.text.includes('已拒绝执行'), '超过硬上限必须拒绝')
    // 提示必须同时给出两条改法，并把「config 是整体替换」的陷阱说清楚，
    // 否则用户照着「只写一行 maxAmountCny」改 profile patch 会把其他配置静默打回默认值。
    assert.ok(denied.text.includes('cordis.patch.yml'), '必须指出改哪个文件')
    assert.ok(denied.text.includes('必须重启'), '改 bundle patch 必须说明要重启')
    assert.ok(denied.text.includes('整体替换'), '必须警告 config 不是深合并')
    assert.ok(denied.text.includes('requestCostCny'), '必须点名会被打回默认值的配置项')
    const unconfirmed = await runTool(
      { action: 'start', amountCny: 0.5 },
      { burner, config, defaultSelection: { provider: 'fake', model: 'deepseek-flash' } },
    )
    assert.ok(unconfirmed.text.includes('未执行'), '缺少 confirm 必须拒绝')
    const planned = await runTool(
      { action: 'plan', amountCny: 0.5 },
      { burner, config, defaultSelection: { provider: 'fake', model: 'deepseek-flash' } },
    )
    assert.ok(planned.text.includes('风险提示与免责声明'), 'plan 必须带免责声明')
    assert.ok(planned.text.includes('未执行，未产生任何费用'))
    assert.equal(burner.running, false, 'plan 不得启动运行')
    ok('超过硬上限被拒绝')
    ok('缺少 confirm=true 被拒绝')
    ok('plan 带免责声明且不产生运行')
  }

  console.log('\n[8b] 余额预检：确知不足时拒绝，查不到时不阻断')
  {
    const { runTool } = await import('../index.js')
    const cfg = { maxAmountCny: 1 }
    const sel = { provider: 'fake', model: 'deepseek-flash' }
    const wallet = (normal, bonus) => ({
      status: 'ready',
      value: normal === null ? [] : [{ currency: 'CNY', balance: String(normal) }],
      bonusWallets: [{ currency: 'CNY', balance: String(bonus) }],
    })

    // ① 余额充足 → 允许
    const rich = new Burner({ llm: makeFakeLlm(), account: { getBalance: async () => wallet(50, 10) } })
    const started = await runTool({ action: 'start', amountCny: 0.05, confirm: true }, { burner: rich, config: cfg, defaultSelection: sel })
    assert.ok(!started.text.includes('已拒绝执行'), '余额充足时不应拒绝')
    assert.ok(started.text.includes('当前余额'), '应附上余额提示')
    await rich.stop({ reason: 'smoke' })

    // ② 余额不足 → 拒绝，且一次请求都不发
    let requests = 0
    const poorLlm = makeFakeLlm()
    const countingLlm = { ...poorLlm, stream: (...a) => { requests += 1; return poorLlm.stream(...a) } }
    const poor = new Burner({ llm: countingLlm, account: { getBalance: async () => wallet(0.01, 0) } })
    const denied = await runTool({ action: 'start', amountCny: 0.5, confirm: true }, { burner: poor, config: cfg, defaultSelection: sel })
    assert.ok(denied.text.includes('余额不足'), '余额不足必须拒绝')
    assert.ok(denied.text.includes('ACCOUNT_QUOTA'), '应说明拒绝理由')
    assert.equal(poor.running, false, '被拒绝时不得启动运行')
    assert.equal(requests, 0, '被拒绝时绝不能发出任何请求')
    ok('余额不足：拒绝执行且零请求（不白跑一次）')

    // ③ 余额查不到 → 不阻断，但要有醒目告警
    const blind = new Burner({ llm: makeFakeLlm(), account: { getBalance: async () => ({ status: 'failed' }) } })
    const warned = await runTool({ action: 'start', amountCny: 0.03, confirm: true }, { burner: blind, config: cfg, defaultSelection: sel })
    assert.ok(!warned.text.includes('已拒绝执行'), '余额查询失败不应阻断（余额不是运行前提）')
    assert.ok(warned.text.includes('余额预检不可用'), '必须给出醒目告警')
    await blind.stop({ reason: 'smoke' })
    ok('余额查询失败：不阻断但明确告警')
  }

  console.log('\n[8c] 余额括号结算延迟：差额 0 必须标记为不可信，而不是被读成「没花钱」')
  {
    // 真机实测：跑完 9 秒后复读余额，before 与 after 一模一样（63.19010394 → 63.19010394），
    // 但账本记了 ¥0.0952。旧代码只会把 driftCny 算成负值，不给任何提示。
    const frozen = { status: 'ready', value: [{ currency: 'CNY', balance: '63.19010394' }], bonusWallets: [] }
    const acct = { async getBalance() { return frozen } }
    const { s } = await burn({ targetCny: 0.05, account: acct })
    assert.ok(s.spentCny > 0, '假 LLM 必须真的花了钱，否则这个用例没意义')
    assert.equal(s.balance.deltaCny, 0, '冻结的余额接口 → 差额必须是 0')
    assert.equal(s.balance.settled, false, '差额 0 而花费 > 0 → settled 必须是 false')
    assert.ok(
      s.warnings.some((w) => w.includes('不可信')),
      `必须有「余额括号不可信」的告警，实际 warnings=${JSON.stringify(s.warnings)}`,
    )
    ok('余额括号冻结时 settled=false 且给出告警（不会被误读成「没花钱」）')
  }

  console.log('\n[8d] reconcile：复读余额与运行起始余额对账')
  {
    // 每读一次余额就往下掉 0.05，模拟「结算延迟过去之后」的样子。
    let bal = 10
    const acct = {
      async getBalance() {
        const v = bal
        bal -= 0.05
        return { status: 'ready', value: [{ currency: 'CNY', balance: v.toFixed(8) }], bonusWallets: [] }
      },
    }
    const { burner: rb, s, config: cfg } = await burn({ targetCny: 0.05, account: acct })
    const rec = await rb.reconcile()
    assert.equal(rec.runId, s.runId, 'reconcile 默认应对最近一次运行')
    assert.equal(rec.ledgerCny, s.spentCny, '账本金额应与运行快照一致')
    assert.ok(Math.abs(rec.before.total - 10) < 1e-9, `起始余额应为 10，实际 ${rec.before?.total}`)
    assert.ok(rec.now.total < rec.before.total, '复读到的余额应更低')
    assert.ok(
      Math.abs(rec.rawDeltaCny - (rec.before.total - rec.now.total)) < 1e-9,
      'rawDeltaCny 必须等于起始与当前的差额',
    )
    // 这次余额**真的动了**（每次读都掉 0.05），且降幅 ≥ 账本花费 → 括号可信。
    assert.equal(rec.bracketSettled, true, '余额真的动了且降幅覆盖账本 → 括号应判为可信')
    // 未知 runId 不能抛
    const empty = await rb.reconcile('burn-does-not-exist')
    assert.ok(empty.error || empty.before === null, '未知 runId 不应抛异常')
    ok(`reconcile 复读对账可用（原始差额 ¥${rec.rawDeltaCny.toFixed(6)}，账本 ¥${rec.ledgerCny.toFixed(6)}）`)

    // 渲染层：这个分支会读 rec.before.total / rec.now.total，任何一处为 undefined 都会输出 NaN。
    const { runTool } = await import('../index.js')
    const sel = { provider: 'fake', model: 'deepseek-flash' }
    const rendered = await runTool({ action: 'reconcile' }, { burner: rb, config: cfg, defaultSelection: sel })
    const text = typeof rendered === 'string' ? rendered : rendered.text
    for (const bad of ['NaN', 'undefined', '[object Object]', '$`']) {
      assert.ok(!text.includes(bad), `对账渲染不应出现 ${bad}：\n${text}`)
    }
    assert.ok(text.includes('这个差额是脏的'), '必须警告差额是脏的')
    assert.ok(text.includes(s.runId), '渲染里应带上 runId')

    // 没有起始余额记录时走降级分支，而不是崩在 rec.before.total 上。
    const bare = {
      async reconcile() {
        return {
          runId: 'burn-x', targetCny: 0.1, ledgerCny: 0.05,
          before: null, now: { currency: 'CNY', total: 1 }, rawDeltaCny: 0,
          elapsedMs: 1000, bracketSettled: null,
        }
      },
    }
    const degraded = await runTool({ action: 'reconcile' }, { burner: bare, config: cfg, defaultSelection: sel })
    const dText = typeof degraded === 'string' ? degraded : degraded.text
    assert.ok(dText.includes('没有可用的'), `无起始余额时应走降级分支，实际：${dText}`)
    assert.ok(!dText.includes('NaN') && dText.includes('¥0.05'), '降级分支仍要给出账本金额')
    ok('对账渲染无 NaN/undefined，且缺少起始余额时优雅降级')

    // 旧账本（没有 settled 字段的那几代）必须能从存下来的括号反推，否则真机上
    // burn-20261015-025631-2y5f 那种「差额 0 但花了钱」的历史运行会被当成可信 —— 正是踩过的坑。
    const legacyId = 'burn-legacy-settled-test'
    appendRecord(legacyId, {
      kind: 'start', at: new Date().toISOString(), targetCny: 0.1,
    })
    appendRecord(legacyId, {
      kind: 'finish', at: new Date().toISOString(), spentCny: 0.095214,
      balance: {
        before: { currency: 'CNY', total: 63.19010394, at: new Date(Date.now() - 60000).toISOString() },
        after: { currency: 'CNY', total: 63.19010394 },
        deltaCny: 0,                    // ← 结算延迟造成的假 0
      },
    })
    const legacyRec = await rb.reconcile(legacyId)
    assert.equal(legacyRec.bracketSettled, false, '旧账本里「差额 0 但花了钱」必须反推为不可信')
    assert.equal(legacyRec.bracketSettledSource, 'inferred', '来源应标记为反推')
    assert.equal(legacyRec.snapshotDeltaCny, 0, '应带回快照原始差额')
    const legacyText = (await runTool({ action: 'reconcile', runId: legacyId }, { burner: rb, config: cfg, defaultSelection: sel })).text
    assert.ok(legacyText.includes('不可信'), `旧账本反推后必须给出不可信提示：${legacyText}`)
    assert.ok(legacyText.includes('反推'), '应说明这个判断是反推的')
    assert.ok(!legacyText.includes('NaN'), '反推分支同样不能出现 NaN')
    ok('旧账本缺 settled 字段时按括号反推，不会把假 0 当成「没花钱」')
  }

  console.log('\n[9] 审计日志')
  {
    const runs = listRuns(20)
    assert.ok(runs.length > 0, '应有运行记录')
    // 挑一条真正发过请求的运行（容差 ≥ 目标的运行可能一次请求都不发，这是正确行为）
    let target = null
    for (const r of runs) {
      const rec = readRun(r.runId)
      if (rec.records.some((x) => x.kind === 'request')) {
        target = { runId: r.runId, rec }
        break
      }
    }
    assert.ok(target, '应至少有一条含请求记录的运动')
    const { rec } = target
    assert.ok(rec.records.some((r) => r.kind === 'start'))
    assert.ok(rec.records.some((r) => r.kind === 'finish'))
    const req = rec.records.find((r) => r.kind === 'request')
    assert.ok(req.usage && typeof req.costCny === 'number')
    console.log(`    ${target.runId}: ${rec.records.filter((r) => r.kind === 'request').length} 条请求记录`)
    ok('start/finish/request 三类记录齐全，含 usage 与单次费用')
  }

  console.log('\n[9b] 容差不得超过目标一半（否则一次请求都不发）')
  {
    const { s, llm } = await burn({ targetCny: 0.01 })
    assert.ok(s.requests.total > 0, '目标 ¥0.01 时也应真正发出请求')
    assert.ok(s.spentCny <= 0.01 + 1e-9)
    console.log(`    target=¥0.01 tolerance=¥${s.toleranceCny} requests=${s.requests.total} spent=¥${s.spentCny.toFixed(6)}`)
    ok('小额目标不会被容差吃掉')
  }

  console.log('\n[10] 停机路径')
  {
    const llm = makeFakeLlm()
    const burner = new Burner({ llm })
    const config = resolveConfig(
      { requestCostCny: 0.001, maxConcurrency: 2, maxInputTokens: 20000, maxAmountCny: 100 },
      100,
    )
    burner.start({ targetCny: 100, model: 'deepseek-flash', provider: 'fake', config })
    await new Promise((r) => setTimeout(r, 60))
    burner.stop('smoke-test')
    const s0 = burner.status()
    assert.ok(['stopping', 'stopped'].includes(s0.state), `state=${s0.state}`)
    const deadline = Date.now() + 10000
    while (burner.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    const s = burner.status()
    assert.equal(s.state, 'stopped')
    assert.equal(s.stopReason, 'smoke-test')
    assert.ok(s.spentCny < 100, '停机后不应继续把钱烧到目标')
    console.log(`    停机时 spent=¥${s.spentCny.toFixed(6)} requests=${s.requests.total}`)
    ok('优雅停机生效，state=stopped，未继续烧到目标')
  }

  console.log('\n[10b] 停机宽限期必须读**本轮配置**（不能拿 DEFAULTS 顶替）')
  {
    // 回归：stop() 里曾写死 setTimeout(..., DEFAULTS.gracefulStopMs)，
    // 于是 gracefulStopMs 配置项被静默忽略（宽限期永远 15 秒）。
    const hangLlm = {
      calls: 0,
      listProviders: () => [{ id: 'fake', name: 'Fake' }],
      async resolveModelInfo(provider, model) {
        return { provider, id: model, name: model, context: { contextWindow: 1000000 }, inputModalities: ['text'] }
      },
      stream(options) {
        this.calls += 1
        const signal = options.signal
        return (async function* gen() {
          await new Promise((_, reject) => {
            const die = () => reject(new Error('aborted'))
            if (signal?.aborted) return die()
            signal?.addEventListener('abort', die, { once: true })
          })
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
        })()
      },
    }
    const burner = new Burner({ llm: hangLlm, account: null })
    // requestTimeoutMs: 0 → 单请求超时**关掉**，只剩停机宽限期这一条路
    const config = resolveConfig(
      { requestCostCny: 0.01, maxConcurrency: 2, maxInputTokens: 20000, requestTimeoutMs: 0, gracefulStopMs: 150, maxConsecutiveFailures: 99 },
      0.05,
    )
    assert.equal(config.gracefulStopMs, 150, 'gracefulStopMs 必须被保留')
    assert.equal(config.requestTimeoutMs, 0, 'requestTimeoutMs=0 表示不限，不该被夹成别的值')
    burner.start({ targetCny: 0.05, model: 'deepseek-flash', provider: 'fake', config })
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(burner.status().state, 'running', '在途请求应还挂着（provider 卡死）')
    const t0 = Date.now()
    burner.stop('grace-test')
    const deadline = Date.now() + 10000
    while (burner.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    const elapsed = Date.now() - t0
    assert.ok(!burner.running, `停机宽限期后必须真的中止在途请求（等了 ${elapsed}ms）`)
    assert.ok(elapsed < 3000, `宽限期 150ms，实际用了 ${elapsed}ms —— 说明没读配置，用的还是 DEFAULTS 的 15 秒`)
    ok(`stop() 按配置的 ${config.gracefulStopMs}ms 宽限期强制中止（实测 ${elapsed}ms）`)
  }

  console.log('\n[11] 注册链路（用 stub ctx 模拟 cordis，验证注册契约）')
  {
    const { apply, name, inject, TOOL_NAME: TN } = await import('../index.js')
    assert.equal(name, 'token-burner')
    assert.deepEqual(inject, ['tools', 'llm'], 'inject 必须声明 tools 与 llm')

    const registered = []
    const effects = []
    const warnings = []
    const infos = []
    let disposed = false
    // 模拟真实的 cordis 加载顺序：账户服务在 apply() 期间**还不存在**
    // （PlatformAccount 有 static inject = ["credentials","authorization"]，apply 被推迟），
    // 加载完成后才注册。这正是 hasAccountAtLoad=false 的原因。
    let applyFinished = false
    // 记录 getBalance 收到的 client 身份 —— 漏传它会炸在
    // "Cannot read properties of undefined (reading 'version')"。
    let balanceClient = 'NOT-CALLED'
    const fakeAccount = {
      getBalance: async (client) => {
        balanceClient = client
        // 权威形状：{ status:'ready', value: Wallet[], bonusWallets: Wallet[] }
        // （dsh-api-account-controller/lib/typert.host.js 的 getBalance result）。
        // ⚠️ 这里以前写成扁平的 { currency, balance }，把插件里「误读 r.balance」的
        //    bug 一起掩盖了 —— 假数据必须长得跟真的一样。
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '12.3456' }],
          bonusWallets: [{ currency: 'CNY', balance: '1.0000' }],
        }
      },
    }
    const stubCtx = {
      logger: {
        warn: (m) => warnings.push(m),
        info: (m) => infos.push(m),
        error: () => {},
      },
      llm: makeFakeLlm(),
      get: (svc) => {
        if (svc === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'deepseek-flash' }) }
        // 只在加载完成后才可见 —— 惰性解析必须能拿到它
        if (svc === 'deepseekAccount') return applyFinished ? fakeAccount : undefined
        return undefined
      },
      tools: {
        register: (def) => {
          registered.push(def)
        },
      },
      effect: (fn) => {
        effects.push(fn)
      },
    }

    apply(stubCtx, { maxAmountCny: 0.5, requestCostCny: 0.005, maxConcurrency: 2, maxInputTokens: 5000 })
    applyFinished = true // 加载完成，账户服务此后才出现

    assert.equal(registered.length, 1, '应恰好注册一个工具')
    const def = registered[0]
    assert.equal(def.name, TN)
    assert.equal(typeof def.execute, 'function')
    assert.equal(typeof def.timeoutMs, 'number')
    assert.equal(def.isConcurrencySafe, false, '预算锁假设独占，必须非并发安全')
    assert.equal(def.output.schema.type, 'object')
    assert.equal(typeof def.output.render, 'function')
    assert.deepEqual(def.parameters.required, ['action'])
    assert.ok(def.parameters.additionalProperties === false)
    for (const key of Object.keys(def.parameters.properties)) {
      if (key === 'action') continue
      assert.ok(def.parameters.properties[key].description, `参数 ${key} 必须有 description`)
    }
    ok('apply() 注册了唯一工具，形状符合 register() 契约')
    ok('parameters 全部带 description（模型才看得懂参数）')
    ok('isConcurrencySafe=false（预算锁独占）')

    // description 必须自带风险提示，否则 agent 不会主动警告用户
    assert.ok(def.description.includes('真实扣费'), '工具描述必须包含真实扣费警告')
    assert.ok(def.description.includes('confirm=true'))
    assert.ok(def.description.includes('plan'), '应引导先 plan')
    ok('工具描述内嵌风险提示与 confirm 要求')

    // 渲染契约
    const rendered = def.output.render({ action: 'plan' }, { text: 'X' })
    assert.deepEqual(rendered, [{ type: 'text', text: 'X' }])
    assert.equal(def.output.render({}, null)[0].type, 'text')
    ok('output.render 返回 [{type:"text",text}] 形状')

    // 通过真实注册对象执行一次 plan（不花钱）
    const res = await def.execute({ action: 'plan', amountCny: 0.3 }, {})
    assert.ok(res.text.includes('未执行，未产生任何费用'))
    assert.ok(res.text.includes('风险提示与免责声明'))
    ok('经注册对象执行 plan：出计划且不花钱')

    // 加载期看不到账户服务 → 只能记 info，绝不能抛错或阻塞加载
    assert.ok(
      infos.some((m) => m.includes('deepseekAccount')),
      '加载期看不到账户服务时必须留下提示',
    )
    ok('加载期账户服务缺席：提示但不阻断加载')

    // ── doctor：零成本预检 ────────────────────────────────────────────────
    const doc = await def.execute({ action: 'doctor' }, {})
    assert.ok(doc.text.includes('零成本'), 'doctor 必须说明自己没有花钱')
    assert.ok(doc.text.includes('未发起任何模型调用'))
    assert.ok(doc.text.includes('ctx.llm'), 'doctor 必须报告 llm 服务状态')
    assert.ok(doc.text.includes('✅ 可用'), 'doctor 应报告服务可用')
    // 惰性解析的核心回归断言：加载期缺席、运行期必须可见
    assert.ok(
      doc.text.includes('deepseekAccount') && !doc.text.includes('运行期仍不可见'),
      'doctor 必须证明账户服务在运行期已可见（惰性解析生效）',
    )
    ok('doctor：账户服务惰性解析生效（加载期缺席 → 运行期可见）')

    // 余额对账（含赠送钱包加总）
    assert.ok(doc.text.includes('12.3456'), 'doctor 必须读到充值钱包余额')
    assert.ok(doc.text.includes('1.0000'), 'doctor 必须读到赠送钱包余额')
    assert.ok(doc.text.includes('13.3456'), '总余额必须是两个钱包之和')
    ok('doctor：余额读取成功且把赠送钱包加总')

    // getBalance(client) 的身份参数 —— 真机就是栽在这里（reading 'version'）
    assert.notStrictEqual(balanceClient, 'NOT-CALLED', 'doctor 必须真的调用 getBalance')
    assert.ok(balanceClient && typeof balanceClient === 'object', 'getBalance 必须收到客户端身份对象')
    assert.ok(
      typeof balanceClient.version === 'string' && balanceClient.version.length > 0,
      'client.version 必须是非空字符串（否则炸在 reading version）',
    )
    assert.ok(typeof balanceClient.locale === 'string' && balanceClient.locale.length > 0, 'client.locale 必须是非空字符串')
    assert.strictEqual(typeof balanceClient.timezoneOffsetSeconds, 'number', 'client.timezoneOffsetSeconds 必须是数字')
    assert.ok(Number.isFinite(balanceClient.timezoneOffsetSeconds), '时区偏移不能是 NaN')
    ok('doctor：getBalance 收到完整客户端身份（version/locale/timezoneOffsetSeconds）')

    // 路由校验：必须走真实字段路径 context.contextWindow / reasoning.efforts
    assert.ok(doc.text.includes('resolveModelInfo'), 'doctor 必须做零成本路由校验')
    assert.ok(doc.text.includes('1000000') || doc.text.includes('1,000,000'), 'doctor 必须从 context.contextWindow 读到真实窗口')
    assert.ok(!doc.text.includes('NaN'), 'doctor 输出里不能出现 NaN（字段路径写错的典型症状）')
    assert.ok(!doc.text.includes('[object Object]'), 'doctor 输出里不能出现 [object Object]（efforts 是对象数组）')
    assert.ok(doc.text.includes('`off`') && doc.text.includes('`max`'), 'doctor 必须列出 reasoning efforts 的 id')
    assert.ok(doc.text.includes('maxInputTokens'), 'doctor 必须校验 maxInputTokens 与 contextWindow')
    assert.ok(doc.text.includes('所有预检项通过'), '全部就绪时结论必须是"通过"')
    ok('doctor：路由存在 + maxInputTokens 未超窗口 + 结论为通过')

    // 并发说明必须与实际是否被压低一致。此处的配置是
    // ¥0.5 ÷ ¥0.005 = 100 ≥ maxConcurrency 2，**没有**被预算锁压低 ——
    // 这时还喊「会被压低」是噪声，会让人忽略真正被压的小目标场景。
    assert.ok(
      doc.text.includes('预算锁不会压低满额并发'),
      '满额并发没被压低时必须如实说「不会」，而不是照本宣科地喊警告',
    )
    assert.ok(
      !doc.text.includes('算只有 2（上限是 2）'),
      '不能被压低却报「只有 2（上限是 2）」这种自相矛盾的句子',
    )
    assert.ok(doc.text.includes('小目标仍会被压'), '同时必须提醒小目标仍会被预算锁压制')
    ok('doctor：并发说明与实际是否被压低一致（不会被压低时不误报）')

    // 无效 provider → doctor 必须报出阻塞问题
    const docBad = await def.execute({ action: 'doctor', provider: 'nope', model: 'x' }, {})
    assert.ok(docBad.text.includes('阻塞问题'), '无效 provider 必须报阻塞')
    assert.ok(docBad.text.includes('先不要跑 start'), '有阻塞问题时必须阻止 start')
    ok('doctor：无效 provider 被识别为阻塞问题')

    // 可选依赖缺失 → 必须有告警，但不能抛
    assert.equal(effects.length, 1, '必须注册一个 effect 用于卸载清理')
    const cleanup = effects[0]()
    assert.equal(typeof cleanup, 'function', 'effect 必须返回 dispose 函数')
    cleanup()
    ok('ctx.effect 注册了卸载清理（避免孤儿请求继续花钱）')
    void disposed
  }

  console.log(`\n全部通过：${pass} 项断言组。\n`)
}

main().catch((err) => {
  console.error('\n❌ 冒烟测试失败：', err)
  process.exit(1)
})

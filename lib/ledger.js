/**
 * ledger.js — 审计日志与本地学习统计（零依赖，只用 node: 内置模块）。
 *
 * 目录布局（默认 $DSH_HOME 或 ~/.dsh）：
 *   <home>/token-burner/runs/<runId>.jsonl   每次运行一行一记录，append-only
 *   <home>/token-burner/stats.json           跨运行学习到的经验常数
 *
 * ⚠️ 设计原则：**记账失败绝不能让烧钱流程崩溃**，也不能影响金额判定。
 *    所有磁盘操作都包在 try/catch 里，失败只记一条 warning。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function rootDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'token-burner')
}

export function runsDir() {
  return path.join(rootDir(), 'runs')
}

export function statsPath() {
  return path.join(rootDir(), 'stats.json')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * runId 会被直接拼进文件路径，而 `reconcile` 的 `runId` **来自工具参数**，
 * 所以必须净化：否则 `runId: "../../../../tmp/x"` 能读到 runs 目录外的 `*.jsonl`。
 * 合法的 runId 是插件自己生成的 `burn-<时间戳>-<4 位随机>`，字符集很窄。
 * 注意 `..` 本身也在允许字符集里，所以额外单独禁掉。
 */
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

export function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId) && !runId.includes('..')
}

/** 追加一条运行记录（JSONL）。返回 null 表示写入失败（已吞掉异常）。 */
export function appendRecord(runId, record) {
  if (!isValidRunId(runId)) return `非法的 runId：${JSON.stringify(runId)}`
  try {
    const dir = runsDir()
    ensureDir(dir)
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
    fs.appendFileSync(path.join(dir, `${runId}.jsonl`), line, 'utf8')
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function readRun(runId) {
  // 非法 runId 一律当作「没有这个运行」，绝不拿它去拼路径。
  if (!isValidRunId(runId)) return { runId, records: [], invalid: true }
  try {
    const file = path.join(runsDir(), `${runId}.jsonl`)
    const text = fs.readFileSync(file, 'utf8')
    const records = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        /* 忽略损坏行 */
      }
    }
    return { runId, records }
  } catch {
    return { runId, records: [] }
  }
}

export function listRuns(limit = 20) {
  try {
    const dir = runsDir()
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(dir, f)
        let mtime = 0
        try {
          mtime = fs.statSync(full).mtimeMs
        } catch {
          /* 忽略 */
        }
        return { runId: f.replace(/\.jsonl$/, ''), mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
    return files
  } catch {
    return []
  }
}

const DEFAULT_STATS = {
  charsPerToken: 4,
  // 故意取得保守：这两个值只影响**第一次**的计划估计，之后会被实测值取代。
  prefillTokensPerSec: 3000,
  decodeTokensPerSec: 40,
  samples: 0,
  updatedAt: null,
}

/**
 * 记录一次插件加载。
 * 对「会花钱的插件」来说这不是噪声而是审计线索：能回答"这个插件是什么时候被加载进来的"。
 * 也用于验证 Link/HMR 是否真的生效（加载后本文件应立刻出现新行）。
 */
export function appendLoadMarker(record) {
  try {
    ensureDir(rootDir())
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
    fs.appendFileSync(path.join(rootDir(), 'plugin-load.jsonl'), line, 'utf8')
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function readLoadMarkers(limit = 20) {
  try {
    const text = fs.readFileSync(path.join(rootDir(), 'plugin-load.jsonl'), 'utf8')
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .slice(-limit)
  } catch {
    return []
  }
}

export function readStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(statsPath(), 'utf8'))
    return { ...DEFAULT_STATS, ...raw }
  } catch {
    return { ...DEFAULT_STATS }
  }
}

export function writeStats(patch) {
  try {
    ensureDir(rootDir())
    const next = { ...readStats(), ...patch, updatedAt: new Date().toISOString() }
    fs.writeFileSync(statsPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** 指数滑动平均更新一个经验常数并落盘。 */
export function learn(key, sample, weight = 0.3) {
  if (!Number.isFinite(sample) || sample <= 0) return readStats()
  const cur = readStats()
  const base = Number.isFinite(cur[key]) && cur[key] > 0 ? cur[key] : sample
  const value = base * (1 - weight) + sample * weight
  writeStats({ [key]: value, samples: (cur.samples ?? 0) + 1 })
  return readStats()
}

export { DEFAULT_STATS }

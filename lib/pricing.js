/**
 * pricing.js — 官方价格表 + 高峰/空闲时段判定 + 计价。
 *
 * 数据来源：DeepSeek 官方「模型 & 价格」页（¥ / 百万 tokens）。
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *
 *   高峰时段 = 北京时间周一至周五 09:00-12:00、14:00-18:00（不含中国法定节假日）
 *   其余时段（含周末与法定节假日全天）价格减半。
 *   扣费规则 = token 消耗量 × 单价，优先扣减「赠送余额」。
 *
 * ⚠️ 风险提示
 *   - 价格随时可能变动，本表是快照，不保证与你的实际账单一致。
 *   - 法定节假日判定是近似实现（holidays 为空时，工作日的节假日会被当成高峰）。
 *   - 无法确定时一律按「高峰价」计算 —— 这是**保守方向**：高估单价 → 同一笔预算
 *     买到的 token 更少 → 只会欠额，由主循环迭代补齐，不会超支。
 *
 * 本文件零依赖，只做纯计算。
 */

/** 单位：人民币元 / 百万 tokens。deepseek-flash 的旧模型名按 Flash 计费。 */
export const PRICE_TABLE = {
  'deepseek-flash': {
    peak: { inMiss: 2, hit: 0.04, out: 8, cacheWrite: 0 },
    off: { inMiss: 1, hit: 0.02, out: 4, cacheWrite: 0 },
  },
  'deepseek-v4-pro': {
    peak: { inMiss: 9, hit: 0.3, out: 27, cacheWrite: 0 },
    off: { inMiss: 4.5, hit: 0.15, out: 13.5, cacheWrite: 0 },
  },
}

/** 旧名/别名 → 现名。旧模型名仍可调用，但由 V4.1-Flash 提供服务并按 Flash 价计费。 */
const ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
}

/** 未知模型时的兜底：取表内**最贵**的一档，宁可高估也不超支。 */
const FALLBACK_MODEL = 'deepseek-v4-pro'

export function canonicalModel(model) {
  const id = typeof model === 'string' ? model.trim() : ''
  return ALIASES[id] ?? id
}

/** 把任意 Date 转成北京时间的日历分量（不依赖宿主机时区）。 */
export function beijingParts(date) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000)
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    weekday: t.getUTCDay(), // 0=周日 … 6=周六
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
  }
}

export function beijingDateKey(date) {
  const p = beijingParts(date)
  const mm = String(p.month).padStart(2, '0')
  const dd = String(p.day).padStart(2, '0')
  return `${p.year}-${mm}-${dd}`
}

/** 高峰时段判定。holidays: 'YYYY-MM-DD' 数组（北京时间）。 */
export function isPeak(date, holidays = []) {
  const p = beijingParts(date)
  if (p.weekday === 0 || p.weekday === 6) return false // 周末全天空闲
  const set = holidays instanceof Set ? holidays : new Set(holidays)
  if (set.has(beijingDateKey(date))) return false // 法定节假日全天空闲
  return (p.hour >= 9 && p.hour < 12) || (p.hour >= 14 && p.hour < 18)
}

/**
 * 取某模型在某一时刻的单价。
 * @returns {{model:string, known:boolean, peak:boolean, tier:'peak'|'off',
 *            inMiss:number, hit:number, out:number, cacheWrite:number,
 *            unit:{inMiss:number, hit:number, out:number, cacheWrite:number}}}
 *           inMiss/hit/out/cacheWrite 单位为「元 / 百万 tokens」；
 *           unit.* 为「元 / token」。
 */
export function priceFor(model, { date = new Date(), holidays = [] } = {}) {
  const id = canonicalModel(model)
  const known = Object.prototype.hasOwnProperty.call(PRICE_TABLE, id)
  const table = PRICE_TABLE[known ? id : FALLBACK_MODEL]
  const peak = isPeak(date, holidays)
  const rates = peak ? table.peak : table.off
  return {
    model: id,
    known,
    peak,
    tier: peak ? 'peak' : 'off',
    ...rates,
    unit: {
      inMiss: rates.inMiss / 1e6,
      hit: rates.hit / 1e6,
      out: rates.out / 1e6,
      cacheWrite: rates.cacheWrite / 1e6,
    },
  }
}

/**
 * 逐 token 精确计价 —— 与 harness 的 usage 字段一一对应。
 *   inputTokens        → 非缓存输入（按「缓存未命中」计价）
 *   cacheReadTokens    → 缓存命中读取
 *   cacheWriteTokens   → 缓存写入（DeepSeek 不单独收费）
 *   outputTokens       → 输出
 * 返回人民币元。
 */
export function costCny(usage, price) {
  const u = usage ?? {}
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0)
  return (
    num(u.inputTokens) * price.unit.inMiss +
    num(u.cacheReadTokens) * price.unit.hit +
    num(u.cacheWriteTokens) * price.unit.cacheWrite +
    num(u.outputTokens) * price.unit.out
  )
}

/** 下一个高峰/空闲时段切换时刻（北京时间），用于「等到空闲时段」类提示。 */
export function nextTierChange(date, holidays = []) {
  const peak = isPeak(date, holidays)
  // ⚠️ isPeak 内部经 beijingParts 已经做过一次 +8h 换算，这里**绝不能再预先平移**，
  // 否则就是 +16h 的双重平移（症状：任何时刻都回报「0 分钟后切换档位」）。
  for (let i = 1; i < 60 * 24 * 8; i += 1) {
    const probe = new Date(date.getTime() + i * 60 * 1000)
    if (isPeak(probe, holidays) !== peak) {
      return { at: probe, becomesPeak: !peak }
    }
  }
  return null
}

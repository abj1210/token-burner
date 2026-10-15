/**
 * filler.js — 本地生成「新鲜」的填充语料（零依赖、零 API 成本）。
 *
 * 为什么需要它：
 *   烧钱最快的通道是「输入·缓存未命中」。DeepSeek 的前缀缓存按最长公共前缀命中，
 *   缓存命中价（¥0.04/M）比未命中（¥2/M）便宜 50 倍 —— 一旦前缀被复用，
 *   烧钱速度会掉 1.5~2 个数量级。
 *   → 所以每次请求都在**最前面**放一个全新的随机 nonce，其余部分也用随机语料填充。
 *
 * 为什么用纯 ASCII 英文单词：
 *   字符→token 的比值必须稳定，主循环才能靠它把「剩余金额」换算成「要填多少字符」。
 *   中英混排、十六进制串的比值波动很大；常见英文单词大约 1 词 1 token，很稳定。
 *
 * ⚠️ 注意：初值 DEFAULT_CHARS_PER_TOKEN = 4 是**故意低估**的（真实英文约 5.5~6）。
 *    低估 → 同样目标 token 数会生成更少的字符 → 实际 token 少于预期 → 欠额。
 *    欠额可以由主循环迭代补齐，超支不能。保守方向永远选欠额。
 */

export const DEFAULT_CHARS_PER_TOKEN = 4

/** 常见英文单词（都很短，BPE 下基本 1 词 ≈ 1 token）。 */
const WORDS = (
  'the of and to in a is that it for as with was his he be on at by have this from or one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no than been its who now people my over did down only way find water long little very after words called just where most know get through back much before go good new write our used me man too any day same right look think also around another came come work three must because does part even place well such here take why things help put years different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always show large often together asked house dont world going want school important until form food keep children feet land side without boy once animals life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light country father let night following picture being study second soon story since white ever paper hard near sentence better best across during today however sure knew try told young sun thing whole hear example heard several change answer room against top turned learn point city play toward five himself usually money seen didn car morning i body upon family later turn move face door cut done group true half red fish plants living black eat short united run book gave order open ground cold really table remember tree course front american space inside ago sad early i school important'
).split(/\s+/).filter(Boolean)

function pick(n) {
  let s = ''
  for (let i = 0; i < n; i += 1) s += `${WORDS[(Math.random() * WORDS.length) | 0]} `
  return s
}

/** 随机 nonce：放在 prompt 最前面，保证前缀缓存必然未命中。 */
export function makeNonce() {
  const a = Math.random().toString(36).slice(2)
  const b = Math.random().toString(36).slice(2)
  const c = Date.now().toString(36)
  return `${c}-${a}${b}`
}

const INSTRUCTION = '下面是一段随机语料。请只回复一个词：OK。不要复述语料。'

/**
 * 构造一次烧钱请求的 prompt。
 * @param {{tokens:number, charsPerToken?:number, nonce?:string}} opts
 * @returns {{text:string, nonce:string, bodyChars:number}}
 */
export function buildPrompt({ tokens, charsPerToken = DEFAULT_CHARS_PER_TOKEN, nonce = makeNonce() }) {
  const targetTokens = Math.max(1, Math.floor(tokens))
  const ratio = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN
  const head = `[nonce:${nonce}] ${INSTRUCTION}\n\n`
  const targetChars = Math.max(0, Math.round(targetTokens * ratio) - head.length)

  const parts = []
  let len = 0
  while (len < targetChars) {
    const chunk = pick(256)
    parts.push(chunk)
    len += chunk.length
  }
  let body = parts.length === 1 ? parts[0] : parts.join('')
  if (body.length > targetChars) body = body.slice(0, targetChars)

  return { text: head + body, nonce, bodyChars: body.length }
}

/**
 * 用实测 usage 反推字符→token 比，并做指数滑动平均。
 * @param {number} prev 上一轮的 charsPerToken
 * @param {number} chars 本次 prompt 的字符数
 * @param {number} observedTokens 本次 usage.inputTokens + cacheReadTokens
 * @param {number} weight 新样本权重
 */
export function updateCharsPerToken(prev, chars, observedTokens, weight = 0.4) {
  if (!Number.isFinite(chars) || chars <= 0) return prev
  if (!Number.isFinite(observedTokens) || observedTokens <= 0) return prev
  const sample = chars / observedTokens
  const base = Number.isFinite(prev) && prev > 0 ? prev : DEFAULT_CHARS_PER_TOKEN
  const next = base * (1 - weight) + sample * weight
  return Math.min(12, Math.max(2, next))
}

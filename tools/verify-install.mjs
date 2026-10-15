/**
 * tools/verify-install.mjs — 校验插件在 Desktop profile 里能否被正确解析与加载。
 *
 * **只读**：不联网、不花钱、不改任何文件。
 * 检查项：
 *   1) profile 能从自己的 node_modules 解析到 @local/token-burner（link: 是否生效）
 *   2) 包清单满足 DSH 的「是不是插件」判据（dsh.bundle.patch / dsh.client.platform）
 *   3) cordis.patch.yml 结构正确，row 的 name 等于包名、id 唯一
 *   4) index.js 能真的 import 出来，且导出 name / inject / apply
 *   5) client.js 语法正确
 *
 * 用法：node tools/verify-install.mjs [profileDir]
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROFILE_DIR = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const PKG = '@local/token-burner'

let failed = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failed += 1
  console.log(`  ✗ ${m}`)
}
const check = (cond, m) => (cond ? ok(m) : bad(m))

console.log(`\n目标 profile: ${PROFILE_DIR}\n`)

if (!fs.existsSync(PROFILE_DIR)) {
  bad(`profile 目录不存在：${PROFILE_DIR}`)
  process.exit(1)
}

console.log('[1] profile 清单')
const profilePkgPath = path.join(PROFILE_DIR, 'package.json')
const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
const dep = profilePkg.dependencies?.[PKG]
const bundles = profilePkg.dsh?.profile?.bundles ?? []
check(Boolean(dep), `dependencies 里有 ${PKG} → ${dep ?? '(缺失)'}`)
check(bundles.includes(PKG), `dsh.profile.bundles 里有 ${PKG}（第 ${bundles.indexOf(PKG) + 1}/${bundles.length} 位）`)
check(new Set(bundles).size === bundles.length, 'bundles 列表无重复项')

console.log('\n[2] 包解析（link: 是否真的生效）')
const req = createRequire(path.join(PROFILE_DIR, 'package.json'))
let entry
let manifestPath
try {
  manifestPath = req.resolve(`${PKG}/package.json`)
  entry = req.resolve(PKG)
  ok(`解析到入口：${entry}`)
} catch (err) {
  bad(`解析失败：${err.message}`)
  console.log('\n❌ 未能解析插件，加载一定失败。\n')
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

console.log('\n[3] DSH 插件判据（缺失则安装会报 not-a-bundle）')
check(manifest.name === PKG, `包名匹配：${manifest.name}`)
check(manifest.type === 'module', 'type = module')
check(typeof manifest.dsh?.bundle?.patch === 'string', `dsh.bundle.patch = ${manifest.dsh?.bundle?.patch}`)
check(manifest.dsh?.client?.platform === 'web', `dsh.client.platform = ${manifest.dsh?.client?.platform}`)
check(Array.isArray(manifest.dsh?.client?.inject), `dsh.client.inject = ${JSON.stringify(manifest.dsh?.client?.inject)}`)
const pkgDir = path.dirname(manifestPath)
for (const f of [manifest.main, 'lib/pricing.js', 'lib/filler.js', 'lib/ledger.js', 'lib/controller.js', 'client.js']) {
  check(Boolean(f) && fs.existsSync(path.join(pkgDir, f)), `文件存在：${f}`)
}
const deps = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) }
check(Object.keys(deps).length === 0, `零依赖（dependencies + peerDependencies 均为空）→ ${JSON.stringify(deps)}`)

console.log('\n[4] bundle patch 结构')
const patchPath = path.join(pkgDir, manifest.dsh.bundle.patch)
const patchText = fs.readFileSync(patchPath, 'utf8')
const names = [...patchText.matchAll(/^\s*-?\s*name:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
const ids = [...patchText.matchAll(/^\s*-?\s*id:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
check(names.includes(PKG), `patch 里的 name 等于包名（${JSON.stringify(names)}）`)
check(ids.length > 0, `row id = ${JSON.stringify(ids)}`)
check(new Set(ids).size === ids.length, 'patch 内 row id 无重复')
// 与 profile 其它 bundle 的 row id 冲突检查（只做本插件自己这一行的粗查）
const otherPatches = []
for (const b of bundles) {
  if (b === PKG || b.startsWith('@deepseek-ai/')) continue
  try {
    const bp = req.resolve(`${b}/package.json`)
    const bm = JSON.parse(fs.readFileSync(bp, 'utf8'))
    const rel = bm.dsh?.bundle?.patch
    if (rel) otherPatches.push({ b, text: fs.readFileSync(path.join(path.dirname(bp), rel), 'utf8') })
  } catch {
    /* 第三方包解析不到就算了 */
  }
}
const clashes = []
for (const { b, text } of otherPatches) {
  const otherIds = [...text.matchAll(/^\s*-?\s*id:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
  for (const id of ids) if (otherIds.includes(id)) clashes.push(`${id} 同时出现在 ${b}`)
}
check(clashes.length === 0, clashes.length ? `row id 与其它 bundle 冲突：${clashes.join('; ')}` : `row id 与已扫描的 ${otherPatches.length} 个第三方 bundle 无冲突`)

console.log('\n[5] Host 半真的能 import')
const mod = await import(pathToFileURL(entry).href)
check(mod.name === 'token-burner', `export const name = ${JSON.stringify(mod.name)}`)
check(Array.isArray(mod.inject), `export const inject = ${JSON.stringify(mod.inject)}`)
check(typeof mod.apply === 'function', 'export function apply(ctx, config)')
check(typeof mod.runTool === 'function', '导出 runTool（便于测试）')
check(typeof mod.DISCLAIMER === 'string' && mod.DISCLAIMER.includes('不可撤销'), '导出免责声明常量')

// 动作枚举是文档/UI/工具三处要一致的东西，最容易加了新动作却忘了同步别处。
const DOC_ACTIONS = ['doctor', 'plan', 'start', 'status', 'stop', 'runs', 'reconcile']
check(
  typeof mod.runTool === 'function' && Array.isArray(mod.PARAMETERS?.properties?.action?.enum),
  'PARAMETERS 暴露 action.enum（便于校验）',
)
const enumActions = mod.PARAMETERS?.properties?.action?.enum
if (Array.isArray(enumActions)) {
  check(
    DOC_ACTIONS.every((a) => enumActions.includes(a)),
    `action.enum 覆盖全部文档化动作（缺：${DOC_ACTIONS.filter((a) => !enumActions.includes(a)).join('、') || '无'}）`,
  )
  check(
    enumActions.every((a) => DOC_ACTIONS.includes(a)),
    `action.enum 没有文档外动作（多：${enumActions.filter((a) => !DOC_ACTIONS.includes(a)).join('、') || '无'}）`,
  )
}
const desc = mod.runTool?.toString() ?? ''
check(desc.includes('reconcile'), '工具描述里写了 reconcile（否则 agent 不知道有这个动作）')
const clientDesc = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8')
check(clientDesc.includes('复制「对账」'), 'Web 面板有「对账」按钮')
check(clientDesc.includes('结算延迟'), 'Web 面板提示了余额结算延迟')

// waitSeconds 的上限必须低于宿主的 120 秒工具调用硬上限 —— 超过会被当成「调用被取消」
// 而调 stop('cancelled')，把一轮本来健康的运行打断（真机事故：¥5 只烧 ¥0.11 就被中止）。
const waitDesc = mod.PARAMETERS?.properties?.waitSeconds?.description ?? ''
check(/120/.test(waitDesc), 'waitSeconds 参数说明里写明了 120 秒工具调用上限')
const indexText = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8')
check(
  /clampNum\(args\.waitSeconds,\s*0,\s*0,\s*(\d+)\)/.test(indexText) &&
    Number(/clampNum\(args\.waitSeconds,\s*0,\s*0,\s*(\d+)\)/.exec(indexText)[1]) <= 110,
  'waitSeconds 被夹到 ≤110 秒（留出余量，避免撞上 120 秒工具上限）',
)

console.log('\n[6] Client 半语法检查')
const clientPath = path.join(pkgDir, 'client.js')
const clientText = fs.readFileSync(clientPath, 'utf8')
check(clientText.includes('window.__ModuleLoader__.load'), '使用 window.__ModuleLoader__.load 形态')
check(!/require\(\s*['"]@deepseek-ai\//.test(clientText), '没有 require 任何 @deepseek-ai/* 客户端包')
check(/require\(\s*['"]react['"]\s*\)/.test(clientText), "只 require('react')")
check(clientText.includes("inject: ['slots']"), "返回 { inject: ['slots'], apply }")
check(clientText.includes('conversation.composer.dock'), '注册到 conversation.composer.dock 槽位')

console.log('\n[7] 仓库卫生：不得残留真实余额 / 密钥 / 个人路径')
{
  // 这个仓库是 public 的。真实账户余额在文档里已脱敏成 <余额A>/<余额B>/<余额C>，
  // 但第一次脱敏时**只扫了 README，漏掉了 tools/smoke.mjs**（真实余额在公开仓库里躺了一轮）。
  // 所以现在把它变成一道自动检查 —— 脱敏是「整个仓库」的事，不是「某个文件」的事。
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const SKIP_DIRS = new Set(['node_modules', '.git'])
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(repoDir)

  // ⚠️ 这里**故意不写**真实余额的字面量。第一版 checker 把 5 个真实读数当黑名单抄了进来 ——
  //    结果 checker 自己成了仓库里最后的泄漏点（公开仓库的读者照样能看到那串数字）。
  //    改用两条**形状**规则，它们抓的是同一批东西，却不需要知道原值：
  //      ① 余额的书写约定是 `CNY <余额X>`：出现 `CNY 数字` 就是没脱敏干净；
  //      ② 真机余额一律有 ≥7 位小数，而仓库里合法的长小数只有「差额」，差额的书写约定是 `¥…`。
  //         所以「≥7 位小数、且前面不是 ¥」就是泄漏。
  const SECRETS = [/gho_[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9]{20,}/, /[/]Users[/][A-Za-z0-9._-]+[/]/]
  const BARE_LONG_DECIMAL = /(?<!¥)\b\d+\.\d{7,}\b/g
  const offenders = []
  for (const f of files) {
    const rel = path.relative(repoDir, f)
    // 跳过本文件：下面 SECRETS 里的正则**源码**本身含有 `/Users/` 这样的字面片段，
    // 不跳过就会自己告自己的状。其余任何文件都不豁免 —— 泄漏就是泄漏，不分文件。
    if (rel === 'tools' + path.sep + 'verify-install.mjs') continue
    let text
    try {
      text = fs.readFileSync(f, 'utf8')
    } catch {
      continue // 二进制/读不了的文件跳过
    }
    for (const re of SECRETS) {
      const m = re.exec(text)
      if (m) offenders.push(`${rel}: 敏感串 ${m[0]}`)
    }
    text.split('\n').forEach((line, i) => {
      const at = `${rel}:${i + 1}`
      const cny = /CNY \d/.exec(line)
      if (cny) offenders.push(`${at}: 未脱敏的余额读数（${cny[0]}…）`)
      // 明确的「差额」上下文（README 里引用的审计账本片段）里，长小数是合法的。
      if (/deltaCny|driftCny|rawDeltaCny/.test(line)) return
      for (const m of line.matchAll(BARE_LONG_DECIMAL)) {
        offenders.push(`${at}: 疑似未脱敏的余额读数（${m[0]}；长小数要写成 ¥… 的差额）`)
      }
    })
  }
  check(
    offenders.length === 0,
    `扫了 ${files.length} 个文件，无真实余额/密钥/个人路径${offenders.length ? `\n      ${offenders.join('\n      ')}` : ''}`,
  )
}

console.log(failed === 0 ? '\n✅ 安装校验全部通过。\n' : `\n❌ 有 ${failed} 项未通过。\n`)
process.exit(failed === 0 ? 0 : 1)

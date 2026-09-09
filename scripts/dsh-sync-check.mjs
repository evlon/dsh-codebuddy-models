#!/usr/bin/env node
/**
 * dsh-daily-sync 检测器：判断本插件是否已适配「当前 DeepSeek Harness daily rc」。
 *
 * DeepSeek Harness 宿主运行时以 `@deepseek-ai/dsh-*` 一组包发布（dsh-agent/attachment/
 * llm/session/settings/tools/user-approval 共享同一条版本轴），官方每日预发布走 npm `next`
 * dist-tag（例：0.1.2-rc.1）。npm 对预发布范围是按 `major.minor.patch` 元组锚定的：
 * `^0.1.2-rc.1` 只会匹配 0.1.2.* 的预发布，不会自动覆盖 0.1.3-rc.x —— 所以宿主升 rc 时，
 * 本插件必须同步把 peer/dev 里的 dsh-* 范围升到对应的下一个 rc（纯机械 = 改范围 + 重装 +
 * 构建/测试；若有 API 破坏则需改码）。
 *
 * 本脚本只做**只读判定**，输出三态之一：
 *   - `NOOP`        ：声明范围已覆盖当前 next rc，无需任何动作。
 *   - `SYNCABLE`    ：缺一个 dsh rc（next 高于声明）；改范围 + build/test 通过即机械同步，
 *                    是否真的机械由上层「改了范围后 build/test 是否过」终审——过则自动提交，
 *                    不过则开 issue（需改码）。
 *   - `NO_DSH_PEER` ：本包没有声明任何 `@deepseek-ai/dsh-*` peer/dev（如纯运行时解析），
 *                    不参与自动同步（记录即可）。
 * 提示：dsh 的 daily rc 通常是**同 0.x 内次/补丁上跳**（如 0.1.2-rc.1 → 0.1.3-rc.x），这在桥接层
 * 插件里多数是纯机械（仅 peer/dev 范围 + lockfile）；跨 0.x→1.x 主版本才几乎必然改码。
 * 本脚本不武断分类「机械/需改码」，统一给 SYNCABLE 交由 build/test 终审（更稳）。
 *
 * 输出（写 stdout，供上层 GitHub Action 分支）：
 *   JSON 单行，例：
 *   {"verdict":"SYNCABLE","next":"0.1.3-rc.0","declared":"^0.1.2-rc.1","target":"0.1.3-rc.0",
 *    "dshPeers":["@deepseek-ai/dsh-agent","@deepseek-ai/dsh-llm","@deepseek-ai/dsh-session"]}
 *
 * 用法：
 *   node scripts/dsh-sync-check.mjs [--next <version>] [--axis-pkg <pkg>]
 *     --next       手动指定 next rc（便于测试/模拟 lag）；缺省从 npm 读 <axis-pkg> 的 dist-tags.next
 *     --axis-pkg   版本轴参考包，缺省 @deepseek-ai/dsh-agent
 *     --no-npm     配合 --next 用：不访问 npm（纯离线判定，便于在无 registry 的沙箱里测）
 *     --emit-new-pkg <path>  仅在 SYNCABLE 时，把「所有 @deepseek-ai/dsh-* 范围改成 ^<next>」的
 *                            package.json 写到 <path>（供上层在临时目录里安装/构建/测试，验证机械性）。
 *
 * 从 stdin 读 package.json 内容（便于外部把修正版喂进来），缺省读 ./package.json。
 * 为兼容 pnpm/yarn/npm，脚本不调用任何包管理器，只做文本/语义判定 + 生成修正后的 package.json。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
// 优先用 npm 自带的 semver（CI / 本机都有）；不额外安装依赖。
let semver
try {
  semver = require('semver')
} catch {
  // 退路：用 pnpm/npm 深层路径——CI 里 node_modules/.pnpm/semver 不一定在顶层，给出明确报错。
  throw new Error('dsh-sync-check: 需要 semver。请在 package.json devDependencies 加 semver，或确认 node 能 require 到 semver。')
}

const DSH_PEER_RE = /^@deepseek-ai\/dsh-[a-z0-9-]+$/ // 只盯 dsh-* 一条轴；cordis/schemastery 各自独立发版，不在此列

function parseArgs(argv) {
  const out = { next: null, axisPkg: '@deepseek-ai/dsh-agent', noNpm: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--next') { out.next = argv[++i]; out.noNpm = true }
    else if (a === '--axis-pkg') out.axisPkg = argv[++i]
    else if (a === '--no-npm') out.noNpm = true
    else if (a === '--emit-new-pkg') out.emitNewPkg = argv[++i]
  }
  return out
}

function collectDshPeers(pkg) {
  const set = new Set()
  const grab = (sec) => {
    if (sec && typeof sec === 'object') {
      for (const k of Object.keys(sec)) if (DSH_PEER_RE.test(k)) set.add(k)
    }
  }
  grab(pkg.peerDependencies)
  grab(pkg.devDependencies)
  grab(pkg.dependencies)
  return [...set]
}

function declaredRangeOf(pkg, name) {
  for (const sec of ['peerDependencies', 'devDependencies', 'dependencies']) {
    const v = pkg[sec]?.[name]
    if (v) return v
  }
  return null
}

async function main() {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)

  const stdinRaw = (() => {
    try { return readFileSync(0, 'utf8') } catch { return '' }
  })()
  const raw = stdinRaw.trim().length > 0 ? stdinRaw : readFileSync('./package.json', 'utf8')
  const pkg = JSON.parse(raw)

  const dshPeers = collectDshPeers(pkg)
  if (dshPeers.length === 0) {
    console.log(JSON.stringify({ verdict: 'NO_DSH_PEER', dshPeers: [] }))
    return
  }

  // next rc：优先命令行 --next；否则读 npm <axisPkg> dist-tags.next
  let next
  if (opts.next) {
    next = opts.next
  } else if (!opts.noNpm) {
    next = require('child_process').execSync(`npm view ${opts.axisPkg} dist-tags.next`, { encoding: 'utf8' }).trim()
  } else {
    throw new Error('dsh-sync-check: 需要 --next（离线模式）或能访问 npm。')
  }
  if (!next || !semver.valid(next)) {
    throw new Error(`dsh-sync-check: 读不到合法的 next rc：${next}`)
  }
  // 保留 prerelease 原值（next 是带 rc 预发布的版本，coerce 会剥掉导致误判稳定版覆盖）。
  const cleanNext = semver.valid(next)
  const nextTuple = semver.major(next) + '.' + semver.minor(next) + '.' + semver.patch(next)

  // 取「声明范围里代表当前适配 tuple」的主 dsh peer（都共享一条轴，取第一个即可；但要范围一致）。
  const primary = dshPeers[0]
  const declared = declaredRangeOf(pkg, primary) || ''

  // 判定：当前声明范围是否覆盖 next？覆盖 → NOOP；否则 → SYNCABLE（交 build/test 终审）。
  // 注意：不能用 includePrerelease:true——那会让 ^0.1.2-rc.1 误判覆盖 0.1.3-rc.0，破坏
  // 预发布「按 major.minor.patch 元组锚定」的语义（必须让 0.1.3-rc.0 不被 ^0.1.2-rc.1 覆盖 → 触发同步）。
  const coversNext = semver.satisfies(next, declared)
  const verdict = coversNext ? 'NOOP' : 'SYNCABLE'

  // SYNCABLE 且要求产出修正 package.json：把所有 @deepseek-ai/dsh-* 的 peer/dev/dep 范围改成 ^<next>。
  if (verdict === 'SYNCABLE' && opts.emitNewPkg) {
    const np = structuredClone(pkg)
    for (const sec of ['peerDependencies', 'devDependencies', 'dependencies']) {
      if (np[sec] && typeof np[sec] === 'object') {
        for (const k of Object.keys(np[sec])) {
          if (DSH_PEER_RE.test(k)) np[sec][k] = `^${next}`
        }
      }
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(opts.emitNewPkg, JSON.stringify(np, null, 2) + '\n')
  }

  const out = {
    verdict,
    next: cleanNext,
    nextTuple,
    declared,
    dshPeers,
  }
  console.log(JSON.stringify(out))
}

main().catch((e) => {
  console.error(String(e?.message || e))
  process.exit(2)
})

#!/usr/bin/env node
/**
 * 诊断 dsh 的 deepseek-official 路由为什么拿不到 DEEPSEEK_API_KEY。
 *
 * 零依赖（只用 node:fs / node:path / node:os），同事机器有 node 就能跑：
 *
 *   node diagnose-deepseek-key.mjs
 *
 * 它按 dsh 真实解析 DEEPSEEK_API_KEY 的四层优先级逐层检查：
 *
 *   1. 启动进程环境变量           （process.env.DEEPSEEK_API_KEY，只读、最高优先级）
 *   2. 凭据文件 $DSH_HOME/.credentials.yaml 的 refs.DEEPSEEK_API_KEY
 *   3. 项目 .env                  （<启动 cwd>/.env）
 *   4. 用户 .env                  （$DSH_HOME/.env）
 *
 * 只判断「有没有值、来自哪一层」，绝不打印密钥明文（只显示前4位+长度）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';

// ---- 帮助函数 ----

/** 把密钥脱敏成 sk-12ab…（前4位 + 总长度），绝不泄露完整值。 */
function mask(v) {
  if (typeof v !== 'string' || v.length === 0) return '(空)';
  const head = v.slice(0, 4);
  return `${head}… (长度 ${v.length})`;
}

/** 极简 YAML：只认 refs: 段下形如 `  KEY: value` 的顶层标量行，够用即可。 */
function readYamlRef(file, key) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { exists: false, value: undefined };
  }
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    // 识别 refs: 段
    if (/^refs\s*:\s*$/.test(line)) { inRefs = true; continue; }
    // 遇到另一顶层段（0 缩进的 : 行）就离开 refs 段
    if (inRefs && /^[A-Za-z0-9_-]+\s*:/.test(line) && !line.startsWith(' ')) { inRefs = false; continue; }
    if (!inRefs) continue;
    // refs 段内的条目：`  KEY: value`
    const m = line.match(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (m && m[1] === key) {
      // 去掉行内注释与引号
      let v = m[2].trim();
      v = v.replace(/\s+#.*$/, '');
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return { exists: true, value: v };
    }
  }
  return { exists: true, value: undefined };
}

/** 读一个 .env 文件里的某个 KEY（忽略大小写，匹配 Windows 语义）。 */
function readDotEnv(file, key) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { exists: false, value: undefined };
  }
  const target = key.toUpperCase();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim().toUpperCase();
    if (k !== target) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return { exists: true, value: v };
  }
  return { exists: true, value: undefined };
}

// ---- 主流程 ----

const KEY = 'DEEPSEEK_API_KEY';

// DSH_HOME：与 dsh 一致，$DSH_HOME 优先，否则 ~/.dsh
const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh');

// 项目 .env：<启动 cwd>/.env（诊断脚本在哪个目录跑，就以哪个目录当 cwd）
const projectEnv = join(process.cwd(), '.env');

const findings = [];

// 1. 启动进程环境
{
  const v = process.env[KEY];
  findings.push({
    layer: '1. 启动进程环境变量',
    detail: `process.env.DEEPSEEK_API_KEY`,
    has: !!v && v.length > 0,
    masked: v ? mask(v) : undefined,
  });
}

// 2. 凭据文件
{
  const f = join(dshHome, '.credentials.yaml');
  const r = readYamlRef(f, KEY);
  findings.push({
    layer: '2. 凭据文件',
    detail: f,
    has: r.exists && !!r.value && r.value.length > 0,
    masked: r.value ? mask(r.value) : (r.exists ? '(文件存在但无该 key)' : '(文件不存在)'),
  });
}

// 3. 项目 .env
{
  const r = readDotEnv(projectEnv, KEY);
  findings.push({
    layer: '3. 项目 .env',
    detail: projectEnv,
    has: r.exists && !!r.value && r.value.length > 0,
    masked: r.value ? mask(r.value) : (r.exists ? '(文件存在但无该 key)' : '(文件不存在)'),
  });
}

// 4. 用户 .env
{
  const f = join(dshHome, '.env');
  const r = readDotEnv(f, KEY);
  findings.push({
    layer: '4. 用户 .env',
    detail: f,
    has: r.exists && !!r.value && r.value.length > 0,
    masked: r.value ? mask(r.value) : (r.exists ? '(文件存在但无该 key)' : '(文件不存在)'),
  });
}

// ---- 输出 ----

console.log('');
console.log('================================================================');
console.log(' dsh DEEPSEEK_API_KEY 诊断');
console.log('================================================================');
console.log(` DSH_HOME          : ${dshHome}`);
console.log(` 当前工作目录(cwd) : ${process.cwd()}`);
console.log(` 平台              : ${process.platform}`);
console.log('');
console.log(' 各层解析结果（按 dsh 真实优先级从高到低）：');
console.log('');

let firstHit = null;
for (const f of findings) {
  const mark = f.has ? '✅ 命中' : '❌ 未命中';
  console.log(` [${mark}] ${f.layer}`);
  console.log(`         ${f.detail}`);
  if (f.has) console.log(`         value = ${f.masked}`);
  else if (f.masked) console.log(`         ${f.masked}`);
  if (f.has && firstHit === null) firstHit = f;
  console.log('');
}

console.log('----------------------------------------------------------------');

if (firstHit) {
  console.log(' 结论：找到 DEEPSEEK_API_KEY，来源 = ' + firstHit.layer);
  console.log(`       ${firstHit.detail}`);
  console.log('');
  console.log(' 如果 dsh 仍报 "no API key for provider route deepseek-official"，');
  console.log(' 那通常不是「没配 key」，而是下面之一：');
  console.log('   - key 是在 dsh 启动【之后】才 export 的（环境快照已冻结，看不到）；');
  console.log('     解决：清掉该环境变量，改用 Web「设置 → 模型」页保存，或重启 dsh。');
  console.log('   - 当前跑的不是同一个 DSH_HOME（本脚本检测到的是 ' + dshHome + '）。');
  console.log('   - key 值本身无效（格式错误）——请核对是否完整、无多余空格。');
} else {
  console.log(' 结论：四层都没有 DEEPSEEK_API_KEY —— 这就是报错的根因。');
  console.log('');
  console.log(' 任选其一补上（推荐第 1 种）：');
  console.log('');
  console.log('  [推荐] 打开 dsh Web 界面 → 设置 → 模型，在 DeepSeek 栏填入');
  console.log('         DEEPSEEK_API_KEY 并保存。它会写入凭据文件，之后每次都生效。');
  console.log('');
  console.log('  或 在【启动 dsh 的那个 shell】里先 export 再启动：');
  console.log('         PowerShell:  $env:DEEPSEEK_API_KEY = "sk-..."');
  console.log('         CMD:         set DEEPSEEK_API_KEY=sk-...');
  console.log('  注意：必须是启动那一刻就存在，启动后再 export 无效。');
  console.log('');
  console.log('  或 在下面任一文件里加一行（没有就新建）：');
  console.log(`         ${join(dshHome, '.env')}`);
  console.log('         内容:  DEEPSEEK_API_KEY=sk-...');
  console.log(`         或    ${projectEnv}`);
}

console.log('');
console.log('================================================================');

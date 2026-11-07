#!/usr/bin/env node
/**
 * 装鲸语的 Python 依赖（edge-tts + 它的传递依赖）到本地目录。
 *
 * 仓库里不提交这些第三方代码（体积大、许可是 LGPL/Apache），克隆后跑一次本脚本即可。
 *
 * 用法：
 *   node scripts/setup.mjs          # 装进插件目录的 pylibs/
 *   node scripts/setup.mjs --user   # 装进 ~/.dsh/whale-voice/pylibs/（插件目录只读时用）
 *
 * 为什么不用 `pip install --target` 一个命令了事：Windows 上 pip 会把 wheel 解包到系统
 * 临时目录，再跨卷 move 到目标目录；某些沙箱环境会在这步拒绝（WinError 5）。所以这里把
 * TMP/TEMP 指到目标目录旁边，让解包和落盘在同一卷内。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 依赖要装到哪。 */
const target = process.argv.includes('--user')
  ? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'whale-voice', 'pylibs')
  : join(PLUGIN_ROOT, 'pylibs')

/** 各平台尝试的 Python 启动方式，从上到下取第一个能跑的。 */
const candidates = process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']
const python = candidates.find((command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0)

if (!python) {
  console.error(`[whale-voice] 找不到 Python（试过 ${candidates.join('、')}）。`)
  console.error('[whale-voice] 装一个 Python 3.8+ 再回来跑，或者在设置 › 鲸语里填 Python 路径。')
  process.exit(1)
}

/** pip 的临时目录，和目标同卷。 */
const tempDir = join(target, '.tmp')
mkdirSync(tempDir, { recursive: true })

console.log(`[whale-voice] Python: ${python}`)
console.log(`[whale-voice] 目标目录: ${target}`)

const env = { ...process.env, TMP: tempDir, TEMP: tempDir }
const result = spawnSync(
  python,
  ['-m', 'pip', 'install', '--upgrade', '--target', target, 'edge-tts'],
  { stdio: 'inherit', env },
)

if (result.error) {
  console.error(`[whale-voice] 调用 pip 失败: ${result.error.message}`)
  process.exit(1)
}

rmSync(tempDir, { recursive: true, force: true })

if (result.status !== 0) {
  console.error('[whale-voice] pip 退出码非 0，依赖可能没装全。')
  console.error(`[whale-voice] 手动重试: ${python} -m pip install --upgrade --target "${target}" edge-tts`)
  process.exit(result.status ?? 1)
}

if (!existsSync(join(target, 'edge_tts'))) {
  console.error('[whale-voice] 装完后没找到 edge_tts 目录，可能被 pip 安装到了别处。')
  process.exit(1)
}

console.log('[whale-voice] 依赖装好了。回 Harness 刷新页面就能朗读。')

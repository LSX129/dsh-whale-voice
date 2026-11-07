/**
 * dsh-whale-voice · Node half（host 侧）
 *
 * 把 "海星" 那一档神经语音（edge-tts）装在 Harness 身上：
 * 1. 声明 volatile 配置——音色 / 语速 / 音调 / 自动朗读 / Python 路径 / 依赖目录，
 *    改动由 Loader 直接提交进同一个 config 引用，插件不重启就换声。
 * 2. 注册 `/api/whale-voice` 路由，给浏览器侧合成音频：
 *    - `POST /say`   传一段文字，直接合成；
 *    - `POST /speak` 传 sessionId（+ 可选 messageId），从会话日志取助手正文再合成。
 * 3. 合成走子进程 `py tts.py`，依赖（edge_tts / aiohttp / certifi…）放在 `pylibs/`
 *    （包内，或 `$DSH_HOME/whale-voice/pylibs`），因此不依赖用户全局 Python 环境里
 *    有没有装 edge-tts。仓库不提交这些依赖，`npm run setup` 一次装好。
 *
 * 为什么正文在 host 取：浏览器侧 `conversation.chat.assistant-actions` 只给 messageId，
 * 拿不到文本；而 host 的 `sessionController.events()` 能分页读出全部 `assistant/message`
 * 事件（旧版宿主退回 `inspect(sessionId)`），正文取自那里最稳。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'

/** Cordis 插件名；同时是配置命名空间（见 cordis.patch.yml 的 insert id）。 */
export const name = 'whale-voice'

/** 提供 HTTP 路由，因此硬依赖 `webServer`。 */
// sessionController 必须显式注入：Cordis 只会把声明过的服务暴露给插件，
// 只靠 ctx.get('sessionController') 在宿主重启后可能拿到 undefined（朗读按钮就会报
// "sessionController unavailable"）。
export const inject = ['webServer', 'sessionController']

/** 路由前缀；client half（lib/client.js）里的 API 常量必须与之一致。 */
const API_PREFIX = '/api/whale-voice'

/** 插件根目录（lib/ 的上一级），用来定位 tts.py 与 pylibs/。 */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 随包携带的 edge-tts 依赖目录。 */
const BUNDLED_PYLIBS = join(PLUGIN_ROOT, 'pylibs')

/** 用户目录下的依赖缓存：包内没带依赖时用这里。 */
const USER_PYLIBS = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'whale-voice', 'pylibs')

/**
 * 解析本次合成用哪个依赖目录。
 *
 * 优先级：设置里填的路径 → 包内 `pylibs/` → `$DSH_HOME/whale-voice/pylibs` → 空串
 * （空串表示只用系统 Python 自己的 site-packages，适合已经全局装过 edge-tts 的人）。
 * @param settings - 当前设置。
 * @returns 依赖目录绝对路径，或空串。
 */
function resolvePylibs(settings) {
  const configured = String(settings.pylibs || '').trim()
  if (configured) return configured
  if (existsSync(BUNDLED_PYLIBS)) return BUNDLED_PYLIBS
  if (existsSync(USER_PYLIBS)) return USER_PYLIBS
  return ''
}

/** 合成 worker 的绝对路径。 */
const TTS_SCRIPT = join(PLUGIN_ROOT, 'tts.py')

/** 一次合成的等待上限；edge-tts 正常在 2 秒内返回，给足 60 秒只防卡死。 */
const TTS_TIMEOUT_MS = 60_000

/** 单次朗读的正文上限，超长回复截断，避免一条消息读出几分钟。 */
const MAX_TEXT_CHARS = 4000

/**
 * 把回复正文整理成"只念该念的"朗读稿。
 *
 * 规矩：**标点不发音，只当停顿与语气用**——中文标点（。，！？；：……——）原样留着，
 * 交给 edge-tts 去表达语气与停顿；真正要删掉的是那些念不出人话、或者会被逐字念成
 * 噪音的东西：代码块、Markdown 记号、emoji、成串的装饰符号。另外把连续的句末标点并成
 * 一个，免得一句话停三次。
 * @param text - 助手回复正文。
 * @returns 朗读稿（可能为空串）。
 */
function prepareSpeechText(text) {
  let out = String(text ?? '')

  // 代码块整段不念：朗读代码没有意义，符号还会被逐个念出来。
  out = out.replace(/```[\s\S]*?```/g, '\n')
  // 行内代码只留内容。
  out = out.replace(/`([^`]*)`/g, '$1')
  // 图片链接整颗丢掉，普通链接只留可读的标题文字。
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Markdown 的标题井号、强调、引用、列表符号。
  out = out.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  out = out.replace(/[*_~>]+/g, '')
  out = out.replace(/^\s*[-+]\s+/gm, '')
  // emoji 与装饰符号：念不出来，也不该念。
  out = out.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
  // 连续标点并成一个：语气保留，停顿不叠加。
  out = out.replace(/([！？!?。])\1+/g, '$1')
  out = out.replace(/[，,]{2,}/g, '，')
  // 收拾空白。
  out = out.replace(/[ \t]{2,}/g, ' ')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/**
 * 可选音色。前两项是从试听里挑出来的"海星感"主力，
 * 正是 `zh-CN` 下 edge-tts 提供的年轻女声。
 */
const VOICES = [
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼', note: '默认，最接近海星那一档' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔', note: '更稳更软，适合长段落' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '小北 · 俏皮', note: '东北腔，带一点调皮' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '小妮 · 明亮', note: '清脆，语速偏快' },
]

/** 默认音色：试听里最贴"海星"那一档。 */
const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

/**
 * 把音色收敛到可选列表里。
 *
 * 旧配置可能存着已经下架的音色（比如早先那两个男声），直接透传会合成出不该出现的声音，
 * 所以在任何入口都过一遍这个函数，认不出来就回到默认。
 * @param value - 来自配置或请求体的音色 id。
 * @returns 可用的音色 id。
 */
function normalizeVoice(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  return VOICES.some((voice) => voice.id === id) ? id : DEFAULT_VOICE
}

/**
 * 投影到浏览器的实时偏好。
 *
 * 全部声明成 volatile：Harness 只允许这类字段被设置页实时改写，
 * 而改动由 Loader 提交进下面 `apply` 捕获的同一个引用，改完立刻生效。
 */
export const Config = z.object({
  voice: z.string().default(DEFAULT_VOICE).volatile(),
  rate: z.string().default('+6%').volatile(),
  pitch: z.string().default('+10Hz').volatile(),
  autoSpeak: z.boolean().default(false).volatile(),
  python: z.string().default('').volatile(),
  pylibs: z.string().default('').volatile(),
})

/**
 * 读取 volatile 字段的当前值。
 * @param field - `config` 上的字段；volatile 字段是 `{ get() }` 引用。
 * @returns 当前值。
 */
function liveValue(field) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/**
 * 把配置引用拍平成一份普通对象，供合成时读取。
 * @param config - 已校验的插件配置。
 * @returns 当前生效的设置。
 */
function currentSettings(config) {
  return {
    voice: normalizeVoice(liveValue(config?.voice)),
    rate: String(liveValue(config?.rate) || '+0%'),
    pitch: String(liveValue(config?.pitch) || '+0Hz'),
    autoSpeak: liveValue(config?.autoSpeak) === true,
    python: String(liveValue(config?.python) || ''),
    pylibs: String(liveValue(config?.pylibs) || ''),
  }
}

/**
 * 响应一个 JSON 结果。
 * @param res - Node 响应。
 * @param code - HTTP 状态码。
 * @param body - 可序列化对象。
 */
function sendJson(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 响应一段 mp3。
 * @param res - Node 响应。
 * @param buffer - mp3 字节。
 */
function sendAudio(res, buffer) {
  res.statusCode = 200
  res.setHeader('content-type', 'audio/mpeg')
  res.setHeader('content-length', String(buffer.length))
  res.setHeader('cache-control', 'no-store')
  res.end(buffer)
}

/**
 * 读取并解析请求体。
 * @param req - Node 请求。
 * @returns 解析后的对象；坏 JSON 与超限都退化成 `{}`。
 */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 400_000) req.destroy()
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw || '{}')
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 从助手消息的 content blocks 里拼出纯文本。
 * @param message - `assistant/message` 事件里的 message。
 * @returns 文本；没有 text block 时为空串。
 */
function messageText(message) {
  const lists = []
  if (Array.isArray(message?.content)) lists.push(message.content)
  if (Array.isArray(message?.blocks)) lists.push(message.blocks)
  if (Array.isArray(message?.parts)) lists.push(message.parts)

  const parts = []
  for (const list of lists) {
    for (const block of list) {
      if (block === null || typeof block !== 'object') continue
      if (typeof block.text === 'string' && (block.type === 'text' || block.type === undefined)) {
        parts.push(block.text)
        continue
      }
      // 某些部署把 block 包成 `{ type:'text', text:{ text } }`，一并兼容。
      if (block.type === 'text' && block.text !== null && typeof block.text === 'object' && typeof block.text.text === 'string') {
        parts.push(block.text.text)
      }
    }
  }
  return parts.join('\n').trim()
}

/**
 * 从流式事件里拼出助手正文。
 *
 * `assistant/message` 的 `message.content` 只有 reasoning 与 tool-call——模型这一轮的
 * 说话内容是以流式协议走的：`{ type:'block-start', index, blockType }` 开场、
 * `{ type:'block-end', index, block }` 收尾，而正文就在 `blockEnd.block.type === 'text'`
 * 那一块的 `text` 上。所以正文必须从 stream 里捞，不能只看 message.content。
 * @param data - `assistant/message` 事件的 data。
 * @returns 该步的正文（可能是空串，比如这一步只调了工具）。
 */
function streamText(data) {
  const stream = Array.isArray(data?.stream) ? data.stream : []
  const parts = []
  for (const item of stream) {
    if (item === null || typeof item !== 'object') continue
    if (item.type === 'block-end' && item.block !== null && typeof item.block === 'object'
      && item.block.type === 'text' && typeof item.block.text === 'string') {
      parts.push(item.block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 一步助手消息的可朗读正文：先看 content 里的 text block（别人家的落盘格式），
 * 再退回流式事件里拼。
 * @param data - `assistant/message` 事件的 data。
 * @returns 正文，取不到就是空串。
 */
function eventText(data) {
  const fromContent = messageText(data?.message)
  if (fromContent) return fromContent
  return streamText(data)
}

/**
 * 消息文本提取失败时给出一份结构摘要，方便对着它改提取逻辑。
 * @param message - `assistant/message` 里的 message。
 * @returns 可序列化的诊断对象。
 */
function messageShape(message) {
  const keys = message !== null && typeof message === 'object' ? Object.keys(message) : []
  const content = message?.content
  return {
    keys,
    contentType: Array.isArray(content) ? 'array' : typeof content,
    blocks: Array.isArray(content) ? content.map((block) => (block && typeof block === 'object' ? block.type ?? typeof block : typeof block)) : null,
    sample: JSON.stringify(message ?? null).slice(0, 400),
  }
}

/**
 * 依次尝试可用的 Python 启动方式。
 * @param settings - 当前设置（`python` 非空则只用它）。
 * @returns 候选命令列表。
 */
function pythonCandidates(settings) {
  if (settings.python) return [settings.python]
  return process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']
}

/**
 * 跑一次 tts.py，把请求从 stdin 递进去。
 * @param command - Python 可执行文件。
 * @param payload - 已序列化的请求 JSON。
 * @returns `{ ok, error?, stderr? }`。
 */
function runTtsOnce(command, payload) {
  return new Promise((resolve) => {
    let settled = false
    const stdout = []
    const stderr = []
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child
    try {
      child = spawn(command, [TTS_SCRIPT], { windowsHide: true })
    } catch (error) {
      finish({ ok: false, error: `spawn ${command} failed: ${String(error?.message ?? error)}` })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, error: 'tts timed out' })
    }, TTS_TIMEOUT_MS)

    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, error: `spawn ${command} failed: ${String(error?.message ?? error)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const outText = Buffer.concat(stdout).toString('utf8').trim()
      const errText = Buffer.concat(stderr).toString('utf8').trim()
      let parsed = null
      try {
        const lastLine = outText.split('\n').filter(Boolean).pop() ?? ''
        parsed = JSON.parse(lastLine)
      } catch {
        parsed = null
      }
      if (parsed !== null && parsed.ok === true) {
        finish({ ok: true })
        return
      }
      const reason = (parsed !== null && parsed.error) || errText.slice(0, 600) || `python exited with ${code}`
      finish({ ok: false, error: reason })
    })

    child.stdin?.on('error', () => {
      /* 子进程提前退出时写入会失败，交给 close 判定 */
    })
    child.stdin?.end(payload, 'utf8')
  })
}

/**
 * 合成一段文字成 mp3。
 * @param settings - 当前设置。
 * @param text - 要朗读的正文。
 * @param overrides - 可选的单次覆盖（voice/rate/pitch）。
 * @returns `{ ok, buffer?, error? }`。
 */
async function synthesize(settings, text, overrides = {}) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { ok: false, error: 'empty text' }
  const clipped = trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS)}…` : trimmed
  const speakable = prepareSpeechText(clipped)
  if (!speakable) return { ok: false, error: '这段没有可朗读的内容' }

  const pylibs = resolvePylibs(settings)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-whale-voice-'))
  const out = join(dir, 'speech.mp3')
  const payload = JSON.stringify({
    pylibs,
    text: speakable,
    voice: normalizeVoice(overrides.voice || settings.voice),
    rate: overrides.rate || settings.rate,
    pitch: overrides.pitch || settings.pitch,
    out,
  })

  let lastError = 'no python available'
  try {
    for (const command of pythonCandidates(settings)) {
      const result = await runTtsOnce(command, payload)
      if (result.ok) {
        const buffer = await readFile(out)
        return { ok: true, buffer }
      }
      lastError = result.error ?? lastError
      if (!/spawn|ENOENT/i.test(lastError)) break
    }
    return { ok: false, error: lastError }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 从会话日志里取出要朗读的正文。
 * @param ctx - 插件上下文。
 * @param body - 请求体（`sessionId` 必填，`messageId` 可选）。
 * @returns `{ ok, text?, error? }`。
 */
async function resolveSessionText(ctx, body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!sessionId) return { ok: false, error: 'missing sessionId' }

  const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (!controller) return { ok: false, error: 'sessionController unavailable' }

  // 新版 Harness 把一次性的 `inspect(sessionId)` 换成了分页的 `events(request)`，
  // 旧版仍然只有 inspect；两边都认，免得宿主一升级朗读就哑掉。
  let events = []
  if (typeof controller.events === 'function') {
    const page = await controller.events(
      { address: { kind: 'session', sessionId }, maxMessages: 400 },
      // 新版 events() 要求调用方给一个取消信号，缺了会在内部 throwIfAborted 上炸掉。
      AbortSignal.timeout(20_000),
    )
    const records = Array.isArray(page?.records) ? page.records : []
    events = records
      .filter((record) => record?.type === 'event' && record.event)
      .map((record) => record.event)
  } else if (typeof controller.inspect === 'function') {
    const inspection = await controller.inspect(sessionId)
    events = Array.isArray(inspection?.events) ? inspection.events : []
  } else {
    return { ok: false, error: 'sessionController has neither events() nor inspect()' }
  }

  const messages = events.filter((event) => event?.type === 'assistant/message' && event?.data?.message)
  if (messages.length === 0) return { ok: false, error: 'session has no assistant message' }

  const wanted = typeof body.messageId === 'string' ? body.messageId : ''
  let picked = null
  if (wanted) {
    // 指定了消息就只认这一条：回退到别的消息会念错内容，宁可报错让用户等一等。
    const exact = messages.find((event) => String(event.data.message.id) === wanted)
    if (!exact) return { ok: false, error: '这条消息还没落盘，等它生成完再试' }
    const exactText = eventText(exact.data)
    if (!exactText) return { ok: false, error: '这条消息没有可朗读的正文' }
    return { ok: true, text: exactText }
  }

  {
    // 一个 turn 里每一步都会落一条 assistant/message，其中大多数只有 reasoning 与
    // tool-call；正文只出现在最后一步。所以从后往前扫，取第一条真有正文的。
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (eventText(messages[index].data)) {
        picked = messages[index]
        break
      }
    }
  }

  if (picked === null) {
    const last = messages[messages.length - 1].data
    const probe = {
      dataKeys: last !== null && typeof last === 'object' ? Object.keys(last) : [],
      messageKeys: last?.message !== null && typeof last?.message === 'object' ? Object.keys(last.message) : [],
      content: Array.isArray(last?.message?.content)
        ? last.message.content.map((block) => ({
          type: block?.type,
          keys: block !== null && typeof block === 'object' ? Object.keys(block) : [],
        }))
        : null,
      streamType: Array.isArray(last?.stream) ? 'array' : typeof last?.stream,
      streamSample: Array.isArray(last?.stream)
        ? last.stream.slice(0, 6).map((item) => {
          const chunk = item !== null && typeof item === 'object' ? item.chunk : item
          if (chunk === null || typeof chunk !== 'object') return typeof chunk
          return { type: chunk.type, keys: Object.keys(chunk), preview: JSON.stringify(chunk).slice(0, 140) }
        })
        : null,
    }
    const eventTypes = {}
    for (const event of events) eventTypes[String(event?.type)] = (eventTypes[String(event?.type)] ?? 0) + 1
    return {
      ok: false,
      error: '句子里没有可朗读的正文',
      debug: { total: messages.length, eventTypes, probe },
    }
  }

  const text = eventText(picked.data)
  if (!text) return { ok: false, error: 'message has no speakable text', debug: messageShape(picked.data.message) }
  return { ok: true, text }
}

/**
 * 注册路由与设置装配。
 * @param ctx - 插件上下文。
 * @param config - 已校验的插件配置，字段是跨更新保持同一身份的 volatile 引用。
 */
export function apply(ctx, config) {
  // 自动生成的配置表单对这几个字段只能给出朴素输入框，观感远不如插件自己的设置页，
  // 因此关掉自动表单，整页交给 client half 的「鲸语」设置页。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const web = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  if (!web || typeof web.register !== 'function') return

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const method = (req.method || 'GET').toUpperCase()
    const settings = currentSettings(config)

    try {
      if (method === 'GET' && route === '/voices') {
        return sendJson(res, 200, { ok: true, voices: VOICES })
      }

      if (method === 'GET' && route === '/config') {
        return sendJson(res, 200, { ok: true, config: settings })
      }

      if (method === 'POST' && route === '/say') {
        const body = await readBody(req)
        const result = await synthesize(settings, body.text, {
          voice: typeof body.voice === 'string' ? body.voice : '',
          rate: typeof body.rate === 'string' ? body.rate : '',
          pitch: typeof body.pitch === 'string' ? body.pitch : '',
        })
        if (!result.ok) return sendJson(res, 500, { ok: false, error: result.error })
        return sendAudio(res, result.buffer)
      }

      if (method === 'POST' && route === '/speak') {
        const body = await readBody(req)
        const resolved = await resolveSessionText(ctx, body)
        if (!resolved.ok) {
          return sendJson(res, 404, {
            ok: false,
            error: resolved.error,
            debug: body.debug === true ? resolved.debug : undefined,
          })
        }
        const result = await synthesize(settings, resolved.text)
        if (!result.ok) return sendJson(res, 500, { ok: false, error: result.error })
        return sendAudio(res, result.buffer)
      }

      return sendJson(res, 404, { ok: false, error: `unknown route ${method} ${route}` })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const disposers = []
  const off = ctx.effect(() => web.register({ kind: 'prefix', path: API_PREFIX, handler }), 'whale-voice routes')
  if (typeof off === 'function') disposers.push(off)

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        /* 已经卸载 */
      }
    }
  }
}

/**
 * dsh-whale-voice · Web client half
 *
 * 两处 UI：
 * 1. 设置 › 鲸语 —— 选音色 / 语速 / 音调、开自动朗读、点一下试听；
 * 2. 每条助手回复下方的「朗读」按钮 —— 点它，这条回复就用鲸语读出来。
 *
 * 文本不在浏览器侧取：`assistant-actions` 只给 `messageId`，
 * 正文交给 host（`/api/whale-voice/speak`）从会话日志里读，
 * 这里只负责发 sessionId / messageId，再把回来的 mp3 播出去。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-voice',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 配置命名空间，必须与 cordis.patch.yml 的 insert id 一致。 */
    const NAMESPACE = 'whale-voice'
    /** 语言包命名空间。 */
    const LOCALE_NS = 'whale-voice'
    /** host 路由前缀，必须与 lib/index.mjs 的 API_PREFIX 一致。 */
    const API = '/api/whale-voice'
    /** 每条助手消息的操作条插槽。 */
    const ACTION_SLOT = 'conversation.chat.assistant-actions'
    /** 设置页插槽。 */
    const SETTINGS_SLOT = 'settings.section'

    /** 试听句：与当初 demo 里那句一致，一听就知道是不是那只小鲸鱼。 */
    const SAMPLE = '主人～我是小鲸鱼。现在终于能开口说话啦！你听听，这个声音像不像海星呀？'

    /** 可选音色；id 与 host 的 VOICES 保持一致。 */
    const VOICES = [
      { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼' },
      { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔' },
      { id: 'zh-CN-liaoning-XiaobeiNeural', label: '小北 · 俏皮' },
      { id: 'zh-CN-shaanxi-XiaoniNeural', label: '小妮 · 明亮' },
    ]

    /** 语速档位。 */
    const RATES = ['-10%', '+0%', '+6%', '+12%', '+20%', '+30%']
    /** 音调档位。 */
    const PITCHES = ['-20Hz', '-10Hz', '+0Hz', '+10Hz', '+18Hz', '+30Hz']

    /** 中文文案。 */
    const zh = {
      'section.title': '鲸语',
      'section.subtitle': '让 Harness 用「海星」那一档的神经语音开口说话。',
      'section.rule': '朗读规矩：标点不念出来，只用来提示语气与停顿；代码块、表情和 Markdown 记号都会跳过。',
      'field.voice': '音色',
      'field.voice.hint': '晓伊最接近海星，晓晓更软。',
      'field.rate': '语速',
      'field.pitch': '音调',
      'field.auto': '自动朗读',
      'field.auto.hint': '开着的时候，新的回复会自动读出来。',
      'field.python': 'Python',
      'field.python.hint': '留空则自动找 py / python。',
      'field.pylibs': '依赖目录',
      'field.pylibs.hint': '留空则用插件自带的 pylibs。',
      'action.preview': '试听这一档',
      'action.stop': '别说了',
      'action.readonly': '当前部署只读，改不了设置。',
      'action.preparing': '准备中…',
      'action.speak': '朗读',
      'action.busy': '正在说话…',
    }

    /** 英文文案。 */
    const en = {
      'section.title': 'Whale Voice',
      'section.subtitle': 'Give the Harness a sea-star-flavoured neural voice.',
      'section.rule': 'Punctuation is never spoken — it only shapes tone and pauses. Code blocks, emoji and Markdown marks are skipped.',
      'field.voice': 'Voice',
      'field.voice.hint': 'Xiaoyi is the closest to the sea-star timbre.',
      'field.rate': 'Rate',
      'field.pitch': 'Pitch',
      'field.auto': 'Auto speak',
      'field.auto.hint': 'Read every new reply out loud.',
      'field.python': 'Python',
      'field.python.hint': 'Empty means auto-detect py / python.',
      'field.pylibs': 'Dependency dir',
      'field.pylibs.hint': 'Empty means the bundled pylibs folder.',
      'action.preview': 'Preview',
      'action.stop': 'Stop',
      'action.readonly': 'This deployment is read-only.',
      'action.preparing': 'Preparing…',
      'action.speak': 'Read aloud',
      'action.busy': 'Speaking…',
    }

    /** 页面首次加载的时刻，用来区分"历史消息"与"新到的回复"。 */
    const pageLoadedAt = Date.now()
    /** 上一次自动朗读过的 messageId，避免同一条读两遍。 */
    let lastAutoSpoken = ''

    /** 当前正在播的 Audio，全局只留一个，新的开口就掐掉旧的。 */
    let currentAudio = null
    /** 当前 Audio 对应的 blob URL，切换时要回收。 */
    let currentUrl = ''

    /**
     * 停掉正在播放的语音。
     */
    function stopSpeaking() {
      if (currentAudio) {
        try {
          currentAudio.pause()
        } catch {
          /* 已结束 */
        }
        currentAudio = null
      }
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl)
        currentUrl = ''
      }
    }

    /**
     * 播一段音频，顺便把上一段掐掉。
     * @param blob - audio/mpeg 数据。
     * @returns 这次播放的 Audio 对象（调用方可挂 ended 回调）。
     */
    function playBlob(blob) {
      stopSpeaking()
      currentUrl = URL.createObjectURL(blob)
      const audio = new Audio(currentUrl)
      currentAudio = audio
      const release = () => {
        if (currentAudio === audio) stopSpeaking()
      }
      audio.addEventListener('ended', release)
      audio.addEventListener('error', release)
      audio.play().catch(release)
      return audio
    }

    /** 已合成过的音频，按 messageId 缓存；同一条再点就不用再等一次合成。 */
    const audioCache = new Map()

    /**
     * 把一段合成好的音频记进缓存，超过 40 条就丢最旧的。
     * @param key - 缓存键（messageId）。
     * @param blob - audio/mpeg 数据。
     */
    function rememberBlob(key, blob) {
      audioCache.set(key, blob)
      while (audioCache.size > 40) audioCache.delete(audioCache.keys().next().value)
    }

    /**
     * 向 host 要一段音频。
     * @param path - 路由后缀（`/say` 或 `/speak`）。
     * @param body - 请求体。
     * @returns audio/mpeg blob。
     */
    async function requestAudio(path, body, signal) {
      const response = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })
      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const data = await response.json()
          if (data && typeof data.error === 'string' && data.error) message = data.error
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new Error(message)
      }
      const buffer = await response.arrayBuffer()
      return new Blob([buffer], { type: 'audio/mpeg' })
    }

    /** 共享样式，全部走主题 token，跟随深浅色。 */
    const styles = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '16px',
        borderRadius: 'var(--dsw-radius-md, 12px)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06))',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.24))',
      },
      row: { display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between' },
      column: { display: 'flex', flexDirection: 'column', gap: '2px' },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #1a1a1a)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', lineHeight: '18px' },
      control: {
        minWidth: '150px',
        padding: '6px 8px',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        fontSize: '13px',
      },
      primary: {
        padding: '7px 16px',
        borderRadius: '999px',
        border: 'none',
        background: 'var(--dsw-static-deepseek-500, #4176e6)',
        color: '#fff',
        fontSize: '13px',
        cursor: 'pointer',
      },
      ghost: {
        padding: '7px 16px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
      action: {
        display: 'inline-flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '5px',
        height: '28px',
        margin: 0,
        padding: '0 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #555)',
        fontSize: '12px',
        lineHeight: '1',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        cursor: 'pointer',
      },
      actionActive: {
        borderColor: 'var(--dsw-static-deepseek-500, #4176e6)',
        color: 'var(--dsw-static-deepseek-500, #4176e6)',
      },
      icon: { width: '14px', height: '14px', flexShrink: 0, display: 'block' },
      error: { fontSize: '12px', color: '#e5484d' },
    }

    /**
     * 喇叭图标（未播放态），跟随文字颜色。
     * @returns 14px 的内联 SVG。
     */
    function speakerIcon() {
      return h(
        'svg',
        { style: styles.icon, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M11 5.5 6.5 9.5H3.5v5h3L11 18.5v-13Z', fill: 'currentColor' }),
        h('path', { d: 'M15 8.6a4.6 4.6 0 0 1 0 6.8', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round' }),
      )
    }

    /**
     * 声波图标（播放中），点它就是"停下"。
     * @returns 14px 的内联 SVG。
     */
    function waveIcon() {
      return h(
        'svg',
        { style: styles.icon, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: '4', y: '9.5', width: '2.6', height: '5', rx: '1.3', fill: 'currentColor' }),
        h('rect', { x: '10.7', y: '6', width: '2.6', height: '12', rx: '1.3', fill: 'currentColor' }),
        h('rect', { x: '17.4', y: '8.5', width: '2.6', height: '7', rx: '1.3', fill: 'currentColor' }),
      )
    }

    /**
     * 把 configForms 快照接到一个组件上。
     * @param form - `ctx.configForms.get(NAMESPACE)` 的结果，可能为 undefined。
     * @returns `{ value, writable, set }`。
     */
    function useFormValue(form) {
      const [snapshot, setSnapshot] = React.useState(() => (form ? form.getSnapshot() : null))
      React.useEffect(() => {
        if (!form) return undefined
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [])

      const value = (snapshot && snapshot.value) || {}
      const writable = !snapshot || snapshot.writable !== false
      const set = React.useCallback(
        (key, next) => {
          if (!form || !writable) return Promise.resolve()
          return Promise.resolve(form.set(key, next)).catch(() => {})
        },
        [form, writable],
      )
      return { value, writable, set }
    }

    /**
     * 一个带说明的整行控件。
     * @param props - `{ labelText, hintText, children }`。
     * @returns 行元素。
     */
    function FieldRow(props) {
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.column },
          h('span', { style: styles.label }, props.labelText),
          props.hintText ? h('span', { style: styles.hint }, props.hintText) : null,
        ),
        props.children,
      )
    }

    /**
     * 构造设置页组件。
     * @param form - configForms 句柄。
     * @returns 设置页组件。
     */
    function createSettingsSection(form) {
      return function WhaleVoiceSettings(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key
        const { value, writable, set } = useFormValue(form)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState('')

        const voice = typeof value.voice === 'string' && value.voice ? value.voice : 'zh-CN-XiaoyiNeural'
        const rate = typeof value.rate === 'string' && value.rate ? value.rate : '+6%'
        const pitch = typeof value.pitch === 'string' && value.pitch ? value.pitch : '+10Hz'
        const autoSpeak = value.autoSpeak === true

        const preview = async () => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            const blob = await requestAudio('/say', { text: SAMPLE })
            playBlob(blob)
          } catch (failure) {
            setError(String(failure && failure.message ? failure.message : failure))
          } finally {
            setBusy(false)
          }
        }

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          h(
            'div',
            { style: styles.column },
            h('span', { style: { fontSize: '15px', fontWeight: 600 } }, t('section.title')),
            h('span', { style: styles.hint }, t('section.subtitle')),
          ),
          h(
            'div',
            { style: styles.card },
            h(
              FieldRow,
              { labelText: t('field.voice'), hintText: t('field.voice.hint') },
              h(
                'select',
                {
                  style: styles.control,
                  value: voice,
                  disabled: !writable,
                  onChange: (event) => set('voice', event.target.value),
                },
                VOICES.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
              ),
            ),
            h(
              FieldRow,
              { labelText: t('field.rate') },
              h(
                'select',
                {
                  style: styles.control,
                  value: rate,
                  disabled: !writable,
                  onChange: (event) => set('rate', event.target.value),
                },
                RATES.map((entry) => h('option', { key: entry, value: entry }, entry)),
              ),
            ),
            h(
              FieldRow,
              { labelText: t('field.pitch') },
              h(
                'select',
                {
                  style: styles.control,
                  value: pitch,
                  disabled: !writable,
                  onChange: (event) => set('pitch', event.target.value),
                },
                PITCHES.map((entry) => h('option', { key: entry, value: entry }, entry)),
              ),
            ),
            h(
              FieldRow,
              { labelText: t('field.auto'), hintText: t('field.auto.hint') },
              h('input', {
                type: 'checkbox',
                checked: autoSpeak,
                disabled: !writable,
                style: { width: '18px', height: '18px', cursor: 'pointer' },
                onChange: (event) => set('autoSpeak', event.target.checked),
              }),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
              h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: preview }, busy ? t('action.busy') : t('action.preview')),
              h('button', { type: 'button', style: styles.ghost, onClick: stopSpeaking }, t('action.stop')),
            ),
            error ? h('span', { style: styles.error }, error) : null,
            writable ? null : h('span', { style: styles.hint }, t('action.readonly')),
            h('span', { style: styles.hint }, t('section.rule')),
          ),
          h(
            'div',
            { style: styles.card },
            h(
              FieldRow,
              { labelText: t('field.python'), hintText: t('field.python.hint') },
              h('input', {
                type: 'text',
                style: styles.control,
                value: typeof value.python === 'string' ? value.python : '',
                placeholder: 'py',
                disabled: !writable,
                onChange: (event) => set('python', event.target.value),
              }),
            ),
            h(
              FieldRow,
              { labelText: t('field.pylibs'), hintText: t('field.pylibs.hint') },
              h('input', {
                type: 'text',
                style: styles.control,
                value: typeof value.pylibs === 'string' ? value.pylibs : '',
                placeholder: 'pylibs',
                disabled: !writable,
                onChange: (event) => set('pylibs', event.target.value),
              }),
            ),
          ),
        )
      }
    }

    /**
     * 构造"朗读这一条"的按钮组件。
     * @param form - configForms 句柄，用来判断要不要自动朗读。
     * @returns 操作条组件。
     */
    function createSpeakAction(form) {
      return function WhaleVoiceSpeakAction(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key
        const { value } = useFormValue(form)
        // idle → loading（等音频）→ playing（在播）；loading 与 playing 时点一下都是停。
        const [phase, setPhase] = React.useState('idle')
        const [error, setError] = React.useState('')
        /** 这一次点出来的音频；只有它自己播完才该把按钮还原。 */
        const ownedAudio = React.useRef(null)
        /** 正在等音频的那次请求；手动停止时掐掉它。 */
        const pending = React.useRef(null)

        const messageId = typeof props.messageId === 'string' ? props.messageId : ''
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''

        const speak = React.useCallback(async () => {
          if (!sessionId) {
            setError('no session')
            return
          }
          if (pending.current) pending.current.abort()
          const controller = new AbortController()
          pending.current = controller
          setPhase('loading')
          setError('')
          try {
            const cached = messageId ? audioCache.get(messageId) : undefined
            const blob = cached || (await requestAudio('/speak', { sessionId, messageId }, controller.signal))
            if (controller.signal.aborted) return
            pending.current = null
            if (messageId && !cached) rememberBlob(messageId, blob)
            const audio = playBlob(blob)
            ownedAudio.current = audio
            setPhase('playing')
            const settle = () => {
              // 只还原"这一次点出来的"那一段；被新播放顶掉的旧音频不许动状态。
              if (ownedAudio.current !== audio) return
              ownedAudio.current = null
              setPhase('idle')
            }
            audio.addEventListener('ended', settle)
            audio.addEventListener('error', settle)
          } catch (failure) {
            if (controller.signal.aborted) return
            pending.current = null
            setPhase('idle')
            setError(String(failure && failure.message ? failure.message : failure))
          }
        }, [sessionId, messageId])

        const stop = React.useCallback(() => {
          if (pending.current) {
            pending.current.abort()
            pending.current = null
          }
          ownedAudio.current = null
          stopSpeaking()
          setPhase('idle')
        }, [])

        React.useEffect(
          () => () => {
            if (pending.current) pending.current.abort()
          },
          [],
        )

        React.useEffect(() => {
          if (value.autoSpeak !== true) return
          if (!messageId || lastAutoSpoken === messageId) return
          // 页面刚打开时挂载的都是历史消息，别一口气全念一遍。
          if (Date.now() - pageLoadedAt < 3000) return
          lastAutoSpoken = messageId
          speak()
        }, [])

        const busy = phase === 'loading'
        const active = phase === 'playing'
        const label = error
          ? '⚠️ ' + t('action.speak')
          : busy
            ? t('action.preparing')
            : active
              ? t('action.stop')
              : t('action.speak')

        return h(
          'button',
          {
            type: 'button',
            style: active || busy ? { ...styles.action, ...styles.actionActive } : styles.action,
            title: error || label,
            onClick: active || busy ? stop : speak,
          },
          active || busy ? waveIcon() : speakerIcon(),
          h('span', null, label),
        )
      }
    }

    /**
     * 挂载语言包、设置页与消息朗读按钮。
     * @param ctx - client 插件上下文。
     */
    function apply(ctx) {
      const form = ctx.configForms && typeof ctx.configForms.get === 'function' ? ctx.configForms.get(NAMESPACE) : undefined

      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'whale-voice locale')

      ctx.slots.inject(SETTINGS_SLOT, () =>
        ctx.slots.register(
          {
            name: SETTINGS_SLOT,
            id: NAMESPACE,
            order: 105,
            label: () => '🐋 ' + ctx.locale.bind(LOCALE_NS)('section.title'),
            locale: LOCALE_NS,
          },
          createSettingsSection(form),
        ),
      )

      ctx.slots.inject(ACTION_SLOT, () =>
        ctx.slots.register(
          {
            name: ACTION_SLOT,
            id: NAMESPACE + '-speak',
            order: 20,
            label: () => ctx.locale.bind(LOCALE_NS)('action.speak'),
            locale: LOCALE_NS,
          },
          createSpeakAction(form),
        ),
      )
    }

    return {
      inject: ['slots', 'configForms', 'locale'],
      apply,
    }
  },
})

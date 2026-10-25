import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Icon } from './icons'
import type { IconName } from './icons'
import type { ApiState, DonePayload, HistoryEntry, MetaInfo, Mode, Preset, ProbeResult, ProgressData, Quality } from './types'
import {
  BUILTIN_PRESETS,
  MAX_FPS,
  DEFAULT_JOB_TIMEOUT_MS,
  classifyFailure,
  estimateOutputBytes,
  stalledReasonText,
  targetFpsForPreset,
  terminalDeadlineMs,
  withDeadline
} from '../electron/pipeline'

type Screen = 'empty' | 'ready' | 'running' | 'paused' | 'done'
type ItemStatus = 'pending' | 'rendering' | 'done' | 'error' | 'cancelled'

interface QueueItem {
  id: number
  path: string
  fileName: string
  info: ProbeResult
  previewUrl: string
  status: ItemStatus
  progress?: ProgressData
  error?: string
  steps?: string[]
  log?: string
  notes: string[]
  result?: DonePayload
  encoder?: string
}

interface Prefs {
  presetId: string
  mode: Mode
  quality: Quality
  mult: number // 0 = 自定义绝对帧率
  customFps: string
  container: 'mp4' | 'mkv'
  useNvenc: boolean
  outDir: string
}

const PREF_KEY = 'frameboost.prefs.v3'
const DEFAULT_PREFS: Prefs = {
  presetId: 'preset-smooth',
  mode: 'balanced',
  quality: 'high',
  mult: 2,
  customFps: '60',
  container: 'mp4',
  useNvenc: true,
  outDir: ''
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    /* ignore */
  }
  return DEFAULT_PREFS
}

const VIDEO_ACCEPT = '.mp4,.mkv,.mov,.avi,.webm,.flv,.ts,.m4v,.mpg,.mpeg,.wmv,.3gp,.vob,.ogv,.m2ts'

const MODES: { id: Mode; title: string; desc: string; quality: number; detail: string }[] = [
  {
    id: 'high',
    title: '光流 · 精细',
    desc: '双向运动估计 + 自适应分块，运动最顺滑',
    quality: 3,
    detail: 'AOBMC 自适应分块 + 双向运动估计 + 变分加权。画质最佳，速度最慢。'
  },
  {
    id: 'balanced',
    title: '光流 · 均衡',
    desc: 'OBMC 运动补偿，速度与画质兼顾',
    quality: 2,
    detail: 'OBMC 运动补偿插帧，速度与画质平衡，适合大多数视频。'
  },
  {
    id: 'fast',
    title: '帧混合',
    desc: '相邻帧加权融合，接近实时处理',
    quality: 1,
    detail: '相邻帧加权融合，接近实时处理；快速运动场景略有拖影。'
  }
]

const QUALITIES: { id: Quality; title: string; desc: string }[] = [
  { id: 'master', title: '母版级', desc: 'CRF 10 · 视觉无损' },
  { id: 'high', title: '高画质', desc: 'CRF 16 · 推荐' },
  { id: 'standard', title: '标准', desc: 'CRF 20 · 体积小' }
]

/** 真实执行步骤：与主进程 setStage 的取值一一对应，不是装饰用的进度条 */
const STEPS: { stage: string; label: string }[] = [
  { stage: 'probe', label: '探测源文件' },
  { stage: 'preflight', label: '能力与磁盘预检' },
  { stage: 'encode', label: '补帧编码' },
  { stage: 'finalize', label: '写入产物' },
  { stage: 'reprobe', label: '回探产物' }
]

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const two = String(ss).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${two}` : `${m}:${two}`
}

function fmtSize(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

function fmtFps(f: number): string {
  return Number.isFinite(f) && f > 0 ? String(Math.round(f * 100) / 100) : '—'
}

function fmtWhen(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function fileUrl(p: string): string {
  return encodeURI('file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''))
}

function splitPath(p: string): { dir: string; base: string; sep: string } {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return {
    dir: p.slice(0, idx),
    base: p.slice(idx + 1).replace(/\.[^.]+$/, ''),
    sep: p.includes('\\') ? '\\' : '/'
  }
}

function defaultOutput(src: string, fps: number, container: string, outDir?: string): string {
  const { base } = splitPath(src)
  const dir = outDir || splitPath(src).dir
  const sep = (dir.includes('\\') || src.includes('\\')) ? '\\' : '/'
  return `${dir}${dir.endsWith(sep) ? '' : sep}${base}_${fps}fps.${container}`
}

function srcFpsOf(info: ProbeResult): number {
  return info.fps > 0 ? info.fps : info.avgFps
}

function is10Bit(info: ProbeResult): boolean {
  return /10le|10be/.test(info.pixFmt)
}

function isHdr(info: ProbeResult): boolean {
  return /^(smpte2084|arib-std-b67)$/.test(info.colorTrc)
}

const ST_META: Record<ItemStatus, { icon: IconName; text: string }> = {
  pending: { icon: 'clock', text: '等待中' },
  rendering: { icon: 'play', text: '处理中' },
  done: { icon: 'check', text: '已完成' },
  error: { icon: 'cross', text: '失败' },
  cancelled: { icon: 'dash', text: '已取消' }
}

function prefsFromPreset(p: Preset): Prefs {
  return {
    presetId: p.id,
    mode: p.mode,
    quality: p.quality,
    mult: p.multiplier,
    customFps: String(p.customFps),
    container: p.container,
    useNvenc: p.useNvenc,
    outDir: ''
  }
}

function samePreset(prefs: Prefs, p: Preset): boolean {
  return (
    prefs.mode === p.mode &&
    prefs.quality === p.quality &&
    prefs.mult === p.multiplier &&
    Math.round(Number(prefs.customFps) || 0) === p.customFps &&
    prefs.container === p.container &&
    prefs.useNvenc === p.useNvenc
  )
}

export default function App() {
  const hasApi = typeof window !== 'undefined' && !!window.api
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [items, setItems] = useState<QueueItem[]>([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [currentItemId, setCurrentItemId] = useState<number | null>(null)
  const [screen, setScreen] = useState<Screen>('empty')
  const [outputPath, setOutputPath] = useState('')
  const [outputLocked, setOutputLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [toast, setToast] = useState('')
  const [meta, setMeta] = useState<MetaInfo | null>(null)
  // 应用内 REST（8393）的真实状态：绑失败时界面要显示原因，而不是让人以为接口在
  const [apiState, setApiState] = useState<ApiState | null>(null)
  const [command, setCommand] = useState('')
  const [presets, setPresets] = useState<Preset[]>(BUILTIN_PRESETS)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [showRunInfo, setShowRunInfo] = useState(false)
  // 预览失败（编码不受支持 / file:// 被拦）时收起 <video>，别让原生播放器占着位置
  const [videoBroken, setVideoBroken] = useState(false)
  // 队列拖拽排序的当前拖起项与悬停项
  // 拖起项同时存一份 ref：dragstart 与 drop 有可能被同一个任务里派发（自动化/触控板），
  // 只靠 state 会读到还没提交的旧值，drop 就成了空操作。
  const [dragId, setDragId] = useState<number | null>(null)
  const dragIdRef = useRef<number | null>(null)
  const [dropId, setDropId] = useState<number | null>(null)
  const [savingPreset, setSavingPreset] = useState(false)
  const [presetName, setPresetName] = useState('')

  const runningRef = useRef(false)
  const pausedRef = useRef(false)
  const currentIdRef = useRef<number | null>(null)
  const abortCurrentRef = useRef(false)
  const terminalResolvers = useRef(new Map<number, (v: 'done' | 'error' | 'cancelled') => void>())
  const nextIdRef = useRef(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveRef = useRef({ prefs, outputLocked, outputPath })
  liveRef.current = { prefs, outputLocked, outputPath }
  // 主进程报回来的时限（FRAMEBOOST_JOB_TIMEOUT_MS）：队列等终态要按它算，不能各写一个数
  const metaRef = useRef<MetaInfo | null>(null)
  metaRef.current = meta

  const sel = items.find((i) => i.id === selectedId) ?? items[0] ?? null
  const currentItem = items.find((i) => i.id === currentItemId) ?? null
  const selFps = sel ? srcFpsOf(sel.info) : 0
  const activePreset = presets.find((p) => p.id === prefs.presetId) ?? null
  const presetDirty = !activePreset || !samePreset(prefs, activePreset)
  const targetFps = targetFpsForPreset(
    { multiplier: prefs.mult, customFps: Math.round(Number(prefs.customFps) || 0) },
    selFps
  )
  const fpsValid = targetFps > 0 && selFps > 0 && targetFps > selFps
  const pendingItems = items.filter((i) => i.status === 'pending')
  const pendingCount = pendingItems.length
  const doneCount = items.filter((i) => i.status === 'done').length
  const failedCount = items.filter((i) => i.status === 'error' || i.status === 'cancelled').length
  const running = screen === 'running'
  const paused = screen === 'paused'
  const nvencLevel = meta?.nvenc ?? null
  const nvencUnavailable = nvencLevel === 'none'
  const is4K = !!sel && sel.info.width * sel.info.height >= 3_500_000
  const overallPercent = items.length
    ? items.reduce((a, i) => a + (i.status === 'done' || i.status === 'error' || i.status === 'cancelled' ? 100 : i.status === 'rendering' ? (i.progress?.percent ?? 0) : 0), 0) / items.length
    : 0
  const livePercent = Math.min(100, currentItem?.progress?.percent ?? 0)
  const liveStage = currentItem?.progress?.stage ?? 'encode'
  const liveStageIdx =
    liveStage === 'retry'
      ? STEPS.findIndex((s) => s.stage === 'encode')
      : STEPS.findIndex((s) => s.stage === liveStage)
  const modeTitle = MODES.find((m) => m.id === prefs.mode)?.title ?? ''
  const qualityTitle = QUALITIES.find((q) => q.id === prefs.quality)?.title ?? ''
  // 预估产物体积：与主进程预检用的是同一个纯函数，界面上的数字与"磁盘够不够"的判断不会两套
  const estBytes = sel ? estimateOutputBytes(sel.info, targetFps || 0, prefs.quality) : 0
  // 队列结束后"打开输出目录"要用最后一条成功的产物；一条都没成就不显示这个按钮
  const lastOutputPath = items.filter((i) => i.status === 'done' && i.result).at(-1)?.result?.outputPath ?? ''

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 5200)
  }, [])

  const patchItem = useCallback((id: number, patch: Partial<QueueItem>) => {
    const next = itemsRef.current.map((i) => (i.id === id ? { ...i, ...patch } : i))
    itemsRef.current = next
    setItems(next)
  }, [])

  const refreshHistory = useCallback(() => {
    if (!hasApi) return
    void window.api.history
      .list()
      .then((r) => setHistory(r.entries ?? []))
      .catch(() => undefined)
  }, [hasApi])

  const addByPath = useCallback(
    async (p: string, preview?: string) => {
      try {
        // 先把"用户打开了这个文件"登记到主进程：之后 REST / Agent 想读同一份文件才过得去归属判定，
        // 而没被用户打开过的路径一律拒。登记失败（老界面替身、无 API）不影响本地流程。
        await window.api.registerFiles?.([p]).catch(() => undefined)
        const r = await window.api.probe(p)
        if (!r.ok || !r.info) {
          showToast(r.error ?? '视频解析失败')
          if (r.steps?.length) console.warn('[frameboost] 添加失败下一步：', r.steps.join(' / '))
          return
        }
        const item: QueueItem = {
          id: nextIdRef.current++,
          path: p,
          fileName: r.info.fileName,
          info: r.info,
          previewUrl: preview ?? fileUrl(p),
          status: 'pending',
          notes: []
        }
        itemsRef.current = [...itemsRef.current, item]
        setItems(itemsRef.current)
        setSelectedId(item.id)
        setVideoBroken(false)
        setScreen((s) => (s === 'running' || s === 'paused' ? s : 'ready'))
        if (itemsRef.current.length > 1) {
          setOutputLocked(false)
          setOutputPath('')
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e))
      }
    },
    [showToast]
  )

  // 拖放与「选择文件」的真实路径由 preload 转上来（File 经 contextBridge 会变克隆体，
  // 渲染层再调 webUtils.getPathForFile 只会拿到空字符串，实测打包版里加不进素材）。
  const addPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return
      setBusy(true)
      try {
        for (const p of paths) await addByPath(p)
      } finally {
        setBusy(false)
      }
    },
    [addByPath]
  )

  const addViaDialog = useCallback(async () => {
    const paths = await window.api.pickVideo()
    for (const p of paths ?? []) await addByPath(p)
  }, [addByPath])

  // ---------- 队列引擎：一次跑一条，失败只影响单条 ----------

  const planOutputFor = useCallback((item: QueueItem, tf: number): string => {
    const { prefs: livePrefs, outputLocked: locked, outputPath: customOut } = liveRef.current
    if (itemsRef.current.length === 1 && locked && customOut) return customOut
    return defaultOutput(item.path, tf, livePrefs.container, livePrefs.outDir)
  }, [])

  const runLoop = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    pausedRef.current = false
    setScreen('running')
    try {
      while (!pausedRef.current) {
        const next = itemsRef.current.find((i) => i.status === 'pending')
        if (!next) break
        const src = srcFpsOf(next.info)
        const live = liveRef.current.prefs
        const tf = targetFpsForPreset({ multiplier: live.mult, customFps: Math.round(Number(live.customFps) || 0) }, src)
        if (!(tf > 0) || !(src > 0) || tf <= src + 0.01) {
          patchItem(next.id, {
            status: 'error',
            error: tf > 0 && src > 0 ? '目标帧率没有高于源帧率' : '目标帧率无效或超出范围',
            steps:
              src > 0
                ? [`这条源是 ${fmtFps(src)} fps，把倍率调到 ×2 以上或把自定义帧率填得更高`, '想只重跑这一条：选中它后点「重试这一条」']
                : ['这份文件读不到帧率，先确认它能正常播放']
          })
          continue
        }
        currentIdRef.current = next.id
        abortCurrentRef.current = false
        setCurrentItemId(next.id)
        // 跟着跑到哪条：预览与结果卡都切到正在处理的这一条，别让用户盯着上一条的"等待中"
        setSelectedId(next.id)
        setVideoBroken(false)
        patchItem(next.id, {
          status: 'rendering',
          progress: undefined,
          error: undefined,
          steps: undefined,
          log: undefined,
          notes: [],
          result: undefined,
          encoder: undefined
        })
        const res = await window.api.startRender({
          inputPath: next.path,
          outputPath: planOutputFor(next, tf),
          targetFps: tf,
          mode: live.mode,
          quality: live.quality,
          useNvenc: live.useNvenc,
          container: live.container
        })
        if (!res.ok) {
          patchItem(next.id, {
            status: 'error',
            error: res.title || res.error || '启动失败',
            steps: res.steps ?? [],
            log: res.log ?? ''
          })
          currentIdRef.current = null
          continue
        }
        setCommand(res.command || '')
        patchItem(next.id, { encoder: res.encoderLabel })
        // 等终态必须有截止时间：主进程那侧已经有任务时限与回探超时，
        // 这里再兜一层 —— 万一终态事件整个没来（主进程卡住、窗口被换掉），
        // 队列也不能永远停在这一行上。到点按失败收口，后面的任务继续跑。
        const jobMs = metaRef.current?.timeouts?.jobMs ?? DEFAULT_JOB_TIMEOUT_MS
        const waitMs = terminalDeadlineMs(jobMs)
        let term: 'done' | 'error' | 'cancelled'
        try {
          term = await withDeadline(
            new Promise<'done' | 'error' | 'cancelled'>((resolve) => {
              terminalResolvers.current.set(next.id, resolve)
            }),
            waitMs,
            'RENDER_TIMEOUT',
            stalledReasonText(waitMs)
          )
        } catch (e) {
          terminalResolvers.current.delete(next.id)
          const f = classifyFailure({ code: 'RENDER_TIMEOUT', message: stalledReasonText(waitMs) })
          patchItem(next.id, {
            status: 'error',
            error: f.title,
            steps: f.steps,
            log: e instanceof Error ? e.message : String(e)
          })
          void window.api.cancelRender().catch(() => undefined)
          currentIdRef.current = null
          continue
        }
        terminalResolvers.current.delete(next.id)
        currentIdRef.current = null
        if (term === 'cancelled' && abortCurrentRef.current) {
          // 「停止队列」：当前这条已取消，剩下的不再开跑，等用户点继续
          pausedRef.current = true
          break
        }
      }
    } finally {
      runningRef.current = false
      setCurrentItemId(null)
      const stillPending = itemsRef.current.some((i) => i.status === 'pending')
      setScreen(pausedRef.current && stillPending ? 'paused' : 'done')
      refreshHistory()
    }
  }, [patchItem, planOutputFor, refreshHistory])

  const pauseQueue = useCallback(
    (alsoCancelCurrent: boolean) => {
      pausedRef.current = true
      if (alsoCancelCurrent && currentIdRef.current != null) {
        abortCurrentRef.current = true
        void window.api.cancelRender()
      }
      if (!runningRef.current) setScreen('paused')
    },
    []
  )

  const resumeQueue = useCallback(() => {
    if (runningRef.current) return
    pausedRef.current = false
    setScreen('running')
    void runLoop()
  }, [runLoop])

  const cancelCurrent = useCallback(() => {
    abortCurrentRef.current = false
    void window.api.cancelRender()
  }, [])

  const skipPending = useCallback(() => {
    if (running) pauseQueue(false)
    const next = itemsRef.current.map((i) =>
      i.status === 'pending' ? { ...i, status: 'cancelled' as const } : i
    )
    itemsRef.current = next
    setItems(next)
  }, [pauseQueue, running])

  const removeItem = useCallback(
    (id: number) => {
      const it = itemsRef.current.find((i) => i.id === id)
      if (!it || (it.status === 'rendering' && running)) return
      if (it.previewUrl.startsWith('blob:')) URL.revokeObjectURL(it.previewUrl)
      const next = itemsRef.current.filter((i) => i.id !== id)
      itemsRef.current = next
      setItems(next)
      if (selectedId === id) setSelectedId(null)
      if (!next.length) setScreen('empty')
    },
    [running, selectedId]
  )

  const moveItem = useCallback((id: number, delta: number) => {
    const arr = [...itemsRef.current]
    const i = arr.findIndex((x) => x.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= arr.length) return
    if (arr[i].status === 'rendering') return
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    itemsRef.current = arr
    setItems(arr)
  }, [])

  /** 拖拽排序：把 from 挪到 to 的位置（正在跑的那条不动，它会跟着队列一起被重排） */
  const reorderItem = useCallback(
    (fromId: number, toId: number) => {
      if (fromId === toId) return
      const arr = [...itemsRef.current]
      const from = arr.findIndex((x) => x.id === fromId)
      const to = arr.findIndex((x) => x.id === toId)
      if (from < 0 || to < 0) return
      const moving = arr[from]
      if (moving.status === 'rendering') return
      const [picked] = arr.splice(from, 1)
      arr.splice(to, 0, picked)
      itemsRef.current = arr
      setItems(arr)
    },
    []
  )

  const resetToPending = useCallback(
    (id: number) => {
      patchItem(id, { status: 'pending', error: undefined, steps: undefined, log: undefined, notes: [], progress: undefined, result: undefined })
      setSelectedId(id)
      setScreen((s) => (s === 'running' ? 'running' : 'ready'))
    },
    [patchItem]
  )

  const retryAllFailed = useCallback(() => {
    if (running) return
    const next = itemsRef.current.map((i) =>
      i.status === 'error' || i.status === 'cancelled'
        ? { ...i, status: 'pending' as const, error: undefined, steps: undefined, log: undefined, notes: [] as string[] }
        : i
    )
    itemsRef.current = next
    setItems(next)
    void runLoop()
  }, [running, runLoop])

  const clearFinished = useCallback(() => {
    if (running) return
    const keep = itemsRef.current.filter((i) => i.status === 'pending')
    itemsRef.current.forEach((i) => {
      if (i.status !== 'pending' && i.previewUrl.startsWith('blob:')) URL.revokeObjectURL(i.previewUrl)
    })
    itemsRef.current = keep
    setItems(keep)
    setSelectedId(null)
    setScreen(keep.length ? 'ready' : 'empty')
  }, [running])

  const enqueueHistoryEntry = useCallback(
    (e: HistoryEntry) => {
      void addByPath(e.inputPath)
      showToast(`已把「${e.fileName}」重新加入队列`)
    },
    [addByPath, showToast]
  )

  const chooseOutput = useCallback(async () => {
    const def = outputPath || (sel ? defaultOutput(sel.path, targetFps || 60, prefs.container, prefs.outDir) : 'output.mp4')
    const p = await window.api.pickOutput(def)
    if (p) {
      setOutputPath(p)
      setOutputLocked(true)
    }
  }, [outputPath, sel, targetFps, prefs.container, prefs.outDir])

  const chooseOutDir = useCallback(async () => {
    const dir = await window.api.pickDir()
    if (dir === null) return
    setPref('outDir', dir)
    setOutputLocked(false)
    setOutputPath('')
  }, [])

  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [k]: v }))
  }, [])

  const changeContainer = useCallback(
    (v: 'mp4' | 'mkv') => {
      setPref('container', v)
      setOutputLocked(false)
      setOutputPath('')
    },
    [setPref]
  )

  const applyPreset = useCallback((p: Preset) => {
    setPrefs((prev) => ({ ...prefsFromPreset(p), outDir: prev.outDir }))
    setOutputLocked(false)
    setOutputPath('')
  }, [])

  const savePreset = useCallback(() => {
    const name = presetName.trim()
    if (!name) {
      showToast('请先给预设起个名字')
      return
    }
    const draft: Preset = {
      id: `user-${Date.now().toString(36)}`,
      name,
      mode: prefs.mode,
      quality: prefs.quality,
      container: prefs.container,
      useNvenc: prefs.useNvenc,
      multiplier: prefs.mult,
      customFps: Math.round(Number(prefs.customFps) || 60),
      builtin: false
    }
    void window.api.presets.save(draft).then((r) => {
      if (!r.ok || !r.presets) {
        showToast(r.error ?? '保存失败')
        return
      }
      setPresets(r.presets)
      setPrefs((p) => ({ ...p, presetId: draft.id }))
      setSavingPreset(false)
      setPresetName('')
      showToast(`已保存预设「${name}」`)
    })
  }, [presetName, prefs, showToast])

  const removePreset = useCallback(
    (id: string) => {
      void window.api.presets.remove(id).then((r) => {
        if (!r.ok || !r.presets) {
          showToast(r.error ?? '删除失败')
          return
        }
        setPresets(r.presets)
        if (prefs.presetId === id) setPrefs((p) => ({ ...p, ...prefsFromPreset(r.presets![0]) }))
      })
    },
    [prefs.presetId, showToast]
  )

  const exportPresets = useCallback(() => {
    void window.api.presets.export().then((r) => {
      if (r.canceled) return
      if (!r.ok) showToast(r.error ?? '导出失败')
      else showToast(`已导出 ${r.count} 条自定义预设到 ${r.path}`)
    })
  }, [showToast])

  const importPresets = useCallback(() => {
    void window.api.presets.import().then((r) => {
      if (r.canceled) return
      if (!r.ok) {
        showToast(r.error ?? '导入失败')
        return
      }
      if (r.presets) setPresets(r.presets)
      showToast(`已导入 ${r.added} 条预设${r.rejected ? `，跳过 ${r.rejected} 条不合法` : ''}`)
    })
  }, [showToast])

  // ---------- 副作用 ----------

  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }, [prefs])

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.types?.includes('Files')) setDragOver(true)
    }
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      if (!e.relatedTarget) setDragOver(false)
    }
    // 真正的落盘路径由 preload 取（见 onFilesPicked），这里只负责拖拽遮罩的显隐
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  useEffect(() => {
    if (!hasApi) return
    const offs = [
      // 拖放 / 文件选择：路径由 preload 取好送上来，这里统一进添加流程
      window.api.onFilesPicked?.((paths) => {
        setDragOver(false)
        void addPaths(paths)
      }),
      window.api.onProgress((d) => {
        const id = currentIdRef.current
        if (id != null) patchItem(id, { progress: d })
      }),
      window.api.onStage((d) => {
        const id = currentIdRef.current
        if (id == null) return
        const cur = itemsRef.current.find((i) => i.id === id)
        patchItem(id, {
          progress: { ...(cur?.progress ?? emptyProgress()), stage: d.stage, stageLabel: d.label },
          encoder: d.encoder || cur?.encoder
        })
      }),
      window.api.onRetry((d) => {
        const id = currentIdRef.current
        if (id != null) {
          const cur = itemsRef.current.find((i) => i.id === id)
          patchItem(id, { notes: [...(cur?.notes ?? []), d.reason], encoder: d.encoderLabel || cur?.encoder })
        }
      }),
      window.api.onNotice((d) => {
        // 预检阶段的通告也归属当前这条（currentIdRef 在 startRender 之前就已置好）
        const id = currentIdRef.current
        if (id == null) {
          showToast(d.message)
          return
        }
        const cur = itemsRef.current.find((i) => i.id === id)
        patchItem(id, { notes: [...(cur?.notes ?? []), d.message] })
      }),
      window.api.onDone((d) => {
        const id = currentIdRef.current
        if (id == null) return
        patchItem(id, { status: 'done', result: d, encoder: d.encoder })
        terminalResolvers.current.get(id)?.('done')
      }),
      window.api.onError((d) => {
        const id = currentIdRef.current
        if (id == null) return
        patchItem(id, {
          status: 'error',
          error: d.title || d.message,
          steps: d.steps ?? [],
          log: d.log ?? ''
        })
        terminalResolvers.current.get(id)?.('error')
      }),
      window.api.onCancelled(() => {
        const id = currentIdRef.current
        if (id == null) return
        patchItem(id, { status: 'cancelled' })
        terminalResolvers.current.get(id)?.('cancelled')
      })
    ]
    void window.api.getMeta().then(setMeta).catch(() => undefined)
    // 应用内 REST 的真实状态：起没起来、为什么没起来，界面要说得出
    void window.api.apiStatus?.().then(setApiState).catch(() => undefined)
    const offApi = window.api.onApiState?.((d) => setApiState(d))
    void window.api.presets
      .list()
      .then((r) => {
        if (r.presets) setPresets(r.presets)
        if (r.error) console.warn('[frameboost]', r.error)
      })
      .catch(() => undefined)
    refreshHistory()
    return () => {
      offs.forEach((o) => o?.())
      offApi?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 底部 dock 是 fixed 的，高度随状态变化（空闲 / 运行 / 展开详情）：
  // 实测高度写进 --dock-h，主区底部留白才能永远刚好让开它。
  const dockRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = dockRef.current
    if (!el) return
    const apply = () => {
      const h = Math.ceil(el.getBoundingClientRect().height)
      document.documentElement.style.setProperty('--dock-h', `${h}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 键盘可达：Enter 开始，Delete 移出队列，Esc 暂停，Ctrl+O 添加素材
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const tag = t?.tagName ?? ''
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || t?.isContentEditable === true
      if (typing) return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        if (!busyRef.current) void addViaDialog()
        return
      }
      if (e.key === 'Enter' && !e.repeat) {
        if (!running && canStartRef.current) {
          e.preventDefault()
          void runLoop()
        }
      } else if (e.key === 'Escape' && runningRef.current) {
        // 跑着的时候 Esc = 跑完当前这条就停（与「暂停」同一个动作，不误杀正在编码的这条）
        e.preventDefault()
        pauseQueue(false)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId != null && !running) {
        const it = itemsRef.current.find((i) => i.id === selectedId)
        if (it && it.status !== 'rendering') {
          e.preventDefault()
          removeItem(selectedId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runLoop, removeItem, selectedId, running, pauseQueue, addViaDialog])

  const canStart = !running && pendingCount > 0 && (items.length > 1 || fpsValid)
  const canStartRef = useRef(canStart)
  canStartRef.current = canStart
  const busyRef = useRef(busy)
  busyRef.current = busy

  const badge = metaBadge(meta)
  const autoOut = sel && items.length === 1 ? defaultOutput(sel.path, targetFps || 60, prefs.container, prefs.outDir) : ''
  const shownOut = items.length === 1 ? (outputLocked ? outputPath : autoOut) : ''

  const onTitlebarDoubleClick = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, select, textarea')) return
    void window.api?.windowControls?.toggleMaximize()
  }, [])

  return (
    <>
      <header className="topbar" onDoubleClick={onTitlebarDoubleClick}>
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="2.6" y="5" width="4.4" height="14" rx="1.7" fill="currentColor" />
              <rect x="9.8" y="5" width="4.4" height="14" rx="1.7" fill="currentColor" opacity=".42" />
              <rect x="17" y="5" width="4.4" height="14" rx="1.7" fill="currentColor" />
            </svg>
          </span>
          <span className="brand-text">
            <strong>FrameBoost</strong>
            <em>本地视频补帧工作台</em>
          </span>
        </div>

        <div className="topbar-status">
          <span
            className={'status-pill ' + badge.cls}
            title={meta?.nvencReason ?? '正在用本机 ffmpeg 实测能力'}
          >
            <Icon name={badge.icon} size={13} />
            {badge.text}
          </span>
          {meta?.ffmpegVersion && (
            <span
              className="status-pill quiet"
              title={[meta.ffmpegPath, meta.ffprobePath, apiState?.ok ? `应用内接口 ${apiState.url}` : '']
                .filter(Boolean)
                .join('\n')}
            >
              ffmpeg {meta.ffmpegVersion}
            </span>
          )}
        </div>

        <WindowButtons />
      </header>

      <div className="shell">
        <main className="stage">
          <div className="page-head">
            <div className="ph-text">
              <p className="eyebrow">LOCAL · OFFLINE</p>
              <h1>补帧工作台</h1>
            </div>
            {items.length > 0 && (
              <div className="tally">
                <span>
                  <b>{items.length}</b>素材
                </span>
                <span>
                  <b>{doneCount}</b>完成
                </span>
                <span className={failedCount ? 'warn' : ''}>
                  <b>{failedCount}</b>失败
                </span>
              </div>
            )}
          </div>

          {!hasApi && (
            <div className="alert">
              <Icon name="info" size={14} />
              <span>
                浏览器预览模式：选择文件、真实补帧与预设存储需在桌面应用中运行（<code>npm run dev</code>）。
              </span>
            </div>
          )}
          {meta?.binProblem && (
            <div className="alert bad">
              <Icon name="warning" size={14} />
              <span>{meta.binProblem}</span>
            </div>
          )}
          {apiState && !apiState.ok && (
            <div className="alert bad">
              <Icon name="warning" size={14} />
              <span>{apiState.error || `应用内接口（127.0.0.1:${apiState.port}）没有起来，Agent 调用会失败。`}</span>
            </div>
          )}

          <div className={'grid' + (items.length ? '' : ' solo')}>
            <div className="col-main">
              {items.length === 0 ? (
                <section
                  className={'hero' + (dragOver ? ' over' : '') + (busy ? ' busy' : '')}
                  onClick={() => {
                    if (hasApi && !busy) void addViaDialog()
                  }}
                >
                  <div className="hero-main">
                    <span className="dz-icon" aria-hidden>
                      <svg viewBox="0 0 48 48" fill="none">
                        <rect x="4" y="11" width="40" height="27" rx="6" stroke="currentColor" strokeWidth="2" />
                        <path d="M4 19h40" stroke="currentColor" strokeWidth="2" />
                        <path d="M13 11v8M22 11v8M31 11v8M40 11v8" stroke="currentColor" strokeWidth="2" />
                        <path d="M21 26.5v8l7-4-7-4z" fill="currentColor" />
                      </svg>
                    </span>
                    <h2>{busy ? '正在读取视频信息…' : '把视频拖进来'}</h2>
                    <p className="hero-sub">MP4 / MKV / MOV / AVI / WebM · 可多选 · 全程本地处理</p>
                    <div className="dz-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn primary" disabled={!hasApi || busy} onClick={() => void addViaDialog()}>
                        <Icon name="plus" size={15} /> 选择文件
                      </button>
                    </div>
                    <div className="dz-presets" onClick={(e) => e.stopPropagation()}>
                      <span className="dz-label">起手预设</span>
                      <div className="chip-row">
                        {presets.slice(0, 4).map((p) => (
                          <button
                            key={p.id}
                            className={'chip' + (p.id === prefs.presetId ? ' on' : '')}
                            onClick={() => applyPreset(p)}
                            title={`${p.mode} · ${p.quality} · ${p.multiplier > 0 ? `×${p.multiplier}` : `${p.customFps}fps`} · ${p.container.toUpperCase()}`}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <aside className="hero-side" aria-label="使用流程">
                    <ol className="rail">
                      <li>
                        <b>01</b>
                        <span>
                          <strong>拖入素材</strong>
                          <em>一次可拖多条，自动排进队列</em>
                        </span>
                      </li>
                      <li>
                        <b>02</b>
                        <span>
                          <strong>定帧率与方式</strong>
                          <em>右侧参数台，或直接套用起手预设</em>
                        </span>
                      </li>
                      <li>
                        <b>03</b>
                        <span>
                          <strong>开始补帧</strong>
                          <em>进度、帧率、剩余时间在底栏实时更新</em>
                        </span>
                      </li>
                    </ol>
                    <p className="rail-note">
                      <Icon name="info" size={13} />
                      光流补帧吃 CPU，4K 素材的耗时可能达到片长的数十倍
                    </p>
                    <p className="rail-keys">
                      <kbd>Ctrl</kbd>+<kbd>O</kbd> 添加素材 · <kbd>Enter</kbd> 开始 · <kbd>Esc</kbd> 暂停
                    </p>
                  </aside>
                </section>
              ) : (
                sel && (
                  <section className="panel preview">
                    <div className={'preview-frame' + (videoBroken ? ' no-video' : '')}>
                      <span className="preview-blank" aria-hidden>
                        <Icon name="film" size={26} />
                        {videoBroken && <em>这份文件在应用内无法预览，不影响补帧</em>}
                      </span>
                      {sel.previewUrl && !videoBroken && (
                        <PreviewVideo key={sel.previewUrl} src={sel.previewUrl} onBroken={() => setVideoBroken(true)} />
                      )}
                      <span className={'state-pill ' + sel.status}>
                        <Icon name={ST_META[sel.status].icon} size={12} />
                        {ST_META[sel.status].text}
                      </span>
                    </div>
                    <div className="preview-info">
                      <div className="pi-head">
                        <h3 title={sel.path}>{sel.fileName}</h3>
                        <span className="pi-sub">
                          {fmtDuration(sel.info.durationSec)} · {fmtSize(sel.info.sizeBytes)}
                        </span>
                      </div>

                      <div className="pi-flow" title="源帧率 → 目标帧率">
                        <span className="pi-from">{fmtFps(srcFpsOf(sel.info))}</span>
                        <Icon name="chevron" size={11} />
                        <span className="pi-to">{targetFps > 0 ? targetFps : '—'}</span>
                        <em>fps</em>
                      </div>

                      <div className="specs">
                        <span>
                          {sel.info.width}×{sel.info.height}
                        </span>
                        <span>
                          {sel.info.videoCodec.toUpperCase()}
                          {sel.info.pixFmt ? ` · ${sel.info.pixFmt}` : ''}
                        </span>
                        <span>{sel.info.hasAudio ? `音轨 ${sel.info.audioCodec}` : '无音轨'}</span>
                      </div>

                      <div className="pi-tags">
                        {is10Bit(sel.info) && <b className="tag">10bit</b>}
                        {isHdr(sel.info) && <b className="tag">HDR · {sel.info.colorTrc}</b>}
                      </div>

                      {is10Bit(sel.info) && meta && meta.tenBitCapable === false && (
                        <p className="inline-note warn">源是 10bit，本机 x264 只能输出 8bit，色彩深度会掉一档。</p>
                      )}
                    </div>
                  </section>
                )
              )}

              {items.length > 0 && sel && (sel.status === 'done' || sel.status === 'error' || sel.status === 'cancelled') && (
                <section className={'panel result ' + (sel.status === 'done' ? 'ok' : 'bad')}>
                  <div className="res-head">
                    <span className="res-icon">
                      <Icon name={sel.status === 'done' ? 'check' : 'warning'} size={16} />
                    </span>
                    <div className="res-text">
                      <strong>{sel.status === 'done' ? '这一条已完成' : sel.error ?? '已取消'}</strong>
                      <em title={sel.status === 'done' && sel.result ? sel.result.outputPath : sel.path}>
                        {sel.status === 'done' && sel.result ? sel.result.outputPath : sel.path}
                      </em>
                    </div>
                    <div className="res-actions">
                      {sel.status === 'done' && sel.result && (
                        <button
                          className="btn tiny"
                          onClick={() => void window.api.showInFolder(sel.result!.outputPath)}
                        >
                          <Icon name="folder" size={13} /> 打开目录
                        </button>
                      )}
                      {sel.status !== 'done' && (
                        <button className="btn tiny ghost" onClick={() => void window.api.showInFolder(sel.path)}>
                          <Icon name="folder" size={13} /> 源文件
                        </button>
                      )}
                      <button className="btn tiny ghost" onClick={() => resetToPending(sel.id)}>
                        <Icon name="retry" size={13} /> {sel.status === 'done' ? '再跑一次' : '重试'}
                      </button>
                    </div>
                  </div>

                  {sel.status === 'done' && sel.result && (
                    <div className="res-stats">
                      <span>
                        <em>帧率</em>
                        <b>{fmtFps(sel.result.fps ?? 0)} fps</b>
                      </span>
                      <span>
                        <em>体积</em>
                        <b>{fmtSize(sel.result.sizeBytes)}</b>
                      </span>
                      <span>
                        <em>时长</em>
                        <b>{fmtDuration(sel.result.durationSec ?? 0)}</b>
                      </span>
                      {sel.result.elapsedSec != null && (
                        <span>
                          <em>用时</em>
                          <b>{fmtDuration(sel.result.elapsedSec)}</b>
                        </span>
                      )}
                      {sel.result.processFps ? (
                        <span>
                          <em>处理</em>
                          <b>{fmtFps(sel.result.processFps)} fps</b>
                        </span>
                      ) : null}
                      {sel.encoder && (
                        <span>
                          <em>编码器</em>
                          <b>{sel.encoder}</b>
                        </span>
                      )}
                    </div>
                  )}

                  {sel.status !== 'done' && !!sel.steps?.length && (
                    <ol className="res-steps">
                      {sel.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  )}
                  {sel.status !== 'done' && !!sel.notes.length && (
                    <ul className="res-notes">
                      {sel.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                  {sel.status !== 'done' && sel.log && (
                    <details className="raw">
                      <summary>原始日志</summary>
                      <pre>{sel.log}</pre>
                    </details>
                  )}
                </section>
              )}

              {items.length > 0 && (
                <section className="panel queue">
                  <header className="panel-head">
                    <span className="ph-left">
                      <h2>队列</h2>
                      <span className="count">{items.length}</span>
                    </span>
                    <div className="head-actions">
                      <button className="btn tiny" disabled={busy || !hasApi} onClick={() => void addViaDialog()}>
                        <Icon name="plus" size={12} /> 添加
                      </button>
                      <button
                        className="btn tiny ghost"
                        disabled={running || !pendingCount}
                        onClick={skipPending}
                      >
                        清空待处理
                      </button>
                    </div>
                  </header>
                  <ul className="queue">
                    {items.map((it, idx) => {
                      const src = srcFpsOf(it.info)
                      const tf = targetFpsForPreset(
                        { multiplier: prefs.mult, customFps: Math.round(Number(prefs.customFps) || 0) },
                        src
                      )
                      return (
                        <li
                          key={it.id}
                          className={
                            'row' +
                            (sel?.id === it.id ? ' sel' : '') +
                            (currentItemId === it.id ? ' cur' : '') +
                            (dragId === it.id ? ' dragging' : '') +
                            (dropId === it.id && dragId !== it.id ? ' drop' : '')
                          }
                          draggable={it.status !== 'rendering' && !running}
                          onDragStart={(e) => {
                            if (it.status === 'rendering' || running) {
                              e.preventDefault()
                              return
                            }
                            dragIdRef.current = it.id
                            setDragId(it.id)
                            e.dataTransfer.effectAllowed = 'move'
                            // 不带点东西某些平台不会触发 drop
                            e.dataTransfer.setData('text/plain', String(it.id))
                          }}
                          onDragOver={(e) => {
                            if (dragIdRef.current == null || dragIdRef.current === it.id) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            setDropId(it.id)
                          }}
                          onDragLeave={() => setDropId((cur) => (cur === it.id ? null : cur))}
                          onDrop={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            const from = dragIdRef.current
                            if (from != null) reorderItem(from, it.id)
                            dragIdRef.current = null
                            setDragId(null)
                            setDropId(null)
                          }}
                          onDragEnd={() => {
                            dragIdRef.current = null
                            setDragId(null)
                            setDropId(null)
                          }}
                          onClick={() => {
                            setSelectedId(it.id)
                            setVideoBroken(false)
                          }}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') setSelectedId(it.id)
                          }}
                        >
                          <span className="grip" aria-hidden title={running ? '' : '拖动调整顺序'}>
                            {it.status !== 'rendering' && !running ? <Icon name="grip" size={12} /> : null}
                          </span>
                          <span className={'dot ' + it.status}>
                            {it.status === 'rendering' ? (
                              <i className="spin" />
                            ) : (
                              <Icon name={ST_META[it.status].icon} size={13} />
                            )}
                          </span>
                          <div className="row-main">
                            <span className="row-name" title={it.path}>
                              {it.fileName}
                            </span>
                            <span className="row-meta">
                              {it.status === 'done' && it.result ? (
                                <>
                                  {fmtFps(it.result.fps ?? tf)} fps · {fmtSize(it.result.sizeBytes)}
                                  {it.result.elapsedSec != null ? ` · 用时 ${fmtDuration(it.result.elapsedSec)}` : ''}
                                </>
                              ) : it.status === 'pending' ? (
                                <>
                                  {fmtFps(src)} → {tf > src ? tf : '—'} fps
                                  {!(tf > src) ? ' · 帧率不够高' : ''}
                                </>
                              ) : it.status === 'rendering' ? (
                                <>
                                  {it.progress?.stageLabel ? `${it.progress.stageLabel} · ` : ''}
                                  {Math.round(it.progress?.percent ?? 0)}% · {fmtFps(it.progress?.fps ?? 0)} fps
                                </>
                              ) : (
                                <>{it.error ?? ST_META[it.status].text}</>
                              )}
                            </span>
                          </div>
                          {it.status === 'rendering' && (
                            <span className="row-bar" aria-hidden>
                              <i style={{ width: `${Math.min(100, it.progress?.percent ?? 0)}%` }} />
                            </span>
                          )}
                          <div className="row-ops">
                            {it.status === 'pending' && !running && (
                              <>
                                <IconBtn
                                  name="up"
                                  title="上移"
                                  disabled={idx === 0}
                                  onClick={() => moveItem(it.id, -1)}
                                />
                                <IconBtn
                                  name="down"
                                  title="下移"
                                  disabled={idx === items.length - 1}
                                  onClick={() => moveItem(it.id, 1)}
                                />
                              </>
                            )}
                            {it.status === 'done' && (
                              <IconBtn
                                name="folder"
                                title="打开所在目录"
                                onClick={() => void window.api.showInFolder(it.result?.outputPath ?? it.path)}
                              />
                            )}
                            {(it.status === 'error' || it.status === 'cancelled') && !running && (
                              <IconBtn name="retry" title="重试这一条" onClick={() => resetToPending(it.id)} />
                            )}
                            {it.status !== 'rendering' && (
                              <IconBtn name="trash" title="移出队列（Del）" onClick={() => removeItem(it.id)} />
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}

              {history.length > 0 && (
                <section className="panel history">
                  <button
                    className="panel-head as-btn"
                    onClick={() => setShowHistory((v) => !v)}
                    aria-expanded={showHistory}
                  >
                    <span className="ph-left">
                      <Icon name="history" size={14} />
                      <h2>历史任务</h2>
                      <span className="count">{history.length}</span>
                    </span>
                    <Icon name="chevronDown" size={14} className={showHistory ? 'rot' : ''} />
                  </button>
                  {showHistory && (
                    <div className="hist-body">
                      <ul className="hist-list">
                        {history.map((h) => (
                          <li key={h.id} className="hist-row">
                            <span className={'dot ' + (h.ok ? 'done' : 'error')}>
                              <Icon name={h.ok ? 'check' : 'cross'} size={12} />
                            </span>
                            <div className="hist-main" title={h.ok ? h.outputPath : h.error}>
                              <span className="hist-name">{h.fileName}</span>
                              <span className="hist-sub">
                                {fmtWhen(h.finishedAt)} · {fmtFps(h.srcFps)} → {h.targetFps} fps
                                {h.ok ? ` · ${fmtSize(h.sizeBytes)}` : ` · ${h.error ?? '失败'}`}
                              </span>
                            </div>
                            <div className="row-ops">
                              <IconBtn
                                name="folder"
                                title="打开所在目录"
                                onClick={() => void window.api.showInFolder(h.outputPath)}
                              />
                              <IconBtn name="retry" title="重新入队" onClick={() => enqueueHistoryEntry(h)} />
                            </div>
                          </li>
                        ))}
                      </ul>
                      <button
                        className="btn tiny ghost"
                        onClick={() =>
                          void window.api.history.clear().then((r) => {
                            setHistory(r.entries ?? [])
                          })
                        }
                      >
                        <Icon name="trash" size={12} /> 清空历史
                      </button>
                    </div>
                  )}
                </section>
              )}
            </div>

            {items.length > 0 && (
            <aside className={'col-side' + (running ? ' locked' : '')}>
              <section className="panel controls">
                <div className="ctl">
                  <div className="ctl-head">
                    <span className="ctl-label">预设</span>
                    {presetDirty && <span className="ctl-flag">已修改</span>}
                  </div>
                  <div className="chip-row">
                    {presets.map((p) => (
                      <button
                        key={p.id}
                        className={'chip' + (p.id === prefs.presetId && !presetDirty ? ' on' : '')}
                        onClick={() => applyPreset(p)}
                        title={`${p.mode} · ${p.quality} · ${p.multiplier > 0 ? `×${p.multiplier}` : `${p.customFps}fps`} · ${p.container.toUpperCase()}${p.useNvenc ? ' · 尝试硬编' : ' · 仅 CPU'}`}
                      >
                        {p.name}
                        {!p.builtin && (
                          <span
                            className="chip-x"
                            role="button"
                            tabIndex={-1}
                            title="删除这个自定义预设"
                            onClick={(e) => {
                              e.stopPropagation()
                              removePreset(p.id)
                            }}
                          >
                            <Icon name="cross" size={9} />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="chip-tools">
                    {savingPreset ? (
                      <>
                        <input
                          className="input"
                          value={presetName}
                          placeholder="预设名称"
                          maxLength={32}
                          autoFocus
                          onChange={(e) => setPresetName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') savePreset()
                            if (e.key === 'Escape') setSavingPreset(false)
                          }}
                        />
                        <button className="btn tiny" onClick={savePreset}>
                          保存
                        </button>
                        <button className="btn tiny ghost" onClick={() => setSavingPreset(false)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="link" onClick={() => setSavingPreset(true)} disabled={!hasApi}>
                          <Icon name="save" size={12} /> 存为预设
                        </button>
                        <button className="link" onClick={exportPresets} disabled={!hasApi}>
                          <Icon name="export" size={12} /> 导出
                        </button>
                        <button className="link" onClick={importPresets} disabled={!hasApi}>
                          <Icon name="import" size={12} /> 导入
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="ctl">
                  <div className="ctl-head">
                    <span className="ctl-label">目标帧率</span>
                    <span className="ctl-side">{sel ? `源 ${fmtFps(selFps)} fps` : '未选素材'}</span>
                  </div>
                  <div className="fps-row">
                    <div className="fps-big">
                      <b>{targetFps > 0 ? targetFps : '—'}</b>
                      <span>fps</span>
                    </div>
                    <div className="seg">
                      {[2, 3, 4].map((m) => (
                        <button key={m} className={prefs.mult === m ? 'on' : ''} onClick={() => setPref('mult', m)}>
                          ×{m}
                        </button>
                      ))}
                      <button className={prefs.mult === 0 ? 'on' : ''} onClick={() => setPref('mult', 0)}>
                        自定义
                      </button>
                    </div>
                  </div>
                  {prefs.mult === 0 && (
                    <input
                      className="input"
                      value={prefs.customFps}
                      onChange={(e) => setPref('customFps', e.target.value.replace(/[^\d.]/g, ''))}
                      placeholder="例如 60"
                      inputMode="decimal"
                    />
                  )}
                  {sel && !fpsValid && (
                    <p className="inline-note bad">目标帧率需高于源帧率，且在 5–{MAX_FPS} 之间。</p>
                  )}
                </div>

                <div className="ctl">
                  <div className="ctl-head">
                    <span className="ctl-label">补帧方式</span>
                  </div>
                  <div className="modes">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        className={'mode' + (prefs.mode === m.id ? ' on' : '')}
                        onClick={() => setPref('mode', m.id)}
                        title={m.detail}
                      >
                        <span className="mode-dot" aria-hidden />
                        <span className="mode-text">
                          <strong>{m.title}</strong>
                          <em>{m.desc}</em>
                        </span>
                        <span className="meter" aria-hidden>
                          {[1, 2, 3].map((i) => (
                            <i key={i} className={i <= m.quality ? 'on' : ''} />
                          ))}
                        </span>
                      </button>
                    ))}
                  </div>
                  {is4K && prefs.mode !== 'fast' && (
                    <p className="inline-note warn">4K 素材用光流会非常慢，可先用帧混合确认效果。</p>
                  )}
                </div>

                <div className="ctl">
                  <div className="ctl-head">
                    <span className="ctl-label">输出质量</span>
                    <span className="ctl-side">{QUALITIES.find((q) => q.id === prefs.quality)?.desc}</span>
                  </div>
                  <div className="seg wide">
                    {QUALITIES.map((q) => (
                      <button
                        key={q.id}
                        className={prefs.quality === q.id ? 'on' : ''}
                        onClick={() => setPref('quality', q.id)}
                      >
                        {q.title}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="ctl rows">
                  <div className="ctl-row">
                    <span className="ctl-label">封装格式</span>
                    <div className="seg small">
                      <button
                        className={prefs.container === 'mp4' ? 'on' : ''}
                        onClick={() => changeContainer('mp4')}
                      >
                        MP4
                      </button>
                      <button
                        className={prefs.container === 'mkv' ? 'on' : ''}
                        onClick={() => changeContainer('mkv')}
                      >
                        MKV
                      </button>
                    </div>
                  </div>
                  <div className="ctl-row">
                    <span className="ctl-row-text">
                      <span className="ctl-label">硬件加速</span>
                      <em>
                        {nvencUnavailable ? '本机无 NVENC，走 CPU 编码' : meta ? 'NVENC 可用' : '检测本机能力…'}
                      </em>
                    </span>
                    <Switch
                      checked={prefs.useNvenc && !nvencUnavailable}
                      disabled={nvencUnavailable || !hasApi}
                      onChange={(v) => setPref('useNvenc', v)}
                      label="硬件加速（NVIDIA NVENC）"
                    />
                  </div>
                </div>

                <div className="ctl">
                  <div className="ctl-head">
                    <span className="ctl-label">{items.length > 1 ? '输出位置' : '输出文件'}</span>
                  </div>
                  {items.length === 1 ? (
                    <>
                      <div className="path-row static" title={shownOut}>
                        <Icon name="film" size={14} />
                        <span>{shownOut.split('\\').pop()}</span>
                        <button className="link" onClick={() => void chooseOutput()} disabled={!hasApi}>
                          更改
                        </button>
                      </div>
                      <button className="path-row" onClick={() => void chooseOutDir()} disabled={!hasApi}>
                        <Icon name="folder" size={14} />
                        <span title={prefs.outDir || '与源文件同目录'}>
                          {prefs.outDir || '与源文件同目录'}
                        </span>
                        <Icon name="chevron" size={12} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="path-row" onClick={() => void chooseOutDir()} disabled={!hasApi}>
                        <Icon name="folder" size={14} />
                        <span title={prefs.outDir || '与源文件同目录'}>
                          {prefs.outDir || '与源文件同目录'}
                        </span>
                        <Icon name="chevron" size={12} />
                      </button>
                      <p className="inline-note">
                        按「原名_帧率fps.{prefs.container}」命名，重名自动加后缀。
                      </p>
                    </>
                  )}
                  {estBytes > 0 && (
                    <p className="est-line" title="按分辨率、时长、目标帧率与画质档粗估，实际以产物为准">
                      <Icon name="info" size={12} />
                      预计产物约 <b>{fmtSize(estBytes)}</b>
                      {items.length === 1 ? '' : `（每条）`}
                    </p>
                  )}
                </div>
              </section>
            </aside>
            )}
          </div>
        </main>
      </div>

      <footer
        ref={dockRef}
        className={'dock' + (running || paused ? ' live' : '') + (screen === 'done' && items.length ? ' settled' : '')}
      >
        <div className="dock-inner">
          {running || paused ? (
            <>
              <div className="dock-live">
                <div className="live-head">
                  <span className={'live-dot' + (running ? '' : ' paused')} />
                  <strong>{running ? '正在补帧' : '队列已暂停'}</strong>
                  <span className="live-file" title={currentItem?.path}>
                    {currentItem?.fileName ?? `剩余 ${pendingCount} 条待处理`}
                  </span>
                  <span className="live-stage">{currentItem?.progress?.stageLabel ?? '准备中'}</span>
                </div>
                <div className="live-bar">
                  <div className="live-fill" style={{ width: `${livePercent}%` }} />
                </div>
                <ol className="live-stages">
                  {STEPS.map((s, i) => (
                    <li key={s.stage} className={i < liveStageIdx ? 'past' : i === liveStageIdx ? 'cur' : ''}>
                      {s.label}
                    </li>
                  ))}
                </ol>
              </div>
              <div className="dock-num">
                <div>
                  <b>{livePercent.toFixed(1)}</b>
                  <span>%</span>
                </div>
                <em>
                  {currentItem?.progress
                    ? `${fmtFps(currentItem.progress.fps)} fps · ${
                        currentItem.progress.speed ? `${currentItem.progress.speed.toFixed(2)}x` : '—'
                      } · 剩余 ${
                        currentItem.progress.etaSec != null && Number.isFinite(currentItem.progress.etaSec)
                          ? fmtDuration(currentItem.progress.etaSec)
                          : '—'
                      }`
                    : '等待 ffmpeg 回报'}
                </em>
              </div>
              <div className="dock-actions">
                {running ? (
                  <>
                    <button className="btn" onClick={() => pauseQueue(false)}>
                      <Icon name="pause" size={14} /> 暂停
                    </button>
                    <button className="btn ghost" onClick={cancelCurrent} disabled={!hasApi}>
                      <Icon name="cross" size={14} /> 取消这条
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn primary" onClick={resumeQueue} disabled={!pendingCount}>
                      <Icon name="play" size={14} /> 继续队列
                    </button>
                    <button className="btn ghost" onClick={skipPending}>
                      放弃剩余
                    </button>
                  </>
                )}
                <button
                  className="btn icon ghost"
                  title="运行详情"
                  aria-expanded={showRunInfo}
                  onClick={() => setShowRunInfo((v) => !v)}
                >
                  <Icon name="chevronDown" size={14} className={showRunInfo ? 'rot' : ''} />
                </button>
              </div>
              {showRunInfo && (
                <div className="dock-detail">
                  <div className="dd-grid">
                    <span>
                      <em>已处理</em>
                      <b>
                        {fmtDuration(currentItem?.progress?.outTimeSec ?? 0)} /{' '}
                        {fmtDuration(currentItem?.info.durationSec ?? 0)}
                      </b>
                    </span>
                    <span>
                      <em>输出帧</em>
                      <b>
                        {currentItem?.progress?.frame ?? 0} / {currentItem?.progress?.totalFrames ?? '—'}
                      </b>
                    </span>
                    <span>
                      <em>已用</em>
                      <b>
                        {currentItem?.progress?.elapsedSec != null
                          ? fmtDuration(currentItem.progress.elapsedSec)
                          : '—'}
                      </b>
                    </span>
                    <span>
                      <em>总进度</em>
                      <b>{overallPercent.toFixed(1)}%</b>
                    </span>
                    {currentItem?.encoder && (
                      <span>
                        <em>编码器</em>
                        <b>{currentItem.encoder}</b>
                      </span>
                    )}
                  </div>
                  {!!currentItem?.notes.length && (
                    <ul className="dd-notes">
                      {currentItem.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                  {command && (
                    <details className="raw">
                      <summary>本次 ffmpeg 命令</summary>
                      <pre>{command}</pre>
                    </details>
                  )}
                </div>
              )}
            </>
          ) : screen === 'done' && items.length > 0 ? (
            <>
              <div className="dock-summary">
                <span className={'sum-icon ' + (failedCount ? 'warn' : 'ok')}>
                  <Icon name={failedCount ? 'warning' : 'check'} size={16} />
                </span>
                <div>
                  <strong>队列结束</strong>
                  <em>
                    成功 {doneCount} · 失败/取消 {failedCount} · 总进度 {overallPercent.toFixed(0)}%
                  </em>
                </div>
              </div>
              <div className="dock-actions">
                {failedCount > 0 && (
                  <button className="btn primary" onClick={retryAllFailed}>
                    <Icon name="retry" size={14} /> 重试失败项（{failedCount}）
                  </button>
                )}
                {lastOutputPath && (
                  <button
                    className="btn ghost"
                    title={lastOutputPath}
                    onClick={() => void window.api.showInFolder(lastOutputPath)}
                  >
                    <Icon name="folder" size={14} /> 打开输出目录
                  </button>
                )}
                <button className="btn ghost" disabled={!doneCount && !failedCount} onClick={clearFinished}>
                  清空已完成
                </button>
              </div>
            </>
          ) : (
            <>
              <button className="btn primary cta" disabled={!canStart || busy} onClick={() => void runLoop()}>
                <Icon name="play" size={15} />
                {busy ? '正在读取…' : `开始补帧${pendingCount > 1 ? `（${pendingCount} 个）` : ''}`}
                <kbd>Enter</kbd>
              </button>
              <div className="dock-brief">
                <span>
                  {items.length
                    ? `${fmtFps(selFps)} → ${targetFps || '—'} fps · ${modeTitle} · ${qualityTitle} · ${prefs.container.toUpperCase()}`
                    : '添加视频后即可开始'}
                </span>
                <em title={items.length === 1 ? shownOut : prefs.outDir}>
                  {items.length === 1
                    ? shownOut
                    : items.length > 1
                      ? `批量输出 · ${prefs.outDir || '各自源目录'}`
                      : '全程本地处理，不上传任何数据'}
                </em>
              </div>
              <div className="dock-actions">
                {items.length > 0 && !fpsValid && (
                  <span className="dock-warn">
                    <Icon name="warning" size={13} /> 目标帧率需高于源帧率
                  </span>
                )}
                <button className="btn ghost" disabled={!doneCount && !failedCount} onClick={clearFinished}>
                  清空已完成
                </button>
              </div>
            </>
          )}
        </div>
      </footer>

      {dragOver && (
        <div className="drag-overlay">
          <div>
            <Icon name="film" size={26} />
            松开以添加视频
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      <input
        ref={fileInputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          // 选中的文件由 preload 的 change 监听转成真实路径送上来（见 onFilesPicked），
          // 这里只把 input 复位，好让同一个文件能再选一次。
          e.currentTarget.value = ''
        }}
      />
    </>
  )
}

function emptyProgress(): ProgressData {
  return { percent: 0, outTimeSec: 0, fps: 0, speed: null, frame: 0, totalFrames: 0, etaSec: null }
}

/**
 * 预览播放器：<video> 的 error 事件不冒泡，也不一定是 React 合成事件能接住的那个时机，
 * 所以这里既挂 onError，也在挂载后主动查一次 readyState —— 文件读不到时能把原生控件收掉，
 * 免得留一个 0:00 的黑条占着整块预览区。
 */
function PreviewVideo(props: { src: string; onBroken: () => void }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const broken = props.onBroken
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      if (el.error || (el.readyState === 0 && el.networkState === 3)) broken()
    }
    const t = setTimeout(check, 1200)
    el.addEventListener('error', check)
    return () => {
      clearTimeout(t)
      el.removeEventListener('error', check)
    }
  }, [broken])
  return (
    <video
      ref={ref}
      src={props.src}
      controls
      muted
      playsInline
      preload="metadata"
      onError={props.onBroken}
    />
  )
}

function Switch(props: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className={'switch' + (props.checked ? ' on' : '')}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="knob" />
    </button>
  )
}

function IconBtn(props: {
  name: IconName
  title: string
  onClick: (e: ReactMouseEvent<HTMLElement>) => void
  disabled?: boolean
}) {
  return (
    <button
      className="op-btn"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick(e)
      }}
    >
      <Icon name={props.name} size={13} />
    </button>
  )
}

// 自绘标题栏：窗口三键
function WindowButtons() {
  const controls = typeof window !== 'undefined' ? window.api?.windowControls : undefined
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!controls) return
    void controls
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    return controls.onMaximizedChange(setMaximized)
  }, [controls])

  if (!controls) return null

  return (
    <div className="win-controls">
      <button className="win-btn" title="最小化" aria-label="最小化" onClick={() => void controls.minimize()}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M1 6h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        className="win-btn"
        title={maximized ? '向下还原' : '最大化'}
        aria-label={maximized ? '向下还原' : '最大化'}
        onClick={() => void controls.toggleMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
            <rect x="1.5" y="3.5" width="7" height="7" rx="1.2" />
            <path d="M3.5 3.5v-2h7v7h-2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
            <rect x="1.5" y="1.5" width="9" height="9" rx="1.2" />
          </svg>
        )}
      </button>
      <button className="win-btn close" title="关闭" aria-label="关闭" onClick={() => void controls.close()}>
        <svg viewBox="0 0 12 12" width="12" height="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden>
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  )
}

function metaBadge(meta: MetaInfo | null): { text: string; cls: string; icon: IconName } {
  if (!meta) return { text: '检测本机能力…', cls: 'dim', icon: 'info' }
  if (meta.binProblem) return { text: 'ffmpeg 缺失', cls: 'err', icon: 'warning' }
  if (meta.nvenc === 'modern' || meta.nvenc === 'legacy') {
    return { text: 'NVENC 硬件加速', cls: 'ok', icon: 'gpu' }
  }
  return { text: 'CPU 编码（无 NVENC）', cls: 'dim', icon: 'cpu' }
}

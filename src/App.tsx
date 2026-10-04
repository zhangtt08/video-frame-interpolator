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

const MODES: { id: Mode; title: string; desc: string; speed: number; quality: number; tag: string }[] = [
  {
    id: 'high',
    title: '光流补偿 · 精细',
    desc: 'AOBMC 自适应分块 + 双向运动估计 + 变分加权，运动最顺滑',
    speed: 1,
    quality: 3,
    tag: '最慢 · 画质最佳'
  },
  {
    id: 'balanced',
    title: '光流补偿 · 均衡',
    desc: 'OBMC 运动补偿插帧，速度与画质平衡，适合大多数视频',
    speed: 2,
    quality: 2,
    tag: '推荐'
  },
  {
    id: 'fast',
    title: '帧混合',
    desc: '相邻帧加权融合，接近实时处理；快速运动场景略有拖影',
    speed: 3,
    quality: 1,
    tag: '最快'
  }
]

const QUALITIES: { id: Quality; title: string; desc: string }[] = [
  { id: 'master', title: '母版级', desc: 'CRF 10 · 视觉无损，用于再剪辑/存档' },
  { id: 'high', title: '高画质', desc: 'CRF 16 · 画质与体积的推荐平衡' },
  { id: 'standard', title: '标准', desc: 'CRF 20 · 体积小、速度快' }
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

function Dots({ n }: { n: number }) {
  return (
    <span className="dots" aria-hidden>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  )
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

  const addFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const arr = files ? Array.from(files) : []
      if (!arr.length) return
      setBusy(true)
      for (const f of arr) {
        const p = window.api?.pathForFile?.(f) ?? ''
        if (!p) {
          showToast(`无法获取「${f.name}」的文件路径，请改用「添加视频」按钮选择`)
          continue
        }
        await addByPath(p, URL.createObjectURL(f))
      }
      setBusy(false)
    },
    [addByPath, showToast]
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
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      void addFiles(e.dataTransfer?.files ?? null)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addFiles])

  useEffect(() => {
    if (!hasApi) return
    const offs = [
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
      offs.forEach((o) => o())
      offApi?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 键盘可达：Enter 开始，Delete 把选中项移出队列
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const tag = t?.tagName ?? ''
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || t?.isContentEditable === true
      if (typing) return
      if (e.key === 'Enter' && !e.repeat) {
        if (!running && canStartRef.current) {
          e.preventDefault()
          void runLoop()
        }
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
  }, [runLoop, removeItem, selectedId, running])

  const canStart = !running && pendingCount > 0 && (items.length > 1 || fpsValid)
  const canStartRef = useRef(canStart)
  canStartRef.current = canStart

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
      <header className="top" onDoubleClick={onTitlebarDoubleClick}>
        <div className="brand">
          <div className="logo" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="3" y="5" width="4" height="14" rx="1.2" fill="rgba(255,255,255,.95)" />
              <rect x="10" y="5" width="4" height="14" rx="1.2" fill="rgba(255,255,255,.55)" />
              <rect x="17" y="5" width="4" height="14" rx="1.2" fill="rgba(255,255,255,.95)" />
            </svg>
          </div>
          <div>
            <h1>FrameBoost</h1>
            <span>本地视频补帧工作台</span>
          </div>
        </div>
        <div className="badges">
          <span className={badge.cls} title={meta?.nvencReason ?? '正在用本机 ffmpeg 实测能力'}>
            <Icon name={badge.icon} size={13} />
            {badge.text}
          </span>
          {meta?.ffmpegVersion && <span className="badge dim">ffmpeg {meta.ffmpegVersion}</span>}
          {meta?.ffprobeVersion && <span className="badge dim">ffprobe {meta.ffprobeVersion}</span>}
        </div>
        <WindowButtons />
      </header>

      <div className="app">
        {!hasApi && (
          <div className="banner">
            当前是浏览器预览模式，选择文件、真实补帧与预设存储需在桌面应用中运行（<code>npm run dev</code>）。
          </div>
        )}
        {meta?.binProblem && <div className="banner">{meta.binProblem}</div>}
        {apiState && !apiState.ok && (
          <div className="banner">
            {apiState.error || `应用内接口（127.0.0.1:${apiState.port}）没有起来，Agent 调用会失败。`}
          </div>
        )}
        {apiState?.ok && !apiState.tokenRequired && (
          <div className="hint">
            应用内接口在 {apiState.url} 监听，只接受本机回环请求；未设置 FRAMEBOOST_API_TOKEN，因此本机任意进程都可调用写接口。
          </div>
        )}
        {items.length === 0 ? (
          <section
            className={'dropzone' + (dragOver ? ' drag' : '') + (busy ? ' busy' : '')}
            onClick={() => hasApi && !busy && fileInputRef.current?.click()}
          >
            <svg className="dz-icon" viewBox="0 0 48 48" fill="none" aria-hidden>
              <rect x="4" y="10" width="40" height="28" rx="4" stroke="currentColor" strokeWidth="2.4" />
              <path d="M4 18h40" stroke="currentColor" strokeWidth="2.4" />
              <path d="M12 10v8M20 10v8M28 10v8M36 10v8" stroke="currentColor" strokeWidth="2.4" />
              <path d="M20 26.5v7l6.5-3.5-6.5-3.5z" fill="currentColor" />
            </svg>
            <h2>{busy ? '正在读取视频信息…' : '拖入视频文件（支持多选），或点击选择'}</h2>
            <p>MP4 / MKV / MOV / AVI / WebM 等 · 全程本地处理，不会上传任何数据</p>
            <div className="dz-preset" onClick={(e) => e.stopPropagation()}>
              <span className="dz-preset-label">起手预设</span>
              <div className="dz-chips">
                {presets.slice(0, 4).map((p) => (
                  <button
                    key={p.id}
                    className={'chip-btn' + (p.id === prefs.presetId ? ' on' : '')}
                    onClick={() => applyPreset(p)}
                    title={`${p.mode} · ${p.quality} · ${p.multiplier > 0 ? `×${p.multiplier}` : `${p.customFps}fps`} · ${p.container.toUpperCase()}`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="ghost dz-browse"
              onClick={(e) => {
                e.stopPropagation()
                if (hasApi && !busy) void addViaDialog()
              }}
            >
              <Icon name="plus" size={14} /> 添加视频…
            </button>
          </section>
        ) : (
          <>
            <div className="workspace">
              <div className="col">
                {sel && (
                  <section className="card preview-card">
                    {sel.previewUrl && <video key={sel.previewUrl} src={sel.previewUrl} controls muted playsInline />}
                    <div className="file-row">
                      <span className="fname" title={sel.path}>
                        {sel.fileName}
                      </span>
                      <span className={'chip st-chip ' + sel.status}>
                        <Icon name={ST_META[sel.status].icon} size={12} />
                        {ST_META[sel.status].text}
                      </span>
                    </div>
                    <div className="chips">
                      <span className="chip">
                        {sel.info.width}×{sel.info.height}
                      </span>
                      <span className="chip">{fmtFps(srcFpsOf(sel.info))} fps</span>
                      <span className="chip">{fmtDuration(sel.info.durationSec)}</span>
                      <span className="chip">
                        {sel.info.videoCodec.toUpperCase()}
                        {sel.info.pixFmt ? ` · ${sel.info.pixFmt}` : ''}
                      </span>
                      {is10Bit(sel.info) && <span className="chip ok">10bit</span>}
                      {isHdr(sel.info) && <span className="chip ok">HDR {sel.info.colorTrc}</span>}
                      {sel.info.hasAudio ? (
                        <span className="chip">音轨 {sel.info.audioCodec}</span>
                      ) : (
                        <span className="chip dim">无音轨</span>
                      )}
                      <span className="chip">{fmtSize(sel.info.sizeBytes)}</span>
                    </div>
                    {is10Bit(sel.info) && meta && meta.tenBitCapable === false && (
                      <div className="hint warn">
                        这份源是 10bit，但本机 x264 编不出 10bit H.264：产物会是 8bit，HDR 元数据仍会带上，但色彩深度会掉。
                      </div>
                    )}
                  </section>
                )}

                <section className="card queue-card">
                  <div className="q-head">
                    <label>
                      处理队列 <span className="q-count">{items.length}</span>
                    </label>
                    <div className="q-actions">
                      <button className="mini" disabled={busy || !hasApi} onClick={() => void addViaDialog()}>
                        <Icon name="plus" size={12} /> 添加
                      </button>
                      <button className="mini" disabled={running || !pendingCount} onClick={skipPending}>
                        <Icon name="cross" size={12} /> 清空待处理
                      </button>
                    </div>
                  </div>
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
                          className={'q-item' + (sel?.id === it.id ? ' sel' : '') + (currentItemId === it.id ? ' cur' : '')}
                          onClick={() => setSelectedId(it.id)}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') setSelectedId(it.id)
                          }}
                        >
                          <span className={'st ' + it.status}>
                            {it.status === 'rendering' ? <i className="spin" /> : <Icon name={ST_META[it.status].icon} size={14} />}
                          </span>
                          <div className="q-main">
                            <div className="q-name" title={it.path}>
                              {it.fileName}
                            </div>
                            <div className="q-sub">
                              {it.status === 'done' && it.result ? (
                                <>
                                  → {fmtFps(it.result.fps ?? tf)} fps · {fmtSize(it.result.sizeBytes)}
                                  {it.result.elapsedSec != null ? ` · 用时 ${fmtDuration(it.result.elapsedSec)}` : ''}
                                </>
                              ) : it.status === 'pending' ? (
                                <>
                                  {fmtFps(src)} → {tf > src ? tf : '—'} fps
                                  {!(tf > src) ? <em className="bad"> 帧率不够高</em> : ''}
                                </>
                              ) : it.status === 'rendering' ? (
                                <>
                                  {it.progress?.stageLabel ? `${it.progress.stageLabel} · ` : ''}
                                  {Math.round(it.progress?.percent ?? 0)}% · 输出 {fmtFps(it.progress?.fps ?? 0)} fps
                                </>
                              ) : (
                                <em className="bad">{it.error ?? ST_META[it.status].text}</em>
                              )}
                            </div>
                          </div>
                          <div className="q-ops">
                            {it.status === 'pending' && !running && (
                              <>
                                <IconBtn name="up" title="上移" onClick={(e) => { e.stopPropagation(); moveItem(it.id, -1) }} disabled={idx === 0} />
                                <IconBtn name="down" title="下移" onClick={(e) => { e.stopPropagation(); moveItem(it.id, 1) }} disabled={idx === items.length - 1} />
                              </>
                            )}
                            {it.status === 'done' && (
                              <IconBtn
                                name="folder"
                                title="打开所在目录"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void window.api.showInFolder(it.result?.outputPath ?? it.path)
                                }}
                              />
                            )}
                            {(it.status === 'error' || it.status === 'cancelled') && !running && (
                              <IconBtn name="retry" title="重试这一条" onClick={(e) => { e.stopPropagation(); resetToPending(it.id) }} />
                            )}
                            {it.status !== 'rendering' && (
                              <IconBtn name="trash" title="移出队列（Del）" onClick={(e) => { e.stopPropagation(); removeItem(it.id) }} />
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </section>

                {history.length > 0 && (
                  <section className="card history-card">
                      <button className="hist-head" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
                      <Icon name="chevron" size={13} className={showHistory ? ' rot' : ''} />
                      <Icon name="history" size={14} />
                      历史任务 <span className="q-count">{history.length}</span>
                      <span className="hist-hint">可重新入队</span>
                    </button>
                    {showHistory && (
                      <div className="hist-body">
                        <ul className="hist-list">
                          {history.map((h) => (
                            <li key={h.id} className="hist-row">
                              <span className={'st ' + (h.ok ? 'done' : 'error')}>
                                <Icon name={h.ok ? 'check' : 'cross'} size={13} />
                              </span>
                              <div className="hist-main" title={h.ok ? h.outputPath : h.error}>
                                <div className="hist-name">{h.fileName}</div>
                                <div className="hist-sub">
                                  {fmtWhen(h.finishedAt)} · {fmtFps(h.srcFps)} → {h.targetFps} fps · {h.encoder || '—'}
                                  {h.ok ? ` · ${fmtSize(h.sizeBytes)}` : ` · ${h.error ?? '失败'}`}
                                </div>
                              </div>
                              <div className="q-ops">
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
                          className="mini"
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

              <section className={'card settings' + (running ? ' disabled' : '')}>
                <div className="field">
                  <label>
                    预设
                    {presetDirty && <span className="lbl-hint">当前设置已改动，未存入预设</span>}
                  </label>
                  <div className="preset-row">
                    <div className="dz-chips">
                      {presets.map((p) => (
                        <button
                          key={p.id}
                          className={'chip-btn' + (p.id === prefs.presetId && !presetDirty ? ' on' : '')}
                          onClick={() => applyPreset(p)}
                          title={`${p.mode} · ${p.quality} · ${p.multiplier > 0 ? `×${p.multiplier}` : `${p.customFps}fps`} · ${p.container.toUpperCase()}${p.useNvenc ? ' · 尝试硬编' : ' · 仅 CPU'}`}
                        >
                          {p.name}
                          {!p.builtin && (
                            <span
                              className="preset-x"
                              role="button"
                              tabIndex={-1}
                              title="删除这个自定义预设"
                              onClick={(e) => {
                                e.stopPropagation()
                                removePreset(p.id)
                              }}
                            >
                              <Icon name="cross" size={10} />
                            </span>
                          )}
                        </button>
                      ))}
                      {presetDirty && <span className="chip-btn dirty">已修改</span>}
                    </div>
                  </div>
                  <div className="preset-tools">
                    {savingPreset ? (
                      <>
                        <input
                          className="fps-input grow"
                          value={presetName}
                          placeholder="预设名称，例如 会议录屏 ×2 标准"
                          maxLength={32}
                          onChange={(e) => setPresetName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') savePreset()
                          }}
                        />
                        <button className="mini" onClick={savePreset}>
                          <Icon name="save" size={12} /> 存为预设
                        </button>
                        <button className="mini" onClick={() => setSavingPreset(false)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="mini" onClick={() => setSavingPreset(true)} disabled={!hasApi}>
                          <Icon name="save" size={12} /> 把当前设置存为预设
                        </button>
                        <button className="mini" onClick={exportPresets} disabled={!hasApi}>
                          <Icon name="export" size={12} /> 导出
                        </button>
                        <button className="mini" onClick={importPresets} disabled={!hasApi}>
                          <Icon name="import" size={12} /> 导入
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="field">
                  <label>
                    目标帧率{sel ? <span className="lbl-hint">按所选视频实时计算</span> : null}
                  </label>
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
                  {prefs.mult === 0 && (
                    <input
                      className="fps-input"
                      value={prefs.customFps}
                      onChange={(e) => setPref('customFps', e.target.value.replace(/[^\d.]/g, ''))}
                      placeholder="例如 60"
                      inputMode="decimal"
                    />
                  )}
                  <div className={'hint' + (fpsValid || !sel ? '' : ' bad')}>
                    {sel
                      ? `${fmtFps(selFps)} fps → ${targetFps > 0 ? targetFps : '—'} fps${fpsValid ? '' : '（需高于原帧率，且在 5–' + MAX_FPS + ' 之间）'}`
                      : '尚未选择视频'}
                  </div>
                </div>

                <div className="field">
                  <label>补帧方式</label>
                  <div className="mode-grid">
                    {MODES.map((m) => (
                      <div
                        key={m.id}
                        role="button"
                        tabIndex={0}
                        className={'mode-card' + (prefs.mode === m.id ? ' sel' : '')}
                        onClick={() => setPref('mode', m.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setPref('mode', m.id)
                          }
                        }}
                      >
                        <h4>{m.title}</h4>
                        <p>{m.desc}</p>
                        <div className="mode-meta">
                          <span className="mode-tag">{m.tag}</span>
                          <span className="mode-dots">
                            速度 <Dots n={m.speed} /> 画质 <Dots n={m.quality} />
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {is4K && prefs.mode !== 'fast' && (
                    <div className="hint warn">
                      当前是高分辨率视频，光流补帧会非常耗时；建议先用「帧混合」确认效果，再决定跑不跑精细模式。
                    </div>
                  )}
                </div>

                <div className="field">
                  <label>输出质量</label>
                  <div className="quality-grid">
                    {QUALITIES.map((q) => (
                      <div
                        key={q.id}
                        role="button"
                        tabIndex={0}
                        className={'quality-card' + (prefs.quality === q.id ? ' sel' : '')}
                        onClick={() => setPref('quality', q.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setPref('quality', q.id)
                          }
                        }}
                      >
                        <h4>{q.title}</h4>
                        <p>{q.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label>封装格式</label>
                  <div className="seg">
                    <button className={prefs.container === 'mp4' ? 'on' : ''} onClick={() => changeContainer('mp4')}>
                      MP4（兼容性最好）
                    </button>
                    <button className={prefs.container === 'mkv' ? 'on' : ''} onClick={() => changeContainer('mkv')}>
                      MKV
                    </button>
                  </div>
                </div>

                <div className="field">
                  <label className={'check' + (nvencUnavailable ? ' off' : '')}>
                    <input
                      type="checkbox"
                      checked={prefs.useNvenc && !nvencUnavailable}
                      disabled={nvencUnavailable || !hasApi}
                      onChange={(e) => setPref('useNvenc', e.target.checked)}
                    />
                    硬件加速（NVIDIA NVENC）
                  </label>
                  <div className="hint">{meta?.nvencReason ?? '正在用本机 ffmpeg 实测 NVENC 能力…'}</div>
                  {nvencUnavailable && prefs.useNvenc && <div className="hint bad">本机不支持，已自动按 CPU 编码处理。</div>}
                </div>

                <div className="field">
                  <label>批量输出位置</label>
                  <div className="outdir-row">
                    <span className="outdir-path" title={prefs.outDir}>
                      {prefs.outDir || '各视频所在目录（默认）'}
                    </span>
                    <button className="ghost mini" disabled={!hasApi} onClick={() => void chooseOutDir()}>
                      指定文件夹…
                    </button>
                    {prefs.outDir && (
                      <button className="ghost mini" onClick={() => setPref('outDir', '')}>
                        恢复默认
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <section className="card action">
              {running || paused ? (
                <>
                  <div className="overall">
                    <span>
                      {running ? (
                        <>
                          正在处理 <b>{currentItem?.fileName ?? '…'}</b>
                        </>
                      ) : (
                        <b>队列已暂停</b>
                      )}
                    </span>
                    <span className="overall-stats">
                      完成 {doneCount} · 失败 {failedCount} · 剩余 {pendingCount}
                    </span>
                  </div>
                  <div className="bar overall-bar">
                    <div className="fill" style={{ width: `${overallPercent}%` }} />
                  </div>
                  <div className="stats dim">
                    <span>
                      总进度 <b>{overallPercent.toFixed(1)}%</b>（{doneCount + failedCount}/{items.length} 条已结算）
                    </span>
                  </div>
                  {currentItem ? (
                    <ProgressView
                      p={currentItem.progress ?? null}
                      duration={currentItem.info.durationSec}
                      notes={currentItem.notes}
                      encoder={currentItem.encoder ?? ''}
                    />
                  ) : (
                    <p className="fine">暂停中：当前没有任务在跑，已排队的 {pendingCount} 条会在你点「继续队列」后接着走。</p>
                  )}
                  <div className="btn-row main-actions">
                    {running ? (
                      <>
                        <button className="ghost" onClick={cancelCurrent} disabled={!hasApi}>
                          <Icon name="cross" size={14} /> 取消这一条
                        </button>
                        <button className="ghost" onClick={() => pauseQueue(false)}>
                          <Icon name="pause" size={14} /> 暂停队列（跑完当前这条停）
                        </button>
                        <button className="ghost danger" onClick={() => pauseQueue(true)}>
                          立即停止并取消当前
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="primary" onClick={resumeQueue} disabled={!pendingCount}>
                          <Icon name="play" size={14} /> 继续队列（{pendingCount}）
                        </button>
                        <button className="ghost" onClick={skipPending}>
                          放弃剩余
                        </button>
                      </>
                    )}
                  </div>
                  <p className="kbd-hint">
                    进度、帧率、倍速与剩余时间都取自 ffmpeg 自己报的 <code>-progress</code> 数据；推不出剩余时显示「—」。
                  </p>
                </>
              ) : (
                <>
                  {items.length === 1 ? (
                    <div className="out-row">
                      <span className="out-label">输出</span>
                      <input className="out-path" value={shownOut} readOnly title={shownOut} />
                      <button className="ghost" onClick={() => void chooseOutput()} disabled={!hasApi}>
                        修改…
                      </button>
                    </div>
                  ) : (
                    <div className="out-note">
                      将为 {items.length} 个视频按 <code>原名_帧率fps.{prefs.container}</code> 命名，输出到
                      {prefs.outDir ? (
                        <>
                          指定目录 <code>{prefs.outDir}</code>
                        </>
                      ) : (
                        '各自源文件所在目录'
                      )}
                      ，重名自动加后缀。
                    </div>
                  )}

                  {sel && (sel.status === 'error' || sel.status === 'cancelled') && (
                    <div className="error-box">
                      <div className="err-title">
                        <Icon name="warning" size={14} /> {sel.error}
                      </div>
                      {!!sel.steps?.length && (
                        <ol className="err-steps">
                          {sel.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      )}
                      {!!sel.notes.length && (
                        <ul className="err-steps">
                          {sel.notes.map((s, i) => (
                            <li key={`n${i}`}>提示：{s}</li>
                          ))}
                        </ul>
                      )}
                      {sel.log && (
                        <details>
                          <summary>查看原始日志</summary>
                          <pre>{sel.log}</pre>
                        </details>
                      )}
                      <div className="btn-row">
                        <button className="mini" onClick={() => resetToPending(sel.id)}>
                          <Icon name="retry" size={12} /> 重试这一条
                        </button>
                        <button className="mini" onClick={() => void window.api.showInFolder(sel.path)}>
                          <Icon name="folder" size={12} /> 打开源文件位置
                        </button>
                      </div>
                    </div>
                  )}

                  {screen === 'done' && items.length > 0 && (
                    <div className={'summary' + (failedCount > 0 ? ' warn' : '')}>
                      <Icon name={failedCount > 0 ? 'warning' : 'check'} size={14} /> 队列结束：成功 {doneCount} ·
                      失败/取消 {failedCount}
                    </div>
                  )}

                  {sel?.status === 'done' && sel.result && (
                    <div className="result-box">
                      <div className="result-path" title={sel.result.outputPath}>
                        {sel.result.outputPath}
                      </div>
                      <div className="chips">
                        <span className="chip ok">{fmtFps(sel.result.fps ?? 0)} fps（回探实测）</span>
                        <span className="chip ok">{fmtSize(sel.result.sizeBytes)}</span>
                        <span className="chip ok">{fmtDuration(sel.result.durationSec ?? 0)}</span>
                        {sel.result.elapsedSec != null && (
                          <span className="chip">用时 {fmtDuration(sel.result.elapsedSec)}</span>
                        )}
                        {sel.result.processFps ? <span className="chip">处理 {fmtFps(sel.result.processFps)} fps</span> : null}
                        {sel.encoder && <span className="chip">{sel.encoder}</span>}
                      </div>
                      <div className="btn-row result-actions">
                        <button
                          className="mini"
                          title="在文件管理器中选中输出文件"
                          onClick={() => void window.api.showInFolder(sel.result!.outputPath)}
                        >
                          <Icon name="folder" size={12} /> 打开所在目录
                        </button>
                        <button className="mini" onClick={() => resetToPending(sel.id)}>
                          <Icon name="retry" size={12} /> 再跑一次
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="btn-row main-actions">
                    {screen === 'done' && failedCount > 0 ? (
                      <button className="primary" onClick={retryAllFailed}>
                        <Icon name="play" size={14} /> 重试失败项（{failedCount}）
                      </button>
                    ) : (
                      <button className="primary" disabled={!canStart || busy} onClick={() => void runLoop()}>
                        <Icon name="play" size={14} /> 开始补帧{pendingCount > 1 ? `（${pendingCount} 个）` : ''}
                      </button>
                    )}
                    <button className="ghost" disabled={!doneCount && !failedCount} onClick={clearFinished}>
                      清空已完成
                    </button>
                  </div>
                  <p className="kbd-hint">
                    键盘：<kbd>Enter</kbd> 开始补帧 · <kbd>Del</kbd> 把选中项移出队列 · <kbd>Tab</kbd> 在控件间移动
                  </p>
                  <p className="fine">
                    光流补帧是 CPU 密集型，高分辨率下耗时可能达到视频时长的数倍到数十倍；先用「帧混合」快速看效果，再上光流出成片。处理全程在本机进行。
                  </p>
                  {command && (
                    <details className="cmd">
                      <summary>查看本次使用的 ffmpeg 命令</summary>
                      <pre>{command}</pre>
                    </details>
                  )}
                </>
              )}
            </section>
          </>
        )}

        {dragOver && (
          <div className="drag-overlay">
            <div>松开以添加视频（支持多选）</div>
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
            void addFiles(e.target.files)
            e.currentTarget.value = ''
          }}
        />
      </div>
    </>
  )
}

function emptyProgress(): ProgressData {
  return { percent: 0, outTimeSec: 0, fps: 0, speed: null, frame: 0, totalFrames: 0, etaSec: null }
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
  if (!meta) return { text: '检测本机能力…', cls: 'badge dim', icon: 'info' }
  if (meta.binProblem) return { text: 'ffmpeg 缺失', cls: 'badge err', icon: 'warning' }
  if (meta.nvenc === 'modern' || meta.nvenc === 'legacy') {
    return { text: 'NVENC 硬件加速可用', cls: 'badge ok', icon: 'gpu' }
  }
  return { text: 'CPU 编码（无 NVENC）', cls: 'badge dim', icon: 'cpu' }
}

function ProgressView(props: { p: ProgressData | null; duration: number; notes: string[]; encoder: string }) {
  const { p, duration, notes, encoder } = props
  const percent = Math.min(100, p?.percent ?? 0)
  const stage = p?.stage ?? 'encode'
  // retry 是「换了编码器再跑一遍编码」，步骤位置仍落在「补帧编码」
  const activeIdx = stage === 'retry' ? STEPS.findIndex((s) => s.stage === 'encode') : STEPS.findIndex((s) => s.stage === stage)
  return (
    <div className="prog">
      <div className="prog-head">
        <strong>{percent >= 100 ? '正在收尾写入文件…' : (p?.stageLabel ?? '准备中')}</strong>
        <span className="pct">{percent.toFixed(1)}%</span>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${percent}%` }} />
      </div>
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.stage} className={i < activeIdx ? 'past' : i === activeIdx ? 'cur' : ''}>
            {s.label}
          </li>
        ))}
      </ol>
      <div className="stats">
        <span>
          已处理 <b>{fmtDuration(p?.outTimeSec ?? 0)}</b> / {fmtDuration(duration)}
        </span>
        <span>
          输出帧 <b>{p?.frame ?? 0}</b> / {p?.totalFrames ?? '—'}
        </span>
        <span>
          实时处理帧率 <b>{p?.fps ? `${p.fps} fps` : '—'}</b>
        </span>
        <span>
          相对实时 <b>{p?.speed ? `${p.speed.toFixed(2)}x` : '—'}</b>
        </span>
        <span>
          已用 <b>{p?.elapsedSec != null ? fmtDuration(p.elapsedSec) : '—'}</b>
        </span>
        <span>
          预计剩余{' '}
          <b>{p?.etaSec != null && Number.isFinite(p.etaSec) ? fmtDuration(p.etaSec) : '—'}</b>
        </span>
      </div>
      {encoder && (
        <div className="stats dim">
          编码器：<b>{encoder}</b>
        </div>
      )}
      {notes.map((n, i) => (
        <div className="note" key={i}>
          {n}
        </div>
      ))}
    </div>
  )
}

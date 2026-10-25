// 纯函数模块：补帧命令构建、回退策略与输出命名。不依赖 Electron，可被测试脚本直接 require。

export type Mode = 'high' | 'balanced' | 'fast'
export type NvencLevel = 'none' | 'legacy' | 'modern'
export type Quality = 'master' | 'high' | 'standard'

export interface ProbeResult {
  path: string
  fileName: string
  sizeBytes: number
  durationSec: number
  width: number
  height: number
  /** 基准帧率（r_frame_rate，异常时为 0） */
  fps: number
  /** 平均帧率（avg_frame_rate，异常时为 0） */
  avgFps: number
  fpsRational: string
  pixFmt: string
  videoCodec: string
  /** 该流在所有视频流中的序号（用于 -map 0:v:N），已排除封面图 */
  videoStreamIndex: number
  colorPrimaries: string
  colorTrc: string
  colorSpace: string
  hasAudio: boolean
  audioCodec: string
}

export interface RenderParams {
  inputPath: string
  outputPath: string
  targetFps: number
  mode: Mode
  quality: Quality
  useNvenc: boolean
  container: 'mp4' | 'mkv'
  scdThreshold?: number
  copySubtitles?: boolean
}

export interface Attempt {
  nvenc: NvencLevel
  audio: 'copy' | 'aac'
}

export const MAX_FPS = 480

// ---------------------------------------------------------------------------
// 时间闸门：凡「等一个可能永远不来的终态」的地方都过这一套，避免整条队列干挂
// ---------------------------------------------------------------------------

/** 预渲染探测（ffprobe 一次）默认上限；环境变量 FRAMEBOOST_PROBE_TIMEOUT_MS 可改 */
export const DEFAULT_PROBE_TIMEOUT_MS = 45_000
/** 其余短命令（-version、NVENC 能力检测等）默认上限；FRAMEBOOST_RUN_TIMEOUT_MS 可改 */
export const DEFAULT_RUN_TIMEOUT_MS = 60_000
/** 子进程 stdout/stderr 各自的字节上限；超出即截断并如实报告，不再无限堆积内存 */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** 一条渲染任务的总时限；FRAMEBOOST_JOB_TIMEOUT_MS 可改，0 表示不设限 */
export const DEFAULT_JOB_TIMEOUT_MS = 4 * 60 * 60 * 1000
/** 主进程任务时限之外再给队列的宽限：主进程一定比队列先判死，队列只是兜底 */
export const TERMINAL_GRACE_MS = 5 * 60 * 1000

/**
 * 把环境变量（或任何未知输入）读成一个「正整数毫秒」。
 * 非法值回落默认，绝不回落 0 —— 0 在这里的含义是「不设限」，
 * 让一个打错的环境变量把闸门关掉，等于没有闸门。
 */
export function readTimeoutMs(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n) || n < 0) return fallback
  if (n === 0) return 0 // 显式写 0 = 调用方主动要求不设限，尊重它
  return Math.round(n)
}

/** 带 node 风格 code 的超时错误，交给 classifyFailure 出「下一步」 */
export function deadlineError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string }
  e.name = 'DeadlineError'
  e.code = code
  return e
}

/**
 * 给一个「可能永不 settle」的 Promise 套上时限：到点以 deadlineError 失败。
 * ms <= 0 时不设限（照旧返回原 Promise），用于显式关闭闸门。
 * 计时器在 settle 后立即清除，不留悬挂句柄。
 */
export function withDeadline<T>(p: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  if (!(ms > 0)) return p
  let timer: ReturnType<typeof setTimeout> | null = null
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(deadlineError(code, message)), ms)
    p.then(
      (v) => {
        if (timer) clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        if (timer) clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** 到点要杀的那个东西：只要具备 kill/once 就行（node 的 ChildProcess 天然满足） */
export interface DeadlineProcess {
  kill?: (...args: any[]) => unknown
  once?: (...args: any[]) => unknown
}

/** 时限到点时要做的动作（杀进程 + 落终态），返回是否真的执行了 */
export interface ProcessDeadline {
  cancel(): void
  readonly ms: number
  fired: boolean
}

/**
 * 给一个子进程挂总时限：到点调用 onExpired（约定它负责 kill 并把作业判失败）。
 * 进程若在时限内退出，计时器自动取消 —— 不留悬挂 timer，测试里也不会拖住事件循环。
 */
export function attachProcessDeadline(proc: DeadlineProcess | null | undefined, ms: number, onExpired: () => void): ProcessDeadline {
  let timer: ReturnType<typeof setTimeout> | null = null
  const handle: ProcessDeadline = {
    ms,
    fired: false,
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
  if (!(ms > 0) || !proc) return handle
  timer = setTimeout(() => {
    timer = null
    handle.fired = true
    try {
      proc.kill?.()
    } catch {
      /* 已经退了 */
    }
    onExpired()
  }, ms)
  proc.once?.('close', () => handle.cancel())
  proc.once?.('exit', () => handle.cancel())
  return handle
}

/** 队列等终态用的时限：主进程任务时限 + 宽限 */
export function terminalDeadlineMs(jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS): number {
  if (!(jobTimeoutMs > 0)) return 0
  return jobTimeoutMs + TERMINAL_GRACE_MS
}

/** 「这一条卡住了」那句可执行的中文 —— 队列与主进程共用同一句，不分叉 */
export function stalledReasonText(ms: number): string {
  const minutes = Math.round(ms / 60000)
  return `这一条超过 ${minutes >= 1 ? `${minutes} 分钟` : `${ms} 毫秒`} 没有回报终态，已按失败收口，队列继续跑后面的任务`
}

export function sanitizeRational(v: unknown, fallbackNum: number): string {
  const s = String(v ?? '')
  const m = /^(\d+)\/(\d+)$/.exec(s)
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
    const val = Number(m[1]) / Number(m[2])
    // 过大的 r_frame_rate（如 mkv 里按 timebase 误报的 90000/1）视为无效
    if (val <= MAX_FPS) return `${m[1]}/${m[2]}`
  }
  return fallbackNum > 0 && fallbackNum <= MAX_FPS ? String(Math.round(fallbackNum)) : ''
}

/** 依据 10bit 编码能力决定输出像素格式；10bit 源在不支持时降级为 8bit */
export function pixFmtFor(src: string, tenBitCapable: boolean): { fmt: string; downgraded: boolean } {
  const is10 = /10le|10be/.test(src)
  if (is10 && tenBitCapable) return { fmt: 'yuv420p10le', downgraded: false }
  if (is10) return { fmt: 'yuv420p', downgraded: true }
  return { fmt: 'yuv420p', downgraded: false }
}

/**
 * 补帧滤镜链。
 * 关键画质点：minterpolate/framerate 处理最后一段时缺少"下一帧"会丢尾部，
 * 先 tpad 克隆补 1s 再插帧，最后 trim 回原时长，保证输出帧数完整、音画对齐。
 */
export function buildFilter(p: RenderParams, info: ProbeResult, tenBitCapable: boolean): string {
  const { fmt } = pixFmtFor(info.pixFmt, tenBitCapable)
  const hasDur = info.durationSec > 0
  const pad = hasDur ? 'tpad=stop_mode=clone:stop_duration=1,' : ''
  const trim = hasDur ? `trim=duration=${info.durationSec.toFixed(3)},` : ''
  if (p.mode === 'fast') {
    return `${pad}framerate=fps=${p.targetFps},${trim}format=${fmt}`
  }
  const scd = p.scdThreshold && p.scdThreshold > 0 ? (':scd=fdiff:scd_threshold=' + p.scdThreshold) : ''
  const mc =
    p.mode === 'high'
      ? ('mc_mode=aobmc:me_mode=bidir:vsbmc=1' + scd)
      : ('mc_mode=obmc:me_mode=bidir:vsbmc=0' + scd)
  const src = sanitizeRational(info.fpsRational, info.fps > 0 ? info.fps : info.avgFps)
  const normalize = src ? `fps=${src},` : ''
  return `${normalize}${pad}minterpolate=fps=${p.targetFps}:mi_mode=mci:${mc},${trim}format=${fmt}`
}

export function encoderArgs(level: NvencLevel, quality: Quality): string[] {
  const cq = quality === 'master' ? '17' : quality === 'high' ? '19' : '23'
  if (level === 'modern') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', cq, '-b:v', '0']
  }
  if (level === 'legacy') {
    return ['-c:v', 'h264_nvenc', '-preset', 'llhq', '-rc', 'vbr', '-cq', cq, '-b:v', '0']
  }
  if (quality === 'master') return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '10']
  if (quality === 'high') return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16']
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20']
}

export function encoderLabel(level: NvencLevel): string {
  return level === 'none' ? 'CPU · libx264' : 'NVIDIA NVENC · H.264'
}

/**
 * 尝试序列规划：
 * - NVENC 仅在启用、检测可用且输出为 8bit 时尝试（h264_nvenc 不支持 10bit）
 * - 音轨先无损直写，失败（编解码器与容器不兼容）自动回退 AAC 重编码
 */
export function planAttempts(p: RenderParams, nvencLevel: NvencLevel, eightBit: boolean): Attempt[] {
  const attempts: Attempt[] = []
  if (p.useNvenc && nvencLevel !== 'none' && eightBit) {
    attempts.push({ nvenc: nvencLevel, audio: 'copy' })
  }
  attempts.push({ nvenc: 'none', audio: 'copy' })
  attempts.push({ nvenc: 'none', audio: 'aac' })
  return attempts
}

/** 输出文件重名时自动追加 " (1)" 后缀，避免覆盖已有文件 */
export function resolveOutputPath(desired: string, exists: (p: string) => boolean): string {
  if (!exists(desired)) return desired
  const m = /^(.*)(\.[^./\\]+)$/.exec(desired)
  const base = m ? m[1] : desired
  const ext = m ? m[2] : ''
  for (let i = 1; i < 1000; i++) {
    const cand = `${base} (${i})${ext}`
    if (!exists(cand)) return cand
  }
  return `${base} (new)${ext}`
}

// ---------------------------------------------------------------------------
// 渲染阶段（真实步骤，不是猜的百分比）
// ---------------------------------------------------------------------------

/**
 * 渲染作业的真实阶段。每个值都对应代码里确实发生的一步：
 * probe=ffprobe 解析源，preflight=能力/磁盘/权限预检，encode=ffmpeg 子进程运行中，
 * finalize=把 .part 改名为正式文件，reprobe=回探产物，终态 done/failed/cancelled。
 */
export type RenderStage =
  | 'queued'
  | 'probe'
  | 'preflight'
  | 'encode'
  | 'retry'
  | 'finalize'
  | 'reprobe'
  | 'done'
  | 'failed'
  | 'cancelled'

const STAGE_LABELS: Record<RenderStage, string> = {
  queued: '排队中',
  probe: '探测源文件',
  preflight: '能力与磁盘预检',
  encode: '补帧编码',
  retry: '回退重试',
  finalize: '写入产物',
  reprobe: '回探产物',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

export function stageLabel(s: RenderStage): string {
  return STAGE_LABELS[s] ?? String(s)
}

/** 阶段是否属于「已经不在跑」的终态 */
export function isTerminalStage(s: RenderStage): boolean {
  return s === 'done' || s === 'failed' || s === 'cancelled'
}

// ---------------------------------------------------------------------------
// ffmpeg -progress 输出解析（主进程与 Agent 共用同一份，避免两处漂移）
// ---------------------------------------------------------------------------

export interface ProgressState {
  /** 已输出的视频时长（秒），来自 out_time_us / out_time_ms */
  outTimeSec: number
  frame: number
  /** ffmpeg 报告的实时处理帧率 */
  fps: number
  /** ffmpeg 报告的相对实时倍速，如 1.85x；解析不到为 null */
  speed: number | null
  /** 是否收到过 progress=end */
  endSeen: boolean
  /** 已解析到的进度行数，用于判断「进度是否真的在动」 */
  lines: number
}

export function createProgressState(): ProgressState {
  return { outTimeSec: 0, frame: 0, fps: 0, speed: null, endSeen: false, lines: 0 }
}

/**
 * 消费一行 ffmpeg 的 `key=value` 进度输出。
 * 返回 true 表示这一行是已知进度字段并被采纳；未知字段原样忽略（ffmpeg 以后加字段不会炸）。
 * 只接受有限且非负的数值，坏值不会污染状态。
 */
export function applyProgressLine(st: ProgressState, line: unknown): boolean {
  const s = String(line ?? '').trim()
  const eq = s.indexOf('=')
  if (eq <= 0) return false
  const key = s.slice(0, eq).trim()
  const val = s.slice(eq + 1).trim()
  if (key === 'out_time_us' || key === 'out_time_ms') {
    // 注意：ffmpeg 的 out_time_ms 名字是历史遗留，值实际也是微秒
    const us = Number(val)
    if (!Number.isFinite(us) || us < 0) return false
    st.outTimeSec = us / 1e6
  } else if (key === 'frame') {
    const f = Number(val)
    if (!Number.isFinite(f) || f < 0) return false
    st.frame = f
  } else if (key === 'fps') {
    const f = Number(val)
    if (!Number.isFinite(f) || f <= 0) return false
    st.fps = f
  } else if (key === 'speed') {
    const m = /([\d.]+)/.exec(val)
    if (!m) return false
    const sp = Number(m[1])
    if (!Number.isFinite(sp) || sp <= 0) return false
    st.speed = sp
  } else if (key === 'progress') {
    if (val === 'end') st.endSeen = true
    else return false
  } else {
    return false
  }
  st.lines++
  return true
}

/**
 * 进度百分比。运行中上限 99.5（ffmpeg 还在写尾包，不谎称 100），
 * 收到 progress=end 或已终态才给 100。时长未知时返回 0，不猜。
 */
export function percentFor(st: ProgressState, durationSec: number, isRunning: boolean): number {
  const raw = durationSec > 0 ? (st.outTimeSec / durationSec) * 100 : 0
  const clamped = Math.min(100, Math.max(0, raw))
  if (st.endSeen) return 100
  return isRunning ? Math.min(99.5, clamped) : clamped
}

/** 预估剩余秒数：只用 ffmpeg 自己报的 speed，没有就返回 null（不猜） */
export function etaSeconds(st: ProgressState, durationSec: number): number | null {
  if (!(durationSec > 0) || !(st.speed && st.speed > 0)) return null
  const remain = durationSec - st.outTimeSec
  if (remain <= 0) return 0
  return Math.round(remain / st.speed)
}

// ---------------------------------------------------------------------------
// 输出体量与磁盘空间预估
// ---------------------------------------------------------------------------

/** 每像素每帧的目标比特数（bpp），按质量档取经验值，用于「预估需要多少空间」 */
const BPP: Record<Quality, number> = { master: 0.15, high: 0.1, standard: 0.06 }

/** 粗估输出字节数（含 192k 音轨）。刻意保守偏高，避免预检放行后真的写满。 */
export function estimateOutputBytes(info: ProbeResult, targetFps: number, quality: Quality): number {
  const px = Math.max(0, info.width) * Math.max(0, info.height)
  const dur = Math.max(0, info.durationSec)
  const videoBits = px * BPP[quality] * Math.max(targetFps, 1) * dur
  const audioBits = info.hasAudio ? 192000 * dur : 0
  const bytes = (videoBits + audioBits) / 8
  // 容器与写不下的整数帧，再留 8%
  return Math.round(bytes * 1.08)
}

/** 预检要求的最小余量倍数：留出临时文件与文件系统碎片 */
export const DISK_HEADROOM = 1.35

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

// ---------------------------------------------------------------------------
// 路径体检：中文与空格不是问题，超长/保留名才是
// ---------------------------------------------------------------------------

/** Windows MAX_PATH 约 260，ffmpeg 走 CRT fopen，留安全边界 */
export const LONG_PATH_LIMIT = 240

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 返回路径本身的真实问题（无问题返回 null）。
 * 中文与空格都能过：子进程用 argv 数组直接起 ffmpeg，不经过 cmd 解释，所以不在此列。
 */
export function pathNamingProblem(p: unknown): string | null {
  const s = String(p ?? '')
  if (!s) return '路径为空'
  const m = /(?:^|[\\/])([^\\/]+)\.[^.\\/]+$/.exec(s)
  const stem = m ? m[1] : s.split(/[\\/]/).pop() ?? ''
  if (RESERVED.test(stem)) return `文件名「${stem}」是 Windows 保留名，不能用作输出`
  if (/[.]$/.test(s)) return '路径以「.」结尾，Windows 不允许'
  if (/[ ]$/.test(s)) return '路径以空格结尾，Windows 下容易出错'
  if (/[<>:"|?*]/.test(s.replace(/^[A-Za-z]:/, ''))) return '路径含 Windows 非法字符 <>:"|?*'
  if (s.length > LONG_PATH_LIMIT) return `路径长度 ${s.length} 字符，超过 ${LONG_PATH_LIMIT} 的安全上限`
  return null
}

// ---------------------------------------------------------------------------
// 失败归因：每种错误都给出「下一步能做什么」，不是一句「处理失败」
// ---------------------------------------------------------------------------

export interface FailureInfo {
  /** 一句话结论，可直接做标题 */
  title: string
  /** 原始证据（stderr / 系统消息），可展开查看 */
  detail: string
  /** 可执行的下一步，按最可能有效排序 */
  steps: string[]
}

const FS_CODE_FAILURES: Record<string, Omit<FailureInfo, 'detail'>> = {
  ENOENT: {
    title: '路径不存在',
    steps: [
      '确认输入文件还在原位置（被移动/重命名/网盘未同步都会报这个）',
      '输出目录不存在时先在文件管理器里新建，或改用「修改…」重新指一个',
      '把文件重新拖进队列一次，让它取到当前真实路径'
    ]
  },
  EACCES: {
    title: '没有读写权限',
    steps: [
      '换一个你有权限的输出目录（例如「视频」文件夹）',
      '若输出文件已在播放器/剪辑软件里打开，先关掉它再重试',
      '检查该文件夹的「只读」属性，或以管理员身份重新启动 FrameBoost'
    ]
  },
  EPERM: {
    title: '文件被占用或受保护',
    steps: [
      '关闭正在使用该文件的播放器、剪辑软件与杀毒扫描',
      '把输出目录改到非系统盘（如 D:\\frameboost-out）',
      '若目标在受保护文件夹（Program Files、系统盘根目录），换目录'
    ]
  },
  EROFS: {
    title: '目标磁盘是只读的',
    steps: ['把输出目录改到可写的本地磁盘', 'U 盘/光盘/只读网络共享不能作为输出位置']
  },
  ENOSPC: {
    title: '磁盘空间不足',
    steps: [
      '清理目标磁盘后重试（软件已按分辨率与质量预估过所需空间）',
      '把「输出质量」降到标准，或先只跑一段短片验证效果',
      '换一个剩余空间更大的磁盘作为输出目录'
    ]
  },
  ENAMETOOLONG: {
    title: '路径过长',
    steps: [
      `Windows 传统路径上限约 260 字符，请把输出目录挪到更浅的位置（如 D:\\out）`,
      '给文件改个短一点的名字',
      '确需深层目录时，在系统里启用长路径支持（组策略：启用 Win32 长路径）'
    ]
  },
  ENOTDIR: {
    title: '路径中某一段不是目录',
    steps: ['检查输出路径：中间层应是文件夹，最后一项才是文件名', '确认没有把文件名当成目录写进路径']
  },
  EISDIR: {
    title: '把目录当成了文件',
    steps: ['输出路径要指到具体文件名（含 .mp4/.mkv 后缀），不能只写文件夹', '在输出框用「修改…」重新命名']
  },
  EMFILE: { title: '系统文件句柄不足', steps: ['关闭其它大量读写文件的程序后重试', '一次少排几条任务'] },
  ENFILE: { title: '系统打开的文件过多', steps: ['关闭其它程序释放句柄后重试'] },
  EINVAL: { title: '参数不被系统接受', steps: ['检查路径是否含异常字符（不可见字符、全角引号）', '把文件移到干净的英文目录再试'] }
}

function firstErrorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^frame=/.test(l) && !/^\d+%/.test(l))
  return lines[lines.length - 1] ?? ''
}

/** 我们自己的校验错误：结论已经说得很准，直接给下一步，不再套一层泛泛标题 */
const PLAIN_CODE_FAILURES: Record<string, () => Omit<FailureInfo, 'detail'>> = {
  BAD_INPUT: () => ({ title: '还没有选好文件', steps: ['把视频拖进队列，或用「添加视频…」选择文件'] }),
  SAME_PATH: () => ({
    title: '输出路径和输入是同一个文件',
    steps: ['给输出换个文件名（默认命名会加「_帧率fps」后缀）', 'FrameBoost 不会覆盖你的源文件']
  }),
  BAD_TARGET_FPS: () => ({
    title: '目标帧率没有高于源帧率',
    steps: [
      '把倍率调到 ×2 以上，或把自定义帧率填得比源帧率高',
      '源已经是 60fps 的话，×2 到 120fps 才有意义',
      '播放/剪辑需求通常 50 或 60fps 就够，不必一味求高帧率'
    ]
  }),
  FPS_RANGE: () => ({
    title: '目标帧率超出可用范围',
    steps: [`请填写 5 到 ${MAX_FPS} 之间的整数帧率`, '常用取值：50 / 60 / 90 / 120']
  }),
  BAD_OUTPUT_EXT: () => ({
    title: '输出封装格式不支持',
    steps: ['输出文件名需要以 .mp4 或 .mkv 结尾', '在输出框点「修改…」重新命名即可']
  }),
  NO_SOURCE_FPS: () => ({
    title: '读不到源视频的帧率',
    steps: ['这类文件多半是可变帧率或录屏/监控产物', '先无损重封装成恒定帧率：ffmpeg -i 输入 -c copy 中间.mp4', '或改用 MKV 容器再试一次']
  }),
  PROBE_TIMEOUT: () => ({
    title: '读取视频信息超时（ffprobe 一直没有回话）',
    steps: [
      '这种文件多半索引损坏或在等一个读不到的数据源：先用播放器完整播一遍看会不会卡住',
      '网络盘 / 网盘占位文件 / 压缩包里的文件先拷到本地磁盘再处理',
      '试着重封装一次再探测：ffmpeg -i 输入 -c copy 修复.mp4',
      '确认是超大文件需要更久时，设置环境变量 FRAMEBOOST_PROBE_TIMEOUT_MS 放宽探测时限（毫秒）'
    ]
  }),
  PROBE_OUTPUT_TOO_LARGE: () => ({
    title: '视频信息异常庞大，已按上限截断',
    steps: [
      '正常视频不会输出这么多探测信息，多半是流数量失控（几百条字幕/数据流）或文件被反复追加',
      '用 ffmpeg -i 输入 -map 0:v:0 -c copy 单一视频.mp4 取一条流重封装后再处理',
      '确需提高上限时设置 FRAMEBOOST_PROBE_MAX_OUTPUT_MB（单位 MB，默认 8）'
    ]
  }),
  RENDER_TIMEOUT: () => ({
    title: '这一条渲染卡住了，已按失败终止',
    steps: [
      '已强制结束这条 ffmpeg，半成品 .part 也一并清掉，不会留下看起来成功的假文件',
      '常见原因是源里有损坏片段：先播到卡住的时间点确认，或重封装修掉那一段',
      '超长视频确实需要更久时，设置 FRAMEBOOST_JOB_TIMEOUT_MS 放宽单条任务时限（毫秒，0 = 不设限）',
      '后面的排队任务不受影响，可在队列里单独重试这一条'
    ]
  }),
  OUT_OF_WORKSPACE: () => ({
    title: '输出路径不在已授权的工作目录内',
    steps: [
      '在界面「输出目录」里用「修改…」选一个目录，它即成为本次会话允许写入的工作范围',
      '通过 Agent / 应用内接口调用时，outputPath 必须落在该工作目录之内（含符号链接指向外也不行）',
      '想写到别处，请重新选择输出目录，不要手填路径'
    ]
  }),
  INPUT_NOT_ALLOWED: () => ({
    title: '这份输入不是用户在界面里打开过的文件',
    steps: [
      '用「添加视频…」或拖拽把文件放进队列，路径才会被登记为可读',
      'Agent / 应用内接口只能处理已登记路径或输出工作目录内的文件',
      '确认无误后可把 FRAMEBOOST_INPUT_ROOTS 指到允许读取的目录（用 ; 分隔多个）'
    ]
  }),
  WORKSPACE_NOT_SET: () => ({
    title: '还没有选择输出工作目录',
    steps: ['在界面「输出目录」点「修改…」选一个目录后再开始', 'Agent 调用请先让用户挑好输出位置，软件不替人决定往哪写']
  })
}

/**
 * 把「节点错误码 + ffmpeg stderr + 我们自己的消息」归一成用户能据此行动的结论。
 * 判定顺序：错误码 → stderr 特征 → 消息特征 → 兜底；兜底也给出可执行下一步，不给空话。
 */
export function classifyFailure(o: {
  stage?: RenderStage
  code?: string | null
  message?: string
  stderr?: string
  detailPath?: string
}): FailureInfo {
  const stderr = String(o.stderr ?? '')
  const message = String(o.message ?? '')
  const detail = (firstErrorLine(stderr) || message || stderr).slice(0, 900)
  const byCode = o.code ? FS_CODE_FAILURES[String(o.code).toUpperCase()] : undefined
  const low = (stderr + ' ' + message).toLowerCase()
  const code = o.code ? String(o.code).toUpperCase() : ''

  const plain = code ? PLAIN_CODE_FAILURES[code] : undefined
  if (plain) {
    const f = plain()
    return { title: f.title, detail: message || f.title, steps: f.steps }
  }

  if (code === 'NO_VIDEO_STREAM') {
    return {
      title: '这个文件里没有视频流',
      detail,
      steps: [
        '确认选中的是视频而不是音频、图片或字幕文件',
        '若确实是视频，可能是流信息写在文件尾部而文件被截断：重新导出或重新下载',
        '用「帧混合」跑一遍不能绕过此检查——问题在源文件本身'
      ]
    }
  }
  if (code === 'EMPTY_FILE') {
    return {
      title: '文件是空的（0 字节）',
      detail,
      steps: ['下载或导出没有完成，请重新获取这份文件', '确认网盘已把该文件同步到本地而不是只留了占位符']
    }
  }
  if (code === 'BAD_INPUT') {
    return { title: '没有选中有效的文件', detail, steps: ['把视频拖进队列，或用「添加视频…」重新选择'] }
  }
  if (code === 'FFMPEG_SPAWN_FAILED' || code === 'FFPROBE_SPAWN_FAILED') {
    return {
      title: '启动不了 ffmpeg',
      detail,
      steps: [
        'FrameBoost 自带 ffmpeg，出现这种情况通常是安装文件被杀毒软件隔离：请恢复或重新安装',
        '也可自行安装 ffmpeg 并设置环境变量 FFMPEG_PATH / FFPROBE_PATH 指向 exe',
        '路径过长同样会让进程起不来：把文件移到更浅的目录再试'
      ]
    }
  }

  if (/(no space left on device|not enough space|磁盘空间)/.test(low)) {
    return { title: '磁盘空间不足（写满）', detail, steps: FS_CODE_FAILURES.ENOSPC.steps }
  }
  if (/(unknown encoder|encoder .{0,40}not found|is not a known encoder|unrecognized option)/.test(low)) {
    return {
      title: '编码器不可用',
      detail,
      steps: [
        '在设置里关掉「硬件加速」，改用 CPU 的 libx264 再跑一次',
        '把「输出质量」换成标准（只用最通用的编码参数）',
        '若必须 NVENC：将 NVIDIA 驱动升级到支持 h264_nvenc 的版本',
        '或安装包含 libx264 的 ffmpeg 构建，并把 FFMPEG_PATH 指到它'
      ]
    }
  }
  if (/(invalid data found|error while decoding|moov atom not found|not a valid|demuxing|broken)/.test(low)) {
    return {
      title: '源文件损坏或不是有效视频',
      detail,
      steps: [
        '先用播放器完整播一遍，确认能播到结尾',
        '尝试无损重新封装修复：ffmpeg -i 损坏.mp4 -c copy 修复.mp4',
        '重新导出或重新下载这份源文件',
        '在队列里只移除这一条，后面的任务不受影响、会继续跑'
      ]
    }
  }
  if (/(nvenc|cuda|cu_|cannot open video codec)/.test(low)) {
    return {
      title: 'NVENC 初始化失败',
      detail,
      steps: [
        '关闭「硬件加速」用 CPU 编码，先保证产出',
        '更新 NVIDIA 驱动；消费级显卡同时最多 8 路编码，减少并发任务',
        '确认这台机器有 NVIDIA 独显（AMD/Intel 核显不支持 h264_nvenc）'
      ]
    }
  }
  if (/(permission denied|read-only file system|operation not permitted)/.test(low)) {
    return { title: '输出位置不可写', detail, steps: FS_CODE_FAILURES.EACCES.steps }
  }
  if (/(failed to rename|error opening output|unable to write|error writing trailer)/.test(low)) {
    return {
      title: '产物写入失败',
      detail,
      steps: [
        '检查输出目录剩余空间与写权限',
        '确认输出文件没被别的程序占用（播放器、索引服务）',
        '把输出目录换成浅层路径（如 D:\\out）后重试'
      ]
    }
  }
  if (/(enoent|no such file or directory)/.test(low)) {
    return { title: '找不到文件或目录', detail, steps: FS_CODE_FAILURES.ENOENT.steps }
  }
  if (byCode) {
    return { title: byCode.title, detail, steps: [...byCode.steps] }
  }
  if (/name too long|path too long/.test(low) || (o.detailPath && pathNamingProblem(o.detailPath))) {
    return { title: '路径不合法', detail, steps: FS_CODE_FAILURES.ENAMETOOLONG.steps }
  }
  if (o.stage === 'probe') {
    return {
      title: '无法读取视频信息',
      detail,
      steps: [
        '确认文件扩展名与实际封装一致（改过后缀的文件常见此错）',
        '换 FFmpeg 支持的容器：MP4 / MKV / MOV / WebM',
        '先拷到本地磁盘再处理（网络盘与压缩包内文件读不稳）'
      ]
    }
  }
  return {
    title: '补帧处理失败',
    detail,
    steps: [
      '展开下方日志定位具体报错的那一行',
      '用「帧混合 + 标准质量」先跑 10 秒短片，验证链路通不通',
      '把输出目录改到浅层、可写、空间充足的位置',
      '失败只影响这一条：其余排队任务照常继续，可单独重试本条'
    ]
  }
}

/** 从 Error / unknown 里抽 node 错误码（没有则 null） */
export function errorCodeOf(err: unknown): string | null {
  const e = err as { code?: unknown } | null | undefined
  const c = e && typeof e === 'object' ? e.code : undefined
  return typeof c === 'string' && c ? c.toUpperCase() : null
}

/** 统一把异常转成 FailureInfo，主进程与 Agent 用同一条路 */
export function failureFrom(err: unknown, stage: RenderStage = 'encode'): FailureInfo {
  const e = err as { code?: unknown; message?: unknown } | null
  const message = err instanceof Error ? err.message : String(err)
  const code = typeof e?.code === 'string' ? String(e.code).toUpperCase() : null
  return classifyFailure({ stage, code, message })
}

// ---------------------------------------------------------------------------
// 预设：可保存、可导出导入的本机 JSON 组合
// ---------------------------------------------------------------------------

export interface Preset {
  id: string
  name: string
  mode: Mode
  quality: Quality
  container: 'mp4' | 'mkv'
  useNvenc: boolean
  /** 帧率倍率；0 表示使用 customFps 绝对值 */
  multiplier: number
  customFps: number
  /** 内置预设不可删除 */
  builtin: boolean
}

export const PRESET_NAME_MAX = 32
export const MAX_USER_PRESETS = 50

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'preset-smooth',
    name: '日常流畅 ×2',
    mode: 'balanced',
    quality: 'high',
    container: 'mp4',
    useNvenc: true,
    multiplier: 2,
    customFps: 60,
    builtin: true
  },
  {
    id: 'preset-film',
    name: '精细成片 ×2',
    mode: 'high',
    quality: 'master',
    container: 'mkv',
    useNvenc: false,
    multiplier: 2,
    customFps: 60,
    builtin: true
  },
  {
    id: 'preset-draft',
    name: '快速预览 ×2',
    mode: 'fast',
    quality: 'standard',
    container: 'mp4',
    useNvenc: true,
    multiplier: 2,
    customFps: 60,
    builtin: true
  },
  {
    id: 'preset-hdr10',
    name: '10bit/HDR 保真 ×2',
    mode: 'balanced',
    quality: 'master',
    container: 'mkv',
    useNvenc: false,
    multiplier: 2,
    customFps: 60,
    builtin: true
  }
]

/** 归一任意来源的预设；不合法（非对象/帧率越界）返回 null，绝不放过去路子的值 */
export function normalizePreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const mode = r.mode === 'high' || r.mode === 'fast' ? r.mode : r.mode === 'balanced' ? 'balanced' : null
  const quality =
    r.quality === 'master' || r.quality === 'standard' ? r.quality : r.quality === 'high' ? 'high' : null
  if (!mode || !quality) return null
  const container = r.container === 'mkv' ? 'mkv' : r.container === 'mp4' ? 'mp4' : null
  if (!container) return null
  const mult = Number(r.multiplier)
  const multiplier = Number.isFinite(mult) && [0, 2, 3, 4].includes(Math.round(mult)) ? Math.round(mult) : 2
  const cf = Number(r.customFps)
  const customFps = Number.isFinite(cf) && cf >= 5 && cf <= MAX_FPS ? Math.round(cf) : 60
  const name = sanitizePresetName(r.name)
  if (!name) return null
  const id = /^[A-Za-z0-9._-]{1,64}$/.test(String(r.id ?? '')) ? String(r.id) : `preset-${Date.now().toString(36)}`
  return {
    id,
    name,
    mode,
    quality,
    container,
    useNvenc: r.useNvenc !== false,
    multiplier,
    customFps,
    builtin: r.builtin === true
  }
}

export function sanitizePresetName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .trim()
    .slice(0, PRESET_NAME_MAX)
}

/**
 * 组装最终预设列表：内置永远在前且不可被同名用户预设顶掉 id；
 * 用户预设按 id 去重、按名字去重（重名自动加尾号）、总数上限 MAX_USER_PRESETS。
 */
export function mergePresetList(raw: unknown): Preset[] {
  const list = Array.isArray(raw) ? raw : []
  const out: Preset[] = [...BUILTIN_PRESETS]
  const usedIds = new Set(out.map((p) => p.id))
  const usedNames = new Set(out.map((p) => p.name))
  for (const item of list) {
    if (out.length - BUILTIN_PRESETS.length >= MAX_USER_PRESETS) break
    const p = normalizePreset(item)
    if (!p || p.builtin) continue
    let id = p.id
    if (usedIds.has(id)) id = `${id}-${usedIds.size}`
    let name = p.name
    let n = 2
    while (usedNames.has(name)) name = `${sanitizePresetName(p.name)} (${n++})`.slice(0, PRESET_NAME_MAX)
    const fixed = { ...p, id, name, builtin: false }
    out.push(fixed)
    usedIds.add(id)
    usedNames.add(fixed.name)
  }
  return out
}

/** 预设 → 目标帧率（倍率优先；倍率 0 用绝对值）。源帧率非法时返回 0。 */
export function targetFpsForPreset(p: Pick<Preset, 'multiplier' | 'customFps'>, srcFps: number): number {
  if (!(srcFps > 0)) return 0
  if (p.multiplier > 0) {
    const tf = Math.round(srcFps * p.multiplier)
    return tf <= MAX_FPS ? tf : 0
  }
  const tf = Math.round(p.customFps)
  return Number.isFinite(tf) && tf >= 5 && tf <= MAX_FPS ? tf : 0
}

/** 导出格式带 schema 版本号，便于以后演进而不靠猜 */
export function serializePresets(list: Preset[]): string {
  const payload = { kind: 'frameboost.presets', version: 1, presets: list.filter((p) => !p.builtin) }
  return JSON.stringify(payload, null, 2)
}

export interface PresetImportResult {
  presets: Preset[]
  rejected: number
  error?: string
}

/** 解析外部 JSON：接受 {presets:[...]} 或裸数组；坏项静默丢弃但计数，整份坏则给 error */
export function parsePresets(text: unknown): PresetImportResult {
  const raw = String(text ?? '')
  if (!raw.trim()) return { presets: [], rejected: 0, error: '文件是空的' }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { presets: [], rejected: 0, error: '不是合法的 JSON 文件' }
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as { presets?: unknown }).presets) ? (data as { presets: unknown[] }).presets : null
  if (!list) return { presets: [], rejected: 0, error: 'JSON 里找不到 presets 数组' }
  const presets: Preset[] = []
  let rejected = 0
  for (const item of list) {
    const p = normalizePreset(item)
    if (!p) {
      rejected++
      continue
    }
    presets.push({ ...p, builtin: false })
  }
  if (!presets.length) {
    return { presets: [], rejected, error: rejected ? `${rejected} 条预设字段都不合法，没有可导入项` : '文件里没有任何预设' }
  }
  return { presets, rejected }
}

// ---------------------------------------------------------------------------
// 历史任务（可回看、可重新入队）
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string
  fileName: string
  inputPath: string
  outputPath: string
  srcFps: number
  targetFps: number
  mode: Mode
  quality: Quality
  container: 'mp4' | 'mkv'
  encoder: string
  /** 成功时是产物真实 ffprobe 结果；失败时是归因结论 */
  ok: boolean
  error?: string
  errorSteps?: string[]
  sizeBytes?: number
  durationSec?: number
  elapsedSec?: number
  /** 真实峰值处理帧率（来自 ffmpeg progress），用于回看吞吐 */
  processFps?: number
  finishedAt: number
}

export const MAX_HISTORY = 200

/** 只保留有真实字段的历史项，并按完成时间倒序截断；坏项直接丢弃而不是猜 */
export function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: HistoryEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const inputPath = String(r.inputPath ?? '')
    const outputPath = String(r.outputPath ?? '')
    const finishedAt = Number(r.finishedAt)
    if (!inputPath || !outputPath || !Number.isFinite(finishedAt) || finishedAt <= 0) continue
    const mode = r.mode === 'high' || r.mode === 'fast' ? r.mode : 'balanced'
    const quality = r.quality === 'master' || r.quality === 'standard' ? r.quality : 'high'
    const entry: HistoryEntry = {
      id: /^[A-Za-z0-9._-]{1,80}$/.test(String(r.id ?? '')) ? String(r.id) : `h-${Math.round(finishedAt)}`,
      fileName: String(r.fileName ?? outputPath.split(/[\\/]/).pop() ?? outputPath),
      inputPath,
      outputPath,
      srcFps: Number(r.srcFps) > 0 ? Number(r.srcFps) : 0,
      targetFps: Number(r.targetFps) > 0 ? Math.round(Number(r.targetFps)) : 0,
      mode,
      quality,
      container: r.container === 'mkv' ? 'mkv' : 'mp4',
      encoder: String(r.encoder ?? ''),
      ok: r.ok === true,
      error: r.error ? String(r.error).slice(0, 500) : undefined,
      errorSteps: Array.isArray(r.errorSteps) ? (r.errorSteps as unknown[]).map(String).slice(0, 6) : undefined,
      sizeBytes: Number(r.sizeBytes) > 0 ? Number(r.sizeBytes) : undefined,
      durationSec: Number(r.durationSec) > 0 ? Number(r.durationSec) : undefined,
      elapsedSec: Number(r.elapsedSec) >= 0 ? Number(r.elapsedSec) : undefined,
      processFps: Number(r.processFps) > 0 ? Number(r.processFps) : undefined,
      finishedAt: Math.round(finishedAt)
    }
    out.push(entry)
  }
  return out.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, MAX_HISTORY)
}

export function buildArgs(p: RenderParams, info: ProbeResult, attempt: Attempt, tenBitCapable: boolean): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-i',
    p.inputPath,
    '-map',
    `0:v:${info.videoStreamIndex}`,
    '-map',
    '0:a:0?',
    '-vf',
    buildFilter(p, info, tenBitCapable),
    ...encoderArgs(attempt.nvenc, p.quality),
    '-c:a',
    attempt.audio
  ]
  if (attempt.audio === 'aac') args.push('-b:a', '192k')
  if (p.container === 'mkv' || p.copySubtitles) args.push('-map', '0:s?', '-c:s', 'copy')
  args.push('-map_metadata', '0')
  if (info.colorPrimaries && info.colorPrimaries !== 'unknown') args.push('-color_primaries', info.colorPrimaries)
  if (info.colorTrc && info.colorTrc !== 'unknown') args.push('-color_trc', info.colorTrc)
  if (info.colorSpace && info.colorSpace !== 'unknown') args.push('-colorspace', info.colorSpace)
  if (p.container === 'mp4') args.push('-movflags', '+faststart')
  args.push('-f', p.container === 'mp4' ? 'mov' : 'matroska', `${p.outputPath}.part`)
  return args
}

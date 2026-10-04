// 共享 ffmpeg / ffprobe 引擎：二进制解析、子进程执行、视频探测与硬件能力检测。
// 纯 Node 逻辑，不依赖 Electron —— electron/main.ts 与 agent/tools.mjs 复用同一份实现，
// 避免桌面应用与 Agent API 对同一能力各写两遍导致漂移。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  errorCodeOf,
  readTimeoutMs,
  type NvencLevel,
  type ProbeResult
} from './pipeline'

// 打包进 asar 时，二进制被解包到 app.asar.unpacked，路径需相应改写。
function asUnpacked(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

// require 在 CJS 编译产物（main.js / ffmpeg.js）里是原生的；从 ESM 动态 import 时
// Node 仍按 CJS 包装，require 可用。createRequire 仅作为极端 ESM 场景的兜底。
function req(id: string): { path?: string } {
  try {
    return require(id) as { path?: string }
  } catch {
    try {
      return createRequire(path.join(process.cwd(), 'noop.cjs'))(id) as { path?: string }
    } catch {
      return {}
    }
  }
}

function resolveBin(pkgName: string, envVar: string, fallback: string): string {
  const fromEnv = process.env[envVar]
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  try {
    const mod = req(pkgName)
    const p = asUnpacked(String(mod?.path ?? ''))
    if (p && fs.existsSync(p)) return p
  } catch {
    // 包不可用时回退到系统 PATH
  }
  return fallback
}

export const ffmpegPath = resolveBin('@ffmpeg-installer/ffmpeg', 'FFMPEG_PATH', 'ffmpeg')
export const ffprobePath = resolveBin('@ffprobe-installer/ffprobe', 'FFPROBE_PATH', 'ffprobe')

/** 截断长文本尾部，用于日志与错误信息展示 */
export function tail(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(-n) : s
}

/** 生效的探测时限（毫秒）：每次调用现读环境变量，非法值回默认而不是 0（0 = 不设限） */
export function probeTimeoutMs(): number {
  return readTimeoutMs(process.env.FRAMEBOOST_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS)
}

/** 生效的输出上限（字节）：FRAMEBOOST_PROBE_MAX_OUTPUT_MB 单位 MB */
export function probeMaxOutputBytes(): number {
  const mb = Number(process.env.FRAMEBOOST_PROBE_MAX_OUTPUT_MB)
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : DEFAULT_MAX_OUTPUT_BYTES
}

export interface RunBinOptions {
  /** stdout / stderr 各自的字节上限；超出即停止累积、强杀进程并如实回报 truncated */
  maxOutputBytes?: number
  /** 注入 spawn 便于测试用「永不退出的假二进制」验证闸门；默认 node:child_process 的 spawn */
  spawnFn?: typeof spawn
}

export interface RunBinResult {
  code: number
  stdout: string
  stderr: string
  /** 输出是否因超过上限被截断（调用方要如实报出来，不能把半截 JSON 当完整结果） */
  truncated: boolean
  /** 触发截断那一路累计的真实字节数 */
  truncatedBytes: number
  /** 是否因超时被强杀 */
  timedOut: boolean
  timeoutMs: number
}

/**
 * 运行一个二进制并收集 stdout/stderr。
 * 两道闸门都不可关（除了显式传 0）：
 *  - 超时：到点强杀并 reject「执行超时」，调用方再归因成中文；
 *  - 输出上限：超出即停止累积并强杀，结果里带 truncated/truncatedBytes 如实说明。
 * 一个病态文件把 ffprobe 拖住、或输出几小时不结束，都不该让上层一直等。
 */
export function runBin(
  bin: string,
  args: string[],
  timeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
  opts: RunBinOptions = {}
): Promise<RunBinResult> {
  const cap = opts.maxOutputBytes && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES
  const doSpawn = opts.spawnFn ?? spawn
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = doSpawn(bin, args, { windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }
    const out: Buffer[] = []
    const errChunks: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let truncatedBytes = 0
    let timedOut = false
    let settled = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            try {
              child.kill()
            } catch {
              /* ignore */
            }
            reject(new Error(`执行超时: ${bin}`))
          }, timeoutMs)
        : null
    const clear = () => {
      if (timer) clearTimeout(timer)
    }
    const collect = (buf: Buffer, isErr: boolean) => {
      if (isErr) {
        errBytes += buf.length
        if (errBytes <= cap) errChunks.push(buf)
        else truncated = true
      } else {
        outBytes += buf.length
        if (outBytes <= cap) out.push(buf)
        else truncated = true
      }
      if (truncated) {
        truncatedBytes = Math.max(truncatedBytes, outBytes, errBytes)
        // 输出已经超出上限：这条命令不可能给出可用结果（多半是病态文件），
        // 继续等只会变成"永远读不完"，直接强杀并把截断事实交回调用方。
        clear()
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }
    }
    child.stdout?.on('data', (d: Buffer) => collect(Buffer.isBuffer(d) ? d : Buffer.from(String(d)), false))
    child.stderr?.on('data', (d: Buffer) => collect(Buffer.isBuffer(d) ? d : Buffer.from(String(d)), true))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clear()
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clear()
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        truncated,
        truncatedBytes,
        timedOut,
        timeoutMs
      })
    })
  })
}

/** 带 node 风格 code 的引擎错误，供 pipeline.classifyFailure 归因出「下一步」 */
export class EngineError extends Error {
  code: string
  stderr?: string
  constructor(code: string, message: string, stderr?: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    if (stderr) this.stderr = stderr
  }
}

function rationalFps(v: string): number {
  const [numStr, denStr] = String(v ?? '').split('/')
  const den = Number(denStr)
  if (!den || den <= 0) return 0
  const val = Number(numStr) / den
  return val > 0 && val <= 480 ? val : 0
}

/**
 * 探测的可注入项。默认值全部来自环境变量与上面的常量，
 * 调用方（含测试）只在需要时才覆盖 —— 与 store.ts 的 deps 注入同一套做法。
 */
export interface ProbeVideoDeps {
  timeoutMs?: number
  maxOutputBytes?: number
  ffprobePath?: string
  spawnFn?: typeof spawn
}

/** 用 ffprobe 解析视频流与容器信息（选最大分辨率的非封面视频流） */
export async function probeVideo(inputPath: string, deps: ProbeVideoDeps = {}): Promise<ProbeResult> {
  if (!inputPath) throw new EngineError('BAD_INPUT', '未指定文件')
  if (!fs.existsSync(inputPath)) {
    throw new EngineError('ENOENT', `文件不存在：${inputPath}`)
  }
  const timeoutMs = deps.timeoutMs ?? probeTimeoutMs()
  const maxOutputBytes = deps.maxOutputBytes ?? probeMaxOutputBytes()
  const bin = deps.ffprobePath ?? ffprobePath
  let out: RunBinResult
  try {
    out = await runBin(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
      timeoutMs,
      { maxOutputBytes, spawnFn: deps.spawnFn }
    )
  } catch (err) {
    // 超时不是「起不动」，但同样必须在这里收口：一个病态文件可以让 ffprobe 永不退出，
    // 而调用方（含渲染完的回探与整条队列）在等一个永远不会来的终态。
    if (err instanceof Error && /执行超时/.test(err.message)) {
      throw new EngineError(
        'PROBE_TIMEOUT',
        `读取视频信息超时：ffprobe 在 ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`} 内没有回话，已强制结束`
      )
    }
    // 起不动 ffprobe 本身（缺二进制 / 路径过长）—— 带上原始 code 让上层归因
    throw new EngineError(errorCodeOf(err) ?? 'FFPROBE_SPAWN_FAILED', `无法运行 ffprobe：${err instanceof Error ? err.message : String(err)}`)
  }
  if (out.truncated) {
    throw new EngineError(
      'PROBE_OUTPUT_TOO_LARGE',
      `ffprobe 输出超过 ${Math.max(1, Math.round(maxOutputBytes / 1024 / 1024))}MB 上限已截断（实测 ${out.truncatedBytes} 字节），不按半截结果继续`
    )
  }
  if (out.code !== 0) {
    const detail = tail(out.stderr.trim(), 400)
    // 把 ffprobe 的原话留在 message 里，classifyFailure 靠它区分「损坏」与「不是视频」
    throw new EngineError('PROBE_FAILED', `ffprobe 解析失败：${detail || '无输出，可能是空文件或扩展名与实际内容不符'}`, out.stderr)
  }
  let data: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
  try {
    data = JSON.parse(out.stdout)
  } catch {
    throw new EngineError('PROBE_FAILED', 'ffprobe 输出无法解析，文件可能被截断或不是视频')
  }
  const allStreams = data.streams ?? []
  const vids = allStreams.filter(
    (s) => s.codec_type === 'video' && !(s.disposition as Record<string, unknown> | undefined)?.attached_pic
  )
  if (vids.length === 0) throw new EngineError('NO_VIDEO_STREAM', '未找到视频流，请选择视频文件')
  const best = vids.reduce((a, b) =>
    Number(b.width ?? 0) * Number(b.height ?? 0) > Number(a.width ?? 0) * Number(a.height ?? 0) ? b : a
  )
  const audio = allStreams.find((s) => s.codec_type === 'audio')
  const format = data.format ?? {}
  return {
    path: inputPath,
    fileName: path.basename(inputPath),
    sizeBytes: Number(format.size ?? 0),
    durationSec: Number(format.duration ?? best.duration ?? 0),
    width: Number(best.width ?? 0),
    height: Number(best.height ?? 0),
    // r_frame_rate 可能按 timebase 误报（如 90000/1），异常时回退 avg_frame_rate
    fps: rationalFps(String(best.r_frame_rate ?? '')),
    avgFps: rationalFps(String(best.avg_frame_rate ?? '')),
    fpsRational: String(best.r_frame_rate ?? ''),
    pixFmt: String(best.pix_fmt ?? ''),
    videoCodec: String(best.codec_name ?? ''),
    videoStreamIndex: vids.indexOf(best),
    colorPrimaries: String(best.color_primaries ?? ''),
    colorTrc: String(best.color_trc ?? ''),
    colorSpace: String(best.colorspace ?? ''),
    hasAudio: !!audio,
    audioCodec: audio ? String(audio.codec_name ?? '') : ''
  }
}

/**
 * 输出目录可写性实测：真建一个临时文件再删掉，比 fs.access 可靠
 * （access 在部分 Windows ACL 配置下会「说能写、实际写不了」）。
 */
export function checkDirWritable(dir: string): { ok: boolean; code?: string; error?: string } {
  if (!dir) return { ok: false, code: 'BAD_INPUT', error: '未指定输出目录' }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, code: errorCodeOf(err) ?? 'MKDIR_FAILED', error: err instanceof Error ? err.message : String(err) }
  }
  const probe = path.join(dir, `.frameboost-write-check-${process.pid}.tmp`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return { ok: true }
  } catch (err) {
    try {
      fs.rmSync(probe, { force: true })
    } catch {
      /* ignore */
    }
    return { ok: false, code: errorCodeOf(err) ?? 'WRITE_FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 目录所在卷的可用字节数；取不到返回 null（预检降级为「不拦但如实说明」）。
 * 注意：Windows 上 libuv 直接回传 statfs 原始字段（frsize/bavail/bfree），
 * 不是 POSIX 文档里那套名字，所以这里按实际形状逐个试。
 */
export function freeBytesFor(dir: string): number | null {
  type Stat = { bsize?: number; frsize?: number; blocks?: number; bfree?: number; bavail?: number }
  const fsx = fs as unknown as { statfsSync?: (p: string) => Stat }
  const statfs = fsx.statfsSync
  if (typeof statfs !== 'function') return null
  try {
    let cur = dir
    // 目录可能还不存在：往上找到存在的祖先再量，量的是同一个卷
    while (cur && !fs.existsSync(cur)) {
      const up = path.dirname(cur)
      if (up === cur) break
      cur = up
    }
    const s = statfs(cur || dir)
    const unit = Number(s.frsize ?? s.bsize ?? 0)
    const avail = Number(s.bavail ?? s.bfree ?? 0)
    if (!(unit > 0) || !(avail >= 0)) return null
    const bytes = unit * avail
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null
  } catch {
    return null
  }
}

/** 输入文件可读性实测 */
export function checkReadable(file: string): { ok: boolean; code?: string; error?: string } {
  try {
    fs.accessSync(file, fs.constants.R_OK)
    const st = fs.statSync(file)
    if (st.isDirectory()) return { ok: false, code: 'EISDIR', error: '选中的是文件夹，请选择视频文件' }
    if (st.size === 0) return { ok: false, code: 'EMPTY_FILE', error: '文件大小为 0，可能是下载未完成或已被删除' }
    return { ok: true }
  } catch (err) {
    return { ok: false, code: errorCodeOf(err) ?? 'READ_FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}

/** 二进制是否真的在位（裸名走 PATH 时返回 unknown，交给 spawn 判定） */
export function binStatus(bin: string): { exists: boolean; absolute: boolean } {
  const absolute = path.isAbsolute(bin)
  return { exists: !absolute || fs.existsSync(bin), absolute }
}

let nvencCache: NvencLevel | null = null

/** 检测 NVIDIA NVENC 能力：modern(p5) / legacy(llhq) / none，带进程内缓存 */
export async function detectNvenc(): Promise<NvencLevel> {
  if (nvencCache) return nvencCache
  const base = ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.5', '-frames:v', '15']
  try {
    const modern = await runBin(ffmpegPath, [...base, '-c:v', 'h264_nvenc', '-preset', 'p5', '-f', 'null', '-'], 20000)
    if (modern.code === 0) {
      nvencCache = 'modern'
      return nvencCache
    }
  } catch {
    /* 继续尝试旧版 */
  }
  try {
    const legacy = await runBin(ffmpegPath, [...base, '-c:v', 'h264_nvenc', '-preset', 'llhq', '-f', 'null', '-'], 20000)
    if (legacy.code === 0) {
      nvencCache = 'legacy'
      return nvencCache
    }
  } catch {
    /* 无硬件加速 */
  }
  nvencCache = 'none'
  return nvencCache
}

let tenBitCache: boolean | null = null

/** 检测内置 libx264 是否支持 10bit 输出（影响 pix_fmt 与是否走 NVENC） */
export async function detectTenBit(): Promise<boolean> {
  if (tenBitCache !== null) return tenBitCache
  try {
    const r = await runBin(
      ffmpegPath,
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.2', '-frames:v', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-f', 'null', '-'],
      15000
    )
    tenBitCache = r.code === 0
  } catch {
    tenBitCache = false
  }
  return tenBitCache
}

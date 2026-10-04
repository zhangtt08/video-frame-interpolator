import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  applyProgressLine,
  attachProcessDeadline,
  buildArgs,
  classifyFailure,
  createProgressState,
  encoderLabel,
  etaSeconds,
  errorCodeOf,
  mergePresetList,
  normalizeHistory,
  normalizePreset,
  parsePresets,
  percentFor,
  planAttempts,
  readTimeoutMs,
  serializePresets,
  stageLabel,
  stalledReasonText,
  DEFAULT_JOB_TIMEOUT_MS,
  MAX_USER_PRESETS,
  type Attempt,
  type FailureInfo,
  type HistoryEntry,
  type NvencLevel,
  type ProcessDeadline,
  type ProbeResult,
  type RenderParams,
  type RenderStage
} from './pipeline'
import { createAgentApiServer, DEFAULT_API_PORT, type RenderStateSnapshot } from './agent-api'
import { makeJsonStore, writeFailureReason, type JsonStore } from './store'
import {
  addToPolicy,
  checkInputAllowed,
  emptyPolicy,
  enforcePathPolicy,
  normalizeRenderParams,
  pixelFormatNotice,
  planOutputPath,
  policyFromEnv,
  preflightRenderPlan,
  saneFpsOf,
  validateRenderRequest,
  type PathPolicy
} from './render-defaults'
import { allowedUrlPrefixesFor, checkIpcSender, type IpcEventLike, type SenderPolicy } from './ipc-auth'
import { listenLocal, localApiToken } from './local-guard'
import {
  binStatus,
  checkDirWritable,
  checkReadable,
  detectNvenc,
  detectTenBit,
  ffmpegPath,
  ffprobePath,
  freeBytesFor,
  probeVideo,
  probeTimeoutMs,
  runBin,
  tail
} from './ffmpeg'

interface Job {
  proc: ReturnType<typeof spawn>
  params: RenderParams
  info: ProbeResult
  attempts: Attempt[]
  attemptIndex: number
  cancelled: boolean
  stage: RenderStage
  durationSec: number
  totalFrames: number
  progress: ReturnType<typeof createProgressState>
  stderrTail: string
  stdoutRest: string
  lastSendAt: number
  startedAt: number
  command: string
  encoder: string
  /** 单条任务的总时限闸门；进程在时限内退出就自动取消，卡死则由它判死 */
  deadline: ProcessDeadline | null
  deadlineFired: boolean
}

let mainWindow: BrowserWindow | null = null
let job: Job | null = null
let lastCommand = ''
let quitting = false

// ---------- 路径授权：只有用户做过 gesture 的位置才准读、才准写 ----------

const pathPolicy: PathPolicy = policyFromEnv(emptyPolicy())

/** 用户在界面里打开过一个文件（对话框 / 拖拽）：登记它，并顺带允许写到它所在目录 */
function registerOpenedFile(p: string): void {
  if (!p) return
  addToPolicy(pathPolicy, 'openedFiles', p)
  addToPolicy(pathPolicy, 'writableRoots', path.dirname(p))
}

/** 用户挑过一个目录（输出目录 / 保存位置的父目录）：它就是本次会话的工作目录 */
function registerWritableRoot(dir: string): void {
  addToPolicy(pathPolicy, 'writableRoots', dir)
}

function inputIsAllowed(p: string): boolean {
  try {
    return checkInputAllowed(p, pathPolicy).ok
  } catch {
    // 归属判定本身出错（路径畸形、realpath 失败）时按"不许"处理：这里必须 fail closed
    return false
  }
}

// ---------- 应用内 REST（8393）的真实状态：绝不静默失败 ----------

export interface ApiBindState {
  ok: boolean
  port: number
  url: string
  error: string
  /** 令牌是否已配置（配了才要求非 GET 带令牌） */
  tokenRequired: boolean
  since: number
}

const apiState: ApiBindState = {
  ok: false,
  port: Number(process.env.FRAMEBOOST_API_PORT) || DEFAULT_API_PORT,
  url: '',
  error: '',
  tokenRequired: false,
  since: 0
}

// 本机持久化：预设与历史。存 userData，不塞进渲染层 localStorage ——
// 这样导出/导入拿到的是真文件，Agent 侧将来要读同一份也不需要第二套存储。
let presetStore: JsonStore<unknown> | null = null
let historyStore: JsonStore<unknown> | null = null

// Agent API 用的最近一次渲染结果快照（render:done / render:error 时更新）
const lastRenderState: RenderStateSnapshot = { done: false, ok: false, result: null, error: null }

// ---------- 窗口事件广播 ----------

function sendToWindow(channel: string, payload: unknown): void {
  if (channel === 'render:done') {
    lastRenderState.done = true
    lastRenderState.ok = true
    lastRenderState.result = payload as Record<string, unknown>
    lastRenderState.error = null
  } else if (channel === 'render:error') {
    lastRenderState.done = true
    lastRenderState.ok = false
    lastRenderState.result = null
    lastRenderState.error = String((payload as { message?: unknown })?.message ?? '')
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function failPayload(info: FailureInfo, log = ''): { message: string; title: string; steps: string[]; log: string } {
  return { message: info.title, title: info.title, steps: info.steps, log: log || info.detail }
}

/**
 * 把应用内 REST 的真实状态推给界面。
 * 绑定失败以前是 `apiServer.on('error', () => {})` —— 一个什么都不说的 no-op，
 * 用户与 Agent 都以为接口在。现在：状态有记录、有广播、有中文出路。
 */
function broadcastApiState(): void {
  sendToWindow('api:state', { ...apiState, workspaceRoots: [...pathPolicy.writableRoots] })
}

// ---------- 任务执行 ----------

function setStage(j: Job, stage: RenderStage): void {
  j.stage = stage
  sendToWindow('render:stage', { stage, label: stageLabel(stage), encoder: j.encoder })
}

/** 统一的进度播报：百分比只来自 ffmpeg 自己报的 out_time，剩余只来自 ffmpeg 的 speed */
function sendProgress(force?: number): void {
  const j = job
  if (!j) return
  const percent = force ?? percentFor(j.progress, j.durationSec, true)
  sendToWindow('render:progress', {
    percent,
    stage: j.stage,
    stageLabel: stageLabel(j.stage),
    outTimeSec: j.progress.outTimeSec,
    fps: j.progress.fps,
    speed: j.progress.speed,
    frame: j.progress.frame,
    totalFrames: j.totalFrames,
    etaSec: etaSeconds(j.progress, j.durationSec),
    elapsedSec: Math.round((Date.now() - j.startedAt) / 1000)
  })
}

function handleProgressLine(line: string): void {
  const j = job
  if (!j) return
  if (!applyProgressLine(j.progress, line)) return
  if (j.progress.endSeen) {
    sendProgress(100)
    return
  }
  const now = Date.now()
  if (now - j.lastSendAt >= 250) {
    j.lastSendAt = now
    sendProgress()
  }
}

async function cleanupPart(out: string): Promise<void> {
  try {
    await fs.promises.rm(`${out}.part`, { force: true })
  } catch {
    /* ignore */
  }
}

function recordHistory(j: Job, ok: boolean, extra?: { sizeBytes?: number; fps?: number; durationSec?: number; failure?: FailureInfo }): void {
  if (!historyStore) return
  const entry: HistoryEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    fileName: j.info.fileName,
    inputPath: j.params.inputPath,
    outputPath: j.params.outputPath,
    srcFps: Math.round((saneFps(j.info) ?? 0) * 100) / 100,
    targetFps: j.params.targetFps,
    mode: j.params.mode,
    quality: j.params.quality,
    container: j.params.container,
    encoder: j.encoder,
    ok,
    error: extra?.failure ? extra.failure.title : undefined,
    errorSteps: extra?.failure ? extra.failure.steps : undefined,
    sizeBytes: extra?.sizeBytes,
    durationSec: extra?.durationSec,
    elapsedSec: Math.round((Date.now() - j.startedAt) / 1000),
    processFps: j.progress.fps > 0 ? Math.round(j.progress.fps * 100) / 100 : undefined,
    finishedAt: Date.now()
  }
  try {
    historyStore.save([entry, ...normalizeHistory(historyStore.load().data)])
  } catch (err) {
    console.log('[frameboost] 历史写入失败：', writeFailureReason(err))
  }
}

function saneFps(info: ProbeResult): number | null {
  return saneFpsOf(info)
}

function spawnAttempt(p: RenderParams, info: ProbeResult, attempts: Attempt[], index: number, tenBitCapable: boolean): void {
  const attempt = attempts[index]
  const args = buildArgs(p, info, attempt, tenBitCapable)
  lastCommand =
    'ffmpeg ' +
    args
      .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      .join(' ')
  console.log('[frameboost]', lastCommand)
  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn(ffmpegPath, args, { windowsHide: true })
  } catch (err) {
    const f = classifyFailure({ stage: 'encode', message: err instanceof Error ? err.message : String(err) })
    sendToWindow('render:error', failPayload(f))
    return
  }
  job = {
    proc,
    params: p,
    info,
    attempts,
    attemptIndex: index,
    cancelled: false,
    stage: index === 0 ? 'encode' : 'retry',
    durationSec: info.durationSec,
    totalFrames: Math.max(1, Math.round(info.durationSec * p.targetFps)),
    progress: createProgressState(),
    stderrTail: '',
    stdoutRest: '',
    lastSendAt: 0,
    startedAt: Date.now(),
    command: lastCommand,
    encoder: encoderLabel(attempt.nvenc),
    deadline: null,
    deadlineFired: false
  }
  setStage(job, job.stage)

  // 总时限闸门：ffmpeg 卡住不回话（既不报错也不退出）时，由它杀进程并把这一条判失败。
  // 没有这道闸门，close 永不触发 → render:done/error 永不发 → 队列在等一个不会来的终态。
  const jobTimeoutMs = readTimeoutMs(process.env.FRAMEBOOST_JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS)
  job.deadline = attachProcessDeadline(proc, jobTimeoutMs, () => {
    const j = job
    if (!j || j.proc !== proc) return
    j.deadlineFired = true
    j.cancelled = true
    const f = classifyFailure({
      stage: 'encode',
      code: 'RENDER_TIMEOUT',
      message: stalledReasonText(jobTimeoutMs)
    })
    sendToWindow('render:notice', { message: f.title })
    try {
      proc.kill()
    } catch {
      /* 已退 */
    }
  })

  proc.stdout?.on('data', (d: Buffer) => {
    const j = job
    if (!j) return
    j.stdoutRest += d.toString()
    let nl: number
    while ((nl = j.stdoutRest.indexOf('\n')) >= 0) {
      const line = j.stdoutRest.slice(0, nl).trim()
      j.stdoutRest = j.stdoutRest.slice(nl + 1)
      if (line) handleProgressLine(line)
    }
  })

  proc.stderr?.on('data', (d: Buffer) => {
    const j = job
    if (j) j.stderrTail = (j.stderrTail + d.toString()).slice(-8000)
  })

  proc.on('error', (err) => {
    const j = job
    j?.deadline?.cancel()
    const f = classifyFailure({
      stage: 'encode',
      code: (err as NodeJS.ErrnoException).code ?? 'FFMPEG_SPAWN_FAILED',
      message: err.message
    })
    sendToWindow('render:error', failPayload(f, f.detail || `无法启动 ffmpeg：${err.message}`))
    if (j) recordHistory(j, false, { failure: f })
    job = null
  })

  proc.on('close', (code) => {
    const j = job
    if (!j || j.proc !== proc) return
    // 时限到点已经把它判死了：这条必须以「卡住」收口，不能落进下面的取消分支（那是用户动作），
    // 也不能当成普通失败去起下一条回退尝试（回退解决不了卡死）。
    if (j.deadlineFired) {
      const f = classifyFailure({
        stage: 'encode',
        code: 'RENDER_TIMEOUT',
        message: stalledReasonText(j.deadline?.ms ?? DEFAULT_JOB_TIMEOUT_MS)
      })
      void cleanupPart(p.outputPath)
      sendToWindow('render:error', failPayload(f, tail(j.stderrTail.trim(), 1600)))
      recordHistory(j, false, { failure: f })
      job = null
      return
    }
    if (j.cancelled) {
      void cleanupPart(p.outputPath).then(() => sendToWindow('render:cancelled', {}))
      recordHistory(j, false, { failure: { title: '已取消', detail: '', steps: ['该条可在队列里单独重试'] } })
      job = null
      return
    }
    if (code === 0) {
      setStage(j, 'finalize')
      fs.rename(`${p.outputPath}.part`, p.outputPath, (err) => {
        if (err) {
          const f = classifyFailure({
            stage: 'finalize',
            code: (err as NodeJS.ErrnoException).code,
            message: `输出文件保存失败：${err.message}`,
            detailPath: p.outputPath
          })
          sendToWindow('render:error', failPayload(f, String(err.message)))
          void cleanupPart(p.outputPath)
          recordHistory(j, false, { failure: f })
          job = null
          return
        }
        const jj = job
        if (jj) setStage(jj, 'reprobe')
        // 回探输出信息，供完成面板展示（真实 ffprobe，不是猜的）
        probeVideo(p.outputPath)
          .then((outInfo) => {
            const done = {
              outputPath: p.outputPath,
              sizeBytes: outInfo.sizeBytes,
              fps: outInfo.fps > 0 ? outInfo.fps : outInfo.avgFps,
              durationSec: outInfo.durationSec,
              encoder: j.encoder,
              elapsedSec: Math.round((Date.now() - j.startedAt) / 1000),
              processFps: j.progress.fps > 0 ? j.progress.fps : undefined
            }
            if (outInfo.fps > 0 && Math.abs(outInfo.fps - p.targetFps) > Math.max(1, p.targetFps * 0.05)) {
              sendToWindow('render:notice', {
                message: `产物实际帧率 ${Math.round(outInfo.fps * 100) / 100} fps 与目标 ${p.targetFps} fps 有差异，已如实回探`
              })
            }
            sendToWindow('render:done', done)
            recordHistory(j, true, { sizeBytes: outInfo.sizeBytes, fps: done.fps, durationSec: outInfo.durationSec })
          })
          .catch(() => {
            sendToWindow('render:done', { outputPath: p.outputPath, encoder: j.encoder })
            recordHistory(j, true)
          })
          .finally(() => {
            job = null
          })
      })
      return
    }
    if (index + 1 < attempts.length) {
      const next = attempts[index + 1]
      const reason =
        attempt.nvenc !== 'none' && next.nvenc === 'none'
          ? '硬件加速不可用，已自动回退到 CPU 编码'
          : '音频无损直写失败，已改为重编码 AAC 后重试'
      sendToWindow('render:retry', { reason, encoderLabel: encoderLabel(next.nvenc) })
      spawnAttempt(p, info, attempts, index + 1, tenBitCapable)
      return
    }
    const f = classifyFailure({
      stage: 'encode',
      message: 'ffmpeg 处理失败',
      stderr: j.stderrTail.trim()
    })
    void cleanupPart(p.outputPath)
    sendToWindow('render:error', failPayload(f, tail(j.stderrTail.trim(), 1600)))
    recordHistory(j, false, { failure: f })
    job = null
  })
}

/**
 * 入参收敛 = 共享的默认值与校验（render-defaults）+ 这一侧独有的路径归属判定。
 * Agent 与 REST 走的是同一个函数，所以"界面能过、接口也能过；界面不能过、接口也不能过"。
 */
function sanitizeParams(raw: unknown): RenderParams {
  return validateRenderRequest(raw, pathPolicy)
}

// ---------- 启动前预检：把「跑了一半才失败」提前成一句可执行的话 ----------

export interface RenderResult {
  ok: boolean
  command?: string
  encoderLabel?: string
  outputPath?: string
  error?: string
  title?: string
  steps?: string[]
  [k: string]: unknown
}

const preflightDeps = {
  checkReadable,
  probeVideo: (file: string) => probeVideo(file),
  checkDirWritable,
  freeBytesFor
}

/** 预检序列只有一份实现（render-defaults），桌面与 Agent 都调它 */
function preflight(p: RenderParams): ReturnType<typeof preflightRenderPlan> {
  setStageSignal('probe')
  return preflightRenderPlan(p, preflightDeps)
}

async function startRender(raw: unknown): Promise<RenderResult> {
  try {
    if (job) {
      return {
        ok: false,
        error: '已有任务在跑',
        title: '已有任务在跑',
        steps: ['等当前任务结束，或在进度区点「取消当前这一条」', 'FrameBoost 一次只跑一条，避免互相抢 CPU 让全部变慢']
      }
    }
    const p0 = sanitizeParams(raw)
    const plan = await preflight(p0)
    const info = plan.info
    setStageSignal('preflight')

    const tenBitCapable = await detectTenBit()
    let nvencLevel: NvencLevel = 'none'
    if (p0.useNvenc) nvencLevel = await detectNvenc()
    const { eff, notices: capNotices } = pixelFormatNotice(p0, info, tenBitCapable, nvencLevel)
    const notices = [...plan.notices, ...capNotices]
    const attempts = planAttempts(p0, nvencLevel, !eff.downgraded)
    // 重名输出自动加后缀，避免覆盖；改完名字要再过一次归属判定（后缀只在同一目录里加，正常仍在界内）
    const outputPath = planOutputPath(p0.outputPath)
    enforcePathPolicy({ ...p0, outputPath }, pathPolicy)
    const p: RenderParams = { ...p0, outputPath }
    for (const message of notices) sendToWindow('render:notice', { message })

    lastRenderState.done = false
    lastRenderState.ok = false
    lastRenderState.result = null
    lastRenderState.error = null
    lastCommand = ''
    spawnAttempt(p, info, attempts, 0, tenBitCapable)
    if (!job) {
      const f = classifyFailure({ code: 'FFMPEG_SPAWN_FAILED', message: 'ffmpeg 进程未能启动' })
      return { ok: false, error: f.title, title: f.title, steps: f.steps }
    }
    return {
      ok: true,
      command: lastCommand,
      encoderLabel: encoderLabel(attempts[0].nvenc),
      outputPath: p.outputPath,
      targetFps: p.targetFps,
      srcFps: saneFps(info) ?? undefined,
      notice: notices.join('；') || undefined
    }
  } catch (err) {
    const f = classifyFailure({ code: errorCodeOf(err), message: err instanceof Error ? err.message : String(err) })
    sendToWindow('render:error', failPayload(f, f.detail))
    return { ok: false, error: f.title, title: f.title, steps: f.steps, log: f.detail }
  }
}

/** 预检阶段的进度信号（此时还没有 Job，直接广播） */
function setStageSignal(stage: RenderStage): void {
  sendToWindow('render:stage', { stage, label: stageLabel(stage), encoder: '' })
}

// ---------- IPC ----------

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', '3gp', 'vob', 'ogv', 'm2ts']

/** 只有这一个窗口是可信发送方；生产页面在应用目录里，dev 页面在 vite 的地址上 */
function senderPolicy(): SenderPolicy {
  return {
    trustedIds: mainWindow && !mainWindow.isDestroyed() ? [mainWindow.webContents.id] : [],
    allowedUrlPrefixes: allowedUrlPrefixesFor({
      appDir: path.join(__dirname, '../dist-renderer'),
      devUrl: process.env.ELECTRON_RENDERER_URL ?? null
    })
  }
}

/**
 * 所有 IPC 入口都从这里过：先验发送方，再执行 handler。
 * 校验不过就抛错（渲染层拿到一条被拒绝的 invoke），绝不"记个日志照办"。
 */
function registerHandler(channel: string, fn: (event: IpcEventLike, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    const verdict = checkIpcSender(event as unknown as IpcEventLike, senderPolicy())
    if (!verdict.ok) {
      console.log(`[frameboost-ipc] 拒绝 ${channel}：${verdict.message}`)
      throw new Error(verdict.message ?? 'IPC 调用未通过发送方校验')
    }
    return fn(event as unknown as IpcEventLike, ...args)
  })
}

async function readVersion(bin: string, label: string): Promise<string> {
  try {
    const r = await runBin(bin, ['-version'], 8000)
    const first = (r.stdout.split('\n')[0] ?? '').trim()
    return first.replace(new RegExp(`^${label} version `, 'i'), '').split(' ')[0] ?? ''
  } catch {
    return ''
  }
}

/** 界面「为什么灰掉」这句话的根据 —— 全部来自真实检测，不写死 */
function nvencReasonText(level: NvencLevel, tenBitCapable: boolean): string {
  if (level === 'modern') return '检测到可用的 NVENC（现代驱动，preset p6）'
  if (level === 'legacy') return '检测到可用的 NVENC（旧驱动，preset llhq）'
  return '本机没有可用的 NVIDIA NVENC：可能是无 N 卡、驱动过旧或被系统策略限制。硬件加速已不可选，将使用 CPU（libx264）'
    + (tenBitCapable ? '' : '；注意本机 x264 也不支持 10bit 输出')
}

function safeUserData(): string {
  try {
    return app.getPath('userData')
  } catch {
    return ''
  }
}

function safeDocuments(): string {
  try {
    return app.getPath('documents')
  } catch {
    return safeUserData()
  }
}

function initStores(): void {
  const dir = safeUserData()
  if (!dir) return
  presetStore = makeJsonStore<unknown>(path.join(dir, 'frameboost-presets.json'), [])
  historyStore = makeJsonStore<unknown>(path.join(dir, 'frameboost-history.json'), [])
}

function registerIpc(): void {
  registerHandler('video:probe', async (_e, rawPath: unknown) => {
    try {
      return { ok: true, info: await probeVideo(String(rawPath ?? '')) }
    } catch (err) {
      const f = classifyFailure({ stage: 'probe', code: errorCodeOf(err), message: err instanceof Error ? err.message : String(err) })
      return { ok: false, error: f.title, steps: f.steps, log: f.detail }
    }
  })

  registerHandler('render:start', async (_e, raw: unknown) => {
    return startRender(raw)
  })

  registerHandler('render:cancel', () => {
    const j = job
    if (!j) return { ok: false }
    j.cancelled = true
    // 用户主动取消：时限闸门要撤掉，否则它会在 close 迟到时把这条改写成"卡住失败"
    j.deadline?.cancel()
    setStageSignal('cancelled')
    try {
      j.proc.kill()
    } catch {
      /* ignore */
    }
    // kill 之后立刻扫一遍 .part：进程若已退出但 close 迟到，也不会留半成品
    void cleanupPart(j.params.outputPath)
    return { ok: true }
  })

  registerHandler('dialog:open-video', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频文件', extensions: VIDEO_EXTS }]
    })
    const paths = r.canceled ? [] : r.filePaths
    // 用户亲手挑的文件 = 授权起点：登记它，也登记它所在目录（默认输出就在旁边）
    for (const p of paths) registerOpenedFile(p)
    broadcastApiState()
    return paths
  })

  // 拖拽进来的路径由渲染层取到真实文件位置后显式登记一次：
  // 这是"用户把它放进了队列"的服务端凭据，REST / Agent 没有这一步就过不去归属判定。
  registerHandler('files:register', (_e, rawPaths: unknown) => {
    const list = Array.isArray(rawPaths) ? rawPaths.map((p) => String(p ?? '')) : [String(rawPaths ?? '')]
    const accepted: string[] = []
    for (const p of list) {
      if (!p) continue
      if (!fs.existsSync(p)) continue
      const stat = fs.statSync(p)
      if (!stat.isFile()) continue
      if (!/\.(mp4|mkv|mov|avi|webm|flv|ts|m4v|mpg|mpeg|wmv|3gp|vob|ogv|m2ts)$/i.test(p)) {
        continue
      }
      registerOpenedFile(p)
      accepted.push(p)
    }
    broadcastApiState()
    return { ok: true, registered: accepted.length, workspaceRoots: pathPolicy.writableRoots.length }
  })

  registerHandler('dialog:save-output', async (_e, defaultPath: unknown) => {
    const r = await dialog.showSaveDialog({
      defaultPath: String(defaultPath ?? 'output.mp4'),
      filters: [{ name: '视频文件', extensions: ['mp4', 'mkv'] }]
    })
    if (r.canceled) return null
    const filePath = r.filePath ?? null
    if (filePath) {
      registerWritableRoot(path.dirname(filePath))
      broadcastApiState()
    }
    return filePath
  })

  registerHandler('dialog:pick-dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled) return null
    const dir = r.filePaths[0] ?? null
    if (dir) {
      registerWritableRoot(dir)
      broadcastApiState()
    }
    return dir
  })

  registerHandler('shell:show-in-folder', (_e, p: unknown) => {
    const s = String(p ?? '')
    if (!s) return false
    if (fs.existsSync(s)) {
      shell.showItemInFolder(s)
      return true
    }
    // 文件已不在（被移动/删了）：退回打开它的父目录，比什么都不做好用
    const parent = path.dirname(s)
    if (fs.existsSync(parent)) {
      shell.openPath(parent)
      return true
    }
    return false
  })

  registerHandler('app:meta', async () => {
    const [ffmpegVersion, ffprobeVersion, nvenc, tenBitCapable] = await Promise.all([
      readVersion(ffmpegPath, 'ffmpeg'),
      readVersion(ffprobePath, 'ffprobe'),
      detectNvenc(),
      detectTenBit()
    ])
    const ffb = binStatus(ffmpegPath)
    const prb = binStatus(ffprobePath)
    return {
      ffmpegPath,
      ffprobePath,
      ffmpegVersion,
      ffprobeVersion,
      nvenc,
      tenBitCapable,
      // 二进制缺失是「界面要灰掉选项」的根据，不是运行期才炸的惊喜
      binOk: ffb.exists && prb.exists,
      binProblem:
        !ffb.exists || !prb.exists
          ? '未找到自带的 ffmpeg/ffprobe 可执行文件，多半被杀毒软件隔离：请恢复隔离区或重新安装 FrameBoost'
          : undefined,
      nvencReason: nvencReasonText(nvenc, tenBitCapable),
      dataDir: safeUserData(),
      // 应用内 REST 的真实状态：起来了就报地址，没起来就把原因原样交出去（不再静默 no-op）
      api: { ...apiState },
      workspace: {
        roots: [...pathPolicy.writableRoots],
        openedFiles: pathPolicy.openedFiles.length,
        problem: pathPolicy.writableRoots.length === 0 ? '还没有选择输出目录，接口与队列都只接受用户挑过的目录之内的输出' : undefined
      },
      timeouts: {
        probeMs: probeTimeoutMs(),
        jobMs: readTimeoutMs(process.env.FRAMEBOOST_JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS)
      }
    }
  })

  registerHandler('api:status', () => ({ ...apiState, workspaceRoots: [...pathPolicy.writableRoots] }))

  // ---------- 预设：本机 JSON，可导出/导入 ----------

  registerHandler('presets:list', () => {
    const store = presetStore
    if (!store) return { ok: false, presets: mergePresetList([]), error: '配置存储尚未就绪' }
    const { data, broken, reason } = store.load()
    return {
      ok: true,
      presets: mergePresetList(data),
      broken,
      error: broken ? `预设文件读取失败（已按内置预设继续）：${reason}` : undefined
    }
  })

  registerHandler('presets:save', (_e, raw: unknown) => {
    const p = normalizePreset(raw)
    if (!p) return { ok: false, error: '预设字段不合法，未保存' }
    const store = presetStore
    if (!store) return { ok: false, error: '配置存储尚未就绪' }
    const all = mergePresetList(store.load().data).filter((x) => !x.builtin)
    const exists = all.findIndex((x) => x.id === p.id)
    const entry = { ...p, builtin: false }
    if (exists >= 0) all[exists] = entry
    else all.push(entry)
    if (all.length > MAX_USER_PRESETS) {
      return { ok: false, error: `自定义预设最多 ${MAX_USER_PRESETS} 条，请先删除不用的`, presets: mergePresetList(all.slice(0, MAX_USER_PRESETS)) }
    }
    try {
      store.save(all)
    } catch (err) {
      return { ok: false, error: writeFailureReason(err) }
    }
    return { ok: true, presets: mergePresetList(all) }
  })

  registerHandler('presets:remove', (_e, rawId: unknown) => {
    const store = presetStore
    if (!store) return { ok: false, error: '配置存储尚未就绪' }
    const id = String(rawId ?? '')
    const all = mergePresetList(store.load().data).filter((x) => !x.builtin && x.id !== id)
    try {
      store.save(all)
    } catch (err) {
      return { ok: false, error: writeFailureReason(err) }
    }
    return { ok: true, presets: mergePresetList(all) }
  })

  registerHandler('presets:export', async () => {
    const store = presetStore
    if (!store) return { ok: false, error: '配置存储尚未就绪' }
    const list = mergePresetList(store.load().data).filter((x) => !x.builtin)
    if (!list.length) return { ok: false, error: '当前没有自定义预设可导出（内置预设随软件分发，不需要导出）' }
    const r = await dialog.showSaveDialog({
      title: '导出预设',
      defaultPath: path.join(safeDocuments(), 'frameboost-预设.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(r.filePath, serializePresets(list), 'utf8')
    } catch (err) {
      return { ok: false, error: writeFailureReason(err) }
    }
    return { ok: true, path: r.filePath, count: list.length }
  })

  registerHandler('presets:import', async () => {
    const store = presetStore
    if (!store) return { ok: false, error: '配置存储尚未就绪' }
    const r = await dialog.showOpenDialog({
      title: '导入预设',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    const file = r.canceled ? null : (r.filePaths[0] ?? null)
    if (!file) return { ok: false, canceled: true }
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, error: `读不了这个文件：${err instanceof Error ? err.message : String(err)}` }
    }
    const parsed = parsePresets(text)
    if (parsed.error) return { ok: false, error: parsed.error, rejected: parsed.rejected }
    const existing = mergePresetList(store.load().data).filter((x) => !x.builtin)
    const merged = mergePresetList([...existing, ...parsed.presets])
    try {
      store.save(merged.filter((x) => !x.builtin))
    } catch (err) {
      return { ok: false, error: writeFailureReason(err) }
    }
    return {
      ok: true,
      presets: mergePresetList(merged.filter((x) => !x.builtin)),
      added: parsed.presets.length,
      rejected: parsed.rejected
    }
  })

  // ---------- 历史任务：可回看、可重新入队 ----------

  registerHandler('history:list', () => {
    const store = historyStore
    if (!store) return { ok: true, entries: [] as HistoryEntry[] }
    const { data, broken, reason } = store.load()
    return {
      ok: true,
      entries: normalizeHistory(data),
      broken,
      error: broken ? `历史文件读取失败（已按空历史继续）：${reason}` : undefined
    }
  })

  registerHandler('history:clear', () => {
    const store = historyStore
    if (!store) return { ok: false, error: '配置存储尚未就绪' }
    try {
      store.save([])
    } catch (err) {
      return { ok: false, error: writeFailureReason(err) }
    }
    return { ok: true, entries: [] as HistoryEntry[] }
  })

  // 自绘标题栏：窗口三键
  registerHandler('window:minimize', () => {
    mainWindow?.minimize()
  })

  registerHandler('window:toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
      return false
    }
    mainWindow.maximize()
    return true
  })

  registerHandler('window:close', () => {
    mainWindow?.close()
  })

  registerHandler('window:is-maximized', () => !!mainWindow?.isMaximized())
}

// ---------- 窗口与生命周期 ----------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0b0d13',
    autoHideMenuBar: true,
    title: 'FrameBoost · 视频补帧',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // preload 需要完整的 electron API（webUtils 解析拖拽文件路径）
      sandbox: false,
      spellcheck: false
    }
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // 自绘标题栏：向渲染层广播最大化状态变化
  const sendMaximized = (maximized: boolean) => mainWindow?.webContents.send('window:maximized', maximized)
  mainWindow.on('maximize', () => sendMaximized(true))
  mainWindow.on('unmaximize', () => sendMaximized(false))
  // 任务进行中关闭窗口需确认，防止误触丢任务
  mainWindow.on('close', (e) => {
    if (quitting || !job || !mainWindow) return
    e.preventDefault()
    void dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        title: '正在补帧',
        message: '补帧任务正在进行中，退出将取消当前任务。',
        buttons: ['继续等待（取消退出）', '退出并停止任务'],
        defaultId: 0,
        cancelId: 0
      })
      .then((r) => {
        if (r.response === 1) {
          quitting = true
          const j = job
          if (j) {
            j.cancelled = true
            void cleanupPart(j.params.outputPath)
          }
          try {
            job?.proc.kill()
          } catch {
            /* ignore */
          }
          mainWindow?.close()
        }
      })
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  mainWindow.webContents.on('console-message', (...args: unknown[]) => {
    const ev = args[0] as Record<string, unknown> | undefined
    const msg = ev && typeof ev === 'object' && 'message' in ev ? String(ev.message) : String(args[2] ?? '')
    const level = ev && typeof ev === 'object' && 'level' in ev ? ev.level : args[1]
    if (level === 3 || level === 'error') console.log('[renderer-error]', msg)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist-renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    initStores()
    registerIpc()
    createWindow()
    console.log('[frameboost] main ready, ffmpeg =', ffmpegPath)
    // 应用内 REST：复用应用内 probe/render 流程。
    // 绑不上就如实报（状态进 apiState → 广播给界面 + app:meta + api:status），
    // 绝不再写 `on('error', () => {})` —— 那等于让所有人都以为接口在。
    try {
      const apiServer = createAgentApiServer({
        version: app.getVersion(),
        port: apiState.port,
        token: localApiToken(),
        canProbeInput: inputIsAllowed,
        startRender,
        getJobSummary: () => {
          const j = job
          if (!j) return { running: false, stage: 'queued', percent: 0 }
          return {
            running: true,
            outputPath: j.params.outputPath,
            inputPath: j.params.inputPath,
            targetFps: j.params.targetFps,
            stage: j.stage,
            encoder: j.encoder,
            frame: j.progress.frame,
            totalFrames: j.totalFrames,
            fps: j.progress.fps,
            speed: j.progress.speed,
            outTimeSec: Math.round(j.progress.outTimeSec * 10) / 10,
            percent: Math.round(percentFor(j.progress, j.durationSec, true) * 10) / 10,
            etaSec: etaSeconds(j.progress, j.durationSec),
            elapsedSec: Math.round((Date.now() - j.startedAt) / 1000)
          }
        },
        probeVideo: (inputPath: string) => {
          if (!inputIsAllowed(inputPath)) {
            return Promise.reject(new Error('这份输入不是用户在界面里打开过的文件，也不在允许的读取目录内'))
          }
          return probeVideo(inputPath)
        },
        detectNvenc,
        lastRenderState
      })
      apiState.tokenRequired = !!localApiToken()
      // 绑定结果必须回到调用方手里：成功→地址，失败→中文原因。以前这里是 `on('error', () => {})`。
      void listenLocal(apiServer as unknown as Parameters<typeof listenLocal>[0], apiState.port, {
        host: '127.0.0.1',
        token: localApiToken()
      }).then((outcome) => {
        apiState.ok = outcome.ok
        apiState.error = outcome.error
        apiState.tokenRequired = outcome.tokenRequired
        apiState.url = outcome.url
        apiState.since = outcome.ok ? Date.now() : 0
        if (outcome.ok) console.log('[frameboost-agent-api] listening on ' + outcome.url)
        else console.error('[frameboost-agent-api] ' + outcome.error)
        broadcastApiState()
      })
    } catch (err) {
      apiState.ok = false
      apiState.error = `应用内接口初始化失败：${err instanceof Error ? err.message : String(err)}`
      console.error('[frameboost-agent-api]', apiState.error)
      broadcastApiState()
    }
  })
}

app.on('before-quit', () => {
  quitting = true
  const j = job
  if (j) {
    j.deadline?.cancel()
    // 先落 cancelled 再 kill：否则 close(code≠0) 会把它当成失败去起下一个回退尝试，
    // 表现就是「关了软件但 ffmpeg 又起来一次」，还会留下覆盖过的半成品。
    j.cancelled = true
    try {
      j.proc.kill()
    } catch {
      /* ignore */
    }
    void cleanupPart(j.params.outputPath)
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

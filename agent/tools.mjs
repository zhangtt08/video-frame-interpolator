#!/usr/bin/env node
// FrameBoost Agent tools — 项目唯一需要实现的文件（server.mjs / mcp-server.mjs 用标准模板）。
// 契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md
//
// 这些工具把 FrameBoost 的真实能力（本机 ffmpeg/ffprobe、NVENC/10bit 检测、补帧渲染）
// 封装为带 JSON Schema 的调用，全部复用桌面应用同一套编译产物：
//   - dist-electron/ffmpeg.js  ← electron/ffmpeg.ts（二进制解析、探测、硬件能力检测）
//   - dist-electron/pipeline.js ← electron/pipeline.ts（命令构建、回退策略、输出命名）
// 因此 Agent 侧与桌面应用侧对同一能力的实现完全一致，不存在第二套逻辑或写死数据。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { AgentError } from './server.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ---- 读取编译产物（与桌面应用共享）；缺失则给出可执行的出路，绝不返回假数据 ----
function loadCompiled() {
  try {
    const pipeline = require(path.join(ROOT, 'dist-electron', 'pipeline.js'))
    const ffmpeg = require(path.join(ROOT, 'dist-electron', 'ffmpeg.js'))
    const defaults = require(path.join(ROOT, 'dist-electron', 'render-defaults.js'))
    return { pipeline, ffmpeg, defaults }
  } catch (e) {
    throw new AgentError(
      'not_built',
      '缺少编译后的核心模块（dist-electron/pipeline.js、dist-electron/ffmpeg.js、dist-electron/render-defaults.js）。' +
        '请先在项目根运行 `npm run build`（agent:serve 已自动包含 build:electron）。原因：' +
        (e && e.message ? e.message : String(e))
    )
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VIDEO_EXTS = new Set([
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', '3gp', 'vob', 'ogv', 'm2ts'
])

// ---- 项目元信息（server.mjs 读取）----
export const project = {
  id: 'frameboost',
  name: pkg.name || 'frameboost',
  version: pkg.version || '0.0.0',
  summary: pkg.description || '本地视频补帧工具'
}
export const projectId = 'frameboost'

// ---------- 辅助函数 ----------

function isVideoFile(name) {
  const ext = path.extname(name).slice(1).toLowerCase()
  return VIDEO_EXTS.has(ext)
}

// 从目录里收集视频文件（可选递归、带上限），返回真实 stat。
function walkVideos(dir, recursive, limit) {
  const out = []
  let scanned = 0
  const stack = [dir]
  while (stack.length && out.length < limit) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        if (recursive && !ent.name.startsWith('.') && !/(node_modules|dist-|release|\.git)/i.test(ent.name)) {
          stack.push(full)
        }
        continue
      }
      if (!ent.isFile() || !isVideoFile(ent.name)) continue
      scanned++
      let st = { sizeBytes: 0, mtimeMs: 0 }
      try {
        const s = fs.statSync(full)
        st = { sizeBytes: s.size, mtimeMs: s.mtimeMs }
      } catch {
        /* ignore */
      }
      out.push({ name: ent.name, path: full, sizeBytes: st.sizeBytes, modifiedAt: new Date(st.mtimeMs).toISOString() })
      if (out.length >= limit) break
    }
  }
  return { items: out, truncated: out.length >= limit, scanned }
}

// 解析目标帧率：显式 targetFps 优先，否则按倍率 × 源帧率。
function resolveTargetFps(input, srcFps) {
  if (input.targetFps != null && input.targetFps !== '') {
    const tf = Math.round(Number(input.targetFps))
    if (!Number.isFinite(tf)) throw new AgentError('bad_input', 'targetFps 不是合法数字')
    return tf
  }
  const mult = Number(input.multiplier)
  if (Number.isFinite(mult) && mult > 1) return Math.round(srcFps * mult)
  throw new AgentError('bad_input', '必须提供 targetFps 或 multiplier（倍率 > 1）')
}

// 计算并规范化输出路径（与桌面应用命名习惯一致：原名_帧率fps.容器）。
// 桌面用的命名函数就是 pipeline.resolveOutputPath（经 render-defaults.planOutputPath 转出），不另写一套。
function planOutputFor(input, targetFps) {
  const explicit = String(input.outputPath || '').trim()
  if (explicit) {
    const m = /\.(mp4|mkv)$/i.exec(explicit)
    if (!m) throw new AgentError('bad_input', '输出文件必须是 .mp4 或 .mkv')
    return { outputPath: explicit, container: m[1].toLowerCase() }
  }
  const container = input.container === 'mkv' ? 'mkv' : 'mp4'
  const dir = path.dirname(String(input.inputPath))
  const base = path.basename(String(input.inputPath)).replace(/\.[^.]+$/, '')
  return { outputPath: path.join(dir, `${base}_${targetFps}fps.${container}`), container }
}

/**
 * Agent 进程的输出归属范围：输入文件所在目录 + 调用方显式指定的工作目录。
 * 这一条把"随便挑一个可写卷往里写"关在门外，又不改变工具默认的"输出放在输入旁边"。
 */
function agentPathPolicy(inputPath) {
  const { emptyPolicy, addToPolicy } = loadCompiledSafe().defaults
  const policy = emptyPolicy()
  if (inputPath) addToPolicy(policy, 'writableRoots', path.dirname(String(inputPath)))
  const envRoot = String(process.env.FRAMEBOOST_WORKSPACE_ROOT ?? '').trim()
  if (envRoot) addToPolicy(policy, 'writableRoots', envRoot)
  for (const r of String(process.env.FRAMEBOOST_INPUT_ROOTS ?? '').split(';')) {
    if (r.trim()) addToPolicy(policy, 'writableRoots', r.trim())
  }
  return policy
}

/** 共享校验函数抛出的带 code 错误 → 契约里的 AgentError，并把「下一步」拼进 message */
function badWithCode(e, pipeline) {
  const f = pipeline.classifyFailure({ code: e && e.code ? String(e.code) : null, message: e instanceof Error ? e.message : String(e) })
  return new AgentError('bad_input', `${f.title}：${f.detail || ''}｜下一步：${f.steps.slice(0, 2).join(' / ')}`)
}

// ---------- 任务管理（Agent 进程内的异步渲染作业）----------
const jobs = new Map()
let jobSeq = 0

function newJobId() {
  jobSeq += 1
  return `job-${Date.now().toString(36)}-${jobSeq}`
}

function fmtFps(v) {
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null
}

// server.mjs 是标准实现（不改），错误体只有 code/message 两个通道，
// 所以把「下一步」直接拼进 message，Agent 读到的仍然是一句能照着做的事。
function badWithSteps(f) {
  return new AgentError('bad_input', `${f.title}：${f.detail || ''}｜下一步：${f.steps.slice(0, 2).join(' / ')}`)
}

function makeJob(params, info, attempts, tenBitCapable, meta) {
  const id = newJobId()
  const { createProgressState, stageLabel } = loadCompiledSafe().pipeline
  const job = {
    id,
    params,
    info,
    attempts,
    attemptIndex: 0,
    tenBitCapable,
    meta,
    proc: null,
    status: 'running',
    stage: 'encode',
    cancelled: false,
    durationSec: info.durationSec,
    totalFrames: Math.max(1, Math.round(info.durationSec * params.targetFps)),
    // 进度状态由 pipeline 的共享解析器维护，与桌面应用读的是同一套字段
    progress: createProgressState(),
    stageLabel: () => stageLabel(job.stage),
    stderrTail: '',
    stdoutRest: '',
    command: '',
    encoderLabel: '',
    result: null,
    error: null,
    failure: null,
    startedAt: Date.now(),
    finishedAt: 0
  }
  jobs.set(id, job)
  runAttempt(job, 0)
  return job
}

function percentOf(job) {
  const { percentFor } = loadCompiledSafe().pipeline
  return percentFor(job.progress, job.durationSec, job.status === 'running')
}

function cleanupPart(out) {
  return fs.promises.rm(`${out}.part`, { force: true }).catch(() => {})
}

function runAttempt(job, index) {
  const { pipeline, ffmpeg } = loadCompiledSafe()
  const { buildArgs, encoderLabel, applyProgressLine } = pipeline
  const attempt = job.attempts[index]
  job.attemptIndex = index
  const args = buildArgs(job.params, job.info, attempt, job.tenBitCapable)
  job.command = 'ffmpeg ' + args.map((a) => (/[\s"]/.exec(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
  job.encoderLabel = encoderLabel(attempt.nvenc)
  job.stage = index === 0 ? 'encode' : 'retry'
  const proc = spawn(ffmpeg.ffmpegPath, args, { windowsHide: true })
  job.proc = proc

  proc.stdout.on('data', (d) => {
    job.stdoutRest += d.toString()
    let nl
    while ((nl = job.stdoutRest.indexOf('\n')) >= 0) {
      const line = job.stdoutRest.slice(0, nl).trim()
      job.stdoutRest = job.stdoutRest.slice(nl + 1)
      if (line) applyProgressLine(job.progress, line)
    }
  })
  proc.stderr.on('data', (d) => {
    job.stderrTail = (job.stderrTail + d.toString()).slice(-8000)
  })
  proc.on('error', (err) => {
    const f = pipeline.classifyFailure({
      stage: 'encode',
      code: err && err.code ? String(err.code).toUpperCase() : 'FFMPEG_SPAWN_FAILED',
      message: err.message
    })
    job.status = 'error'
    job.stage = 'failed'
    job.failure = f
    job.error = f.title
    job.finishedAt = Date.now()
  })
  proc.on('close', (code) => {
    if (job.cancelled) {
      void cleanupPart(job.params.outputPath)
      job.status = 'cancelled'
      job.stage = 'cancelled'
      job.finishedAt = Date.now()
      return
    }
    if (code === 0) {
      const finalPath = job.params.outputPath
      job.stage = 'finalize'
      fs.rename(`${finalPath}.part`, finalPath, (err) => {
        if (err) {
          const f = pipeline.classifyFailure({
            stage: 'finalize',
            code: err && err.code ? String(err.code).toUpperCase() : null,
            message: `输出文件保存失败：${err.message}`,
            detailPath: finalPath
          })
          job.status = 'error'
          job.stage = 'failed'
          job.failure = f
          job.error = f.title
          job.finishedAt = Date.now()
          return
        }
        job.stage = 'reprobe'
        // 回探输出信息（真实 ffprobe），供结果展示
        ffmpeg
          .probeVideo(finalPath)
          .then((outInfo) => {
            job.result = {
              outputPath: finalPath,
              sizeBytes: outInfo.sizeBytes,
              fps: outInfo.fps > 0 ? outInfo.fps : outInfo.avgFps,
              durationSec: outInfo.durationSec,
              pixFmt: outInfo.pixFmt,
              colorTrc: outInfo.colorTrc
            }
          })
          .catch(() => {
            job.result = { outputPath: finalPath }
          })
          .finally(() => {
            job.status = 'done'
            job.stage = 'done'
            job.finishedAt = Date.now()
          })
      })
      return
    }
    if (index + 1 < job.attempts.length) {
      const next = job.attempts[index + 1]
      job.meta = job.meta || {}
      job.meta.retriedFrom = encoderLabel(attempt.nvenc)
      job.meta.retryReason =
        attempt.nvenc !== 'none' && next.nvenc === 'none' ? 'NVENC 不可用，回退 CPU 编码' : '音轨直写失败，改为 AAC 重编码'
      runAttempt(job, index + 1)
      return
    }
    const f = pipeline.classifyFailure({
      stage: 'encode',
      message: 'ffmpeg 处理失败',
      stderr: job.stderrTail.trim()
    })
    void cleanupPart(job.params.outputPath)
    job.status = 'error'
    job.stage = 'failed'
    job.failure = f
    job.error = f.title
    job.finishedAt = Date.now()
  })
}

// runAttempt 需要模块，但 loadCompiled() 会抛；这里缓存一份，作业运行期复用。
let _compiledCache = null
function loadCompiledSafe() {
  if (!_compiledCache) _compiledCache = loadCompiled()
  return _compiledCache
}

function describeJob(job) {
  const { etaSeconds, stageLabel } = loadCompiledSafe().pipeline
  const pr = job.progress
  const remainSec = job.status === 'running' ? etaSeconds(pr, job.durationSec) : null
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    stageLabel: stageLabel(job.stage),
    inputPath: job.params.inputPath,
    outputPath: job.params.outputPath,
    srcFps: fmtFps(job.info.fps > 0 ? job.info.fps : job.info.avgFps),
    targetFps: job.params.targetFps,
    mode: job.params.mode,
    quality: job.params.quality,
    container: job.params.container,
    encoderLabel: job.encoderLabel,
    command: job.command,
    retryReason: (job.meta && job.meta.retryReason) || undefined,
    percent: Math.round(percentOf(job) * 10) / 10,
    elapsedSec: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000),
    progress:
      job.status === 'running' || job.status === 'done'
        ? {
            outTimeSec: Math.round(pr.outTimeSec * 10) / 10,
            frame: pr.frame,
            totalFrames: job.totalFrames,
            processFps: fmtFps(pr.fps),
            speedX: pr.speed != null ? Math.round(pr.speed * 100) / 100 : null,
            etaSec: remainSec != null ? remainSec : null
          }
        : undefined,
    result: job.result || undefined,
    error: job.error || undefined,
    errorSteps: job.failure ? job.failure.steps : undefined,
    errorDetail: job.failure ? job.failure.detail || undefined : undefined
  }
}

// ---------- 工具声明 ----------
export const tools = [
  {
    name: 'frameboost.capability_probe',
    description:
      '探测本机 ffmpeg/ffprobe 二进制路径与版本、NVIDIA NVENC 硬件编码能力（modern/legacy/none）与 10bit 编码能力。用于判断可用编码方式；全部为本机真实检测结果。返回 {ffmpegPath,ffprobePath,ffmpegVersion,ffprobeVersion,nvenc,tenBitCapable}。',
    risk: 'read',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { ffmpeg } = loadCompiled()
      const readVer = async (bin) => {
        try {
          const r = await ffmpeg.runBin(bin, ['-version'], 8000)
          const first = (r.stdout.split('\n')[0] || '').trim()
          return first.replace(/^ffmpeg version /i, '').replace(/^ffprobe version /i, '').split(' ')[0] || first
        } catch {
          return null
        }
      }
      const [ffmpegVersion, ffprobeVersion, nvenc, tenBitCapable] = await Promise.all([
        readVer(ffmpeg.ffmpegPath),
        readVer(ffmpeg.ffprobePath),
        ffmpeg.detectNvenc(),
        ffmpeg.detectTenBit()
      ])
      return {
        ffmpegPath: ffmpeg.ffmpegPath,
        ffprobePath: ffmpeg.ffprobePath,
        ffmpegVersion,
        ffprobeVersion,
        nvenc,
        tenBitCapable
      }
    }
  },
  {
    name: 'frameboost.list_inputs',
    description:
      '列出指定目录里可处理的输入视频文件（真实 stat，含路径/大小/修改时间）。dir 省略时使用视频文件的常见位置（用户“ Videos”或项目根）。recursive=true 递归子目录。用于给 Agent 挑选输入。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '要扫描的目录绝对路径；省略则用默认位置' },
        recursive: { type: 'boolean', description: '是否递归子目录，默认 false' },
        limit: { type: 'integer', description: '最多返回条数，默认 200，上限 1000' }
      },
      additionalProperties: false
    },
    handler: async (input) => {
      const dir = input.dir ? String(input.dir) : defaultVideoDir()
      if (!dir || !fs.existsSync(dir)) throw new AgentError('bad_input', `目录不存在：${dir}`)
      const stat = fs.statSync(dir)
      if (!stat.isDirectory()) throw new AgentError('bad_input', `不是目录：${dir}`)
      const limit = Math.min(1000, Math.max(1, Number(input.limit) || 200))
      const { items, truncated } = walkVideos(dir, !!input.recursive, limit)
      return { dir, count: items.length, truncated, videos: items }
    }
  },
  {
    name: 'frameboost.probe_video',
    description:
      '用 ffprobe 探测单个视频文件的真实信息（分辨率、帧率、时长、编码、像素格式、色彩、音轨）。额外给出 ×2/×3/×4 的建议目标帧率，便于随后调用 render_start。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: '视频文件绝对路径' }
      },
      required: ['inputPath'],
      additionalProperties: false
    },
    handler: async (input) => {
      const { ffmpeg, pipeline } = loadCompiled()
      const info = await ffmpeg.probeVideo(String(input.inputPath))
      const src = info.fps > 0 ? info.fps : info.avgFps
      const suggestions = src > 0 ? { x2: Math.round(src * 2), x3: Math.round(src * 3), x4: Math.round(src * 4) } : null
      return {
        ...info,
        srcFps: fmtFps(src),
        suggestedTargetFps: suggestions,
        maxFps: pipeline.MAX_FPS
      }
    }
  },
  {
    name: 'frameboost.render_start',
    description:
      '按参数创建并真实执行一个补帧任务（异步）。复用桌面应用完全相同的命令构建与回退策略（NVENC→CPU、音轨直写→AAC 重试）。必须传 confirm:true 才会执行；否则只返回将要执行的计划与风险。返回 jobId，随后用 job_status 轮询。',
    risk: 'exec',
    input_schema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: '输入视频绝对路径' },
        outputPath: { type: 'string', description: '输出绝对路径（.mp4/.mkv）；省略则按 原名_帧率fps 命名到输入同目录' },
        targetFps: { type: 'integer', description: '目标帧率（与 multiplier 二选一）' },
        multiplier: { type: 'number', description: '按源帧率的倍率（>1），与 targetFps 二选一' },
        mode: { type: 'string', enum: ['high', 'balanced', 'fast'], description: '补帧方式，默认 balanced' },
        quality: { type: 'string', enum: ['master', 'high', 'standard'], description: '输出质量，默认 standard（与桌面应用同一份默认值表）' },
        container: { type: 'string', enum: ['mp4', 'mkv'], description: '封装格式（决定默认输出后缀），默认 mp4' },
        useNvenc: { type: 'boolean', description: '是否尝试 NVIDIA NVENC，默认 true（不可用自动回退 CPU）' },
        confirm: { type: 'boolean', description: '必须显式 true 才会真实执行渲染' }
      },
      required: ['inputPath', 'confirm'],
      additionalProperties: false
    },
    handler: async (input) => {
      const { ffmpeg, pipeline, defaults } = loadCompiled()
      const { normalizeRenderParams, preflightRenderPlan, pixelFormatNotice, planOutputPath, resolveInsideRoot, emptyPolicy, addToPolicy } = defaults

      // 默认值与校验只有一份实现：桌面应用用的就是这个函数。
      // 之前这里自己写了第二套（quality 默认 high、桌面默认 standard），同一能力两种码率。
      const inputPath = String(input.inputPath ?? '')
      if (!inputPath) throw new AgentError('bad_input', '必须提供 inputPath')
      let params
      try {
        let targetFps = input.targetFps != null && input.targetFps !== '' ? Math.round(Number(input.targetFps)) : 0
        if (!(targetFps > 0)) {
          // 倍率模式要先知道源帧率，所以这里可能多探一次；探测走的是共享闸门（有超时、有输出上限）
          const pre = await ffmpeg.probeVideo(inputPath)
          targetFps = resolveTargetFps(input, pre.fps > 0 ? pre.fps : pre.avgFps)
        }
        const planned = planOutputFor(input, targetFps)
        params = normalizeRenderParams({
          inputPath,
          outputPath: planned.outputPath,
          targetFps,
          mode: input.mode,
          quality: input.quality,
          container: planned.container,
          // Agent 侧的 useNvenc 由工具 schema 自己声明（默认尝试硬件加速），
          // 传成"明确给过的值"，不改动共享默认，两边都不会漂移。
          useNvenc: input.useNvenc !== false
        })
      } catch (e) {
        if (e instanceof AgentError) throw e
        throw badWithCode(e, pipeline)
      }

      // 输出归属：落在输入文件所在目录、或调用方用环境变量指定的工作目录之内。
      // 这一条挡的是"随便挑一个卷往里写"，不是把 Agent 变成第二个桌面 —— 见 agent/README.md。
      const policy = agentPathPolicy(inputPath)
      const inside = policy.writableRoots.some((root) => resolveInsideRoot(params.outputPath, root).ok)
      if (!inside) {
        throw new AgentError(
          'bad_input',
          `输出路径不在允许的工作目录内：${params.outputPath}｜已允许的目录：${policy.writableRoots.join('、')}｜下一步：把 outputPath 指到输入文件所在目录，或设置 FRAMEBOOST_WORKSPACE_ROOT 后重试`
        )
      }

      let planResult
      try {
        planResult = await preflightRenderPlan(params, {
          checkReadable: ffmpeg.checkReadable,
          probeVideo: ffmpeg.probeVideo,
          checkDirWritable: ffmpeg.checkDirWritable,
          freeBytesFor: ffmpeg.freeBytesFor
        })
      } catch (e) {
        throw badWithCode(e, pipeline)
      }
      const info = planResult.info
      const srcFps = info.fps > 0 ? info.fps : info.avgFps

      const tenBitCapable = await ffmpeg.detectTenBit()
      const nvencLevel = params.useNvenc ? await ffmpeg.detectNvenc() : 'none'
      const { eff, notices } = pixelFormatNotice(params, info, tenBitCapable, nvencLevel)
      const attempts = pipeline.planAttempts(params, nvencLevel, !eff.downgraded)
      // 重名不覆盖：命名规则同样来自共享实现（只在同一目录里加数字后缀）
      params = { ...params, outputPath: planOutputPath(params.outputPath) }

      // 预演（dry-run）：未确认时只返回执行计划，不启动任何进程。
      if (input.confirm !== true) {
        return {
          executed: false,
          needsConfirm: true,
          risk: 'exec',
          message: '这是写操作：将真实调用 ffmpeg 生成文件。请传 confirm:true 重新调用以执行。',
          plan: {
            ...params,
            srcFps: fmtFps(srcFps),
            nvencLevel: attempts[0]?.nvenc ?? 'none',
            pixFmtDowngraded: eff.downgraded,
            estimatedOutputBytes: planResult.estimatedBytes,
            diskFreeBytes: planResult.freeBytes,
            notices,
            outputContainment: { roots: policy.writableRoots, fromEnv: !!String(process.env.FRAMEBOOST_WORKSPACE_ROOT ?? '').trim() },
            attemptSequence: attempts.map((a) => ({ encoder: a.nvenc, audio: a.audio }))
          }
        }
      }

      const job = makeJob(params, info, attempts, tenBitCapable, { notices })
      return { executed: true, jobId: job.id, encoderLabel: job.encoderLabel, command: job.command, status: job.status, notices }
    }
  },
  {
    name: 'frameboost.job_status',
    description:
      '查询某个补帧任务的进度与结果。running 时给出百分比、已处理时长、处理帧率、倍速与预估剩余秒数，并给出当前真实阶段 stage/stageLabel（encode/retry/finalize/reprobe）；done 时给出输出文件真实 ffprobe 结果；error 时给出归因结论与下一步。所有数字都来自解析 ffmpeg -progress 输出，不是估算。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'render_start 返回的 jobId' } },
      required: ['jobId'],
      additionalProperties: false
    },
    handler: async (input) => {
      const job = jobs.get(String(input.jobId))
      if (!job) throw new AgentError('unknown_job', `未找到任务：${input.jobId}（进程重启后内存态任务会丢失）`)
      return describeJob(job)
    }
  },
  {
    name: 'frameboost.cancel_job',
    description: '取消（停止）一个正在运行的补帧任务：终止 ffmpeg 子进程并清理未完成的 .part 文件。必须传 confirm:true。',
    risk: 'write',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '要取消的任务 id' },
        confirm: { type: 'boolean', description: '必须显式 true' }
      },
      required: ['jobId', 'confirm'],
      additionalProperties: false
    },
    handler: async (input) => {
      if (input.confirm !== true)
        throw new AgentError('confirm_required', '取消会中断正在写入的输出，请传 confirm:true')
      const job = jobs.get(String(input.jobId))
      if (!job) throw new AgentError('unknown_job', `未找到任务：${input.jobId}`)
      if (job.status !== 'running') return { jobId: job.id, status: job.status, cancelled: false, message: '任务不在运行中' }
      job.cancelled = true
      job.stage = 'cancelled'
      try {
        job.proc?.kill()
      } catch {
        /* ignore */
      }
      await cleanupPart(job.params.outputPath)
      job.status = 'cancelled'
      job.finishedAt = Date.now()
      return {
        jobId: job.id,
        status: 'cancelled',
        stage: 'cancelled',
        cancelled: true,
        partFileRemoved: !fs.existsSync(`${job.params.outputPath}.part`),
        message: '已终止 ffmpeg 子进程并清理 .part 半成品'
      }
    }
  },
  {
    name: 'frameboost.list_outputs',
    description:
      '列出目录里的 FrameBoost 输出文件（命名约定 原名_数字fps.mp4/mkv），含真实大小与修改时间，按修改时间倒序。dir 省略时用默认位置。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '扫描目录绝对路径' },
        recursive: { type: 'boolean', description: '是否递归，默认 false' },
        limit: { type: 'integer', description: '最多条数，默认 200，上限 1000' }
      },
      additionalProperties: false
    },
    handler: async (input) => {
      const dir = input.dir ? String(input.dir) : defaultVideoDir()
      if (!dir || !fs.existsSync(dir)) throw new AgentError('bad_input', `目录不存在：${dir}`)
      if (!fs.statSync(dir).isDirectory()) throw new AgentError('bad_input', `不是目录：${dir}`)
      const limit = Math.min(1000, Math.max(1, Number(input.limit) || 200))
      const { items, truncated } = walkVideos(dir, !!input.recursive, limit)
      const outputs = items
        .filter((v) => /_\d+(\.\d+)?fps\.(mp4|mkv)$/i.test(v.name))
        .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt))
      return { dir, count: outputs.length, scanned: items.length, truncated, outputs }
    }
  }
]

function defaultVideoDir() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const vid = home ? path.join(home, 'Videos') : ''
  if (vid && fs.existsSync(vid)) return vid
  return ROOT
}

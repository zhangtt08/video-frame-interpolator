// 渲染入参的唯一默认值、唯一校验、唯一预检序列，以及"路径归谁管"的归属判定。
//
// 桌面主进程（electron/main.ts）与 Agent（agent/tools.mjs 读 dist-electron/render-defaults.js）
// 必须走这同一份 —— README 里那句"没有第二套实现"靠这个文件成立，不是靠承诺。
// 之前 Agent 侧自己把 quality 默认成 high、桌面默认成 standard，同一个能力两种码率，就是漂移。
import path from 'node:path'
import fs from 'node:fs'
import {
  MAX_FPS,
  estimateOutputBytes,
  formatBytes,
  pathNamingProblem,
  pixFmtFor,
  resolveOutputPath,
  DISK_HEADROOM,
  type NvencLevel,
  type ProbeResult,
  type Quality,
  type RenderParams
} from './pipeline'

/** 唯一一份默认值。改这里就等于改桌面与 Agent 两边，不存在只改一边的可能。 */
export const RENDER_DEFAULTS = {
  mode: 'balanced',
  quality: 'standard',
  container: 'mp4',
  /** 硬件加速默认关：不是每台机器都有 NVENC，默认开着只会让第一次失败看不懂 */
  useNvenc: false,
  minTargetFps: 5
} as const

/** 带 code 的校验错误：交给 pipeline.classifyFailure 出「结论 + 下一步」 */
export function paramError(code: string, message: string): never {
  const e = new Error(message) as Error & { code: string }
  e.name = 'ParamError'
  e.code = code
  throw e
}

const MODES = ['high', 'balanced', 'fast']
const QUALITIES: Quality[] = ['master', 'high', 'standard']

/**
 * 把任意来源（界面 / REST / Agent）的原始入参收敛成一份 RenderParams。
 * 默认值只有这一处：mode=balanced、quality=standard、container=mp4、useNvenc=false。
 * 非法值一律拒绝并给 code，不做"看起来不对就悄悄换成默认"的静默纠正。
 */
export function normalizeRenderParams(raw: unknown): RenderParams {
  const r = (raw ?? {}) as Record<string, unknown>
  const inputPath = String(r.inputPath ?? '').trim()
  const outputPath = String(r.outputPath ?? '').trim()
  const targetFps = Math.round(Number(r.targetFps))
  const container = String(r.container ?? RENDER_DEFAULTS.container)
  const mode = r.mode === undefined || r.mode === null || r.mode === '' ? RENDER_DEFAULTS.mode : String(r.mode)
  const quality = r.quality === undefined || r.quality === null || r.quality === '' ? RENDER_DEFAULTS.quality : String(r.quality)

  if (!inputPath) paramError('BAD_INPUT', '未指定输入文件')
  if (!outputPath) paramError('BAD_INPUT', '未指定输出路径')
  if (path.resolve(inputPath) === path.resolve(outputPath)) paramError('SAME_PATH', '输出路径不能与输入文件相同')
  if (!Number.isFinite(targetFps) || targetFps < RENDER_DEFAULTS.minTargetFps || targetFps > MAX_FPS) {
    paramError('FPS_RANGE', `目标帧率无效（应在 ${RENDER_DEFAULTS.minTargetFps}-${MAX_FPS} 之间）`)
  }
  if (!MODES.includes(mode)) paramError('BAD_MODE', `补帧方式只能是 ${MODES.join(' / ')}，收到的是「${mode}」`)
  if (!QUALITIES.includes(quality as Quality)) paramError('BAD_QUALITY', `输出质量只能是 ${QUALITIES.join(' / ')}，收到的是「${quality}」`)
  if (container !== 'mp4' && container !== 'mkv') paramError('BAD_OUTPUT_EXT', '输出封装格式只支持 mp4 或 mkv')
  if (!/\.(mp4|mkv)$/i.test(outputPath)) paramError('BAD_OUTPUT_EXT', '输出文件必须是 .mp4 或 .mkv')
  // useNvenc 只在"明确给了"时按给的算；没给时走 RENDER_DEFAULTS.useNvenc，两边同一个默认。
  const useNvenc = r.useNvenc === undefined || r.useNvenc === null ? RENDER_DEFAULTS.useNvenc : !!r.useNvenc

  const scdThreshold = typeof r.scdThreshold === 'number' && Number.isFinite(r.scdThreshold) && r.scdThreshold >= 0 ? r.scdThreshold : undefined
  const copySubtitles = typeof r.copySubtitles === 'boolean' ? r.copySubtitles : undefined
  return { inputPath, outputPath, targetFps, mode: mode as RenderParams['mode'], quality: quality as Quality, container, useNvenc, ...(scdThreshold !== undefined ? { scdThreshold } : {}), ...(copySubtitles !== undefined ? { copySubtitles } : {}) }
}

// ---------------------------------------------------------------------------
// 路径归属：输出只能落在用户挑过的工作目录里，输入只能是他打开过的文件
// ---------------------------------------------------------------------------

export interface FsDeps {
  realpath: (p: string) => string
  exists: (p: string) => boolean
}

const realFs: FsDeps = {
  realpath: (p) => fs.realpathSync(p),
  exists: (p) => fs.existsSync(p)
}

/** Windows 路径大小写不敏感、分隔符两种写法等价 —— 比对前先归成同一种形状 */
export function pathKey(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase('en-US')
}

/**
 * candidate 是否真的落在 root 之内（含符号链接指向外面也算在外面）。
 *
 * 两段判定：① 词面 containment（挡住 ../ 绕行）；② 对最深的那个「已存在」祖先做 realpath
 * 再判一次（挡住「目录里藏一个指向别处的链接/junction」—— 输出文件本身通常还不存在，
 * 所以链接只能出现在祖先链上，祖先查干净就够）。任何一段不过就拒。
 */
export function resolveInsideRoot(candidate: string, root: string, deps: FsDeps = realFs): { ok: boolean; reason?: string; resolved?: string } {
  if (!root) return { ok: false, reason: 'WORKSPACE_NOT_SET' }
  let abs: string
  let realRoot: string
  try {
    abs = path.resolve(candidate)
    realRoot = deps.realpath(root)
  } catch {
    return { ok: false, reason: 'WORKSPACE_NOT_SET' }
  }
  const rel = path.relative(realRoot, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'OUT_OF_WORKSPACE', resolved: abs }
  }
  // 沿祖先链往上找到第一个真实存在的目录，对它做 realpath，再比一次
  let cur = abs
  for (;;) {
    if (deps.exists(cur)) break
    const up = path.dirname(cur)
    if (up === cur) return { ok: false, reason: 'OUT_OF_WORKSPACE', resolved: abs }
    cur = up
  }
  let realCur: string
  try {
    realCur = deps.realpath(cur)
  } catch {
    return { ok: false, reason: 'OUT_OF_WORKSPACE', resolved: abs }
  }
  const relReal = path.relative(realRoot, realCur)
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    // 词面在工作目录内、真实位置却在外面 —— 这就是符号链接逃逸
    return { ok: false, reason: 'OUT_OF_WORKSPACE', resolved: abs }
  }
  return { ok: true, resolved: abs }
}

/**
 * 用户 gesture 换来的可写/可读范围。空集合意味着"什么都还没授权"，
 * 此时必须拒绝而不是放行 —— 放行等于没有这道门。
 */
export interface PathPolicy {
  /** 允许写入的目录（用户挑过的输出目录、保存对话框给出的目录、打开过的输入所在目录） */
  writableRoots: string[]
  /** 允许读取的目录（额外登记的输入根，如 FRAMEBOOST_INPUT_ROOTS） */
  inputRoots: string[]
  /** 用户在界面里明确打开过的具体文件 */
  openedFiles: string[]
}

export function emptyPolicy(): PathPolicy {
  return { writableRoots: [], inputRoots: [], openedFiles: [] }
}

export function addToPolicy(policy: PathPolicy, kind: 'writableRoots' | 'inputRoots' | 'openedFiles', value: string): void {
  if (!value) return
  const key = pathKey(value)
  if (!policy[kind].some((p) => pathKey(p) === key)) policy[kind].push(path.resolve(value))
}

export function policyFromEnv(policy: PathPolicy, env: NodeJS.ProcessEnv = process.env): PathPolicy {
  const extra = String(env.FRAMEBOOST_INPUT_ROOTS ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const root of extra) addToPolicy(policy, 'inputRoots', root)
  return policy
}

export interface PathDecision {
  ok: boolean
  code?: string
  message?: string
}

/** 输入：必须是用户打开过的文件，或落在允许的读根之内 */
export function checkInputAllowed(p: string, policy: PathPolicy, deps: FsDeps = realFs): PathDecision {
  const key = pathKey(p)
  if (policy.openedFiles.some((f) => pathKey(f) === key)) return { ok: true }
  const roots = [...policy.writableRoots, ...policy.inputRoots]
  for (const root of roots) {
    const inside = resolveInsideRoot(p, root, deps)
    if (inside.ok) return { ok: true }
  }
  return {
    ok: false,
    code: 'INPUT_NOT_ALLOWED',
    message: `这份输入不是用户在界面里打开过的文件，也不在允许的读取目录内：${p}`
  }
}

/** 输出：必须落在用户挑过的工作目录之内（含符号链接逃逸判定） */
export function checkOutputInsideWorkspace(p: string, policy: PathPolicy, deps: FsDeps = realFs): PathDecision {
  if (policy.writableRoots.length === 0) {
    return { ok: false, code: 'WORKSPACE_NOT_SET', message: '还没有选择过输出目录，FrameBoost 不会替人决定往哪写' }
  }
  for (const root of policy.writableRoots) {
    const inside = resolveInsideRoot(p, root, deps)
    if (inside.ok) return { ok: true }
  }
  return {
    ok: false,
    code: 'OUT_OF_WORKSPACE',
    message: `输出路径不在用户选择的工作目录内：${p}（已授权的目录：${policy.writableRoots.join('、')}）`
  }
}

/** 一次把两条都判了；通过就原样交出 params，方便串进流程 */
export function enforcePathPolicy(p: RenderParams, policy: PathPolicy, deps: FsDeps = realFs): RenderParams {
  const inCheck = checkInputAllowed(p.inputPath, policy, deps)
  if (!inCheck.ok) paramError(inCheck.code ?? 'INPUT_NOT_ALLOWED', inCheck.message ?? '输入路径未获授权')
  const outCheck = checkOutputInsideWorkspace(p.outputPath, policy, deps)
  if (!outCheck.ok) paramError(outCheck.code ?? 'OUT_OF_WORKSPACE', outCheck.message ?? '输出路径越出工作目录')
  return p
}

/**
 * 「一条渲染请求能不能收下」的完整判据 —— 桌面 IPC、应用内 REST、Agent 三条入口都调这一个函数。
 * 有任何一条入口自己拼校验，就一定会漂移，所以这里就是唯一的一层。
 */
export function validateRenderRequest(raw: unknown, policy: PathPolicy, deps: FsDeps = realFs): RenderParams {
  return enforcePathPolicy(normalizeRenderParams(raw), policy, deps)
}

// ---------------------------------------------------------------------------
// 预检序列：把「跑了一半才失败」提前成一句可执行的话 —— 桌面与 Agent 共用同一条
// ---------------------------------------------------------------------------

export interface PreflightDeps {
  checkReadable(file: string): { ok: boolean; code?: string; error?: string }
  probeVideo(file: string): Promise<ProbeResult>
  checkDirWritable(dir: string): { ok: boolean; code?: string; error?: string }
  freeBytesFor(dir: string): number | null
}

export interface PreflightResult {
  info: ProbeResult
  srcFps: number
  estimatedBytes: number
  freeBytes: number | null
  notices: string[]
}

export function saneFpsOf(info: ProbeResult): number | null {
  const v = info.fps > 0 ? info.fps : info.avgFps
  return v > 0 ? v : null
}

/**
 * 跑一遍完整预检：读得到 → 路径合法 → 探得出信息 → 帧率说得通 → 输出目录写得动 → 空间够。
 * 每一步失败都抛带 code 的 Error，由 classifyFailure 出「下一步」；不返回"大概没问题"。
 */
export async function preflightRenderPlan(p: RenderParams, deps: PreflightDeps): Promise<PreflightResult> {
  const read = deps.checkReadable(p.inputPath)
  if (!read.ok) paramError(read.code ?? 'ENOENT', read.error ?? '输入文件读不了')
  const inIssue = pathNamingProblem(p.inputPath)
  if (inIssue) paramError('ENAMETOOLONG', `输入路径有问题：${inIssue}`)

  const info = await deps.probeVideo(p.inputPath)
  const srcFps = saneFpsOf(info)
  if (!srcFps) paramError('NO_SOURCE_FPS', '源视频没有可读的帧率信息')
  if (p.targetFps <= srcFps + 0.01) {
    paramError('BAD_TARGET_FPS', `目标帧率需高于原帧率（原 ${Math.round(srcFps * 100) / 100} fps）`)
  }

  const outIssue = pathNamingProblem(p.outputPath)
  if (outIssue) paramError('ENAMETOOLONG', `输出路径有问题：${outIssue}`)
  const dir = path.dirname(p.outputPath)
  const writable = deps.checkDirWritable(dir)
  if (!writable.ok) paramError(writable.code ?? 'EACCES', writable.error ?? '输出目录不可写')

  const notices: string[] = []
  const estimatedBytes = estimateOutputBytes(info, p.targetFps, p.quality)
  const freeBytes = deps.freeBytesFor(dir)
  if (freeBytes !== null && freeBytes < estimatedBytes * DISK_HEADROOM) {
    paramError(
      'ENOSPC',
      `目标磁盘剩余 ${formatBytes(freeBytes)}，预计需要约 ${formatBytes(estimatedBytes)}（含安全余量 ${formatBytes(Math.round(estimatedBytes * DISK_HEADROOM))}）`
    )
  }
  if (freeBytes === null) notices.push('未能读取目标磁盘剩余空间，跳过空间预检直接开始')
  return { info, srcFps, estimatedBytes, freeBytes, notices }
}

/** 10bit 源 + 本机编码能力 → 是否降级、要不要提醒（同样只有一份实现） */
export function pixelFormatNotice(p: RenderParams, info: ProbeResult, tenBitCapable: boolean, nvencLevel: NvencLevel): { eff: { fmt: string; downgraded: boolean }; notices: string[] } {
  const eff = pixFmtFor(info.pixFmt, tenBitCapable)
  const notices: string[] = []
  if (eff.downgraded) notices.push('源视频为 10bit，内置 x264 不支持 10bit H.264 输出，将以 8bit 编码')
  if (p.useNvenc && nvencLevel === 'none') notices.push('本机未检测到可用的 NVENC，已直接使用 CPU（libx264）编码')
  return { eff, notices }
}

/** 输出重名时自动加后缀 —— 命名规则也只有一份（resolveOutputPath 来自 pipeline） */
export function planOutputPath(desired: string, exists: (p: string) => boolean = (x) => fs.existsSync(x)): string {
  return resolveOutputPath(desired, exists)
}

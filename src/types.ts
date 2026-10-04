// 渲染端与主进程共享的类型：核心类型直接复用 electron/pipeline.ts（纯函数模块）
import type { ProbeResult } from '../electron/pipeline'

export type {
  Mode,
  NvencLevel,
  Quality,
  ProbeResult,
  RenderParams,
  Preset,
  HistoryEntry,
  RenderStage,
  FailureInfo
} from '../electron/pipeline'

export interface ProbeResponse {
  ok: boolean
  info?: ProbeResult
  error?: string
  steps?: string[]
  log?: string
}

export interface StartResult {
  ok: boolean
  error?: string
  /** 归因结论的一句话标题 */
  title?: string
  /** 失败时可执行的下一步 */
  steps?: string[]
  log?: string
  command?: string
  encoderLabel?: string
  outputPath?: string
  targetFps?: number
  srcFps?: number
  notice?: string
}

export interface ProgressData {
  percent: number
  stage?: string
  stageLabel?: string
  outTimeSec: number
  fps: number
  speed: number | null
  frame: number
  totalFrames: number
  /** 由 ffmpeg 自己报的 speed 推出的剩余秒数；推不出为 null */
  etaSec?: number | null
  elapsedSec?: number
}

export interface DonePayload {
  outputPath: string
  sizeBytes?: number
  fps?: number
  durationSec?: number
  encoder?: string
  elapsedSec?: number
  processFps?: number
}

/** 应用内 REST（8393）的真实状态 —— 绑不上就照实写，不再静默 no-op */
export interface ApiState {
  ok: boolean
  port: number
  url: string
  error: string
  tokenRequired: boolean
  since: number
}

/** 一次能力的唯一真相：界面灰掉什么、为什么灰，全看这里 */
export interface MetaInfo {
  ffmpegPath: string
  ffprobePath: string
  ffmpegVersion: string
  ffprobeVersion?: string
  nvenc?: 'none' | 'legacy' | 'modern'
  tenBitCapable?: boolean
  nvencReason?: string
  binOk?: boolean
  binProblem?: string
  dataDir?: string
  api?: ApiState
  workspace?: { roots: string[]; openedFiles: number; problem?: string }
  timeouts?: { probeMs: number; jobMs: number }
}

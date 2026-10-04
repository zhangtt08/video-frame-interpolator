// 仅开发预览用：在普通浏览器中打开渲染端时（无 Electron），注入模拟 API，
// 便于用浏览器走查完整 UI 流程（添加 → 选预设 → 队列 → 阶段进度 → 完成）。生产构建被摇树移除。
// 注意：这里的进度是模拟的，只为看界面；真实百分比/帧率/剩余时间来自主进程解析 ffmpeg -progress。
import type { MetaInfo, ProbeResponse, ProbeResult, StartResult } from './types'
import { mergePresetList } from '../electron/pipeline'

const DEMO = {
  path: 'C:\\Videos\\精彩集锦.mp4',
  fileName: '精彩集锦.mp4',
  sizeBytes: 384921600,
  durationSec: 183.5,
  width: 1920,
  height: 1080,
  fps: 29.97,
  avgFps: 29.97,
  fpsRational: '30000/1001',
  pixFmt: 'yuv420p',
  videoCodec: 'h264',
  videoStreamIndex: 0,
  colorPrimaries: 'bt709',
  colorTrc: 'bt709',
  colorSpace: 'bt709',
  hasAudio: true,
  audioCodec: 'aac'
}

/** 第二条演示素材，用来看多文件队列 */
const DEMO2 = {
  ...DEMO,
  path: 'C:\\Videos\\产品演示 素材.mp4',
  fileName: '产品演示 素材.mp4',
  sizeBytes: 88492160,
  durationSec: 41.2,
  width: 1280,
  height: 720,
  fps: 25,
  avgFps: 25,
  fpsRational: '25/1',
  pixFmt: 'yuv420p10le',
  colorTrc: 'smpte2084',
  hasAudio: false,
  audioCodec: ''
}

const STAGES: { stage: string; label: string; at: number }[] = [
  { stage: 'probe', label: '探测源文件', at: 0 },
  { stage: 'preflight', label: '能力与磁盘预检', at: 4 },
  { stage: 'encode', label: '补帧编码', at: 8 },
  { stage: 'finalize', label: '写入产物', at: 96 },
  { stage: 'reprobe', label: '回探产物', at: 100 }
]

let addSeq = 0

export function installDevMock(): void {
  const listeners: Record<string, ((d: unknown) => void) | null> = {
    progress: null,
    stage: null,
    retry: null,
    notice: null,
    done: null,
    error: null,
    cancelled: null
  }
  let timer: ReturnType<typeof setInterval> | null = null
  let userPresets: unknown[] = []

  const api = {
    probe: async (): Promise<ProbeResponse> => {
      addSeq += 1
      return { ok: true, info: { ...(addSeq % 2 === 0 ? DEMO2 : DEMO) } as ProbeResult }
    },
    pathForFile: () => '',
    pickVideo: async () => [DEMO.path],
    pickOutput: async (def: string) => def,
    pickDir: async () => 'C:\\Videos\\补帧输出',
    showInFolder: async () => true,
    getMeta: async (): Promise<MetaInfo> => ({
      ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
      ffprobePath: 'C:\\ffmpeg\\bin\\ffprobe.exe',
      ffmpegVersion: '7.0.2-mock',
      ffprobeVersion: '7.0.2-mock',
      nvenc: 'none',
      tenBitCapable: true,
      nvencReason: '（模拟）本机没有可用的 NVIDIA NVENC，硬件加速已不可选，将使用 CPU（libx264）',
      binOk: true,
      dataDir: 'C:\\Users\\demo\\AppData\\Roaming\\FrameBoost'
    }),
    startRender: async (raw: unknown): Promise<StartResult> => {
      const p = (raw ?? {}) as { targetFps?: number; outputPath?: string }
      let pct = 0
      let stageIdx = 0
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        pct += 4
        if (stageIdx < STAGES.length - 1 && pct >= STAGES[stageIdx + 1].at) {
          stageIdx += 1
          listeners.stage?.({ stage: STAGES[stageIdx].stage, label: STAGES[stageIdx].label, encoder: 'CPU · libx264' })
        }
        if (pct >= 100) {
          if (timer) clearInterval(timer)
          timer = null
          listeners.progress?.({
            percent: 100,
            stage: 'reprobe',
            stageLabel: '回探产物',
            outTimeSec: DEMO.durationSec,
            fps: 68,
            speed: 1.9,
            frame: 11010,
            totalFrames: 11010,
            etaSec: 0,
            elapsedSec: 96
          })
          listeners.done?.({
            outputPath: p.outputPath ?? 'C:\\Videos\\精彩集锦_60fps.mp4',
            sizeBytes: 512340000,
            fps: p.targetFps ?? 60,
            durationSec: DEMO.durationSec,
            encoder: 'CPU · libx264',
            elapsedSec: 96,
            processFps: 68
          })
        } else {
          listeners.progress?.({
            percent: pct,
            stage: STAGES[stageIdx].stage,
            stageLabel: STAGES[stageIdx].label,
            outTimeSec: (DEMO.durationSec * pct) / 100,
            fps: 58 + Math.round(pct / 8),
            speed: 1.6 + Math.random() * 0.6,
            frame: Math.round((11010 * pct) / 100),
            totalFrames: 11010,
            etaSec: Math.round(((100 - pct) / 100) * DEMO.durationSec / 1.8),
            elapsedSec: Math.round((pct / 100) * 96)
          })
        }
      }, 300)
      listeners.notice?.({ message: '（模拟）本机未检测到可用的 NVENC，已直接使用 CPU（libx264）编码' })
      return {
        ok: true,
        command:
          'ffmpeg -y -hide_banner -nostdin -loglevel error -progress pipe:1 -i "C:\\Videos\\精彩集锦.mp4" -map 0:v:0 -map 0:a:0? -vf "fps=30000/1001,tpad=stop_mode=clone:stop_duration=1,minterpolate=fps=60:mi_mode=mci:mc_mode=obmc:me_mode=bidir:vsbmc=0,trim=duration=183.500,format=yuv420p" -c:v libx264 -preset slow -crf 16 -c:a copy -movflags +faststart -f mov "C:\\Videos\\精彩集锦_60fps.mp4.part"',
        encoderLabel: 'CPU · libx264',
        outputPath: p.outputPath ?? 'C:\\Videos\\精彩集锦_60fps.mp4',
        targetFps: p.targetFps ?? 60,
        srcFps: 29.97
      }
    },
    cancelRender: async () => {
      if (timer) clearInterval(timer)
      timer = null
      listeners.cancelled?.({})
      return { ok: true }
    },
    onProgress: (cb: (d: unknown) => void) => {
      listeners.progress = cb
      return () => {
        listeners.progress = null
      }
    },
    onStage: (cb: (d: unknown) => void) => {
      listeners.stage = cb
      return () => {
        listeners.stage = null
      }
    },
    onRetry: (cb: (d: unknown) => void) => {
      listeners.retry = cb
      return () => {
        listeners.retry = null
      }
    },
    onNotice: (cb: (d: unknown) => void) => {
      listeners.notice = cb
      return () => {
        listeners.notice = null
      }
    },
    onDone: (cb: (d: unknown) => void) => {
      listeners.done = cb
      return () => {
        listeners.done = null
      }
    },
    onError: (cb: (d: unknown) => void) => {
      listeners.error = cb
      return () => {
        listeners.error = null
      }
    },
    onCancelled: (cb: (d: unknown) => void) => {
      listeners.cancelled = cb
      return () => {
        listeners.cancelled = null
      }
    },
    presets: {
      list: async () => ({ ok: true, presets: mergePresetList(userPresets) }),
      save: async (preset: unknown) => {
        userPresets = [...userPresets, preset]
        return { ok: true, presets: mergePresetList(userPresets) }
      },
      remove: async (id: string) => {
        userPresets = userPresets.filter((p) => (p as { id?: string }).id !== id)
        return { ok: true, presets: mergePresetList(userPresets) }
      },
      export: async () => ({ ok: false, error: '浏览器预览模式不能写文件，请在桌面版里导出' }),
      import: async () => ({ ok: false, error: '浏览器预览模式不能读文件，请在桌面版里导入' })
    },
    history: {
      list: async () => ({
        ok: true,
        entries: [
          {
            id: 'mock-1',
            fileName: '上年跑过的样片.mp4',
            inputPath: DEMO.path,
            outputPath: 'C:\\Videos\\上年跑过的样片_60fps.mp4',
            srcFps: 29.97,
            targetFps: 60,
            mode: 'balanced',
            quality: 'high',
            container: 'mp4',
            encoder: 'CPU · libx264',
            ok: true,
            sizeBytes: 402340000,
            durationSec: 183.5,
            elapsedSec: 640,
            processFps: 21.4,
            finishedAt: Date.now() - 86400000
          },
          {
            id: 'mock-2',
            fileName: '坏掉的录屏.mp4',
            inputPath: DEMO2.path,
            outputPath: 'C:\\Videos\\坏掉的录屏_50fps.mp4',
            srcFps: 25,
            targetFps: 50,
            mode: 'fast',
            quality: 'standard',
            container: 'mp4',
            encoder: 'CPU · libx264',
            ok: false,
            error: '源文件损坏或不是有效视频',
            finishedAt: Date.now() - 3600000
          }
        ]
      }),
      clear: async () => ({ ok: true, entries: [] })
    },
    windowControls: {
      minimize: async () => undefined,
      toggleMaximize: async () => false,
      close: async () => undefined,
      isMaximized: async () => false,
      onMaximizedChange: () => () => undefined
    }
  }
  ;(window as unknown as { api: unknown }).api = api
}

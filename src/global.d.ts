import type {
  ApiState,
  DonePayload,
  HistoryEntry,
  MetaInfo,
  Preset,
  ProbeResponse,
  ProgressData,
  RenderParams,
  StartResult
} from './types'

interface PresetResult {
  ok: boolean
  presets?: Preset[]
  added?: number
  rejected?: number
  path?: string
  count?: number
  canceled?: boolean
  error?: string
}

interface HistoryResult {
  ok: boolean
  entries?: HistoryEntry[]
  broken?: boolean
  error?: string
}

declare global {
  interface Window {
    api: {
      probe(p: string): Promise<ProbeResponse>
      startRender(p: RenderParams): Promise<StartResult>
      cancelRender(): Promise<{ ok: boolean }>
      pickVideo(): Promise<string[]>
      pickOutput(defaultPath: string): Promise<string | null>
      pickDir(): Promise<string | null>
      /** 拖拽/外部添加文件时登记"用户打开过它"，主进程据此放行读取与就近写入 */
      registerFiles(paths: string[]): Promise<{ ok: boolean; registered: number; workspaceRoots: number }>
      /** 应用内 REST 的真实状态（8393 有没有真的在听） */
      apiStatus(): Promise<ApiState & { workspaceRoots?: string[] }>
      showInFolder(p: string): Promise<boolean>
      getMeta(): Promise<MetaInfo>
      pathForFile(f: File): string
      onApiState?(cb: (d: ApiState & { workspaceRoots?: string[] }) => void): () => void
      onProgress(cb: (d: ProgressData) => void): () => void
      onStage(cb: (d: { stage: string; label: string; encoder: string }) => void): () => void
      onRetry(cb: (d: { reason: string; encoderLabel?: string }) => void): () => void
      onNotice(cb: (d: { message: string }) => void): () => void
      onDone(cb: (d: DonePayload) => void): () => void
      onError(cb: (d: { message: string; title?: string; steps?: string[]; log?: string }) => void): () => void
      onCancelled(cb: () => void): () => void
      presets: {
        list(): Promise<PresetResult>
        save(preset: Preset): Promise<PresetResult>
        remove(id: string): Promise<PresetResult>
        export(): Promise<PresetResult>
        import(): Promise<PresetResult>
      }
      history: {
        list(): Promise<HistoryResult>
        clear(): Promise<HistoryResult>
      }
      windowControls?: WindowControls
    }
  }

  interface WindowControls {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    onMaximizedChange(cb: (maximized: boolean) => void): () => void
  }
}

export {}

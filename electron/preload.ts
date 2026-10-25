import { contextBridge, ipcRenderer, webUtils } from 'electron'

function sub(channel: string, cb: (data: unknown) => void): () => void {
  const handler = (_e: unknown, data: unknown) => cb(data)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

/**
 * 取文件真实路径。
 *
 * 为什么必须在 preload 这一侧取：webUtils.getPathForFile 认的是"这个 File 是不是浏览器
 * 自己创建的那一个"。File 一旦经 contextBridge 传进渲染层就变成了克隆体，再传回来
 * 已经认不出原对象，只能拿到空字符串（实测打包版里拖拽/选择文件全加不进来）。
 * 所以拖放与文件选择的监听都放在这里：DOM 是共享的，事件在这一侧拿到的是原始 File。
 */
function pathsOf(fileList: FileList | null | undefined): string[] {
  if (!fileList) return []
  const out: string[] = []
  for (const f of Array.from(fileList)) {
    try {
      const p = webUtils.getPathForFile(f)
      if (p) out.push(p)
    } catch {
      /* 单个文件取不到就跳过，不影响其余 */
    }
  }
  return out
}
function reportFiles(paths: string[]): void {
  if (paths.length) ipcRenderer.send('files:picked', paths)
}

window.addEventListener(
  'drop',
  (e) => {
    const ev = e as DragEvent
    ev.preventDefault()
    reportFiles(pathsOf(ev.dataTransfer?.files))
  },
  true
)

window.addEventListener(
  'change',
  (e) => {
    const t = e.target as HTMLInputElement | null
    if (!t || t.tagName !== 'INPUT' || t.type !== 'file') return
    reportFiles(pathsOf(t.files))
  },
  true
)

const api = {
  probe: (p: string) => ipcRenderer.invoke('video:probe', p),
  startRender: (params: unknown) => ipcRenderer.invoke('render:start', params),
  cancelRender: () => ipcRenderer.invoke('render:cancel'),
  pickVideo: () => ipcRenderer.invoke('dialog:open-video'),
  pickOutput: (defaultPath: string) => ipcRenderer.invoke('dialog:save-output', defaultPath),
  pickDir: () => ipcRenderer.invoke('dialog:pick-dir'),
  // 拖拽进来的路径要显式登记一次：这是"用户亲手把它放进队列"的服务端凭据，
  // 应用内 REST / Agent 没有这一步就过不去路径归属判定。
  registerFiles: (paths: string[]) => ipcRenderer.invoke('files:register', paths),
  apiStatus: () => ipcRenderer.invoke('api:status'),
  showInFolder: (p: string) => ipcRenderer.invoke('shell:show-in-folder', p),
  getMeta: () => ipcRenderer.invoke('app:meta'),
  /** 拖放/文件选择得到的真实路径（由上面两个监听转上来，绕开 File 跨桥克隆的问题） */
  onFilesPicked: (cb: (paths: string[]) => void) => sub('files:picked', (d) => cb(Array.isArray(d) ? (d as string[]) : [])),
  onProgress: (cb: (d: unknown) => void) => sub('render:progress', cb),
  onStage: (cb: (d: unknown) => void) => sub('render:stage', cb),
  onRetry: (cb: (d: unknown) => void) => sub('render:retry', cb),
  onNotice: (cb: (d: unknown) => void) => sub('render:notice', cb),
  onDone: (cb: (d: unknown) => void) => sub('render:done', cb),
  onError: (cb: (d: unknown) => void) => sub('render:error', cb),
  onCancelled: (cb: () => void) => sub('render:cancelled', cb),
  onApiState: (cb: (data: unknown) => void) => sub('api:state', cb),
  // 预设与历史都落在主进程的本机 JSON 里：导出拿到的是真文件，重启也还在
  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    save: (preset: unknown) => ipcRenderer.invoke('presets:save', preset),
    remove: (id: string) => ipcRenderer.invoke('presets:remove', id),
    export: () => ipcRenderer.invoke('presets:export'),
    import: () => ipcRenderer.invoke('presets:import')
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: async () => (await ipcRenderer.invoke('window:toggle-maximize')) === true,
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: async () => (await ipcRenderer.invoke('window:is-maximized')) === true,
    onMaximizedChange: (cb: (maximized: boolean) => void) =>
      sub('window:maximized', (data) => cb(data === true))
  }
}

contextBridge.exposeInMainWorld('api', api)

import { contextBridge, ipcRenderer, webUtils } from 'electron'

function sub(channel: string, cb: (data: unknown) => void): () => void {
  const handler = (_e: unknown, data: unknown) => cb(data)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

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
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
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

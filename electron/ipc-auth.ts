// IPC 发送方校验 —— 主进程收到的每一条 invoke 都要先问"这是不是我自己的渲染进程发来的"。
//
// 为什么必须有：本应用的 BrowserWindow 是 sandbox:false（preload 要用完整的 electron API），
// 渲染层一旦被 XSS，攻击者拿到的就是 ipcRenderer.invoke 的全套能力 —— 选盘、写文件、起 ffmpeg。
// 校验点在主进程这一侧：不认 sender.id 与 frame URL 的一律拒，并且拒的时候留下一行日志，
// 这样"被拒"本身是可查的事，不是界面上一句没来由的失败。
import path from 'node:path'

export interface SenderLike {
  id: number
  mainFrame?: { url?: string } | null
}

export interface IpcEventLike {
  sender: SenderLike
  senderFrame?: { url?: string } | null
}

export interface SenderPolicy {
  /** 唯一可信窗口：BrowserWindow.webContents.id */
  trustedIds: number[]
  /** 允许的 frame URL 前缀（dev 的 http://localhost:5173/ 与生产的 file:///…/dist-renderer/） */
  allowedUrlPrefixes: string[]
}

export interface Verdict {
  ok: boolean
  code?: string
  message?: string
}

export function frameUrlOf(event: IpcEventLike): string {
  return String(event?.senderFrame?.url ?? event?.sender?.mainFrame?.url ?? '')
}

export function checkIpcSender(event: IpcEventLike | undefined, policy: SenderPolicy): Verdict {
  if (!event || typeof event !== 'object' || !event.sender) {
    return { ok: false, code: 'NO_SENDER', message: 'IPC 事件缺少发送方，已拒绝' }
  }
  if (!policy.trustedIds.includes(event.sender.id)) {
    return { ok: false, code: 'UNTRUSTED_SENDER', message: `来自未知发送方（webContents#${event.sender.id}）的 IPC 调用，已拒绝` }
  }
  const url = frameUrlOf(event)
  if (!url) {
    return { ok: false, code: 'NO_FRAME_URL', message: 'IPC 调用取不到 frame URL，无法确认来源，已拒绝' }
  }
  const normalized = url.replace(/\\/g, '/').toLowerCase()
  const ok = policy.allowedUrlPrefixes.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, '/').toLowerCase()))
  if (!ok) {
    return { ok: false, code: 'FRAME_NOT_ALLOWED', message: `IPC 调用来自未允许的页面地址（${url.slice(0, 160)}），已拒绝` }
  }
  return { ok: true }
}

/**
 * 造一个包住 ipcMain.handle 的守卫：校验不过就不执行 handler，
 * 返回一句结构化拒绝（界面能显示、日志能查），而不是抛异常把主进程拖崩。
 */
export function createIpcAuthorizer(getPolicy: () => SenderPolicy) {
  return function assertSender(event: IpcEventLike | undefined, channel: string): Verdict {
    const verdict = checkIpcSender(event, getPolicy())
    if (!verdict.ok) console.log(`[frameboost-ipc] 拒绝 ${channel}：${verdict.message}`)
    return verdict
  }
}

/** 生产页面在 dist-renderer 下，dev 页面在 vite 的 http 地址下：两条前缀就是全部合法来源 */
export function allowedUrlPrefixesFor(opts: { appDir: string; devUrl?: string | null }): string[] {
  const prefixes: string[] = []
  if (opts.devUrl) {
    try {
      const u = new URL(opts.devUrl)
      prefixes.push(`${u.protocol}//${u.host}/`.toLowerCase())
    } catch {
      /* dev URL 不合法就不加 */
    }
  }
  // 生产：只允许应用自己目录里的那份 HTML，不给 file:// 全盘开口
  const appDir = path.resolve(opts.appDir).replace(/\\/g, '/').toLowerCase()
  prefixes.push(appDir.endsWith('/') ? appDir : `${appDir}/`)
  return prefixes
}

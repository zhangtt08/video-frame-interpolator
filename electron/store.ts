// 本机 JSON 持久化：预设与历史任务。原子写（tmp + rename），读失败一律回退到初值而不抛。
// 与桌面 UI / Agent 共用同一份判据，避免「界面记了一份、主进程记了一份」的漂移。
import fs from 'node:fs'
import path from 'node:path'

export interface StoreDeps {
  /** 读取文件文本；不存在返回 null */
  read(file: string): string | null
  /** 原子写入；失败抛错由调用方归因 */
  write(file: string, text: string): void
}

const defaultDeps: StoreDeps = {
  read(file) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  write(file, text) {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
    } catch (e) {
      // 替换失败时保留旧文件，不能为了重试先删掉用户的预设与历史。
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      throw e
    }
  }
}

export interface JsonStore<T> {
  file: string
  /** 读并归一；文件缺失/损坏都返回 fallback，且损坏时留下原因供界面说明 */
  load(): { data: T; broken: boolean; reason: string }
  save(data: unknown): void
}

export function makeJsonStore<T>(file: string, fallback: T, deps: StoreDeps = defaultDeps): JsonStore<T> {
  return {
    file,
    load() {
      const text = deps.read(file)
      if (text === null) return { data: fallback, broken: false, reason: '' }
      if (!text.trim()) return { data: fallback, broken: false, reason: '' }
      try {
        return { data: JSON.parse(text) as T, broken: false, reason: '' }
      } catch (e) {
        return {
          data: fallback,
          broken: true,
          reason: e instanceof Error ? e.message : String(e)
        }
      }
    },
    save(data) {
      deps.write(file, JSON.stringify(data, null, 2))
    }
  }
}

/** 把 node 错误码转成一句中文，用于「存不下」的提示 */
export function writeFailureReason(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? ''
  if (code === 'EACCES' || code === 'EPERM') return '配置目录没有写权限，FrameBoost 仍可用，但本次改动不会被记住'
  if (code === 'ENOSPC') return '磁盘已满，无法写入配置文件，请清理后重试'
  return err instanceof Error ? err.message : String(err)
}

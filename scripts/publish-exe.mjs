// 打包收尾：把 release/FrameBoost.exe 挪到仓库根目录（用户双击即用的那一份），
// 然后删掉 release/ 里的中间产物，避免仓库里同时躺着两份 130MB 的 exe。
// 由 `npm run dist` 自动调用，也可以单独跑 `node scripts/publish-exe.mjs`。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const built = path.join(root, 'release', 'FrameBoost.exe')
const target = path.join(root, 'FrameBoost.exe')

if (!fs.existsSync(built)) {
  console.error(`[publish] 没有找到打包产物：${built}`)
  console.error('[publish] 先跑 npm run dist（或 electron-builder --win portable）')
  process.exit(1)
}

const size = fs.statSync(built).size
fs.copyFileSync(built, target)
console.log(`[publish] ${(size / 1024 / 1024).toFixed(1)} MB -> FrameBoost.exe（仓库根目录，双击即用）`)

// release/ 只留打包器自己的日志，中间目录与重复 exe 都清掉
const releaseDir = path.join(root, 'release')
for (const name of ['win-unpacked', 'FrameBoost.exe', 'builder-debug.yml', 'builder-effective-config.yaml']) {
  const p = path.join(releaseDir, name)
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch (e) {
    console.warn(`[publish] 未能清理 ${name}：${e instanceof Error ? e.message : String(e)}`)
  }
}
try {
  if (fs.existsSync(releaseDir) && fs.readdirSync(releaseDir).length === 0) fs.rmdirSync(releaseDir)
} catch {
  /* 留着空目录也不影响 */
}
console.log('[publish] release/ 中间产物已清理')

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// CSP：交付给用户的每一份 HTML 都必须带，缺了它等于渲染层一旦被注入脚本就能任意外连。
//
// 为什么写在构建期而不是直接写进 index.html —— 这条是实测出来的，不是嫌麻烦：
//   dev 模式 @vitejs/plugin-react 会往 HTML 里注入一段内联 <script>（react-refresh 引导），
//   `script-src 'self'` 会把它拦掉，HMR 直接白屏。所以下面按命令给两套：
//   · build（交付的那一份）：script-src 'self'，不带任何 unsafe-*；
//   · serve（开发者本机临时页面）：script-src 'self' 'unsafe-inline'，只放开被实测需要的那一条。
// 生产页面的 CSP 由构建产物保证 —— dist-renderer/index.html 里那条 meta 才是发给用户的东西。
//
// style-src 里的 'unsafe-inline' 是量出来的：src/App.tsx 有 2 处 `style={{ width: ... }}`
// （进度条宽度），内联 style 属性在没有 'unsafe-inline' 时不会生效，界面会少掉进度条。
//
// frame-ancestors 故意不写：本页面是 file:// 加载的，这条指令通过 <meta> 交付时浏览器一律忽略，
// 每次启动都会在控制台留一条 error（实测）。真正需要防嵌套的话只能靠响应头，而 file:// 没有响应头，
// 所以这里不留一条"看起来有、实际没生效"的指令。
const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

const CSP_DEV = CSP_PROD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")

function csp(mode: 'build' | 'serve'): Plugin {
  const content = mode === 'build' ? CSP_PROD : CSP_DEV
  return {
    name: `frameboost:csp-${mode}`,
    apply: mode,
    transformIndexHtml(html) {
      // 直接往 HTML 字符串里插，而不是用 tag/attrs 交给 vite 序列化：
      // vite 会把 'self' 里的单引号转成 &#39;，浏览器能解码，但交付物与校验脚本里
      // 读到的是一串实体（test-guard 正是照原文比对的），所以这里保留原样。
      const meta = `<meta http-equiv="Content-Security-Policy" content="${content}" />`
      return html.replace(/<head[^>]*>/i, (head) => `${head}\n    ${meta}`)
    }
  }
}

export default defineConfig({
  plugins: [react(), csp('build'), csp('serve')],
  base: './',
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    target: 'chrome120'
  },
  server: {
    port: 5173,
    strictPort: true
  }
})

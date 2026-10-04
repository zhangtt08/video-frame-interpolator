// pipeline.ts 纯函数单元测试：node scripts/test-pipeline.mjs
// 需先编译：npm run build:electron
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const P = require('../dist-electron/pipeline.js')

let failed = 0
let total = 0

function eq(actual, expected, name) {
  total++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok - ${name}`)
  } else {
    failed++
    console.error(`  FAIL - ${name}\n    expected: ${e}\n    actual:   ${a}`)
  }
}

function info(over = {}) {
  return {
    path: 'C:\\v\\a.mp4',
    fileName: 'a.mp4',
    sizeBytes: 1000,
    durationSec: 3,
    width: 640,
    height: 360,
    fps: 30,
    avgFps: 30,
    fpsRational: '30/1',
    pixFmt: 'yuv420p',
    videoCodec: 'h264',
    videoStreamIndex: 0,
    colorPrimaries: '',
    colorTrc: '',
    colorSpace: '',
    hasAudio: true,
    audioCodec: 'aac',
    ...over
  }
}

function params(over = {}) {
  return {
    inputPath: 'C:\\v\\a.mp4',
    outputPath: 'C:\\v\\a_60fps.mp4',
    targetFps: 60,
    mode: 'balanced',
    quality: 'high',
    useNvenc: true,
    container: 'mp4',
    ...over
  }
}

console.log('== sanitizeRational ==')
eq(P.sanitizeRational('30000/1001', 0), '30000/1001', '正常有理数保留')
eq(P.sanitizeRational('0/0', 29.97), '30', '0/0 回退数值')
eq(P.sanitizeRational('', 0), '', '无效且无回退')
eq(P.sanitizeRational('90000/1', 0), '', 'timebase 误报(>480fps)拒绝')
eq(P.sanitizeRational('30/1', 0), '30/1', '常规 30fps')
eq(P.sanitizeRational('240/1', 0), '240/1', '240fps 高速摄影合法')

console.log('== pixFmtFor ==')
eq(P.pixFmtFor('yuv420p10le', true), { fmt: 'yuv420p10le', downgraded: false }, '10bit 且支持 → 保持')
eq(P.pixFmtFor('yuv420p10le', false), { fmt: 'yuv420p', downgraded: true }, '10bit 不支持 → 降级 8bit')
eq(P.pixFmtFor('yuv420p', false), { fmt: 'yuv420p', downgraded: false }, '8bit 不受影响')

console.log('== buildFilter ==')
const fBal = P.buildFilter(params({ mode: 'balanced' }), info(), true)
eq(
  fBal,
  'fps=30/1,tpad=stop_mode=clone:stop_duration=1,minterpolate=fps=60:mi_mode=mci:mc_mode=obmc:me_mode=bidir:vsbmc=0,trim=duration=3.000,format=yuv420p',
  '均衡模式：fps归一→tpad→minterpolate→trim→format'
)
const fHigh = P.buildFilter(params({ mode: 'high' }), info(), true)
eq(
  /minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1/.test(fHigh),
  true,
  '精细模式 AOBMC+vsbmc'
)
const fFast = P.buildFilter(params({ mode: 'fast' }), info(), true)
eq(
  fFast,
  'tpad=stop_mode=clone:stop_duration=1,framerate=fps=60,trim=duration=3.000,format=yuv420p',
  '快速模式：tpad→framerate→trim→format'
)
const f10 = P.buildFilter(params({ mode: 'balanced' }), info({ pixFmt: 'yuv420p10le' }), true)
eq(/format=yuv420p10le$/.test(f10), true, '10bit 源输出 10bit')
const f8 = P.buildFilter(params({ mode: 'balanced' }), info({ pixFmt: 'yuv420p10le' }), false)
eq(/format=yuv420p$/.test(f8), true, '10bit 源降级输出 8bit')
const fNoDur = P.buildFilter(params(), info({ durationSec: 0 }), true)
eq(/tpad/.test(fNoDur), false, '无时长时不加 tpad')
const fVfr = P.buildFilter(params(), info({ fpsRational: '90000/1', fps: 0, avgFps: 29.97 }), true)
eq(/^fps=30,/.test(fVfr), true, 'VFR 误报帧率回退 avgFps 归一化')

console.log('== encoderArgs / 画质三档 ==')
eq(P.encoderArgs('none', 'master'), ['-c:v', 'libx264', '-preset', 'slow', '-crf', '10'], '母版级 CRF10')
eq(P.encoderArgs('none', 'high'), ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16'], '高画质 CRF16')
eq(P.encoderArgs('none', 'standard'), ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'], '标准 CRF20')
eq(
  P.encoderArgs('modern', 'high'),
  ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
  'NVENC modern p6'
)
eq(
  P.encoderArgs('legacy', 'standard'),
  ['-c:v', 'h264_nvenc', '-preset', 'llhq', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
  'NVENC legacy llhq'
)

console.log('== planAttempts ==')
const pNv = P.planAttempts(params(), 'modern', true)
eq(pNv.length, 3, 'NVENC 可用 → 3 级尝试')
eq(pNv[0], { nvenc: 'modern', audio: 'copy' }, '首选 NVENC+音轨直写')
eq(pNv[2], { nvenc: 'none', audio: 'aac' }, '末级 AAC 重编码')
eq(P.planAttempts(params(), 'none', true).length, 2, '无 NVENC → 2 级尝试')
eq(P.planAttempts(params(), 'modern', false).length, 2, '10bit 输出 → 跳过 NVENC')
eq(P.planAttempts(params({ useNvenc: false }), 'modern', true).length, 2, '关闭硬解 → 跳过 NVENC')

console.log('== resolveOutputPath ==')
const exists1 = () => false
eq(P.resolveOutputPath('C:\\v\\a_60fps.mp4', exists1), 'C:\\v\\a_60fps.mp4', '不冲突原样返回')
const taken = new Set(['C:\\v\\a_60fps.mp4', 'C:\\v\\a_60fps (1).mp4'])
eq(
  P.resolveOutputPath('C:\\v\\a_60fps.mp4', (p) => taken.has(p)),
  'C:\\v\\a_60fps (2).mp4',
  '重名自动 (2) 后缀'
)

console.log('== buildArgs ==')
const args = P.buildArgs(params(), info(), { nvenc: 'none', audio: 'copy' }, true)
eq(args[0], '-y', '首参 -y')
eq(args.includes('-nostdin'), true, '包含 -nostdin')
eq(args.includes('-progress'), true, '包含 -progress')
eq(args.includes('0:a:0?'), true, '音轨可选映射')
eq(
  args.includes('fps=30/1,tpad=stop_mode=clone:stop_duration=1,minterpolate=fps=60:mi_mode=mci:mc_mode=obmc:me_mode=bidir:vsbmc=0,trim=duration=3.000,format=yuv420p'),
  true,
  '滤镜链完整'
)
eq(args[args.length - 1], 'C:\\v\\a_60fps.mp4.part', '输出为 .part 文件')
eq(args.includes('mov'), true, 'mp4 → mov 封装器')
const argsMkv = P.buildArgs(params({ container: 'mkv' }), info(), { nvenc: 'none', audio: 'aac' }, true)
eq(argsMkv.includes('matroska'), true, 'mkv → matroska 封装器')
eq(argsMkv.includes('192k'), true, 'AAC 时带码率')
eq(argsMkv.includes('+faststart'), false, 'mkv 无 faststart')
const argsColor = P.buildArgs(
  params(),
  info({ colorPrimaries: 'bt2020', colorTrc: 'smpte2084', colorSpace: 'bt2020nc' }),
  { nvenc: 'none', audio: 'copy' },
  true
)
eq(
  argsColor.includes('-color_primaries') && argsColor.includes('bt2020') && argsColor.includes('smpte2084'),
  true,
  'HDR 色彩元数据透传'
)

console.log('== encoderLabel ==')
eq(P.encoderLabel('none'), 'CPU · libx264', 'CPU 标签')
eq(P.encoderLabel('modern'), 'NVIDIA NVENC · H.264', 'NVENC 标签')

console.log('== stageLabel / isTerminalStage ==')
eq(P.stageLabel('encode'), '补帧编码', '编码阶段中文标签')
eq(P.stageLabel('preflight'), '能力与磁盘预检', '预检阶段中文标签')
eq(P.isTerminalStage('done'), true, 'done 是终态')
eq(P.isTerminalStage('encode'), false, 'encode 不是终态')
eq(P.isTerminalStage('cancelled'), true, 'cancelled 是终态')

console.log('== applyProgressLine / percentFor / etaSeconds：进度只认 ffmpeg 报的数 ==')
const st0 = P.createProgressState()
eq(P.applyProgressLine(st0, 'out_time_us=1500000'), true, 'out_time_us 被采纳')
eq(st0.outTimeSec, 1.5, '1500000us = 1.5s')
eq(P.applyProgressLine(st0, 'out_time_ms=2000000'), true, 'out_time_ms 其实也是微秒（ffmpeg 历史遗留）')
eq(st0.outTimeSec, 2, '按微秒换算，不当毫秒')
eq(P.applyProgressLine(st0, 'frame=120'), true, '帧数')
eq(st0.frame, 120, 'frame 落到状态')
eq(P.applyProgressLine(st0, 'fps=59.88'), true, '实时处理帧率')
eq(P.applyProgressLine(st0, 'speed=1.85x'), true, '倍速去掉尾部 x')
eq(st0.speed, 1.85, 'speed 解析成数字')
eq(P.applyProgressLine(st0, 'speed=N/A'), false, 'N/A 不当数字用')
eq(P.applyProgressLine(st0, 'bitrate=1200kbits/s'), false, '未知字段忽略')
eq(P.applyProgressLine(st0, 'progress=continue'), false, 'continue 不算结束')
eq(P.applyProgressLine(st0, 'no-equals-sign'), false, '没有等号的行拒绝')
eq(P.applyProgressLine(st0, 'out_time_us=-5'), false, '负时长拒绝')
eq(P.applyProgressLine(st0, 'frame=abc'), false, '坏帧数值不污染状态')
eq(st0.frame, 120, '坏值没改动已有 frame')
eq(P.percentFor(st0, 3, true), (2 / 3) * 100, '百分比直接来自 out_time')
const stRun = P.createProgressState()
P.applyProgressLine(stRun, 'out_time_us=99900000')
eq(P.percentFor(stRun, 100, true), 99.5, '运行中上限 99.5，不谎报 100')
eq(P.percentFor(stRun, 100, false), 99.9, '非运行态按实际值给，不凑整')
const stEnd = P.createProgressState()
P.applyProgressLine(stEnd, 'progress=end')
eq(stEnd.endSeen, true, 'progress=end 记录在案')
eq(P.percentFor(stEnd, 10, true), 100, '收到 end 才给 100')
const stEta = P.createProgressState()
P.applyProgressLine(stEta, 'out_time_us=10000000')
P.applyProgressLine(stEta, 'speed=2x')
eq(P.etaSeconds(stEta, 30), 10, '剩余 = (30-10)/2 = 10s')
const stNoSpeed = P.createProgressState()
P.applyProgressLine(stNoSpeed, 'out_time_us=1000000')
eq(P.etaSeconds(stNoSpeed, 30), null, 'ffmpeg 没报 speed 时不猜剩余')
eq(P.etaSeconds(stEta, 0), null, '时长未知时不猜剩余')
eq(P.percentFor(P.createProgressState(), 0, true), 0, '时长 0 不除零、不出 NaN')

console.log('== classifyFailure：每种错误都要给得出下一步 ==')
const fNospc = P.classifyFailure({ code: 'ENOSPC', message: 'no space left' })
eq(fNospc.title.includes('磁盘'), true, '磁盘满有专属结论')
eq(fNospc.steps.length >= 2, true, '磁盘满给了多条下一步')
eq(P.classifyFailure({ stderr: 'x264 [error]: no encoder', message: '' }).title, '补帧处理失败', '泛 stderr 不误判成编码器缺失')
const fEnc = P.classifyFailure({ stderr: "Unknown encoder 'h264_nvenc'", message: '' })
eq(fEnc.title, '编码器不可用', '编码器缺失单独归因')
eq(/硬件加速|NVENC|FFMPEG_PATH/.test(fEnc.steps.join(' ')), true, '编码器缺失提到了硬解/驱动/ffmpeg 路径')
const fCorrupt = P.classifyFailure({ stderr: 'Invalid data found when processing input', message: '' })
eq(fCorrupt.title, '源文件损坏或不是有效视频', '损坏源单独归因')
eq(/重新|ffmpeg|播放器/.test(fCorrupt.steps.join(' ')), true, '损坏源给了可执行的修复动作')
eq(P.classifyFailure({ code: 'EACCES', message: 'x' }).title, '没有读写权限', '权限错误归因')
eq(P.classifyFailure({ code: 'EROFS', message: 'x' }).title, '目标磁盘是只读的', '只读盘归因')
eq(P.classifyFailure({ code: 'ENAMETOOLONG', message: 'x' }).title, '路径过长', '长路径归因')
eq(P.classifyFailure({ code: 'ENOTDIR', message: 'x' }).steps.length > 0, true, 'ENOTDIR 也有下一步')
eq(P.classifyFailure({ code: 'NO_VIDEO_STREAM', message: '未找到视频流' }).title, '这个文件里没有视频流', '无视频流归因')
eq(P.classifyFailure({ code: 'EMPTY_FILE', message: '0 字节' }).title, '文件是空的（0 字节）', '空文件归因')
const fTfps = P.classifyFailure({ code: 'BAD_TARGET_FPS', message: '目标帧率需高于原帧率（原 30 fps）' })
eq(fTfps.title, '目标帧率没有高于源帧率', '帧率校验有专属结论')
eq(fTfps.detail.includes('30 fps'), true, '真实数字保留在 detail 里')
eq(P.classifyFailure({ code: 'SAME_PATH', message: 'x' }).title, '输出路径和输入是同一个文件', '不许覆盖源文件')
eq(P.classifyFailure({ code: 'BAD_OUTPUT_EXT', message: 'x' }).title, '输出封装格式不支持', '后缀校验结论')
eq(P.classifyFailure({ stage: 'probe', message: 'ffprobe 解析失败：moov atom not found' }).title, '源文件损坏或不是有效视频', 'probe 失败按 stderr 特征判')
eq(P.classifyFailure({ stage: 'probe', message: 'ffprobe 解析失败：啥也没说' }).title, '无法读取视频信息', 'probe 阶段的兜底结论')
const fUnknown = P.classifyFailure({ message: '完全没见过的错' })
eq(fUnknown.steps.length >= 3, true, '兜底分支也必须给得出下一步，不许只说一句「失败了」')
eq(P.classifyFailure({ code: 'eacces', message: 'x' }).title, '没有读写权限', '错误码大小写不敏感')
eq(P.errorCodeOf(Object.assign(new Error('x'), { code: 'enoent' })), 'ENOENT', 'errorCodeOf 归一大写')
eq(P.errorCodeOf(new Error('x')), null, '无 code 返回 null')
eq(P.failureFrom(Object.assign(new Error('boom'), { code: 'EROFS' })).title, '目标磁盘是只读的', 'failureFrom 走同一个归因入口')

console.log('== pathNamingProblem：中文与空格不是问题 ==')
eq(P.pathNamingProblem('C:\\视频 素材\\第 1 集.mp4'), null, '中文+空格放行：子进程走 argv，不经 cmd 解释')
eq(P.pathNamingProblem('C:\\v\\a_60fps.mkv'), null, '常规路径无问题')
eq(P.pathNamingProblem('C:\\v\\CON.mp4'), '文件名「CON」是 Windows 保留名，不能用作输出', '保留名被拦')
eq(P.pathNamingProblem('C:\\v\\nul.mp4'), '文件名「nul」是 Windows 保留名，不能用作输出', '保留名大小写不敏感')
eq(/长度/.test(P.pathNamingProblem('C:\\v\\' + 'x'.repeat(260))), true, '超长被拦')
eq(/非法字符/.test(P.pathNamingProblem('C:\\v\\a<b>.mp4')), true, '非法字符被拦')
eq(P.pathNamingProblem(''), '路径为空', '空路径')
eq(/结尾/.test(P.pathNamingProblem('C:\\v\\a.')), true, '以点结尾被拦')
eq(P.LONG_PATH_LIMIT < 260, true, '长路径阈值留了安全边界')

console.log('== estimateOutputBytes / formatBytes ==')
const estMaster = P.estimateOutputBytes(info(), 60, 'master')
const estStd = P.estimateOutputBytes(info(), 60, 'standard')
eq(estMaster > estStd, true, '母版级预估比标准档大')
eq(estStd > 0, true, '预估值恒为正')
eq(P.estimateOutputBytes(info({ durationSec: 0 }), 60, 'high'), 0, '0 时长 → 0 预估')
eq(P.estimateOutputBytes(info({ hasAudio: false }), 60, 'high') < P.estimateOutputBytes(info(), 60, 'high'), true, '无音轨预估更小')
eq(P.formatBytes(0), '0 B', '0 字节')
eq(P.formatBytes(1024 * 1024 * 1024), '1.0 GB', 'GB 一档')
eq(P.formatBytes(1500), '1.5 KB', 'KB 一档')
eq(P.DISK_HEADROOM > 1, true, '空间预检留了余量，不是刚好卡平')

console.log('== 预设：归一化 / 合并 / 导入导出 ==')
eq(P.BUILTIN_PRESETS.length >= 4, true, '至少 4 条内置预设')
eq(P.BUILTIN_PRESETS.every((p) => P.normalizePreset(p) !== null), true, '内置预设全部合法')
eq(P.normalizePreset({ name: 'x', mode: 'weird', quality: 'high', container: 'mp4' }), null, '未知 mode 直接拒绝')
eq(P.normalizePreset({ name: 'x', mode: 'fast', quality: 'nope', container: 'mp4' }), null, '未知 quality 拒绝')
eq(P.normalizePreset('nope'), null, '非对象拒绝')
const np = P.normalizePreset({ name: '我的档', mode: 'fast', quality: 'standard', container: 'mkv', multiplier: 3, customFps: 120 })
eq(np.name, '我的档', '名字保留')
eq(np.builtin, false, '未声明就不是内置')
eq(P.normalizePreset({ name: 'a', mode: 'high', quality: 'high', container: 'mp4', customFps: 99999 }).customFps, 60, '越界 customFps 回落 60')
eq(P.normalizePreset({ name: 'a', mode: 'high', quality: 'high', container: 'mp4', multiplier: 7 }).multiplier, 2, '非法倍率回落 2')
eq(P.sanitizePresetName('  带' + String.fromCharCode(0) + '控制符和<尖括号>与*星号  '), '带控制符和尖括号与星号', '预设名洗掉控制字符与非法字符并 trim')
eq(P.sanitizePresetName('x'.repeat(60)).length, P.PRESET_NAME_MAX, '预设名长度有上限')
const merged = P.mergePresetList([
  { id: 'u1', name: P.BUILTIN_PRESETS[0].name, mode: 'fast', quality: 'standard', container: 'mp4', multiplier: 2, customFps: 60 },
  { id: 'u1', name: '重名档', mode: 'fast', quality: 'standard', container: 'mp4', multiplier: 2, customFps: 60 },
  { id: 'u2', name: '重名档', mode: 'balanced', quality: 'high', container: 'mkv', multiplier: 3, customFps: 90 },
  { id: 'u3', name: '伪装内置', mode: 'fast', quality: 'standard', container: 'mp4', multiplier: 2, customFps: 60, builtin: true }
])
eq(merged.slice(0, P.BUILTIN_PRESETS.length), P.BUILTIN_PRESETS, '内置预设原样排在最前')
eq(merged.length, P.BUILTIN_PRESETS.length + 3, '自称内置的那条被丢弃，其余三条保留')
eq(new Set(merged.map((p) => p.id)).size, merged.length, 'id 不重复')
eq(new Set(merged.map((p) => p.name)).size, merged.length, '同名自动加尾号，不互相顶掉')
eq(merged.filter((p) => p.builtin).length, P.BUILTIN_PRESETS.length, '用户预设永远拿不到 builtin 标记')
eq(P.mergePresetList(null).length, P.BUILTIN_PRESETS.length, '坏输入只剩内置')
const many = Array.from({ length: 80 }, (_, i) => ({ id: 'x' + i, name: 'p' + i, mode: 'fast', quality: 'high', container: 'mp4', multiplier: 2, customFps: 60 }))
eq(P.mergePresetList(many).length - P.BUILTIN_PRESETS.length, P.MAX_USER_PRESETS, '自定义预设数量有上限')
eq(P.targetFpsForPreset({ multiplier: 2, customFps: 60 }, 29.97), 60, '×2 按源帧率取整')
eq(P.targetFpsForPreset({ multiplier: 0, customFps: 120 }, 29.97), 120, '倍率 0 时用绝对帧率')
eq(P.targetFpsForPreset({ multiplier: 2, customFps: 60 }, 0), 0, '源帧率缺失返回 0，不猜')
eq(P.targetFpsForPreset({ multiplier: 4, customFps: 60 }, 200), 0, '超过 MAX_FPS 判为不可用')
const roundTrip = P.parsePresets(P.serializePresets(merged))
eq(roundTrip.presets.length, merged.length - P.BUILTIN_PRESETS.length, '导出只含自定义预设，导入原样回来')
eq(roundTrip.presets.every((p) => p.builtin === false), true, '导入后一律按用户预设对待')
eq(P.parsePresets('not json').error !== undefined, true, '坏 JSON 说得出原因')
eq(P.parsePresets('').error !== undefined, true, '空文件说得出原因')
eq(P.parsePresets('{"foo":1}').error !== undefined, true, '缺 presets 数组说得出原因')
eq(P.parsePresets('[{"name":"ok","mode":"fast","quality":"high","container":"mp4"},{"mode":"nope"}]').rejected, 1, '坏项计数如实')
eq(/kind/.test(P.serializePresets([])), true, '导出带 kind/version 标记，便于以后演进而不靠猜')

console.log('== 历史任务归一化 ==')
const now = Date.now()
const hist = P.normalizeHistory([
  { id: 'a', inputPath: 'C:\\v\\a.mp4', outputPath: 'C:\\v\\a_60fps.mp4', finishedAt: now - 1000, ok: true, sizeBytes: 10 },
  { id: 'b', inputPath: 'C:\\v\\b.mp4', outputPath: 'C:\\v\\b_60fps.mp4', finishedAt: now, ok: false, error: '源文件损坏', errorSteps: ['先看日志'] },
  { inputPath: '', outputPath: 'x', finishedAt: now },
  { id: 'd', inputPath: 'C:\\v\\d.mp4', outputPath: 'C:\\v\\d.mp4', finishedAt: 0 },
  null,
  'string'
])
eq(hist.length, 2, '缺关键字段或时间戳为 0 的项被丢弃')
eq(hist[0].id, 'b', '按完成时间倒序，最新在前')
eq(hist[1].ok, true, '成功标记如实保留')
eq(P.normalizeHistory('nope').length, 0, '非数组返回空而不是抛')
const manyHist = Array.from({ length: 300 }, (_, i) => ({ id: 'h' + i, inputPath: 'C:\\v.mp4', outputPath: 'C:\\o.mp4', finishedAt: now + i, ok: true }))
eq(P.normalizeHistory(manyHist).length, P.MAX_HISTORY, '历史条数有上限，不会无限增长')
eq(P.normalizeHistory(manyHist)[0].id, 'h299', '截断保留的是最新那批')
eq(P.normalizeHistory([{ id: 'x/../y', inputPath: 'C:\\v.mp4', outputPath: 'C:\\o.mp4', finishedAt: now }])[0].id, 'h-' + Math.round(now), '带路径穿越的 id 被换成安全 id')

console.log('== 原子存储：替换失败保留旧数据 ==')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { mock } = require('node:test')
const { makeJsonStore } = require('../dist-electron/store.js')
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameboost-store-'))
try {
  const store = makeJsonStore(path.join(storeDir, 'presets.json'), [])
  store.save([{ name: '旧预设' }])
  const rename = mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }) })
  let caught = false
  try { store.save([{ name: '新预设' }]) } catch { caught = true } finally { rename.mock.restore() }
  eq(caught, true, '替换失败向调用方报告')
  eq(store.load().data, [{ name: '旧预设' }], '旧预设未被删除')
  eq(fs.readdirSync(storeDir), ['presets.json'], '失败临时文件被清理')
  store.save([{ name: '新预设' }])
  eq(store.load().data, [{ name: '新预设' }], '解除占用后可保存')
} finally { fs.rmSync(storeDir, { recursive: true, force: true }) }

console.log(`\n${total - failed}/${total} passed${failed ? `，${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)

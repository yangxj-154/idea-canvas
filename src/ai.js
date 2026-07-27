// AI 客户端：标准 OpenAI 兼容接口，默认 DeepSeek。
// Key / baseURL / model 全部由用户在设置面板填写，仅存本机，应用直连厂商，数据不出机器。
import { webSearch } from './search'

export const DEFAULT_SETTINGS = {
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-v4-pro',
  // 默认保留用户数据（关闭演示模式的每次清空）。需要清空时点「清空画布」。
  resetOnStart: false,
  // 联网搜索：'none' 仅模型知识库 | 'app' 应用侧搜索 API 注入(RAG) | 'model' 模型侧 web_search 工具
  searchMode: 'none',
  searchProvider: 'tavily', // 'tavily' | 'serpapi' | 'bing'
  searchApiKey: '',
  modelWebSearch: false,
}

// 边关系 -> 中文标签
const REL_LABELS = {
  derives: '派生',
  'depends-on': '依赖',
  relates: '相关',
  supports: '支撑',
  contradicts: '矛盾',
}

export function relLabel(rel) {
  return REL_LABELS[rel] || rel || ''
}

// 带超时的 fetch，防止模型名/网络错误导致请求挂死
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `请求超时 (${timeoutMs / 1000}s)，请检查网络、模型名或 Base URL 是否正确。`,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// 基础对话补全
export async function chatCompletion(settings, messages, opts = {}) {
  const { baseURL, apiKey, model } = settings
  if (!apiKey) throw new Error('未配置 API Key，请在设置中填写。')

  // 联网搜索 · 应用侧 RAG：检索实时资料注入 system，让模型基于最新信息回答
  let finalMessages = messages
  const searchMode = settings.searchMode || 'none'
  if (searchMode === 'app' && settings.searchApiKey) {
    const q = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
    if (q) {
      try {
        const ctx = await webSearch(settings.searchProvider, settings.searchApiKey, q)
        if (ctx) {
          finalMessages = [
            {
              role: 'system',
              content: `以下是联网检索到的实时资料，请在回答中优先参考，并在提及处标注来源链接：\n${ctx}`,
            },
            ...messages,
          ]
        }
      } catch (e) {
        // 检索失败不阻断对话，静默退化为纯模型回答
        console.warn('联网检索失败，已退化为纯模型回答：', e)
      }
    }
  }

  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`
  const body = {
    model: model || 'deepseek-v4-pro',
    messages: finalMessages,
    temperature: opts.temperature ?? 0.7,
  }
  if (opts.jsonMode) body.response_format = { type: 'json_object' }
  // 联网搜索 · 模型侧 web_search 工具（需厂商支持，如 OpenAI o 系列；由厂商执行搜索）
  if (searchMode === 'model' && settings.modelWebSearch) {
    body.tools = [{ type: 'web_search' }]
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? 15000,
  )

  if (!res.ok) {
    let detail = ''
    try {
      const errJson = await res.json()
      detail =
        errJson.error?.message ||
        errJson.message ||
        JSON.stringify(errJson).slice(0, 400)
    } catch {
      try {
        detail = (await res.text()).slice(0, 400)
      } catch {
        /* ignore */
      }
    }
    throw new Error(`模型请求失败 (${res.status})：${detail}`)
  }

  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('模型返回为空。')
  return content
}

// 拆解系统提示（全局 idea 模式）
const DECOMPOSE_SYSTEM = `你是"想法拆解助手"。用户会给你一个已确认方向的想法。
请把它拆解成结构化节点树，只输出严格 JSON（不要 markdown 代码块，不要任何解释文字）。
schema：
{
  "root": { "type": "idea", "title": "想法标题", "body": "一句话说明" },
  "children": [
    {
      "type": "direction|step|resource|insight",
      "title": "节点标题",
      "body": "节点说明（可选）",
      "rel": "derives|depends-on|relates|supports|contradicts",
      "children": [ /* 同结构，可嵌套 */ ]
    }
  ]
}
规则：
- type 取值：idea(想法) / direction(方向) / step(步骤) / resource(资料) / insight(洞察)
- rel 表示与父节点的关系：derives(派生) / depends-on(依赖) / relates(相关) / supports(支撑) / contradicts(矛盾)
- 一级方向 2~4 个；每个方向下 2~4 个步骤或资料；可适度补充 insight 洞察节点
- 节点标题简洁（<=20字），body 可空
- 只输出 JSON`

// 拆解系统提示（drill 下钻模式：针对已有卡片）
const DECOMPOSE_DRILL_SYSTEM = `你是"卡片下钻助手"。用户会给你一张画布上已存在的卡片内容。
请把它拆解成下一级子节点，只输出 children 数组（不要 root），严格 JSON（不要 markdown，不要解释）。
schema：
{
  "children": [
    {
      "type": "direction|step|resource|insight",
      "title": "子节点标题",
      "body": "子节点说明（可选）",
      "rel": "derives|depends-on|relates|supports|contradicts",
      "children": [ /* 可继续嵌套 */ ]
    }
  ]
}
规则：
- 这些子节点将直接挂在该卡片下方，成为它的下一级
- type 取值：direction(方向) / step(步骤) / resource(资料) / insight(洞察)
- rel 表示与父卡片的关系
- 子节点 2~4 个，标题简洁（<=20字）
- 只输出 JSON`

// 容错解析：去掉可能的 ```json 包裹，截取首个 { 到末个 }
export function parseTree(text) {
  let raw = (text || '').trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  if (!raw.startsWith('{')) {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1)
  }
  if (!raw) throw new Error('模型未返回可解析的 JSON。')
  const obj = JSON.parse(raw)
  if (obj.root) {
    if (!obj.root.type) obj.root.type = 'idea'
    if (!Array.isArray(obj.children)) obj.children = []
    return obj
  }
  if (Array.isArray(obj.children)) {
    return { root: null, children: obj.children }
  }
  throw new Error('拆解结果缺少 root 或 children。')
}

// 画布优化系统提示（全局模式：更主动地补全缺漏、合并重复）
const OPTIMIZE_SYSTEM = `你是"画布优化助手"。用户会给你当前画布的全部节点与连线。
请审查并改进，宁可多补充也不要遗漏重要角度：
1. 补全缺漏：哪些重要步骤 / 资料 / 洞察缺失，建议在合适的父节点下新增节点（add）。每个方向至少补 1 个具体步骤或资料；如有明显遗漏的关键视角，主动补 insight 洞察节点。
2. 合并重复：内容高度重复的节点，建议合并（merge，给出两个节点 id）。
3. 理顺关系：在 notes 用中文说明调整思路。
只输出严格 JSON（不要 markdown，不要解释文字）：
{
  "add": [ { "parentId": "节点id", "type": "step|resource|direction|insight", "title": "标题", "body": "说明(可选)" } ],
  "merge": [ ["idA","idB"] ],
  "notes": "中文说明"
}`

// 画布优化系统提示（选中卡片模式：深度补全该卡片及其子树）
const OPTIMIZE_NODE_SYSTEM = `你是"卡片深度补全助手"。用户选中了一张卡片（focus）及其相关子树（subgraph），请你围绕这张卡片深度补全缺漏的内容。
要求：
1. 在 focus 卡片本身下，补充它缺失的下一级子节点（add 的 parentId = focus 的 id），类型可为 step / resource / direction / insight。
2. 也可以在其现有子节点下继续补孙节点（parentId 填对应子节点 id）。
3. 只围绕这张卡片相关的内容补全，不要改动其它无关分支。
4. 内容重复的子节点可建议合并（merge）。
只输出严格 JSON（不要 markdown，不要解释文字）：
{
  "add": [ { "parentId": "节点id", "type": "step|resource|direction|insight", "title": "标题", "body": "说明(可选)" } ],
  "merge": [ ["idA","idB"] ],
  "notes": "中文说明"
}`

export function parseOptimize(text) {
  let raw = (text || '').trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  if (!raw.startsWith('{')) {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1)
  }
  if (!raw) throw new Error('模型未返回可解析的 JSON。')
  const obj = JSON.parse(raw)
  return {
    add: Array.isArray(obj.add) ? obj.add : [],
    merge: Array.isArray(obj.merge) ? obj.merge : [],
    notes: obj.notes || '',
  }
}

// 自动关联：AI 识别卡片之间真实存在的实体/关系，返回建议连线
const RELATE_SYSTEM = `你是"实体关联助手"。用户画布上有很多卡片，部分卡片涉及相同的人物、龙名、地点、事件、概念、组织等。请分析这些节点，找出真实存在的关联，并输出需要新增的连线。
只输出严格 JSON（不要 markdown，不要解释文字）：
{
  "edges": [
    { "source": "节点A的id", "target": "节点B的id", "rel": "relates", "reason": "都提到梦火" }
  ]
}
规则：
- source/target 必须是下面 nodes 里的 id
- 只建议确实有实体重叠的关联，避免牵强
- rel 取值：derives|depends-on|relates|supports|contradicts
- 如果已存在同方向连线，不要再建议
- 节点正文里提到的人名、龙名、地点、事件名是主要关联线索`

export function parseRelate(text) {
  let raw = (text || '').trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  if (!raw.startsWith('{')) {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1)
  }
  if (!raw) throw new Error('模型未返回可解析的 JSON。')
  const obj = JSON.parse(raw)
  return Array.isArray(obj.edges) ? obj.edges : []
}

// 生成报告：AI 通读整张画布，产出结构化中文思考报告（纯文本，可含 markdown）
const REPORT_SYSTEM = `你是"画布报告助手"。用户会给你整张画布的全部节点（含类型、内容）与连线。
请基于真实内容生成一份结构化的中文思考报告，只输出纯文本（可用 markdown 标题与列表，不要 JSON，不要代码块包裹）。
报告结构：
# 主题概括
（一句话概括这张画布在思考什么）
# 思路分层
（按"想法 → 方向 → 步骤/资料"逐层说明，体现节点之间的关系与连线）
# 关键洞察
（提炼 2~4 条最有价值的发现或结论）
# 下一步建议
（给出 2~4 条可执行建议）
要求：严格基于画布真实内容，不要编造节点中不存在的信息；语言精炼、有洞察、可直接当作复盘文档。`

// 导入拆解系统提示：把一段"材料"（文章 / 笔记 / 会议纪要 / 聊天记录导出）提炼成图谱
const IMPORT_SYSTEM = `你是"材料结构化助手"。用户会给你一段材料——可能是文章、笔记、会议纪要，或某个 AI 助手（ChatGPT / Claude / DeepSeek / 豆包等）的聊天记录导出文本。
请提炼其中的主题与要点，拆成结构化节点树，只输出严格 JSON（不要 markdown 代码块，不要任何解释文字）。
schema：
{
  "root": { "type": "idea", "title": "核心主题（一句话）", "body": "材料主旨概述" },
  "children": [
    {
      "type": "direction|step|resource|insight",
      "title": "节点标题",
      "body": "节点说明（可选）",
      "rel": "derives|depends-on|relates|supports|contradicts",
      "children": [ /* 同结构，可嵌套 */ ]
    }
  ]
}
规则：
- 归纳成 1 个核心 idea（root），再拆出 2~5 个 direction（主题板块 / 对话主线 / 章节）。
- 每个 direction 下 2~4 个 step / resource / insight：
  - 文章 / 笔记类：按章节或论点组织，resource 放引用与链接，insight 放关键结论。
  - 聊天记录类：按"对话主线 / 关键结论 / 待办事项 / 提到的资料"组织；把对方或自己提到的链接、文档放进 resource，重要的结论放进 insight，约定的动作放进 step。
- type 取值：idea(想法) / direction(方向) / step(步骤) / resource(资料) / insight(洞察)
- rel 表示与父节点的关系：derives(派生) / depends-on(依赖) / relates(相关) / supports(支撑) / contradicts(矛盾)
- 节点标题简洁（<=20字），body 可空；保留材料中的关键实体（人名、地名、概念、链接）。
- 只输出 JSON`

// 导入拆解：把材料 / 聊天记录提炼成节点树（复用 parseTree）
// ============================================================
//  演示模式（无需 API Key）：返回模拟数据，便于直接体验交互
// ============================================================

function isDemo(settings) {
  return !settings || !settings.apiKey
}

// 把一段文本按标点/换行切成若干"要点"
function splitPoints(text) {
  return (text || '')
    .split(/[\n。；;，,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const MOCK_TYPES = ['direction', 'step', 'resource', 'insight']

// 模拟多轮讨论回复（返回结构化数据：text + 标签芯片）
export async function discuss(settings, messages) {
  if (isDemo(settings)) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const topic = (lastUser?.content || '这个想法').slice(0, 40)
    const round = messages.filter((m) => m.role === 'user').length
    const replies = [
      {
        text: `收到！针对「${topic}」，我的分析如下：这是一个多层次的议题，建议用结构化的方式展开：`,
        tags: [
          { type: 'insight', label: '关键洞察' },
          { type: 'direction', label: '技术路径' },
          { type: 'step', label: 'STEP 1 — 数据收集' },
          { type: 'step', label: 'STEP 2 — 建模分析' },
          { type: 'idea', label: '创新点' },
        ],
      },
      {
        text: `关于「${topic}」，我从几个维度补充分析：\n\n1. 核心目标是否足够清晰？\n2. 有哪些关键假设需要验证？\n3. 可参考的资料和竞品有哪些？\n\n建议继续讨论，我会把节点落到右侧画布。`,
        tags: [
          { type: 'insight', label: '核心假设' },
          { type: 'direction', label: '验证路径' },
          { type: 'step', label: 'STEP 1 — 假设验证' },
          { type: 'resource', label: '参考资料' },
          { type: 'idea', label: '差异化' },
        ],
      },
      {
        text: `有意思！我们可以把「${topic}」拆解成几个方向来深入：\n\n每个方向都可以继续展开成具体步骤。你可以说"拆解落图"，节点会自动生长到画布上。`,
        tags: [
          { type: 'insight', label: '机会点' },
          { type: 'direction', label: '方向 A' },
          { type: 'direction', label: '方向 B' },
          { type: 'step', label: 'STEP 1 — 第一步行动' },
          { type: 'idea', label: 'MVP 想法' },
        ],
      },
    ]
    const idx = (round - 1) % replies.length
    await new Promise((r) => setTimeout(r, 500))
    return replies[Math.max(0, idx)]
  }
  // 真实模式：调用 API 获取文本，再附加基于上下文的标签
  const text = await chatCompletion(settings, messages, { temperature: 0.85 })
  const round = messages.filter((m) => m.role === 'user').length
  // 根据轮次生成语义标签（真实模式下标签是辅助性的，主要靠 AI 文本）
  const tagSets = [
    [
      { type: 'insight', label: '关键洞察' },
      { type: 'direction', label: '技术路径' },
      { type: 'step', label: 'STEP 1 — 数据收集' },
      { type: 'step', label: 'STEP 2 — 建模分析' },
      { type: 'idea', label: '创新点' },
    ],
    [
      { type: 'insight', label: '核心假设' },
      { type: 'direction', label: '验证路径' },
      { type: 'step', label: 'STEP 1 — 假设验证' },
      { type: 'resource', label: '参考资料' },
      { type: 'idea', label: '差异化' },
    ],
    [
      { type: 'insight', label: '机会点' },
      { type: 'direction', label: '方向 A' },
      { type: 'direction', label: '方向 B' },
      { type: 'step', label: 'STEP 1 — 行动计划' },
      { type: 'idea', label: 'MVP 想法' },
    ],
  ]
  return { text, tags: tagSets[(round - 1) % tagSets.length] }
}

// 模拟拆解：把方向文本拆成结构化节点树
export async function decompose(settings, direction, opts = {}) {
  if (isDemo(settings)) {
    const { anchor = null } = opts
    await new Promise((r) => setTimeout(r, 600))
    const root = (anchor ? (anchor.content || direction) : direction).toString().slice(0, 40) || '想法'
    const points = splitPoints(direction)
    const children = []
    const seeds = points.length
      ? points.slice(0, 6)
      : ['目标与价值', '关键假设', '第一步动作', '可参考的资料']
    seeds.forEach((p, i) => {
      const type = MOCK_TYPES[i % MOCK_TYPES.length]
      const sub = []
      // 给 direction/step 再补一层子节点，让图谱更丰满
      if (type === 'direction' || type === 'step') {
        sub.push({ type: 'step', title: `${p.slice(0, 12)} · 具体动作`, body: '', rel: 'supports' })
        sub.push({ type: 'resource', title: `${p.slice(0, 12)} · 参考资料`, body: '', rel: 'supports' })
      }
      children.push({
        type,
        title: p.slice(0, 20) || `${type} ${i + 1}`,
        body: '',
        rel: 'derives',
        children: sub,
      })
    })
    if (anchor) return { root: null, children }
    return { root: { type: 'idea', title: root, body: '' }, children }
  }
  const { history = [], anchor = null, learning = '' } = opts
  const system = (anchor ? DECOMPOSE_DRILL_SYSTEM : DECOMPOSE_SYSTEM) + (learning || '')
  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: anchor
        ? `这是一张已存在的卡片：\n${direction}\n\n请只输出它的下一级子节点 children 数组（不要 root），按 schema 拆解。`
        : `已确认方向：\n${direction}\n\n请按 schema 拆解成节点树 JSON。`,
    },
  ]
  const text = await chatCompletion(settings, messages, {
    temperature: 0.4,
    jsonMode: true,
    timeoutMs: 30000,
  })
  return parseTree(text)
}

// 模拟优化：基于现有节点补几个子节点
export async function optimizeCanvas(settings, graph, opts = {}) {
  if (isDemo(settings)) {
    await new Promise((r) => setTimeout(r, 600))
    const { mode = 'global', focusId = null } = opts
    const parents = mode === 'node' && focusId
      ? graph.nodes.filter((n) => n.id === focusId)
      : graph.nodes.filter((n) => n.type === 'direction' || n.type === 'step').slice(0, 3)
    const add = parents.map((p, i) => ({
      parentId: p.id,
      type: MOCK_TYPES[i % MOCK_TYPES.length],
      title: `补充：${(p.content || '节点').slice(0, 10)}的下一步`,
      body: '',
    }))
    return { add, merge: [], notes: '（演示模式）已基于现有结构补充若干节点，建议你在真实模式下让 AI 深度审查。' }
  }
  const { mode = 'global', focusId = null, focusContent = '', subgraph = null } = opts
  let system = OPTIMIZE_SYSTEM
  let userContent = `当前画布：\n${JSON.stringify(graph, null, 2)}\n\n请输出优化 JSON。`
  if (mode === 'node' && focusId) {
    system = OPTIMIZE_NODE_SYSTEM
    const subText = subgraph
      ? `\n这部分子树：\n${JSON.stringify(subgraph, null, 2)}`
      : ''
    userContent = `用户选中的卡片（focus）：\nid: ${focusId}\n内容: ${focusContent}${subText}\n\n请只围绕这张卡片深度补全，输出 JSON。`
  }
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ]
  const text = await chatCompletion(settings, messages, {
    temperature: mode === 'node' ? 0.5 : 0.5,
    jsonMode: true,
    timeoutMs: 40000,
  })
  return parseOptimize(text)
}

// 模拟关联：把前两个节点连起来
export async function autoRelate(settings, graph) {
  if (isDemo(settings)) {
    await new Promise((r) => setTimeout(r, 400))
    if (graph.nodes.length < 2) return []
    return [
      { source: graph.nodes[0].id, target: graph.nodes[1].id, rel: 'relates', reason: '（演示模式）同属一个想法脉络' },
    ]
  }
  const messages = [
    { role: 'system', content: RELATE_SYSTEM },
    {
      role: 'user',
      content: `当前画布节点：\n${JSON.stringify(graph, null, 2)}\n\n请输出建议新增的连线 JSON。`,
    },
  ]
  const text = await chatCompletion(settings, messages, {
    temperature: 0.3,
    jsonMode: true,
    timeoutMs: 40000,
  })
  return parseRelate(text)
}

// 模拟报告
export async function generateReport(settings, graph) {
  if (isDemo(settings)) {
    await new Promise((r) => setTimeout(r, 500))
    const lines = graph.nodes.map((n) => `- 【${n.type}】${n.content || '（空）'}`).slice(0, 12)
    return `# 主题概括\n（演示模式）这张画布围绕「${graph.nodes[0]?.content || '你的想法'}」展开。\n\n# 思路分层\n${lines.join('\n')}\n\n# 关键洞察\n- 演示模式下的报告为占位内容，填入 API Key 后由真实模型生成。\n\n# 下一步建议\n- 配置模型 API Key，让 AI 做真实审查与补全。`
  }
  const messages = [
    { role: 'system', content: REPORT_SYSTEM },
    {
      role: 'user',
      content: `画布数据：\n${JSON.stringify(graph, null, 2)}\n\n请生成报告（纯文本）。`,
    },
  ]
  const text = await chatCompletion(settings, messages, {
    temperature: 0.5,
    timeoutMs: 45000,
  })
  return text
}

// 模拟导入拆解
export async function decomposeImport(settings, text, opts = {}) {
  const { learning = '' } = opts
  if (isDemo(settings)) {
    await new Promise((r) => setTimeout(r, 600))
    const points = splitPoints(text)
    const children = (points.length ? points.slice(0, 5) : ['核心主题', '关键论点', '待办事项', '参考资料']).map((p, i) => ({
      type: MOCK_TYPES[i % MOCK_TYPES.length],
      title: p.slice(0, 20) || `要点 ${i + 1}`,
      body: '',
      rel: 'derives',
      children: [],
    }))
    return { root: { type: 'idea', title: (text.slice(0, 30) || '导入材料'), body: '' }, children }
  }
  const messages = [
    {
      role: 'system',
      content: IMPORT_SYSTEM + (learning || ''),
    },
    {
      role: 'user',
      content: `下面是待拆解的材料（文章 / 笔记 / 聊天记录）：\n\n${text}\n\n请提炼成结构化节点树 JSON。`,
    },
  ]
  const out = await chatCompletion(settings, messages, {
    temperature: 0.4,
    jsonMode: true,
    timeoutMs: 45000,
  })
  return parseTree(out)
}

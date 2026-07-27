// 联网搜索客户端：支持 Tavily / SerpAPI / Bing。
// 仅用于「应用侧 RAG」模式，API Key 由用户在设置面板填写，仅存本机，应用直连厂商。
// 注意：浏览器直连这些搜索 API 可能受 CORS 限制（Tavily / SerpAPI 通常允许，Bing 需服务端代理）。
// 若 CORS 失败，建议改用「模型侧 web_search 工具」模式（由模型厂商代发请求）。

async function fetchWithTimeout(url, options, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('搜索请求超时，请检查网络或搜索 Key。')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function fmt(items) {
  if (!items || !items.length) return ''
  return items
    .slice(0, 6)
    .map((it, i) => `[${i + 1}] ${it.title}\n${it.url}\n${it.snippet}`)
    .join('\n\n')
}

// provider: 'tavily' | 'serpapi' | 'bing'
// 返回格式化后的检索文本，供注入 system 提示
export async function webSearch(provider, key, query) {
  if (!key) throw new Error('未配置搜索 API Key')
  const q = (query || '').slice(0, 400)
  if (!q.trim()) return ''
  let items = []

  if (provider === 'tavily') {
    const r = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: q, max_results: 6, search_depth: 'basic' }),
    })
    if (!r.ok) throw new Error(`Tavily 搜索失败 (${r.status})`)
    const j = await r.json()
    items = (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }))
  } else if (provider === 'serpapi') {
    const u = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=6&api_key=${encodeURIComponent(key)}`
    const r = await fetchWithTimeout(u)
    if (!r.ok) throw new Error(`SerpAPI 搜索失败 (${r.status})`)
    const j = await r.json()
    items = (j.organic_results || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '' }))
  } else if (provider === 'bing') {
    const u = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=6`
    const r = await fetchWithTimeout(u, { headers: { 'Ocp-Apim-Subscription-Key': key } })
    if (!r.ok) throw new Error(`Bing 搜索失败 (${r.status})`)
    const j = await r.json()
    items = (j.webPages?.value || []).map((x) => ({ title: x.name, url: x.url, snippet: x.snippet || '' }))
  } else {
    throw new Error('未知的搜索服务')
  }

  return fmt(items)
}

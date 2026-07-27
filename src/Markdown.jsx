import React from 'react'

// 安全的最小 Markdown 渲染器（零依赖、不使用 dangerouslySetInnerHTML，避免 XSS）。
// 支持：**粗体** *斜体* `行内代码` [链接](url) 与 #/##/### 标题、无序列表、段落与换行。
// 主要用于渲染 AI 生成 / 用户编辑的节点正文。

function renderInline(text, keyBase) {
  const regex =
    /(\*\*([^*]+?)\*\*|\*([^*]+?)\*|`([^`]+?)`|\[([^\]]+?)\]\((https?:\/\/[^\s)]+|[^\s)]+)\))/g
  const out = []
  let last = 0
  let m
  let i = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${keyBase}-${i++}`
    if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>)
    else if (m[3] !== undefined) out.push(<em key={k}>{m[3]}</em>)
    else if (m[4] !== undefined) out.push(<code key={k}>{m[4]}</code>)
    else if (m[5] !== undefined) {
      const url = m[6]
      // 仅放行 http/https/相对路径，阻断 javascript: 等危险协议
      const safe = /^https?:\/\//.test(url) || url.startsWith('/') ? url : '#'
      out.push(
        <a key={k} href={safe} target="_blank" rel="noreferrer">
          {m[5]}
        </a>,
      )
    }
    last = regex.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function Markdown({ children, className, inline }) {
  const text = typeof children === 'string' ? children : String(children || '')
  if (inline) return <>{renderInline(text, 'il')}</>

  const blocks = text.split(/\n{2,}/)
  return (
    <div className={className}>
      {blocks.map((blk, bi) => {
        const t = blk.trim()
        if (!t) return null
        if (/^#{1,3}\s/.test(t)) {
          const level = t.match(/^#+/)[0].length
          const Tag = `h${Math.min(level + 2, 6)}` // #→h3, ##→h4, ###→h5
          return <Tag key={bi}>{renderInline(t.replace(/^#+\s/, ''), `b${bi}`)}</Tag>
        }
        if (/^[-*]\s+/m.test(t)) {
          const items = t
            .split(/\n/)
            .filter((l) => /^[-*]\s+/.test(l))
            .map((l) => l.replace(/^[-*]\s+/, ''))
          return (
            <ul key={bi}>
              {items.map((it, ii) => (
                <li key={ii}>{renderInline(it, `b${bi}-${ii}`)}</li>
              ))}
            </ul>
          )
        }
        const lines = t.split(/\n/)
        return (
          <p key={bi}>
            {lines.map((ln, li) => (
              <React.Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(ln, `b${bi}-${li}`)}
              </React.Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}

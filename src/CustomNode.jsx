import { useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { NODE_TYPES, NODE_TYPE_KEYS } from './nodeTypes'
import { useStore } from './store'
import { recordCorrection } from './corrections'

export default function CustomNode({ id, data, selected }) {
  const cfg = NODE_TYPES[data.type] || NODE_TYPES.idea
  const updateNodeData = useStore((s) => s.updateNodeData)
  const deleteNode = useStore((s) => s.deleteNode)
  const setDetailNode = useStore((s) => s.setDetailNode)
  const [editing, setEditing] = useState(false)
  const startRef = useRef(data.content)
  const fileRef = useRef(null)

  // 仅 read === true 视为已读；其余（含存量无字段节点、手动新建）均为未读
  const read = data.read === true

  const onDelete = (e) => {
    e.stopPropagation()
    if (data.ai) recordCorrection({ action: 'delete', type: data.type })
    deleteNode(id)
  }

  const enterEdit = () => {
    startRef.current = data.content
    setEditing(true)
  }

  const onBlur = () => {
    setEditing(false)
    if (data.ai && startRef.current !== data.content) {
      recordCorrection({ action: 'edit', type: data.type })
    }
  }

  const toggleRead = (e) => {
    e.stopPropagation()
    updateNodeData(id, { read: !read })
  }

  const onPickImage = (e) => {
    e.stopPropagation()
    fileRef.current?.click()
  }

  const onFile = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    const r = new FileReader()
    r.onload = () => updateNodeData(id, { image: r.result })
    r.readAsDataURL(f)
    e.target.value = ''
  }

  const openDetail = (e) => {
    // 不阻止冒泡：点击名称同时也选中卡片（便于下钻）
    if (!read) updateNodeData(id, { read: true })
    setDetailNode(id)
  }

  const lines = (data.content || '').split('\n')
  const keyword = (lines.find((l) => l.trim()) || '').slice(0, 40)

  return (
    <div
      className={`node-card${selected ? ' selected' : ''}${read ? ' read' : ''}`}
      style={{ borderColor: cfg.color, background: cfg.bg }}
    >
      <div className="node-head" style={{ color: cfg.color }}>
        <select
          className="node-type"
          value={data.type}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => updateNodeData(id, { type: e.target.value })}
        >
          {NODE_TYPE_KEYS.map((k) => (
            <option key={k} value={k}>
              {NODE_TYPES[k].label}
            </option>
          ))}
        </select>
        <span
          className={`read-badge ${read ? 'read' : 'unread'}`}
          title={read ? '已读，点击标记未读' : '未读，点击标记已读'}
          onClick={toggleRead}
        >
          {read ? '✓' : '●'}
        </span>
        <button className="node-img-btn" title="插入图片" onClick={onPickImage}>
          🖼
        </button>
        <button className="node-del" title="删除卡片" onClick={onDelete}>
          ×
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onFile}
        />
      </div>

      <div className="node-body" onDoubleClick={enterEdit}>
        {editing ? (
          <textarea
            autoFocus
            className="node-edit"
            value={data.content || ''}
            onChange={(e) => updateNodeData(id, { content: e.target.value })}
            onBlur={onBlur}
          />
        ) : (
          <>
            <div
              className="node-name"
              title="点击查看详细说明"
              onClick={openDetail}
            >
              {keyword ? keyword : <span className="node-ph">双击编辑…</span>}
            </div>
            {data.url && (
              <a
                className="node-link"
                href={data.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={data.url}
              >
                🔗 链接
              </a>
            )}
            {data.image && (
              <img
                className="node-thumb"
                src={data.image}
                alt=""
                title="点击查看大图"
                onClick={(e) => {
                  e.stopPropagation()
                  openDetail(e)
                }}
              />
            )}
          </>
        )}
      </div>

      <Handle type="target" position={Position.Left} style={{ background: cfg.color }} />
      <Handle type="source" position={Position.Right} style={{ background: cfg.color }} />
      <Handle type="target" position={Position.Top} style={{ background: cfg.color }} />
      <Handle type="source" position={Position.Bottom} style={{ background: cfg.color }} />
    </div>
  )
}

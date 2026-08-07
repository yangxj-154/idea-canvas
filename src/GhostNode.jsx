import { useStore } from './store'

// 跨画布关联的「幽灵节点」：在当前画布中以虚框表示另一端位于其它画布的节点，
// 点击整卡跳转、点击 × 删除该跨画布关联。
export default function GhostNode({ data }) {
  const deleteCrossEdge = useStore((s) => s.deleteCrossEdge)
  return (
    <div className="ghost-node" title="点击跳转到关联的其它画布节点">
      <span className="ghost-arrow">{data.ghostLabel}</span>
      <button
        className="ghost-del"
        title="删除此跨画布关联"
        onClick={(e) => {
          e.stopPropagation()
          if (data.crossId) deleteCrossEdge(data.crossId)
        }}
      >
        ×
      </button>
    </div>
  )
}

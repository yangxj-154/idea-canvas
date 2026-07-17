// 节点类型定义：想法 / 方向 / 步骤 / 资料 / 洞察
export const NODE_TYPES = {
  idea: {
    label: '想法',
    color: '#2563EB',
    bg: '#EFF6FF',
    desc: '一个未拆解的念头、主题或问题根节点',
  },
  direction: {
    label: '方向',
    color: '#7C3AED',
    bg: '#F5F3FF',
    desc: '想法可以延伸的路线、策略或分支角度',
  },
  step: {
    label: '步骤',
    color: '#059669',
    bg: '#ECFDF5',
    desc: '具体可执行的下一步动作',
  },
  resource: {
    label: '资料',
    color: '#D97706',
    bg: '#FFFBEB',
    desc: '参考、链接、素材、信息来源',
  },
  insight: {
    label: '洞察',
    color: '#DC2626',
    bg: '#FEF2F2',
    desc: '关键发现、结论、提醒或亮点',
  },
}

export const NODE_TYPE_KEYS = Object.keys(NODE_TYPES)

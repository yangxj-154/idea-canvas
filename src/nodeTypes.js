// 节点类型定义：想法 / 方向 / 步骤 / 资料 / 洞察（孟菲斯波普色板）
export const NODE_TYPES = {
  idea: {
    label: '想法',
    color: '#FF2E92',
    bg: '#FFF0F7',
    desc: '一个未拆解的念头、主题或问题根节点',
  },
  direction: {
    label: '方向',
    color: '#2A4DFF',
    bg: '#F0F4FF',
    desc: '想法可以延伸的路线、策略或分支角度',
  },
  step: {
    label: '步骤',
    color: '#FFE500',
    bg: '#FFFEF0',
    desc: '具体可执行的下一步动作',
  },
  resource: {
    label: '资料',
    color: '#00C969',
    bg: '#F0FFF6',
    desc: '参考、链接、素材、信息来源',
  },
  insight: {
    label: '洞察',
    color: '#000000',
    bg: '#F5F5F5',
    desc: '关键发现、结论、提醒或亮点',
  },
}

export const NODE_TYPE_KEYS = Object.keys(NODE_TYPES)

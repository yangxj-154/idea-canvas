// 文件解析层：把导入的文件 / 粘贴的材料统一成纯文本，交给 AI 拆解。
// .md/.txt/.json 原生读取（零依赖）。.docx/.pdf 视解析库是否安装：
// 已装则直接解析；未装则给出友好降级提示，引导用户转成文本再导入（"不行也做了"）。

export const SUPPORTED_EXT = [
  '.md',
  '.markdown',
  '.txt',
  '.text',
  '.json',
  '.docx',
  '.pdf',
]

export function extOf(name = '') {
  const m = (name || '').toLowerCase().match(/\.[a-z0-9]+$/)
  return m ? m[0] : ''
}

function makeErr(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

// 检查解析库是否可用（安装后才成立）
export async function hasDocxSupport() {
  try {
    await import('mammoth')
    return true
  } catch {
    return false
  }
}

export async function hasPdfSupport() {
  try {
    await import('pdfjs-dist')
    return true
  } catch {
    return false
  }
}

export async function readFileAsText(file) {
  const ext = extOf(file.name)
  if (['.md', '.markdown', '.txt', '.text', '.json'].includes(ext)) {
    return await file.text()
  }
  if (ext === '.docx') {
    try {
      const mod = await import('mammoth')
      const res = await mod.extractRawText({ arrayBuffer: await file.arrayBuffer() })
      return res.value || ''
    } catch {
      throw makeErr(
        'DOCX_UNSUPPORTED',
        '当前环境暂不支持直接解析 .docx。请先用 Word / WPS 另存为 .txt 或 .md，再把文字粘贴 / 导入。',
      )
    }
  }
  if (ext === '.pdf') {
    try {
      const pdfjs = await import('pdfjs-dist')
      // 配置 worker（Vite 会把 worker 文件作为静态资源打包并给出 URL）
      try {
        const workerMod = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default
      } catch {
        /* worker 加载失败时 pdfjs 会退回主线程解析（仅性能下降） */
      }
      const buf = await file.arrayBuffer()
      const doc = await pdfjs.getDocument({ data: buf }).promise
      let out = ''
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const tc = await page.getTextContent()
        out += tc.items.map((it) => it.str || '').join(' ') + '\n'
      }
      return out
    } catch {
      throw makeErr(
        'PDF_UNSUPPORTED',
        '当前环境暂不支持直接解析 .pdf。请复制 PDF 中的文字，或转成 .txt / .md 后再导入。',
      )
    }
  }
  // 其它扩展名：尝试当纯文本兜底
  try {
    return await file.text()
  } catch {
    throw makeErr(
      'FORMAT_UNSUPPORTED',
      `不支持的文件类型：${ext || '未知'}。请用 .md / .txt 文本，或直接粘贴内容导入。`,
    )
  }
}

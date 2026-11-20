import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FileImage, History } from 'lucide-react'
import { listOperations, loadOperation, loadThumbnail, type HistoryRow, type Operation } from './store'

const time = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

export default function HistoryList({ revision, onRestore }: {
  revision: number
  onRestore: (operation: Operation, id: number) => void
}) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [error, setError] = useState('')
  const selection = useRef(0)
  useEffect(() => () => { selection.current++ }, [])
  useEffect(() => {
    let live = true
    listOperations().then(async items => {
      if (!live) return
      setRows(items)
      // Decode one original at a time. Text and cached images are usable immediately.
      for (const row of items) {
        if (!live) break
        if (row.kind !== 'image' || row.thumbnail) continue
        try {
          const thumbnail = await loadThumbnail(row.id)
          if (live) setRows(current => current?.map(r => r.id === row.id ? { ...r, thumbnail } : r) ?? null)
        } catch { /* Keep the image placeholder and the restore action available. */ }
      }
    })
      .catch(() => { if (live) setError('无法读取本地历史记录，请重新打开历史记录。') })
    return () => { live = false }
  }, [revision])

  async function restore(id: number) {
    const token = ++selection.current
    try {
      const operation = await loadOperation(id)
      if (token === selection.current) onRestore(operation, id)
    } catch {
      if (token === selection.current) setError('无法恢复这条记录，请重新打开历史记录。')
    }
  }

  return <div className="history-view">
    <div className="title-line"><div><h1>历史记录</h1><p>最近 30 次已完成的模型操作</p></div></div>
    {error && <p role="alert">{error}</p>}
    {rows === null ? !error && <p role="status">正在读取…</p> : rows.length === 0 ?
      <div className="history-empty"><History size={28}/><p>还没有操作记录</p></div> :
      <ul className="history-list">{rows.map(row => <li key={row.id}>
        <button onClick={() => void restore(row.id)}>
          <span className="history-summary">
            {row.kind === 'text' ? <span className="history-text">{row.preview}</span> :
              row.thumbnail ? <img className="history-thumbnail" src={row.thumbnail} alt="本次操作的原图预览"/> :
                <span className="history-image-placeholder"><FileImage size={20}/>图片</span>}
            <span className="history-meta"><span>{row.actionName}</span>
              <time dateTime={new Date(row.completedAt).toISOString()}>{time.format(row.completedAt)}</time>
            </span>
          </span>
          <ChevronRight size={15}/>
        </button>
      </li>)}</ul>}
  </div>
}

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FileImage, FileText, History } from 'lucide-react'
import { listOperations, loadOperation, type HistoryRow, type Operation } from './store'

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
    listOperations().then(items => { if (live) setRows(items) })
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
          <span className="history-kind" aria-label={row.kind === 'text' ? '文字' : '图片'}>
            {row.kind === 'text' ? <FileText size={18}/> : <FileImage size={18}/>}
          </span>
          <span className="history-summary"><strong>{row.actionName}</strong><span>{row.preview}</span></span>
          <time dateTime={new Date(row.completedAt).toISOString()}>{time.format(row.completedAt)}</time>
          <ChevronRight size={15}/>
        </button>
      </li>)}</ul>}
  </div>
}

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, FileText, Image as ImageIcon, MessageCircle, PanelLeft, Plus, Square, Trash2 } from 'lucide-react'
import { errorText } from '../desktop'
import ModelResult from '../results/ModelResult'
import type { useConversations } from './useConversations'

type Props = { chat: ReturnType<typeof useConversations>; onSettings: () => void }

export default function Conversations({ chat, onSettings }: Props) {
  const { thread, selected } = chat
  const [collapsed, setCollapsed] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const lastUser = thread?.turns.at(-1)?.role === 'user'
  useEffect(() => {
    stick.current = true
    setConfirm(null)
    setNotice('')
    composer.current?.focus()
  }, [thread?.id])
  useEffect(() => {
    const log = scroller.current
    if (log && stick.current) log.scrollTop = log.scrollHeight
  }, [thread?.id, thread?.turns.length, chat.busy, chat.error])

  const create = () => void chat.create().catch(e => setNotice(errorText(e)))
  const send = () => {
    if (!thread || chat.busy || !chat.draft.trim()) return
    stick.current = true
    void chat.send(thread, chat.draft)
  }

  return <div className={collapsed ? 'chat-layout collapsed' : 'chat-layout'}>
    {!collapsed && <aside className="chat-sidebar" aria-label="已保存的会话">
      <button className="chat-new" onClick={create}><Plus size={16}/>新会话</button>
      <div className="chat-index">{chat.rows.map(row =>
        <button key={row.id} title={row.title} aria-current={row.id === selected ? 'true' : undefined}
          onClick={() => chat.select(row.id)}><MessageCircle size={14}/><span>{row.title}</span></button>)}</div>
    </aside>}
    <section className="chat-main" aria-label="当前会话">
      <header className="chat-head">
        <button title={collapsed ? '展开会话列表' : '收起会话列表'} aria-label={collapsed ? '展开会话列表' : '收起会话列表'}
          aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><PanelLeft size={16}/></button>
        <h1 title={thread?.title}>{thread?.title ?? '会话'}</h1>
        {collapsed && <button title="新会话" aria-label="新会话" onClick={create}><Plus size={16}/></button>}
        {thread && <button title="删除会话" aria-label="删除会话" onClick={() => setConfirm(thread.id)}><Trash2 size={15}/></button>}
      </header>
      {confirm && confirm === thread?.id && <div className="chat-confirm" role="group" aria-label="确认删除">
        <span>删除这段会话及全部消息？</span>
        <button onClick={() => setConfirm(null)}>取消</button>
        <button onClick={() => void chat.remove(confirm).then(() => setConfirm(null)).catch(e => setNotice(errorText(e)))}>确认删除</button>
      </div>}
      {(chat.storageError || notice) && <div className="notice" role="alert">{chat.storageError || notice}
        {chat.storageError && <button onClick={chat.refresh}>重新载入</button>}</div>}
      {thread ? <>
        <div className="chat-log" ref={scroller} onScroll={e => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
        }}>
          {thread.source && <details key={thread.id} className="chat-source" open={!thread.turns.length}>
            <summary>{thread.source.kind === 'image' ? <ImageIcon size={15}/> : <FileText size={15}/>}剪贴板{thread.source.kind === 'image' ? '图片' : '文字'}</summary>
            {thread.source.kind === 'image' ? <img src={thread.source.value} alt="加入此会话的剪贴板图片"/> : <pre>{thread.source.value}</pre>}
          </details>}
          {!thread.source && !thread.turns.length && <p className="chat-prompt">想聊些什么？</p>}
          {thread.turns.map((turn, i) => <article key={i} className={'chat-turn ' + turn.role} aria-label={turn.role === 'user' ? '我' : '模型'}>
            {turn.role === 'user' ? <p>{turn.text}</p> : <><b>模型回复</b><ModelResult text={turn.text}/></>}
          </article>)}
          {chat.busy && <p className="waiting" role="status">正在等待模型回复…</p>}
          {chat.error && <p className="chat-error" role="alert">{chat.error}</p>}
          {lastUser && !chat.busy && <div className="line-actions"><button onClick={() => void chat.send(thread)}>重新发送</button>
            <button onClick={onSettings}>模型设置</button></div>}
        </div>
        <form className="chat-composer" onSubmit={e => { e.preventDefault(); send() }}>
          <textarea ref={composer} rows={2} value={chat.draft} aria-label="会话消息"
            placeholder={lastUser && !chat.busy ? '可改写上一条问题，再次发送…' : thread.source && !thread.turns.length ? '想了解这份内容的什么？' : '输入消息…'}
            onChange={e => chat.setDraft(thread.id, e.target.value)} onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                e.preventDefault(); send()
              }
            }}/>
          <div><small>Enter 发送 · Shift+Enter 换行</small>
            {chat.busy ? <button type="button" aria-label="停止生成" title="停止生成" onClick={() => chat.stop(thread.id)}><Square size={14}/></button> :
              <button className="primary" type="submit" aria-label="发送消息" title="发送消息" disabled={!chat.draft.trim()}><ArrowUp size={17}/></button>}</div>
        </form>
      </> : <div className="chat-empty"><MessageCircle size={28}/><h2>{chat.loading ? '正在打开会话…' : '开始一段会话'}</h2>
        {!chat.loading && <><p>可以直接提问，也可以从工作台加入文字或图片。</p><button onClick={create}><Plus size={16}/>创建会话</button></>}</div>}
    </section>
  </div>
}

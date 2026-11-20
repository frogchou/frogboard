import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowDownLeft, Check, ChevronDown, Clipboard, Copy, FileImage, FileText, Keyboard, Languages, PenLine, RefreshCw, Save, Scan, Settings2, X } from 'lucide-react'
import Editor from './editor/Editor'
import Settings, { listActions, runAction, type Action } from './models'
import ShortcutSettings from './Preferences'
import { bindDesktop, defaults, errorText, modeNames, native, type Input, type Preferences, type Snapshot } from './desktop'
import logo from '../assets/frogboard.svg'

type View = 'work' | 'editor' | 'models' | 'shortcuts'
type Reply = { action: string; text: string; busy: boolean; error?: string }

export default function App() {
  const [view, setView] = useState<View>('work')
  const [item, setItem] = useState<Snapshot | null>(null)
  const [actions, setActions] = useState<Action[]>([])
  const [reply, setReply] = useState<Reply | null>(null)
  const [notice, setNotice] = useState('')
  const [prefs, setPrefs] = useState<Preferences>(defaults)
  const [menu, setMenu] = useState(false)
  const request = useRef<AbortController | null>(null)
  const activeId = useRef<number | null>(null)
  const lastAction = useRef('')
  const actionBar = useRef<HTMLDivElement>(null)

  function invalidate() {
    request.current?.abort()
    request.current = null
    setReply(null)
  }
  async function execute(action: string, input: Input, name = '翻译') {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    lastAction.current = action
    setNotice('')
    setReply({ action: name, text: '', busy: true })
    try {
      const text = await runAction(action, input, { signal: controller.signal })
      if (request.current === controller) setReply({ action: name, text, busy: false })
    } catch (e) {
      if (request.current === controller && !controller.signal.aborted)
        setReply({ action: name, text: '', busy: false, error: errorText(e) })
    }
  }
  function accept(next: Snapshot) {
    activeId.current = next.id
    invalidate()
    setMenu(false)
    setNotice('')
    setItem(next)
    const overlay = next.kind === 'image' && (next.mode === 'capture' || next.mode === 'translate')
    setView(overlay ? 'editor' : 'work')
    if (next.kind === 'text' && (next.mode === 'translate' || next.mode === 'selection'))
      void execute('translate', { kind: 'text', value: next.value })
  }
  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined
    void bindDesktop(accept, setNotice, () => { activeId.current = null; invalidate(); setItem(null); setMenu(false); setView('work') })
      .then(cleanup => { if (disposed) cleanup(); else stop = cleanup }).catch(e => setNotice(errorText(e)))
    if (native) void invoke<[Preferences, string]>('get_preferences').then(([p, w]) => {
      setPrefs(p); if (w) setNotice(w)
    }).catch(e => setNotice(errorText(e)))
    return () => { disposed = true; stop?.(); request.current?.abort() }
  }, [])
  useEffect(() => {
    let live = true
    setActions([])
    if (native && item && item.kind !== 'empty' && view === 'work') {
      void listActions(item.kind).then(rows => { if (live) setActions(rows) }).catch(e => {
        if (live) setNotice(errorText(e))
      })
    }
    return () => { live = false }
  }, [item, view])

  async function trigger(mode: keyof typeof modeNames) {
    setMenu(false)
    if (!native) { setNotice('请在 Windows 桌面版中使用系统剪贴板、截图和翻译。'); return }
    try { await invoke('open_input', { mode }) } catch (e) { setNotice(errorText(e)) }
  }
  async function closeEditor() {
    if (!item || activeId.current !== item.id) return
    if (item.mode !== 'clipboard' && native) {
      const current = await invoke<boolean>('finish_editor', { id: item.id, hide: true })
      if (!current || activeId.current !== item.id) return
      activeId.current = null
      setItem(null)
    }
    setView('work')
  }
  async function exportImage(kind: 'copy' | 'save' | 'translate' | 'ocr', png: string) {
    if (!item || activeId.current !== item.id) return
    if (kind === 'save') { await invoke('save_png', { png }); return }
    if (kind === 'copy') {
      await invoke('copy_png', { png })
      if (activeId.current !== item.id) return
      if (item?.mode === 'clipboard') {
        setItem({ ...item, value: png })
        setView('work')
      } else {
        await closeEditor()
      }
      setNotice('已复制标注后的图片')
      return
    }
    const current = await invoke<boolean>('finish_editor', { id: item.id, hide: false })
    if (!current || activeId.current !== item.id) return
    const input = { kind: 'image', value: png } as const
    setItem({ ...input, mode: 'clipboard', id: item?.id ?? 0 })
    setView('work')
    await execute(kind === 'ocr' ? 'ocr' : 'image-translate', input, kind === 'ocr' ? '提取文字' : '图片翻译')
  }
  function openView(next: View) {
    setMenu(false)
    if (reply?.busy) invalidate()
    setView(next)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || view !== 'work' || e.isComposing) return
      if (menu) { setMenu(false); return }
      invalidate()
      activeId.current = null
      setItem(null)
      if (native) void invoke('hide_panel').catch(err => setNotice(errorText(err)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, menu])
  if (view === 'editor' && item?.kind === 'image')
    return <Editor key={item.id} image={item.value} cropFirst={item.mode !== 'clipboard'}
      windowBounds={item.windowBounds} quickTranslate={item.mode === 'translate'} onExport={exportImage}
      onClose={() => void closeEditor().catch(e => setNotice(errorText(e)))}/>

  const valid = item && item.kind !== 'empty' ? { kind: item.kind, value: item.value } as Input : null
  const report = (job: Promise<unknown>, ok = '') => void job.then(() => setNotice(ok)).catch(e => setNotice(errorText(e)))
  const reading = valid?.kind === 'text' && (item?.mode === 'selection' || item?.mode === 'translate')
  const resultCard = valid && reply && <section className="result" aria-live="polite">
    <div className="result-head"><b><Languages size={16}/> {reply.action}</b>
      {reply.busy ? <button onClick={invalidate}>取消</button> : reply.text &&
        <button onClick={() => report(invoke('copy_text', { text: reply.text }), '已复制结果')}><Copy size={14}/> 复制</button>}
    </div>
    {reply.busy ? <p className="waiting">正在等待模型响应…</p> : reply.error ? <>
      <p>{reply.error}</p><div className="line-actions"><button onClick={() => openView('models')}>模型设置</button>
      <button onClick={() => execute(lastAction.current, valid, reply.action)}>重试</button></div>
    </> : <pre>{reply.text}</pre>}
  </section>
  return <main className="frog-shell">
    <header className="app-header"><div className="brand"><img src={logo} alt=""/><b>青蛙跳板</b><span>FrogBoard</span></div>
      <div className="menu-wrap"><button className="menu-trigger" aria-expanded={menu} onClick={() => setMenu(!menu)}><Settings2 size={16}/> 设置 <ChevronDown size={13}/></button>
        {menu && <><button className="menu-backdrop" aria-label="关闭设置菜单" onClick={() => setMenu(false)}/><div className="menu-list">
          <button onClick={() => openView('models')}><Languages size={16}/> 模型与动作</button>
          <button onClick={() => openView('shortcuts')}><Keyboard size={16}/> 快捷键与划词</button>
        </div></>}</div>
    </header>
    {view === 'shortcuts' ? <ShortcutSettings current={prefs} onSave={setPrefs} onBack={() => openView('work')}/> :
      view === 'models' ? <div className="model-host">
        <Settings onClose={() => openView('work')}/></div> :
      <section className="work">
        <div className="title-line"><div><h1>{reading ? '划词翻译' : '剪贴板工作台'}</h1>
          {!reading && <p>{valid ? valid.kind === 'image' ? '图片快照' : '文字快照' : '读取当前内容，选择下一步操作。'}</p>}</div>
          <button className="circle" title="重新读取剪贴板" aria-label="重新读取剪贴板" onClick={() => trigger('clipboard')}><RefreshCw size={17}/></button></div>
        {notice && <div className="notice" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={14}/></button></div>}
        {!valid ? <>
          <div className="empty-board"><div className="empty-icon"><Clipboard size={33} strokeWidth={1.6}/></div>
            <h2>{item ? '剪贴板里还没有可处理的内容' : '从剪贴板开始'}</h2>
            <p>复制一段文字或一张图片，再在这里读取。</p>
            <button className="primary" onClick={() => trigger('clipboard')}><Clipboard size={16}/> 读取剪贴板</button>
          </div>
          <div className="launch-grid">{(['capture','translate'] as const).map(mode => <button key={mode} aria-label={modeNames[mode]} onClick={() => trigger(mode)}>
            <span className="launch-icon">{mode === 'capture' ? <Scan/> : <Languages/>}</span>
            <span><strong>{modeNames[mode]}</strong><kbd>{prefs[mode]}</kbd></span><ArrowDownLeft size={16}/></button>)}</div>
        </> : <>
          {reading && resultCard}
          {reading ? <details key={item?.id} className="preview original"><summary>查看原文</summary><pre>{valid.value}</pre></details> :
            <div className="preview" aria-label="当前输入">{valid.kind === 'image' ? <img alt="本次操作的图片" src={valid.value}/> : <pre>{valid.value}</pre>}</div>}
          <div className="action-bar" ref={actionBar} onKeyDown={e => {
            if (!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp'].includes(e.key)) return
            const buttons = Array.from(actionBar.current?.querySelectorAll('button') ?? [])
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (current >= 0) { e.preventDefault(); buttons[(current + (['ArrowRight','ArrowDown'].includes(e.key) ? 1 : -1) + buttons.length) % buttons.length].focus() }
          }}>
            {valid.kind === 'image' && <><button onClick={() => { invalidate(); setView('editor') }}><PenLine size={15}/> 继续标注</button>
              <button onClick={() => report(invoke('save_png', { png: valid.value }))}><Save size={15}/> 保存 PNG</button></>}
            {actions.map(a => <button key={a.id} onClick={() => execute(a.id, valid, a.name)}>{a.name}</button>)}
          </div>
          {!reading && resultCard}
        </>}
      </section>}
    {view === 'work' && <footer className="status-line"><span>{valid ? valid.kind === 'text' ? <FileText size={13}/> : <FileImage size={13}/> : <Check size={13}/>}
      {valid ? valid.kind === 'text' ? `${Array.from(valid.value).length} 字符` : '图片' : '工作台就绪'}</span>
      <button onClick={() => openView('shortcuts')}><Keyboard size={14}/> {prefs.clipboard}</button></footer>}
  </main>
}

import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft, Check } from 'lucide-react'
import { defaults, errorText, modeNames, type Preferences } from './desktop'

export default function ShortcutSettings({ current, onSave, onBack }: {
  current: Preferences; onSave: (p: Preferences) => void; onBack: () => void
}) {
  const [draft, setDraft] = useState(current)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      await invoke('save_preferences', { preferences: draft })
      onSave(draft)
      setMessage('已保存，新的快捷键现在可以使用。')
    } catch (e) { setMessage(errorText(e)) }
    finally { setBusy(false) }
  }
  return <section className="pref-screen">
    <button className="plain" onClick={onBack}><ArrowLeft size={16}/> 返回工作台</button>
    <h1>快捷键与划词</h1>
    <p>在输入框中按下新的组合键。</p>
    {(Object.keys(modeNames) as (keyof typeof modeNames)[]).map(mode =>
      <label className="pref-row" key={mode}>{modeNames[mode]}
        <input value={draft[mode]} readOnly onKeyDown={e => {
          if (e.key === 'Tab') return
          e.preventDefault()
          if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return
          if (!/^(Key[A-Z]|Digit\d|F\d{1,2}|Space|Insert|Home|End|PageUp|PageDown)$/.test(e.code)) return
          const parts = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', e.code.replace(/^Key|^Digit/, '')]
          setDraft({ ...draft, [mode]: parts.filter(Boolean).join('+') })
          setMessage('')
        }}/>
      </label>)}
    <label className="pref-row">划词后显示翻译按钮<input type="checkbox" checked={draft.selection}
      onChange={e => setDraft({ ...draft, selection: e.target.checked })}/></label>
    <div className="line-actions"><button className="primary" onClick={save} disabled={busy}><Check size={16}/> 保存</button>
      <button onClick={() => setDraft(defaults)}>恢复默认值</button></div>
    {message && <p role="status">{message}</p>}
  </section>
}

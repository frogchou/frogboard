import { useNotify } from '../feedback/Feedback'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft } from 'lucide-react'
import { errorText, native } from '../desktop'
import { appearance, recordHistory, saveAppearance, setRecordHistory, type Appearance } from './preferences'

export default function GeneralSettings({ onBack }: { onBack: () => void }) {
  const [theme, setTheme] = useState(appearance)
  const [history, setHistory] = useState(recordHistory)
  const [startup, setStartup] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const notify = useNotify()
  useEffect(() => {
    if (!native) return
    let active = true
    invoke<boolean>('get_login_startup').then(value => { if (active) setStartup(value) })
      .catch(e => { if (active) notify(errorText(e)) })
    return () => { active = false }
  }, [])

  async function update(change: () => void | Promise<void>) {
    setBusy(true)
    try { await change() } catch (e) { notify(errorText(e)) }
    finally { setBusy(false) }
  }

  return <section className="pref-screen general-settings">
    <button className="plain" onClick={onBack}><ArrowLeft size={16}/> 返回工作台</button>
    <h1>通用设置</h1>
    <label className="pref-row"><span>开机启动<small>登录 Windows 后自动驻留在系统托盘。</small></span>
      <input type="checkbox" role="switch" aria-label="开机启动" checked={startup === true} disabled={busy || startup === null}
        onChange={e => { const enable = e.target.checked; void update(async () => setStartup(await invoke<boolean>('set_login_startup', { enable }))) }}/>
    </label>
    <label className="pref-row"><span>主题</span>
      <select aria-label="主题" value={theme} disabled={busy} onChange={e => {
        const next = e.target.value as Appearance
        void update(async () => { await saveAppearance(next); setTheme(next) })
      }}>
        <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
      </select>
    </label>
    <label className="pref-row"><span>记录操作历史<small>开启时在本机保存最近 30 条。关闭后可继续查看已有记录。</small></span>
      <input type="checkbox" role="switch" aria-label="记录操作历史" checked={history} disabled={busy}
        onChange={e => { const enabled = e.target.checked; void update(() => { setRecordHistory(enabled); setHistory(enabled) }) }}/>
    </label>
  </section>
}

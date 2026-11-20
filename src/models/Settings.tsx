import { useNotify } from '../feedback/Feedback';
import { useEffect, useState } from 'react';
import {
  ArrowLeft, ChevronDown, ChevronRight, Copy, Image as ImageIcon, Laptop,
  ListFilter, Plus, Save, ScanText, Server, SlidersHorizontal, Trash2, Type,
} from 'lucide-react';
import {
  builtInActions, loadSettings, modelForAction, requiredActionIds, saveSettings, type Action, type InputKind,
  type KeyChanges, type ModelSettings, type Profile,
} from './api';
import ProfileEditor from './ProfileEditor';
import PromptTester from './PromptTester';
import './settings.css';

type Props = { onClose?: () => void; onOpenClipboardPrivacy?: () => void };
type Tab = 'profiles' | 'actions';

function validationError(settings: ModelSettings): string {
  for (const p of settings.profiles) {
    if (!p.name.trim() || !p.model.trim()) return '请为每个模型填写显示名称和模型 ID。';
    try {
      const url = new URL(p.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.includes('?') || url.href.includes('#')) throw new Error();
    } catch { return '请输入完整的 HTTP 或 HTTPS 接口地址，地址中不能包含账号、密码、查询参数或片段。'; }
  }
  if (settings.actions.some(a => !a.name.trim() || !a.prompt.trim())) return '请为每个操作填写名称和提示词。';
  return '';
}

export default function Settings({ onClose, onOpenClipboardPrivacy }: Props) {
  const [saved, setSaved] = useState<ModelSettings | null>(null);
  const [draft, setDraft] = useState<ModelSettings | null>(null);
  const [tab, setTab] = useState<Tab>('profiles');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [keyChanges, setKeyChanges] = useState<KeyChanges>({});
  const [error, setError] = useState('');
  const notify = useNotify();
  function reportError(message: string) { setError(message); notify(message); }
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    loadSettings().then(settings => {
      if (active) { setDraft(settings); setSaved(settings); setKeyChanges({}); setError(''); }
    }).catch(e => { if (active) reportError(e.message); });
    return () => { active = false; };
  }, [reload]);

  const dirty = draft !== saved || Object.keys(keyChanges).length > 0;
  function edit(data: Partial<ModelSettings>) {
    setDraft(current => current && { ...current, ...data });
    setError('');
  }
  function editProfile(id: string, changes: Partial<Profile>) {
    if (!draft) return;
    edit({
      profiles: draft.profiles.map(p => p.id === id ? { ...p, ...changes } : p),
      actions: changes.vision === false ? draft.actions.map(a => a.input === 'image' && a.modelId === id ? { ...a, modelId: null } : a) : draft.actions,
      defaultVision: changes.vision === false && draft.defaultVision === id ? null
        : changes.vision === true && !draft.defaultVision ? id : draft.defaultVision,
    });
  }
  function editKey(id: string, value: string | null | undefined) {
    setKeyChanges(current => {
      const next = { ...current };
      if (value === undefined) delete next[id]; else next[id] = value;
      return next;
    });
    setError('');
  }
  function newProfile() {
    if (!draft) return;
    const profile: Profile = { id: crypto.randomUUID(), provider: 'custom', name: '', endpoint: '', model: '', vision: false, hasKey: false };
    edit({ profiles: [...draft.profiles, profile], defaultText: draft.defaultText || profile.id });
    setProfileId(profile.id);
  }
  function removeProfile(id: string) {
    if (!draft) return;
    edit({
      profiles: draft.profiles.filter(p => p.id !== id),
      actions: draft.actions.map(a => a.modelId === id ? { ...a, modelId: null } : a),
      defaultText: draft.defaultText === id ? null : draft.defaultText,
      defaultVision: draft.defaultVision === id ? null : draft.defaultVision,
    });
    editKey(id, undefined);
    setProfileId(null);
  }
  function editAction(id: string, changes: Partial<Action>) {
    if (draft) edit({ actions: draft.actions.map(a => a.id === id ? { ...a, ...changes } : a) });
  }
  function newAction(copy?: Action) {
    if (!draft) return;
    const action: Action = { input: 'text', prompt: '', ...copy, id: crypto.randomUUID(), name: copy ? copy.name + '（副本）' : '' };
    edit({ actions: [...draft.actions, action] });
    setActionId(action.id);
  }
  async function save(): Promise<boolean> {
    if (!draft || busy) return false;
    const invalid = validationError(draft);
    if (invalid) { reportError(invalid); return false; }
    setBusy(true); setError('');
    try {
      const result = await saveSettings(draft, keyChanges);
      setDraft(result); setSaved(result); setKeyChanges({}); notify('已保存设置', 'success');
      return true;
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : '无法保存设置，请重试。');
      return false;
    } finally { setBusy(false); }
  }
  const retryLoad = error && (!draft || error.includes('重新载入'));
  const models = draft?.profiles || [];
  function defaultModel(kind: InputKind) {
    const image = kind === 'image';
    const options = models.filter(p => !image || p.vision);
    return <label className="fbm-default"><span>{image ? <ImageIcon size={16} /> : <Type size={16} />}{image ? '视觉模型' : '文本模型'}</span>
      <select aria-label={image ? '默认视觉模型' : '默认文本模型'} value={(image ? draft?.defaultVision : draft?.defaultText) || ''} onChange={e => edit({ [image ? 'defaultVision' : 'defaultText']: e.target.value || null })}>
        <option value="">未选择</option>{options.map(p => <option key={p.id} value={p.id}>{p.name || '未命名模型'}</option>)}
      </select></label>;
  }
  return <section className="fbm-settings" aria-label="模型与操作设置">
    <div className="fbm-header"><div className="fbm-heading">{onClose && <button type="button" className="fbm-icon" title="返回" aria-label="返回" onClick={onClose}><ArrowLeft size={18} /></button>}<div><h2>模型与操作</h2><p>为文字和图片选择模型，管理自己的快捷操作。</p></div></div>
      {retryLoad && <button type="button" className="fbm-button" onClick={() => setReload(r => r + 1)}>重新载入</button>}
      <button type="button" className="fbm-button fbm-primary" disabled={!draft || !dirty || busy} onClick={() => void save()}><Save size={15} />{busy ? '保存中…' : '保存设置'}</button>
    </div>
    <div className="fbm-tabs" aria-label="设置分类">
      <button type="button" aria-pressed={tab === 'profiles'} onClick={() => setTab('profiles')}><SlidersHorizontal size={15} />模型连接</button>
      <button type="button" aria-pressed={tab === 'actions'} onClick={() => setTab('actions')}><ListFilter size={15} />提示词操作</button>
    </div>
    {!draft && !error && <p className="fbm-muted" role="status">正在读取设置…</p>}
    {draft && <fieldset className="fbm-body" disabled={busy}>
      {tab === 'profiles' ? <>
        <div className="fbm-section-head"><h3>模型配置</h3><button type="button" className="fbm-button" onClick={newProfile}><Plus size={15} />添加模型</button></div>
        {models.length === 0 && <div className="fbm-empty"><span className="fbm-symbol"><Server size={23} /></span><strong>尚未连接模型</strong><p>添加兼容 Chat Completions 或 Responses 的云端或本机服务。</p></div>}
        <div className="fbm-list">{models.map(p => {
          const expanded = profileId === p.id;
          return <div key={p.id} className="fbm-item" data-open={expanded}><button type="button" className="fbm-row" aria-expanded={expanded} onClick={() => setProfileId(expanded ? null : p.id)}>
            <span className="fbm-symbol">{p.provider === 'ollama' ? <Laptop size={18} /> : <Server size={18} />}</span>
            <span className="fbm-row-title"><strong>{p.name || '新模型'}</strong><small>{p.model || '填写连接信息'}</small></span>
            <span className="fbm-kind">{p.vision ? '文字与图片' : '文字'}</span>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
            {expanded && <ProfileEditor profile={p} saved={saved?.profiles.find(s => s.id === p.id)} keyEdit={keyChanges[p.id]} onKey={v => editKey(p.id, v)} onChange={changes => editProfile(p.id, changes)} onRemove={() => removeProfile(p.id)} />}
          </div>;
        })}</div>
        <div className="fbm-section-head"><h3>默认模型</h3></div>
        <div className="fbm-defaults">{defaultModel('text')}{defaultModel('image')}</div>
        <p className="fbm-muted">运行操作时，只向对应模型发送本次选中的内容。API 密钥保存在 Windows 凭据管理器。</p>
        {onOpenClipboardPrivacy && <button type="button" className="fbm-text" onClick={onOpenClipboardPrivacy}>剪贴板与隐私设置</button>}
      </> : <>
        <div className="fbm-section-head"><h3>快捷操作</h3><button type="button" className="fbm-button" onClick={() => newAction()}><Plus size={15} />添加操作</button></div>
        <div className="fbm-list">{draft.actions.map(a => {
          const expanded = actionId === a.id;
          const builtIn = builtInActions.find(item => item.id === a.id);
          const fixedInput = requiredActionIds.has(a.id);
          const promptLabel = a.id === 'translate' || a.id === 'image-translate' ? '翻译提示词与目标语言' : '提示词';
          const model = modelForAction(draft, a);
          return <div key={a.id} className="fbm-item" data-open={expanded}><button type="button" className="fbm-row" aria-expanded={expanded} onClick={() => setActionId(expanded ? null : a.id)}>
            <span className="fbm-symbol">{a.input === 'text' ? <Type size={17} /> : <ScanText size={18} />}</span><span className="fbm-row-title"><strong>{a.name || '新操作'}</strong></span>
            <span className="fbm-kind">{a.input === 'text' ? '文字' : '图片'}</span>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
            {expanded && <div className="fbm-editor"><div className="fbm-grid">
              <label>操作名称<input value={a.name} onChange={e => editAction(a.id, { name: e.target.value })} placeholder="例如：整理会议要点" maxLength={96} /></label>
              <label>适用输入<select value={a.input} disabled={fixedInput} onChange={e => editAction(a.id, { input: e.target.value as InputKind, modelId: null })}><option value="text">文字</option><option value="image">图片</option></select></label>
            </div>
              <label>执行模型<select value={a.modelId || ''} onChange={e => editAction(a.id, { modelId: e.target.value || null })}><option value="">使用{a.input === 'text' ? '文本' : '视觉'}默认模型</option>{models.filter(p => a.input !== 'image' || p.vision).map(p => <option key={p.id} value={p.id}>{p.name || '新模型'}</option>)}</select></label>
              <label>{promptLabel}<textarea aria-label={promptLabel} rows={4} value={a.prompt} onChange={e => editAction(a.id, { prompt: e.target.value })} placeholder="描述要完成的任务和期望的输出格式…" /></label>
              <div className="fbm-editor-bottom"><button type="button" className="fbm-text" onClick={() => newAction(a)}><Copy size={14} />复制为新操作</button>{builtIn && <button type="button" className="fbm-text" disabled={a.prompt === builtIn.prompt} onClick={() => editAction(a.id, { prompt: builtIn.prompt })}>恢复内置提示词</button>}
                {!fixedInput && <button type="button" className="fbm-text fbm-delete" onClick={() => { edit({ actions: draft.actions.filter(item => item.id !== a.id) }); setActionId(null); }}><Trash2 size={14} />移除操作</button>}</div>
              <PromptTester key={a.id + a.input} action={a} modelName={model?.name} dirty={dirty} save={save} />
            </div>}
          </div>;
        })}</div>
      </>}
    </fieldset>}
  </section>;
}

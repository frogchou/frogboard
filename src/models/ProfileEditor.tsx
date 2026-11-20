import { Eye, EyeOff, KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Profile } from './api';

const providers = [
  { id: 'custom', name: '自定义兼容服务', endpoint: '' },
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1' },
  { id: 'ollama', name: 'Ollama · 本机', endpoint: 'http://localhost:11434/v1' },
];

export default function ProfileEditor({ profile, saved, keyEdit, onChange, onKey, onRemove }: {
  profile: Profile; saved?: Profile; keyEdit?: string | null;
  onChange: (changes: Partial<Profile>) => void; onKey: (value: string | null | undefined) => void;
  onRemove: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const reusable = saved?.hasKey && saved.endpoint.replace(/\/+$/, '') === profile.endpoint.replace(/\/+$/, '');
  const retainsKey = reusable && keyEdit === undefined;
  function changeEndpoint(endpoint: string, changes: Partial<Profile> = {}) {
    if (endpoint !== profile.endpoint) onKey(undefined);
    onChange({ endpoint, ...changes });
  }
  return <div className="fbm-editor">
    <div className="fbm-grid">
      <label>服务商<select value={profile.provider || 'custom'} onChange={event => {
        const provider = providers.find(item => item.id === event.target.value)!;
        changeEndpoint(provider.endpoint, { provider: provider.id, model: '', vision: false });
      }}>{providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label>
      <label>显示名称<input value={profile.name} onChange={e => onChange({ name: e.target.value })} placeholder="例如：工作用模型" maxLength={96} /></label>
    </div>
    <label>接口地址<input className="fbm-mono" value={profile.endpoint} onChange={e => changeEndpoint(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} autoComplete="off" /></label>
    {/^http:\/\//i.test(profile.endpoint.trim()) && <small className="fbm-muted">HTTP 会明文传输请求内容和随请求发送的 API 密钥。</small>}
    <label>模型 ID<input className="fbm-mono" value={profile.model} onChange={e => onChange({ model: e.target.value })} placeholder="填写服务商提供的模型 ID" spellCheck={false} autoComplete="off" /></label>
    <label><span className="fbm-label-line">API 密钥 <small>{retainsKey ? '已存入 Windows 凭据管理器' : '本机免密服务可留空'}</small></span>
      <span className="fbm-secret"><KeyRound size={15} /><input type={visible ? 'text' : 'password'} value={keyEdit || ''} onChange={e => onKey(e.target.value || undefined)} placeholder={retainsKey ? '已保存，输入新密钥可替换' : '输入 API 密钥'} autoComplete="new-password" spellCheck={false} />
      <button type="button" aria-label={visible ? '隐藏密钥' : '显示密钥'} title={visible ? '隐藏密钥' : '显示密钥'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></span>
    </label>
    {reusable && <button className="fbm-text" type="button" onClick={() => onKey(keyEdit === null ? undefined : null)}>{keyEdit === null ? '撤销清除密钥' : '清除已存密钥'}</button>}
    <div className="fbm-editor-bottom"><label className="fbm-check"><input type="checkbox" checked={profile.vision} onChange={e => onChange({ vision: e.target.checked })} />此模型支持图片输入</label>
    <button type="button" className="fbm-icon" title="移除模型" aria-label="移除模型" onClick={onRemove}><Trash2 size={15} /></button></div>
  </div>;
}

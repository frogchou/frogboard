import { FlaskConical, Play, Square, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { runAction, type Action, type ActionInput } from './api';
import ModelResult from '../results/ModelResult';

export default function PromptTester({ action, modelName, dirty, save }: {
  action: Action; modelName?: string; dirty: boolean; save: () => Promise<boolean>;
}) {
  const [sample, setSample] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setResult(''); setMessage(''); setBusy(false);
    return () => { active.current?.abort(); active.current = null; };
  }, [action.id, action.prompt, action.modelId, modelName]);
  async function test() {
    if (busy) return;
    const controller = new AbortController();
    active.current = controller;
    setMessage(''); setResult(''); setBusy(true);
    try {
      let input: ActionInput;
      if (action.input === 'image') {
        if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
          throw new Error('请选择 12 MB 以内的 PNG、JPEG 或 WebP 图片。');
        }
        const value = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('无法读取这张图片，请重新选择。'));
          reader.readAsDataURL(file);
        });
        input = { kind: 'image', value };
      } else { input = { kind: 'text', value: sample }; }
      if (!controller.signal.aborted && (!dirty || await save()) && !controller.signal.aborted) {
        const output = await runAction(action, input, { signal: controller.signal });
        if (active.current === controller) setResult(output);
      }
    } catch (cause) {
      if (active.current === controller) setMessage(cause instanceof Error ? cause.message : '测试失败，请重试。');
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }
  return <details className="fbm-tester">
    <summary><FlaskConical size={15} /> 测试操作</summary>
    <div className="fbm-test-body">
      {action.input === 'text' ? <label>测试文本<textarea value={sample} onChange={e => setSample(e.target.value)} rows={2} placeholder="输入一小段测试文字…" disabled={busy} /></label> :
        <label className="fbm-upload"><Upload size={16} /><span>{file?.name || '选择测试图片'}</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => setFile(e.target.files?.[0] || null)} /></label>}
      <div className="fbm-test-controls"><small>{modelName ? '发送至 ' + modelName : '请先选择默认模型'}</small>
        {busy ? <button type="button" className="fbm-button" onClick={() => active.current?.abort()}><Square size={13} />取消测试</button> :
          <button type="button" className="fbm-button" disabled={!modelName || (action.input === 'text' ? !sample.trim() : !file)} onClick={() => void test()}><Play size={13} />{dirty ? '保存并测试' : '运行测试'}</button>}
      </div>
      {message && <p className="fbm-error" role="status">{message}</p>}
      {result && <div className="fbm-result" role="status"><ModelResult text={result}/></div>}
    </div>
  </details>;
}

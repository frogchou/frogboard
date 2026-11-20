import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import definitions from './defaults.json';

export type InputKind = 'text' | 'image';
export type ActionInput = { kind: InputKind; value: string };
export interface Action { id: string; name: string; input: InputKind; prompt: string; modelId?: string | null }
export interface Profile {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  model: string;
  vision: boolean;
  hasKey: boolean;
}
export interface ModelSettings {
  revision: number;
  profiles: Profile[];
  defaultText: string | null;
  defaultVision: string | null;
  actions: Action[];
}
export type KeyChanges = Record<string, string | null>;
export const builtInActions: Action[] = definitions as Action[];
export const requiredActionIds = new Set(['translate', 'image-translate', 'ocr']);
export const settingsChanged = 'frogboard-model-settings-changed';
const previewKey = 'frogboard.model-settings.preview.v1';

export class ModelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

function asModelError(cause: unknown): ModelError {
  if (cause instanceof ModelError) return cause;
  if (cause && typeof cause === 'object' && 'code' in cause && 'message' in cause) {
    return new ModelError(String(cause.code), String(cause.message));
  }
  return new ModelError('desktop', '无法与桌面应用通信，请重新打开青蛙跳板。');
}

export async function loadSettings(): Promise<ModelSettings> {
  if (!isTauri()) {
    const preview = localStorage.getItem(previewKey);
    if (preview) {
      try {
        const settings = JSON.parse(preview) as ModelSettings;
        for (const required of builtInActions.filter(a => requiredActionIds.has(a.id))) {
          const action = settings.actions.find(a => a.id === required.id);
          if (!action) settings.actions.push({ ...required });
          else if (action.input !== required.input) { action.input = required.input; action.modelId = null; }
        }
        return settings;
      }
      catch { throw new ModelError('storage', '浏览器中的预览配置无法读取。'); }
    }
    return { revision: 0, profiles: [], defaultText: null, defaultVision: null, actions: structuredClone(builtInActions) };
  }
  try { return await invoke<ModelSettings>('model_settings_load'); }
  catch (cause) { throw asModelError(cause); }
}

export async function saveSettings(settings: ModelSettings, keyChanges: KeyChanges): Promise<ModelSettings> {
  let saved: ModelSettings;
  if (isTauri()) {
    try { saved = await invoke<ModelSettings>('model_settings_save', { settings, keyChanges }); }
    catch (cause) { throw asModelError(cause); }
    void emit(settingsChanged).catch(() => {});
  } else {
    if (Object.values(keyChanges).some(key => key)) {
      throw new ModelError('desktop', '请在 Windows 桌面应用中保存 API 密钥。');
    }
    saved = { ...settings, revision: settings.revision + 1 };
    localStorage.setItem(previewKey, JSON.stringify(saved));
  }
  window.dispatchEvent(new Event(settingsChanged));
  return saved;
}

export async function listActions(kind: InputKind): Promise<Action[]> {
  return (await loadSettings()).actions.filter(action => action.input === kind);
}

export function modelForAction(settings: ModelSettings, action: Action): Profile | undefined {
  const compatible = (id?: string | null) => settings.profiles.find(profile =>
    profile.id === id && (action.input !== 'image' || profile.vision));
  return compatible(action.modelId) || compatible(action.input === 'image' ? settings.defaultVision : settings.defaultText);
}

export async function runAction(
  action: Action | string, input: ActionInput, options: { signal?: AbortSignal } = {},
): Promise<string> {
  const cancelled = () => new ModelError('cancelled', '已取消本次操作。');
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  if (!isTauri()) throw new ModelError('desktop', '请在 Windows 桌面应用中运行模型操作。');
  const requestId = crypto.randomUUID();
  const handleAbort = () => { void invoke('model_action_cancel', { requestId }).catch(() => {}); };
  signal?.addEventListener('abort', handleAbort, { once: true });
  try {
    const value = await invoke<string>('model_action_run', {
      requestId, actionId: typeof action === 'string' ? action : action.id, input,
    });
    if (signal?.aborted) throw cancelled();
    return value;
  } catch (cause) {
    throw signal?.aborted ? cancelled() : asModelError(cause);
  } finally {
    signal?.removeEventListener('abort', handleAbort);
  }
}

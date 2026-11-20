import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const native = isTauri()
export type Input = { kind: 'text' | 'image'; value: string }
export type Bounds = { x: number; y: number; w: number; h: number }
export type Snapshot = {
  id: number
  mode: 'clipboard' | 'capture' | 'translate' | 'selection'
  kind: Input['kind'] | 'empty'
  value: string
  windowBounds?: Bounds[]
}
export type Preferences = { clipboard: string; capture: string; translate: string; selection: boolean }
export const defaults: Preferences = {
  clipboard: 'Ctrl+Alt+V', capture: 'Ctrl+Alt+A', translate: 'Ctrl+Alt+T', selection: true,
}
export const modeNames = { clipboard: '剪贴板面板', capture: '截图标注', translate: '智能翻译' } as const
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function bindDesktop(
  onInput: (item: Snapshot) => void, onError: (message: string) => void, onDismiss: () => void,
) {
  if (!native) return () => {}
  let lastId = -1
  const accept = (item: Snapshot | null) => {
    if (item && item.id > lastId) {
      lastId = item.id
      onInput(item)
      void invoke('clear_pending', { id: item.id }).catch(e => onError(errorText(e)))
    }
  }
  const unlisten = await Promise.all([
    listen<Snapshot>('frog-input', event => accept(event.payload)),
    listen<[number, string]>('frog-input-error', ({ payload: [id, message] }) => {
      if (id < lastId) return
      accept({ id, kind: 'empty', mode: 'clipboard', value: '' })
      onError(message)
    }),
    listen<string>('frog-error', event => onError(event.payload)),
    listen<number>('frog-dismiss', ({ payload: id }) => {
      if (id <= lastId) return
      lastId = id
      onDismiss()
    }),
  ])
  try { accept(await invoke<Snapshot | null>('pending_input')) }
  catch (e) { onError(errorText(e)) }
  return () => unlisten.forEach(fn => fn())
}

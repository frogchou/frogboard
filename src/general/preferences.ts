import { setTheme } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'

export type Appearance = 'system' | 'light' | 'dark'
const appearanceKey = 'frogboard.appearance'
const historyKey = 'frogboard.record-history'
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

export function appearance(): Appearance {
  const value = localStorage.getItem(appearanceKey)
  return value === 'dark' || value === 'light' ? value : 'system'
}

function applyColors(value: Appearance) {
  document.documentElement.dataset.theme = value === 'system' ? (systemDark.matches ? 'dark' : 'light') : value
}

export function initializeAppearance() {
  const saved = appearance()
  applyColors(saved)
  systemDark.addEventListener('change', () => applyColors(appearance()))
  if (isTauri() && saved !== 'system') void setTheme(saved).catch(console.error)
}

export async function saveAppearance(value: Appearance) {
  if (isTauri()) await setTheme(value === 'system' ? null : value)
  localStorage.setItem(appearanceKey, value)
  applyColors(value)
}

export function recordHistory() {
  return localStorage.getItem(historyKey) !== 'off'
}

export function setRecordHistory(enabled: boolean) {
  localStorage.setItem(historyKey, enabled ? 'on' : 'off')
}

import type { Input } from '../desktop'
import type { ConversationMessage } from '../models/api'

export type Turn = { role: 'user' | 'assistant'; text: string }
export type ThreadRow = { id: string; title: string; updated: number }
export type Thread = ThreadRow & { source?: Input; turns: Turn[] }

let database: Promise<IDBDatabase> | undefined
function open() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('frogboard.conversations', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('list', { keyPath: 'id' })
      req.result.createObjectStore('threads', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => { db.close(); database = undefined }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  }).catch(e => { database = undefined; throw e })
  return database
}

function read<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function listThreads(): Promise<ThreadRow[]> {
  const db = await open()
  const rows: ThreadRow[] = await read(db.transaction('list').objectStore('list').getAll())
  return rows.sort((a, b) => b.updated - a.updated)
}

export async function getThread(id: string): Promise<Thread | undefined> {
  const db = await open()
  return read(db.transaction('threads').objectStore('threads').get(id))
}

// Check the turn count in the same transaction as the write. A late reply
// cannot recreate a deleted conversation or overwrite a newer exchange.
async function write(id: string, update: (current?: Thread) => Thread | undefined) {
  const db = await open()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['threads', 'list'], 'readwrite')
    const threads = tx.objectStore('threads')
    const list = tx.objectStore('list')
    const req = threads.get(id)
    let failure: unknown
    req.onsuccess = () => {
      try {
        const next = update(req.result)
        if (next) {
          threads.put(next)
          list.put({ id, title: next.title, updated: next.updated })
        } else {
          threads.delete(id)
          list.delete(id)
        }
      } catch (e) { failure = e; tx.abort() }
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('会话保存失败，请检查本机存储空间。'))
  })
}

const titleOf = (text: string) => Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, 40).join('')

export async function createThread(source?: Input): Promise<string> {
  const id = crypto.randomUUID()
  const title = source?.kind === 'image' ? '剪贴板图片' : titleOf(source?.value ?? '') || '新会话'
  await write(id, () => ({ id, title, updated: Date.now(), source, turns: [] }))
  return id
}

export function appendTurn(id: string, count: number, turn: Turn) {
  return write(id, current => {
    if (!current || current.turns.length !== count) throw new Error('会话已更新或删除，请重新打开。')
    const replacing = turn.role === 'user' && current.turns.at(-1)?.role === 'user'
    const previous = replacing ? current.turns.slice(0, -1) : current.turns
    const title = !previous.length && current.source?.kind !== 'text' ? titleOf(turn.text) : current.title
    return { ...current, title, updated: Date.now(), turns: [...previous, turn] }
  })
}

export const deleteThread = (id: string) => write(id, () => undefined)

export function modelMessages(thread: Thread): ConversationMessage[] {
  return thread.turns.map((turn, index) => {
    const content: Input[] = [{ kind: 'text', value: turn.text }]
    if (index === 0 && thread.source) content.unshift(thread.source)
    return { role: turn.role, content }
  })
}

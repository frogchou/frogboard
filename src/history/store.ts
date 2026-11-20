import type { Input } from '../desktop'

export type Operation = {
  input: Input
  actionId: string
  actionName: string
  instruction: string
  result: string
  completedAt: number
}

export type HistoryRow = {
  id: number
  actionName: string
  kind: Input['kind']
  preview: string
  thumbnail?: string
  completedAt: number
}

const limit = 30
let database: Promise<IDBDatabase> | undefined

function openDatabase() {
  if (database) return database
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('frogboard-operations', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('rows', { keyPath: 'id', autoIncrement: true })
      request.result.createObjectStore('operations')
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); database = undefined }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  }).catch((error: unknown) => { database = undefined; throw error })
  return database
}

// Index and payload are committed and evicted together. Cached previews can
// be listed without loading the original images.
export async function saveOperation(operation: Operation): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['rows', 'operations'], 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('历史记录写入中断'))
    const rows = tx.objectStore('rows')
    const details = tx.objectStore('operations')
    const { actionName, completedAt, input } = operation
    const preview = input.kind === 'text' ? input.value.trim().slice(0, 180) : ''
    const add = rows.add({ actionName, completedAt, kind: input.kind, preview })
    add.onsuccess = () => {
      details.add(operation, add.result)
      const keys = rows.getAllKeys()
      keys.onsuccess = () => {
        for (const id of keys.result.slice(0, Math.max(0, keys.result.length - limit))) {
          rows.delete(id)
          details.delete(id)
        }
      }
    }
  })
}

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function listOperations(): Promise<HistoryRow[]> {
  const db = await openDatabase()
  return (await read(db.transaction('rows').objectStore('rows').getAll())).reverse()
}

export async function loadOperation(id: number): Promise<Operation> {
  const db = await openDatabase()
  const operation = await read(db.transaction('operations').objectStore('operations').get(id))
  if (!operation) throw new Error('这条记录已移出最近 30 条操作。')
  return operation
}

// Generate on first use so existing records get the same preview as new ones.
export async function loadThumbnail(id: number): Promise<string> {
  const { input } = await loadOperation(id)
  const image = new Image()
  image.src = input.value
  await image.decode()
  const scale = Math.min(1, 360 / image.naturalWidth, 168 / image.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法生成图片预览')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const thumbnail = canvas.toDataURL('image/webp', .85)
  const db = await openDatabase()
  const rows = db.transaction('rows', 'readwrite').objectStore('rows')
  const readRow = rows.get(id)
  readRow.onsuccess = () => {
    // The record may have been evicted while the image was decoding.
    if (readRow.result) rows.put({ ...readRow.result, thumbnail })
  }
  return thumbnail
}

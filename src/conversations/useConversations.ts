import { useEffect, useRef, useState } from 'react'
import { errorText, type Input } from '../desktop'
import { runConversation } from '../models/api'
import { appendTurn, createThread, deleteThread, getThread, listThreads, modelMessages, type Thread, type ThreadRow, type Turn } from './store'

export function useConversations(visible: boolean) {
  const [rows, setRows] = useState<ThreadRow[]>([])
  const [selected, select] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Thread>()
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [storageError, setStorageError] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const requests = useRef(new Map<string, AbortController>())
  const creating = useRef(false)
  const refresh = () => setRevision(n => n + 1)
  const thread = loaded?.id === selected ? loaded : undefined

  useEffect(() => {
    if (!visible) return
    let active = true
    setLoading(true)
    void (async () => {
      const list = await listThreads()
      const id = list.find(row => row.id === selected)?.id ?? list[0]?.id ?? null
      const current = id ? await getThread(id) : undefined
      if (!active) return
      setRows(list)
      select(id)
      setLoaded(current)
      setStorageError('')
    })().catch(e => { if (active) setStorageError(errorText(e)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selected, revision, visible])

  useEffect(() => {
    const jobs = requests.current
    return () => { for (const job of jobs.values()) job.abort() }
  }, [])

  function draft(id: string, value: string) {
    setDrafts(previous => ({ ...previous, [id]: value }))
  }

  async function create(source?: Input, question = '') {
    if (creating.current) return
    creating.current = true
    try {
      const id = await createThread(source)
      draft(id, question)
      select(id)
      refresh()
    } finally { creating.current = false }
  }

  async function remove(id: string) {
    await deleteThread(id)
    requests.current.get(id)?.abort()
    setDrafts(previous => { const next = { ...previous }; delete next[id]; return next })
    setErrors(previous => { const next = { ...previous }; delete next[id]; return next })
    select(current => current === id ? null : current)
    refresh()
  }

  async function send(current: Thread, question?: string) {
    const { id } = current
    if (requests.current.has(id)) return
    const controller = new AbortController()
    requests.current.set(id, controller)
    setErrors(previous => ({ ...previous, [id]: '' }))
    let turns = current.turns
    try {
      if (question !== undefined) {
        const turn: Turn = { role: 'user', text: question.trim() }
        if (!turn.text) return
        await appendTurn(id, turns.length, turn)
        draft(id, '')
        turns = [...(turns.at(-1)?.role === 'user' ? turns.slice(0, -1) : turns), turn]
        refresh()
      }
      if (turns.at(-1)?.role !== 'user') return
      const answer = await runConversation(modelMessages({ ...current, turns }), controller.signal)
      await appendTurn(id, turns.length, { role: 'assistant', text: answer })
    } catch (e) {
      if (!controller.signal.aborted) setErrors(previous => ({ ...previous, [id]: errorText(e) }))
    } finally {
      requests.current.delete(id)
      refresh()
    }
  }

  return { rows, selected, thread, loading, storageError, select, create, remove, refresh,
    error: selected ? errors[selected] : '', busy: selected ? requests.current.has(selected) : false,
    draft: selected ? drafts[selected] ?? '' : '', setDraft: draft, send,
    stop: (id: string) => requests.current.get(id)?.abort() }
}

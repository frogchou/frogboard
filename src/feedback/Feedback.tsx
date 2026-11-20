import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react'
import './feedback.css'

type Tone = 'success' | 'error' | 'info'
type Notify = (text: string, tone?: Tone) => void
const Feedback = createContext<Notify | null>(null)

export function useNotify() {
  const notify = useContext(Feedback)
  if (!notify) throw new Error('Missing FeedbackProvider')
  return notify
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; tone: Tone; id: number } | null>(null)
  const next = useRef(0)
  const notify = useCallback<Notify>((text, tone = 'error') => {
    setMessage(text ? { text, tone, id: ++next.current } : null)
  }, [])
  const dismiss = useCallback(() => setMessage(null), [])
  return <Feedback.Provider value={notify}>
    {children}
    {message && <Bubble key={message.id} {...message} dismiss={dismiss}/>}
  </Feedback.Provider>
}

function Bubble({ text, tone, dismiss }: { text: string; tone: Tone; dismiss: () => void }) {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  useEffect(() => {
    if (hover || focus) return
    const timer = window.setTimeout(dismiss, tone === 'error' ? 8000 : 2600)
    return () => window.clearTimeout(timer)
  }, [hover, focus, tone, dismiss])
  const Icon = tone === 'error' ? CircleAlert : tone === 'success' ? CheckCircle2 : Info
  return <div className="feedback-bubble" data-tone={tone} onPointerEnter={() => setHover(true)}
    onPointerLeave={() => setHover(false)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}>
    <Icon size={16} aria-hidden="true"/>
    <span role={tone === 'error' ? 'alert' : 'status'}>{text}</span>
    <button type="button" aria-label="关闭提示" onClick={dismiss}><X size={14}/></button>
  </div>
}

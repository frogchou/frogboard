import { useMemo } from 'react'
import { renderResult } from './markdown'
import './markdown.css'

export default function ModelResult({ text }: { text: string }) {
  const html = useMemo(() => ({ __html: renderResult(text) }), [text])
  return <div className="model-markdown" dangerouslySetInnerHTML={html} />
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { renderResult } from './markdown.ts'

test('renders prose and preserves literal JSX inside a fenced example', () => {
  const source = ['# 代码详解', '这段 **React** 代码使用 `<div>`。', '', '---', '',
    '## 示例', '```jsx', '<div>', '  {tab === "sources" && <ReadNotice />}', '</div>', '```'].join('\n')
  const html = renderResult(source)
  assert.match(html, /<h1>代码详解<\/h1>/)
  assert.match(html, /<strong>React<\/strong>.*<code>&lt;div&gt;<\/code>/)
  assert.match(html, /<hr>\n<h2>示例<\/h2>/)
  assert.match(html, /<pre><code class="language-jsx">&lt;div&gt;\n  \{tab/)
  assert.doesNotMatch(html, /<ReadNotice|\*\*React\*\*|```/)
})

test('keeps plain-text line breaks, nested lists and tables', () => {
  assert.match(renderResult('第一行\n第二行'), /第一行<br>\n第二行/)
  assert.match(renderResult('1. 外层\n   - 内层'), /<ol>[\s\S]*<ul>[\s\S]*内层/)
  assert.match(renderResult('| 列 |\n| --- |\n| 值 |'), /<table>[\s\S]*<th>列<\/th>[\s\S]*<td>值<\/td>/)
})

test('shows markup as text and renders references without active web content', () => {
  const html = renderResult('<button>示例</button>\n\n![配图](https://example.com/a.png) [资料](https://example.com/)')
  assert.match(html, /&lt;button&gt;示例&lt;\/button&gt;/)
  assert.match(html, /配图/)
  assert.match(html, /title="https:\/\/example.com\/">资料<\/span>/)
  assert.doesNotMatch(html, /<(?:img|button|a)\b/)
})

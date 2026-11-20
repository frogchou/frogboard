import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, breaks: true })
const { escapeHtml } = markdown.utils

// Results are documents inside a desktop tool. Preserve references without
// navigating the workbench or fetching a model-supplied image.
markdown.renderer.rules.link_open = (tokens, index) =>
  `<span class="markdown-reference" title="${escapeHtml(tokens[index].attrGet('href') ?? '')}">`
markdown.renderer.rules.link_close = () => '</span>'
markdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
  escapeHtml(renderer.renderInlineAsText(tokens[index].children ?? [], options, env) || '图片')
markdown.renderer.rules.table_open = () => '<div class="markdown-table"><table>\n'
markdown.renderer.rules.table_close = () => '</table></div>\n'

export function renderResult(text: string): string {
  return markdown.render(text)
}

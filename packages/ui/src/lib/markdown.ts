import { marked } from 'marked'

let configured = false

export function markdown(text: string): string {
  if (!configured) {
    marked.setOptions({ breaks: true, gfm: true })
    configured = true
  }
  return marked.parse(text, { async: false }) as string
}

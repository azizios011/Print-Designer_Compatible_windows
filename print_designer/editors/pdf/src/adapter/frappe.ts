/**
 * Frappe HTTP client + one-shot handshake with the hosting desk page.
 *
 * The editor runs in a same-origin iframe on /app/pdf-editor. The page hands
 * over the CSRF token, the Frappe File to open, the user's name and UI
 * language via postMessage once the iframe announces itself.
 */

import { normalizeLang, type Lang } from '@genoffice/i18n'

export interface FrappeFileData {
  docname: string
  name: string
  /** base64 content */
  contentBase64: string
  attachedToDoctype: string | null
  attachedToName: string | null
  isPrivate: boolean
}

export interface Bootstrap {
  file: string | null
  lang: Lang
  csrfToken: string
  fullName: string
}

let boot: Bootstrap | null = null
let handshakePromise: Promise<Bootstrap> | null = null

export function bootstrap(): Promise<Bootstrap> {
  if (boot) return Promise.resolve(boot)
  if (!handshakePromise) {
    handshakePromise = new Promise<Bootstrap>((resolve) => {
      const fallback = window.setTimeout(() => {
        resolve({ file: null, lang: 'en', csrfToken: '', fullName: '' })
      }, 5000)
      const onMessage = (ev: MessageEvent) => {
        if (ev.source !== window.parent) return
        const data = ev.data as Partial<{
          type: string
          file: string | null
          lang: string
          csrfToken: string
          fullName: string
        }>
        if (data?.type !== 'pdf-editor-init') return
        window.clearTimeout(fallback)
        window.removeEventListener('message', onMessage)
        boot = {
          file: typeof data.file === 'string' && data.file ? data.file : null,
          lang: normalizeLang(data.lang),
          csrfToken: typeof data.csrfToken === 'string' ? data.csrfToken : '',
          fullName: typeof data.fullName === 'string' ? data.fullName : '',
        }
        resolve(boot)
      }
      window.addEventListener('message', onMessage)
      window.parent.postMessage({ type: 'pdf-editor-ready' }, window.location.origin)
    })
  }
  return handshakePromise
}

async function api<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const ctx = await bootstrap()
  const res = await fetch(`/api/method/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': ctx.csrfToken,
    },
    credentials: 'same-origin',
    body: JSON.stringify(params ?? {}),
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { exception?: string; _server_messages?: string }
      if (body.exception) message = body.exception
      else if (body._server_messages) {
        const msgs = JSON.parse(body._server_messages) as string[]
        if (msgs.length > 0) message = (JSON.parse(msgs[0]) as { message?: string }).message ?? message
      }
    } catch {
      // keep the status-line message
    }
    throw new Error(message)
  }
  const body = (await res.json()) as { message: T }
  return body.message
}

export function fetchFrappeFile(docname: string): Promise<FrappeFileData> {
  return api<FrappeFileData>('print_designer.api.pdf_editor.open_file', { file: docname })
}

export function saveFrappeFile(params: {
  /** existing File docname to overwrite; omit to create a new File */
  file?: string
  fileName: string
  contentBase64: string
  attachedToDoctype?: string | null
  attachedToName?: string | null
  isPrivate?: boolean
}): Promise<{ docname: string; name: string }> {
  return api<{ docname: string; name: string }>('print_designer.api.pdf_editor.save_file', params)
}

/** base64 (no data: prefix) ← bytes */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** bytes ← base64 (no data: prefix) */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

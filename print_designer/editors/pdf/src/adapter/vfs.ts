/**
 * Session in-memory store for document bytes that do not live (yet) in a
 * Frappe File: locally picked PDFs and generated outputs (merged/split/…).
 * Paths use the `gen:<id>:<name>` scheme so the UI can always show a file name.
 */

let counter = 0

const store = new Map<string, Uint8Array>()

export function genPath(name: string): string {
  counter += 1
  return `gen:${counter}:${name}`
}

export function vfsPut(path: string, bytes: Uint8Array): void {
  store.set(path, bytes)
}

export function vfsGet(path: string): Uint8Array | undefined {
  return store.get(path)
}

export function vfsHas(path: string): boolean {
  return store.has(path)
}

export function vfsPathName(path: string): string {
  const idx = path.indexOf(':', path.indexOf(':') + 1)
  return idx === -1 ? path : path.slice(idx + 1)
}

/** Parse a path into its Frappe File docname and display name, or null when it is not a Frappe file */
export function parseFrappePath(path: string): { docname: string; name: string } | null {
  if (!path.startsWith('frappe-file:')) return null
  const rest = path.slice('frappe-file:'.length)
  const sep = rest.indexOf(':')
  if (sep === -1) return { docname: rest, name: rest }
  return { docname: rest.slice(0, sep), name: rest.slice(sep + 1) }
}

export function frappePath(docname: string, name: string): string {
  return `frappe-file:${docname}:${name}`
}

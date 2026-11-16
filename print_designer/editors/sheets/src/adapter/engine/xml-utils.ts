/**
 * Minimal XML utilities for the in-browser xlsx reader.
 *
 * The desktop engine parses OOXML with quick-xml in Rust; here a small set of
 * regex/scan helpers covers the worksheet/styles/workbook parts the renderer
 * needs. All XML is unescaped through `decodeEntities`; attribute access goes
 * through `readAttrs`/`attr` so quoting variations cannot corrupt values.
 * Parts come from the zip already UTF-8-decoded (see archive.ts readText).
 */

/** Decode the five XML entities OOXML uses (numeric refs pass through). */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function encodeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\u0000/g, '') // NUL is not representable; producers strip it
}

/** Raw (still-encoded) attribute map of one tag's source text. */
export function readAttrs(tagSource: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([A-Za-z0-9_:.-]+)\s*=\s*("[^"]*"|'[^']*')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(tagSource)) !== null) {
    attrs[match[1]!] = match[2]!.slice(1, -1)
  }
  return attrs
}

/** Decode a single attribute's value (or null). */
export function attr(attrs: Record<string, string>, name: string): string | null {
  const raw = attrs[name]
  return raw === undefined ? null : decodeEntities(raw)
}

export function attrInt(attrs: Record<string, string>, name: string): number | null {
  const raw = attr(attrs, name)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? Math.trunc(value) : null
}

export function attrFloat(attrs: Record<string, string>, name: string): number | null {
  const raw = attr(attrs, name)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function attrBool(attrs: Record<string, string>, name: string): boolean {
  return attr(attrs, name) === '1' || attr(attrs, name) === 'true'
}

/**
 * Iterate every element instance with the given local name. Self-closing and
 * paired tags both yield; the callback receives the full open tag source
 * (attributes readable via readAttrs) and, for paired tags, the inner source.
 * Nested same-name elements inside the body are NOT matched — OOXML parts
 * the reader consumes never nest their own name meaningfully.
 */
export function eachElement(
  xml: string,
  localName: string,
  visit: (tagSource: string, body: string, selfClosing: boolean) => void,
): void {
  // `<name`, `<ns:name` — a word boundary excludes longer names like sheetData vs sheet
  const pattern = new RegExp(`<([A-Za-z0-9_.-]+:)?${localName}(?=[\\s/>])`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const openStart = match.index
    // find the end of the open tag (attributes can contain '>')
    let i = pattern.lastIndex
    let inQuote: string | null = null
    while (i < xml.length) {
      const ch = xml[i]!
      if (inQuote) {
        if (ch === inQuote) inQuote = null
      } else if (ch === '"' || ch === "'") {
        inQuote = ch
      } else if (ch === '>') {
        break
      }
      i += 1
    }
    if (i >= xml.length) return
    const tagSource = xml.slice(openStart, i + 1)
    const selfClosing = xml[i - 1] === '/'
    if (selfClosing) {
      visit(tagSource, '', true)
      continue
    }
    const closePattern = new RegExp(`</([A-Za-z0-9_.-]+:)?${localName}\\s*>`)
    closePattern.lastIndex = 0
    const rest = xml.slice(i + 1)
    const close = closePattern.exec(rest)
    if (!close) {
      visit(tagSource, rest, false)
      return
    }
    visit(tagSource, rest.slice(0, close.index), false)
    pattern.lastIndex = i + 1 + close.index + close[0].length
  }
}

/** First element's tag source + body, or null. */
export function firstElement(
  xml: string,
  localName: string,
): { tagSource: string; body: string; selfClosing: boolean } | null {
  let found: { tagSource: string; body: string; selfClosing: boolean } | null = null
  eachElement(xml, localName, (tagSource, body, selfClosing) => {
    if (found === null) found = { tagSource, body, selfClosing }
  })
  return found
}

/** Text content of an element body (concatenated text + t/run text). */
export function elementText(body: string): string {
  // strip comments/CDATA markers that would leak into values
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, '')
  return decodeEntities(cleaned.replace(/<[^>]*>/g, ''))
}

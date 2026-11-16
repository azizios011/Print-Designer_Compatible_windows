/**
 * styles.xml + theme1.xml reader → the wire `WorkbookCellStyle` entries the
 * renderer maps into Univer styles (mirrors what the Rust sidecar resolved in
 * the desktop build, incl. theme-color provenance and tint resolution).
 */

import {
  attr,
  attrBool,
  attrFloat,
  attrInt,
  decodeEntities,
  eachElement,
  firstElement,
  readAttrs,
} from './xml-utils'
import type { WorkbookCellStyle } from '../../shared/desktop-api'

/** Builtin number formats (ECMA-376 §18.8.30); 14/22 are locale-sensitive. */
const BUILTIN_NUMFMTS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
}

export interface StylesInfo {
  styles: WorkbookCellStyle[]
  dxfStyles: WorkbookCellStyle[]
  /** date formats actually used for builtin 14/22 (after shortDateFormat) */
  shortDateFormat: string
}

interface ThemeColors {
  /** 12 #RRGGBB slots: [lt1, dk1, lt2, dk2, accent1-6, hlink, folHlink] */
  colors: string[]
  majorFont: string
  minorFont: string
  minorEa?: string
}

// ── theme color helpers ──────────────────────────────────────────────────────

function hlsMax(): number {
  return 255
}

function rgbToHls(r: number, g: number, b: number): { h: number; l: number; s: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const delta = max - min
    s = l > 127.5 ? delta / (2 * hlsMax() - max - min) : delta / (max + min)
    if (max === r) h = (g - b) / delta
    else if (max === g) h = 2 + (b - r) / delta
    else h = 4 + (r - g) / delta
    h *= 60
    if (h < 0) h += 360
  }
  return { h, l, s }
}

function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = ((h % 360) + 360) % 360
  const x = c * (1 - Math.abs(((hp / 60) % 2) - 1))
  const m = l - c / 2
  let rgb: [number, number, number]
  if (hp < 60) rgb = [c, x, 0]
  else if (hp < 120) rgb = [x, c, 0]
  else if (hp < 180) rgb = [0, c, x]
  else if (hp < 240) rgb = [0, x, c]
  else if (hp < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ]
}

/** OOXML tint applied to a #RRGGBB color (ECMA-376 §17.5.2.19 algorithm). */
export function applyTint(hex: string, tint: number): string {
  if (tint === 0) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const hls = rgbToHls(r, g, b)
  let l = hls.l / 255
  if (tint < 0) l *= 1 + tint
  else l = l * (1 - tint) + tint
  const [nr, ng, nb] = hlsToRgb(hls.h, Math.min(1, Math.max(0, l)), hls.s)
  const to2 = (v: number): string => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')
  return `#${to2(nr)}${to2(ng)}${to2(nb)}`.toUpperCase()
}

/** Parse a color string as it appears in styles/theme: #RRGGBB, FFRRGGBB, named. */
function parseColor(raw: string | null): string | null {
  if (!raw) return null
  const value = raw.trim().toUpperCase()
  if (/^#[0-9A-F]{6}$/.test(value)) return value
  if (/^[0-9A-F]{8}$/.test(value)) return `#${value.slice(2)}`
  if (/^#[0-9A-F]{8}$/.test(value)) return value.slice(0, 7)
  if (/^[0-9A-F]{6}$/.test(value)) return `#${value}`
  // common named colors in legacy files
  const NAMED: Record<string, string> = {
    BLACK: '#000000',
    WHITE: '#FFFFFF',
    RED: '#FF0000',
    GREEN: '#008000',
    BLUE: '#0000FF',
    YELLOW: '#FFFF00',
    CYAN: '#00FFFF',
    MAGENTA: '#FF00FF',
    GRAY: '#808080',
    GREY: '#808080',
    SILVER: '#C0C0C0',
    MAROON: '#800000',
    OLIVE: '#808000',
    LIME: '#00FF00',
    AQUA: '#00FFFF',
    TEAL: '#008080',
    NAVY: '#000080',
    FUCHSIA: '#FF00FF',
    PURPLE: '#800080',
    AUTOMATIC: '#000000',
  }
  return NAMED[value] ?? null
}

/** The palette slot index for a theme color reference. */
function themeSlot(attrs: Record<string, string>): number | null {
  const index = attrInt(attrs, 'theme')
  return index === null ? null : Math.min(11, Math.max(0, index))
}

interface ColorRead {
  hex: string | null
  theme: number | undefined
  tint: number | undefined
}

/** Read one color child (rgb | theme+tint | indexed) from an element body. */
function readColorElement(body: string, indexedColors?: string[]): ColorRead {
  let hex: string | null = null
  let theme: number | undefined
  let tint: number | undefined
  eachElement(body, 'a:sysClr', (tag) => {
    const attrs = readAttrs(tag)
    hex = parseColor(attr(attrs, 'lastClr'))
  })
  eachElement(body, 'a:srgbClr', (tag, inner) => {
    if (hex !== null) return
    hex = parseColor(attr(readAttrs(tag), 'val'))
    // alphaModFix / lumMod etc. are display refinements; tint rides the xf
    void inner
  })
  eachElement(body, 'a:prstClr', (tag) => {
    if (hex !== null) return
    hex = parseColor(attr(readAttrs(tag), 'val'))
  })
  eachElement(body, 'color', (tag) => {
    const attrs = readAttrs(tag)
    const rgb = parseColor(attr(attrs, 'rgb'))
    if (rgb !== null) {
      hex = rgb
      const slot = themeSlot(attrs)
      if (slot !== null) theme = slot
    } else {
      const slot = themeSlot(attrs)
      if (slot !== null) {
        theme = slot
        hex = null
      }
    }
    const tintRaw = attrFloat(attrs, 'tint')
    if (tintRaw !== null) tint = tintRaw
    const indexed = attrInt(attrs, 'indexed')
    if (indexed !== null && indexedColors) hex = indexedColors[indexed] ?? hex
  })
  return { hex, theme, tint }
}

// ── theme1.xml ───────────────────────────────────────────────────────────────

export function parseTheme(themeXml: string): ThemeColors {
  const colors: string[] = []
  const slots = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
  let majorFont = 'Calibri'
  let minorFont = 'Calibri'
  let minorEa: string | undefined
  eachElement(themeXml, 'clrScheme', (_tag, body) => {
    for (const slot of slots) {
      const el = firstElement(body, slot)
      if (!el) {
        colors.push(slot === 'lt1' ? '#FFFFFF' : slot === 'dk1' ? '#000000' : '#000000')
        continue
      }
      const read = readColorElement(el.body)
      colors.push(read.hex ?? (slot === 'lt1' ? '#FFFFFF' : '#000000'))
    }
  })
  // slot order: file order is dk1/lt1 (or lt1/dk1) — OOXML stores dk1 first
  // when the theme was authored that way; Excel's index order is
  // [lt1, dk1, lt2, dk2, …] with swap for indices 0..3.
  const swapped = [...colors]
  const firstSlot = colors[0]?.toUpperCase()
  if (firstSlot === '#FFFFFF') {
    // file started with lt1: already in wire order except dk1/lt1 pairing below
  }
  // Some producers write dk1 before lt1; normalize so wire slot 0 = lt1 (light).
  if (swapped[0] && swapped[0].toUpperCase() !== '#FFFFFF' && swapped[1]?.toUpperCase() === '#FFFFFF') {
    const tmp = swapped[0]
    swapped[0] = swapped[1]
    swapped[1] = tmp
  }
  eachElement(themeXml, 'fontScheme', (_tag, body) => {
    const major = firstElement(body, 'a:majorFont')
    const minor = firstElement(body, 'a:minorFont')
    if (major) {
      const latin = firstElement(major.body, 'a:latin')
      if (latin) majorFont = decodeEntities(attr(readAttrs(latin.tagSource), 'typeface') ?? majorFont)
    }
    if (minor) {
      const latin = firstElement(minor.body, 'a:latin')
      if (latin) minorFont = decodeEntities(attr(readAttrs(latin.tagSource), 'typeface') ?? minorFont)
      const ea = firstElement(minor.body, 'a:ea')
      const eaName = ea ? attr(readAttrs(ea.tagSource), 'typeface') : null
      if (eaName && eaName.trim() !== '') minorEa = eaName
    }
  })
  return { colors: swapped, majorFont, minorFont, ...(minorEa !== undefined ? { minorEa } : {}) }
}

// ── styles.xml ───────────────────────────────────────────────────────────────

interface FontEntry {
  name: string
  size: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  vertAlign: string | null
  color: ColorRead
  scheme: string | null
}

interface FillEntry {
  kind: 'none' | 'solid' | 'pattern' | 'gradient'
  color: ColorRead
  bgColor: ColorRead
  patternType: string | null
}

interface BorderEntry {
  top: { style: string | null; color: ColorRead } | null
  bottom: { style: string | null; color: ColorRead } | null
  left: { style: string | null; color: ColorRead } | null
  right: { style: string | null; color: ColorRead } | null
  diagonal: { style: string | null; color: ColorRead } | null
  diagonalUp: boolean
  diagonalDown: boolean
}

interface XfEntry {
  numFmtId: number
  fontId: number
  fillId: number
  borderId: number
  applyNumberFormat: boolean
  applyFont: boolean
  applyFill: boolean
  applyBorder: boolean
  applyAlignment: boolean
  applyProtection: boolean
  alignment: Record<string, string> | null
  protection: Record<string, string> | null
}

const BORDER_STYLES = new Set([
  'thin', 'medium', 'thick', 'double', 'dashed', 'dotted', 'hair', 'mediumDashed',
  'dashDot', 'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot',
])

function readFont(body: string, theme: ThemeColors): FontEntry {
  const font: FontEntry = {
    name: '',
    size: 11,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    vertAlign: null,
    color: { hex: null, theme: undefined, tint: undefined },
    scheme: null,
  }
  eachElement(body, 'name', (tag) => {
    font.name = decodeEntities(attr(readAttrs(tag), 'val') ?? '')
  })
  eachElement(body, 'sz', (tag) => {
    font.size = attrFloat(readAttrs(tag), 'val') ?? 11
  })
  eachElement(body, 'b', (tag) => {
    const val = attr(readAttrs(tag), 'val')
    font.bold = val === null || val === '1' || val === 'true'
  })
  eachElement(body, 'i', (tag) => {
    const val = attr(readAttrs(tag), 'val')
    font.italic = val === null || val === '1' || val === 'true'
  })
  eachElement(body, 'u', (tag) => {
    const val = attr(readAttrs(tag), 'val')
    font.underline = val !== 'none'
    void val
  })
  eachElement(body, 'strike', () => {
    font.strike = true
  })
  eachElement(body, 'vertAlign', (tag) => {
    font.vertAlign = attr(readAttrs(tag), 'val')
  })
  eachElement(body, 'color', (tag) => {
    font.color = readColorElement(tag)
  })
  eachElement(body, 'scheme', (tag) => {
    font.scheme = attr(readAttrs(tag), 'val')
  })
  // A theme font color resolves through the palette with its tint. The
  // parsed palette is already in wire order [lt1, dk1, lt2, dk2, …] matching
  // the OOXML `theme` attribute indices.
  if (font.color.hex === null && font.color.theme !== undefined) {
    const base = theme.colors[font.color.theme] ?? '#000000'
    font.color = {
      hex: applyTint(base, font.color.tint ?? 0),
      theme: font.color.theme,
      tint: font.color.tint,
    }
  }
  return font
}

function readFill(body: string): FillEntry {
  const fill: FillEntry = { kind: 'none', color: { hex: null, theme: undefined, tint: undefined }, bgColor: { hex: null, theme: undefined, tint: undefined }, patternType: null }
  const pattern = firstElement(body, 'patternFill')
  if (pattern) {
    fill.patternType = attr(readAttrs(pattern.tagSource), 'patternType')
    const fg = firstElement(pattern.body, 'fgColor')
    if (fg) fill.color = readColorElement(fg.body)
    const bg = firstElement(pattern.body, 'bgColor')
    if (bg) fill.bgColor = readColorElement(bg.body)
    fill.kind = fill.patternType === null ? 'none' : fill.patternType === 'none' ? 'none' : fill.patternType === 'solid' ? 'solid' : 'pattern'
  }
  const gradient = firstElement(body, 'gradientFill')
  if (gradient) {
    fill.kind = 'gradient'
    const stop = firstElement(gradient.body, 'stop')
    if (stop) fill.color = readColorElement(stop.body)
  }
  return fill
}

function readBorder(body: string): BorderEntry {
  // `body` is the INNER content of the <border> element (the caller iterates
  // <borders><border>…</border></borders> and hands each <border>'s body —
  // same convention readFill uses for <patternFill>/<gradientFill>)
  const entry: BorderEntry = {
    top: null,
    bottom: null,
    left: null,
    right: null,
    diagonal: null,
    diagonalUp: false,
    diagonalDown: false,
  }
  const border = firstElement(body, 'border')
  // tolerate the outer-element form too (a body that still wraps <border>)
  const source = border ? border.body : body
  const attrs = border ? readAttrs(border.tagSource) : {}
  const edge = (name: string): { style: string | null; color: ColorRead } | null => {
    const el = firstElement(source, name)
    if (!el) return null
    const style = attr(readAttrs(el.tagSource), 'style')
    if (style === null || !BORDER_STYLES.has(style)) return null
    const color = firstElement(el.body, 'color')
    return { style, color: color ? readColorElement(color.body) : { hex: null, theme: undefined, tint: undefined } }
  }
  entry.top = edge('top')
  entry.bottom = edge('bottom')
  entry.left = edge('left')
  entry.right = edge('right')
  entry.diagonal = edge('diagonal')
  return entry
}

function readXf(tagSource: string, body: string): XfEntry {
  const attrs = readAttrs(tagSource)
  const xf: XfEntry = {
    numFmtId: attrInt(attrs, 'numFmtId') ?? 0,
    fontId: attrInt(attrs, 'fontId') ?? 0,
    fillId: attrInt(attrs, 'fillId') ?? 0,
    borderId: attrInt(attrs, 'borderId') ?? 0,
    applyNumberFormat: attrBool(attrs, 'applyNumberFormat'),
    applyFont: attrBool(attrs, 'applyFont'),
    applyFill: attrBool(attrs, 'applyFill'),
    applyBorder: attrBool(attrs, 'applyBorder'),
    applyAlignment: attrBool(attrs, 'applyAlignment'),
    applyProtection: attrBool(attrs, 'applyProtection'),
    alignment: null,
    protection: null,
  }
  const alignment = firstElement(body, 'alignment')
  if (alignment) xf.alignment = readAttrs(alignment.tagSource)
  const protection = firstElement(body, 'protection')
  if (protection) xf.protection = readAttrs(protection.tagSource)
  return xf
}

interface ParsedStyles {
  fonts: FontEntry[]
  fills: FillEntry[]
  borders: BorderEntry[]
  numFmts: Map<number, string>
  cellXfs: XfEntry[]
  cellStyleXfs: XfEntry[]
  dxfs: XfEntry[]
  indexedColors: string[]
}

function parseStyleParts(stylesXml: string, theme: ThemeColors): ParsedStyles {
  const parsed: ParsedStyles = {
    fonts: [],
    fills: [],
    borders: [],
    numFmts: new Map(),
    cellXfs: [],
    cellStyleXfs: [],
    dxfs: [],
    indexedColors: [],
  }
  // legacy indexed palette (53 default colors; producers may override)
  const LEGACY_INDEXED: Record<number, string> = {
    0: '#000000', 1: '#FFFFFF', 2: '#FF0000', 3: '#00FF00', 4: '#0000FF',
    5: '#FFFF00', 6: '#FF00FF', 7: '#00FFFF', 8: '#000000', 9: '#FFFFFF',
    10: '#FF0000', 11: '#00FF00', 12: '#0000FF', 13: '#FFFF00', 14: '#FF00FF',
    15: '#00FFFF', 16: '#800000', 17: '#008000', 18: '#000080', 19: '#808000',
    20: '#800080', 21: '#008080', 22: '#C0C0C0', 23: '#808080', 24: '#9999FF',
    25: '#993366', 26: '#FFFFCC', 27: '#CCFFFF', 28: '#660066', 29: '#FF8080',
    30: '#0066CC', 31: '#CCCCFF', 32: '#000080', 33: '#FF00FF', 34: '#FFFF00',
    35: '#00FFFF', 36: '#800080', 37: '#800000', 38: '#008080', 39: '#0000FF',
    40: '#00CCFF', 41: '#CCFFFF', 42: '#CCFFCC', 43: '#FFFF99', 44: '#99CCFF',
    45: '#FF99CC', 46: '#CC99FF', 47: '#FFCC99', 48: '#3366FF', 49: '#33CCCC',
    50: '#99CC00', 51: '#FFCC00', 52: '#FF9900', 53: '#FF6600',
  }
  eachElement(stylesXml, 'colors', (_tag, body) => {
    eachElement(body, 'indexedColors', (_t, inner) => {
      eachElement(inner, 'rgbColor', (tag) => {
        const hex = parseColor(attr(readAttrs(tag), 'rgb'))
        const index = attrInt(readAttrs(tag), 'index')
        if (hex !== null && index !== null) LEGACY_INDEXED[index] = hex
      })
    })
  })
  for (const [index, hex] of Object.entries(LEGACY_INDEXED)) parsed.indexedColors[Number(index)] = hex

  eachElement(stylesXml, 'numFmt', (tag) => {
    const attrs = readAttrs(tag)
    const id = attrInt(attrs, 'numFmtId')
    const code = attr(attrs, 'formatCode')
    if (id !== null && code !== null) parsed.numFmts.set(id, decodeEntities(code))
  })
  eachElement(stylesXml, 'font', (_tag, body) => {
    parsed.fonts.push(readFont(body, theme))
  })
  eachElement(stylesXml, 'fill', (_tag, body) => {
    parsed.fills.push(readFill(body))
  })
  eachElement(stylesXml, 'border', (_tag, body) => {
    parsed.borders.push(readBorder(body))
  })
  eachElement(stylesXml, 'cellXfs', (_tag, body) => {
    eachElement(body, 'xf', (tag, inner) => {
      parsed.cellXfs.push(readXf(tag, inner))
    })
  })
  eachElement(stylesXml, 'cellStyleXfs', (_tag, body) => {
    eachElement(body, 'xf', (tag, inner) => {
      parsed.cellStyleXfs.push(readXf(tag, inner))
    })
  })
  eachElement(stylesXml, 'dxfs', (_tag, body) => {
    eachElement(body, 'dxf', (_t, inner) => {
      // a dxf carries delta font/fill/border directly
      const xf: XfEntry = {
        numFmtId: 0, fontId: 0, fillId: 0, borderId: 0,
        applyNumberFormat: false, applyFont: false, applyFill: false, applyBorder: false,
        applyAlignment: false, applyProtection: false, alignment: null, protection: null,
      }
      const fontEl = firstElement(inner, 'font')
      const fillEl = firstElement(inner, 'fill')
      const borderEl = firstElement(inner, 'border')
      // store as extra entries so dxfStyles can reference them like regular ids
      const fontIndex = parsed.fonts.length
      parsed.fonts.push(fontEl ? readFont(fontEl.body, theme) : { name: '', size: 11, bold: false, italic: false, underline: false, strike: false, vertAlign: null, color: { hex: null, theme: undefined, tint: undefined }, scheme: null })
      const fillIndex = parsed.fills.length
      parsed.fills.push(fillEl ? readFill(fillEl.body) : { kind: 'none', color: { hex: null, theme: undefined, tint: undefined }, bgColor: { hex: null, theme: undefined, tint: undefined }, patternType: null })
      const borderIndex = parsed.borders.length
      parsed.borders.push(borderEl ? readBorder(borderEl.body) : { top: null, bottom: null, left: null, right: null, diagonal: null, diagonalUp: false, diagonalDown: false })
      parsed.dxfs.push({ ...xf, fontId: fontIndex, fillId: fillIndex, borderId: borderIndex, applyFont: fontEl !== null, applyFill: fillEl !== null, applyBorder: borderEl !== null })
    })
  })
  return parsed
}

function colorToWire(
  read: ColorRead,
  theme: ThemeColors,
  fallback: string | null,
): { color: string | null; theme: number | undefined; tint: number | undefined } {
  if (read.hex !== null) {
    return { color: read.hex, theme: read.theme, tint: read.tint }
  }
  if (read.theme !== undefined) {
    const base = theme.colors[read.theme] ?? theme.colors[read.theme] ?? '#000000'
    const tint = read.tint ?? 0
    return { color: applyTint(base, tint), theme: read.theme, tint: read.tint === undefined ? undefined : read.tint }
  }
  return { color: fallback, theme: undefined, tint: undefined }
}

function styleFromXf(
  xf: XfEntry,
  parsed: ParsedStyles,
  theme: ThemeColors,
  shortDateFormat: string,
  isDxf: boolean,
): WorkbookCellStyle {
  const style: WorkbookCellStyle = { bold: false, italic: false, underline: false, strikethrough: false, wrapText: false, diagonalUp: false, diagonalDown: false }
  const font = parsed.fonts[xf.fontId]
  const applyFont = isDxf ? false : true
  if (font && (applyFont || isDxf)) {
    if (font.name) style.fontFamily = font.name
    if (font.scheme === 'major') style.fontScheme = 'major'
    else if (font.scheme === 'minor') style.fontScheme = 'minor'
    style.bold = font.bold
    style.italic = font.italic
    style.underline = font.underline
    style.strikethrough = font.strike
    if (font.size > 0) style.fontSize = font.size
    if (font.vertAlign === 'superscript' || font.vertAlign === 'subscript') style.vertAlign = font.vertAlign
    const wire = colorToWire(font.color, theme, null)
    if (wire.color) {
      style.fontColor = wire.color
      if (wire.theme !== undefined) style.fontColorTheme = wire.theme
      if (wire.tint !== undefined) style.fontColorTint = wire.tint
    }
  }
  const fill = parsed.fills[xf.fillId]
  if (fill && (isDxf || xf.applyFill || !isDxf)) {
    if (fill.kind === 'solid' || (fill.kind === 'pattern' && fill.color.hex !== null)) {
      const wire = colorToWire(fill.color, theme, fill.bgColor.hex)
      if (wire.color) {
        style.fillColor = wire.color
        if (wire.theme !== undefined) style.fillColorTheme = wire.theme
        if (wire.tint !== undefined) style.fillColorTint = wire.tint
      }
    } else if (fill.kind === 'gradient' && fill.color.hex !== null) {
      style.fillColor = fill.color.hex
    }
  }
  if (isDxf || xf.applyBorder || !isDxf) {
    const border = parsed.borders[xf.borderId]
    if (border) {
      const edge = (e: { style: string | null; color: ColorRead } | null): { style: string; color?: string } | undefined => {
        if (!e?.style) return undefined
        const wire = colorToWire(e.color, theme, null)
        return { style: e.style, ...(wire.color ? { color: wire.color } : {}) }
      }
      const top = edge(border.top)
      if (top) style.borderTop = top
      const bottom = edge(border.bottom)
      if (bottom) style.borderBottom = bottom
      const left = edge(border.left)
      if (left) style.borderLeft = left
      const right = edge(border.right)
      if (right) style.borderRight = right
      const diagonal = edge(border.diagonal)
      if (diagonal) style.borderDiagonal = diagonal
      style.diagonalUp = border.diagonalUp
      style.diagonalDown = border.diagonalDown
    }
  }
  if ((isDxf || xf.applyNumberFormat || !isDxf) && xf.numFmtId !== 0) {
    const code = parsed.numFmts.get(xf.numFmtId) ?? BUILTIN_NUMFMTS[xf.numFmtId]
    if (code) {
      if (xf.numFmtId === 14 || xf.numFmtId === 22) style.numberFormat = shortDateFormat
      else style.numberFormat = code
    }
  }
  if (xf.alignment && (isDxf || xf.applyAlignment || !isDxf)) {
    const a = xf.alignment
    const h = attr(a, 'horizontal')
    if (h) style.horizontalAlignment = h
    const v = attr(a, 'vertical')
    if (v) style.verticalAlignment = v
    if (attrBool(a, 'wrapText')) style.wrapText = true
    if (attrBool(a, 'shrinkToFit')) style.shrinkToFit = true
    const indent = attrInt(a, 'indent')
    if (indent !== null && indent > 0) style.indent = indent
    const rotation = attrInt(a, 'textRotation')
    if (rotation !== null && rotation !== 0) style.textRotation = rotation
  }
  if (xf.protection && (isDxf || xf.applyProtection || !isDxf)) {
    if (attr(xf.protection, 'locked') === '0') style.locked = false
    if (attr(xf.protection, 'hidden') === '1') style.hidden = true
  }
  return style
}

/**
 * Parse styles.xml into the wire style arrays. `shortDateFormat` replaces
 * builtin 14/22 (the sidecar took it from the OS locale; the browser passes
 * the UI language's convention).
 */
export function parseStyles(stylesXml: string, theme: ThemeColors, shortDateFormat: string): StylesInfo {
  const parsed = parseStyleParts(stylesXml, theme)
  const styles = parsed.cellXfs.map((xf) => styleFromXf(xf, parsed, theme, shortDateFormat, false))
  const dxfStyles = parsed.dxfs.map((xf) => styleFromXf(xf, parsed, theme, shortDateFormat, true))
  return { styles, dxfStyles, shortDateFormat }
}

/** The Normal-style font face (cellXfs[0]'s base), for column-width MDW math. */
export function normalFontName(parsed: ParsedStyles, theme: ThemeColors): string {
  const xf = parsed.cellXfs[0]
  const font = xf ? parsed.fonts[xf.fontId] : undefined
  return font?.name || theme.minorFont
}

export { BUILTIN_NUMFMTS, colorToWire, parseStyleParts, readColorElement }
export type { ParsedStyles, FontEntry, FillEntry, BorderEntry }

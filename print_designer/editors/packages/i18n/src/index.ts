/**
 * Minimal typed i18n core shared by the editors bundled into Print Designer.
 *
 * Vendored from GenOffice `packages/i18n` (Apache-2.0, see
 * editors/THIRD_PARTY/genoffice/): the language set is trimmed to the UI
 * languages Print Designer ships (en, fr, ar) and the base/fallback language
 * is `en`.
 */

export type Lang = 'en' | 'fr' | 'ar'

export const LANGS: readonly Lang[] = ['en', 'fr', 'ar']

export function isLang(value: unknown): value is Lang {
	return typeof value === 'string' && (LANGS as readonly string[]).includes(value)
}

/** map a raw locale string ('fr-CA', 'ar-EG', 'en-US', …) to a supported Lang */
export function normalizeLang(raw: string | null | undefined): Lang {
	const value = raw?.trim().toLowerCase()
	if (!value) return 'en'
	for (const lang of LANGS) {
		if (value === lang || value.startsWith(`${lang}-`) || value.startsWith(`${lang}_`)) return lang
	}
	return 'en'
}

const HTML_LANGS: Record<Lang, string> = {
	en: 'en-US',
	fr: 'fr-FR',
	ar: 'ar-SA',
}

/** BCP-47 tag for document.documentElement.lang (drives CSS :lang() and Chromium's per-language font fallback) */
export function htmlLang(lang: Lang): string {
	return HTML_LANGS[lang]
}

/** Languages whose script reads right-to-left: UI chrome flips direction for them */
const RTL_LANGS: readonly Lang[] = ['ar']

/** Whether this UI language lays out right-to-left (drives the renderers' html dir) */
export function isRtlLang(lang: string | undefined | null): boolean {
	return (RTL_LANGS as readonly string[]).includes(lang ?? '')
}

/** The `dir` attribute value for a UI language: every bootstrap and every locale
 *  setter writes the same expression, so the ternary lives here once. */
export function htmlDir(lang: string | undefined | null): 'rtl' | 'ltr' {
	return isRtlLang(lang) ? 'rtl' : 'ltr'
}

// ---- platform-native shortcut hints ----
// Dictionaries write shortcut hints in Mac notation (⌘S, ⇧⌘Z, ⌘+Click); on
// Windows/Linux every translated string is rewritten to Ctrl/Alt/Shift form.

const MAC_KEY_NAMES: Record<string, string> = {
	'⌫': 'Backspace',
	'⌦': 'Delete',
	'⏎': 'Enter',
	'↩': 'Enter',
	'␣': 'Space',
}

const HAS_MAC_SYMBOL = /[⌘⌃⌥⇧⌫⌦⏎↩␣]/
const CHORD = /([⌘⌃⌥⇧]+)(F\d{1,2}|[A-Za-z0-9±=`'\\,./;[\]\-←↑→↓⌫⌦⏎↩␣]|\+)?/g

function chordToWin(mods: string, key: string | undefined): string {
	const parts: string[] = []
	if (mods.includes('⌘') || mods.includes('⌃')) parts.push('Ctrl')
	if (mods.includes('⌥')) parts.push('Alt')
	if (mods.includes('⇧')) parts.push('Shift')
	if (key) parts.push(MAC_KEY_NAMES[key] ?? key)
	return parts.join('+')
}

/** rewrite Mac shortcut notation in a UI string to Windows/Linux form (pure) */
export function macShortcutsToWin(text: string): string {
	if (!HAS_MAC_SYMBOL.test(text)) return text
	return text
		.replace(/⌘\/(?=\p{L}{2})/gu, '') // "⌘/Ctrl+Enter" dual-platform listings: keep the Ctrl side
		.replace(CHORD, (_m, mods: string, key: string | undefined) =>
			key === '+' ? `${chordToWin(mods, undefined)}+` : chordToWin(mods, key),
		)
		.replace(/[⌫⌦⏎↩␣]/g, (glyph) => MAC_KEY_NAMES[glyph] ?? glyph)
}

const IS_MAC = (() => {
	const g = globalThis as {
		navigator?: { platform?: string }
	}
	if (g.navigator?.platform) return /mac/i.test(g.navigator.platform)
	return false
})()

/** platform-aware shortcut display: identity on macOS */
export const platformShortcuts: (text: string) => string = IS_MAC
	? (text) => text
	: macShortcutsToWin

export type Params = Record<string, string | number>

/** fill {name} placeholders; unknown or nullish ones are left as-is */
export function format(template: string, params?: Params): string {
	if (!params) return template
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		// hasOwn guards inherited properties; the nullish check keeps an explicitly
		// undefined param from rendering as the literal text "undefined"
		Object.hasOwn(params, name) && params[name] != null ? String(params[name]) : match,
	)
}

/** per-language dictionaries; en defines the key set, all others must match it */
export type LangDicts<D extends Record<string, string>> = { en: D } & {
	[L in Exclude<Lang, 'en'>]: Record<keyof D, string>
}

/**
 * Identity helper for dictionary shards: keeps literal key inference while
 * type-checking that every other language covers exactly the en key set.
 */
export function defineStrings<D extends Record<string, string>>(dicts: LangDicts<D>): LangDicts<D> {
	return dicts
}

/**
 * Build a translator over per-language dictionaries. The en dictionary defines
 * the key set; every other language must cover exactly the same keys
 * (compile-time checked), so a missing translation is a type error, not a
 * runtime fallback.
 */
export function createI18n<D extends Record<string, string>>(dicts: LangDicts<D>) {
	return (lang: Lang, key: keyof D, params?: Params): string => {
		// A shard that predates a key must degrade (en, then the key)
		// instead of throwing inside format()
		const text = dicts[lang]?.[key] ?? dicts.en[key] ?? String(key)
		return format(platformShortcuts(text), params)
	}
}

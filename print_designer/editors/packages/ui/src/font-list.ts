import type { Lang } from '@genoffice/i18n'

/**
 * Font dropdown candidates for the editors bundled into Print Designer.
 *
 * Vendored from GenOffice `packages/ui` (Apache-2.0, see
 * editors/THIRD_PARTY/genoffice/) with the CJK family tables removed — those
 * lived in the i18n package's font-names dictionary, which the trimmed
 * (en/fr/ar) build does not carry. The browser lists whatever the platform
 * font enumeration reports beside these builtin names.
 */
const LATIN = [
  'Aptos',
  'Calibri',
  'Calibri Light',
  'Arial',
  'Times New Roman',
  'Georgia',
  'Verdana',
  'Tahoma',
  'Cambria',
  'Garamond',
  'Trebuchet MS',
  'Segoe UI',
  'Courier New',
  'Impact',
]

export const BUILTIN_FONT_FAMILIES: readonly string[] = [...LATIN]

export function fontFamiliesFor(_lang: Lang): readonly string[] {
  return BUILTIN_FONT_FAMILIES
}

/** candidate spelling → every other known spelling of the same family (CJK aliases were dropped with the font-names dictionary) */
const FAMILY_SPELLINGS: ReadonlyMap<string, readonly string[]> = new Map()

/** Every spelling we know for a family, its own name first. */
function familySpellings(family: string): readonly string[] {
  return [family, ...(FAMILY_SPELLINGS.get(family) ?? [])]
}

function isPresent(family: string, known: ReadonlySet<string>): boolean {
  return familySpellings(family).some((spelling) => known.has(spelling))
}

/**
 * Split a queryLocalFonts family list into picker sections: `builtin` holds the
 * candidates that exist on this machine, `system` holds the rest, both keeping the
 * caller's ordering. `knownAvailable` lists families the enumeration cannot see but
 * that are known installed; they keep their builtin slot without leaking into the
 * system section. When the enumeration is unavailable, denied, or still loading
 * (no system families) every candidate is kept — offering a dead name beats
 * hiding a real one.
 */
export function partitionFontFamilies(
  candidates: readonly string[],
  systemFamilies: readonly string[],
  knownAvailable: readonly string[] = [],
): { builtin: readonly string[]; system: readonly string[] } {
  // only the enumeration proves anything: catalog installs alone must not
  // turn the gate on and hide every candidate they do not cover
  if (systemFamilies.length === 0) return { builtin: [...candidates], system: [] }
  const known = new Set(systemFamilies)
  for (const f of knownAvailable) known.add(f)
  return {
    builtin: candidates.filter((f) => isPresent(f, known)),
    system: systemFamiliesBesidesCandidates(candidates, systemFamilies),
  }
}

/**
 * The machine-reported families a picker should list beside the candidates:
 * everything the enumeration returned that no candidate already covers by its
 * own name. Pickers that keep the full candidate list visible build their
 * system section with this instead of partitionFontFamilies, so no builtin
 * shows up twice.
 */
export function systemFamiliesBesidesCandidates(
  candidates: readonly string[],
  systemFamilies: readonly string[],
): readonly string[] {
  const covered = new Set(candidates)
  return systemFamilies.filter((f) => !covered.has(f))
}

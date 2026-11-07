import type { Lang } from '@genoffice/i18n'
import type { CropEdge } from './image-dialogs'

// Shared accessible names for the crop edge handles, so every edge is reachable
// by keyboard and still announced in the editor's own language.
export const CROP_EDGE_LABELS: Record<Lang, Record<CropEdge, string>> = {
  en: {
    nw: 'Top left edge',
    n: 'Top edge',
    ne: 'Top right edge',
    e: 'Right edge',
    se: 'Bottom right edge',
    s: 'Bottom edge',
    sw: 'Bottom left edge',
    w: 'Left edge',
  },
  fr: {
    nw: 'Bord supérieur gauche',
    n: 'Bord supérieur',
    ne: 'Bord supérieur droit',
    e: 'Bord droit',
    se: 'Bord inférieur droit',
    s: 'Bord inférieur',
    sw: 'Bord inférieur gauche',
    w: 'Bord gauche',
  },
  ar: {
    nw: 'الحافة العلوية اليسرى',
    n: 'الحافة العلوية',
    ne: 'الحافة العلوية اليمنى',
    e: 'الحافة اليمنى',
    se: 'الحافة السفلية اليمنى',
    s: 'الحافة السفلية',
    sw: 'الحافة السفلية اليسرى',
    w: 'الحافة اليسرى',
  },
}

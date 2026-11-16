import { appStrings } from './strings-app'
import { dialogStrings } from './strings-dialogs'

export const strings = {
  en: { ...appStrings.en, ...dialogStrings.en },
  fr: { ...appStrings.fr, ...dialogStrings.fr },
  ar: { ...appStrings.ar, ...dialogStrings.ar },
}

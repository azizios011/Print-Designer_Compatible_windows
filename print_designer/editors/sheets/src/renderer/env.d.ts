declare module '*.md?raw' {
  const content: string
  export default content
}

import type { DesktopApi } from '../shared/desktop-api'

declare global {
  interface Window {
    /** installed by src/adapter (imported first in main.tsx) before the renderer boots */
    desktopApi: DesktopApi
    /** integration surface for the sibling print / import-export / signature module */
    sheetsEditorApi: {
      exportWorkbookBytes: () => Promise<Uint8Array | null>
      currentFile: () => { docname: string; fileName: string } | null
    }
  }
}

export {}

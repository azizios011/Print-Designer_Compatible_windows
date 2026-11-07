import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Frappe serves the built editor from the app's public dir; bench build
// (print_designer/build.py) passes the same --base explicitly.
const BASE = '/assets/print_designer/editors/pdf/'

// Non-embedded CMaps/standard fonts/wasm (e.g. CJK) must ship with the
// renderer output — pdf.js resolves them against document.baseURI + pdfjs/
const pdfjsDir = (sub: string): string => {
  const pkgUrl = import.meta.resolve('pdfjs-dist/package.json')
  // strip the trailing package.json from the resolved file URL
  const root = pkgUrl.slice(0, -'package.json'.length)
  return new URL(sub, root).pathname
}

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: pdfjsDir('cmaps'), dest: 'pdfjs' },
        { src: pdfjsDir('standard_fonts'), dest: 'pdfjs' },
        { src: pdfjsDir('wasm'), dest: 'pdfjs' },
      ],
    }),
  ],
})

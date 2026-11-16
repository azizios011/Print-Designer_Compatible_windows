import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Frappe serves the built editor from the app's public dir; bench build
// (print_designer/build.py) passes the same --base explicitly.
const BASE = '/assets/print_designer/editors/sheets/'

export default defineConfig({
  base: BASE,
  plugins: [react()],
})

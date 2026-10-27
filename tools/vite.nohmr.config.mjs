// Dev helper: a second dev server without hot reload (port 5174): screenshot tests are never reloaded
// mid-run when files are saved, and a new page load still gets the latest code (files are watched).
// Run once and leave it running: npx vite --config tools/vite.nohmr.config.mjs
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import base from '../vite.config.js';
export default defineConfig({ ...base, root: fileURLToPath(new URL('..', import.meta.url)), server: { port: 5174, strictPort: true, hmr: false } });

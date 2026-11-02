import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const API_PORT = Number(process.env.PORT ?? 4317);
const LICENSES = 'THIRD-PARTY-LICENSES.txt';
/** Bundled as CSS and fonts only, so Vite's license file (JavaScript modules) leaves them out. */
const CSS_ONLY = ['@fontsource-variable/jetbrains-mono', 'tw-animate-css'];

/** The settings page links to both files, so the app shows them without a network. */
function licenses(): Plugin {
  return {
    name: 'licenses',
    apply: 'build',
    writeBundle(options) {
      const here = fileURLToPath(new URL('.', import.meta.url));
      copyFileSync(join(here, '..', 'LICENSE'), join(options.dir ?? 'dist', 'LICENSE.txt'));
      const out = join(options.dir ?? 'dist', LICENSES);
      if (!existsSync(out)) return;
      for (const name of CSS_ONLY) {
        const dir = [join(here, 'node_modules', name), join(here, '..', 'node_modules', name)].find((d) => existsSync(join(d, 'package.json')));
        if (!dir) throw new Error(`${name}: package not found for ${LICENSES}`);
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        appendFileSync(out, `\n## ${name} - ${pkg.version} (${pkg.license})\n\n${readFileSync(join(dir, 'LICENSE'), 'utf8').trim()}\n`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), licenses()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Host header is forwarded unchanged; the API server allows the Vite address in --dev mode only.
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false } },
  },
  // the minified bundle drops the libraries' license comments; their notices ship in this file instead (MIT and others
  // ask for the notice to go with every copy)
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, license: { fileName: LICENSES } },
});

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
      const engine = JSON.parse(readFileSync(join(bergamotDir(), '..', 'package.json'), 'utf8'));
      appendFileSync(
        out,
        `\n## ${BERGAMOT} - ${engine.version} (${engine.license})\n\nThe translation engine in bergamot/ is shipped unmodified. Its source (version ${engine.version}):` +
          ` https://codeberg.org/mkljczk/bergamot-translator (MPL-2.0, https://mozilla.org/MPL/2.0/). Its WebAssembly is built from` +
          ` bergamot-translator with the libraries it includes, such as Marian NMT (MIT), SentencePiece (Apache-2.0) and intgemm (MIT);` +
          ` their notices are in that source. The translation models are Mozilla's (MPL-2.0), downloaded from Mozilla when turned on.\n`,
      );
    },
  };
}

const BERGAMOT = '@mkljczk/bergamot-translator';
/** The engine's worker loads its glue and WebAssembly by address next to itself. */
const BERGAMOT_FILES = ['translator-worker.js', 'bergamot-translator-worker.js', 'bergamot-translator-worker.wasm'];
function bergamotDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const dir = [join(here, 'node_modules', BERGAMOT, 'worker'), join(here, '..', 'node_modules', BERGAMOT, 'worker')].find((d) => existsSync(d));
  if (!dir) throw new Error(`${BERGAMOT}: package not found`);
  return dir;
}

/** Description translation where the browser has none built in (2026-11-03): the engine's worker files, as /bergamot/. */
function bergamotWorker(): Plugin {
  return {
    name: 'bergamot-worker',
    configureServer(server) {
      server.middlewares.use('/bergamot', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '');
        if (!BERGAMOT_FILES.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(join(bergamotDir(), name)));
      });
    },
    generateBundle() {
      for (const name of BERGAMOT_FILES) this.emitFile({ type: 'asset', fileName: `bergamot/${name}`, source: readFileSync(join(bergamotDir(), name)) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), licenses(), bergamotWorker()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Host header is forwarded unchanged; the API server allows the Vite address in --dev mode only.
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
      '/translate-models': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
  // the minified bundle drops the libraries' license comments; their notices ship in this file instead (MIT and others
  // ask for the notice to go with every copy)
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, license: { fileName: LICENSES } },
});

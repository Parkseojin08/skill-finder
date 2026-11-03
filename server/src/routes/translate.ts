import express, { Router } from 'express';
import type { AppContext } from '../context.ts';
import { MODEL_LANGS, MODEL_URL_PATH, type ModelLang } from '../translate/models.ts';

const langOf = (v: unknown): ModelLang | null => (MODEL_LANGS.includes(v as ModelLang) ? (v as ModelLang) : null);

/** The translation model for browsers without a built-in translator: its state, and the one-time download. */
export function translateRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/translate/models/:lang', (req, res) => {
    const lang = langOf(req.params.lang);
    if (!lang) return void res.status(404).json({ error: '번역 모델이 없는 언어입니다' });
    res.json(ctx.translateModels.status(lang));
  });
  r.post('/translate/models/:lang', (req, res) => {
    const lang = langOf(req.params.lang);
    if (!lang) return void res.status(404).json({ error: '번역 모델이 없는 언어입니다' });
    res.json(ctx.translateModels.start(lang));
  });
  return r;
}

/**
 * The downloaded files and the engine's registry, outside /api: the engine fetches them without the API header.
 * Read only; the registry's addresses carry each file's hash (?v=), so the files are cached for good.
 */
export function translateFiles(ctx: AppContext): Router {
  const r = Router();
  r.get(`${MODEL_URL_PATH}/index.json`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json(ctx.translateModels.registry());
  });
  r.use(MODEL_URL_PATH, express.static(ctx.translateModels.root, { index: false, dotfiles: 'deny', maxAge: '30d', immutable: true }));
  // a file that is not there is a 404, not the page's index.html (the engine saw that only as an integrity error)
  r.use(MODEL_URL_PATH, (_req, res) => void res.status(404).end());
  return r;
}

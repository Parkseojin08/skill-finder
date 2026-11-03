import type { AppConfig } from './config.ts';
import type { Store } from './db/store.ts';
import type { GitHub } from './sources/github.ts';
import type { Indexer } from './indexer.ts';
import type { Jobs } from './jobs.ts';
import type { TranslateModels } from './translate/models.ts';

/** Shared services handed to routes and background work. */
export type AppContext = {
  config: AppConfig;
  store: Store;
  github: GitHub;
  indexer: Indexer;
  jobs: Jobs;
  translateModels: TranslateModels;
};

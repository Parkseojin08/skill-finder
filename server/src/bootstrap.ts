import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { openDb } from './db/index.ts';
import { Store } from './db/store.ts';
import { Indexer } from './indexer.ts';
import { Jobs } from './jobs.ts';
import { seedMarketplaces } from './settings.ts';
import { GitHub } from './sources/github.ts';

export function createContext(config: AppConfig, dbPath = join(config.dataDir, 'skill-finder.db')): AppContext {
  const store = new Store(openDb(dbPath));
  seedMarketplaces(store);
  const github = new GitHub(store, config);
  const indexer = new Indexer(store, github);
  return { config, store, github, indexer, jobs: new Jobs() };
}

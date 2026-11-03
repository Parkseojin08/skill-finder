import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { isCorruptDb, latestBackup, openDb, setAsideCorrupt } from './db/index.ts';
import { Store } from './db/store.ts';
import { Indexer } from './indexer.ts';
import { Jobs } from './jobs.ts';
import { seedMarketplaces } from './settings.ts';
import { GitHub } from './sources/github.ts';
import { TranslateModels } from './translate/models.ts';
import { APP_VERSION } from './version.ts';

export function createContext(config: AppConfig, dbPath = join(config.dataDir, 'skill-finder.db')): AppContext {
  const store = new Store(openDb(dbPath, { backupLabel: dbPath === ':memory:' ? null : APP_VERSION }));
  seedMarketplaces(store);
  const github = new GitHub(store, config);
  const indexer = new Indexer(store, github);
  return { config, store, github, indexer, jobs: new Jobs(), translateModels: new TranslateModels(join(config.dataDir, 'translate-models')) };
}

/**
 * createContext for the server: a damaged database file (project review #4) is moved aside and the newest backup
 * made before a migration is put in its place, or, without one, the app starts with an empty one (the index is
 * collected again; settings and the search log start over). Each step is said on the console and in the log.
 */
export function openContext(config: AppConfig): AppContext {
  const dbPath = join(config.dataDir, 'skill-finder.db');
  let restored: string | null = null;
  for (;;) {
    try {
      return createContext(config, dbPath);
    } catch (err) {
      if (!isCorruptDb(err)) throw err;
      const moved = setAsideCorrupt(dbPath);
      console.error(`[db] 데이터 파일이 손상되어 열 수 없습니다. 살펴볼 수 있게 옮겨 두었습니다: ${moved}`);
      const backup: string | null = restored ? null : latestBackup(dbPath);
      if (backup) {
        copyFileSync(backup, dbPath);
        restored = backup;
        console.error(`[db] 백업으로 되살려 시작합니다: ${backup}`);
      } else {
        console.error('[db] 새 데이터로 시작합니다. 스킬 목록은 다시 모으고, 설정과 검색 기록은 처음 값으로 돌아갑니다.');
        return createContext(config, dbPath);
      }
    }
  }
}

export type RiskLevel = 'low' | 'medium' | 'high';
export type SourceKind = 'marketplace' | 'skillssh' | 'github';
export type InstallMethod = 'plugin' | 'skills-cli' | 'manual-only';
export type InstallScope = 'user' | 'project' | 'local';
export type TrustTier = 'official' | 'partner' | 'community' | 'other';
export type Breakdown = { R: number; P: number; F: number; T: number };

export type SourceRef = { kind: SourceKind; label: string; url: string };

export type ResultItem = {
  id: string;
  name: string;
  /** Pages of copies in other repos folded into this result (not this skill's own badges). */
  copies?: SourceRef[];
  description: string;
  sources: SourceRef[];
  installs?: number;
  stars?: number;
  lastCommitAt?: string;
  score: number;
  breakdown: Breakdown;
  riskLevel: RiskLevel;
  riskFlags: string[];
  qualityWarnings: string[];
  install: { method: InstallMethod; command: string; pluginId?: string; disabled?: boolean };
  /** `topRisk`: the highest level among the plugin's skills, which all install together. */
  plugin?: { id: string; name: string; marketplace: string; skillCount: number; topRisk?: RiskLevel };
  trust: TrustTier;
  /** 1–2 rule-based category keys (see CATEGORY in labels.ts). */
  categories: string[];
  /** Search results: 1 when the name has a query word and half the words match (sorted first). */
  tier?: number;
};

export type RepoResult = {
  repo: string;
  url: string;
  description: string | null;
  stars: number | null;
  topics: string[];
  skills: Array<{ id: string; name: string; riskLevel: RiskLevel; riskFlags?: string[]; method: InstallMethod; installable: boolean; scopes: string[] }>;
};

export type SkillMatch ={ item: ResultItem; score: number; matchedTerms: string[] };

export type RecommendResult = {
  readmePath: string;
  summary: { title: string; intro: string; features: string[] };
  keywords: Array<{ term: string; weight: number }>;
  /** Similar skills, most downloaded first (then stars). */
  skills: SkillMatch[];
};

export type SearchSource = 'local' | 'skillssh' | 'github' | 'repos';
export type SourceProgress = { state: 'running' | 'done' | 'failed' | 'timeout' | 'skipped'; count?: number; ms?: number };

export type SearchEvent =
  | { type: 'stage'; stage: 'collect' | 'enrich' | 'score'; message: string }
  | ({ type: 'source'; source: SearchSource } & SourceProgress)
  /** An English query for a Korean one, sent first (offered as a button). */
  | { type: 'suggest'; query: string; /** Korean words the suggestion leaves out. */ dropped: string[] }
  | { type: 'candidates'; items: ResultItem[] }
  /** `urgent`: changes what the results mean (stays on screen); `note`: folds into the "알림" toggle. */
  | { type: 'warning'; source: string; message: string; severity?: 'urgent' | 'note' }
  | {
      type: 'results';
      items: ResultItem[];
      hiddenHighRisk: number;
      hiddenNoDescription: number;
      hiddenLowStars?: number;
      /** Hidden because the repo's star count is not known yet (first run, no token). */
      hiddenUnknownStars?: number;
      minStars?: number;
      /** Results without a single query word in their name or description. */
      hiddenNoMatch?: number;
      /** An English query for a Korean one, offered as a button. */
      suggestQuery?: string;
      /** Every query word is a generic one ("skill"): searched as typed, so the results are broad. */
      broadQuery?: boolean;
      repos?: RepoResult[];
    }
  /** `sid`: this search in the local search log (when it is on). */
  | { type: 'done'; cached: boolean; elapsedMs: number; sid?: string };

export type InstallPlan = {
  method: InstallMethod;
  scopes: InstallScope[];
  command: string;
  pluginId?: string;
  pluginName?: string;
  marketplace?: { name: string; repo: string };
  repo?: string;
  source?: string;
  /** The commit a skills CLI install is pinned to (the one the risk check read). */
  pinnedRef?: string;
  skillName?: string;
  reason?: string;
  disabled?: boolean;
};

export type SkillDetail = {
  id: string;
  name: string;
  description: string | null;
  whenToUse: string | null;
  /** Context it takes, estimated: name + description with every request once installed; SKILL.md when used. */
  tokens: { perTurn: number; onUse: number | null };
  origin: 'plugin' | 'generic' | 'wellknown';
  repo: string | null;
  ref: string | null;
  dirPath: string | null;
  url: string | null;
  sources: SourceRef[];
  installs: number | null;
  stars: number | null;
  license: string | null;
  archived: boolean;
  lastCommitAt: string | null;
  frontmatter: Record<string, unknown>;
  bodyLines: number | null;
  partialBreakdown: { F: number; T: number };
  riskLevel: RiskLevel;
  riskFlags: string[];
  qualityWarnings: string[];
  skillMd: string | null;
  skillMdError: string | null;
  files: Array<{ path: string; size: number | null; isText: boolean }>;
  filesTotal: number;
  plugin: null | {
    id: string;
    name: string;
    displayName: string | null;
    description: string | null;
    marketplace: string;
    sourceKind: string;
    skills: Array<{ id: string; name: string; riskLevel: RiskLevel; riskFlags: string[] }>;
    hooks: boolean;
    mcp: boolean;
    bin: boolean;
    monitors: boolean;
    strictConflict: boolean;
  };
  install: InstallPlan;
};

/** A same-name skill folder the skills CLI would replace. `same`: true = this skill again, false = another, null = unknown. */
export type ExistingSkill = { path: string; name: string; same: boolean | null; change: InstallChange };

/** Text files of a skill folder checked before an install (project review F1); SKILL.md is not among them. */
export type FileScan = {
  commit: string;
  checked: number;
  findings: Array<{ path: string; flags: string[] }>;
  skipped: Array<{ path: string; reason: 'binary' | 'large' | 'limit' | 'failed' }>;
  unlisted: number;
};
/** What a plugin runs once installed, as written in it. */
export type RunConfigItem = { kind: 'hooks' | 'mcp' | 'monitors' | 'bin'; source: string; text: string; truncated: boolean };
export type InstallScan =
  | { kind: 'files'; pinned: boolean; scan: FileScan }
  | { kind: 'plugin'; pluginId: string; config: { commit: string; items: RunConfigItem[] } }
  | { kind: 'none'; reason: string };

export type InstallPreview = {
  plan: InstallPlan;
  steps: Array<{ display: string; cwd: string }>;
  location: string;
  createsLockFile?: boolean;
  existing?: ExistingSkill | null;
  error?: string;
};

export type Settings = {
  weights: Breakdown;
  telemetryDisabled: boolean;
  autoCollect: boolean;
  defaultScope: 'user' | 'project';
  defaultProjectPath: string;
  minStars: number;
  /** Keep a search log on this PC (what was searched, which results were opened), 90 days. */
  searchLog: boolean;
};

export type MarketplaceInfo = {
  name: string;
  repo: string;
  enabled: boolean;
  indexMode: 'eager' | 'lazy';
  syncedAt: string | null;
  pluginCount: number | null;
  error: string | null;
  pendingSkillIndex: number;
};

export type SettingsResponse = {
  settings: Settings;
  githubToken: boolean;
  /** Where the index and search log (dataDir) and the token (envPath) are kept. */
  dataDir: string;
  envPath: string;
  marketplaces: MarketplaceInfo[];
  searchLogCount: number;
};

/** Where an opened result was in its search, for the search log. */
export type OpenedFrom = { sid?: string; pos: number; page: number; provisional: boolean };

export type Job = {
  id: string;
  kind: 'sync' | 'collect';
  label: string;
  status: 'running' | 'paused' | 'done' | 'error' | 'cancelled';
  done: number;
  total: number;
  errors: string[];
  /** Entries that cannot be installed as listed (deleted repo, missing commit or folder). */
  skipped?: string[];
  startedAt: string;
  finishedAt: string | null;
};

export type Health = { ok: boolean; appVersion: string | null; update: { version: string } | null; node: string; claudeVersion: string | null; skillsCli: string; githubToken: boolean; plugins: number; skills: number };

/** `same`: what is installed is what the index holds; `changed`: the index holds different text or a different commit. */
export type InstallChange = 'same' | 'changed' | 'unknown';

export type InstalledResponse = {
  plugins: Array<{
    id: string;
    version: string | null;
    scope: string;
    enabled: boolean | null;
    enabledWhere: string | null;
    installPath: string | null;
    projectPath: string | null;
    removeCommand: string | null;
    indexed: boolean;
    topRisk: RiskLevel | null;
    change: InstallChange;
    /** Indexed skills the plugin brought in. */
    skills: Array<{ id: string; name: string; riskLevel: RiskLevel }>;
  }>;
  pluginError: string | null;
  /** Project folders the app installed into, newest first. */
  projects: string[];
  skills: Array<{
    scope: 'user' | 'project';
    path: string;
    folder: string;
    name: string;
    description: string;
    removeCommand: string;
    skillId: string | null;
    /** The current risk rules run on the installed files. */
    risk: { level: RiskLevel; flags: string[] };
    installedRisk: RiskLevel | null;
    change: InstallChange;
    tokens: { perTurn: number; onUse: number | null };
  }>;
};

/** What is installed, by index id (`/installed/ids`), for the "설치됨" badges. */
export type InstalledIds = { plugins: Array<{ id: string; scope: string }>; skills: Array<{ id: string; scope: string }> };

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
  plugin?: { id: string; name: string; marketplace: string; skillCount: number };
  trust: TrustTier;
  /** 1–2 rule-based category keys (see CATEGORY in labels.ts). */
  categories: string[];
};

export type SkillMatch = { item: ResultItem; score: number; matchedTerms: string[] };

export type RecommendResult = {
  readmePath: string;
  summary: { title: string; intro: string; features: string[] };
  keywords: Array<{ term: string; weight: number }>;
  /** Similar skills, most downloaded first (then stars). */
  skills: SkillMatch[];
};

export type SearchEvent =
  | { type: 'stage'; stage: 'collect' | 'enrich' | 'score'; message: string }
  | { type: 'candidates'; items: ResultItem[] }
  | { type: 'warning'; source: string; message: string }
  | { type: 'results'; items: ResultItem[]; hiddenHighRisk: number; hiddenNoDescription: number }
  | { type: 'done'; cached: boolean; elapsedMs: number };

export type InstallPlan = {
  method: InstallMethod;
  scopes: InstallScope[];
  command: string;
  pluginId?: string;
  pluginName?: string;
  marketplace?: { name: string; repo: string };
  repo?: string;
  skillName?: string;
  reason?: string;
  disabled?: boolean;
};

export type SkillDetail = {
  id: string;
  name: string;
  description: string | null;
  whenToUse: string | null;
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
    skills: Array<{ id: string; name: string }>;
    hooks: boolean;
    mcp: boolean;
    bin: boolean;
    monitors: boolean;
    strictConflict: boolean;
  };
  install: InstallPlan;
};

export type InstallPreview = {
  plan: InstallPlan;
  steps: Array<{ display: string; cwd: string }>;
  location: string;
  createsLockFile?: boolean;
  error?: string;
};

export type Settings = {
  weights: Breakdown;
  telemetryDisabled: boolean;
  autoCollect: boolean;
  defaultScope: 'user' | 'project';
  defaultProjectPath: string;
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

export type SettingsResponse = { settings: Settings; githubToken: boolean; marketplaces: MarketplaceInfo[] };

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

export type Health = { ok: boolean; node: string; claudeVersion: string | null; skillsCli: string; githubToken: boolean; plugins: number; skills: number };

export type InstalledResponse = {
  plugins: Array<{ id: string; version: string | null; scope: string; enabled: boolean | null; enabledWhere: string | null; installPath: string | null; projectPath: string | null; removeCommand: string | null }>;
  pluginError: string | null;
  skills: Array<{ scope: 'user' | 'project'; path: string; folder: string; name: string; description: string; removeCommand: string }>;
};

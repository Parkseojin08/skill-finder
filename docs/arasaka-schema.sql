-- ARASAKA_IN online schema (PostgreSQL 15+, hosted on Neon). Design notes: docs/arasaka-db.md
-- The game API (a Cloudflare Worker) is the only writer. Clients send actions; the Worker runs the engine and stores
-- the result. Each action request is two queries over Neon's HTTP driver: load_character(), then apply_batch().

create extension if not exists citext;

create type rarity as enum ('trash', 'common', 'hq', 'rare', 'legendary', 'epic');
create type gear_slot as enum ('primary', 'special', 'destructive', 'helmet', 'upper', 'lower', 'boots');

-- ───────────── accounts ─────────────

create table players (
  id                  uuid primary key default gen_random_uuid(),
  display_name        citext not null unique
                      check (char_length(display_name) between 2 and 16
                             and display_name ~ '^[0-9A-Za-z가-힣_]+$'),
  -- daily reset is 09:00 in this zone; changes are rate-limited by the server (timezone_changed_at)
  timezone            text not null default 'Asia/Seoul',
  timezone_changed_at timestamptz,
  status              text not null default 'active' check (status in ('active', 'hidden', 'banned')),
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz
);

-- one row per OAuth login a player has linked; no passwords are stored
create table auth_identities (
  provider     text not null check (provider in ('github', 'google')),
  provider_uid text not null,
  player_id    uuid not null references players (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (provider, provider_uid)
);
create index auth_identities_player on auth_identities (player_id);

-- Login from the local Skill Finder page, without cookies or window.opener:
-- the page creates a request (keeping a secret), opens the OAuth start URL in a new tab, and polls with the secret.
-- When OAuth finishes, player_id is set; the first poll after that issues a session token and sets consumed_at.
create table login_requests (
  id          uuid primary key default gen_random_uuid(),   -- also the OAuth `state`
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  player_id   uuid references players (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz
);
create index login_requests_expiry on login_requests (expires_at);

-- bearer tokens (Authorization header); only their SHA-256 is kept
create table sessions (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  player_id  uuid not null references players (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_player on sessions (player_id);
create index sessions_expiry on sessions (expires_at);

-- ───────────── character ─────────────

create table characters (
  id               bigint generated always as identity primary key,
  player_id        uuid not null unique references players (id) on delete cascade,
  level            smallint not null default 1 check (level between 1 and 60),
  xp               integer not null default 0 check (xp >= 0),        -- progress toward the next level
  total_xp         bigint not null default 0 check (total_xp >= 0),   -- all-time ranking key
  total_xp_at      timestamptz not null default now(),                -- when total_xp last rose: earlier wins ties
  credits          bigint not null default 0 check (credits >= 0),
  hp               integer not null check (hp >= 0),
  hp_at            timestamptz not null default now(),                -- out-of-dungeon regen is computed from this
  unlocked_station smallint not null default 0 check (unlocked_station between 0 and 4),
  bag_capacity     smallint not null default 40 check (bag_capacity between 1 and 200),
  hotbar           smallint[] not null default '{0,NULL,NULL}'        -- heal tier bound to Q / W / E
                   check (cardinality(hotbar) = 3),
  flatline_until   timestamptz,
  overclock_until  timestamptz,
  raid_day         date,                                              -- business day of the last raid
  ranked           boolean not null default true,                     -- false when the player is hidden or banned
  version          integer not null default 0,                        -- optimistic lock for each action batch
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index characters_rank on characters (total_xp desc, total_xp_at) where ranked;

create table character_skills (
  character_id bigint not null references characters (id) on delete cascade,
  skill        text not null check (skill in ('printing', 'medical', 'ammo')),
  level        smallint not null default 1 check (level between 1 and 100),
  xp           integer not null default 0 check (xp >= 0),
  primary key (character_id, skill)
);

-- lifetime counters: profile page and season boards
create table character_stats (
  character_id     bigint primary key references characters (id) on delete cascade,
  kills            integer not null default 0,
  boss_kills       integer not null default 0,
  deaths           integer not null default 0,
  dungeon_clears   integer not null default 0,
  challenge_clears integer not null default 0,
  raid_attempts    integer not null default 0,
  raid_wins        integer not null default 0,
  crates_opened    integer not null default 0,
  items_printed    integer not null default 0,
  ice_cracked      integer not null default 0
);

-- volatile state that only the engine reads. Never queried across players, so it stays JSON.
create table character_state (
  character_id       bigint primary key references characters (id) on delete cascade,
  -- server-held PRNG (four uint32 words, safe as JSON numbers): the player cannot reroll by reloading
  rng_state          bigint[] not null check (cardinality(rng_state) = 4
                                              and 0 <= all (rng_state) and 4294967295 >= all (rng_state)),
  location           jsonb not null default '{"kind":"hub"}',
  dungeon            jsonb,               -- current run: rooms, entities, position, started_at
  combat             jsonb,               -- current fight
  street             jsonb,               -- nearby enemies in the current area
  modal              jsonb,               -- open quest-giver offer, lore, minigame
  quests             jsonb not null default '[]',
  quest_seq          integer not null default 0,    -- id of the last quest handed out
  buffs              jsonb not null default '[]',
  job                jsonb,               -- AFK job: id, started_at, ends_at
  market             jsonb,               -- daily 09:00 stock: {"day":"2026-10-27","offers":[...]}
  weaponsmith        jsonb,               -- hourly stock
  ice_cooldown_until timestamptz,
  log                jsonb not null default '[]',   -- last 80 event lines shown in the game's side panel
  updated_at         timestamptz not null default now()
);

-- ───────────── inventory ─────────────

-- stackable things: ammo, materials, heals, caches, key fragments
create table item_catalog (
  code      text primary key,             -- 'cells', 'heal:2', 'cache:weapon:rare', 'fragment:1:b'
  category  text not null check (category in ('ammo', 'material', 'heal', 'cache', 'fragment')),
  name      text not null,
  max_stack integer not null default 10000 check (max_stack > 0)
);

create table item_stacks (
  character_id bigint not null references characters (id) on delete cascade,
  item_code    text not null references item_catalog (code),
  qty          integer not null check (qty > 0),   -- the row is deleted at zero
  primary key (character_id, item_code)
);

-- unique things: each piece of gear and each module is its own row.
-- ids are UUIDs the engine creates, so a batch can refer to an item it made earlier in the same batch.
create table items (
  id            uuid primary key,
  character_id  bigint not null references characters (id) on delete cascade,
  kind          text not null check (kind in ('gear', 'module')),
  slot          gear_slot,                 -- gear only
  stat          text,                      -- module only: the stat it adds
  rarity        rarity not null,
  level         smallint not null check (level between 1 and 60),
  name          text not null,
  main_value    real not null,             -- weapon damage, armor HP, or the module's value
  affixes       jsonb not null default '{}',  -- {"crit":3.2,"evade":1.1}
  mod_slots     smallint not null default 0 check (mod_slots between 0 and 3),
  equipped_slot gear_slot,                 -- set while worn
  installed_in  uuid references items (id) on delete set null,  -- module fitted to gear; scrapping the gear returns it to the bag
  source        text not null check (source in ('start', 'drop', 'print', 'shop', 'market', 'craft', 'raid', 'quest')),
  acquired_at   timestamptz not null default now(),
  check ((kind = 'gear') = (slot is not null)),
  check ((kind = 'module') = (stat is not null)),
  check (kind = 'gear' or (equipped_slot is null and mod_slots = 0)),
  check (kind = 'module' or installed_in is null),
  check (equipped_slot is null or equipped_slot = slot)
);
create index items_owner on items (character_id);
create unique index items_one_per_slot on items (character_id, equipped_slot) where equipped_slot is not null;
create index items_installed on items (installed_in) where installed_in is not null;

-- ───────────── records and ranking ─────────────

-- per dungeon variant; best_ms is measured from server timestamps (entry → treasure room cleared)
create table dungeon_records (
  character_id     bigint not null references characters (id) on delete cascade,
  station          smallint not null check (station between 0 and 4),
  dungeon          smallint not null check (dungeon between 0 and 2),
  challenge        boolean not null,
  clears           integer not null default 0,
  best_ms          integer check (best_ms > 0),
  best_at          timestamptz,
  first_cleared_at timestamptz not null default now(),
  primary key (character_id, station, dungeon, challenge)
);
create index dungeon_speed on dungeon_records (station, dungeon, challenge, best_ms, best_at) where best_ms is not null;

-- weekly seasons; boards that reset each season live here, all-time boards read characters / dungeon_records
create table seasons (
  id        smallint primary key,
  name      text not null,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  check (ends_at > starts_at)
);

create table season_scores (
  season_id    smallint not null references seasons (id),
  board        text not null check (board in ('xp', 'clears', 'raid')),
  character_id bigint not null references characters (id) on delete cascade,
  score        bigint not null default 0 check (score >= 0),
  reached_at   timestamptz not null default now(),   -- when the score last rose: earlier wins ties
  primary key (season_id, board, character_id)
);
create index season_board_rank on season_scores (season_id, board, score desc, reached_at);

-- frozen final standings, written once when a season closes
create table season_results (
  season_id    smallint not null references seasons (id),
  board        text not null,
  rank         integer not null check (rank > 0),
  character_id bigint references characters (id) on delete set null,
  display_name text not null,                         -- name at the time, kept if the account is deleted
  score        bigint not null,
  primary key (season_id, board, rank)
);

-- ───────────── audit ─────────────

-- every accepted action batch, for replay checks and support; rows older than 30 days are deleted daily
create table action_log (
  character_id bigint not null references characters (id) on delete cascade,
  seq          bigint not null,                -- characters.version after the batch
  actions      jsonb not null,
  state_hash   bytea not null,                 -- SHA-256 of the engine state after the batch
  created_at   timestamptz not null default now(),
  primary key (character_id, seq)
);
create index action_log_age on action_log (created_at);

-- ───────────── functions the Worker calls ─────────────
-- Each is one statement over Neon's HTTP driver, so a request needs no open connection and no interactive transaction.

-- Login poll. Returns the player once OAuth has finished, and stores the new session; NULL while still pending.
create function claim_login(p_request uuid, p_secret_hash bytea, p_token_hash bytea) returns uuid
language plpgsql as $$
declare
  v_player uuid;
begin
  update login_requests set consumed_at = now()
   where id = p_request and secret_hash = p_secret_hash and player_id is not null
     and consumed_at is null and expires_at > now()
  returning player_id into v_player;
  if v_player is null then
    return null;
  end if;
  insert into sessions (token_hash, player_id, expires_at) values (p_token_hash, v_player, now() + interval '30 days');
  return v_player;
end $$;

-- First login: an empty character. Starter gear is then written by apply_batch with source 'start'.
create function create_character(p_player uuid, p_hp integer, p_rng bigint[]) returns bigint
language plpgsql as $$
declare
  v_id bigint;
begin
  insert into characters (player_id, hp) values (p_player, p_hp) returning id into v_id;
  insert into character_state (character_id, rng_state) values (v_id, p_rng);
  insert into character_stats (character_id) values (v_id);
  insert into character_skills (character_id, skill) select v_id, s from unnest(array['printing', 'medical', 'ammo']) s;
  return v_id;
end $$;

-- Everything the engine needs, found by session token. NULL for an unknown or expired session or a banned player.
create function load_character(p_token_hash bytea) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'player',    jsonb_build_object('id', pl.id, 'display_name', pl.display_name, 'timezone', pl.timezone),
    'character', to_jsonb(ch),
    'state',     to_jsonb(st) - 'character_id',
    'stats',     to_jsonb(cs) - 'character_id',
    'skills',    coalesce((select jsonb_agg(to_jsonb(k) - 'character_id') from character_skills k where k.character_id = ch.id), '[]'),
    'items',     coalesce((select jsonb_agg(to_jsonb(i) - 'character_id') from items i where i.character_id = ch.id), '[]'),
    'stacks',    coalesce((select jsonb_object_agg(s.item_code, s.qty) from item_stacks s where s.character_id = ch.id), '{}'),
    'records',   coalesce((select jsonb_agg(to_jsonb(r) - 'character_id') from dungeon_records r where r.character_id = ch.id), '[]')
  )
  from sessions se
  join players pl on pl.id = se.player_id and pl.status <> 'banned'
  join characters ch on ch.player_id = pl.id
  join character_state st on st.character_id = ch.id
  join character_stats cs on cs.character_id = ch.id
  where se.token_hash = p_token_hash and se.expires_at > now()
$$;

-- Saves one action batch atomically. `p_version` is the version load_character returned; if another request saved
-- in between, nothing is written and SQLSTATE AR409 is raised (the Worker answers 409 and the client reloads).
-- p: { character, state?, stats?, skills?, items_upserted?, items_deleted?, stacks? {code: qty, 0 = remove},
--      records?, season_scores?, actions, state_hash (hex) }
create function apply_batch(p_character_id bigint, p_version integer, p jsonb) returns integer
language plpgsql as $$
declare
  v_new integer;
begin
  update characters c set
    level = x.level, xp = x.xp, total_xp = x.total_xp, total_xp_at = x.total_xp_at, credits = x.credits,
    hp = x.hp, hp_at = x.hp_at, unlocked_station = x.unlocked_station, bag_capacity = x.bag_capacity,
    hotbar = x.hotbar, flatline_until = x.flatline_until, overclock_until = x.overclock_until, raid_day = x.raid_day,
    version = c.version + 1, updated_at = now()
  from jsonb_populate_record(null::characters, p -> 'character') x
  where c.id = p_character_id and c.version = p_version
  returning c.version into v_new;
  if v_new is null then
    raise exception 'version conflict for character %', p_character_id using errcode = 'AR409';
  end if;

  if p ? 'state' then
    update character_state s set
      rng_state = x.rng_state, location = x.location, dungeon = x.dungeon, combat = x.combat, street = x.street,
      modal = x.modal, quests = x.quests, quest_seq = x.quest_seq, buffs = x.buffs, job = x.job, market = x.market,
      weaponsmith = x.weaponsmith, ice_cooldown_until = x.ice_cooldown_until, log = x.log, updated_at = now()
    from jsonb_populate_record(null::character_state, p -> 'state') x
    where s.character_id = p_character_id;
  end if;

  if p ? 'stats' then
    update character_stats s set
      kills = x.kills, boss_kills = x.boss_kills, deaths = x.deaths, dungeon_clears = x.dungeon_clears,
      challenge_clears = x.challenge_clears, raid_attempts = x.raid_attempts, raid_wins = x.raid_wins,
      crates_opened = x.crates_opened, items_printed = x.items_printed, ice_cracked = x.ice_cracked
    from jsonb_populate_record(null::character_stats, p -> 'stats') x
    where s.character_id = p_character_id;
  end if;

  if p ? 'skills' then
    insert into character_skills (character_id, skill, level, xp)
    select p_character_id, x.skill, x.level, x.xp from jsonb_populate_recordset(null::character_skills, p -> 'skills') x
    on conflict (character_id, skill) do update set level = excluded.level, xp = excluded.xp;
  end if;

  if p ? 'items_deleted' then
    delete from items
     where character_id = p_character_id
       and id in (select value::uuid from jsonb_array_elements_text(p -> 'items_deleted'));
  end if;

  if p ? 'items_upserted' then
    -- unequip the touched rows first, so swapping two items within one batch never trips items_one_per_slot
    update items set equipped_slot = null
     where character_id = p_character_id
       and id in (select x.id from jsonb_populate_recordset(null::items, p -> 'items_upserted') x);
    insert into items (id, character_id, kind, slot, stat, rarity, level, name, main_value, affixes, mod_slots,
                       equipped_slot, installed_in, source, acquired_at)
    select x.id, p_character_id, x.kind, x.slot, x.stat, x.rarity, x.level, x.name, x.main_value,
           coalesce(x.affixes, '{}'), coalesce(x.mod_slots, 0), x.equipped_slot, x.installed_in, x.source,
           coalesce(x.acquired_at, now())
      from jsonb_populate_recordset(null::items, p -> 'items_upserted') x
    on conflict (id) do update set
      level = excluded.level, name = excluded.name, main_value = excluded.main_value, affixes = excluded.affixes,
      mod_slots = excluded.mod_slots, equipped_slot = excluded.equipped_slot, installed_in = excluded.installed_in
    where items.character_id = excluded.character_id;
  end if;

  if p ? 'stacks' then
    delete from item_stacks
     where character_id = p_character_id
       and item_code in (select key from jsonb_each_text(p -> 'stacks') where value::integer = 0);
    insert into item_stacks (character_id, item_code, qty)
    select p_character_id, key, value::integer from jsonb_each_text(p -> 'stacks') where value::integer > 0
    on conflict (character_id, item_code) do update set qty = excluded.qty;
  end if;

  if p ? 'records' then
    insert into dungeon_records (character_id, station, dungeon, challenge, clears, best_ms, best_at, first_cleared_at)
    select p_character_id, x.station, x.dungeon, x.challenge, x.clears, x.best_ms, x.best_at,
           coalesce(x.first_cleared_at, now())
      from jsonb_populate_recordset(null::dungeon_records, p -> 'records') x
    on conflict (character_id, station, dungeon, challenge) do update set
      clears = excluded.clears, best_ms = excluded.best_ms, best_at = excluded.best_at;
  end if;

  if p ? 'season_scores' then
    insert into season_scores (season_id, board, character_id, score, reached_at)
    select x.season_id, x.board, p_character_id, x.score, x.reached_at
      from jsonb_populate_recordset(null::season_scores, p -> 'season_scores') x
    on conflict (season_id, board, character_id) do update set score = excluded.score, reached_at = excluded.reached_at;
  end if;

  insert into action_log (character_id, seq, actions, state_hash)
  values (p_character_id, v_new, p -> 'actions', decode(p ->> 'state_hash', 'hex'));
  return v_new;
end $$;

-- Cron Trigger, once a day
create function housekeeping() returns void
language sql as $$
  delete from sessions where expires_at < now();
  delete from login_requests where expires_at < now() - interval '1 day';
  delete from action_log where created_at < now() - interval '30 days';
$$;

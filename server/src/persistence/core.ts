import { DatabaseSync } from "node:sqlite";
import { errorMessage } from "../foundation/errors.ts";
import { DB_PATH, ensureDirs } from "../config.ts";

ensureDirs();

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

export function runInTransaction<T>(fn: () => T): T {
  return runTransaction("BEGIN", fn);
}

export function runInImmediateTransaction<T>(fn: () => T): T {
  return runTransaction("BEGIN IMMEDIATE", fn);
}

function runTransaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", fn: () => T): T {
  db.exec(begin);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {  }
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_keys (
  user_id    TEXT NOT NULL,
  provider   TEXT NOT NULL,
  enc_key    TEXT NOT NULL,   -- AES-256-GCM ciphertext (iv:tag:data, base64)
  hint       TEXT NOT NULL,   -- last 4 chars for display
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orca_credentials (
  user_id     TEXT PRIMARY KEY,
  source      TEXT NOT NULL CHECK (source IN ('api_key','oauth_pkce')),
  scope       TEXT,
  generation  INTEGER NOT NULL DEFAULT 1,
  needs_reauth INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  sandbox_mode    TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  status          TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  team_provision_team_id TEXT,
  team_provision_reservation_id TEXT,
  team_provision_state TEXT CHECK (team_provision_state IS NULL OR team_provision_state IN ('provisional','published')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS trg_sessions_title_insert_bound
BEFORE INSERT ON sessions
WHEN length(NEW.title) > 120 OR length(CAST(NEW.title AS BLOB)) > 480
BEGIN
  SELECT RAISE(ABORT, 'session title exceeds bound');
END;
CREATE TRIGGER IF NOT EXISTS trg_sessions_title_update_bound
BEFORE UPDATE OF title ON sessions
WHEN length(NEW.title) > 120 OR length(CAST(NEW.title AS BLOB)) > 480
BEGIN
  SELECT RAISE(ABORT, 'session title exceeds bound');
END;

-- Bound legacy rows before any application query can materialize them. Current
-- writes pass through the stricter one-line scalar normalizer and these triggers.
UPDATE sessions
SET title = substr(title, 1, 120)
WHERE length(title) > 120 OR length(CAST(title AS BLOB)) > 480;

-- One durable top-level agent work interval. This is the product/Codex-style Turn, NOT pi's
-- provider-call-sized turn_start/turn_end. Composite identity lets a fork retain the exact
-- copied historical turn ids inside its new Session without inventing new lineage.
CREATE TABLE IF NOT EXISTS agent_turns (
  session_id   TEXT NOT NULL,
  id           TEXT NOT NULL,
  status       TEXT NOT NULL, -- in_progress | completed | interrupted | failed
  started_at   INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms  INTEGER,
  start_seq    INTEGER,
  end_seq      INTEGER,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  accepted_input TEXT,
  source       TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','team')),
  team_task_id TEXT,
  team_task_lease_generation INTEGER,
  team_mail_claim_generation INTEGER,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_turns_session_started ON agent_turns(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_turns_status ON agent_turns(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_one_in_progress
  ON agent_turns(session_id) WHERE status = 'in_progress';

-- Durable Session-local Agent identity. Team membership is a separate join
-- between real Session roots; it never creates another Agent kind here.
CREATE TABLE IF NOT EXISTS agent_nodes (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  session_id      TEXT,
  root_agent_id   TEXT NOT NULL,
  parent_agent_id TEXT,
  path            TEXT NOT NULL,
  label           TEXT,
  provider        TEXT,
  model           TEXT,
  thinking_level  TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('session', 'subagent')),
  purpose         TEXT NOT NULL DEFAULT 'addressable' CHECK (purpose IN ('addressable', 'joined_slot')),
  status          TEXT NOT NULL CHECK (status IN ('initializing', 'idle', 'running', 'interrupted', 'error', 'closed')),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (root_agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
  UNIQUE (root_agent_id, path)
);
CREATE INDEX IF NOT EXISTS idx_agent_nodes_session_updated
  ON agent_nodes(user_id, session_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_nodes_root_updated
  ON agent_nodes(user_id, root_agent_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_nodes_visible_children
  ON agent_nodes(user_id, root_agent_id, parent_agent_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_nodes_visible_roots
  ON agent_nodes(user_id, parent_agent_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_nodes_session_fk
  ON agent_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_nodes_parent_fk
  ON agent_nodes(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_nodes_dispatch_roots
  ON agent_nodes(id)
  WHERE id = root_agent_id AND kind = 'session' AND status <> 'closed';
CREATE INDEX IF NOT EXISTS idx_agent_nodes_user_dispatch_roots
  ON agent_nodes(user_id, id)
  WHERE id = root_agent_id AND kind = 'session' AND status <> 'closed';
CREATE INDEX IF NOT EXISTS idx_agent_nodes_dispatch_children
  ON agent_nodes(root_agent_id, kind, status, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_nodes_one_session_identity
  ON agent_nodes(session_id) WHERE session_id IS NOT NULL AND kind = 'session';

-- One tree-wide revision for the bounded Agent roster. Per-row versions cannot be
-- combined into a cache key: two independent mutations can have the same MAX(version),
-- and millisecond timestamps can tie. Every model-visible Agent/Task/result edge bumps
-- this row in the same transaction as the mutation it describes.
CREATE TABLE IF NOT EXISTS agent_rosters (
  root_agent_id TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- Internal joined workers advance the runtime cursor but must not invalidate
  -- the model-visible roster capsule or appear as a new addressable Agent.
  addressable_revision INTEGER NOT NULL DEFAULT 1 CHECK (addressable_revision >= 1),
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (root_agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_rosters_user_updated
  ON agent_rosters(user_id, updated_at DESC, root_agent_id DESC);

-- Account-wide collection cursor. Every addressable Agent/Task/Result edge
-- advances this in the same transaction as its per-Session roster revision.
CREATE TABLE IF NOT EXISTS orchestration_user_revisions (
  user_id           TEXT PRIMARY KEY,
  activity_revision INTEGER NOT NULL CHECK (activity_revision >= 1),
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Child-Agent transcript cache. This is independent from the Session message log: a
-- SubAgent may receive multiple Tasks while retaining its own context, whereas a
-- Team member owns a real Session and uses that Session transcript instead.
CREATE TABLE IF NOT EXISTS agent_transcripts (
  agent_id          TEXT PRIMARY KEY,
  version           INTEGER NOT NULL CHECK (version >= 1),
  source_task_id    TEXT,
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
  message_count     INTEGER NOT NULL CHECK (message_count >= 0 AND message_count <= 256),
  total_bytes       INTEGER NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= 16777216),
  saved_at          INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (source_task_id) REFERENCES runtime_tasks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_transcripts_source_task_fk
  ON agent_transcripts(source_task_id);
CREATE TABLE IF NOT EXISTS agent_messages (
  agent_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  msg_json    TEXT NOT NULL CHECK (
    json_valid(msg_json) AND length(CAST(msg_json AS BLOB)) <= 1048576
  ),
  msg_bytes   INTEGER NOT NULL CHECK (msg_bytes = length(CAST(msg_json AS BLOB))),
  saved_at    INTEGER NOT NULL,
  PRIMARY KEY (agent_id, seq),
  FOREIGN KEY (agent_id) REFERENCES agent_transcripts(agent_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_tool_result_delivery
  ON agent_messages(
    agent_id,
    json_extract(msg_json, '$.toolCallId'),
    json_extract(msg_json, '$.isError')
  )
  WHERE json_extract(msg_json, '$.role') = 'toolResult';

-- Workflow and Team identities are independent from executable Tasks. Workflow
-- identity owns versioned graph and run revisions; neither is inferred from Tasks.
CREATE TABLE IF NOT EXISTS workflows (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  owner_session_id    TEXT NOT NULL,
  root_agent_id       TEXT,
  controller_agent_id TEXT,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  definition_version  INTEGER NOT NULL DEFAULT 1 CHECK (definition_version >= 1),
  graph_revision      INTEGER NOT NULL DEFAULT 1 CHECK (graph_revision >= 1),
  graph_sealed        INTEGER NOT NULL DEFAULT 0 CHECK (graph_sealed IN (0, 1)),
  run_revision        INTEGER NOT NULL DEFAULT 1 CHECK (run_revision >= 1),
  max_nodes           INTEGER NOT NULL DEFAULT 64 CHECK (max_nodes BETWEEN 1 AND 64),
  max_edges           INTEGER NOT NULL DEFAULT 256 CHECK (max_edges BETWEEN 0 AND 256),
  max_depth           INTEGER NOT NULL DEFAULT 8 CHECK (max_depth BETWEEN 0 AND 16),
  max_attempts        INTEGER NOT NULL DEFAULT 128 CHECK (max_attempts BETWEEN 1 AND 256),
  max_runtime_ms      INTEGER NOT NULL DEFAULT 86400000 CHECK (max_runtime_ms BETWEEN 1 AND 604800000),
  max_tokens          INTEGER NOT NULL DEFAULT 2000000 CHECK (max_tokens BETWEEN 1 AND 100000000),
  max_cost_micros     INTEGER NOT NULL DEFAULT 1000000000 CHECK (max_cost_micros BETWEEN 1 AND 1000000000000),
  attempts_used       INTEGER NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
  tokens_used         INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  tokens_reserved     INTEGER NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  cost_used_micros    INTEGER NOT NULL DEFAULT 0 CHECK (cost_used_micros >= 0),
  cost_reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_reserved_micros >= 0),
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  started_at          INTEGER,
  settled_at          INTEGER,
  cancellation_pending INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_pending IN (0, 1)),
  terminal_intent     TEXT CHECK (terminal_intent IS NULL OR terminal_intent IN ('cancelled', 'failed')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (root_agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (controller_agent_id) REFERENCES agent_nodes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_owner_updated
  ON workflows(user_id, owner_session_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_owner_session_fk
  ON workflows(owner_session_id);
CREATE INDEX IF NOT EXISTS idx_workflows_controller_agent_fk
  ON workflows(controller_agent_id);

CREATE TABLE IF NOT EXISTS teams (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  root_agent_id    TEXT NOT NULL,
  owner_session_ref TEXT,
  root_agent_ref    TEXT,
  provision_key    TEXT,
  provision_request_json TEXT CHECK (provision_request_json IS NULL OR json_valid(provision_request_json)),
  provision_state  TEXT NOT NULL DEFAULT 'ready' CHECK (provision_state IN ('ready','provisioning','failed')),
  lead_agent_id    TEXT,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_session_ref) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (root_agent_ref) REFERENCES agent_nodes(id) ON DELETE SET NULL,
  FOREIGN KEY (lead_agent_id) REFERENCES agent_nodes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_owner_updated
  ON teams(user_id, owner_session_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_teams_owner_session_fk
  ON teams(owner_session_id);
CREATE INDEX IF NOT EXISTS idx_teams_lead_agent_fk
  ON teams(lead_agent_id);

-- A Team joins ordinary, navigable Session self-roots. Membership never changes
-- the Agent tree and one Session may participate in more than one Team.
CREATE TABLE IF NOT EXISTS team_members (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  role       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active', 'paused', 'removed')),
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
  UNIQUE (team_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_session
  ON team_members(session_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_team_members_team
  ON team_members(team_id, status, updated_at DESC, id DESC);

-- Immutable identity/provenance survives Session/Agent cascades. Live membership
-- is still enforced through team_members; history is never an execution authority.
CREATE TABLE IF NOT EXISTS team_member_history (
  member_id   TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  role        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active','paused','removed')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  removed_at  INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_member_history_session
  ON team_member_history(user_id, session_id, updated_at DESC);
CREATE TRIGGER IF NOT EXISTS team_member_history_insert
AFTER INSERT ON team_members
BEGIN
  INSERT INTO team_member_history
    (member_id, team_id, user_id, session_id, agent_id, role, status,
     created_at, updated_at, removed_at)
  SELECT NEW.id, NEW.team_id, team.user_id, NEW.session_id, NEW.agent_id, NEW.role,
         NEW.status, NEW.created_at, NEW.updated_at,
         CASE WHEN NEW.status = 'removed' THEN NEW.updated_at ELSE NULL END
  FROM teams team WHERE team.id = NEW.team_id
  ON CONFLICT(member_id) DO UPDATE SET role = excluded.role, status = excluded.status,
    updated_at = excluded.updated_at, removed_at = excluded.removed_at;
END;
CREATE TRIGGER IF NOT EXISTS team_member_history_update
AFTER UPDATE OF role, status, updated_at ON team_members
BEGIN
  UPDATE team_member_history SET role = NEW.role, status = NEW.status,
    updated_at = NEW.updated_at,
    removed_at = CASE WHEN NEW.status = 'removed' THEN NEW.updated_at ELSE removed_at END
  WHERE member_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS team_member_history_delete
BEFORE DELETE ON team_members
BEGIN
  UPDATE team_member_history SET status = 'removed', updated_at = MAX(updated_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
    removed_at = COALESCE(removed_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
  WHERE member_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS team_member_reservations (
  id               TEXT PRIMARY KEY,
  team_id          TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  actor_session_id TEXT NOT NULL,
  role             TEXT NOT NULL,
  provisioned_session_id TEXT NOT NULL,
  provisioned_agent_id TEXT NOT NULL,
  member_id        TEXT NOT NULL,
  operation_key    TEXT,
  request_json     TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  status           TEXT NOT NULL CHECK (status IN ('reserved','finalized','cancelled')),
  provision_generation INTEGER NOT NULL DEFAULT 0 CHECK (provision_generation >= 0),
  provision_claim_token TEXT,
  provision_claim_expires_at INTEGER,
  expires_at       INTEGER NOT NULL,
  cleanup_requested_at INTEGER,
  cleanup_completed_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (team_id, id)
);
CREATE INDEX IF NOT EXISTS idx_team_member_reservations_open
  ON team_member_reservations(team_id, status, expires_at);

-- One assignment is independent from its Agent identity and from the Tool Step which delegates it.
-- JSON size checks use BLOB length so the cap is UTF-8 bytes, not JavaScript or SQLite characters.
CREATE TABLE IF NOT EXISTS runtime_tasks (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  owner_session_id  TEXT NOT NULL,
  owner_turn_id     TEXT,
  owner_step_id     TEXT,
  agent_id          TEXT NOT NULL,
  agent_ord         INTEGER NOT NULL DEFAULT 0 CHECK (agent_ord >= 0),
  parent_task_id    TEXT,
  workflow_id       TEXT,
  team_id           TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('delegation', 'workflow_node', 'team_turn')),
  title             TEXT NOT NULL,
  payload_json      TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_bytes     INTEGER NOT NULL CHECK (
    payload_bytes = length(CAST(payload_json AS BLOB)) AND payload_bytes <= 65536
  ),
  status            TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'waiting', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  await_policy      TEXT NOT NULL CHECK (await_policy IN ('join', 'background')),
  cancel_policy     TEXT NOT NULL CHECK (cancel_policy IN ('linked', 'detached')),
  checkpoint_safe   INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_safe IN (0, 1)),
  capability_contract_version INTEGER NOT NULL DEFAULT 0 CHECK (capability_contract_version >= 0),
  provider_tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (provider_tokens_used >= 0),
  provider_cost_used_micros INTEGER NOT NULL DEFAULT 0 CHECK (provider_cost_used_micros >= 0),
  activity          TEXT CHECK (activity IS NULL OR activity IN ('model', 'approval', 'handoff', 'tool:shell', 'tool:read', 'tool:write', 'tool:search', 'tool:browser', 'tool:other')),
  wait_reason       TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('approval', 'dependency', 'resource', 'rate', 'signal', 'other')),
  lease_generation  INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  started_at        INTEGER,
  settled_at        INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_session_id, owner_turn_id) REFERENCES agent_turns(session_id, id),
  FOREIGN KEY (agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_session_updated
  ON runtime_tasks(user_id, session_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_user_updated
  ON runtime_tasks(user_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_owner_updated
  ON runtime_tasks(user_id, owner_session_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_owner_turn_updated
  ON runtime_tasks(user_id, owner_session_id, owner_turn_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_owner_step_updated
  ON runtime_tasks(user_id, owner_session_id, owner_step_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_visible_children
  ON runtime_tasks(user_id, session_id, parent_task_id, id);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_visible_roots
  ON runtime_tasks(user_id, parent_task_id, id);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_agent_updated
  ON runtime_tasks(agent_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_session_fk
  ON runtime_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_owner_turn_fk
  ON runtime_tasks(owner_session_id, owner_turn_id);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_parent_task_fk
  ON runtime_tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_workflow_fk
  ON runtime_tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_workflow_updated
  ON runtime_tasks(user_id, workflow_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_recovery
  ON runtime_tasks(checkpoint_safe, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_runtime_tasks_linked_orphan_scan
  ON runtime_tasks(updated_at, id)
  WHERE cancel_policy = 'linked' AND status IN ('queued','waiting');
-- Peer mail is an independent ledger. Session ids are immutable provenance
-- snapshots; mail never enters messages, pending_messages, or timeline.
CREATE TABLE IF NOT EXISTS team_mail (
  id                 TEXT PRIMARY KEY,
  team_id            TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  seq                INTEGER NOT NULL CHECK (seq >= 1),
  source_member_id   TEXT NOT NULL,
  source_session_id  TEXT NOT NULL,
  target_member_id   TEXT NOT NULL,
  target_session_id  TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('note', 'work', 'result', 'ack')),
  subject            TEXT NOT NULL,
  payload_json       TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_bytes      INTEGER NOT NULL CHECK (
    payload_bytes = length(CAST(payload_json AS BLOB)) AND payload_bytes <= 65536
  ),
  idempotency_key    TEXT NOT NULL,
  parent_mail_id     TEXT,
  task_id            TEXT,
  hop                INTEGER NOT NULL CHECK (hop >= 0 AND hop <= 8),
  deadline_at        INTEGER NOT NULL,
  budget_turns       INTEGER CHECK (budget_turns IS NULL OR budget_turns BETWEEN 1 AND 64),
  budget_tokens      INTEGER CHECK (budget_tokens IS NULL OR budget_tokens BETWEEN 1 AND 4000000),
  child_reserved_turns  INTEGER NOT NULL DEFAULT 0 CHECK (child_reserved_turns >= 0),
  child_reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (child_reserved_tokens >= 0),
  budget_root_mail_id    TEXT,
  budget_remaining_turns  INTEGER CHECK (budget_remaining_turns IS NULL OR budget_remaining_turns >= 0),
  budget_remaining_tokens INTEGER CHECK (budget_remaining_tokens IS NULL OR budget_remaining_tokens >= 0),
  route_reserved_turns    INTEGER NOT NULL DEFAULT 0 CHECK (route_reserved_turns >= 0),
  route_reserved_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (route_reserved_tokens >= 0),
  route_used_turns        INTEGER NOT NULL DEFAULT 0 CHECK (route_used_turns >= 0),
  route_used_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (route_used_tokens >= 0),
  self_used_model_cycles  INTEGER NOT NULL DEFAULT 0 CHECK (self_used_model_cycles >= 0),
  self_used_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (self_used_tokens >= 0),
  status             TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'acknowledged', 'cancelled')),
  claim_generation   INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claim_token        TEXT,
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  claimed_at         INTEGER,
  claim_expires_at   INTEGER,
  acknowledged_at    INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_mail_id) REFERENCES team_mail(id) ON DELETE SET NULL,
  FOREIGN KEY (budget_root_mail_id) REFERENCES team_mail(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE SET NULL,
  UNIQUE (team_id, seq),
  UNIQUE (team_id, source_member_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_team_mail_inbox
  ON team_mail(user_id, target_session_id, status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_team_mail_outbox
  ON team_mail(user_id, source_session_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_mail_claim_token
  ON team_mail(target_session_id, claim_token) WHERE claim_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_mail_work_task
  ON team_mail(task_id) WHERE kind = 'work' AND task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_mail_work_recovery
  ON team_mail(status, deadline_at, claim_expires_at, updated_at, id)
  WHERE kind = 'work' AND status IN ('queued','claimed');

-- Spent claim tokens remain tombstones. An old worker cannot reuse one token
-- after redelivery and accidentally select a different envelope.
CREATE TABLE IF NOT EXISTS team_mail_claims (
  mail_id            TEXT NOT NULL,
  target_session_id  TEXT NOT NULL,
  claim_token        TEXT NOT NULL,
  claim_generation   INTEGER NOT NULL CHECK (claim_generation >= 1),
  claimed_at         INTEGER NOT NULL,
  PRIMARY KEY (target_session_id, claim_token),
  FOREIGN KEY (mail_id) REFERENCES team_mail(id) ON DELETE CASCADE
);
-- Internal Team Turn completion outbox. The Session commits this row with the
-- Agent Turn terminal edge. A dispatcher can then finish Task/mail settlement
-- without rerunning model or tool side effects after a crash.
CREATE TABLE IF NOT EXISTS team_turn_outcomes (
  task_id        TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  turn_id        TEXT NOT NULL,
  task_lease_generation INTEGER NOT NULL CHECK (task_lease_generation >= 0),
  mail_claim_generation INTEGER NOT NULL CHECK (mail_claim_generation >= 1),
  status         TEXT NOT NULL CHECK (status IN ('completed','failed','interrupted','cancelled')),
  summary        TEXT NOT NULL,
  body_json      TEXT NOT NULL CHECK (json_valid(body_json)),
  artifacts_json TEXT NOT NULL CHECK (json_valid(artifacts_json)),
  model_cycles   INTEGER NOT NULL CHECK (model_cycles >= 0),
  tokens         INTEGER NOT NULL CHECK (tokens >= 0),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, turn_id) REFERENCES agent_turns(session_id, id) ON DELETE CASCADE,
  UNIQUE (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_team_turn_outcomes_user
  ON team_turn_outcomes(user_id, updated_at DESC, task_id);
CREATE INDEX IF NOT EXISTS idx_team_mail_claims_mail
  ON team_mail_claims(mail_id, claim_generation DESC);

-- Append-only lifecycle evidence. task_version identifies the Task state produced by an event.
CREATE TABLE IF NOT EXISTS task_events (
  task_id           TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  task_version      INTEGER NOT NULL CHECK (task_version >= 1),
  lease_generation  INTEGER NOT NULL CHECK (lease_generation >= 0),
  type              TEXT NOT NULL,
  payload_json      TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_bytes     INTEGER NOT NULL CHECK (
    payload_bytes = length(CAST(payload_json AS BLOB)) AND payload_bytes <= 16384
  ),
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (task_id, seq),
  FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE
);

-- Exact-attempt, bounded materialization of joined Child progress. This is a snapshot, not an
-- engine transcript or side-effect checkpoint. Each accepted semantic event atomically replaces
-- this row and the owner Timeline Step; last_seq makes duplicate/stale wire idempotent.
CREATE TABLE IF NOT EXISTS task_progress (
  task_id            TEXT PRIMARY KEY,
  lease_generation   INTEGER NOT NULL CHECK (lease_generation >= 1),
  last_seq            INTEGER NOT NULL CHECK (last_seq >= 1),
  turn_id             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('in_progress','completed','interrupted','failed')),
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  duration_ms         INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  source              TEXT NOT NULL CHECK (source IN ('worker','recovery')),
  owner_timeline_seq  INTEGER NOT NULL,
  nested_seq_highwater INTEGER NOT NULL CHECK (nested_seq_highwater >= 0),
  omitted_items       INTEGER NOT NULL DEFAULT 0 CHECK (omitted_items >= 0),
  omitted_bytes       INTEGER NOT NULL DEFAULT 0 CHECK (omitted_bytes >= 0),
  snapshot_json       TEXT NOT NULL CHECK (
    json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 524288
  ),
  snapshot_bytes      INTEGER NOT NULL CHECK (
    snapshot_bytes = length(CAST(snapshot_json AS BLOB)) AND snapshot_bytes <= 524288
  ),
  item_count          INTEGER NOT NULL CHECK (item_count >= 0 AND item_count <= 256),
  last_event_hash     TEXT NOT NULL CHECK (length(last_event_hash) = 64),
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE
);

-- A Task has at most one result. Full data is fetched only when the user or parent opens it.
CREATE TABLE IF NOT EXISTS task_results (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL UNIQUE,
  summary           TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) <= 16384),
  body_json         TEXT NOT NULL CHECK (
    json_valid(body_json) AND length(CAST(body_json AS BLOB)) <= 262144
  ),
  artifacts_json    TEXT NOT NULL CHECK (
    json_valid(artifacts_json) AND length(CAST(artifacts_json AS BLOB)) <= 65536
  ),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        INTEGER NOT NULL,
  acknowledged_at  INTEGER,
  FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_results_unread
  ON task_results(task_id, acknowledged_at) WHERE acknowledged_at IS NULL;

-- Reading a Result inside get_agent is not delivery. The acknowledgement is
-- staged here and commits only after the matching parent ToolResult is durable.
CREATE TABLE IF NOT EXISTS pending_result_acknowledgements (
  user_id               TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  delivery_agent_id     TEXT NOT NULL,
  delivery_step_id      TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  expected_result_version INTEGER NOT NULL CHECK (expected_result_version >= 1),
  acknowledge_on_error  INTEGER NOT NULL DEFAULT 0 CHECK (acknowledge_on_error IN (0, 1)),
  created_at            INTEGER NOT NULL,
  PRIMARY KEY (delivery_agent_id, delivery_step_id, task_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_agent_id) REFERENCES agent_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_result_ack_delivery
  ON pending_result_acknowledgements(user_id, session_id, delivery_agent_id, delivery_step_id);
-- Immutable authored definitions and the mutable run graph are separate. A
-- controller can append nodes without rewriting the definition which started it.
CREATE TABLE IF NOT EXISTS workflow_definition_versions (
  workflow_id       TEXT NOT NULL,
  version           INTEGER NOT NULL CHECK (version >= 1),
  graph_json        TEXT NOT NULL CHECK (
    json_valid(graph_json) AND length(CAST(graph_json AS BLOB)) <= 262144
  ),
  graph_hash        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, version),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  workflow_id       TEXT NOT NULL,
  id                TEXT NOT NULL,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('work', 'join', 'gate', 'controller')),
  payload_json      TEXT NOT NULL CHECK (
    json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 65536
  ),
  effect            TEXT NOT NULL CHECK (effect IN ('pure_readonly', 'workspace_read', 'workspace_write', 'network', 'unknown')),
  cache_policy      TEXT NOT NULL CHECK (cache_policy IN ('none', 'evidence')),
  status            TEXT NOT NULL CHECK (status IN ('blocked', 'ready', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  execution_phase   TEXT CHECK (execution_phase IS NULL OR execution_phase IN ('queued', 'starting', 'running', 'waiting', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  executor_agent_id TEXT,
  signal_name       TEXT,
  depth             INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 16),
  max_attempts      INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 16),
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  expanded_by_node_id TEXT,
  output_digest     TEXT,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  settled_at        INTEGER,
  PRIMARY KEY (workflow_id, id),
  CHECK (
    (kind IN ('work','controller') AND executor_agent_id IS NOT NULL)
    OR (kind IN ('join','gate') AND executor_agent_id IS NULL)
  ),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
  FOREIGN KEY (executor_agent_id) REFERENCES agent_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_nodes_state
  ON workflow_nodes(workflow_id, status, created_at, id);

-- Model-launched Workflow executors are private to one durable Workflow. The
-- row preserves ownership after the Agent closes, so history stays inspectable
-- while closed identities stop consuming live tree capacity.
CREATE TABLE IF NOT EXISTS workflow_managed_executors (
  workflow_id       TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  agent_id          TEXT NOT NULL UNIQUE,
  retired_at        INTEGER,
  PRIMARY KEY (workflow_id, node_id),
  FOREIGN KEY (workflow_id, node_id) REFERENCES workflow_nodes(workflow_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agent_nodes(id)
);

CREATE TABLE IF NOT EXISTS workflow_edges (
  workflow_id       TEXT NOT NULL,
  from_node_id      TEXT NOT NULL,
  to_node_id        TEXT NOT NULL,
  condition         TEXT NOT NULL CHECK (condition IN ('success', 'settled')),
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, from_node_id, to_node_id),
  CHECK (from_node_id <> to_node_id),
  FOREIGN KEY (workflow_id, from_node_id) REFERENCES workflow_nodes(workflow_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_id, to_node_id) REFERENCES workflow_nodes(workflow_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_edges_target
  ON workflow_edges(workflow_id, to_node_id, from_node_id);

CREATE TABLE IF NOT EXISTS workflow_node_attempts (
  workflow_id       TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  attempt_no        INTEGER NOT NULL CHECK (attempt_no >= 1),
  task_id           TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL CHECK (status IN ('running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  execution_phase   TEXT NOT NULL CHECK (execution_phase IN ('queued', 'starting', 'running', 'waiting', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  source            TEXT NOT NULL CHECK (source IN ('execution', 'cache')),
  cache_key         TEXT,
  source_task_id    TEXT,
  source_result_id  TEXT,
  evidence_json     TEXT NOT NULL CHECK (
    json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB)) <= 16384
  ),
  tokens_used       INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  tokens_reserved   INTEGER NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  cost_used_micros  INTEGER NOT NULL DEFAULT 0 CHECK (cost_used_micros >= 0),
  cost_reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_reserved_micros >= 0),
  deadline_at       INTEGER,
  created_at        INTEGER NOT NULL,
  settled_at        INTEGER,
  PRIMARY KEY (workflow_id, node_id, attempt_no),
  FOREIGN KEY (workflow_id, node_id) REFERENCES workflow_nodes(workflow_id, id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_task_id) REFERENCES runtime_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (source_result_id) REFERENCES task_results(id) ON DELETE SET NULL
);

-- Signals are an idempotent ledger. They are not Messages.
CREATE TABLE IF NOT EXISTS workflow_signals (
  workflow_id       TEXT NOT NULL,
  signal_name       TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
  graph_revision    INTEGER NOT NULL CHECK (graph_revision >= 1),
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, signal_name),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

-- Workflow evidence is append-only and shares each mutation transaction.
CREATE TABLE IF NOT EXISTS workflow_events (
  workflow_id       TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  workflow_version  INTEGER NOT NULL CHECK (workflow_version >= 1),
  graph_revision    INTEGER NOT NULL CHECK (graph_revision >= 1),
  run_revision      INTEGER NOT NULL CHECK (run_revision >= 1),
  type              TEXT NOT NULL,
  mutation_id       TEXT,
  request_digest    TEXT,
  payload_json      TEXT NOT NULL CHECK (
    json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 16384
  ),
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, seq),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_events_mutation
  ON workflow_events(workflow_id, mutation_id) WHERE mutation_id IS NOT NULL;

-- Cache values are user-scoped execution evidence. Only attested read-only
-- nodes can write them.
CREATE TABLE IF NOT EXISTS workflow_cache_entries (
  user_id           TEXT NOT NULL,
  cache_key         TEXT NOT NULL,
  contract_version  INTEGER NOT NULL CHECK (contract_version >= 1),
  summary           TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) <= 16384),
  body_json         TEXT NOT NULL CHECK (
    json_valid(body_json) AND length(CAST(body_json AS BLOB)) <= 262144
  ),
  artifacts_json    TEXT NOT NULL CHECK (
    json_valid(artifacts_json) AND length(CAST(artifacts_json AS BLOB)) <= 65536
  ),
  output_digest     TEXT NOT NULL,
  source_task_id    TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER NOT NULL,
  hit_count         INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  PRIMARY KEY (user_id, cache_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (source_task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE
);

-- Append-only timeline log (Codex rollout pattern), one row per persisted item.
CREATE TABLE IF NOT EXISTS timeline (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  turn_id    TEXT,
  item_json  TEXT NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- At most one quiet-window recap is pending per session. The payload is a bounded snapshot of the
-- completed turn, not a model transcript: keeping it here lets the runtime be released/rebuilt while
-- the 4.5 minute quiet window is still running. A new Agent Turn cancels the row; successful generation
-- atomically replaces it with a display-only timeline item. contract_version is the behavior key —
-- never infer prompt semantics from sessions.created_at.
CREATE TABLE IF NOT EXISTS recap_jobs (
  session_id       TEXT PRIMARY KEY,
  turn_id          TEXT NOT NULL,
  anchor_seq       INTEGER NOT NULL,
  due_at           INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recap_jobs_due ON recap_jobs(due_at);

-- Steer/queue messages persisted at SEND time (durable, separate from the delivered timeline so they
-- never enter getTimeline()/msg_cut/rewind/streaming-reducer). A pending row is promoted to a real
-- timeline user row only when pi actually consumes it (message_start). FIFO by ord.
CREATE TABLE IF NOT EXISTS pending_messages (
  session_id TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  id         TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('steer', 'queue')),
  text       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, ord),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Existing databases predate the inline CHECK above. These schema guards give old and new files the
-- same invariant without a blocking table-copy migration.
CREATE TRIGGER IF NOT EXISTS trg_pending_messages_kind_insert
BEFORE INSERT ON pending_messages
WHEN NEW.kind NOT IN ('steer', 'queue')
BEGIN
  SELECT RAISE(ABORT, 'invalid pending message kind');
END;
CREATE TRIGGER IF NOT EXISTS trg_pending_messages_kind_update
BEFORE UPDATE OF kind ON pending_messages
WHEN NEW.kind NOT IN ('steer', 'queue')
BEGIN
  SELECT RAISE(ABORT, 'invalid pending message kind');
END;

-- Raw pi Message log for faithful resume of the agent transcript.
CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  msg_json   TEXT NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_tool_result_delivery
  ON messages(
    session_id,
    json_extract(msg_json, '$.toolCallId'),
    json_extract(msg_json, '$.isError')
  )
  WHERE json_valid(msg_json) AND json_extract(msg_json, '$.role') = 'toolResult';

-- Uploaded attachments, for enforcing the per-user storage quota.
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ssh_targets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  label       TEXT NOT NULL,
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL DEFAULT 22,
  username    TEXT NOT NULL,
  enc_key     TEXT NOT NULL,   -- key_protected=0: AES-256-GCM(platform secret) of the key (#45); key_protected=1: JSON passkey-PRF-wrapped blob {v,credentialId,salt,iv,ct} the server CANNOT decrypt
  host_fp     TEXT,            -- TOFU host-key fingerprint, pinned on first connect
  key_protected INTEGER NOT NULL DEFAULT 0, -- 1 = private key wrapped by a passkey (WebAuthn PRF), unlockable only client-side
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connectors (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  workspace_root    TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  last_seen_at      INTEGER,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_pairings (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  code_hash      TEXT NOT NULL UNIQUE,
  expires_at     INTEGER NOT NULL,
  redeemed_at    INTEGER,
  connector_id   TEXT,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE SET NULL
);

-- WebAuthn passkeys used ONLY as a client-side key-derivation device (PRF extension), NOT as an
-- auth factor. We store just enough to run an assertion later (credential_id + transports) and a
-- label; we never store the public key or verify assertions server-side, because the security of
-- a passkey-protected SSH key comes entirely from the PRF secret never leaving the browser (the
-- server holds only ciphertext it cannot decrypt). See ssh_targets.key_protected + ssh-unlock.ts.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  credential_id  TEXT NOT NULL UNIQUE,   -- base64url of the raw WebAuthn credential id
  label          TEXT NOT NULL,
  transports     TEXT,                   -- JSON string[] of authenticator transports (hint for allowCredentials)
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Scheduled headless agent runs (#46). Each automation owns a dedicated session
-- (approval_policy:"never" — REQUIRED, else a headless turn would hang on a tool
-- approval with no client to answer) and fires that session's agent turn on an
-- interval. Deleting the user or the backing session cascades the automation away.
CREATE TABLE IF NOT EXISTS automations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_run_at      INTEGER,             -- epoch ms of the last fire (null = never run)
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Public read-only conversation shares (#J). A share is a FROZEN, redacted snapshot of a
-- session's timeline at share time, addressed by an unguessable capability token (NOT the
-- session id). The transcript may keep growing or gain sensitive content after sharing, so
-- we snapshot rather than serve live (see sharing/redact.ts). revoked_at soft-deletes the
-- share AND we clear snapshot_json on revoke so a revoked row holds no transcript at rest.
-- Deleting the session or the user cascades the share away.
CREATE TABLE IF NOT EXISTS shares (
  token         TEXT PRIMARY KEY,        -- crypto-random capability; the ONLY authorization to read
  session_id    TEXT NOT NULL,           -- provenance only (never served); FK so deleting the session revokes
  created_by    TEXT NOT NULL,           -- sharer user id — server-side only, NEVER returned to a public viewer
  title         TEXT NOT NULL,           -- snapshotted (redacted) session title at share time
  snapshot_json TEXT NOT NULL,           -- the filtered TimelineItem[] frozen at share time (cleared on revoke)
  meta_json     TEXT NOT NULL,           -- sanitized display meta: { model?, provider?, createdAt, itemCount }
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,                 -- null = active; set on revoke (kept so the token resolves dead)
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_session ON shares(session_id);
CREATE INDEX IF NOT EXISTS idx_shares_creator ON shares(created_by);

-- Compact operational audit log. This is intentionally separate from timeline/messages:
-- timeline is user-visible conversation state; audit_events is bounded, redacted,
-- queryable ops telemetry for debugging production behavior.
CREATE TABLE IF NOT EXISTS audit_events (
  id         TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  level      TEXT NOT NULL,
  event      TEXT NOT NULL,
  user_id    TEXT,
  session_id TEXT,
  request_id TEXT,
  target_id  TEXT,
  data_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_event_ts ON audit_events(event, ts);
CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON audit_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_session_ts ON audit_events(session_id, ts);

-- Status page (public, Atlassian/Cloudflare-style). All bounded + pruned like audit_events.
-- status_samples: one row per component per probe tick (the prober writes these).
CREATE TABLE IF NOT EXISTS status_samples (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  component   TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  latency_ms  INTEGER,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_component_ts ON status_samples(component, ts);
-- perf_samples: one row per real (non-subagent) turn, captured passively. ttft_ms is NULL
-- for non-streaming / no-first-token turns (excluded from latency percentiles, but ok/err
-- still feed the error rate).
CREATE TABLE IF NOT EXISTS perf_samples (
  ts        INTEGER NOT NULL,
  provider  TEXT NOT NULL,
  model     TEXT NOT NULL,
  ttft_ms   INTEGER,
  total_ms  INTEGER,
  ok        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_provider_model_ts ON perf_samples(provider, model, ts);
CREATE INDEX IF NOT EXISTS idx_perf_ts ON perf_samples(ts);
-- status_incidents: auto-derived (3 consecutive failed probes open; 2 successes resolve).
CREATE TABLE IF NOT EXISTS status_incidents (
  id          TEXT PRIMARY KEY,
  component   TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  severity    TEXT NOT NULL,
  summary     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_started ON status_incidents(started_at);
CREATE INDEX IF NOT EXISTS idx_incident_open ON status_incidents(component, resolved_at);

-- Raw provider request/response capture (Feature D, admin inspect). Ring-capped per session
-- (newest CAPTURE_RING_MAX kept). Bodies are byte-capped + response headers allowlisted
-- before storage (see capture.ts) so no auth/cookie/key is ever persisted.
CREATE TABLE IF NOT EXISTS request_captures (
  session_id        TEXT NOT NULL,
  message_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  request_json      TEXT NOT NULL,
  response_meta_json TEXT,
  response_msg_json TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_captures_session_seq ON request_captures(session_id, seq);

-- Feature C (compaction visibility): one row per auto-compaction. The timeline carries only a
-- lightweight compaction marker (meta); the heavy detail (summary + the archived older messages
-- that compaction would otherwise discard) lives here and is fetched on demand by the owner.
-- seq is the timeline seq of that marker, so the row correlates back to it.
-- Dreaming memory (per-user, cross-session). ONE synthesized memory document per user — the
-- "memory state" a background dreaming pass keeps fresh from recent session activity, plus the
-- user's own always-preserved notes/instructions. enabled gates BOTH injection and dreaming.
CREATE TABLE IF NOT EXISTS user_memory (
  user_id         TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 1,
  state           TEXT,               -- dreamed memory document (markdown); NULL = nothing yet
  user_notes      TEXT,               -- user-authored additions/instructions (verbatim, never rewritten)
  last_dreamed_at INTEGER,            -- wall clock of the last successful dreaming pass
  dreamed_through INTEGER,            -- high-water mark: sessions.updated_at consumed so far
  next_review_at  INTEGER,            -- earliest future date mentioned in state — due = time-only revision dream
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS compactions (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  summarized_count  INTEGER NOT NULL,
  tokens_before     INTEGER NOT NULL,
  tokens_after      INTEGER NOT NULL,
  summary_text      TEXT NOT NULL,
  archived_json     TEXT NOT NULL,   -- JSON of the archived older Message array
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_compactions_session_seq ON compactions(session_id, seq);
`);

for (const [column, definition] of [
  ["provider", "TEXT"],
  ["model", "TEXT"],
  ["thinking_level", "TEXT"],
  ["purpose", "TEXT NOT NULL DEFAULT 'addressable'"],
] as const) {
  try {
    db.exec(`ALTER TABLE agent_nodes ADD COLUMN ${column} ${definition};`);
  } catch (error) {
    if (!/duplicate column name/i.test(errorMessage(error))) throw error;
  }
}
db.exec(`
  UPDATE agent_nodes
  SET provider = (SELECT s.provider FROM sessions s WHERE s.id = agent_nodes.session_id),
      model = (SELECT s.model FROM sessions s WHERE s.id = agent_nodes.session_id)
  WHERE kind = 'subagent' AND (provider IS NULL OR model IS NULL)
    AND session_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = agent_nodes.session_id);
`);

for (const [column, definition] of [
  ["root_agent_id", "TEXT"],
  ["definition_version", "INTEGER NOT NULL DEFAULT 1"],
  ["graph_revision", "INTEGER NOT NULL DEFAULT 1"],
  ["graph_sealed", "INTEGER NOT NULL DEFAULT 0"],
  ["run_revision", "INTEGER NOT NULL DEFAULT 1"],
  ["max_nodes", "INTEGER NOT NULL DEFAULT 64"],
  ["max_edges", "INTEGER NOT NULL DEFAULT 256"],
  ["max_depth", "INTEGER NOT NULL DEFAULT 8"],
  ["max_attempts", "INTEGER NOT NULL DEFAULT 128"],
  ["max_runtime_ms", "INTEGER NOT NULL DEFAULT 86400000"],
  ["max_tokens", "INTEGER NOT NULL DEFAULT 2000000"],
  ["max_cost_micros", "INTEGER NOT NULL DEFAULT 1000000000"],
  ["attempts_used", "INTEGER NOT NULL DEFAULT 0"],
  ["tokens_used", "INTEGER NOT NULL DEFAULT 0"],
  ["tokens_reserved", "INTEGER NOT NULL DEFAULT 0"],
  ["cost_used_micros", "INTEGER NOT NULL DEFAULT 0"],
  ["cost_reserved_micros", "INTEGER NOT NULL DEFAULT 0"],
  ["started_at", "INTEGER"],
  ["settled_at", "INTEGER"],
  ["cancellation_pending", "INTEGER NOT NULL DEFAULT 0"],
  ["terminal_intent", "TEXT"],
] as const) {
  try {
    db.exec(`ALTER TABLE workflows ADD COLUMN ${column} ${definition};`);
  } catch (error) {
    if (!/duplicate column name/i.test(errorMessage(error))) throw error;
  }
}

try {
  db.exec("ALTER TABLE workflow_nodes ADD COLUMN executor_agent_id TEXT;");
} catch (error) {
  if (!/duplicate column name/i.test(errorMessage(error))) throw error;
}
try {
  db.exec("ALTER TABLE workflow_nodes ADD COLUMN execution_phase TEXT;");
} catch (error) {
  if (!/duplicate column name/i.test(errorMessage(error))) throw error;
}
try {
  db.exec("ALTER TABLE workflow_node_attempts ADD COLUMN execution_phase TEXT;");
} catch (error) {
  if (!/duplicate column name/i.test(errorMessage(error))) throw error;
}
for (const [column, definition] of [
  ["tokens_reserved", "INTEGER NOT NULL DEFAULT 0"],
  ["cost_reserved_micros", "INTEGER NOT NULL DEFAULT 0"],
  ["deadline_at", "INTEGER"],
] as const) {
  try {
    db.exec(`ALTER TABLE workflow_node_attempts ADD COLUMN ${column} ${definition};`);
  } catch (error) {
    if (!/duplicate column name/i.test(errorMessage(error))) throw error;
  }
}
try {
  db.exec("ALTER TABLE runtime_tasks ADD COLUMN capability_contract_version INTEGER NOT NULL DEFAULT 0;");
} catch (error) {
  if (!/duplicate column name/i.test(errorMessage(error))) throw error;
}
for (const [column, definition] of [
  ["provider_tokens_used", "INTEGER NOT NULL DEFAULT 0"],
  ["provider_cost_used_micros", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  try {
    db.exec(`ALTER TABLE runtime_tasks ADD COLUMN ${column} ${definition};`);
  } catch (error) {
    if (!/duplicate column name/i.test(errorMessage(error))) throw error;
  }
}
db.exec(`
  DROP TRIGGER IF EXISTS workflows_validate_graph_insert;
  DROP TRIGGER IF EXISTS workflows_validate_graph_update;
  DROP TRIGGER IF EXISTS workflow_nodes_validate_executor_insert;
  DROP TRIGGER IF EXISTS workflow_nodes_validate_executor_update;
  DROP TRIGGER IF EXISTS workflow_nodes_validate_execution_phase_insert;
  DROP TRIGGER IF EXISTS workflow_nodes_validate_execution_phase_update;
  DROP TRIGGER IF EXISTS workflow_attempts_validate_execution_phase_insert;
  DROP TRIGGER IF EXISTS workflow_attempts_validate_execution_phase_update;
  DROP TRIGGER IF EXISTS agent_nodes_delete_owned_workflows;
  DROP TRIGGER IF EXISTS agent_nodes_restrict_workflow_executors;
  DROP TRIGGER IF EXISTS agent_nodes_restrict_workflow_executor_close;
  DROP TRIGGER IF EXISTS sessions_delete_legacy_orchestration;
  DROP TRIGGER IF EXISTS users_delete_legacy_orchestration;
  DROP TRIGGER IF EXISTS workflows_delete_legacy_graph;
`);
db.exec(`
  UPDATE runtime_tasks
  SET checkpoint_safe = 0
  WHERE kind = 'workflow_node' AND capability_contract_version = 0 AND checkpoint_safe <> 0;

  UPDATE workflow_node_attempts
  SET execution_phase = COALESCE((
    SELECT task.status FROM runtime_tasks task
    WHERE task.id = workflow_node_attempts.task_id
  ), status)
  WHERE execution_phase IS NULL;
  UPDATE workflow_nodes
  SET execution_phase = CASE
    WHEN status = 'running' THEN COALESCE((
      SELECT task.status FROM workflow_node_attempts attempt
      JOIN runtime_tasks task ON task.id = attempt.task_id
      WHERE attempt.workflow_id = workflow_nodes.workflow_id
        AND attempt.node_id = workflow_nodes.id
        AND attempt.attempt_no = workflow_nodes.attempt_count
    ), 'running')
    ELSE NULL
  END
  WHERE execution_phase IS NULL;

  -- An older cancellation path marked the graph terminal before a live Task
  -- acknowledged cancel_requested. Restore the non-terminal derived phase.
  UPDATE workflows
  SET cancellation_pending = 1,
      terminal_intent = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
      settled_at = NULL
  WHERE cancellation_pending = 0
    AND status IN ('succeeded','failed','cancelled','interrupted')
    AND EXISTS (
      SELECT 1 FROM workflow_node_attempts attempt
      JOIN runtime_tasks task ON task.id = attempt.task_id
      WHERE attempt.workflow_id = workflows.id
        AND attempt.status IN ('running','cancel_requested')
        AND task.status IN ('queued','starting','running','waiting','cancel_requested')
    );

  UPDATE workflow_nodes
  SET status = 'running', execution_phase = (
        SELECT task.status FROM workflow_node_attempts attempt
        JOIN runtime_tasks task ON task.id = attempt.task_id
        WHERE attempt.workflow_id = workflow_nodes.workflow_id
          AND attempt.node_id = workflow_nodes.id
          AND attempt.attempt_no = workflow_nodes.attempt_count
      ), output_digest = NULL, settled_at = NULL,
      version = version + 1, updated_at = updated_at + 1
  WHERE status IN ('succeeded','failed','cancelled')
    AND EXISTS (
      SELECT 1 FROM workflow_node_attempts attempt
      JOIN runtime_tasks task ON task.id = attempt.task_id
      WHERE attempt.workflow_id = workflow_nodes.workflow_id
        AND attempt.node_id = workflow_nodes.id
        AND attempt.attempt_no = workflow_nodes.attempt_count
        AND attempt.status IN ('running','cancel_requested')
        AND task.status IN ('queued','starting','running','waiting','cancel_requested')
    );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_nodes_executor
  ON workflow_nodes(executor_agent_id, status, updated_at, workflow_id, id);`);

db.exec(`
  DROP TRIGGER IF EXISTS workflows_validate_graph_insert;
  DROP TRIGGER IF EXISTS workflows_validate_graph_update;
  DROP TRIGGER IF EXISTS workflow_nodes_validate_executor_insert;
  DROP TRIGGER IF EXISTS workflow_nodes_validate_executor_update;
  DROP TRIGGER IF EXISTS agent_nodes_delete_owned_workflows;
  DROP TRIGGER IF EXISTS agent_nodes_restrict_workflow_executors;
  DROP TRIGGER IF EXISTS agent_nodes_restrict_workflow_executor_close;
  DROP TRIGGER IF EXISTS sessions_delete_legacy_orchestration;
  DROP TRIGGER IF EXISTS users_delete_legacy_orchestration;
`);

db.exec(`
  -- The first Workflow placeholder format could retain a controller without a
  -- durable Agent root. Such a row cannot execute. Detach it before the strict
  -- graph validators return so later Session cleanup does not hit its FK.
  UPDATE workflows
  SET controller_agent_id = NULL
  WHERE root_agent_id IS NULL AND controller_agent_id IS NOT NULL;

  UPDATE workflow_nodes
  SET executor_agent_id = COALESCE(
    (
      SELECT t.agent_id FROM workflow_node_attempts a
      JOIN runtime_tasks t ON t.id = a.task_id
      JOIN agent_nodes executor ON executor.id = t.agent_id
      WHERE a.workflow_id = workflow_nodes.workflow_id AND a.node_id = workflow_nodes.id
        AND executor.kind = 'subagent' AND executor.purpose = 'addressable'
        AND executor.provider IS NOT NULL AND executor.model IS NOT NULL
      ORDER BY a.attempt_no DESC LIMIT 1
    ),
    CASE WHEN kind = 'controller' THEN (
      SELECT w.controller_agent_id FROM workflows w
      JOIN agent_nodes executor ON executor.id = w.controller_agent_id
      WHERE w.id = workflow_nodes.workflow_id
        AND executor.kind = 'subagent' AND executor.purpose = 'addressable'
        AND executor.provider IS NOT NULL AND executor.model IS NOT NULL
    ) END
  )
  WHERE kind IN ('work','controller') AND executor_agent_id IS NULL;

  UPDATE workflow_nodes
  SET status = 'failed', version = version + 1, updated_at = updated_at + 1,
      settled_at = updated_at + 1
  WHERE kind IN ('work','controller') AND executor_agent_id IS NULL
    AND status NOT IN ('succeeded','failed','cancelled')
    AND EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_nodes.workflow_id AND w.root_agent_id IS NOT NULL
    );

  UPDATE workflows
  SET status = 'interrupted', version = version + 1,
      run_revision = run_revision + 1, updated_at = updated_at + 1,
      settled_at = updated_at + 1
  WHERE root_agent_id IS NOT NULL
    AND status IN ('draft','queued','running','waiting')
    AND EXISTS (
      SELECT 1 FROM workflow_nodes n
      WHERE n.workflow_id = workflows.id AND n.kind IN ('work','controller')
        AND n.executor_agent_id IS NULL
    );
`);

db.exec(`
  DROP INDEX IF EXISTS idx_workflows_coordinator_active;
  CREATE INDEX IF NOT EXISTS idx_workflows_coordinator_active
    ON workflows(user_id, id)
    WHERE root_agent_id IS NOT NULL
      AND (status IN ('queued','running','waiting') OR cancellation_pending = 1);
  CREATE INDEX IF NOT EXISTS idx_workflows_root_agent ON workflows(root_agent_id, id);
  CREATE INDEX IF NOT EXISTS idx_workflows_user_id ON workflows(user_id, id);
  CREATE INDEX IF NOT EXISTS idx_workflows_controller_agent ON workflows(controller_agent_id, id);
  CREATE INDEX IF NOT EXISTS idx_workflows_owner_session ON workflows(owner_session_id, id);
  CREATE INDEX IF NOT EXISTS idx_runtime_tasks_workflow_fk ON runtime_tasks(workflow_id, id);
  CREATE INDEX IF NOT EXISTS idx_workflow_attempts_source_task
    ON workflow_node_attempts(source_task_id, workflow_id, node_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_attempts_source_result
    ON workflow_node_attempts(source_result_id, workflow_id, node_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_attempts_open_projection
    ON workflow_node_attempts(status, workflow_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_cache_source_task
    ON workflow_cache_entries(source_task_id, user_id, cache_key);
`);

db.exec(`
DROP TRIGGER IF EXISTS workflows_validate_graph_insert;
DROP TRIGGER IF EXISTS workflows_validate_graph_update;
DROP TRIGGER IF EXISTS workflow_nodes_validate_executor_insert;
DROP TRIGGER IF EXISTS workflow_nodes_validate_executor_update;
DROP TRIGGER IF EXISTS agent_nodes_delete_owned_workflows;
DROP TRIGGER IF EXISTS agent_nodes_restrict_workflow_executors;
DROP TRIGGER IF EXISTS agent_nodes_restrict_workflow_executor_close;
DROP TRIGGER IF EXISTS workflow_nodes_validate_execution_phase_insert;
DROP TRIGGER IF EXISTS workflow_nodes_validate_execution_phase_update;
DROP TRIGGER IF EXISTS workflow_attempts_validate_execution_phase_insert;
DROP TRIGGER IF EXISTS workflow_attempts_validate_execution_phase_update;
DROP TRIGGER IF EXISTS sessions_delete_legacy_orchestration;
DROP TRIGGER IF EXISTS users_delete_legacy_orchestration;
DROP TRIGGER IF EXISTS workflows_delete_legacy_graph;

CREATE TRIGGER IF NOT EXISTS workflows_validate_graph_insert
BEFORE INSERT ON workflows
WHEN NEW.root_agent_id IS NULL
  OR NEW.status NOT IN ('draft', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted')
  OR NEW.definition_version < 1 OR NEW.graph_revision < 1 OR NEW.run_revision < 1 OR NEW.version < 1
  OR NEW.attempts_used < 0 OR NEW.tokens_used < 0 OR NEW.cost_used_micros < 0
  OR NEW.cancellation_pending NOT IN (0, 1)
  OR NEW.terminal_intent NOT IN ('cancelled', 'failed')
     AND NEW.terminal_intent IS NOT NULL
  OR (NEW.cancellation_pending = 1 AND NEW.terminal_intent IS NULL)
  OR NEW.graph_sealed NOT IN (0, 1)
  OR NEW.max_nodes NOT BETWEEN 1 AND 64
  OR NEW.max_edges NOT BETWEEN 0 AND 256
  OR NEW.max_depth NOT BETWEEN 0 AND 16
  OR NEW.max_attempts NOT BETWEEN 1 AND 256
  OR NEW.max_runtime_ms NOT BETWEEN 1 AND 604800000
  OR NEW.max_tokens NOT BETWEEN 1 AND 100000000
  OR NEW.max_cost_micros NOT BETWEEN 1 AND 1000000000000
  OR NOT EXISTS (
    SELECT 1 FROM agent_nodes a
    WHERE a.id = NEW.root_agent_id AND a.user_id = NEW.user_id
      AND a.root_agent_id = a.id AND a.session_id = NEW.owner_session_id
      AND a.kind = 'session' AND a.purpose = 'addressable'
  )
  OR (
    NEW.controller_agent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM agent_nodes a
      WHERE a.id = NEW.controller_agent_id AND a.user_id = NEW.user_id
        AND a.root_agent_id = NEW.root_agent_id AND a.purpose = 'addressable'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow ownership or limits');
END;

CREATE TRIGGER IF NOT EXISTS workflows_validate_graph_update
BEFORE UPDATE OF root_agent_id, controller_agent_id, user_id, owner_session_id,
  status, definition_version, graph_revision, run_revision, version, graph_sealed,
  max_nodes, max_edges, max_depth, max_attempts, max_runtime_ms, max_tokens,
  max_cost_micros, attempts_used, tokens_used, cost_used_micros,
  cancellation_pending, terminal_intent ON workflows
WHEN NEW.root_agent_id IS NULL
  OR NEW.status NOT IN ('draft', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted')
  OR NEW.definition_version < 1 OR NEW.graph_revision < 1 OR NEW.run_revision < 1 OR NEW.version < 1
  OR NEW.attempts_used < 0 OR NEW.tokens_used < 0 OR NEW.cost_used_micros < 0
  OR NEW.cancellation_pending NOT IN (0, 1)
  OR NEW.terminal_intent NOT IN ('cancelled', 'failed')
     AND NEW.terminal_intent IS NOT NULL
  OR (NEW.cancellation_pending = 1 AND NEW.terminal_intent IS NULL)
  OR NEW.graph_sealed NOT IN (0, 1)
  OR NEW.max_nodes NOT BETWEEN 1 AND 64
  OR NEW.max_edges NOT BETWEEN 0 AND 256
  OR NEW.max_depth NOT BETWEEN 0 AND 16
  OR NEW.max_attempts NOT BETWEEN 1 AND 256
  OR NEW.max_runtime_ms NOT BETWEEN 1 AND 604800000
  OR NEW.max_tokens NOT BETWEEN 1 AND 100000000
  OR NEW.max_cost_micros NOT BETWEEN 1 AND 1000000000000
  OR NOT EXISTS (
    SELECT 1 FROM agent_nodes a
    WHERE a.id = NEW.root_agent_id AND a.user_id = NEW.user_id
      AND a.root_agent_id = a.id AND a.session_id = NEW.owner_session_id
      AND a.kind = 'session' AND a.purpose = 'addressable'
  )
  OR (
    NEW.controller_agent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM agent_nodes a
      WHERE a.id = NEW.controller_agent_id AND a.user_id = NEW.user_id
        AND a.root_agent_id = NEW.root_agent_id AND a.purpose = 'addressable'
    )
  )
  OR EXISTS (
    SELECT 1 FROM workflow_nodes n
    LEFT JOIN agent_nodes a ON a.id = n.executor_agent_id
    WHERE n.workflow_id = NEW.id AND n.kind IN ('work','controller')
      AND (
        a.id IS NULL OR a.user_id <> NEW.user_id OR a.root_agent_id <> NEW.root_agent_id
        OR a.kind <> 'subagent' OR a.purpose <> 'addressable'
        OR a.provider IS NULL OR a.model IS NULL
        OR (
          a.status = 'closed' AND NEW.cancellation_pending = 0
          AND NEW.status IN ('draft','queued','running','waiting')
        )
        OR (n.kind = 'controller' AND a.id IS NOT NEW.controller_agent_id)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow ownership or limits');
END;

CREATE TRIGGER IF NOT EXISTS workflow_nodes_validate_executor_insert
BEFORE INSERT ON workflow_nodes
WHEN (
  NEW.kind IN ('work','controller') AND (
    NEW.executor_agent_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM workflows w JOIN agent_nodes a ON a.id = NEW.executor_agent_id
      WHERE w.id = NEW.workflow_id AND a.user_id = w.user_id
        AND a.root_agent_id = w.root_agent_id AND a.purpose = 'addressable'
        AND a.kind = 'subagent' AND a.provider IS NOT NULL AND a.model IS NOT NULL
        AND a.status <> 'closed'
        AND (NEW.kind <> 'controller' OR a.id = w.controller_agent_id)
      )
      OR EXISTS (
        SELECT 1 FROM workflow_managed_executors managed
        WHERE managed.agent_id = NEW.executor_agent_id
          AND managed.workflow_id <> NEW.workflow_id
      )
    )
  ) OR (NEW.kind IN ('join','gate') AND NEW.executor_agent_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow executor Agent');
END;

CREATE TRIGGER IF NOT EXISTS workflow_nodes_validate_executor_update
BEFORE UPDATE OF kind, executor_agent_id, workflow_id ON workflow_nodes
WHEN (
  NEW.kind IN ('work','controller') AND (
    NEW.executor_agent_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM workflows w JOIN agent_nodes a ON a.id = NEW.executor_agent_id
      WHERE w.id = NEW.workflow_id AND a.user_id = w.user_id
        AND a.root_agent_id = w.root_agent_id AND a.purpose = 'addressable'
        AND a.kind = 'subagent' AND a.provider IS NOT NULL AND a.model IS NOT NULL
        AND a.status <> 'closed'
        AND (NEW.kind <> 'controller' OR a.id = w.controller_agent_id)
      )
      OR EXISTS (
        SELECT 1 FROM workflow_managed_executors managed
        WHERE managed.agent_id = NEW.executor_agent_id
          AND managed.workflow_id <> NEW.workflow_id
      )
    )
  ) OR (NEW.kind IN ('join','gate') AND NEW.executor_agent_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow executor Agent');
END;

CREATE TRIGGER IF NOT EXISTS workflow_nodes_validate_execution_phase_insert
BEFORE INSERT ON workflow_nodes
WHEN NEW.execution_phase IS NOT NULL AND NEW.execution_phase NOT IN
  ('queued','starting','running','waiting','cancel_requested','succeeded','failed','cancelled','interrupted')
BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow node execution phase');
END;

CREATE TRIGGER IF NOT EXISTS workflow_nodes_validate_execution_phase_update
BEFORE UPDATE OF execution_phase ON workflow_nodes
WHEN NEW.execution_phase IS NOT NULL AND NEW.execution_phase NOT IN
  ('queued','starting','running','waiting','cancel_requested','succeeded','failed','cancelled','interrupted')
BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow node execution phase');
END;

CREATE TRIGGER IF NOT EXISTS workflow_attempts_validate_execution_phase_insert
BEFORE INSERT ON workflow_node_attempts
WHEN NEW.execution_phase IS NULL OR NEW.execution_phase NOT IN
  ('queued','starting','running','waiting','cancel_requested','succeeded','failed','cancelled','interrupted')
BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow attempt execution phase');
END;

CREATE TRIGGER IF NOT EXISTS workflow_attempts_validate_execution_phase_update
BEFORE UPDATE OF execution_phase ON workflow_node_attempts
WHEN NEW.execution_phase IS NULL OR NEW.execution_phase NOT IN
  ('queued','starting','running','waiting','cancel_requested','succeeded','failed','cancelled','interrupted')
BEGIN
  SELECT RAISE(ABORT, 'invalid Workflow attempt execution phase');
END;

-- Remove the Workflow graph before SQLite checks executor references to the
-- Session root. Child executor deletion remains restricted by its normal FK.
CREATE TRIGGER IF NOT EXISTS agent_nodes_delete_owned_workflows
BEFORE DELETE ON agent_nodes
WHEN OLD.id = OLD.root_agent_id
BEGIN
  DELETE FROM workflows WHERE root_agent_id = OLD.id;
  DELETE FROM agent_nodes WHERE root_agent_id = OLD.id AND id <> OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS workflows_delete_legacy_graph
BEFORE DELETE ON workflows
BEGIN
  DELETE FROM workflow_edges WHERE workflow_id = OLD.id;
  DELETE FROM workflow_node_attempts WHERE workflow_id = OLD.id;
  DELETE FROM workflow_signals WHERE workflow_id = OLD.id;
  DELETE FROM workflow_events WHERE workflow_id = OLD.id;
  DELETE FROM workflow_definition_versions WHERE workflow_id = OLD.id;
  DELETE FROM workflow_nodes WHERE workflow_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS agent_nodes_restrict_workflow_executors
BEFORE DELETE ON agent_nodes
WHEN OLD.id <> OLD.root_agent_id AND EXISTS (
  SELECT 1 FROM workflow_nodes n WHERE n.executor_agent_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'Workflow executor Agent is still referenced');
END;

CREATE TRIGGER IF NOT EXISTS agent_nodes_restrict_workflow_executor_close
BEFORE UPDATE OF status ON agent_nodes
WHEN NEW.status = 'closed' AND OLD.status <> 'closed' AND EXISTS (
  SELECT 1 FROM workflow_nodes n JOIN workflows w ON w.id = n.workflow_id
  WHERE n.executor_agent_id = OLD.id
    AND (w.status IN ('draft','queued','running','waiting') OR w.cancellation_pending = 1)
)
BEGIN
  SELECT RAISE(ABORT, 'Active Workflow still uses this executor Agent');
END;

-- Old identity tables had no foreign keys. These deletes give upgraded
-- databases the same owner cascade as fresh schema tables.
CREATE TRIGGER IF NOT EXISTS sessions_delete_legacy_orchestration
BEFORE DELETE ON sessions
BEGIN
  DELETE FROM workflows WHERE owner_session_id = OLD.id;
  DELETE FROM agent_nodes WHERE session_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS users_delete_legacy_orchestration
BEFORE DELETE ON users
BEGIN
  DELETE FROM workflows WHERE user_id = OLD.id;
  DELETE FROM agent_nodes WHERE user_id = OLD.id;
END;
`);

try {
  db.exec(
    "ALTER TABLE pending_result_acknowledgements "
    + "ADD COLUMN acknowledge_on_error INTEGER NOT NULL DEFAULT 0 "
    + "CHECK (acknowledge_on_error IN (0, 1));",
  );
} catch (e) {
  if (!/duplicate column name/i.test(errorMessage(e))) throw e;
}
for (const [column, definition] of [
  ["provisioned_session_id", "TEXT"],
  ["provisioned_agent_id", "TEXT"],
  ["member_id", "TEXT"],
] as const) {
  try {
    db.exec(`ALTER TABLE team_member_reservations ADD COLUMN ${column} ${definition};`);
  } catch (e) {
    if (!/duplicate column name/i.test(errorMessage(e))) throw e;
  }
}
db.exec(`
  UPDATE agent_nodes
  SET root_agent_id = id, parent_agent_id = NULL, path = '/root', kind = 'session',
      purpose = 'addressable', provider = NULL, model = NULL, thinking_level = NULL
  WHERE kind = 'team_member' AND session_id IS NOT NULL;
  DROP INDEX IF EXISTS idx_agent_nodes_one_session_identity;
  CREATE UNIQUE INDEX idx_agent_nodes_one_session_identity
    ON agent_nodes(session_id) WHERE session_id IS NOT NULL AND kind = 'session';
`);
try {
  db.exec("ALTER TABLE runtime_tasks ADD COLUMN agent_ord INTEGER NOT NULL DEFAULT 0 CHECK (agent_ord >= 0);");
} catch (e) {
  if (!/duplicate column name/i.test(errorMessage(e))) throw e;
}
db.exec(`
  DROP INDEX IF EXISTS idx_runtime_tasks_open_agent_ord;
  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at ASC, id ASC) AS ord
    FROM runtime_tasks
  )
  UPDATE runtime_tasks
  SET agent_ord = (SELECT ord FROM ranked WHERE ranked.id = runtime_tasks.id)
  WHERE agent_ord = 0;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_tasks_agent_ord
    ON runtime_tasks(agent_id, agent_ord);
  CREATE INDEX IF NOT EXISTS idx_runtime_tasks_background_dispatch
    ON runtime_tasks(await_policy, status, agent_id, agent_ord);
  CREATE INDEX IF NOT EXISTS idx_runtime_tasks_agent_open
    ON runtime_tasks(agent_id, agent_ord)
    WHERE status IN ('queued','starting','running','waiting','cancel_requested');
  CREATE INDEX IF NOT EXISTS idx_runtime_tasks_linked_orphan_scan
    ON runtime_tasks(updated_at, id)
    WHERE cancel_policy = 'linked' AND status IN ('queued','waiting');
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_agent_nodes_dispatch_roots
    ON agent_nodes(id)
    WHERE id = root_agent_id AND kind = 'session' AND status <> 'closed';
  CREATE INDEX IF NOT EXISTS idx_agent_nodes_user_dispatch_roots
    ON agent_nodes(user_id, id)
    WHERE id = root_agent_id AND kind = 'session' AND status <> 'closed';
  CREATE INDEX IF NOT EXISTS idx_agent_nodes_dispatch_children
    ON agent_nodes(root_agent_id, kind, status, id);
`);

db.exec(`
  INSERT OR IGNORE INTO agent_rosters (root_agent_id, user_id, revision, updated_at)
  SELECT id, user_id, 1, updated_at FROM agent_nodes WHERE id = root_agent_id;
  INSERT OR IGNORE INTO team_member_history
    (member_id, team_id, user_id, session_id, agent_id, role, status, created_at, updated_at, removed_at)
  SELECT member.id, member.team_id, team.user_id, member.session_id, member.agent_id,
         member.role, member.status, member.created_at, member.updated_at,
         CASE WHEN member.status = 'removed' THEN member.updated_at ELSE NULL END
  FROM team_members member JOIN teams team ON team.id = member.team_id;
`);

try {
  db.exec("ALTER TABLE teams ADD COLUMN root_agent_id TEXT;");
} catch (e) {
  if (!/duplicate column name/i.test(errorMessage(e))) throw e;
}
try {
  db.exec("ALTER TABLE teams ADD COLUMN owner_session_ref TEXT;");
} catch (e) {
  if (!/duplicate column name/i.test(errorMessage(e))) throw e;
}
try {
  db.exec("ALTER TABLE teams ADD COLUMN root_agent_ref TEXT;");
} catch (e) {
  if (!/duplicate column name/i.test(errorMessage(e))) throw e;
}
for (const [column, definition] of [
  ["provision_key", "TEXT"],
  ["provision_request_json", "TEXT"],
  ["provision_state", "TEXT NOT NULL DEFAULT 'ready'"],
] as const) {
  try {
    db.exec(`ALTER TABLE teams ADD COLUMN ${column} ${definition};`);
  } catch (e) {
    if (!/duplicate column name/i.test(errorMessage(e))) throw e;
  }
}
for (const [column, definition] of [
  ["operation_key", "TEXT"],
  ["request_json", "TEXT"],
  ["provision_generation", "INTEGER NOT NULL DEFAULT 0"],
  ["provision_claim_token", "TEXT"],
  ["provision_claim_expires_at", "INTEGER"],
  ["cleanup_requested_at", "INTEGER"],
  ["cleanup_completed_at", "INTEGER"],
] as const) {
  try {
    db.exec(`ALTER TABLE team_member_reservations ADD COLUMN ${column} ${definition};`);
  } catch (e) {
    if (!/duplicate column name/i.test(errorMessage(e))) throw e;
  }
}
db.exec(`
  DROP TRIGGER IF EXISTS team_member_reservations_generation_insert_guard;
  DROP TRIGGER IF EXISTS team_member_reservations_generation_update_guard;
  CREATE TRIGGER team_member_reservations_generation_insert_guard
  BEFORE INSERT ON team_member_reservations
  WHEN NEW.provision_generation < 0
  BEGIN
    SELECT RAISE(ABORT, 'invalid Team provision generation');
  END;
  CREATE TRIGGER team_member_reservations_generation_update_guard
  BEFORE UPDATE OF provision_generation ON team_member_reservations
  WHEN NEW.provision_generation < 0
  BEGIN
    SELECT RAISE(ABORT, 'invalid Team provision generation');
  END;
`);
try {
  db.exec("ALTER TABLE runtime_tasks ADD COLUMN team_id TEXT;");
} catch (e) {
  if (!/duplicate column name/i.test(errorMessage(e))) throw e;
}
for (const [column, definition] of [
  ["deadline_at", "INTEGER NOT NULL DEFAULT 0"],
  ["budget_turns", "INTEGER"],
  ["budget_tokens", "INTEGER"],
  ["child_reserved_turns", "INTEGER NOT NULL DEFAULT 0"],
  ["child_reserved_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["budget_root_mail_id", "TEXT"],
  ["budget_remaining_turns", "INTEGER"],
  ["budget_remaining_tokens", "INTEGER"],
  ["route_reserved_turns", "INTEGER NOT NULL DEFAULT 0"],
  ["route_reserved_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["route_used_turns", "INTEGER NOT NULL DEFAULT 0"],
  ["route_used_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["self_used_model_cycles", "INTEGER NOT NULL DEFAULT 0"],
  ["self_used_tokens", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  try {
    db.exec(`ALTER TABLE team_mail ADD COLUMN ${column} ${definition};`);
  } catch (e) {
    if (!/duplicate column name/i.test(errorMessage(e))) throw e;
  }
}
db.exec(`
  UPDATE teams SET root_agent_id = (
    SELECT id FROM agent_nodes
    WHERE agent_nodes.session_id = teams.owner_session_id
      AND agent_nodes.id = agent_nodes.root_agent_id
      AND agent_nodes.user_id = teams.user_id
    LIMIT 1
  ) WHERE root_agent_id IS NULL;
  UPDATE teams SET owner_session_ref = owner_session_id
  WHERE owner_session_ref IS NULL AND status <> 'closed'
    AND EXISTS (
      SELECT 1 FROM sessions session
      WHERE session.id = teams.owner_session_id AND session.user_id = teams.user_id
    );
  UPDATE teams SET root_agent_ref = root_agent_id
  WHERE root_agent_ref IS NULL AND status <> 'closed'
    AND EXISTS (
      SELECT 1 FROM agent_nodes agent
      WHERE agent.id = teams.root_agent_id AND agent.user_id = teams.user_id
        AND agent.id = agent.root_agent_id AND agent.kind = 'session' AND agent.status <> 'closed'
    );
  UPDATE teams SET status = 'closed', version = version + 1
  WHERE status <> 'closed' AND (owner_session_ref IS NULL OR root_agent_ref IS NULL);
  UPDATE teams SET status = 'paused', version = version + 1
  WHERE status = 'active' AND NOT EXISTS (
    SELECT 1 FROM team_members member
    WHERE member.team_id = teams.id AND member.agent_id = teams.lead_agent_id
      AND member.status = 'active'
  );
  UPDATE team_mail SET deadline_at = created_at + 3600000 WHERE deadline_at = 0;
  UPDATE team_mail SET budget_turns = 8, budget_tokens = 100000
    WHERE kind = 'work' AND (budget_turns IS NULL OR budget_tokens IS NULL);
  UPDATE team_mail SET budget_turns = NULL, budget_tokens = NULL WHERE kind <> 'work';
  -- Old work predates aggregate accounting. Consume its whole route budget
  -- conservatively so an upgrade can never mint new capacity.
  UPDATE team_mail SET budget_root_mail_id = id,
    budget_remaining_turns = 0, budget_remaining_tokens = 0,
    route_reserved_turns = 0, route_reserved_tokens = 0,
    route_used_turns = budget_turns, route_used_tokens = budget_tokens
  WHERE kind = 'work' AND budget_root_mail_id IS NULL;
  DROP INDEX IF EXISTS idx_team_members_active_agent;
  CREATE INDEX IF NOT EXISTS idx_runtime_tasks_team_updated
    ON runtime_tasks(team_id, updated_at DESC, id DESC) WHERE team_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_team_mail_work_recovery
    ON team_mail(status, deadline_at, claim_expires_at, updated_at, id)
    WHERE kind = 'work' AND status IN ('queued','claimed');
  CREATE INDEX IF NOT EXISTS idx_teams_owner_session_ref_fk ON teams(owner_session_ref);
  CREATE INDEX IF NOT EXISTS idx_teams_root_agent_ref_fk ON teams(root_agent_ref);
  CREATE INDEX IF NOT EXISTS idx_runtime_tasks_team_fk ON runtime_tasks(team_id);
  CREATE INDEX IF NOT EXISTS idx_team_mail_task_fk ON team_mail(task_id);
  CREATE INDEX IF NOT EXISTS idx_team_mail_budget_root_fk ON team_mail(budget_root_mail_id);
  CREATE INDEX IF NOT EXISTS idx_team_mail_parent_fk ON team_mail(parent_mail_id);
  CREATE INDEX IF NOT EXISTS idx_team_member_history_team_fk ON team_member_history(team_id);
  CREATE INDEX IF NOT EXISTS idx_team_member_reservations_user_fk ON team_member_reservations(user_id);
  CREATE INDEX IF NOT EXISTS idx_team_members_agent_fk ON team_members(agent_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_provision_operation
    ON teams(user_id, owner_session_id, provision_key) WHERE provision_key IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_team_member_reservations_operation
    ON team_member_reservations(team_id, operation_key) WHERE operation_key IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_team_member_reservations_provision_session
    ON team_member_reservations(user_id, provisioned_session_id);
  CREATE INDEX IF NOT EXISTS idx_team_member_reservations_cleanup
    ON team_member_reservations(status, cleanup_requested_at, updated_at, id)
    WHERE status = 'reserved' AND cleanup_requested_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_team_member_reservations_provision_claim
    ON team_member_reservations(status, cleanup_requested_at, provision_claim_expires_at, created_at, id)
    WHERE status = 'reserved' AND cleanup_requested_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_team_member_reservations_claim_token
    ON team_member_reservations(provision_claim_token)
    WHERE provision_claim_token IS NOT NULL;

  CREATE TRIGGER IF NOT EXISTS team_mail_budget_insert_guard
  BEFORE INSERT ON team_mail
  WHEN NEW.deadline_at <= NEW.created_at
    OR NEW.deadline_at - NEW.created_at > 604800000
    OR (NEW.kind = 'work' AND (NEW.budget_turns IS NULL OR NEW.budget_tokens IS NULL))
    OR (NEW.kind <> 'work' AND (NEW.budget_turns IS NOT NULL OR NEW.budget_tokens IS NOT NULL))
  BEGIN
    SELECT RAISE(ABORT, 'invalid Team mail deadline or budget');
  END;
  CREATE TRIGGER IF NOT EXISTS team_mail_budget_update_guard
  BEFORE UPDATE OF kind, created_at, deadline_at, budget_turns, budget_tokens ON team_mail
  WHEN NEW.deadline_at <= NEW.created_at
    OR NEW.deadline_at - NEW.created_at > 604800000
    OR (NEW.kind = 'work' AND (NEW.budget_turns IS NULL OR NEW.budget_tokens IS NULL))
    OR (NEW.kind <> 'work' AND (NEW.budget_turns IS NOT NULL OR NEW.budget_tokens IS NOT NULL))
  BEGIN
    SELECT RAISE(ABORT, 'invalid Team mail deadline or budget');
  END;
  DROP TRIGGER IF EXISTS team_mail_route_budget_insert_guard;
  DROP TRIGGER IF EXISTS team_mail_route_budget_update_guard;
  CREATE TRIGGER IF NOT EXISTS team_mail_route_budget_insert_guard
  BEFORE INSERT ON team_mail
  WHEN NEW.child_reserved_turns < 0 OR NEW.child_reserved_tokens < 0
    OR NEW.self_used_model_cycles < 0 OR NEW.self_used_tokens < 0
    OR (NEW.kind = 'work' AND (
      NEW.budget_root_mail_id IS NULL
      OR NEW.budget_remaining_turns IS NULL OR NEW.budget_remaining_tokens IS NULL
      OR NEW.budget_remaining_turns > NEW.budget_turns
      OR NEW.budget_remaining_tokens > NEW.budget_tokens
      OR NEW.route_used_turns + NEW.route_reserved_turns > NEW.budget_turns
      OR NEW.route_used_tokens + NEW.route_reserved_tokens > NEW.budget_tokens
    ))
  BEGIN
    SELECT RAISE(ABORT, 'invalid Team route budget');
  END;
  CREATE TRIGGER IF NOT EXISTS team_mail_route_budget_update_guard
  BEFORE UPDATE OF budget_turns, budget_tokens, child_reserved_turns, child_reserved_tokens,
    budget_root_mail_id, budget_remaining_turns, budget_remaining_tokens,
    route_reserved_turns, route_reserved_tokens, route_used_turns, route_used_tokens,
    self_used_model_cycles, self_used_tokens ON team_mail
  WHEN NEW.child_reserved_turns < 0 OR NEW.child_reserved_tokens < 0
    OR NEW.self_used_model_cycles < 0 OR NEW.self_used_tokens < 0
    OR (NEW.kind = 'work' AND (
      NEW.budget_root_mail_id IS NULL
      OR NEW.budget_remaining_turns IS NULL OR NEW.budget_remaining_tokens IS NULL
      OR NEW.budget_remaining_turns > NEW.budget_turns
      OR NEW.budget_remaining_tokens > NEW.budget_tokens
      OR NEW.route_reserved_turns > NEW.budget_turns
      OR NEW.route_reserved_tokens > NEW.budget_tokens
    ))
  BEGIN
    SELECT RAISE(ABORT, 'invalid Team route budget');
  END;
`);

let addedAddressableRosterRevision = false;
try {
  db.exec("ALTER TABLE agent_rosters ADD COLUMN addressable_revision INTEGER NOT NULL DEFAULT 1 CHECK (addressable_revision >= 1);");
  addedAddressableRosterRevision = true;
} catch (e) {
  if (!/duplicate column name/i.test(errorMessage(e))) throw e;
}
if (addedAddressableRosterRevision) {
  db.exec("UPDATE agent_rosters SET addressable_revision = revision;");
}
db.exec(`
  INSERT OR IGNORE INTO orchestration_user_revisions (user_id, activity_revision, updated_at)
  SELECT user_id, 1, MAX(updated_at) FROM agent_rosters GROUP BY user_id;
`);

for (const [col, def] of [
  ["sandbox_kind", "TEXT NOT NULL DEFAULT 'local'"],
  ["sandbox_id", "TEXT"],
  ["sandbox_target_id", "TEXT"],
  ["mode", "TEXT NOT NULL DEFAULT 'coding'"],
  ["thinking_level", "TEXT NOT NULL DEFAULT 'medium'"],
  ["e2b_snapshot_id", "TEXT"],
  ["connector_unconfined", "INTEGER"],
  ["self_token", "TEXT"],
  ["approved_tools", "TEXT"],
  ["team_provision_team_id", "TEXT"],
  ["team_provision_reservation_id", "TEXT"],
  ["team_provision_state", "TEXT"],
] as const) {
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${def};`);
  } catch {
  }
}
db.exec(`
  DROP TRIGGER IF EXISTS sessions_team_provision_state_insert_guard;
  DROP TRIGGER IF EXISTS sessions_team_provision_state_update_guard;
  CREATE TRIGGER sessions_team_provision_state_insert_guard
  BEFORE INSERT ON sessions
  WHEN NEW.team_provision_state IS NOT NULL
    AND NEW.team_provision_state NOT IN ('provisional','published')
  BEGIN
    SELECT RAISE(ABORT, 'invalid Team Session provision state');
  END;
  CREATE TRIGGER sessions_team_provision_state_update_guard
  BEFORE UPDATE OF team_provision_state ON sessions
  WHEN NEW.team_provision_state IS NOT NULL
    AND NEW.team_provision_state NOT IN ('provisional','published')
  BEGIN
    SELECT RAISE(ABORT, 'invalid Team Session provision state');
  END;
`);
db.exec(`
  UPDATE agent_nodes
  SET provider = (SELECT s.provider FROM sessions s WHERE s.id = agent_nodes.session_id),
      model = (SELECT s.model FROM sessions s WHERE s.id = agent_nodes.session_id),
      thinking_level = COALESCE(
        (SELECT s.thinking_level FROM sessions s WHERE s.id = agent_nodes.session_id),
        'medium'
      )
  WHERE kind = 'subagent'
    AND (provider IS NULL OR model IS NULL)
    AND session_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = agent_nodes.session_id);
`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_self_token ON sessions(self_token) WHERE self_token IS NOT NULL;");
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_team_provision_reservation
  ON sessions(team_provision_reservation_id)
  WHERE team_provision_reservation_id IS NOT NULL;`);
db.exec(`
  UPDATE sessions
  SET team_provision_team_id = (
        SELECT reservation.team_id FROM team_member_reservations reservation
        WHERE reservation.user_id = sessions.user_id
          AND reservation.provisioned_session_id = sessions.id
          AND reservation.status IN ('reserved','finalized')
        LIMIT 1
      ),
      team_provision_reservation_id = (
        SELECT reservation.id FROM team_member_reservations reservation
        WHERE reservation.user_id = sessions.user_id
          AND reservation.provisioned_session_id = sessions.id
          AND reservation.status IN ('reserved','finalized')
        LIMIT 1
      ),
      team_provision_state = CASE WHEN EXISTS (
        SELECT 1 FROM team_member_reservations reservation
        JOIN teams team ON team.id = reservation.team_id
        WHERE reservation.user_id = sessions.user_id
          AND reservation.provisioned_session_id = sessions.id
          AND reservation.status = 'finalized' AND team.status = 'active'
      ) THEN 'published' ELSE 'provisional' END
  WHERE team_provision_state IS NULL AND EXISTS (
    SELECT 1 FROM team_member_reservations reservation
    WHERE reservation.user_id = sessions.user_id
      AND reservation.provisioned_session_id = sessions.id
      AND reservation.status IN ('reserved','finalized')
  );
`);

try {
  db.exec(`ALTER TABLE connectors ADD COLUMN unconfined INTEGER NOT NULL DEFAULT 0;`);
} catch {
}

try {
  db.exec(`ALTER TABLE ssh_targets ADD COLUMN unconfined INTEGER NOT NULL DEFAULT 0;`);
} catch {
}

for (const [col, def] of [
  ["github_id", "TEXT"],
  ["google_id", "TEXT"],
  ["proxy_url", "TEXT"],
  ["jump_server", "TEXT"],
  ["os_uid", "INTEGER"],
  ["password_changed_at", "INTEGER"],
  ["email_verified", "INTEGER"],
  ["verify_token", "TEXT"],
  ["verify_expires", "INTEGER"],
  ["verify_code_hash", "TEXT"],
  ["verify_attempts", "INTEGER"],
  ["verify_locked_until", "INTEGER"],
  ["verify_sent_at", "INTEGER"],
  ["banned_at", "INTEGER"],
  ["ban_reason", "TEXT"],
  ["canonical_email", "TEXT"],
  ["reset_code_hash", "TEXT"],
  ["reset_expires", "INTEGER"],
  ["reset_attempts", "INTEGER"],
  ["reset_locked_until", "INTEGER"],
  ["reset_sent_at", "INTEGER"],
] as const) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def};`);
  } catch (e) {
    if (!/duplicate column name/i.test(errorMessage(e))) throw e;
  }
}

try {
  db.exec(`ALTER TABLE timeline ADD COLUMN msg_cut INTEGER;`);
} catch {
}

try {
  db.exec(`ALTER TABLE timeline ADD COLUMN turn_id TEXT;`);
} catch {
}

try {
  db.exec(`ALTER TABLE agent_turns ADD COLUMN accepted_input TEXT;`);
} catch {
}
try {
  db.exec(`ALTER TABLE agent_turns ADD COLUMN team_task_id TEXT;`);
} catch {
}
try {
  db.exec(`ALTER TABLE agent_turns ADD COLUMN team_task_lease_generation INTEGER;`);
} catch {
}
try {
  db.exec(`ALTER TABLE agent_turns ADD COLUMN team_mail_claim_generation INTEGER;`);
} catch {
}
try {
  db.exec(`ALTER TABLE agent_turns ADD COLUMN source TEXT NOT NULL DEFAULT 'user';`);
} catch {
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_team_task
    ON agent_turns(team_task_id) WHERE team_task_id IS NOT NULL;
`);

for (const [column, definition] of [
  ["task_lease_generation", "INTEGER NOT NULL DEFAULT 0"],
  ["mail_claim_generation", "INTEGER NOT NULL DEFAULT 1"],
] as const) {
  try {
    db.exec(`ALTER TABLE team_turn_outcomes ADD COLUMN ${column} ${definition};`);
  } catch (e) {
    if (!/duplicate column name/i.test(errorMessage(e))) throw e;
  }
}

const teamForeignKeys = db.prepare("PRAGMA foreign_key_list('teams')").all() as unknown as Array<{
  from: string;
}>;
const rebuildTeams = teamForeignKeys.some((foreignKey) =>
  foreignKey.from === "owner_session_id" || foreignKey.from === "root_agent_id"
);
const outcomeSql = (db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'team_turn_outcomes'",
).get() as { sql: string } | undefined)?.sql ?? "";
const outcomeColumns = db.prepare("PRAGMA table_info('team_turn_outcomes')").all() as unknown as Array<{
  name: string;
  dflt_value: string | null;
}>;
const repairOutcomeGenerations = outcomeColumns.some((column) =>
  (column.name === "task_lease_generation" || column.name === "mail_claim_generation")
  && column.dflt_value !== null
);
const rebuildOutcomes = !/['"]cancelled['"]/i.test(outcomeSql) || repairOutcomeGenerations;

if (rebuildTeams || rebuildOutcomes) {
  if (repairOutcomeGenerations) {
    const legacyOutcomes = db.prepare(
      `SELECT outcome.task_id, outcome.session_id, outcome.turn_id, outcome.created_at,
         turn.team_task_lease_generation AS turn_task_generation,
         turn.team_mail_claim_generation AS turn_mail_generation,
         mail.id AS mail_id, mail.claim_generation, mail.claimed_at,
         (
           SELECT claim.claim_generation FROM team_mail_claims claim
           WHERE claim.mail_id = mail.id AND claim.claimed_at <= outcome.created_at
           ORDER BY claim.claimed_at DESC, claim.claim_generation DESC LIMIT 1
         ) AS tombstone_generation
       FROM team_turn_outcomes outcome
       LEFT JOIN agent_turns turn
         ON turn.session_id = outcome.session_id AND turn.id = outcome.turn_id
           AND turn.source = 'team' AND turn.team_task_id = outcome.task_id
       LEFT JOIN team_mail mail ON mail.task_id = outcome.task_id AND mail.kind = 'work'
       ORDER BY outcome.created_at ASC, outcome.task_id ASC`,
    ).all() as unknown as Array<{
      task_id: string;
      session_id: string;
      turn_id: string;
      created_at: number;
      turn_task_generation: number | null;
      turn_mail_generation: number | null;
      mail_id: string | null;
      claim_generation: number | null;
      claimed_at: number | null;
      tombstone_generation: number | null;
    }>;
    for (const outcome of legacyOutcomes) {
      const taskGeneration = outcome.turn_task_generation
        ?? outcome.tombstone_generation
        ?? (outcome.claimed_at !== null && outcome.claimed_at <= outcome.created_at
          ? outcome.claim_generation
          : null);
      const mailGeneration = outcome.turn_mail_generation
        ?? outcome.tombstone_generation
        ?? (outcome.claimed_at !== null && outcome.claimed_at <= outcome.created_at
          ? outcome.claim_generation
          : null);
      if (
        taskGeneration === null
        || mailGeneration === null
        || taskGeneration < 1
        || taskGeneration !== mailGeneration
      ) {
        throw new Error(`Cannot recover exact Team outcome generation for ${outcome.task_id}`);
      }
      db.prepare(
        `UPDATE team_turn_outcomes
         SET task_lease_generation = ?, mail_claim_generation = ?
         WHERE task_id = ?`,
      ).run(taskGeneration, mailGeneration, outcome.task_id);
      db.prepare(
        `UPDATE agent_turns
         SET team_task_lease_generation = COALESCE(team_task_lease_generation, ?),
             team_mail_claim_generation = COALESCE(team_mail_claim_generation, ?)
         WHERE session_id = ? AND id = ? AND source = 'team' AND team_task_id = ?`,
      ).run(
        taskGeneration,
        mailGeneration,
        outcome.session_id,
        outcome.turn_id,
        outcome.task_id,
      );
    }
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec("BEGIN IMMEDIATE;");
    if (rebuildTeams) {
      db.exec(`
        DROP TRIGGER IF EXISTS team_member_history_insert;
        DROP TRIGGER IF EXISTS team_member_history_update;
        DROP TRIGGER IF EXISTS team_member_history_delete;
        CREATE TABLE teams_next (
          id                TEXT PRIMARY KEY,
          user_id           TEXT NOT NULL,
          owner_session_id  TEXT NOT NULL,
          root_agent_id     TEXT NOT NULL,
          owner_session_ref TEXT,
          root_agent_ref    TEXT,
          provision_key     TEXT,
          provision_request_json TEXT CHECK (provision_request_json IS NULL OR json_valid(provision_request_json)),
          provision_state   TEXT NOT NULL DEFAULT 'ready' CHECK (provision_state IN ('ready','provisioning','failed')),
          lead_agent_id     TEXT,
          name              TEXT NOT NULL,
          status            TEXT NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
          version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (owner_session_ref) REFERENCES sessions(id) ON DELETE SET NULL,
          FOREIGN KEY (root_agent_ref) REFERENCES agent_nodes(id) ON DELETE SET NULL,
          FOREIGN KEY (lead_agent_id) REFERENCES agent_nodes(id) ON DELETE SET NULL
        );
        INSERT INTO teams_next
          (id, user_id, owner_session_id, root_agent_id, owner_session_ref,
           root_agent_ref, provision_key, provision_request_json, provision_state,
           lead_agent_id, name, status, version, created_at, updated_at)
        SELECT id, user_id, owner_session_id,
          COALESCE(root_agent_id, 'legacy-root:' || id), owner_session_ref,
          root_agent_ref, provision_key, provision_request_json, provision_state,
          lead_agent_id, name, status, version, created_at, updated_at
        FROM teams;
        DROP TABLE teams;
        ALTER TABLE teams_next RENAME TO teams;
        CREATE INDEX idx_teams_owner_updated
          ON teams(user_id, owner_session_id, updated_at DESC, id DESC);
        CREATE INDEX idx_teams_owner_session_fk ON teams(owner_session_id);
        CREATE INDEX idx_teams_lead_agent_fk ON teams(lead_agent_id);
        CREATE INDEX idx_teams_owner_session_ref_fk ON teams(owner_session_ref);
        CREATE INDEX idx_teams_root_agent_ref_fk ON teams(root_agent_ref);
        CREATE UNIQUE INDEX idx_teams_provision_operation
          ON teams(user_id, owner_session_id, provision_key) WHERE provision_key IS NOT NULL;
        CREATE TRIGGER team_member_history_insert
        AFTER INSERT ON team_members
        BEGIN
          INSERT INTO team_member_history
            (member_id, team_id, user_id, session_id, agent_id, role, status,
             created_at, updated_at, removed_at)
          SELECT NEW.id, NEW.team_id, team.user_id, NEW.session_id, NEW.agent_id, NEW.role,
                 NEW.status, NEW.created_at, NEW.updated_at,
                 CASE WHEN NEW.status = 'removed' THEN NEW.updated_at ELSE NULL END
          FROM teams team WHERE team.id = NEW.team_id
          ON CONFLICT(member_id) DO UPDATE SET role = excluded.role, status = excluded.status,
            updated_at = excluded.updated_at, removed_at = excluded.removed_at;
        END;
        CREATE TRIGGER team_member_history_update
        AFTER UPDATE OF role, status, updated_at ON team_members
        BEGIN
          UPDATE team_member_history SET role = NEW.role, status = NEW.status,
            updated_at = NEW.updated_at,
            removed_at = CASE WHEN NEW.status = 'removed' THEN NEW.updated_at ELSE removed_at END
          WHERE member_id = NEW.id;
        END;
        CREATE TRIGGER team_member_history_delete
        BEFORE DELETE ON team_members
        BEGIN
          UPDATE team_member_history SET status = 'removed',
            updated_at = MAX(updated_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
            removed_at = COALESCE(removed_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
          WHERE member_id = OLD.id;
        END;
      `);
    }
    if (rebuildOutcomes) {
      db.exec(`
        CREATE TABLE team_turn_outcomes_next (
          task_id        TEXT PRIMARY KEY,
          user_id        TEXT NOT NULL,
          session_id     TEXT NOT NULL,
          turn_id        TEXT NOT NULL,
          task_lease_generation INTEGER NOT NULL CHECK (task_lease_generation >= 0),
          mail_claim_generation INTEGER NOT NULL CHECK (mail_claim_generation >= 1),
          status         TEXT NOT NULL CHECK (status IN ('completed','failed','interrupted','cancelled')),
          summary        TEXT NOT NULL,
          body_json      TEXT NOT NULL CHECK (json_valid(body_json)),
          artifacts_json TEXT NOT NULL CHECK (json_valid(artifacts_json)),
          model_cycles   INTEGER NOT NULL CHECK (model_cycles >= 0),
          tokens         INTEGER NOT NULL CHECK (tokens >= 0),
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES runtime_tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id, turn_id) REFERENCES agent_turns(session_id, id) ON DELETE CASCADE,
          UNIQUE (session_id, turn_id)
        );
        INSERT INTO team_turn_outcomes_next
          (task_id, user_id, session_id, turn_id, task_lease_generation,
           mail_claim_generation, status, summary, body_json, artifacts_json,
           model_cycles, tokens, created_at, updated_at)
        SELECT task_id, user_id, session_id, turn_id, task_lease_generation,
          mail_claim_generation, status, summary, body_json, artifacts_json,
          model_cycles, tokens, created_at, updated_at
        FROM team_turn_outcomes;
        DROP TABLE team_turn_outcomes;
        ALTER TABLE team_turn_outcomes_next RENAME TO team_turn_outcomes;
        CREATE INDEX idx_team_turn_outcomes_user
          ON team_turn_outcomes(user_id, updated_at DESC, task_id);
      `);
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) throw new Error("Team schema upgrade produced a foreign-key violation");
    db.exec("COMMIT;");
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {  }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

db.exec(`
CREATE TRIGGER IF NOT EXISTS timeline_note_agent_turn_bounds
AFTER INSERT ON timeline
WHEN NEW.turn_id IS NOT NULL
BEGIN
  UPDATE agent_turns SET
    start_seq = CASE WHEN start_seq IS NULL OR NEW.seq < start_seq THEN NEW.seq ELSE start_seq END,
    end_seq = CASE WHEN end_seq IS NULL OR NEW.seq > end_seq THEN NEW.seq ELSE end_seq END
  WHERE session_id = NEW.session_id AND id = NEW.turn_id;
END;
`);

try {
  db.exec(`ALTER TABLE ssh_targets ADD COLUMN key_protected INTEGER NOT NULL DEFAULT 0;`);
} catch {
}

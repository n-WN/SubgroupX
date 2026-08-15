import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, runInTransaction } from "./core.ts";
import {
  bumpOrchestrationActivityRevisionInTransaction,
  detachWorkflowTasksOwnedBySessionInTransaction,
} from "./orchestration.ts";
import { WORKSPACES_DIR } from "../config.ts";
import { isPendingMessageKind } from "../../../shared/src/protocol.ts";
import type {
  AgentTurn,
  AgentTurnStatus,
  SandboxMode,
  SandboxKind,
  ApprovalPolicy,
  SessionStatus,
  ThinkingLevel,
  TimelineItem,
  PendingMessage,
} from "../../../shared/src/protocol.ts";

export interface AutomationRow {
  id: string;
  user_id: string;
  session_id: string;
  name: string;
  prompt: string;
  interval_minutes: number;
  enabled: number;
  last_run_at: number | null;
  created_at: number;
}

export const automationDao = {
  create(row: AutomationRow): void {
    db.prepare(
      `INSERT INTO automations (id, user_id, session_id, name, prompt, interval_minutes, enabled, last_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.user_id,
      row.session_id,
      row.name,
      row.prompt,
      row.interval_minutes,
      row.enabled,
      row.last_run_at,
      row.created_at,
    );
  },
  listForUser(userId: string): AutomationRow[] {
    return db
      .prepare("SELECT * FROM automations WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as unknown as AutomationRow[];
  },
  byId(userId: string, id: string): AutomationRow | undefined {
    return db.prepare("SELECT * FROM automations WHERE id = ? AND user_id = ?").get(id, userId) as
      | AutomationRow
      | undefined;
  },
  setEnabled(userId: string, id: string, enabled: boolean): void {
    db.prepare("UPDATE automations SET enabled = ? WHERE id = ? AND user_id = ?").run(enabled ? 1 : 0, id, userId);
  },
  setLastRun(id: string, at: number): void {
    db.prepare("UPDATE automations SET last_run_at = ? WHERE id = ?").run(at, id);
  },
  delete(userId: string, id: string): void {
    db.prepare("DELETE FROM automations WHERE id = ? AND user_id = ?").run(id, userId);
  },
  listDue(now: number): AutomationRow[] {
    return db
      .prepare(
        `SELECT * FROM automations
         WHERE enabled = 1
           AND (last_run_at IS NULL OR last_run_at + interval_minutes * 60000 <= ?)`,
      )
      .all(now) as unknown as AutomationRow[];
  },
};

export interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  provider: string;
  model: string;
  sandbox_mode: SandboxMode;
  sandbox_kind: SandboxKind;
  sandbox_id: string | null;
  sandbox_target_id: string | null;
  e2b_snapshot_id: string | null;
  mode: string;
  skill_prompt: string | null;
  approval_policy: ApprovalPolicy;
  status: SessionStatus;
  thinking_level: ThinkingLevel;
  cwd: string;
  created_at: number;
  updated_at: number;
  connector_unconfined?: number | null;
  approved_tools?: string | null;
  team_provision_team_id?: string | null;
  team_provision_reservation_id?: string | null;
  team_provision_state?: "provisional" | "published" | null;
}

export interface SessionDeletionInvalidation {
  userId: string;
  sessionId: string;
  rootAgentId: string;
  revision: number;
}

export interface SessionDeletionLiveTask {
  userId: string;
  executionSessionId: string;
  rootAgentId: string;
  taskId: string;
}

export interface SessionDeletionEffects {
  runs: SessionDeletionInvalidation[];
  activities: Array<{ userId: string; revision: number }>;
  workflows: Array<{ userId: string; workflowId: string; version: number }>;
  teams: Array<{ userId: string; teamId: string; version: number }>;
  liveTasks: SessionDeletionLiveTask[];
}

export const SESSION_TITLE_MAX_CHARS = 120;
export const SESSION_TITLE_MAX_BYTES = SESSION_TITLE_MAX_CHARS * 4;
const SESSION_TITLE_SCAN_MAX_CODE_UNITS = 2_048;

const SESSION_SELECT_COLUMNS = `
  id, user_id, substr(title, 1, ${SESSION_TITLE_MAX_CHARS}) AS title,
  provider, model, sandbox_mode, sandbox_kind, sandbox_id, sandbox_target_id,
  e2b_snapshot_id, mode, skill_prompt, approval_policy, status, thinking_level, cwd,
  created_at, updated_at, connector_unconfined, approved_tools,
  team_provision_team_id, team_provision_reservation_id, team_provision_state`;

const TITLE_SEPARATOR = /[\p{Cc}\p{Cf}\p{Z}]/u;

export function normalizeSessionTitle(value: string, fallback = ""): string {
  const input = typeof value === "string" ? value : String(value ?? "");
  const prefix = input.length > SESSION_TITLE_SCAN_MAX_CODE_UNITS
    ? input.slice(0, SESSION_TITLE_SCAN_MAX_CODE_UNITS)
    : input;
  let title = "";
  let points = 0;
  let heldSpace = false;
  for (const scalar of prefix) {
    if (TITLE_SEPARATOR.test(scalar)) {
      heldSpace ||= points > 0;
      continue;
    }
    if (heldSpace && points < SESSION_TITLE_MAX_CHARS - 1) {
      title += " ";
      points += 1;
    }
    heldSpace = false;
    if (points >= SESSION_TITLE_MAX_CHARS) break;
    title += scalar;
    points += 1;
    if (points >= SESSION_TITLE_MAX_CHARS) break;
  }
  return title || fallback;
}

function settleTeamDeletionWork(sessionId: string, at: number): void {
  const rows = db.prepare(
    `SELECT task.id, task.user_id, task.status, task.version, task.lease_generation,
            mail.id AS mail_id, mail.status AS mail_status, mail.deadline_at,
            outcome.status AS outcome_status, outcome.summary AS outcome_summary,
            outcome.body_json AS outcome_body_json, outcome.artifacts_json AS outcome_artifacts_json,
            outcome.created_at AS outcome_created_at,
            EXISTS (
              SELECT 1 FROM teams owner_team
              WHERE owner_team.id = task.team_id
                AND (owner_team.owner_session_ref = ? OR owner_team.owner_session_id = ?)
            ) AS owner_deleted
     FROM runtime_tasks task
     JOIN team_mail mail ON mail.task_id = task.id AND mail.kind = 'work'
     LEFT JOIN team_turn_outcomes outcome ON outcome.task_id = task.id
     WHERE task.kind = 'team_turn' AND (
       task.session_id = ? OR task.owner_session_id = ? OR task.team_id IN (
         SELECT team.id FROM teams team
         WHERE team.owner_session_ref = ? OR team.owner_session_id = ?
       )
     )`,
  ).all(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId) as unknown as Array<{
    id: string;
    user_id: string;
    status: string;
    version: number;
    lease_generation: number;
    mail_id: string;
    mail_status: string;
    deadline_at: number;
    outcome_status: "completed" | "failed" | "interrupted" | "cancelled" | null;
    outcome_summary: string | null;
    outcome_body_json: string | null;
    outcome_artifacts_json: string | null;
    outcome_created_at: number | null;
    owner_deleted: number;
  }>;
  const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
  for (const row of rows) {
    const hasResult = Boolean(db.prepare("SELECT 1 FROM task_results WHERE task_id = ?").get(row.id));
    const fromOutcome = row.outcome_status !== null;
    const nextStatus = fromOutcome
      ? row.outcome_status === "completed" && Number(row.outcome_created_at) <= row.deadline_at
        ? "succeeded"
        : row.outcome_status === "failed"
          ? "failed"
          : row.outcome_status === "cancelled"
            ? "cancelled"
            : "interrupted"
      : row.owner_deleted === 1
        ? "cancelled"
        : row.status === "queued" || row.status === "cancel_requested"
        ? "cancelled"
        : "interrupted";
    if (!terminal.has(row.status)) {
      db.prepare(
        `UPDATE runtime_tasks SET status = ?, activity = NULL, wait_reason = NULL,
           lease_generation = lease_generation + 1, version = version + 1,
           updated_at = ?, settled_at = ? WHERE id = ?`,
      ).run(nextStatus, at, at, row.id);
    }
    if (!hasResult) {
      db.prepare(
        `INSERT INTO task_results
           (id, task_id, summary, body_json, artifacts_json, version, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
      ).run(
        `team_delete_${row.id}`,
        row.id,
        row.outcome_summary ?? (row.owner_deleted === 1
          ? "Team work was cancelled because the owner Session was deleted."
          : "Team work stopped because a member Session was deleted."),
        row.outcome_body_json ?? JSON.stringify({
          reason: row.owner_deleted === 1 ? "team_owner_session_deleted" : "session_deleted",
        }),
        row.outcome_artifacts_json ?? "[]",
        row.outcome_created_at ?? at,
      );
      db.prepare("UPDATE runtime_tasks SET version = version + 1, updated_at = ? WHERE id = ?")
        .run(at, row.id);
    }
    if (fromOutcome) {
      db.prepare(
        `UPDATE team_mail SET status = 'acknowledged', acknowledged_at = ?, claim_token = NULL,
           claim_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status IN ('queued','claimed')`,
      ).run(at, at, row.mail_id);
    } else {
      db.prepare(
        `UPDATE team_mail SET status = 'cancelled', claim_token = NULL,
           claim_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status IN ('queued','claimed')`,
      ).run(at, row.mail_id);
    }
  }
}

export const sessionDao = {
  create(row: SessionRow): void {
    const title = normalizeSessionTitle(row.title);
    if (!title) throw new Error("Session title must not be empty");
    db.prepare(
      `INSERT INTO sessions
         (id, user_id, title, provider, model, sandbox_mode, sandbox_kind, sandbox_id,
          sandbox_target_id, mode, skill_prompt, approval_policy, status, cwd,
          team_provision_team_id, team_provision_reservation_id, team_provision_state,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.user_id,
      title,
      row.provider,
      row.model,
      row.sandbox_mode,
      row.sandbox_kind,
      row.sandbox_id,
      row.sandbox_target_id,
      row.mode,
      row.skill_prompt ?? null,
      row.approval_policy,
      row.status,
      row.cwd,
      row.team_provision_team_id ?? null,
      row.team_provision_reservation_id ?? null,
      row.team_provision_state ?? null,
      row.created_at,
      row.updated_at,
    );
  },
  setSandboxId(id: string, sandboxId: string): void {
    db.prepare("UPDATE sessions SET sandbox_id = ? WHERE id = ?").run(sandboxId, id);
  },
  setConnectorUnconfined(id: string, v: boolean | null): void {
    db.prepare("UPDATE sessions SET connector_unconfined = ? WHERE id = ?").run(v == null ? null : v ? 1 : 0, id);
  },
  setSandboxBackend(id: string, kind: SandboxKind, targetId: string | null): void {
    db.prepare(
      "UPDATE sessions SET sandbox_kind = ?, sandbox_target_id = ?, sandbox_id = NULL, e2b_snapshot_id = NULL, updated_at = ? WHERE id = ?",
    ).run(kind, targetId, Date.now(), id);
  },
  setSnapshotId(id: string, snapshotId: string): void {
    db.prepare("UPDATE sessions SET e2b_snapshot_id = ? WHERE id = ?").run(snapshotId, id);
  },
  setTitle(id: string, title: string): { userId: string; activityRevision: number } | null {
    const normalized = normalizeSessionTitle(title);
    if (!normalized) throw new Error("Session title must not be empty");
    return runInTransaction(() => {
      const renamed = db.prepare(
        "UPDATE sessions SET title = ? WHERE id = ? RETURNING user_id",
      ).get(normalized, id) as { user_id: string } | undefined;
      if (!renamed) return null;
      return {
        userId: renamed.user_id,
        activityRevision: bumpOrchestrationActivityRevisionInTransaction(renamed.user_id, Date.now()),
      };
    });
  },
  setThinkingLevel(id: string, level: ThinkingLevel): void {
    db.prepare("UPDATE sessions SET thinking_level = ? WHERE id = ?").run(level, id);
  },
  setModel(id: string, provider: string, model: string): void {
    db.prepare("UPDATE sessions SET provider = ?, model = ?, updated_at = ? WHERE id = ?").run(provider, model, Date.now(), id);
  },
  setApprovalPolicy(id: string, policy: ApprovalPolicy): void {
    db.prepare("UPDATE sessions SET approval_policy = ? WHERE id = ?").run(policy, id);
  },
  setApprovedTools(id: string, names: string[]): void {
    db.prepare("UPDATE sessions SET approved_tools = ? WHERE id = ?").run(names.length ? JSON.stringify(names) : null, id);
  },
  byId(id: string): SessionRow | undefined {
    return db.prepare(`SELECT ${SESSION_SELECT_COLUMNS} FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  },
  listForUser(userId: string): SessionRow[] {
    return db
      .prepare(
        `SELECT ${SESSION_SELECT_COLUMNS} FROM sessions
         WHERE user_id = ? AND COALESCE(team_provision_state, 'published') = 'published'
         ORDER BY updated_at DESC`,
      )
      .all(userId) as unknown as SessionRow[];
  },
  listRunning(): SessionRow[] {
    return db.prepare(`SELECT ${SESSION_SELECT_COLUMNS} FROM sessions WHERE status = 'running'`).all() as unknown as SessionRow[];
  },
  setStatus(id: string, status: SessionStatus): void {
    db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  },
  touch(id: string): void {
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  },
  delete(id: string): SessionDeletionEffects {
    return runInTransaction(() => {
      const now = Date.now();
      const affectedLiveTasks = db.prepare(
        `WITH RECURSIVE deletion_task_ids(id) AS (
           SELECT t.id
           FROM runtime_tasks t
           WHERE t.owner_session_id = ?
           UNION
           SELECT t.id
           FROM workflows owner_workflow
           JOIN runtime_tasks t
             ON t.workflow_id = owner_workflow.id
            AND t.user_id = owner_workflow.user_id
           WHERE owner_workflow.owner_session_id = ?
           UNION
           SELECT child.id
           FROM runtime_tasks child
           JOIN deletion_task_ids parent ON parent.id = child.parent_task_id
         )
         SELECT
           t.user_id, t.session_id, a.root_agent_id, t.id
         FROM deletion_task_ids affected
         JOIN runtime_tasks t ON t.id = affected.id
         JOIN agent_nodes a ON a.id = t.agent_id AND a.user_id = t.user_id
         JOIN sessions execution_session
           ON execution_session.id = t.session_id
          AND execution_session.user_id = t.user_id
         WHERE t.session_id <> ?
           AND t.status IN ('starting', 'running', 'waiting', 'cancel_requested')`,
      ).all(id, id, id) as unknown as Array<{
        user_id: string;
        session_id: string;
        root_agent_id: string;
        id: string;
      }>;
      const affectedWorkflows = db.prepare(
        `SELECT w.id, w.user_id
         FROM workflows w
         JOIN agent_nodes controller ON controller.id = w.controller_agent_id
         WHERE controller.session_id = ? AND w.owner_session_id <> ?`,
      ).all(id, id) as unknown as Array<{ id: string; user_id: string }>;

      settleTeamDeletionWork(id, now);
      db.prepare(
        `UPDATE teams SET status = 'closed', owner_session_ref = NULL, root_agent_ref = NULL,
           provision_state = CASE WHEN provision_state = 'provisioning' THEN 'failed' ELSE provision_state END,
           lead_agent_id = CASE WHEN lead_agent_id IN (
             SELECT agent.id FROM agent_nodes agent WHERE agent.session_id = ?
           ) THEN NULL ELSE lead_agent_id END,
           version = version + 1, updated_at = ?
         WHERE owner_session_ref = ? OR owner_session_id = ?`,
      ).run(id, now, id, id);
      db.prepare(
        `UPDATE team_member_reservations
         SET status = 'reserved', cleanup_requested_at = COALESCE(cleanup_requested_at, ?),
             provision_claim_token = NULL, provision_claim_expires_at = NULL, updated_at = ?
         WHERE team_id IN (SELECT id FROM teams WHERE owner_session_id = ?)
           AND status <> 'cancelled'
           AND (status = 'reserved' OR team_id IN (
             SELECT id FROM teams WHERE owner_session_id = ? AND provision_state = 'failed'
           ))
           AND EXISTS (
             SELECT 1 FROM sessions provisioned
             WHERE provisioned.id = team_member_reservations.provisioned_session_id
               AND provisioned.user_id = team_member_reservations.user_id
           )`,
      ).run(now, now, id, id);
      db.prepare(
        `UPDATE team_member_reservations
         SET status = 'cancelled', cleanup_completed_at = ?,
             provision_claim_token = NULL, provision_claim_expires_at = NULL, updated_at = ?
         WHERE team_id IN (SELECT id FROM teams WHERE owner_session_id = ?)
           AND status <> 'cancelled'
           AND (status = 'reserved' OR team_id IN (
             SELECT id FROM teams WHERE owner_session_id = ? AND provision_state = 'failed'
           ))
           AND NOT EXISTS (
             SELECT 1 FROM sessions provisioned
             WHERE provisioned.id = team_member_reservations.provisioned_session_id
               AND provisioned.user_id = team_member_reservations.user_id
           )`,
      ).run(now, now, id, id);
      const affectedRoots = db.prepare(
        `SELECT root_agent_id, user_id, MAX(addressable) AS addressable FROM (
           SELECT a.root_agent_id, a.user_id,
             CASE WHEN a.purpose = 'addressable' THEN 1 ELSE 0 END AS addressable
           FROM agent_nodes a
           WHERE a.session_id = ? AND a.id <> a.root_agent_id
           UNION
           SELECT a.root_agent_id, a.user_id,
             CASE WHEN a.purpose = 'addressable' THEN 1 ELSE 0 END AS addressable
           FROM runtime_tasks t
           JOIN agent_nodes a ON a.id = t.agent_id AND a.user_id = t.user_id
           WHERE t.id IN (
             WITH RECURSIVE doomed(id) AS (
               SELECT task.id FROM runtime_tasks task
               WHERE task.session_id = ? OR task.owner_session_id = ?
               UNION
               SELECT child.id FROM runtime_tasks child JOIN doomed parent ON child.parent_task_id = parent.id
             )
             SELECT id FROM doomed
           )
           UNION
           SELECT a.root_agent_id, a.user_id,
             CASE WHEN a.purpose = 'addressable' THEN 1 ELSE 0 END AS addressable
           FROM workflows w
           JOIN runtime_tasks t ON t.workflow_id = w.id AND t.user_id = w.user_id
           JOIN agent_nodes a ON a.id = t.agent_id AND a.user_id = t.user_id
           WHERE w.owner_session_id = ?
         ) GROUP BY root_agent_id, user_id`,
      ).all(id, id, id, id) as unknown as Array<{
        root_agent_id: string;
        user_id: string;
        addressable: number;
      }>;
      const affectedTeams = db.prepare(
        `SELECT DISTINCT team_id, user_id FROM (
           SELECT member.team_id, team.user_id
           FROM team_members member JOIN teams team ON team.id = member.team_id
           WHERE member.session_id = ?
           UNION
           SELECT id AS team_id, user_id FROM teams WHERE owner_session_id = ?
           UNION
           SELECT task.team_id, task.user_id FROM runtime_tasks task
           WHERE task.team_id IS NOT NULL AND task.id IN (
             WITH RECURSIVE doomed(id) AS (
               SELECT seed.id FROM runtime_tasks seed
               WHERE seed.session_id = ? OR seed.owner_session_id = ?
               UNION
               SELECT child.id FROM runtime_tasks child JOIN doomed parent ON child.parent_task_id = parent.id
             )
             SELECT id FROM doomed
           )
           UNION
           SELECT team.id AS team_id, team.user_id
           FROM teams team
           JOIN agent_nodes lead ON lead.id = team.lead_agent_id
           WHERE lead.session_id = ? AND team.owner_session_id <> ?
         )`,
      ).all(id, id, id, id, id, id) as unknown as Array<{ team_id: string; user_id: string }>;

      db.prepare(
        `UPDATE team_mail SET status = 'cancelled', claim_token = NULL,
           claim_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE (
           target_session_id = ? OR source_session_id = ? OR task_id IN (
             WITH RECURSIVE doomed(id) AS (
               SELECT task.id FROM runtime_tasks task
               WHERE task.session_id = ? OR task.owner_session_id = ?
               UNION
               SELECT child.id FROM runtime_tasks child JOIN doomed parent ON child.parent_task_id = parent.id
             )
             SELECT id FROM doomed
           )
         ) AND status IN ('queued','claimed')`,
      ).run(now, id, id, id, id);

      detachWorkflowTasksOwnedBySessionInTransaction(id, now);
      db.prepare(
        `DELETE FROM runtime_tasks WHERE id IN (
           WITH RECURSIVE doomed(id) AS (
             SELECT task.id FROM runtime_tasks task
             WHERE task.session_id = ? OR task.owner_session_id = ?
             UNION
             SELECT child.id FROM runtime_tasks child JOIN doomed parent ON child.parent_task_id = parent.id
           )
           SELECT id FROM doomed
         )`,
      ).run(id, id);
      db.prepare(
        `UPDATE teams SET lead_agent_id = NULL
         WHERE lead_agent_id IN (SELECT agent.id FROM agent_nodes agent WHERE agent.session_id = ?)`,
      ).run(id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);

      const bump = db.prepare(
        `UPDATE agent_rosters
         SET revision = revision + 1,
             addressable_revision = addressable_revision + ?,
             updated_at = MAX(updated_at + 1, ?)
         WHERE root_agent_id = ? AND user_id = ?
         RETURNING addressable_revision`,
      );
      const invalidations: SessionDeletionInvalidation[] = [];
      const addressableUsers = new Set<string>();
      for (const root of affectedRoots) {
        const addressable = root.addressable === 1;
        if (addressable) addressableUsers.add(root.user_id);
        const changed = bump.get(
          addressable ? 1 : 0,
          now,
          root.root_agent_id,
          root.user_id,
        ) as { addressable_revision: number } | undefined;
        if (!changed || !addressable) continue;
        const surviving = db.prepare(
          `SELECT session_id FROM agent_nodes
           WHERE id = ? AND user_id = ? AND id = root_agent_id
             AND purpose = 'addressable'`,
        ).get(root.root_agent_id, root.user_id) as { session_id: string | null } | undefined;
        if (!surviving?.session_id) continue;
        invalidations.push({
          userId: root.user_id,
          sessionId: surviving.session_id,
          rootAgentId: root.root_agent_id,
          revision: Number(changed.addressable_revision),
        });
      }
      const workflowInvalidations = affectedWorkflows.flatMap((workflow) => {
        const changed = db.prepare(
          `UPDATE workflows
           SET version = version + 1, updated_at = MAX(updated_at + 1, ?)
           WHERE id = ? AND user_id = ? AND controller_agent_id IS NULL
           RETURNING version`,
        ).get(now, workflow.id, workflow.user_id) as { version: number } | undefined;
        return changed
          ? [{ userId: workflow.user_id, workflowId: workflow.id, version: Number(changed.version) }]
          : [];
      });
      const teamInvalidations = affectedTeams.flatMap((team) => {
        const changed = db.prepare(
          `UPDATE teams
           SET version = version + 1, updated_at = MAX(updated_at + 1, ?),
               status = CASE WHEN lead_agent_id IS NULL AND status = 'active' THEN 'paused' ELSE status END
           WHERE id = ? AND user_id = ?
           RETURNING version`,
        ).get(now, team.team_id, team.user_id) as { version: number } | undefined;
        return changed
          ? [{ userId: team.user_id, teamId: team.team_id, version: Number(changed.version) }]
          : [];
      });
      return {
        runs: invalidations,
        activities: [...addressableUsers].map((userId) => ({
          userId,
          revision: bumpOrchestrationActivityRevisionInTransaction(userId, now),
        })),
        workflows: workflowInvalidations,
        teams: teamInvalidations,
        liveTasks: affectedLiveTasks.map((task) => ({
          userId: task.user_id,
          executionSessionId: task.session_id,
          rootAgentId: task.root_agent_id,
          taskId: task.id,
        })),
      };
    });
  },
  selfToken(id: string): string | null {
    const read = () =>
      (db.prepare("SELECT self_token FROM sessions WHERE id = ?").get(id) as { self_token: string | null } | undefined)
        ?.self_token ?? null;
    const existing = read();
    if (existing) return existing;
    if (!this.byId(id)) return null;
    db.prepare("UPDATE sessions SET self_token = ? WHERE id = ? AND self_token IS NULL").run(
      crypto.randomBytes(18).toString("base64url"),
      id,
    );
    return read();
  },
  idBySelfToken(token: string): string | null {
    const row = db.prepare("SELECT id FROM sessions WHERE self_token = ?").get(token) as { id: string } | undefined;
    return row?.id ?? null;
  },
};

interface AgentTurnRow {
  session_id: string;
  id: string;
  status: AgentTurnStatus;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  start_seq: number | null;
  end_seq: number | null;
  provider: string;
  model: string;
  accepted_input: string | null;
  source: "user" | "team";
  team_task_id: string | null;
  team_task_lease_generation: number | null;
  team_mail_claim_generation: number | null;
}

const turnInfo = (row: AgentTurnRow): AgentTurn => ({
  id: row.id,
  sessionId: row.session_id,
  status: row.status,
  startedAt: row.started_at,
  ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
  ...(row.duration_ms == null ? {} : { durationMs: row.duration_ms }),
  ...(row.start_seq == null ? {} : { startSeq: row.start_seq }),
  ...(row.end_seq == null ? {} : { endSeq: row.end_seq }),
  provider: row.provider,
  model: row.model,
  source: row.source,
  ...(row.team_task_id === null ? {} : { teamTaskId: row.team_task_id }),
  ...(row.team_task_lease_generation === null
    ? {}
    : { teamTaskLeaseGeneration: Number(row.team_task_lease_generation) }),
  ...(row.team_mail_claim_generation === null
    ? {}
    : { teamMailClaimGeneration: Number(row.team_mail_claim_generation) }),
});

export const agentTurnDao = {
  start(input: Pick<AgentTurn, "id" | "sessionId" | "startedAt" | "provider" | "model" | "teamTaskId"
    | "teamTaskLeaseGeneration" | "teamMailClaimGeneration"> & {
    source?: AgentTurn["source"];
    acceptedInput?: string;
  }): void {
    db.prepare(
      `INSERT INTO agent_turns
         (session_id, id, status, started_at, completed_at, duration_ms, start_seq, end_seq,
          provider, model, accepted_input, source, team_task_id,
          team_task_lease_generation, team_mail_claim_generation)
       VALUES (?, ?, 'in_progress', ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.id,
      input.startedAt,
      input.provider,
      input.model,
      input.acceptedInput ?? null,
      input.source ?? "user",
      input.teamTaskId ?? null,
      input.teamTaskLeaseGeneration ?? null,
      input.teamMailClaimGeneration ?? null,
    );
  },
  complete(sessionId: string, id: string, status: Exclude<AgentTurnStatus, "in_progress">, completedAt: number): void {
    db.prepare(
      `UPDATE agent_turns
       SET status = ?, completed_at = ?, duration_ms = MAX(0, ? - started_at)
       WHERE session_id = ? AND id = ? AND status = 'in_progress'`,
    ).run(status, completedAt, completedAt, sessionId, id);
  },
  latestInProgress(sessionId: string): AgentTurn | null {
    const row = db.prepare(
      `SELECT * FROM agent_turns
       WHERE session_id = ? AND status = 'in_progress'
       ORDER BY started_at DESC LIMIT 1`,
    ).get(sessionId) as AgentTurnRow | undefined;
    return row ? turnInfo(row) : null;
  },
  latest(sessionId: string): AgentTurn | null {
    const row = db.prepare(
      `SELECT * FROM agent_turns
       WHERE session_id = ?
       ORDER BY started_at DESC LIMIT 1`,
    ).get(sessionId) as AgentTurnRow | undefined;
    return row ? turnInfo(row) : null;
  },
  byTeamTask(sessionId: string, teamTaskId: string): AgentTurn | null {
    const row = db.prepare(
      "SELECT * FROM agent_turns WHERE session_id = ? AND team_task_id = ?",
    ).get(sessionId, teamTaskId) as AgentTurnRow | undefined;
    return row ? turnInfo(row) : null;
  },
  acceptedInput(sessionId: string, id: string): string | null {
    const row = db.prepare(
      "SELECT accepted_input FROM agent_turns WHERE session_id = ? AND id = ?",
    ).get(sessionId, id) as { accepted_input: string | null } | undefined;
    return row?.accepted_input ?? null;
  },
  clearAcceptedInput(sessionId: string, id: string): void {
    db.prepare("UPDATE agent_turns SET accepted_input = NULL WHERE session_id = ? AND id = ?").run(sessionId, id);
  },
  listInProgress(): AgentTurn[] {
    return (db.prepare(
      "SELECT * FROM agent_turns WHERE status = 'in_progress' ORDER BY started_at ASC",
    ).all() as unknown as AgentTurnRow[]).map(turnInfo);
  },
  list(sessionId: string): AgentTurn[] {
    return (db.prepare(
      "SELECT * FROM agent_turns WHERE session_id = ? ORDER BY started_at ASC",
    ).all(sessionId) as unknown as AgentTurnRow[]).map(turnInfo);
  },
  truncateFrom(sessionId: string, seq: number): void {
    db.prepare(
      `UPDATE agent_turns
       SET status = 'interrupted',
           end_seq = (
             SELECT MAX(t.seq) FROM timeline t
             WHERE t.session_id = agent_turns.session_id
               AND t.turn_id = agent_turns.id
               AND t.seq < ?
           )
       WHERE session_id = ? AND start_seq < ? AND (end_seq IS NULL OR end_seq >= ?)`,
    ).run(seq, sessionId, seq, seq);
    db.prepare("DELETE FROM agent_turns WHERE session_id = ? AND start_seq >= ?").run(sessionId, seq);
  },
  copyPrefixInto(srcId: string, dstId: string, toSeq: number, forkedAt: number): void {
    db.prepare(
      `INSERT INTO agent_turns
         (session_id, id, status, started_at, completed_at, duration_ms, start_seq, end_seq,
          provider, model, accepted_input, source, team_task_id,
          team_task_lease_generation, team_mail_claim_generation)
       SELECT ?, id, status, started_at, completed_at, duration_ms, start_seq, end_seq, provider, model, NULL, source, NULL, NULL, NULL
       FROM agent_turns
       WHERE session_id = ? AND status != 'in_progress' AND end_seq IS NOT NULL AND end_seq <= ?`,
    ).run(dstId, srcId, toSeq);
    db.prepare(
      `INSERT INTO agent_turns
         (session_id, id, status, started_at, completed_at, duration_ms, start_seq, end_seq,
          provider, model, accepted_input, source, team_task_id,
          team_task_lease_generation, team_mail_claim_generation)
       SELECT ?, id, 'interrupted', started_at, ?, MAX(0, ? - started_at), start_seq,
              CASE WHEN end_seq IS NULL OR end_seq > ? THEN ? ELSE end_seq END,
              provider, model, NULL, source, NULL, NULL, NULL
       FROM agent_turns
       WHERE session_id = ? AND start_seq IS NOT NULL AND start_seq <= ?
         AND (status = 'in_progress' OR end_seq IS NULL OR end_seq > ?)`,
    ).run(dstId, forkedAt, forkedAt, toSeq, toSeq, srcId, toSeq, toSeq);
  },
};

export const timelineDao = {
  append(sessionId: string, item: TimelineItem, msgCut?: number): void {
    db.prepare("INSERT OR REPLACE INTO timeline (session_id, seq, turn_id, item_json, msg_cut) VALUES (?, ?, ?, ?, ?)").run(
      sessionId,
      item.seq,
      item.turnId ?? null,
      JSON.stringify(item),
      msgCut ?? null,
    );
  },
  list(sessionId: string): TimelineItem[] {
    const rows = db
      .prepare("SELECT item_json FROM timeline WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as { item_json: string }[];
    return rows.map((r) => JSON.parse(r.item_json) as TimelineItem);
  },
  atSeq(sessionId: string, seq: number): TimelineItem | undefined {
    const row = db.prepare(
      "SELECT item_json FROM timeline WHERE session_id = ? AND seq = ?",
    ).get(sessionId, seq) as { item_json: string } | undefined;
    return row ? JSON.parse(row.item_json) as TimelineItem : undefined;
  },
  maxSeq(sessionId: string): number {
    const row = db.prepare("SELECT MAX(seq) AS m FROM timeline WHERE session_id = ?").get(sessionId) as {
      m: number | null;
    };
    return row.m ?? 0;
  },
  listPage(
    sessionId: string,
    after: number,
    limit: number,
    maxBytes: number,
  ): { items: TimelineItem[]; total: number; hasMore: boolean } {
    const total = (
      db.prepare("SELECT COUNT(*) AS c FROM timeline WHERE session_id = ?").get(sessionId) as { c: number }
    ).c;
    const rows = db
      .prepare("SELECT item_json FROM timeline WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(sessionId, after, limit + 1) as { item_json: string }[];
    const items: TimelineItem[] = [];
    let bytes = 0;
    for (const r of rows.slice(0, limit)) {
      bytes += r.item_json.length;
      if (items.length > 0 && bytes > maxBytes) break;
      items.push(JSON.parse(r.item_json) as TimelineItem);
    }
    return { items, total, hasMore: items.length < rows.length };
  },
  msgCutAt(sessionId: string, seq: number): number | null {
    const row = db.prepare("SELECT msg_cut FROM timeline WHERE session_id = ? AND seq = ?").get(sessionId, seq) as
      | { msg_cut: number | null }
      | undefined;
    return row?.msg_cut ?? null;
  },
  latestCompactionSeq(sessionId: string): number {
    const row = db
      .prepare("SELECT MAX(seq) AS m FROM timeline WHERE session_id = ? AND json_extract(item_json, '$.kind') = 'compaction'")
      .get(sessionId) as { m: number | null };
    return row.m ?? 0;
  },
  kindAt(sessionId: string, seq: number): string | null {
    const row = db
      .prepare("SELECT json_extract(item_json, '$.kind') AS kind FROM timeline WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as { kind: string | null } | undefined;
    return row?.kind ?? null;
  },
  recentUserTexts(sessionId: string, limit: number): string[] {
    const bounded = Math.max(1, Math.min(8, Math.floor(limit)));
    const rows = db.prepare(
      `SELECT text FROM (
         SELECT seq, json_extract(item_json, '$.text') AS text
         FROM timeline
         WHERE session_id = ? AND json_extract(item_json, '$.kind') = 'user'
         ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`,
    ).all(sessionId, bounded) as { text: string | null }[];
    return rows.flatMap((row) => typeof row.text === "string" ? [row.text] : []);
  },
  truncateFrom(sessionId: string, seq: number): void {
    db.prepare("DELETE FROM timeline WHERE session_id = ? AND seq >= ?").run(sessionId, seq);
  },
  copyPrefixInto(srcId: string, dstId: string, toSeq: number): void {
    db.prepare(
      "INSERT INTO timeline (session_id, seq, turn_id, item_json, msg_cut) SELECT ?, seq, turn_id, item_json, msg_cut FROM timeline WHERE session_id = ? AND seq <= ?",
    ).run(dstId, srcId, toSeq);
  },
  remapCompactionId(sessionId: string, seq: number, newCompactionId: string): void {
    db.prepare(
      "UPDATE timeline SET item_json = json_set(item_json, '$.id', ?, '$.compactionId', ?) WHERE session_id = ? AND seq = ?",
    ).run(newCompactionId, newCompactionId, sessionId, seq);
  },
};

export interface RecapJobRow {
  session_id: string;
  turn_id: string;
  anchor_seq: number;
  due_at: number;
  contract_version: number;
  payload_json: string;
  created_at: number;
}

export const recapJobDao = {
  upsert(row: RecapJobRow): void {
    db.prepare(
      `INSERT INTO recap_jobs
         (session_id, turn_id, anchor_seq, due_at, contract_version, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         turn_id = excluded.turn_id,
         anchor_seq = excluded.anchor_seq,
         due_at = excluded.due_at,
         contract_version = excluded.contract_version,
         payload_json = excluded.payload_json,
         created_at = excluded.created_at`,
    ).run(
      row.session_id,
      row.turn_id,
      row.anchor_seq,
      row.due_at,
      row.contract_version,
      row.payload_json,
      row.created_at,
    );
  },
  get(sessionId: string): RecapJobRow | null {
    return (db.prepare("SELECT * FROM recap_jobs WHERE session_id = ?").get(sessionId) as RecapJobRow | undefined) ?? null;
  },
  delete(sessionId: string): void {
    db.prepare("DELETE FROM recap_jobs WHERE session_id = ?").run(sessionId);
  },
  deleteIfTurn(sessionId: string, turnId: string): boolean {
    return db.prepare("DELETE FROM recap_jobs WHERE session_id = ? AND turn_id = ?").run(sessionId, turnId).changes > 0;
  },
};

export const pendingMessageDao = {
  append(sessionId: string, row: Omit<PendingMessage, "ord">): number {
    if (!isPendingMessageKind(row.kind)) throw new TypeError("invalid pending message kind");
    const ord = this.nextOrd(sessionId);
    db.prepare(
      "INSERT INTO pending_messages (session_id, ord, id, kind, text, ts, consumed) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ).run(sessionId, ord, row.id, row.kind, row.text, row.ts);
    return ord;
  },
  nextOrd(sessionId: string): number {
    const r = db.prepare("SELECT MAX(ord) AS m FROM pending_messages WHERE session_id = ?").get(sessionId) as {
      m: number | null;
    };
    return (r.m ?? 0) + 1;
  },
  listPending(sessionId: string): PendingMessage[] {
    const rows = db
      .prepare("SELECT id, kind, text, ts, ord FROM pending_messages WHERE session_id = ? AND consumed = 0 ORDER BY ord ASC")
      .all(sessionId) as { id: string; kind: string; text: string; ts: number; ord: number }[];
    return rows.map((r) => {
      if (!isPendingMessageKind(r.kind)) throw new TypeError("invalid persisted pending message kind");
      return { id: r.id, kind: r.kind, text: r.text, ts: r.ts, ord: r.ord };
    });
  },
  isPending(sessionId: string, id: string): boolean {
    return Boolean(db.prepare(
      "SELECT 1 AS ok FROM pending_messages WHERE session_id = ? AND id = ? AND consumed = 0 LIMIT 1",
    ).get(sessionId, id));
  },
  byId(sessionId: string, id: string): PendingMessage | null {
    const r = db.prepare(
      "SELECT id, kind, text, ts, ord FROM pending_messages WHERE session_id = ? AND id = ? AND consumed = 0 LIMIT 1",
    ).get(sessionId, id) as { id: string; kind: string; text: string; ts: number; ord: number } | undefined;
    if (!r) return null;
    if (!isPendingMessageKind(r.kind)) throw new TypeError("invalid persisted pending message kind");
    return { id: r.id, kind: r.kind, text: r.text, ts: r.ts, ord: r.ord };
  },
  findUnconsumedSteerByText(sessionId: string, text: string): PendingMessage | null {
    const r = db
      .prepare(
        "SELECT id, kind, text, ts, ord FROM pending_messages WHERE session_id = ? AND consumed = 0 AND kind = 'steer' AND text = ? ORDER BY ord ASC LIMIT 1",
      )
      .get(sessionId, text) as { id: string; kind: string; text: string; ts: number; ord: number } | undefined;
    if (!r) return null;
    if (!isPendingMessageKind(r.kind)) throw new TypeError("invalid persisted pending message kind");
    return { id: r.id, kind: r.kind, text: r.text, ts: r.ts, ord: r.ord };
  },
  markConsumed(sessionId: string, id: string): boolean {
    return db.prepare(
      "UPDATE pending_messages SET consumed = 1 WHERE session_id = ? AND id = ? AND consumed = 0",
    ).run(sessionId, id).changes > 0;
  },
  deleteById(sessionId: string, id: string): boolean {
    const r = db.prepare("DELETE FROM pending_messages WHERE session_id = ? AND id = ? AND consumed = 0").run(sessionId, id);
    return r.changes > 0;
  },
  deleteAll(sessionId: string): number {
    return Number(db.prepare("DELETE FROM pending_messages WHERE session_id = ?").run(sessionId).changes);
  },
  setKindById(sessionId: string, id: string, kind: PendingMessage["kind"]): boolean {
    if (!isPendingMessageKind(kind)) throw new TypeError("invalid pending message kind");
    return db.prepare(
      "UPDATE pending_messages SET kind = ? WHERE session_id = ? AND id = ? AND consumed = 0 AND kind != ?",
    ).run(kind, sessionId, id, kind).changes > 0;
  },
  setTextById(sessionId: string, id: string, text: string): boolean {
    return db.prepare(
      "UPDATE pending_messages SET text = ? WHERE session_id = ? AND id = ? AND consumed = 0",
    ).run(text, sessionId, id).changes > 0;
  },
  reorderPending(sessionId: string, order: string[]): boolean {
    return runInTransaction(() => this.reorderPendingInTransaction(sessionId, order));
  },
  reorderPendingInTransaction(sessionId: string, order: string[]): boolean {
    const current = this.listPending(sessionId);
    if (current.length !== order.length) return false;
    const ids = new Set(current.map((r) => r.id));
    if (new Set(order).size !== order.length || !order.every((id) => ids.has(id))) return false;
    let ord = this.nextOrd(sessionId);
    const stmt = db.prepare("UPDATE pending_messages SET ord = ? WHERE session_id = ? AND id = ? AND consumed = 0");
    for (const id of order) stmt.run(ord++, sessionId, id);
    return true;
  },
  reclassifyPendingKind(
    sessionId: string,
    from: PendingMessage["kind"],
    to: PendingMessage["kind"],
  ): number {
    if (!isPendingMessageKind(from) || !isPendingMessageKind(to)) {
      throw new TypeError("invalid pending message kind");
    }
    return Number(db.prepare(
      "UPDATE pending_messages SET kind = ? WHERE session_id = ? AND kind = ? AND consumed = 0",
    ).run(to, sessionId, from).changes);
  },
};

export const uploadDao = {
  add(row: { id: string; user_id: string; session_id: string; rel_path: string; bytes: number }): void {
    db.prepare(
      "INSERT INTO uploads (id, user_id, session_id, rel_path, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(row.id, row.user_id, row.session_id, row.rel_path, row.bytes, Date.now());
  },
  totalBytesForUser(userId: string): number {
    const rows = db
      .prepare(
        `SELECT u.id AS id, u.session_id AS session_id, u.rel_path AS rel_path, u.bytes AS bytes,
                s.sandbox_kind AS sandbox_kind
           FROM uploads u
           JOIN sessions s ON s.id = u.session_id
          WHERE u.user_id = ?`,
      )
      .all(userId) as { id: string; session_id: string; rel_path: string; bytes: number; sandbox_kind: SandboxKind }[];
    let total = 0;
    const dead: string[] = [];
    for (const u of rows) {
      if (u.sandbox_kind !== "local") {
        total += u.bytes;
        continue;
      }
      const live = liveUploadBytes(userId, u.session_id, u.rel_path);
      if (live === null) {
        dead.push(u.id);
        continue;
      }
      total += Math.min(live, u.bytes);
    }
    if (dead.length > 0) {
      const del = db.prepare("DELETE FROM uploads WHERE id = ?");
      for (const id of dead) del.run(id);
    }
    return total;
  },
};

function liveUploadBytes(userId: string, sessionId: string, relPath: string): number | null {
  const root = path.join(WORKSPACES_DIR, userId, sessionId);
  const abs = path.resolve(root, relPath.replace(/^[/\\]+/, ""));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const st = fs.lstatSync(abs);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

export const messageDao = {
  list(sessionId: string): unknown[] {
    const rows = db
      .prepare("SELECT msg_json FROM messages WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as { msg_json: string }[];
    return rows.map((r) => JSON.parse(r.msg_json));
  },
  replaceAll(sessionId: string, messages: unknown[]): void {
    const tx = db.prepare("DELETE FROM messages WHERE session_id = ?");
    tx.run(sessionId);
    const ins = db.prepare("INSERT INTO messages (session_id, seq, msg_json) VALUES (?, ?, ?)");
    messages.forEach((m, i) => ins.run(sessionId, i, JSON.stringify(m)));
  },
};

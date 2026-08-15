import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(path.join(tmpdir(), "oiia-skill-lifecycle-"));
process.env.AGENT_WEB_SECRET = "skill-lifecycle-check-secret-32ch!";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "0";

const { sessionDao, userDao, skillDao, teamDao, agentNodeDao } = await import("../server/src/persistence/index.ts");
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { AgentSessionRuntime, InvalidStoredSkillError } = await import("../server/src/runtime/agent-session.ts");
const { sessionManager, InvalidSkillError } = await import("../server/src/runtime/manager.ts");
const { skillRegistry } = await import("../server/src/runtime/skill-registry.ts");
const { workspacePathFor } = await import("../server/src/runtime/sandbox.ts");

import type { CreateSessionInput } from "../server/src/runtime/manager.ts";
import type { SessionRow } from "../server/src/persistence/index.ts";

registerMockProvider();

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
function check(name: string, fn: () => void): void {
  try {
    fn();
    ok(name);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const NOW = Date.now();
const user = { id: "u_skill", email: "skill@test" };
userDao.create({ id: user.id, email: user.email, password_hash: "x", created_at: NOW });

const SKILL_ID = "skill_persona";
const PROMPT_A = "alpha-skill-body-9f1c";
const PROMPT_B = "bravo-skill-body-7a2d";
const WRAPPED_A = `<custom-skill>\n${PROMPT_A}\n</custom-skill>`;
const WRAPPED_B = `<custom-skill>\n${PROMPT_B}\n</custom-skill>`;
const CODING = skillRegistry.basePrompt(skillRegistry.resolveBuiltin("coding")!);

const base: CreateSessionInput = {
  provider: MOCK_PROVIDER,
  model: MOCK_MODEL_ID,
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
};

const promptOf = (sessionId: string): string => {
  const row = sessionDao.byId(sessionId);
  if (!row) throw new Error(`session ${sessionId} not found`);
  const rt = new AgentSessionRuntime(row);
  const prompt = (rt as unknown as { systemPrompt: string }).systemPrompt;
  rt.close();
  return prompt;
};

const snapshotOf = (sessionId: string): string | null => {
  const row = sessionDao.byId(sessionId);
  if (!row) throw new Error(`session ${sessionId} not found`);
  return row.skill_prompt;
};

const seedSkill = (id: string, name: string, prompt: string): void =>
  skillDao.create({ id, user_id: user.id, name, description: "", icon: "", prompt, created_at: NOW });

seedSkill(SKILL_ID, "Persona", PROMPT_A);

console.log("\n── Case 1: session snapshots the user skill's base prompt at creation ──");

const s1 = sessionManager.createSession(user, { ...base, mode: SKILL_ID });
check("session mode is the user skill id", () => assert.equal(s1.mode, SKILL_ID));
check("skill_prompt column stores the frozen wrapped snapshot", () =>
  assert.equal(snapshotOf(s1.id), WRAPPED_A),
);
check("composed system prompt wraps prompt A in <custom-skill>", () => {
  const p = promptOf(s1.id);
  assert.ok(p.includes(WRAPPED_A), "expected the wrapped custom-skill block for A");
});

console.log("\n── Case 2: editing the skill does NOT change an existing session ──");

skillDao.update(user.id, SKILL_ID, { name: "Persona", description: "", icon: "", prompt: PROMPT_B });
check("rebuilt runtime for the SAME session still composes A, not B", () => {
  const p = promptOf(s1.id);
  assert.ok(p.includes(PROMPT_A), "frozen snapshot A must survive the edit");
  assert.ok(!p.includes(PROMPT_B), "edited prompt B must NOT leak into the old session");
});

console.log("\n── Case 3: a NEW session created after the edit gets B ──");

const s2 = sessionManager.createSession(user, { ...base, mode: SKILL_ID });
check("new session snapshots the edited wrapped prompt B", () =>
  assert.equal(snapshotOf(s2.id), WRAPPED_B),
);
check("new session composes B and not the stale A", () => {
  const p = promptOf(s2.id);
  assert.ok(p.includes(WRAPPED_B), "new session must carry B");
  assert.ok(!p.includes(PROMPT_A), "new session must not carry the old A");
});

console.log("\n── Case 4: deleting the skill leaves existing sessions on their snapshot ──");

skillDao.delete(user.id, SKILL_ID);
check("skill row is gone", () => assert.equal(skillDao.byId(user.id, SKILL_ID), undefined));
check("deleted skill's old session still composes its frozen A", () => {
  assert.equal(snapshotOf(s1.id), WRAPPED_A);
  const p = promptOf(s1.id);
  assert.ok(p.includes(PROMPT_A), "snapshot A must persist after delete");
  assert.ok(!p.includes(CODING), "a deleted skill must NOT silently fall back to coding");
});

console.log("\n── Case 5: an explicit unresolvable mode is rejected; a missing mode is coding ──");

check("creating a session with an unknown explicit skill id throws InvalidSkillError", () =>
  assert.throws(
    () => sessionManager.createSession(user, { ...base, mode: "sk_does_not_exist" }),
    (e: unknown) => e instanceof InvalidSkillError,
  ),
);
check("a deleted skill id is unresolvable and also rejected for new sessions", () =>
  assert.throws(
    () => sessionManager.createSession(user, { ...base, mode: SKILL_ID }),
    (e: unknown) => e instanceof InvalidSkillError,
  ),
);

const sNull = sessionManager.createSession(user, base);
check("a missing mode resolves to coding", () => assert.equal(sNull.mode, "coding"));
check("a coding-by-default session stores no snapshot", () =>
  assert.equal(snapshotOf(sNull.id), null),
);

console.log("\n── Case 6: built-in sessions stay live-from-code (no snapshot) ──");

const s6 = sessionManager.createSession(user, { ...base, mode: "coding" });
check("built-in coding session has a null skill_prompt", () =>
  assert.equal(snapshotOf(s6.id), null),
);
check("built-in coding session composes the live coding prompt from code", () => {
  const p = promptOf(s6.id);
  assert.ok(p.includes(CODING), "coding session must embed the bundled coding prompt");
  assert.ok(!p.includes("<custom-skill>"), "a built-in must never wrap in <custom-skill>");
});

console.log("\n── Case 7: snapshot remains the resolved custom prompt across a concurrent delete ──");

const RACE_ID = "skill_race";
const RACE_PROMPT = "charlie-skill-body-3e5f";
const RACE_WRAPPED = `<custom-skill>\n${RACE_PROMPT}\n</custom-skill>`;
seedSkill(RACE_ID, "Race", RACE_PROMPT);

// A concurrent delete landing between two skill lookups would make a second query
// miss and silently freeze the coding prompt. Delete on the read so any re-query
// would miss; the create must still freeze the resolved custom prompt.
const realById = skillDao.byId;
let raceByIdCalls = 0;
skillDao.byId = (uid, id) => {
  raceByIdCalls++;
  const row = realById(uid, id);
  if (id === RACE_ID) skillDao.delete(user.id, RACE_ID);
  return row;
};
let raced: ReturnType<typeof sessionManager.createSession> | undefined;
try {
  raced = sessionManager.createSession(user, { ...base, mode: RACE_ID });
} finally {
  skillDao.byId = realById;
}

check("the delete-after-read stub was actually exercised", () =>
  assert.ok(raceByIdCalls > 0, "skillDao.byId must run through the patched reference, or the race is untested"),
);
check("createSession survived the delete-after-read", () =>
  assert.ok(raced, "the create must not throw when the skill is deleted after its read"),
);
check("the persisted snapshot is the wrapped CUSTOM prompt, never coding", () => {
  const stored = snapshotOf(raced!.id);
  assert.equal(stored, RACE_WRAPPED);
  assert.notEqual(stored, CODING);
});

// ── Team provisioning inherits the actor's frozen persona snapshot ──
// The reconciler provisions members through createTeamMemberSession; stub only the
// claim-validity gate so this exercises the real member-session persona construction
// and persistence path (persona from the actor row, not a re-resolve of its mode)
// while isolating reservation-claim mechanics. The reconciler/claim path itself is
// covered by check:agent-team.
const realClaim = teamDao.isActiveMemberProvisionClaim;
teamDao.isActiveMemberProvisionClaim = () => true;
const teamMemberFrom = (actorSessionId: string, title: string) =>
  sessionManager.createTeamMemberSession(user.id, actorSessionId, title, {
    teamId: "team_persona",
    reservationId: `res_${randomUUID()}`,
    sessionId: `s_member_${randomUUID()}`,
    generation: 1,
    claimToken: `tok_${randomUUID()}`,
  });

const T_SKILL = "skill_team_persona";
const T_PROMPT_A = "team-alpha-body-1b8e";
const T_PROMPT_B = "team-bravo-body-4c7a";
const T_WRAPPED_A = `<custom-skill>\n${T_PROMPT_A}\n</custom-skill>`;
seedSkill(T_SKILL, "Team Persona", T_PROMPT_A);
const actor = sessionManager.createSession(user, { ...base, mode: T_SKILL });

console.log("\n── Case 8: a team member inherits the actor's frozen snapshot ──");

const member1 = teamMemberFrom(actor.id, "Member one");
check("member's skill_prompt equals the actor's frozen snapshot", () =>
  assert.equal(snapshotOf(member1.id), snapshotOf(actor.id)),
);
check("member composes the actor's wrapped custom prompt", () => {
  const p = promptOf(member1.id);
  assert.ok(p.includes(T_WRAPPED_A), "member must carry the actor's wrapped A");
});

console.log("\n── Case 9: editing the actor's skill does NOT change a new team member ──");

skillDao.update(user.id, T_SKILL, { name: "Team Persona", description: "", icon: "", prompt: T_PROMPT_B });
const member2 = teamMemberFrom(actor.id, "Member two");
check("member inherits the actor's ORIGINAL snapshot, not the edited skill", () => {
  assert.equal(snapshotOf(member2.id), T_WRAPPED_A);
  const p = promptOf(member2.id);
  assert.ok(p.includes(T_PROMPT_A), "member must carry the actor's original A");
  assert.ok(!p.includes(T_PROMPT_B), "the edited B must NOT re-resolve into the member");
});

console.log("\n── Case 10: deleting the actor's skill still provisions a member on the snapshot ──");

skillDao.delete(user.id, T_SKILL);
check("skill row is gone", () => assert.equal(skillDao.byId(user.id, T_SKILL), undefined));
let member3: ReturnType<typeof teamMemberFrom> | undefined;
check("provisioning a new member does NOT throw InvalidSkillError after the delete", () => {
  member3 = teamMemberFrom(actor.id, "Member three");
});
check("the post-delete member still carries the actor's frozen snapshot, never coding", () => {
  assert.equal(snapshotOf(member3!.id), T_WRAPPED_A);
  const p = promptOf(member3!.id);
  assert.ok(p.includes(T_PROMPT_A), "snapshot A must survive the skill delete");
  assert.ok(!p.includes(CODING), "a deleted skill must NOT fall back to coding for a member");
});

console.log("\n── Case 11: a built-in actor's team member carries no snapshot ──");

const codingActor = sessionManager.createSession(user, { ...base, mode: "coding" });
const memberC = teamMemberFrom(codingActor.id, "Coding member");
check("built-in actor's member has a null skill_prompt", () =>
  assert.equal(snapshotOf(memberC.id), null),
);
check("built-in actor's member composes the live coding prompt", () => {
  const p = promptOf(memberC.id);
  assert.ok(p.includes(CODING), "member must embed the bundled coding prompt");
  assert.ok(!p.includes("<custom-skill>"), "a built-in member must never wrap in <custom-skill>");
});

console.log("\n── Case 11b: a corrupt actor cannot provision a member ──");

const corruptActorRow: SessionRow = {
  ...sessionDao.byId(actor.id)!,
  id: "s_corrupt_actor",
  mode: "sk_ghost_actor",
  skill_prompt: null,
};
sessionDao.create(corruptActorRow);
const beforeMembers = sessionDao.listForUser(user.id).length;
check("provisioning from a snapshot-less corrupt actor throws InvalidStoredSkillError", () =>
  assert.throws(
    () => teamMemberFrom(corruptActorRow.id, "Doomed member"),
    (e: unknown) => e instanceof InvalidStoredSkillError,
  ),
);
check("no member session is written for the corrupt actor", () =>
  assert.equal(sessionDao.listForUser(user.id).length, beforeMembers),
);

console.log("\n── Case 11c: a snapshot-bearing actor provisions even when its mode is unresolvable ──");

const LEGACY_SNAPSHOT = "<custom-skill>\nlegacy-frozen-body-2f9c\n</custom-skill>";
const legacyActorRow: SessionRow = {
  ...sessionDao.byId(actor.id)!,
  id: "s_legacy_actor",
  mode: "sk_ghost_legacy",
  skill_prompt: LEGACY_SNAPSHOT,
};
sessionDao.create(legacyActorRow);
let legacyMember: ReturnType<typeof teamMemberFrom> | undefined;
check("a snapshot-bearing actor with an unresolvable mode still provisions a member", () => {
  legacyMember = teamMemberFrom(legacyActorRow.id, "Legacy member");
});
check("the member inherits the actor's authoritative snapshot verbatim", () =>
  assert.equal(snapshotOf(legacyMember!.id), LEGACY_SNAPSHOT),
);

teamDao.isActiveMemberProvisionClaim = realClaim;

console.log("\n── Case 12: restore fails loudly on an unresolvable stored mode ──");

const probe = sessionManager.createSession(user, base);
const probeRow = sessionDao.byId(probe.id)!;

const corruptRow: SessionRow = { ...probeRow, id: "s_restore_corrupt", mode: "sk_ghost_restore", skill_prompt: null };
sessionDao.create(corruptRow);
check("a custom stored mode with a null snapshot throws InvalidStoredSkillError", () =>
  assert.throws(
    () => new AgentSessionRuntime(corruptRow),
    (e: unknown) => e instanceof InvalidStoredSkillError,
  ),
);

const builtinRow: SessionRow = { ...probeRow, id: "s_restore_builtin", mode: "coding", skill_prompt: null };
sessionDao.create(builtinRow);
check("a built-in stored mode with a null snapshot composes the live builtin", () => {
  const p = promptOf(builtinRow.id);
  assert.ok(p.includes(CODING), "builtin restore must embed the bundled coding prompt");
  assert.ok(!p.includes("<custom-skill>"), "a builtin restore must not wrap in <custom-skill>");
});

const RESTORE_SNAPSHOT = "<custom-skill>\nrestored-frozen-body-8d3f\n</custom-skill>";
const snapRow: SessionRow = { ...probeRow, id: "s_restore_snap", mode: "sk_ghost_restore2", skill_prompt: RESTORE_SNAPSHOT };
sessionDao.create(snapRow);
check("a stored snapshot is used verbatim even when the mode is unresolvable", () => {
  const p = promptOf(snapRow.id);
  assert.ok(p.includes(RESTORE_SNAPSHOT), "restore must use the frozen snapshot over the mode");
});

console.log("\n── Case 13: a corrupt stored mode throws BEFORE any construction side effect ──");

// status "running" makes the recovery transition a real side effect, so this locks the
// invariant that a corrupt row throws before recovery, createSandbox, and the agent-root
// create — none of those side effects may occur.
const NOEFFECT_ID = "s_restore_noeffect";
const noEffectRow: SessionRow = {
  ...probeRow,
  id: NOEFFECT_ID,
  mode: "sk_ghost_noeffect",
  skill_prompt: null,
  status: "running",
};
sessionDao.create(noEffectRow);

const rootBefore = agentNodeDao.rootBySession(user.id, NOEFFECT_ID);
const workspaceBefore = existsSync(workspacePathFor(user.id, NOEFFECT_ID));
const statusBefore = sessionDao.byId(NOEFFECT_ID)?.status;

check("constructing a corrupt row throws InvalidStoredSkillError", () =>
  assert.throws(
    () => new AgentSessionRuntime(noEffectRow),
    (e: unknown) => e instanceof InvalidStoredSkillError,
  ),
);
check("no agent root is created for the corrupt session", () => {
  assert.equal(rootBefore, undefined);
  assert.equal(agentNodeDao.rootBySession(user.id, NOEFFECT_ID), undefined);
});
check("no local workspace directory is created for the corrupt session", () => {
  assert.equal(workspaceBefore, false);
  assert.equal(existsSync(workspacePathFor(user.id, NOEFFECT_ID)), false);
});
check("the session status is unchanged (no recovery transition)", () => {
  assert.equal(statusBefore, "running");
  assert.equal(sessionDao.byId(NOEFFECT_ID)?.status, "running");
});

if (failed > 0) {
  console.error(`\n${failed} skill-lifecycle check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all skill-lifecycle checks passed");
process.exit(0);

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

process.env.AGENT_WEB_DATA_DIR = mkdtempSync(path.join(tmpdir(), "oiia-skill-api-"));
process.env.AGENT_WEB_SECRET = "skill-api-check-secret-32-chars!!";
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";
process.env.AGENT_WEB_SESSION_WARM_MS = "0";

const { userDao, skillDao } = await import("../server/src/persistence/index.ts");
const { issueToken } = await import("../server/src/identity/auth.ts");
const { createApiRouter } = await import("../server/src/http/api.ts");
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");

registerMockProvider();

let failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

const NOW = Date.now();
function makeUser(id: string): { id: string; token: string } {
  userDao.create({ id, email: `${id}@test`, password_hash: "x", created_at: NOW });
  return { id, token: issueToken({ id, email: `${id}@test` }) };
}
const alice = makeUser("u_alice");
const bob = makeUser("u_bob");
const carol = makeUser("u_carol");

const app = express();
// no outer express.json(): createApiRouter mounts its own at the 20mb production limit
app.use("/api", createApiRouter());
const server = app.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Reply = { status: number; body: { skill?: any; skills?: any[]; ok?: boolean; error?: string } };
async function call(
  method: string,
  route: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(opts.body);
  }
  const res = await fetch(`${base}${route}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

console.log("\n── No auth ──");
await check("GET /skills without a token is 401", async () => {
  const res = await call("GET", "/api/skills");
  assert.equal(res.status, 401);
});

console.log("\n── CRUD happy path ──");
let createdId = "";
await check("POST creates a user skill with a skill_ id and echoes its detail", async () => {
  const res = await call("POST", "/api/skills", {
    token: alice.token,
    body: { name: "Analyst", description: "does analysis", prompt: "You are an analyst.", icon: "search" },
  });
  assert.equal(res.status, 200);
  const skill = res.body.skill;
  assert.ok(String(skill.id).startsWith("skill_"), `id must start with skill_, got ${skill.id}`);
  assert.equal(skill.name, "Analyst");
  assert.equal(skill.description, "does analysis");
  assert.equal(skill.icon, "search");
  assert.equal(skill.prompt, "You are an analyst.");
  createdId = skill.id;
});

await check("GET lists only the user's skills as summaries (no built-ins, no prompt)", async () => {
  const res = await call("GET", "/api/skills", { token: alice.token });
  assert.equal(res.status, 200);
  const mine = res.body.skills!.find((s) => s.id === createdId);
  assert.ok(mine, "own skill must be in the list");
  assert.ok(res.body.skills!.every((s) => String(s.id).startsWith("skill_")), "no built-ins in the list");
  assert.equal(mine.prompt, undefined, "list is summaries; prompt is not included");
});

await check("GET /skills/:id returns the full detail including prompt", async () => {
  const res = await call("GET", `/api/skills/${createdId}`, { token: alice.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.skill.prompt, "You are an analyst.");
});

await check("PATCH updates only the given field and keeps the rest", async () => {
  const res = await call("PATCH", `/api/skills/${createdId}`, { token: alice.token, body: { name: "Analyst 2" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.skill.name, "Analyst 2");
  assert.equal(res.body.skill.prompt, "You are an analyst.");
});

await check("DELETE removes the skill", async () => {
  const del = await call("DELETE", `/api/skills/${createdId}`, { token: alice.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  const after = await call("GET", "/api/skills", { token: alice.token });
  assert.ok(!after.body.skills!.some((s) => s.id === createdId), "deleted skill must be gone");
});

console.log("\n── Cross-user isolation ──");
let aliceSkillId = "";
await check("a skill owned by A is invisible to B", async () => {
  const created = await call("POST", "/api/skills", { token: alice.token, body: { name: "Secret", prompt: "hidden body" } });
  assert.equal(created.status, 200);
  aliceSkillId = created.body.skill.id;
  const bList = await call("GET", "/api/skills", { token: bob.token });
  assert.ok(!bList.body.skills!.some((s) => s.id === aliceSkillId), "B must not see A's skill");
});
await check("B cannot PATCH A's skill (404)", async () => {
  const res = await call("PATCH", `/api/skills/${aliceSkillId}`, { token: bob.token, body: { name: "hijacked" } });
  assert.equal(res.status, 404);
});
await check("B cannot DELETE A's skill (404)", async () => {
  const res = await call("DELETE", `/api/skills/${aliceSkillId}`, { token: bob.token });
  assert.equal(res.status, 404);
});
await check("B cannot GET A's skill detail (404)", async () => {
  const res = await call("GET", `/api/skills/${aliceSkillId}`, { token: bob.token });
  assert.equal(res.status, 404);
});
await check("A's skill survives B's failed writes unchanged", async () => {
  const res = await call("GET", "/api/skills", { token: alice.token });
  const mine = res.body.skills!.find((s) => s.id === aliceSkillId);
  assert.ok(mine && mine.name === "Secret", "A's skill must be intact");
});

console.log("\n── Validation ──");
await check("empty (whitespace) name is rejected", async () => {
  const res = await call("POST", "/api/skills", { token: alice.token, body: { name: "   ", prompt: "ok" } });
  assert.equal(res.status, 400);
});
await check("whitespace-only prompt is rejected", async () => {
  const res = await call("POST", "/api/skills", { token: alice.token, body: { name: "Whitespace", prompt: "   " } });
  assert.equal(res.status, 400);
});
await check("prompt within UTF-16 length but over the 8000-byte budget is rejected", async () => {
  const prompt = "あ".repeat(3000); // 3000 UTF-16 units, 9000 UTF-8 bytes
  assert.ok(prompt.length <= 8000, "UTF-16 length must be under the limit");
  assert.ok(Buffer.byteLength(prompt, "utf8") > 8000, "byte length must exceed the budget");
  const res = await call("POST", "/api/skills", { token: alice.token, body: { name: "Multibyte", prompt } });
  assert.equal(res.status, 400);
});
await check("a non-string name (number) is rejected", async () => {
  const res = await call("POST", "/api/skills", { token: alice.token, body: { name: 42, prompt: "ok" } });
  assert.equal(res.status, 400);
});
await check("a non-string name (object) is rejected without coercing to [object Object]", async () => {
  const res = await call("POST", "/api/skills", { token: alice.token, body: { name: { evil: true }, prompt: "ok" } });
  assert.equal(res.status, 400);
});
await check("description over 500 chars is rejected and NOT silently stored truncated", async () => {
  const description = "d".repeat(501);
  const res = await call("POST", "/api/skills", { token: alice.token, body: { name: "DescOver", prompt: "ok", description } });
  assert.equal(res.status, 400);
  const list = await call("GET", "/api/skills", { token: alice.token });
  assert.ok(!list.body.skills!.some((s) => s.name === "DescOver"), "the rejected skill must not persist");
});
console.log("\n── Per-user cap ──");
await check("the 101st skill is rejected with the limit message", async () => {
  for (let i = 0; i < 100; i++) {
    skillDao.create({
      id: `skill_seed_${i}`,
      user_id: carol.id,
      name: `seed ${i}`,
      description: "",
      icon: "sparkles",
      prompt: "p",
      created_at: NOW + i,
    });
  }
  const res = await call("POST", "/api/skills", { token: carol.token, body: { name: "Overflow", prompt: "ok" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "skill limit reached (100 max)");
});

console.log("\n── Unknown mode through session creation ──");
await check("POST /sessions with an unknown explicit skill id is 400 unknown skill", async () => {
  const res = await call("POST", "/api/sessions", {
    token: alice.token,
    body: { provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, mode: "sk_does_not_exist" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "unknown skill");
});

console.log("\n── Explicit non-string mode is rejected with 400 ──");
const badModes: unknown[] = [42, { evil: true }, ["x"]];
for (const bad of badModes) {
  await check(`POST /sessions with a non-string mode (${JSON.stringify(bad)}) is 400`, async () => {
    const res = await call("POST", "/api/sessions", {
      token: alice.token,
      body: { provider: MOCK_PROVIDER, model: MOCK_MODEL_ID, mode: bad },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "mode must be a string");
  });
}

console.log("\n── Non-string icon is rejected ──");
await check("POST /skills with a non-string icon is 400", async () => {
  const res = await call("POST", "/api/skills", {
    token: alice.token,
    body: { name: "IconTypo", prompt: "ok", icon: 7 },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "icon must be a string");
});
await check("POST /skills with an unsupported icon is 400 (not silently coerced)", async () => {
  const res = await call("POST", "/api/skills", {
    token: alice.token,
    body: { name: "IconUnknown", prompt: "ok", icon: "not-a-real-icon" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "unsupported icon");
});

server.close();
if (failed > 0) {
  console.error(`\n${failed} skill-api check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all skill-api checks passed");
process.exit(0);

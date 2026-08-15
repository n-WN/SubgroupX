import crypto from "node:crypto";
import type express from "express";
import { skillDao, type SkillRow, type SkillSummaryRow } from "../../persistence/index.ts";
import { SKILL_ICON_KEYS, type SkillSummary, type SkillDetail, type UserSkillId } from "../../../../shared/src/protocol.ts";
import { type AuthedRequest, requireAuth } from "../route-helpers.ts";

function toSummary(row: SkillSummaryRow): SkillSummary {
  return {
    id: row.id as UserSkillId,
    name: row.name,
    description: row.description,
    icon: row.icon,
    createdAt: row.created_at,
  };
}

function toDetail(row: SkillRow): SkillDetail {
  return { ...toSummary(row), prompt: row.prompt };
}

interface SkillFields {
  name: string;
  description: string;
  icon: string;
  prompt: string;
}

// Type-check first, then reject anything over the limits (never truncate). For
// PATCH, an omitted field falls back to the stored value; for POST, `existing`
// is null so required fields are enforced.
function validateSkillBody(
  body: Record<string, unknown>,
  existing: SkillRow | null,
): { ok: true; fields: SkillFields } | { ok: false; error: string } {
  let name: string;
  if (body.name === undefined) {
    if (!existing) return { ok: false, error: "name required" };
    name = existing.name;
  } else if (typeof body.name !== "string") {
    return { ok: false, error: "name must be a string" };
  } else {
    name = body.name.trim();
    if (!name) return { ok: false, error: "name required" };
    if (name.length > 80) return { ok: false, error: "name too long (80 max)" };
  }

  let description: string;
  if (body.description === undefined) {
    description = existing ? existing.description : "";
  } else if (typeof body.description !== "string") {
    return { ok: false, error: "description must be a string" };
  } else {
    description = body.description.trim();
    if (description.length > 500) return { ok: false, error: "description too long (500 max)" };
  }

  let prompt: string;
  if (body.prompt === undefined) {
    if (!existing) return { ok: false, error: "prompt required" };
    prompt = existing.prompt;
  } else if (typeof body.prompt !== "string") {
    return { ok: false, error: "prompt must be a string" };
  } else {
    prompt = body.prompt;
    if (!prompt.trim()) return { ok: false, error: "prompt required" };
    if (Buffer.byteLength(prompt, "utf8") > 8000) return { ok: false, error: "prompt too long (8000 max)" };
  }

  let icon: string;
  if (body.icon === undefined) {
    icon = existing ? existing.icon : "sparkles";
  } else if (typeof body.icon !== "string") {
    return { ok: false, error: "icon must be a string" };
  } else {
    icon = (SKILL_ICON_KEYS as readonly string[]).includes(body.icon) ? body.icon : "sparkles";
  }

  return { ok: true, fields: { name, description, icon, prompt } };
}

const MAX_SKILLS_PER_USER = 100;

export function registerSkillRoutes(r: express.Router): void {
  r.get("/skills", requireAuth, (req: AuthedRequest, res) => {
    res.json({ skills: skillDao.listSummariesForUser(req.user!.id).map(toSummary) });
  });

  r.get("/skills/:id", requireAuth, (req: AuthedRequest, res) => {
    const row = skillDao.byId(req.user!.id, String(req.params.id));
    if (!row) {
      res.status(404).json({ error: "skill not found" });
      return;
    }
    res.json({ skill: toDetail(row) });
  });

  r.post("/skills", requireAuth, (req: AuthedRequest, res) => {
    if (skillDao.countForUser(req.user!.id) >= MAX_SKILLS_PER_USER) {
      res.status(400).json({ error: "skill limit reached (100 max)" });
      return;
    }
    const v = validateSkillBody(req.body ?? {}, null);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const row: SkillRow = {
      id: "skill_" + crypto.randomUUID(),
      user_id: req.user!.id,
      name: v.fields.name,
      description: v.fields.description,
      icon: v.fields.icon,
      prompt: v.fields.prompt,
      created_at: Date.now(),
    };
    skillDao.create(row);
    res.json({ skill: toDetail(row) });
  });

  r.patch("/skills/:id", requireAuth, (req: AuthedRequest, res) => {
    const existing = skillDao.byId(req.user!.id, String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "skill not found" });
      return;
    }
    const v = validateSkillBody(req.body ?? {}, existing);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    skillDao.update(req.user!.id, existing.id, {
      name: v.fields.name,
      description: v.fields.description,
      icon: v.fields.icon,
      prompt: v.fields.prompt,
    });
    res.json({ skill: toDetail({ ...existing, ...v.fields }) });
  });

  r.delete("/skills/:id", requireAuth, (req: AuthedRequest, res) => {
    const existing = skillDao.byId(req.user!.id, String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "skill not found" });
      return;
    }
    skillDao.delete(req.user!.id, existing.id);
    res.json({ ok: true });
  });
}

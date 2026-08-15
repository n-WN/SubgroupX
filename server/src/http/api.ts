import express from "express";
import { auditHttpMiddleware } from "../observability/audit-log.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerAccountRoutes } from "./routes/account.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerShareRoutes } from "./routes/share.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSkillRoutes } from "./routes/skills.ts";
import { registerAutomationRoutes } from "./routes/automations.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerOrchestrationRoutes } from "./routes/orchestration.ts";

export function createApiRouter(): express.Router {
  const r = express.Router();
  r.use(auditHttpMiddleware);
  r.use(express.json({ limit: "20mb" }));

  registerAuthRoutes(r);
  registerAccountRoutes(r);
  registerAdminRoutes(r);
  registerShareRoutes(r);
  registerSessionRoutes(r);
  registerSkillRoutes(r);
  registerOrchestrationRoutes(r);
  registerAutomationRoutes(r);
  registerFileRoutes(r);

  return r;
}

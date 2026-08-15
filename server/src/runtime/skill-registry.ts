import type { SessionMode, UserSkillId, BuiltinSessionMode } from "../../../shared/src/protocol.ts";
import { skillDao, type SkillRow } from "../persistence/index.ts";
import { loadPrompt } from "./prompt-loader.ts";

export interface SkillSpec {
  id: SessionMode;
  source: "builtin" | "user";
  isSecurity: boolean;
  appendCtfContract: boolean;
  promptText: string;
}

let CTF_CONTRACT = "";
try {
  CTF_CONTRACT = loadPrompt("ctf-contract");
} catch {
  CTF_CONTRACT = "";
}

function builtin(
  id: BuiltinSessionMode,
  isSecurity: boolean,
  appendCtfContract: boolean,
  promptText: string,
): SkillSpec {
  return { id, source: "builtin", isSecurity, appendCtfContract, promptText };
}

const BUILTIN_SPECS: SkillSpec[] = [
  builtin("coding", false, false, loadPrompt("coding")),
  builtin("bold", false, false, loadPrompt("bold")),
  builtin("pentest", true, true, loadPrompt("pentest")),
  builtin("exploit", true, true, loadPrompt("exploit")),
];

const BY_ID = new Map<string, SkillSpec>(BUILTIN_SPECS.map((spec) => [spec.id, spec]));

function rowToSpec(row: SkillRow): SkillSpec {
  return {
    id: row.id as UserSkillId,
    source: "user",
    isSecurity: false,
    appendCtfContract: false,
    promptText: row.prompt,
  };
}

export const skillRegistry = {
  resolve(userId: string, id: string): SkillSpec | undefined {
    const builtinSpec = BY_ID.get(id);
    if (builtinSpec) return builtinSpec;
    const row = skillDao.byId(userId, id);
    return row ? rowToSpec(row) : undefined;
  },
  resolveBuiltin(id: string): SkillSpec | undefined {
    return BY_ID.get(id);
  },
  basePrompt(spec: SkillSpec): string {
    if (spec.source === "builtin") {
      return spec.appendCtfContract && CTF_CONTRACT
        ? `${spec.promptText}\n\n---\n\n${CTF_CONTRACT}`
        : spec.promptText;
    }
    // Mark the custom persona as its own system-prompt section and escape look-alike custom-skill delimiters. Not a security boundary.
    const safe = spec.promptText.replace(/<(\/?)(custom-skill)/gi, "&lt;$1$2");
    return `<custom-skill>\n${safe}\n</custom-skill>`;
  },
};

import { Bug, Code2, Rocket, ShieldCheck, ShieldHalf, Zap } from "lucide-react";
import type { BuiltinSessionMode } from "@shared/protocol";
import type { TranslationKey } from "../../../i18n/en";
import type { LucideIcon } from "./skill-icons.ts";

// The four built-in personas, in display order. The Skills manager and the New Session
// mode picker show the same personas but with their own icon and copy, so each row
// carries both: `skill*` fields drive the Skills manager, `mode*` fields drive the picker.
export interface BuiltinPersona {
  id: BuiltinSessionMode;
  skillIcon: LucideIcon;
  modeIcon: LucideIcon;
  nameKey: TranslationKey;
  descKey: TranslationKey;
  caps: [TranslationKey, TranslationKey, TranslationKey];
  modeLabelKey: TranslationKey;
  modeDescKey: TranslationKey;
}

export const BUILTIN_PERSONAS: readonly BuiltinPersona[] = [
  {
    id: "coding",
    skillIcon: Code2,
    modeIcon: Code2,
    nameKey: "skills.coding.name",
    descKey: "skills.coding.desc",
    caps: ["skills.cap.edit", "skills.cap.shell", "skills.cap.subagent"],
    modeLabelKey: "ns.modeCoding",
    modeDescKey: "ns.modeCodingHelp",
  },
  {
    id: "bold",
    skillIcon: Zap,
    modeIcon: Rocket,
    nameKey: "skills.bold.name",
    descKey: "skills.bold.desc",
    caps: ["skills.cap.proactive", "skills.cap.allTools", "skills.cap.terse"],
    modeLabelKey: "ns.modeBold",
    modeDescKey: "ns.modeBoldCardHelp",
  },
  {
    id: "pentest",
    skillIcon: ShieldHalf,
    modeIcon: ShieldCheck,
    nameKey: "skills.pentest.name",
    descKey: "skills.pentest.desc",
    caps: ["skills.cap.recon", "skills.cap.e2b", "skills.cap.authorized"],
    modeLabelKey: "ns.modePentest",
    modeDescKey: "ns.modePentestCardHelp",
  },
  {
    id: "exploit",
    skillIcon: Bug,
    modeIcon: Bug,
    nameKey: "skills.exploit.name",
    descKey: "skills.exploit.desc",
    caps: ["skills.cap.reversing", "skills.cap.wasm", "skills.cap.reason"],
    modeLabelKey: "ns.modeExploit",
    modeDescKey: "ns.modeExploitCardHelp",
  },
];

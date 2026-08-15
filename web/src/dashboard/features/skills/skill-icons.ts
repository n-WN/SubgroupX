import {
  Code2,
  Zap,
  ShieldHalf,
  Bug,
  Sparkles,
  Wrench,
  Terminal,
  BookOpen,
  FlaskConical,
  Bot,
  Cpu,
  Search,
} from "lucide-react";
import { SKILL_ICON_KEYS, type SkillIconKey } from "@shared/protocol";

import type { LucideIcon } from "lucide-react";
export type { LucideIcon };

export const USER_ICONS: Record<SkillIconKey, LucideIcon> = {
  "code-2": Code2,
  zap: Zap,
  "shield-half": ShieldHalf,
  bug: Bug,
  sparkles: Sparkles,
  wrench: Wrench,
  terminal: Terminal,
  "book-open": BookOpen,
  "flask-conical": FlaskConical,
  bot: Bot,
  cpu: Cpu,
  search: Search,
};

export function userIcon(key: string): LucideIcon {
  return (USER_ICONS as Record<string, LucideIcon | undefined>)[key] ?? Sparkles;
}

export function normalizeIconKey(key: string): SkillIconKey {
  return (SKILL_ICON_KEYS as readonly string[]).includes(key) ? (key as SkillIconKey) : "sparkles";
}

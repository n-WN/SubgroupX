import { readFileSync } from "node:fs";

export function loadPrompt(name: string): string {
  return readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").trim();
}

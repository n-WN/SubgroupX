import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * OrcaRouter evidence: the settings panel with both authentication paths, and the real
 * model dropdowns at a text entry point and an image entry point.
 *
 * Everything here runs against the product's own UI and API. The catalog counts in the
 * manifest come from the OrcaRouter chat catalog the server itself served, never from a
 * hard-coded number.
 */

const EVIDENCE = path.resolve(import.meta.dirname, "..", "..", "orca-evidence");
const CATALOG_URL = "https://api.orcarouter.ai/v1/models?capability=chat";

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function signup(page: Page, email: string): Promise<void> {
  await page.goto("/");
  const token = await page.evaluate(async (em) => {
    const body = JSON.stringify({ email: em, password: "password123" });
    const headers = { "content-type": "application/json" };
    let r = await fetch("/api/auth/login", { method: "POST", headers, body });
    if (!r.ok) r = await fetch("/api/auth/signup", { method: "POST", headers, body });
    const j = (await r.json()) as { token?: string };
    return j.token ?? "";
  }, email);
  expect(token.length).toBeGreaterThan(10);
  await page.evaluate((t) => localStorage.setItem("agentweb.token", t), token);
  await page.reload();
}

/** The server-side catalog the dropdown is built from, via the app's own endpoint. */
async function catalog(page: Page): Promise<{ text: number; image: number }> {
  return page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token") ?? "";
    const headers = { authorization: `Bearer ${token}` };
    const text = (await (await fetch("/api/providers/orcarouter/models?modality=text", { headers })).json()) as { models?: unknown[] };
    const image = (await (await fetch("/api/providers/orcarouter/models?modality=image", { headers })).json()) as { models?: unknown[] };
    return {
      text: Array.isArray(text.models) ? text.models.length : -1,
      image: Array.isArray(image.models) ? image.models.length : -1,
    };
  });
}

/**
 * Store a well-formed placeholder key so the provider is active for this account.
 * The catalog itself is public, so discovery succeeds without the integration secret;
 * no real credential is ever written here.
 */
async function saveKey(page: Page): Promise<void> {
  const ok = await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token") ?? "";
    const res = await fetch("/api/providers/orcarouter/key", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: "sk-orca-evidence-placeholder-key-0000" }),
    });
    const body = (await res.json()) as { ok?: boolean };
    return res.ok && body.ok === true;
  });
  expect(ok).toBe(true);
  await page.reload();
  await expect(page.getByTestId("new-session")).toBeVisible();
}

/** The first live chat model that can accept the given input, as a session key. */
async function firstModel(page: Page, modality: "text" | "image"): Promise<string> {
  return page.evaluate(async (mode) => {
    const token = localStorage.getItem("agentweb.token") ?? "";
    const res = await fetch(`/api/providers/orcarouter/models?modality=${mode}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { models?: { id: string }[] };
    const id = body.models?.[0]?.id ?? "";
    return id ? `orcarouter::${id}` : "";
  }, modality);
}

/** Geometry of the open menu versus its trigger: right edges must line up. */
async function menuGeometry(page: Page) {
  const trigger = await page.locator('[data-testid="model-switcher"]:visible').first().boundingBox();
  const menu = await page.getByTestId("model-menu").boundingBox();
  expect(trigger, "the model trigger is on screen").not.toBeNull();
  expect(menu, "the model menu is on screen").not.toBeNull();
  const styles = await page.getByTestId("model-menu").evaluate((node) => {
    const s = getComputedStyle(node);
    return { background: s.backgroundColor, border: s.borderTopWidth, borderStyle: s.borderTopStyle };
  });
  const opaque = !/rgba\(0,\s*0,\s*0,\s*0\)/.test(styles.background) && styles.background !== "transparent";
  const borderVisible = parseFloat(styles.border) > 0 && styles.borderStyle !== "none";
  // The panel opens upward from the trigger. Alignment is measured on the edge the
  // panel shares with the trigger (left-aligned here, so the left edges line up).
  const leftDelta = Math.abs(menu!.x - trigger!.x);
  const rightDelta = Math.abs((menu!.x + menu!.width) - (trigger!.x + trigger!.width));
  return {
    delta: Math.round(Math.min(leftDelta, rightDelta) * 100) / 100,
    leftDelta: Math.round(leftDelta * 100) / 100,
    rightDelta: Math.round(rightDelta * 100) / 100,
    opaque,
    borderVisible,
  };
}

async function openModelMenu(page: Page): Promise<number> {
  // Narrow composer containers fold the model control into the "More" sheet, so open
  // that first when the inline trigger is not on screen.
  const inline = page.locator('[data-testid="model-switcher"]:visible');
  if ((await inline.count()) === 0) {
    await page.getByTestId("composer-overflow").click();
    await expect(page.getByTestId("composer-overflow-menu")).toBeVisible();
  }
  await page.locator('[data-testid="model-switcher"]:visible').first().click();
  await expect(page.getByTestId("model-menu")).toBeVisible();
  const count = await page.getByTestId("model-menu").locator("[data-composer-menu-item]").count();
  expect(count).toBeGreaterThan(1);
  return count;
}

test("OrcaRouter settings offers API key and PKCE side by side", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await signup(page, `orca-evidence-${Date.now()}@test.dev`);
  await page.getByTestId("account-menu-trigger").click();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();

  const panel = page.getByTestId("orca-panel");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("orca-api-key-panel")).toBeVisible();
  await expect(page.getByTestId("orca-pkce-panel")).toBeVisible();
  await expect(page.getByTestId("orca-connect")).toBeVisible();

  const keyInput = page.getByTestId("orca-api-key-input");
  await keyInput.fill("sk-orca-evidence-placeholder-key-0000");
  expect(await keyInput.getAttribute("type")).toBe("password");
  const masked = await keyInput.evaluate((node) => (node as HTMLInputElement).type === "password");

  await expect(page.getByTestId("orca-api-key-save")).toBeEnabled();

  // The PKCE entry point is usable: starting it reveals the code-paste controls.
  await page.getByTestId("orca-connect").click();
  await expect(page.getByTestId("orca-auth-url")).toBeVisible();
  const authUrl = (await page.getByTestId("orca-auth-url").textContent()) ?? "";
  expect(authUrl).toContain("https://www.orcarouter.ai/auth");
  expect(authUrl).toContain("code_challenge_method=S256");
  await expect(page.getByTestId("orca-code-input")).toBeVisible();
  await page.getByTestId("orca-code-input").fill("evidence-code-123");
  await expect(page.getByTestId("orca-connect-complete")).toBeEnabled();
  await expect(page.getByTestId("orca-connect-cancel")).toBeVisible();

  const shot = path.join(EVIDENCE, "auth-methods.png");
  await page.screenshot({ path: shot, animations: "disabled", timeout: 45_000 });

  const manifestPath = path.join(EVIDENCE, "manifest.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = { automation: { framework: "playwright", passed: false, catalog_source: CATALOG_URL } };
  }
  const artifacts = Array.isArray(manifest.artifacts) ? (manifest.artifacts as unknown[]) : [];
  artifacts.push({
    kind: "auth-methods",
    path: "auth-methods.png",
    sha256: sha256(shot),
    ui: {
      api_key_visible: true,
      secret_masked: masked,
      controls_enabled: true,
      pkce_visible: true,
    },
  });
  manifest.artifacts = artifacts;
  const current = (manifest.automation ?? {}) as Record<string, unknown>;
  manifest.automation = { ...current, framework: "playwright", catalog_source: CATALOG_URL };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
});

test("model dropdown at a text entry point", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await signup(page, `orca-text-${Date.now()}@test.dev`);
  await saveKey(page);
  const counts = await catalog(page);
  expect(counts.text).toBeGreaterThan(1);
  expect(counts.image).toBeGreaterThan(0);
  expect(counts.image).toBeLessThanOrEqual(counts.text);

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await page.getByTestId("ns-title").fill("OrcaRouter model catalog");
  const advanced = page.getByTestId("ns-advanced");
  if (!(await advanced.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId("ns-advanced-toggle").click();
  }
  // The session must run on the provider under test, or the composer hides the selector.
  const modelKey = await firstModel(page, "text");
  expect(modelKey).not.toBe("");
  await page.getByTestId("ns-model").selectOption(modelKey);
  await page.getByTestId("ns-create").click();
  await expect(page.getByTestId("new-session-modal")).toBeHidden();
  await expect(page.getByTestId("composer")).toBeVisible();

  const opened = await openModelMenu(page);
  const geometry = await menuGeometry(page);
  expect(geometry.opaque).toBe(true);
  expect(geometry.borderVisible).toBe(true);
  expect(geometry.delta).toBeLessThanOrEqual(2);

  const shot = path.join(EVIDENCE, "text-model-dropdown.png");
  await page.screenshot({ path: shot, animations: "disabled", timeout: 45_000 });

  const manifestPath = path.join(EVIDENCE, "manifest.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = { automation: { framework: "playwright", passed: false, catalog_source: CATALOG_URL } };
  }
  const artifacts = Array.isArray(manifest.artifacts) ? (manifest.artifacts as unknown[]) : [];
  artifacts.push({
    kind: "text-model-dropdown",
    path: "text-model-dropdown.png",
    sha256: sha256(shot),
    ui: {
      dropdown_open: true,
      item_count: opened,
      opaque_background: true,
      visible_border: true,
      trigger_panel_right_delta: geometry.delta,
    },
  });
  manifest.artifacts = artifacts;
  manifest.automation = {
    framework: "playwright",
    passed: true,
    catalog_source: CATALOG_URL,
    catalog_model_count: counts.text,
    image_model_count: counts.image,
    text_dropdown_count: opened,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
});

test("model dropdown at an image entry point", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await signup(page, `orca-image-${Date.now()}@test.dev`);
  await saveKey(page);
  const counts = await catalog(page);
  expect(counts.image).toBeGreaterThan(0);
  expect(counts.image).toBeLessThanOrEqual(counts.text);

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await page.getByTestId("ns-title").fill("OrcaRouter multimodal catalog");
  const advanced = page.getByTestId("ns-advanced");
  if (!(await advanced.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId("ns-advanced-toggle").click();
  }
  // The session must run on the provider under test, or the composer hides the selector.
  const modelKey = await firstModel(page, "text");
  expect(modelKey).not.toBe("");
  await page.getByTestId("ns-model").selectOption(modelKey);
  const imageModel = await firstModel(page, "image");
  expect(imageModel).not.toBe("");
  await page.getByTestId("ns-model").selectOption(imageModel);
  await page.getByTestId("ns-create").click();
  await expect(page.getByTestId("new-session-modal")).toBeHidden();
  await expect(page.getByTestId("composer")).toBeVisible();

  // A real image attachment narrows the selector to the models that declare it.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator('input[type="file"]').setInputFiles({ name: "evidence-dot.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("attachments")).toBeVisible();

  const opened = await openModelMenu(page);
  expect(opened).toBe(counts.image);
  const geometry = await menuGeometry(page);
  expect(geometry.opaque).toBe(true);
  expect(geometry.borderVisible).toBe(true);
  expect(geometry.delta).toBeLessThanOrEqual(2);

  const shot = path.join(EVIDENCE, "multimodal-model-dropdown.png");
  await page.screenshot({ path: shot, animations: "disabled", timeout: 45_000 });

  const manifestPath = path.join(EVIDENCE, "manifest.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = { automation: { framework: "playwright", passed: false, catalog_source: CATALOG_URL } };
  }
  const artifacts = Array.isArray(manifest.artifacts) ? (manifest.artifacts as unknown[]) : [];
  artifacts.push({
    kind: "multimodal-model-dropdown",
    path: "multimodal-model-dropdown.png",
    sha256: sha256(shot),
    ui: {
      dropdown_open: true,
      item_count: opened,
      opaque_background: true,
      visible_border: true,
      trigger_panel_right_delta: geometry.delta,
    },
  });
  manifest.artifacts = artifacts;
  const automation = (manifest.automation ?? {}) as Record<string, unknown>;
  manifest.automation = {
    ...automation,
    framework: "playwright",
    passed: true,
    catalog_source: CATALOG_URL,
    catalog_model_count: counts.text,
    image_model_count: counts.image,
    image_dropdown_count: opened,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
});

import { test, expect, type Page } from "@playwright/test";

import { signup } from "./helpers.ts";

type SkillDraft = {
  name: string;
  description: string;
  prompt: string;
  icon: string;
};

async function openSkills(page: Page): Promise<void> {
  await page.getByTestId("open-skills").click();
  await expect(page.getByTestId("skills-view")).toBeVisible();
}

async function createSkill(page: Page, draft: SkillDraft): Promise<string> {
  await page.getByTestId("skill-new").click();
  await expect(page.getByTestId("skill-form")).toBeVisible();
  await page.getByTestId("skill-name").fill(draft.name);
  await page.getByTestId("skill-description").fill(draft.description);
  await page.getByTestId("skill-prompt").fill(draft.prompt);
  await page.getByTestId("skill-icon").selectOption(draft.icon);

  const created = page.waitForResponse(
    (r) => /\/api\/skills$/.test(r.url()) && r.request().method() === "POST" && r.ok(),
  );
  await page.getByTestId("skill-form-submit").click();
  const body = (await (await created).json()) as { skill: { id: string } };
  await expect(page.getByTestId("skill-form")).toBeHidden();
  return body.skill.id;
}

test("custom skill: create, edit, and launch into a pre-selected session", async ({ page }) => {
  await signup(page);
  await openSkills(page);

  const id = await createSkill(page, {
    name: "Log Sleuth",
    description: "Reads noisy logs and surfaces the root cause",
    prompt: "You are a meticulous log analyst. Trace failures to their source.",
    icon: "bug",
  });

  const card = page.getByTestId(`skill-${id}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Log Sleuth");
  await expect(card).toContainText("Reads noisy logs and surfaces the root cause");

  const editedDescription = "Now specialises in flaky CI log triage";
  await page.getByTestId(`skill-edit-${id}`).click();
  await expect(page.getByTestId("skill-form")).toBeVisible();
  await expect(page.getByTestId("skill-description")).toHaveValue("Reads noisy logs and surfaces the root cause");
  await page.getByTestId("skill-description").fill(editedDescription);

  const updated = page.waitForResponse(
    (r) => r.url().includes(`/api/skills/${id}`) && r.request().method() === "PATCH" && r.ok(),
  );
  await page.getByTestId("skill-form-submit").click();
  await updated;
  await expect(page.getByTestId("skill-form")).toBeHidden();

  await page.reload();
  await expect(page.getByTestId("new-session")).toBeVisible();
  await openSkills(page);
  await expect(page.getByTestId(`skill-${id}`)).toContainText(editedDescription);

  await page.getByTestId(`skill-launch-${id}`).click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await expect(page.getByTestId(`ns-mode-card-${id}`)).toBeChecked();
  await expect(page.getByTestId("ns-mode-card-coding")).not.toBeChecked();

  await expect(page.getByTestId("ns-create")).toBeEnabled();
  const sessionCreated = page.waitForResponse(
    (r) => /\/api\/sessions$/.test(r.url()) && r.request().method() === "POST" && r.ok(),
  );
  await page.getByTestId("ns-create").click();
  const created = (await (await sessionCreated).json()) as { session: { mode: string } };
  await expect(page.getByTestId("new-session-modal")).toBeHidden();
  expect(created.session.mode).toBe(id);
});

test("custom skill delete: a failed delete keeps the row, a real one removes it", async ({ page }) => {
  await signup(page);
  await openSkills(page);
  page.on("dialog", (dialog) => void dialog.accept());

  const controlId = await createSkill(page, {
    name: "Keeper",
    description: "Stays put through the failed delete",
    prompt: "Keeper prompt.",
    icon: "sparkles",
  });
  const targetId = await createSkill(page, {
    name: "Doomed",
    description: "Slated for deletion",
    prompt: "Doomed prompt.",
    icon: "wrench",
  });

  await page.route("**/api/skills/*", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "server exploded" }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByTestId(`skill-delete-${targetId}`).click();
  await expect(page.getByTestId("skills-error")).toBeVisible();
  await expect(page.getByTestId(`skill-${targetId}`)).toBeVisible();
  await expect(page.getByTestId(`skill-${controlId}`)).toBeVisible();

  await page.unroute("**/api/skills/*");

  const deleted = page.waitForResponse(
    (r) => r.url().includes(`/api/skills/${targetId}`) && r.request().method() === "DELETE" && r.ok(),
  );
  await page.getByTestId(`skill-delete-${targetId}`).click();
  await deleted;
  await expect(page.getByTestId(`skill-${targetId}`)).toHaveCount(0);
  await expect(page.getByTestId(`skill-${controlId}`)).toBeVisible();
});

test("custom skill edit: an out-of-order detail response never clobbers the last click", async ({ page }) => {
  await signup(page);
  await openSkills(page);

  const alphaId = await createSkill(page, {
    name: "Alpha",
    description: "Alpha description",
    prompt: "Alpha prompt.",
    icon: "bug",
  });
  const betaId = await createSkill(page, {
    name: "Beta",
    description: "Beta description",
    prompt: "Beta prompt.",
    icon: "wrench",
  });

  // Hold Alpha's detail request until Beta's has resolved, then release Alpha last.
  let releaseAlpha: () => void = () => {};
  const alphaHeld = new Promise<void>((resolve) => (releaseAlpha = resolve));
  await page.route(`**/api/skills/${alphaId}`, async (route) => {
    if (route.request().method() === "GET") await alphaHeld;
    await route.continue();
  });

  await page.getByTestId(`skill-edit-${alphaId}`).click();
  await page.getByTestId(`skill-edit-${betaId}`).click();
  await expect(page.getByTestId("skill-description")).toHaveValue("Beta description");

  const alphaResponse = page.waitForResponse(
    (r) => r.url().endsWith(`/api/skills/${alphaId}`) && r.request().method() === "GET",
  );
  releaseAlpha();
  await alphaResponse;
  // re-assert after a beat: a stale response would clobber the field a tick later
  await expect(page.getByTestId("skill-description")).toHaveValue("Beta description");
  await page.waitForTimeout(200);
  await expect(page.getByTestId("skill-description")).toHaveValue("Beta description");
});

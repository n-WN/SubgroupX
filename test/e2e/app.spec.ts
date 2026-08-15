import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

import { uniqueEmail, signup, signupViaUi, authViaApi, createSession, openSettings, openSessionAdvanced } from "./helpers.ts";
import { captureVisibleElement } from "../../scripts/view-preserving-screenshot.mjs";

async function sendMessage(page: Page, text: string) {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("send").click();
}

async function expectCircularComposerControl(page: Page, testId: string) {
  const control = page.getByTestId(testId);
  await expect(control).toBeVisible();
  const shape = await control.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { width: box.width, height: box.height, radius: Number.parseFloat(style.borderTopLeftRadius) };
  });
  expect(shape.width).toBeCloseTo(32, 0);
  expect(shape.height).toBeCloseTo(32, 0);
  expect(Math.abs(shape.width - shape.height)).toBeLessThanOrEqual(0.5);
  expect(shape.radius).toBeGreaterThanOrEqual(Math.min(shape.width, shape.height) / 2 - 0.5);
}

test("email verification keeps a non-enumerating escape path to existing sign-in methods", async ({ page }) => {
  const email = "person@outlook.com";
  await page.route("**/api/auth/signup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "PENDING_VERIFY",
        emailVerificationPending: true,
        pendingEmail: email,
        message: "Check your inbox if this address needs verification, or use its existing sign-in method.",
      }),
    });
  });
  await page.goto("/auth/signup");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("auth-submit").click();

  await expect(page).toHaveURL(/\/auth\/verify$/);
  await expect(page.getByText(`If this address needs verification, we sent a 6-digit code to ${email}.`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend available in 30s", exact: true })).toBeDisabled();
  await expect(page.getByTestId("verify-use-password")).toBeVisible();
  await expect(page.getByTestId("verify-use-github")).toBeVisible();

  await page.getByTestId("verify-use-password").click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByTestId("email")).toHaveValue(email);
});

test("a user who forgot their password can get back in from the sign-in page", async ({ page }) => {
  const email = "forgetful@outlook.com";
  const code = "424242";
  let sent = 0;
  await page.route("**/api/auth/forgot", async (route) => {
    sent++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/auth/reset", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { code?: string };
    if (body.code !== code) {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "That code is invalid or expired." }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state: "FULL_APP", token: "t_reset", user: { id: "u_reset", email, isAdmin: false, hasPassword: true } }),
    });
  });

  await page.goto("/auth/login");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("forgot-link").click();
  await expect(page).toHaveURL(/\/auth\/forgot$/);
  await expect(page.getByTestId("forgot-email")).toHaveValue(email);

  await page.getByTestId("forgot-send").click();
  await expect(page.getByText(`If ${email} has an account, a 6-digit code is on its way. It expires in 30 minutes.`)).toBeVisible();
  expect(sent).toBe(1);
  await expect(page.getByTestId("forgot-resend")).toBeDisabled();

  await page.getByTestId("forgot-code").fill("111111");
  await page.getByTestId("forgot-password").fill("brandnewpw1");
  await page.getByTestId("forgot-submit").click();
  await expect(page.getByTestId("forgot-error")).toHaveText("That code is invalid or expired.");

  await page.reload();
  await expect(page.getByTestId("forgot-have-code")).toBeDisabled();
  await page.getByTestId("forgot-email").fill(email);
  await page.getByTestId("forgot-have-code").click();
  await expect(page.getByText(`Type the 6-digit code sent to ${email}, then choose a new password.`)).toBeVisible();
  expect(sent).toBe(1);

  await page.getByTestId("forgot-code").fill(code);
  await page.getByTestId("forgot-password").fill("brandnewpw1");
  await page.getByTestId("forgot-submit").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("new-session")).toBeVisible();
});

test("a request that never reaches the server says so, instead of showing the browser's own words", async ({ page, browser }) => {
  await page.route("**/api/auth/login", (route) => route.abort("connectionfailed"));
  await page.goto("/auth/login");
  await page.getByTestId("email").fill("someone@outlook.com");
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("auth-submit").click();

  const error = page.getByTestId("auth-error");
  await expect(error).toHaveText("Couldn't reach the server. Check your connection and try again.");
  await expect(error).not.toContainText("Load failed");
  await expect(error).not.toContainText("Failed to fetch");
  await expect(page.getByTestId("auth-submit")).toBeEnabled();

  await page.unroute("**/api/auth/login");
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" }));
  await page.getByTestId("auth-submit").click();
  await expect(error).toHaveText("The server is briefly unavailable — try again in a moment.");
  await expect(error).not.toContainText("Bad Gateway");

  const zh = await browser.newContext({ locale: "zh-CN" });
  try {
    const zhPage = await zh.newPage();
    await zhPage.route("**/api/auth/login", (route) => route.abort("connectionfailed"));
    await zhPage.goto("/auth/login");
    await zhPage.getByTestId("email").fill("someone@outlook.com");
    await zhPage.getByTestId("password").fill("password123");
    await zhPage.getByTestId("auth-submit").click();
    await expect(zhPage.getByTestId("auth-error")).toHaveText("无法连接到服务器，请检查网络后重试。");
  } finally {
    await zh.close();
  }
});

function rangePdfFixture(withSecondPage = true, firstPageText = "PDF RANGE E2E"): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets: number[] = [0];
  let length = chunks[0].length;
  const object = (id: number, body: Buffer | string) => {
    offsets[id] = length;
    const head = Buffer.from(`${id} 0 obj\n`, "ascii");
    const data = typeof body === "string" ? Buffer.from(body, "ascii") : body;
    const tail = Buffer.from("\nendobj\n", "ascii");
    chunks.push(head, data, tail);
    length += head.length + data.length + tail.length;
  };
  object(1, withSecondPage
    ? "<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(second) [7 0 R /Fit]] >> >> >>"
    : "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, withSecondPage
    ? "<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>"
    : "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  const content = Buffer.from(`BT /F1 24 Tf 72 720 Td (${firstPageText}) Tj ET`, "ascii");
  object(4, Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"), content, Buffer.from("\nendstream", "ascii")]));
  object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const padding = Buffer.alloc(700 * 1024, 0x20);
  object(6, Buffer.concat([Buffer.from(`<< /Length ${padding.length} >>\nstream\n`, "ascii"), padding, Buffer.from("\nendstream", "ascii")]));
  if (withSecondPage) {
    object(7, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 8 0 R >>");
    const secondContent = Buffer.from("BT /F1 24 Tf 72 720 Td (PDF PAGE TWO) Tj ET", "ascii");
    object(8, Buffer.concat([Buffer.from(`<< /Length ${secondContent.length} >>\nstream\n`, "ascii"), secondContent, Buffer.from("\nendstream", "ascii")]));
  }
  const xref = length;
  const objectCount = withSecondPage ? 8 : 6;
  const rows = ["xref", `0 ${objectCount + 1}`, "0000000000 65535 f ", ...Array.from({ length: objectCount }, (_, index) => `${String(offsets[index + 1]).padStart(10, "0")} 00000 n `)];
  chunks.push(Buffer.from(`${rows.join("\n")}\ntrailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii"));
  return Buffer.concat(chunks);
}

async function openFilePanel(page: Page) {
  const fileTreeTab = page.getByRole("button", { name: "File Tree", exact: true });
  if (!(await fileTreeTab.isVisible().catch(() => false))) {
    await page.locator(".lucide-panel-right").click();
    await expect(fileTreeTab).toBeVisible();
  }
  await fileTreeTab.click();
}

test("full lifecycle: signup → session → agent writes a file (auto-approve)", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await signupViaUi(page);
  await createSession(page, { title: "Write test", approval: "never" });

  await sendMessage(page, "/write hello.txt\nHello from E2E!");

  const tool = page.getByTestId("tool-write_file");
  await expect(tool).toBeVisible();
  await expect(tool.getByTestId("tool-status")).toHaveText("success");

  await expect(page.getByTestId("msg-assistant").last()).toContainText("Done");

  await openFilePanel(page);
  await expect(page.getByTestId("file-hello.txt")).toBeVisible();
  await page.getByTestId("file-hello.txt").click();
  await expect(page.getByTestId("file-view")).toContainText("Hello from E2E!");
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await expect(page.getByTestId("file-hello.txt")).toBeVisible();
  const fileColumns = await page.getByTestId("file-workbench").evaluate((workbench) => {
    const browser = workbench.querySelector<HTMLElement>('[data-testid="file-browser"]');
    const document = workbench.querySelector<HTMLElement>('[data-testid="file-view"]');
    if (!browser || !document) throw new Error("file workspace columns missing");
    const browserBox = browser.getBoundingClientRect();
    const documentBox = document.getBoundingClientRect();
    return {
      browserWidth: Math.round(browserBox.width),
      documentWidth: Math.round(documentBox.width),
      seam: Math.round(documentBox.left - browserBox.right),
    };
  });
  expect(fileColumns.browserWidth).toBeGreaterThanOrEqual(184);
  expect(fileColumns.documentWidth).toBeGreaterThan(0);
  expect(Math.abs(fileColumns.seam)).toBeLessThanOrEqual(1);
});

test("tool file link: clicking a tool's path opens it in the file panel", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "File link", approval: "never" });

  await sendMessage(page, "/write linked.txt\nopened via the tool link");
  await expect(page.getByTestId("tool-write_file").getByTestId("tool-status")).toHaveText("success");

  await page.getByTestId("tool-write_file").getByTestId("tool-open").click();
  await page.getByTestId("tool-detail").getByTestId("tool-file-link").click();

  await expect(page.getByTestId("file-view")).toContainText("opened via the tool link");
});

test("MCP: an external MCP server's tool flows through the same tool timeline", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "MCP", approval: "never" });

  await sendMessage(page, "/mcp hello from e2e");

  const tool = page.getByTestId("tool-mcp__demo__echo");
  await expect(tool).toBeVisible();
  await expect(tool.getByTestId("tool-status")).toHaveText("success");
  await tool.getByTestId("tool-open").click();
  await expect(page.getByTestId("tool-detail").getByTestId("tool-result")).toContainText("echo: hello from e2e");
});

test("subagent / agent-team: delegate spawns a nested child agent sharing the workspace", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Team", approval: "never" });

  await sendMessage(page, "/subagent /write team.txt\nbuilt by a subagent");

  const sub = page.getByTestId("tool-spawn_subagent");
  await expect(sub).toBeVisible();
  await expect(sub.getByTestId("tool-status").first()).toHaveText("success");

  await sub.getByTestId("tool-open").click();
  await expect(page.getByTestId("subagent-timeline")).toBeVisible();
  await expect(page.getByTestId("subagent-timeline").getByTestId("tool-write_file")).toBeVisible();

  await openFilePanel(page);
  await expect(page.getByTestId("file-team.txt")).toBeVisible();
});

test("subagent timeline persists across a page reload", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "SubPersist", approval: "never" });

  await sendMessage(page, "/subagent /write sp.txt\nnested + persisted");
  await page.getByTestId("tool-spawn_subagent").getByTestId("tool-open").click();
  await expect(page.getByTestId("subagent-timeline").getByTestId("tool-write_file")).toBeVisible();

  await page.reload();

  await page.getByTestId("tool-spawn_subagent").getByTestId("tool-open").click();
  await expect(page.getByTestId("subagent-timeline").getByTestId("tool-write_file")).toBeVisible();
  await openFilePanel(page);
  await expect(page.getByTestId("file-sp.txt")).toBeVisible();
});

test("approval prompt is restored after a reload mid-approval (reconnect)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "PermReconnect", approval: "on-request" });

  await sendMessage(page, "/bash echo reconnected > rc.txt");
  await expect(page.getByTestId("permission")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("permission")).toBeVisible();

  await page.getByTestId("perm-approve").click();
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status").first()).toHaveText("success");
  await openFilePanel(page);
  await expect(page.getByTestId("file-rc.txt")).toBeVisible();
});

test("a permission prompt answers to the keyboard, without stealing the composer's keys", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Perm keys", approval: "on-request" });

  await sendMessage(page, "/bash echo keyed > keyed.txt");
  const perm = page.getByTestId("permission");
  await expect(perm).toBeVisible();
  await expect(page.getByTestId("perm-approve")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tool-bash").last().getByTestId("tool-status")).toHaveText("success");

  await sendMessage(page, "/bash echo denied > denied.txt");
  await expect(perm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(perm).toHaveCount(0);
  await expect(page.getByTestId("tool-bash").last().getByTestId("tool-status")).toHaveText("denied");

  await sendMessage(page, "/bash echo tabbed > tabbed.txt");
  await expect(perm).toBeVisible();
  await page.getByTestId("perm-deny").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tool-bash").last().getByTestId("tool-status")).toHaveText("denied");

  await page.getByTestId("composer").fill("still mine");
  await page.getByTestId("composer").press("Escape");
  await expect(page.getByTestId("composer")).toHaveValue("still mine");
});

test("approval flow: on-request gates bash; approve runs it", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Approve test", approval: "on-request" });

  await sendMessage(page, "/bash echo approved-by-user > result.txt");

  const perm = page.getByTestId("permission");
  await expect(perm).toBeVisible();
  await expect(perm.getByRole("heading")).toHaveText("Run this command?");
  const subject = perm.getByTestId("perm-summary");
  await expect(subject).toHaveText("echo approved-by-user > result.txt");
  expect(await subject.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono|Menlo|Consolas|Courier/i);
  const weight = await perm.evaluate((root) => {
    const seen = (id: string) => {
      const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      const style = getComputedStyle(el);
      return { bg: style.backgroundColor, color: style.color };
    };
    return { run: seen("perm-approve"), deny: seen("perm-deny"), session: seen("perm-approve-session") };
  });
  const isTransparent = (c: string) => /rgba\(0, 0, 0, 0\)|transparent/.test(c);
  expect(isTransparent(weight.run.bg), "the primary action should be a solid button").toBe(false);
  expect(isTransparent(weight.session.bg), "always-allow should not compete with the primary action").toBe(true);
  const approvalActivity = page.getByTestId("agent-activity-orb");
  await expect(approvalActivity).toHaveAttribute("data-orb-state", "listening");
  await expect(approvalActivity).toHaveAttribute("data-orb-paused", "true");
  const approvalCanvas = approvalActivity.locator("canvas");
  const approvalFrame = await approvalCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(160);
  expect(await approvalCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).toBe(approvalFrame);

  await page.getByTestId("perm-approve").click();

  const tool = page.getByTestId("tool-bash");
  await expect(tool.getByTestId("tool-status")).toHaveText("success");
  await openFilePanel(page);
  await expect(page.getByTestId("file-result.txt")).toBeVisible();
});

test("tool inspector preserves the raw command at approval, then formats after execution", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Command truth", approval: "on-request" });

  const command = `sleep 1.2; for part in "alpha beta" "gamma delta"; do echo "== $part =="; printf 'ok\\n'; done`;
  await sendMessage(page, `/bash ${command}`);
  await expect(page.getByTestId("permission")).toBeVisible();

  const tool = page.getByTestId("tool-bash");
  await tool.getByTestId("tool-open").click();
  const detailCommand = page.getByTestId("tool-detail").getByTestId("shell-command");
  await expect(detailCommand).toHaveAttribute("data-formatted", "false");
  await expect(detailCommand).toContainText(command);
  await expect(page.getByTestId("tool-detail")).toContainText("Awaiting approval");
  await expect(page.getByTestId("tool-output-pane")).toHaveCount(0);

  await page.getByTestId("perm-approve").click();
  await expect(page.getByTestId("tool-lifecycle")).toContainText("Running");
  await expect(page.getByTestId("tool-output-pane")).toBeVisible();
  const firstElapsed = await page.getByTestId("tool-elapsed").textContent();
  await expect.poll(() => page.getByTestId("tool-elapsed").textContent()).not.toBe(firstElapsed);
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("success");
  await expect(detailCommand).toHaveAttribute("data-formatted", "true");
  await expect(page.getByTestId("tool-detail")).toContainText("Completed");

  await expect(page.getByTestId("tool-detail-section")).toHaveCount(0);
  const inspector = page.getByTestId("shell-tool-inspector");
  await expect(inspector).toHaveAttribute("data-layout", "natural");
  await expect(page.getByTestId("tool-shell-splitter")).toHaveCount(0);
  const geometry = await inspector.evaluate((root) => {
    const commandPane = root.querySelector<HTMLElement>('[data-testid="tool-command-pane"]')!;
    const outputPane = root.querySelector<HTMLElement>('[data-testid="tool-output-pane"]')!;
    const inspectorBox = root.getBoundingClientRect();
    const commandBox = commandPane.getBoundingClientRect();
    const outputBox = outputPane.getBoundingClientRect();
    return {
      inspectorHeight: inspectorBox.height,
      commandHeight: commandBox.height,
      outputTop: outputBox.top,
      commandBottom: commandBox.bottom,
      commandSelect: getComputedStyle(commandPane.querySelector('[data-testid="shell-command"]')!).userSelect,
      outputSelect: getComputedStyle(outputPane.querySelector('[data-testid="tool-result"]')!).userSelect,
    };
  });
  expect(geometry.commandHeight / geometry.inspectorHeight).toBeLessThan(0.4);
  expect(Math.abs(geometry.outputTop - geometry.commandBottom)).toBeLessThan(1);
  expect(geometry.commandSelect).toBe("text");
  expect(geometry.outputSelect).toBe("text");
  const commandCode = detailCommand.locator("pre").first();
  const commandBox = await commandCode.boundingBox();
  expect(commandBox).not.toBeNull();
  await page.mouse.move(commandBox!.x + 2, commandBox!.y + 8);
  await page.mouse.down();
  await page.mouse.move(commandBox!.x + Math.min(90, commandBox!.width - 2), commandBox!.y + 8);
  await page.mouse.up();
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim().length).toBeGreaterThan(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const outputText = page.getByTestId("tool-output-pane").locator("[data-testid=tool-result] span").first();
  const outputBox = await outputText.boundingBox();
  expect(outputBox).not.toBeNull();
  await page.mouse.move(outputBox!.x + 2, outputBox!.y + 8);
  await page.mouse.down();
  await page.mouse.move(outputBox!.x + Math.min(90, outputBox!.width - 2), outputBox!.y + 8);
  await page.mouse.up();
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim().length).toBeGreaterThan(0);

  const sessionUrl = page.url();
  await page.goto("about:blank");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(sessionUrl);
  const mobileTool = page.getByTestId("tool-bash");
  await expect(mobileTool.getByTestId("tool-status")).toHaveText("success");
  await mobileTool.getByTestId("tool-open").click();
  await expect(page.getByTestId("tool-detail")).toBeVisible();
  expect(await page.getByTestId("tool-command-pane").evaluate((pane) => pane.scrollWidth - pane.clientWidth)).toBeLessThanOrEqual(1);
});

test("tool inspector adds a splitter only when command and output both overflow", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Adaptive tool split", approval: "never" });

  const command = [
    "sleep 0.8",
    ...Array.from({ length: 72 }, (_, index) => `printf 'adaptive-${String(index).padStart(2, "0")}\\n'`),
  ].join("\n");
  await page.evaluate(() => localStorage.setItem("oiia.shellInspectorOverflowSplit", "0.7800"));
  await sendMessage(page, `/bash ${command}`);
  const tool = page.getByTestId("tool-bash");
  await expect(tool.getByTestId("tool-status")).toHaveText("running");
  await tool.getByTestId("tool-open").click();
  const outputPane = page.getByTestId("tool-output-pane");
  await expect(outputPane).toContainText("Running");
  await outputPane.focus();
  await outputPane.press("End");
  await expect(tool.getByTestId("tool-status")).toHaveText("success");

  const inspector = page.getByTestId("shell-tool-inspector");
  await expect(inspector).toHaveAttribute("data-layout", "split");
  const commandPane = page.getByTestId("tool-command-pane");
  await expect(commandPane).toHaveAttribute("aria-labelledby", /tool-command-label-/);
  await expect(outputPane).toHaveAttribute("aria-labelledby", /tool-output-label-/);
  await expect(outputPane).toContainText("adaptive-71");
  await expect(outputPane.getByText(/more lines/i)).toHaveCount(0);
  const tail = await outputPane.evaluate((pane) => ({
    scrollTop: pane.scrollTop,
    gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
  }));
  expect(tail.scrollTop).toBeGreaterThan(0);
  expect(Math.abs(tail.gap)).toBeLessThan(2);
  const splitter = page.getByTestId("tool-shell-splitter");
  await expect(splitter).toHaveAttribute("aria-valuenow", "78");
  const before = Number(await splitter.getAttribute("aria-valuenow"));
  await outputPane.dispatchEvent("wheel", { deltaY: -400 });
  await outputPane.evaluate((pane) => {
    pane.scrollTop = 0;
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await splitter.focus();
  await splitter.press("ArrowUp");
  await expect(splitter).toHaveAttribute("aria-valuenow", String(before - 4));
  expect(await outputPane.evaluate((pane) => pane.scrollTop)).toBeLessThan(1);
  const inspectorBox = await inspector.boundingBox();
  const splitterBox = await splitter.boundingBox();
  expect(inspectorBox).not.toBeNull();
  expect(splitterBox).not.toBeNull();
  await page.mouse.move(splitterBox!.x + splitterBox!.width / 2, splitterBox!.y + splitterBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(inspectorBox!.x + inspectorBox!.width / 2, inspectorBox!.y + inspectorBox!.height * 0.5);
  await page.mouse.up();
  await expect(splitter).toHaveAttribute("aria-valuenow", "50");
});

test("approval flow: deny blocks the tool", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Deny test", approval: "on-request" });

  await sendMessage(page, "/bash echo should-not-run > blocked.txt");

  await expect(page.getByTestId("permission")).toBeVisible();
  await page.getByTestId("perm-deny").click();

  const tool = page.getByTestId("tool-bash");
  await expect(tool.getByTestId("tool-status")).toHaveText("denied");
  await openFilePanel(page);
  await expect(page.getByTestId("file-blocked.txt")).toHaveCount(0);
});

test("approval switch: changing the policy mid-session from the composer takes effect", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Switch policy", approval: "never" });
  await sendMessage(page, "/bash echo first > a.txt");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("success");
  await expect(page.getByTestId("permission")).toHaveCount(0);

  await page.getByTestId("approval-switch").click();
  await page.getByTestId("approval-opt-untrusted").click();

  await sendMessage(page, "/bash echo second > b.txt");
  await expect(page.getByTestId("permission")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("perm-approve").click();
  await expect(page.getByTestId("tool-bash").last().getByTestId("tool-status")).toHaveText("success");
});

test("persistence: timeline survives a page reload", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Persist test", approval: "never" });

  await sendMessage(page, "/write persisted.txt\nstill here");
  await expect(page.getByTestId("tool-write_file").getByTestId("tool-status")).toHaveText("success");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Done");

  await page.reload();

  await expect(page.getByTestId("msg-user").first()).toContainText("/write persisted.txt");
  await expect(page.getByTestId("tool-write_file")).toBeVisible();
  await openFilePanel(page);
  await expect(page.getByTestId("file-persisted.txt")).toBeVisible();
});

test("session switch: an in-tab switch-back paints the bounded Timeline cache immediately", async ({ page }) => {
  await page.addInitScript(() => {
    const audit = { sent: [] as unknown[], received: [] as unknown[] };
    (window as Window & { __oiiaReplayAudit?: typeof audit }).__oiiaReplayAudit = audit;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        const nativeSend = socket.send.bind(socket);
        socket.send = (data) => {
          if (typeof data === "string") {
            try { audit.sent.push(JSON.parse(data)); } catch {  }
          }
          nativeSend(data);
        };
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            try { audit.received.push(JSON.parse(event.data)); } catch {  }
          }
        });
        return socket;
      },
    });
  });
  await signup(page);
  await createSession(page, { title: "Cache A", approval: "never" });
  const sessionA = decodeURIComponent(new URL(page.url()).pathname.slice(3));
  await sendMessage(page, "cache-a-marker");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();

  await createSession(page, { title: "Cache B", approval: "never" });
  await expect(page.getByTestId("main-content")).toHaveAttribute("data-session-cache-hit", "false");

  await page.evaluate(() => {
    const audit = (window as Window & { __oiiaReplayAudit?: { sent: unknown[]; received: unknown[] } }).__oiiaReplayAudit;
    if (audit) { audit.sent = []; audit.received = []; }
  });
  await page.locator("[data-session-item]").filter({ hasText: "Cache A" }).click();
  const main = page.getByTestId("main-content");
  await expect(main).toHaveAttribute("data-session-cache-hit", "true");
  await expect(page.getByTestId("msg-user").last()).toContainText("cache-a-marker");
  await page.waitForTimeout(220);
  await expect(page.locator(".oiia-overlay")).toHaveCount(0);

  const readResumeAudit = () => page.evaluate((sessionId) => {
    const audit = (window as Window & { __oiiaReplayAudit?: { sent: unknown[]; received: unknown[] } }).__oiiaReplayAudit;
    const sent = (audit?.sent ?? []) as Array<{ type?: string; sessionId?: string; resume?: { epoch?: string; version?: number } }>;
    const received = (audit?.received ?? []) as Array<{ type?: string; sessionId?: string }>;
    const subscribe = sent.find((event) => event.type === "subscribe" && event.sessionId === sessionId);
    return {
      hasCursor: typeof subscribe?.resume?.epoch === "string" && Number.isSafeInteger(subscribe?.resume?.version),
      replayCount: received.filter((event) => event.type === "timeline_replay" && event.sessionId === sessionId).length,
      lightweight: received.filter((event) => event.sessionId === sessionId).map((event) => event.type),
    };
  }, sessionA);
  await expect.poll(readResumeAudit).toMatchObject({
    hasCursor: true,
    lightweight: expect.arrayContaining(["session_status", "context_usage"]),
  });
  const resumeAudit = await readResumeAudit();
  expect(resumeAudit.hasCursor).toBe(true);
  expect(resumeAudit.replayCount).toBe(0);

  await page.reload();
  await expect(page.getByTestId("main-content")).toHaveAttribute("data-session-cache-hit", "false");
  await expect(page.getByTestId("msg-user").last()).toContainText("cache-a-marker");
});

test("sandbox: read-only mode blocks file writes", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Read-only", approval: "never", sandbox: "read-only" });

  await sendMessage(page, "/write nope.txt\nshould not be written");

  const tool = page.getByTestId("tool-write_file");
  await expect(tool.getByTestId("tool-status")).toHaveText("error");
  await expect(tool.getByTestId("tool-error-preview")).toContainText("read-only");
  await openFilePanel(page);
  await expect(page.getByTestId("file-nope.txt")).toHaveCount(0);
});

test("interrupt: Stop aborts a long-running command", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Interrupt", approval: "never" });

  const sendNode = await page.getByTestId("send").elementHandle();
  expect(sendNode).not.toBeNull();
  await sendMessage(page, "/bash sleep 30");

  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");
  const stopNode = await page.getByTestId("interrupt").elementHandle();
  expect(stopNode).not.toBeNull();
  expect(await sendNode!.evaluate((node, stop) => node === stop, stopNode)).toBe(true);
  await page.getByTestId("interrupt").click();

  await expect(page.getByTestId("send")).toBeVisible();
  const sendAgainNode = await page.getByTestId("send").elementHandle();
  expect(await sendNode!.evaluate((node, next) => node === next, sendAgainNode)).toBe(true);
});

test("background tasks: a session running in the background shows in the menubar + jumps back (#74)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Background A", approval: "never" });

  await sendMessage(page, "/bash sleep 30");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  await createSession(page, { title: "Background B", approval: "never" });

  const indicator = page.getByTestId("bg-tasks");
  await expect(indicator).toBeVisible();
  await expect(indicator).toContainText("1 running");

  await indicator.click();
  const panel = page.getByTestId("bg-tasks-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Background A");

  await panel.getByRole("button", { name: "Background A" }).click();
  await expect(page.locator(".session-item", { hasText: "Background A" })).toHaveAttribute("aria-current", "page");

  await page.getByTestId("interrupt").click();
  await expect(page.getByTestId("send")).toBeVisible();
});

test("ssh executor: register/list/delete targets + SSRF guard rejects internal hosts (#45)", async ({ page }) => {
  await signup(page);
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    const h = { "content-type": "application/json", authorization: "Bearer " + token };
    const KEY = ["-----BEGIN", "OPENSSH PRIVATE KEY-----\n"].join(" ")
      + "b3BlbnNzaC1rZXk".repeat(8)
      + ["\n-----END", "OPENSSH PRIVATE KEY-----"].join(" ");
    const post = (body: unknown) =>
      fetch("/api/ssh/targets", { method: "POST", headers: h, body: JSON.stringify(body) }).then((r) => r.status);
    const okStatus = await post({ label: "my box", host: "203.0.113.10", port: 22, username: "deploy", privateKey: KEY });
    const internalStatus = await post({ label: "evil", host: "10.0.0.5", username: "root", privateKey: KEY });
    const metaStatus = await post({ label: "meta", host: "169.254.169.254", username: "root", privateKey: KEY });
    const list = await fetch("/api/ssh/targets", { headers: h }).then((r) => r.json());
    return { okStatus, internalStatus, metaStatus, list };
  });
  expect(result.okStatus).toBe(200);
  expect(result.internalStatus).toBe(400);
  expect(result.metaStatus).toBe(400);
  expect(result.list.enabled).toBe(true);
  expect(result.list.targets).toHaveLength(1);
  expect(result.list.targets[0].host).toBe("203.0.113.10");
  expect(JSON.stringify(result.list.targets[0])).not.toContain("PRIVATE KEY");
});

test("plugins: register an SSH target via the UI (#45)", async ({ page }) => {
  await signup(page);

  await page.getByTestId("open-plugins").click();
  await expect(page.getByTestId("plugins-view")).toBeVisible();

  await page.getByTestId("add-ssh").click();
  await expect(page.getByTestId("plugin-register")).toBeVisible();
  await page.getByTestId("plugin-label").fill("my box");
  await page.getByTestId("plugin-host").fill("203.0.113.5");
  await page.getByTestId("plugin-username").fill("deploy");
  const dummyKey = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "x".repeat(120) + "\n-----END OPENSSH PRIVATE KEY-----";
  await page.getByTestId("plugin-key").fill(dummyKey);
  await page.getByTestId("plugin-register-submit").click();

  await expect(page.getByText("203.0.113.5:22", { exact: true })).toBeVisible();
});

test("connectors: master-detail presence marker has its own geometry and no duplicate status copy", async ({ page }) => {
  await signup(page);
  const now = Date.now();
  let telemetryTick = 0;
  await page.route("**/api/connectors/geometry-online/telemetry", async (route) => {
    telemetryTick += 1;
    const cpuPct = 18 + telemetryTick * 7;
    const memUsed = (5.1 + telemetryTick * 0.2) * 1024 ** 3;
    await route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        telemetry: {
          sampledAt: now + telemetryTick * 3_000,
          cpuPct,
          memUsed,
          memTotal: 16 * 1024 ** 3,
          cpuCores: 12,
          loadAvg: [1.2, 1.1, 1.0],
          processCount: 146,
          cpuKind: "interval",
          processSource: "native",
          processes: [
            { pid: 4102, ppid: 1, name: "node", state: "R+", cpuPct: 24.6, memPct: 3.2, rssBytes: 534_773_760, elapsed: "12:48" },
            { pid: 982, ppid: 1, name: "WindowServer", state: "Ss", cpuPct: 8.1, memPct: 1.5, rssBytes: 251_658_240, elapsed: "04:21:09" },
          ],
        },
      },
    });
  });
  await page.route("**/api/connectors", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        connectors: [
          {
            id: "geometry-online",
            name: "Studio Mac",
            workspaceRoot: "~/work/studio",
            capabilities: ["exec", "files", "pty"],
            online: true,
            lastSeenAt: now,
            createdAt: now,
            unconfined: false,
            daemonUnconfined: true,
          },
          {
            id: "geometry-offline",
            name: "Travel laptop",
            workspaceRoot: "~/work/travel",
            capabilities: ["exec", "files"],
            online: false,
            lastSeenAt: now - 60_000,
            createdAt: now,
            unconfined: false,
            daemonUnconfined: null,
          },
        ],
      },
    });
  });

  await page.getByTestId("open-plugins").click();
  const onlineRow = page.getByTestId("connector-row-geometry-online");
  await expect(onlineRow).toBeVisible();
  await expect(onlineRow).not.toContainText(/online|offline/i);

  const telemetry = page.getByTestId("connector-telemetry-geometry-online");
  await expect(telemetry).toContainText("Live performance");
  await expect(telemetry).toContainText("node");
  await expect(telemetry.getByTestId("connector-process-row")).toHaveCount(2);
  await expect(telemetry).not.toContainText(/--token|cmdline|password123/);
  await expect.poll(() => telemetryTick, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
  await expect(telemetry.locator(".recharts-area-curve")).toHaveCount(2);

  const glyphBox = await page.getByTestId("connector-glyph-geometry-online").boundingBox();
  const presence = page.getByTestId("connector-presence-geometry-online");
  const presenceBox = await presence.boundingBox();
  const dotBox = await presence.locator('[aria-hidden="true"]').boundingBox();
  expect(glyphBox).not.toBeNull();
  expect(presenceBox).not.toBeNull();
  expect(dotBox).not.toBeNull();
  expect(glyphBox!.width).toBeCloseTo(16, 1);
  expect(glyphBox!.height).toBeCloseTo(16, 1);
  expect(presenceBox!.width).toBeCloseTo(16, 1);
  expect(presenceBox!.height).toBeCloseTo(16, 1);
  expect(dotBox!.width).toBeCloseTo(6, 1);
  expect(dotBox!.height).toBeCloseTo(6, 1);
  expect(Math.abs((dotBox!.x + dotBox!.width / 2) - (presenceBox!.x + presenceBox!.width / 2))).toBeLessThan(0.5);
  expect(Math.abs((dotBox!.y + dotBox!.height / 2) - (presenceBox!.y + presenceBox!.height / 2))).toBeLessThan(0.5);
  expect(presenceBox!.x).toBeGreaterThan(glyphBox!.x + glyphBox!.width + 120);

  const appSidebarSeparator = page.getByRole("separator", { name: "Resize sidebar" });
  for (let i = 0; i < 30; i += 1) await appSidebarSeparator.press("ArrowRight");
  await expect.poll(async () => (await appSidebarSeparator.boundingBox())?.x ?? 0).toBeGreaterThan(590);
  await expect(onlineRow).toBeVisible();
  await expect(page.getByRole("heading", { name: "Studio Mac" })).toBeHidden();
  await onlineRow.click();
  await expect(page.getByRole("heading", { name: "Studio Mac" })).toBeVisible();
  await expect(onlineRow).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  await page.getByRole("button", { name: "Back to machines" }).click();
  await expect(onlineRow).toBeFocused();
  await onlineRow.click();
  await expect(page.getByRole("main")).toBeFocused();

  for (let i = 0; i < 30; i += 1) await appSidebarSeparator.press("ArrowLeft");
  await expect(onlineRow).toBeVisible();

  await page.getByTestId("connector-row-geometry-offline").click();
  const detailPresence = page.getByTestId("connector-detail-presence-geometry-offline");
  await expect(detailPresence).toHaveAttribute("aria-label", "offline");
  await expect(page.getByRole("heading", { name: "Travel laptop" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(/\boffline\b/i);
  await expect(page.getByTestId("connector-telemetry-geometry-offline")).toContainText("Connect this machine to load performance data.");
});

test("skills gallery: launches New Session pre-set to the chosen persona (#44)", async ({ page }) => {
  await signup(page);

  await page.getByTestId("open-skills").click();
  await expect(page.getByTestId("skill-coding")).toBeVisible();
  await expect(page.getByTestId("skill-pentest")).toBeVisible();
  await expect(page.getByTestId("skill-exploit")).toBeVisible();
  await expect(page.getByTestId("skill-team")).toHaveCount(0);

  await page.getByTestId("skill-launch-pentest").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await expect(page.getByTestId("ns-mode-card-pentest")).toBeChecked();
});

test("new session blueprint: crisp overlay, mode cards, and one coherent selection state", async ({ page }) => {
  await signup(page);
  await page.getByTestId("new-session").click();

  const modal = page.getByTestId("new-session-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("ns-mode-cards")).toBeVisible();
  for (const m of ["coding", "bold", "pentest", "exploit"]) {
    await expect(page.getByTestId(`ns-mode-card-${m}`)).toBeVisible();
  }
  await expect(page.getByTestId("ns-mode-card-coding")).toBeChecked();

  const overlayFilter = await page.getByTestId("new-session-overlay").evaluate((node) => {
    const style = getComputedStyle(node);
    return { backdropFilter: style.backdropFilter, webkitBackdropFilter: style.webkitBackdropFilter };
  });
  expect(overlayFilter.backdropFilter).toBe("none");
  expect([undefined, "none"]).toContain(overlayFilter.webkitBackdropFilter);

  await page.getByTestId("ns-mode-option-pentest").click();
  await expect(page.getByTestId("ns-mode-card-pentest")).toBeChecked();

  const box = await modal.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(700);
  expect(box!.width).toBeLessThanOrEqual(782);
});

test("new session blueprint: phone layout stays crisp and scrolls inside the sheet", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 900, height: 760 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await signup(page);
    await page.getByTestId("new-session").click();
    await page.setViewportSize({ width: 390, height: 844 });

    const modal = page.getByTestId("new-session-modal");
    await expect(modal).toBeVisible();
    const modalBox = await modal.boundingBox();
    expect(modalBox).not.toBeNull();
    expect(modalBox!.width).toBeLessThanOrEqual(360);
    expect(modalBox!.height).toBeLessThanOrEqual(748);

    const cards = page.locator('[data-testid^="ns-mode-option-"]');
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    const third = await cards.nth(2).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect(Math.abs(first!.y - second!.y)).toBeLessThan(10);
    expect(third!.y).toBeGreaterThan(first!.y + first!.height);

    await cards.nth(3).click();
    await expect(page.getByTestId("ns-mode-card-exploit")).toBeChecked();
    await expect(page.getByTestId("new-session-overlay")).toHaveCSS("backdrop-filter", "none");
  } finally {
    await context.close();
  }
});

test("multi-provider: adding an API key surfaces that provider's models", async ({ page }) => {
  await signup(page);

  await openSettings(page);
  const row = page.locator(".key-row", { hasText: "anthropic" });
  await row.locator("input").fill("sk-ant-fake-key-for-ui-test-1234567890");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("····");

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await openSessionAdvanced(page);
  const anthropicOption = page.locator('[data-testid="ns-model"] option[value^="anthropic::"]');
  await expect(anthropicOption.first()).toBeAttached();
});

test("search: finds a session by message text and opens it (#55)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Findable", approval: "never" });
  await sendMessage(page, "zorptastic-marker please reply briefly");
  await expect(page.getByTestId("send")).toBeVisible();

  await page.getByTestId("open-search").click();
  await page.getByTestId("search-input").fill("zorptastic-marker");
  const result = page.getByTestId("search-result").first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("steer: a message sent mid-turn injects into the running turn (#56)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Steerable", approval: "never" });

  await sendMessage(page, "/bash sleep 3");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  await page.getByTestId("composer").fill("steer-marker-xyz");
  await expect(page.getByTestId("steer")).toBeVisible();
  await page.getByTestId("steer").click();

  await expect(page.getByText("steer-marker-xyz").first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("session-status")).toHaveText("idle", { timeout: 20_000 });
  await expect(page.getByTestId("edit-message")).toHaveCount(1);
  await expect(page.getByTestId("fork-message")).toHaveCount(1);
});

test("queue PROOF: a queue behind a >10s turn stays visible (no ghost-timeout) + promotes once", async ({ page }) => {
  test.setTimeout(90_000);
  await signup(page);
  await createSession(page, { title: "QueueDurable", approval: "never" });

  await sendMessage(page, "/bash sleep 14");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  await page.getByTestId("composer").fill("queued-marker-abc");
  await expect(page.getByTestId("queue")).toBeVisible();
  await page.getByTestId("queue").click();

  const chip = page.getByTestId("pending-region").getByTestId("pending-queue");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("queued-marker-abc");
  await expect(chip.getByTestId("pending-ord")).toHaveText("1");

  await page.waitForTimeout(11000);
  await expect(chip).toBeVisible();
  await expect(page.getByTestId("pending-region").getByText("queued-marker-abc")).toBeVisible();

  await expect(page.getByTestId("pending-region")).toBeHidden({ timeout: 20000 });
  await expect(page.getByText("queued-marker-abc")).toHaveCount(1, { timeout: 20000 });
});

test("queue REFRESH survival: a pending chip re-renders from server truth after a reload", async ({ page }) => {
  test.setTimeout(90_000);
  await signup(page);
  await createSession(page, { title: "QueueRefresh", approval: "never" });

  await sendMessage(page, "/bash sleep 14");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  await page.getByTestId("composer").fill("survive-reload-q");
  await page.getByTestId("queue").click();
  await expect(page.getByTestId("pending-region").getByText("survive-reload-q")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");
  await expect(page.getByTestId("pending-region").getByText("survive-reload-q")).toBeVisible();

  await expect(page.getByTestId("pending-region")).toBeHidden({ timeout: 20000 });
  await expect(page.getByText("survive-reload-q")).toHaveCount(1, { timeout: 20000 });
});

test("pending edit + drag reorder: rewrite in place, durable, FIFO follows the new order", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page);
  await createSession(page, { title: "PendingEditReorder", approval: "never" });

  await sendMessage(page, "/bash sleep 22");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  for (const text of ["pending-alpha", "pending-beta", "pending-gamma"]) {
    await page.getByTestId("composer").fill(text);
    await page.getByTestId("queue").click();
    await expect(page.getByTestId("pending-region").getByText(text)).toBeAttached();
  }
  const region = page.getByTestId("pending-region");
  await region.getByTestId("pending-stack-toggle").click();
  await expect(region.getByTestId("pending-queue")).toHaveCount(3);

  const betaRow = region.getByTestId("pending-queue").filter({ hasText: "pending-beta" });
  await betaRow.getByTestId("pending-edit").click();
  const editInput = region.getByTestId("pending-edit-input");
  await expect(editInput).toBeVisible();
  await editInput.fill("pending-beta-edited");
  await editInput.press("Enter");
  await expect(region.getByText("pending-beta-edited")).toBeAttached();
  await expect(region.getByText(/^pending-beta$/)).toHaveCount(0);

  const gammaRow = region.getByTestId("pending-queue").filter({ hasText: "pending-gamma" });
  const gammaText = gammaRow.getByText("pending-gamma");
  const box = await gammaText.boundingBox();
  if (!box) throw new Error("gamma row geometry is unavailable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 34, { steps: 6 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 68, { steps: 6 });
  await page.mouse.up();
  await expect(gammaRow.getByTestId("pending-ord")).toHaveText("1");

  await page.reload();
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");
  const region2 = page.getByTestId("pending-region");
  await region2.getByTestId("pending-stack-toggle").click();
  await expect(region2.getByText("pending-beta-edited")).toBeAttached();
  await expect(region2.getByTestId("pending-queue").filter({ hasText: "pending-gamma" }).getByTestId("pending-ord")).toHaveText("1");

  await expect(region2).toBeHidden({ timeout: 40000 });
  await expect(page.getByText("pending-beta-edited")).toHaveCount(1, { timeout: 20000 });
  const order = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('[data-testid="msg-user"]')].map((n) => n.textContent ?? "");
    return {
      gamma: texts.findIndex((t) => t.includes("pending-gamma")),
      alpha: texts.findIndex((t) => t.includes("pending-alpha")),
    };
  });
  expect(order.gamma).toBeGreaterThanOrEqual(0);
  expect(order.alpha).toBeGreaterThan(order.gamma);
});

test("pending swap: one tap converts queue↔steer in place, durably (survives reload)", async ({ page }) => {
  test.setTimeout(90_000);
  await signup(page);
  await createSession(page, { title: "PendingSwap", approval: "never" });

  await sendMessage(page, "/bash sleep 14");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  await page.getByTestId("composer").fill("swap-me-around");
  await page.getByTestId("queue").click();
  const region = page.getByTestId("pending-region");
  await expect(region.getByTestId("pending-queue")).toBeVisible();
  await expect(region.getByTestId("pending-ord")).toHaveText("1");

  await region.getByTestId("pending-swap").click();
  await expect(region.getByTestId("pending-steer")).toBeVisible();
  await expect(region.getByTestId("pending-queue")).toHaveCount(0);
  await expect(region.getByTestId("pending-ord")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");
  await expect(region.getByTestId("pending-steer")).toBeVisible();
  await expect(region.getByTestId("pending-steer")).toContainText("swap-me-around");

  await region.getByTestId("pending-swap").click();
  await expect(region.getByTestId("pending-queue")).toBeVisible();
  await expect(region.getByTestId("pending-ord")).toHaveText("1");

  await expect(region).toBeHidden({ timeout: 25000 });
  await expect(page.getByText("swap-me-around")).toHaveCount(1, { timeout: 20000 });
});

test("steer-before-queue ORDER: the region shows the steer chip above the queue chip", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "SteerQueueOrder", approval: "never" });

  await sendMessage(page, "/bash sleep 6");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  await page.getByTestId("composer").fill("order-queue-1");
  await page.getByTestId("queue").click();
  await expect(page.getByTestId("pending-region").getByText("order-queue-1")).toBeVisible();

  await page.getByTestId("composer").fill("order-steer-1");
  await page.getByTestId("steer").click();
  await expect(page.getByTestId("pending-region").getByText("order-steer-1")).toBeVisible();

  const chipsText = await page.getByTestId("pending-region").locator("[data-pending-kind]").allInnerTexts();
  const steerIdx = chipsText.findIndex((c) => c.includes("order-steer-1"));
  const queueIdx = chipsText.findIndex((c) => c.includes("order-queue-1"));
  expect(steerIdx).toBeGreaterThanOrEqual(0);
  expect(queueIdx).toBeGreaterThanOrEqual(0);
  expect(steerIdx).toBeLessThan(queueIdx);
});

test("FIFO multi-queue: three queued messages render #1/#2/#3 by order", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "QueueFifo", approval: "never" });

  await sendMessage(page, "/bash sleep 10");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");

  for (const txt of ["fifo-one", "fifo-two", "fifo-three"]) {
    await page.getByTestId("composer").fill(txt);
    await page.getByTestId("queue").click();
    await expect(page.getByTestId("pending-region").getByText(txt)).toBeVisible();
  }

  const region = page.getByTestId("pending-region");
  const texts = await region.locator("[data-pending-kind='queue']").allInnerTexts();
  const order = texts.map((t) => t.replace(/\s+/g, " "));
  const i1 = order.findIndex((t) => t.includes("fifo-one"));
  const i2 = order.findIndex((t) => t.includes("fifo-two"));
  const i3 = order.findIndex((t) => t.includes("fifo-three"));
  expect(i1).toBeLessThan(i2);
  expect(i2).toBeLessThan(i3);
  const badges = await region.locator("[data-pending-kind='queue'] [data-testid='pending-ord']").allInnerTexts();
  expect(badges).toEqual(["1", "2", "3"]);
});

test("a long draft caps at the sweet spot and hands off to the draft editor", async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 1_000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page);
  await createSession(page, { title: "Long draft", approval: "never" });

  const composer = page.getByTestId("composer");
  await composer.fill("short draft");
  await expect(page.getByTestId("draft-expand")).toHaveCount(0);

  const longDraft = Array.from({ length: 24 }, (_, index) => `draft line ${index + 1}`).join("\n");
  await composer.fill(longDraft);
  await expect.poll(() => composer.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(140);
  expect(await composer.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByTestId("draft-expand").click();

  const editor = page.getByTestId("draft-editor");
  const editorInput = page.getByTestId("draft-editor-input");
  await expect(editor).toBeVisible();
  await expect(editorInput).toHaveValue(longDraft);
  await editorInput.fill(`${longDraft}\nedited in the big editor`);
  await page.getByTestId("draft-editor-done").click();
  await expect(editor).toBeHidden();
  await expect(composer).toHaveValue(`${longDraft}\nedited in the big editor`);
  await expect(composer).toBeFocused();

  await page.getByTestId("draft-expand").click();
  await expect(editor).toBeVisible();
  await page.getByTestId("draft-editor-send").click();
  await expect(editor).toBeHidden();
  await expect(page.getByTestId("msg-user").last()).toContainText("edited in the big editor");
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("draft-expand")).toHaveCount(0);
});

test("memory settings: the toggle and user notes round-trip through the API", async ({ page }) => {
  await signup(page);
  await openSettings(page);
  const section = page.getByTestId("memory-settings");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "true");
  await expect(section.getByTestId("memory-state-empty")).toBeVisible();

  await section.getByTestId("memory-notes").fill("always run the tests first");
  await section.getByTestId("memory-notes").blur();
  const readMemory = () => page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    return await fetch("/api/settings/memory", { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  });
  await expect.poll(async () => (await readMemory()).userNotes).toBe("always run the tests first");

  await section.getByTestId("memory-toggle").click();
  await expect(section.getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await readMemory()).enabled).toBe(false);
  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId("memory-settings").getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "false");
});

test("settings: an egress proxy is saved and persists across reload (#55)", async ({ page }) => {
  await signup(page);
  await openSettings(page);

  const proxy = page.locator("#proxy-pool");
  const PROXY = "socks5://203.0.113.10:1080";
  await proxy.fill(PROXY);
  const saved = page.waitForResponse(
    (r) => r.url().includes("/settings/egress") && r.request().method() === "PATCH" && r.ok(),
  );
  await proxy.blur();
  await saved;

  await page.reload();
  await openSettings(page);
  await expect(page.locator("#proxy-pool")).toHaveValue(PROXY);
});

test("egress SSRF guard: PATCH /settings/egress rejects internal proxy hosts with 400", async ({ page }) => {
  await signup(page);
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    const h = { "content-type": "application/json", authorization: "Bearer " + token };
    const patch = (body: unknown) =>
      fetch("/api/settings/egress", { method: "PATCH", headers: h, body: JSON.stringify(body) }).then((r) => r.status);

    const link_local    = await patch({ proxyUrl: "http://169.254.169.254" });
    const loopback      = await patch({ proxyUrl: "http://127.0.0.1:8080" });
    const rfc1918_10    = await patch({ proxyUrl: "http://10.0.0.5:3128" });
    const rfc1918_192   = await patch({ proxyUrl: "http://192.168.1.1:3128" });
    const ipv6_loopback = await patch({ proxyUrl: "socks5://[::1]:1080" });

    const publicProxy   = await patch({ proxyUrl: "https://1.1.1.1:8080" });

    const cleared       = await patch({ proxyUrl: "" });

    return { link_local, loopback, rfc1918_10, rfc1918_192, ipv6_loopback, publicProxy, cleared };
  });

  expect(result.link_local,    "169.254.169.254 should be 400").toBe(400);
  expect(result.loopback,      "127.0.0.1 should be 400").toBe(400);
  expect(result.rfc1918_10,    "10.0.0.5 should be 400").toBe(400);
  expect(result.rfc1918_192,   "192.168.1.1 should be 400").toBe(400);
  expect(result.ipv6_loopback, "::1 should be 400").toBe(400);
  expect(result.publicProxy,   "1.1.1.1 should be 200").toBe(200);
  expect(result.cleared,       "empty proxyUrl should be 200").toBe(200);
});

test("session delete: removes the session from the sidebar", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Throwaway", approval: "never" });
  const session = page.locator(".session-item", { hasText: "Throwaway" });
  await expect(session).toBeVisible();

  page.on("dialog", (d) => d.accept());
  await session.hover();
  await session.locator(".session-del").click();

  await expect(page.locator(".session-item", { hasText: "Throwaway" })).toHaveCount(0);
});

test("session rename: inline edit updates the sidebar title", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "RenameMe", approval: "never" });
  const row = page.locator(".session-item", { hasText: "RenameMe" });
  await expect(row).toBeVisible();

  await row.hover();
  await row.locator(".session-rename").click();
  const input = page.locator(".session-rename-input");
  await expect(input).toBeVisible();
  await input.fill("Renamed Session");
  await input.press("Enter");

  await expect(page.locator(".session-item", { hasText: "Renamed Session" })).toBeVisible();
  await expect(page.locator(".session-item", { hasText: "RenameMe" })).toHaveCount(0);
});

test("auto-title: the first user message names an Untitled session", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "", approval: "never" });
  await expect(page.locator(".session-item", { hasText: "Untitled session" })).toBeVisible();

  await sendMessage(page, "Sort an array of numbers");

  await expect(page.locator(".session-item", { hasText: "Sort an array of numbers" })).toBeVisible();
  await expect(page.locator(".session-item", { hasText: "Untitled session" })).toHaveCount(0);
});

test("multi-user isolation: a second user cannot see the first user's sessions", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await signup(pageA);
  await createSession(pageA, { title: "Private-A-session", approval: "never" });
  await expect(pageA.locator(".session-item", { hasText: "Private-A-session" })).toBeVisible();

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signup(pageB);
  await expect(pageB.locator(".session-item", { hasText: "Private-A-session" })).toHaveCount(0);
  await expect(pageB.getByText("No sessions yet.")).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

async function installNotificationProbe(page: Page, opts: { backgrounded: boolean }) {
  await page.addInitScript(({ backgrounded }) => {
    const win = window as typeof window & {
      __notifs: Array<{ title: string; options: NotificationOptions }>;
      Notification: typeof Notification;
      BroadcastChannel: typeof BroadcastChannel;
    };
    const OriginalNotification = win.Notification;

    win.__notifs = [];
    win.BroadcastChannel = class {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(_name: string) {}
      postMessage(_message: unknown) {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true; }
    } as typeof BroadcastChannel;

    class NotificationProbe {
      static permission = "granted";
      static maxActions = 0;
      static requestPermission = async () => "granted" as NotificationPermission;
      onclick: ((this: Notification, ev: Event) => unknown) | null = null;
      private real: Notification | null = null;

      constructor(title: string, options?: NotificationOptions) {
        win.__notifs.push({ title, options: options ?? {} });
        if (OriginalNotification) {
          try {
            this.real = new OriginalNotification(title, options);
          } catch {
            this.real = null;
          }
        }
      }

      close() {
        this.real?.close();
      }
    }

    Object.defineProperty(NotificationProbe, "permission", {
      configurable: true,
      get: () => "granted",
    });
    Object.defineProperty(win, "Notification", {
      configurable: true,
      value: NotificationProbe,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => backgrounded,
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => !backgrounded,
    });
  }, opts);
}

async function readNotifications(page: Page) {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __notifs?: Array<{ title: string; options: NotificationOptions }>;
    };
    return win.__notifs ?? [];
  });
}

test("shows notification when tab is backgrounded", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.grantPermissions(["notifications"]);
    const page = await context.newPage();
    await installNotificationProbe(page, { backgrounded: true });

    await signup(page);
    await createSession(page, { title: "Notify background", approval: "never" });
    await sendMessage(page, "/ls");
    await expect(page.getByTestId("msg-assistant").last()).toContainText("Done");

    await expect.poll(async () => (await readNotifications(page)).some((n) => n.title === "oiia")).toBe(true);
  } finally {
    await context.close();
  }
});

test("does NOT show notification when tab is focused", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.grantPermissions(["notifications"]);
    const page = await context.newPage();
    await installNotificationProbe(page, { backgrounded: false });

    await signup(page);
    await createSession(page, { title: "Notify focused", approval: "never" });
    await sendMessage(page, "/ls");
    await expect(page.getByTestId("msg-assistant").last()).toContainText("Done");

    await expect.poll(() => readNotifications(page)).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test("shows permission-request notification", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.grantPermissions(["notifications"]);
    const page = await context.newPage();
    await installNotificationProbe(page, { backgrounded: true });

    await signup(page);
    await createSession(page, { title: "Notify permission", approval: "on-request" });
    await sendMessage(page, "/bash echo hi");
    await expect(page.getByTestId("permission")).toBeVisible();

    await expect.poll(async () => (await readNotifications(page)).some((n) => n.title === "oiia")).toBe(true);
  } finally {
    await context.close();
  }
});

test("uploaded attachment is readable by the agent in the same session (#59)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Upload read", approval: "never" });

  await page.locator('input[type="file"]').setInputFiles({
    name: "probe.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("UPLOAD_PROBE_42"),
  });
  await sendMessage(page, "here is a file");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();

  await sendMessage(page, "/read uploads/probe.txt");
  const tool = page.getByTestId("tool-read_file");
  await expect(tool).toBeVisible();
  await expect(tool.getByTestId("tool-status")).toHaveText("success");
  await tool.getByTestId("tool-open").click();
  await expect(page.getByTestId("tool-detail").getByTestId("tool-result")).toContainText("UPLOAD_PROBE_42");
});

test("user message renders uploaded files as chips (not the raw note), clickable to preview", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Attach render", approval: "never" });

  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("RENDERED_CHIP_CONTENT"),
  });
  await expect(page.getByTestId("attachments")).toBeVisible();
  await sendMessage(page, "look at this file");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();

  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble).toContainText("look at this file");
  await expect(bubble).not.toContainText("[Attached");
  await expect(bubble).not.toContainText("uploads/");

  const chip = page.getByTestId("msg-attachment");
  await expect(chip.first()).toBeVisible();
  await expect(chip.first()).toContainText("notes.txt");

  await chip.first().click();
  await expect(page.getByTestId("file-view")).toContainText("RENDERED_CHIP_CONTENT", { timeout: 10000 });
});

test("long pasted text becomes an editable .txt attachment", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Pasted text attachment", approval: "never" });

  const composer = page.getByTestId("composer");
  await composer.fill("summarize the pasted document");
  const longText = Array.from(
    { length: 96 },
    (_, index) => `section ${index + 1}: ${"long clipboard content ".repeat(2)}`,
  ).join("\n");
  expect(Buffer.byteLength(longText, "utf8")).toBeGreaterThanOrEqual(2 * 1024);

  await composer.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }));
  }, longText);

  await expect(composer).toHaveValue("summarize the pasted document");
  const card = page.getByTestId("pasted-text-attachment");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Pasted text");
  await expect(card).toContainText("TXT");
  await expect(card).toHaveAttribute("data-file-name", /^pasted-text-[a-z0-9]{12}\.txt$/);

  await card.getByRole("button", { name: "Edit pasted text" }).click();
  const editor = page.getByTestId("pasted-text-editor");
  const editorInput = page.getByTestId("pasted-text-editor-input");
  await expect(editor).toBeVisible();
  await expect(editorInput).toHaveValue(longText);
  await expect(editorInput).toBeFocused();
  await expect.poll(() => editorInput.evaluate((node) => node.scrollTop)).toBe(0);

  const editedText = `EDITED_PASTE_MARKER\n${longText.slice(0, 1_200)}`;
  await editorInput.fill(editedText);
  await editorInput.press("Control+Enter");
  await expect(editor).toBeHidden();

  await card.getByRole("button", { name: "Edit pasted text" }).click();
  await expect(editorInput).toHaveValue(editedText);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toBeHidden();

  await page.getByTestId("send").click();
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();

  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble).toContainText("summarize the pasted document");
  await expect(bubble).not.toContainText("[Attached");
  await expect(bubble).not.toContainText("Use read_file");
  const sentChip = page.getByTestId("msg-attachment").last();
  await expect(sentChip).toContainText(/pasted-text-[a-z0-9]{12}\.txt/);
  await sentChip.click();
  await expect(page.getByTestId("file-view")).toContainText("EDITED_PASTE_MARKER", { timeout: 10000 });
});

test("image attachment previews as an actual image, not '[binary file]'", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Image preview", approval: "never" });

  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z8Dwn4EIwDiKBgD+/g/9k0nXAAAAAABJRU5ErkJggg==";
  await page.locator('input[type="file"]').setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG, "base64"),
  });
  await sendMessage(page, "a picture");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();

  await page.getByTestId("msg-attachment").first().click();
  await expect(page.getByTestId("file-view").locator('img[alt="uploads/shot.png"]')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("[binary file]", { exact: false })).toHaveCount(0);
});

test("PDF preview skips the text read and renders pages through bounded ranges", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "PDF range preview", approval: "never" });
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.slice(3));
  const textReads: string[] = [];
  const previewRequests: { range: string | undefined; url: string }[] = [];
  const previewResponses: { status: number; contentRange: string | undefined; contentLength: string | undefined }[] = [];
  const finishedBodySizes: Promise<number>[] = [];
  let mintRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/sessions/${sessionId}/file`) textReads.push(url.searchParams.get("path") ?? "");
    if (url.pathname === `/api/sessions/${sessionId}/file-preview`) mintRequests++;
    if (url.pathname.startsWith("/api/file-preview/")) previewRequests.push({ range: request.headers().range, url: url.pathname });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/file-preview/")) return;
    const headers = response.headers();
    previewResponses.push({ status: response.status(), contentRange: headers["content-range"], contentLength: headers["content-length"] });
  });
  page.on("requestfinished", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/file-preview/")) finishedBodySizes.push(request.sizes().then((sizes) => sizes.responseBodySize));
  });

  await page.locator('input[type="file"]').setInputFiles({
    name: "range-performance.pdf",
    mimeType: "application/pdf",
    buffer: rangePdfFixture(),
  });
  await sendMessage(page, "profile this PDF");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();
  await page.getByTestId("msg-attachment").first().click();
  await expect(page.getByTestId("pdf-preview")).toBeVisible({ timeout: 15_000 });
  const pdfCanvas = (pageNumber: number) => page.locator(`[data-testid="pdf-canvas"][data-page-number="${pageNumber}"]`);
  const pdfPage = (pageNumber: number) => page.locator(`[data-testid="pdf-page"][data-page-number="${pageNumber}"]`);
  await expect(pdfCanvas(1)).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(page.getByTestId("pdf-page")).toHaveCount(2);

  const workbenchChrome = await page.getByTestId("file-view").evaluate((fileView) => {
    const preview = fileView.querySelector<HTMLElement>('[data-testid="pdf-preview"]');
    const toolbar = fileView.querySelector<HTMLElement>('[data-testid="pdf-toolbar"]');
    const header = fileView.querySelector<HTMLElement>('[data-testid="file-header"]');
    const stage = fileView.querySelector<HTMLElement>('[data-testid="pdf-stage"]');
    if (!preview || !toolbar || !header || !stage) throw new Error("workspace chrome fixtures missing");
    const fileLane = header.firstElementChild as HTMLElement | null;
    const closeLane = header.lastElementChild as HTMLElement | null;
    if (!fileLane || !closeLane) throw new Error("workspace title lanes missing");
    const fileBox = fileView.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const toolbarBox = toolbar.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    const fileLaneBox = fileLane.getBoundingClientRect();
    const closeLaneBox = closeLane.getBoundingClientRect();
    return {
      integrated: toolbar.dataset.integrated,
      toolbarInsideGestureRoot: preview.contains(toolbar),
      headerOffset: Math.round(headerBox.top - fileBox.top),
      toolbarOffset: Math.round(toolbarBox.top - fileBox.top),
      stageOffset: Math.round(stageBox.top - fileBox.top),
      clearsFileLaneBy: Math.round(toolbarBox.left - fileLaneBox.right),
      clearsCloseLaneBy: Math.round(closeLaneBox.left - toolbarBox.right),
    };
  });
  expect(workbenchChrome).toMatchObject({
    integrated: "true",
    toolbarInsideGestureRoot: true,
    headerOffset: 0,
  });
  expect(workbenchChrome.toolbarOffset).toBeLessThanOrEqual(8);
  expect(workbenchChrome.stageOffset).toBeLessThanOrEqual(64);
  expect(workbenchChrome.clearsFileLaneBy).toBeGreaterThanOrEqual(-1);
  expect(workbenchChrome.clearsCloseLaneBy).toBeGreaterThanOrEqual(-1);

  expect(textReads).toEqual([]);
  expect(previewRequests.length).toBeGreaterThan(0);
  expect(previewRequests.every((request) => request.range?.startsWith("bytes="))).toBe(true);
  expect(previewResponses.length).toBe(previewRequests.length);
  expect(previewResponses.every((response) => response.status === 206 && /^bytes \d+-\d+\/\d+$/.test(response.contentRange ?? ""))).toBe(true);
  const rangedBytes = previewRequests
    .map((request) => /bytes=(\d+)-(\d+)/.exec(request.range ?? ""))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .reduce((total, match) => total + Number(match[2]) - Number(match[1]) + 1, 0);
  expect(rangedBytes).toBeLessThan(rangePdfFixture().byteLength);
  const actualBodyBytes = (await Promise.all(finishedBodySizes)).reduce((total, bytes) => total + bytes, 0);
  expect(actualBodyBytes).toBeGreaterThan(0);
  expect(actualBodyBytes).toBeLessThan(rangePdfFixture().byteLength);
  expect(mintRequests).toBe(1);

  const noFlash = await page.getByTestId("pdf-stage").evaluate(async (stage) => {
    const zoomIn = stage.parentElement?.parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]');
    if (!zoomIn) throw new Error("zoom button missing");
    zoomIn.click();
    let blankFrames = 0;
    let sampledFrames = 0;
    const deadline = performance.now() + 450;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const stageRect = stage.getBoundingClientRect();
      const visibleCanvas = [...stage.querySelectorAll("canvas")].some((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const style = getComputedStyle(canvas);
        return canvas.width > 0 && canvas.height > 0
          && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0
          && rect.bottom > stageRect.top && rect.top < stageRect.bottom
          && rect.right > stageRect.left && rect.left < stageRect.right;
      });
      sampledFrames++;
      if (!visibleCanvas) blankFrames++;
    }
    return { blankFrames, sampledFrames };
  });
  expect(noFlash.sampledFrames).toBeGreaterThan(5);
  expect(noFlash.blankFrames).toBe(0);
  await expect(page.getByTestId("pdf-zoom")).toHaveText("110%");

  const zoomBeforePinch = Number((await page.getByTestId("pdf-zoom").textContent())?.replace("%", ""));
  const pinchStage = page.getByTestId("pdf-stage");
  const pinchResult = await pinchStage.evaluate((stage) => {
    const rect = stage.getBoundingClientRect();
    const canvas = stage.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas"][data-ready="true"]');
    if (!canvas) throw new Error("ready PDF canvas missing");
    const canvasWidthBefore = canvas.getBoundingClientRect().width;
    let prevented = true;
    for (let packet = 0; packet < 4; packet++) {
      prevented = !stage.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 0,
        deltaY: -2,
        deltaZ: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      })) && prevented;
    }
    return { prevented, canvasWidthBefore };
  });
  expect(pinchResult.prevented).toBe(true);
  await expect.poll(async () => Number((await page.getByTestId("pdf-zoom").textContent())?.replace("%", ""))).toBeGreaterThan(zoomBeforePinch);
  await expect.poll(() => pinchStage.evaluate((stage) => {
    const canvas = stage.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas"][data-ready="true"]');
    return canvas?.getBoundingClientRect().width ?? 0;
  })).toBeGreaterThan(pinchResult.canvasWidthBefore);

  const zoomBeforeScopedPinch = Number((await page.getByTestId("pdf-zoom").textContent())?.replace("%", ""));
  const gestureScope = await page.getByTestId("pdf-preview").evaluate((preview) => {
    const toolbar = preview.querySelector<HTMLElement>('[data-testid="pdf-toolbar"]');
    const composer = document.querySelector<HTMLElement>('[data-testid="composer"]');
    if (!toolbar || !composer) throw new Error("gesture scope fixtures missing");
    const dispatchPinchWheel = (target: HTMLElement) => target.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaX: 0,
      deltaY: -4,
      deltaZ: 0,
    }));
    return {
      insidePrevented: !dispatchPinchWheel(toolbar),
      outsidePrevented: !dispatchPinchWheel(composer),
      touchAction: getComputedStyle(preview).touchAction,
    };
  });
  expect(gestureScope).toEqual({
    insidePrevented: true,
    outsidePrevented: false,
    touchAction: "pan-x pan-y",
  });
  await expect.poll(async () => Number((await page.getByTestId("pdf-zoom").textContent())?.replace("%", ""))).toBeGreaterThan(zoomBeforeScopedPinch);

  const zoomBeforeWebKitPinch = Number((await page.getByTestId("pdf-zoom").textContent())?.replace("%", ""));
  const webKitGesture = await page.getByTestId("pdf-preview").evaluate((preview) => {
    const toolbar = preview.querySelector<HTMLElement>('[data-testid="pdf-toolbar"]');
    const stage = preview.querySelector<HTMLElement>('[data-testid="pdf-stage"]');
    if (!toolbar || !stage) throw new Error("WebKit gesture fixtures missing");
    const rect = stage.getBoundingClientRect();
    const dispatch = (type: string, scale: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        scale: { value: scale },
        clientX: { value: rect.left + rect.width / 2 },
        clientY: { value: rect.top + rect.height / 2 },
      });
      return !toolbar.dispatchEvent(event);
    };
    return {
      startPrevented: dispatch("gesturestart", 1),
      changePrevented: dispatch("gesturechange", 1.08),
      endPrevented: dispatch("gestureend", 1.08),
    };
  });
  expect(webKitGesture).toEqual({
    startPrevented: true,
    changePrevented: true,
    endPrevented: true,
  });
  await expect.poll(async () => Number((await page.getByTestId("pdf-zoom").textContent())?.replace("%", ""))).toBeGreaterThan(zoomBeforeWebKitPinch);
  const zoomBeforeTouchPinch = Number((await page.getByTestId("pdf-zoom").textContent())?.replace("%", ""));

  const touchPinchDispatched = await page.getByTestId("pdf-stage").evaluate((stage) => {
    const touch = (identifier: number, clientX: number, clientY: number) => {
      try {
        return new Touch({
          identifier,
          target: stage,
          clientX,
          clientY,
          screenX: clientX,
          screenY: clientY,
        });
      } catch {
        return null;
      }
    };
    const dispatch = (type: string, touches: Touch[], changedTouches: Touch[]) => stage.dispatchEvent(new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches,
      targetTouches: touches,
      changedTouches,
    }));
    const rect = stage.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const one = touch(1, rect.left + rect.width / 2 - 40, y);
    if (!one) return false;
    dispatch("touchstart", [one], [one]);
    const two = touch(2, rect.left + rect.width / 2 + 40, y);
    if (!two) return false;
    dispatch("touchstart", [one, two], [two]);
    const wideOne = touch(1, rect.left + rect.width / 2 - 70, y);
    const wideTwo = touch(2, rect.left + rect.width / 2 + 70, y);
    if (!wideOne || !wideTwo) return false;
    dispatch("touchmove", [wideOne, wideTwo], [wideOne, wideTwo]);
    const widerOne = touch(1, rect.left + rect.width / 2 - 90, y);
    const widerTwo = touch(2, rect.left + rect.width / 2 + 90, y);
    if (!widerOne || !widerTwo) return false;
    dispatch("touchmove", [widerOne, widerTwo], [widerOne, widerTwo]);
    dispatch("touchend", [], [widerOne, widerTwo]);
    return true;
  });
  if (touchPinchDispatched) {
    await expect.poll(async () => Number((await page.getByTestId("pdf-zoom").textContent())?.replace("%", ""))).toBeGreaterThan(zoomBeforeTouchPinch);
  }
  const zoomAfterPinch = await page.getByTestId("pdf-zoom").textContent();

  const stageBox = await page.getByTestId("pdf-stage").boundingBox();
  expect(stageBox).not.toBeNull();
  await page.mouse.move(stageBox!.x + stageBox!.width / 2, stageBox!.y + stageBox!.height / 2);
  await page.mouse.wheel(0, 1_200);
  await expect(page.getByLabel("Page number")).toHaveValue("2");
  await expect(page.getByTestId("pdf-zoom")).toHaveText(zoomAfterPinch ?? "");
  await expect(pdfCanvas(2)).toHaveAttribute("data-ready", "true");
  await expect(pdfPage(2)).toBeVisible();
  await page.mouse.wheel(0, -1_200);
  await expect(page.getByLabel("Page number")).toHaveValue("1");
  await expect(page.getByTestId("pdf-zoom")).toHaveText(zoomAfterPinch ?? "");

  const rangesBeforeZoom = previewRequests.length;
  const mintsBeforeLocation = mintRequests;
  await sendMessage(page, "/link uploads/range-performance.pdf#page=1&zoom=200&view=FitH");
  const zoomLink = page.locator('a[data-file="uploads/range-performance.pdf"][href="uploads/range-performance.pdf#page=1&zoom=200&view=FitH"]').last();
  await expect(zoomLink).toBeVisible();
  await zoomLink.click();
  await expect(page.getByTestId("pdf-toolbar")).toContainText("200%");
  await expect(pdfCanvas(1)).toHaveAttribute("data-ready", "true");
  expect(previewRequests.length).toBe(rangesBeforeZoom);
  expect(mintRequests).toBe(mintsBeforeLocation);

  await sendMessage(page, "/link uploads/range-performance.pdf#nameddest=second");
  const namedLink = page.locator('a[data-file="uploads/range-performance.pdf"][href="uploads/range-performance.pdf#nameddest=second"]').last();
  await expect(namedLink).toBeVisible();
  await namedLink.click();
  await expect(page.getByLabel("Page number")).toHaveValue("2");
  await expect(pdfCanvas(2)).toHaveAttribute("data-ready", "true");
  await expect(pdfCanvas(2)).toHaveAttribute("aria-label", "Page 2 of uploads/range-performance.pdf");
  expect(mintRequests).toBe(mintsBeforeLocation);

  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.getByLabel("Page number")).toHaveValue("1");
  await expect(pdfCanvas(1)).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByLabel("Page number")).toHaveValue("2");
  await expect(pdfCanvas(2)).toHaveAttribute("aria-label", "Page 2 of uploads/range-performance.pdf");
  expect(mintRequests).toBe(mintsBeforeLocation);

  await zoomLink.click();
  await expect(page.getByLabel("Page number")).toHaveValue("1");
  await namedLink.click();
  await expect(page.getByLabel("Page number")).toHaveValue("2");
  await expect(pdfCanvas(2)).toHaveAttribute("data-ready", "true");
  expect(mintRequests).toBe(mintsBeforeLocation);

  await page.getByRole("button", { name: "Close range-performance.pdf" }).click();
  await page.getByTestId("file-uploads").click();
  await page.getByTestId("file-range-performance.pdf").click();
  await expect(page.getByLabel("Page number")).toHaveValue("1");
  await expect(pdfCanvas(1)).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(150);
  await expect(page.getByLabel("Page number")).toHaveValue("1");
  expect(mintRequests).toBe(mintsBeforeLocation);

  await page.getByRole("button", { name: "Next page" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByLabel("Page number")).toHaveValue("2");
  await expect(page.getByTestId("pdf-toolbar")).toContainText("120%");
  const sourceUrlsBeforeReplacement = new Set(previewRequests.map((request) => request.url));
  await page.locator('input[type="file"]').setInputFiles({
    name: "range-performance.pdf",
    mimeType: "application/pdf",
    buffer: rangePdfFixture(true, "PDF RANGE E2E UPDATED"),
  });
  await sendMessage(page, "replace this PDF");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();
  await expect.poll(() => mintRequests).toBe(mintsBeforeLocation + 1);
  await expect.poll(() => previewRequests.some((request) => !sourceUrlsBeforeReplacement.has(request.url))).toBe(true);
  await expect(page.getByTestId("pdf-toolbar")).toContainText("/ 2");
  await expect(page.getByTestId("pdf-toolbar")).toContainText("120%");
  await expect(page.getByLabel("Page number")).toHaveValue("2");
  await expect(pdfCanvas(2)).toHaveAttribute("aria-label", "Page 2 of uploads/range-performance.pdf");
  await expect(pdfCanvas(2)).toHaveAttribute("data-ready", "true");
  expect(mintRequests).toBe(mintsBeforeLocation + 1);

  await page.setViewportSize({ width: 1169, height: 720 });
  await expect(pdfCanvas(2)).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("pdf-toolbar")).toHaveCSS("width", "336px");

  await page.setViewportSize({ width: 1150, height: 720 });
  await expect(pdfCanvas(2)).toHaveAttribute("data-ready", "true");
  const narrowWorkbench = await page.getByTestId("file-view").evaluate((fileView) => {
    const toolbar = fileView.querySelector<HTMLElement>('[data-testid="pdf-toolbar"]');
    const header = fileView.querySelector<HTMLElement>('[data-testid="file-header"]');
    const closeLane = header?.lastElementChild as HTMLElement | null;
    const readyCanvas = fileView.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas"][data-page-number="2"][data-ready="true"]');
    if (!toolbar || !header || !closeLane || !readyCanvas) throw new Error("narrow workbench fixtures missing");
    const fileBox = fileView.getBoundingClientRect();
    const toolbarBox = toolbar.getBoundingClientRect();
    const closeBox = closeLane.getBoundingClientRect();
    const canvasBox = readyCanvas.getBoundingClientRect();
    return {
      headerOverflow: header.scrollWidth - header.clientWidth,
      toolbarLeftInset: Math.round(toolbarBox.left - fileBox.left),
      toolbarRightClearance: Math.round(closeBox.left - toolbarBox.right),
      toolbarWidth: Math.round(toolbarBox.width),
      canvasPainted: readyCanvas.width > 0 && readyCanvas.height > 0 && canvasBox.width > 0 && canvasBox.height > 0,
    };
  });
  expect(narrowWorkbench.headerOverflow).toBeLessThanOrEqual(1);
  expect(narrowWorkbench.toolbarLeftInset).toBeGreaterThanOrEqual(0);
  expect(narrowWorkbench.toolbarRightClearance).toBeGreaterThanOrEqual(-1);
  expect(narrowWorkbench.toolbarWidth).toBe(208);
  expect(narrowWorkbench.canvasPainted).toBe(true);

  await expect(page.getByTestId("file-browser")).toBeHidden();
  await page.getByRole("button", { name: "File Tree", exact: true }).click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await expect(page.getByTestId("file-view")).toBeHidden();
  const mintsBeforeCompactReturn = mintRequests;
  await page.getByTestId("file-range-performance.pdf").click();
  await expect(page.getByTestId("file-view")).toBeVisible();
  await expect(pdfCanvas(2)).toHaveAttribute("data-ready", "true");
  expect(mintRequests).toBe(mintsBeforeCompactReturn);
});

test("PDF preview survives Retina pinch zoom and repeated sidebar/window resizing", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: String(test.info().project.use.baseURL),
    viewport: { width: 1_440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  try {
    await signup(page);
    await page.evaluate(() => localStorage.setItem("oiia.workspacePaneWidth", "860"));
    await createSession(page, { title: "PDF resize stability", approval: "never" });
    await page.locator('input[type="file"]').setInputFiles({
      name: "resize-stability.pdf",
      mimeType: "application/pdf",
      buffer: rangePdfFixture(),
    });
    await sendMessage(page, "stress this PDF viewer");
    await expect(page.getByTestId("msg-assistant").last()).toBeVisible();
    await page.getByTestId("msg-attachment").first().click();

    const stage = page.getByTestId("pdf-stage");
    await expect(stage).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="pdf-canvas"][data-page-number="1"]')).toHaveAttribute(
      "data-ready",
      "true",
      { timeout: 20_000 },
    );

    await stage.evaluate(async (node) => {
      const rect = node.getBoundingClientRect();
      for (let index = 0; index < 40; index++) {
        node.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaX: 0,
          deltaY: -4,
          deltaZ: 0,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await expect(page.getByTestId("pdf-zoom")).toHaveText("400%");
    await expect.poll(
      () => stage.locator('canvas[aria-hidden="true"]').count(),
      { message: "PDF.js entered its restricted-canvas detail-view path" },
    ).toBeGreaterThan(0);

    for (const viewport of [
      { width: 1_180, height: 820 },
      { width: 1_700, height: 960 },
      { width: 1_260, height: 860 },
      { width: 1_440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(35);
    }
    const separator = page.getByRole("separator", { name: "Resize panel" });
    for (const delta of [-220, 180, -160, 120]) {
      const box = await separator.boundingBox();
      if (!box) throw new Error("PDF panel resize handle missing");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + delta, y, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(35);
    }
    await page.waitForTimeout(650);

    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator('[data-testid="pdf-canvas"][data-page-number="1"]')).toHaveAttribute(
      "data-ready",
      "true",
    );
    const bitmap = await stage.evaluate((node) => {
      const canvases = [...node.querySelectorAll("canvas")];
      return {
        usable: canvases.some((canvas) => canvas.width > 0 && canvas.height > 0),
        maxArea: Math.max(0, ...canvases.map((canvas) => canvas.width * canvas.height)),
      };
    });
    expect(bitmap.usable).toBe(true);
    expect(bitmap.maxArea).toBeLessThanOrEqual(16 * 1024 * 1024);

    await page.getByRole("button", { name: "Fit to width" }).click();
    await expect(page.getByTestId("pdf-zoom")).toHaveText("100%");
    await stage.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      for (let index = 0; index < 40; index++) {
        node.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaX: 0,
          deltaY: -4,
          deltaZ: 0,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      }
    });
    await expect(page.getByTestId("pdf-zoom")).toHaveText("400%");
    await expect.poll(() => stage.locator('canvas[aria-hidden="true"]').count()).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator('[data-testid="pdf-canvas"][data-page-number="1"]')).toHaveAttribute(
      "data-ready",
      "true",
    );
  } finally {
    await context.close();
  }
});

test("Enter during IME composition confirms instead of sending (#73)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "IME", approval: "never" });
  const composer = page.getByTestId("composer");
  await composer.fill("ni hao");

  await composer.dispatchEvent("compositionstart");
  await composer.press("Enter");
  await expect(composer).not.toHaveValue("");
  await expect(page.getByTestId("msg-assistant")).toHaveCount(0);

  await composer.dispatchEvent("compositionend");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();
  await expect(composer).toHaveValue("");
});

test("terminal: PTY shell runs a command in the session sandbox (#39)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Terminal", approval: "never" });

  await page.getByTestId("open-terminal").click();
  const term = page.getByTestId("shell-terminal");
  await expect(term).toBeVisible();
  await expect(term).toHaveAttribute("data-state", "idle", { timeout: 15000 });
  await page.getByTestId("shell-new").click();
  await expect(term).toHaveAttribute("data-state", "open", { timeout: 15000 });

  await term.click();
  await page.keyboard.type("echo e2e_pty_marker_42");
  await page.keyboard.press("Enter");
  await expect(term).toContainText("e2e_pty_marker_42", { timeout: 10000 });
});

test("Automations: create + run-now (#46)", async ({ page }) => {
  await signup(page);

  await page.getByTestId("open-automations").click();
  await expect(page).toHaveURL(/\/automations$/);
  await expect(page.getByTestId("automations-view")).toBeVisible();

  await page.getByTestId("automation-name").fill("daily digest");
  await page.getByTestId("automation-prompt").fill("say hi");
  await page.getByTestId("automation-preset-everyHour").click();
  await page.getByTestId("automation-create-submit").click();

  const row = page.locator('[data-testid^="automation-row-"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("daily digest");
  await expect(row).toContainText("every 1h");

  await row.locator('[data-testid^="automation-run-"]').click();
  await expect(page.locator('[data-testid^="automation-run-result-"]')).toBeVisible();
});

test("context usage ring: appears after a turn and opens a breakdown (#64)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "ctx-ring", approval: "never" });

  await sendMessage(page, "hello");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();

  await expect(page.getByTestId("context-ring")).toBeVisible();
  await page.getByTestId("context-ring").click();
  const breakdown = page.getByTestId("context-breakdown");
  await expect(breakdown).toBeVisible();
  await expect(breakdown).toContainText("System prompt");
  await expect(breakdown).toContainText("Tool definitions");
  await expect(breakdown).toContainText("%");
});

test("build watermark uses the free corner on wide screens and the composer gutter on phones", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await signup(page);
  await createSession(page, { title: "Responsive build watermark", approval: "never" });

  const geometry = () => page.getByTestId("commit-hash").evaluate((node) => {
    const box = node.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-shell"]')?.getBoundingClientRect();
    return {
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      composerBottom: composer?.bottom ?? null,
      writingMode: getComputedStyle(node).writingMode,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });

  const desktop = await geometry();
  expect(desktop.writingMode).toBe("vertical-rl");
  expect(desktop.viewport.width - desktop.box.right).toBeLessThanOrEqual(5);
  expect(desktop.viewport.height - desktop.box.bottom).toBeLessThanOrEqual(8);
  expect(desktop.box.top).toBeGreaterThan(desktop.viewport.height / 2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const phone = await geometry();
  expect(phone.writingMode).toBe("horizontal-tb");
  expect(Math.abs((phone.box.left + phone.box.right) / 2 - phone.viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(phone.viewport.height - phone.box.bottom).toBeLessThanOrEqual(5);
  expect(phone.composerBottom).not.toBeNull();
  expect(phone.box.top).toBeGreaterThanOrEqual(phone.composerBottom! - 2);
});

test("composer contact stays shallow, surface-matched, and theme-neutral", async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await signup(page);
  await createSession(page, { title: "Composer contact", approval: "never" });
  const composer = page.getByTestId("composer");
  await composer.fill("Keep the contact edge quiet.");
  await composer.focus();

  const readContact = () => page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>(".oiia-composer-wrap")!;
    const edge = document.querySelector<HTMLElement>('[data-testid="composer-scroll-edge"]')!;
    const input = document.querySelector<HTMLElement>('[data-testid="composer"]')!;
    const edgeBox = edge.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    return {
      edgeHeight: edgeBox.height,
      edgeBottomGap: Math.abs(edgeBox.bottom - wrapBox.top),
      surface: getComputedStyle(wrap).backgroundColor,
      edgeBackground: getComputedStyle(edge).backgroundImage,
      inputShadow: getComputedStyle(input).boxShadow,
      inputRadius: getComputedStyle(input).borderTopLeftRadius,
    };
  });

  const light = await readContact();
  expect(light.edgeHeight).toBeCloseTo(20, 0);
  expect(light.edgeBottomGap).toBeLessThanOrEqual(1);
  expect(light.surface).toBe("rgb(251, 252, 248)");
  expect(light.edgeBackground).toContain("/ 0.24)");
  expect(light.inputRadius).toBe("24px");
  expect(light.inputShadow).toContain("0px 0px 0px 1px");
  expect(light.inputShadow).toContain("0px 2px 8px -6px");
  expect(light.inputShadow).not.toContain("0px 8px 24px -18px");
  expect(light.inputShadow).not.toContain("rgba(42, 47, 38");

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const dark = await readContact();
  expect(dark.edgeHeight).toBeCloseTo(20, 0);
  expect(dark.surface).toBe("rgb(26, 26, 26)");
  expect(dark.edgeBackground).toContain("rgb(26, 26, 26)");
  expect(dark.inputShadow).toContain("rgba(0, 0, 0, 0.72) 0px 2px 8px -6px");
  expect(dark.inputShadow).not.toContain("rgba(42, 47, 38");
});

test("composer keeps one field anchor through mid-turn actions and workbench resizing", async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 1_000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page);
  await createSession(page, { title: "Composer geometry", approval: "never" });
  await sendMessage(page, "first layout prompt");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();
  await sendMessage(page, "second layout prompt");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();

  type Rect = { left: number; right: number; width: number; center: number };
  const geometry = () => page.evaluate(() => {
    const rect = (testId: string): Rect => {
      const node = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (!node) throw new Error(`missing geometry node: ${testId}`);
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, center: box.left + box.width / 2 };
    };
    const firstRect = (selector: string): Rect => {
      const node = document.querySelector<HTMLElement>(selector);
      if (!node) throw new Error(`missing geometry node: ${selector}`);
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, center: box.left + box.width / 2 };
    };
    return {
      shell: rect("composer-shell"),
      row: rect("composer-row"),
      field: rect("composer"),
      primary: firstRect('[data-testid="send"], [data-testid="interrupt"], [data-testid="resend"]'),
      jumpAnchor: rect("jump-to-latest-anchor"),
      readerAnchor: rect("reader-actions-anchor"),
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  const expectAnchored = async () => {
    const current = await geometry();
    expect(Math.abs(current.field.center - current.row.center)).toBeLessThanOrEqual(1);
    expect(Math.abs(current.jumpAnchor.left - current.field.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(current.jumpAnchor.right - current.field.right)).toBeLessThanOrEqual(2);
    expect(current.documentWidth).toBeLessThanOrEqual(current.viewportWidth);
    if (current.row.width >= 1_024) {
      expect(Math.abs(current.readerAnchor.left - current.field.right)).toBeLessThanOrEqual(2);
      expect(current.readerAnchor.right).toBeGreaterThan(current.readerAnchor.left + 8);
      expect(current.primary.right).toBeLessThanOrEqual(current.field.right - 6);
      expect(current.primary.left).toBeGreaterThanOrEqual(current.field.right - 44);
    } else {
      expect(Math.abs(current.readerAnchor.left - current.field.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(current.readerAnchor.right - current.field.right)).toBeLessThanOrEqual(2);
    }
    return current;
  };

  const idle = await expectAnchored();
  await expectCircularComposerControl(page, "attach");
  await page.getByTestId("composer-overflow").click();
  await expect(page.getByTestId("composer-overflow-menu")).toBeVisible();
  await expectCircularComposerControl(page, "composer-overflow");
  await page.getByTestId("composer-overflow").click();
  await expect(page.getByTestId("composer-overflow-menu")).toBeHidden();

  await page.getByTestId("composer").fill("/bash sleep 20");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("running");
  await expectAnchored();
  await page.getByTestId("composer").fill("Review the output, then continue with the safer path.");
  await expect(page.getByTestId("steer")).toBeVisible();
  const withActions = await expectAnchored();
  expect(Math.abs(withActions.field.left - idle.field.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(withActions.field.right - idle.field.right)).toBeLessThanOrEqual(1);
  const queueBox = await page.getByTestId("queue").boundingBox();
  if (!queueBox) throw new Error("Queue action geometry is unavailable");
  expect(queueBox.x).toBeGreaterThanOrEqual(withActions.field.right + 6);

  await expect(page.getByTestId("reader-actions-dock")).toHaveCSS("opacity", "0");
  await page.getByTestId("composer").fill("");
  await expect(page.getByTestId("steer")).toBeHidden();
  await expect(page.getByTestId("reader-actions-dock")).toHaveCSS("opacity", "1");

  await page.getByRole("button", { name: "Toggle details panel" }).click();
  await expect(page.getByTestId("workspace-rail")).toBeVisible();
  await expect.poll(async () => (await geometry()).row.width).toBeLessThan(800);
  await expectAnchored();
  const separator = page.getByRole("separator", { name: "Resize panel" });
  for (const delta of [360, -280, 220]) {
    const box = await separator.boundingBox();
    if (!box) throw new Error("workspace resize handle missing");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 6 });
    await page.mouse.up();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expectAnchored();
  }
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  await expect(page.getByTestId("workspace-rail")).toBeHidden();

  for (const viewport of [
    { width: 980, height: 820 },
    { width: 720, height: 820 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expectAnchored();
    await expect.poll(() => page.getByTestId("composer").evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    if (viewport.width === 390) {
      await expect.poll(() => page.getByTestId("composer").evaluate((node) => node.clientHeight)).toBeGreaterThan(48);
    }
  }
});

test("the left control capsule clamps to its track instead of clipping under the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await signup(page);

  await openSettings(page);
  const row = page.locator(".key-row", { hasText: "anthropic" });
  await row.locator("input").fill("sk-ant-fake-key-for-layout-test-1234567890");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("····");

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await page.getByTestId("ns-title").fill("Satellite overflow");
  await openSessionAdvanced(page);
  const anthropicOption = page.locator('[data-testid="ns-model"] option[value^="anthropic::"]');
  await expect(anthropicOption.first()).toBeAttached();
  await page.getByTestId("ns-model").selectOption((await anthropicOption.first().getAttribute("value"))!);
  await page.getByTestId("ns-sandbox").selectOption("workspace-write");
  await page.getByTestId("ns-approval").selectOption("never");
  await page.getByTestId("ns-create").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("composer")).toBeVisible();

  const geometry = () => page.evaluate(() => {
    const container = document.querySelector('[data-testid="composer-shell"]')!.parentElement!.getBoundingClientRect();
    const cluster = document.querySelector('[data-testid="attach"]')!.parentElement!.getBoundingClientRect();
    const switcher = document.querySelector('[data-testid="model-switcher"]');
    return {
      containerLeft: container.left,
      containerWidth: container.width,
      clusterLeft: cluster.left,
      modelVisible: Boolean(switcher && switcher.getBoundingClientRect().width > 0),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

  await expect.poll(async () => (await geometry()).modelVisible).toBe(true);
  const wide = await geometry();
  expect(wide.containerWidth).toBeGreaterThanOrEqual(1_152);
  expect(wide.clusterLeft).toBeGreaterThanOrEqual(wide.containerLeft - 1);
  expect(wide.documentWidth).toBeLessThanOrEqual(wide.viewportWidth);

  await page.setViewportSize({ width: 1_340, height: 900 });
  await expect.poll(async () => (await geometry()).containerWidth).toBeGreaterThanOrEqual(1_024);
  const tight = await geometry();
  expect(tight.containerWidth).toBeLessThan(1_152);
  expect(tight.modelVisible).toBe(true);
  expect(tight.clusterLeft).toBeGreaterThanOrEqual(tight.containerLeft - 1);
  expect(tight.documentWidth).toBeLessThanOrEqual(tight.viewportWidth);
  const chipWidth = await page.evaluate(() => document.querySelector('[data-testid="model-switcher"]')!.getBoundingClientRect().width);
  expect(chipWidth).toBeLessThan(80);
});

test("outline jumps scroll only the timeline: the shell, window and composer never move", async ({ page }) => {
  await page.setViewportSize({ width: 1_100, height: 560 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page);
  await createSession(page, { title: "Outline jump containment", approval: "never" });
  for (const prompt of Array.from({ length: 6 }, (_, index) => `outline jump prompt ${index + 1}`)) {
    const before = await page.getByTestId("msg-assistant").count();
    await sendMessage(page, prompt);
    await expect(page.getByTestId("msg-assistant")).toHaveCount(before + 1);
    await expect(page.getByTestId("session-status")).toHaveText("idle");
  }

  const timeline = page.getByTestId("timeline");
  const toc = page.getByTestId("conversation-toc");
  const jumpTo = async (index: number) => {
    await toc.click();
    await expect(page.getByTestId("conversation-toc-panel")).toBeVisible();
    await page.getByTestId("toc-row").nth(index).click();
    await expect(page.getByTestId("conversation-toc-panel")).toBeHidden();
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  };
  const shellState = () =>
    page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(".oiia-composer-wrap")!.getBoundingClientRect();
      let ancestorScroll = 0;
      let el: HTMLElement | null = document.querySelector<HTMLElement>('[data-testid="timeline"]')!.parentElement;
      while (el) { ancestorScroll += el.scrollTop; el = el.parentElement; }
      return {
        windowScrollY: window.scrollY,
        ancestorScroll,
        composerBottom: Math.round(composer.bottom),
        viewportHeight: window.innerHeight,
        appVvh: getComputedStyle(document.documentElement).getPropertyValue("--app-vvh").trim(),
      };
    });

  await jumpTo(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const anchors = document.querySelectorAll<HTMLElement>('[id^="toc-"]');
        const timelineBox = document.querySelector<HTMLElement>('[data-testid="timeline"]')!.getBoundingClientRect();
        return Math.round(anchors[1].getBoundingClientRect().top - timelineBox.top);
      }),
    )
    .toBeLessThanOrEqual(10);
  const early = await shellState();
  expect(early.windowScrollY).toBe(0);
  expect(early.ancestorScroll).toBe(0);
  expect(early.composerBottom).toBe(early.viewportHeight);

  await jumpTo(5);
  const last = await shellState();
  expect(last.windowScrollY).toBe(0);
  expect(last.ancestorScroll).toBe(0);
  expect(last.composerBottom).toBe(last.viewportHeight);
  expect(last.appVvh === "" || last.appVvh === "100dvh").toBe(true);
});

test("reader actions stay beside the composer while session chrome keeps its width", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 620 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page);
  await createSession(page, { title: "Reader action chrome", approval: "never" });
  for (const prompt of Array.from({ length: 12 }, (_, index) => `reader prompt ${index + 1}`)) {
    const before = await page.getByTestId("msg-assistant").count();
    await sendMessage(page, prompt);
    await expect(page.getByTestId("msg-assistant")).toHaveCount(before + 1);
    await expect(page.getByTestId("msg-assistant").nth(before)).toBeVisible();
    await expect(page.getByTestId("session-status")).toHaveText("idle");
  }

  const header = page.getByTestId("top-header");
  const dock = page.getByTestId("reader-actions-dock");
  const toc = page.getByTestId("conversation-toc");
  const share = page.getByTestId("chat-share");
  await expect(dock.getByTestId("conversation-toc")).toBeVisible();
  await expect(dock.getByTestId("chat-share")).toBeVisible();
  await expect(header.getByTestId("conversation-toc")).toHaveCount(0);
  await expect(header.getByTestId("chat-share")).toHaveCount(0);
  await expect(share).toBeVisible();
  await expect(toc).toHaveCSS("box-shadow", "none");
  await expect(share).toHaveCSS("box-shadow", "none");
  await expect(dock).not.toHaveCSS("box-shadow", "none");
  await expect(dock).not.toHaveCSS("border-style", "none");
  const desktopShapes = await dock.locator("button").evaluateAll((buttons) => buttons.map((node) => {
    const box = node.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      radius: Number.parseFloat(getComputedStyle(node).borderTopLeftRadius),
    };
  }));
  expect(desktopShapes).toHaveLength(2);
  for (const shape of desktopShapes) {
    expect(shape.width).toBeCloseTo(32, 0);
    expect(shape.height).toBeCloseTo(32, 0);
    expect(shape.radius).toBeGreaterThanOrEqual(15.5);
  }

  await toc.evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["HEADER_DROP_PROBE"], "probe.txt", { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  });
  await expect(page.getByTestId("attachments")).toHaveCount(0);

  await page.setViewportSize({ width: 1_280, height: 480 });
  await toc.click();
  const panel = page.getByTestId("conversation-toc-panel");
  await expect(panel).toBeVisible();
  await expect(page.locator(':focus')).toHaveAttribute("role", "menuitem");
  const focusedVisibility = await page.locator(':focus').evaluate((row) => {
    const item = row.getBoundingClientRect();
    const menu = row.closest('[data-testid="conversation-toc-panel"]')!.getBoundingClientRect();
    return { itemTop: item.top, itemBottom: item.bottom, menuTop: menu.top, menuBottom: menu.bottom };
  });
  expect(focusedVisibility.itemTop).toBeGreaterThanOrEqual(focusedVisibility.menuTop);
  expect(focusedVisibility.itemBottom).toBeLessThanOrEqual(focusedVisibility.menuBottom);
  const focusedBefore = await page.locator(':focus').getAttribute("title");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(':focus')).toHaveAttribute("role", "menuitem");
  expect(await page.locator(':focus').getAttribute("title")).not.toBe(focusedBefore);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toc).toBeFocused();

  await toc.click();
  await expect(panel).toBeVisible();
  await expect(page.locator(':focus')).toHaveAttribute("role", "menuitem");
  await page.keyboard.press("Tab");
  await expect(panel).toBeHidden();
  await expect(toc).toBeFocused();

  await toc.click();
  await expect(panel).toBeVisible();
  await expect(page.locator(':focus')).toHaveAttribute("role", "menuitem");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  await expect(toc).toBeFocused();

  await share.click();
  await expect(page.getByTestId("share-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("share-dialog")).toBeHidden();
  await expect(share).toBeFocused();

  const headerBefore = await header.boundingBox();
  if (!headerBefore) throw new Error("top header geometry is unavailable");
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  const rail = page.getByTestId("workspace-rail");
  await expect(rail).toBeVisible();
  const headerAfter = await header.boundingBox();
  const railBox = await rail.boundingBox();
  if (!headerAfter || !railBox) throw new Error("open workbench geometry is unavailable");
  expect(Math.abs(headerAfter.x - headerBefore.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(headerAfter.width - headerBefore.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(headerAfter.x + headerAfter.width - (headerBefore.x + headerBefore.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(railBox.y - (headerAfter.y + headerAfter.height))).toBeLessThanOrEqual(1);
  const dockAlignment = await page.evaluate(() => {
    const field = document.querySelector<HTMLElement>('[data-testid="composer"]')!.getBoundingClientRect();
    const anchor = document.querySelector<HTMLElement>('[data-testid="reader-actions-anchor"]')!.getBoundingClientRect();
    return { fieldLeft: field.left, fieldRight: field.right, anchorLeft: anchor.left, anchorRight: anchor.right };
  });
  expect(Math.abs(dockAlignment.anchorLeft - dockAlignment.fieldLeft)).toBeLessThanOrEqual(2);
  expect(Math.abs(dockAlignment.anchorRight - dockAlignment.fieldRight)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  await expect(rail).toBeHidden();

  const timeline = page.getByTestId("timeline");
  await timeline.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const jump = page.getByTestId("jump-to-latest");
  await expect(jump).toHaveCSS("opacity", "1");
  await expect(jump).toContainText("Jump to latest");
  const centres = await page.evaluate(() => {
    const box = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.getBoundingClientRect();
    const field = box("composer");
    const button = box("jump-to-latest");
    return { field: field.left + field.width / 2, button: button.left + button.width / 2 };
  });
  expect(Math.abs(centres.field - centres.button)).toBeLessThanOrEqual(1);

  await toc.click();
  await expect(jump).toHaveCSS("opacity", "0");
  await expect(jump).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Escape");
  await expect(jump).toHaveCSS("opacity", "1");

  const approval = page.getByTestId("approval-switch");
  await approval.click();
  await expect(page.getByTestId("approval-menu")).toBeVisible();
  await expect(jump).toHaveCSS("opacity", "0");
  await expect(jump).toHaveAttribute("tabindex", "-1");
  await expect(dock).toHaveCSS("opacity", "0");
  await expect(toc).toHaveAttribute("tabindex", "-1");
  await expect(share).toHaveAttribute("tabindex", "-1");
  await page.setViewportSize({ width: 900, height: 480 });
  await expect(page.getByTestId("approval-menu")).toBeHidden();
  await expect(jump).toHaveCSS("opacity", "1");
  await expect(dock).toHaveCSS("opacity", "1");
  await page.setViewportSize({ width: 1_280, height: 480 });
  await expect(page.getByTestId("approval-menu")).toBeHidden();

  await jump.click();
  await expect.poll(() => timeline.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(40);
  await expect(jump).toHaveCSS("opacity", "0");
  await expect(timeline).toBeFocused();

  await page.setViewportSize({ width: 700, height: 844 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await timeline.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -600 }));
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(jump).toHaveCSS("opacity", "1");
  const tabletJumpBox = await jump.boundingBox();
  expect(tabletJumpBox?.width).toBeGreaterThanOrEqual(40);
  expect(tabletJumpBox?.height).toBeGreaterThanOrEqual(40);
  for (const action of [toc, share]) {
    const box = await action.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(40);
    expect(box?.height).toBeGreaterThanOrEqual(40);
  }
  await expect(page.getByTestId("github-star")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const tocBox = await toc.boundingBox();
  expect(tocBox?.width).toBeGreaterThanOrEqual(40);
  expect(tocBox?.height).toBeGreaterThanOrEqual(40);
  const shareBox = await share.boundingBox();
  expect(shareBox?.width).toBeGreaterThanOrEqual(40);
  expect(shareBox?.height).toBeGreaterThanOrEqual(40);
  await expect(header.getByTestId("chat-share")).toHaveCount(0);
  await share.focus();
  await share.press("Enter");
  await expect(page.getByTestId("share-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("share-dialog")).toBeHidden();
  await expect(share).toBeFocused();

  await page.setViewportSize({ width: 320, height: 700 });
  await expect
    .poll(async () => (await page.getByTestId("session-title").boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(32);
  await expect(page.getByTestId("github-star")).toHaveCount(0);
});

test("composer popovers: keyboard focus, Escape restore, and peer switching share one contract", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Composer popovers", approval: "never" });
  await sendMessage(page, "hello");
  await expect(page.getByTestId("context-ring")).toBeVisible();

  const approval = page.getByTestId("approval-switch");
  await approval.focus();
  await approval.press("Enter");
  const approvalMenu = page.getByTestId("approval-menu");
  await expect(approvalMenu).toBeVisible();
  await expect(page.getByTestId("approval-opt-never")).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("approval-opt-on-request")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(approvalMenu).toBeHidden();
  await expect(approval).toBeFocused();

  await approval.click();
  await expect(approvalMenu).toBeVisible();
  await page.getByTestId("context-ring").click();
  await expect(page.getByTestId("context-breakdown")).toBeVisible();
  await expect(approvalMenu).toBeHidden();
});

test("hover aim: crossing rows toward an open submenu never steals it (Amazon triangle)", async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page);

  await openSettings(page);
  const row = page.locator(".key-row", { hasText: "anthropic" });
  await row.locator("input").fill("sk-ant-fake-key-for-aim-test-1234567890");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("····");
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await page.getByTestId("ns-title").fill("Hover aim");
  await openSessionAdvanced(page);
  const anthropicOption = page.locator('[data-testid="ns-model"] option[value^="anthropic::"]');
  await expect(anthropicOption.first()).toBeAttached();
  await page.getByTestId("ns-model").selectOption((await anthropicOption.first().getAttribute("value"))!);
  await page.getByTestId("ns-approval").selectOption("never");
  await page.getByTestId("ns-create").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("composer")).toBeVisible();

  await page.getByTestId("composer-overflow").click();
  const dialog = page.getByTestId("composer-overflow-menu");
  await expect(dialog).toBeVisible();
  const approvalRow = dialog.getByTestId("approval-switch");
  const approvalBox = await approvalRow.boundingBox();
  if (!approvalBox) throw new Error("approval row geometry is unavailable");
  await page.mouse.move(approvalBox.x + approvalBox.width / 2, approvalBox.y + approvalBox.height / 2);
  const approvalMenu = page.getByTestId("approval-menu");
  await expect(approvalMenu).toBeVisible();

  const menuBox = await approvalMenu.boundingBox();
  if (!menuBox) throw new Error("approval submenu geometry is unavailable");
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2, { steps: 14 });
  await page.waitForTimeout(400);
  await expect(approvalMenu).toBeVisible();
  await expect(page.getByTestId("model-menu")).toBeHidden();
  await expect(page.getByTestId("thinking-menu")).toBeHidden();

  await page.mouse.move(approvalBox.x + approvalBox.width / 2, approvalBox.y + approvalBox.height / 2);
  await expect(approvalMenu).toBeVisible();
  const from = { x: approvalBox.x + approvalBox.width / 2, y: approvalBox.y + approvalBox.height / 2 };
  const to = { x: menuBox.x + menuBox.width / 2, y: menuBox.y + menuBox.height * 0.25 };
  const slowSteps = 24;
  for (let i = 1; i <= slowSteps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / slowSteps, from.y + ((to.y - from.y) * i) / slowSteps);
    await page.waitForTimeout(45);
  }
  await page.waitForTimeout(300);
  await expect(approvalMenu).toBeVisible();
  await expect(page.getByTestId("model-menu")).toBeHidden();
  await expect(page.getByTestId("thinking-menu")).toBeHidden();
});

test("composer hover intent: cold dwell, no graze pop, warm handoff, pinned survives peer hover", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page);
  await createSession(page, { title: "Composer hover intent", approval: "never" });
  await sendMessage(page, "hello");

  const approval = page.getByTestId("approval-switch");
  const approvalMenu = page.getByTestId("approval-menu");
  const contextRing = page.getByTestId("context-ring");
  const contextMenu = page.getByTestId("context-breakdown");
  const ringBox = await contextRing.boundingBox();
  const approvalBox = await approval.boundingBox();
  if (!ringBox || !approvalBox) throw new Error("composer control geometry is unavailable");
  const rowY = ringBox.y + ringBox.height / 2;

  await page.mouse.move(ringBox.x - 60, rowY);
  await page.mouse.move(approvalBox.x + approvalBox.width + 60, rowY, { steps: 6 });
  await page.mouse.move(approvalBox.x + approvalBox.width + 60, rowY + 120);
  await page.waitForTimeout(250);
  await expect(approvalMenu).toBeHidden();
  await expect(contextMenu).toBeHidden();

  await contextRing.hover();
  await expect(contextMenu).toBeVisible();
  await approval.hover();
  await expect(approvalMenu).toBeVisible();
  await expect(contextMenu).toBeHidden();

  await page.mouse.move(approvalBox.x + approvalBox.width / 2, rowY + 150);
  await expect(approvalMenu).toBeHidden();
  await approval.click();
  await expect(approvalMenu).toBeVisible();
  await contextRing.hover();
  await page.waitForTimeout(300);
  await expect(approvalMenu).toBeVisible();
  await expect(contextMenu).toBeHidden();
  await contextRing.click();
  await expect(contextMenu).toBeVisible();
  await expect(approvalMenu).toBeHidden();
});

test("composer hover popovers keep a safe triangle across the gap and close on deviation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page);
  await createSession(page, { title: "Composer safe triangle", approval: "never" });
  await sendMessage(page, "hello");

  const approval = page.getByTestId("approval-switch");
  const approvalMenu = page.getByTestId("approval-menu");
  const contextRing = page.getByTestId("context-ring");
  const contextMenu = page.getByTestId("context-breakdown");

  await approval.hover();
  await expect(approvalMenu).toBeVisible();
  const triggerBox = await approval.boundingBox();
  const menuBox = await approvalMenu.boundingBox();
  if (!triggerBox || !menuBox) throw new Error("composer popover geometry is unavailable");

  const start = {
    x: triggerBox.x + triggerBox.width - 4,
    y: triggerBox.y + 4,
  };
  const destination = {
    x: menuBox.x + 18,
    y: menuBox.y + menuBox.height - 10,
  };
  const gapY = (triggerBox.y + menuBox.y + menuBox.height) / 2;
  const progress = (start.y - gapY) / (start.y - destination.y);
  const gapX = start.x + (destination.x - start.x) * progress;

  await page.mouse.move(start.x, start.y);
  await page.mouse.move(gapX, gapY, { steps: 6 });
  await page.waitForTimeout(220);
  await expect(approvalMenu).toBeVisible();
  await page.mouse.move(destination.x, destination.y, { steps: 4 });
  await expect(approvalMenu).toBeVisible();

  await approval.hover();
  const viewport = page.viewportSize();
  await page.mouse.move(
    triggerBox.x + triggerBox.width / 2,
    Math.min((viewport?.height ?? 800) - 2, triggerBox.y + triggerBox.height + 8),
    { steps: 3 },
  );
  await expect(approvalMenu).toBeHidden({ timeout: 300 });

  await approval.hover();
  await expect(approvalMenu).toBeVisible();
  await contextRing.hover();
  await expect(contextMenu).toBeVisible();
  await expect(approvalMenu).toBeHidden();
});

test("touch composer overflow opens on the first activation and toggles closed", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 900, height: 760 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await signup(page);
    await createSession(page, { title: "Touch controls", approval: "never" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    const trigger = page.getByTestId("composer-overflow");
    const menu = page.getByTestId("composer-overflow-menu");
    await trigger.click();
    await expect(menu).toBeVisible();
    await expectCircularComposerControl(page, "attach");
    await expectCircularComposerControl(page, "composer-overflow");
    await expect(menu).toContainText("Approval policy");
    await expect(page.getByTestId("composer-overflow-settings")).toBeVisible();
    await expect(page.getByTestId("composer-overflow-status")).toBeVisible();

    const overflowRows = menu.locator("[data-composer-overflow-row]");
    await expect(overflowRows).toHaveCount(3);
    const overflowGeometry = await overflowRows.evaluateAll((rows) => rows.map((row) => {
      const rect = row.getBoundingClientRect();
      const button = row.querySelector("button");
      const icon = button?.querySelector(":scope > svg");
      const category = button?.querySelector("[data-composer-control-category]");
      const value = button?.querySelector("[data-composer-control-value]");
      const box = (element: Element | null | undefined) => {
        const part = element?.getBoundingClientRect();
        return part ? { left: part.left, right: part.right } : null;
      };
      return { left: rect.left, right: rect.right, height: rect.height, icon: box(icon), category: box(category), value: box(value) };
    }));
    expect(Math.max(...overflowGeometry.map((row) => row.left)) - Math.min(...overflowGeometry.map((row) => row.left))).toBeLessThan(0.5);
    expect(Math.max(...overflowGeometry.map((row) => row.right)) - Math.min(...overflowGeometry.map((row) => row.right))).toBeLessThan(0.5);
    expect(overflowGeometry.every((row) => row.height >= 40)).toBe(true);
    for (const column of ["icon", "category", "value"] as const) {
      const boxes = overflowGeometry.map((row) => row[column]);
      expect(boxes.every(Boolean)).toBe(true);
      const present = boxes.filter((box): box is { left: number; right: number } => box != null);
      expect(Math.max(...present.map((box) => box.left)) - Math.min(...present.map((box) => box.left))).toBeLessThan(0.5);
      expect(Math.max(...present.map((box) => box.right)) - Math.min(...present.map((box) => box.right))).toBeLessThan(0.5);
    }

    await trigger.click();
    await expect(menu).toBeHidden();

    await trigger.tap();
    await expect(menu).toBeVisible();

    await menu.getByTestId("approval-switch").tap();
    await expect(page.getByTestId("approval-menu")).toBeVisible();
    await expect(menu).toBeVisible();

    await expect(page.getByTestId("floating-actions-anchor")).toHaveCount(0);
    await expect(page.getByTestId("reader-actions-dock")).toBeVisible();
    await expect(menu).toBeVisible();
  } finally {
    await context.close();
  }
});

test("mock canvas uses a natural completion summary", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Canvas summary", approval: "never" });

  await sendMessage(page, "/canvas");
  await expect(page.getByTestId("canvas-card")).toBeVisible();
  const summary = page.getByTestId("msg-assistant").last();
  await expect(summary).toContainText("rendered a canvas card");
  await expect(summary).not.toContainText("I canvas");
});

test("Terminal view probes the selected target and does NOT auto-spawn (#78)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Terminal probe", approval: "never" });

  await page.getByTestId("open-terminal").click();
  await expect(page.getByTestId("shell-target")).toBeVisible();
  const term = page.getByTestId("shell-terminal");
  await expect(term).toBeVisible();
  await expect(term).toHaveAttribute("data-state", "idle", { timeout: 15000 });
  await expect(page.getByTestId("shell-empty")).toBeVisible();
});

test("Terminal mount/unmount releases ghostty document listeners", async ({ page }) => {
  await page.addInitScript(() => {
    const active = new Map<string, Set<EventListenerOrEventListenerObject>>([
      ["mousedown", new Set()],
      ["mouseup", new Set()],
    ]);
    const add = Document.prototype.addEventListener;
    const remove = Document.prototype.removeEventListener;
    Document.prototype.addEventListener = function (type, listener, options) {
      if (this === document && listener && active.has(type)) active.get(type)!.add(listener);
      return add.call(this, type, listener, options);
    } as typeof Document.prototype.addEventListener;
    Document.prototype.removeEventListener = function (type, listener, options) {
      if (this === document && listener && active.has(type)) active.get(type)!.delete(listener);
      return remove.call(this, type, listener, options);
    } as typeof Document.prototype.removeEventListener;
    Object.defineProperty(window, "__oiiaDocumentListenerCounts", {
      value: () => Object.fromEntries([...active].map(([type, listeners]) => [type, listeners.size])),
    });
  });

  await signup(page);
  await createSession(page, { title: "Terminal listener lifecycle", approval: "never" });

  const counts = () => page.evaluate(() => (
    window as Window & { __oiiaDocumentListenerCounts: () => Record<string, number> }
  ).__oiiaDocumentListenerCounts());
  const baseline = await counts();

  for (let iteration = 0; iteration < 4; iteration++) {
    await page.getByTestId("open-terminal").click();
    await expect(page.getByTestId("shell-terminal")).toHaveAttribute("data-state", "idle", { timeout: 15000 });
    await page.getByTestId("open-search").click();
    await expect(page.getByTestId("search-input")).toBeVisible();
    await expect.poll(counts).toEqual(baseline);
  }
});

test("explicit New terminal spawns + auto-reattaches on view switch (#78)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Terminal reattach", approval: "never" });

  await page.getByTestId("open-terminal").click();
  const term = page.getByTestId("shell-terminal");
  await expect(term).toHaveAttribute("data-state", "idle", { timeout: 15000 });

  await page.getByTestId("shell-new").click();
  await expect(term).toHaveAttribute("data-state", "open", { timeout: 15000 });

  const marker = `e2e_pty_reattach_${Date.now()}`;
  await term.click();
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press("Enter");
  await expect(term).toContainText(marker, { timeout: 10000 });

  await page.getByTestId("open-search").click();
  await expect(page.getByTestId("search-input")).toBeVisible();
  await page.getByTestId("open-terminal").click();
  await expect(term).toHaveAttribute("data-state", "open", { timeout: 15000 });
  await expect(term).toContainText(marker, { timeout: 10000 });
});

test("Terminal view does not duplicate the session's shell-tool history (#78)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Shell history", approval: "never" });

  await sendMessage(page, "/bash echo e2e_history_marker");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();
  const sessionUrl = page.url();

  await page.getByTestId("open-terminal").click();
  await expect(page.getByTestId("shell-target")).toBeVisible();
  await expect(page.getByTestId("shell-history")).toHaveCount(0);

  await page.goto(sessionUrl);
  await page.getByTestId("tool-bash").getByTestId("tool-open").click();
  await expect(page.getByTestId("tool-detail").getByTestId("shell-command"))
    .toContainText("echo e2e_history_marker", { timeout: 10000 });
});

test("thinking headline preview: collapsed Thinking label shows the reasoning summary line", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Think headline", approval: "never" });

  await sendMessage(page, "/bash echo hi");
  const toggle = page.getByTestId("thinking-toggle");
  await expect(toggle).toBeVisible({ timeout: 10000 });
  await expect(toggle).toContainText("tool results are in");
  await expect(toggle.locator('[data-thinking-preview-mode="prose"]')).toBeVisible();
  await expect(toggle.locator(".thinking-headline-motion")).toHaveCount(0);
});

test("admin LLM Inspector (Feature D): '···' opens captures with structured req/resp", async ({ page }) => {
  await authViaApi(page, "admin@e2e.dev");
  await createSession(page, { title: "Inspector", approval: "never" });

  await sendMessage(page, "/write note.txt\nhello inspector");
  await expect(page.getByTestId("tool-write_file").getByTestId("tool-status")).toHaveText("success");
  await expect(page.getByTestId("msg-assistant").last()).toBeVisible();

  await page.getByTestId("overflow-menu").click();
  await expect(page.getByTestId("overflow-menu-panel")).toBeVisible();
  await page.getByTestId("admin-inspector-open").click();

  const panel = page.getByTestId("admin-inspector");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("mock-coder");
  await expect(panel.getByTestId("json-tree").first()).toBeVisible();
  await panel.getByTestId("json-mode-raw").first().click();
  await expect(panel.getByTestId("json-view").first()).toBeVisible();
  await expect(panel).toContainText("hello inspector");
  await page.getByText("Headers", { exact: true }).click();
  await expect(panel).toContainText("content-type");
  await expect(panel.getByText("Replay", { exact: true })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("admin replay endpoint: operator-channel-only + admin-only gating", async ({ page }) => {
  await authViaApi(page, "admin2@e2e.dev");
  await createSession(page, { title: "Replay gate", approval: "never" });
  await sendMessage(page, "/write r.txt\nreplay gate");
  await expect(page.getByTestId("tool-write_file").getByTestId("tool-status")).toHaveText("success");

  const gate = await page.evaluate(async () => {
    const tok = localStorage.getItem("agentweb.token");
    const h = { authorization: "Bearer " + tok, "content-type": "application/json" };
    const sessions = await (await fetch("/api/sessions", { headers: h })).json();
    const sid = sessions.sessions[0].id;
    const caps = await (await fetch(`/api/admin/sessions/${sid}/captures`, { headers: h })).json();
    const mid = caps.captures[0].messageId;
    const r = await fetch(`/api/admin/sessions/${sid}/captures/${mid}/replay`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ request: { model: "mock-coder", input: "hi" } }),
    });
    return { sid, status: r.status, body: await r.json() };
  });
  expect(gate.status).toBe(400);
  expect(String(gate.body.error)).toContain("0AI-jail");

  const forbidden = await page.evaluate(async (sid) => {
    const r = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `nonadmin_${Date.now()}@test.dev`, password: "password123" }),
    });
    const tok = (await r.json()).token;
    const rep = await fetch(`/api/admin/sessions/${sid}/captures/x/replay`, {
      method: "POST",
      headers: { authorization: "Bearer " + tok, "content-type": "application/json" },
      body: JSON.stringify({ request: {} }),
    });
    return rep.status;
  }, gate.sid);
  expect(forbidden).toBe(403);
});

test("admin gate: a non-admin's '···' shows no inspector menu", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "No admin", approval: "never" });

  await page.getByTestId("overflow-menu").click();
  await expect(page.getByTestId("overflow-menu-panel")).toBeVisible();
  await expect(page.getByTestId("admin-inspector-open")).toHaveCount(0);
});

test("OG-preview: active share injects correct meta; revoke + bogus token serve generic card (no title leak)", async ({ page }) => {
  const DISTINCTIVE_TITLE = "OG_LEAK_CANARY_e2e_7f3a9b2c";
  const GENERIC_OG_TITLE = "Shared conversation · oiia";

  await signup(page);
  await createSession(page, { title: DISTINCTIVE_TITLE, approval: "never" });

  const shareResult = await page.evaluate(async (title) => {
    const token = localStorage.getItem("agentweb.token");
    const h = { "content-type": "application/json", authorization: "Bearer " + token };

    const sessionsResp = await fetch("/api/sessions", { headers: h });
    const sessionsJson = await sessionsResp.json() as { sessions: Array<{ id: string; title: string }> };
    const session = sessionsJson.sessions.find((s) => s.title === title);
    if (!session) return { error: "session not found", sessions: sessionsJson.sessions.map((s) => s.title) };

    const shareResp = await fetch(`/api/sessions/${session.id}/share`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({}),
    });
    const shareJson = await shareResp.json() as { token: string; url: string };
    return { shareToken: shareJson.token, shareUrl: shareJson.url, sessionId: session.id };
  }, DISTINCTIVE_TITLE);

  expect(shareResult).not.toHaveProperty("error");
  const shareToken = (shareResult as { shareToken: string; shareUrl: string; sessionId: string }).shareToken;
  const shareUrl = (shareResult as { shareToken: string; shareUrl: string; sessionId: string }).shareUrl;

  const activeHtml = await page.evaluate(async (token) => {
    const r = await fetch(`/share/${token}`);
    return r.text();
  }, shareToken);

  expect(activeHtml).toContain(`${DISTINCTIVE_TITLE} · oiia`);
  expect(activeHtml).toContain("/og-card.png");
  expect(activeHtml).toContain("summary_large_image");
  expect(activeHtml).toContain(shareToken);
  expect(activeHtml).toContain("noindex");
  const activeHeaders = await page.evaluate(async (token) => {
    const r = await fetch(`/share/${token}`);
    return r.headers.get("x-robots-tag") ?? "";
  }, shareToken);
  expect(activeHeaders).toContain("noindex");

  await page.evaluate(async (token) => {
    const bearerToken = localStorage.getItem("agentweb.token");
    await fetch(`/api/share/${token}`, {
      method: "DELETE",
      headers: { authorization: "Bearer " + bearerToken },
    });
  }, shareToken);

  const revokedHtml = await page.evaluate(async (token) => {
    const r = await fetch(`/share/${token}`);
    return r.text();
  }, shareToken);

  expect(revokedHtml).toContain(GENERIC_OG_TITLE);
  expect(revokedHtml).not.toContain(DISTINCTIVE_TITLE);
  expect(revokedHtml).toContain("noindex");

  const bogusToken = "A".repeat(43);
  const bogusHtml = await page.evaluate(async (token) => {
    const r = await fetch(`/share/${token}`);
    return r.text();
  }, bogusToken);

  expect(bogusHtml).toContain(GENERIC_OG_TITLE);
  expect(bogusHtml).not.toContain(DISTINCTIVE_TITLE);
  expect(bogusHtml).toContain("noindex");

  const ogCardStatus = await page.evaluate(async () => {
    const r = await fetch("/og-card.png");
    return { status: r.status, contentType: r.headers.get("content-type") ?? "" };
  });
  expect(ogCardStatus.status).toBe(200);
  expect(ogCardStatus.contentType).toContain("image/png");

  expect(shareUrl).toContain(`/share/${shareToken}`);
});

test("markdown file links: workspace link opens side-panel; external link keeps target=_blank; page does not navigate", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "File link md", approval: "never" });

  await sendMessage(page, "/write caufinder.md\n# Caufinder Guide");
  await expect(page.getByTestId("tool-write_file").getByTestId("tool-status")).toHaveText("success");

  await sendMessage(page, "/link caufinder.md");
  const assistantMsg = page.getByTestId("msg-assistant").last();
  await expect(assistantMsg).toContainText("Here is the file:");

  const workspaceLink = assistantMsg.locator('a[data-file="caufinder.md"]');
  await expect(workspaceLink).toBeVisible();
  await expect(workspaceLink).toContainText("caufinder.md");

  const externalLink = assistantMsg.locator('a[href="https://example.com/docs"]');
  await expect(externalLink).toBeVisible();
  await expect(externalLink).toHaveAttribute("target", "_blank");

  const urlBefore = page.url();
  await workspaceLink.click();
  expect(page.url()).toBe(urlBefore);

  const fileView = page.getByTestId("file-view");
  await expect(fileView).toContainText("Caufinder Guide", { timeout: 10000 });
  await expect(fileView.locator("h1")).toContainText("Caufinder Guide");
});

test("standalone workspace image link stays bounded and frameless, mints lazily, and opens the full preview", async ({ page }) => {
  await page.setViewportSize({ width: 1_100, height: 760 });
  await signup(page);
  await createSession(page, { title: "Inline workspace image", approval: "never" });
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.slice(3));

  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z8Dwn4EIwDiKBgD+/g/9k0nXAAAAAABJRU5ErkJggg==";
  await page.evaluate(async ({ id, png }) => {
    const token = localStorage.getItem("agentweb.token");
    const response = await fetch(`/api/sessions/${id}/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ files: [{ name: "shot.png", dataBase64: png }] }),
    });
    if (!response.ok) throw new Error(`image seed failed: ${response.status}`);
  }, { id: sessionId, png: PNG });

  await page.evaluate(() => {
    type DeferredObserver = {
      callback: IntersectionObserverCallback;
      targets: Set<Element>;
      instance: IntersectionObserver;
    };
    const observers: DeferredObserver[] = [];
    class DeferredIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "360px 0px";
      readonly thresholds = [0];
      private readonly record: DeferredObserver;
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, targets: new Set(), instance: this as unknown as IntersectionObserver };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.add(target); }
      unobserve(target: Element) { this.record.targets.delete(target); }
      disconnect() { this.record.targets.clear(); }
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    (window as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
      DeferredIntersectionObserver as unknown as typeof IntersectionObserver;
    (window as unknown as { revealWorkspaceImages: () => void }).revealWorkspaceImages = () => {
      for (const observer of observers) {
        const entries = [...observer.targets]
          .filter((target) => target.matches('[data-workspace-image-root]'))
          .map((target) => ({ isIntersecting: true, target })) as IntersectionObserverEntry[];
        if (entries.length) observer.callback(entries, observer.instance);
      }
    };
  });

  let mintRequests = 0;
  let textReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === `/api/sessions/${sessionId}/file-preview`) mintRequests++;
    if (request.method() === "GET" && url.pathname === `/api/sessions/${sessionId}/file` && url.searchParams.get("path") === "uploads/shot.png") textReads++;
  });

  await sendMessage(page, "/link uploads/shot.png");
  const assistantMsg = page.getByTestId("msg-assistant").last();
  const preview = assistantMsg.getByTestId("workspace-image-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-file", "uploads/shot.png");
  await expect(preview).toHaveAttribute("data-state", "idle");
  expect(mintRequests).toBe(0);
  await expect(assistantMsg.locator('a[data-file="uploads/shot.png"]')).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { revealWorkspaceImages: () => void }).revealWorkspaceImages());
  await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10_000 });
  await expect.poll(() => mintRequests).toBe(1);
  expect(textReads).toBe(0);

  const image = preview.getByTestId("workspace-image");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image).toHaveAttribute("decoding", "async");
  const cardBox = await preview.boundingBox();
  const viewportBox = await preview.getByTestId("workspace-image-viewport").boundingBox();
  if (!cardBox || !viewportBox) throw new Error("workspace image geometry unavailable");
  expect(cardBox.width).toBeLessThanOrEqual(544.5);
  expect(viewportBox.height).toBeLessThanOrEqual(340.5);
  expect(Math.abs(viewportBox.width / viewportBox.height - 1.6)).toBeLessThan(0.02);
  const chrome = await preview.evaluate((node) => {
    const style = getComputedStyle(node);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius, shadow: style.boxShadow };
  });
  expect(chrome).toEqual({ border: "0px", radius: "0px", shadow: "none" });
  const imageChrome = await image.evaluate((node) => {
    const style = getComputedStyle(node);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius, margin: style.marginTop };
  });
  expect(imageChrome).toEqual({ border: "0px", radius: "0px", margin: "0px" });

  const urlBefore = page.url();
  await preview.click();
  expect(page.url()).toBe(urlBefore);
  await expect(page.getByTestId("file-view").locator('img[alt="uploads/shot.png"]')).toBeVisible({ timeout: 10_000 });
  expect(mintRequests).toBe(1);
});

test("large reader image shows determinate byte progress while downloading", async ({ page }) => {
  test.setTimeout(90_000);
  await signup(page);
  await createSession(page, { title: "Image progress", approval: "never" });
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.slice(3));

  const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z8Dwn4EIwDiKBgD+/g/9k0nXAAAAAABJRU5ErkJggg==";
  const padded = Buffer.concat([Buffer.from(tiny, "base64"), Buffer.alloc(1_200_000)]).toString("base64");
  await page.evaluate(async ({ id, dataBase64 }) => {
    const token = localStorage.getItem("agentweb.token");
    const response = await fetch(`/api/sessions/${id}/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ files: [{ name: "big.png", dataBase64 }] }),
    });
    if (!response.ok) throw new Error(`image seed failed: ${response.status}`);
  }, { id: sessionId, dataBase64: padded });

  await sendMessage(page, "/link uploads/big.png");
  const preview = page.getByTestId("msg-assistant").last().getByTestId("workspace-image-preview");
  await expect(preview).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 10,
    downloadThroughput: 300 * 1024,
    uploadThroughput: -1,
  });
  await preview.scrollIntoViewIfNeeded();

  const ring = preview.getByTestId("byte-progress");
  await expect(ring).toBeVisible({ timeout: 15_000 });
  const seen = Number(await ring.getAttribute("aria-valuenow"));
  expect(seen).toBeGreaterThanOrEqual(0);
  expect(seen).toBeLessThanOrEqual(100);
  await expect(ring).toContainText("MB");
  await expect
    .poll(async () => Number(await ring.getAttribute("aria-valuenow").catch(() => "100")), { timeout: 15_000 })
    .toBeGreaterThan(seen);

  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(preview.getByTestId("workspace-image")).toBeVisible();
});

test("markdown CJK emphasis: ** and ~~ close next to CJK punctuation (no literal asterisks)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "CJK markdown", approval: "never" });

  await sendMessage(page, "/say **我不知道你的真实姓名、身份或个人隐私。**我只能确认你在使用云端服务,~~这句已删除。~~继续说明。");
  const msg = page.getByTestId("msg-assistant").last();
  await expect(msg.locator("strong")).toHaveText("我不知道你的真实姓名、身份或个人隐私。");
  await expect(msg.locator("del")).toHaveText("这句已删除。");
  await expect(msg).not.toContainText("**");
  await expect(msg).not.toContainText("~~");

  await sendMessage(page, "/say Plain **bold works.** And _italics_ too.");
  const latin = page.getByTestId("msg-assistant").last();
  await expect(latin.locator("strong")).toHaveText("bold works.");
  await expect(latin.locator("em")).toHaveText("italics");
  await expect(latin).not.toContainText("**");
});

test("inline workspace image remints once after a transient media failure", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Inline image retry", approval: "never" });
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.slice(3));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z8Dwn4EIwDiKBgD+/g/9k0nXAAAAAABJRU5ErkJggg==";
  await page.evaluate(async ({ id, dataBase64 }) => {
    const token = localStorage.getItem("agentweb.token");
    const response = await fetch(`/api/sessions/${id}/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ files: [{ name: "retry.png", dataBase64 }] }),
    });
    if (!response.ok) throw new Error(`image seed failed: ${response.status}`);
  }, { id: sessionId, dataBase64: png });

  let mediaGets = 0;
  let mintRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === `/api/sessions/${sessionId}/file-preview`) mintRequests++;
  });
  await page.route("**/api/file-preview/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    mediaGets++;
    if (mediaGets === 1) return route.abort("failed");
    return route.continue();
  });

  await sendMessage(page, "/link uploads/retry.png");
  const preview = page.getByTestId("msg-assistant").last().getByTestId("workspace-image-preview");
  await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(preview.getByTestId("workspace-image")).toBeVisible();
  expect(mediaGets).toBe(2);
  expect(mintRequests).toBe(2);
});

test("file preview LRU refetches an evicted open tab", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await signup(page);
  await createSession(page, { title: "File preview LRU", approval: "never" });
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.slice(3));
  const names = Array.from({ length: 9 }, (_, index) => `cache-${index}.txt`);
  await page.evaluate(async ({ id, files }) => {
    const token = localStorage.getItem("agentweb.token");
    await Promise.all(files.map(async (name, index) => {
      const response = await fetch(`/api/sessions/${id}/file`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: name, content: `bounded cache content ${index}` }),
      });
      if (!response.ok) throw new Error(`failed to seed ${name}`);
    }));
  }, { id: sessionId, files: names });

  let firstFileReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/sessions/${sessionId}/file` && url.searchParams.get("path") === names[0]) firstFileReads++;
  });

  await openFilePanel(page);
  for (let index = 0; index < names.length; index++) {
    await page.getByTestId(`file-${names[index]}`).click();
    await expect(page.getByTestId("file-view")).toContainText(`bounded cache content ${index}`);
    await expect(page.getByTestId("file-browser")).toBeVisible();
  }
  expect(firstFileReads).toBe(1);

  await page.getByTestId("file-view").getByRole("button", { name: names[0], exact: true }).click();
  await expect(page.getByTestId("file-view")).toContainText("bounded cache content 0");
  expect(firstFileReads).toBe(2);
});

test.describe.serial("diagram rendering", () => {
test("mermaid diagrams render with source copy, size toggle, and fullscreen", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signup(page);
  await createSession(page, { title: "Mermaid controls", approval: "never" });

  await sendMessage(page, "/mermaid");
  const assistant = page.getByTestId("msg-assistant").last();
  const shell = assistant.locator(".mermaid-shell");
  const diagram = assistant.getByTestId("mermaid-diagram");
  const svg = diagram.locator("svg");

  await expect(svg).toBeVisible({ timeout: 10000 });
  await expect(shell).toHaveAttribute("data-fit", "width");
  await expect(assistant.locator(".codeblock-shell")).toHaveCount(0);

  const fitBoxes = await Promise.all([diagram.boundingBox(), svg.boundingBox()]);
  expect(fitBoxes[0]).not.toBeNull();
  expect(fitBoxes[1]).not.toBeNull();
  expect(fitBoxes[1]!.width).toBeLessThanOrEqual(fitBoxes[0]!.width + 1);
  expect(await diagram.evaluate((node) => Number.parseFloat(getComputedStyle(node).maxHeight))).toBeLessThanOrEqual(320);

  await assistant.getByTestId("mermaid-size-toggle").click();
  await expect(shell).toHaveAttribute("data-fit", "actual");
  await assistant.getByTestId("mermaid-size-toggle").click();
  await expect(shell).toHaveAttribute("data-fit", "width");

  await assistant.getByTestId("mermaid-copy").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("flowchart LR");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Backend HTTP API");

  await assistant.getByTestId("mermaid-fullscreen").click();
  const dialog = page.locator(".mermaid-fullscreen-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".mermaid-fullscreen-host svg")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("D2 is compiler-checked before display and keeps the shared diagram controls", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signup(page);
  await createSession(page, { title: "D2 compiler flow", approval: "never" });

  await sendMessage(page, "/lintd2");
  const lint = page.getByTestId("tool-diagram_lint");
  await expect(lint).toBeVisible();
  await expect(lint.getByTestId("tool-status")).toHaveText("success", { timeout: 20000 });

  const assistant = page.getByTestId("msg-assistant").last();
  const shell = assistant.locator(".d2-shell");
  const diagram = assistant.getByTestId("d2-diagram");
  const svg = diagram.locator("svg").first();
  await expect(svg).toBeVisible({ timeout: 20000 });
  await expect(shell).toHaveAttribute("data-fit", "width");
  await expect(assistant).toContainText("Compiler passed");
  await expect(svg).toHaveAttribute("aria-label", "D2 diagram");
  expect(await diagram.evaluate((node) => Number.parseFloat(getComputedStyle(node).maxHeight))).toBeLessThanOrEqual(320);

  await assistant.getByTestId("d2-copy").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Compiler / lint");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("输入");

  await assistant.getByTestId("d2-size-toggle").click();
  await expect(shell).toHaveAttribute("data-fit", "actual");
  await assistant.getByTestId("d2-fullscreen").click();
  const dialog = page.locator(".d2-fullscreen-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".d2-fullscreen-host svg").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("diagram compiler errors return to the agent and invalid D2 stays copyable", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "D2 compiler errors", approval: "never" });

  await sendMessage(page, "/badlintd2");
  await expect(page.getByTestId("tool-diagram_lint").getByTestId("tool-status")).toHaveText("success", { timeout: 20000 });
  const feedback = page.getByTestId("msg-assistant").last();
  await expect(feedback).toContainText("INVALID d2 diagram");
  await expect(feedback).toContainText("missing destination");
  await expect(feedback.getByTestId("d2-diagram")).toHaveCount(0);

  await sendMessage(page, "/badd2");
  const fallback = page.getByTestId("msg-assistant").last();
  await expect(fallback.getByTestId("d2-pending")).toBeVisible({ timeout: 5000 });
  await expect(fallback.getByTestId("d2-error")).toBeVisible({ timeout: 5000 });
  await expect(fallback.locator(".codeblock-shell")).toContainText("a ->");
});

test("D2 compiler output cannot retain active links or remote media", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.invalid/")) externalRequests.push(request.url());
  });
  await signup(page);
  await createSession(page, { title: "D2 output hardening", approval: "never" });

  await sendMessage(page, "/lintd2unsafe");
  await expect(page.getByTestId("tool-diagram_lint").getByTestId("tool-status")).toHaveText("success", { timeout: 20000 });
  const svg = page.getByTestId("msg-assistant").last().getByTestId("d2-diagram").locator("svg").first();
  await expect(svg).toBeVisible({ timeout: 20000 });
  await expect(svg.locator("image, script, iframe, object, embed, foreignObject img, foreignObject style")).toHaveCount(0);
  await expect(svg.locator("[src], [srcset], [poster], [action], [formaction]")).toHaveCount(0);
  expect(await svg.locator("[href], [xlink\\:href]").evaluateAll((nodes) => nodes.map((node) =>
    node.getAttribute("href") ?? node.getAttribute("xlink:href"),
  ))).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("tall Mermaid and D2 diagrams stay in a bounded inline viewport", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Bounded diagrams", approval: "never" });

  for (const [command, language] of [["/tallmermaid", "mermaid"], ["/talld2", "d2"]] as const) {
    await sendMessage(page, command);
    const viewport = page.getByTestId("msg-assistant").last().getByTestId(`${language}-diagram`);
    await expect(viewport.locator("svg").first()).toBeVisible({ timeout: 20000 });
    const bounds = await viewport.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      maxHeight: Number.parseFloat(getComputedStyle(node).maxHeight),
    }));
    expect(bounds.maxHeight).toBeLessThanOrEqual(320);
    expect(bounds.clientHeight).toBeLessThanOrEqual(321);
    expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight);
  }
});

test("invalid mermaid hides streaming source first, then falls back to copyable code", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signup(page);
  await createSession(page, { title: "Bad mermaid fallback", approval: "never" });

  await sendMessage(page, "/badmermaid");
  const assistant = page.getByTestId("msg-assistant").last();

  await expect(assistant.getByTestId("mermaid-pending")).toBeVisible({ timeout: 5000 });
  await expect(assistant.locator(".codeblock-shell")).toBeVisible({ timeout: 5000 });
  await expect(assistant.locator(".codeblock-shell")).toContainText("flowchart LR");

  await assistant.getByLabel("Copy code").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("A -->");
});
});

test("streaming math stays neutral and commits without changing its reserved height", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Stable streaming math", approval: "never" });

  await page.evaluate(() => {
    type Sample = { pendingHeight: number | null; formulaHeight: number | null; errors: number };
    const state = { samples: [] as Sample[], frame: 0 };
    const sample = () => {
      const messages = document.querySelectorAll('[data-testid="msg-assistant"]');
      const message = messages[messages.length - 1];
      const pending = message?.querySelector('.stream-math-placeholder--display');
      const formula = message?.querySelector('.katex-display');
      state.samples.push({
        pendingHeight: pending?.getBoundingClientRect().height ?? null,
        formulaHeight: formula?.getBoundingClientRect().height ?? null,
        errors: message?.querySelectorAll('.katex-error').length ?? 0,
      });
      state.frame = requestAnimationFrame(sample);
    };
    state.frame = requestAnimationFrame(sample);
    (window as unknown as { streamingMathSamples: typeof state }).streamingMathSamples = state;
  });

  const response = `/say Before\n\n\\[${" ".repeat(240)}\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\\]\n\nAfter`;
  await sendMessage(page, response);
  const assistant = page.getByTestId("msg-assistant").last();
  await expect(assistant.locator(".katex-display")).toBeVisible();
  await expect(assistant.locator(".katex-error")).toHaveCount(0);

  const samples = await page.evaluate(() => {
    const state = (window as unknown as {
      streamingMathSamples: {
        samples: Array<{ pendingHeight: number | null; formulaHeight: number | null; errors: number }>;
        frame: number;
      };
    }).streamingMathSamples;
    cancelAnimationFrame(state.frame);
    return state.samples;
  });
  const pendingHeight = samples.find((sample) => sample.pendingHeight != null)?.pendingHeight;
  const formulaHeight = samples.find((sample) => sample.formulaHeight != null)?.formulaHeight;
  expect(pendingHeight).not.toBeNull();
  expect(pendingHeight).not.toBeUndefined();
  expect(formulaHeight).not.toBeNull();
  expect(formulaHeight).not.toBeUndefined();
  expect(Math.abs(pendingHeight! - formulaHeight!)).toBeLessThanOrEqual(1);
  expect(samples.every((sample) => sample.errors === 0)).toBe(true);
});

test("single-dollar formulas stay atomic and their bars do not split GFM table cells", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Math table boundaries", approval: "never" });

  await page.evaluate(() => {
    const state = { leaked: false, animatedTable: false, frame: 0 };
    const sample = () => {
      const messages = document.querySelectorAll<HTMLElement>('[data-testid="msg-assistant"]');
      const latest = messages[messages.length - 1];
      if (latest) {
        if (latest.querySelector('table [data-stream-word]')) state.animatedTable = true;
        const copy = latest.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('.katex, .stream-math-placeholder--inline').forEach((node) => node.remove());
        if (/\\(?:begin|frac|delta|le)/.test(copy.textContent ?? '')) state.leaked = true;
      }
      state.frame = requestAnimationFrame(sample);
    };
    state.frame = requestAnimationFrame(sample);
    (window as unknown as { mathTableSamples: typeof state }).mathTableSamples = state;
  });

  const response = String.raw`/say | Loss | Formula | Task |
| --- | --- | --- |
| Huber | $\begin{cases}\frac12r^2 & |r| \le \delta \\ \delta(|r|-\frac12\delta) & \text{otherwise}\end{cases}$ | Regression |`;
  await sendMessage(page, response);

  const assistant = page.getByTestId("msg-assistant").last();
  await expect(assistant.locator("table tbody tr")).toHaveCount(1);
  await expect(assistant.locator("table tbody tr td")).toHaveCount(3);
  await expect(assistant.locator(".katex-error")).toHaveCount(0);
  const tableState = await page.evaluate(() => {
    const state = (window as unknown as {
      mathTableSamples: { leaked: boolean; animatedTable: boolean; frame: number };
    }).mathTableSamples;
    cancelAnimationFrame(state.frame);
    return state;
  });
  expect(tableState.leaked).toBe(false);
  expect(tableState.animatedTable).toBe(false);
});

test("provider-style formula corpus survives cumulative stream snapshots", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Formula transport corpus", approval: "never" });

  await page.evaluate(() => {
    const state = { leakedTexSamples: [] as string[], redErrors: false, frame: 0 };
    const sample = () => {
      const messages = document.querySelectorAll<HTMLElement>('[data-testid="msg-assistant"]');
      const latest = messages[messages.length - 1];
      if (latest) {
        const copy = latest.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('.katex, .stream-math-placeholder, .codeblock-shell, code').forEach((node) => node.remove());
        const visibleText = copy.textContent ?? '';
        if (/\\(?:begin|end|frac|sum|prod|int|left|right|sqrt|operatorname)/.test(visibleText)) {
          const match = /\\(?:begin|end|frac|sum|prod|int|left|right|sqrt|operatorname)/.exec(visibleText);
          const start = Math.max(0, (match?.index ?? 0) - 40);
          const sample = visibleText.slice(start, start + 180);
          if (!state.leakedTexSamples.includes(sample) && state.leakedTexSamples.length < 8) {
            state.leakedTexSamples.push(sample);
          }
        }
        if (latest.querySelector('.katex-error')) state.redErrors = true;
      }
      state.frame = requestAnimationFrame(sample);
    };
    state.frame = requestAnimationFrame(sample);
    (window as unknown as { formulaCorpusSamples: typeof state }).formulaCorpusSamples = state;
  });

  const tick = '`';
  const corpus = String.raw`/say Inline dollar: $E=mc^2$ and $\operatorname{softmax}(z_i)=\frac{e^{z_i}}{\sum_j e^{z_j}}$.

Inline LaTeX delimiters: \(a^2+b^2=c^2\) and CJK adjacent \(损失=\lVert y-\hat y\rVert_2^2\)完成。

Same-line display:
$$\int_{-\infty}^{\infty} e^{-x^2}\,dx=\sqrt{\pi}$$

Multiline display:
$$
\prod_{k=1}^{n} k=n!
$$

Bracket display:
\[
\begin{pmatrix}a&b\\c&d\end{pmatrix}^{-1}
=\frac{1}{ad-bc}\begin{pmatrix}d&-b\\-c&a\end{pmatrix}
\]

Cases and aligned:
\[
f(x)=\begin{cases}x^2,&x\ge 0\\-x,&x<0\end{cases},\qquad
\begin{aligned}\nabla_\theta L&=\sum_i r_i\\H&=J^\top J+\lambda I\end{aligned}
\]

Bare equation environment:
\begin{equation}
e^{i\pi}+1=0
\end{equation}

Bare align environment:
\begin{align}
(a+b)^2&=a^2+2ab+b^2\\
(a-b)^2&=a^2-2ab+b^2
\end{align}

Bare matrix environment:
\begin{pmatrix}
1&2\\3&4
\end{pmatrix}

| Kind | Formula | Meaning |
| --- | --- | --- |
| Norm | $\lVert x\rVert_2=\sqrt{\sum_i x_i^2}$ | vector norm |
| Bars | $|r|\le\delta,\; P(A\mid B)=\frac{P(A\cap B)}{P(B)}$ | literal bars |
| Array | $\begin{array}{c|c}a&b\\c&d\end{array}$ | inner separator |

Currency stays text: $50, $USD, and escaped \$100.

Code stays literal: ${tick}$not_math$ \(still_code\)${tick}.

Final formula: $D_{\mathrm{KL}}(P\|Q)=\sum_i p_i\log\frac{p_i}{q_i}$.`;
  await sendMessage(page, corpus);

  const assistant = page.getByTestId("msg-assistant").last();
  await expect(assistant.locator('.katex-error')).toHaveCount(0);
  await expect(assistant.locator('.katex-display')).toHaveCount(7);
  await expect(assistant.locator('table tbody tr')).toHaveCount(3);
  await expect(assistant.locator('table tbody tr').nth(1).locator('td')).toHaveCount(3);
  await expect(assistant).toContainText('$50');
  await expect(assistant).toContainText('$USD');
  await expect(assistant).toContainText('$not_math$');

  const streamState = await page.evaluate(() => {
    const state = (window as unknown as {
      formulaCorpusSamples: { leakedTexSamples: string[]; redErrors: boolean; frame: number };
    }).formulaCorpusSamples;
    cancelAnimationFrame(state.frame);
    return state;
  });
  expect(streamState.leakedTexSamples).toEqual([]);
  expect(streamState.redErrors).toBe(false);
});

test("new streamed lines rise through a damped bottom follow instead of snapping", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Stream line follow", approval: "never" });
  await page.setViewportSize({ width: 760, height: 460 });

  const baseline = Array.from(
    { length: 24 },
    (_, index) => `Baseline ${index + 1}: ${"reader content ".repeat(7)}`,
  ).join("\n\n") + "\n\nBASE-END";
  await sendMessage(page, `/say ${baseline}`);
  await expect(page.getByTestId("msg-assistant").last()).toContainText("BASE-END", { timeout: 15_000 });

  const timeline = page.getByTestId("timeline");
  await expect.poll(() => timeline.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    const state = { samples: [] as number[], arrivalFrames: 0, softenedFrames: 0, frame: 0 };
    const sample = () => {
      const messages = document.querySelectorAll<HTMLElement>('[data-testid="msg-assistant"]');
      const latest = messages[messages.length - 1];
      if (latest?.textContent?.includes("FOLLOW-START")) {
        const timeline = document.querySelector<HTMLElement>('[data-testid="timeline"]');
        if (timeline) state.samples.push(timeline.scrollTop);
        const arrivals = latest.querySelectorAll<HTMLElement>('[data-stream-arrival]');
        if (arrivals.length > 0) {
          state.arrivalFrames++;
          if (Array.from(arrivals).some((word) => Number.parseFloat(getComputedStyle(word).opacity) < 0.98)) {
            state.softenedFrames++;
          }
        }
      }
      state.frame = requestAnimationFrame(sample);
    };
    state.frame = requestAnimationFrame(sample);
    (window as unknown as { streamFollowSamples: typeof state }).streamFollowSamples = state;
  });

  const streamed = "FOLLOW-START\n\n" + Array.from(
    { length: 18 },
    (_, index) => `New line ${index + 1}: ${"a calm upward arrival ".repeat(6)}`,
  ).join("\n\n") + "\n\nFOLLOW-END";
  await sendMessage(page, `/say ${streamed}`);
  await expect(page.getByTestId("agent-activity-orb")).toBeVisible();
  await expect(page.getByTestId("live-activity")).toHaveCount(0);
  await expect(page.getByTestId("msg-assistant").last()).toContainText("FOLLOW-END", { timeout: 15_000 });
  await expect(page.getByTestId("agent-activity-orb")).toHaveCount(0);
  await expect(page.getByTestId("context-ring").first()).toBeVisible();
  await expect(page.getByTestId("msg-assistant").last().locator('[data-stream-word]')).toHaveCount(0);
  await expect.poll(() => timeline.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);

  const streamState = await page.evaluate(() => {
    const state = (window as unknown as {
      streamFollowSamples: { samples: number[]; arrivalFrames: number; softenedFrames: number; frame: number };
    }).streamFollowSamples;
    cancelAnimationFrame(state.frame);
    return state;
  });
  const samples = streamState.samples;
  const deltas = samples.slice(1).map((value, index) => value - samples[index]);
  let longestRise = 0;
  let currentRise = 0;
  for (const delta of deltas) {
    if (delta > 0.15 && delta < 12) {
      currentRise++;
      longestRise = Math.max(longestRise, currentRise);
    } else {
      currentRise = 0;
    }
  }
  expect(longestRise).toBeGreaterThanOrEqual(3);
  expect(Math.min(...deltas)).toBeGreaterThanOrEqual(-1);
  expect(streamState.arrivalFrames).toBeGreaterThan(0);
  expect(streamState.softenedFrames).toBeGreaterThan(0);
});

test("a mixed display-math closer cannot swallow the following section", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Mixed math delimiters", approval: "never" });

  const response = String.raw`/say ## Vandermonde

\[
V = \begin{pmatrix} 1 & x_1 \\ 1 & x_2 \end{pmatrix}
$$

---

## Hilbert

\[
H_{ij} = \frac{1}{i + j - 1}
\]`;
  await sendMessage(page, response);

  const assistant = page.getByTestId("msg-assistant").last();
  await expect(assistant.locator(".katex-display")).toHaveCount(2);
  await expect(assistant.getByRole("heading", { name: "Hilbert" })).toBeVisible();
  await expect(assistant.locator(".katex-error")).toHaveCount(0);
  expect(await assistant.evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".katex").forEach((formula) => formula.remove());
    return copy.textContent?.includes(String.raw`\frac`) ?? false;
  })).toBe(false);
});

test("download all: button triggers tar.gz download of session workspace (#download-all)", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Download all", approval: "never" });

  await sendMessage(page, "/write download-probe.txt\ndownload-all-e2e-content");
  const tool = page.getByTestId("tool-write_file");
  await expect(tool).toBeVisible();
  await expect(tool.getByTestId("tool-status")).toHaveText("success");

  await openFilePanel(page);
  await expect(page.getByTestId("file-download-probe.txt")).toBeVisible();

  const dlBtn = page.getByTestId("rs-download-all");
  await expect(dlBtn).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dlBtn.click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^workspace-.*\.tar\.gz$/);

  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const { statSync } = await import("fs");
  expect(statSync(filePath!).size).toBeGreaterThan(0);
});

test("bold mode: help text, persisted mode, and skills gallery card (#bold)", async ({ page }) => {
  await authViaApi(page, "admin3@e2e.dev");

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();

  await page.getByTestId("ns-mode-option-bold").click();
  await expect(page.getByTestId("ns-mode-card-bold")).toBeChecked();

  await expect(page.getByText("Maximally proactive", { exact: false })).toBeVisible();

  await expect(page.getByText("Defaults to the isolated E2B pentest sandbox", { exact: false })).toHaveCount(0);

  await page.getByTestId("ns-title").fill("Bold e2e test");
  await openSessionAdvanced(page);
  await page.getByTestId("ns-model").selectOption("mock::mock-coder");
  await page.getByTestId("ns-sandbox").selectOption("workspace-write");
  await page.getByTestId("ns-approval").selectOption("never");
  await page.getByTestId("ns-create").click();
  await expect(page.getByTestId("new-session-modal")).toBeHidden();
  await expect(page.getByTestId("composer")).toBeVisible();

  const sessionMode = await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    const h = { authorization: "Bearer " + token };
    const resp = await fetch("/api/sessions", { headers: h });
    const json = await resp.json() as { sessions: Array<{ title: string; mode: string }> };
    const session = json.sessions.find((s) => s.title === "Bold e2e test");
    return session?.mode ?? null;
  });
  expect(sessionMode).toBe("bold");

  await page.getByTestId("open-skills").click();
  await expect(page.getByTestId("skill-bold")).toBeVisible();

  await page.getByTestId("skill-launch-bold").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();
  await expect(page.getByTestId("ns-mode-card-bold")).toBeChecked();
});

test("E2B capacity gate disables manual creation and routes to Connector setup", async ({ page }) => {
  await signup(page);

  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const body = await upstream.json() as { models: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...body,
        e2b: false,
        executors: {
          local: { available: false, reason: "policy_disabled" },
          e2b: { available: false, reason: "capacity_unavailable" },
        },
      },
    });
  });

  await page.getByTestId("new-session").click();
  const guidance = page.getByTestId("ns-executor-guidance");
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("Cloud workspace is full right now");
  await expect(guidance).toContainText("read files, run commands, and use the terminal");
  await expect(page.getByTestId("ns-create")).toBeDisabled();

  await page.getByTestId("ns-executor-connector-cta").click();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByTestId("plugins-view")).toBeVisible();

  await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    const headers = { authorization: `Bearer ${token}` };
    const listed = await fetch("/api/sessions", { headers }).then((response) => response.json()) as {
      sessions: Array<{ id: string }>;
    };
    await Promise.all(listed.sessions.map((session) => fetch(`/api/sessions/${session.id}`, { method: "DELETE", headers })));
  });
  await page.goto("/");
  const emptyState = page.getByTestId("executor-empty-state");
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText("Choose where your agent works");
  await expect(emptyState).toContainText("Your own computer");
  await expect(emptyState.getByTestId("executor-cloud-option")).toContainText("full right now");
  const limits = emptyState.getByTestId("executor-limits-list");
  await expect(limits).toBeHidden();
  await emptyState.getByText("What can't I do until then?").click();
  await expect(limits).toBeVisible();
  await expect(limits).toContainText("Uploading files");
  await expect.poll(() => page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    const response = await fetch("/api/sessions", { headers: { authorization: `Bearer ${token}` } });
    return ((await response.json()) as { sessions: unknown[] }).sessions.length;
  })).toBe(0);

  await page.evaluate(() => { (window as unknown as { __alive?: boolean }).__alive = true; });
  await emptyState.getByTestId("executor-see-what-it-does").click();
  await expect(page).toHaveURL(/\/about$/);
  expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive === true)).toBe(true);
  await page.goBack();
  await expect(emptyState).toBeVisible();

  await page.getByTestId("executor-connect-cta").click();
  await expect(page).toHaveURL(/\/plugins$/);
});

test("connector session refresh stays neutral until the session list hydrates", async ({ page }) => {
  await signup(page);

  const connectorSessionId = await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const connectorResponse = await fetch("/api/connectors", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Hydration machine", workspaceRoot: "./workspaces/hydration" }),
    });
    if (!connectorResponse.ok) throw new Error(`connector setup failed: ${connectorResponse.status}`);
    const { connector } = await connectorResponse.json() as { connector: { id: string } };
    const sessionResponse = await fetch("/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Hydration connector session",
        provider: "mock",
        model: "mock-coder",
        sandboxMode: "workspace-write",
        sandboxKind: "connector",
        sandboxTargetId: connector.id,
        approvalPolicy: "never",
      }),
    });
    if (!sessionResponse.ok) throw new Error(`session setup failed: ${sessionResponse.status}`);
    return ((await sessionResponse.json()) as { session: { id: string } }).session.id;
  });
  await page.goto(`/s/${connectorSessionId}`);
  await expect(page.getByTestId("composer")).toBeVisible();

  let releaseSessions!: () => void;
  const sessionsGate = new Promise<void>((resolve) => { releaseSessions = resolve; });
  let markModelsReady!: () => void;
  const modelsReady = new Promise<void>((resolve) => { markModelsReady = resolve; });

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await sessionsGate;
    await route.continue();
  });
  await page.route("**/api/models", async (route) => {
    const upstream = await route.fetch();
    const body = await upstream.json() as { models: unknown[] };
    await route.fulfill({
      response: upstream,
      json: {
        ...body,
        e2b: false,
        executors: {
          local: { available: false, reason: "policy_disabled" },
          e2b: { available: false, reason: "capacity_unavailable" },
        },
      },
    });
    markModelsReady();
  });
  await page.addInitScript(() => {
    const state = window as Window & { __sawExecutorEmpty?: boolean };
    state.__sawExecutorEmpty = false;
    const start = () => {
      const detect = () => {
        if (document.querySelector('[data-testid="executor-empty-state"]')) state.__sawExecutorEmpty = true;
      };
      new MutationObserver(detect).observe(document.documentElement, { childList: true, subtree: true });
      detect();
    };
    if (document.documentElement) start();
    else window.addEventListener("DOMContentLoaded", start, { once: true });
  });

  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await modelsReady;
    const hydration = page.getByTestId("session-hydration-state");
    await expect(hydration).toHaveAttribute("data-visible", "true");
    await expect(page.getByTestId("session-list-hydration")).toHaveAttribute("data-visible", "true");
    await expect(page.getByTestId("executor-empty-state")).toHaveCount(0);

    releaseSessions();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByText("Hydration connector session", { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __sawExecutorEmpty?: boolean }).__sawExecutorEmpty)).toBe(false);
  } finally {
    releaseSessions();
  }
});

test("change-password: success, token invalidation, and wrong-current-password error", async ({ page }) => {
  await signup(page);

  await openSettings(page);

  const oldToken = await page.evaluate(() => localStorage.getItem("agentweb.token"));
  expect(oldToken).toBeTruthy();

  const form = page.getByTestId("change-password-form");
  await expect(form).toBeVisible();

  await form.getByTestId("pw-current").fill("wrong-password-xyz");
  await form.getByTestId("pw-new").fill("newpassword456");
  await form.getByTestId("pw-confirm").fill("newpassword456");
  await form.getByTestId("pw-submit").click();

  await expect(form.getByTestId("pw-error")).toBeVisible();
  await expect(form.getByTestId("pw-saved")).toHaveCount(0);

  await form.getByTestId("pw-current").fill("password123");
  await form.getByTestId("pw-new").fill("newpassword456");
  await form.getByTestId("pw-confirm").fill("newpassword456");
  await form.getByTestId("pw-submit").click();

  await expect(form.getByTestId("pw-saved")).toBeVisible();
  await expect(form.getByTestId("pw-error")).toHaveCount(0);

  const newToken = await page.evaluate(() => localStorage.getItem("agentweb.token"));
  expect(newToken).toBeTruthy();
  expect(newToken).not.toBe(oldToken);

  const tokenResults = await page.evaluate(async (tokens) => {
    const get = (tok: string) =>
      fetch("/api/me", { headers: { authorization: "Bearer " + tok } }).then((r) => r.status);
    return {
      oldStatus: await get(tokens.old!),
      newStatus: await get(tokens.new!),
    };
  }, { old: oldToken, new: newToken });

  expect(tokenResults.oldStatus).toBe(401);
  expect(tokenResults.newStatus).toBe(200);
});

test("the landing page shows the product before asking for an account", async ({ page }) => {
  await page.goto("/");

  const audit = async () => page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>("main img")].map((img) => ({
      src: new URL(img.currentSrc || img.src).pathname,
      declared: img.width / img.height,
      natural: img.naturalWidth / img.naturalHeight,
      decoded: img.naturalWidth > 0,
      stretches: getComputedStyle(img).objectFit === "fill",
    })));

  const loadEverything = async () => {
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      window.scrollTo(0, 0);
    });
    await expect
      .poll(() => page.evaluate(() => [...document.querySelectorAll("main img")].every((img) => (img as HTMLImageElement).complete)))
      .toBe(true);
  };
  await loadEverything();

  const light = await audit();
  expect(light.length).toBeGreaterThanOrEqual(4);
  for (const img of light) {
    expect(img.decoded, `${img.src} did not decode`).toBe(true);
    expect(img.src).toContain("-light.png");
    if (img.stretches) {
      expect(Math.abs(img.declared / img.natural - 1), `${img.src} is stretched: declared box disagrees with the file`).toBeLessThan(0.02);
    }
  }

  await page.emulateMedia({ colorScheme: "dark" });
  await loadEverything();
  await expect.poll(async () => (await audit()).every((i) => i.src.includes("-dark.png"))).toBe(true);
  for (const img of await audit()) {
    expect(img.decoded, `${img.src} did not decode`).toBe(true);
    if (img.stretches) {
      expect(Math.abs(img.declared / img.natural - 1), `${img.src} is stretched: declared box disagrees with the file`).toBeLessThan(0.02);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });

  const layering = await page.evaluate(() => {
    const mark = document.querySelector('[data-testid="landing-wordmark"]') as HTMLElement;
    const stage = document.querySelector('[data-testid="landing-stage"]') as HTMLElement;
    const m = mark.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return {
      overlaps: Math.min(m.bottom, s.bottom) - Math.max(m.top, s.top) > 24,
      sameContext: mark.parentElement === stage.parentElement,
      markZ: Number(getComputedStyle(mark).zIndex),
      stageZ: Number(getComputedStyle(stage).zIndex),
    };
  });
  expect(layering.overlaps, "the mark and the product do not overlap — there is no occlusion").toBe(true);
  expect(layering.sameContext, "the two are in different stacking contexts; z-index cannot be compared").toBe(true);
  expect(layering.stageZ, "the wordmark paints over the product instead of behind it").toBeGreaterThan(layering.markZ);

  const gapAt = async (y: number) => {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(220);
    return page.evaluate(() => {
      const mark = document.querySelector('[data-testid="landing-wordmark"]')!.getBoundingClientRect();
      const stage = document.querySelector('[data-testid="landing-stage"]')!.getBoundingClientRect();
      return stage.top - mark.top;
    });
  };
  const restingGap = await gapAt(0);
  const scrolledGap = await gapAt(400);
  expect(scrolledGap, "the wordmark and the product move together — nothing separates them").toBeGreaterThan(restingGap + 20);

  await page.reload();
  await page.waitForTimeout(300);
  const startSection = page.getByTestId("landing-start");
  expect(await startSection.evaluate((el) => Number(getComputedStyle(el.querySelector("h2")!).opacity))).toBeLessThan(0.5);
  await page.getByRole("link", { name: "Start" }).click();
  await expect.poll(async () => startSection.evaluate((el) => Number(getComputedStyle(el.querySelector("h2")!).opacity))).toBeGreaterThan(0.9);

  await expect(page.getByText("Close the tab. It keeps working.")).toBeVisible();
  await expect(page.getByText("Also included:")).toBeVisible();
  await expect(page.getByTestId("landing-signup-terms")).toBeVisible();
});

test("the landing page holds still for a reader who asked it to", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(300);
  const p = await page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-testid="landing"]')!).getPropertyValue("--lp-p").trim());
  expect(Number(p || 0)).toBe(0);

  await expect(page.getByTestId("landing-hero")).toBeVisible();
  await expect(page.getByText("Close the tab. It keeps working.")).toBeVisible();
  const startHeading = page.getByTestId("landing-start").locator("h2");
  await expect.poll(async () => startHeading.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.9);
});

test("an empty session suggests a real task in the field itself", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Suggestion", approval: "never" });

  const composer = page.getByTestId("composer");
  await expect(composer).toBeFocused();

  const suggestion = await composer.getAttribute("placeholder");
  expect(suggestion).toBeTruthy();
  expect(suggestion).not.toBe("Reply to assistant…");
  await expect(composer).toHaveValue("");

  const keycap = page.getByTestId("accept-suggestion");
  await expect(keycap).toBeVisible();
  await composer.press("Tab");
  await expect(composer).toHaveValue(suggestion!);
  await expect(page.getByTestId("msg-user")).toHaveCount(0);
  await expect(keycap).toHaveCount(0);

  await composer.fill("");
  await expect(composer).toHaveAttribute("placeholder", suggestion!);
  await composer.fill("something of my own");
  await expect(page.getByTestId("accept-suggestion")).toHaveCount(0);

  await composer.fill("");
  await sendMessage(page, "/bash echo suggestion");
  await expect(page.getByTestId("tool-bash").getByTestId("tool-status")).toHaveText("success");
  await expect(composer).toHaveAttribute("placeholder", "Reply to assistant…");
  await expect(page.getByTestId("accept-suggestion")).toHaveCount(0);

  await createSession(page, { title: "Second session", approval: "never" });
  const other = await page.getByTestId("composer").getAttribute("placeholder");
  expect(other).toBeTruthy();
  expect(other).not.toBe("Reply to assistant…");
});

test("Help is the one entry for everything about the product", async ({ page }) => {
  await signup(page);
  await page.getByTestId("help-menu-trigger").click();
  await expect(page.getByTestId("help-menu")).toBeVisible();

  await expect(page.getByTestId("open-blog")).toHaveAttribute("target", "_blank");
  await expect(page.getByTestId("help-github")).toHaveAttribute("target", "_blank");
  await page.getByTestId("help-shortcuts").click();
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByTestId("help-menu-trigger").click();
  await page.getByTestId("help-about").click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByTestId("landing-enter-app")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign up" })).toHaveCount(0);

  await page.getByTestId("landing-enter-app").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
});

test("account identity stays two-line and its menu follows the warm popover contract", async ({ page }) => {
  await signup(page);
  const account = page.getByTestId("account-menu-trigger");
  const navigationRow = page.getByTestId("open-plugins");

  await expect(account.locator("[data-account-name]")).not.toBeEmpty();
  await expect(account.locator("[data-account-email]")).toContainText("@test.dev");
  await expect(account).toHaveAttribute("aria-haspopup", "menu");
  await expect(account).toHaveAttribute("aria-expanded", "false");

  const accountBox = await account.boundingBox();
  const navigationBox = await navigationRow.boundingBox();
  expect(accountBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(accountBox!.x).toBeCloseTo(navigationBox!.x, 1);
  expect(accountBox!.width).toBeCloseTo(navigationBox!.width, 1);
  expect(accountBox!.height).toBeGreaterThan(navigationBox!.height);

  await account.hover();
  await page.waitForTimeout(180);
  const accountHover = await account.evaluate((node) => getComputedStyle(node).backgroundColor);
  await navigationRow.hover();
  await page.waitForTimeout(180);
  const navigationHover = await navigationRow.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(accountHover).not.toBe("rgba(0, 0, 0, 0)");
  expect(accountHover).toBe(navigationHover);

  await account.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByTestId("account-menu");
  await expect(account).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("open-settings")).toBeFocused();
  await expect(menu.locator("[data-menu-item]")).toHaveCount(3);
  expect(await menu.locator("[data-menu-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")))).toEqual([
    "open-settings",
    "status-page",
    "logout",
  ]);

  const menuStyle = await menu.evaluate((node) => {
    const style = getComputedStyle(node);
    const first = node.querySelector<HTMLElement>("[data-menu-item]");
    const firstStyle = first ? getComputedStyle(first) : null;
    return {
      radius: style.borderTopLeftRadius,
      padding: style.paddingTop,
      border: style.borderTopColor,
      shadow: style.boxShadow,
      rowRadius: firstStyle?.borderTopLeftRadius,
    };
  });
  expect(menuStyle.radius).toBe("14px");
  expect(menuStyle.padding).toBe("6px");
  expect(menuStyle.border).toBe("rgb(222, 217, 200)");
  expect(menuStyle.shadow).not.toBe("none");
  expect(menuStyle.rowRadius).toBe("8px");
  await expect(menu.locator('[role="separator"]')).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("status-page")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(account).toHaveAttribute("aria-expanded", "false");
  await expect(account).toBeFocused();
});

test("workspace rail keeps primary destinations fixed when contextual detail appears", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Stable workspace rail", approval: "never" });
  await page.getByRole("button", { name: "Toggle details panel" }).click();

  const rail = page.getByTestId("workspace-rail");
  await expect(rail).toBeVisible();
  const quietChrome = await rail.evaluate((node) => {
    const group = node.firstElementChild as HTMLElement | null;
    const active = node.querySelector<HTMLElement>('button[aria-pressed="true"]');
    const railStyle = getComputedStyle(node);
    const groupStyle = group ? getComputedStyle(group) : null;
    const activeStyle = active ? getComputedStyle(active) : null;
    return {
      width: Math.round(node.getBoundingClientRect().width),
      railBackground: railStyle.backgroundColor,
      groupBackground: groupStyle?.backgroundColor,
      groupShadow: groupStyle?.boxShadow,
      activeShadow: activeStyle?.boxShadow,
    };
  });
  expect(quietChrome.width).toBe(40);
  expect(quietChrome.groupBackground).toBe("rgba(0, 0, 0, 0)");
  expect(quietChrome.groupShadow).toBe("none");
  expect(quietChrome.activeShadow).toBe("none");
  const primaryLabels = ["File Tree", "Changes", "Terminal", "Commands", "Run"];
  const primaryTops = async () => Promise.all(primaryLabels.map(async (label) => {
    const box = await rail.getByRole("button", { name: label, exact: true }).boundingBox();
    if (!box) throw new Error(`workspace destination is not measurable: ${label}`);
    return box.y;
  }));
  const before = await primaryTops();

  await sendMessage(page, "/bash echo stable-rail");
  const tool = page.getByTestId("tool-bash").last();
  await expect(tool.getByTestId("tool-status")).toHaveText("success");
  await tool.getByTestId("tool-open").click();
  const toolDestination = rail.getByRole("button", { name: "Tool", exact: true });
  await expect(toolDestination).toBeVisible();
  await expect(toolDestination).toHaveAttribute("aria-pressed", "true");

  expect(await primaryTops()).toEqual(before);
  await expect(rail.locator("svg.lucide")).toHaveCount(6);
});

test("the header offers no control that cannot do anything", async ({ page }) => {
  await signup(page);
  await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    const headers = { authorization: `Bearer ${token}` };
    const listed = await fetch("/api/sessions", { headers }).then((r) => r.json()) as { sessions: Array<{ id: string }> };
    await Promise.all(listed.sessions.map((s) => fetch(`/api/sessions/${s.id}`, { method: "DELETE", headers })));
  });
  await page.goto("/");
  await expect(page.getByTestId("top-header")).toBeVisible();
  await expect(page.getByTestId("overflow-menu")).toHaveCount(0);
  await expect(page.getByTestId("github-star")).toHaveCount(0);

  await createSession(page, { title: "Header controls", approval: "never" });
  await page.getByTestId("overflow-menu").click();
  await expect(page.getByTestId("overflow-menu-panel")).toBeVisible();
});

test("the execution-target control is named for its menu and drawn for this app", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Runtime target mark", approval: "never" });

  const trigger = page.getByTestId("overflow-menu");
  await expect(trigger).toHaveAttribute("aria-label", "Where this session runs");

  await expect(trigger.locator("svg")).toHaveCount(1);
  await expect(trigger.locator("svg.lucide")).toHaveCount(0);

  await expect(page.getByTestId("top-header").locator("svg.lucide").first()).toBeAttached();
});

test("a collapsed sidebar stays recoverable on a view with no header", async ({ page }) => {
  await signup(page);
  await page.goto("/terminal");
  await expect(page.getByText("Open or start a session to use the terminal.")).toBeVisible();

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);

  const recovery = page.getByTestId("sidebar-recovery");
  await expect(recovery).toBeVisible();
  await recovery.click();
  await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
  await expect(recovery).toHaveCount(0);

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
});

test("responsive capture probes preserve the user's desktop panel arrangement", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Panel capture", approval: "never" });

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  await expect(page.getByTestId("workspace-rail")).toBeVisible();

  const bodyCapture = await captureVisibleElement(page, page.locator("body"));
  expect(bodyCapture.image.byteLength).toBeGreaterThan(1_000);
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await expect(page.getByTestId("workspace-rail")).toBeVisible();

  await page.setViewportSize({ width: 740, height: 720 });
  await expect(page.getByTestId("workspace-rail")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });

  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await expect(page.getByTestId("workspace-rail")).toBeVisible();
});

test("a transient breakpoint probe does not detach or reposition open desktop panels", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Panel stability", approval: "never" });
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  await expect(page.getByTestId("workspace-rail")).toBeVisible();
  await page.waitForTimeout(250);

  await page.evaluate(() => {
    const left = document.querySelector('[data-testid="account-menu-trigger"]');
    const right = document.querySelector('[data-testid="workspace-rail"]');
    const main = document.querySelector('[data-testid="main-content"]');
    if (!left || !right || !main) throw new Error("panel stability fixtures missing");
    const rect = main.getBoundingClientRect();
    const state = {
      left,
      right,
      main,
      detachObservations: 0,
      before: { x: rect.x, width: rect.width, scrollTop: main.scrollTop },
      observer: null as MutationObserver | null,
    };
    state.observer = new MutationObserver(() => {
      if (!left.isConnected || !right.isConnected || !main.isConnected) {
        state.detachObservations += 1;
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    (window as typeof window & { __panelStabilityProbe?: typeof state }).__panelStabilityProbe = state;
  });

  await page.setViewportSize({ width: 740, height: 720 });
  await page.waitForTimeout(20);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(180);

  const probe = await page.evaluate(() => {
    const state = (window as typeof window & {
      __panelStabilityProbe?: {
        left: Element;
        right: Element;
        main: Element;
        detachObservations: number;
        before: { x: number; width: number; scrollTop: number };
        observer: MutationObserver | null;
      };
    }).__panelStabilityProbe;
    if (!state) throw new Error("panel stability probe missing");
    state.observer?.disconnect();
    const rect = state.main.getBoundingClientRect();
    return {
      sameLeft: document.querySelector('[data-testid="account-menu-trigger"]') === state.left,
      sameRight: document.querySelector('[data-testid="workspace-rail"]') === state.right,
      sameMain: document.querySelector('[data-testid="main-content"]') === state.main,
      detachObservations: state.detachObservations,
      before: state.before,
      after: { x: rect.x, width: rect.width, scrollTop: state.main.scrollTop },
    };
  });
  expect(probe.sameLeft).toBe(true);
  expect(probe.sameRight).toBe(true);
  expect(probe.sameMain).toBe(true);
  expect(probe.detachObservations).toBe(0);
  expect(probe.after.x).toBeCloseTo(probe.before.x, 1);
  expect(probe.after.width).toBeCloseTo(probe.before.width, 1);
  expect(probe.after.scrollTop).toBe(probe.before.scrollTop);
});

test("view-preserving node capture refuses to move an off-screen Settings row", async ({ page }) => {
  await signup(page);
  await openSettings(page);

  const settings = page.getByTestId("settings-modal");
  const offscreenRow = page.locator(".key-row").last();
  await settings.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(offscreenRow).toBeAttached();

  const before = await settings.evaluate((node) => node.scrollTop);
  expect(before).toBe(0);
  await expect(captureVisibleElement(page, offscreenRow)).rejects.toThrow(
    "outside the current viewport",
  );
  expect(await settings.evaluate((node) => node.scrollTop)).toBe(before);

  const heading = settings.getByRole("heading", { name: "Settings" });
  const capture = await captureVisibleElement(page, heading);
  expect(capture.image.byteLength).toBeGreaterThan(100);
  expect(await settings.evaluate((node) => node.scrollTop)).toBe(before);
});

test("routing: view switches update the URL; refresh and back/forward keep the page", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Routing", approval: "never" });
  await expect(page).toHaveURL(/\/s\/s_[a-z0-9-]+$/);
  const sessionUrl = page.url();

  await page.getByTestId("open-terminal").click();
  await expect(page).toHaveURL(/\/terminal$/);
  await page.getByTestId("open-search").click();
  await expect(page).toHaveURL(/\/search$/);

  await page.reload();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByTestId("search-input")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/terminal$/);
  await expect(page.getByTestId("shell-terminal")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/search$/);

  await page.goto(sessionUrl);
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page).toHaveURL(sessionUrl);
});

test("routing: /auth deep links open the right form; toggle syncs the URL", async ({ page }) => {
  await page.goto("/auth/signup");
  await expect(page.getByTestId("auth-submit")).toBeVisible();
  await page.getByTestId("toggle-mode").click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/auth\/signup$/);
});

test("GitHub OAuth failures return to login with an explanation, never the landing page", async ({ page }) => {
  await page.goto("/api/auth/github/callback?code=expired&state=invalid");
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByTestId("auth-error")).toContainText("GitHub");

  await page.goto("/?auth_error=github_failed");
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByTestId("auth-error")).toContainText("GitHub");
});

test("management views are cut from the same cloth as the rest of the app", async ({ page }) => {
  await signup(page);

  const surfaces: { route: string; testId: string; header: string; background: string }[] = [];
  for (const [route, testId] of [
    ["/skills", "skills-view"],
    ["/automations", "automations-view"],
    ["/plugins", "plugins-view"],
    ["/search", "search-view"],
    ["/channels", "channel-view"],
    ["/settings", "settings-modal"],
    ["/agents/activity", "agents-view"],
  ] as const) {
    await page.goto(route);
    const view = page.getByTestId(testId);
    await expect(view).toBeVisible();
    const header = view.getByTestId("view-header");
    await expect(header).toBeVisible();
    surfaces.push({
      route,
      testId,
      header: await header.evaluate((el) => {
        const s = getComputedStyle(el);
        return `${Math.round(el.getBoundingClientRect().height)}px ${s.borderBottomColor}`;
      }),
      background: await view.evaluate((el) => getComputedStyle(el).backgroundColor),
    });
  }

  const [reference] = surfaces;
  for (const surface of surfaces) {
    expect(`${surface.route} ${surface.header}`).toBe(`${surface.route} ${reference.header}`);
    expect(`${surface.route} ${surface.background}`).toBe(`${surface.route} ${reference.background}`);
  }

  expect(reference.background).not.toBe("rgb(255, 255, 255)");
  expect(reference.header.startsWith("52px ")).toBe(true);
});

test("a skill row announces what it is and what pressing it does", async ({ page }) => {
  await signup(page);
  await page.goto("/skills");
  const row = page.getByTestId("skill-coding");
  await expect(row).toBeVisible();

  const resolved = await row.evaluate((el) => {
    const textOf = (attr: string) =>
      (el.getAttribute(attr) || "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? `UNRESOLVED:${id}`);
    return { name: textOf("aria-labelledby"), description: textOf("aria-describedby") };
  });

  expect(resolved.name.join(" | ")).not.toContain("UNRESOLVED");
  expect(resolved.description.join(" | ")).not.toContain("UNRESOLVED");
  expect(resolved.name).toContain("Coding agent");
  expect(resolved.name).toContain("Start session");
  expect(resolved.description[0] ?? "").toContain("software engineering");
});

test("the default policy writes files without asking, and still stops for a command", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Default friction", approval: "on-request" });

  await sendMessage(page, "/write notes.txt\nwritten without a prompt");

  const write = page.getByTestId("tool-write_file");
  await expect(write.getByTestId("tool-status")).toHaveText("success");
  await expect(page.getByTestId("permission")).toHaveCount(0);
  await openFilePanel(page);
  await expect(page.getByTestId("file-notes.txt")).toBeVisible();

  await sendMessage(page, "/bash echo still-gated > gated.txt");
  await expect(page.getByTestId("permission")).toBeVisible();
  await expect(page.getByTestId("permission").getByRole("heading")).toHaveText("Run this command?");
});

test("a new session runs unattended by default, and says so before you create it", async ({ page }) => {
  await signup(page);
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("new-session-modal")).toBeVisible();

  await expect(page.getByTestId("ns-advanced")).toHaveJSProperty("open", false);
  await expect(page.getByTestId("ns-advanced-summary")).toHaveText("full access, network on · never asks");

  await openSessionAdvanced(page);
  await expect(page.getByTestId("ns-sandbox")).toHaveValue("danger-full-access");
  await expect(page.getByTestId("ns-approval")).toHaveValue("never");
});

test("the API applies the same defaults as the form when a client omits them", async ({ page }) => {
  await signup(page);
  const created = await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const models = await fetch("/api/models", { headers }).then((r) => r.json()) as { models: Array<{ provider: string; id: string }> };
    const model = models.models.find((m) => m.provider === "mock") ?? models.models[0];
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "api defaults", provider: model.provider, model: model.id }),
    });
    return await res.json() as { session: { sandboxMode: string; approvalPolicy: string } };
  });
  expect(created.session.sandboxMode).toBe("danger-full-access");
  expect(created.session.approvalPolicy).toBe("never");
});

test("the front door has a link preview, and its image actually resolves", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  const meta = (prop: string) =>
    html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`))?.[1] ?? null;

  expect(meta("og:title")).toContain("oiia");
  expect(meta("og:description")?.length ?? 0).toBeGreaterThan(40);
  expect(meta("twitter:card")).toBe("summary_large_image");

  const image = meta("og:image");
  expect(image).toMatch(/^https?:\/\//);
  expect(meta("og:image:width")).toBe("1200");

  for (const card of [new URL(image!).pathname, "/og-card.png"]) {
    const res = await request.get(card);
    expect(res.status(), `${card} should be served`).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect((await res.body()).byteLength).toBeGreaterThan(5000);
  }

  expect(html).not.toContain("o11n");
});

test("a spinning mark turns about a fixed centre", async ({ page }) => {
  await signup(page);

  const drift = await page.evaluate(() => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none";
    document.body.appendChild(host);
    host.innerHTML = `
      <svg id="probe" class="size-5" viewBox="0 0 24 24" fill="none">
        <path id="a1" d="M12 3A9 9 0 0 1 21 12" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/>
        <path id="a2" d="M12 21A9 9 0 0 1 3 12" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/>
      </svg>`;
    const svg = document.getElementById("probe") as HTMLElement;
    const paths = ["a1", "a2"].map((id) => document.getElementById(id) as unknown as SVGPathElement);

    const centre = () => {
      let sx = 0, sy = 0, n = 0;
      for (const p of paths) {
        const m = p.getScreenCTM()!;
        const len = p.getTotalLength();
        for (let i = 0; i < 180; i++) {
          const pt = p.getPointAtLength((i / 180) * len);
          sx += pt.x * m.a + pt.y * m.c + m.e;
          sy += pt.x * m.b + pt.y * m.d + m.f;
          n += 1;
        }
      }
      return { x: sx / n, y: sy / n };
    };

    const seen: { x: number; y: number }[] = [];
    for (let deg = 0; deg < 360; deg += 15) {
      svg.style.transform = `rotate(${deg}deg)`;
      seen.push(centre());
    }
    host.remove();
    const xs = seen.map((s) => s.x), ys = seen.map((s) => s.y);
    return { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys) };
  });

  expect(drift.x).toBeLessThan(0.05);
  expect(drift.y).toBeLessThan(0.05);
});

test("the header shows the reading, and falls back to the connection only when there is none", async ({ page }) => {
  await signup(page);
  await createSession(page, { title: "Header states", approval: "never" });

  const meter = page.getByTestId("sandbox-load");
  const badge = page.getByTestId("ws-badge");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(meter).toBeVisible();
  await expect(badge).toBeHidden();
  await expect(meter).toHaveAttribute("aria-label", /^live · /);
  const wide = (await meter.boundingBox())!.width;

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(meter).toBeVisible();
  await expect(badge).toBeHidden();
  await expect(meter).toContainText("%");
  const narrow = (await meter.boundingBox())!.width;

  expect(narrow).toBeLessThan(wide * 0.6);

  await page.context().setOffline(true);
  await expect(badge).toBeVisible({ timeout: 15000 });
  await expect(meter).toBeHidden();
  await page.context().setOffline(false);
});

test("help offers an install route that matches the browser looking at it", async ({ page }) => {
  await signup(page);
  await page.getByTestId("help-menu-trigger").click();
  await expect(page.getByTestId("help-menu")).toBeVisible();
  await page.getByTestId("help-install").click();

  const dialog = page.getByTestId("install-app-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("oiia");

  const body = dialog.locator("[data-testid^='install-state-']");
  await expect(body).toHaveAttribute("data-testid", "install-state-manual");
  await expect(body).not.toBeEmpty();
});

test("a frontend-only deploy is picked up without restarting the runtime", async ({ page, request }) => {
  const distIndex = new URL("../../web/dist/index.html", import.meta.url).pathname;
  const original = await readFile(distIndex, "utf8");
  try {
    const before = await (await request.get("/")).text();
    expect(before).toContain("<!doctype html");

    const marker = `swapped-${Date.now()}`;
    await writeFile(distIndex, original.replace("</head>", `<meta name="deploy-marker" content="${marker}" /></head>`), "utf8");

    const after = await (await request.get("/")).text();
    expect(after, "the served shell must follow the file on disk, not a cache from startup").toContain(marker);
    expect(after).toContain('property="og:image"');

    const badTypes: string[] = [];
    page.on("response", (res) => {
      const url = res.url();
      if (!url.includes("/assets/")) return;
      const type = res.headers()["content-type"] ?? "";
      if (res.status() !== 200 || type.includes("text/html")) badTypes.push(`${url} → ${res.status()} ${type}`);
    });
    await page.goto("/", { waitUntil: "networkidle" });
    expect(badTypes, "an asset served as HTML is the signature of this outage").toEqual([]);
    await expect(page.locator("#root")).not.toBeEmpty();
  } finally {
    await writeFile(distIndex, original, "utf8");
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// A separate headless browser and synthetic mail only; no desktop focus or
// access to the user's installed mail client, credentials or browser profile.
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "demo/vite.demo.config.ts"], {
  cwd: new URL("..", import.meta.url), windowsHide: true, stdio: "pipe",
});
let output = "";
server.stdout.on("data", chunk => { output += chunk; });
server.stderr.on("data", chunk => { output += chunk; });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw Error(`Vite exited: ${output}`);
    try { if ((await fetch("http://localhost:1421")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
    if (attempt === 59) throw Error(`Vite did not start: ${output}`);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.SKIM_TEST_BROWSER || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    if (localStorage.getItem("skimdemo.taskInbox") === "on") return;
    localStorage.setItem("skimdemo.taskInbox", "on");
    localStorage.setItem("skimdemo.multiaccount", "on");
    localStorage.setItem("skimdemo.settings", JSON.stringify({ inbox_sender_rules: JSON.stringify({
      "marcus@acme-partners.example": { priority: true },
      "notifications@github.example": { category: "notifications" },
      "receipts@stripe.example": { category: "newsletters" },
    }) }));
  });
  await page.goto("http://localhost:1421");
  const list = page.locator("section.list");
  await list.getByRole("heading", { name: "Priority", exact: true }).waitFor();
  await list.getByRole("button", { name: /^Anna Weber/ }).waitFor();
  assert.equal(await list.locator("button.row").filter({ hasText: "Anna Weber" }).count(), 0);
  await list.getByRole("button", { name: /^Anna Weber/ }).click();
  assert.equal(await list.locator("button.row").filter({ hasText: "Anna Weber" }).count(), 2);
  await list.getByRole("button", { name: /Back to senders/ }).click();
  await list.getByRole("button", { name: /Back to inbox/ }).click();
  await list.getByRole("button", { name: /^Notifications/ }).click();
  await list.locator("button.row").filter({ hasText: "GitHub" }).waitFor();
  await list.getByRole("button", { name: "✓ Done", exact: true }).click();
  await page.waitForFunction(async () => {
    const { commandLog } = await import("/demo/mock/tauri-core.ts");
    return commandLog.some(call => call.cmd === "archive_messages");
  });
  const archived = await page.evaluate(async () => {
    const { commandLog } = await import("/demo/mock/tauri-core.ts");
    return commandLog.filter(call => call.cmd === "archive_messages").map(call => call.args.messageIds);
  });
  assert.deepEqual(archived, [[1061]], "Done must not archive the sent copy (99999)");
  await list.getByRole("button", { name: /Back to inbox/ }).click();
  await list.locator("button.row").filter({ hasText: "Priya Nair" }).waitFor();
  const priyaActions = list.locator(".row-wrap").filter({ hasText: "Priya Nair" }).locator("xpath=following-sibling::*[1]");
  await page.evaluate(() => localStorage.setItem("skimdemo.failArchive", "on"));
  await priyaActions.getByRole("button", { name: "✓ Done", exact: true }).click();
  await page.locator("nav.sidebar .sync.error").waitFor();
  assert.equal(await list.locator("button.row").filter({ hasText: "Priya Nair" }).count(), 1,
    "A rejected archive must leave the conversation available");
  await page.evaluate(() => localStorage.removeItem("skimdemo.failArchive"));
  await priyaActions.getByRole("button", { name: /Priority sender/ }).click();
  await page.waitForFunction(() => JSON.parse(JSON.parse(localStorage.getItem("skimdemo.settings")).inbox_sender_rules)["priya@brightwave.io"]?.priority === true);
  await page.reload();
  await list.getByRole("heading", { name: "Priority", exact: true }).waitFor();
  assert.equal(await list.locator(".priority button.row").filter({ hasText: "Priya Nair" }).count(), 1);
  // Sent remains a unified folder, and uses the same sender grouping controls.
  await page.locator("nav.sidebar").getByRole("button", { name: /^Sent/ }).click();
  await list.getByRole("heading", { name: "Sent", exact: true }).waitFor();
  assert.equal(await list.getByRole("button", { name: "✓ Done", exact: true }).count(), 0);
  await page.locator("nav.sidebar").getByRole("button", { name: /^Inbox/ }).click();
  await list.getByRole("heading", { name: "Priority", exact: true }).waitFor();
  await mkdir(new URL("../demo/output/", import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL("../demo/output/task-inbox.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Inbox UI passed: sender drill-down, categories, scoped Done, archive failure recovery, saved priority, unified Sent, no runtime errors.");
} finally {
  await browser?.close();
  server.kill();
}

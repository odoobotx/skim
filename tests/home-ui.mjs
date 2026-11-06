import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = "http://localhost:1423";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "demo/vite.demo.config.ts", "--port", "1423"], {
  cwd: new URL("..", import.meta.url), windowsHide: true, stdio: "pipe",
});
let output = "", browser;
server.stdout.on("data", chunk => output += chunk);
server.stderr.on("data", chunk => output += chunk);
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw Error(`Vite exited: ${output}`);
    try { if ((await fetch(origin)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
    if (attempt === 59) throw Error(`Vite did not start: ${output}`);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.SKIM_TEST_BROWSER || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/Chicago" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-11-06T09:00:00-06:00"));
  await page.goto(origin);
  await page.locator(".mail-preview").first().waitFor();
  assert.equal(await page.locator(".latest").evaluate(el => el.getBoundingClientRect().width), 650);
  assert.equal(await page.locator(".mail-preview").first().evaluate(el => el.getBoundingClientRect().height), 36);
  assert.equal(await page.locator(".latest ul").evaluate(el => getComputedStyle(el).gap), "5px");
  assert.equal(await page.locator(".latest .glass-panel").count(), 0);
  await mkdir(new URL("../demo/output/", import.meta.url), { recursive: true });
  const shot = name => new URL(`../demo/output/${name}.png`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
  await page.screenshot({ path: shot("home-extra-compact"), fullPage: true });
  async function openHomeSettings() {
    await page.getByRole("button", { name: "Check Inbox", exact: true }).click();
    await page.locator("nav.sidebar").getByRole("button", { name: /Settings$/ }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Home", exact: true }).click();
    await page.locator('.scene button:enabled').first().waitFor();
  }
  const scene = name => page.getByRole("article", { name: `${name} background`, exact: true });
  const defaultChoice = name => scene(name).getByRole("button", { name: "Default", exact: true });
  const customChoice = name => scene(name).getByRole("button", { name: "Custom", exact: true });
  async function settled() { await page.locator('.scene button:disabled').first().waitFor({ state: "hidden" }); }
  async function home() {
    await page.locator(".overlay .close").click();
    await page.evaluate(async () => (await import("/src/lib/stores/ui.svelte.ts")).ui.showHome());
    await page.locator(".home").waitFor();
  }
  await openHomeSettings();
  for (const name of ["Dawn", "Morning", "Afternoon", "Evening", "Night"]) {
    assert.equal(await defaultChoice(name).getAttribute("aria-pressed"), "true");
    assert((await scene(name).locator("img").getAttribute("src")).startsWith("/home-"));
  }
  await page.screenshot({ path: shot("home-background-settings"), fullPage: true });
  const chooserEvent = page.waitForEvent("filechooser");
  await customChoice("Dawn").click();
  await (await chooserEvent).setFiles([]);
  assert.equal(await defaultChoice("Dawn").getAttribute("aria-pressed"), "true", "Cancel leaves Default selected");
  const photo = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2560; canvas.height = 1440;
    const context = canvas.getContext("2d");
    const colors = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    colors.addColorStop(0, "#8fbaab"); colors.addColorStop(1, "#25335c");
    context.fillStyle = colors; context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const upload = { name: "personal-photo.png", mimeType: "image/png", buffer: Buffer.from(photo, "base64") };
  await customChoice("Morning").click({ noWaitAfter: true });
  await page.getByLabel("Choose Home photo", { exact: true }).setInputFiles(upload);
  await settled();
  assert.equal(await customChoice("Morning").getAttribute("aria-pressed"), "true");
  const customImage = await scene("Morning").locator("img").getAttribute("src");
  assert(customImage.startsWith("data:image/jpeg;base64,"));
  await scene("Morning").locator("img").evaluate(async el => { await el.decode(); });
  assert.equal(await scene("Morning").locator("img").evaluate(el => el.naturalWidth), 1920, "Large photos are resized once when saved");
  for (const name of ["Dawn", "Afternoon", "Evening", "Night"]) assert.equal(await defaultChoice(name).getAttribute("aria-pressed"), "true");
  await defaultChoice("Morning").click(); await settled();
  assert.equal(await scene("Morning").locator("img").getAttribute("src"), "/home-morning.png");
  assert.equal(await scene("Morning").getByRole("button").count(), 2, "Only Default and Custom controls remain");
  await customChoice("Morning").click(); await settled();
  assert.equal(await scene("Morning").locator("img").getAttribute("src"), customImage, "Default preserves the saved custom image");
  const replacementChooser = page.waitForEvent("filechooser");
  await customChoice("Morning").click();
  await (await replacementChooser).setFiles([]);
  assert.equal(await scene("Morning").locator("img").getAttribute("src"), customImage, "Cancel replacing a custom photo preserves it");
  await page.getByLabel("Choose Home photo", { exact: true }).setInputFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await settled();
  await page.getByRole("alert").filter({ hasText: "couldn't be opened" }).waitFor();
  assert.equal(await scene("Morning").locator("img").getAttribute("src"), customImage, "Invalid uploads preserve the previous photo");
  await home();
  await page.waitForFunction(image => document.querySelector(".home").style.getPropertyValue("--home-image").includes(image), customImage);
  await page.reload();
  await page.waitForFunction(image => document.querySelector(".home")?.style.getPropertyValue("--home-image").includes(image), customImage);
  await page.clock.setFixedTime(new Date("2026-11-06T15:00:00-06:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.querySelector(".home").dataset.scene === "afternoon");
  assert((await page.locator(".home").getAttribute("style")).includes("/home-afternoon.png"), "Other stages retain their default photos");
  await openHomeSettings();
  await page.evaluate(() => {
    window.originalPhotoPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function() { throw new DOMException("Synthetic storage failure", "QuotaExceededError"); };
  });
  await defaultChoice("Morning").click(); await settled();
  await page.getByRole("alert").filter({ hasText: "previous photo is still in place" }).waitFor();
  assert.equal(await customChoice("Morning").getAttribute("aria-pressed"), "true", "Failed persistence never applies a choice that wasn't saved");
  await page.evaluate(() => IDBObjectStore.prototype.put = window.originalPhotoPut);
  await defaultChoice("Morning").click(); await settled();
  await home(); await page.reload();
  await openHomeSettings();
  assert.equal(await defaultChoice("Morning").getAttribute("aria-pressed"), "true", "Default survives reload");
  await customChoice("Morning").click(); await settled();
  assert.equal(await scene("Morning").locator("img").getAttribute("src"), customImage, "Custom image survives a reload while Default was active");
  for (const size of [{ width: 1083, height: 956 }, { width: 900, height: 600 }, { width: 420, height: 860 }]) {
    await page.setViewportSize(size);
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Home", exact: true }).click();
    const bounds = await page.locator(".panel").boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= size.width && bounds.y + bounds.height <= size.height, "Settings stays in the viewport");
    assert(await page.locator(".panel .body").evaluate(el => el.scrollWidth <= el.clientWidth), "Settings content has no horizontal overflow");
    assert.equal(await page.locator(".panel header .close").isVisible(), true);
  }
  assert.deepEqual(errors, []);
  const unavailable = await browser.newPage();
  await unavailable.addInitScript(() => Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new Error("Storage unavailable"); } } }));
  await unavailable.goto(origin);
  await unavailable.getByRole("button", { name: "Check Inbox", exact: true }).waitFor();
  await unavailable.getByRole("button", { name: "Check Inbox", exact: true }).click();
  await unavailable.locator("nav.sidebar").getByRole("button", { name: /Settings$/ }).click();
  await unavailable.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Home", exact: true }).click();
  await unavailable.getByRole("alert").filter({ hasText: "default collection is still available" }).waitFor();
  console.log("Home UI passed: compact geometry, five defaults, upload/resize, cancellation, per-stage selection, reload persistence, recovery after failed saves, unavailable storage, and responsive Settings.");
} finally {
  await browser?.close();
  server.kill();
}

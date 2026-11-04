import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const renderer = process.env.SKIM_RENDERER_EXE || resolve(root, "src-tauri/target/debug/examples/render_email.exe");
function sanitize(html, allowImages = false) {
  const result = spawnSync(renderer, allowImages ? ["--allow-remote-images"] : [], {
    input: html, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || "Build the render_email example first");
  return JSON.parse(result.stdout);
}

const fixture = await readFile(new URL("./fixtures/email-rendering.html", import.meta.url), "utf8");
const sanitized = sanitize(fixture);
const blocked = sanitize(`<style>.x { background: u\\72l(https://tracker.example/pixel) }</style>
  <div class="x">Safe text<script>parent.__emailScriptRan=true</script></div>
  <img src="https://tracker.example/pixel" onerror="parent.__emailScriptRan=true">`);
assert.equal(blocked.blockedImages, 1);
assert(!blocked.html.includes("tracker.example"));
assert(!blocked.html.includes("script"));

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "demo/vite.demo.config.ts"], {
  cwd: root, windowsHide: true, stdio: "pipe",
});
let serverOutput = "";
server.stdout.on("data", chunk => serverOutput += chunk);
server.stderr.on("data", chunk => serverOutput += chunk);
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw Error(`Vite exited: ${serverOutput}`);
    try { if ((await fetch("http://localhost:1421/demo/rendering.html")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
    if (attempt === 59) throw Error("Vite did not start");
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.SKIM_TEST_BROWSER || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = [];
  const external = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" && url.port === "1421") return route.continue();
    if (url.hostname === "skim-cid.localhost") {
      const small = url.pathname.endsWith("/small");
      return route.fulfill({ contentType: "image/svg+xml", body:
        `<svg xmlns="http://www.w3.org/2000/svg" width="${small ? 100 : 2104}" height="${small ? 50 : 905}"><rect x="20" y="20" width="600" height="400" rx="60" fill="#e53935"/><text x="20" y="820" font-size="250" fill="black">EXAMPLE</text></svg>` });
    }
    if (url.href === "https://mail.zoho.com/cpanel/mailimage?filename=zoho-logo.png" && process.env.SKIM_PRIVATE_LOGO) {
      return route.fulfill({ contentType: "image/png", body: await readFile(process.env.SKIM_PRIVATE_LOGO) });
    }
    external.push(url.hostname);
    return route.abort();
  });
  await page.goto("http://localhost:1421/demo/rendering.html");
  await page.waitForFunction(() => typeof window.setRenderingHtml === "function");
  const frame = page.frameLocator("iframe");
  async function show(html) {
    await page.evaluate(value => {
      window.__previousRenderingDocument = document.querySelector("iframe")?.contentDocument;
      window.setRenderingHtml(value);
    }, html);
    await page.waitForFunction(() => {
      const doc = document.querySelector("iframe")?.contentDocument;
      return doc !== window.__previousRenderingDocument && doc?.body?.childElementCount > 0;
    });
  }
  await show(sanitized.html);
  assert.notEqual(await frame.locator("body").evaluate(el => getComputedStyle(el).backgroundColor),"rgb(255, 255, 255)","App theme is the default");
  assert.equal(await page.getByLabel("Email appearance",{exact:true}).count(),0,"Appearance is an account setting");
  await page.evaluate(() => window.setRenderingAppearance("original"));
  await page.waitForFunction(() => {
    const body=document.querySelector("iframe")?.contentDocument?.body;
    return body && getComputedStyle(body).backgroundColor === "rgb(255, 255, 255)";
  });
  const logo = frame.getByAltText("Example logo");
  await logo.waitFor();
  await page.waitForFunction(() => [...document.querySelector("iframe").contentDocument.images].every(image => image.complete));
  const dimensions = await logo.boundingBox();
  assert(dimensions.width <= 120.1 && dimensions.height <= 40.1, JSON.stringify(dimensions));
  assert(dimensions.width > 50 && dimensions.height > 20);
  assert(await frame.locator('div[style*="max-width:660px"]').first().evaluate(el => el.getBoundingClientRect().width <= 660.1));
  assert.equal(await frame.getByText("Hidden preheader").isVisible(), false);
  assert.equal(await frame.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
  async function selectForCopy(target) {
    return target.evaluate(el => {
      const doc=el.ownerDocument, selection=doc.getSelection(), range=doc.createRange();
      range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);
      const menu=new MouseEvent("contextmenu", {bubbles:true,cancelable:true});
      el.dispatchEvent(menu);
      return {text:selection.toString(),prevented:menu.defaultPrevented};
    });
  }
  const greeting=frame.getByText("Hello Example User,", {exact:true});
  const selected=await selectForCopy(greeting);
  assert.equal(selected.prevented,true,"Native link actions cannot bypass the reader's safety controls");
  const copy=page.getByRole("menuitem",{name:/^Copy/});
  await copy.waitFor();
  assert(await copy.evaluate(el=>el===document.activeElement),"Copy is immediately keyboard accessible");
  await copy.click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),selected.text,"Right-click Copy writes selected email text");
  await page.getByRole("menu").waitFor({state:"detached"});
  await page.locator("iframe").focus();
  await page.keyboard.press("Control+c");
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),selected.text,"Ctrl+C copies the selected email text");
  await selectForCopy(greeting);
  await copy.press("Escape");
  await page.getByRole("menu").waitFor({state:"detached"});
  assert(await page.locator("iframe").evaluate(el=>el===document.activeElement),"Escape returns focus to the message");
  await selectForCopy(greeting);
  await page.evaluate(()=>Object.defineProperty(navigator.clipboard,"writeText",{configurable:true,value:async()=>{throw Error("Clipboard unavailable");}}));
  await copy.click();
  await page.getByRole("alert").filter({hasText:"Couldn't copy"}).waitFor();
  assert(await copy.isVisible(),"A failed copy stays available to retry");
  await page.evaluate(()=>delete navigator.clipboard.writeText);
  await copy.press("Enter");
  await page.getByRole("menu").waitFor({state:"detached"});
  assert.equal(await frame.locator("body").evaluate(el=>{
    el.ownerDocument.getSelection().removeAllRanges();
    const menu=new MouseEvent("contextmenu", {bubbles:true,cancelable:true});
    el.dispatchEvent(menu);return menu.defaultPrevented;
  }),true,"Unselected message areas still suppress the browser menu");
  await mkdir(resolve(root, "demo/output"), { recursive: true });
  await page.screenshot({ path: resolve(root, "demo/output/rendering-original.png"), fullPage: true });
  await logo.click();
  await page.getByRole("dialog", { name: "View image" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.evaluate(() => window.setRenderingAppearance("theme"));
  await page.waitForFunction(() => {
    const body = document.querySelector("iframe")?.contentDocument?.body;
    return body && getComputedStyle(body).backgroundColor !== "rgb(255, 255, 255)";
  });
  assert.equal(await frame.getByText("Hello Example User,").evaluate(el => getComputedStyle(el).color), "rgb(236, 236, 239)");
  await page.evaluate(() => window.setRenderingAppearance("original"));

  await page.setViewportSize({ width: 320, height: 700 });
  for (const [alt, attributes, maxWidth, maxHeight, ratio] of [
    ["fixed", 'width="800" height="400"', 280, 140, 2],
    ["height-only", 'height="40"', 100, 40, 2104 / 905],
    ["inline-fixed", 'style="width:800px;height:400px;max-width:800px"', 280, 140, 2],
    ["small", "", 100, 50, 2],
  ]) {
    await show(sanitize(`<img src="cid:${alt === "small" ? "small" : "logo"}" alt="${alt}" ${attributes}>`).html);
    const image = frame.getByAltText(alt);
    await image.waitFor();
    await page.waitForFunction(() => [...document.querySelector("iframe").contentDocument.images].every(image => image.complete));
    const box = await image.boundingBox();
    assert(box.width <= maxWidth + 0.1 && box.height <= maxHeight + 0.1, `${alt}: ${JSON.stringify(box)}`);
    assert(Math.abs(box.width / box.height - ratio) < 0.05, `${alt}: aspect ratio changed`);
  }
  await show('<pre class="skim-plain">Plain text follows the app theme.</pre>');
  await frame.getByText("Plain text follows the app theme.").waitFor();
  assert.equal(await page.getByRole("combobox").count(), 0);
  assert.notEqual(await frame.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
  await show('<p><a href="https://destination.example">Copy this linked text</a></p>');
  const linked=await selectForCopy(frame.getByText("Copy this linked text",{exact:true}));
  assert.equal(linked.prevented,true);
  await copy.click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),linked.text,"Linked text copies without opening its destination");
  await page.evaluate(()=>window.setRenderingConversation(true));
  await show(sanitize('<p>My new reply.</p><div class="gmail_quote"><div class="gmail_attr">On Tuesday, Example wrote:</div><p>Repeated earlier message.</p></div>').html);
  await frame.getByText("My new reply.",{exact:true}).waitFor();
  assert.equal(await frame.getByText("Repeated earlier message.",{exact:true}).count(),0);
  await page.getByRole("button",{name:"Show quoted history",exact:true}).click();
  await frame.getByText("Repeated earlier message.",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Hide quoted history",exact:true}).click();
  await show('<blockquote>An inline quotation that is part of the reply.</blockquote><p>My discussion.</p>');
  await frame.getByText("An inline quotation that is part of the reply.",{exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Show quoted history",exact:true}).count(),0);
  await show(sanitize('<div class="gmail_quote"><p>This quote is the entire message.</p></div>').html);
  await frame.getByText("This quote is the entire message.",{exact:true}).waitFor();
  await show('<pre class="skim-plain">My plain reply.\nOn Tuesday Example wrote:\nRepeated plain history.</pre>');
  await frame.getByText("My plain reply.",{exact:true}).waitFor();
  assert.equal(await frame.getByText("Repeated plain history.").count(),0);
  await page.getByRole("button",{name:"Show quoted history",exact:true}).click();
  await frame.getByText(/Repeated plain history/).waitFor();
  await page.evaluate(()=>window.setRenderingConversation(false));
  await show(blocked.html);
  await frame.getByText("Safe text").waitFor();
  assert.equal(await page.evaluate(() => window.__emailScriptRan), undefined);
  assert.deepEqual(external, [], "Rendering must not contact external image/style hosts");
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-same-origin");

  // Optional private reproduction runs only locally. Neither email nor output
  // is sent to CI, copied into the repo, or included in diagnostic messages.
  if (process.env.SKIM_PRIVATE_RENDER_HTML) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const privateHtml = await readFile(process.env.SKIM_PRIVATE_RENDER_HTML, "utf8");
    await show(sanitize(privateHtml, true).html);
    await page.waitForFunction(() => [...document.querySelector("iframe").contentDocument.images].every(image => image.complete));
    const privateBox = await frame.locator("img").first().boundingBox();
    assert(privateBox.width <= 120.1 && privateBox.height <= 40.1, "Private email logo must retain its authored size limits");
    await page.screenshot({ path: join(dirname(process.env.SKIM_PRIVATE_RENDER_HTML), "zoho-fixed.png"), fullPage: true });
    console.log(`Private cached email verified locally: logo ${privateBox.width.toFixed(1)} × ${privateBox.height.toFixed(1)} px.`);
  }
  assert.deepEqual(errors, []);
  console.log("Rendering passed: stylesheet sizing, original/theme appearance, responsive image dimensions, image enlargement, plain text and blocked external content.");
} finally {
  await browser?.close();
  server.kill();
}

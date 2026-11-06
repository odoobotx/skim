import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir} from "node:fs/promises";
import {chromium} from "playwright";

// Synthetic mail in a separate headless browser; no live mailbox actions.
const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--config","demo/vite.demo.config.ts","--port","1423"],{cwd:new URL("..",import.meta.url),windowsHide:true,stdio:"pipe"});
let output="",browser;
server.stdout.on("data",chunk=>output+=chunk);server.stderr.on("data",chunk=>output+=chunk);
try {
  for(let attempt=0;attempt<60;attempt++) {
    if(server.exitCode!==null) throw Error(output);
    try {if((await fetch("http://localhost:1423")).ok) break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
    if(attempt===59) throw Error(output);
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.SKIM_TEST_BROWSER || undefined});
  const page=await browser.newPage({viewport:{width:1155,height:956},timezoneId:"America/Chicago"});
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem("skimdemo.taskInbox","on"));
  await page.goto("http://localhost:1423");
  await page.getByRole("button",{name:"Check Inbox",exact:true}).click();
  const dock=page.locator(".compose-dock"), reader=page.locator(".reading-host");
  const form=dock.locator(".draft-host:not([hidden]) .compose-form"), to=form.getByRole("textbox",{name:"To",exact:true}), body=form.getByRole("textbox",{name:"Message body",exact:true});
  const calls=cmd=>page.evaluate(async cmd=>(await import("/demo/mock/tauri-core.ts")).commandLog.filter(call=>call.cmd===cmd),cmd);
  await page.locator("nav.sidebar").getByRole("button",{name:/Compose/}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="To");
  assert.equal(await dock.getAttribute("aria-modal"),"false");
  await to.fill("test@example.com");
  await form.locator("input.subject").fill("A draft to keep");
  await body.fill("Keep this text while I read other mail.");
  const composeId=await page.evaluate(async()=>(await import("/src/lib/stores/ui.svelte.ts")).ui.activeComposeId);
  await page.evaluate(()=>localStorage.setItem("skimdemo.longEmail","on"));
  await page.locator("section.list button.row").filter({hasText:"Anna Weber"}).first().click();
  await reader.locator("iframe").first().waitFor();
  await page.waitForFunction(()=>{const el=document.querySelector(".reading-host .scroll");return el && el.scrollHeight>el.clientHeight+600;});
  await reader.locator(".scroll").hover({position:{x:30,y:40}});
  await page.mouse.wheel(0,650);
  await page.waitForFunction(()=>document.querySelector(".reading-host .scroll").scrollTop>200);
  assert.equal(await body.inputValue(),"Keep this text while I read other mail.");
  await page.evaluate(()=>localStorage.removeItem("skimdemo.longEmail"));
  await reader.getByRole("button",{name:"Back to list",exact:true}).click();
  await page.locator("section.list button.row").filter({hasText:"Priya Nair"}).click();
  await reader.locator("iframe").first().waitFor();
  assert.equal(await body.inputValue(),"Keep this text while I read other mail.","Opening a different email must preserve the composer");
  await body.focus();
  await page.keyboard.press("Control+s");
  await form.getByText("Draft saved",{exact:true}).waitFor();
  assert.equal((await calls("send_draft")).length,0,"Ctrl+S saves without sending");
  assert((await calls("save_server_draft")).some(call=>call.args.draft.id===composeId));
  await dock.getByRole("button",{name:"Expand composer",exact:true}).click();
  const full=await dock.boundingBox();assert(full.width>1100 && full.height>850);
  await dock.getByRole("button",{name:"Restore docked composer",exact:true}).click();
  assert.equal(await body.inputValue(),"Keep this text while I read other mail.");
  await dock.getByRole("button",{name:"Minimize composer",exact:true}).click();
  assert(!(await body.isVisible()));
  await dock.getByRole("button",{name:"Restore composer",exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="Message body");
  assert.equal(await body.inputValue(),"Keep this text while I read other mail.");

  // A second draft keeps the first mounted, without sharing Send shortcuts.
  await page.keyboard.press("Control+n");
  await page.waitForFunction(()=>document.querySelectorAll(".compose-dock .draft-host").length===2);
  await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="To");
  assert(!(await body.inputValue()).includes("Keep this text"),"The second draft starts independently, with its own signature");
  await to.fill("second@example.com");await body.fill("Only the second draft sends.");
  await body.press("Control+Enter");
  await page.waitForFunction(()=>document.querySelectorAll(".compose-dock .draft-host").length===1);
  assert.equal(await body.inputValue(),"Keep this text while I read other mail.");
  assert.notEqual((await calls("send_draft")).at(-1).args.draftId,composeId,"Sending the active draft leaves hidden drafts untouched");

  // Send failure is visible and retry keeps the entire draft intact.
  const sendsBeforeRetry=(await calls("send_draft")).length;
  await page.evaluate(()=>localStorage.setItem("skimdemo.failSend","on"));
  await body.focus();await page.keyboard.press("Control+Enter");
  await form.getByRole("alert").filter({hasText:"Synthetic send failure"}).waitFor();
  assert.equal(await body.inputValue(),"Keep this text while I read other mail.");
  await page.evaluate(()=>localStorage.removeItem("skimdemo.failSend"));
  await dock.getByRole("button",{name:"Expand composer",exact:true}).click();
  await page.keyboard.press("Control+Enter");
  await dock.waitFor({state:"hidden"});
  assert.equal((await calls("send_draft")).length,sendsBeforeRetry+2,"Ctrl+Enter also works from composer controls and submits once");

  // Replies and forwards focus at the start of the body, with history preserved.
  for(const mode of ["reply","forward"]) {
    await reader.getByRole("button",{name:mode==="reply" ? /^Reply/ : /^Forward/}).first().click();
    await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="Message body");
    assert.equal(await body.evaluate(el=>el.selectionStart),0);
    assert(!((await body.inputValue()).includes("wrote:")),"Quoted text stays out of the editable reply body");
    if(mode==="forward") assert.equal(await to.inputValue(),"");
    assert.equal(await form.getByRole("button",{name:"Show quoted text",exact:true}).count(),0,"Docked replies keep history hidden");
    const id=await page.evaluate(async()=>(await import("/src/lib/stores/ui.svelte.ts")).ui.activeComposeId);
    const original=await page.evaluate(async id=>(await import("/demo/mock/data.ts")).getDraft(id).body,id);
    const quote=original.slice(original.indexOf("\n\nOn "));
    await body.fill(`My ${mode}.`);
    await dock.getByRole("button",{name:"Expand composer",exact:true}).click();
    await form.getByRole("button",{name:"Show quoted text",exact:true}).click();
    await form.locator(".quoted-history").waitFor();
    assert((await form.locator(".quoted-history").textContent()).includes("wrote:"));
    await form.getByRole("button",{name:"Hide quoted text",exact:true}).click();
    assert.equal(await body.inputValue(),`My ${mode}.`);
    await body.press("Control+s");
    await form.getByText("Draft saved",{exact:true}).waitFor();
    const saved=(await calls("save_server_draft")).at(-1).args.draft;
    assert.equal(saved.body,`My ${mode}.`+quote,"Saving must keep the hidden quote byte-for-byte");
    await to.fill("test@example.com");
    await body.focus();await page.keyboard.press("Control+Enter");
    await dock.waitFor({state:"hidden"});
    const sent=(await calls("update_draft")).filter(call=>call.args.draft.id===id).at(-1).args.draft;
    assert.equal(sent.body,`My ${mode}.`+quote,"Sending includes the hidden history");
  }

  // A failed close/save leaves the editor open; pop-out waits for local writes.
  await page.locator("nav.sidebar").getByRole("button",{name:/Compose/}).click();
  await body.fill("A draft that must survive errors.");
  await page.evaluate(()=>localStorage.setItem("skimdemo.failDraftSave","on"));
  await dock.getByRole("button",{name:"Close and save draft",exact:true}).click();
  await form.getByRole("alert").filter({hasText:"Synthetic draft save failure"}).waitFor();
  assert(await dock.isVisible());
  await page.evaluate(()=>localStorage.removeItem("skimdemo.failDraftSave"));
  await dock.getByRole("button",{name:"Open composer in a new window",exact:true}).click();
  await dock.waitFor({state:"hidden"});
  const opened=(await calls("open_compose_window")).at(-1);
  const writes=await calls("update_draft");
  assert(writes.some(call=>call.args.draft.id===opened.args.draftId && call.args.draft.body==="A draft that must survive errors."));

  // A delayed explicit save cannot overwrite newer text being sent.
  await page.locator("nav.sidebar").getByRole("button",{name:/Compose/}).click();
  await to.fill("latest@example.com");await body.fill("Older text");
  await page.evaluate(async()=>{
    const {api}=await import("/src/lib/api.ts"),original=api.saveServerDraft;
    let release;const gate=new Promise(resolve=>{release=resolve;});
    window.releaseDraftSave=release;
    api.saveServerDraft=async draft=>{window.draftSaveStarted=true;await gate;api.saveServerDraft=original;return original(draft);};
  });
  await body.press("Control+s");
  await page.waitForFunction(()=>window.draftSaveStarted);
  await body.fill("Newer text must win");
  const sendsBeforeGate=(await calls("send_draft")).length;
  await body.press("Control+Enter");
  assert.equal((await calls("send_draft")).length,sendsBeforeGate,"Send waits for the pending write");
  await page.evaluate(()=>window.releaseDraftSave());
  await dock.waitFor({state:"hidden"});
  assert.equal((await calls("update_draft")).at(-1).args.draft.body,"Newer text must win");
  assert.equal((await calls("send_draft")).length,sendsBeforeGate+1);
  await mkdir(new URL("../demo/output/",import.meta.url),{recursive:true});
  await page.screenshot({path:new URL("../demo/output/compose-test-complete.png",import.meta.url).pathname.replace(/^\/(\w:)/,"$1")});
  assert.deepEqual(errors,[]);
  console.log("Compose UI passed: docked reading, focus, expand/minimize, multiple drafts, Ctrl+S, Ctrl+Enter, quote preservation, send/save failure and pop-out.");
} finally {await browser?.close();server.kill();}

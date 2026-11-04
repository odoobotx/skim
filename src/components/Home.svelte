<script lang="ts">
  import { onMount } from "svelte";
  import { api, reportError } from "../lib/api";
  import { mail } from "../lib/stores/mail.svelte";
  import { ui } from "../lib/stores/ui.svelte";
  import { palette } from "../lib/stores/palette.svelte";
  import type { ThreadRow } from "../lib/types";
  let now = $state(new Date());
  let composeError = $state(false);
  let composing = $state(false);
  let recentFailed = $state(false);
  let recent = $state<ThreadRow[]>([]);
  let newUnread = $state(0);
  let recentLoaded = $state(false);
  onMount(() => {
    const timer = setInterval(() => now = new Date(), 60000);
    return () => clearInterval(timer);
  });
  const greeting = $derived(now.getHours() < 12 ? "Good morning." : now.getHours() < 18 ? "Good afternoon." : "Good evening.");
  const inbox = $derived(mail.folders.find(folder => folder.role === "inbox"));
  $effect(() => {
    void mail.threads;
    if (!mail.accounts.length) return;
    const account = mail.unified ? null : mail.account?.id ?? null;
    let active = true;
    void mail.newUnread(account).then(summary => { if (active) { recent = summary.rows; newUnread = summary.total; recentFailed = false; recentLoaded = true; } })
      .catch(error => { if (active) { recentFailed = true; recentLoaded = true; } reportError("home.unread", error); });
    return () => { active = false; };
  });
  $effect(() => {
    if (inbox && inbox.id !== mail.selectedFolderId) void mail.selectFolder(inbox.id);
  });
  async function enter() {
    mail.selectedThreadId = null;
    mail.selectedMessageId = null;
    ui.showInbox();
    if (inbox && inbox.id !== mail.selectedFolderId) await mail.selectFolder(inbox.id);
  }
  async function open(row: ThreadRow) {
    await enter();
    mail.selectedThreadId = row.id;
    mail.selectedMessageId = row.messageId ?? null;
  }
  async function compose() {
    if (composing) return;
    composing = true;
    composeError = false;
    try {
      const draft = await api.createDraft(await mail.composeAccountId());
      ui.openComposer(draft);
    } catch (error) {
      reportError("home.compose", error);
      composeError = true;
    } finally { composing = false; }
  }
  function time(date: number) {
    const d = new Date(date * 1000);
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
</script>

<section class="home" aria-label="Home">
  <div class="topline">
    <div><time>{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</time>
      <div class="clock">{now.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})}</div></div>
    <div class="tools">
      <button onclick={() => palette.show()} aria-label="Search mail">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.8"/><path d="m13 13 4.5 4.5"/></svg><span>Search</span>
      </button>
      <button onclick={() => void compose()} disabled={composing} aria-label="Compose">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m13 3 4 4-9 9-5 1 1-5zM11 5l4 4"/></svg><span>Compose</span>
      </button>
    </div>
  </div>
  <div class="welcome">
    <h1>{greeting}</h1>
    <button class="enter" onclick={() => void enter()}>Check Inbox</button>
    <p class="status">{#if mail.loadFailed || recentFailed}Mail couldn't load. Open Inbox to retry.
      {:else if !recentLoaded}Checking for new mail…
      {:else if newUnread > 0}{newUnread.toLocaleString()} new unread {newUnread === 1 ? "email" : "emails"}
      {:else}No New Emails{/if}</p>
    {#if composeError}<p class="error" role="alert">Couldn't open the composer. Please try again.</p>{/if}
    {#if recent.length}
      <div class="latest"><h2>New Unread Emails</h2><ul>
        {#each recent as row (row.messageId ?? row.id)}
          <li><button class="mail-preview" onclick={() => void open(row)}>
            <span class="sender">{row.fromName || row.fromAddr}</span>
            <span class="subject">{row.subject || "No subject"}</span><time>{time(row.date)}</time>
          </button></li>
        {/each}
      </ul></div>
    {/if}
  </div>
</section>

<style>
  .home { position:relative; isolation:isolate; flex:1; overflow:auto; display:flex; flex-direction:column; padding:72px 44px 32px; color:#fff; background:#17342f; background-image:linear-gradient(180deg,#061b1940,#06151170),url("/home-nature.png"); background-size:cover; background-position:center; }
  .topline { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  .topline time { font-size:12px; color:#ffffffe0; } .clock { margin-top:8px; font-size:30px; font-weight:350; letter-spacing:-1px; }
  .tools { display:flex; gap:10px; }
  .tools button { display:flex; gap:9px; align-items:center; padding:11px 14px; border:1px solid #ffffff55; border-radius:26px; color:#fff; font-size:12px; background:#071b1920; }
  .tools button:hover { background:#ffffff20; } .tools button:disabled { opacity:.5; }
  .welcome { width:min(760px,100%); margin:auto; padding:64px 0 88px; text-align:center; }
  h1 { margin:0 0 28px; font-size:clamp(36px,5vw,62px); font-weight:550; letter-spacing:-1.8px; line-height:1.12; text-shadow:0 2px 24px #0003; }
  .enter { display:inline-flex; gap:24px; align-items:center; padding:13px 24px; border-radius:30px; background:#f7faf7; color:#153b33; font-weight:600; font-size:13px; box-shadow:0 4px 22px #0001; }
  .enter:hover { background:#fff; } .status { margin:16px 0 0; font-size:12px; color:#ffffffe0; }
  .latest { margin:32px auto 0; text-align:left; width:100%; }
  h2 { font-size:11px; font-weight:500; color:#ffffffe0; margin:0 12px 10px; }
  ul { padding:0; margin:0; list-style:none; display:grid; gap:4px; }
  .mail-preview { display:grid; grid-template-columns:minmax(100px,25%) minmax(0,1fr) 68px; gap:16px; align-items:center; width:100%; padding:12px 16px; border-radius:9px; background:#0b242ab8; border:1px solid #ffffff18; color:#fff; text-align:left; font-size:12px; }
  .mail-preview:hover { background:#193e42e8; border-color:#ffffff55; }
  .sender,.subject { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sender { font-weight:600; } .subject { color:#ffffffe8; } .mail-preview time { font-size:10px; color:#ffffffca; text-align:right; }
  .home :focus-visible { outline:2px solid #fff; outline-offset:3px; }
  .error { margin:12px; font-size:12px; }
  @media(max-width:650px) { .home { padding:64px 24px 24px; } .tools button span { display:none; } .tools button { padding:12px; } .mail-preview { grid-template-columns:minmax(80px,30%) minmax(0,1fr); gap:12px; } .mail-preview time { display:none; } }
  @media(max-height:700px) { .welcome { padding:30px 0; } h1 { font-size:40px; margin-bottom:20px; } .latest { margin-top:22px; } }
</style>

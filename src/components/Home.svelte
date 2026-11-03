<script lang="ts">
  import { onMount } from "svelte";
  import { mail } from "../lib/stores/mail.svelte";
  import { ui } from "../lib/stores/ui.svelte";
  import { palette } from "../lib/stores/palette.svelte";
  let now = $state(new Date());
  onMount(() => {
    const timer = setInterval(() => now = new Date(), 60000);
    return () => clearInterval(timer);
  });
  const greeting = $derived(now.getHours() < 12 ? "Good morning." : now.getHours() < 18 ? "Good afternoon." : "Good evening.");
  const unread = $derived(mail.folders.find(f => f.role === "inbox")?.unreadCount ?? 0);
  async function enter() {
    ui.showInbox();
    const inbox = mail.folders.find(f => f.role === "inbox");
    if (inbox && inbox.id !== mail.selectedFolderId) await mail.selectFolder(inbox.id);
  }
</script>

<section class="home" aria-label="Home">
  <div class="topline">
    <div><time>{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</time>
      <div class="clock">{now.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})}</div></div>
    <button class="search" onclick={() => palette.show()} aria-label="Search mail">Search mail <kbd>Ctrl K</kbd></button>
  </div>
  <div class="welcome">
    <div class="mark" aria-hidden="true">✓</div>
    <p class="eyebrow">A LITTLE SPACE TO THINK</p>
    <h1>{greeting}</h1>
    <p class="sub">Your mail, at your pace.</p>
    <button class="enter" onclick={() => void enter()}>Check Inbox <span aria-hidden="true">↗</span></button>
    <p class="status">{#if mail.loadFailed}Mail couldn't load. Open Inbox to retry.
      {:else if mail.syncState === "syncing"}Catching up on your mail…
      {:else if unread > 0}{unread.toLocaleString()} unread · {mail.accounts.length} {mail.accounts.length === 1 ? "mailbox" : "mailboxes"}
      {:else}A quiet inbox. Enjoy the space.{/if}</p>
  </div>
  <div class="foot">SKIM TASKS <span>Less noise. More clarity.</span></div>
</section>

<style>
  .home { position:relative; isolation:isolate; flex:1; overflow:hidden; display:flex; flex-direction:column; padding:36px 48px; background:var(--bg); }
  .home::before { content:""; position:absolute; z-index:-1; width:900px; height:900px; right:-260px; top:-330px; border-radius:50%; background:radial-gradient(ellipse, color-mix(in srgb, #749f9a 18%, transparent),transparent 67%); pointer-events:none; }
  .home::after { content:""; position:absolute; z-index:-1; width:800px; height:800px; left:-250px; bottom:-460px; border-radius:50%; background:radial-gradient(ellipse, color-mix(in srgb, #c3a778 14%, transparent),transparent 68%); pointer-events:none; }
  .topline { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  time { font-size:12px; color:var(--text-dim); } .clock { margin-top:8px; font-size:28px; font-weight:350; letter-spacing:-1px; }
  .search { display:flex; gap:24px; align-items:center; padding:10px 14px; border:1px solid var(--hairline); border-radius:24px; color:var(--text-dim); font-size:12px; }
  kbd { font-size:10px; color:var(--text-faint); }
  .welcome { margin:auto; padding:48px 16px 90px; text-align:center; }
  .mark { display:grid; place-items:center; margin:0 auto 34px; width:48px; height:48px; border:1px solid color-mix(in srgb, #749f9a 45%, transparent); border-radius:16px; font-size:23px; color:#749f9a; transform:rotate(-6deg); }
  .eyebrow { font-size:10px; letter-spacing:2.5px; color:var(--text-faint); }
  h1 { margin:18px 0 12px; font-size:clamp(32px,5vw,64px); font-weight:450; letter-spacing:-2px; line-height:1.1; }
  .sub { color:var(--text-dim); font-size:16px; }
  .enter { display:inline-flex; gap:30px; align-items:center; margin-top:30px; padding:14px 24px; border-radius:30px; background:var(--text); color:var(--bg); font-weight:600; font-size:13px; transition:transform .15s; }
  .enter:hover { transform:translateY(-2px); } .status { margin-top:18px; font-size:11px; color:var(--text-faint); }
  .foot { display:flex; justify-content:space-between; gap:20px; font-size:9px; letter-spacing:2px; color:var(--text-faint); } .foot span { letter-spacing:0; font-size:11px; }
  @media(max-width:700px) { .home { padding:24px; } .search kbd { display:none; } }
  @media(prefers-reduced-motion:reduce) { .enter { transition:none; } }
</style>

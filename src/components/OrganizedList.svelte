<script lang="ts">
  import { onDestroy } from "svelte";
  import { reportError } from "../lib/api";
  import { groupInbox, inboxSection, senderAddress, type Category, type GroupBy, type SenderRules } from "../lib/inbox";
  import { t } from "../lib/i18n/index.svelte";
  import { mail, rowKey } from "../lib/stores/mail.svelte";
  import type { ThreadRow } from "../lib/types";
  import MessageRow from "./MessageRow.svelte";

  let { rules, saveRule }: {
    rules: SenderRules;
    saveRule: (address: string, patch: { priority?: boolean; category?: Category }) => Promise<void>;
  } = $props();
  let mode = $state<GroupBy>("sender");
  let category = $state<string | null>(null);
  let sender = $state<string | null>(null);
  let busy = $state<number[]>([]);
  const isInbox = $derived(mail.selectedFolder?.role === "inbox");
  const sections = ["notifications", "newsletters"] as const;
  let limit = $state(100);
  const priorityRows = $derived(mail.threads.filter(row => inboxSection(row, rules) === "priority"));
  const ordinaryGroups = $derived(groupInbox(mail.threads.filter(row => inboxSection(row, rules) === "mail"), mode));
  const scoped = $derived(!isInbox || (category === null && sender === null) ? mail.threads
    : mail.threads.filter(row => inboxSection(row, rules) === (category ?? "mail")));
  const groups = $derived(groupInbox(scoped, mode));
  const opened = $derived(groups.find(group => group.key === sender));
  const openedRows = $derived(opened?.rows ?? []);

  // Folder/account switches must not inherit a previous sender drill-down.
  $effect(() => {
    void mail.selectedFolderId;
    void mail.unified;
    category = null;
    sender = null;
  });
  $effect(() => {
    const rows = sender !== null ? openedRows.slice(0, limit)
      : isInbox && category === null
        ? [...priorityRows.slice(0, 5), ...ordinaryGroups.slice(0, limit).filter(g => g.rows.length === 1).flatMap(g => g.rows)]
        : groups.slice(0, limit).filter(g => g.rows.length === 1).flatMap(g => g.rows);
    mail.setNavigationRows(rows.map(rowKey));
  });
  onDestroy(() => mail.setNavigationRows(null));

  function navigate(nextCategory: string | null, nextSender: string | null = null) {
    mail.clearSelection();
    mail.selectedThreadId = null;
    mail.selectedMessageId = null;
    category = nextCategory;
    sender = nextSender;
    limit = 100;
  }

  async function done(row: ThreadRow) {
    if (busy.includes(rowKey(row))) return;
    busy = [...busy, rowKey(row)];
    try {
      await mail.setDone(row, !row.isDone);
    } catch (error) {
      reportError("inbox.done", error);
      mail.noteError(t("ops.failed"));
      await mail.refreshThreads();
    } finally {
      busy = busy.filter(key => key !== rowKey(row));
    }
  }

  let sweep = $state<number[]>([]);
  let pointer: number | null = null;
  let previousY = 0;
  let sweepDone = true;
  let snapshot: ThreadRow[] = [];
  let root: HTMLDivElement;

  async function complete(rows: ThreadRow[], done = !rows.every(row => row.isDone)) {
    if (!rows.length || busy.length) return;
    busy = rows.map(rowKey);
    try { await mail.setDoneRows(rows, done); }
    catch (error) { reportError("inbox.done", error); mail.noteError(t("ops.failed")); }
    finally { busy = []; }
  }
  function begin(rows: ThreadRow[], event: PointerEvent) {
    if (event.button !== 0 || busy.length || pointer !== null) return;
    event.preventDefault();
    pointer = event.pointerId;
    previousY = event.clientY;
    snapshot = [...mail.threads];
    sweepDone = !rows.every(row => row.isDone);
    sweep = rows.map(rowKey);
  }
  function move(event: PointerEvent) {
    if (pointer !== event.pointerId) return;
    if (!(event.buttons & 1)) { cancel(); return; }
    const low = Math.min(previousY, event.clientY), high = Math.max(previousY, event.clientY);
    const keys = new Set(sweep);
    for (const button of root.querySelectorAll<HTMLElement>("[data-done-ids]")) {
      const rect = button.getBoundingClientRect();
      if (event.clientX >= rect.left - 8 && event.clientX <= rect.right + 8 && high >= rect.top && low <= rect.bottom) {
        for (const id of button.dataset.doneIds!.split(",")) keys.add(Number(id));
      }
    }
    sweep = [...keys];
    previousY = event.clientY;
  }
  function finish(event: PointerEvent) {
    if (pointer !== event.pointerId) return;
    const keys = new Set(sweep);
    const rows = snapshot.filter(row => keys.has(rowKey(row)));
    cancel();
    void complete(rows, sweepDone);
  }
  function cancel() { pointer = null; sweep = []; snapshot = []; }
</script>

<svelte:window onpointermove={move} onpointerup={finish} onpointercancel={cancel} onblur={cancel} />
<div bind:this={root} class="organized" class:sweeping={sweep.length > 0}>
<div class="organize">
  {#if isInbox}<label class="show-done"><input type="checkbox" checked={mail.showDone}
    onchange={(event) => void mail.setShowDone(event.currentTarget.checked).catch(error => { reportError("inbox.showDone", error); mail.noteError(t("ops.failed")); })} /> Show Done</label>{/if}
  <label>{t("inbox.group_by")}
    <select bind:value={mode} onchange={() => navigate(category)}>
      <option value="sender">{t("inbox.by_sender")}</option>
      <option value="address">{t("inbox.by_address")}</option>
      <option value="none">{t("inbox.by_conversation")}</option>
    </select>
  </label>
  {#if category !== null || sender !== null}
    <button class="back" onclick={() => navigate(sender !== null ? category : null)}>
      ← {sender !== null ? t("inbox.back_senders") : t("inbox.back_inbox")}
    </button>
  {/if}
  <small>{t("inbox.loaded", { n: scoped.length })}</small>
</div>

{#snippet summary(label: string, rows: ThreadRow[], open: () => void)}
  <div class="group-row" class:completed={rows.every(row => row.isDone)}>
  {#if isInbox}<button class="group-done" data-done-ids={rows.map(rowKey).join(",")}
    aria-label={`${rows.every(row => row.isDone) ? "Mark Undone" : "Mark Done"}: ${label}`}
    onpointerdown={(event) => begin(rows, event)}
    onclick={(event) => { if (event.detail === 0) void complete(rows); }}
    class:staged={rows.some(row => sweep.includes(rowKey(row)))}>✓</button>{/if}
  <button class="summary" onclick={open}>
    <span class="summary-title">{label}<span class="count">{rows.length}</span><span class="arrow">›</span></span>
    <span class="preview">{rows.slice(0, 3).map(row => row.subject).join(" · ")}</span>
    <span class="unread">{t("inbox.unread_conversations", { n: rows.filter(row => !row.isRead).length })}</span>
  </button>
  </div>
{/snippet}

{#snippet message(row: ThreadRow)}
  <div class="message-wrap">
  <MessageRow thread={row}
    selected={mail.groupThreads ? mail.selectedThreadId === row.id : mail.selectedMessageId === row.messageId}
    checked={mail.isSelected(rowKey(row))}
    onselect={() => { mail.selectedThreadId = row.id; mail.selectedMessageId = row.messageId ?? null; }}
    ontoggle={(extend) => mail.toggleRow(rowKey(row), extend)}
    ondone={isInbox ? () => void done(row) : undefined}
    ondonepointer={isInbox ? (event) => begin([row], event) : undefined}
    completing={sweep.includes(rowKey(row))}
  />
  {#if isInbox}
    <details class="actions"><summary aria-label="Sender options">···</summary><div class="sender-options">
      {#if senderAddress(row)}
        <button aria-pressed={rules[senderAddress(row)]?.priority ?? false}
          onclick={() => void saveRule(senderAddress(row), { priority: !rules[senderAddress(row)]?.priority })}>
          {rules[senderAddress(row)]?.priority ? "⚡" : "+"} {t("inbox.priority_sender")}
        </button>
        <select aria-label={t("inbox.sender_category")} value={rules[senderAddress(row)]?.category ?? row.category ?? "mail"}
          onchange={(event) => void saveRule(senderAddress(row), { category: event.currentTarget.value as Category })}>
          <option value="mail">{t("inbox.mail")}</option>
          <option value="notifications">{t("inbox.notifications")}</option>
          <option value="newsletters">{t("inbox.newsletters")}</option>
        </select>
      {/if}
    </div></details>
  {/if}
  </div>
{/snippet}

{#if isInbox && category === null && sender === null}
  {#if priorityRows.length}
    <div class="priority">
      <h2>{t("inbox.priority")}</h2>
      {#each priorityRows.slice(0, 5) as row (rowKey(row))}{@render message(row)}{/each}
      {#if priorityRows.length > 5}
        <button class="more" onclick={() => navigate("priority")}>{t("inbox.show_priority", { n: priorityRows.length })}</button>
      {/if}
    </div>
  {/if}
  {#if ordinaryGroups.length}<h2>People</h2>{/if}
  {#each ordinaryGroups.slice(0, limit) as group (group.key)}
    {#if group.rows.length === 1}
      {@render message(group.rows[0])}
    {:else}
      {@render summary(group.label, group.rows, () => navigate(null, group.key))}
    {/if}
  {/each}
  {#if ordinaryGroups.length > limit}<button class="more" onclick={() => limit += 100}>{t("inbox.show_more")}</button>{/if}
  {#each sections as section}
    {@const rows = mail.threads.filter(row => inboxSection(row, rules) === section)}
    {#if rows.length}
      {@render summary(t(`inbox.${section}`), rows, () => navigate(section))}
    {/if}
  {/each}
{:else if sender !== null}
  <h2>{opened?.label ?? t("inbox.empty_group")}</h2>
  {#each openedRows.slice(0, limit) as row (rowKey(row))}{@render message(row)}{/each}
  {#if openedRows.length > limit}<button class="more" onclick={() => limit += 100}>{t("inbox.show_more")}</button>{/if}
{:else}
  {#each groups.slice(0, limit) as group (group.key)}
    {#if group.rows.length === 1}
      {@render message(group.rows[0])}
    {:else}
      {@render summary(group.label, group.rows, () => navigate(category, group.key))}
    {/if}
  {/each}
  {#if groups.length > limit}<button class="more" onclick={() => limit += 100}>{t("inbox.show_more")}</button>{/if}
{/if}

</div>
<style>
  .organized { padding:0 12px 28px; }
  .sweeping { user-select:none; }
  .message-wrap, .group-row { position:relative; }
  .group-done { position:absolute; z-index:2; left:8px; top:16px; width:26px; height:28px; opacity:0; color:var(--text-dim); border-radius:8px; touch-action:none; }
  .group-row:hover .group-done, .group-done:focus-visible, .group-done.staged { opacity:1; }
  .group-done:hover, .group-done.staged { color:#749f9a; background:color-mix(in srgb,#749f9a 20%,transparent); }
  .completed .summary { opacity:.48; }
  .show-done { margin-left:auto; display:flex; align-items:center; gap:6px; }
  .show-done input { accent-color:#749f9a; }
  .actions { position:absolute; right:12px; bottom:7px; font-size:11px; }
  .actions>summary { cursor:pointer; padding:2px 8px; opacity:0; list-style:none; border-radius:5px; }
  .message-wrap:hover .actions>summary, .actions:focus-within>summary, .actions[open]>summary { opacity:1; }
  .sender-options { position:absolute; right:0; top:100%; width:200px; padding:12px; background:var(--surface); border:1px solid var(--hairline); border-radius:10px; box-shadow:0 8px 28px #0002; z-index:10; display:grid; gap:10px; }
  @media(hover:none) { .group-done, .actions>summary { opacity:1; } }
  .organize { padding: 8px 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-bottom: 1px solid var(--hairline); }
  label, small, .back, .unread { font-size: 11px; color: var(--text-faint); }
  select { max-width: 145px; background: var(--bg); color: var(--text); border: 1px solid var(--hairline); border-radius: 4px; padding: 3px; font: inherit; }
  small { width: 100%; }
  .summary { display: block; width: 100%; text-align: left; padding: 14px 22px 14px 42px; border-bottom: 1px solid var(--hairline); border-radius:10px; }
  .summary:hover { background: var(--hover); }
  .summary-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; }
  .count { font-size: 11px; font-weight: 400; color: var(--text-faint); }
  .arrow { margin-left: auto; }
  .preview { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 4px 0; font-size: 12px; color: var(--text-dim); }
  .priority { margin:12px 0; border-radius:14px; background:color-mix(in srgb,#b68b35 8%,var(--bg)); }
  .priority h2 { color:#b68b35; }
  h2 { font-size: 13px; padding: 12px 16px; }
  .more { width: 100%; padding: 12px 16px; font-size: 12px; color: var(--text-dim); text-align: left; }
  .actions button { color: var(--text-dim); }
  .actions button[aria-pressed="true"] { color: #b68b35; }
  .actions button:disabled { opacity: 0.5; }
</style>

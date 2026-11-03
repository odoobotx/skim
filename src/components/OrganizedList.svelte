<script lang="ts">
  import { onDestroy } from "svelte";
  import { api, reportError } from "../lib/api";
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
  const scoped = $derived(category === null || !isInbox ? mail.threads
    : mail.threads.filter(row => inboxSection(row, rules) === category));
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
      const detail = await api.getThread(row.id);
      const candidates = detail.messages.filter(m => row.messageId == null || m.id === row.messageId);
      const folderIds = [...new Set(candidates.map(m => m.folderId))];
      const inboxFolders = new Set<number>();
      for (const id of folderIds) {
        if ((await api.folderRef(id)).role === "inbox") inboxFolders.add(id);
      }
      // Complete only the inbox copies, never the sent side of a conversation.
      const ids = candidates.filter(m => inboxFolders.has(m.folderId)).map(m => m.id);
      if (!ids.length) return;
      await api.archiveMessages(ids);
      mail.removeRowsFromList([rowKey(row)]);
    } catch (error) {
      reportError("inbox.done", error);
      mail.noteError(t("ops.failed"));
      await mail.refreshThreads();
    } finally {
      busy = busy.filter(key => key !== rowKey(row));
    }
  }
</script>

<div class="organize">
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
  <button class="summary" onclick={open}>
    <span class="summary-title">{label}<span class="count">{rows.length}</span><span class="arrow">›</span></span>
    <span class="preview">{rows.slice(0, 3).map(row => row.subject).join(" · ")}</span>
    <span class="unread">{t("inbox.unread_conversations", { n: rows.filter(row => !row.isRead).length })}</span>
  </button>
{/snippet}

{#snippet message(row: ThreadRow)}
  <MessageRow thread={row}
    selected={mail.groupThreads ? mail.selectedThreadId === row.id : mail.selectedMessageId === row.messageId}
    checked={mail.isSelected(rowKey(row))}
    onselect={() => { mail.selectedThreadId = row.id; mail.selectedMessageId = row.messageId ?? null; }}
    ontoggle={(extend) => mail.toggleRow(rowKey(row), extend)}
  />
  {#if isInbox}
    <div class="actions">
      <button disabled={busy.includes(rowKey(row))} onclick={() => void done(row)} title={t("inbox.done_hint")}>✓ {t("inbox.done")}</button>
      {#if senderAddress(row)}
        <button aria-pressed={rules[senderAddress(row)]?.priority ?? false}
          onclick={() => void saveRule(senderAddress(row), { priority: !rules[senderAddress(row)]?.priority })}>
          {rules[senderAddress(row)]?.priority ? "⚡" : "+"} {t("inbox.priority_sender")}
        </button>
        <select aria-label={t("inbox.sender_category")} value={rules[senderAddress(row)]?.category ?? "mail"}
          onchange={(event) => void saveRule(senderAddress(row), { category: event.currentTarget.value as Category })}>
          <option value="mail">{t("inbox.mail")}</option>
          <option value="notifications">{t("inbox.notifications")}</option>
          <option value="newsletters">{t("inbox.newsletters")}</option>
        </select>
      {/if}
    </div>
  {/if}
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
  {#each ordinaryGroups.slice(0, limit) as group (group.key)}
    {#if group.rows.length === 1}
      {@render message(group.rows[0])}
    {:else}
      {@render summary(group.label, group.rows, () => navigate("mail", group.key))}
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

<style>
  .organize { padding: 8px 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-bottom: 1px solid var(--hairline); }
  label, small, .back, .unread { font-size: 11px; color: var(--text-faint); }
  select { max-width: 145px; background: var(--bg); color: var(--text); border: 1px solid var(--hairline); border-radius: 4px; padding: 3px; font: inherit; }
  small { width: 100%; }
  .summary { display: block; width: 100%; text-align: left; padding: 14px 16px; border-bottom: 1px solid var(--hairline); }
  .summary:hover { background: var(--hover); }
  .summary-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; }
  .count { font-size: 11px; font-weight: 400; color: var(--text-faint); }
  .arrow { margin-left: auto; }
  .preview { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 4px 0; font-size: 12px; color: var(--text-dim); }
  .priority { border-left: 3px solid #b68b35; }
  h2 { font-size: 13px; padding: 12px 16px; }
  .more { width: 100%; padding: 12px 16px; font-size: 12px; color: var(--text-dim); text-align: left; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 16px 8px; border-bottom: 1px solid var(--hairline); font-size: 11px; }
  .actions button { color: var(--text-dim); }
  .actions button[aria-pressed="true"] { color: #b68b35; }
  .actions button:disabled { opacity: 0.5; }
</style>

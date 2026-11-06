<script lang="ts">
  import { api, errorMessage } from "../lib/api";
  import { t } from "../lib/i18n/index.svelte";
  import type { AttachmentMeta } from "../lib/types";

  let { attachments }: { attachments: AttachmentMeta[] } = $props();
  let error = $state("");
  let busy = $state<number | null>(null);
  $effect(() => { void attachments; error = ""; });

  async function act(id: number, save: boolean) {
    error = "";
    busy = id;
    const current = attachments;
    try {
      if (save) await api.saveAttachment(id);
      else await api.openAttachment(id);
    } catch (e) {
      if (attachments === current) error = errorMessage(e);
    } finally {
      if (busy === id) busy = null;
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div class="chips">
  <div class="microlabel">{t("reading.attachments")}</div>
  <div class="row">
    {#each attachments as a (a.id)}
      <div class="chip">
        <button class="name" onclick={() => act(a.id, false)} disabled={busy !== null} title={t("reading.open")}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M10 2.5H4.5v11h7V6L10 2.5zM10 2.5V6h1.5" />
          </svg>
          {a.filename ?? "attachment"}
          <span class="size">{formatSize(a.size)}</span>
        </button>
        <button class="save" onclick={() => act(a.id, true)} disabled={busy !== null} title={t("reading.save")}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M8 2v8m0 0L5 7m3 3l3-3M3 12v2h10v-2" />
          </svg>
        </button>
      </div>
    {/each}
  </div>
  {#if error}<div class="error" role="alert">{error}</div>{/if}
</div>

<style>
  .chips {
    margin-top: 16px;
  }
  .error { margin-top: 8px; color: var(--danger); font-size: 12px; }
  button:disabled { opacity: 0.6; cursor: wait; }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  .chip {
    display: flex;
    align-items: center;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-s);
    overflow: hidden;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    font-size: 12.5px;
    color: var(--text);
  }
  .name:hover {
    background: var(--hover);
  }
  .size {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .save {
    padding: 7px 9px;
    border-left: 1px solid var(--hairline);
    color: var(--text-dim);
    display: grid;
    place-items: center;
  }
  .save:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>

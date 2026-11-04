<script lang="ts">
  import { aiErrorText, aiStream, api, errorMessage, reportError } from "../lib/api";
  import { getLocale, t } from "../lib/i18n/index.svelte";
  import { ai } from "../lib/stores/ai.svelte";
  import { aiSessions } from "../lib/stores/aiSession.svelte";
  import { mail } from "../lib/stores/mail.svelte";
  import { ui } from "../lib/stores/ui.svelte";
  import type { MessageMeta, RenderedBody, ThreadDetail } from "../lib/types";
  import AiAsk from "./AiAsk.svelte";
  import AttachmentChips from "./AttachmentChips.svelte";
  import BackDone from "./BackDone.svelte";
  import CopyAffordance from "./CopyAffordance.svelte";
  import HtmlViewer from "./HtmlViewer.svelte";
  import InviteCard from "./InviteCard.svelte";

  let detail = $state<ThreadDetail | null>(null);
  // "loading" = already in the local cache, back in milliseconds; "fetching" =
  // still has to be pulled off the server, which can take seconds.
  let bodies = $state<Record<number, RenderedBody | "loading" | "fetching" | "error">>({});
  // Why a body failed, for the tooltip on the error note — the visible wording
  // stays the same, but a bug report is diagnosable.
  let bodyErrors = $state<Record<number, string>>({});
  // Newest body request per message, so a slow answer can't overwrite a newer
  // one. Plain (non-reactive) state: it only gates writes into `bodies`.
  let bodySeq = 0;
  const bodyReq = new Map<number, number>();
  // Real destination of the link under the cursor (browser-style status bar).
  let hoverUrl = $state<string | null>(null);

  // Security verdict of the AI-target message's loaded body; gates the
  // "check for phishing" quick chip so it only exists for flagged mail.
  const targetSecurity = $derived.by(() => {
    const id = replyTarget?.id;
    if (id == null) return null;
    const b = bodies[id];
    return typeof b === "object" ? (b.security ?? null) : null;
  });
  const targetFlagged = $derived(
    targetSecurity !== null &&
      (targetSecurity.sender.length > 0 || targetSecurity.links.length > 0),
  );
  // Per-message unsubscribe state: true once the user clicks the chip.
  let unsubscribed = $state<Record<number, boolean>>({});
  // Per-message state for the recipients line: whether it overflows the one-line
  // meta row (so a clickable "…" is worth showing) and whether the user has
  // asked to see all of them. One-way for the session — opening to copy an
  // address is the whole point, hiding again rarely is.
  let recipientsOverflow = $state<Record<number, boolean>>({});
  let recipientsExpanded = $state<Record<number, boolean>>({});

  // Svelte action: calls back whenever the element's content stops fitting its
  // box. Used only here, kept local.
  function trackOverflow(node: HTMLElement, cb: (overflowing: boolean) => void) {
    const check = () => cb(node.scrollWidth - node.clientWidth > 1);
    const ro = new ResizeObserver(check);
    ro.observe(node);
    check();
    return { destroy: () => ro.disconnect() };
  }
  // Which view each message is being shown in. Kept so one toggle can't undo the
  // other: "show images" must not drop a translation, nor the reverse.
  let viewOpts = $state<Record<number, { images: boolean; translated: boolean }>>({});
  // A translation being generated: how many segments are back, or what failed.
  type Translating = { current: number; total: number } | { error: string };
  let translating = $state<Record<number, Translating>>({});
  let loadedFor = $state<string | null>(null);
  // The focused (fully open) message in the conversation. Reply/AI actions
  // target it; newer messages collapse above it, older ones below. Defaults to
  // the latest-in-folder message on thread load.
  let focusedId = $state<number | null>(null);
  let focusedEl = $state<HTMLDivElement | undefined>();

  // The newest message of the thread IN THE CURRENT FOLDER — the default focus,
  // the flat-view fallback, and the read/loadKey anchor.
  const latest = $derived.by(() => {
    const msgs = detail?.messages ?? [];
    if (msgs.length === 0) return null;
    const inFolder = msgs.filter((m) => m.folderId === mail.selectedFolderId);
    if (inFolder.length > 0) return inFolder[inFolder.length - 1];
    return msgs[msgs.length - 1];
  });

  // Conversation view: the whole back-and-forth as a chat. Off in flat mode or
  // when a specific message was picked from a flat list.
  const conversation = $derived(mail.groupThreads && mail.selectedMessageId === null);

  // The message currently open in the pane (conversation view).
  const focused = $derived.by(() => {
    const msgs = detail?.messages ?? [];
    return msgs.find((m) => m.id === focusedId) ?? latest;
  });

  // The single message shown when not in conversation view: the one picked from
  // a flat list, else the newest in folder.
  const shown = $derived.by(() => {
    const msgs = detail?.messages ?? [];
    if (mail.selectedMessageId !== null) {
      return msgs.find((m) => m.id === mail.selectedMessageId) ?? latest;
    }
    return latest;
  });

  // A message is outgoing if it's from the account owner (his own reply). The
  // unified view owns every connected address.
  function isOutgoing(m: MessageMeta): boolean {
    return mail.myEmails.includes(m.from.addr.toLowerCase());
  }

  // The message reply/AI actions target: focused in conversation, else shown.
  const replyTarget = $derived(conversation ? focused : shown);

  // The heading follows the open message: an untranslated subject sitting above
  // translated text is exactly the half-done look the feature exists to avoid.
  // The message list keeps the original — it is an index, and recognizing a
  // message there beats reading it.
  const shownSubject = $derived.by(() => {
    const id = replyTarget?.id;
    const body = id != null ? bodies[id] : undefined;
    const translate = typeof body === "object" ? body.translate : null;
    if (translate?.showing && translate.subject) return translate.subject;
    return detail?.subject || "—";
  });

  // ---- AI chat over this email ----
  // The chat belongs to the message, not to this pane: the session store keeps
  // it (and any answer still streaming) across closing the dock, hopping
  // between emails, and popping it into a window of its own.
  const askSession = $derived(aiSessions.askFor(replyTarget?.id));

  // Keep the session's window title and phishing chip in step with the email —
  // the security verdict only lands once the body has loaded.
  $effect(() => {
    if (!askSession || !replyTarget) return;
    askSession.title = replyTarget.subject;
    askSession.flagged = targetFlagged;
  });

  // Toggle the chat: pressing Ask again (button or the Q shortcut) closes the
  // dock it opened. The conversation stays, so reopening — for this email or
  // after hopping to another and back — picks it up where it was left.
  function openAsk() {
    const target = replyTarget;
    if (!target) return;
    if (askSession?.open) {
      aiSessions.close(askSession);
      return;
    }
    // This email's chat is already open in a window of its own — show it there
    // rather than growing a second copy in the dock.
    if (askSession?.detached) {
      void aiSessions.detach(askSession);
      return;
    }
    aiSessions.openAsk(target.id, target.subject, targetFlagged);
  }

  // Fire a canned prompt (the phishing banner sits in the message, above the
  // dock): open the chat and send. The answer is a normal turn the user can
  // follow up on.
  function quickPrompt(question: string) {
    const target = replyTarget;
    if (!target) return;
    aiSessions.send(aiSessions.openAsk(target.id, target.subject, targetFlagged), question);
  }

  // Reply-all only makes sense with more than one other party (sender + other
  // recipients besides me). With a single correspondent it equals Reply.
  const canReplyAll = $derived.by(() => {
    const m = replyTarget;
    if (!m) return false;
    const mine = mail.myEmails;
    const others = new Set<string>();
    for (const a of [m.from, ...m.to, ...m.cc]) {
      const addr = a.addr?.toLowerCase();
      if (addr && !mine.includes(addr)) others.add(addr);
    }
    return others.size > 1;
  });

  // Open a different message from the chain. The AI target follows, so the dock
  // shows that message's chat (usually none, until it is asked something).
  function setFocus(id: number) {
    if (id === focusedId) return;
    focusedId = id;
  }

  // Fetch on demand the body of the open message (focused in conversation view,
  // or the single shown message in flat view). Collapsed rows need only snippets.
  $effect(() => {
    const m = conversation ? focused : shown;
    if (m && bodies[m.id] === undefined) void loadBody(m.id);
  });

  // Keep the open message in view when navigating the chain.
  $effect(() => {
    void focusedId;
    if (conversation) focusedEl?.scrollIntoView({ block: "nearest" });
  });

  // Expose the AI actions to the global keyboard handler (Q, T) in App.svelte.
  // The closures read the current reactive state, so a single registration stays
  // correct across thread changes.
  $effect(() => {
    ui.setReadingAi({
      ask: openAsk,
      translate: () => {
        const id = replyTarget?.id;
        if (id != null) toggleTranslation(id);
      },
    });
    return () => ui.setReadingAi(null);
  });

  // Publish the open message so the palette AI chat can pick it up as context.
  $effect(() => {
    ui.setOpenMessage(replyTarget?.id ?? null);
    return () => ui.setOpenMessage(null);
  });

  // Reload when the thread changes OR when the selected thread gains a new
  // message. messageCount/date on the row advance via refreshThreads() on the
  // `mail:updated` event, so this reacts to new mail landing in the thread that
  // is already open — showing the newest message and marking it read without a
  // re-click.
  const loadKey = $derived.by(() => {
    const id = mail.selectedThreadId;
    if (id === null) return null;
    const row = mail.selectedThread;
    return `${id}:${row?.messageCount ?? 0}:${row?.date ?? 0}:${row?.pendingMove ?? false}`;
  });

  $effect(() => {
    const key = loadKey;
    if (key === null) {
      detail = null;
      loadedFor = null;
      return;
    }
    if (key === loadedFor) return;
    loadedFor = key;
    void loadThread(mail.selectedThreadId!);
  });

  async function loadThread(threadId: number) {
    detail = null;
    bodies = {};
    bodyErrors = {};
    bodyReq.clear();
    viewOpts = {};
    // `translating` is NOT reset: a translation still being generated belongs to
    // its message, not to this pane, and clearing it here would offer to start a
    // second one for the same message on the way back.
    // The chat is not reset here: it belongs to the message, and the dock
    // follows whichever message the pane settles on.
    try {
      const d = await api.getThread(threadId);
      if (mail.selectedThreadId !== threadId) return;
      detail = d;
      const msgs = d.messages;
      const inFolder = msgs.filter((m) => m.folderId === mail.selectedFolderId);
      focusedId = (inFolder.length ? inFolder[inFolder.length - 1] : msgs[msgs.length - 1])?.id ?? null;

      const unread = d.messages.filter((m) => !m.isRead).map((m) => m.id);
      if (unread.length > 0) {
        mail.patchThreadRow(threadId, { isRead: true });
        void api.markRead(unread, true);
      }
    } catch {
      detail = null;
    }
  }

  // ---- translation ----
  // The bar above the body offers this for mail in a language the backend
  // decided the user doesn't read; T reaches it either way.

  function translateMessage(messageId: number) {
    const running = translating[messageId];
    if (running && !("error" in running)) return;
    translating = { ...translating, [messageId]: { current: 0, total: 0 } };
    // Deliberately not cancelled when the thread changes: the backend caches the
    // result, so letting it finish makes the next open free instead of throwing
    // away tokens already spent.
    aiStream(
      "ai_translate",
      { messageId },
      {
        // The reply is a numbered segment list, useless to render — the pane
        // redraws from the cached body once it lands.
        delta: () => {},
        reasoning: () => {},
        progress: (current, total) => {
          translating = { ...translating, [messageId]: { current, total } };
        },
        done: () => {
          // Clear the progress only once the translated body is in place, so the
          // bar never blinks through a state where it says nothing.
          void loadBody(messageId, undefined, true).finally(() => {
            const { [messageId]: _done, ...rest } = translating;
            translating = rest;
          });
        },
        error: (code, message) => {
          translating = { ...translating, [messageId]: { error: aiErrorText(code, message) } };
        },
      },
    );
  }

  /** Translation ⇄ original. Generates one the first time there is nothing to show. */
  function toggleTranslation(messageId: number) {
    const body = bodies[messageId];
    if (typeof body !== "object") return;
    if (body.translate?.showing) {
      void loadBody(messageId, undefined, false);
    } else if (body.translate?.cached) {
      void loadBody(messageId, undefined, true);
    } else {
      translateMessage(messageId);
    }
  }

  async function loadBody(messageId: number, showImages?: boolean, translated?: boolean) {
    // A body fetch can take seconds (the server may have to be asked), so guard
    // against both ways a late answer can land in the wrong place: the thread
    // changed under us (loadThread clears `bodies`), or this same message was
    // requested again meanwhile (a thread refresh, Retry, "show images"). An
    // "error" written by a stale answer would latch — the auto-load effect only
    // fires on `undefined`, so nothing would ever retry it.
    const threadId = mail.selectedThreadId;
    const seq = ++bodySeq;
    bodyReq.set(messageId, seq);
    const stale = () => bodyReq.get(messageId) !== seq || mail.selectedThreadId !== threadId;
    // Say which of the two is happening. A body already in SQLite renders in
    // milliseconds; one the server still has to hand over does not, and showing
    // the same word for both is what made a slow fetch look like a hang. The
    // loaded-object check covers Retry and "show images", where `detail` still
    // carries the pre-fetch bodyState.
    const local =
      typeof bodies[messageId] === "object" ||
      detail?.messages.find((m) => m.id === messageId)?.bodyState === 1;
    bodies = { ...bodies, [messageId]: local ? "loading" : "fetching" };
    // Each flag keeps its last value, so passing one doesn't reset the other.
    const prev = viewOpts[messageId];
    const opts = {
      images: showImages ?? prev?.images ?? false,
      translated: translated ?? prev?.translated ?? true,
    };
    viewOpts = { ...viewOpts, [messageId]: opts };
    try {
      const body = await api.getMessageBody(messageId, opts.images, opts.translated);
      if (stale()) return;
      bodies = { ...bodies, [messageId]: body };
    } catch (e) {
      console.warn("getMessageBody failed", messageId, e);
      if (stale()) return;
      bodies = { ...bodies, [messageId]: "error" };
      bodyErrors = { ...bodyErrors, [messageId]: errorMessage(e) };
    }
  }

  async function allowSender(messageId: number, addr: string | null) {
    if (addr) await api.allowRemoteImages(addr);
    void loadBody(messageId, true);
  }

  async function allowAllImages(messageId: number) {
    await api.setSetting("images_policy", "always");
    void loadBody(messageId, true);
  }

  const allIds = $derived(detail?.messages.map((m) => m.id) ?? []);
  // Both toggles track the visible thread row, so the buttons and the global S/U
  // shortcuts (App.svelte) always agree — those patch the row, and `detail` is a
  // snapshot taken when the thread opened that nothing refreshes on a flag flip.
  // The row's isStarred is max(is_starred) over the thread, i.e. the same "any
  // message starred". Opening a thread auto-marks it read, so isRead is normally
  // true while the pane is shown.
  const anyStarred = $derived(mail.selectedThread?.isStarred ?? false);
  const isRead = $derived(mail.selectedThread?.isRead ?? true);
  const inInbox = $derived(mail.selectedFolder?.role === "inbox");
  let completing = $state(false);

  function backToList() {
    mail.selectedThreadId = null;
    mail.selectedMessageId = null;
    ui.closeRecap();
  }

  function archive() {
    if (!detail || completing) return;
    if (inInbox) {
      completing = true;
      const row = mail.selectedThread;
      // Home/search can open a thread outside the currently paged list.
      const completion = row ? mail.setDone(row, !row.isDone)
        : api.setThreadDone(detail.id, mail.selectedMessageId, true).then(async () => {
          mail.selectedThreadId = null;
          mail.selectedMessageId = null;
          await mail.refreshThreads();
        });
      void completion.catch(error => {
        reportError("inbox.done", error);
        mail.noteError(t("ops.failed"));
      }).finally(() => { completing = false; });
      return;
    }
    const threadId = detail.id;
    const ids = allIds;
    mail.removeThreadFromList(threadId);
    void api.archiveMessages(ids);
  }

  function remove() {
    if (!detail) return;
    const threadId = detail.id;
    const ids = allIds;
    mail.removeThreadFromList(threadId);
    void api.deleteMessages(ids);
  }

  function reportSpam() {
    if (!detail) return;
    const threadId = detail.id;
    const ids = allIds;
    mail.removeThreadFromList(threadId);
    void api.reportSpam(ids);
  }

  function unsubscribe(id: number) {
    if (unsubscribed[id]) return;
    unsubscribed[id] = true; // optimistic; the backend queues the actual op
    void api.unsubscribe(id).catch(() => {
      unsubscribed[id] = false; // let the user try again if it never queued
    });
  }

  // The picker itself does the optimistic removal once a destination is picked
  // — until then nothing has happened yet.
  function openMove() {
    if (!detail) return;
    ui.openMove({ rowKeys: mail.rowKeysForThread(detail.id), messageIds: allIds });
  }

  function toggleStar() {
    if (!detail) return;
    const on = !anyStarred;
    mail.patchThreadRow(detail.id, { isStarred: on });
    void api.setStarred(allIds, on);
  }

  function toggleRead() {
    if (!detail) return;
    const next = !isRead;
    mail.patchThreadRow(detail.id, { isRead: next });
    void api.markRead(allIds, next);
  }

  function initial(name: string | null): string {
    return (name ?? "?").charAt(0).toUpperCase() || "?";
  }

  function formatFull(unix: number): string {
    return new Date(unix * 1000).toLocaleString(getLocale(), {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  async function reply(mode: "reply" | "reply_all" | "forward") {
    const target = replyTarget;
    if (!target) return;
    const draft = await api.getReplyTemplate(target.id, mode);
    await api.openComposeWindow(draft.id);
  }
</script>

<section class="pane">
  {#if !detail}
    {#if mail.readingLayout === "full" && mail.selectedThreadId !== null}<header class="toolbar"><BackDone onback={backToList} /></header>{/if}
    {#if ui.temperature === "warm" && mail.selectedThreadId === null}
      <!-- Quiet-zine empty state: a taped paper note. Warm themes only. -->
      <div class="placeholder">
        <div class="note">
          <div class="note-paper">
            <svg class="note-icon" width="52" height="52" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
              <defs>
                <filter id="note-marker" x="-30%" y="-30%" width="160%" height="160%">
                  <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" result="n" />
                  <feDisplacementMap in="SourceGraphic" in2="n" scale="1.8" />
                </filter>
              </defs>
              <g filter="url(#note-marker)">
                <rect x="6" y="12" width="36" height="24" rx="2.5" />
                <path d="M6.5 15l17.5 12.5L41.5 15" />
              </g>
            </svg>
            <div class="note-line">{t("reading.no_selection")}</div>
            <div class="note-hint">
              <kbd>J</kbd><kbd>K</kbd><span>{t("reading.hint_browse")}</span>
            </div>
            <div class="note-hint">
              <kbd>Ctrl</kbd><kbd>K</kbd><span>— {t("reading.hint_command")}</span>
            </div>
          </div>
          <span class="tape"></span>
        </div>
      </div>
    {:else}
      <div class="placeholder">
        <div class="ghost">✉</div>
        {mail.selectedThreadId === null ? t("reading.no_selection") : t("reading.loading")}
        {#if mail.selectedThreadId === null && mail.navigationRows.length > 0}
          <span class="browse-hint"><kbd>J</kbd><kbd>K</kbd><span>{t("reading.navigation_hint")}</span></span>
        {/if}
      </div>
    {/if}
  {:else}
    <header class="toolbar">
      {#if inInbox || mail.readingLayout === "full"}
        <BackDone onback={mail.readingLayout === "full" ? backToList : undefined} ondone={inInbox ? archive : undefined} done={mail.selectedThread?.isDone ?? false} disabled={completing} />
      {/if}
      {#if mail.navigationRows.length > 1 && mail.navigationRows.some(row => row.id === mail.selectedThreadId)}
        <span class="browse-hint" title={`${t("shortcuts.next")} · ${t("shortcuts.prev")}`}><kbd>J</kbd><kbd>K</kbd><span>{t("reading.navigation_hint")}</span></span>
      {/if}
      <div class="spacer"></div>
      {#if !inInbox}<button class="tool" onclick={archive} title={t("reading.archive")}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 3h12v3H2V3zm1 3v7h10V6M6.5 9h3" /></svg>
        <kbd>E</kbd>
      </button>{/if}
      <button class="tool" onclick={remove} title={t("reading.delete")}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.5 9.5h6l.5-9.5M6.7 6.5v5M9.3 6.5v5" /></svg>
        <kbd>Del</kbd>
      </button>
      <button class="tool" onclick={reportSpam} title={t("reading.spam")}>
        <!-- Warning octagon: junk / report spam. -->
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M5.4 1.8h5.2l3.6 3.6v5.2l-3.6 3.6H5.4L1.8 10.6V5.4L5.4 1.8z" /><path d="M8 4.6v4M8 11.1v.1" /></svg>
        <kbd>!</kbd>
      </button>
      <button class="tool" onclick={openMove} title={t("reading.move")}>
        <!-- Folder with an arrow going in: file this somewhere. -->
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.5 3.5h4l1.5 2h7.5v7h-13v-9z" /><path d="M8 7.5v3.5M6.4 9.4L8 11l1.6-1.6" /></svg>
        <kbd>V</kbd>
      </button>
      <button class="tool" class:starred={anyStarred} onclick={toggleStar} title={anyStarred ? t("reading.unstar") : t("reading.star")}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill={anyStarred ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.2"><path d="M8 1.5l2 4.1 4.5.6-3.3 3.2.8 4.5L8 11.8l-4 2.1.8-4.5L1.5 6.2 6 5.6 8 1.5z" /></svg>
        <kbd>S</kbd>
      </button>
      <button class="tool" onclick={toggleRead} title={isRead ? t("reading.mark_unread") : t("reading.mark_read")}>
        {#if isRead}
          <!-- Sealed envelope: click to mark unread. -->
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="3.5" width="12" height="9" rx="1" /><path d="M2 5l6 4.5L14 5" /></svg>
        {:else}
          <!-- Open envelope: click to mark read. -->
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 6.5l6-4 6 4v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z" /><path d="M2 6.5l6 4.5 6-4.5" /></svg>
        {/if}
        <kbd>U</kbd>
      </button>
    </header>

    <div class="scroll">
      <div class="subject-row copy-host">
        <h1 class="subject">{shownSubject}</h1>
        <CopyAffordance value={shownSubject} label={t("reading.copy_subject")} />
      </div>

      {#if conversation}
        <div class="convo">
          {#each detail.messages as m (m.id)}
            <div class="conversation-card" class:outgoing={isOutgoing(m)} class:active={focused?.id === m.id}>
              {#if focused?.id === m.id}
                <div bind:this={focusedEl}>{@render messageBlock(m,bodies[m.id])}</div>
              {:else}
                {@render chatRow(m)}
              {/if}
            </div>
          {/each}
        </div>
      {:else if shown}
        {@render messageBlock(shown, bodies[shown.id])}
      {/if}
    </div>

    {#if askSession?.open && !askSession.expanded}
      <!-- AI dock sits above the actions so it's visible at any scroll position.
           Expanded, the same chat is drawn over the whole window by App. -->
      <AiAsk
        session={askSession}
        onsend={(q) => aiSessions.send(askSession, q)}
        onclose={() => aiSessions.close(askSession)}
        onpopout={() => void aiSessions.detach(askSession)}
        ontoggleexpand={() => aiSessions.toggleExpand(askSession)}
      />
    {/if}

    <footer class="actions">
      {#if ai.keyPresent}
        <button class="ai-btn" onclick={openAsk}>✦ {t("ai.ask")}<kbd>Q</kbd></button>
      {/if}
      <button class="btn" onclick={() => reply("reply")}>{t("reading.reply")}<kbd>R</kbd></button>
      {#if canReplyAll}
        <button class="btn" onclick={() => reply("reply_all")}>{t("reading.reply_all")}<kbd>A</kbd></button>
      {/if}
      <button class="btn" onclick={() => reply("forward")}>{t("reading.forward")}<kbd>F</kbd></button>
    </footer>

    {#if hoverUrl}
      <!-- Browser-style status bar: the real destination of the hovered link. -->
      <div class="statusbar">{hoverUrl}</div>
    {/if}
  {/if}
</section>

{#snippet messageBlock(
  message: MessageMeta,
  body: RenderedBody | "loading" | "fetching" | "error" | undefined,
)}
  {@const loaded = typeof body === "object" ? body : null}
  {@const job = translating[message.id]}
  {@const offerTranslate = ai.keyPresent && (loaded?.translate != null || job != null)}
  <article class="message">
    <div class="meta">
      <span class="avatar">{initial(message.from.name ?? message.from.addr)}</span>
      <div class="who">
        <div class="from copy-host">
          <span class="from-text">
            {message.from.name ?? message.from.addr}
            <span class="addr">&lt;{message.from.addr}&gt;</span>
          </span>
          <CopyAffordance value={message.from.addr} label={t("reading.copy_address")} />
        </div>
        {@render recipientsLine(message)}
      </div>
      <span class="date microlabel">{formatFull(message.date)}</span>
    </div>

    {#if offerTranslate || message.canUnsubscribe}
      <!-- One row for the chips that act on this message. The meta line above is
           identity — sender, recipients, date — so a button in it was a squatter;
           the framed bars below are the app telling the user something. -->
      <div class="chips">
        {#if job && "error" in job}
          <span class="translate-failed">{job.error}</span>
          <button class="chip ai" onclick={() => translateMessage(message.id)}>
            ✦ {t("reading.retry")}
          </button>
        {:else if job}
          <span class="translate-note">
            <span class="spark">✦</span>
            {job.total > 0
              ? t("translate.progress", { percent: Math.round((job.current / job.total) * 100) })
              : t("translate.working")}
          </span>
        {:else if loaded?.translate?.showing}
          <span class="translate-note">
            <span class="spark">✦</span>
            {t("translate.done")}
          </span>
          {#if loaded.translate.truncated}
            <span class="sep">·</span>
            <span class="translate-note">{t("translate.truncated")}</span>
          {/if}
          <button class="chip ai" onclick={() => toggleTranslation(message.id)}>
            {t("translate.show_original")}<kbd>T</kbd>
          </button>
        {:else if offerTranslate}
          <button class="chip ai" onclick={() => toggleTranslation(message.id)}>
            ✦ {loaded?.translate?.cached
              ? t("translate.show_translation")
              : t("ai.translate")}<kbd>T</kbd>
          </button>
        {/if}
        {#if message.canUnsubscribe}
          {#if unsubscribed[message.id]}
            <span class="chip done">{t("reading.unsubscribed")} ✓</span>
          {:else}
            <button class="chip" onclick={() => unsubscribe(message.id)}>
              {t("reading.unsubscribe")}
            </button>
          {/if}
        {/if}
      </div>
    {/if}

    {#if body === "loading" || body === "fetching" || body === undefined}
      <div class="body-note">{t(body === "fetching" ? "reading.fetching" : "reading.loading")}</div>
    {:else if body === "error"}
      <div class="body-note" title={bodyErrors[message.id]}>
        {t("reading.load_failed")}
        <button class="linkish" onclick={() => loadBody(message.id)}>{t("reading.retry")}</button>
      </div>
    {:else}
      {#if body.security && body.security.sender.length > 0}
        <!-- Danger-toned sibling of the images bar: message-level phishing
             signals. Informational — nothing is blocked, links get their own
             click-time gate. -->
        <div class="security-bar">
          <span class="security-title">{t("security.banner")}</span>
          <span class="security-reasons">
            {body.security.sender
              .map((r) => t(`security.reason.${r.code}`, { param: r.param ?? "" }))
              .join(" · ")}
          </span>
          {#if ai.keyPresent}
            <button class="linkish ai-check" onclick={() => quickPrompt(t("ai.prompt_phishing"))}>
              ✦ {t("security.check_ai")}
            </button>
          {/if}
        </div>
      {/if}
      {#if body.blockedImages > 0}
        <div class="images-bar">
          {t("reading.images_blocked", { n: body.blockedImages })}
          <button class="linkish" onclick={() => loadBody(message.id, true)}>
            {t("reading.show_once")}
          </button>
          {#if body.fromAddr}
            <span class="sep">·</span>
            <button class="linkish" onclick={() => allowSender(message.id, body.fromAddr)}>
              {t("reading.always_sender")}
            </button>
          {/if}
          <span class="sep">·</span>
          <button class="linkish" onclick={() => allowAllImages(message.id)}>
            {t("reading.always_all")}
          </button>
        </div>
      {/if}
      {#if body.invite}
        <InviteCard
          invite={body.invite}
          onRsvp={(response) => api.rsvpInvite(message.id, response)}
          onAddToCalendar={() => api.openInviteIcs(message.id)}
        />
      {/if}
      {#if body.invite && body.invite.method !== "reply"}
        <!-- The card says it all; the sender's verbose HTML (Google's
             banner etc.) stays one click away for Meet links & co. -->
        {#if body.html}
          <details class="orig-body">
            <summary class="linkish">{t("invite.show_original")}</summary>
            <div class="body">
              <HtmlViewer
                html={body.html}
                appearance={mail.emailAppearanceFor(message.accountId)}
                trimQuotes={conversation && (detail?.messages.length ?? 0)>1}
                security={body.security?.links}
                onHoverUrl={(u) => (hoverUrl = u)}
              />
            </div>
          </details>
        {/if}
      {:else if body.html}
        <div class="body">
          <HtmlViewer
            html={body.html}
                appearance={mail.emailAppearanceFor(message.accountId)}
                trimQuotes={conversation && (detail?.messages.length ?? 0)>1}
            security={body.security?.links}
            onHoverUrl={(u) => (hoverUrl = u)}
          />
        </div>
      {:else}
        <!-- Headers over a blank rectangle read as a bug. Say it plainly:
             the message came through, there was just nothing to render. -->
        <div class="body-note">{t("reading.empty")}</div>
      {/if}
      {#if body.attachments.length > 0}
        <AttachmentChips attachments={body.attachments} />
      {/if}
    {/if}
  </article>
{/snippet}

{#snippet recipientsLine(m: MessageMeta)}
  {@const all = [...m.to, ...m.cc]}
  {@const expanded = recipientsExpanded[m.id] === true}
  {@const overflow = recipientsOverflow[m.id] === true}
  <div
    class="microlabel recipients"
    class:expanded
    class:overflowing={overflow && !expanded}
    use:trackOverflow={(o) => (recipientsOverflow[m.id] = o)}
  >
    {#if all.length === 0}
      {t("reading.to_me")}
    {:else}
      {#each all as a, i (i)}
        {#if i > 0}<span class="rcpt-sep">, </span>{/if}<span class="rcpt copy-host"
          ><span class="rcpt-name">{a.name || a.addr}</span><CopyAffordance
            value={a.addr}
            label={t("reading.copy_address")}
          /></span>
      {/each}
    {/if}
    {#if overflow && !expanded}
      <button
        type="button"
        class="rcpt-more"
        aria-label={t("reading.show_all_recipients")}
        title={t("reading.show_all_recipients")}
        onclick={() => (recipientsExpanded[m.id] = true)}>…</button
      >
    {/if}
  </div>
{/snippet}

{#snippet chatRow(m: MessageMeta)}
  <button
    class="chat-row"
    class:outgoing={isOutgoing(m)}
    class:unread={!m.isRead}
    onclick={() => setFocus(m.id)}
  >
    <span class="avatar sm">{initial(m.from.name ?? m.from.addr)}</span>
    <div class="chat-bubble">
      <div class="chat-head">
        <span class="chat-name">
          {isOutgoing(m) ? t("reading.you") : (m.from.name ?? m.from.addr)}
        </span>
        <span class="chat-date">{formatFull(m.date)}</span>
      </div>
      <div class="chat-snippet">{m.snippet}</div>
    </div>
  </button>
{/snippet}

<style>
  .pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    /* Anchors the link-destination status bar. */
    position: relative;
  }

  .placeholder {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--text-faint);
    font-size: 13px;
  }
  .ghost {
    font-size: 28px;
    opacity: 0.4;
  }
  /* Quiet-zine empty state — a paper note pinned with tape. Only mounts in warm
     themes, so it can use theme tokens directly without gating.
     .note is an unclipped wrapper: it carries the rotation and hosts the tape as
     a sibling of .note-paper, so the paper's clip-path (torn edge) doesn't cut
     the tape off. */
  .note {
    position: relative;
    width: 340px;
    max-width: 80%;
    transform: rotate(-1.4deg);
  }
  .note-paper {
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    box-shadow: 4px 7px 18px rgba(0, 0, 0, 0.22);
    padding: 36px 28px 28px;
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
    clip-path: polygon(
      0 2%,
      4% 0,
      46% 2%,
      73% 0,
      100% 2%,
      99% 46%,
      100% 75%,
      98% 100%,
      57% 98%,
      25% 100%,
      2% 99%,
      0 55%
    );
  }
  .note .tape {
    position: absolute;
    top: -13px;
    left: 50%;
    transform: translateX(-50%) rotate(-4deg);
    width: 112px;
    height: 28px;
    background: rgba(216, 190, 120, 0.5);
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.16);
    z-index: 1;
  }
  .note-icon {
    color: var(--text);
    opacity: 0.5;
  }
  .note-line {
    font-size: 20px;
    font-weight: 600;
    font-style: italic;
    line-height: 1.15;
    color: var(--text);
  }
  .note-hint {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    justify-content: center;
    font-style: italic;
    font-size: 14px;
    color: var(--text-dim);
  }
  .note-hint kbd {
    font-family: var(--font-mono);
    font-style: normal;
    font-size: 11px;
    color: var(--text);
    border: 1.4px solid var(--text);
    box-shadow: 1.5px 1.5px 0 var(--text);
    border-radius: 3px;
    padding: 1px 6px;
  }
  .note-hint:first-of-type kbd:first-child {
    transform: rotate(-2deg);
  }
  .note-hint:first-of-type kbd:nth-child(2) {
    transform: rotate(2deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .note,
    .note .tape,
    .note-hint kbd {
      transform: none;
    }
    .note .tape {
      transform: translateX(-50%);
    }
  }

  .browse-hint { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--text-faint); white-space:nowrap; }
  .browse-hint kbd { padding:2px 4px; border:1px solid var(--hairline-strong); border-radius:4px; }
  .browse-hint span { margin-left:4px; }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 12px 24px 8px;
    flex-shrink: 0;
  }
  .toolbar :global(.leading-actions) { margin-right:12px; }
  .tool { transition:background 120ms,color 120ms; }
  @media(max-width:1000px) { .toolbar .browse-hint span { display:none; } }
  @media(prefers-reduced-motion:reduce) { .tool { transition:none; } }
  .spacer {
    flex: 1;
  }
  .tool {
    height: 32px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    gap: 5px;
    border-radius: var(--radius-s);
    color: var(--text-dim);
  }
  .tool:hover {
    background: var(--hover);
    color: var(--text);
  }
  .tool.starred {
    color: var(--text);
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .btn kbd,
  .ai-btn kbd {
    margin-left: 6px;
  }

  /* Edge to edge: the message gets the whole pane, and the scrollbar sits at
     the right of the window rather than in the middle of it. The old 840px
     column cropped any mail laid out wider than that, with nothing to scroll
     it back into view, while leaving the rest of a wide window unused. */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 36px 28px;
  }

  .subject-row {
    display: flex;
    align-items: baseline;
    gap: 2px;
    margin-bottom: 8px;
  }
  .subject {
    font-size: 21px;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.25;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .message {
    border-bottom: 1px solid var(--hairline);
    padding-bottom: 14px;
    margin-bottom: 6px;
  }
  .message:last-child {
    border-bottom: none;
  }

  /* ---- Conversation (chat) view ---- */
  .conversation-card { min-width:0; border:1px solid var(--hairline); border-radius:14px; margin-right:24px; overflow:hidden; }
  .conversation-card.active { border-color:var(--hairline-strong); }
  .conversation-card.outgoing { margin-right:0; margin-left:24px; background:var(--hover); }
  .conversation-card .message { padding:0 16px 16px; margin:0; border:0; }
  .convo {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
  }
  .chat-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    text-align: left;
    padding: 12px;
    transition: opacity 0.08s;
  }
  .avatar.sm {
    width: 26px;
    height: 26px;
    font-size: 11px;
  }
  .chat-bubble {
    flex: 1;
    min-width: 0;
    padding: 0;
    border-radius: 8px;
  }
  .chat-row:hover { background:var(--hover); }
  .chat-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }
  .chat-name {
    font-weight: 600;
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat-row.unread .chat-name {
    font-weight: 800;
  }
  .chat-date {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    flex-shrink: 0;
  }
  .chat-snippet {
    font-size: 12.5px;
    color: var(--text-faint);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: normal;
    overflow-wrap:anywhere;
    display:-webkit-box;
    -webkit-line-clamp:3;
    line-clamp:3;
    -webkit-box-orient:vertical;
  }
  /* Outgoing (your own replies): mirrored to the right, tinted. */
  .chat-row.outgoing {
    flex-direction: row-reverse;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
    width: 100%;
    text-align: left;
  }
  .avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--selected);
    display: grid;
    place-items: center;
    font-weight: 700;
    font-size: 13px;
    flex-shrink: 0;
  }
  .who {
    flex: 1;
    min-width: 0;
  }
  .from {
    display: flex;
    align-items: baseline;
    gap: 0;
    font-weight: 600;
    font-size: 13.5px;
    min-width: 0;
  }
  .from-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 0 1 auto;
  }
  .addr {
    color: var(--text-faint);
    font-weight: 400;
  }
  .who .microlabel {
    text-transform: none;
    letter-spacing: 0.02em;
    font-size: 11px;
  }
  .who .recipients {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    position: relative;
  }
  /* Overflowing: hide the native "…" so the clickable button carries it alone,
     avoiding a dead ellipsis next to a live one. */
  .who .recipients.overflowing {
    text-overflow: clip;
  }
  /* Expanded: let the list wrap and the whole row grow — the "…" button is gone
     at this point (rendered conditionally). */
  .who .recipients.expanded {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
  }
  /* The clickable "…" at the end of a truncated recipients line. Sits inline so
     it rides the baseline, but reserves a solid-background wedge over whatever
     was clipped underneath — otherwise half-visible letters bleed through. */
  .rcpt-more {
    position: absolute;
    right: 0;
    bottom: 0;
    padding: 0 6px 0 10px;
    border: none;
    background: linear-gradient(
      to right,
      transparent 0,
      var(--surface) 8px,
      var(--surface) 100%
    );
    color: var(--text-dim);
    font: inherit;
    line-height: inherit;
    cursor: pointer;
  }
  .rcpt-more:hover {
    color: var(--text);
  }
  /* Each recipient is its own hover-host so the copy icon reveals per-address.
     inline-flex keeps the icon on the baseline next to the name. */
  .rcpt {
    display: inline-flex;
    align-items: baseline;
    max-width: 100%;
    vertical-align: baseline;
  }
  .rcpt-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .date {
    flex-shrink: 0;
  }

  /* The two framed bars between the header and the body — blocked images and
     phishing signals. One shape, so they stack without looking like two
     different ideas; only the tone differs. */
  .images-bar,
  .security-bar {
    margin-top: 12px;
    padding: 8px 12px;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-s);
    font-size: 12.5px;
    color: var(--text-dim);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  /* Danger-toned: message-level phishing signals. Danger only on the border and
     title — not the AI accent. */
  .security-bar {
    border-color: color-mix(in srgb, var(--danger) 35%, transparent);
  }
  .security-title {
    color: var(--danger);
    font-weight: 600;
  }
  /* The one AI entry point in the banner — accent is correct here. */
  .ai-check {
    color: var(--accent);
  }
  /* The chips row: one shape for every action that belongs to this message, so
     translate and unsubscribe read as siblings instead of competing. */
  .chips {
    margin-top: 10px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .chip {
    flex-shrink: 0;
    font-size: 12px;
    line-height: 1.4;
    padding: 2px 9px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    color: var(--text-dim);
    white-space: nowrap;
  }
  button.chip:hover {
    background: var(--hover);
    color: var(--text);
  }
  /* AI actions carry the accent, the same one the Ask button uses. */
  .chip.ai {
    border-color: var(--accent-dim);
    color: var(--accent);
  }
  button.chip.ai:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .chip.done {
    color: var(--success);
    border-color: transparent;
  }
  .chip kbd {
    margin-left: 6px;
  }
  .translate-note {
    font-size: 12px;
    color: var(--text-dim);
  }
  .translate-note .spark {
    color: var(--accent);
  }
  .translate-failed {
    font-size: 12px;
    color: var(--danger);
  }
  /* Browser-style status bar for the hovered link's real destination. */
  .statusbar {
    position: absolute;
    left: 8px;
    bottom: 8px;
    z-index: 30;
    max-width: 70%;
    padding: 3px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-s);
    font-family: Consolas, monospace;
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .linkish {
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 3px;
    font-size: 12.5px;
  }

  .body {
    margin-top: 14px;
  }
  .orig-body {
    margin-top: 12px;
  }
  .orig-body summary {
    cursor: pointer;
    color: var(--text-dim);
    width: fit-content;
  }
  .orig-body summary::-webkit-details-marker {
    display: none;
  }
  .body-note {
    margin-top: 14px;
    color: var(--text-faint);
    font-size: 13px;
    display: flex;
    gap: 10px;
  }

  .actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 6px;
    padding: 10px 36px 12px;
    border-top: 1px solid var(--hairline);
  }
  .ai-btn {
    padding: 7px 16px;
    border-radius: var(--radius-m);
    border: 1px solid var(--accent-dim);
    color: var(--accent);
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }
  .ai-btn:hover {
    background: var(--accent-soft);
  }
  .btn {
    padding: 7px 16px;
    border-radius: var(--radius-m);
    border: 1px solid var(--hairline-strong);
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }
  .btn:hover {
    background: var(--hover);
    border-color: var(--text-faint);
  }

  .sep {
    color: var(--text-faint);
  }
</style>

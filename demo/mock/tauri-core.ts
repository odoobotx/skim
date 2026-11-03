// Mock of `@tauri-apps/api/core` for the product demo.
//
// The whole app talks to its Rust backend through `invoke()` and streams AI
// output over a `Channel`. Alias this module in place of the real one and the
// UI runs unchanged in a plain browser, served entirely fake data.

import * as db from "./data";
import { emitDemo } from "./tauri-event";

// Used only by headless tests, with this synthetic mailbox.
export const commandLog: { cmd: string; args: any }[] = [];
const savedSettings: Record<string, string> = JSON.parse(localStorage.getItem("skimdemo.settings") ?? "{}");
const priorityRows=new Set<number>(JSON.parse(localStorage.getItem("skimdemo.priority") ?? "[]"));
const doneRows = new Set<number>(JSON.parse(localStorage.getItem("skimdemo.done") ?? "[]"));
const readRows = new Set<number>([...doneRows, ...JSON.parse(localStorage.getItem("skimdemo.read") ?? "[]")]);
if (localStorage.getItem("skimdemo.taskInbox") === "on") {
  db.INBOX_THREADS.push({ ...db.INBOX_THREADS[0], id: 109, subject: "A separate conversation with Anna" });
}

// The app checks `"__TAURI_INTERNALS__" in window` to decide whether to boot
// (vs. show onboarding). Presence is enough — our aliased invoke does the work.
(globalThis as any).window && ((window as any).__TAURI_INTERNALS__ ||= { demo: true });

// Tunables the recorder can override via localStorage before the app boots.
function num(key: string, fallback: number): number {
  const v = Number((globalThis as any).localStorage?.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const TYPING_MS = () => num("skimdemo.typingMs", 24); // per token
const THINK_MS = () => num("skimdemo.thinkMs", 420); // pause before first token
const STEP_MS = () => num("skimdemo.stepMs", 650); // tool-step dwell
// Second mailbox + unified view on demand — off by default so the classic
// single-account shots stay reproducible.
const MULTI = () => {
  try {
    return (globalThis as any).localStorage?.getItem("skimdemo.multiaccount") === "on";
  } catch {
    return false;
  }
};

function unreadCounts(): Record<string,number> {
  const rows=MULTI() ? db.unifiedList("inbox") : db.INBOX_THREADS.map(row=>({...row,accountId:db.ACCOUNT.id}));
  const counts:Record<string,number>={};
  for (const row of rows) if (!row.isRead && !readRows.has(row.id) && !doneRows.has(row.id)) counts[row.accountId]=(counts[row.accountId] ?? 0)+1;
  return counts;
}

// ---- AI streaming --------------------------------------------------------
export class Channel<T = unknown> {
  onmessage: (msg: T) => void = () => {};
}

const cancelled = new Set<string>();

function tokens(text: string): string[] {
  // Keep whitespace attached so the streamed text reflows naturally.
  return text.match(/\S+\s*/g) ?? [text];
}

function streamText(
  channel: Channel<any>,
  text: string,
  requestId: string,
  citations: any[] = [],
  startDelay = THINK_MS(),
): void {
  const parts = tokens(text);
  let i = 0;
  const tick = () => {
    if (cancelled.has(requestId)) return;
    if (i >= parts.length) {
      channel.onmessage({ type: "done", citations });
      return;
    }
    channel.onmessage({ type: "delta", text: parts[i++] });
    setTimeout(tick, TYPING_MS());
  };
  setTimeout(tick, startDelay);
}

// The recap panel reads the unread mail before it writes a word, and renders
// that wait as "Reading your unread mail… 1/3". So the fixture has to emit
// `progress` first — text alone would skip the scan and land the digest with an
// empty "0 unread digested" eyebrow and no marked-as-read line.
function runRecap(channel: Channel<any>, requestId: string): void {
  const { text, citations } = db.AI_RECAP;
  const total = citations.length;
  let delay = 0;
  for (let i = 1; i <= total; i++) {
    setTimeout(() => {
      if (cancelled.has(requestId)) return;
      channel.onmessage({ type: "progress", current: i, total });
    }, delay);
    delay += STEP_MS();
  }
  streamText(channel, text, requestId, citations, delay + 200);
}

function runChat(channel: Channel<any>, requestId: string, turns: any[] | undefined): void {
  const { steps, answer, citations } = db.chatTurn(turns);
  let delay = 300;
  steps.forEach((s, idx) => {
    const id = `step-${idx}`;
    setTimeout(() => {
      if (cancelled.has(requestId)) return;
      channel.onmessage({ type: "toolCall", id, kind: s.kind, arg: s.arg });
    }, delay);
    delay += STEP_MS();
    setTimeout(() => {
      if (cancelled.has(requestId)) return;
      channel.onmessage({ type: "toolDone", id, count: s.count });
    }, delay);
    delay += 120;
  });
  streamText(channel, answer, requestId, citations, delay + 200);
}

const AI_COMMANDS = new Set([
  "ai_ask",
  "ai_compose",
  "ai_chat",
  "ai_recap",
  "ai_analyze_style",
]);

function handleAi(cmd: string, args: any): void {
  const channel: Channel<any> | undefined = args?.channel;
  const requestId: string = args?.requestId ?? "";
  cancelled.delete(requestId);
  if (!channel) return;

  switch (cmd) {
    // The email chat and the palette chat are both continuable: the UI sends the
    // whole history, and the fixtures answer the question that was actually
    // asked (quick prompt, opener, or follow-up).
    case "ai_ask":
      streamText(channel, db.askAnswer(args?.turns), requestId);
      return;
    case "ai_recap":
      runRecap(channel, requestId);
      return;
    case "ai_chat":
      runChat(channel, requestId, args?.turns);
      return;
    case "ai_compose": {
      const isReply = args?.replyToMessageId != null;
      streamText(channel, isReply ? db.AI_REPLY : db.AI_COMPOSE_NEW, requestId);
      return;
    }
    default:
      streamText(channel, db.AI_SUMMARY, requestId);
  }
}

// ---- Plain command surface ----------------------------------------------
export function invoke<T = any>(cmd: string, args: any = {}): Promise<T> {
  commandLog.push({ cmd, args });
  if (commandLog.length > 500) commandLog.shift();
  if (AI_COMMANDS.has(cmd)) {
    handleAi(cmd, args);
    return Promise.resolve(undefined as T);
  }

  const ok = <R>(v: R) => Promise.resolve(v as unknown as T);

  switch (cmd) {
    // accounts
    case "list_accounts":
      return ok(MULTI() ? [db.ACCOUNT, db.ACCOUNT2] : [db.ACCOUNT]);
    case "inbox_unread_counts":
      return ok(unreadCounts());
    case "google_oauth_available":
      return ok(false);
    case "microsoft_oauth_available":
      return ok(false);
    case "autoconfig_lookup":
      return ok(null);

    // settings — the recorder/screenshotter can force a theme via localStorage.
    // Recorder overrides stay available; fresh previews use the fork's default.
    case "get_settings": {
      let theme = "moonlit-dark";
      try {
        theme = (globalThis as any).localStorage?.getItem("skimdemo.theme") || "moonlit-dark";
      } catch {}
      return ok({ locale: "en", theme, images_policy: "ask", group_threads: "on", ...savedSettings });
    }
    case "set_setting":
      savedSettings[args.key] = args.value;
      localStorage.setItem("skimdemo.settings", JSON.stringify(savedSettings));
      return ok(undefined);

    // mail
    case "list_folders":
      return ok((MULTI() && args.accountId === "acc-2" ? db.FOLDERS2 : db.FOLDERS).map(folder => folder.role === "inbox" ? {...folder,unreadCount:unreadCounts()[folder.accountId] ?? 0} : folder));
    case "list_unified_folders":
      return ok(db.UNIFIED_FOLDERS.map(folder => folder.role === "inbox" ? {...folder,unreadCount:Object.values(unreadCounts()).reduce((a,b)=>a+b,0)} : folder));
    case "list_unified_threads":
    case "list_unified_messages":
      return ok(args.offset > 0 ? [] : db.unifiedList(args.role ?? null));
    case "folder_ref":
      return ok(db.folderRef(args.folderId));
    // Threads vs. flat messages: the app picks one based on the group_threads
    // setting. The fixtures serve for both.
    case "list_threads":
    case "list_messages": {
      const list = db.THREADS_BY_FOLDER[args.folderId] ?? [];
      return ok(args.offset > 0 ? [] : list);
    }
    case "list_recent_unread":
    case "list_task_inbox": {
      const rows = MULTI() ? db.unifiedList("inbox") : db.INBOX_THREADS.map(row => ({...row, accountId: db.ACCOUNT.id}));
      return ok([...rows].sort((a,b)=>cmd === "list_recent_unread" ? b.date-a.date : Number(priorityRows.has(b.id))-Number(priorityRows.has(a.id)) || b.date-a.date).filter(row => (!args.accountId || row.accountId === args.accountId) && (args.showDone || !doneRows.has(row.id)) && (cmd !== "list_recent_unread" || !(row.isRead || readRows.has(row.id))))
        .map(row => ({...row, isDone: doneRows.has(row.id), isRead:row.isRead || readRows.has(row.id), pendingMove: false,isPriority:priorityRows.has(row.id),
          category: row.fromAddr.includes("github") ? "notifications" : row.fromAddr.includes("stripe") ? "newsletters" : "mail"}))
        .slice(args.offset ?? 0, cmd === "list_recent_unread" ? 5 : args.offset + args.limit));
    }
    case "set_task_priority":
      if (localStorage.getItem("skimdemo.failPriority") === "on") return Promise.reject(new Error("Synthetic Priority failure"));
      if (args.priority) priorityRows.add(args.threadId); else priorityRows.delete(args.threadId);
      localStorage.setItem("skimdemo.priority",JSON.stringify([...priorityRows]));
      return ok(undefined);
    case "set_tasks_done":
    case "set_thread_done": {
      if (localStorage.getItem("skimdemo.failArchive") === "on") return Promise.reject(new Error("Synthetic archive failure"));
      for (const id of args.threadIds ?? [args.threadId]) {
        if (args.done) {doneRows.add(id);readRows.add(id);priorityRows.delete(id);} else doneRows.delete(id);
      }
      localStorage.setItem("skimdemo.done", JSON.stringify([...doneRows]));
      localStorage.setItem("skimdemo.priority",JSON.stringify([...priorityRows]));
      localStorage.setItem("skimdemo.read", JSON.stringify([...readRows]));
      queueMicrotask(() => emitDemo("folders:updated",{}));
      return ok(undefined);
    }
    case "get_thread": {
      const detail = db.threadDetail(args.threadId);
      if (localStorage.getItem("skimdemo.taskInbox") === "on" && detail.messages.length) {
        detail.messages.unshift({ ...detail.messages[0], id: 99999, folderId: 3, date:detail.messages[0].date-3600,
          from:{name:"Alex Morgan",addr:"alex@brightwave.io"},snippet:"Here is my earlier reply." });
      }
      return ok(detail);
    }
    case "get_message_body": {
      const body=db.renderedBody(args.messageId);
      if (localStorage.getItem("skimdemo.longEmail") === "on") {
        body.html=`<p>Long email start</p>${Array.from({length:65},(_,i)=>`<p>Long email paragraph ${i+1}. This content verifies the reading pane scrolls naturally.</p>`).join("")}<p>Long email end</p>`;
      }
      return ok(body);
    }
    case "archive_messages":
      if (localStorage.getItem("skimdemo.failArchive") === "on") return Promise.reject(new Error("Synthetic archive failure"));
      return ok(undefined);
    case "thread_message_ids":
      return ok([args.threadId * 10 + 1]);
    case "thread_message_ids_bulk":
      return ok((args.threadIds as number[]).map((id) => id * 10 + 1));
    // Move destinations: the account's folders minus the one the mail is in
    // (Inbox, in every demo scenario) and the roles that aren't destinations.
    case "folder_message_count":
      return ok((db.THREADS_BY_FOLDER[args.folderId] ?? []).length);
    case "move_targets":
      return ok(
        (MULTI() ? db.FOLDERS2 : db.FOLDERS).filter(
          (f) => !["inbox", "starred", "drafts", "all"].includes(f.role ?? ""),
        ),
      );
    case "take_pending_open":
      return ok(null);
    case "search_messages":
      return ok(db.searchHits(args.query ?? ""));

    // compose
    case "create_draft":
      return ok(db.createDraft());
    case "update_account_identity":
      return ok(db.updateAccountIdentity(args.accountId, args.displayName, args.signature));
    case "set_draft_account":
      return ok(db.setDraftAccount(args.draftId, args.accountId, args.body));
    case "get_draft":
      return ok(db.getDraft(args.draftId));
    case "get_reply_template":
      return ok(db.replyTemplate(args.messageId, args.mode));
    case "update_draft":
      db.updateDraft(args.draft);
      return ok(undefined);
    case "list_draft_attachments":
      return ok([]);
    case "suggest_addresses":
      return ok([]);

    // AI key gate — the demo always has a key so AI actions are visible.
    case "ai_key_status":
      return ok({ provider: "anthropic", anthropic: true, openrouter: false, custom: false });
    case "ai_cancel":
      cancelled.add(args.requestId);
      return ok(undefined);

    // Fire-and-forget mutations: mark read, star, archive, delete, send…
    default:
      return ok(undefined);
  }
}

export const convertFileSrc = (p: string) => p;
export const transformCallback = (cb: (r: any) => void) => cb;
export const isTauri = () => true;
export const PluginListener = class {};

# Skim Tasks fork

This fork adapts Skim to a task-oriented email workflow inspired by Spark.
The upstream MIT license and attribution remain in place. New behavior belongs
to this fork; upstream's deliberate exclusion of organizing features does not
describe this fork's scope.

## Product standard — non-negotiable

The finished client must feel **very polished, elegant, minimal and clean**.
Every interaction and animation must be thoughtfully designed, reliable and
fast. Speed is a primary product requirement: **FAST, FAST, FAST — yet smooth,
never jerky**. Looking good and delivering dependable email behavior are both
required; neither compensates for failure in the other.

- Give immediate visual feedback for local actions; sync and network latency
  must not block input or make users wonder whether their click registered.
- Keep list positions, selection, focus and scroll stable. No surprise reflows,
  flashing empty states, jumping rows or lost context during drill-downs.
- Use restrained, purposeful motion. Transitions should preserve continuity,
  never delay actions; honor reduced-motion preferences.
- Make menus, spacing, typography, icons, hover/focus states and reading layouts
  consistent. Avoid redundant controls and visual clutter.
- Treat pointer, keyboard, drag, cancellation, undo, offline operation, errors
  and recovery as first-class interactions, not finishing touches.
- Verify responsiveness with realistic large caches and queued work. Measure
  UI response and rendering, not only database-query timings. Do not accept
  visibly jerky or unreliable behavior merely because an isolated test passes.

This is the acceptance bar for the completed product, not a claim that the
current preview has reached it.

## Current preview

- The Inbox timeline uses Today, Yesterday, This Week, Last Week, This Month,
  Last Month and Earlier. Priority stays above it. Each collapsed category or
  sender group appears once under its newest message's date, interleaved with
  ordinary messages. Hover/focus a date heading to complete its represented mail
  in one batch, including older members inside its collapsed groups. Date
  boundaries use local calendar time and refresh at midnight or app resume.
- Read/unread rows and group summaries share a fixed leading gutter. Hover/focus
  fades the unread dot into Done without shifting avatars or text. The reader
  pairs an icon-only Back arrow with Done at the top left; E uses the same
  read-and-archive operation. Completing a message returns to the list even
  when Show Done is on. Back preserves category/sender drill-down context.
- Attachment and calendar-file opening resolves the real on-disk path before
  handing it to another app. This handles Windows redirected AppData caches;
  download behavior and cached files remain unchanged. Open/save failures show
  an inline error with retry available.
- Opt-in sender grouping: right-click a message or open its sender options, then
  choose Group by Sender. Rules use the exact normalized address and persist
  across subjects and accounts; Ungroup Sender reverses the choice.
- Sender drill-downs within category drill-downs.
- Individual message/conversation Priority: hover a row and use the bolt, or use
  its context menu. This local flag is independent of server stars and sender
  rules. Priority sender rules automatically apply to current and future Inbox
  mail, and the same bolt reflects that inherited status. Individual exceptions
  can turn Priority on/off; Use sender's Priority setting restores inheritance.
  One Priority section shows the first five groups/cards, then Show all. A new
  manual mark sorts first; native queries page older manual Priority mail first.
  Done clears individual overrides. Label-folder copies share the same setting.
- Notifications also recognize DMARC report-subject signatures and NAS/system
  notice signals from sender name, address and subject, including existing cache
  entries with no automation/list headers. Human reply/forward discussions and
  vendor newsletters have negative fixtures to limit over-classification.
- Automatic Notifications/Newsletters classification from headers and sender signals,
  with explicit sender corrections saved in local settings.
- Full-window nature Home screen with Search, Compose, Check Inbox and recent unread mail.
- Conversation view shows chronological incoming/outgoing cards without the
  earlier/later accordion controls. Cached snippets keep other cards lightweight;
  opening one fetches its body on demand. Known reply-history containers collapse
  behind Show quoted history; ordinary blockquotes and quote-only mail remain
  visible. The stored email is preserved.
- Reading panes now constrain flex height so long mail scrolls in full and split
  layouts, including wheel input over the email iframe. Browser tests cover both.
- Per-account reading layout: Full-width (default), opening an email in place
  with Back to return, or Split with a persistent list beside the reading pane.
  The same layout applies inside category and sender drill-downs. All inboxes
  has its own saved preference. Compact Inbox/Sent/Pinned/Drafts sidebar.
  Optional unified Inbox/Sent/Pinned parents expand into full-address account
  rows. Selecting a child switches directly to that account and folder without
  loading Inbox first. Settings can hide Pinned or turn off unified groups.
  Distinct domain tags replace ambiguous name initials on unified message rows.
- Pinned is a view of existing IMAP starred/flagged mail across folders, including
  archived mail, with account scope, label-copy deduplication and trash/junk
  exclusion. It does not depend on the provider exposing a Starred folder.
  Priority remains independent and local.
- Moonlit light/dark palettes add cool porcelain and deep blue-gray/violet
  surfaces. New profiles default to Moonlit dark. Compose follows the palette
  in every theme; Priority uses theme tokens rather than a fixed amber fill.
- Email Appearance is a saved per-account option in Settings. Match app theme
  is the default; Original preserves the sender's colors. The message's own
  account determines the preference in All inboxes, including off-page opens.
  The reading surface has no per-message Appearance menu.
- Hover/focus Done controls on individual rows and group summaries.
- Drag across the Done column to stage a stable list, then submit one batch on release.
- Show Done uses an accessible theme-aware slider, available even when Inbox is empty. It merges Inbox and
  received archived mail; clearing Done restores Inbox without marking unread.
  A new Inbox reply reopens an otherwise completed conversation.
- Done marks the affected inbox messages read locally and queues the server read
  flag before archiving; the read state follows offline moves and restart.
  It archives only a conversation's inbox messages using Skim's
  existing offline operation queue. Sent copies remain untouched by this action.
- Existing unified Inbox and Sent remain available.
- Keyboard navigation and select-all stay inside the current drill-down. J/K hints
  live in the reading view/empty split pane, not over full-width inbox cards.
- Group counts explicitly describe loaded conversations, not the entire mailbox.
  Loading older conversations expands the set. Rendering is bounded in batches
  of 100 groups/messages, including within a sender drill-down.

This is a development prototype, not a replacement for daily email yet. The
Windows preview is installed separately as Skim Tasks; the user is setting up
their own mailbox. Automated mutations use synthetic mail. A read-only snapshot
of the fork profile was used to validate migration and inbox query behavior; no
mail-server operations were performed against that account during development.

## Confirmed design direction

- Priority stays at the top; date sections mix personal messages, Notifications,
  Newsletters and opt-in sender groups in chronological order. A collapsed group
  spans dates and appears once under its newest member, as the user chose.
- Sidebar defaults: Inbox, Sent, Drafts. Other folders belong under More.
- Done control appears on hover and keyboard focus; provide an accessible touch
  target rather than relying on hover alone.
- User requests Spark's drag-to-complete gesture: press a Done checkbox and drag
  vertically across more checkboxes to complete multiple rows. Test this against
  synthetic messages, not the user's live mailbox. Process each crossed row only
  once, scope the operation to the current list, and keep bulk selection separate.
- Notifications and Newsletters collapse to summary rows, with sender groups
  inside each category. Sender corrections override automatic classification.
- Preserve downloaded bodies and attachments across archive/restore operations.
  Show Done changes the query, not the server state.
- Group summaries and pagination belong in SQLite; opening the inbox must not
  require loading every cached message or fetching individual message bodies.

## Future AI categorization — recorded, not implemented

AI categorization should become an optional per-account feature when a working
AI provider/key is configured. Keep the local first-pass classifier available
without AI. Key presence makes the feature available; turning categorization on
controls sending mailbox data to the chosen provider. The browser demo's canned
AI responses are not classification and do not establish a working key.

- Run in the background for new/recent unread mail first, with bounded batches,
  concurrency, cost limits and retry/backoff. Never wait for AI when opening,
  scrolling or rendering mail. Store results locally and reuse them; do not send
  a request per view or repeatedly classify unchanged messages.
- Combine message-level headers, list/automation markers, recipient and reply
  context, and normalized subject/template signals. Use minimal permitted
  content when headers are insufficient. The same address can send a receipt,
  a newsletter and a personal reply; a sender alone is not the unit of learning.
- Learn from explicit recategorization and accepted suggestions. Keep a local
  feedback history with the requested scope: this message, this recurring stream,
  or always this sender. An acceptance can suggest a reusable pattern; broad
  learned rules should show examples before application. Done/archive activity
  alone is not proof of the correct category.
- Cache category, reason, confidence, feature/rule/model version and message
  identity. Manual choices win. Provide undo, reset/forget learned patterns and
  a way to see why a message was categorized. Account-specific corrections must
  not silently leak into other accounts.
- Leave uncertain mail visible under People. Start with reviewable suggestions;
  enable automatic display grouping only at a measured confidence threshold.
  Categorization must not itself archive, mark read, delete or send messages.
- Treat email content as untrusted data, including instructions inside mail.
  The classifier gets no tools or mailbox mutation powers and returns validated
  category decisions for the supplied IDs only. Provider failures keep the last
  cached/local result and never disrupt inbox use.
- Evaluate mixed-purpose senders, human replies, mailing-list discussions,
  newsletters, receipts, security alerts and invitations on a labeled local set.
  Track corrections/reversals and missed important personal mail, not only the
  number of messages confidently assigned. Improve incrementally from approved
  examples rather than silently rewriting the whole inbox on every model change.

## Spark local cache observations — 2026-11-03

Inspected the running installation's SQLite databases using read-only
connections and `PRAGMA query_only=ON`. No message contents, credentials, or
account identifiers were exported. No settings or mail were changed.

- `messages.sqlite` separates messages, conversations and folder membership.
  Conversations have separate `inInbox`, `inArchive`, `totalInbox`, and
  `totalArchive` fields. A conversation can have both Inbox and Archive content:
  54 conversations had both flags at inspection time. Completion therefore
  cannot be represented correctly by looking only for any archived message.
- 70,347 conversations were marked Archive without Inbox. Their 88,600 message
  rows included 54,347 messages with nonempty locally cached HTML, about 61%.
  Cached bodies covered message dates from March 2019 through November 2026.
  This establishes substantial local archive retention, not complete offline
  availability of all archived mail.
- `cache.sqlite` separately stores HTML, parsed bodies, and IMAP data. Its
  body records include `messagePk`, `lastAccessDate`, and `dataSize`. The HTML
  table has an index on `messagePk`. Last-access fields suggest cache management
  but do not establish eviction policy or a retention limit.
- `listContentItems` and `listContentItemGroups` persist list/conversation
  membership, order dates, group IDs and counts. There were 4,949 group records.
  These are evidence of precomputed list/group data; the exact query used by
  Show Done is not visible from the schema alone.
- Categories exist on messages and conversations, with separate
  `categoryByHeaders` and contact category fields. This is consistent with
  automatic classification plus sender rules; enum meanings and Spark's
  classifier accuracy were not inferred from numeric values.

A later read-only sample of the 20,000 newest locally inserted non-Sent,
non-Draft messages with a sender address found 12,590 populated
`categoryByHeaders` values; 1,639 differed from the message's final `category`.
Among 715 repeated (account, normalized sender address) pairs, 44 had multiple
header-category codes and 74 had multiple final-category codes. The query took
about one second. These observations support studying layered, message-level
classification, but do not establish enum meanings, current classifier inputs,
or why labels differ. Historical corrections, contact settings, classifier
changes and message/conversation context could contribute. No message text or
sender identities were exported. This is observational evidence, not a recovered
Spark algorithm.

Spark was minimized during the cache inspection. A subsequent visible UI
inspection confirmed a narrow left Done column revealed with row hover, right
hover actions, a tinted Priority panel capped with Show all, compact category
summary rows with sender previews/counts, and category drill-down replacing the
message list with a Back control. Date headings organize the list. Category
drill-downs retain compact sender groups and the Show Done switch. The user's
drag-to-complete gesture was recorded but not exercised on live mail. Spark was
returned to the background afterward. Cache eviction, fetch-on-open behavior,
and performance causes remain unverified; database size alone does not identify
a performance problem.

Behavior reference: https://sparkmailapp.com/help/manage-your-inbox/mark-as-done

## Remaining requirements, in priority order

1. **Mailbox-wide sender grouping:** move group summaries and paging into SQLite so
   counts and sender drill-downs cover all cached mail without loading every
   conversation into the frontend. Current group actions cover the loaded rows,
   as indicated in the list; they must not imply completion of unloaded history.
2. **Classification accuracy:** the current deterministic first pass is not
   Spark-level classification. Improve at message/mail-stream level: distinguish
   personal replies, transactional alerts and broadcasts even from one address.
   Combine list/automation headers, recipient and reply/thread context, plus
   content signals when available. Uncertain mail stays visible under People.
   Corrections should offer this message/this recurring stream/always this sender,
   rather than silently treating every correction as a permanent sender rule.
   Keep reason/confidence/version for evaluation and compare a labeled local
   sample against Spark's observed categories without exporting private mail.
   Spark documents sender-wide manual corrections but does not describe its
   classifier in the consulted public category documentation:
   https://sparkmailapp.com/help/manage-your-inbox/customize-your-inbox
3. **Recipient/To grouping:** expose recipient metadata through list queries and
   define multi-recipient membership before implementing.
4. **Pin interaction polish:** the separate Pinned view uses existing star/flag
   actions; consider a consistent pin glyph/terminology across those controls.
5. **Navigation polish:** remembered drill-down scroll positions. Keep secondary
   controls out of idle rows.
6. **Platform validation:** Windows previews build through CI. Linux requires
   replacing Windows-specific integrations and adding Linux build/testing.
   OAuth registrations and real-account sleep/resume/offline verification remain.

## Archive implementation and verification

Completion keeps the message row, downloaded body, attachments and search index
under stable local IDs while an offline operation is pending. A move journal
retains original server coordinates; confirmed destination headers rebind the
cached row using Message-ID. Offline undo records the desired folder and queues
an inverse operation only after its destination UID is known. Gmail restore adds
Inbox without deleting the All Mail copy. Source UIDVALIDITY is checked before
server mutations. Read/star overrides follow pending moves.

Known limit: mail without Message-ID cannot be rebound safely. Its cached body
survives while offline/pending, but after successful destination sync the server
copy takes over. Pending undo for such a message waits until reconciliation.
UIDPLUS move receipts would remove this limitation.

Synthetic tests cover archive/restore body retention, new reply reopening,
offline undo, database reopen, failed move rollback, Gmail duplicate copies,
Sent exclusion, UIDVALIDITY reset, pending read flags, account scope and paging.
Native settings allow the fork's sender rules, Show Done, reading layout and
appearance keys; a frontend/native contract test guards that boundary.
Browser tests cover Home, More, drill-downs, keyboard completion, group completion,
Show Done in an empty inbox, Done marking read, restore, drag batching, failed
archive recovery, saved sender rules and account reading layouts.

Performance check on 2026-11-03 (Python SQLite, in-memory copy; query time only):
100,000 synthetic headers, first 100 grouped rows, about 38 ms Inbox / 89 ms with
Show Done, versus about 252 ms / 1182 ms before paging IDs first. A private
pre-upgrade snapshot with 27,128 actual headers migrated successfully; first-page
queries took about 27 ms / 37 ms. These are local observations, not production
latency guarantees. No private messages or screenshots are committed.

## Local UI development

`npm run demo:dev` runs the same Svelte UI in a browser with synthetic fixtures.
It reloads UI changes immediately and does not access mailbox credentials.
`npm run tauri -- dev` runs the web UI against the native Rust backend and needs
the native toolchain; Rust changes compile incrementally. Installed previews
bundle the UI and backend together. A real browser-only email client would need
a separate service for IMAP/SMTP, authentication and storage; the current browser
preview is a design/test surface, not a second live mailbox client.

## Development isolation

The native product is **Skim Tasks**, identifier `com.techsystech.skimtasks`.
Its database/log directory, Credential Manager service, toast identity, protocol
scheme, notification icon path and uninstall cleanup are separate from Skim.
Upstream automatic updates are disabled until the fork has its own signed
release process. Running the prototype must not reuse the installed Skim profile.

No existing database, mail credentials, OAuth client IDs or AI keys were copied.
Source builds need their own OAuth app registrations as documented upstream.

## Checks

```powershell
npm ci
npm test
npm run check
npm run build
npx playwright install chromium
npm run test:inbox-ui
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

The browser test starts a temporary local Vite server and a separate **headless**
browser using synthetic fixture mail. It never opens a desktop window or reads a
real mailbox. Set `SKIM_TEST_BROWSER` to an existing Chromium executable to avoid
downloading another test browser. Preview output: `demo/output/task-inbox.png`.

## Priority reference — 2026-11-03

Spark documents Pins separately from Priority senders/threads, including an
individual hover Priority action. The consulted page does not establish its
server-star mapping. This fork keeps local Priority separate from IMAP stars.
https://sparkmailapp.com/help/sending-emails/pin-and-priority
Spark's Smart Search help uses "Starred" to find pinned mail. This supports the
choice of a flag-based Pinned view here; it does not prove Spark's IMAP storage.
https://sparkmailapp.com/help/manage-your-inbox/use-smart-search

## Browser design mailbox

The preview defaults to two fictional accounts with a larger mix of personal
mail, work conversations, service notices, DMARC/NAS reports and newsletters.
Several senders/threads exercise the five-card Priority preview and Show all.
Multi-message conversations include alternating incoming/outgoing cards and
quoted history. The browser remains synthetic; its API and AI replies do not
access real mail servers. Recorder runs can opt out with
`skimdemo.multiaccount=off`.

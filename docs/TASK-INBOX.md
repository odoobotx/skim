# Skim Tasks fork

This fork adapts Skim to a task-oriented email workflow inspired by Spark.
The upstream MIT license and attribution remain in place. New behavior belongs
to this fork; upstream's deliberate exclusion of organizing features does not
describe this fork's scope.

## Current preview

- Sender grouping across unrelated subjects, with a separate exact-address mode.
- Sender drill-downs within category drill-downs.
- Priority sender rules, independent of message stars/pins, with a top section.
- Automatic Notifications/Newsletters classification from headers and sender signals,
  with explicit sender corrections saved in local settings.
- Full-window nature Home screen with Search, Compose, Check Inbox and recent unread mail.
- Full-width inbox, compact rows and an Inbox/Sent/Drafts sidebar.
- Hover/focus Done controls on individual rows and group summaries.
- Drag across the Done column to stage a stable list, then submit one batch on release.
- Show Done merges Inbox and received archived mail; clearing Done restores Inbox.
  A new Inbox reply reopens an otherwise completed conversation.
- Done actions that archive only a conversation's inbox messages using Skim's
  existing offline operation queue. Sent copies remain untouched by this action.
- Existing unified Inbox and Sent remain available.
- Keyboard navigation and select-all stay inside the current drill-down.
- Group counts explicitly describe loaded conversations, not the entire mailbox.
  Loading older conversations expands the set. Rendering is bounded in batches
  of 100 groups/messages, including within a sender drill-down.

This is a development prototype, not a replacement for daily email yet. The
Windows preview is installed separately as Skim Tasks; the user is setting up
their own mailbox. Automated mutations use synthetic mail. A read-only snapshot
of the fork profile was used to validate migration and inbox query behavior; no
mail-server operations were performed against that account during development.

## Confirmed design direction

- Default inbox sections: Priority, People, Notifications, Newsletters.
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
2. **Classification accuracy:** header/sender rules are now automatic, but need a
   labeled evaluation set and user feedback. No claim of Spark-level accuracy.
3. **Recipient/To grouping:** expose recipient metadata through list queries and
   define multi-recipient membership before implementing.
4. **Pins:** expose a compact pinned group independently from Priority senders.
5. **Navigation polish:** remembered drill-down scroll positions and persistent
   grouping mode. Keep secondary controls out of idle rows.
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
Browser tests cover Home, More, drill-downs, keyboard completion, group completion,
Show Done/restore, drag batching, failed archive recovery and saved sender rules.

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

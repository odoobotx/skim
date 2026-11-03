# Skim Tasks fork

This fork adapts Skim to a task-oriented email workflow inspired by Spark.
The upstream MIT license and attribution remain in place. New behavior belongs
to this fork; upstream's deliberate exclusion of organizing features does not
describe this fork's scope.

## First implementation

- Sender grouping across unrelated subjects, with a separate exact-address mode.
- Sender drill-downs within category drill-downs.
- Priority sender rules, independent of message stars/pins, with a top section.
- Explicit Notifications and Newsletters sender rules, saved in local settings.
- Done actions that archive only a conversation's inbox messages using Skim's
  existing offline operation queue. Sent copies remain untouched by this action.
- Existing unified Inbox and Sent remain available.
- Keyboard navigation and select-all stay inside the current drill-down.
- Group counts explicitly describe loaded conversations, not the entire mailbox.
  Loading older conversations expands the set. Rendering is bounded in batches
  of 100 groups/messages, including within a sender drill-down.

This is a development prototype, not a replacement for daily email yet. The
Windows preview is installed separately as Skim Tasks; the user is setting up
their own mailbox. Automated tests use synthetic mail and do not validate a live
account.

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

1. **Show Done toggle:** show inbox and completed/archived mail in the same
   grouped view. Preserve useful completed content locally while archive ops
   are queued. Upstream archive deletes source cache rows immediately, so simply
   merging Inbox and Archive lists would have a visibility gap. Test offline
   completion, restart, move failure, server resync and a new reply reopening work.
2. **Mailbox-wide grouping:** move group summaries and paging into SQLite so
   counts, sorting and sender drill-downs cover all cached mail without loading
   every conversation into the frontend. Retain lazy rendering.
3. **Automatic Notifications/Newsletters:** classify using reliable message
   headers and provider signals, with explicit sender corrections taking
   precedence. Current categories are manual; no claim of Spark-level automatic
   classification. Preserve human mail and measure accuracy on labeled fixtures.
4. **Recipient/To grouping:** expose recipient metadata through list queries and
   support grouping by recipient address. Define multi-recipient membership and
   name-versus-address behavior before implementing. Do not fetch each full
   conversation just to populate recipient groups.
5. **Pins:** expose a compact pinned group independently from Priority senders.
   Skim's existing stars remain unchanged in this first pass.
6. **Layout polish:** compact Spark-inspired rows, better group summaries,
   remembered drill-down scroll positions, persistent grouping mode and a
   lightweight reading/organizing experience without per-message control clutter.
7. **Native validation:** build the Windows executable, set up this fork's own
   provider OAuth registrations, then test multiple accounts, large mailboxes,
   sleep/resume, offline queues and performance. No live mailbox testing has run.

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

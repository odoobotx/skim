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

This is a development prototype, not a replacement for daily email yet. It has
not been connected to a real mailbox or installed on the user's desktop.

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

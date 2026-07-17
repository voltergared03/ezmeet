# Changelog

All notable changes to Garely are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project currently
ships `beta` tags ahead of a 1.0 public release.

## [1.24.0-beta.3] — 2026-07-17

The AI can now write meeting content in Russian, chosen by an admin — independent of the
interface language.

### Added
- **AI report language (admin toggle).** Settings → Workspace has a new "AI report language"
  picker (Ukrainian / Russian / English). It sets the language the AI writes in — meeting
  reports, task titles, decisions, summaries, weekly rollups, the meeting chat, and the live
  in-call notes — separately from the interface language. A workspace whose interface is
  Ukrainian can now generate Russian meeting content. Left unset, the AI keeps following the
  interface language, so nothing changes for existing workspaces.
- **Russian action-item detection.** The live agent now recognizes Russian task cues
  ("нужно", "надо", "сделать", "срок", "дедлайн", …). Previously a Russian action item was
  filtered out before the AI ever looked at it, so live task suggestions were missed on
  Russian-language calls.

### Changed
- The AI output language is resolved in one place across the whole app and the live agent,
  replacing a scattered Ukrainian-or-English choice that silently produced English for any
  other language. The interface language set (Ukrainian / English) is unchanged.

## [1.24.0-beta.2] — 2026-07-17

ClickUp routing stops guessing: you now map each department to a ClickUp list by hand, pin
a person's tasks to their own list, and give the transcription a glossary so it stops
mangling your product names.

### Added
- **Manual department → ClickUp list mapping.** Each department's destination list is now
  chosen by an admin from a live picker in Settings → Departments, stored on the department
  itself. Routing no longer matches your department names against ClickUp Space names —
  which broke whenever a name drifted, silently picked whichever list a Space happened to
  order first, and forced one customer's naming quirk to be hardcoded in the product. A
  department with no list falls back to the list you pick as the fallback (Settings →
  Integrations → ClickUp); with no fallback either, its tasks stay in Garely. Unmapped
  departments show a warning chip so the gaps are visible.
- **Per-user ClickUp list (C-level routing).** In Settings → Users you can pin one person's
  tasks to a single ClickUp list, and their tasks go there from *any* call regardless of the
  task's department. It out-ranks department routing and the automatic personal list, and
  works whether or not per-assignee routing is on.
- **Transcription glossary.** Settings → Workspace takes a list of terms the speech-to-text
  keeps getting wrong — product names, tools, internal jargon. They boost Deepgram
  recognition (measured on real calls: a product name spoken inside another language was
  transcribed at 0.99 confidence as a different, wrong word, and the glossary recovers it)
  and correct the spelling of those exact terms in the AI report, including for meetings
  already recorded.

### Fixed
- **Garbled task names.** A task titled from a misheard product name (the transcript said
  one thing, the recognizer wrote another) is now corrected via the glossary rather than
  copied verbatim into ClickUp. This was a speech-to-text error, not the AI inventing names.
- **The re-transcription path ignored your Deepgram model setting** and was pinned to one
  model, so a re-transcribed speaker could come back sounding different from the rest of the
  call. It now uses the configured model, with the matching term-boost syntax for it.

### Changed
- The department→list link changed meaning: the field that used to cache an auto-guessed
  list is now the admin's explicit choice and is never overwritten automatically. Existing
  installs are seeded once from the old behavior, then edited in the picker. Already-pushed
  ClickUp tasks are not relocated (ClickUp can't move a task between lists) — the new mapping
  applies to new tasks.

## [1.24.0-beta.1] — 2026-07-17

Meeting tasks stop duplicating and landing on the wrong people, and RDP v2 can finally
ask Windows to scale its UI.

### Fixed
- **Duplicate ClickUp tasks (one assigned, one not).** Task creation caught *every* error
  and retried without assignees. That is only safe for a 400 (request refused, nothing
  created) — it also fired on timeouts and 5xx, where ClickUp had already created the task,
  leaving an orphaned assigned copy plus a linked unassigned one. Only a 400 retries now,
  and the status and assignees are dropped in separate steps so a status name the list
  doesn't define can no longer cost a valid assignee.
- **Whole departments falling into the Call Inbox.** List discovery only asked for
  *folderless* lists, so a ClickUp Space whose lists live inside Folders looked empty —
  no mapping, no error — and every one of that department's tasks went to the Inbox even
  though the department plainly existed. Folders are read too, and a Space with no
  reachable list now warns instead of failing silently.
- **Tasks assigned to the wrong person, and multi-assignee tasks collapsing to one.**
  Name matching was an unanchored substring test, so a short name captured an unrelated
  longer one ("Al" matched "Natalia") and the winner could change between runs. Matching is
  now exact-then-whole-word, and an ambiguous name resolves to nobody: an unassigned task
  is visible and fixable, a task on the wrong person is not.
- **All-hands tasks dumped onto one team's board.** A task with no explicit department
  inherited its *assignee's* department, so shared work followed whoever the AI named first.
  A task without a department now goes to the Call Inbox for triage. Expect more Inbox
  volume — that is the point.
- **Renaming a department stranded it.** The department→list link was a pure name match
  against ClickUp Space names. Each successful resolve is now pinned, and the pin is used
  when the name no longer matches. An explicit list-map override still wins.

### Added
- **RDP v2 can request Windows UI scaling.** Upstream `guacd` never sends the RDP
  `desktopScaleFactor` (and zeroes it on every resize), so a HiDPI client could only shrink
  the picture, never make Windows scale — HD was crisp but tiny. Garely now ships a patched
  `guacd` (`rdp-gw2/desktop-scale.patch`) that adds a `desktop-scale` parameter, and HD
  renders at device-pixel density while asking for 150% UI scaling.
  *Note:* a Windows target configured with `IgnoreClientDesktopScaleFactor=1` discards the
  request — no RDP client can override that; it must be changed on the server.

### Changed
- **RDP v2 scale is two fixed modes** — normal and HD — instead of a picker, and switching
  reconnects. Concurrent reconnects could previously let an older scale win while the UI
  showed the newer one, so the on-screen scale could disagree with what was rendered.

## [1.23.0-beta.4] — 2026-07-17

### Changed
- **RDP v2 scale is now a −/+ stepper.** The pill's binary HD toggle is replaced by a
  live scale stepper (1.0×–2.5×, 0.25 steps) so you can dial the exact size: lower for a
  bigger UI, higher for sharper text. The choice persists per browser. guacd can't scale
  the Windows UI (unlike v1's IronRDP, which used DesktopScaleFactor), so the render
  resolution is the only lever — this hands that lever to the user. For fully crisp text
  at a normal UI size on a Retina display, set the Windows target's display scale to 200%
  and raise the stepper to 2×.

## [1.23.0-beta.3] — 2026-07-17

### Fixed
- **RDP v2 resolution.** Normal mode renders at 1.5× the viewport (the comfortable
  default); the pill's HD toggle now bumps to 2× for maximum device-pixel sharpness
  (smaller UI) on demand, replacing the old toggle-off state that dropped to 1× and
  looked both too large and soft. guacd sets no Windows scale factor, so resolution is
  the only lever — 1.5× is the crisp-vs-size sweet spot on HiDPI displays. (For fully
  crisp text at a normal UI size on a Retina display, set the Windows target's display
  scale to 200% and switch on HD.)

## [1.23.0-beta.2] — 2026-07-17

Follow-up fixes to the RDP v2 beta.

### Fixed
- **Two-way file transfer was silently broken.** `guacd` runs as a non-root user, but
  the redirected-drive volume was created root-owned, so guacd couldn't create the
  per-user folder ("Unable to create directory … Permission denied") and every
  transfer failed. The drive volume is now world-writable (re-asserted on cron start),
  so uploads/downloads work.
- **Default resolution too soft on Retina.** v2 now opens at 1.5× the viewport —
  sharper text at a comfortable UI size — instead of 1×. The pill's HD toggle drops to
  1× for a larger UI. (guacd sets no Windows scale factor, so resolution is the only
  lever; 1.5× is the crisp-vs-size sweet spot.)

## [1.23.0-beta.1] — 2026-07-17

RDP v2 — a second, opt-in way to reach managed servers, built on Apache Guacamole
(native `guacd` decode) to fix the motion lag and input bugs of the v1 in-browser
IronRDP client. v2 runs alongside v1: users pick **Standard** or **V2 (beta)** on the
connect screen (or `?v=2`), and v1 stays the default until v2 is proven, so nothing
about the existing flow changes.

### Added
- **RDP v2 on Apache Guacamole (opt-in, coexists with v1).** `guacd` 1.6 +
  guacamole-lite tunnel + guacamole-common-js client, isolated behind a compose
  profile so v1 (Devolutions Gateway) is untouched. Native multi-threaded decode +
  copy-rect scrolling fixes the v1 sluggishness on remote scroll/redraw.
- **Client parity with v1.** Draggable floating control pill (position persisted);
  full-viewport takeover with correct scaling from the first frame; transform- and
  fullscreen-safe mouse; bidirectional text clipboard; Mac ⌘→Ctrl shortcuts
  (⌘A/⌘C/⌘V/⌘X/⌘Z/⌘S and ⌘⇧ combos) that actually reach the Windows target; and a
  keepalive that stops a backgrounded tab from freezing the session.
- **Two-way file transfer** via RDP drive redirection: an Upload button and drag-drop
  send files to a per-user "Garely" drive on the server; a drive panel browses and
  downloads files copied there from the server side. A nightly job prunes staged
  files older than 7 days so the shared host disk can't be exhausted.
- **HD toggle.** Comfortable resolution by default (normal-size Windows UI, since
  guacd can't scale the remote UI); an optional per-session HD mode renders 1.5× for
  sharper text.

### Security
- The v2 RDP password is injected into the AES-256-CBC guac token **server-side and
  never returned to the browser** — a strict improvement over v1's connect, which
  hands the cleartext password to the in-browser client for NLA.
- Per-user redirected-drive path, so one user's uploaded or staged files are never
  visible inside another user's session.

## [1.22.0-beta.1] — 2026-07-16

Security hardening (credential exposure), plus meeting/ClickUp and screen-share
improvements. The security work came out of an incident-response assessment of how
credentials could be extracted from Garely or a managed RDP host.

### Security
- **Revocable sessions.** Garely sessions were stateless 30-day JWTs with no
  server-side revocation — a stolen session cookie survived password changes for
  weeks, and the only way to invalidate all sessions was to rotate the master secret
  (which also destroys every encrypted credential, since it is the same key). A new
  per-user `sessionEpoch` lets you sign a user (or everyone) out everywhere WITHOUT
  touching `AUTH_SECRET`. Existing sessions are grandfathered, so the change logs
  nobody out on deploy.
- **Throttled the RDP credential reveal.** `POST /servers/[id]/connect` returns the
  server password to the browser (the in-browser client performs NLA itself); it is
  now rate-limited per user so a compromised session cannot iterate it to dump the
  whole fleet's credentials in a burst. Corrected a misleading code comment.
- **Per-IP login throttle** on password sign-in (on top of the existing per-email
  bucket), fail-open on an unknown IP so a proxy misconfig never locks anyone out.
- **SMTP credential re-point guard.** Changing the SMTP host to a different server
  without supplying a new password now clears the stored password, so it can't be
  transmitted to an attacker-controlled server via "send test".
- **Ops:** tightened the production `.env` to mode 0600 (was world-readable).

### Added
- **Unconfirmed meeting tasks route to the ClickUp Call Inbox.** When the AI routes a
  task to a department that had nobody from the meeting present, it now goes to the
  shared Call Inbox as one triage task assigned to all attendees, instead of landing
  unassigned in that department's list.

### Fixed
- **Sharper screen sharing.** Screen share ran on SDK defaults (VP8, 1080p@15,
  2.5 Mbps, no content hint), so text smeared on scroll. Added a `text` content hint,
  raised the bitrate ceiling to 4 Mbps, and trimmed the simulcast ladder — all scoped
  to the screen-share track (camera untouched).
- **Stale RDP audit sessions are reaped.** The disconnect beacon is best-effort, so a
  killed tab left audit rows stuck "active" forever; the cleanup cron now closes them
  with a real end time (never affecting live-presence, which keys on heartbeats).

### Changed
- The RDP gateway compose overlay is now tracked in git and pinned to a tested image
  version, instead of living only on the production host.

### Deferred (documented, not shipped)
- Separating the encryption key from the session-signing key, key-rotation tooling,
  encrypting three provider secrets at rest, mandatory 2FA, and splitting the internal
  API secret — each carries prod-migration or live-integration risk and is tracked for
  supervised rollout.

## [1.21.0-beta.1] — 2026-07-09

In-browser RDP (Remote Access) reliability.

### Added
- **File-clipboard toggle in the session pill.** Turn the shared file clipboard off
  to work with files INSIDE the server without server-side file copies auto-downloading
  to your machine (and without drag-drop upload). The text clipboard is a separate
  channel and always stays on.

### Fixed
- **Sessions no longer drop after ~5 minutes in a background tab.** An inaudible
  keepalive stops the browser from freezing the backgrounded tab (which severed the
  WebSocket); auto-reconnect-on-focus remains the fallback.
- **Stuck Shift after a macOS system shortcut.** ⌘⇧5 (screenshot) and similar could
  strand Shift “down” on the server; it's now released on your next keystroke. Scoped
  to Shift so it never disturbs ⌘C / ⌘V paste.
- **Horizontal touchpad scroll.** Two-finger horizontal swipes now scroll the remote
  desktop — the client previously dropped horizontal wheel deltas (rebuilt the vendored
  IronRDP web component to send each axis independently).

## [1.20.0-beta.1] — 2026-07-03

### Added
- **ClickUp fallback insight.** Settings → Integrations → ClickUp now shows how
  many tasks landed in the fallback list (“Call Inbox”) in the last 30 days (and
  all-time), so you can tell at a glance whether the fallback is still catching
  unrouted tasks before deciding to remove it. Loaded on demand when the modal
  opens.

## [1.19.0-beta.1] — 2026-07-03

Per-user ClickUp routing, and sharper AI task extraction.

### Added
- **Per-user ClickUp routing.** Settings → Integrations → ClickUp → “Personal
  lists for cross-department people”. When on, a meeting task is created as one
  ClickUp task **per assignee**, and anyone who belongs to 2+ departments (e.g.
  admins) gets their tasks in their **own auto-created list** under a “Garely
  Personal” space instead of a department space — so cross-department admins’
  tasks no longer clutter department spaces. Single-department members keep their
  department routing. Status still syncs both ways (last change wins). Off by
  default; existing behaviour is unchanged. Enable it before the first connect for
  a clean rollout — tasks already pushed in the old mode aren’t moved.

### Fixed
- **The AI no longer records in-meeting logistics as tasks.** In-call requests
  like “share your screen”, “unmute”, “next slide”, and anything done on the spot
  during the call are excluded from task extraction — only genuine follow-up work
  that outlives the meeting becomes a task. Applies to newly generated reports;
  regenerate an older report to re-apply.

### Notes
- Additive schema change (`ClickUpTaskLink.rowId` + `assigneeUserId`) applied ahead of the deploy.

## [1.18.0-beta.1] — 2026-06-23

HubSpot CRM integration — turn finished meetings into CRM activity.

### Added
- **HubSpot CRM.** Settings → Integrations → CRM: paste a HubSpot Private App
  token and turn it on. When a meeting's AI report is generated, Garely finds
  each participant's contact by email and logs the meeting (summary + decisions
  + report link) as a Meeting activity associated to everyone from the call who
  exists in HubSpot. One-way Garely → CRM, opt-in, fire-and-forget and fail-soft
  — never delays or breaks report generation. Optionally auto-create a contact
  for an unknown participant email. The token is encrypted at rest and never
  returned to the browser. Provider is stored so Pipedrive / Salesforce can be
  added on the same pattern later.

### Changed
- **Provider pricing moved to the Usage tab.** The per-provider rates (DeepSeek
  in/out, Deepgram/min, email limit) now live in Settings → Usage, next to the
  cost figures they compute, and the spend updates as soon as you save them.

## [1.17.0-beta.1] — 2026-06-23

Generic outbound webhooks — wire Garely into Zapier, Make, n8n or any HTTP
endpoint. One connector, hundreds of automations.

### Added
- **Outbound webhooks.** Settings → Integrations → Webhooks: add one or more
  HTTPS endpoints, each subscribed to the events you care about, and Garely
  POSTs a JSON payload whenever they fire. Events: `report.ready` (a meeting's
  AI report is generated), `meeting.reminder` (ahead of a call), `task.created`
  and `task.updated`. An endpoint with no events selected receives every event.
- **Signed, verifiable deliveries.** Each POST carries `X-Garely-Signature:
  sha256=<HMAC-SHA256 of the body>` (GitHub-compatible) signed with the
  endpoint's secret, plus `X-Garely-Event`, `X-Garely-Delivery` and
  `X-Garely-Timestamp` headers so receivers can verify authenticity and dedupe.
  Secrets are encrypted at rest and never returned to the browser. Delivery is
  opt-in, fire-and-forget and fail-soft — a slow or broken endpoint never delays
  or breaks the meeting, report or task flow that triggered it. Send a test ping
  per endpoint from the settings modal.

### Notes
- No schema change — webhook config lives in workspace settings; app-only deploy.

## [1.16.0-beta.1] — 2026-06-23

Tier 1 integrations: outbound chat notifications, a pluggable AI-model provider
with an API-driven model picker, and a full two-way Linear sync — plus the AI
provider is no longer locked to DeepSeek.

### Added
- **Chat notifications → Telegram / Slack / Mattermost / Discord.** Settings →
  Integrations → Chat: paste a Telegram bot token + chat id, or a Slack /
  Mattermost / Discord incoming-webhook URL, and turn it on. Meeting AI reports
  (summary + decisions + link) post when generated, and meeting reminders post
  ahead of the call. Secrets are encrypted at rest; opt-in, non-blocking, and
  never delays or breaks report generation.
- **Pluggable AI model provider.** The AI integration is now provider-agnostic —
  pick DeepSeek, OpenRouter, OpenAI, Anthropic, Ollama (local), or any custom
  OpenAI-compatible endpoint in Settings → Integrations → AI model. Click **Load
  models** to pull the provider's model list into a dropdown (or type a custom
  id), and set an optional **Max output tokens** ceiling — auto-filled from the
  model's reported limit where the provider exposes it. Existing DeepSeek setups
  keep working unchanged. Reach Claude via OpenRouter (`anthropic/claude-opus-4-8`)
  or Anthropic directly.
- **Two-way Linear sync — AI tasks ↔ Linear issues.** Paste a Linear API key in
  Settings → Integrations → Linear and turn it on; teams, members (matched by
  email) and workflow states are auto-discovered. Tasks route to the team
  matching each department; any task whose assignee exists in Linear becomes a
  **read-only mirror** in Garely (badge + link) while Linear owns it. Workflow-
  state changes and deletions flow **back** via a signed webhook (HMAC-SHA256
  with a replay guard). On connect, existing assigned tasks migrate; on
  disconnect, tasks return to native Garely editing. Tasks with no Linear
  assignee stay native. Opt-in and a no-op until configured.

### Fixed
- **Meeting-chat assistant honours the configured AI model.** It was hardcoded to
  a DeepSeek model id and would have failed against other providers; it now uses
  whichever model the workspace has selected.

## [1.15.0-beta.1] — 2026-06-23

A two-way ClickUp integration that can hand task management over to ClickUp, plus
the in-meeting briefing — description and agenda now visible during the call.

### Added
- **Two-way ClickUp integration — ClickUp becomes the primary task manager.**
  Paste a ClickUp Personal API token in Settings → Integrations and turn it on;
  everything else (workspace, members, department→list routing, the "Source"
  field) is auto-discovered. Any task whose assignee exists in ClickUp (matched
  by email) is pushed to the list matching its department, tagged **Source =
  Garely Call**, and becomes a **read-only mirror** in Garely (board, report
  action items and the detail drawer show a "Managed in ClickUp" badge + link;
  edits happen in ClickUp). Status changes and deletions flow **back** from
  ClickUp via a signed webhook (HMAC-SHA256). On connect, all existing assigned
  tasks migrate to ClickUp; on disconnect the webhook is removed and tasks return
  to native Garely editing. Tasks with no ClickUp assignee stay native. Opt-in,
  non-blocking, and a no-op until configured.

### Changed
- **Meetings show their description and agenda during the call.** A new "Agenda"
  tab in the meeting room — and the agenda card in the lobby — lists the meeting's
  description and numbered agenda items, so everyone sees the briefing without
  leaving the call. Quick meetings with no briefing simply don't show it.

## [1.14.1-beta.1] — 2026-06-11

Google Calendar auto-connect, database ownership transfer, and an iOS 26 Liquid
Glass mobile navigation bar.

### Added
- **Transfer ownership of databases and individual tables.** A base owner or a
  workspace admin can hand a database to another member (the outgoing owner is
  kept on with admin access); each table now has its own owner who can rename,
  delete and manage that table even without base-admin rights, transferable from
  the table's ⋯ menu. Who can *see* a table stays at the base level.

### Changed
- **Mobile navigation rebuilt as an iOS 26 Liquid Glass tab bar.** A translucent
  floating capsule — four tabs (Dashboard, Calendar, Tasks, Decisions) plus a
  detached circular **More** button that morphs the tabs to the rest (Database,
  Servers, Archive, Settings). Content scrolls through the glass, the selection
  capsule springs between tabs, and the bar minimizes on scroll. It stays on
  every screen, so any section is one tap away.
- **Google Calendar connects automatically on Google sign-in.** Signing in with
  Google now also enables two-way calendar sync — no separate "Connect" step.
  The Settings → Profile connect/disconnect card stays for password accounts and
  as a manual fallback. (Best-effort and fully isolated from the login flow — a
  Google hiccup never blocks or breaks signing in.)

### Removed
- **Retired the read-only ICS subscription feed** (the "Calendar sync" link in
  Settings → Profile and its `/api/calendar/*` endpoints) — superseded by the
  two-way Google Calendar integration. Note: meeting/task-deadline visibility in
  Outlook/Apple Calendar via that feed is no longer available; the two-way Google
  sync covers meetings.

### Fixed
- **Rescheduling a missed meeting reopens it instead of leaving it "completed".**
  An overdue meeting that someone briefly opened (so it was marked ended) and
  then moved to a new time now returns to the upcoming state — no more phantom
  "report" on a meeting that never happened. Genuine meetings with a real report
  are never touched.
- **The dashboard stops showing finished meetings as "next".** Once a meeting's
  scheduled end time passes (start + duration), it no longer appears as the next
  meeting or in the upcoming list; meetings in progress still show.
- **Deleting a meeting that has a recording no longer fails silently.** The
  archive now explains that a recording is attached and offers a single
  "delete the meeting and its recording" action, with a clear error otherwise.
- **Task status now syncs between the Tasks board and the AI report.** Ticking an
  action item in a report persists like the board does (and reverts if the server
  rejects it); an in-progress task is shown distinctly instead of as not-started.
  Board status changes also revert on failure rather than appearing to succeed.
- **View-only database access is now truly read-only.** Members shared a database
  with the *viewer* role can no longer edit cells, set or replace 2FA codes and
  passwords, upload files, or add/remove rows, fields and records — while still
  being able to read everything (including viewing a 2FA code or revealing a
  password). The whole grid, kanban, calendar and record view respect the role.
- **2FA codes stay in sync with your authenticator.** The rotating code now
  anchors to an absolute window boundary from the server and re-fetches at each
  rotation (and when you return to the tab), so a backgrounded tab no longer
  shows a code from a window that already expired.
- **The meeting description and agenda are now visible during the call.** Notes
  and discussion points added when scheduling a meeting now appear in an
  **Agenda** side-panel inside the room, and in the lobby before you join — not
  only on the calendar. The panel is shown whenever a meeting has a description
  or agenda items.

## [1.14.0-beta.1] — 2026-06-10

**The "calendar that just works" release.** Garely now lives inside Google
Calendar two ways, every meeting link is the same link everywhere, and
colleagues who click "the same meeting" land in the same room.

### Added
- **Two-way Google Calendar sync.** Connect your Google account in Settings →
  Profile: a dedicated **"Garely"** calendar is created in your account and kept
  in sync both directions. Events you add, edit or delete there become Garely
  meetings (with a room, join link and attendees mapped to members/guests); and
  meetings you schedule, reschedule or cancel in Garely appear/update/disappear
  there with the join link written into the event. Per-user OAuth (works for
  password accounts too), tokens encrypted at rest, scoped to the one calendar —
  personal events are never touched. Near-instant via Google push channels with
  a 10-minute cron poller as a fallback; an etag loop-guard prevents echo loops.
- **Send files to a remote server's clipboard from the RDP status pill** — an
  upload button left of the server name uploads picked files straight into the
  remote machine's clipboard (same path as drag-and-drop).

### Fixed
- **One canonical meeting link everywhere.** The calendar invite, the `.ics`,
  the "Add to Google Calendar" button and the in-room "copy link" now all hand
  out the same token-based `/join/<token>` URL. Signed-in colleagues land
  straight in the lobby; guests get the guest flow; a raw `/room/<id>` is no
  longer a dead end. Signing in from a `/join` link returns you to the lobby
  (honours `callbackUrl`).
- **Recurring meetings no longer split people across rooms.** The join token now
  migrates to each new occurrence, so the link saved in a calendar always opens
  the current room; recurring invites ship a single `RRULE` event instead of
  copies. Finished/cancelled occurrences return 410 (and a recurring series
  redirects to the next live occurrence) instead of resurrecting a dead room.
- **Quick-meeting URLs are now shareable** — `/room/quick` rewrites to the real
  meeting id once created, and the lazy room name is deterministic so two people
  joining a legacy meeting in the same second can't end up in different rooms.

## [1.13.0-beta.1] — 2026-06-06

**The "work OS" release.** Garely grows from a meeting app into a self-hosted
work platform: a built-in database, tasks rebuilt on top of it, and an AI layer
that turns meetings into decisions and assigned work — all on your own server.

### Added
- **Rebrand to Garely.** New name, interlock logo mark + wordmark, and docs
  (formerly EZmeet / EAM Meet). Product brand is decoupled from your workspace name.
- **Multi-tenancy foundation.** Every record now belongs to an Organization
  (single-database, `orgId`-scoped throughout) — the groundwork for a clean
  self-host first-run and a future hosted/multi-org cloud.
- **A native database engine** (Airtable / Teable-style), built in: Base → Table →
  Field → Record → Views (**grid, kanban, calendar**), ~18 field types (text,
  long text, number, currency, percent, rating, single/multi-select, date, person,
  checkbox, URL, email, phone, file/attachment, **TOTP 2FA code**, encrypted
  **password**, and two-way **link/relations**), filters & sorts, resizable and
  drag-reorderable columns & rows, a row context menu (insert ×N / duplicate /
  copy link / comment / delete), multi-select + bulk actions, **record comments**
  and attachments, and **per-base sharing by email** (roles + hidden columns).
- **Tasks, rebuilt on the engine.** Tasks are now records in that database, which
  unlocks **custom fields on tasks** — set them on create, edit them in the task
  drawer, see them as chips on the board, and filter the board by select fields.
  Plus multiple assignees and inline subtasks.
- **AI that does the work (the moat):**
  - The AI now **fills your custom task fields** straight from the meeting transcript.
  - **Decisions registry** — every decision your meetings make is extracted into a
    searchable registry (with owners), organised by meeting, with per-decision
    access control, inline **edit/delete**, and a backfill for existing reports.
  - A **weekly "where to focus" AI rollup** at the top of the digest email.
  - AI auto-assigns people, subtasks and the right department to action items.
- **Remote access — in-browser RDP** *(folded into this beta on 2026-06-09):*
  - **Connect to your RDP servers from the browser**, no client to install — a
    Rust/WASM **IronRDP** client streams the desktop through a self-hosted
    **Devolutions Gateway** (RDCleanPath over WSS); the page is the full client
    (display, keyboard, mouse, **NLA/CredSSP**).
  - **Encrypted credential vault** (AES-256-GCM) with **per-server access control**
    by user or department; every connection is audit-logged.
  - **Shared clipboard** both ways, **file drag-and-drop**, **dynamic 1:1 resolution**
    that follows the browser window and re-fits live, and **live presence** — everyone
    with access sees when a server is in use and by whom.
  - **Keyboard-layout sync** — Unicode keyboard mode types the character you pressed
    (Ukrainian, Russian, etc.) regardless of the server's active layout; a macOS
    **⌘→Ctrl** mapping with self-healing modifier state so a swallowed ⌘ keyup (e.g.
    after switching input source) never leaves typing stuck.
  - **Draggable session status pill** — reposition the server/disconnect chip anywhere
    over the canvas; the position persists across reconnects.

### Changed / Fixed
- **Self-host first-run hardening.** The Google-SSO setup path now provisions the
  first Organization (a fresh Google-only install no longer comes up without an
  org); integration status detects Google credentials via the database **and** env;
  `.env.example` spells out which services matter (DeepSeek = core, SMTP =
  recommended, Deepgram = opt-in).
- Meeting invitations send the `.ics` as a proper calendar alternative with a
  correct ORGANIZER/ATTENDEE; reports show **all** assignees, not just the lead.
- Database home bento layout, grid viewport-fit, and assorted polish.
- Calendar month view no longer nests interactive controls: a day cell is now a
  keyboard-operable container (not a `<button>`), so the task-deadline chips
  inside it are valid — clearing the React hydration warning.
- **Tasks — dense, sortable table.** The desktop list/department views are now a
  proper data-grid (Task · Priority · Assignee · Due · Subtasks · Department/Status)
  with click-to-sort headers, tabular dates, overdue/soon colour, and an inline
  "add a task" row per group; mobile keeps the stacked cards, Kanban is unchanged.
- **Meetings — entry window + "Start now".** A scheduled meeting can be joined only
  from 5 minutes before it starts; earlier, only the host/admin can start it via a
  "Start now" button (enforced server-side in the join-token route). This also fixes
  a bug where opening a future meeting early flipped it to `live` and an empty-room
  webhook then ended it — wrongly dropping it into the archive. The cleanup cron no
  longer auto-ends meetings whose start is still in the future.
- **Calendar keeps history.** Past, ended and cancelled meetings now stay on the
  calendar greyed-out instead of vanishing; the Archive remains the dedicated list.
- **Recording rework — stable, automatic, screen-aware.** The recorder no longer uses a
  CPU-heavy room-composite grid (which tore the video and broke the audio on a modest
  host). New `screen-audio` mode (`WS_RECORD_MODE`): the screen-share is captured as a
  passthrough TrackEgress (no transcode, no headless browser) and the whole room's mixed
  audio via a light audio-only egress, then muxed offline with ffmpeg into one MP4 — the
  screen placed on the timeline by real media-start so audio and screen stay in sync.
  Recording is now **fully automatic** (starts with the meeting; the manual in-room
  toggle is gone, the REC indicator stays). Deleting a meeting that has a recording is
  blocked so recordings can't silently vanish.

## [1.12.0-beta.1] — 2026-06-03

### Added
- **Personal calendar subscription (ICS).** Each user gets a private feed URL
  in *Settings → Calendar sync* to subscribe to **their own meetings and task
  deadlines** from Google Calendar, Outlook or Apple Calendar. One-way, the
  secret URL is the credential, and regenerating it revokes old subscriptions.
- **Email notifications for tasks.** You get an email (and in-app notification)
  when a task is **assigned** to you, and when a task's **status or due date
  changes** — sent to the assignee and collaborators, never to the person who
  made the change, and only on a real change. Honours the per-user task
  notification toggle.
- **Email + calendar invitations for meetings.** Scheduling a meeting now emails
  everyone (creator + participants/guests) an invitation with an attached `.ics`
  plus **Join**, **Add to Google Calendar** and **Add to calendar (.ics)** buttons
  — so it drops straight into Google / Outlook / Apple Calendar. Rescheduling
  sends an update; deleting sends a cancellation.

### Changed
- **Manage subtasks inline on the Tasks board.** Each task row has a disclosure
  caret that expands its subtasks in place — toggle status, see the assignee,
  delete, and quick-add (Enter) without opening the task. The parent row shows a
  progress meter (done / total).
- **Task details open in a side panel** — a right-hand, full-height drawer
  instead of a centred modal, keeping subtasks, comments, files and collaborators
  together; on phones it becomes a full-screen sheet.
- **Animated sign-in background** — a subtle, accent-tinted "flowing paths"
  backdrop on the login screen (CSS-only, hair-thin lines, honours
  `prefers-reduced-motion`).

## [1.11.0-beta.1] — 2026-06-03

**Departments & a real task workspace.** Tasks gain org structure, collaboration,
and a role-aware calendar — turning the post-meeting task list into a place work
actually happens.

### Added
- **Departments (org structure).** Admins create departments (name + colour) in
  *Settings → Departments* and assign members (with an optional lead). Meetings
  and tasks can belong to a department. A task's **effective department** is its
  explicit one, else its **assignee's** department — so moving a person into a
  department automatically attributes their tasks to it.
- **Access gating by department.** Non-admins see their **own** tasks, their
  **meetings'** tasks, their **department's** tasks, and tasks they **collaborate**
  on; admins see everything. The Tasks board adds a **By department** grouped view
  and a department filter; admins also get a department filter on the calendar.
- **Subtasks.** Break a task into a checklist of subtasks (one level), each
  toggleable and assignable; the board shows a subtask count.
- **Comments.** A threaded discussion per task. The assignee, collaborators and
  the task's department are notified of new comments; explicit @mentions notify
  the mentioned teammate (gated to people who can already see the task).
- **File attachments.** Upload files to a task (stored in a dedicated Docker
  volume, 25 MB each); download is authenticated and always served as an
  attachment. Uploader or an admin can delete.
- **Collaborators.** Add extra people to a task beyond the assignee; they get the
  task in their lists, on their calendar, and a notification when added.
- **Tasks on the calendar, role-scoped.** Task (and subtask) deadlines appear on
  the calendar within each person's access scope; clicking one opens the task.

### Changed
- The Tasks page modal now hosts the full task workspace — details plus a
  **Subtasks / Comments / Files** panel and a collaborators row.

## [1.10.0-beta.1] — 2026-05-30

A **mobile & in-meeting UX** pass. This entry also **consolidates the 1.6.0–1.9.0
betas** (those standalone releases were retired in favour of one rolling release).

### Added
- **Start a quick meeting from mobile.** The mobile compose (+) button is now a
  **speed-dial** offering *Quick meeting* (start now) or *Schedule*, and the
  dashboard exposes both as cards — previously phones could only schedule.

### Changed
- **Simplified in-meeting controls.** The bottom bar went from ~14 flat buttons
  to a focused core — mic, camera, screen share, reactions — plus a **⋮ More**
  menu (record, invite, device pickers) and a single **Panel** button. The five
  separate side-panel buttons (participants, chat, transcript, notes, AI) are now
  **tabs inside one panel**. On phones the bar stays compact: screen share and the
  device pickers fold into the ⋮ menu.
- **Quizzes moved into the Tasks page** as a `Tasks | Quizzes` tab (web + mobile),
  with the pending-quiz reminder badge now on Tasks. This frees a slot in the
  mobile bottom bar; `/quizzes` redirects to the new tab.

### Fixed
- The in-call **device pickers now show the device actually in use** (and the
  default speaker) instead of "Not found".

### Also in this release (consolidated from 1.6.0–1.9.0)

- **Comprehension quizzes** (was 1.9.0). From a finished meeting's report, an
  admin or the creator can generate AI multiple-choice questions, edit / add /
  remove them, choose open- or closed-book, and assign to participants. Assignees
  take a mobile-friendly, **auto-graded** quiz (one attempt); creators are
  notified of each result. A "Quizzes" hub shows everyone their assigned quizzes
  and gives admins/creators each participant's score with an answer review.
  Quizzes can be deleted.
- **Recording rebuild** (was 1.8.0). **On-demand recording** — start/stop from a
  Record button inside the meeting (host/admin) instead of an all-or-nothing
  setting; the REC indicator now reflects the real recording state for everyone.
  Transcript segments from one continuous turn are **coalesced** into
  paragraph-sized rows.
- **Recurring meetings & polish** (was 1.7.0). Recurring meetings
  **auto-materialize** their next occurrence (missed slots skipped); report and
  archive render times in the **workspace timezone**; accessibility aria-labels on
  icon-only buttons.
- **Security & reliability** (was 1.6.0). Tightened **authorization** on tasks,
  recordings and per-speaker tracks; upgraded `nodemailer` (clears an
  SMTP-injection advisory); added security headers (CSP `frame-ancestors` /
  `X-Frame-Options` / `nosniff` / `Referrer-Policy`); report generation status
  with a Retry button; **automated daily DB backups** (rotated, kept 14); a
  state-cleanup cron; ops hardening (healthchecks, log rotation, memory limits);
  a clean `scheduled → live → ended` meeting status machine; DB indexes.

## [1.5.0-beta.1] — 2026-05-26

A foundational **quality & hardening** release driven by a code audit — no new
user-facing features, plus one user-facing fix.

### Added
- Test suite expanded **24 → 122** across 21 files: integration tests for the 12
  most security-critical API routes (set-password token lifecycle, tasks
  scope/authorization, invite, admin password reset, self-registration
  anti-enumeration, webhook auth, join-token, guest join, admit, recording
  access) plus unit tests for the core authz primitive, route guards,
  rate-limiter, validation, error wrapper, password and i18n parity. Prisma
  deep-mock test harness.
- Structured JSON logger and a `withRoute()` error wrapper adopted across the
  API — uniform try/catch + structured error logs (routes without error handling
  went **36 → 1**).
- Error tracking via a Sentry-envelope reporter (self-hosted GlitchTip
  compatible), enabled by setting `SENTRY_DSN`.
- Redis-backed rate limiting with a transparent in-process fallback.
- `zod` request-body validation (foundation + task creation).
- Test-coverage reporting: `npm run test:coverage`.

### Changed
- Split the four largest components into focused files: settings 1581→69,
  calendar 1983→350 (fully), report 2245→1813 and room 1405→1205 (lib +
  presentational extracted).
- Typed the NextAuth session/JWT — removed **124 `as any` casts** (318 → 194).
- Extracted shared primitives (secret resolution, SSE parser, HTTP/route-guard
  helpers, email escaping, UI Spinner/Modal/useTransientMessage).
- The production 2FA secret now fails closed (never falls back to a dev constant).

### Fixed
- Dashboard React #418 hydration error: dates/times render against the workspace
  timezone so server and client produce identical markup.

## [1.4.0-beta.1] — 2026-05-26

### Added
- Grounded per-meeting **AI chat** on the report (streaming answers, clickable
  transcript citations).
- Calendar shows **task deadlines** alongside scheduled meetings.
- Invited users **set their own password** via a one-time link.
- Admins are **emailed on new self-registrations**; admins can **rename users**.

### Changed
- Admin Users list redesigned into a single aligned row.

### Fixed
- User-facing email links now use the public URL (were pointing at the internal
  Docker host).

## [1.3.0-beta.1] — 2026-05-25

### Added
- Topic-structured **"Detailed" reports** with clickable transcript citations;
  the extended report is also included in the PDF export.

## [1.2.0-beta.1] — 2026-05-25

### Added
- **Per-speaker multilingual transcription** (uk/ru/en): per-participant Deepgram
  STT, post-meeting language detection (with a UI-language prior to break the
  uk↔ru tie), and a report "fix language & regenerate" flow.

## [1.0.0-beta.1]

### Added
- Initial public beta: video meetings (LiveKit SFU), live transcription, AI
  summaries / action items, collaborative notes, reactions, optional recording,
  installable PWA with push notifications, full uk/en i18n, and a self-hosted
  one-command installer with automatic HTTPS.

[1.24.0-beta.3]: https://github.com/voltergared03/garely/releases/tag/v1.24.0-beta.3
[1.24.0-beta.2]: https://github.com/voltergared03/garely/releases/tag/v1.24.0-beta.2
[1.24.0-beta.1]: https://github.com/voltergared03/garely/releases/tag/v1.24.0-beta.1
[1.23.0-beta.4]: https://github.com/voltergared03/garely/releases/tag/v1.23.0-beta.4
[1.23.0-beta.3]: https://github.com/voltergared03/garely/releases/tag/v1.23.0-beta.3
[1.23.0-beta.2]: https://github.com/voltergared03/garely/releases/tag/v1.23.0-beta.2
[1.23.0-beta.1]: https://github.com/voltergared03/garely/releases/tag/v1.23.0-beta.1
[1.10.0-beta.1]: https://github.com/voltergared03/garely/releases/tag/v1.10.0-beta.1
[1.5.0-beta.1]: https://github.com/voltergared03/garely/releases/tag/v1.5.0-beta.1
[1.4.0-beta.1]: https://github.com/voltergared03/garely/releases/tag/v1.4.0-beta.1
[1.3.0-beta.1]: https://github.com/voltergared03/garely/releases/tag/v1.3.0-beta.1
[1.2.0-beta.1]: https://github.com/voltergared03/garely/releases/tag/v1.2.0-beta.1
[1.0.0-beta.1]: https://github.com/voltergared03/garely/releases/tag/v1.0.0-beta.1

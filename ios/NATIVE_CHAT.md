# Native chat

The native chat replaces the placeholder in the existing authenticated iOS shell.
It uses real session history, runtime capabilities, catalogs, attachments and
interaction responses. Authentication, account management, device management and
the sidebar retain their existing routes.

The implementation builds on the v2 API alignment at `95693c24` and the approved
local Untitled Project prototype at `b7ece2a`. The app uses AA's existing
`AppTheme`: primary controls are black in light mode and white in dark mode.
Semantic error and availability colors remain separate from the primary color.

## Composer and timeline

- The empty, unfocused composer is a pill with the same 48-point base height as
  the header controls. Focus, any text (including whitespace), or attachments
  expand it. A single `UITextView` survives the layout transition.
- Return always enters a newline or participates in IME candidate selection.
  The send button and Command-Return share the same send path. Marked text blocks
  sending; the client does not force the Chinese input method to commit a guess.
- The editor grows to `min(160, max(72, availableHeight * 0.30))` points, then
  scrolls internally. Controls preserve at least a 44-point touch target.
- The plus button opens a Liquid Glass options sheet with contrasting, borderless
  photo/file tiles and model/permission rows. Secondary selection pages use native
  lists and expand to the large detent. A picker is presented from the persistent
  composer host only after the options sheet finishes dismissing.
- Photo/file imports allow at most five attachments of 25 MiB each. Existing
  sessions upload attachments through the session resource; creation uses the
  backend's inline first-message attachment contract. Downloads are explicit.
- Textual is pinned to 0.5.0 and renders Markdown headings, lists, code, tables,
  quotes, links, images and math. Code copying and native selection remain
  available. Completed Markdown blocks keep their identity and layout.
- `SessionTimelinePresentation` stages received projections separately from
  observable rows. It publishes at 30 Hz while work is pending; static history
  does not keep a polling clock awake. New glyphs use a 240 ms opacity, blur and
  vertical reveal. Initial history and recovery snapshots do not replay reveals.
- Pending user-message removal and authoritative echo insertion happen in the
  same presentation tick. A per-width/Dynamic-Type height floor and stable blocks
  reduce Markdown height churn during streaming. Authoritative replacements
  reset the layout generation.
- Tail following uses a continuous spring. Scrolling away suspends it, and a
  small borderless “到底部” pill sits centered above the composer. There is no
  animated streaming dot or cursor.
- An explicit return-to-bottom request survives the previous drag's deceleration
  callbacks. The pill is a sibling of the scroll view, and native `ScrollPosition`
  owns navigation. A new drag (including a direct transition from animation to
  interaction) releases its persistent edge target and cancels queued following.
  The pill hides within 96 points of the bottom and throughout tracking,
  dragging, deceleration and programmatic scrolling. Exact follow intent keeps
  its two-point tolerance: stopping near the bottom does not resume following.
  Phase changes use their own geometry rather than a stale callback's value.
  Active interactions cancel queued auto-follow and release the native edge
  target. Explicit return remains available, but ends on arrival while an
  interaction is present. Removing the card preserves the reading position.
  A constant 32-point tail spacer provides breathing room without status-driven
  padding changes.
- When the latest-history prompt is already visible, pulling up another 24 points
  and releasing loads the latest records once. The prompt changes to “松开加载”;
  tapping remains available. Inertia and viewport resizing cannot trigger a load.
  A drag during the fetch cancels its pending return to the bottom.

## Session presentation and files

- Tools use a single-line, monospaced marker with a disclosure chevron. Commands,
  MCP calls, web searches, Agent calls and file changes follow Web's payload
  parsing. Expanded commands/outputs have bounded scrolling and copying; unified
  diffs include action colors and old/new line numbers. These panels render
  timeline payloads, without fetching file contents. The marker does not parse
  patches or format output JSON: expanding mounts the detail subtree, and
  collapsing unmounts it. Active titles shimmer, failures are red and other
  markers use the primary text color; no trailing status badge is shown.
- The timeline uses lazy row layout. Scroll geometry updates are isolated from
  the content subtree, and a separate observable structural projection keeps
  token/tool-output appends from regrouping every historical row. Only status,
  membership and grouping changes invalidate that projection.
- Consecutive tools/reasoning/artifacts, child Agent calls and reconnect attempts
  are grouped. Groups retain the first item's identity while growing, and
  disclosure state survives streaming updates. Items targeted by active notices
  remain individually visible. Hidden items, turn markers, duplicate diff
  artifacts and Claude's interruption/no-response sentinels are filtered like Web.
- Expanded groups align with the timeline without an extra leading inset. Copy
  and Share appear once after each completed reply turn, following Web's grouping
  between user messages. Copy/Share collect that turn's assistant text fragments;
  reasoning, tools and system text stay out. Active/incomplete latest turns have
  no footer; individual entries remain copyable from their context menus.
- The session header uses `safeAreaBar` with the scroll view's native soft edge
  effect. The sidebar icon has three left-aligned strokes, the last shorter.
  A right-hand glass button group contains New Session and a details menu. The
  phone's left-edge drawer gesture starts within 44 points and still requires
  horizontal intent so vertical timeline scrolling is not intercepted.
- The plus sheet includes takeover, its consequences and an explicit confirmation.
  Ambiguous writes require refreshing; a successful takeover followed by a failed
  read retains the confirmed write result.
- Read-only sessions also show an interactive glass takeover pill below the
  header, sharing the options sheet's native system Alert. The empty composer says
  “请先接管” until takeover is enabled; existing drafts remain intact. The sidebar
  strokes explicitly use AA's primary foreground color in both appearances.
- Switches use the native switch style with inherited app tint/accent overrides
  cleared. Their shape, thumb, size and animation are supplied by the system.
- Details expose session/device/Agent metadata and JSON export. The server export
  paginates independently of the visible history cache, deduplicates revisions,
  and rejects stalled cursors, cancellation and mismatched sessions. Both exports
  preserve original timeline/notice payloads and identify their source/window.
- Workspace file paths in markers, Markdown links and inline code open a **sheet
  containing the Web preview**. Workspace images also open Web on demand. The
  native directory browser and session links share a scoped, one-use preview
  token flow; native code does not fetch `fs/readText` to render previews. Each
  sheet uses an ephemeral WebKit data store and obtains a fresh token on retry.
  Already displayed content remains visible offline, with device/network status.
  Uploaded session attachments retain their separate attachment download flow.
- File management opens at the medium detent and can expand to large; individual
  Web previews open large. Long-pressing any directory entry copies its path.
  Files also offer Download (the system export picker) and Open In (the system
  activity sheet). Exports use the full binary transfer, validate its byte count,
  and reject cross-origin credential forwarding. They remain temporary on disk
  until the system sheet closes; cancellation/failure removes partial files.
  The Web preview's own download links, including blob URLs, use `WKDownload`
  and open a system activity sheet on completion.
- Non-inline session/action errors appear below the header in borderless glass
  toasts with horizontal paging, dismissal and explicit refresh where applicable.
  Toasts overlay content without changing the timeline's height. Dismissing one
  never changes connection facts or replays an action. Inline form errors remain
  with their forms.

## New Session and connectivity

`NewSessionModel` owns the account-scoped draft and preparation state. The page
shows the selected device and configured Agent together, a workspace entry and
current availability. Its picker first selects a device, then an actual configured
Agent instance on that device. Only the completed pair changes the target;
canceling the picker preserves the previous choice.

The model keeps cached inventories for display, but requires an online device,
a ready Agent, fresh preparation and valid selections before creating. Phone
connectivity and device availability are separate states. Temporary empty/offline
inventory does not overwrite saved preferences. Reconnection re-prepares the
target, and generation checks discard late preparation results.

Before creation, capabilities and catalogs are checked again. If the effective
model or permission choices changed, creation pauses for another explicit send.
A timeout or other ambiguous write retains the draft and requires checking the
session list before explicitly enabling another attempt. Reconnection never
replays creation, messages, uploads or interaction responses.

Only non-content preferences use `UserDefaults`, namespaced by server and account:
device/Agent IDs, per-device workspace paths, and per-target opaque selection IDs.
Session histories, message drafts, attachment bytes and interaction drafts remain
in memory. They survive view changes and temporary disconnection, but not process
termination. See [API_ALIGNMENT.md](API_ALIGNMENT.md) for cache limits, retry and
recovery policy.

## Runtime interaction protocol

`SessionNoticeStore` exposes stable observable notice objects and keeps form drafts
separate from authoritative runtime state. Approval, confirmation, execution-error
and input-request interactions share the same action path. Action IDs, styles,
blocking scope, status and expiry come from the protocol. Known action labels
are localized like Web; extension actions retain their protocol labels.

- Active interactions blocking this session form a vertically paged stack above
  the composer, with the same horizontal inset as the collapsed composer. The
  selected item survives new arrivals; removing it selects an adjacent item.
  The collapsed surface is a glass card with fixed title, summary, status and
  action slots; there is no external response prompt. Expand and the optional
  page count live inside the card. The stack retains its height across notice
  counts and submission/network hints. Vertical swipes change the selected card.
  Expand opens the selected notice in the full interaction sheet. Operation
  Details opens a sheet with context, editable fields and full diagnostic text.
  Neither entry expands the dock inline.
- Actions reuse `AppGlassButton`: protocol-primary actions are prominent,
  secondary/cancel actions regular, and danger actions destructive. Only the
  selected action shows loading; all actions reject concurrent submissions.
  Every protocol choice remains accessible, including approve-for-session.
  An incomplete form action opens the editable sheet from the compact card;
  the full form cannot submit until valid.
- Nonblocking interactions are associated with their source/context timeline
  item when present. Unanchored notices appear in the timeline. Ordinary
  notifications do not gain action buttons or block sending.
- Standard `inputRequest` v1 forms support multiple questions, single/multiple
  choices and an explicit Other selector. Single-choice radios remain selected
  on repeated taps, selecting Other clears the single preset, and multiple
  presets can coexist with Other. Deselecting Other removes its payload text.
  Payloads use the protocol's `optionIds` and `customText` structure. All native
  text inputs guard Chinese IME composition; draft objects survive sheet changes.
- Other action schemas support native scalar, enum, enum-array and nested-object
  forms with client validation. Arbitrary JSON Schema extensions are not a
  universal supported surface: unsupported required forms fail closed and direct
  the user to Web rather than submitting an empty or fabricated payload.
- `open`/`failed` can accept an explicit response. `responding`,
  `response_accepted` and `resolving` stay visible without enabling duplicate
  submissions. Terminal/expired notices cannot be answered.
- HTTP acceptance does not close the notice. Runtime state confirms completion.
  A later refresh failure cannot turn an accepted action into a retryable write.
  Ambiguous writes require review; drafts survive disconnection and status
  revisions, and reset when the form definition changes.
- `waiting_approval` is a runtime/session state, as well as a timeline status.
  Metadata decoding accepts it and preserves unknown future state values as
  `.unknown`. A decoding failure is an invalid response, never a network outage;
  errors identify the event and field without exposing payload contents. Cards
  distinguish phone offline, device offline and state validation errors.

## Login lifecycle

After the user selects a local server (address entry or QR confirmation), a real
native connection to that target requests local-network access before the OAuth
browser opens. It waits through the system prompt, supports cancellation, and
offers Settings when access is denied. It does not broadcast discovery traffic.
Authentication URL sessions wait for connectivity. `Info.plist` registers the
OAuth callback as a URL-types array and declares scoped local-network ATS rules.

OAuth attempts own their presentation window and continuation. Browser dismissal,
failure to start, task cancellation and late duplicate callbacks settle the
attempt exactly once. The redirect target, state and authorization-code fields
are validated before token exchange, and the profile is verified before saving
credentials. Cancelling the browser remains a retryable login outcome rather
than a “server unavailable” alert.

## Verified checks

Verified on 2026-09-05, without starting a server or simulator:

- 73 headless Swift tests across ten suites pass against production client-core
  sources. They cover API contracts, recovery/cache races, uncertain delivery,
  30 Hz presentation, echo handoff, target preparation, preference scope, schema
  payloads and interaction lifecycle/IME guards. Session-detail checks cover
  tool/diff parsing, grouping identity, file routing, export pagination/cancellation,
  OAuth callback validation, local-server classification and waiting-approval
  metadata through an actual repository connection and response.
- The Python backend contract fixture exporter reports that fixtures are current.
- The complete unsigned iOS Debug target builds for `generic/platform=iOS`, using
  the checked-in package resolutions and the Xcode beta toolchain. The app's
  existing iOS 26.5 deployment target remains unchanged.

From the repository root:

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path ios
```

From `server/`:

```sh
uv run python ../ios/scripts/export_contract_fixtures.py --check
```

Unsigned app build, when needed after source changes:

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild \
  -project 'ios/Agents Anywhere/Agents Anywhere.xcodeproj' \
  -scheme 'Agents Anywhere' -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath ios/.build/xcode \
  -onlyUsePackageVersionsFromResolvedFile CODE_SIGNING_ALLOWED=NO build
```

## Manual Xcode checks

Open `ios/Agents Anywhere/Agents Anywhere.xcodeproj`, choose the `Agents Anywhere`
scheme and the intended signing team/device. Rendering, the system pickers, actual
keyboard layout and real mobile-network behavior still need manual validation:

1. Check AA colors in light/dark mode and the compact/expanded composer, including
   focus with no text, whitespace-only text, attachments and large Dynamic Type.
2. With a Chinese keyboard, select candidates, tap Send during composition, use
   Return for newlines and Command-Return on a hardware keyboard. Paste long text
   and verify internal scrolling and keyboard safe areas.
3. Open Photos and Files from the options sheet, cancel and reopen, then send
   attachments. Check model/permission secondary pages and capability changes.
4. Stream the first reply and another reply with Markdown, code and tables. Check
   glyph reveal, stable message handoff, tail following and manual scroll-away.
5. Select another device and Agent, cancel halfway, then switch back. Check that
   the workspace and selections belong to the chosen target.
6. Disconnect the phone network, disconnect the target device and background the
   app during preparation/streaming. Restore connectivity and confirm drafts and
   selection remain, reads recover and writes are not replayed.
7. Exercise approval, confirmation, execution-error and multi-question input
   requests, including concurrent notices, IME input, expiry, failures and an
   accepted response followed by temporary disconnection.
8. Check single-line markers, nested Agent groups, command/output copying and
   file-change diffs. Open workspace paths and images from Markdown and the file
   browser; refresh previews after disconnection and close/reopen a sheet.
9. Swipe approval cards vertically, including long forms; verify their width
   against the collapsed composer. Swipe multiple top errors horizontally and
   dismiss them without changing the conversation's scroll position.
10. Test first-use local-network permission (allow and deny), cancelling OAuth,
    an invalid/expired callback and starting login again. Inspect the native
    header edge effect over long titles and bright content in both appearances.

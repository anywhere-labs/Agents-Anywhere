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
  the header controls and 32-point horizontal insets (eight points narrower on
  each side than before). Focus, any text (including whitespace), or attachments
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
- Opening a session immediately displays one persistent loading indicator in
  the detail column. History loading and timeline mounting wait for the sidebar
  animation's completion and another 120 ms; a new selection cancels the pending
  start. A sidebar gesture after loading starts does not restart the connection.
  Opening loads the latest window, reveals it when the initial projection is
  ready, and animates to the measured bottom offset. It never pages backward to
  find a user message. Spinner dismissal and the 30 Hz presentation clock do not wait
  for scroll/layout acknowledgements; there is no frozen opening snapshot or
  positioning retry loop. Network failures still offer Retry.
- `TimelineScrollState` owns three navigation modes: reading, following and
  returning. Opening, sending, accepted responses and the bottom pill all request
  the same return operation. Each native animation targets one finite offset,
  rather than leaving a persistent bottom edge to follow layout independently;
  completion releases that position. Command IDs stop interrupted/old completions
  from releasing a newer target. Layout changes are
  coalesced for 24 ms, and offset callbacks cannot reissue the same target. The
  30 Hz token presentation and spring scroll animation remain independent.
- Native `ScrollGeometry` is the only source of bottom distance. The clamped
  bottom offset is `max(-topInset, contentHeight + bottomInset - containerHeight)`;
  no screen visibility probe or duplicate footer inset participates. Arrival has
  an 8-point tolerance, while the small borderless “到底部” pill stays hidden within
  96 points. The pill remains centered above the footer and hides during tracking,
  dragging, deceleration and programmatic scrolling. An interrupted request that
  did not reach its target leaves the pill available instead of endlessly retrying.
- A new vertical gesture cancels automatic navigation immediately. The idle phase's
  own geometry decides whether a completed manual scroll reached the bottom;
  stopping nearby remains reading mode. Explicit returns survive old deceleration
  callbacks. Active interactions cancel queued following; a requested return with
  remaining cards finishes in reading mode. Removing the last interaction requests
  the new bottom. Loading older history retains its existing measured anchor.
- The composer and approval dock overlay the scroll view. Their actual, rounded
  height supplies one bottom content margin; resizing the dock does not also
  resize the scroll viewport. A constant 32-point spacer provides breathing room.
  The phone drawer applies the untransformed host's safe area (including keyboard)
  once, and suspends navigation throughout motion and while obscuring the detail.
  Resuming preserves reading intent and follows new content only when
  appropriate. iPad keeps its default native split layout and animation.
- Both history prompts support a fresh 24-point outward pull and release when
  already visible: pulling past the top loads older messages, and pulling past
  the bottom loads newer records. The prompt changes to “松开加载”; tapping remains
  available. Only one history request runs at a time. Inertia and viewport/content
  resizing cannot trigger a load. A drag during the fetch cancels pending anchor
  restoration or return to the bottom, preserving the user's new reading intent.
  Older history shows an explicit circular spinner through the presentation and
  layout deadline. One measured existing group retains the reading offset when
  a page is prepended, without counting streamed tail growth or aligning a whole
  group to the top. The final page keeps the prompt's height as a start-of-session
  marker, preventing a second jump when loading ends.

## Session presentation and files

- Tools use a single-line, monospaced marker with a disclosure chevron. Commands,
  MCP calls, web searches, Agent calls and file changes follow Web's payload
  parsing. Expanded commands/outputs have bounded scrolling and copying; unified
  diffs include action colors and old/new line numbers. These panels render
  timeline payloads, without fetching file contents. The marker does not parse
  patches or format output JSON: expanding mounts the detail subtree, and
  collapsing unmounts it. Active titles shimmer, failures are red and other
  markers use the primary text color; no trailing status badge is shown.
- The main timeline and interaction surfaces use ordinary stacks to retain
  actual geometry while Markdown, forms and expanded tools change height.
  Deferred parsing/rendering is scoped to hidden tool details. Scroll geometry
  updates are isolated from the content subtree, and a separate observable
  structural projection keeps token/tool-output appends from regrouping every
  historical row. Only status, membership and grouping changes invalidate it.
  Looking up an existing repository model only touches its cache entry; it does
  not re-project historical payloads or subscribe the shell to every row's
  observable fields. Session/New Session pages have equality boundaries that
  isolate sidebar movement while allowing their own observed state to update.
- Consecutive tools/reasoning/artifacts, child Agent calls and reconnect attempts
  are grouped. Groups retain the first item's identity while growing, and
  disclosure state survives streaming updates. Items targeted by active notices
  remain individually visible. Hidden items, turn markers, duplicate diff
  artifacts and Claude's interruption/no-response sentinels are filtered like Web.
- Expanded groups align with the timeline without an extra leading inset. Copy
  and Share appear once after each completed reply turn, following Web's grouping
  between user messages. Copy/Share collect that turn's assistant text fragments;
  reasoning, tools and system text stay out. Active/incomplete latest turns have
  no footer; individual entries remain copyable from their context menus. A local
  pending user message already marks the next turn, so its predecessor's footer
  stays visible through HTTP acceptance and the authoritative echo.
- The session header uses `safeAreaBar` with the scroll view's native soft edge
  effect. Its subtitle shows the Agent and device names, using the device ID
  when its name is not yet available. The sidebar icon has three left-aligned strokes, the last shorter.
  A right-hand glass button group contains New Session and a details menu. The
  phone's left-edge drawer gesture starts within 44 points and still requires
  horizontal intent so vertical timeline scrolling is not intercepted.
  The sliding card uses the host's original horizontal safe-area insets instead
  of deriving new insets from its partly off-screen position. Sidebar movement
  releases the native edge target and suspends queued auto-follow/edge pulls;
  vertical navigation resumes from the reported native scroll phase afterward.
- At regular iPad widths, the native split opens with both columns and keeps the
  sidebar visible when selecting a session, device or New Session. The detail
  remains an active read target while the sidebar sits beside it. Narrow iPad
  windows use `preferredCompactColumn` to show the selected detail; widening
  restores both columns. The balanced style reserves room for the sidebar.
  Explicit split toggles retain smooth animation and respect Reduce Motion.
  The detail uses the native split's proposed width immediately, without a
  frozen width or delayed reflow. The phone drawer shadows only its card
  shape, avoiding an animated compositing layer around the whole conversation. The custom
  sidebar and chat headers suppress empty native navigation bars, retaining the
  system safe area without an additional blank bar above the glass controls.
- Sidebar indicators follow Web's priority and position, on the title's trailing
  side: a green waiting-approval capsule, a native spinner for running/waiting/
  pending, or a green unread dot for an idle session. Opening an unread session
  in the active foreground immediately clears its local unread indicator and
  sends the existing read-receipt API through `V2SessionReadCoordinator`. Requests
  belong to the authenticated services, surviving drawer/selection changes.
  Local seen progress and confirmed `lastReadSeq` merge monotonically across
  dashboard snapshots, independently of `updatedSeq`. A receipt changes read
  progress only, preserving current runtime metadata; older snapshots cannot
  resurrect an already read turn or conceal a newer unseen turn.
  Transient failures retry with backoff only for the visible foreground session.
  Offline/background periods preserve local progress, and new turns received
  while away remain unread. Returning foreground/online retries the visible
  session. Account/server changes invalidate requests and clear the watermarks.
  An unrelated dashboard error does not block this idempotent server operation.
  Dashboard updates drive indicators live. Running sessions sort first in stable
  ID order; other sessions use descending `sortAt`, matching Web within pinned
  and recent sections.
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
- Composer image selections use background-downsampled thumbnails. User-message
  attachments appear above the text bubble, with image previews or filename/type/
  size tiles, matching Web's arrangement. Only visible remote images request
  thumbnails: uploaded files use the session attachment API; device paths use
  `fs/read` and its binary transfer, honoring the attachment root. Tapping device
  files/images still opens the scoped Web preview sheet. Image frames retain the
  same size while decoding or switching from a local preview to server content.
  The session owns a 16 MiB preview cache and bounded attachment metadata; cached
  previews work offline and account invalidation clears them.
- Sending moves the committed draft into a local bubble immediately after uploads
  are ready. Its only pending indicator is a spinner in the bubble's left gutter;
  delivery status never changes text width. Metadata and thumbnails survive
  `clientMessageId` reconciliation, including reordered/sparse server attachments.
  Failed or uncertain writes restore the draft only if the editor is still empty,
  never overwrite a newer draft, and never replay automatically. A compact issue
  icon opens the existing explicit failure/uncertain-delivery actions.
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
  the composer, with a 24-point inset, slightly wider than the collapsed composer. The
  selected item survives new arrivals; removing it selects an adjacent item.
  The collapsed surface is a glass card with fixed title, summary and action
  slots; there is no external response prompt. Details sits to the left of Expand
  and the optional page count inside its aligned header. At default text size the
  preview is 166 points tall. Status uses the summary's second line when needed,
  rather than reserving a separate empty row.
  The stack retains its height across notice
  counts and submission/network hints. Vertical swipes change the selected card.
  Expand opens the selected notice in the full interaction sheet. Operation
  Details opens a sheet with context, editable fields and full diagnostic text.
  Neither entry expands the dock inline.
- Actions reuse `AppGlassButton`: protocol-primary actions are prominent,
  secondary/cancel actions regular, and danger actions destructive. Only the
  selected action shows loading; all actions reject concurrent submissions.
  The compact card prioritizes the primary action and an actual reject action;
  additional choices, including approve-for-session, open in a native “更多” menu
  beside the buttons. Reject and cancel are distinct wire decisions. If the
  protocol offers cancel without reject, the card says “取消本轮”; it never invents
  a reject action or submits cancellation disguised as rejection.
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

Verified on 2026-09-06, without starting a server or simulator:

- 135 headless Swift tests across eighteen suites pass against production client-core
  sources. They cover API contracts, recovery/cache races, uncertain delivery,
  30 Hz presentation, echo handoff, target preparation, preference scope, schema
  payloads and interaction lifecycle/IME guards. Session-detail checks cover
  tool/diff parsing, grouping identity, file routing, export pagination/cancellation,
  OAuth callback validation, local-server classification and waiting-approval
  metadata through an actual repository connection and response. Navigation
  cases cover native insets, short content, rounding, manual/explicit returns,
  animation completion ordering, drawer occlusion, interaction changes and both
  history edges. Sidebar status priority/order and compact approval
  grouping are checked against the Web and runtime contracts. Read receipt tests
  exercise the production API, immediate local read state, rapid navigation,
  equal-revision snapshots, delayed acknowledgements, per-turn coalescing,
  connectivity/lifecycle recovery and account invalidation.
  Sidebar tests cover regular/compact selection and resize behavior, and confirm
  cached model lookup does not subscribe its caller to historical row payloads.
  Opening/history tests cover measured offset retention, scroll-independent
  presentation and optimistic echo handoff, realtime updates during opening,
  pulls, cancellation and opening without fetching earlier user messages.
  Attachment/delivery tests cover sparse/reordered echoes, bounded caches, FS
  thumbnail reads, offline preview reuse and preserving a newer identical draft.
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
9. Swipe approval cards vertically, including long forms; cards should be slightly
   wider than the collapsed composer, with Details to the left of Expand on the
   same line. Accept the final request and check the return after the dock closes.
   Swipe multiple top errors horizontally and
   dismiss them without changing the conversation's scroll position. Check
   Approve/Reject, the native More menu, and a runtime offering only Approve/Cancel.
10. Test first-use local-network permission (allow and deny), cancelling OAuth,
    an invalid/expired callback and starting login again. Inspect the native
    header edge effect over long titles and bright content in both appearances.
11. Reach the actual bottom with and without the keyboard/approval dock; the
    return pill should hide near the bottom and while scrolling. Stop farther up
    and verify it returns without snapping back. At each history edge, release
    a fresh pull to load one page; scroll during loading to cancel restoration.
12. Open the sidebar during running, approval and idle-unread states. Open an
    unread session and immediately reopen the sidebar or choose another session.
    Its unread dot should clear immediately and stay cleared after the request
    and dashboard update. New turns received while away should become unread.
    Switch apps and return, and reconnect after going offline; verify read
    synchronization and live status changes without reopening the app.
13. On iPad, start at regular width and select several sessions, devices and New
    Session; the sidebar should remain alongside the detail. Check both custom
    headers against the status bar without an empty navigation bar. Resize to a
    narrow window, select a session, reopen the sidebar and widen again. With a
    long Markdown history, toggle the sidebar and check responsiveness, retained
    reading position and continued streaming while the detail remains visible.
14. Open long, short and running sessions: the detail's spinner appears at once,
    loading starts after the sidebar animation, and loaded content appears with
    an animated return to bottom. Switch sessions rapidly during drawer motion.
    At the bottom of a long session, slowly open/close the iPhone drawer and leave
    it open; check stable footer spacing and no repeated vertical corrections.
    Repeat while reading in the middle and while streaming. Expand/collapse the
    composer, show/dismiss the keyboard and respond to approval cards; check the
    bottom margin is applied once and that a manual upward scroll is respected.
    Check Agent/device names in the header. Load older pages by tap/pull and check the spinner, retained
    reading offset and the final-page marker. Send images and documents, check
    composer thumbnails, the bubble's left spinner and unchanged preview/text
    geometry after echoes. Read a device-path image online, then reopen it offline
    from cache. Verify the previous completed reply's Copy/Share stays available.

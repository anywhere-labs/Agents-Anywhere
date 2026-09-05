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
and input-request interactions share the same action path. Action IDs, labels,
styles, blocking scope, status and expiry come from the protocol.

- An active interaction blocking this session stays in a bounded, internally
  scrolling card above the composer. The dock shows the first pending card and
  a count; it can expand into a page containing all pending cards.
- Nonblocking interactions are associated with their source/context timeline
  item when present. Unanchored notices appear in the timeline. Ordinary
  notifications do not gain action buttons or block sending.
- Standard `inputRequest` v1 forms support multiple questions, single/multiple
  choices and custom answers. Payloads use the protocol's `optionIds` and
  `customText` structure. All native text inputs guard Chinese IME composition.
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

## Verified checks

Verified on 2026-09-05, without starting a server or simulator:

- 54 headless Swift tests across seven suites pass against production client-core
  sources. They cover API contracts, recovery/cache races, uncertain delivery,
  30 Hz presentation, echo handoff, target preparation, preference scope, schema
  payloads and interaction lifecycle/IME guards.
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

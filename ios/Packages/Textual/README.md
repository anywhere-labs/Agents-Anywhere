# Textual for iOS

Source: https://github.com/gonzalezreal/textual, version 0.5.0,
commit `01b51875a5406eefc95f52a058cb059e7bc94dc4`. The MIT license is retained.
Only `Sources` and the runtime package dependencies are vendored; the upstream
snapshot test suite is not included.

This local package keeps the text-selection crash fix reproducible in Xcode and
on another development machine. Do not patch a DerivedData checkout.

The package also bundles its own `PrivacyInfo.xcprivacy`. Its `CA92.1` declaration
covers the app-local UserDefaults flag that enables Textual logging; the library
does not rely on the app's manifest to declare its own API use.

The selection changes adapt the stale-position validation from
[upstream PR 80](https://github.com/gonzalezreal/textual/pull/80) and the
empty-paragraph/layout-size fixes from the first two commits of
[upstream PR 88](https://github.com/gonzalezreal/textual/pull/88)
(`2b29f6e` and `9bc4036`). They are not released in 0.5.0.

Local additions apply the same validation to selected text, caret geometry,
range traversal and layout reconciliation. Invalid positions yield an empty
result instead of indexing a replaced layout. Traversal skips empty paragraphs,
lines and runs; valid selections keep their original UTF-16 offsets.

Selection layout snapshots capture their resolved size for comparison. They do
not feed size back through View state or reset overlay identity as text grows.
Reconciliation only publishes a changed range, following the approach in
[upstream PR 67](https://github.com/gonzalezreal/textual/pull/67), and coordination
does not repeatedly clear already-empty selections.

The iOS app supplies native code, table and image components. Local style APIs
expose literal code and attributed table cells (including empty columns), and
allow selection to be scoped to text instead of covering embedded controls.
Attachments remain live SwiftUI views rather than Canvas symbols, so image
buttons can receive input. Embedded controls publish exclusion rectangles to
the selection overlay. The parser, syntax highlighter, formatter and upstream
clipboard exporter remain unchanged; the app's code button copies literal text.

Run the headless regression tests from the repository root (no app or simulator):

```sh
swift test --package-path ios/Packages/Textual --scratch-path ios/.build/textual-tests
```

When upstream releases these fixes, compare the regression coverage before
switching the Xcode project back to a remote package and removing this copy.

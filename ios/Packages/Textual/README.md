# Textual for iOS

Source: https://github.com/gonzalezreal/textual, version 0.5.0,
commit `01b51875a5406eefc95f52a058cb059e7bc94dc4`. The MIT license is retained.
Only `Sources` and the runtime package dependencies are vendored; the upstream
snapshot test suite is not included.

This local package keeps the text-selection crash fix reproducible in Xcode and
on another development machine. Do not patch a DerivedData checkout.

Selection changes and regression coverage are documented alongside the fix.

# Agents Anywhere HarmonyOS

Native HarmonyOS client for Agents Anywhere, built with ArkTS and ArkUI on the
Stage model for HarmonyOS NEXT.

This client is a screen-for-screen port of the Android client in `android/`.
The Android app is the feature superset (it also ships Terminal, Files, camera
attachments and in-app updates), so matching it satisfies the iOS client too.

## Stack

- ArkTS + ArkUI (declarative), Stage model
- HarmonyOS NEXT 5.0.0 (API 12) minimum, compiled against the installed 6.1.0 SDK
- Zero third-party ohpm dependencies. Markdown, code highlighting and diff
  rendering are implemented in-tree so the build stays verifiable offline.
- The terminal embeds xterm.js (MIT) in an ArkWeb page; the JS bundle ships in
  `entry/src/main/resources/rawfile/terminal/` and never touches the network.

## Layout

```text
harmony/
├─ AppScope/                 application-level manifest and icon
├─ entry/src/main/
│  ├─ module.json5           abilities, permissions, OAuth deep link
│  ├─ resources/             base (English) and zh_CN string tables + media
│  │  └─ rawfile/terminal/   xterm.js host page and its JS/CSS bundle
│  └─ ets/
│     ├─ api/                HTTP/WS transport, URL rules, DTO parsing
│     ├─ feature/            controllers and page state (no UI)
│     ├─ model/              shared app models
│     ├─ navigation/         AppDestination
│     ├─ ui/designsystem/    colour tokens, metrics, icons, shared components
│     ├─ ui/screens/         one folder per screen family
│     ├─ app/                composition root and dependency wiring
│     └─ pages/Index.ets     the single page the entry ability loads
└─ tools/                    resource conversion scripts
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the layering rules and
[harmony-client-plan.zh-CN.md](harmony-client-plan.zh-CN.md) for the port plan
and phase status.

## Open in DevEco Studio

1. Install DevEco Studio 6.1 or newer with the HarmonyOS 6.1.0 (API 23) SDK.
2. Open this `harmony/` directory (not the repository root).
3. Wait for the project sync to finish.
4. Select the `entry` module and run it on a device or emulator.

## Build from the command line

The `hvigorw` / `hvigorw.bat` wrapper resolves the hvigor bundled with the local
DevEco Studio installation instead of downloading it, so the build works offline
and uses the same build system version as the IDE. Set `DEVECO_HOME` if DevEco
Studio is installed somewhere unusual.

```bash
./hvigorw assembleHap
```

On Windows:

```bat
hvigorw.bat assembleHap
```

To invoke hvigor directly, which is what the wrapper does:

```powershell
$env:DEVECO_SDK_HOME = "C:\Program Files\Huawei\DevEco Studio\sdk"
node "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js" `
  assembleHap --mode module -p product=default --no-daemon
```

The output is `entry/build/default/outputs/default/`: `entry-default-unsigned.hap`
and, when a signing config is present, `entry-default-signed.hap`.

### Static checks

`assembleHap` runs the ArkTS compiler, which performs the full type check and the
ArkTS lint pass; its diagnostics are the authoritative static gate and the build
fails on any error. A clean build reports **zero errors and zero ArkTS warnings**.

DevEco Studio's **Code Linter** is an IDE plugin and this installation exposes no
headless `codelinter` command, so it is run from the IDE
(`Code > Code Linter`) rather than from the command line. `code-linter.json5` is
committed so the IDE uses the project rule set.

### Signing

`build-profile.json5` currently carries a `signingConfigs` block that DevEco
Studio generated for this machine: the `material` paths point at
`C:\Users\<user>\.ohos\config\...` and the block contains `keyPassword` /
`storePassword` values. That is why both a signed and an unsigned HAP are
produced.

Consequences worth knowing before sharing this directory:

- the absolute paths only exist on the machine that generated them, so a fresh
  checkout must either run `File > Project Structure > Signing Configs` once or
  drop the `signingConfigs` block (and the `"signingConfig": "default"` reference)
  to build an unsigned HAP;
- the password fields and the referenced `.cer` / `.p7b` / `.p12` must not be
  committed. `harmony/.gitignore` excludes local signing material.

The build succeeds either way; only device installation needs a profile.

## Localization

`entry/src/main/resources/base` holds English and `zh_CN` holds Simplified
Chinese, matching the two resource sets the Android client ships. The tables are
generated from the Android sources rather than retyped:

```bash
node tools/convert-android-strings.mjs
```

The script reads `android/app/src/main/res/values*`, rewrites positional
placeholders into appearance-order sequential ones, asserts that both locales
agree on argument count and order, and re-reads what it wrote so a broken
resource file fails in the script instead of inside the ArkTS compiler.

## Resource reference check

`hvigor` does **not** fail a build for a `$r('app.string.missing_name')`
reference: the name compiles and only breaks at runtime. Since the port carries
764 strings across two locales and many screens, that is the most likely way a
typo escapes, so it is checked explicitly:

```bash
node tools/verify-resource-usage.mjs
```

This collects every `$r('app.<kind>.<name>')` in the ETS sources and confirms the
name is declared in `resources/base`, and that `zh_CN` declares it too for
strings and plurals. Run it after any screen work; a clean `assembleHap` alone is
not sufficient evidence that the copy will render.

## Configuration

`AppConfig` mirrors the Android client:

- The default service is `https://web.agents-anywhere.com`. A self-hosted
  address can be entered in the sign-in flow.
- The in-app update download address is a placeholder until a real HarmonyOS
  package is published; the update check itself still runs.

## Verification status

Every phase must leave `assembleHap` green, which means the ArkTS compiler and
its lint pass report zero errors, and must also pass the repository scripts:

```bash
node tools/verify-resource-usage.mjs   # every $r(...) reference exists in base and zh_CN
node tools/verify-encoding.mjs         # no BOM, no replacement character, no mojibake
node tools/verify-reachability.mjs     # every .ets file is reachable from pages/Index
```

Three more habits the port relies on:

- **Reachability.** hvigor only compiles what `pages/Index` can reach, so a file
  that has not been wired in yet is not type-checked. `verify-reachability.mjs`
  compares the source tree with `entry/build/default/intermediates/loader_out/`
  `default/ets/sourceMaps.map` and fails on an orphan; it found `AAWordmark.ets`,
  which the two screens were drawing inline instead of using.
- **Node harnesses.** Pure logic (tokenizer, scroll follow, path rules, the
  new-session state machine, attachment handling, file search, reply actions,
  command matching, draft codecs, terminal frames, version comparison) runs the
  real `.ets` sources through `%TEMP%\aa-tok\prepare-*.mjs` + `check-*.mjs`, about
  615 assertions in total.
- **Text files only through file tools or an explicit UTF-8 Node script.** A
  PowerShell `Get-Content`/`Set-Content` round trip decodes with the console code
  page and has twice destroyed files in this repository (see the plan's
  verification notes). After any bulk edit, scan for U+FFFD.

Runtime behaviour on a device is verified in DevEco Studio, since this repository
has no HarmonyOS device or emulator attached.

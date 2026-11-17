# Platform Files

Where each host picks SpecRune up, and where those files come from.

Platform adapters were removed from the CLI in P5. `specrune init` installs only
`.specrune/` and the shared `.agents/skills/`; everything below is installed by
the host's own npm plugin package (`npx specrune-<host> install`). The CLI no
longer owns a platform template table (`PlatformTemplates()` / `PlatformOfTemplate`
are deleted); `update` / `uninstall` / `ablate` only manage core assets.

## Pi Agent — global `~/.pi/agent/`

| Path | Role |
|------|------|
| `~/.pi/agent/agents/specrune-{implement,check,research}.md` | sub-agent definitions for native dispatch |
| `~/.pi/agent/prompts/specrune-{start,next,finish-work}.md` | slash-command prompts, mounted via settings |
| `~/.pi/agent/extensions/specrune/index.ts` | extension: session identity, hook wiring, sub-agent isolation |
| `~/.pi/agent/settings.json` | mixed-ownership file: the installer adds `extensions`, `prompts` and `enableSkillCommands`; other keys are the user's |

The installer merges `settings.json`; its uninstall scrubs only its keys.

## OpenCode v2 — global `~/.config/opencode/`

| Path | Role |
|------|------|
| `agents/specrune-{implement,check,research}.md` | sub-agents (`mode: subagent`; body is the system prompt) |
| `commands/specrune/{start,next,finish-work}.md` | slash commands → `/specrune/start` etc. |
| `plugins/specrune.ts` | plugin: session identity and hook wiring; auto-loaded by path |

Skills are deliberately not installed under `.opencode/skills/`: OpenCode v2
discovers the shared `.agents/skills/` layer. A same-ID skill there would shadow
skill updates silently.

## Claude Code — global `~/.claude/` (or project `.claude/` with `--scope project`)

The installer writes agents, commands, skills and merges the `hooks` / `env`
entries in `settings.json`, preserving user keys.

## Codex — project `.codex/` only

| Path | Role |
|------|------|
| `.codex/hooks.json` | project hooks for session start, each prompt, and SpecRune sub-agent start; install preserves user hooks |
| `.codex/agents/specrune-{implement,check,research}.toml` | native task sub-agents; model and permissions inherit |

Codex must trust project hooks with `/hooks`, and `specrune` must be on PATH.
The hook's `session_id` binds to the `codex_<id>` task pointer. Hooks never fall
back to environment identity; shell commands may use `CODEX_THREAD_ID` or
`--context-key`.

## DSH — machine-level `~/.dsh/`

The installer writes `~/.dsh/specrune/` (host bridge + agent definitions) and
the managed block in `~/.dsh/profiles/<profile>/cordis.patch.yml`. It does not
write project files.

## Shared — `.agents/`

| Path | Role |
|------|------|
| `.agents/skills/` | the only place the CLI installs `specrune-*` skills. Pi reads it directly; OpenCode v2 and Codex discover it. Never touch skills you did not install (check the manifest) |

## Manifest coupling

The CLI manifest (`.specrune/.template-hashes.json`) only records core assets:
`.specrune/` and `.agents/skills/`. Host plugin files are tracked by each
installer's own state (`specrune-install.json` or
`.specrune/.state/plugins/<host>.json`), never by the CLI.

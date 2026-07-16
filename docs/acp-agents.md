# ACP Multi-Agent Support

Agents Anywhere can drive local coding agents over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) using a single
generic connector adapter plus per-agent manifests.

## Architecture

- **Server / mobile / web** keep speaking Agents Anywhere RPCs
  (`session.*`, `turn.*`, timeline, approvals).
- **Connector** runs as the ACP *client*, spawning agent CLIs as stdio JSON-RPC
  subprocesses.
- **Native adapters** remain for Codex and Claude Code (deep history / SDK paths).
- **ACP adapters** cover Cursor, Grok Build, Gemini CLI, CodeBuddy, and future
  registry agents via `connector/acp/manifests/*.json`.

## Built-in agents (v1)

| Runtime id   | Display     | Launch                         | Auth hint                                      |
| ------------ | ----------- | ------------------------------ | ---------------------------------------------- |
| `gemini`     | Gemini CLI  | `gemini --acp`                 | Local `gemini` login                           |
| `grok_build` | Grok Build  | `grok agent stdio`             | `XAI_API_KEY` or `grok login`                  |
| `cursor`     | Cursor      | `agent acp`                    | `agent login` / `CURSOR_API_KEY`               |
| `codebuddy`  | CodeBuddy   | `codebuddy --acp` (spike)      | Local CodeBuddy login; flags may be refined    |

## Adding a new ACP agent

1. Add `connector/connector/acp/manifests/<id>.json`.
2. Optionally add fixtures under `connector/tests/acp/fixtures/agents/<id>/`.
3. Extend Web/Android “Add agent” option lists with the same runtime id.
4. Run contract tests (no real binary required):

```bash
cd connector
uv run pytest tests/acp tests/contract -q
```

5. Optional live smoke (requires installed + logged-in CLI):

```bash
AA_LIVE_AGENTS=gemini uv run pytest -m live_agent -q
```

## Capability degradation

ACP agents advertise capabilities at `initialize`. v1 behavior:

| Capability              | If missing                                      |
| ----------------------- | ----------------------------------------------- |
| `session/list` + load   | History sync returns empty (new sessions only)  |
| `session/request_permission` | No approval UI path for that agent         |
| Auth methods            | Discovery may be OK; first turn fails with hint |

## Contract tests

- **L1/L2**: reducer goldens + manifest load (`tests/acp/test_acp_reducer_golden.py`)
- **L3**: Fake ACP agent process (`tests/acp/fake_agent` + `test_acp_adapter_fake.py`)
- **Helpers**: `tests/contract/helpers.py` (timeline/approval shape asserts)

Default CI should run `pytest -m "not live_agent"`.

## Operational notes

- **cwd is required** for `session.create` / turns. The ACP process is spawned
  without a session-specific process cwd; workspace roots are passed per
  `session/new` (and load/resume).
- **Process restart**: changing the selected binary via scan/rewire closes the
  previous agent subprocess on the next use (no zombie processes).
- **Permissions**: `session/request_permission` is handled on a background task
  so streaming for other sessions is not blocked while the user decides.
- **Turn timeout**: default 1 hour (`manifest.quirks.maxTurnSeconds` to override;
  set `null` for no limit).
- **Version probe**: if `--version` fails but the binary exists, discovery still
  marks execution `ok` and sets `versionUnverified` / `warnings`.

## Known limitations (v1)

- History import is best-effort only when the agent supports list/load.
- Cursor extension methods (`cursor/ask_question`, plans, todos) are auto-handled
  with skip/accept policies and may not surface full UX.
- CodeBuddy launch flags should be confirmed against the installed CLI version.
- Filesystem/terminal ACP client methods are mostly disabled; agents use their
  own local tools.
- Docker/image changes are intentionally out of scope for the ACP PR surface.

# ACP recording replay

Recordings of real Agent ACP interactions, replayed without installing the Agent to check dialects and event translation (`test/runtime/recording-replay.test.ts`).
The format is the same as v2 `connector/tests/fixtures/acp-recordings`: one `{direction, message}` per line; `outgoing` is AA to Agent, `incoming` is Agent to AA.

| File | Agent | Scenario | Source |
| --- | --- | --- | --- |
| `hermes-allow.jsonl` | Hermes (`git.42456cf`) | Allows one write approval; the Agent writes the file and replies | Copied from v2 |
| `pi-new-prompt.jsonl` | Pi 1.4.0 + `@openma/pi-acp` 0.1.8 (with AA patches, local mode) | New session, one short prompt, close | Recorded by `test/live/pi.live.test.ts`; local paths replaced with `/home/user` and `/workspace`, guard path is `__AA_PI_GUARD__` |

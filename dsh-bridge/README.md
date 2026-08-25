# Agents Anywhere DSH Bridge

`@agents-anywhere/dsh-bridge` is a headless Cordis plugin that exposes a running
DeepSeek Harness Host to one local Agents Anywhere Connector. It projects the
Host's native sessions, timeline, catalogs, selections, commands, approvals,
steering, interruption, and shutdown behavior through the shared DSH Bridge 1.0
JSON-RPC contract. It does not require a browser or other GUI service.

DSH Session persistence remains the conversation-history source of truth. The
Bridge stores only endpoint discovery data, instance-independent session
bindings, catalog revisions, and idempotency records under its private state
root.

## Supported Host

The supported peer set is intentionally narrow because the Host APIs are still
release candidates.

| Component | Verified version |
| --- | --- |
| `@deepseek-ai/dsh` | `0.1.1-rc.2` |
| DSH Host service packages | `0.1.1-rc.2` exactly |
| `@deepseek-ai/cordis` | `4.0.1` exactly |
| Node.js | `^22.19.0 || >=24` |
| DSH Bridge contract | `1.0` |

The package was verified against the official `dsh-v0.1.1-rc.2` source and is
not declared compatible with earlier or later DSH prereleases.

## Runtime Identity

The Bridge wire always uses the provider identity `dsh`. In particular,
`initialize.params.runtime`, response identity fields, capabilities, catalogs,
and notifications use `dsh`; they never carry a configured instance name.

Agents Anywhere `runtimeId` instance binding belongs to the Connector. A
Connector may bind one discovered DSH endpoint to a named runtime instance, but
that instance identity is outside the Bridge wire and must not replace `dsh` in
protocol payloads.

## Installation

Install the package into the DSH profile that should expose the Bridge. A Web
profile is suitable for a long-running Host:

```bash
dsh plugin --profile web add @agents-anywhere/dsh-bridge@0.1.0
dsh --profile web --dump-config
dsh web
```

The same bundle can compose into the headless profile without GUI services:

```bash
dsh plugin --profile headless add @agents-anywhere/dsh-bridge@0.1.0
dsh --profile headless --dump-config
```

The packaged `dsh.bundle.patch` metadata points to `cordis.patch.yml`. By
default the plugin writes Connector discovery data to:

```text
$DSH_HOME/agents-anywhere/bridge/endpoint.json
```

`dshHome` and `stateRoot` must be absolute paths. `stateRoot` must resolve to a
private, non-symlink descendant of the canonical `DSH_HOME`. The endpoint file
advertises the loopback port, bearer token, process ID, and the fixed frame
limit; Connector configuration should not duplicate those values.

## Wire And Threat Boundary

- The server binds only `127.0.0.1` and uses newline-delimited JSON-RPC.
- The maximum frame payload is fixed at 8 MiB. It is advertised by discovery
  and initialization, but neither side may negotiate a larger value.
- Authentication has a bounded deadline. The first failed authentication ends
  that connection, and token digests are compared with `timingSafeEqual`.
- Exactly one authenticated Connector owns the endpoint. Pending or failed
  unauthenticated connections cannot claim or displace that owner.
- One process lock is held per canonical `DSH_HOME`, independent of the chosen
  state subdirectory, and is released only by its recorded owner.
- On POSIX systems the state root is mode `0700` and sensitive files are mode
  `0600`; owner, symlink, and permission checks fail closed. On Windows, the
  deployment must protect `DSH_HOME` with same-user ACLs.

The trust boundary is one machine and one operating-system user. A compromised
same-user process, a malicious in-process DSH plugin, or remote exposure through
an external proxy is out of scope. Session storage reports
`crossProcessWriterExclusion: false`: the Bridge serializes its own writes and
detects revisions, but it does not turn DSH persistence into distributed
consensus.

## Protocol Coverage

The implementation supports initialization and shutdown; runtime config and
capabilities; model and permission catalogs; session discovery, snapshots,
state, notices, and capabilities; create/start/steer/interrupt; model and
permission selection; commands; approval responses; request cancellation; and
the notifications declared by the shared 1.0 schemas.

Tests load the schemas and identity fixture directly from
`contracts/dsh-bridge/1.0`; this package has no private protocol schema or
fixture copy.

Known limits:

- Attachments are rejected because Bridge contract 1.0 does not support them.
- `userQuestions` is false. DSH `0.1.1-rc.2` exposes one question provider and
  no observer/multiplex API, so mirroring questions would steal ownership from
  another Host client.
- A Bridge-owned Agent supports model-selection updates. The Bridge rejects a
  model change for an already-live Agent owned by another Host consumer instead
  of stacking a competing model-selection provider.
- Malformed JSON without a valid request ID closes the connection. The shared
  response schema declares parse error `-32700` but does not admit the canonical
  JSON-RPC `id: null` response.

## Development And Publishing

The package owns a Yarn 4.6.0 lockfile and is built from TypeScript source:

```bash
cd dsh-bridge
corepack enable
yarn install --immutable
yarn verify
npm pack --dry-run
```

`yarn verify` runs type checking, lint, tests, and `yarn pack:check`. The pack
check removes prior output, builds through the package lifecycle, audits the
tarball allowlist, installs that tarball into a temporary Yarn 4.6.0 consumer,
imports the installed package, and composes it with the official DSH
`--dump-config` path.

`lib/` is generated for packing and publishing and must not be committed.
Releases use tags in the form `dsh-bridge-v<package-version>`; the dedicated
workflow performs an immutable install and repeats verification before npm
publication with provenance.

## Attribution

This package preserves the origin and authorship of
[`xipian1216/dsh-aa-bridge`](https://github.com/xipian1216/dsh-aa-bridge),
authored by **xipian1216**. That implementation entered Agents Anywhere in
commit
[`16395489be15b3a9e87ba9a5394629b2ab57a942`](https://github.com/anywhere-labs/Agents-Anywhere/commit/16395489be15b3a9e87ba9a5394629b2ab57a942),
with subsequent integration and ownership documentation in `cac7e76` and
`53a136c`.

The current implementation is a source rewrite against the shared 1.0 contract
and the verified DSH Host API. It does not publish the imported generated
`lib/`, source maps, or private protocol fixtures.

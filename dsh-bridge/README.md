# @agents-anywhere/dsh-bridge

Host-only DeepSeek Harness plugin used by the Agents Anywhere Connector. It
exposes DSH sessions over newline-delimited JSON-RPC 2.0 on stdin/stdout. The
package has no client bundle and never writes logs to stdout.

Install it into the `aa` DSH profile, then launch the profile through the
Connector with `dsh --profile aa`. The plugin requires DSH `0.1.0-rc.5` service
contracts and persists only AA bindings/idempotency metadata under
`$DSH_HOME/aa/bridge`; DSH remains the source of truth for session history.

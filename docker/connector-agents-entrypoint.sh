#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[connector-agents-image] %s\n' "$*"
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    log "missing required environment variable: $name"
    exit 2
  fi
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

setup_ssh() {
  local port="${SSH_PORT:-2222}"
  mkdir -p /run/sshd /home/agent/.ssh
  chown -R agent:agent /home/agent/.ssh
  chmod 700 /home/agent/.ssh

  if [ -n "${SSH_AUTHORIZED_KEYS:-}" ]; then
    printf '%s\n' "$SSH_AUTHORIZED_KEYS" > /home/agent/.ssh/authorized_keys
    chown agent:agent /home/agent/.ssh/authorized_keys
    chmod 600 /home/agent/.ssh/authorized_keys
  fi

  if [ -n "${SSH_PASSWORD:-}" ]; then
    printf 'agent:%s\n' "$SSH_PASSWORD" | chpasswd
  fi

  if [ ! -s /etc/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -A >/dev/null
  fi

  {
    printf 'Port %s\n' "$port"
    printf 'ListenAddress 0.0.0.0\n'
    printf 'PermitRootLogin no\n'
    printf 'AllowUsers agent\n'
    printf 'PasswordAuthentication %s\n' "$([ -n "${SSH_PASSWORD:-}" ] && printf yes || printf no)"
    printf 'PubkeyAuthentication yes\n'
    printf 'AuthorizedKeysFile .ssh/authorized_keys\n'
    printf 'UsePAM yes\n'
    printf 'X11Forwarding no\n'
    printf 'AllowTcpForwarding yes\n'
  } > /etc/ssh/sshd_config.d/99-agents-anywhere.conf

  /usr/sbin/sshd -D -e &
  log "sshd listening on 0.0.0.0:${port} as user agent"
}

configure_npm() {
  if [ -n "${NPM_CONFIG_REGISTRY:-}" ]; then
    npm config set registry "${NPM_CONFIG_REGISTRY}" >/dev/null
  fi
}

npm_install_global() {
  local package_name="$1"
  configure_npm
  npm install -g --no-audit --no-fund "$package_name"
}

link_runtime_binary() {
  local command_name="$1"
  local target_path="$2"
  local actual_path
  actual_path="$(command -v "$command_name")"
  if [ "$actual_path" = "$target_path" ]; then
    return
  fi
  mkdir -p "$(dirname "$target_path")"
  ln -sf "$actual_path" "$target_path"
}

install_codex_if_requested() {
  if ! is_truthy "${INSTALL_CODEX:-}"; then
    return
  fi
  local package_name="${CODEX_NPM_PACKAGE:-@openai/codex}"
  if [ -n "${CODEX_VERSION:-}" ]; then
    package_name="${package_name}@${CODEX_VERSION}"
  fi
  log "installing Codex CLI package ${package_name}"
  npm_install_global "$package_name"
  if ! command -v codex >/dev/null 2>&1; then
    log "Codex install completed but codex is not on PATH"
    exit 2
  fi
  link_runtime_binary codex "${CODEX_BIN:-/usr/local/bin/codex}"
}

install_claude_if_requested() {
  if ! is_truthy "${INSTALL_CLAUDE:-}"; then
    return
  fi
  local package_name="${CLAUDE_NPM_PACKAGE:-@anthropic-ai/claude-code}"
  if [ -n "${CLAUDE_VERSION:-}" ]; then
    package_name="${package_name}@${CLAUDE_VERSION}"
  fi
  log "installing Claude Code package ${package_name}"
  npm_install_global "$package_name"
  if ! command -v claude >/dev/null 2>&1; then
    log "Claude Code install completed but claude is not on PATH"
    exit 2
  fi
  link_runtime_binary claude "${CLAUDE_BIN:-/usr/local/bin/claude}"
}

connector_args() {
  local mode="${AGENT_CONNECTOR_MODE:-auto}"
  require_env AGENT_SERVER_URL

  case "$mode" in
    auto)
      if [ -n "${AGENT_CONNECTOR_ID:-}" ] && [ -n "${AGENT_CONNECTOR_TOKEN:-}" ]; then
        printf '%s\n' start
      else
        printf '%s\n' pair
      fi
      ;;
    token|start)
      require_env AGENT_CONNECTOR_ID
      require_env AGENT_CONNECTOR_TOKEN
      printf '%s\n' start
      ;;
    pair|pairing|login)
      printf '%s\n' pair
      ;;
    *)
      log "invalid AGENT_CONNECTOR_MODE=$mode; expected auto, token, or pair"
      exit 2
      ;;
  esac
}

mkdir -p /data /workspace "${AGENT_CONNECTOR_ATTACHMENTS_ROOT:-/data/attachments}"
chown -R agent:agent /data /workspace "${AGENT_CONNECTOR_ATTACHMENTS_ROOT:-/data/attachments}"

setup_ssh
install_codex_if_requested
install_claude_if_requested

cd "${AGENT_CONNECTOR_WORKDIR:-/workspace}"

cmd="$(connector_args)"
if [ "$cmd" = "start" ]; then
  log "starting connector with token credentials"
  exec sudo -E -H -u agent /opt/anywhere-cli-venv/bin/anywhere-cli start
fi

log "starting connector pairing flow"
exec sudo -E -H -u agent /opt/anywhere-cli-venv/bin/anywhere-cli pair \
  "${AGENT_SERVER_URL}" \
  ${AGENT_CONNECTOR_PAIR_NO_START:+--no-start}

#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[connector-image] %s\n' "$*"
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    log "missing required environment variable: $name"
    exit 2
  fi
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

connector_args() {
  local mode="${AGENT_CONNECTOR_MODE:-auto}"
  require_env AGENT_SERVER_URL

  case "$mode" in
    auto)
      if [ -n "${AGENT_CONNECTOR_ID:-}" ] && [ -n "${AGENT_CONNECTOR_TOKEN:-}" ]; then
        printf '%s\n' start
      else
        printf '%s\n' login
      fi
      ;;
    token|start)
      require_env AGENT_CONNECTOR_ID
      require_env AGENT_CONNECTOR_TOKEN
      printf '%s\n' start
      ;;
    pair|pairing|login)
      printf '%s\n' login
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

cd "${AGENT_CONNECTOR_WORKDIR:-/workspace}"

cmd="$(connector_args)"
if [ "$cmd" = "start" ]; then
  log "starting connector with token credentials"
  exec sudo -E -H -u agent /opt/agent-connector-venv/bin/agent-connector start
fi

log "starting connector pairing flow"
exec sudo -E -H -u agent /opt/agent-connector-venv/bin/agent-connector login \
  --server-url "${AGENT_SERVER_URL}" \
  ${AGENT_CONNECTOR_PAIR_NO_START:+--no-start}

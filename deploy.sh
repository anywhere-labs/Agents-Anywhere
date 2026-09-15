#!/usr/bin/env bash
#
# Agents Anywhere · 生产部署脚本
#
# 构建 server 镜像（内含静态导出的 web-next），再用单端口 compose 起全栈。
#
#   ./deploy.sh              构建镜像并启动 / 更新整个栈
#   ./deploy.sh --status     查看容器与健康状态
#   ./deploy.sh --logs       跟随 server-next 日志
#   ./deploy.sh --down       停止并移除容器（保留数据卷）
#
# 首次部署前：cp docker/.env.example docker/.env 并填好必填变量。

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker/docker-compose.prod.yml"
DOCKERFILE_REL="docker/Dockerfile"
ENV_FILE="${AGENTS_ANYWHERE_DEPLOY_ENV_FILE:-${ROOT_DIR}/docker/.env}"
ENV_FILE_EXAMPLE="${ROOT_DIR}/docker/.env.example"

BUILD_IMAGE=true
BUILD_NO_CACHE=false
PULL_BASE=false
WAIT_HEALTH=true
HEALTH_TIMEOUT="${AGENTS_ANYWHERE_HEALTH_TIMEOUT:-300}"
ACTION="up"

APT_MIRROR="${AGENTS_ANYWHERE_APT_MIRROR:-}"
PIP_INDEX_URL="${AGENTS_ANYWHERE_PIP_INDEX_URL:-}"
YARN_REGISTRY="${AGENTS_ANYWHERE_YARN_REGISTRY:-}"

usage() {
  cat <<'EOF'
Deploy the Agents Anywhere production stack.

Usage:
  ./deploy.sh [options]

Options:
  --no-build        跳过镜像构建，直接用现有镜像启动
  --build-only      只构建镜像，不启动
  --no-cache        构建时不使用缓存
  --pull            启动前拉取最新的基础镜像
  --mirror          使用国内镜像源构建（USTC apt/pypi + npmmirror）
  --env-file PATH   使用指定的环境变量文件（默认 docker/.env）
  --no-wait         启动后不等待健康检查
  --status          显示容器和健康状态后退出
  --logs            跟随 server-next 日志（Ctrl-C 退出，不影响服务）
  --down            停止并移除容器，保留数据卷
  -h, --help        显示帮助

Environment:
  AGENTS_ANYWHERE_DEPLOY_ENV_FILE   环境变量文件路径
  AGENTS_ANYWHERE_SERVER_IMAGE      镜像 tag（默认 agents-anywhere-server:postgres）
  AGENTS_ANYWHERE_APT_MIRROR        Debian apt 镜像源
  AGENTS_ANYWHERE_PIP_INDEX_URL     PyPI 镜像源
  AGENTS_ANYWHERE_YARN_REGISTRY     npm registry 镜像源
  AGENTS_ANYWHERE_HEALTH_TIMEOUT    健康检查等待秒数（默认 300）
EOF
}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) BUILD_IMAGE=false; shift ;;
    --build-only) ACTION="build"; shift ;;
    --no-cache) BUILD_NO_CACHE=true; shift ;;
    --pull) PULL_BASE=true; shift ;;
    --mirror)
      APT_MIRROR="${APT_MIRROR:-https://mirrors.ustc.edu.cn/debian}"
      PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.ustc.edu.cn/pypi/simple}"
      YARN_REGISTRY="${YARN_REGISTRY:-https://registry.npmmirror.com}"
      shift
      ;;
    --env-file)
      [[ $# -ge 2 ]] || fail "--env-file requires a path"
      ENV_FILE="$2"
      shift 2
      ;;
    --no-wait) WAIT_HEALTH=false; shift ;;
    --status) ACTION="status"; shift ;;
    --logs) ACTION="logs"; shift ;;
    --down) ACTION="down"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
done

# ── 前置检查 ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "docker 未安装或不在 PATH 中"
[[ -f "$COMPOSE_FILE" ]] || fail "找不到 ${COMPOSE_FILE}"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail "docker compose 不可用（需要 Compose v2 或 docker-compose）"
fi

compose() { "${COMPOSE[@]}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

read_env_value() {
  local key="$1" line value
  [[ -f "$ENV_FILE" ]] || return 1
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$ENV_FILE_EXAMPLE" ]]; then
      cp "$ENV_FILE_EXAMPLE" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      fail "已生成 ${ENV_FILE}，请填好 POSTGRES_PASSWORD / AGENT_SERVER_SECRET / AGENT_SERVER_PUBLIC_ORIGIN 后重新运行"
    fi
    fail "缺少环境变量文件 ${ENV_FILE}"
  fi
  local missing=()
  [[ -n "$(read_env_value POSTGRES_PASSWORD || true)" ]] || missing+=("POSTGRES_PASSWORD")
  [[ -n "$(read_env_value AGENT_SERVER_SECRET || true)" ]] || missing+=("AGENT_SERVER_SECRET")
  [[ -n "$(read_env_value AGENT_SERVER_PUBLIC_ORIGIN || true)" ]] || missing+=("AGENT_SERVER_PUBLIC_ORIGIN")
  if [[ ${#missing[@]} -gt 0 ]]; then
    fail "${ENV_FILE} 中这些必填变量为空: ${missing[*]}"
  fi
}

IMAGE_TAG="$(read_env_value AGENTS_ANYWHERE_SERVER_IMAGE || true)"
IMAGE_TAG="${IMAGE_TAG:-${AGENTS_ANYWHERE_SERVER_IMAGE:-agents-anywhere-server:postgres}}"
export AGENTS_ANYWHERE_SERVER_IMAGE="$IMAGE_TAG"

BIND_IP="$(read_env_value AGENTS_ANYWHERE_BIND_IP || true)"
BIND_IP="${BIND_IP:-127.0.0.1}"
WEB_PORT="$(read_env_value AGENTS_ANYWHERE_WEB_PORT || true)"
WEB_PORT="${WEB_PORT:-5174}"
PUBLIC_ORIGIN="$(read_env_value AGENT_SERVER_PUBLIC_ORIGIN || true)"

[[ "$BIND_IP" == "0.0.0.0" || "$BIND_IP" == "::" ]] && HEALTH_HOST="127.0.0.1" || HEALTH_HOST="$BIND_IP"
HEALTH_URL="http://${HEALTH_HOST}:${WEB_PORT}/api/v2/health/ready"

# ── 各动作 ──────────────────────────────────────────────────────────────
do_build() {
  log "构建镜像 ${IMAGE_TAG}（含 web-next 静态导出）"
  local args=(-f "${ROOT_DIR}/${DOCKERFILE_REL}" --target server -t "$IMAGE_TAG")
  [[ "$BUILD_NO_CACHE" == true ]] && args+=(--no-cache)
  [[ "$PULL_BASE" == true ]] && args+=(--pull)
  [[ -n "$APT_MIRROR" ]] && args+=(--build-arg "APT_MIRROR=${APT_MIRROR}")
  [[ -n "$PIP_INDEX_URL" ]] && args+=(--build-arg "PIP_INDEX_URL=${PIP_INDEX_URL}")
  [[ -n "$YARN_REGISTRY" ]] && args+=(--build-arg "YARN_REGISTRY=${YARN_REGISTRY}")
  docker build "${args[@]}" "$ROOT_DIR"
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  if ! command -v curl >/dev/null 2>&1; then
    warn "未安装 curl，跳过健康检查；用 ./deploy.sh --status 查看容器状态"
    return 1
  fi
  log "等待健康检查 ${HEALTH_URL}（最多 ${HEALTH_TIMEOUT}s）"
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      log "服务已就绪"
      return 0
    fi
    if [[ -z "$(compose ps -q server-next 2>/dev/null)" ]]; then
      warn "server-next 容器不存在，请检查 compose 启动日志"
      return 1
    fi
    sleep 3
  done
  warn "等待超时，查看日志： ./deploy.sh --logs"
  return 1
}

print_summary() {
  local url="${PUBLIC_ORIGIN:-http://127.0.0.1:${WEB_PORT}}"
  cat <<EOF

服务地址:   ${url}
监听地址:   ${BIND_IP}:${WEB_PORT} → 容器 8000（唯一对外端口）
环境文件:   ${ENV_FILE}
镜像:       ${IMAGE_TAG}

首次部署：在 server-next 日志里找 setup token，用它创建第一个管理员账号
  ./deploy.sh --logs | grep -A3 setup-token

常用命令：
  ./deploy.sh --status      查看状态
  ./deploy.sh --logs        跟随日志
  ./deploy.sh --down        停止（保留数据卷）
EOF
}

case "$ACTION" in
  build)
    ensure_env_file
    do_build
    log "镜像构建完成：${IMAGE_TAG}"
    ;;
  status)
    ensure_env_file
    compose ps
    printf '\n'
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      curl -fsS --max-time 5 "$HEALTH_URL"; printf '\n'
    else
      warn "健康检查未通过：${HEALTH_URL}"
    fi
    ;;
  logs)
    ensure_env_file
    compose logs -f --tail=200 server-next
    ;;
  down)
    ensure_env_file
    log "停止并移除容器（数据卷保留）"
    compose down
    ;;
  up)
    ensure_env_file
    if [[ "$BUILD_IMAGE" == true ]]; then
      do_build
    else
      docker image inspect "$IMAGE_TAG" >/dev/null 2>&1 \
        || fail "本地没有镜像 ${IMAGE_TAG}，去掉 --no-build 先构建"
    fi
    log "启动服务栈（migrate-next 会先跑数据库迁移）"
    compose up -d
    compose ps
    if [[ "$WAIT_HEALTH" == true ]]; then
      wait_for_health || true
    fi
    print_summary
    ;;
esac

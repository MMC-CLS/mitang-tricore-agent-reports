#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# TriCore Agent v1.0 - Canary Deployment Script
#
# Deploys a new version to a subset of instances (canary), monitors
# health and error rates, and either promotes or auto-rolls back.
#
# Supports Docker Compose and Kubernetes deployment modes.
#
# Usage:
#   ./scripts/canary-deploy.sh --image mitang-tricore-agent:2.0.0
#   ./scripts/canary-deploy.sh --image mitang-tricore-agent:2.0.0 --mode k8s
#   ./scripts/canary-deploy.sh --image mitang-tricore-agent:2.0.0 --canary-percent 25
#   ./scripts/canary-deploy.sh --image mitang-tricore-agent:2.0.0 --rollback
#
# Traffic Shifting Stages:
#   10% → 25% → 50% → 100%  (with health checks between each)
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Constants ──
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.yml"
readonly DEPLOY_DIR="${PROJECT_ROOT}/deploy"
readonly K8S_DIR="${DEPLOY_DIR}/k8s"
readonly LOG_DIR="${PROJECT_ROOT}/deploy/logs"
readonly TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
readonly LOG_FILE="${LOG_DIR}/canary-deploy-${TIMESTAMP}.log"

# Ensure log directory exists from the start
mkdir -p "${LOG_DIR}"

# Traffic shifting stages (percentages)
readonly -a TRAFFIC_STAGES=(10 25 50 100)

# ── Default Options ──
IMAGE=""
MODE="compose"              # compose | k8s
CANARY_PERCENT=""            # Override auto-shifting; deploy at this % directly
STABLE_IMAGE=""              # Current stable image (auto-detected if empty)
ERROR_THRESHOLD=5.0         # Max error rate % before auto-rollback
LATENCY_THRESHOLD_MS=5000    # Max p95 latency ms before auto-rollback
HEALTH_TIMEOUT=30            # Seconds to wait for health check
OBSERVATION_SECONDS=60       # Seconds to observe at each traffic stage
ROLLBACK=false               # If true, rollback to stable immediately
NAMESPACE="default"          # K8s namespace
DEPLOYMENT_NAME="tricore"    # K8s deployment name
SERVICE_NAME="tricore-svc"   # K8s service name
REPLICAS=3                   # Number of replicas for compose mode
DRY_RUN=false                # If true, only print what would happen
COMPOSE_PROJECT="mitang"     # Docker Compose project name

# ── State ──
CANARY_INSTANCE_ID=""
STABLE_INSTANCE_IDS=()
CURRENT_TRAFFIC_PERCENT=0
DEPLOYMENT_PHASE="init"

# ── Colors ──
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly BOLD='\033[1m'
readonly NC='\033[0m'

# ═══════════════════════════════════════════════════════════════
# Logging
# ═══════════════════════════════════════════════════════════════

log() {
  local level="${1}"
  shift
  local message="${*}"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"

  local log_line="[${ts}] [${level}] ${message}"
  echo "${log_line}" >> "${LOG_FILE}" 2>/dev/null || true

  case "${level}" in
    INFO)   echo -e "${CYAN}[INFO]${NC}  ${ts}  ${message}" ;;
    OK)     echo -e "${GREEN}[OK]${NC}    ${ts}  ${message}" ;;
    WARN)   echo -e "${YELLOW}[WARN]${NC}  ${ts}  ${message}" ;;
    ERROR)  echo -e "${RED}[ERROR]${NC} ${ts}  ${message}" ;;
    PHASE)  echo -e "${BOLD}[PHASE]${NC} ${ts}  ${message}" ;;
    *)      echo -e "${BLUE}[${level}]${NC}  ${ts}  ${message}" ;;
  esac
}

log_banner() {
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  ${*}${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] BANNER: ${*}" >> "${LOG_FILE}" 2>/dev/null || true
}

# ═══════════════════════════════════════════════════════════════
# Argument Parsing
# ═══════════════════════════════════════════════════════════════

usage() {
  cat <<EOF
Usage: $(basename "${0}") [OPTIONS]

TriCore Agent Canary Deployment Script

Required:
  -i, --image <tag>           New image tag to deploy (e.g., mitang-tricore-agent:2.0.0)

Options:
  -m, --mode <mode>           Deployment mode: compose (default) or k8s
  -p, --canary-percent <N>   Deploy directly at N% traffic (skip gradual shifting)
      --stable-image <tag>   Current stable image tag (auto-detected if omitted)
      --error-threshold <N> Max error rate % for rollback (default: ${ERROR_THRESHOLD})
      --latency-threshold <N> Max p95 latency ms for rollback (default: ${LATENCY_THRESHOLD_MS})
      --observation <secs>   Seconds to observe at each stage (default: ${OBSERVATION_SECONDS})
      --health-timeout <secs> Health check timeout (default: ${HEALTH_TIMEOUT})
      --namespace <ns>       K8s namespace (default: ${NAMESPACE})
      --deployment <name>    K8s deployment name (default: ${DEPLOYMENT_NAME})
      --service <name>       K8s service name (default: ${SERVICE_NAME})
      --replicas <N>         Number of replicas for compose mode (default: ${REPLICAS})
      --project <name>      Docker Compose project name (default: ${COMPOSE_PROJECT})
      --rollback             Rollback to stable image immediately
      --dry-run              Print actions without executing
  -h, --help                 Show this help message

Traffic Shifting Stages:
  By default, traffic shifts gradually: ${TRAFFIC_STAGES[*]}%
  Use --canary-percent to jump directly to a specific percentage.

Examples:
  # Gradual canary deployment (Docker Compose)
  $(basename "${0}") --image mitang-tricore-agent:2.0.0

  # Deploy directly at 25% traffic
  $(basename "${0}") --image mitang-tricore-agent:2.0.0 --canary-percent 25

  # Kubernetes canary deployment
  $(basename "${0}") --image mitang-tricore-agent:2.0.0 --mode k8s

  # Emergency rollback
  $(basename "${0}") --image mitang-tricore-agent:2.0.0 --rollback
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "${1}" in
      -i|--image)
        IMAGE="${2:?--image requires a value}"
        shift 2
        ;;
      -m|--mode)
        MODE="${2:?--mode requires a value}"
        if [[ "${MODE}" != "compose" && "${MODE}" != "k8s" ]]; then
          log ERROR "Invalid mode: ${MODE}. Must be 'compose' or 'k8s'"
          exit 1
        fi
        shift 2
        ;;
      -p|--canary-percent)
        CANARY_PERCENT="${2:?--canary-percent requires a value}"
        if ! [[ "${CANARY_PERCENT}" =~ ^[0-9]+$ ]] || [[ "${CANARY_PERCENT}" -lt 1 || "${CANARY_PERCENT}" -gt 100 ]]; then
          log ERROR "Canary percent must be 1-100, got: ${CANARY_PERCENT}"
          exit 1
        fi
        shift 2
        ;;
      --stable-image)
        STABLE_IMAGE="${2:?--stable-image requires a value}"
        shift 2
        ;;
      --error-threshold)
        ERROR_THRESHOLD="${2:?--error-threshold requires a value}"
        shift 2
        ;;
      --latency-threshold)
        LATENCY_THRESHOLD_MS="${2:?--latency-threshold requires a value}"
        shift 2
        ;;
      --observation)
        OBSERVATION_SECONDS="${2:?--observation requires a value}"
        shift 2
        ;;
      --health-timeout)
        HEALTH_TIMEOUT="${2:?--health-timeout requires a value}"
        shift 2
        ;;
      --namespace)
        NAMESPACE="${2:?--namespace requires a value}"
        shift 2
        ;;
      --deployment)
        DEPLOYMENT_NAME="${2:?--deployment requires a value}"
        shift 2
        ;;
      --service)
        SERVICE_NAME="${2:?--service requires a value}"
        shift 2
        ;;
      --replicas)
        REPLICAS="${2:?--replicas requires a value}"
        shift 2
        ;;
      --project)
        COMPOSE_PROJECT="${2:?--project requires a value}"
        shift 2
        ;;
      --rollback)
        ROLLBACK=true
        shift
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        log ERROR "Unknown option: ${1}"
        usage
        exit 1
        ;;
    esac
  done

  if [[ -z "${IMAGE}" ]]; then
    log ERROR "--image is required"
    usage
    exit 1
  fi
}

# ═══════════════════════════════════════════════════════════════
# Prerequisites & Setup
# ═══════════════════════════════════════════════════════════════

check_prerequisites() {
  log INFO "Checking prerequisites for ${MODE} mode..."

  if [[ "${MODE}" == "compose" ]]; then
    if ! command -v docker &>/dev/null; then
      log ERROR "docker is not installed"
      exit 1
    fi
    if ! docker info &>/dev/null 2>&1; then
      log ERROR "Docker daemon is not running"
      exit 1
    fi
    if ! command -v docker-compose &>/dev/null && ! docker compose version &>/dev/null 2>&1; then
      log ERROR "docker-compose or docker compose plugin is not available"
      exit 1
    fi
    log OK "Docker and Docker Compose available"

  elif [[ "${MODE}" == "k8s" ]]; then
    if ! command -v kubectl &>/dev/null; then
      log ERROR "kubectl is not installed"
      exit 1
    fi
    if ! kubectl cluster-info &>/dev/null 2>&1; then
      log ERROR "Kubernetes cluster is not accessible"
      exit 1
    fi
    log OK "kubectl and Kubernetes cluster available"
  fi

  # Ensure log directory exists
  mkdir -p "${LOG_DIR}"
}

detect_stable_image() {
  if [[ -n "${STABLE_IMAGE}" ]]; then
    log OK "Stable image specified: ${STABLE_IMAGE}"
    return
  fi

  if [[ "${MODE}" == "compose" ]]; then
    # Read current image from docker-compose.yml
    if [[ -f "${COMPOSE_FILE}" ]]; then
      STABLE_IMAGE="$(grep -E '^\s+image:' "${COMPOSE_FILE}" | head -1 | awk '{print $2}' | tr -d '"')"
      if [[ -z "${STABLE_IMAGE}" ]]; then
        STABLE_IMAGE="mitang-tricore-agent:1.0.0"
      fi
    else
      STABLE_IMAGE="mitang-tricore-agent:1.0.0"
    fi
  elif [[ "${MODE}" == "k8s" ]]; then
    STABLE_IMAGE="$(kubectl get deployment "${DEPLOYMENT_NAME}" \
      -n "${NAMESPACE}" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")"
    if [[ -z "${STABLE_IMAGE}" ]]; then
      STABLE_IMAGE="mitang-tricore-agent:1.0.0"
      log WARN "Could not detect stable image from K8s, using: ${STABLE_IMAGE}"
    fi
  fi

  log OK "Detected stable image: ${STABLE_IMAGE}"
}

# ═══════════════════════════════════════════════════════════════
# Docker Compose Helper Functions
# ═══════════════════════════════════════════════════════════════

# Wrapper for docker-compose (supports both v1 and v2)
dc() {
  if docker compose version &>/dev/null 2>&1; then
    docker compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" "$@"
  else
    docker-compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" "$@"
  fi
}

# ═══════════════════════════════════════════════════════════════
# Health Check Functions
# ═══════════════════════════════════════════════════════════════

# Check health of a single instance via HTTP
# Args: host port [timeout_seconds]
# Returns: 0 if healthy, 1 if unhealthy
check_health_http() {
  local host="${1:-127.0.0.1}"
  local port="${2:-3722}"
  local timeout="${3:-${HEALTH_TIMEOUT}}"

  local url="http://${host}:${port}/health"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Health check: curl -sf --max-time ${timeout} ${url}"
    return 0
  fi

  local http_code
  http_code="$(curl -sf -o /dev/null -w '%{http_code}' --max-time "${timeout}" "${url}" 2>/dev/null)" || true

  if [[ "${http_code}" == "200" ]]; then
    return 0
  else
    return 1
  fi
}

# Check health of a Docker container
# Args: container_name [timeout_seconds]
# Returns: 0 if healthy, 1 if unhealthy
check_health_docker() {
  local container_name="${1}"
  local timeout="${2:-${HEALTH_TIMEOUT}}"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Docker health check for: ${container_name}"
    return 0
  fi

  local health_status
  health_status="$(docker inspect --format='{{.State.Health.Status}}' "${container_name}" 2>/dev/null || echo "unknown")"

  if [[ "${health_status}" == "healthy" ]]; then
    return 0
  fi

  # Wait and retry
  local elapsed=0
  while [[ "${elapsed}" -lt "${timeout}" ]]; do
    sleep 5
    elapsed=$((elapsed + 5))
    health_status="$(docker inspect --format='{{.State.Health.Status}}' "${container_name}" 2>/dev/null || echo "unknown")"
    if [[ "${health_status}" == "healthy" ]]; then
      return 0
    fi
    log INFO "Waiting for ${container_name} to become healthy... (${elapsed}s/${timeout}s, status: ${health_status})"
  done

  return 1
}

# Check health of a K8s deployment
# Args: deployment_name namespace [timeout_seconds]
# Returns: 0 if healthy, 1 if unhealthy
check_health_k8s() {
  local deployment="${1}"
  local ns="${2}"
  local timeout="${3:-${HEALTH_TIMEOUT}}"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] K8s health check for: ${deployment} in ${ns}"
    return 0
  fi

  local available
  available="$(kubectl get deployment "${deployment}" -n "${ns}" \
    -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo "0")"

  local desired
  desired="$(kubectl get deployment "${deployment}" -n "${ns}" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")"

  if [[ "${available}" == "${desired}" && "${available}" -gt 0 ]]; then
    return 0
  fi

  # Wait and retry
  local elapsed=0
  while [[ "${elapsed}" -lt "${timeout}" ]]; do
    sleep 5
    elapsed=$((elapsed + 5))
    available="$(kubectl get deployment "${deployment}" -n "${ns}" \
      -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo "0")"
    desired="$(kubectl get deployment "${deployment}" -n "${ns}" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")"
    if [[ "${available}" == "${desired}" && "${available}" -gt 0 ]]; then
      return 0
    fi
    log INFO "Waiting for K8s deployment ${deployment}... (${elapsed}s/${timeout}s, available: ${available}/${desired})"
  done

  return 1
}

# ═══════════════════════════════════════════════════════════════
# Metrics Collection
# ═══════════════════════════════════════════════════════════════

# Collect error rate from Docker container logs
# Args: container_name [since_seconds]
# Outputs: error_rate as percentage (e.g., "2.5")
collect_error_rate_docker() {
  local container_name="${1}"
  local since="${2:-60}"

  if [[ "${DRY_RUN}" == true ]]; then
    echo "0.0"
    return
  fi

  local total_lines error_lines
  total_lines="$(docker logs --since "${since}s" "${container_name}" 2>&1 | wc -l || echo "0")"
  error_lines="$(docker logs --since "${since}s" "${container_name}" 2>&1 | grep -ciE '(error|ERR|fail|exception|5[0-9]{2})' || echo "0")"

  if [[ "${total_lines}" -eq 0 ]]; then
    echo "0.0"
    return
  fi

  # Calculate error rate as percentage
  echo "scale=2; ${error_lines} * 100 / ${total_lines}" | bc -l 2>/dev/null || echo "0.0"
}

# Collect p95 latency from Docker container logs
# Args: container_name [since_seconds]
# Outputs: latency in ms (integer)
collect_latency_docker() {
  local container_name="${1}"
  local since="${2:-60}"

  if [[ "${DRY_RUN}" == true ]]; then
    echo "100"
    return
  fi

  # Extract latency values from structured log lines
  # Matches patterns like: "duration": 234 or latency=234ms or durationMs=234
  local latencies
  latencies="$(docker logs --since "${since}s" "${container_name}" 2>&1 \
    | grep -oE '(duration|latency)[":=]+[0-9]+' \
    | grep -oE '[0-9]+' \
    | sort -n \
    || true)"

  if [[ -z "${latencies}" ]]; then
    echo "100"
    return
  fi

  # Calculate p95
  local count
  count="$(echo "${latencies}" | wc -l)"
  local p95_index
  p95_index="$(echo "scale=0; ${count} * 95 / 100" | bc)"

  if [[ "${p95_index}" -eq 0 ]]; then
    p95_index=1
  fi

  local p95
  p95="$(echo "${latencies}" | sed -n "${p95_index}p")"
  echo "${p95:-100}"
}

# Collect error rate from K8s pods
# Args: label_selector namespace [since_seconds]
# Outputs: error_rate as percentage
collect_error_rate_k8s() {
  local label="${1}"
  local ns="${2}"
  local since="${3:-60}"

  if [[ "${DRY_RUN}" == true ]]; then
    echo "0.0"
    return
  fi

  local pod
  pod="$(kubectl get pods -n "${ns}" -l "${label}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")"

  if [[ -z "${pod}" ]]; then
    echo "0.0"
    return
  fi

  local total_lines error_lines
  total_lines="$(kubectl logs --since="${since}s" "${pod}" -n "${ns}" 2>&1 | wc -l || echo "0")"
  error_lines="$(kubectl logs --since="${since}s" "${pod}" -n "${ns}" 2>&1 | grep -ciE '(error|ERR|fail|exception|5[0-9]{2})' || echo "0")"

  if [[ "${total_lines}" -eq 0 ]]; then
    echo "0.0"
    return
  fi

  echo "scale=2; ${error_lines} * 100 / ${total_lines}" | bc -l 2>/dev/null || echo "0.0"
}

# ═══════════════════════════════════════════════════════════════
# Docker Compose Deployment
# ═══════════════════════════════════════════════════════════════

deploy_canary_compose() {
  log PHASE "Deploying canary instance (Docker Compose mode)"

  # Scale up: add one more instance with the new image
  local canary_container="${COMPOSE_PROJECT}-tricore-canary-${TIMESTAMP}"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would run: docker run -d --name ${canary_container} ${IMAGE}"
    CANARY_INSTANCE_ID="${canary_container}"
    return
  fi

  # Start a canary container alongside the existing ones
  local api_port
  api_port="$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()" 2>/dev/null || echo "3723")"
  local health_port
  health_port="$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()" 2>/dev/null || echo "3724")"

  docker run -d \
    --name "${canary_container}" \
    -e NODE_ENV=production \
    -e TRICORE_API_PORT="${api_port}" \
    -e TRICORE_HEALTH_PORT="${health_port}" \
    -e LLM_API_KEY="${LLM_API_KEY:-}" \
    -p "${api_port}:3721" \
    -p "${health_port}:3722" \
    --network "${COMPOSE_PROJECT}_tricore-net" \
    "${IMAGE}" \
    || {
      log ERROR "Failed to start canary container"
      return 1
    }

  CANARY_INSTANCE_ID="${canary_container}"
  log OK "Canary container started: ${CANARY_INSTANCE_ID} (API: ${api_port}, Health: ${health_port})"

  # Wait for canary to become healthy
  if check_health_docker "${CANARY_INSTANCE_ID}" "${HEALTH_TIMEOUT}"; then
    log OK "Canary instance is healthy"
  else
    log ERROR "Canary instance failed health check"
    return 1
  fi
}

shift_traffic_compose() {
  local target_percent="${1}"

  log PHASE "Shifting traffic to ${target_percent}% canary (Docker Compose mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would shift ${target_percent}% traffic to canary: ${CANARY_INSTANCE_ID}"
    return
  fi

  # In Docker Compose mode, traffic shifting is simulated by adjusting
  # which port the load balancer / reverse proxy points to.
  # Since Compose doesn't have native traffic splitting, we use a
  # weighted round-robin via an nginx config or a simple script.

  # For this script, we create/update an nginx upstream config
  local nginx_conf_dir="${PROJECT_ROOT}/deploy/nginx"
  mkdir -p "${nginx_conf_dir}"

  # Get container IPs
  local canary_ip
  canary_ip="$(docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${CANARY_INSTANCE_ID}" 2>/dev/null || echo "127.0.0.1")"

  local stable_containers
  stable_containers="$(docker ps --filter "name=${COMPOSE_PROJECT}" --filter "name=tricore" --format '{{.Names}}' | grep -v canary || true)"

  # Build upstream config with weights
  # nginx weight formula: weight = container_percent / 10
  # With 1 canary and N stable, distribute remaining percent across stable
  local stable_percent=$((100 - target_percent))
  local stable_count
  stable_count="$(echo "${stable_containers}" | wc -l || echo "1")"
  local per_stable_percent
  if [[ "${stable_count}" -gt 0 ]]; then
    per_stable_percent=$((stable_percent / stable_count))
  else
    per_stable_percent=0
  fi

  {
    echo "upstream tricore_backend {"
    echo "  server ${canary_ip}:3721 weight=${target_percent};"
    for sc in ${stable_containers}; do
      local sc_ip
      sc_ip="$(docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${sc}" 2>/dev/null || echo "127.0.0.1")"
      echo "  server ${sc_ip}:3721 weight=${per_stable_percent};"
    done
    echo "}"
  } > "${nginx_conf_dir}/upstream.conf"

  log OK "Traffic shifted: canary=${target_percent}%, stable=${stable_percent}%"
  log INFO "Updated upstream config: ${nginx_conf_dir}/upstream.conf"

  CURRENT_TRAFFIC_PERCENT="${target_percent}"
}

observe_canary_compose() {
  local observe_seconds="${1:-${OBSERVATION_SECONDS}}"

  log PHASE "Observing canary for ${observe_seconds}s (Docker Compose mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would observe canary for ${observe_seconds}s"
    return 0
  fi

  local elapsed=0
  local sample_interval=10

  while [[ "${elapsed}" -lt "${observe_seconds}" ]]; do
    sleep "${sample_interval}"
    elapsed=$((elapsed + sample_interval))

    # Collect error rate
    local canary_error_rate
    canary_error_rate="$(collect_error_rate_docker "${CANARY_INSTANCE_ID}" "${sample_interval}")"

    # Collect latency
    local canary_latency
    canary_latency="$(collect_latency_docker "${CANARY_INSTANCE_ID}" "${sample_interval}")"

    log INFO "[${elapsed}s/${observe_seconds}s] Error rate: ${canary_error_rate}% | P95 latency: ${canary_latency}ms"

    # Check thresholds
    local error_rate_val
    error_rate_val="$(echo "${canary_error_rate}" | awk '{printf "%.1f", $1}')"
    if (( $(echo "${error_rate_val} > ${ERROR_THRESHOLD}" | bc -l 2>/dev/null || echo "0") )); then
      log ERROR "Canary error rate ${canary_error_rate}% exceeds threshold ${ERROR_THRESHOLD}%"
      return 1
    fi

    if [[ "${canary_latency}" -gt "${LATENCY_THRESHOLD_MS}" ]]; then
      log ERROR "Canary latency ${canary_latency}ms exceeds threshold ${LATENCY_THRESHOLD_MS}ms"
      return 1
    fi
  done

  return 0
}

rollback_compose() {
  log PHASE "Rolling back canary (Docker Compose mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would stop and remove canary container: ${CANARY_INSTANCE_ID}"
    return
  fi

  if [[ -n "${CANARY_INSTANCE_ID}" ]]; then
    docker stop "${CANARY_INSTANCE_ID}" 2>/dev/null || true
    docker rm -f "${CANARY_INSTANCE_ID}" 2>/dev/null || true
    log OK "Canary container removed: ${CANARY_INSTANCE_ID}"
  fi

  # Restore original upstream config (100% to stable)
  local nginx_conf_dir="${PROJECT_ROOT}/deploy/nginx"
  if [[ -f "${nginx_conf_dir}/upstream.conf" ]]; then
    rm -f "${nginx_conf_dir}/upstream.conf"
    log OK "Removed canary upstream config"
  fi

  CURRENT_TRAFFIC_PERCENT=0
  log OK "Rollback complete — all traffic routed to stable: ${STABLE_IMAGE}"
}

promote_compose() {
  log PHASE "Promoting canary to stable (Docker Compose mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would replace stable instances with: ${IMAGE}"
    return
  fi

  # Stop old stable instances
  local stable_containers
  stable_containers="$(docker ps --filter "name=${COMPOSE_PROJECT}" --filter "name=tricore" --format '{{.Names}}' | grep -v canary || true)"

  for sc in ${stable_containers}; do
    docker stop "${sc}" 2>/dev/null || true
    docker rm -f "${sc}" 2>/dev/null || true
    log OK "Removed stable container: ${sc}"
  done

  # Restart compose with the new image
  # Update the image in docker-compose.yml temporarily
  local temp_compose="${COMPOSE_FILE}.canary-${TIMESTAMP}"
  cp "${COMPOSE_FILE}" "${temp_compose}"
  sed -i.bak "s|image: ${STABLE_IMAGE}|image: ${IMAGE}|g" "${temp_compose}" 2>/dev/null || true

  dc -f "${temp_compose}" up -d --scale tricore="${REPLICAS}"
  log OK "Started ${REPLICAS} instances with new image: ${IMAGE}"

  # Cleanup
  rm -f "${temp_compose}" "${temp_compose}.bak"

  # Remove the canary container (now replaced by scaled-up new instances)
  if [[ -n "${CANARY_INSTANCE_ID}" ]]; then
    docker stop "${CANARY_INSTANCE_ID}" 2>/dev/null || true
    docker rm -f "${CANARY_INSTANCE_ID}" 2>/dev/null || true
  fi

  CURRENT_TRAFFIC_PERCENT=100
  log OK "Promotion complete — all traffic on: ${IMAGE}"
}

# ═══════════════════════════════════════════════════════════════
# Kubernetes Deployment
# ═══════════════════════════════════════════════════════════════

deploy_canary_k8s() {
  log PHASE "Deploying canary (Kubernetes mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would create K8s canary deployment: ${DEPLOYMENT_NAME}-canary with image ${IMAGE}"
    return
  fi

  # Create a canary deployment with 1 replica
  local canary_name="${DEPLOYMENT_NAME}-canary"

  # Get the existing deployment spec as a base
  kubectl get deployment "${DEPLOYMENT_NAME}" -n "${NAMESPACE}" -o yaml \
    | sed "s/name: ${DEPLOYMENT_NAME}/name: ${canary_name}/g" \
    | sed "s|image: .*|image: ${IMAGE}|g" \
    | sed 's/replicas: [0-9]*/replicas: 1/' \
    | kubectl apply -f - || {
      log ERROR "Failed to create canary deployment"
      return 1
    }

  CANARY_INSTANCE_ID="${canary_name}"
  log OK "Canary deployment created: ${canary_name}"

  # Wait for canary to become healthy
  if check_health_k8s "${canary_name}" "${NAMESPACE}" "${HEALTH_TIMEOUT}"; then
    log OK "Canary deployment is healthy"
  else
    log ERROR "Canary deployment failed health check"
    return 1
  fi
}

shift_traffic_k8s() {
  local target_percent="${1}"

  log PHASE "Shifting traffic to ${target_percent}% canary (Kubernetes mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would set canary weight to ${target_percent}%"
    return
  fi

  # Calculate replica counts
  local total_replicas="${REPLICAS}"
  local canary_replicas
  canary_replicas="$(echo "scale=0; (${total_replicas} * ${target_percent} / 100 + 0.5) / 1" | bc)"
  local stable_replicas=$((total_replicas - canary_replicas))

  if [[ "${canary_replicas}" -lt 1 ]]; then
    canary_replicas=1
  fi
  if [[ "${stable_replicas}" -lt 0 ]]; then
    stable_replicas=0
  fi

  # Scale canary deployment
  kubectl scale deployment "${CANARY_INSTANCE_ID}" -n "${NAMESPACE}" --replicas="${canary_replicas}" || true

  # Scale stable deployment
  if [[ "${stable_replicas}" -gt 0 ]]; then
    kubectl scale deployment "${DEPLOYMENT_NAME}" -n "${NAMESPACE}" --replicas="${stable_replicas}" || true
  fi

  log OK "Scaled: canary=${canary_replicas} replicas, stable=${stable_replicas} replicas"
  CURRENT_TRAFFIC_PERCENT="${target_percent}"
}

observe_canary_k8s() {
  local observe_seconds="${1:-${OBSERVATION_SECONDS}}"

  log PHASE "Observing canary for ${observe_seconds}s (Kubernetes mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would observe canary for ${observe_seconds}s"
    return 0
  fi

  local elapsed=0
  local sample_interval=10
  local canary_label="app=${DEPLOYMENT_NAME},track=canary"

  while [[ "${elapsed}" -lt "${observe_seconds}" ]]; do
    sleep "${sample_interval}"
    elapsed=$((elapsed + sample_interval))

    local canary_error_rate
    canary_error_rate="$(collect_error_rate_k8s "${canary_label}" "${NAMESPACE}" "${sample_interval}")"

    log INFO "[${elapsed}s/${observe_seconds}s] Error rate: ${canary_error_rate}%"

    local error_rate_val
    error_rate_val="$(echo "${canary_error_rate}" | awk '{printf "%.1f", $1}')"
    if (( $(echo "${error_rate_val} > ${ERROR_THRESHOLD}" | bc -l 2>/dev/null || echo "0") )); then
      log ERROR "Canary error rate ${canary_error_rate}% exceeds threshold ${ERROR_THRESHOLD}%"
      return 1
    fi
  done

  return 0
}

rollback_k8s() {
  log PHASE "Rolling back canary (Kubernetes mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would delete canary deployment and restore stable replicas"
    return
  fi

  # Delete canary deployment
  if [[ -n "${CANARY_INSTANCE_ID}" ]]; then
    kubectl delete deployment "${CANARY_INSTANCE_ID}" -n "${NAMESPACE}" --grace-period=30 || true
    log OK "Deleted canary deployment: ${CANARY_INSTANCE_ID}"
  fi

  # Restore stable replicas
  kubectl scale deployment "${DEPLOYMENT_NAME}" -n "${NAMESPACE}" --replicas="${REPLICAS}" || true
  log OK "Restored stable deployment to ${REPLICAS} replicas"

  CURRENT_TRAFFIC_PERCENT=0
  log OK "Rollback complete — all traffic on stable: ${STABLE_IMAGE}"
}

promote_k8s() {
  log PHASE "Promoting canary to stable (Kubernetes mode)"

  if [[ "${DRY_RUN}" == true ]]; then
    log INFO "[DRY-RUN] Would update stable deployment image to ${IMAGE}"
    return
  fi

  # Update the stable deployment's image
  kubectl set image "deployment/${DEPLOYMENT_NAME}" \
    "tricore=${IMAGE}" \
    -n "${NAMESPACE}" || {
      log ERROR "Failed to update stable deployment image"
      return 1
    }

  # Wait for rollout
  kubectl rollout status "deployment/${DEPLOYMENT_NAME}" -n "${NAMESPACE}" --timeout="${HEALTH_TIMEOUT}s" || true

  # Scale up stable
  kubectl scale deployment "${DEPLOYMENT_NAME}" -n "${NAMESPACE}" --replicas="${REPLICAS}" || true

  # Delete canary deployment
  if [[ -n "${CANARY_INSTANCE_ID}" ]]; then
    kubectl delete deployment "${CANARY_INSTANCE_ID}" -n "${NAMESPACE}" --grace-period=30 || true
  fi

  CURRENT_TRAFFIC_PERCENT=100
  log OK "Promotion complete — all traffic on: ${IMAGE}"
}

# ═══════════════════════════════════════════════════════════════
# Unified Interface (dispatches to compose or k8s)
# ═══════════════════════════════════════════════════════════════

deploy_canary() {
  if [[ "${MODE}" == "compose" ]]; then
    deploy_canary_compose
  else
    deploy_canary_k8s
  fi
}

shift_traffic() {
  local percent="${1}"
  if [[ "${MODE}" == "compose" ]]; then
    shift_traffic_compose "${percent}"
  else
    shift_traffic_k8s "${percent}"
  fi
}

observe_canary() {
  local seconds="${1:-${OBSERVATION_SECONDS}}"
  if [[ "${MODE}" == "compose" ]]; then
    observe_canary_compose "${seconds}"
  else
    observe_canary_k8s "${seconds}"
  fi
}

rollback() {
  if [[ "${MODE}" == "compose" ]]; then
    rollback_compose
  else
    rollback_k8s
  fi
}

promote() {
  if [[ "${MODE}" == "compose" ]]; then
    promote_compose
  else
    promote_k8s
  fi
}

# ═══════════════════════════════════════════════════════════════
# Main Deployment Flow
# ═══════════════════════════════════════════════════════════════

canary_deploy_main() {
  log_banner "TriCore Agent Canary Deployment"

  # Print configuration
  log INFO "Mode:             ${MODE}"
  log INFO "New Image:        ${IMAGE}"
  log INFO "Stable Image:     ${STABLE_IMAGE}"
  log INFO "Error Threshold:  ${ERROR_THRESHOLD}%"
  log INFO "Latency Threshold: ${LATENCY_THRESHOLD_MS}ms"
  log INFO "Observation:       ${OBSERVATION_SECONDS}s per stage"
  log INFO "Health Timeout:    ${HEALTH_TIMEOUT}s"
  log INFO "Dry Run:           ${DRY_RUN}"
  echo ""

  # ── Phase 1: Deploy Canary Instance ──
  DEPLOYMENT_PHASE="deploy"
  log PHASE "Phase 1: Deploying canary instance"

  if ! deploy_canary; then
    log ERROR "Canary deployment failed — aborting"
    rollback
    exit 1
  fi

  # ── Phase 2: Initial Health Check ──
  DEPLOYMENT_PHASE="health-check"
  log PHASE "Phase 2: Verifying canary health"

  log OK "Canary instance healthy: ${CANARY_INSTANCE_ID}"

  # ── Phase 3: Traffic Shifting ──
  DEPLOYMENT_PHASE="traffic-shift"

  if [[ -n "${CANARY_PERCENT}" ]]; then
    # Direct shift to specified percentage
    log PHASE "Phase 3: Direct traffic shift to ${CANARY_PERCENT}%"

    shift_traffic "${CANARY_PERCENT}"

    if ! observe_canary; then
      log ERROR "Canary failed observation at ${CANARY_PERCENT}% — initiating rollback"
      rollback
      exit 1
    fi

    # If at 100%, promotion is done
    if [[ "${CANARY_PERCENT}" -eq 100 ]]; then
      log OK "Canary at 100% traffic — deployment complete"
      exit 0
    fi
  else
    # Gradual shifting through defined stages
    log PHASE "Phase 3: Gradual traffic shifting (${TRAFFIC_STAGES[*]}%)"

    for stage_percent in "${TRAFFIC_STAGES[@]}"; do
      log INFO "Shifting traffic to ${stage_percent}%..."
      shift_traffic "${stage_percent}"

      # Observe at this traffic level
      # Shorter observation for early stages, longer for later
      local observe_time
      if [[ "${stage_percent}" -lt 50 ]]; then
        observe_time=$((OBSERVATION_SECONDS / 2))
      else
        observe_time="${OBSERVATION_SECONDS}"
      fi

      if ! observe_canary "${observe_time}"; then
        log ERROR "Canary failed observation at ${stage_percent}% — initiating rollback"
        rollback
        exit 1
      fi

      log OK "Canary passed observation at ${stage_percent}% traffic"
    done
  fi

  # ── Phase 4: Promote ──
  DEPLOYMENT_PHASE="promote"
  log PHASE "Phase 4: Promoting canary to stable"

  promote

  log_banner "Canary Deployment Complete"
  log OK "Successfully deployed: ${IMAGE}"
  log OK "All traffic is now served by the new version"
}

# ═══════════════════════════════════════════════════════════════
# Rollback Mode
# ═══════════════════════════════════════════════════════════════

rollback_main() {
  log_banner "Emergency Rollback"

  # Detect the canary instance
  if [[ "${MODE}" == "compose" ]]; then
    CANARY_INSTANCE_ID="$(docker ps --filter "name=canary" --format '{{.Names}}' | head -1 || true)"
  elif [[ "${MODE}" == "k8s" ]]; then
    CANARY_INSTANCE_ID="${DEPLOYMENT_NAME}-canary"
  fi

  if [[ -z "${CANARY_INSTANCE_ID}" ]]; then
    log WARN "No canary instance found — nothing to roll back"
    # Still restore stable deployment
    if [[ "${MODE}" == "k8s" ]]; then
      kubectl scale deployment "${DEPLOYMENT_NAME}" -n "${NAMESPACE}" --replicas="${REPLICAS}" 2>/dev/null || true
    fi
    exit 0
  fi

  log INFO "Rolling back canary: ${CANARY_INSTANCE_ID}"
  rollback
  log OK "Rollback complete"
}

# ═══════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════

main() {
  parse_args "$@"
  check_prerequisites
  detect_stable_image

  mkdir -p "${LOG_DIR}"
  log INFO "Log file: ${LOG_FILE}"

  if [[ "${ROLLBACK}" == true ]]; then
    rollback_main
  else
    # Trap to ensure rollback on unexpected exit during deployment
    trap 'if [[ "${DEPLOYMENT_PHASE}" != "promote" ]] && [[ "${DEPLOYMENT_PHASE}" != "init" ]]; then log ERROR "Deploy interrupted at phase: ${DEPLOYMENT_PHASE}"; rollback; fi' EXIT
    canary_deploy_main
    # Clear trap on successful exit
    trap - EXIT
  fi
}

main "$@"

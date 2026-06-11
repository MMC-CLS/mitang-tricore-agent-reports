#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# TriCore Agent v1.0 - Chaos Test Runner
#
# Runs chaos engineering tests with scenario selection, temporary
# environment setup, structured result reporting, and cleanup.
#
# Usage:
#   ./scripts/chaos-test.sh                        # Run all chaos tests
#   ./scripts/chaos-test.sh --scenario network     # Run only network chaos
#   ./scripts/chaos-test.sh --scenario cpu          # Run only CPU chaos
#   ./scripts/chaos-test.sh --scenario memory       # Run only memory chaos
#   ./scripts/chaos-test.sh --scenario disk         # Run only disk chaos
#   ./scripts/chaos-test.sh --scenario process      # Run only process chaos
#   ./scripts/chaos-test.sh --scenario sustained    # Run sustained chaos
#   ./scripts/chaos-test.sh --duration 10000       # Custom duration (ms)
#   ./scripts/chaos-test.sh --verbose              # Verbose output
#   ./scripts/chaos-test.sh --list                  # List available scenarios
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Constants ──
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly CHAOS_TEST_FILE="${PROJECT_ROOT}/tests/chaos/chaos-test.js"
readonly TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
readonly RESULT_DIR="${PROJECT_ROOT}/test_output/chaos"
readonly RESULT_FILE="${RESULT_DIR}/chaos-result-${TIMESTAMP}.log"

# ── Colors ──
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly BOLD='\033[1m'
readonly NC='\033[0m'  # No Color

# ── Default Options ──
SCENARIO=""
DURATION=""
VERBOSE=false
LIST_ONLY=false
NODE_OPTIONS=""

# ── Available Scenarios ──
declare -A SCENARIOS
SCENARIOS=(
  ["network"]="Network Chaos (latency spikes, connection drops, partial responses, partition)"
  ["cpu"]="CPU Pressure (busy workers, event loop blocking)"
  ["memory"]="Memory Pressure (large buffers, allocation cycles, OOM handling)"
  ["disk"]="Disk I/O Chaos (concurrent writes, disk-full simulation, FD exhaustion)"
  ["process"]="Process Chaos (subprocess crashes, SIGTERM, orphan cleanup, uncaughtException)"
  ["sustained"]="Sustained Multi-Domain Chaos (combined network + memory, recovery)"
)

# ═══════════════════════════════════════════════════════════════
# Functions
# ═══════════════════════════════════════════════════════════════

log() {
  local level="${1}"
  shift
  local message="${*}"
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"

  case "${level}" in
    info)  echo -e "${CYAN}[INFO]${NC}  ${timestamp}  ${message}" ;;
    ok)    echo -e "${GREEN}[OK]${NC}    ${timestamp}  ${message}" ;;
    warn)  echo -e "${YELLOW}[WARN]${NC}  ${timestamp}  ${message}" ;;
    error) echo -e "${RED}[ERROR]${NC} ${timestamp}  ${message}" ;;
    *)     echo -e "${BLUE}[${level}]${NC}  ${timestamp}  ${message}" ;;
  esac
}

log_banner() {
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  ${*}${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
  echo ""
}

usage() {
  cat <<EOF
Usage: $(basename "${0}") [OPTIONS]

TriCore Agent Chaos Engineering Test Runner

Options:
  -s, --scenario <name>   Run a specific scenario:
$(for name in "${!SCENARIOS[@]}"; do echo "                            ${name} - ${SCENARIOS[$name]}"; done | sort)
  -d, --duration <ms>    Custom chaos duration in milliseconds
  -v, --verbose          Enable verbose output
  -l, --list             List available scenarios and exit
  -h, --help             Show this help message

Examples:
  $(basename "${0}")                          # Run all chaos tests
  $(basename "${0}") --scenario network       # Run network chaos only
  $(basename "${0}") --scenario cpu --verbose # Verbose CPU pressure test
  $(basename "${0}") --duration 10000         # 10-second chaos duration
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "${1}" in
      -s|--scenario)
        SCENARIO="${2:-}"
        if [[ -z "${SCENARIO}" ]]; then
          log error "Scenario name is required for --scenario"
          exit 1
        fi
        if [[ -z "${SCENARIOS[${SCENARIO}]+x}" ]]; then
          log error "Unknown scenario: ${SCENARIO}"
          log error "Available: ${!SCENARIOS[*]}"
          exit 1
        fi
        shift 2
        ;;
      -d|--duration)
        DURATION="${2:-}"
        if [[ -z "${DURATION}" ]]; then
          log error "Duration value is required for --duration"
          exit 1
        fi
        if ! [[ "${DURATION}" =~ ^[0-9]+$ ]]; then
          log error "Duration must be a number (milliseconds), got: ${DURATION}"
          exit 1
        fi
        shift 2
        ;;
      -v|--verbose)
        VERBOSE=true
        shift
        ;;
      -l|--list)
        LIST_ONLY=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        log error "Unknown option: ${1}"
        usage
        exit 1
        ;;
    esac
  done
}

list_scenarios() {
  log_banner "Available Chaos Scenarios"
  for name in $(echo "${!SCENARIOS[@]}" | tr ' ' '\n' | sort); do
    echo -e "  ${GREEN}${name}${NC}  ${SCENARIOS[${name}]}"
  done
  echo ""
}

check_prerequisites() {
  log info "Checking prerequisites..."

  # Check Node.js
  if ! command -v node &>/dev/null; then
    log error "Node.js is not installed. Please install Node.js >= 18.0.0"
    exit 1
  fi

  local node_version
  node_version="$(node --version | sed 's/v//' | cut -d. -f1)"
  if [[ "${node_version}" -lt 18 ]]; then
    log error "Node.js >= 18.0.0 is required. Current: $(node --version)"
    exit 1
  fi
  log ok "Node.js $(node --version) detected"

  # Check test file exists
  if [[ ! -f "${CHAOS_TEST_FILE}" ]]; then
    log error "Chaos test file not found: ${CHAOS_TEST_FILE}"
    exit 1
  fi
  log ok "Chaos test file found: ${CHAOS_TEST_FILE}"

  # Check project structure
  if [[ ! -f "${PROJECT_ROOT}/package.json" ]]; then
    log error "package.json not found in project root: ${PROJECT_ROOT}"
    exit 1
  fi
  log ok "Project root: ${PROJECT_ROOT}"
}

setup_environment() {
  log info "Setting up temporary test environment..."

  # Create result directory
  mkdir -p "${RESULT_DIR}"

  # Set environment variables for chaos tests
  export NODE_ENV="test"
  export CHAOS_TEST_MODE="true"

  # Apply custom duration if specified
  if [[ -n "${DURATION}" ]]; then
    export CHAOS_DURATION="${DURATION}"
    log ok "Custom chaos duration: ${DURATION}ms"
  fi

  # Increase memory limit for chaos tests
  NODE_OPTIONS="--max-old-space-size=1024"
  if [[ "${VERBOSE}" == true ]]; then
    NODE_OPTIONS="${NODE_OPTIONS} --trace-warnings"
  fi
  export NODE_OPTIONS

  # Create a temporary directory for test artifacts
  local temp_dir
  temp_dir="$(mktemp -d /tmp/mitang-chaos-XXXXXX)"
  export CHAOS_TEMP_DIR="${temp_dir}"
  log ok "Temp directory: ${temp_dir}"

  # Record start time
  CHAOS_START_TIME="$(date +%s%N)"
  export CHAOS_START_TIME
}

cleanup_environment() {
  log info "Cleaning up test environment..."

  # Remove temporary directory
  if [[ -n "${CHAOS_TEMP_DIR:-}" ]] && [[ -d "${CHAOS_TEMP_DIR}" ]]; then
    rm -rf "${CHAOS_TEMP_DIR}"
    log ok "Removed temp directory: ${CHAOS_TEMP_DIR}"
  fi

  # Unset test-specific variables
  unset CHAOS_TEST_MODE CHAOS_DURATION CHAOS_TEMP_DIR CHAOS_START_TIME

  log ok "Environment cleanup complete"
}

run_chaos_tests() {
  # Build the node --test command arguments
  local -a node_args=(--test "${CHAOS_TEST_FILE}")

  if [[ -n "${SCENARIO}" ]]; then
    # Map scenario name to test name pattern
    local pattern=""
    case "${SCENARIO}" in
      network)   pattern="Network Chaos" ;;
      cpu)       pattern="CPU Pressure" ;;
      memory)    pattern="Memory Pressure" ;;
      disk)      pattern="Disk I/O Chaos" ;;
      process)   pattern="Process Chaos" ;;
      sustained) pattern="Sustained Multi-Domain Chaos" ;;
    esac
    node_args=(--test --test-name-pattern "${pattern}" "${CHAOS_TEST_FILE}")
    log info "Running scenario: ${SCENARIO} (pattern: '${pattern}')"
  else
    log info "Running all chaos scenarios"
  fi

  log_banner "Running Chaos Engineering Tests"

  local exit_code=0

  # Run the test — avoid eval to prevent injection issues
  local output
  set +e
  output="$(node "${node_args[@]}" 2>&1)" || exit_code=$?
  set -e

  # Write raw output to result file
  echo "${output}" > "${RESULT_FILE}"

  # Display output
  if [[ "${VERBOSE}" == true ]]; then
    echo "${output}"
  else
    # Show summary lines only
    echo "${output}" | grep -E "(✓|✗|✘|✔|✕|ok|not ok|#|tapes|tests|pass|fail|skip|duration|real)" || true
  fi

  return ${exit_code}
}

generate_report() {
  local exit_code="${1}"

  local end_time
  end_time="$(date +%s%N)"
  local total_duration_ms
  total_duration_ms=$(( (end_time - CHAOS_START_TIME) / 1000000 ))

  log_banner "Chaos Test Report"

  # Parse results from output
  local total_tests=0
  local passed_tests=0
  local failed_tests=0
  local skipped_tests=0

  if [[ -f "${RESULT_FILE}" ]]; then
    total_tests="$(grep -cE "^(ok|not ok)" "${RESULT_FILE}" 2>/dev/null || echo "0")"
    passed_tests="$(grep -cE "^ok " "${RESULT_FILE}" 2>/dev/null || echo "0")"
    failed_tests="$(grep -cE "^not ok" "${RESULT_FILE}" 2>/dev/null || echo "0")"
    skipped_tests="$(grep -cE "skip" "${RESULT_FILE}" 2>/dev/null || echo "0")"
  fi

  # Summary table
  echo -e "  ${BOLD}Duration:${NC}       ${total_duration_ms}ms"
  echo -e "  ${BOLD}Total Tests:${NC}    ${total_tests}"
  echo -e "  ${GREEN}${BOLD}Passed:${NC}         ${passed_tests}"
  echo -e "  ${RED}${BOLD}Failed:${NC}         ${failed_tests}"
  echo -e "  ${YELLOW}${BOLD}Skipped:${NC}       ${skipped_tests}"
  echo -e "  ${BOLD}Result File:${NC}    ${RESULT_FILE}"
  echo -e "  ${BOLD}Scenario:${NC}       ${SCENARIO:-all}"
  echo ""

  # Verdict
  if [[ "${exit_code}" -eq 0 ]]; then
    log ok "All chaos tests PASSED - System is resilient under tested conditions"
  else
    log error "Some chaos tests FAILED - System may have resilience issues"
    log warn "Review the full output at: ${RESULT_FILE}"
  fi

  echo ""
}

# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

main() {
  parse_args "$@"

  # Handle --list
  if [[ "${LIST_ONLY}" == true ]]; then
    list_scenarios
    exit 0
  fi

  log_banner "TriCore Agent Chaos Engineering Suite"

  # Prerequisites
  check_prerequisites

  # Setup
  setup_environment

  # Ensure cleanup runs on exit
  trap cleanup_environment EXIT

  # Run tests
  local exit_code=0
  run_chaos_tests || exit_code=$?

  # Report
  generate_report "${exit_code}"

  exit "${exit_code}"
}

main "$@"

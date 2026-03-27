#!/usr/bin/env bash
# =============================================================================
# Reka Installer — Self-hosted RAG infrastructure for AI coding assistants
# Usage: curl -fsSL https://reka.dev/install.sh | bash
# =============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Header ---
echo -e "${BOLD}"
echo "  ╦═╗╔═╗╦╔═╔═╗"
echo "  ╠╦╝║╣ ╠╩╗╠═╣"
echo "  ╩╚═╚═╝╩ ╩╩ ╩"
echo -e "${NC}"
echo "  Memory your AI can trust."
echo ""

# --- Check prerequisites ---
info "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || err "Docker is required. Install: https://docs.docker.com/get-docker/"
command -v docker compose >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1 || err "Docker Compose is required."
command -v git >/dev/null 2>&1 || err "Git is required."
command -v curl >/dev/null 2>&1 || err "curl is required."

ok "All prerequisites found"

# --- Docker running? ---
docker info >/dev/null 2>&1 || err "Docker daemon is not running. Start it and try again."
ok "Docker is running"

# --- Check available memory ---
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "0")
TOTAL_MEM_GB=$((TOTAL_MEM_KB / 1024 / 1024))
if [ "$TOTAL_MEM_GB" -lt 8 ] && [ "$TOTAL_MEM_GB" -gt 0 ]; then
  warn "System has ${TOTAL_MEM_GB}GB RAM. Reka recommends at least 8GB (16GB+ for LLM)."
fi

# --- GPU detection ---
HAS_GPU="false"
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "")
  if [ -n "$GPU_NAME" ]; then
    HAS_GPU="true"
    ok "GPU detected: $GPU_NAME"
  fi
fi

if [ "$HAS_GPU" = "false" ]; then
  warn "No NVIDIA GPU detected. Ollama will use CPU (slower LLM inference)."
fi

# --- Install directory ---
INSTALL_DIR="${REKA_DIR:-$HOME/reka}"

if [ -d "$INSTALL_DIR" ]; then
  info "Directory $INSTALL_DIR already exists."
  read -p "  Update existing installation? [Y/n] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    cd "$INSTALL_DIR"
    git pull --ff-only || warn "Could not auto-update. Continuing with existing version."
  fi
else
  info "Cloning Reka to $INSTALL_DIR..."
  git clone https://github.com/reka-dev/reka.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# --- Configure environment ---
if [ ! -f rag-api/.env ]; then
  info "Creating configuration from template..."
  cp rag-api/.env.example rag-api/.env

  # Generate API key
  API_KEY=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || \
            node -e "console.log(require('crypto').randomUUID())" 2>/dev/null || \
            cat /proc/sys/kernel/random/uuid 2>/dev/null || \
            echo "change-me-$(date +%s)")

  # Set API key in .env
  sed -i "s/^# API_KEY=$/API_KEY=${API_KEY}/" rag-api/.env 2>/dev/null || \
  sed -i '' "s/^# API_KEY=$/API_KEY=${API_KEY}/" rag-api/.env 2>/dev/null || true

  ok "Configuration created with auto-generated API key"
  echo -e "  ${YELLOW}API Key: ${API_KEY}${NC}"
  echo "  Save this — you'll need it to connect MCP clients."
else
  ok "Existing configuration found, keeping it"
fi

# --- Handle GPU for docker-compose ---
COMPOSE_FILE="docker/docker-compose.yml"
if [ "$HAS_GPU" = "false" ]; then
  warn "Creating CPU-only override (no GPU for Ollama)..."
  cat > docker/docker-compose.override.yml <<'EOF'
# Auto-generated: CPU-only override (no NVIDIA GPU detected)
services:
  ollama:
    deploy:
      resources:
        limits:
          memory: 8G
        reservations: {}
EOF
fi

# --- Check port availability ---
for PORT in 3100 6333 11434 8080 6380 3000; do
  if ss -tlnp 2>/dev/null | grep -q ":${PORT} " || lsof -i ":${PORT}" >/dev/null 2>&1; then
    warn "Port $PORT is already in use. Reka may have conflicts."
  fi
done

# --- Start services ---
info "Starting Reka services (this may take a few minutes on first run)..."

COMPOSE_CMD="docker compose"
$COMPOSE_CMD version >/dev/null 2>&1 || COMPOSE_CMD="docker-compose"

cd docker
$COMPOSE_CMD up -d

echo ""
info "Waiting for services to be healthy..."

# Wait for Qdrant
for i in $(seq 1 30); do
  if curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
    ok "Qdrant is ready"
    break
  fi
  [ "$i" -eq 30 ] && warn "Qdrant not responding yet (may still be starting)"
  sleep 2
done

# Wait for RAG API
for i in $(seq 1 30); do
  if curl -sf http://localhost:3100/health >/dev/null 2>&1; then
    ok "RAG API is ready"
    break
  fi
  [ "$i" -eq 30 ] && warn "RAG API not responding yet (may still be starting)"
  sleep 2
done

# --- Pull default Ollama model ---
info "Pulling default LLM model (this may take a while on first run)..."
docker exec shared-ollama ollama pull qwen3.5:35b 2>/dev/null &
OLLAMA_PID=$!

# --- Success ---
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Reka is running!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  RAG API:    ${BOLD}http://localhost:3100${NC}"
echo -e "  Dashboard:  ${BOLD}http://localhost:3000${NC}"
echo -e "  Qdrant UI:  ${BOLD}http://localhost:6333/dashboard${NC}"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo ""
echo "  1. Connect your AI assistant (add to .mcp.json):"
echo ""
echo '     {'
echo '       "mcpServers": {'
echo '         "reka": {'
echo '           "command": "npx",'
echo '           "args": ["-y", "@reka/mcp-server"],'
echo '           "env": {'
echo '             "PROJECT_NAME": "my-project",'
echo '             "PROJECT_PATH": "/path/to/my-project",'
echo "             \"RAG_API_URL\": \"http://localhost:3100\","
echo "             \"RAG_API_KEY\": \"${API_KEY:-your-api-key}\""
echo '           }'
echo '         }'
echo '       }'
echo '     }'
echo ""
echo "  2. Index your codebase (via MCP tool or API):"
echo "     curl -X POST http://localhost:3100/api/index \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -H 'X-Project-Name: my-project' \\"
echo "       -d '{\"path\": \"/path/to/my-project/src\"}'"
echo ""
echo "  3. Search your code:"
echo "     curl http://localhost:3100/api/search \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -H 'X-Project-Name: my-project' \\"
echo "       -d '{\"query\": \"authentication middleware\"}'"
echo ""

if [ -n "${OLLAMA_PID:-}" ] && kill -0 "$OLLAMA_PID" 2>/dev/null; then
  echo -e "  ${YELLOW}Note: LLM model is still downloading in the background.${NC}"
  echo "  Check progress: docker logs -f shared-ollama"
fi

echo ""
echo -e "  Docs:    ${BLUE}https://github.com/reka-dev/reka${NC}"
echo -e "  Discord: ${BLUE}https://discord.gg/reka${NC}"
echo ""

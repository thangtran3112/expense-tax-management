# Builds every ai-trading image. Run from the repository root:
#   docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
# Bake resolves relative paths against the current working directory.

variable "REGISTRY" {
  default = "ghcr.io/thangtran3112/family-app"
}

variable "TAG" {
  default = "local"
}

variable "VIBE_TRADING_URL" {
  default = "https://vibe-trading.tobytran.dev"
}

group "default" {
  targets = ["web", "ta-terminal", "ahf-terminal", "vibe-trading"]
}

target "web" {
  context = "ai-trading/frontend"
  args = {
    NEXT_PUBLIC_VIBE_TRADING_URL = VIBE_TRADING_URL
  }
  tags = ["${REGISTRY}/ai-trading-web:${TAG}"]
}

target "terminal-tools" {
  context = "ai-trading/deploy/upstream/terminal"
}

target "ta-upstream" {
  context = "ai-trading/packages/trading-agents"
}

target "ta-terminal" {
  context = "ai-trading/deploy/upstream/trading-agents"
  contexts = {
    base  = "target:ta-upstream"
    tools = "target:terminal-tools"
  }
  tags = ["${REGISTRY}/ai-trading-ta-terminal:${TAG}"]
}

target "ahf-terminal" {
  context = "ai-trading/deploy/upstream/ai-hedge-fund"
  contexts = {
    upstream = "ai-trading/packages/ai-hedge-fund"
    tools    = "target:terminal-tools"
  }
  tags = ["${REGISTRY}/ai-trading-ahf-terminal:${TAG}"]
}

target "vibe-trading" {
  context = "ai-trading/packages/vibe-trading"
  tags    = ["${REGISTRY}/ai-trading-vibe-trading:${TAG}"]
}

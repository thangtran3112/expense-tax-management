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

variable "MIROFISH_API_BASE_URL" {
  default = "https://mirofish.tobytran.dev"
}

# Public (non-secret) Clerk publishable key baked into the static export.
# Sourced from the repo-scoped GitHub Actions variable
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (refreshed by the operator from Firestore
# ai-trading/clerk PUBLISHABLE_KEY; see .github/workflows/ai-trading-deploy.yml).
# Default "" (not absent) so --print always shows the arg name -- an empty
# value fails the frontend's own requireClerkPublishableKey() at build time
# instead of silently shipping a build with no Clerk key.
variable "CLERK_PUBLISHABLE_KEY" {
  default = ""
}

group "default" {
  targets = ["web", "ta-terminal", "ahf-terminal", "vibe-trading", "mirofish-backend", "auth"]
}

target "web" {
  context = "ai-trading/frontend"
  args = {
    NEXT_PUBLIC_VIBE_TRADING_URL      = VIBE_TRADING_URL
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = CLERK_PUBLISHABLE_KEY
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

target "auth" {
  context = "ai-trading/auth"
  tags    = ["${REGISTRY}/ai-trading-auth:${TAG}"]
}

target "mirofish-backend" {
  context = "ai-trading/deploy/upstream/mirofish"
  contexts = {
    upstream = "ai-trading/packages/mirofish/backend"
    # app/utils/locale.py resolves three directories above its own file to a
    # sibling "locales" dir at the mirofish repo root (outside the "backend"
    # subtree) -- pin it as its own context rather than editing upstream source.
    locales = "ai-trading/packages/mirofish/locales"
  }
  tags = ["${REGISTRY}/ai-trading-mirofish-backend:${TAG}"]
}

target "mirofish-frontend" {
  context = "ai-trading/deploy/upstream/mirofish-frontend"
  contexts = {
    upstream = "ai-trading/packages/mirofish/frontend"
    # src/i18n/index.js resolves three directories above its own file to a
    # sibling "locales" dir at the mirofish repo root (outside the "frontend"
    # subtree) -- pin it as its own context rather than editing upstream source.
    locales = "ai-trading/packages/mirofish/locales"
  }
  args = {
    VITE_API_BASE_URL = MIROFISH_API_BASE_URL
  }
  target = "export"
  output = ["type=local,dest=ai-trading/frontend-artifacts/mirofish"]
}

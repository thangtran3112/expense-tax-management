# Merged with docker-bake.hcl in GitHub Actions: adds per-target GHA layer caches.

target "web" {
  cache-from = ["type=gha,scope=ai-trading-web"]
  cache-to   = ["type=gha,scope=ai-trading-web,mode=max"]
}

target "terminal-tools" {
  cache-from = ["type=gha,scope=ai-trading-terminal-tools"]
  cache-to   = ["type=gha,scope=ai-trading-terminal-tools,mode=max"]
}

target "ta-upstream" {
  cache-from = ["type=gha,scope=ai-trading-ta-upstream"]
  cache-to   = ["type=gha,scope=ai-trading-ta-upstream,mode=max"]
}

target "ta-terminal" {
  cache-from = ["type=gha,scope=ai-trading-ta-terminal"]
  cache-to   = ["type=gha,scope=ai-trading-ta-terminal,mode=max"]
}

target "ahf-terminal" {
  cache-from = ["type=gha,scope=ai-trading-ahf-terminal"]
  cache-to   = ["type=gha,scope=ai-trading-ahf-terminal,mode=max"]
}

target "vibe-upstream" {
  cache-from = ["type=gha,scope=ai-trading-vibe-trading"]
  cache-to   = ["type=gha,scope=ai-trading-vibe-trading,mode=max"]
}

target "vibe-trading" {
  cache-from = ["type=gha,scope=ai-trading-vibe-wrapper"]
  cache-to   = ["type=gha,scope=ai-trading-vibe-wrapper,mode=max"]
}

target "auth" {
  cache-from = ["type=gha,scope=ai-trading-auth"]
  cache-to   = ["type=gha,scope=ai-trading-auth,mode=max"]
}

target "mirofish-backend" {
  cache-from = ["type=gha,scope=ai-trading-mirofish-backend"]
  cache-to   = ["type=gha,scope=ai-trading-mirofish-backend,mode=max"]
}

target "mirofish-frontend" {
  cache-from = ["type=gha,scope=ai-trading-mirofish-frontend"]
  cache-to   = ["type=gha,scope=ai-trading-mirofish-frontend,mode=max"]
}

# syntax=docker/dockerfile:1.7
# TradingAgents in a browser terminal. "base" is the upstream image built
# unmodified from ai-trading/packages/trading-agents/Dockerfile; "tools" is the terminal layer.
FROM base
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ncurses-term \
 && rm -rf /var/lib/apt/lists/*
COPY --from=tools / /
ENV APP_COMMAND=tradingagents \
    TTYD_BASE_PATH=/u/tradingagents \
    TTYD_AUTH_HEADER=Cf-Access-Authenticated-User-Email
USER appuser
EXPOSE 7681
ENTRYPOINT ["/usr/local/bin/terminal-entrypoint.sh"]
CMD []

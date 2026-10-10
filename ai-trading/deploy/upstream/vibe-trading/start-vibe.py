"""Show Firestore-injected LLM settings instead of upstream example defaults."""

import asyncio
import os
import sys

from src.api.helpers import ENV_PATH, _write_env_values
from src.api.settings_routes import (
    LLM_PROVIDER_BY_NAME,
    _desktop_secure_credential_names,
    _discover_reasoning_efforts,
)


if (
    os.environ.get("LANGCHAIN_PROVIDER") != "openai"
    or os.environ.get("OPENAI_BASE_URL") != "https://api.openai.com/v1"
    or not os.environ.get("LANGCHAIN_MODEL_NAME")
    or not os.environ.get("OPENAI_API_KEY")
    or os.environ.get("VIBE_TRADING_DESKTOP_SECURE_CREDENTIALS") != "1"
):
    raise RuntimeError("Vibe requires the direct OpenAI family-config profile")

settings = {
    name: os.environ[name]
    for name in (
        "LANGCHAIN_PROVIDER", "LANGCHAIN_MODEL_NAME", "OPENAI_BASE_URL",
        "LANGCHAIN_REASONING_EFFORT", "LANGCHAIN_USE_RESPONSES_API",
        "LANGCHAIN_TEMPERATURE", "TIMEOUT_SECONDS", "MAX_RETRIES",
        "VIBE_TRADING_SSE_TIMEOUT",
    )
    if name in os.environ
}

# An effort the model rejects fails every run (HTTP 400), so a model/effort
# mismatch in Firestore must degrade to the model's own default, not take Vibe
# down. Only a definite answer from OpenAI counts; an unreachable probe changes
# nothing.
effort = settings.get("LANGCHAIN_REASONING_EFFORT", "").strip().lower()
if effort:
    accepted = asyncio.run(_discover_reasoning_efforts(
        LLM_PROVIDER_BY_NAME["openai"],
        model_name=settings["LANGCHAIN_MODEL_NAME"],
        base_url=settings["OPENAI_BASE_URL"],
        api_key=os.environ["OPENAI_API_KEY"],
    ))
    if accepted.source == "provider" and effort not in accepted.efforts:
        print(
            f"start-vibe: {settings['LANGCHAIN_MODEL_NAME']} does not support "
            f"LANGCHAIN_REASONING_EFFORT={effort!r} (supports "
            f"{', '.join(accepted.efforts) or 'no effort setting'}); using the model default",
            file=sys.stderr,
        )
        settings["LANGCHAIN_REASONING_EFFORT"] = ""
        os.environ.pop("LANGCHAIN_REASONING_EFFORT")

# Native secure-credential mode reads keys from the injected environment.
# Clear stale file credentials; no provider key is copied into this settings file.
settings.update({name: "" for name in _desktop_secure_credential_names()})
settings["OPENROUTER_BASE_URL"] = ""
_write_env_values(ENV_PATH, settings)
os.execvp(sys.argv[1], sys.argv[1:])

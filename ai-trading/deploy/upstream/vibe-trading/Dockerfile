FROM base

# Keep upstream source and pinned dependencies untouched. Its stock image
# omits the optional Anthropic adapter (retained for offline compatibility checks).
USER root
COPY requirements-anthropic.lock /tmp/requirements-anthropic.lock
RUN pip install --no-cache-dir --no-deps --require-hashes -r /tmp/requirements-anthropic.lock \
    && pip check \
    && rm /tmp/requirements-anthropic.lock
COPY start-vibe.py /usr/local/bin/start-vibe.py
USER vibe
CMD ["python", "/usr/local/bin/start-vibe.py", "vibe-trading", "serve", "--host", "0.0.0.0", "--port", "8899"]

FROM base

# Keep upstream source and pinned dependencies untouched. Its stock image
# omits the optional adapter required by our configured Anthropic provider.
USER root
COPY requirements-anthropic.lock /tmp/requirements-anthropic.lock
RUN pip install --no-cache-dir --no-deps --require-hashes -r /tmp/requirements-anthropic.lock \
    && pip check \
    && rm /tmp/requirements-anthropic.lock
USER vibe

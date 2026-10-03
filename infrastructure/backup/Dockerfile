# Pinned by digest so a Docker Hub tag move cannot silently change what
# ships to the VPS. google/cloud-sdk:slim is Debian trixie and already
# carries gcloud + gsutil; apt adds PostgreSQL 17 client tools and age
# straight from the trixie repos (both present there, no PGDG repo needed).
FROM google/cloud-sdk@sha256:7c2dbc4eeba1e500b788be19cae33599cefe3294949a62c034bd1c2002329f69

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-client-17 \
       age \
       jq \
    && rm -rf /var/lib/apt/lists/*

# tar, sha256sum (coreutils), and flock (util-linux) ship in the base image.
RUN command -v tar >/dev/null \
    && command -v sha256sum >/dev/null \
    && command -v flock >/dev/null \
    && command -v pg_dump >/dev/null \
    && command -v pg_restore >/dev/null \
    && command -v age >/dev/null \
    && command -v gcloud >/dev/null

WORKDIR /
COPY lib.sh backup.sh restore.sh recovery-drill.sh /usr/local/lib/family-app-backup/
RUN chmod 0555 /usr/local/lib/family-app-backup/lib.sh \
      /usr/local/lib/family-app-backup/backup.sh \
      /usr/local/lib/family-app-backup/restore.sh \
      /usr/local/lib/family-app-backup/recovery-drill.sh

# Defense in depth: root filesystem is mounted --read-only at `docker run`
# time (see deploy/production/docker-compose.yml backup profile and
# infrastructure/backup/README.md); /staging is a size-bounded tmpfs
# mounted at run time, not baked in here. This image contains no plaintext
# secret and no application data -- only pinned tools and read-only scripts.
ENTRYPOINT ["/usr/local/lib/family-app-backup/backup.sh"]

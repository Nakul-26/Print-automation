# Document-processing tools (Ghostscript) for local development and CI parity.
# Production API/worker images install the same packages themselves.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ghostscript fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]

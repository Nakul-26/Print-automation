# Document-processing tools for local development and CI parity:
# Ghostscript (PDF normalise / grayscale / n-up) and LibreOffice (Office -> PDF).
# The production API image installs the same packages (see Dockerfile.api).
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ghostscript \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      python3 python3-uno \
      fonts-liberation fonts-dejavu-core fonts-crosextra-carlito fonts-crosextra-caladea \
      fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/print-convert
CMD ["sleep", "infinity"]

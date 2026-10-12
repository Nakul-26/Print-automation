# Nightly encrypted PostgreSQL backups to an S3-compatible bucket (Cloudflare R2), each one
# test-restored before it is uploaded. pg_dump must match the server's major version.
FROM postgres:17-alpine
RUN apk add --no-cache bash rclone age curl tzdata
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh \
 && mkdir -p /backups /work && chown postgres:postgres /backups /work
USER postgres
HEALTHCHECK --interval=5m --timeout=10s --start-period=3m --retries=1 \
  CMD test -n "$(find /backups/last-success -mmin -1560 2>/dev/null)"
ENTRYPOINT ["backup.sh"]
CMD ["run"]

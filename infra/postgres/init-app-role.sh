#!/bin/sh
# Runs once, when the database volume is first created.
#
# The app never connects as the Postgres superuser. It gets `print_app`: it owns only the `print`
# database (it must, to run migrations and let pg-boss manage its own schema) but cannot read files
# or run programs on the server, create roles or databases, or touch any other database.
# The superuser password stays on the postgres and backup services only.
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" \
  --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE print_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE print OWNER print_app;
REVOKE ALL ON DATABASE print FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL

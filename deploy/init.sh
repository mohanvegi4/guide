#!/bin/sh
# Runs once on the first start of the Postgres container (as the superuser).
# Creates the two application roles with passwords from the environment:
#   guide_engine  — the backend's role: NOSUPERUSER NOBYPASSRLS, so Row-Level
#                   Security always applies (the backend refuses to boot otherwise)
#   keycloak      — Keycloak's own database
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE guide_engine LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE DATABASE guide_engine OWNER guide_engine;
CREATE ROLE keycloak LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE DATABASE keycloak OWNER keycloak;
SQL

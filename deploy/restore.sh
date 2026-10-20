#!/bin/sh
# Restores one database of the deploy/ stack from a dump that backup.sh wrote.
# Run on the host, from this directory's docker compose project:
#
#   ./restore.sh guide_engine backups/guide_engine-20261019T030000Z.dump --yes
#   ./restore.sh keycloak     backups/keycloak-20261019T030000Z.dump     --yes
#
# In order:
#   1. stops the services that use the database (backend and studio; for
#      keycloak also Keycloak itself), so nothing writes during the restore
#   2. dumps the database as it is now to backups/<db>-pre-restore-<stamp>.dump,
#      so a restore of the wrong file can itself be undone (best effort: a
#      database that is already broken may not dump, and that is no reason
#      to stop restoring it)
#   3. drops and recreates the database, owned by its application role
#   4. pg_restore in a single transaction: the result is the dump, or the
#      empty database and an error — never half of each
#   5. starts the services again (the backend applies any migrations newer
#      than the dump) and prints the backend's /ready answer
#
# Without --yes it only prints this plan for the given arguments and exits 1.
# The dump must be in ./backups: that is the directory the postgres container
# can see (copy it there first if it came from off-host storage).
set -eu

usage() {
  echo "usage: restore.sh <guide_engine|keycloak> <backups/NAME.dump> --yes" >&2
  exit 2
}

db=''
dump=''
yes=false
for arg in "$@"; do
  case "$arg" in
    --yes) yes=true ;;
    -*) usage ;;
    *) if [ -z "$db" ]; then db=$arg; elif [ -z "$dump" ]; then dump=$arg; else usage; fi ;;
  esac
done
[ -n "$db" ] && [ -n "$dump" ] || usage

case "$db" in
  # Each database is owned by its own application role (init.sh); the backend
  # refuses to start unless guide_engine owns its database.
  guide_engine) owner=guide_engine; services='backend studio' ;;
  keycloak)     owner=keycloak;     services='keycloak backend studio' ;;
  *) echo "restore.sh: unknown database '$db' (guide_engine or keycloak)" >&2; exit 2 ;;
esac

# The dump path is relative to where the operator typed it; make it absolute
# before moving into deploy/, the compose project directory (as render-realm.sh does).
case "$dump" in
  /*) ;;
  *) dump="$PWD/$dump" ;;
esac
cd "$(dirname "$0")"

name=$(basename "$dump")
if [ ! -f "$dump" ]; then
  echo "restore.sh: no such file: $dump" >&2
  exit 2
fi
if [ ! "$dump" -ef "backups/$name" ]; then
  echo "restore.sh: the dump must be inside $(pwd)/backups/ (the only directory the postgres container sees); copy it there first" >&2
  exit 2
fi
case "$name" in
  "$db"-*) ;;
  *) echo "restore.sh: $name does not look like a dump of $db (backup.sh names them <database>-<timestamp>.dump)" >&2; exit 2 ;;
esac

stamp=$(date -u +%Y%m%dT%H%M%SZ)
cat <<PLAN
restore.sh will, in the compose project at $(pwd):
  1. docker compose stop $services
  2. dump the current $db to backups/$db-pre-restore-$stamp.dump (best effort)
  3. DROP DATABASE $db WITH (FORCE); CREATE DATABASE $db OWNER $owner
  4. pg_restore --single-transaction backups/$name into $db
  5. docker compose up -d --wait $services, then GET /ready on the backend
Every row currently in $db is replaced by the dump.
PLAN
if [ "$yes" != true ]; then
  echo "Nothing done. Add --yes to run it."
  exit 1
fi

pg() { docker compose exec -T postgres "$@"; }

echo "==> stopping $services"
docker compose stop $services

echo "==> safety dump of the current $db"
if ! pg pg_dump -U postgres --format=custom --dbname="$db" --file="/backups/$db-pre-restore-$stamp.dump"; then
  echo "    (could not dump the current $db; continuing with the restore)"
fi

echo "==> recreating $db"
pg psql -U postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$db\" OWNER \"$owner\""

echo "==> restoring $name"
pg pg_restore -U postgres --dbname="$db" --single-transaction --exit-on-error "/backups/$name"

echo "==> starting $services"
docker compose up -d --wait $services

echo "==> backend /ready:"
docker compose exec -T backend wget -qO- http://127.0.0.1:3000/ready
echo
echo "restored $db from backups/$name (the previous contents are in backups/$db-pre-restore-$stamp.dump)"

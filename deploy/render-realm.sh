#!/bin/sh
# Writes keycloak-import/guide-engine-realm.json from the development realm,
# with the Studio's public URL in the client's redirect URIs and web origins.
# Keycloak imports it on first start only; later changes are made in the
# admin console (or delete the realm and restart to re-import).
set -e
cd "$(dirname "$0")"
. ./.env
mkdir -p keycloak-import
sed "s#http://localhost:4300#https://${STUDIO_HOST}#g" ../docker/keycloak/guide-engine-realm.json \
  > keycloak-import/guide-engine-realm.json
echo "wrote keycloak-import/guide-engine-realm.json for https://${STUDIO_HOST}"
echo "note: the three test users (olivia / eddie / root) are in it — delete them in the admin console on a real deployment."

#!/bin/sh
# Writes keycloak-import/guide-engine-realm.json, the realm Keycloak imports on
# its first start, from the DEVELOPMENT realm in docker/keycloak/. The
# development realm is what `npm run idp:up`, the e2e test and CI use, so it
# stays as it is; this script makes the production copy safe by construction:
#
#   - the `users` array is removed entirely (the three test users with
#     password = username must never exist on a real deployment; the first
#     real user is created in the admin console, see README "Deploying")
#   - brute-force detection is turned on for the realm
#   - the Studio client's redirect URIs, web origins, root URL and post-logout
#     URIs are exactly https://STUDIO_HOST (no localhost left anywhere)
#   - everything else (client, PKCE, audience mapper, token lifetimes) is
#     copied unchanged, and the lifetimes are printed so you can judge them
#
# Requires jq (https://jqlang.github.io/jq/; `apt install jq` / `brew install jq`).
# Later changes to the realm are made in the admin console: Keycloak imports
# the file on first start only (or delete the realm and restart to re-import).
set -eu
cd "$(dirname "$0")"

if ! command -v jq >/dev/null 2>&1; then
  echo "render-realm.sh: jq is required (apt install jq / brew install jq)" >&2
  exit 1
fi
if [ -f ./.env ]; then
  # shellcheck disable=SC1091
  . ./.env
fi
if [ -z "${STUDIO_HOST:-}" ]; then
  echo "render-realm.sh: set STUDIO_HOST in deploy/.env (the Studio's public hostname, e.g. studio.example.com)" >&2
  exit 1
fi
case "$STUDIO_HOST" in
  *://*|*/*|*' '*)
    echo "render-realm.sh: STUDIO_HOST must be a bare hostname (no scheme, path or spaces): '$STUDIO_HOST'" >&2
    exit 1 ;;
esac

src=../docker/keycloak/guide-engine-realm.json
out=keycloak-import/guide-engine-realm.json
studio="https://${STUDIO_HOST}"

# Brute-force detection (realm → Security defenses → Brute force detection).
# Temporary lockouts only: a wrong password 5 times locks the user for 1 min,
# each further failure adds a minute, up to 15 min; the failure count resets
# after 12 h without one. No permanent lockout, so an attacker can't lock a
# real user out for good by guessing their username.
failure_factor=5
wait_increment=60
max_failure_wait=900
max_delta_time=43200

mkdir -p keycloak-import
jq --arg studio "$studio" \
   --argjson failureFactor "$failure_factor" \
   --argjson waitIncrementSeconds "$wait_increment" \
   --argjson maxFailureWaitSeconds "$max_failure_wait" \
   --argjson maxDeltaTimeSeconds "$max_delta_time" '
  del(.users)
  | .bruteForceProtected = true
  | .permanentLockout = false
  | .failureFactor = $failureFactor
  | .waitIncrementSeconds = $waitIncrementSeconds
  | .maxFailureWaitSeconds = $maxFailureWaitSeconds
  | .maxDeltaTimeSeconds = $maxDeltaTimeSeconds
  | .clients |= map(
      if .clientId == "guide-studio" then
        .rootUrl = $studio
        | .redirectUris = [$studio + "/*"]
        | .webOrigins = [$studio]
        | .attributes["post.logout.redirect.uris"] = ($studio + "/*")
      else . end)
' "$src" > "$out.tmp"

# Belt and braces: the rendered realm must contain no development leftovers.
if grep -q 'localhost' "$out.tmp"; then
  rm -f "$out.tmp"
  echo "render-realm.sh: the rendered realm still mentions localhost; refusing to write it" >&2
  exit 1
fi
if [ "$(jq '.users // [] | length' "$out.tmp")" != "0" ]; then
  rm -f "$out.tmp"
  echo "render-realm.sh: the rendered realm still contains users; refusing to write it" >&2
  exit 1
fi
mv "$out.tmp" "$out"

echo "wrote $out for $studio"
echo "  stripped users:        $(jq -r '[.users[]?.username] | join(", ")' "$src") (the realm now has no users)"
echo "  brute force:           on — lock after $failure_factor failures for ${wait_increment}s, +${wait_increment}s per failure up to ${max_failure_wait}s; failures reset after $((max_delta_time / 3600))h; no permanent lockout"
echo "  guide-studio client:   redirectUris [$studio/*], webOrigins [$studio], post-logout $studio/*"
echo "  kept from dev realm:   accessTokenLifespan $(jq '.accessTokenLifespan' "$out")s, ssoSessionIdleTimeout $(jq '.ssoSessionIdleTimeout' "$out")s, ssoSessionMaxLifespan $(jq '.ssoSessionMaxLifespan' "$out")s (change in the admin console if you want shorter sessions)"
echo "Next: create the first user in the admin console (https://${AUTH_HOST:-<AUTH_HOST>}/admin) — see README, Deploying."

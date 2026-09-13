#!/bin/bash
# Foresight — cPanel deploy script.
#
# Runs INSIDE the cPanel account. It is started once by a temporary cron entry that
# the GitHub Actions workflow (.github/workflows/deploy-cpanel.yml) creates through the
# cPanel API, right after uploading foresight-cpanel.zip to the home directory:
#
#   cd $HOME && unzip -oj foresight-cpanel.zip foresight/deploy.sh foresight/deploy.conf -d $HOME && bash $HOME/deploy.sh
#
# It unpacks the release, optionally moves the current public_html aside, registers the
# app with the CloudLinux Node.js Selector (the engine behind cPanel's "Setup Node.js App"),
# installs production dependencies and restarts. Progress goes to ~/foresight-deploy.log and
# the final state to ~/foresight-deploy.status ("OK" or "FAILED_<reason>").
set -u
cd "$HOME" || exit 1
LOG="$HOME/foresight-deploy.log"
STATUS="$HOME/foresight-deploy.status"
exec >>"$LOG" 2>&1

fail() {
  echo "FAILED_$1" >"$STATUS"
  echo "=== deploy FAILED ($1) $(date -u +%FT%TZ)"
  self_remove_cron
  exit 1
}

self_remove_cron() {
  # The cron entry is single-use; drop it so the deploy never re-runs by accident.
  (crontab -l 2>/dev/null | grep -v 'foresight-cpanel.zip' | crontab -) || true
}

echo "=== deploy start $(date -u +%FT%TZ) as $(whoami) in $HOME"
rm -f "$STATUS"

# deploy.conf is written by the workflow: DOMAIN, WIPE_PUBLIC_HTML, ENV_JSON (one line).
if [ ! -f "$HOME/deploy.conf" ]; then fail "NO_CONF"; fi
# shellcheck disable=SC1091
source "$HOME/deploy.conf"
: "${DOMAIN:?}" "${WIPE_PUBLIC_HTML:=1}" "${ENV_JSON:?}"

[ -f foresight-cpanel.zip ] || fail "NO_ZIP"
# Consume the zip immediately so a second cron tick (deploys take minutes) is a no-op.
mv -f foresight-cpanel.zip foresight-release.zip

# ---- unpack release, keep persisted data ------------------------------------
rm -rf foresight.new && mkdir foresight.new
unzip -oq foresight-release.zip -d foresight.new || fail "UNZIP"
[ -d foresight.new/foresight ] || fail "ZIP_LAYOUT"
if [ -d foresight/data ]; then
  echo "preserving existing data/ (state.json)"
  cp -a foresight/data foresight.new/foresight/
fi
if [ -d foresight/node_modules ]; then
  echo "reusing node_modules from previous release to speed up install"
  mv foresight/node_modules foresight.new/foresight/
fi
rm -rf foresight.old
[ -d foresight ] && mv foresight foresight.old
mv foresight.new/foresight foresight && rm -rf foresight.new
echo "release unpacked to $HOME/foresight"

# ---- Node.js Selector ---------------------------------------------------------
SEL=""
for c in /usr/sbin/cloudlinux-selector /usr/bin/cloudlinux-selector; do
  [ -x "$c" ] && SEL="$c" && break
done
[ -n "$SEL" ] || fail "NO_NODEJS_SELECTOR"

INFO="$($SEL get --json --interpreter nodejs 2>/dev/null || true)"
echo "selector info: ${INFO:0:800}"
NODE_VERSION=""
for v in 22 20 18; do
  if echo "$INFO" | grep -q "\"$v\""; then NODE_VERSION="$v"; break; fi
done
[ -n "$NODE_VERSION" ] || NODE_VERSION=20
echo "using Node.js $NODE_VERSION"

# ---- optionally move the current website aside --------------------------------
if [ "$WIPE_PUBLIC_HTML" = "1" ] && [ -d public_html ]; then
  TS="$(date +%Y%m%d%H%M%S)"
  BK="$HOME/backup_public_html_$TS"
  mkdir -p "$BK"
  echo "moving current public_html contents to $BK"
  find public_html -mindepth 1 -maxdepth 1 ! -name '.well-known' -exec mv -f {} "$BK"/ \;
fi

# ---- (re)create the application -----------------------------------------------
# A stale registration keeps old settings/.htaccess; recreate for a clean state.
$SEL destroy --json --interpreter nodejs --app-root foresight >/dev/null 2>&1 || true
echo "creating application on $DOMAIN"
if ! $SEL create --json --interpreter nodejs --version "$NODE_VERSION" --app-root foresight \
  --domain "$DOMAIN" --app-uri / --app-mode production --startup-file app.cjs --env-vars "$ENV_JSON"; then
  fail "SELECTOR_CREATE"
fi
echo "installing production dependencies (npm install)"
$SEL install-modules --json --interpreter nodejs --app-root foresight || fail "NPM_INSTALL"
echo "restarting"
$SEL restart --json --interpreter nodejs --app-root foresight || fail "RESTART"

echo "OK" >"$STATUS"
echo "=== deploy OK $(date -u +%FT%TZ)"
self_remove_cron
exit 0

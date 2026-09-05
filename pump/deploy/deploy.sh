#!/bin/bash
# Noxia (pump) — cPanel deploy script. Generalised copy of Foresight's deploy/cpanel/deploy.sh.
#
# Runs INSIDE the cPanel account. It is started once by a temporary cron entry that
# the GitHub Actions workflow (.github/workflows/deploy-pump.yml) creates through the
# cPanel API, right after uploading ${APP_ROOT}-cpanel.zip to the home directory:
#
#   cd $HOME && unzip -p noxia-pump-cpanel.zip noxia-pump/deploy.sh > $HOME/noxia-pump-deploy.sh \
#     && bash $HOME/noxia-pump-deploy.sh $HOME/noxia-pump-deploy.conf
#
# It unpacks the release, optionally moves the current public_html aside, registers the
# app with the CloudLinux Node.js Selector (the engine behind cPanel's "Setup Node.js App"),
# installs production dependencies and restarts. Progress goes to ~/${APP_ROOT}-deploy.log and
# the final state to ~/${APP_ROOT}-deploy.status ("OK" or "FAILED_<reason>").
#
# Foresight (~/foresight, ~/deploy.conf, ~/foresight-deploy.*) and this app can share one
# cPanel account: every file this script touches carries the ${APP_ROOT} prefix.
#
# Config (sourced from $1, default ~/noxia-pump-deploy.conf; written by the workflow):
#   APP_ROOT          app folder / Node.js Selector app-root (default noxia-pump)
#   DOMAIN            domain the app is served on (required, e.g. app.noxia.work)
#   WIPE_PUBLIC_HTML  1 = move the main domain's public_html contents to a backup (default 0)
#   ZIP_NAME          uploaded release zip (default ${APP_ROOT}-cpanel.zip)
#   ENV_JSON          JSON object with the app's environment variables (required)
set -u
cd "$HOME" || exit 1

CONF="${1:-$HOME/noxia-pump-deploy.conf}"
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  source "$CONF"
fi
APP_ROOT="${APP_ROOT:-noxia-pump}"
ZIP_NAME="${ZIP_NAME:-${APP_ROOT}-cpanel.zip}"
WIPE_PUBLIC_HTML="${WIPE_PUBLIC_HTML:-0}"

LOG="$HOME/${APP_ROOT}-deploy.log"
STATUS="$HOME/${APP_ROOT}-deploy.status"
exec >>"$LOG" 2>&1

self_remove_cron() {
  # The cron entry is single-use; drop it so the deploy never re-runs by accident.
  (crontab -l 2>/dev/null | grep -v -F "$ZIP_NAME" | crontab -) || true
}

fail() {
  echo "FAILED_$1" >"$STATUS"
  echo "=== deploy FAILED ($1) $(date -u +%FT%TZ)"
  self_remove_cron
  exit 1
}

echo "=== deploy start $(date -u +%FT%TZ) as $(whoami) in $HOME (app-root $APP_ROOT)"
rm -f "$STATUS"

[ -f "$CONF" ] || fail "NO_CONF"
[ -n "${DOMAIN:-}" ] || fail "NO_DOMAIN"
[ -n "${ENV_JSON:-}" ] || fail "NO_ENV_JSON"

[ -f "$ZIP_NAME" ] || fail "NO_ZIP"
# Consume the zip immediately so a second cron tick (deploys take minutes) is a no-op.
RELEASE_ZIP="${APP_ROOT}-release.zip"
mv -f "$ZIP_NAME" "$RELEASE_ZIP"

# ---- unpack release, keep persisted data ------------------------------------
NEW="${APP_ROOT}.new"
OLD="${APP_ROOT}.old"
rm -rf "$NEW" && mkdir "$NEW"
unzip -oq "$RELEASE_ZIP" -d "$NEW" || fail "UNZIP"
[ -d "$NEW/$APP_ROOT" ] || fail "ZIP_LAYOUT"
if [ -d "$APP_ROOT/data" ]; then
  # data/ holds state.json AND data/uploads (coin images, comment attachments, avatars).
  # Move (not copy): uploads can grow large and a copy would double the disk usage.
  echo "preserving existing data/ (state.json + uploads)"
  rm -rf "$NEW/$APP_ROOT/data"
  mv "$APP_ROOT/data" "$NEW/$APP_ROOT/data" || fail "PRESERVE_DATA"
fi
mkdir -p "$NEW/$APP_ROOT/data/uploads/coins" "$NEW/$APP_ROOT/data/uploads/comments" "$NEW/$APP_ROOT/data/uploads/avatars"
if [ -d "$APP_ROOT/node_modules" ]; then
  echo "reusing node_modules from previous release to speed up install"
  mv "$APP_ROOT/node_modules" "$NEW/$APP_ROOT/"
fi
rm -rf "$OLD"
[ -d "$APP_ROOT" ] && mv "$APP_ROOT" "$OLD"
mv "$NEW/$APP_ROOT" "$APP_ROOT" && rm -rf "$NEW"
echo "release unpacked to $HOME/$APP_ROOT"

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
# Only relevant when DOMAIN is the main domain; for a subdomain (app.noxia.work) its
# document root is public_html/<label> and nothing else is touched.
if [ "$WIPE_PUBLIC_HTML" = "1" ] && [ -d public_html ]; then
  TS="$(date +%Y%m%d%H%M%S)"
  BK="$HOME/backup_public_html_$TS"
  mkdir -p "$BK"
  echo "moving current public_html contents to $BK"
  find public_html -mindepth 1 -maxdepth 1 ! -name '.well-known' -exec mv -f {} "$BK"/ \;
fi

# ---- (re)create the application -----------------------------------------------
# A stale registration keeps old settings/.htaccess; recreate for a clean state.
$SEL destroy --json --interpreter nodejs --app-root "$APP_ROOT" >/dev/null 2>&1 || true
# The selector exits 0 even when it refuses an operation (it reports {"result": "<error text>"}
# instead), so every step checks the JSON result rather than the exit code.
sel_ok() { echo "$1" | grep -q '"result": *"success"'; }

echo "creating application on $DOMAIN"
OUT="$($SEL create --json --interpreter nodejs --version "$NODE_VERSION" --app-root "$APP_ROOT" \
  --domain "$DOMAIN" --app-uri / --app-mode production --startup-file app.cjs --env-vars "$ENV_JSON" 2>&1)"
echo "$OUT"
sel_ok "$OUT" || fail "SELECTOR_CREATE"

echo "installing production dependencies (npm install)"
OUT="$($SEL install-modules --json --interpreter nodejs --app-root "$APP_ROOT" 2>&1)"
echo "$OUT"
if ! sel_ok "$OUT"; then
  # The selector refuses to install while the domain does not resolve yet ("Web application
  # is inaccessible by its address"). npm inside the app's own nodevenv does not care.
  echo "selector install refused; running npm inside the app's nodevenv instead"
  VENV="$HOME/nodevenv/$APP_ROOT/$NODE_VERSION/bin/activate"
  if [ -f "$VENV" ]; then
    # shellcheck disable=SC1090
    ( source "$VENV" && cd "$HOME/$APP_ROOT" && npm install --omit=dev --no-audit --no-fund --loglevel=error ) || fail "NPM_INSTALL"
  else
    NPM_BIN="/opt/alt/alt-nodejs$NODE_VERSION/root/usr/bin/npm"
    [ -x "$NPM_BIN" ] || fail "NPM_INSTALL_NO_NPM"
    ( cd "$HOME/$APP_ROOT" && "$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error ) || fail "NPM_INSTALL"
  fi
fi
[ -d "$HOME/$APP_ROOT/node_modules/express" ] || fail "NPM_INSTALL_INCOMPLETE"
if [ ! -d "$HOME/$APP_ROOT/node_modules/sharp" ]; then
  echo "WARNING: sharp did not install; uploaded images will be stored unprocessed"
fi

echo "restarting"
OUT="$($SEL restart --json --interpreter nodejs --app-root "$APP_ROOT" 2>&1)"
echo "$OUT"
sel_ok "$OUT" || fail "RESTART"

echo "OK" >"$STATUS"
echo "=== deploy OK $(date -u +%FT%TZ)"
self_remove_cron
exit 0

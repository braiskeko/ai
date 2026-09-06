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
  if [ "${WIPE_DATA:-0}" = "1" ]; then
    # Deliberate reset: keep a dated copy of the snapshot, then start from an empty database.
    TS="$(date +%Y%m%d%H%M%S)"
    if [ -f "$NEW/$APP_ROOT/data/state.json" ]; then
      cp "$NEW/$APP_ROOT/data/state.json" "$HOME/${APP_ROOT}-state-backup-$TS.json"
      echo "WIPE_DATA=1: previous state saved to ~/${APP_ROOT}-state-backup-$TS.json and removed"
    fi
    rm -f "$NEW/$APP_ROOT/data/state.json"
  fi
fi
# A release must never arrive with an empty database when a snapshot of the real
# one is sitting in the home directory: restore the newest backup instead, so a
# reset that happened once does not repeat itself on every deploy.
if [ ! -f "$NEW/$APP_ROOT/data/state.json" ] && [ "${WIPE_DATA:-0}" != "1" ]; then
  LAST_BACKUP="$(ls -1t "$HOME/${APP_ROOT}"-state-backup-*.json 2>/dev/null | head -1 || true)"
  if [ -n "$LAST_BACKUP" ]; then
    mkdir -p "$NEW/$APP_ROOT/data"
    cp "$LAST_BACKUP" "$NEW/$APP_ROOT/data/state.json"
    echo "no database in this release; restored $(basename "$LAST_BACKUP")"
  fi
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
  # is inaccessible by its address"). Plain npm from the same Node.js build does not care.
  # node_modules is a symlink into ~/nodevenv/<app>/<version>/lib created by `create`, so the
  # packages land exactly where the selector expects them.
  ALT_BIN="/opt/alt/alt-nodejs$NODE_VERSION/root/usr/bin"
  if [ -x "$ALT_BIN/npm" ]; then
    echo "selector install refused; running $ALT_BIN/npm directly"
    ( cd "$HOME/$APP_ROOT" && PATH="$ALT_BIN:$PATH" timeout 900 "$ALT_BIN/npm" install --omit=dev --no-audit --no-fund --loglevel=error </dev/null ) || fail "NPM_INSTALL"
  else
    echo "selector install refused; running npm inside the app's nodevenv instead"
    VENV="$HOME/nodevenv/$APP_ROOT/$NODE_VERSION/bin/activate"
    [ -f "$VENV" ] || fail "NPM_INSTALL_NO_NPM"
    # The activate script references unset variables; relax `set -u` inside the subshell.
    # shellcheck disable=SC1090
    ( set +u; source "$VENV" && cd "$HOME/$APP_ROOT" && timeout 900 npm install --omit=dev --no-audit --no-fund --loglevel=error </dev/null ) || fail "NPM_INSTALL"
  fi
  echo "npm install finished"
fi
[ -d "$HOME/$APP_ROOT/node_modules/express" ] || fail "NPM_INSTALL_INCOMPLETE"
if [ ! -d "$HOME/$APP_ROOT/node_modules/sharp" ]; then
  echo "WARNING: sharp did not install; uploaded images will be stored unprocessed"
fi

echo "restarting"
OUT="$(timeout 180 $SEL restart --json --interpreter nodejs --app-root "$APP_ROOT" 2>&1)"
echo "$OUT"
if ! sel_ok "$OUT"; then
  # Passenger (re)starts the app on the next request when tmp/restart.txt is touched, and the
  # selector refuses to restart while the domain does not resolve — so do not fail on this.
  echo "WARNING: selector restart refused; touching tmp/restart.txt for Passenger instead"
  mkdir -p "$HOME/$APP_ROOT/tmp" && touch "$HOME/$APP_ROOT/tmp/restart.txt"
fi

echo "OK" >"$STATUS"
echo "=== deploy OK $(date -u +%FT%TZ)"
self_remove_cron
exit 0

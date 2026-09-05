#!/usr/bin/env bash
# Builds Noxia (pump) and produces noxia-pump-cpanel.zip, ready to upload to a cPanel
# host that offers "Setup Node.js App" (CloudLinux Node.js Selector / Passenger).
# Same mechanism as Foresight's scripts/package-cpanel.sh; see pump/README.md.
#
#   cd pump && bash scripts/package-cpanel.sh
#
# Env:
#   APP_ROOT   folder name inside the zip and on the host (default noxia-pump)
#   SKIP_BUILD set to 1 to reuse an existing dist/ (CI runs the build itself)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ROOT="${APP_ROOT:-noxia-pump}"
ZIP_NAME="${APP_ROOT}-cpanel.zip"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "› building client + server"
  npm run build
fi
[ -f dist/index.js ] || { echo "dist/index.js missing — build failed?" >&2; exit 1; }
[ -d dist/public ] || { echo "dist/public missing — client build failed?" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$APP_ROOT"
cp -r dist "$STAGE/$APP_ROOT/dist"
cp package.json package-lock.json "$STAGE/$APP_ROOT/"
[ -f .env.example ] && cp .env.example "$STAGE/$APP_ROOT/"
[ -f README.md ] && cp README.md "$STAGE/$APP_ROOT/LEEME.md"
cp deploy/deploy.sh "$STAGE/$APP_ROOT/deploy.sh"
chmod +x "$STAGE/$APP_ROOT/deploy.sh"
# Uploads (coin images, comment attachments) live under data/; ship the folders so
# the very first release can write to them before the persister creates data/.
mkdir -p "$STAGE/$APP_ROOT/data/uploads/coins" "$STAGE/$APP_ROOT/data/uploads/comments" "$STAGE/$APP_ROOT/data/uploads/avatars"

# Passenger loads the "startup file" with require(); a CommonJS shim keeps that working
# on every Node version while the server itself stays an ES module bundle.
cat > "$STAGE/$APP_ROOT/app.cjs" <<'EOF'
process.env.NODE_ENV = process.env.NODE_ENV || "production";
import("./dist/index.js").catch((err) => {
  console.error("failed to start Noxia", err);
  process.exit(1);
});
EOF

# Production-only manifest: cPanel's "Run NPM Install" reads this package.json.
node - "$STAGE/$APP_ROOT/package.json" <<'EOF'
const fs = require("fs");
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
delete pkg.devDependencies;
delete pkg.optionalDependencies;
pkg.scripts = { start: "node app.cjs" };
pkg.engines = { node: ">=20" };
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
EOF

rm -f "$ZIP_NAME"
(cd "$STAGE" && zip -qr "$OLDPWD/$ZIP_NAME" "$APP_ROOT")
echo "› wrote $(du -h "$ZIP_NAME" | cut -f1) $ZIP_NAME"

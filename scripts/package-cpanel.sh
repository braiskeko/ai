#!/usr/bin/env bash
# Builds the app and produces foresight-cpanel.zip, ready to upload to a cPanel
# host that offers "Setup Node.js App" (CloudLinux Node.js Selector / Passenger).
# See docs/DEPLOY_CPANEL.md for the step-by-step guide.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "› building client + server"
npm run build

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/foresight"
cp -r dist "$STAGE/foresight/dist"
cp package.json package-lock.json .env.example "$STAGE/foresight/"
cp docs/DEPLOY_CPANEL.md "$STAGE/foresight/LEEME-CPANEL.md"
cp deploy/cpanel/deploy.sh "$STAGE/foresight/deploy.sh"

# Passenger loads the "startup file" with require(); a CommonJS shim keeps that working
# on every Node version while the server itself stays an ES module bundle.
cat > "$STAGE/foresight/app.cjs" <<'EOF'
process.env.NODE_ENV = process.env.NODE_ENV || "production";
import("./dist/index.js").catch((err) => {
  console.error("failed to start Foresight", err);
  process.exit(1);
});
EOF

# Production-only manifest: cPanel's "Run NPM Install" reads this package.json.
node - "$STAGE/foresight/package.json" <<'EOF'
const fs = require("fs");
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
delete pkg.devDependencies;
delete pkg.optionalDependencies;
pkg.scripts = { start: "node app.cjs" };
pkg.engines = { node: ">=20" };
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
EOF

rm -f foresight-cpanel.zip
(cd "$STAGE" && zip -qr "$OLDPWD/foresight-cpanel.zip" foresight)
echo "› wrote $(du -h foresight-cpanel.zip | cut -f1) foresight-cpanel.zip"

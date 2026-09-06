/**
 * Deploys foresight-cpanel.zip to a cPanel account using only the cPanel HTTP API
 * (no SSH). Runs from GitHub Actions (see .github/workflows/deploy-cpanel.yml) or
 * from any machine that can reach the cPanel host.
 *
 *   CPANEL_HOST=noxia.work CPANEL_USER=... CPANEL_TOKEN=... DOMAIN=noxia.work \
 *   APP_URL=https://noxia.work ADMIN_EMAILS=me@x.com node scripts/cpanel-remote-deploy.mjs
 *
 * Steps: upload the zip (UAPI Fileman/upload_files) → schedule deploy/cpanel/deploy.sh
 * through a single-use cron entry (API2 Cron::add_line) → poll ~/foresight-deploy.status →
 * print the deploy log → verify https://APP_URL/api/config.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const env = (k, fallback) => {
  const v = process.env[k]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  console.error(`missing required env ${k}`);
  process.exit(2);
};

const HOST = env("CPANEL_HOST");
const USER = env("CPANEL_USER");
const TOKEN = env("CPANEL_TOKEN");
const DOMAIN = env("DOMAIN", HOST);
const APP_URL = env("APP_URL", `https://${DOMAIN}`);
const ADMIN_EMAILS = env("ADMIN_EMAILS", "");
const CHAIN = env("CHAIN", "amoy");
const WIPE = env("WIPE_PUBLIC_HTML", "1");
const SESSION_SECRET = env("SESSION_SECRET", randomBytes(32).toString("hex"));
const ZIP = env("ZIP_PATH", "foresight-cpanel.zip");
const INITIAL_CREDITS = env("INITIAL_CREDITS", "");
const PORT = env("CPANEL_PORT", "2083");
const TIMEOUT_MIN = Number(env("DEPLOY_TIMEOUT_MIN", "20"));

const base = `https://${HOST}:${PORT}`;
const authHeaders = { Authorization: `cpanel ${USER}:${TOKEN}` };
const homeDir = `/home/${USER}`;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function uapi(fn, params = {}, body) {
  const url = new URL(`${base}/execute/${fn}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method: body ? "POST" : "GET", headers: authHeaders, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${fn}: HTTP ${res.status} non-JSON response: ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.status !== 1) {
    throw new Error(`${fn}: HTTP ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 500)}`);
  }
  return json.data;
}

async function api2(module, func, params = {}) {
  const url = new URL(`${base}/json-api/cpanel`);
  url.searchParams.set("cpanel_jsonapi_user", USER);
  url.searchParams.set("cpanel_jsonapi_apiversion", "2");
  url.searchParams.set("cpanel_jsonapi_module", module);
  url.searchParams.set("cpanel_jsonapi_func", func);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: authHeaders });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${module}::${func}: HTTP ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  const r = json.cpanelresult ?? {};
  if (r.error || (r.event && r.event.result === 0)) {
    throw new Error(`${module}::${func}: ${r.error ?? JSON.stringify(r).slice(0, 500)}`);
  }
  return r.data ?? r;
}

async function uploadFile(localPath, remoteDir) {
  const form = new FormData();
  form.set("dir", remoteDir);
  form.set("overwrite", "1");
  const bytes = fs.readFileSync(localPath);
  form.set("file-1", new Blob([bytes]), path.basename(localPath));
  const data = await uapi("Fileman/upload_files", { overwrite: 1 }, form);
  const failed = (data?.failed ?? []).length;
  if (failed) throw new Error(`upload reported failures: ${JSON.stringify(data)}`);
  return data;
}

async function readRemoteFile(remotePath) {
  const dir = path.posix.dirname(remotePath);
  const file = path.posix.basename(remotePath);
  try {
    const data = await uapi("Fileman/get_file_content", { dir, file });
    return data?.content ?? null;
  } catch (e) {
    if (/does not exist|No such file|not found/i.test(e.message)) return null;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(ZIP)) throw new Error(`${ZIP} not found — run scripts/package-cpanel.sh first`);

  // 0. connectivity + account sanity check
  log(`connecting to ${base} as ${USER}`);
  const files = await uapi("Fileman/list_files", { dir: homeDir, types: "dir", limit_to_list: 1 });
  log(`ok, home has ${Array.isArray(files) ? files.length : "?"} directories`);

  // 1. deploy.conf consumed by deploy.sh on the host (shell-sourced; values single-quoted)
  const envVars = {
    NODE_ENV: "production",
    APP_URL,
    SESSION_SECRET,
    ADMIN_EMAILS,
    CHAIN,
    INSTANT_EMAIL_LOGIN: "1",
    DEPOSITS_ENABLED: "1",
    ...(INITIAL_CREDITS ? { INITIAL_CREDITS } : {}),
  };
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const conf = [
    `DOMAIN=${sq(DOMAIN)}`,
    `WIPE_PUBLIC_HTML=${sq(WIPE)}`,
    `ENV_JSON=${sq(JSON.stringify(envVars))}`,
    "",
  ].join("\n");
  const confPath = path.join(path.dirname(ZIP), "deploy.conf");
  fs.writeFileSync(confPath, conf);

  // 2. upload zip + conf; blank out the previous run's status file and remember the
  //    current log length so we only react to THIS deploy's output.
  log(`uploading ${ZIP} (${(fs.statSync(ZIP).size / 1024).toFixed(0)} KB)`);
  await uploadFile(ZIP, homeDir);
  await uploadFile(confPath, homeDir);
  const statusPath = path.join(path.dirname(ZIP), "foresight-deploy.status");
  fs.writeFileSync(statusPath, "");
  await uploadFile(statusPath, homeDir);
  const previousLog = (await readRemoteFile(`${homeDir}/foresight-deploy.log`)) ?? "";
  log("uploaded");

  // 3. schedule the single-use deploy cron (fires on the next minute boundary)
  const cmd =
    `cd ${homeDir} && unzip -oj foresight-cpanel.zip foresight/deploy.sh -d ${homeDir} >/dev/null 2>&1 && ` +
    `/bin/bash ${homeDir}/deploy.sh`;
  log("scheduling deploy via cron");
  await api2("Cron", "add_line", { command: cmd, minute: "*", hour: "*", day: "*", month: "*", weekday: "*" });
  log("cron scheduled; the deploy starts within ~60s and takes a few minutes (npm install)");

  // 4. poll status
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let status = null;
  let lastLogLen = previousLog.length;
  while (Date.now() < deadline) {
    await sleep(20_000);
    const logText = (await readRemoteFile(`${homeDir}/foresight-deploy.log`)) ?? "";
    if (logText.length > lastLogLen) {
      process.stdout.write(logText.slice(lastLogLen));
      lastLogLen = logText.length;
    }
    status = ((await readRemoteFile(`${homeDir}/foresight-deploy.status`)) ?? "").trim();
    if (status) break;
  }

  // 5. make sure the temporary cron line is gone even if deploy.sh could not do it
  try {
    const lines = await api2("Cron", "listcron");
    for (const l of Array.isArray(lines) ? lines : []) {
      if (l.command && l.command.includes("foresight-cpanel.zip")) {
        await api2("Cron", "remove_line", { linekey: l.linekey });
        log("removed temporary cron entry");
      }
    }
  } catch (e) {
    log(`could not clean cron entry (${e.message}); deploy.sh removes it itself when it runs`);
  }

  if (!status) throw new Error(`deploy did not report a status within ${TIMEOUT_MIN} minutes — check ~/foresight-deploy.log in cPanel`);
  if (status !== "OK") throw new Error(`deploy failed on the host: ${status} (see log above)`);

  // 6. verify the live site
  log(`verifying ${APP_URL}/api/config`);
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(`${APP_URL}/api/config`, { redirect: "manual" });
      if (res.ok) {
        const cfg = await res.json();
        log(`LIVE: ${APP_URL} (chain ${cfg.chain?.name}, instant email login ${cfg.instantEmailLogin})`);
        return;
      }
      log(`not ready yet: HTTP ${res.status}`);
    } catch (e) {
      log(`not ready yet: ${e.message}`);
    }
    await sleep(10_000);
  }
  throw new Error("deploy reported OK but the site does not answer on /api/config yet — open the Node.js App page in cPanel and press Restart");
}

main().catch((e) => {
  console.error(`\nDEPLOY ERROR: ${e.message}`);
  process.exit(1);
});

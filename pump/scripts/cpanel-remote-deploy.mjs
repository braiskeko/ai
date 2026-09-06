/**
 * Deploys noxia-pump-cpanel.zip to a cPanel account using only the cPanel HTTP API
 * (no SSH). Generalised copy of Foresight's scripts/cpanel-remote-deploy.mjs. Runs from
 * GitHub Actions (see .github/workflows/deploy-pump.yml) or from any machine that can
 * reach the cPanel host.
 *
 *   CPANEL_HOST=next.work CPANEL_USER=... CPANEL_TOKEN=... \
 *   DOMAIN=app.noxia.work APP_URL=https://app.noxia.work ADMIN_EMAILS=me@x.com \
 *   ZIP_PATH=pump/noxia-pump-cpanel.zip node pump/scripts/cpanel-remote-deploy.mjs
 *
 * Steps: upload the zip (UAPI Fileman/upload_files) → make sure DOMAIN exists as a
 * (sub)domain of the account (UAPI DomainInfo/list_domains + SubDomain/addsubdomain,
 * then SSL/start_autossl_check) → schedule pump/deploy/deploy.sh through a single-use
 * cron entry (API2 Cron::add_line) → poll ~/${APP_ROOT}-deploy.status → print the deploy
 * log → verify APP_URL/api/config (https first, then http: AutoSSL on a brand-new
 * subdomain can take minutes).
 *
 * Env: CPANEL_HOST, CPANEL_USER, CPANEL_TOKEN (required); APP_ROOT (noxia-pump),
 * ZIP_PATH (noxia-pump-cpanel.zip), DOMAIN (app.noxia.work), APP_URL (https://DOMAIN),
 * ADMIN_EMAILS, SOLANA_CLUSTER (mainnet-beta), RPC_URL, DBC_CONFIG, TREASURY_WALLET,
 * ADMIN_API_TOKEN, WIPE_PUBLIC_HTML (0), WIPE_DATA (0), SESSION_SECRET (optional:
 * unset keeps the one the server persisted, so a deploy does not sign anyone out),
 * ORIGIN_IP, CPANEL_PORT (2083), DEPLOY_TIMEOUT_MIN (20).
 */
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import dns from "node:dns/promises";
import path from "node:path";

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
const APP_ROOT = env("APP_ROOT", "noxia-pump");
const DOMAIN = env("DOMAIN", "app.noxia.work");
const APP_URL = env("APP_URL", `https://${DOMAIN}`).replace(/\/+$/, "");
const ADMIN_EMAILS = env("ADMIN_EMAILS", "");
const SOLANA_CLUSTER = env("SOLANA_CLUSTER", "mainnet-beta");
const RPC_URL = env("RPC_URL", "");
const DBC_CONFIG = env("DBC_CONFIG", "");
const TREASURY_WALLET = env("TREASURY_WALLET", "");
const ADMIN_API_TOKEN = env("ADMIN_API_TOKEN", "");
const WIPE = env("WIPE_PUBLIC_HTML", "0");
/** 1 = start from an empty database (the old snapshot is backed up on the host first). */
const WIPE_DATA = env("WIPE_DATA", "0");
/**
 * Only sent when explicitly configured. A fresh random secret on every deploy
 * signs every session out, which is exactly what it used to do; with no value the
 * server generates one once and keeps it beside its data (server/config.ts).
 */
const SESSION_SECRET = env("SESSION_SECRET", "");
const ZIP = env("ZIP_PATH", `${APP_ROOT}-cpanel.zip`);
const ZIP_NAME = path.basename(ZIP);
const PORT = env("CPANEL_PORT", "2083");
const TIMEOUT_MIN = Number(env("DEPLOY_TIMEOUT_MIN", "20"));
// Public IP of the cPanel server. Used to reach the app directly (Host header) while the
// domain's DNS record does not exist yet — e.g. when DNS is hosted at Cloudflare and the
// subdomain created by cPanel has no record there.
const ORIGIN_IP = env("ORIGIN_IP", "");

const base = `https://${HOST}:${PORT}`;
const authHeaders = { Authorization: `cpanel ${USER}:${TOKEN}` };
const homeDir = `/home/${USER}`;
// Per-app file names so Foresight (~/deploy.conf, ~/foresight-deploy.*) and Next can
// live in the same account without stepping on each other.
const remoteConf = `${homeDir}/${APP_ROOT}-deploy.conf`;
const remoteScript = `${homeDir}/${APP_ROOT}-deploy.sh`;
const remoteLog = `${homeDir}/${APP_ROOT}-deploy.log`;
const remoteStatus = `${homeDir}/${APP_ROOT}-deploy.status`;

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
  // API2 result rows often carry their own {result, reason}; surface failures.
  const rows = Array.isArray(r.data) ? r.data : [];
  const failedRow = rows.find((row) => row && typeof row === "object" && row.result === 0);
  if (failedRow) throw new Error(`${module}::${func}: ${failedRow.reason ?? JSON.stringify(failedRow).slice(0, 300)}`);
  return r.data ?? r;
}

async function uploadFile(localPath, remoteDir, remoteName = path.basename(localPath)) {
  const form = new FormData();
  form.set("dir", remoteDir);
  form.set("overwrite", "1");
  const bytes = fs.readFileSync(localPath);
  form.set("file-1", new Blob([bytes]), remoteName);
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
const lower = (s) => String(s ?? "").toLowerCase().replace(/\.$/, "");

/**
 * Makes sure DOMAIN is served by this cPanel account. Returns true when the subdomain
 * had to be created (the caller then knows a TLS certificate may not exist yet).
 */
async function ensureDomain() {
  const want = lower(DOMAIN);
  const info = await uapi("DomainInfo/list_domains");
  const main = lower(info?.main_domain);
  const subs = (info?.sub_domains ?? []).map(lower);
  const addons = (info?.addon_domains ?? []).map(lower);
  const parked = (info?.parked_domains ?? []).map(lower);
  log(`account domains: main=${main} sub=[${subs.join(", ")}] addon=[${addons.join(", ")}] parked=[${parked.join(", ")}]`);
  if (want === main || subs.includes(want) || addons.includes(want) || parked.includes(want)) {
    log(`${DOMAIN} already exists on the account`);
    return false;
  }

  // Pick the longest known root the wanted host name hangs under; fall back to the
  // main domain when nothing matches (cPanel will reject impossible combinations).
  const roots = [main, ...addons, ...parked].filter(Boolean).sort((a, b) => b.length - a.length);
  const root = roots.find((r) => want.endsWith(`.${r}`)) ?? main;
  if (!root || !want.endsWith(`.${root}`)) {
    throw new Error(`${DOMAIN} is not a subdomain of any domain on this cPanel account (${[main, ...addons].join(", ")}) — add it in cPanel first`);
  }
  const label = want.slice(0, -(root.length + 1));
  const dir = `public_html/${label}`;
  log(`creating subdomain ${label}.${root} (document root ~/${dir})`);
  try {
    await uapi("SubDomain/addsubdomain", { domain: label, rootdomain: root, dir, disallowdot: 1 });
    log("subdomain created (UAPI)");
  } catch (e) {
    log(`UAPI SubDomain/addsubdomain failed (${e.message}); trying API2 SubDomain::addsubdomain`);
    await api2("SubDomain", "addsubdomain", { domain: label, rootdomain: root, dir, disallowdot: 1 });
    log("subdomain created (API2)");
  }

  // Ask AutoSSL to issue a certificate for the new host name. It runs asynchronously
  // and can take several minutes; a failure here is not fatal for the deploy.
  try {
    await uapi("SSL/start_autossl_check");
    log("AutoSSL check requested (certificate issuance may take a few minutes)");
  } catch (e) {
    log(`could not start AutoSSL check (${e.message}); request it from cPanel → SSL/TLS Status if https keeps failing`);
  }
  return true;
}

const isTlsError = (e) => {
  const code = e?.cause?.code ?? e?.code ?? "";
  const msg = `${code} ${e?.cause?.message ?? ""} ${e?.message ?? ""}`;
  return /CERT|TLS|SSL|ALTNAME|SELF_SIGNED|HANDSHAKE|LEAF_SIGNATURE|UNABLE_TO_VERIFY|certificate/i.test(msg);
};

const describe = (cfg) =>
  `app ${cfg?.appName ?? "?"}, chain ${cfg?.chain?.name ?? "?"}, instant email login ${cfg?.instantEmailLogin ?? "?"}`;

/** GET url/api/config. Resolves {ok, cfg} | {ok:false, status, location}; throws on network/TLS errors. */
async function probe(url) {
  const res = await fetch(`${url}/api/config`, { redirect: "manual" });
  if (!res.ok) return { ok: false, status: res.status, location: res.headers.get("location") ?? "" };
  const cfg = await res.json();
  return { ok: true, cfg };
}

/**
 * Same request over https but WITHOUT certificate validation. Only used after a TLS
 * failure, to tell "the app is up, the certificate is not there yet" (AutoSSL still
 * pending on a fresh subdomain) apart from "the app is down".
 */
function probeInsecure(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `${url}/api/config`,
      { rejectUnauthorized: false, timeout: 15_000, headers: { accept: "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
          try {
            resolve({ ok: true, cfg: JSON.parse(body) });
          } catch {
            resolve({ ok: false, status: res.statusCode });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function printTlsNote(subdomainIsNew) {
  console.log(
    [
      "",
      `NOTE: ${DOMAIN} answers, but https does not have a valid certificate yet.`,
      subdomainIsNew
        ? `The subdomain was created by this deploy: cPanel AutoSSL usually issues its certificate within a few minutes.`
        : "AutoSSL has not issued (or renewed) the certificate for this host name yet.",
      "Open cPanel → SSL/TLS Status → Run AutoSSL if https still fails after ~15 minutes.",
      "",
    ].join("\n"),
  );
}


/** A records of DOMAIN, or [] when the name does not resolve. */
async function resolveDomain() {
  try {
    return await dns.resolve4(DOMAIN);
  } catch {
    return [];
  }
}

/** Nameservers of the registrable domain (best effort; used only for the hint text). */
async function nameservers() {
  const parts = DOMAIN.split(".");
  const apex = parts.slice(-2).join(".");
  try {
    return await dns.resolveNs(apex);
  } catch {
    return [];
  }
}

/** Plain-http probe of the origin server with a Host header (bypasses DNS). */
function probeOrigin(ip) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: ip, port: 80, path: "/api/config", timeout: 15_000, headers: { host: DOMAIN, accept: "application/json" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
          try {
            resolve({ ok: true, cfg: JSON.parse(body) });
          } catch {
            resolve({ ok: false, status: res.statusCode });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function printDnsNote(ns) {
  const atCloudflare = ns.some((n) => /cloudflare/i.test(n));
  console.log(
    [
      "",
      `ACTION NEEDED: ${DOMAIN} has no DNS record, so nobody can reach it yet.`,
      atCloudflare
        ? `The DNS zone is hosted at Cloudflare (${ns.join(", ")}). In the Cloudflare dashboard → DNS → Records, add:`
        : `Add this record at your DNS provider${ns.length ? ` (${ns.join(", ")})` : ""}:`,
      `  Type A   Name ${DOMAIN.split(".")[0]}   Content ${ORIGIN_IP || "<server IP>"}   Proxy: on (orange cloud) for free https`,
      "It usually starts working within a minute or two.",
      "",
    ].join("\n"),
  );
}

async function verify(subdomainIsNew) {
  const httpsUrl = APP_URL.startsWith("http://") ? null : APP_URL;
  const httpUrl = APP_URL.replace(/^https:/, "http:");
  log(`verifying ${APP_URL}/api/config`);
  const records = await resolveDomain();
  if (records.length === 0) {
    log(`${DOMAIN} does not resolve (no DNS record yet)`);
    if (!ORIGIN_IP) {
      printDnsNote(await nameservers());
      throw new Error(`${DOMAIN} has no DNS record; set ORIGIN_IP to verify the app directly on the server`);
    }
    let last = "";
    for (let i = 0; i < 12; i++) {
      try {
        const r = await probeOrigin(ORIGIN_IP);
        if (r.ok) {
          log(`LIVE on the server (${ORIGIN_IP}, Host: ${DOMAIN}): ${describe(r.cfg)}`);
          printDnsNote(await nameservers());
          return;
        }
        last = `HTTP ${r.status}`;
      } catch (e) {
        last = e.code ?? e.message;
      }
      log(`origin not ready yet: ${last}`);
      await sleep(10_000);
    }
    throw new Error(`deploy reported OK but the app does not answer on the server (${last}) — open the Node.js App page in cPanel and press Restart`);
  }
  for (let i = 0; i < 12; i++) {
    let tlsFailed = false;
    if (httpsUrl) {
      try {
        const r = await probe(httpsUrl);
        if (r.ok) {
          log(`LIVE: ${httpsUrl} (${describe(r.cfg)})`);
          return;
        }
        log(`https not ready yet: HTTP ${r.status}`);
      } catch (e) {
        if (isTlsError(e)) {
          tlsFailed = true;
          log(`https certificate not valid yet (${e.cause?.code ?? e.message})`);
        } else {
          log(`https not ready yet: ${e.cause?.code ?? e.message}`);
        }
      }
    }

    if (tlsFailed) {
      // Certificate problem only: check the app behind it without validating the chain.
      try {
        const r = await probeInsecure(httpsUrl);
        if (r.ok) {
          log(`LIVE behind a pending certificate: ${httpsUrl} (${describe(r.cfg)})`);
          printTlsNote(subdomainIsNew);
          return;
        }
        log(`https (unverified) not ready yet: HTTP ${r.status}`);
      } catch (e) {
        log(`https (unverified) not ready yet: ${e.code ?? e.message}`);
      }
    }

    // A fresh subdomain has no certificate until AutoSSL runs; the app itself is fine
    // if plain http answers. Accept that and say so clearly.
    try {
      const r = await probe(httpUrl);
      if (r.ok) {
        log(`LIVE over plain http: ${httpUrl} (${describe(r.cfg)})`);
        if (httpsUrl) printTlsNote(subdomainIsNew);
        return;
      }
      if (r.status >= 300 && r.status < 400 && /^https:/i.test(r.location)) {
        log(`http redirects to https (${r.location}) — "Force HTTPS Redirect" is on for this domain`);
      } else {
        log(`http not ready yet: HTTP ${r.status}`);
      }
    } catch (e) {
      log(`http not ready yet: ${e.cause?.code ?? e.message}`);
    }
    await sleep(10_000);
  }
  throw new Error("deploy reported OK but the site does not answer on /api/config yet — open the Node.js App page in cPanel and press Restart");
}

async function main() {
  if (!fs.existsSync(ZIP)) throw new Error(`${ZIP} not found — run pump/scripts/package-cpanel.sh first`);

  // 0. connectivity + account sanity check
  log(`connecting to ${base} as ${USER}`);
  const files = await uapi("Fileman/list_files", { dir: homeDir, types: "dir", limit_to_list: 1 });
  log(`ok, home has ${Array.isArray(files) ? files.length : "?"} directories`);

  // 1. deploy conf consumed by deploy.sh on the host (shell-sourced; values single-quoted)
  const envVars = {
    NODE_ENV: "production",
    APP_URL,
    ...(SESSION_SECRET ? { SESSION_SECRET } : {}),
    ADMIN_EMAILS,
    SOLANA_CLUSTER,
    INSTANT_EMAIL_LOGIN: "1",
    SEED_DEMO: "0",
    ...(RPC_URL ? { RPC_URL } : {}),
    ...(DBC_CONFIG ? { DBC_CONFIG } : {}),
    ...(TREASURY_WALLET ? { TREASURY_WALLET } : {}),
    ...(ADMIN_API_TOKEN ? { ADMIN_API_TOKEN } : {}),
  };
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const conf = [
    `APP_ROOT=${sq(APP_ROOT)}`,
    `DOMAIN=${sq(DOMAIN)}`,
    `WIPE_PUBLIC_HTML=${sq(WIPE)}`,
    `WIPE_DATA=${sq(WIPE_DATA)}`,
    `ZIP_NAME=${sq(ZIP_NAME)}`,
    `ENV_JSON=${sq(JSON.stringify(envVars))}`,
    "",
  ].join("\n");
  const localDir = path.dirname(ZIP);
  const confPath = path.join(localDir, `${APP_ROOT}-deploy.conf`);
  fs.writeFileSync(confPath, conf);

  // 2. upload zip + conf; blank out the previous run's status file and remember the
  //    current log length so we only react to THIS deploy's output.
  log(`uploading ${ZIP} (${(fs.statSync(ZIP).size / 1024).toFixed(0)} KB)`);
  await uploadFile(ZIP, homeDir, ZIP_NAME);
  await uploadFile(confPath, homeDir);
  const statusPath = path.join(localDir, `${APP_ROOT}-deploy.status`);
  fs.writeFileSync(statusPath, "");
  await uploadFile(statusPath, homeDir);
  const previousLog = (await readRemoteFile(remoteLog)) ?? "";
  log("uploaded");

  // 3. make sure the (sub)domain exists before the Node.js Selector binds the app to it
  const subdomainIsNew = await ensureDomain();

  // 4. schedule the single-use deploy cron (fires on the next minute boundary)
  const cmd =
    `cd ${homeDir} && unzip -p ${ZIP_NAME} ${APP_ROOT}/deploy.sh > ${remoteScript} 2>/dev/null && ` +
    `/bin/bash ${remoteScript} ${remoteConf}`;
  log("scheduling deploy via cron");
  await api2("Cron", "add_line", { command: cmd, minute: "*", hour: "*", day: "*", month: "*", weekday: "*" });
  log("cron scheduled; the deploy starts within ~60s and takes a few minutes (npm install)");

  // 5. poll status
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let status = null;
  let lastLogLen = previousLog.length;
  while (Date.now() < deadline) {
    await sleep(20_000);
    const logText = (await readRemoteFile(remoteLog)) ?? "";
    if (logText.length > lastLogLen) {
      process.stdout.write(logText.slice(lastLogLen));
      lastLogLen = logText.length;
    }
    status = ((await readRemoteFile(remoteStatus)) ?? "").trim();
    if (status) break;
  }

  // 6. make sure the temporary cron line is gone even if deploy.sh could not do it
  try {
    const lines = await api2("Cron", "listcron");
    for (const l of Array.isArray(lines) ? lines : []) {
      if (l.command && l.command.includes(ZIP_NAME)) {
        await api2("Cron", "remove_line", { linekey: l.linekey });
        log("removed temporary cron entry");
      }
    }
  } catch (e) {
    log(`could not clean cron entry (${e.message}); deploy.sh removes it itself when it runs`);
  }

  if (!status) {
    // deploy.sh went quiet (killed by a resource limit, or a selector call hung). The app may
    // still be serving — Passenger starts it on the first request — so check before giving up.
    log(`deploy.sh did not report a status within ${TIMEOUT_MIN} minutes; checking whether the app answers anyway`);
    try {
      await verify(subdomainIsNew);
      console.log(`NOTE: deploy.sh never wrote its status file — review ~/${APP_ROOT}-deploy.log in cPanel → File Manager.`);
      return;
    } catch (e) {
      log(`app not answering either: ${e.message}`);
    }
    throw new Error(`deploy did not report a status within ${TIMEOUT_MIN} minutes — check ~/${APP_ROOT}-deploy.log in cPanel`);
  }
  if (status !== "OK") throw new Error(`deploy failed on the host: ${status} (see log above)`);

  // 7. verify the live site
  await verify(subdomainIsNew);
}

main().catch((e) => {
  console.error(`\nDEPLOY ERROR: ${e.message}`);
  process.exit(1);
});

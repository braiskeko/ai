import express from "express";
import { registerRoutes, closeRealtime } from "./routes";
import { initStorage, storage } from "./storage";
import { seedDemo } from "./seed";
import * as vanity from "./vanity";

const app = express();
app.use(express.json({ limit: "3mb" }));
await initStorage();
await vanity.init();
seedDemo();
const server = await registerRoutes(app);
await new Promise<void>((r) => server.listen(5177, () => r()));

const get = async (p: string) => {
  const res = await fetch(`http://127.0.0.1:5177${p}`);
  const body = await res.text();
  console.log(p, res.status, body.slice(0, 260));
};
await get("/api/config");
await get("/api/coins?sort=trending&limit=2");
await get("/api/stats");
await get("/api/activity?limit=2");
await get("/api/wallet");
await get("/api/portfolio");
await get("/api/coins/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
await get("/api/meta/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU.json");
await get("/api/auth/wallet/nonce?address=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
await get("/api/nope");
const post = await fetch("http://127.0.0.1:5177/api/admin/vanity", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({keypairs: []}) });
console.log("/api/admin/vanity", post.status, (await post.text()).slice(0, 200));
const coins = await (await fetch("http://127.0.0.1:5177/api/coins")).json();
if (coins.length) {
  await get(`/api/coins/${coins[0].ca}`);
  await get(`/api/coins/${coins[0].ca}/candles`);
  await get(`/api/coins/${coins[0].ca}/trades?limit=1`);
  await get(`/api/coins/${coins[0].ca}/comments`);
}
closeRealtime();
server.close();
await storage.flush();
process.exit(0);

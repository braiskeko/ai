/**
 * Devnet rehearsal of the whole on-chain flow, independent of the web app:
 * airdrop → create config → create pool (+ first buy) → buy → sell → read state → claim fees.
 *
 *   node pump/scripts/solana/devnet-e2e.mjs
 *
 * Optional: PAYER (reuse a funded keypair), DBC_CONFIG (reuse an existing config), RPC_URL.
 * Exit code 1 on any failure. Meant to run on GitHub Actions (the sandbox has no RPC access).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ActivationType,
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  getCurrentPoint,
  getPriceFromSqrtPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT, airdrop, connectionFor, explorer, loadKeypair, log, nextCurve, sendTx } from "./lib.mjs";

const cluster = "devnet";
const connection = connectionFor(cluster);
const payer = loadKeypair(process.env.PAYER) ?? Keypair.generate();
const dbc = DynamicBondingCurveClient.create(connection, "confirmed");
const fail = (m) => {
  console.error("FAIL", m);
  process.exit(1);
};

log(`payer ${payer.publicKey.toBase58()}`);
let balance = await connection.getBalance(payer.publicKey);
if (balance < 1.5e9) {
  await airdrop(connection, payer.publicKey, 2);
  balance = await connection.getBalance(payer.publicKey);
}
log(`balance ${balance / 1e9} SOL`);

// ---- config ---------------------------------------------------------------
const SOL_USD = 150;
let configPk;
if (process.env.DBC_CONFIG) {
  configPk = new PublicKey(process.env.DBC_CONFIG);
} else {
  const curve = nextCurve(SOL_USD);
  const configKp = Keypair.generate();
  const tx = await dbc.partner.createConfig({
    config: configKp.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: payer.publicKey,
    quoteMint: NATIVE_MINT,
    payer: payer.publicKey,
    ...curve,
  });
  await sendTx(connection, tx, [payer, configKp], "createConfig");
  configPk = configKp.publicKey;
}
const config = await dbc.state.getPoolConfig(configPk);
if (!config) fail("config not found on chain");
log(`config ${configPk.toBase58()} migrationQuoteThreshold ${config.migrationQuoteThreshold.toString()} lamports`);

// ---- create pool with a first buy ---------------------------------------------
const mint = Keypair.generate();
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, configPk);
const createTx = await dbc.creator.createPoolWithFirstBuy({
  createPoolParam: {
    name: "Next Devnet Cat",
    symbol: "NDCAT",
    uri: "https://app.noxia.work/api/meta/devnet-test.json",
    payer: payer.publicKey,
    poolCreator: payer.publicKey,
    config: configPk,
    baseMint: mint.publicKey,
  },
  firstBuyParam: {
    buyer: payer.publicKey,
    buyAmount: new BN(0.05e9),
    minimumAmountOut: new BN(1),
    referralTokenAccount: null,
  },
});
await sendTx(connection, createTx, [payer, mint], "createPoolWithFirstBuy");
log(`mint ${mint.publicKey.toBase58()} pool ${pool.toBase58()} ${explorer(cluster, "token", mint.publicKey.toBase58())}`);

// The anchor account nests every field under `poolState`.
const stateOf = (vp) => vp.poolState;

const readState = async (label) => {
  const vp = await dbc.state.getPool(pool);
  if (!vp) fail("pool not found");
  const st = stateOf(vp);
  const price = getPriceFromSqrtPrice(st.sqrtPrice, 6, 9);
  const progress = await dbc.state.getPoolQuoteTokenCurveProgress(pool);
  log(
    `${label}: price ${price.toString()} SOL/token, mcap ${(Number(price.toString()) * 1e9).toFixed(3)} SOL, quoteReserve ${
      Number(st.quoteReserve.toString()) / 1e9
    } SOL, baseReserve ${Number(st.baseReserve.toString()) / 1e6} tokens, progress ${(progress * 100).toFixed(2)}%`,
  );
  return vp;
};
const afterCreate = await readState("after create");
if (!(Number(stateOf(afterCreate).quoteReserve.toString()) > 0)) fail("first buy did not add quote reserve");

// ---- quote + buy --------------------------------------------------------------
const currentPoint = await getCurrentPoint(connection, ActivationType.Slot);
const quote = dbc.pool.swapQuote({
  virtualPool: afterCreate,
  config,
  swapBaseForQuote: false,
  amountIn: new BN(0.1e9),
  slippageBps: 500,
  hasReferral: false,
  eligibleForFirstSwapWithMinFee: false,
  currentPoint,
});
// SwapQuoteResult: {actualInputAmount, outputAmount, nextSqrtPrice, tradingFee, protocolFee, referralFee, minimumAmountOut}
const totalFee = (q) => Number(q.tradingFee.add(q.protocolFee).add(q.referralFee).toString()) / 1e9;
log(
  `quote buy 0.1 SOL → ${Number(quote.outputAmount.toString()) / 1e6} tokens (min ${
    Number(quote.minimumAmountOut.toString()) / 1e6
  }), fee ${totalFee(quote)} SOL`,
);
const expectedFee = 0.1 * 0.027;
const fee = totalFee(quote);
if (Math.abs(fee - expectedFee) > 1e-6) fail(`fee ${fee} != 2.7% (${expectedFee})`);

const buyTx = await dbc.pool.swap({
  owner: payer.publicKey,
  pool,
  amountIn: new BN(0.1e9),
  minimumAmountOut: quote.minimumAmountOut,
  swapBaseForQuote: false,
  referralTokenAccount: null,
});
await sendTx(connection, buyTx, [payer], "buy 0.1 SOL");
const afterBuy = await readState("after buy");
if (!(Number(stateOf(afterBuy).sqrtPrice.toString()) > Number(stateOf(afterCreate).sqrtPrice.toString())))
  fail("price did not rise");

// ---- sell half of what we hold ------------------------------------------------
const accounts = await connection.getParsedTokenAccountsByOwner(payer.publicKey, { mint: mint.publicKey });
const held = Number(accounts.value[0]?.account.data.parsed.info.tokenAmount.amount ?? 0);
if (!(held > 0)) fail("no tokens held after buys");
const sellAmount = new BN(Math.floor(held / 2));
const sellQuote = dbc.pool.swapQuote({
  virtualPool: afterBuy,
  config,
  swapBaseForQuote: true,
  amountIn: sellAmount,
  slippageBps: 500,
  hasReferral: false,
  eligibleForFirstSwapWithMinFee: false,
  currentPoint: await getCurrentPoint(connection, ActivationType.Slot),
});
log(`quote sell ${sellAmount.toNumber() / 1e6} tokens → ${Number(sellQuote.outputAmount.toString()) / 1e9} SOL`);
const sellTx = await dbc.pool.swap({
  owner: payer.publicKey,
  pool,
  amountIn: sellAmount,
  minimumAmountOut: sellQuote.minimumAmountOut,
  swapBaseForQuote: true,
  referralTokenAccount: null,
});
await sendTx(connection, sellTx, [payer], "sell");
const afterSell = await readState("after sell");
if (!(Number(stateOf(afterSell).sqrtPrice.toString()) < Number(stateOf(afterBuy).sqrtPrice.toString())))
  fail("price did not fall");

// ---- fees ------------------------------------------------------------------------
const metrics = await dbc.state.getPoolFeeMetrics(pool);
log(
  `fees: partner ${Number(metrics.current.partnerQuoteFee.toString()) / 1e9} SOL, creator ${
    Number(metrics.current.creatorQuoteFee.toString()) / 1e9
  } SOL, total ${Number(metrics.total.totalTradingQuoteFee.toString()) / 1e9} SOL`,
);
const creatorFee = Number(metrics.current.creatorQuoteFee.toString());
const partnerFee = Number(metrics.current.partnerQuoteFee.toString());
if (!(creatorFee > 0 && partnerFee > 0)) fail("fees not accrued");
const ratio = creatorFee / (creatorFee + partnerFee);
if (Math.abs(ratio - 0.1) > 0.01) fail(`creator share ${ratio} != 10%`);

// ---- transaction history (what the indexer will read) -----------------------------
const sigs = await connection.getSignaturesForAddress(pool, { limit: 10 });
log(`pool has ${sigs.length} signatures`);
const parsed = await connection.getParsedTransaction(sigs[0].signature, { maxSupportedTransactionVersion: 0 });
const pre = parsed.meta.preTokenBalances.length;
log(`latest tx: ${pre} pre token balances, ${parsed.meta.postTokenBalances.length} post token balances, signer ${parsed.transaction.message.accountKeys[0].pubkey.toBase58()}`);

console.log("\nDEVNET E2E OK");
console.log(JSON.stringify({ config: configPk.toBase58(), mint: mint.publicKey.toBase58(), pool: pool.toBase58() }));

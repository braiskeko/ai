import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { SWAP_FEE } from "@shared/schema";
import { decodeSwap } from "./indexer";

// Real addresses so PublicKey accepts them.
const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const QUOTE_VAULT = "8pM1DN3RiT8vbom5u1sNryaNT1nyL8CTTW3b5PwWXRBH";
const BASE_VAULT = "9pM1DN3RiT8vbom5u1sNryaNT1nyL8CTTW3b5PwWXRBH";
const TRADER = "6dNVeH1FFbUABc6uUJdgpqZseYVdvKn3vJj3fVKrjQ8T";
const OTHER = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const WSOL = "So11111111111111111111111111111111111111112";

const LAMPORTS = 1_000_000_000;
const TOKEN_UNIT = 1_000_000;

interface BalanceInput {
  index: number;
  mint: string;
  owner?: string;
  amount: number;
}

function balances(entries: BalanceInput[]) {
  return entries.map((e) => ({
    accountIndex: e.index,
    mint: e.mint,
    owner: e.owner,
    uiTokenAmount: { amount: String(e.amount), decimals: 6, uiAmount: null, uiAmountString: String(e.amount) },
  }));
}

/**
 * A parsed transaction with just the fields decodeSwap reads. Account index 0 is
 * the signer, 1 the quote vault, 2 the base vault, 3 the trader's token account.
 */
function tx(options: {
  pre?: BalanceInput[];
  post?: BalanceInput[];
  err?: unknown;
  keys?: string[];
  slot?: number;
  blockTime?: number | null;
}): ParsedTransactionWithMeta {
  const keys = options.keys ?? [TRADER, QUOTE_VAULT, BASE_VAULT, MINT];
  return {
    slot: options.slot ?? 12345,
    blockTime: options.blockTime === undefined ? 1_700_000_000 : options.blockTime,
    transaction: {
      signatures: ["sig"],
      message: {
        accountKeys: keys.map((key, i) => ({
          pubkey: new PublicKey(key),
          signer: i === 0,
          writable: true,
          source: "transaction" as const,
        })),
        instructions: [],
        recentBlockhash: "",
      },
    },
    meta: {
      err: options.err ?? null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: balances(options.pre ?? []),
      postTokenBalances: balances(options.post ?? []),
      innerInstructions: [],
      logMessages: [],
    },
  } as unknown as ParsedTransactionWithMeta;
}

const pool = { quoteVault: QUOTE_VAULT, mint: MINT };

test("a buy is read from the vault gaining SOL and the trader gaining tokens", () => {
  const swap = decodeSwap(
    tx({
      pre: [
        { index: 1, mint: WSOL, amount: 10 * LAMPORTS },
        { index: 3, mint: MINT, owner: TRADER, amount: 0 },
      ],
      post: [
        { index: 1, mint: WSOL, amount: 11 * LAMPORTS },
        { index: 3, mint: MINT, owner: TRADER, amount: 20_000 * TOKEN_UNIT },
      ],
    }),
    pool,
  );

  assert.ok(swap);
  assert.equal(swap!.side, "buy");
  assert.equal(swap!.sol, 1, "the vault gained exactly what the trader paid");
  assert.equal(swap!.tokens, 20_000);
  assert.ok(Math.abs(swap!.feeSol - SWAP_FEE) < 1e-12, "2.7% of 1 SOL");
  assert.ok(Math.abs(swap!.priceSol - (1 - SWAP_FEE) / 20_000) < 1e-15, "the fee does not reach the curve");
  assert.equal(swap!.wallet, TRADER);
  assert.equal(swap!.slot, 12345);
  assert.equal(swap!.createdAt, new Date(1_700_000_000_000).toISOString());
});

test("a sell is read from the vault paying out SOL", () => {
  const swap = decodeSwap(
    tx({
      pre: [
        { index: 1, mint: WSOL, amount: 11 * LAMPORTS },
        { index: 3, mint: MINT, owner: TRADER, amount: 20_000 * TOKEN_UNIT },
      ],
      post: [
        { index: 1, mint: WSOL, amount: 10.1 * LAMPORTS },
        { index: 3, mint: MINT, owner: TRADER, amount: 0 },
      ],
    }),
    pool,
  );

  assert.ok(swap);
  assert.equal(swap!.side, "sell");
  assert.ok(Math.abs(swap!.sol - 0.9) < 1e-9, "the trader receives the net payout");
  assert.equal(swap!.tokens, 20_000);
  // The fee was withheld from the gross, so the curve gave back more than the payout.
  assert.ok(Math.abs(swap!.feeSol - (0.9 * SWAP_FEE) / (1 - SWAP_FEE)) < 1e-9);
  assert.ok(swap!.priceSol > 0.9 / 20_000, "the fill price is the gross, not the net");
});

test("the creation transaction's first buy is decoded like any other buy", () => {
  // Both the vault and the trader's token account are created inside the
  // transaction, so neither appears in preTokenBalances.
  const swap = decodeSwap(
    tx({
      pre: [],
      post: [
        { index: 1, mint: WSOL, amount: 0.05 * LAMPORTS },
        { index: 3, mint: MINT, owner: TRADER, amount: 1_500_000 * TOKEN_UNIT },
      ],
    }),
    pool,
  );

  assert.ok(swap);
  assert.equal(swap!.side, "buy");
  assert.ok(Math.abs(swap!.sol - 0.05) < 1e-12);
  assert.equal(swap!.tokens, 1_500_000);
});

test("another wallet's token account is ignored", () => {
  const swap = decodeSwap(
    tx({
      pre: [{ index: 1, mint: WSOL, amount: 10 * LAMPORTS }],
      post: [
        { index: 1, mint: WSOL, amount: 11 * LAMPORTS },
        { index: 4, mint: MINT, owner: OTHER, amount: 5_000 * TOKEN_UNIT },
      ],
    }),
    pool,
  );
  assert.equal(swap, null, "no token movement for the signer means no decodable trade");
});

test("failed, unrelated and no-op transactions decode to null", () => {
  const movement = {
    pre: [
      { index: 1, mint: WSOL, amount: 10 * LAMPORTS },
      { index: 3, mint: MINT, owner: TRADER, amount: 0 },
    ],
    post: [
      { index: 1, mint: WSOL, amount: 11 * LAMPORTS },
      { index: 3, mint: MINT, owner: TRADER, amount: 20_000 * TOKEN_UNIT },
    ],
  };

  assert.equal(decodeSwap(tx({ ...movement, err: { InstructionError: [0, "Custom"] } }), pool), null, "failed tx");
  assert.equal(decodeSwap(tx({ ...movement, keys: [TRADER, BASE_VAULT, MINT] }), pool), null, "vault not in the tx");
  assert.equal(
    decodeSwap(
      tx({
        pre: [{ index: 1, mint: WSOL, amount: 10 * LAMPORTS }],
        post: [{ index: 1, mint: WSOL, amount: 10 * LAMPORTS }],
      }),
      pool,
    ),
    null,
    "the vault balance did not move",
  );
});

test("a transaction without a block time is stamped with the current time", () => {
  const before = Date.now();
  const swap = decodeSwap(
    tx({
      blockTime: null,
      pre: [
        { index: 1, mint: WSOL, amount: 0 },
        { index: 3, mint: MINT, owner: TRADER, amount: 0 },
      ],
      post: [
        { index: 1, mint: WSOL, amount: LAMPORTS },
        { index: 3, mint: MINT, owner: TRADER, amount: TOKEN_UNIT },
      ],
    }),
    pool,
  );
  assert.ok(swap);
  const at = Date.parse(swap!.createdAt);
  assert.ok(at >= before - 1_000 && at <= Date.now() + 1_000);
});

import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { buildWalletMessage, issueWalletNonce, pendingWalletNonces, verifyWalletLogin } from "./walletAuth";
import { HttpError } from "./storage";

/** A throwaway Solana keypair: the address *is* the ed25519 public key. */
function wallet() {
  const pair = nacl.sign.keyPair();
  return {
    address: bs58.encode(pair.publicKey),
    sign: (message: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), pair.secretKey)),
  };
}

test("the challenge message names the address and the nonce", () => {
  const { address } = wallet();
  const { nonce, message } = issueWalletNonce(address);
  assert.match(message, /wants you to sign in with your Solana account:/);
  assert.ok(message.includes(address));
  assert.ok(message.includes(`Nonce: ${nonce}`));
  assert.match(message, /Issued At: \d{4}-\d{2}-\d{2}T/);
});

test("a correctly signed challenge authenticates the wallet", () => {
  const w = wallet();
  const { nonce, message } = issueWalletNonce(w.address);
  const address = verifyWalletLogin({ address: w.address, signature: w.sign(message), nonce });
  assert.equal(address, w.address);
});

test("a nonce is single use", () => {
  const w = wallet();
  const { nonce, message } = issueWalletNonce(w.address);
  const signature = w.sign(message);
  verifyWalletLogin({ address: w.address, signature, nonce });
  assert.throws(
    () => verifyWalletLogin({ address: w.address, signature, nonce }),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );
});

test("a signature from another wallet is rejected", () => {
  const owner = wallet();
  const attacker = wallet();
  const { nonce, message } = issueWalletNonce(owner.address);
  assert.throws(
    () => verifyWalletLogin({ address: owner.address, signature: attacker.sign(message), nonce }),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );
});

test("signing a different message does not authenticate", () => {
  const w = wallet();
  const { nonce } = issueWalletNonce(w.address);
  const forged = buildWalletMessage(w.address, "not-the-nonce", Date.now());
  assert.throws(
    () => verifyWalletLogin({ address: w.address, signature: w.sign(forged), nonce }),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );
});

test("the challenge is bound to the address it was issued for", () => {
  const owner = wallet();
  const other = wallet();
  const { nonce, message } = issueWalletNonce(owner.address);
  assert.throws(
    () => verifyWalletLogin({ address: other.address, signature: other.sign(message), nonce }),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );
});

test("malformed addresses and signatures are refused", () => {
  assert.throws(() => issueWalletNonce("not-a-wallet"), (err: unknown) => err instanceof HttpError && err.status === 400);
  const w = wallet();
  const { nonce } = issueWalletNonce(w.address);
  assert.throws(
    () => verifyWalletLogin({ address: w.address, signature: "!!!not-base58!!!", nonce }),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );
});

test("unknown nonces are rejected without leaking state", () => {
  const w = wallet();
  const before = pendingWalletNonces();
  assert.throws(
    () => verifyWalletLogin({ address: w.address, signature: bs58.encode(new Uint8Array(64)), nonce: "0".repeat(32) }),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );
  assert.equal(pendingWalletNonces(), before);
});

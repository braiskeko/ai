import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction, VersionedTransaction, type Keypair } from "@solana/web3.js";
import type { SendTxInput, SentTx, UnsignedTx } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { loadVault, solanaKeypair } from "@/lib/embeddedWallet";

export type TxKind = SendTxInput["kind"];

/**
 * Decodes a server-built transaction of either shape.
 *
 * Our own Meteora instructions come back as legacy `Transaction`s (sometimes
 * already partially signed by a mint keypair); Jupiter routes come back as
 * v0 `VersionedTransaction`s with address lookup tables. `VersionedTransaction.
 * deserialize` also accepts a legacy message, so the version is checked
 * explicitly and legacy transactions keep taking exactly the path they always
 * did.
 */
export function decodeTx(bytes: Uint8Array): Transaction | VersionedTransaction {
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    if (versioned.version !== "legacy") return versioned;
  } catch {
    // Not a versioned transaction — fall through to the legacy decoder.
  }
  return Transaction.from(bytes);
}

/** Re-serializes a signed transaction of either shape to base64. */
function serializeSigned(tx: Transaction | VersionedTransaction): string {
  const bytes =
    tx instanceof VersionedTransaction
      ? tx.serialize()
      : // Partial signatures applied server-side (the mint on a launch) stay intact.
        tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return Buffer.from(bytes).toString("base64");
}

export interface WalletTx {
  /** base58 address of the connected browser wallet, or null when disconnected. */
  publicKey: string | null;
  connected: boolean;
  connecting: boolean;
  /**
   * Decodes the server-built unsigned transaction, asks the connected wallet to
   * sign it, re-serializes it (the mint / other partial signers already applied
   * server-side stay intact) and posts it to POST /api/tx/send for the server to
   * relay, confirm and index.
   *
   * `onSigned` (optional) fires the instant the wallet returns a signature, i.e.
   * right as the flow moves from "waiting on the wallet" to "confirming
   * on-chain" — callers use it to flip a signing/confirming UI phase without
   * needing a different return shape.
   */
  signAndSend(unsigned: UnsignedTx, kind: TxKind, ca?: string, onSigned?: () => void): Promise<SentTx>;
}

/**
 * Thin wrapper around `@solana/wallet-adapter-react` that turns a server-built
 * `UnsignedTx` into a confirmed, indexed `SentTx`. The browser never talks to an
 * RPC directly — signing happens locally, everything else is relayed by the
 * server (see shared/schema.ts UnsignedTx / SendTxInput / SentTx).
 */
/** Applies the account's own key to a transaction of either shape. */
function signLocally(tx: Transaction | VersionedTransaction, keypair: Keypair): Transaction | VersionedTransaction {
  if (tx instanceof VersionedTransaction) tx.sign([keypair]);
  // partialSign, not sign: signatures already applied server-side (a launch's mint) must survive.
  else tx.partialSign(keypair);
  return tx;
}

export function useWalletTx(): WalletTx {
  const { publicKey, connected, connecting, signTransaction } = useWallet();
  // The account's built-in wallet, used whenever no extension is connected.
  const vault = loadVault();

  const signAndSend = useCallback(
    async (unsigned: UnsignedTx, kind: TxKind, ca?: string, onSigned?: () => void): Promise<SentTx> => {
      const local = !connected || !signTransaction ? loadVault() : null;
      if (!signTransaction && !local) {
        throw new Error("Sign in to trade — your account comes with its own wallet.");
      }
      const tx = decodeTx(Buffer.from(unsigned.tx, "base64"));
      const signed = local ? signLocally(tx, solanaKeypair(local.mnemonic)) : await signTransaction!(tx);
      onSigned?.();
      const body: SendTxInput = {
        tx: serializeSigned(signed),
        kind,
        ...(ca ? { ca } : {}),
      };
      const res = await apiRequest("POST", "/api/tx/send", body);
      return (await res.json()) as SentTx;
    },
    [signTransaction, connected],
  );

  return {
    publicKey: publicKey ? publicKey.toBase58() : (vault?.solana ?? null),
    // "Connected" now means "able to sign", which an account with its own wallet always is.
    connected: connected || !!vault,
    connecting,
    signAndSend,
  };
}

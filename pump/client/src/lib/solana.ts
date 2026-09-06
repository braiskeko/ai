import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import type { SendTxInput, SentTx, UnsignedTx } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";

export type TxKind = SendTxInput["kind"];

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
export function useWalletTx(): WalletTx {
  const { publicKey, connected, connecting, signTransaction } = useWallet();

  const signAndSend = useCallback(
    async (unsigned: UnsignedTx, kind: TxKind, ca?: string, onSigned?: () => void): Promise<SentTx> => {
      if (!signTransaction) {
        throw new Error("Connect a Solana wallet that supports transaction signing.");
      }
      const tx = Transaction.from(Buffer.from(unsigned.tx, "base64"));
      const signed = await signTransaction(tx);
      onSigned?.();
      const serialized = signed.serialize({ requireAllSignatures: false, verifySignatures: false });
      const body: SendTxInput = {
        tx: Buffer.from(serialized).toString("base64"),
        kind,
        ...(ca ? { ca } : {}),
      };
      const res = await apiRequest("POST", "/api/tx/send", body);
      return (await res.json()) as SentTx;
    },
    [signTransaction],
  );

  return {
    publicKey: publicKey ? publicKey.toBase58() : null,
    connected,
    connecting,
    signAndSend,
  };
}

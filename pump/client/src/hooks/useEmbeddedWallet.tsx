import { useCallback, useEffect, useRef, useState } from "react";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { SafeUser } from "@shared/schema";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ensureVault, importVault, loadVault, solanaKeypair, type Vault } from "@/lib/embeddedWallet";

/**
 * The account's own wallet: created the first time someone signs in, linked to
 * the account with the same signed challenge an extension wallet would use, and
 * used to sign transactions when no extension is connected.
 *
 * Nothing secret leaves the browser — the server only ever receives the address
 * and signatures (see lib/embeddedWallet.ts).
 */

/**
 * One link at a time per browser: several components mount this hook, and the
 * challenge endpoint is rate-limited per IP — without this they would race.
 */
let linkInFlight: Promise<SafeUser> | null = null;

function linkOnce(keypair: Keypair, path: "/api/me/wallet" | "/api/auth/wallet"): Promise<SafeUser> {
  if (!linkInFlight) {
    linkInFlight = signChallenge(keypair, path).finally(() => {
      linkInFlight = null;
    });
  }
  return linkInFlight;
}

async function signChallenge(keypair: Keypair, path: "/api/me/wallet" | "/api/auth/wallet"): Promise<SafeUser> {
  const address = keypair.publicKey.toBase58();
  const res = await fetch(`/api/auth/wallet/nonce?address=${encodeURIComponent(address)}`, { credentials: "include" });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const { nonce, message } = (await res.json()) as { nonce: string; message: string };
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey));
  const linked = await apiRequest("POST", path, { address, signature, nonce });
  return (await linked.json()) as SafeUser;
}

export interface EmbeddedWallet {
  vault: Vault | null;
  /** true while the wallet is being created or linked to the account */
  provisioning: boolean;
  /** Creates the wallet if needed and links it to the signed-in account. */
  provision: () => Promise<Vault>;
  /** Replaces this browser's wallet with an existing recovery phrase, then re-links it. */
  restore: (mnemonic: string) => Promise<Vault>;
  keypair: () => Keypair | null;
}

export function useEmbeddedWallet(): EmbeddedWallet {
  const { user } = useAuth();
  // The wallet belongs to the account, not to the browser: two people signing in
  // here get two wallets, and a deposit meant for one cannot land in the other.
  const scope = user?.id ?? "guest";
  const [vault, setVault] = useState<Vault | null>(() => loadVault(scope));

  // Switching accounts swaps the wallet under everything that reads it.
  useEffect(() => {
    setVault(loadVault(scope));
  }, [scope]);
  const [provisioning, setProvisioning] = useState(false);
  const attempted = useRef<string | null>(null);

  const provision = useCallback(async () => {
    const created = ensureVault(scope);
    setVault(created);
    // Link it whenever the account points somewhere else: this key is the only
    // one this browser can sign with, and the address people deposit to.
    if (user && user.walletAddress !== created.solana) {
      const next = await linkOnce(solanaKeypair(created.mnemonic), "/api/me/wallet");
      queryClient.setQueryData(["/api/me"], next);
      void queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
    }
    return created;
  }, [user, scope]);

  const restore = useCallback(async (mnemonic: string) => {
    const restored = importVault(mnemonic, scope);
    setVault(restored);
    const next = await linkOnce(solanaKeypair(restored.mnemonic), "/api/me/wallet");
    queryClient.setQueryData(["/api/me"], next);
    void queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
    return restored;
  }, [scope]);

  /**
   * Signing in is all it takes to have a wallet: create and link one silently.
   *
   * The link can fail for reasons that pass — a rate limit, a dropped request —
   * and an account without a linked wallet cannot see a balance or trade, so this
   * keeps trying for a while rather than giving up after one go.
   */
  useEffect(() => {
    if (!user) return;
    // The account is settled only when it points at this browser's own wallet.
    const local = vault?.solana ?? loadVault(scope)?.solana ?? null;
    if (user.walletAddress && local && user.walletAddress === local) return;
    // No wallet here yet and the account already has one: nothing to correct.
    if (user.walletAddress && !local) return;
    const key = `${user.id}:${local ?? "new"}`;
    if (attempted.current === key) return;
    attempted.current = key;

    let cancelled = false;
    setProvisioning(true);
    void (async () => {
      for (let attempt = 0; attempt < 4 && !cancelled; attempt += 1) {
        try {
          await provision();
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
        }
      }
      // Out of tries for now; the next sign-in or reload starts over.
      attempted.current = null;
    })().finally(() => {
      if (!cancelled) setProvisioning(false);
    });

    return () => {
      cancelled = true;
    };
  }, [user, provision, scope, vault?.solana]);

  const keypair = useCallback(() => {
    const current = vault ?? loadVault(scope);
    return current ? solanaKeypair(current.mnemonic) : null;
  }, [vault, scope]);

  return { vault, provisioning, provision, restore, keypair };
}

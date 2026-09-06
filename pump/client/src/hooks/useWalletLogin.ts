import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type Adapter, type MessageSignerWalletAdapter, type WalletName } from "@solana/wallet-adapter-base";
import bs58 from "bs58";
import type { SafeUser } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { apiErrorMessage } from "@/hooks/useAuth";
import { useT } from "@/i18n";

/**
 * Sign-In-With-Solana: the wallet signs a server-issued challenge.
 *
 *   1. GET  /api/auth/wallet/nonce?address=<base58> → { message, nonce }
 *   2. signMessage(utf8(message)) (Wallet Standard `signMessage`)
 *   3. POST /api/auth/wallet { address, signature (base58), nonce } → SafeUser   (fresh login)
 *      POST /api/me/wallet    { address, signature (base58), nonce } → SafeUser   (link to an
 *      already-authenticated Google/Apple/email account, so social users can trade too)
 *
 * Wallets are read straight off the adapter (not the `useWallet()` context state) right after
 * connecting, so this never races a React re-render: `select()` is still called so the shared
 * wallet context (used by lib/solana.ts for signing trades) picks up the same wallet.
 */

export interface DetectedWallet {
  name: string;
  icon: string;
  installed: boolean;
}

const isRejection = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message.toLowerCase() : "";
  return msg.includes("reject") || msg.includes("cancel") || msg.includes("denied");
};

async function fetchChallenge(address: string): Promise<{ message: string; nonce: string }> {
  const res = await apiRequest("GET", `/api/auth/wallet/nonce?address=${encodeURIComponent(address)}`);
  return (await res.json()) as { message: string; nonce: string };
}

interface Challenge {
  address: string;
  signature: string;
  nonce: string;
}

async function signChallenge(adapter: Adapter): Promise<Challenge> {
  if (!adapter.connected) await adapter.connect();
  const pk = adapter.publicKey;
  if (!pk) throw new Error("Wallet did not return an address.");
  const signer = adapter as unknown as Partial<MessageSignerWalletAdapter>;
  if (typeof signer.signMessage !== "function") {
    throw new Error("This wallet does not support message signing.");
  }
  const address = pk.toBase58();
  const { message, nonce } = await fetchChallenge(address);
  const signatureBytes = await signer.signMessage(new TextEncoder().encode(message));
  return { address, signature: bs58.encode(signatureBytes), nonce };
}

export function useWalletLogin(options: { onSuccess?: (user: SafeUser) => void } = {}) {
  const { onSuccess } = options;
  const t = useT();
  const { wallets, select } = useWallet();
  const [busyWallet, setBusyWallet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Installed / loadable wallets, ready to show in the picker (with their icons).
   *
   * The generic "Mobile Wallet Adapter" entry the library injects on Android is
   * left out: it is not a wallet anyone recognises, and every account here can
   * already sign with its own wallet.
   */
  const detected: DetectedWallet[] = useMemo(
    () =>
      wallets
        .filter((w) => !/mobile wallet adapter/i.test(w.adapter.name))
        .filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable)
        .map((w) => ({
          name: w.adapter.name,
          icon: w.adapter.icon,
          installed: w.readyState === WalletReadyState.Installed,
        })),
    [wallets],
  );

  const finish = useCallback(
    (user: SafeUser) => {
      queryClient.setQueryData(["/api/me"], user);
      void queryClient.invalidateQueries();
      onSuccess?.(user);
    },
    [onSuccess],
  );

  const clearError = useCallback(() => setError(null), []);

  const withWallet = useCallback(
    async (walletName: string, endpoint: "/api/auth/wallet" | "/api/me/wallet") => {
      const found = wallets.find((w) => w.adapter.name === walletName);
      if (!found) {
        setError(t("auth.walletNoProvider"));
        return;
      }
      setBusyWallet(walletName);
      setError(null);
      try {
        select(walletName as WalletName);
        const challenge = await signChallenge(found.adapter);
        const res = await apiRequest("POST", endpoint, challenge);
        const user = (await res.json()) as SafeUser;
        finish(user);
      } catch (e) {
        setError(isRejection(e) ? t("auth.walletRejected") : apiErrorMessage(e, t("auth.walletFailed")));
      } finally {
        setBusyWallet(null);
      }
    },
    [wallets, select, finish, t],
  );

  /** Fresh sign-in: creates/logs into the account that owns this wallet. */
  const connectWallet = useCallback((walletName: string) => withWallet(walletName, "/api/auth/wallet"), [withWallet]);

  /** Links this wallet to the currently signed-in (Google/Apple/email) account. */
  const linkWallet = useCallback((walletName: string) => withWallet(walletName, "/api/me/wallet"), [withWallet]);

  return {
    wallets: detected,
    connectWallet,
    linkWallet,
    /** true while any wallet flow is in progress */
    busy: busyWallet !== null,
    busyWallet,
    error,
    clearError,
  };
}

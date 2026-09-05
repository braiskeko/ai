import { useCallback, useState } from "react";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import type { SafeUser } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useConfig } from "@/hooks/useConfig";
import { apiErrorMessage } from "@/hooks/useAuth";
import { useT } from "@/i18n";

/**
 * Sign-In-With-Ethereum style login.
 *
 *   1. eth_requestAccounts on the provider (injected or WalletConnect)
 *   2. GET  /api/auth/wallet/nonce?address=0x… → { nonce, message }
 *   3. personal_sign(message)
 *   4. POST /api/auth/wallet { address, signature, nonce } → SafeUser
 *
 * WalletConnect is loaded with a dynamic import ONLY when the deployment has a
 * project id. The package is not part of this build, so the import is guarded
 * and surfaces "not configured" instead of crashing.
 */

export type WalletMethod = "injected" | "walletconnect";

interface WalletProviderLike extends Eip1193Provider {
  isMetaMask?: boolean;
  providers?: WalletProviderLike[];
}

/**
 * EIP-1193 provider injected by MetaMask & co. Read via a cast instead of a
 * `declare global` so we never collide with other Window augmentations.
 */
export function getInjectedProvider(): WalletProviderLike | undefined {
  if (typeof window === "undefined") return undefined;
  const eth = (window as unknown as { ethereum?: WalletProviderLike }).ethereum;
  if (!eth) return undefined;
  // Several extensions installed: prefer MetaMask, else the first one.
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.find((p) => p.isMetaMask) ?? eth.providers[0];
  }
  return eth;
}

const isRejection = (e: unknown) => {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown; error?: { code?: unknown } }).code : undefined;
  const inner = typeof e === "object" && e !== null ? (e as { error?: { code?: unknown } }).error?.code : undefined;
  if (code === 4001 || inner === 4001 || code === "ACTION_REJECTED") return true;
  const msg = e instanceof Error ? e.message.toLowerCase() : "";
  return msg.includes("user rejected") || msg.includes("user denied") || msg.includes("rejected the request");
};

const WALLETCONNECT_PKG = "@walletconnect/ethereum-provider";

export function useWalletLogin(options: { onSuccess?: (user: SafeUser) => void } = {}) {
  const { onSuccess } = options;
  const config = useConfig();
  const t = useT();
  const [busyWith, setBusyWith] = useState<WalletMethod | null>(null);
  const [error, setError] = useState<string | null>(null);

  const walletConnectProjectId = config?.walletConnectProjectId ?? null;
  const hasInjected = typeof window !== "undefined" && !!getInjectedProvider();

  const finish = useCallback(
    (user: SafeUser) => {
      queryClient.setQueryData(["/api/me"], user);
      void queryClient.invalidateQueries();
      onSuccess?.(user);
    },
    [onSuccess],
  );

  /** Shared challenge/sign/verify flow for any EIP-1193 provider. */
  const signInWith = useCallback(
    async (eip1193: Eip1193Provider): Promise<SafeUser> => {
      const provider = new BrowserProvider(eip1193);
      // Prompts the wallet for account access (eth_requestAccounts).
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();

      const nonceRes = await apiRequest("GET", `/api/auth/wallet/nonce?address=${encodeURIComponent(address)}`);
      const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };

      // personal_sign — ethers prefixes and hex-encodes the message correctly.
      const signature = await signer.signMessage(message);

      const res = await apiRequest("POST", "/api/auth/wallet", { address, signature, nonce });
      return (await res.json()) as SafeUser;
    },
    [],
  );

  const run = useCallback(
    async (method: WalletMethod, getProvider: () => Promise<Eip1193Provider | null>) => {
      if (busyWith) return;
      setBusyWith(method);
      setError(null);
      try {
        const eip1193 = await getProvider();
        if (!eip1193) return;
        const user = await signInWith(eip1193);
        finish(user);
      } catch (e) {
        setError(isRejection(e) ? t("auth.walletRejected") : apiErrorMessage(e, t("auth.walletFailed")));
      } finally {
        setBusyWith(null);
      }
    },
    [busyWith, finish, signInWith, t],
  );

  const connectInjected = useCallback(
    () =>
      run("injected", async () => {
        const eth = getInjectedProvider();
        if (!eth) {
          setError(t("auth.walletNoProvider"));
          return null;
        }
        return eth;
      }),
    [run, t],
  );

  const connectWalletConnect = useCallback(
    () =>
      run("walletconnect", async () => {
        if (!walletConnectProjectId) {
          setError(t("auth.notConfigured"));
          return null;
        }
        let mod: {
          EthereumProvider?: {
            init: (opts: Record<string, unknown>) => Promise<Eip1193Provider & { connect?: () => Promise<void> }>;
          };
        };
        try {
          // Non-literal specifier: neither TypeScript nor Vite try to resolve it at build time.
          const spec = WALLETCONNECT_PKG;
          mod = (await import(/* @vite-ignore */ spec)) as typeof mod;
        } catch {
          setError(t("auth.walletConnectMissing"));
          return null;
        }
        if (!mod.EthereumProvider) {
          setError(t("auth.walletConnectMissing"));
          return null;
        }
        const chainId = config?.chain.chainId ?? 1;
        const provider = await mod.EthereumProvider.init({
          projectId: walletConnectProjectId,
          chains: [chainId],
          optionalChains: [chainId],
          showQrModal: true,
          metadata: {
            name: config?.appName ?? "Noxia",
            description: t("app.tagline"),
            url: window.location.origin,
            icons: [`${window.location.origin}/favicon.svg`],
          },
        });
        if (typeof provider.connect === "function") await provider.connect();
        return provider;
      }),
    [run, t, walletConnectProjectId, config?.chain.chainId, config?.appName],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    connectInjected,
    connectWalletConnect,
    /** true while any wallet flow is in progress */
    busy: busyWith !== null,
    busyWith,
    error,
    clearError,
    hasInjected,
    walletConnectConfigured: !!walletConnectProjectId,
  };
}

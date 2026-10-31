import { BrowserProvider, type JsonRpcSigner } from "ethers";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type WalletNetwork, addChainParams, AccountChangedError, WrongNetworkError } from "../wallet/network";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export type WalletStatus = "unavailable" | "disconnected" | "connecting" | "connected";

export interface WalletApi {
  status: WalletStatus;
  account: string | null;
  chainId: number | null;
  targetChainId: number;
  isCorrectChain: boolean;
  epoch: number;
  error: string | null;
  connect(): Promise<void>;
  switchChain(): Promise<void>;
  getSigner(): Promise<JsonRpcSigner>;
}

const WalletContext = createContext<WalletApi | null>(null);

const toChainId = (hex: unknown) => (typeof hex === "string" ? Number.parseInt(hex, 16) : null);

export function WalletProvider({ dep, children }: { dep: WalletNetwork; children: ReactNode }) {
  const ethereum = typeof window === "undefined" ? undefined : window.ethereum;
  const [status, setStatus] = useState<WalletStatus>(ethereum ? "disconnected" : "unavailable");
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ethereum) return;
    let cancelled = false;
    const onAccounts = (...args: unknown[]) => {
      const accounts = (args[0] as string[] | undefined) ?? [];
      setAccount(accounts[0]?.toLowerCase() ?? null);
      setStatus(accounts[0] ? "connected" : "disconnected");
      setEpoch((e) => e + 1);
    };
    const onChain = (...args: unknown[]) => {
      setChainId(toChainId(args[0]));
      setEpoch((e) => e + 1);
    };
    Promise.all([ethereum.request({ method: "eth_accounts" }), ethereum.request({ method: "eth_chainId" })])
      .then(([accounts, chain]) => {
        if (cancelled) return;
        setChainId(toChainId(chain));
        onAccounts(accounts);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Wallet unavailable: ${(err as Error).message}`);
      });
    ethereum.on?.("accountsChanged", onAccounts);
    ethereum.on?.("chainChanged", onChain);
    return () => {
      cancelled = true;
      ethereum.removeListener?.("accountsChanged", onAccounts);
      ethereum.removeListener?.("chainChanged", onChain);
    };
  }, [ethereum]);

  const connect = useCallback(async () => {
    if (!ethereum) {
      setError("No browser wallet detected. Install MetaMask to send transactions; browsing does not require a wallet.");
      return;
    }
    setStatus("connecting");
    setError(null);
    try {
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
      setChainId(toChainId(await ethereum.request({ method: "eth_chainId" })));
      setAccount(accounts[0]?.toLowerCase() ?? null);
      setStatus(accounts[0] ? "connected" : "disconnected");
      setEpoch((e) => e + 1);
    } catch (err) {
      setStatus("disconnected");
      setError((err as { code?: number }).code === 4001 ? "Connection request was rejected in your wallet." : (err as Error).message);
    }
  }, [ethereum]);

  const switchChain = useCallback(async () => {
    if (!ethereum) return;
    const hexId = `0x${dep.chainId.toString(16)}`;
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (err) {
      if ((err as { code?: number }).code !== 4902) {
        setError((err as { code?: number }).code === 4001 ? "Network switch was rejected in your wallet." : (err as Error).message);
        return;
      }
      await ethereum.request({ method: "wallet_addEthereumChain", params: [addChainParams(dep)] });
    }
  }, [ethereum, dep]);

  const getSigner = useCallback(async () => {
    if (!ethereum || !account) throw new AccountChangedError("Connect your wallet first.");
    const provider = new BrowserProvider(ethereum, "any");
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== dep.chainId) {
      throw new WrongNetworkError(`Your wallet is on chain ${network.chainId}. Switch to chain ${dep.chainId} first.`);
    }
    const signer = await provider.getSigner();
    if ((await signer.getAddress()).toLowerCase() !== account) {
      throw new AccountChangedError("The wallet account changed. Review and confirm the action again.");
    }
    return signer;
  }, [ethereum, account, dep.chainId]);

  const value = useMemo<WalletApi>(
    () => ({
      status,
      account,
      chainId,
      targetChainId: dep.chainId,
      isCorrectChain: chainId === dep.chainId,
      epoch,
      error,
      connect,
      switchChain,
      getSigner,
    }),
    [status, account, chainId, dep.chainId, epoch, error, connect, switchChain, getSigner],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletApi {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

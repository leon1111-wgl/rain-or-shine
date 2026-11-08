import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ContractTransactionResponse, JsonRpcSigner } from "ethers";
import { isError } from "ethers";
import { useWallet } from "../hooks/useWallet";
import { createReader, errorMessage, readDashboard, verifyMetricDeployment, type Dashboard, type MetricDeployment } from "./client";

function useController(dep: MetricDeployment) {
  const wallet = useWallet();
  const reader = useMemo(() => createReader(dep), [dep]);
  const [data, setData] = useState<Dashboard>();
  const [dataOwner, setDataOwner] = useState("");
  const identity = `${dep.contracts.PredictionMarket.address}:${dep.bindingTransactionHash}:${wallet.account ?? "none"}:${wallet.chainId}:${wallet.epoch}`;
  const identityRef = useRef(identity);
  const [fault, setFault] = useState("");
  const [loadingStage, setLoadingStage] = useState<"deployment" | "events" | "idle">("deployment");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState("");
  const lock = useRef(false);
  const sequence = useRef(0);
  const pendingRefresh = useRef<{ identity: string; reader: typeof reader; promise: Promise<void> } | null>(null);
  const pendingReadVerification = useRef<{ dep: MetricDeployment; reader: typeof reader; promise: Promise<void> } | null>(null);
  const refresh = useCallback(async (force = false) => {
    if (identity !== identityRef.current) return;
    const existing = pendingRefresh.current;
    if (existing?.identity === identity && existing.reader === reader) {
      if (!force) return existing.promise;
      // A refresh after an action must read a later snapshot.
      await existing.promise;
      if (identity !== identityRef.current) return;
      const newer = pendingRefresh.current;
      if (newer?.identity === identity && newer.reader === reader) return newer.promise;
    }
    const request = ++sequence.current;
    setLoadingStage("deployment");
    const flight = { identity, reader, promise: Promise.resolve() };
    pendingRefresh.current = flight;
    flight.promise = (async () => {
      try {
        let verification = pendingReadVerification.current;
        if (!verification || verification.dep !== dep || verification.reader !== reader) {
          const check = { dep, reader, promise: Promise.resolve() };
          pendingReadVerification.current = check;
          check.promise = (async () => {
            try { await verifyMetricDeployment(dep, reader, { receipts: false }); }
            finally { if (pendingReadVerification.current === check) pendingReadVerification.current = null; }
          })();
          verification = check;
        }
        await verification.promise;
        // Wallet restoration can replace a read during its account-free check.
        if (request !== sequence.current || identity !== identityRef.current) return;
        setLoadingStage("events");
        const next = await readDashboard(dep, reader, wallet.account ?? undefined);
        if (request === sequence.current && identity === identityRef.current) { setData(next); setDataOwner(identity); setFault(""); setLoadingStage("idle"); }
      } catch (error) {
        if (request === sequence.current && identity === identityRef.current) { setFault(errorMessage(error)); setLoadingStage("idle"); }
      } finally {
        if (pendingRefresh.current === flight) pendingRefresh.current = null;
      }
    })();
    return flight.promise;
  }, [dep, reader, wallet.account, identity]);
  const refreshRef = useRef(refresh);
  useLayoutEffect(() => { identityRef.current = identity; refreshRef.current = refresh; }, [identity, refresh]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped) return;
      await refresh();
      // Finish each read before the next RPC round.
      if (!stopped) timer = setTimeout(() => void poll(), dep.environment === "SEPOLIA_UMA" ? 30000 : 5000);
    };
    queueMicrotask(() => void poll());
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, dep.environment]);

  const action = useCallback(async (label: string, task: () => Promise<void>) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setMessage(label + "…"); setTxHash("");
    try {
      await verifyMetricDeployment(dep, reader, { receipts: false });
      await task();
      setMessage(label + ": complete");
      await refreshRef.current(true);
      return true;
    } catch (error) {
      setMessage(label + ": " + errorMessage(error));
      return false;
    } finally { lock.current = false; setBusy(false); }
  }, [dep, reader]);

  const run = useCallback((label: string, send: (signer: JsonRpcSigner) => Promise<ContractTransactionResponse>) => action(label, async () => {
    const signer = await wallet.getSigner();
    await verifyMetricDeployment(dep, signer.provider);
    if (identity !== identityRef.current) throw new Error("The account or network changed. Try the action again");
    const tx = await send(signer);
    setTxHash(tx.hash); setMessage(label + ": waiting for confirmation…");
    let receipt;
    try { receipt = await tx.wait(); }
    catch (error) {
      if (isError(error, "TRANSACTION_REPLACED") && error.reason === "repriced" && error.receipt.status === 1) {
        receipt = error.receipt; setTxHash(error.replacement.hash);
      } else throw error;
    }
    if (!receipt || receipt.status !== 1) throw new Error("The transaction was not confirmed successfully. Refresh the chain state to check it.");
  }), [action, wallet, dep, identity]);

  const advanceTo = (timestamp: number) => action("Advance local chain time", async () => {
    if (dep.environment !== "LOCAL_MOCK" || dep.chainId !== 31337) throw new Error("Available on the local mock chain only");
    const block = await reader.getBlock("latest");
    if (!block) throw new Error("Unable to read the latest block");
    if (timestamp <= block.timestamp) throw new Error("The target time has already passed. Refresh the page");
    await reader.send("evm_setNextBlockTimestamp", [timestamp]);
    await reader.send("evm_mine", []);
  });
  const currentData = dataOwner === identity ? data : undefined;
  return { dep, reader, wallet, data: currentData, fault, loadingStage, busy, message, txHash, refresh, action, run, advanceTo,
    ready: !!currentData && !fault,
    canWrite: !!currentData && !fault && !!wallet.account && wallet.isCorrectChain && !busy,
    isAdmin: wallet.account?.toLowerCase() === dep.admin.toLowerCase() };
}

const Context = createContext<ReturnType<typeof useController> | null>(null);
export function MetricProvider({ dep, children }: { dep: MetricDeployment; children: ReactNode }) {
  const api = useController(dep);
  return <Context.Provider value={api}>{children}</Context.Provider>;
}
export function useMetricApp() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing MetricProvider");
  return value;
}
export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

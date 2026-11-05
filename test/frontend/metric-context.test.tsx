import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JsonRpcProvider, JsonRpcSigner, makeError, type ContractTransactionResponse, type TransactionReceipt, type TransactionResponse } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletApi } from "../../web/src/hooks/useWallet";
import type { Dashboard, MarketView, MetricDeployment, readDashboard, verifyMetricDeployment } from "../../web/src/metric/client";
import { MetricProvider, useMetricApp } from "../../web/src/metric/context";

const mocks = vi.hoisted(() => ({
  useWallet: vi.fn<() => WalletApi>(),
  createReader: vi.fn<(dep: MetricDeployment) => JsonRpcProvider>(),
  readDashboard: vi.fn<typeof readDashboard>(),
  verifyMetricDeployment: vi.fn<typeof verifyMetricDeployment>(),
}));
vi.mock("../../web/src/hooks/useWallet", () => ({ useWallet: mocks.useWallet }));
vi.mock("../../web/src/metric/client", () => ({
  createReader: mocks.createReader,
  readDashboard: mocks.readDashboard,
  verifyMetricDeployment: mocks.verifyMetricDeployment,
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const HASH = `0x${"11".repeat(32)}`;
const DEAD_RPC = "http://127.0.0.1:9";
const contract = (n: number) => ({ address: `0x${String(n).padStart(40, "0")}`, transactionHash: HASH,
  blockNumber: 1, constructorArguments: [], abiKeccak256: HASH, runtimeCodeKeccak256: HASH });
const dep: MetricDeployment = {
  schemaVersion: 1, product: "rainpool-metric-v1", environment: "LOCAL_MOCK", network: "localhost",
  chainId: 31337, publicRpcUrl: DEAD_RPC, deployedAt: "2026-10-19T00:00:00Z", admin: A,
  bindingTransactionHash: HASH,
  contracts: { PredictionMarket: contract(1), UmaMetricOracleAdapter: contract(2), TestBondToken: contract(3), MockOptimisticOracleV3: contract(4) },
  oracle: { optimisticOracleV3: contract(4).address, bondCurrency: contract(3).address, bondSymbol: "tBOND",
    bondDecimals: 6, policyBond: "10000000", minimumBond: "0", identifier: HASH, note: "Synthetic unit-test deployment" },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function dashboard(stake: bigint): Dashboard {
  const market = { id: 1, position: { side: 1n, claimed: false, stake } } as unknown as MarketView;
  return { now: 1800000000, blockNumber: 123, metrics: [], markets: [market], bondBalance: stake, bondAmount: 10000000n };
}
const successfulReceipt = { hash: HASH, status: 1 } as unknown as TransactionReceipt;
const transaction = (wait: () => Promise<TransactionReceipt | null>) => ({ hash: HASH, wait }) as unknown as ContractTransactionResponse;
type Send = (signer: JsonRpcSigner) => Promise<ContractTransactionResponse>;

function Probe({ send }: { send: Send }) {
  const app = useMetricApp();
  return <>
    <output data-testid="position">{app.data?.markets[0]?.position.stake.toString() ?? "loading"}</output>
    <output data-testid="message">{app.message}</output>
    <output data-testid="fault">{app.fault}</output>
    <output data-testid="loading-stage">{app.loadingStage}</output>
    <output data-testid="transaction-hash">{app.txHash}</output>
    <button onClick={() => void app.refresh()}>Refresh</button>
    <button disabled={!app.canWrite} onClick={() => void app.run("Submit", send)}>Submit</button>
  </>;
}

let reader: JsonRpcProvider;
let walletProvider: JsonRpcProvider;
let currentWallet: WalletApi;

function wallet(account: string, epoch: number): WalletApi {
  return { account, epoch, status: "connected", chainId: 31337, targetChainId: 31337, isCorrectChain: true,
    error: null, connect: vi.fn(async () => undefined), switchChain: vi.fn(async () => undefined),
    getSigner: vi.fn(async () => new JsonRpcSigner(walletProvider, account)) };
}
function tree(send: Send) { return <MetricProvider dep={dep}><Probe send={send} /></MetricProvider>; }

beforeEach(() => {
  vi.resetAllMocks();
  reader = new JsonRpcProvider(DEAD_RPC);
  walletProvider = new JsonRpcProvider(DEAD_RPC);
  currentWallet = wallet(A, 1);
  mocks.useWallet.mockImplementation(() => currentWallet);
  mocks.createReader.mockReturnValue(reader);
  mocks.verifyMetricDeployment.mockResolvedValue(undefined);
  mocks.readDashboard.mockImplementation(async (_dep, _reader, account) => dashboard(account === B ? 222n : 111n));
});
afterEach(() => { reader.destroy(); walletProvider.destroy(); });

describe("metric controller account and provider boundaries", () => {
  it("shares pending deployment verification and skips the anonymous event scan when a wallet is restored", async () => {
    const check = deferred<undefined>();
    const events = deferred<Dashboard>();
    mocks.verifyMetricDeployment.mockReturnValueOnce(check.promise);
    mocks.readDashboard.mockReturnValueOnce(events.promise);
    currentWallet = { ...wallet(A, 0), account: null, chainId: null, status: "disconnected", isCorrectChain: false };
    const view = render(tree(vi.fn<Send>()));
    await waitFor(() => expect(mocks.verifyMetricDeployment).toHaveBeenCalledOnce());
    expect(screen.getByTestId("loading-stage")).toHaveTextContent("deployment");
    expect(mocks.readDashboard).not.toHaveBeenCalled();

    currentWallet = wallet(A, 1);
    view.rerender(tree(vi.fn<Send>()));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.verifyMetricDeployment).toHaveBeenCalledOnce();
    await act(async () => { check.resolve(undefined); });
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledOnce());
    expect(mocks.readDashboard).toHaveBeenCalledWith(dep, reader, A);
    expect(screen.getByTestId("loading-stage")).toHaveTextContent("events");
    expect(screen.getByTestId("position")).toHaveTextContent("loading");
    await act(async () => { events.resolve(dashboard(111n)); });
    expect(screen.getByTestId("position")).toHaveTextContent("111");
    expect(screen.getByTestId("loading-stage")).toHaveTextContent("idle");
  });

  it("retries after a shared verification failure without retaining the failed flight", async () => {
    const check = deferred<undefined>();
    mocks.verifyMetricDeployment.mockReturnValueOnce(check.promise);
    const view = render(tree(vi.fn<Send>()));
    await waitFor(() => expect(mocks.verifyMetricDeployment).toHaveBeenCalledOnce());
    currentWallet = wallet(B, 2);
    view.rerender(tree(vi.fn<Send>()));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.verifyMetricDeployment).toHaveBeenCalledOnce();
    await act(async () => { check.reject(new Error("RPC unavailable")); });
    expect(mocks.readDashboard).not.toHaveBeenCalled();
    expect(screen.getByTestId("fault")).toHaveTextContent("RPC unavailable");
    expect(screen.getByTestId("loading-stage")).toHaveTextContent("idle");

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByTestId("position")).toHaveTextContent("222"));
    expect(mocks.verifyMetricDeployment).toHaveBeenCalledTimes(2);
    expect(mocks.readDashboard).toHaveBeenCalledOnce();
    expect(mocks.readDashboard).toHaveBeenCalledWith(dep, reader, B);
    expect(screen.getByTestId("fault")).toBeEmptyDOMElement();
    expect(screen.getByTestId("loading-stage")).toHaveTextContent("idle");
  });
  it("shares one pending read across repeated manual refreshes for the same wallet", async () => {
    const pending = deferred<Dashboard>();
    mocks.readDashboard.mockReturnValue(pending.promise);
    render(tree(vi.fn<Send>()));
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.readDashboard).toHaveBeenCalledOnce();
    expect(mocks.verifyMetricDeployment).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(dashboard(111n)); });
    expect(screen.getByTestId("position")).toHaveTextContent("111");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledTimes(2));
  });

  it("does not let an old wallet read clear the current wallet's pending read", async () => {
    const pendingA = deferred<Dashboard>();
    const pendingB = deferred<Dashboard>();
    mocks.readDashboard.mockImplementation((_dep, _reader, account) => account === A ? pendingA.promise : pendingB.promise);
    const send = vi.fn<Send>();
    const view = render(tree(send));
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledWith(dep, reader, A));
    currentWallet = wallet(B, 2);
    view.rerender(tree(send));
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledWith(dep, reader, B));
    await act(async () => { pendingA.resolve(dashboard(111n)); });
    expect(screen.getByTestId("position")).toHaveTextContent("loading");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.readDashboard).toHaveBeenCalledTimes(2);
    await act(async () => { pendingB.resolve(dashboard(222n)); });
    expect(screen.getByTestId("position")).toHaveTextContent("222");
  });

  it("takes a fresh snapshot after a transaction even when a pre-transaction refresh is pending", async () => {
    const pending = deferred<Dashboard>();
    mocks.readDashboard.mockResolvedValueOnce(dashboard(111n)).mockReturnValueOnce(pending.promise).mockResolvedValue(dashboard(333n));
    const send = vi.fn<Send>().mockResolvedValue(transaction(async () => successfulReceipt));
    render(tree(send));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(mocks.readDashboard).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve(dashboard(111n)); });
    await waitFor(() => expect(screen.getByTestId("position")).toHaveTextContent("333"));
    expect(mocks.readDashboard).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("message")).toHaveTextContent("Submit: complete");
  });

  it("does not restore A's position when A's delayed dashboard arrives after B's dashboard", async () => {
    const pendingA = deferred<Dashboard>();
    const pendingB = deferred<Dashboard>();
    mocks.readDashboard.mockImplementation((_dep, _reader, account) => account === A ? pendingA.promise : pendingB.promise);
    const send = vi.fn<Send>();
    const view = render(tree(send));
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledWith(dep, reader, A));

    currentWallet = wallet(B, 2);
    view.rerender(tree(send));
    expect(screen.getByTestId("position")).toHaveTextContent("loading");
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledWith(dep, reader, B));
    await act(async () => { pendingB.resolve(dashboard(222n)); });
    expect(screen.getByTestId("position")).toHaveTextContent("222");

    await act(async () => { pendingA.resolve(dashboard(111n)); });
    expect(screen.getByTestId("position")).toHaveTextContent("222");
    expect(screen.getByTestId("position")).not.toHaveTextContent("111");
  });

  it("refreshes B, not the submitting account A, after A's pending receipt completes", async () => {
    const pendingReceipt = deferred<TransactionReceipt | null>();
    const wait = vi.fn(() => pendingReceipt.promise);
    const send = vi.fn<Send>().mockResolvedValue(transaction(wait));
    const view = render(tree(send));
    await waitFor(() => expect(screen.getByTestId("position")).toHaveTextContent("111"));
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(wait).toHaveBeenCalledOnce());

    currentWallet = wallet(B, 2);
    view.rerender(tree(send));
    expect(screen.getByTestId("position")).toHaveTextContent("loading");
    await waitFor(() => expect(screen.getByTestId("position")).toHaveTextContent("222"));
    mocks.readDashboard.mockClear();

    await act(async () => { pendingReceipt.resolve(successfulReceipt); });
    await waitFor(() => expect(mocks.readDashboard).toHaveBeenCalledWith(dep, reader, B));
    expect(mocks.readDashboard.mock.calls.every((call) => call[2] === B)).toBe(true);
    expect(screen.getByTestId("position")).toHaveTextContent("222");
    expect(screen.getByTestId("message")).toHaveTextContent("Submit: complete");
    expect(send).toHaveBeenCalledOnce();
  });

  it("blocks send when the reader verifies but the wallet provider fails deployment verification", async () => {
    mocks.verifyMetricDeployment.mockImplementation(async (_dep, provider) => {
      if (provider === walletProvider) throw new Error("wallet deployment mismatch");
    });
    const send = vi.fn<Send>();
    render(tree(send));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("wallet deployment mismatch"));
    expect(mocks.verifyMetricDeployment).toHaveBeenCalledWith(dep, reader);
    expect(mocks.verifyMetricDeployment).toHaveBeenCalledWith(dep, walletProvider);
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks send if the account changes while the wallet provider is being verified", async () => {
    const walletCheck = deferred<undefined>();
    mocks.verifyMetricDeployment.mockImplementation((_dep, provider) => provider === walletProvider ? walletCheck.promise : Promise.resolve());
    const send = vi.fn<Send>();
    const view = render(tree(send));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mocks.verifyMetricDeployment).toHaveBeenCalledWith(dep, walletProvider));

    currentWallet = wallet(B, 2);
    view.rerender(tree(send));
    await waitFor(() => expect(screen.getByTestId("position")).toHaveTextContent("222"));
    await act(async () => { walletCheck.resolve(undefined); });
    await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("account or network changed"));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId("position")).toHaveTextContent("222");
  });
});

describe("numeric transaction receipt lifecycle", () => {
  it("stays pending until a successful receipt arrives", async () => {
    const pending = deferred<TransactionReceipt | null>();
    const send = vi.fn<Send>().mockResolvedValue(transaction(() => pending.promise));
    render(tree(send));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("waiting for confirmation"));
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(screen.getByTestId("message")).not.toHaveTextContent("complete");
    await act(async () => { pending.resolve(successfulReceipt); });
    await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("Submit: complete"));
  });

  it.each([null, { hash: HASH, status: 0 } as unknown as TransactionReceipt])(
    "does not report success for an absent or reverted receipt: %j",
    async (receipt) => {
      const send = vi.fn<Send>().mockResolvedValue(transaction(async () => receipt));
      render(tree(send));
      await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "Submit" }));
      await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("transaction was not confirmed successfully"));
      expect(screen.getByTestId("message")).not.toHaveTextContent("complete");
    },
  );

  it.each(["cancelled", "repriced"] as const)(
    "handles a %s replacement according to the confirmed replacement receipt",
    async (reason) => {
      const replacementHash = `0x${"22".repeat(32)}`;
      const error = makeError("transaction was replaced", "TRANSACTION_REPLACED", {
        cancelled: reason === "cancelled", reason, hash: HASH,
        replacement: { hash: replacementHash } as unknown as TransactionResponse,
        receipt: { hash: replacementHash, status: 1 } as unknown as TransactionReceipt,
      });
      const send = vi.fn<Send>().mockResolvedValue(transaction(async () => { throw error; }));
      render(tree(send));
      await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "Submit" }));
      if (reason === "repriced") {
        await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("Submit: complete"));
        expect(screen.getByTestId("transaction-hash")).toHaveTextContent(replacementHash);
      } else {
        await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("transaction was replaced"));
        expect(screen.getByTestId("message")).not.toHaveTextContent("complete");
      }
    },
  );
});

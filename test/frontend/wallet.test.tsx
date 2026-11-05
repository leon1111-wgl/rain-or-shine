import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { type Eip1193Provider, useWallet, WalletProvider } from "../../web/src/hooks/useWallet";
import { addChainParams, type WalletNetwork } from "../../web/src/wallet/network";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const network: WalletNetwork = { chainId: 31337, publicRpcUrl: "http://127.0.0.1:9" };
type Request = Parameters<Eip1193Provider["request"]>[0];

class FakeWallet implements Eip1193Provider {
  accounts: string[] = [];
  chainId = "0x7a69";
  calls: Request[] = [];
  rejectConnect = false;
  switchError: number | null = null;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  async request(args: Request): Promise<unknown> {
    this.calls.push(args);
    if (args.method === "eth_accounts") return this.accounts;
    if (args.method === "eth_chainId") return this.chainId;
    if (args.method === "eth_requestAccounts") {
      if (this.rejectConnect) throw Object.assign(new Error("rejected"), { code: 4001 });
      this.accounts = [A];
      return this.accounts;
    }
    if (args.method === "wallet_switchEthereumChain") {
      if (this.switchError !== null) throw Object.assign(new Error("switch failed"), { code: this.switchError });
      this.chainId = (args.params as Array<{ chainId: string }>)[0]!.chainId;
      this.emit("chainChanged", this.chainId);
      return null;
    }
    if (args.method === "wallet_addEthereumChain") return null;
    throw new Error(`unexpected wallet method: ${args.method}`);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function Probe() {
  const wallet = useWallet();
  const [signerResult, setSignerResult] = useState("");
  async function readSigner() {
    try {
      const signer = await wallet.getSigner();
      setSignerResult((await signer.getAddress()).toLowerCase());
    } catch (error) {
      setSignerResult(error instanceof Error ? error.message : String(error));
    }
  }
  return <>
    <output data-testid="status">{wallet.status}</output>
    <output data-testid="account">{wallet.account ?? "none"}</output>
    <output data-testid="chain">{wallet.chainId ?? "none"}</output>
    <output data-testid="correct-chain">{String(wallet.isCorrectChain)}</output>
    <output data-testid="epoch">{wallet.epoch}</output>
    <output data-testid="error">{wallet.error}</output>
    <output data-testid="signer">{signerResult}</output>
    <button onClick={() => void wallet.connect()}>Connect</button>
    <button onClick={() => void wallet.switchChain()}>Switch network</button>
    <button onClick={() => void readSigner()}>Read signer</button>
  </>;
}

function tree() { return <WalletProvider dep={network}><Probe /></WalletProvider>; }

describe("numeric app wallet connection", () => {
  it("stays read-only without a wallet and rejects getting a signer", async () => {
    render(tree());
    expect(screen.getByTestId("status")).toHaveTextContent("unavailable");
    expect(screen.getByTestId("account")).toHaveTextContent("none");
    expect(screen.getByTestId("correct-chain")).toHaveTextContent("false");
    await userEvent.click(screen.getByRole("button", { name: "Read signer" }));
    expect(screen.getByTestId("signer")).toHaveTextContent("Connect your wallet first");
  });

  it("restores an authorized account without requesting permission", async () => {
    const wallet = new FakeWallet();
    wallet.accounts = [A];
    window.ethereum = wallet;
    render(tree());
    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent(A));
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
    expect(wallet.calls.map((call) => call.method)).not.toContain("eth_requestAccounts");
  });

  it("connects, follows account and chain changes, switches back, and removes listeners", async () => {
    const wallet = new FakeWallet();
    window.ethereum = wallet;
    const view = render(tree());
    await waitFor(() => expect(screen.getByTestId("chain")).toHaveTextContent("31337"));
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent(A));
    const epoch = Number(screen.getByTestId("epoch").textContent);
    act(() => { wallet.accounts = [B]; wallet.emit("accountsChanged", [B]); });
    expect(screen.getByTestId("account")).toHaveTextContent(B);
    expect(Number(screen.getByTestId("epoch").textContent)).toBeGreaterThan(epoch);
    act(() => { wallet.chainId = "0x1"; wallet.emit("chainChanged", "0x1"); });
    expect(screen.getByTestId("correct-chain")).toHaveTextContent("false");
    await userEvent.click(screen.getByRole("button", { name: "Switch network" }));
    await waitFor(() => expect(screen.getByTestId("correct-chain")).toHaveTextContent("true"));
    expect(wallet.calls).toContainEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7a69" }] });
    expect(wallet.listeners.get("accountsChanged")!.size).toBe(1);
    view.unmount();
    expect(wallet.listeners.get("accountsChanged")!.size).toBe(0);
    expect(wallet.listeners.get("chainChanged")!.size).toBe(0);
  });

  it("clears the connected identity when the wallet removes all accounts", async () => {
    const wallet = new FakeWallet();
    wallet.accounts = [A];
    window.ethereum = wallet;
    render(tree());
    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent(A));
    act(() => { wallet.accounts = []; wallet.emit("accountsChanged", []); });
    expect(screen.getByTestId("account")).toHaveTextContent("none");
    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
    await userEvent.click(screen.getByRole("button", { name: "Read signer" }));
    expect(screen.getByTestId("signer")).toHaveTextContent("Connect your wallet first");
  });

  it("reports a rejected connection without connecting an account", async () => {
    const wallet = new FakeWallet();
    wallet.rejectConnect = true;
    window.ethereum = wallet;
    render(tree());
    await waitFor(() => expect(screen.getByTestId("chain")).toHaveTextContent("31337"));
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByTestId("error")).toHaveTextContent("Connection request was rejected");
    expect(screen.getByTestId("account")).toHaveTextContent("none");
    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
  });

  it("adds an unknown network using only the configured chain and RPC", async () => {
    const wallet = new FakeWallet();
    wallet.switchError = 4902;
    window.ethereum = wallet;
    render(tree());
    await userEvent.click(screen.getByRole("button", { name: "Switch network" }));
    expect(wallet.calls).toContainEqual({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x7a69",
        chainName: "Hardhat Local",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [network.publicRpcUrl],
      }],
    });
    expect(addChainParams({ chainId: 11155111, publicRpcUrl: "https://rpc.example" })).toEqual({
      chainId: "0xaa36a7",
      chainName: "Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://rpc.example"],
      blockExplorerUrls: ["https://sepolia.etherscan.io"],
    });
  });

  it("reports a rejected network switch and does not try adding the network", async () => {
    const wallet = new FakeWallet();
    wallet.switchError = 4001;
    window.ethereum = wallet;
    render(tree());
    await userEvent.click(screen.getByRole("button", { name: "Switch network" }));
    expect(screen.getByTestId("error")).toHaveTextContent("Network switch was rejected");
    expect(wallet.calls.map((call) => call.method)).not.toContain("wallet_addEthereumChain");
  });

  it("rechecks the actual wallet chain before returning a signer", async () => {
    const wallet = new FakeWallet();
    wallet.accounts = [A];
    window.ethereum = wallet;
    render(tree());
    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent(A));
    wallet.chainId = "0x1";
    await userEvent.click(screen.getByRole("button", { name: "Read signer" }));
    await waitFor(() => expect(screen.getByTestId("signer")).toHaveTextContent("Switch to chain 31337 first"));
  });

  it("rejects an account that changes before the provider notification arrives", async () => {
    const wallet = new FakeWallet();
    wallet.accounts = [A];
    window.ethereum = wallet;
    render(tree());
    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent(A));
    wallet.accounts = [B];
    await userEvent.click(screen.getByRole("button", { name: "Read signer" }));
    await waitFor(() => expect(screen.getByTestId("signer")).toHaveTextContent("wallet account changed"));
  });

  it("returns a signer only for the connected account on the configured chain", async () => {
    const wallet = new FakeWallet();
    wallet.accounts = [A];
    window.ethereum = wallet;
    render(tree());
    await waitFor(() => expect(screen.getByTestId("account")).toHaveTextContent(A));
    await userEvent.click(screen.getByRole("button", { name: "Read signer" }));
    await waitFor(() => expect(screen.getByTestId("signer")).toHaveTextContent(A));
    expect(wallet.calls.map((call) => call.method)).not.toContain("eth_sendTransaction");
  });
});

// Chain names, short forms of addresses and hashes, and explorer links for the selected deployment.

import type { MetricDeployment } from "../metric/client";

export const CHAIN_NAMES: Record<number, string> = { 11155111: "Sepolia", 31337: "Local Hardhat" };

/** 0x1234…abcd for addresses and hashes shown inline. Links and titles carry the full value. */
export const shortHex = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

export function explorerTx(dep: MetricDeployment, hash: string): string | null {
  return dep.chainId === 11155111 ? `https://sepolia.etherscan.io/tx/${hash}` : null;
}

export function explorerAddress(dep: MetricDeployment, address: string): string | null {
  return dep.chainId === 11155111 ? `https://sepolia.etherscan.io/address/${address}` : null;
}

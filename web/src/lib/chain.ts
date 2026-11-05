import type { MetricDeployment } from "../metric/client";

export const CHAIN_NAMES: Record<number, string> = { 11155111: "Sepolia", 31337: "Local Hardhat" };

export const shortHex = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

export function explorerTx(dep: MetricDeployment, hash: string): string | null {
  return dep.chainId === 11155111 ? `https://sepolia.etherscan.io/tx/${hash}` : null;
}

export function explorerAddress(dep: MetricDeployment, address: string): string | null {
  return dep.chainId === 11155111 ? `https://sepolia.etherscan.io/address/${address}` : null;
}

export interface WalletNetwork {
  chainId: number;
  publicRpcUrl: string;
}

export class WrongNetworkError extends Error {}
export class AccountChangedError extends Error {}

export function addChainParams(network: WalletNetwork) {
  return {
    chainId: `0x${network.chainId.toString(16)}`,
    chainName: network.chainId === 11155111 ? "Sepolia" : "Hardhat Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [network.publicRpcUrl],
    ...(network.chainId === 11155111 ? { blockExplorerUrls: ["https://sepolia.etherscan.io"] } : {}),
  };
}

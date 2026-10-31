import { configVariable, defineConfig } from "hardhat/config";
import base from "./hardhat.config.js";

// This configuration never loads a private key or connects a transaction signer
// to Sepolia. Remote RPC requests only read state; transactions run in local EDR.
const requestedBlock = process.env.SEPOLIA_FORK_BLOCK;
const blockNumber = requestedBlock === undefined ? undefined : Number(requestedBlock);
if (requestedBlock !== undefined
  && (!/^[1-9]\d*$/.test(requestedBlock) || !Number.isSafeInteger(blockNumber))) {
  throw new Error("SEPOLIA_FORK_BLOCK must be a positive safe integer");
}

export default defineConfig({
  ...base,
  paths: { ...base.paths, tests: { mocha: "./test/fork" } },
  networks: {
    sepoliaFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 11155111,
      forking: {
        url: configVariable("SEPOLIA_RPC_URL", {
          default: "https://ethereum-sepolia-rpc.publicnode.com",
        }),
        ...(blockNumber === undefined ? {} : { blockNumber }),
      },
    },
  },
});

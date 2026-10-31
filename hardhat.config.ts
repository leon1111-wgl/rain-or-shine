import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

const SOLC_VERSION = "0.8.37";
const compiler = {
  version: SOLC_VERSION,
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
  },
};

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    profiles: {
      default: compiler,
      production: compiler,
    },
  },
  paths: {
    tests: { mocha: "./test/contracts" },
  },
  test: {
    mocha: { timeout: 300_000 },
  },
  coverage: {
    skipFiles: ["contracts/test/**"],
  },
  networks: {
    localhost: {
      type: "http",
      chainType: "l1",
      chainId: 31337,
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL", { default: "https://ethereum-sepolia-rpc.publicnode.com" }),
      accounts: [configVariable("SEPOLIA_DEPLOYER_KEY")],
    },
  },
});

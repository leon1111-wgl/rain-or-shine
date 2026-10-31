import { JsonRpcProvider } from "ethers";

const seconds = Number(process.argv[2]);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30 * 86_400) {
  throw new Error("usage: npm run local:advance -- <seconds between 1 and 2592000>");
}
const provider = new JsonRpcProvider("http://127.0.0.1:8545");
const { chainId } = await provider.getNetwork();
if (chainId !== 31337n) throw new Error(`refusing to change time on chainId ${chainId}: local Hardhat node (31337) only`);
await provider.send("evm_increaseTime", [seconds]);
await provider.send("evm_mine", []);
const block = await provider.getBlock("latest");
console.log(`LOCAL DEMO fast-forward: +${seconds} s; chain time is now ${new Date(block!.timestamp * 1000).toISOString()}`);
provider.destroy();

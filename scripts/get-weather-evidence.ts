// The HKO evidence tool for proposers. It fetches the month's Daily Extract and checks the day's readings.
// It saves the files for the result panel. It signs and sends nothing. Messages are in English and Chinese.

import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectWeatherEvidence, type WeatherSelection } from "../src/weather/collect-evidence.js";
import { WeatherDataError } from "../src/weather/strict.js";

const portableEntry = process.platform === "darwin" ? "./GET-WEATHER.command" : "GET-WEATHER.cmd";
const HELP = `Rain or Shine: HKO weather evidence / 天文台天气证据
It fetches data and saves files. It signs nothing and sends no transaction. / 只获取数据并保存文件，不签名，也不发交易。

Double-click ${portableEntry} and answer the questions. / 双击 ${portableEntry}，按提示回答。
Command line / 命令行: ${portableEntry} --date YYYYMMDD [--metric rainfall|max-temperature|both] [--out-dir DIR]
From source / 源码: npm run weather:collect -- --date YYYYMMDD --metric both

Data for a day appears after the Hong Kong day ends and HKO publishes it. / 香港当天结束、天文台发布后才有数据。
Files go to weather-results/<date>-<time>/. Nothing is overwritten. / 文件保存在 weather-results/<日期>-<时间>/，不会覆盖已有文件。
Official market: import hko-<date>-<metric>.json. / 官方市场：导入 hko-<日期>-<指标>.json。
Daily Extract field market: import dailyExtract_<YYYYMM>.xml. / 每日摘要字段市场：导入 dailyExtract_<年月>.xml。
`;
const metrics: Record<string, WeatherSelection> = {
  "1": "rainfall", "2": "max-temperature", "3": "both",
  rainfall: "rainfall", "max-temperature": "max-temperature", both: "both",
};
async function main() {
  const args = process.argv.slice(2);
  const { values } = parseArgs({ args, strict: true, options: {
    date: { type: "string" }, metric: { type: "string" }, "out-dir": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(HELP); return; }
  let date = values.date;
  let selection: string = values.metric ?? "both";
  if (args.length === 0) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10).replaceAll("-", "");
      console.log("Rain or Shine: HKO weather evidence / 天文台天气证据\nNo wallet is needed. / 不需要钱包。\n");
      date = (await input.question(`Hong Kong date YYYYMMDD / 香港日期 (Enter = ${yesterday}): `)).trim() || yesterday;
      selection = (await input.question("Metric / 指标: 1 = daily rainfall / 日总雨量, 2 = daily maximum temperature / 日最高气温, 3 = both / 两者 (Enter = 3): ")).trim() || "both";
    } finally { input.close(); }
  }
  if (!date) throw new Error(`Give --date YYYYMMDD, or double-click ${portableEntry}. / 请提供 --date YYYYMMDD，或双击 ${portableEntry}。`);
  const selected = Object.hasOwn(metrics, selection) ? metrics[selection] : undefined;
  if (!selected) throw new Error("The metric must be rainfall, max-temperature, both, or 1, 2, 3. / 指标请选 rainfall、max-temperature、both，或 1、2、3。");
  console.log(`Fetching HKO data for ${date} (${selected}). This can take a minute. / 正在获取 ${date} 的天文台数据（${selected}），可能需要一分钟。`);
  const collected = await collectWeatherEvidence(date, selected, { timeoutMs: 12000, retries: 2 });
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const directory = resolve(values["out-dir"] ?? "weather-results", collected.date + "-" + stamp);
  await mkdir(resolve(directory, ".."), { recursive: true });
  await mkdir(directory); // A collection never replaces an existing evidence snapshot.
  const files: string[] = [];
  for (const bundle of collected.bundles) {
    const metric = bundle.observation.metric === "TOTAL_RAINFALL_MM" ? "rainfall" : "max-temperature";
    const file = resolve(directory, `hko-${collected.date}-${metric}.json`);
    await writeFile(file, JSON.stringify(bundle, null, 2) + "\n", { flag: "wx" });
    files.push(file);
    console.log(`Saved / 已保存 ${metric}: ${bundle.observation.valueText} ${bundle.observation.unit}\n  ${file}`);
  }
  const month = resolve(directory, `dailyExtract_${collected.date.slice(0, 6)}.xml`);
  await writeFile(month, collected.raw.bytes, { flag: "wx" });
  const observation = collected.bundles[0]!.observation;
  await writeFile(resolve(directory, "capture.meta.json"), JSON.stringify({
    captureTool: "Rain or Shine weather collector", targetDate: collected.date,
    sourceURL: collected.raw.sourceURL, fetchedAt: collected.raw.fetchedAt,
    httpStatus: collected.raw.httpStatus, byteLength: collected.raw.bytes.length,
    rawSha256: observation.rawSha256, bundleFiles: files.map(file => file.slice(directory.length + 1)),
    monthlyFile: month.slice(directory.length + 1),
  }, null, 2) + "\n", { flag: "wx" });
  console.log([
    "", "Done. Folder / 完成。文件夹：", directory, "",
    "Official market: import hko-*.json. / 官方市场：导入 hko-*.json。",
    "Field market: import dailyExtract_*.xml. / 字段市场：导入 dailyExtract_*.xml。",
    "capture.meta.json is a record, not a result. / capture.meta.json 是采集记录，不是结果文件。",
    "The files hold readings. The contract decides Yes or No. / 文件里是读数。Yes 或 No 由合约判定。",
  ].join("\n"));
}
main().catch((error: unknown) => {
  console.error("Failed / 失败: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = error instanceof WeatherDataError ? (error.code === "DATA_UNAVAILABLE" ? 2 : 3) : 1;
});

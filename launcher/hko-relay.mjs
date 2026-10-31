export const HKO_RELAY_PREFIX = "/hko-open-data";
const OPEN_DATA = "https://data.weather.gov.hk";
// The Daily Extract file sends no CORS header, so a browser can only read it through this relay.
const HKO_SITE = "https://www.hko.gov.hk";
const LANG = /^(en|sc|tc)$/;
const JSON_TYPE = "application/json; charset=utf-8";
const ALLOWED = [
  { origin: OPEN_DATA, path: "/weatherAPI/opendata/weather.php", params: { dataType: /^rhrread$/, lang: LANG }, type: JSON_TYPE },
  { origin: OPEN_DATA, path: "/weatherAPI/opendata/hourlyRainfall.php", params: { lang: LANG }, type: JSON_TYPE },
  { origin: OPEN_DATA, path: "/weatherAPI/opendata/opendata.php", params: { dataType: /^RYES$/, date: /^\d{8}$/, lang: LANG, station: /^HKO$/ }, type: JSON_TYPE },
  { origin: HKO_SITE, path: /^\/cis\/dailyExtract\/dailyExtract_\d{6}\.xml$/, params: {}, type: "text/xml; charset=utf-8" },
];
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 256 * 1024;

export function hkoUpstreamUrl(requestUrl) {
  return allowedRead(requestUrl)?.url ?? null;
}

function allowedRead(requestUrl) {
  if (typeof requestUrl !== "string" || !requestUrl.startsWith(`${HKO_RELAY_PREFIX}/`)) return null;
  let url;
  try {
    url = new URL(requestUrl.slice(HKO_RELAY_PREFIX.length), OPEN_DATA);
  } catch {
    return null;
  }
  if (url.origin !== OPEN_DATA || url.hash) return null;
  const rule = ALLOWED.find((r) => (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)));
  if (!rule) return null;
  const keys = [...url.searchParams.keys()];
  const expected = Object.keys(rule.params);
  if (keys.length !== expected.length || new Set(keys).size !== keys.length) return null;
  if (!expected.every((k) => rule.params[k].test(url.searchParams.get(k) ?? ""))) return null;
  return { url: new URL(url.pathname + url.search, rule.origin).href, type: rule.type };
}

const text = (status, body) => ({ status, type: "text/plain; charset=utf-8", body });

export async function relayHko(requestUrl, fetchImpl = (input, init) => fetch(input, init)) {
  const read = allowedRead(requestUrl);
  if (!read) return text(404, "not an allowed HKO read\n");
  try {
    const response = await fetchImpl(read.url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return text(502, `HKO answered HTTP ${response.status}\n`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return text(502, "HKO response larger than expected\n");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) return text(502, "HKO response larger than expected\n");
    return { status: 200, type: read.type, body: bytes };
  } catch (error) {
    return text(502, `HKO unreachable: ${error?.cause?.code ?? error?.name ?? "error"}\n`);
  }
}

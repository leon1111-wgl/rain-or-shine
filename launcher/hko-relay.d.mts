export declare const HKO_RELAY_PREFIX: "/hko-open-data";
export declare function hkoUpstreamUrl(requestUrl: string): string | null;
export interface RelayResult {
  status: number;
  type: string;
  body: string | Uint8Array;
}
export declare function relayHko(requestUrl: string, fetchImpl?: typeof fetch): Promise<RelayResult>;

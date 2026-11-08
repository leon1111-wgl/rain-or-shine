/** Returns the address as a link target for http and https. Other addresses return null and show as text.
 * A javascript:, data: or vbscript: address from the chain never becomes a link. */
export function webHref(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

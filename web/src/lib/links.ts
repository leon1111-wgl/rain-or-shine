/** The address as a link target when it is a web address (http or https), otherwise null, and the page shows it as text.
 * A javascript:, data: or vbscript: address from the chain never becomes a link. */
export function webHref(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

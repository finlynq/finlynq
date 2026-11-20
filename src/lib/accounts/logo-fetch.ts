/**
 * Fetch a bank's icon from its website (GH #420, 2026-11-20). SERVER ONLY.
 *
 * Runs only when a user types their bank's domain and asks for its logo; a
 * page load never contacts a third party. The bytes go back to the browser,
 * which draws them onto a canvas and saves the PNG through the normal
 * upload path, so this module never stores anything.
 *
 * The URL comes from user input, so every request is guarded against SSRF:
 *   - https only, a real hostname (no IP literals, no localhost);
 *   - every DNS answer must be a public address, checked INSIDE the socket's
 *     own lookup so the address connected to is the one checked (no
 *     check-then-resolve-again rebinding gap);
 *   - redirects are followed by hand (at most 3), each hop re-checked;
 *   - 6 s timeout, response capped at 512 KB, and only real image formats
 *     (PNG, JPEG, GIF, WebP, ICO by their magic bytes) are returned. SVG is
 *     refused: it can carry script, and the canvas step can't rely on it.
 */

import https from "node:https";
import dns from "node:dns";
import net from "node:net";

const MAX_ICON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;

export class LogoFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoFetchError";
  }
}

/**
 * "https://www.ExampleBank.com/personal?x=1" -> "www.examplebank.com".
 * Null when the input isn't a plain public hostname. Pure.
 */
export function normalizeInstitutionDomain(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0];
  if (v.includes("@")) return null;
  v = v.replace(/:\d+$/, "").replace(/\.$/, "");
  if (v.length > 253 || !v.includes(".")) return null;
  if (net.isIP(v) || /^\[/.test(v)) return null;
  const labels = v.split(".");
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1]) && !/^xn--[a-z0-9-]+$/.test(labels[labels.length - 1])) return null;
  if (v === "localhost" || v.endsWith(".localhost") || v.endsWith(".local") || v.endsWith(".internal")) return null;
  return v;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** True only for a globally routable unicast address. Pure. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED_V4.some(([b, n]) => inV4(ip, b, n));
  if (family !== 6) return false;
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPublicAddress(mapped[1]);
  if (v === "::" || v === "::1") return false;
  const first = parseInt(v.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (v.startsWith("2001:db8:") || v.startsWith("2001:0db8:")) return false; // documentation
  if (v.startsWith("64:ff9b:")) return false; // NAT64, maps to v4 we can't see
  if (v.startsWith("100::") || v.startsWith("0100:")) return false; // discard
  return true;
}

/** Which image format these bytes are, by magic number. SVG/HTML -> null. Pure. */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (buf.toString("latin1", 0, 6) === "GIF87a" || buf.toString("latin1", 0, 6) === "GIF89a")) return "image/gif";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "image/x-icon";
  return null;
}

/**
 * Icon URLs declared in a homepage's <link rel="...icon..."> tags, best first:
 * apple-touch-icon, then the largest declared size. Relative hrefs resolve
 * against `base`; non-https and data: hrefs are dropped. Pure.
 */
export function iconLinksFromHtml(html: string, base: string): string[] {
  const found: Array<{ href: string; score: number }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!href || href.startsWith("data:") || /\.svg(\?|#|$)/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)x\d+/i.exec(tag)?.[1] ?? 0);
    const score = (rel.includes("apple-touch-icon") ? 10_000 : 0) + size;
    found.push({ href: url.toString(), score });
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.href);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** A dns lookup that refuses any non-public answer; used as the socket's own lookup. */
function guardedLookup(hostname: string, options: dns.LookupOptions | number | undefined, cb: LookupCb): void {
  const opts = typeof options === "object" && options ? options : {};
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err, "");
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      const e = new Error("That address is not a public website.") as NodeJS.ErrnoException;
      e.code = "EPRIVATE";
      return cb(e, "");
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

interface FetchResult {
  status: number;
  contentType: string;
  body: Buffer;
  finalUrl: string;
}

function getOnce(url: URL, maxBytes: number, truncate: boolean): Promise<FetchResult & { location?: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup: guardedLookup as unknown as typeof dns.lookup,
        timeout: TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FinlynqLogoFetcher/1.0)",
          Accept: "image/*,text/html;q=0.8,*/*;q=0.5",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, contentType: "", body: Buffer.alloc(0), finalUrl: url.toString(), location: res.headers.location });
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks), finalUrl: url.toString() });
        };
        res.on("data", (c: Buffer) => {
          if (done) return;
          total += c.length;
          if (total > maxBytes) {
            // A homepage: the icon links are in <head>, so keep what we have.
            // An image: too large to be an icon, refuse.
            if (truncate) {
              chunks.push(c.subarray(0, c.length - (total - maxBytes)));
              finish();
              req.destroy();
            } else {
              req.destroy(new LogoFetchError("The file is too large."));
            }
            return;
          }
          chunks.push(c);
        });
        res.on("end", finish);
        res.on("error", (e) => (done ? undefined : reject(e)));
      },
    );
    req.on("timeout", () => req.destroy(new LogoFetchError("The website took too long to answer.")));
    req.on("error", (e) => reject(e));
  });
}

async function safeGet(start: string, maxBytes: number, truncate = false): Promise<FetchResult> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:") throw new LogoFetchError("Only secure (https) websites are supported.");
    if (!normalizeInstitutionDomain(url.hostname)) throw new LogoFetchError("That address is not a public website.");
    const r = await getOnce(url, maxBytes, truncate);
    if (!r.location) return r;
    url = new URL(r.location, url);
  }
  throw new LogoFetchError("The website redirected too many times.");
}

export interface FetchedIcon {
  bytes: Buffer;
  mime: string;
  url: string;
}

async function tryIcon(url: string): Promise<FetchedIcon | null> {
  try {
    const r = await safeGet(url, MAX_ICON_BYTES);
    if (r.status !== 200) return null;
    const mime = sniffImageMime(r.body);
    return mime ? { bytes: r.body, mime, url: r.finalUrl } : null;
  } catch {
    return null;
  }
}

/**
 * The best square icon a bank's website offers: apple-touch-icon first, then
 * the icons its homepage declares (largest first), then /favicon.ico.
 * Throws LogoFetchError with a reason the user can read.
 */
export async function fetchInstitutionIcon(domainInput: string): Promise<FetchedIcon> {
  const domain = normalizeInstitutionDomain(domainInput);
  if (!domain) throw new LogoFetchError("Enter the bank's website, like examplebank.com.");
  const origin = `https://${domain}`;

  for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
    const icon = await tryIcon(origin + path);
    if (icon) return icon;
  }

  let home: FetchResult | null = null;
  try {
    home = await safeGet(origin + "/", MAX_HTML_BYTES, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EPRIVATE") throw new LogoFetchError("That address is not a public website.");
    if ((e as NodeJS.ErrnoException)?.code === "ENOTFOUND") throw new LogoFetchError(`Couldn't find ${domain}. Check the spelling.`);
  }
  if (home && home.status === 200 && /html/i.test(home.contentType)) {
    for (const link of iconLinksFromHtml(home.body.toString("utf8"), home.finalUrl).slice(0, 5)) {
      const icon = await tryIcon(link);
      if (icon) return icon;
    }
  }

  const ico = await tryIcon(origin + "/favicon.ico");
  if (ico) return ico;
  throw new LogoFetchError(`${domain} doesn't offer an icon we can use. Upload an image instead.`);
}

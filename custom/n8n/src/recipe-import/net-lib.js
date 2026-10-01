// Outbound fetches from n8n: only http(s) to public hosts, redirects followed by hand so every hop is checked.
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home", ".localdomain", ".ts.net", ".audibox.cc"];

function isPrivateIp(ip) {
  const v4 = String(ip).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
  if (!v6.includes(":")) return false;
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

// Throws "resolve: ..." when the URL may not be fetched from the server.
async function checkPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error("resolve: not a link"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("resolve: only http and https links");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s)) || isPrivateIp(host)) {
    throw new Error("resolve: private address refused");
  }
  let dns = null;
  try { dns = require("dns").promises; } catch (e) { dns = null; }
  if (dns) {
    let addresses = [];
    try { addresses = await dns.lookup(host, { all: true }); } catch (e) { throw new Error("resolve: unknown host " + host); }
    if (addresses.some((a) => isPrivateIp(a.address))) throw new Error("resolve: private address refused");
  }
  return u;
}

// GET with manual redirects (max 5). Returns { url, status, body, headers }. `binary` gives a Buffer body.
async function fetchPublic(helpers, url, { binary = false, timeout = 15000, maxBytes = PAGE_MAX_BYTES } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await checkPublicUrl(current);
    const res = await helpers.httpRequest({ method: "GET", url: current, timeout, returnFullResponse: true,
      ignoreHttpStatusErrors: true, disableFollowRedirect: true, ...(binary ? { encoding: "arraybuffer" } : { json: false }),
      headers: { "User-Agent": DESKTOP_UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        Accept: binary ? "image/*" : "text/html,application/xhtml+xml,*/*;q=0.8" } });
    const status = res.statusCode || res.status || 0;
    const headers = res.headers || {};
    if (status >= 300 && status < 400 && headers.location) { current = new URL(headers.location, current).toString(); continue; }
    let body = res.body;
    if (binary) {
      body = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
      if (body.length > maxBytes) throw new Error("read: file too large");
    } else {
      body = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : JSON.stringify(body || "");
      body = body.slice(0, maxBytes);
    }
    return { url: current, status, body, headers };
  }
  throw new Error("resolve: too many redirects");
}

// Short links and tracking: one resolve, utm_*, fbclid, gclid and the fragment removed.
const SHORT_HOSTS = ["vm.tiktok.com", "vt.tiktok.com", "bit.ly", "t.co", "pin.it", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "share.google"];
const needsResolve = (u) => SHORT_HOSTS.includes(u.hostname.toLowerCase()) || (/tiktok\.com$/i.test(u.hostname) && !/\/video\/\d+/.test(u.pathname));
function stripTracking(raw) {
  const u = new URL(raw);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key) || ["fbclid", "gclid", "igsh", "igshid", "_r", "_t"].includes(key)) u.searchParams.delete(key);
  if (/tiktok\.com$/i.test(u.hostname)) u.search = "";
  return u.toString();
}
async function normaliseUrl(helpers, raw) {
  let u = await checkPublicUrl(String(raw).trim());
  if (needsResolve(u)) {
    const res = await fetchPublic(helpers, u.toString(), { timeout: 10000 });
    u = new URL(res.url);
  }
  return stripTracking(u.toString());
}
const tiktokId = (url) => (String(url).match(/tiktok\.com\/.*\/(?:video|photo)\/(\d+)/) || [])[1] || "";

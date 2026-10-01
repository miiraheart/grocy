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
  if (v6.startsWith("::ffff:")) return /^\d+\.\d+\.\d+\.\d+$/.test(v6.slice(7)) ? isPrivateIp(v6.slice(7)) : true;
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

// Throws "resolve: ..." when the link may not be fetched from the server; returns the parsed link (url-lib.js).
// dns is a disallowed module in the n8n task runner, so the resolved address check only runs where it is allowed.
async function checkPublicUrl(raw) {
  const u = parseUrl(raw);
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

// Response bodies cross the runner RPC as JSON: a Buffer arrives as { type: "Buffer", data: [...] }.
const bodyBuffer = (body) => (Buffer.isBuffer(body) ? body : body && body.type === "Buffer" && Array.isArray(body.data) ? Buffer.from(body.data)
  : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? Buffer.from(body) : Buffer.from(typeof body === "string" ? body : ""));
const headerOf = (headers, name) => { const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === name); return k ? headers[k] : undefined; };

// GET with manual redirects (max 5). Returns { url, status, body, headers }. `binary` gives a Buffer body.
async function fetchPublic(helpers, url, { binary = false, timeout = 15000, maxBytes = PAGE_MAX_BYTES } = {}) {
  let current = formatUrl(parseUrl(url));
  for (let hop = 0; hop < 6; hop++) {
    current = formatUrl(await checkPublicUrl(current));
    const res = await helpers.httpRequest({ method: "GET", url: current, timeout, returnFullResponse: true,
      ignoreHttpStatusErrors: true, disableFollowRedirect: true, ...(binary ? { encoding: "arraybuffer" } : { json: false }),
      headers: { "User-Agent": DESKTOP_UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        Accept: binary ? "image/*" : "text/html,application/xhtml+xml,*/*;q=0.8" } });
    const status = res.statusCode || res.status || 0;
    const headers = res.headers || {};
    const location = headerOf(headers, "location");
    if (status >= 300 && status < 400 && location) { current = formatUrl(resolveUrl(location, current)); continue; }
    let body = res.body;
    if (binary) {
      body = bodyBuffer(body);
      if (body.length > maxBytes) throw new Error("read: file too large");
    } else {
      body = typeof body === "string" ? body : body && typeof body === "object" && body.type !== "Buffer" && !ArrayBuffer.isView(body)
        ? JSON.stringify(body) : bodyBuffer(body).toString("utf8");
      body = body.slice(0, maxBytes);
    }
    return { url: current, status, body, headers };
  }
  throw new Error("resolve: too many redirects");
}

// Short links and tracking: one resolve, utm_*, fbclid, gclid and the fragment removed.
const SHORT_HOSTS = ["vm.tiktok.com", "vt.tiktok.com", "bit.ly", "t.co", "pin.it", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "share.google"];
const needsResolve = (u) => SHORT_HOSTS.includes(u.hostname) || (/tiktok\.com$/i.test(u.hostname) && !/\/video\/\d+/.test(u.pathname));
const TRACKING = ["fbclid", "gclid", "igsh", "igshid", "_r", "_t"];
function stripTracking(raw) {
  const u = dropParams({ ...parseUrl(raw), hash: "" }, (key) => /^utm_/i.test(key) || TRACKING.includes(key));
  if (/tiktok\.com$/i.test(u.hostname)) u.search = "";
  return formatUrl(u);
}
async function normaliseUrl(helpers, raw) {
  let u = await checkPublicUrl(String(raw).trim());
  if (needsResolve(u)) {
    const res = await fetchPublic(helpers, formatUrl(u), { timeout: 10000 });
    u = parseUrl(res.url);
  }
  return stripTracking(formatUrl(u));
}
const tiktokId = (url) => (String(url).match(/tiktok\.com\/.*\/(?:video|photo)\/(\d+)/) || [])[1] || "";

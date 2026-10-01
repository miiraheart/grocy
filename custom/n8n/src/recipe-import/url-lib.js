// Links without the URL global: the n8n task runner sandbox has none. Enough of RFC 3986 for http(s) links:
// absolute parse, relative resolve (redirects, image paths), query edits. Hosts are ASCII only so that n8n, which
// parses the link again before fetching, sees the same host that was checked here.
const LINK_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

// WHATWG IPv4 forms (0x7f.1, 2130706433, 0177.0.0.1) to dotted decimal, so the private check sees what n8n dials.
function ipv4Host(host) {
  const parts = host.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (!/^(0x[0-9a-f]*|\d+)$/.test(parts[parts.length - 1]) || parts.length > 4) return null;
  const nums = parts.map((p) => (/^0x[0-9a-f]*$/.test(p) ? parseInt(p.slice(2) || "0", 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : /^(0|[1-9]\d*)$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error("resolve: not a link");
  const last = nums.pop();
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) throw new Error("resolve: not a link");
  let value = last;
  nums.forEach((n, i) => { value += n * 256 ** (3 - i); });
  return [24, 16, 8, 0].map((s) => Math.floor(value / 2 ** s) % 256).join(".");
}

function parseAuthority(authority) {
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : "";
  const hostport = at >= 0 ? authority.slice(at + 1) : authority;
  const m = hostport.match(/^(\[[0-9a-fA-F:.]+\]|[^:]*)(?::(\d*))?$/);
  if (!m) throw new Error("resolve: not a link");
  let hostname = m[1].toLowerCase();
  if (!hostname.startsWith("[")) {
    if (hostname && !/^[a-z0-9._-]+$/.test(hostname)) throw new Error("resolve: not a link");
    hostname = ipv4Host(hostname) || hostname;
  }
  return { userinfo, hostname, port: m[2] || "" };
}

function parseUrl(raw) {
  const text = String(raw).replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  const scheme = (text.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [])[1];
  const special = /^https?$/i.test(scheme || "");
  const m = (special ? text.replace(/^([^?#]*)/, (s) => s.replace(/\\/g, "/")) : text).match(LINK_RE);
  if (!m) throw new Error("resolve: not a link");
  const protocol = m[1].toLowerCase() + ":";
  if (m[2] === undefined) return { protocol, userinfo: "", hostname: "", port: "", pathname: m[3], search: m[4] === undefined ? "" : "?" + m[4], hash: "" };
  const { userinfo, hostname, port } = parseAuthority(m[2]);
  if (special && !hostname) throw new Error("resolve: not a link");
  const defaultPort = (protocol === "http:" && port === "80") || (protocol === "https:" && port === "443");
  return { protocol, userinfo, hostname, port: defaultPort ? "" : port, pathname: m[3] || "/",
    search: m[4] ? "?" + m[4] : "", hash: m[5] ? "#" + m[5] : "" };
}

const formatUrl = (u) => u.protocol + (u.hostname ? "//" + (u.userinfo ? u.userinfo + "@" : "") + u.hostname + (u.port ? ":" + u.port : "") : "")
  + u.pathname + u.search + u.hash;

function removeDots(path) {
  const out = [];
  const segments = path.split("/");
  segments.forEach((s, i) => {
    if (s === "..") { if (out.length > 1) out.pop(); if (i === segments.length - 1) out.push(""); }
    else if (s === ".") { if (i === segments.length - 1) out.push(""); }
    else out.push(s);
  });
  return out.join("/");
}

// Resolves `ref` against `base` (RFC 3986 5.2) and returns the parsed link.
function resolveUrl(ref, base) {
  const r = String(ref).trim().replace(/\\/g, "/");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r)) return parseUrl(r);
  if (!base) throw new Error("resolve: not a link");
  const b = typeof base === "string" ? parseUrl(base) : base;
  if (r.startsWith("//")) return parseUrl(b.protocol + r);
  const m = r.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const [path, search, hash] = [m[1], m[2] || "", m[3] || ""];
  const out = { ...b, hash };
  if (!path) out.search = search || b.search;
  else {
    out.pathname = removeDots(path.startsWith("/") ? path : b.pathname.replace(/[^/]*$/, "") + path);
    out.search = search;
  }
  return out;
}

// Query keys of a parsed link, removed when `drop(key)` is true; the other pairs keep their exact text.
function dropParams(u, drop) {
  const kept = u.search.replace(/^\?/, "").split("&").filter((pair) => {
    if (!pair) return false;
    let key = pair.split("=")[0].replace(/\+/g, " ");
    try { key = decodeURIComponent(key); } catch (e) { key = pair.split("=")[0]; }
    return !drop(key);
  });
  return { ...u, search: kept.length ? "?" + kept.join("&") : "" };
}

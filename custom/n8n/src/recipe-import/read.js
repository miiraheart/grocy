// Read: the web page, the TikTok caption (and a recipe site linked in it), or the pasted text as is.
const { ctx } = $input.first().json;
const out = (fields) => [{ json: { ctx, ...fields } }];
const ingredientLike = (text) => String(text).split(/\n|,|;/).map((l) => cleanLine(l.replace(/^[^\p{L}\p{N}]+/u, "")))
  .filter((l) => { const p = parseLine(l); return p.quantity !== null && p.name.length > 1; }).length;

async function readPage(helpers, url) {
  const res = await fetchPublic(helpers, url);
  if (res.status >= 400) throw new Error("read: the page answered " + res.status);
  if (!/<html|<body|<head|<script/i.test(res.body.slice(0, 20000))) throw new Error("read: not a web page");
  return res;
}

try {
  if (ctx.kind !== "url") return out({ text: ctx.text, page: { title: null, image_url: null, author: null } });

  if (ctx.source_kind === "tiktok") {
    const oembed = await this.helpers.httpRequest({ url: "https://www.tiktok.com/oembed?url=" + encodeURIComponent(ctx.url),
      json: true, timeout: 15000 }).catch((e) => { throw new Error("read: TikTok did not answer (" + String(e.message).slice(0, 80) + ")"); });
    const caption = String(oembed.title || "").replace(/ {2,}/g, "\n")
      .replace(/[ \t]*\b(ingr[ée]dients?|instructions?|pr[ée]paration|[ée]tapes|method)[ \t]*:[ \t]*/giu, "\n$1\n")
      .replace(/[ \t]+(\d{1,2}[.)])[ \t]+(?=\p{Lu})/gu, "\n$1 ").trim();
    const author = oembed.author_unique_id ? "@" + oembed.author_unique_id : oembed.author_name || null;
    const firstLine = caption.split("\n")[0].replace(/#[\p{L}\p{N}_]+/gu, "").trim();
    const page = { title: firstLine.length >= 3 && firstLine.length <= 80 ? firstLine : null, image_url: oembed.thumbnail_url || null, author };
    const linked = (caption.match(/https?:\/\/[^\s"'<>]+/g) || []).find((l) => !/tiktok\.com/i.test(l));
    if (linked) {
      try {
        const res = await readPage(this.helpers, linked.replace(/[).,;!]+$/, ""));
        return out({ text: caption, html: res.body, page: { ...pageMeta(res.body), image_url: page.image_url, author }, linked_url: res.url });
      } catch (e) { page.linked_error = e.message; }
    }
    if (!ingredientLike(caption)) {
      return out({ text: caption, page, error: { stage: "read", message: "no written recipe in this post" } });
    }
    return out({ text: caption, page });
  }

  const res = await readPage(this.helpers, ctx.url);
  return out({ html: res.body, page: pageMeta(res.body) });
} catch (e) {
  return out({ error: { stage: stageOf(e.message, "read"), message: e.message } });
}

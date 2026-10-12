export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type ValidationResult = { ok: true; url: string } | { ok: false; reason: string };

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // WhatsApp image limit (Messenger allows 8MB)

function parseHttps(raw: string): URL | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
    return u;
  } catch {
    return null;
  }
}

/** Syntactic check only (no network). */
export function validateProductUrl(raw: string): ValidationResult {
  const u = parseHttps(raw);
  return u ? { ok: true, url: u.toString() } : { ok: false, reason: "invalid_or_non_https_url" };
}

/**
 * Rewrites common "share page" links into direct image links:
 * Google Drive /file/d/<id>/view and open?id= -> uc?export=view&id=<id>
 * Dropbox ?dl=0 -> raw=1, imgur.com/<id> -> i.imgur.com/<id>.jpg
 */
export function normalizeImageUrl(raw: string): string {
  const s = String(raw || "").trim();
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (host === "drive.google.com") {
      const m = u.pathname.match(/\/file\/d\/([^/]+)/);
      const id = m?.[1] || u.searchParams.get("id");
      if (id) return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`;
    }
    if (host.endsWith("dropbox.com")) {
      u.searchParams.delete("dl");
      u.searchParams.set("raw", "1");
      return u.toString();
    }
    if (host === "imgur.com" || host === "www.imgur.com") {
      const m = u.pathname.match(/^\/([A-Za-z0-9]+)$/);
      if (m) return `https://i.imgur.com/${m[1]}.jpg`;
    }
    return s;
  } catch {
    return s;
  }
}

/** Extracts og:image / twitter:image / image_src from an HTML page. */
export function extractOgImage(html: string, base: string): string | null {
  const pats = [
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i,
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (m?.[1]) {
      try { return new URL(m[1].replace(/&amp;/g, "&"), base).toString(); } catch { /* next */ }
    }
  }
  return null;
}

const resolveCache = new Map<string, { r: ValidationResult; at: number }>();
export function clearValidateCache(): void { resolveCache.clear(); }

/**
 * Validates/resolves an image URL: https, 2xx, image/* content-type, size <= limit.
 * Share-page links are normalized; if the URL is an HTML page we try its og:image.
 * Returns the final direct image URL. fetchFn injectable for tests.
 */
export async function validateImageUrl(
  raw: string,
  opts: { fetchFn?: FetchFn; timeoutMs?: number; maxBytes?: number; depth?: number } = {}
): Promise<ValidationResult> {
  const cacheKey = String(raw || "").trim();
  const useCache = !opts.fetchFn;
  const c = useCache ? resolveCache.get(cacheKey) : undefined;
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.r;
  const r = await validateInner(normalizeImageUrl(raw), opts);
  if (useCache) resolveCache.set(cacheKey, { r, at: Date.now() });
  return r;
}

async function validateInner(
  raw: string,
  opts: { fetchFn?: FetchFn; timeoutMs?: number; maxBytes?: number; depth?: number }
): Promise<ValidationResult> {
  const u = parseHttps(raw);
  if (!u) return { ok: false, reason: "invalid_or_non_https_url" };
  const fetchFn = opts.fetchFn || (fetch as FetchFn);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    let r = await fetchFn(u.toString(), { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    let ct = (r.headers.get("content-type") || "").toLowerCase();
    // Some hosts reject HEAD or lie on HEAD; retry with GET.
    if (!r.ok || !ct.startsWith("image/")) {
      r = await fetchFn(u.toString(), { method: "GET", redirect: "follow", signal: ctrl.signal });
      ct = (r.headers.get("content-type") || "").toLowerCase();
    }
    if (!r.ok) return { ok: false, reason: `http_${r.status}` };
    const finalUrl = u.toString();
    if (ct.startsWith("text/html") && (opts.depth ?? 0) < 1) {
      const html = (await r.text()).slice(0, 300_000);
      const og = extractOgImage(html, finalUrl);
      if (og) {
        const v = await validateInner(normalizeImageUrl(og), { ...opts, depth: (opts.depth ?? 0) + 1 });
        if (v.ok) return v;
      }
      return { ok: false, reason: `not_image:${ct}:${u.hostname}` };
    }
    if (!ct.startsWith("image/")) return { ok: false, reason: `not_image:${ct || "unknown"}:${u.hostname}` };
    const len = Number(r.headers.get("content-length") || "0");
    if (len && len > (opts.maxBytes ?? MAX_IMAGE_BYTES)) return { ok: false, reason: "too_large" };
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return { ok: true, url: finalUrl };
  } catch (err) {
    return { ok: false, reason: ctrl.signal.aborted ? "timeout" : `fetch_error:${err instanceof Error ? err.message : "unknown"}` };
  } finally {
    clearTimeout(timer);
  }
}

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

/** HEAD-checks an image URL: https, 2xx, image/* content-type, size <= limit. fetchFn injectable for tests. */
export async function validateImageUrl(
  raw: string,
  opts: { fetchFn?: FetchFn; timeoutMs?: number; maxBytes?: number } = {}
): Promise<ValidationResult> {
  const u = parseHttps(raw);
  if (!u) return { ok: false, reason: "invalid_or_non_https_url" };
  const fetchFn = opts.fetchFn || (fetch as FetchFn);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const r = await fetchFn(u.toString(), { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    if (!r.ok) return { ok: false, reason: `http_${r.status}` };
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) return { ok: false, reason: `not_image:${ct || "unknown"}` };
    const len = Number(r.headers.get("content-length") || "0");
    if (len && len > (opts.maxBytes ?? MAX_IMAGE_BYTES)) return { ok: false, reason: "too_large" };
    return { ok: true, url: u.toString() };
  } catch (err) {
    return { ok: false, reason: ctrl.signal.aborted ? "timeout" : `fetch_error:${err instanceof Error ? err.message : "unknown"}` };
  } finally {
    clearTimeout(timer);
  }
}

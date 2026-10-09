/**
 * CORS policy. The built UI is served same-origin (directly or through the
 * ngrok tunnel), and in dev Vite proxies /api + /ws, so cross-origin access is
 * only ever needed from a local dev origin. Everything else gets no CORS
 * headers, so a foreign site can't read API responses through the browser.
 *
 * Requests without an Origin header (curl, same-origin GETs) aren't CORS
 * requests at all and are unaffected.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

/** Options for `@fastify/cors`. */
export const corsOptions = {
  origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) =>
    cb(null, isAllowedOrigin(origin)),
};

// A liveness check for the container's health check and uptime monitors. It answers from the
// server process alone, never the database, so it stays cheap and says only that the server is up.

/** `GET`: 200 with `{ ok: true }`. */
export function GET() {
  return Response.json({ ok: true });
}

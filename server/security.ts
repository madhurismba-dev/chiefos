import crypto from "node:crypto";
import { WS_TOKEN_PREFIX } from "../src/lib/local/protocol";

/**
 * Local server security. The server can make agents run tools on your machine, so a connection must prove
 * all three:
 *
 * - Host is 127.0.0.1 / localhost on our port (stops DNS-rebinding pages from reaching the server).
 * - Origin is the UI the server itself serves (stops any other website from opening a WebSocket to it).
 * - It knows the random per-launch token printed in the terminal (stops other local processes and pages).
 */

export function newToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Browsers can't set headers on a WebSocket, so the token travels as a subprotocol: `agentstaff.token.<hex>`. */
export function tokenFromProtocols(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  for (const p of raw.split(",").map((s) => s.trim())) {
    if (p.startsWith(WS_TOKEN_PREFIX)) return p.slice(WS_TOKEN_PREFIX.length);
  }
  return null;
}

export function selfOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export function originAllowed(origin: string | undefined, port: number, extra: string[] = []): boolean {
  if (!origin) return false; // browsers always send Origin on WebSocket upgrades; non-browser clients must too
  return [...selfOrigins(port), ...extra].includes(origin);
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Remove anything that looks like a secret before text reaches a log or the UI. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-…[redacted]");
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

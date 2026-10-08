import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_64 = /^[0-9a-f]{64}$/i;

export function sign(payload, secretHex) {
  if (typeof secretHex !== "string" || !HEX_64.test(secretHex)) {
    throw new Error("secretHex must be exactly 64 hexadecimal characters");
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify(token, secretHex) {
  if (typeof token !== "string") return null;
  if (typeof secretHex !== "string" || !HEX_64.test(secretHex)) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expectedMac = createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;
  return payload;
}

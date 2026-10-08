export function isAllowedOrigin(originHeader, allowedOriginsCsv) {
  if (!originHeader) return false;
  const allowed = new Set((allowedOriginsCsv || "").split(",").map((o) => o.trim()).filter(Boolean));
  return allowed.has(originHeader);
}

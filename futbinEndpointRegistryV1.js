const DEFAULT_BASE = "https://www.futbin.org/futbin/api";

function cleanBase(value) {
  const v = String(value || "").trim().replace(/\/$/, "");
  if (!/^https:\/\//i.test(v)) return null;
  return v;
}

export function getFutbinEndpointCandidates() {
  const configured = String(process.env.FUTBIN_AUTHORIZED_API_BASES || "")
    .split(",").map(cleanBase).filter(Boolean);
  const legacy = cleanBase(process.env.FUTBIN_DIRECT_API_BASE || process.env.FUTBIN_DIRECT_BRAIN_BASE);
  return [...new Set([...configured, legacy, DEFAULT_BASE].filter(Boolean))];
}

export function getFutbinEndpointPolicy() {
  return {
    discovery: "configured-authorized-only",
    candidates: getFutbinEndpointCandidates(),
    noHiddenEndpointDiscovery: true,
    noAccessBypass: true
  };
}

/** Pure metadata utilities shared by capture, presentation and export. No values or headers. */
export type RequestType = "fetch-xhr" | "rest" | "graphql" | "websocket";
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

export type TrafficMetadata = {
  id: string;
  url: string;
  hostname: string;
  path: string;
  method: string;
  statusCode: number | null;
  contentType: string | null;
  startedAt: string;
  durationMs: number | null;
  type: RequestType;
  resourceType: string;
  jsonSchema: JsonSchema | null;
  isApiCandidate: boolean;
  candidateReasons: string[];
};

export const SENSITIVE_NAME = /password|passwd|passphrase|passcode|pwd|cookie|authorization|authentication|credential|secret|token|api[-_ ]?key|private[-_ ]?key|session[-_ ]?(?:id|key|secret)|csrf|xsrf|signature|client[-_ ]?secret|x[-_ ]?amz|captcha/i;
export const SENSITIVE_PATH = /^(?:auth(?:entication|orization)?|login|signin|sign-in|logout|signup|sign-up|register|password|passwd|credentials?|secrets?|tokens?|access[-_]?token|api[-_]?key|session|oauth|sso|reset-password|verify|captcha|challenge)$/i;

function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function looksLikeSecret(value: string): boolean {
  const text = decoded(value);
  return /^(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+)$/i.test(text)
    || /^[a-f0-9]{32,}$/i.test(text)
    || (text.length >= 28 && /^[A-Za-z0-9._~+-]+$/.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text) && /\d/.test(text));
}

function safeFieldName(name: string): boolean {
  return name.length <= 80 && /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(name)
    && !SENSITIVE_NAME.test(name) && !looksLikeSecret(name)
    && !["__proto__", "constructor", "prototype"].includes(name);
}

/** URLs in results never include userinfo, parameters, fragments or opaque credentials. */
export function sanitizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error("Unsupported URL.");
  const segments = url.pathname.split("/");
  const path = segments.map((part, index) => {
    const text = decoded(part);
    const previous = decoded(segments[index - 1] ?? "");
    if (SENSITIVE_PATH.test(previous) || looksLikeSecret(text) || SENSITIVE_NAME.test(text) && /[=:]/.test(text)) return "[redacted]";
    // Remove embedded userinfo, addresses and labeled credentials in path components as well.
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return "[redacted]";
    return part;
  }).join("/");
  return `${url.origin}${path}`;
}

/** Network URLs retain ordinary query parameters; credential-bearing requests are blocked. */
export function safeRequestUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.pathname.split("/").some(part => SENSITIVE_PATH.test(decoded(part)) || looksLikeSecret(part))) return null;
    for (const [key, value] of url.searchParams) {
      if (SENSITIVE_NAME.test(key) || /^(?:auth|session|sig|code)$/i.test(key) || looksLikeSecret(value)) return null;
    }
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function schemaKey(schema: JsonSchema): string { return JSON.stringify(schema); }

function mergeSchemas(schemas: JsonSchema[]): JsonSchema {
  const unique = [...new Map(schemas.map(schema => [schemaKey(schema), schema])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.every(schema => schema.type === "object")) {
    const properties: Record<string, JsonSchema> = Object.create(null);
    for (const name of new Set(unique.flatMap(schema => Object.keys(schema.properties ?? {})))) {
      properties[name] = mergeSchemas(unique.flatMap(schema => schema.properties?.[name] ? [schema.properties[name]] : []));
    }
    return { type: "object", properties };
  }
  return { anyOf: unique.slice(0, 8) };
}

/** Infer only structure. Never emit examples, literals, enum, default, const or body data. */
export function inferJsonSchema(value: unknown): JsonSchema {
  let remainingFields = 180;
  const visit = (item: unknown, depth: number): JsonSchema => {
    if (item === null) return { type: "null" };
    if (Array.isArray(item)) {
      return { type: "array", ...(depth < 6 && item.length ? { items: mergeSchemas(item.slice(0, 20).map(v => visit(v, depth + 1))) } : {}) };
    }
    if (typeof item === "object") {
      const properties: Record<string, JsonSchema> = Object.create(null);
      if (depth < 6) for (const [name, child] of Object.entries(item as Record<string, unknown>)) {
        if (remainingFields <= 0) break;
        if (!safeFieldName(name)) continue;
        remainingFields -= 1;
        properties[name] = visit(child, depth + 1);
      }
      return { type: "object", properties };
    }
    return { type: typeof item === "number" ? Number.isInteger(item) ? "integer" : "number" : typeof item === "boolean" ? "boolean" : "string" };
  };
  return visit(value, 0);
}

/** Defensive allowlist for schemas crossing an export boundary. */
export function cleanJsonSchema(value: unknown, depth = 0): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 6) return null;
  const source = value as Record<string, unknown>;
  const allowed = ["object", "array", "string", "integer", "number", "boolean", "null"];
  const result: JsonSchema = {};
  if (typeof source.type === "string" && allowed.includes(source.type)) result.type = source.type;
  if (Array.isArray(source.type)) result.type = source.type.filter((type): type is string => typeof type === "string" && allowed.includes(type)).slice(0, 7);
  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    const properties: Record<string, JsonSchema> = Object.create(null);
    for (const [name, schema] of Object.entries(source.properties).slice(0, 180)) {
      if (!safeFieldName(name)) continue;
      const clean = cleanJsonSchema(schema, depth + 1);
      if (clean) properties[name] = clean;
    }
    result.properties = properties;
  }
  const items = cleanJsonSchema(source.items, depth + 1);
  if (items) result.items = items;
  if (Array.isArray(source.anyOf)) {
    result.anyOf = source.anyOf.slice(0, 8).flatMap(schema => {
      const clean = cleanJsonSchema(schema, depth + 1);
      return clean ? [clean] : [];
    });
  }
  return Object.keys(result).length ? result : null;
}

export function jsonSchemaFields(value: unknown): string[] {
  const schema = cleanJsonSchema(value);
  const fields = new Set<string>();
  const visit = (node: JsonSchema, prefix: string) => {
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      fields.add(path);
      visit(child, path);
    }
    if (node.items) visit(node.items, `${prefix}[]`);
    for (const variant of node.anyOf ?? []) visit(variant, prefix);
  };
  if (schema) visit(schema, "");
  return [...fields].sort();
}

export function inferRequestType(path: string, contentType: string | null, graphql = false): RequestType {
  if (graphql || /\/(?:graphql|gql)(?:\/|$)/i.test(path) || contentType?.startsWith("application/graphql")) return "graphql";
  if (/(?:^|\/)(?:api|rest)(?:\/|$)|\/v\d+(?:\/|$)/i.test(path) || contentType === "application/json" || contentType?.endsWith("+json")) return "rest";
  return "fetch-xhr";
}

export function isProtectionTraffic(path: string): boolean {
  return /^\/cdn-cgi\/(?:challenge-platform|turnstile)(?:\/|$)/i.test(path);
}

export function candidateReasons(request: Pick<TrafficMetadata, "type" | "resourceType" | "contentType" | "path">): string[] {
  if (isProtectionTraffic(request.path)) return [];
  const reasons: string[] = [];
  if (["fetch", "xhr"].includes(request.resourceType)) reasons.push("Fetch/XHR");
  if (request.type === "graphql") reasons.push("GraphQL");
  if (request.type === "websocket") reasons.push("WebSocket");
  if (request.contentType === "application/json" || request.contentType?.endsWith("+json")) reasons.push("JSON-Antwort");
  if (/(?:^|\/)(?:api|rest)(?:\/|$)|\/v\d+(?:\/|$)/i.test(request.path)) reasons.push("API-Pfad");
  return reasons;
}

export function countsFor(requests: Pick<TrafficMetadata, "type" | "resourceType">[]) {
  return {
    fetchXhr: requests.filter(request => ["fetch", "xhr"].includes(request.resourceType)).length,
    rest: requests.filter(request => request.type === "rest").length,
    graphql: requests.filter(request => request.type === "graphql").length,
    websocket: requests.filter(request => request.type === "websocket").length,
  };
}

export function endpointPath(path: string): string {
  return path.split("/").map(part => /^\d+$/.test(part) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(part) || part === "[redacted]" || part === "%5Bredacted%5D" ? ":id" : part).join("/");
}

export function groupEndpoints<T extends { hostname: string; path: string; method: string; type: RequestType; durationMs?: number | null; statusCode?: number | null; jsonSchema?: unknown; }>(requests: T[]) {
  const groups = new Map<string, { key: string; hostname: string; path: string; method: string; type: RequestType; requests: T[]; fields: string[]; averageDurationMs: number | null }>();
  for (const request of requests) {
    const path = endpointPath(request.path);
    const key = `${request.method} ${request.hostname}${path} ${request.type}`;
    const group = groups.get(key) ?? { key, hostname: request.hostname, path, method: request.method, type: request.type, requests: [], fields: [], averageDurationMs: null };
    group.requests.push(request);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.fields = [...new Set(group.requests.flatMap(request => jsonSchemaFields(request.jsonSchema)))].sort();
    const durations = group.requests.flatMap(request => typeof request.durationMs === "number" ? [request.durationMs] : []);
    group.averageDurationMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  }
  return [...groups.values()].sort((a, b) => b.requests.length - a.requests.length || a.key.localeCompare(b.key));
}

export function matchesRequestFilter(request: { type: RequestType; resourceType: string }, filter: "all" | RequestType): boolean {
  return filter === "all" || (filter === "fetch-xhr" ? ["fetch", "xhr"].includes(request.resourceType) : request.type === filter);
}

export function requestSearchText(request: { url: string; hostname: string; path: string; method: string; type: RequestType; resourceType: string; statusCode?: number | null; contentType?: string | null; jsonSchema?: unknown }): string {
  return [request.url, request.hostname, request.path, request.method, request.type, request.resourceType, request.statusCode, request.contentType, ...jsonSchemaFields(request.jsonSchema)].join(" ").toLocaleLowerCase("de");
}

/** Explicit export shape excludes screenshots, session IDs, arbitrary extra fields and raw data. */
export function sanitizedTrafficExport(result: { url: string; durationMs: number; blockedCount: number; capturedAt?: string; startedAt?: string; requests: Array<{ id: string; url: string; method: string; statusCode?: number | null; contentType?: string | null; startedAt: string; durationMs?: number | null; type: RequestType; resourceType: string; jsonSchema?: unknown }> }) {
  const requests: TrafficMetadata[] = result.requests.flatMap(request => {
    try {
      const url = sanitizeUrl(request.url);
      const parsed = new URL(url);
      const contentType = request.contentType?.split(";", 1)[0].toLowerCase() ?? null;
      const reasons = candidateReasons({ ...request, path: parsed.pathname, contentType });
      return [{
        id: request.id, url, hostname: parsed.hostname, path: parsed.pathname,
        method: /^[A-Z]{1,16}$/.test(request.method) ? request.method : "UNKNOWN",
        statusCode: typeof request.statusCode === "number" ? request.statusCode : null,
        contentType: contentType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) ? contentType : null,
        startedAt: new Date(request.startedAt).toISOString(), durationMs: request.durationMs ?? null,
        type: request.type, resourceType: ["fetch", "xhr", "document", "websocket", "other"].includes(request.resourceType) ? request.resourceType : "other",
        jsonSchema: cleanJsonSchema(request.jsonSchema), isApiCandidate: reasons.length > 0, candidateReasons: reasons,
      }];
    } catch { return []; }
  });
  return {
    url: sanitizeUrl(result.url), capturedAt: new Date(result.capturedAt ?? result.startedAt ?? Date.now()).toISOString(),
    durationMs: result.durationMs, requestCount: requests.length, blockedCount: result.blockedCount,
    counts: countsFor(requests), requests,
  };
}

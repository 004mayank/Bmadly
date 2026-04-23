export async function runtimeFetch(params: {
  hostPort: number;
  path: string;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<any> {
  const { hostPort, path, method = "GET", body, timeoutMs = 30_000 } = params;
  const url = `http://127.0.0.1:${hostPort}${path}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await resp.text().catch(() => "");
    const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : null;
    if (!resp.ok) {
      throw new Error(`runtime ${resp.status}: ${typeof json === "string" ? json : JSON.stringify(json).slice(0, 500)}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}


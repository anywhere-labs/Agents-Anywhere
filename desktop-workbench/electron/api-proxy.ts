export async function proxyDesktopApi(
  request: Request,
  serverOrigin: string,
  trustedOrigins: readonly string[],
  fetcher: typeof fetch,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !trustedOrigins.includes(origin)) {
    return new Response("Forbidden", { status: 403 });
  }
  const corsHeaders = new Headers();
  if (origin) {
    corsHeaders.set("access-control-allow-origin", origin);
    corsHeaders.set("vary", "Origin");
  }
  if (request.method === "OPTIONS") {
    corsHeaders.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    corsHeaders.set("access-control-allow-headers", request.headers.get("access-control-request-headers") ?? "authorization, content-type");
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("origin");
  headers.delete("referer");
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    ...(request.body ? { duplex: "half" } : {}),
  };
  const response = await fetcher(`${serverOrigin}${url.pathname}${url.search}`, init);
  const responseHeaders = new Headers(response.headers);
  corsHeaders.forEach((value, key) => responseHeaders.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

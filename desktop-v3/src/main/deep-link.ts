// `agents-anywhere://` deep links → workbench routes inside the app.
//
//   agents-anywhere://sessions/<deviceId>/<sessionId>   open a conversation
//   agents-anywhere://devices/<deviceId>                open a device
//   agents-anywhere://auth/oidc/callback?code=…         OIDC redirect back into the app
//   agents-anywhere://oauth/tokens/callback?code=…      Tokens Anywhere redirect back into the app

export const DEEP_LINK_SCHEME = "agents-anywhere";

const ALLOWED = [/^\/$/u, /^\/sessions\/[^/]+\/[^/]+$/u, /^\/devices\/[^/]+$/u, /^\/settings$/u, /^\/assistant$/u, /^\/auth\/oidc\/callback$/u, /^\/oauth\/tokens\/callback$/u];

/** The app-relative route (path + query) for a deep link, or null when it is not one we open. */
export function deepLinkRoute(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // `agents-anywhere://sessions/a/b` parses with host `sessions`; `agents-anywhere:///sessions/a/b` without.
  const route = `/${[url.host, ...url.pathname.split("/")].filter(Boolean).join("/")}`;
  if (!ALLOWED.some((re) => re.test(route))) return null;
  return `${route}${url.search}`;
}

export function deepLinkFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
  return arg ? deepLinkRoute(arg) : null;
}

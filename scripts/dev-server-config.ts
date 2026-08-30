/**
 * The port a `VITE_BACKEND_HOST` names, as a string, or null when it names no port. Throws on a
 * value that is not a bare `host[:port]`.
 */
export function getWranglerPortFromBackendHost(backendHost: string): string | null {
  const trimmed = backendHost.trim();
  if (!trimmed) return null;
  if (trimmed.includes("://")) {
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    if (/(^.*\]:|^[^:]+:)[^:]+$/.test(trimmed)) {
      throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
    }
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  if (!url.port) return null;

  const port = Number(url.port);
  if (port < 1) {
    throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
  }

  return url.port;
}

/** Who local dev treats as a deployment admin when `ADMINS` says nothing. */
const DEFAULT_DEV_ADMINS = ["admin"];

/**
 * The admin list for local dev, from an `ADMINS` shell or `.dev.vars` value.
 *
 * Accepts the JSON array a deployment uses, or a bare comma-separated list, since `.dev.vars` is
 * `KEY=VALUE` and quoting JSON there is easy to get wrong. Unset keeps the local `admin` account,
 * which is the only admin a password-login dev server ever had.
 *
 * Forwarding this matters once a dev server signs people in through a gatekeeper: the backend
 * matches admins against the signed-in profile id, which is then a verified email, so the default
 * username can never match one.
 */
export function parseDevAdmins(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_DEV_ADMINS;

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("ADMINS must be a JSON array of names, or a comma-separated list.");
    }
    if (!Array.isArray(parsed) || parsed.some(name => typeof name !== "string")) {
      throw new Error("ADMINS must be a JSON array of names, or a comma-separated list.");
    }
    return parsed as string[];
  }

  return trimmed.split(",").map(name => name.trim()).filter(Boolean);
}

/**
 * Resolve where the dev server's backend lives: an explicit `--port` wins, else
 * `VITE_BACKEND_HOST`, else `localhost:8787`.
 */
export function getDevServerConfig(args: readonly string[], envBackendHost?: string): {
  backendHost: string;
  wranglerPort: string | null;
} {
  let commandLinePort: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== "--port" && !arg.startsWith("--port=")) continue;

    if (commandLinePort !== null) {
      throw new Error("--port may only be specified once.");
    }

    const value = arg === "--port" ? args[++i] : arg.slice("--port=".length);
    if (!/^\d+$/.test(value ?? "") || Number(value) < 1 || Number(value) > 65535) {
      throw new Error("--port must be an integer between 1 and 65535.");
    }
    commandLinePort = String(Number(value));
  }

  if (commandLinePort !== null) {
    return {
      backendHost: `localhost:${commandLinePort}`,
      wranglerPort: commandLinePort,
    };
  }

  const backendHost = envBackendHost?.trim() || "localhost:8787";
  return {
    backendHost,
    wranglerPort: getWranglerPortFromBackendHost(backendHost),
  };
}

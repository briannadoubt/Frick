export type WebSecurityCommand = "serve" | "preview";

export interface WebSecurityHeaderOptions {
  readonly command: WebSecurityCommand;
  readonly demoHttpEndpoint: string;
  readonly demoWsEndpoint: string;
}

export function buildWebSecurityHeaders(options: WebSecurityHeaderOptions): Record<string, string> {
  return {
    "content-security-policy": buildWebContentSecurityPolicy(options),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "serial=()",
      "bluetooth=()",
      "hid=()",
    ].join(", "),
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "service-worker-allowed": "/",
  };
}

export function formatStaticWebSecurityHeaders(headers: Record<string, string>): string {
  return [
    "/*",
    ...Object.entries(headers).map(([name, value]) => `  ${canonicalHeaderName(name)}: ${value}`),
    "",
  ].join("\n");
}

export function buildWebContentSecurityPolicy(options: WebSecurityHeaderOptions): string {
  const isDevServer = options.command === "serve";
  const connectSources = [
    "'self'",
    originFor(options.demoHttpEndpoint),
    originFor(options.demoWsEndpoint),
    ...(isDevServer
      ? [
          "http://127.0.0.1:*",
          "http://localhost:*",
          "ws://127.0.0.1:*",
          "ws://localhost:*",
        ]
      : []),
  ];

  return [
    directive("default-src", ["'self'"]),
    directive("script-src", isDevServer ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'"]),
    directive("script-src-attr", ["'none'"]),
    directive("style-src", isDevServer ? ["'self'", "'unsafe-inline'"] : ["'self'"]),
    directive("style-src-attr", isDevServer ? ["'unsafe-inline'"] : ["'none'"]),
    directive("img-src", ["'self'", "blob:", "data:"]),
    directive("font-src", ["'self'", "data:"]),
    directive("connect-src", connectSources),
    directive("worker-src", ["'self'"]),
    directive("manifest-src", ["'self'"]),
    directive("media-src", ["'self'", "blob:"]),
    directive("frame-src", ["'none'"]),
    directive("object-src", ["'none'"]),
    directive("base-uri", ["'none'"]),
    directive("form-action", ["'self'"]),
    directive("frame-ancestors", ["'none'"]),
  ].join("; ");
}

function directive(name: string, values: Array<string | undefined>): string {
  return `${name} ${unique(values).join(" ")}`;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function originFor(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function canonicalHeaderName(name: string): string {
  const knownNames: Record<string, string> = {
    "content-security-policy": "Content-Security-Policy",
    "x-content-type-options": "X-Content-Type-Options",
    "referrer-policy": "Referrer-Policy",
    "permissions-policy": "Permissions-Policy",
    "cross-origin-opener-policy": "Cross-Origin-Opener-Policy",
    "cross-origin-resource-policy": "Cross-Origin-Resource-Policy",
    "service-worker-allowed": "Service-Worker-Allowed",
  };
  return knownNames[name] ?? name;
}

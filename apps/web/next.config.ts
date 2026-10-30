import type { NextConfig } from "next";

const apiPort = process.env["API_PORT"] ?? "3001";
const isDev = process.env.NODE_ENV !== "production";

// Production CSP has no 'unsafe-eval'. Next.js dev tooling needs eval for hot reloading.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // The browser only ever talks to this origin; API calls are proxied to the loopback Fastify server.
  rewrites: () =>
    Promise.resolve([
      { source: "/api/v1/:path*", destination: `http://127.0.0.1:${apiPort}/api/v1/:path*` },
    ]),
  headers: () =>
    Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]),
};

export default config;

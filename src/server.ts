import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// public/ holds the rewired prototype frontend; in dist builds it sits two levels up.
const publicDir = join(__dirname, "..", "public");

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyRateLimit, { global: false });

  // Health check (used by docker-compose and U1 verification).
  app.get("/api/health", async () => ({ status: "ok" }));

  // Feature routes are registered here as units land:
  //   auth (U3), settings (U5), spaces (U6), connectors (U7), chat (U10)
  // await app.register(authRoutes, { prefix: "/api/auth" });

  // Serve the static frontend last so /api/* takes precedence.
  await app.register(fastifyStatic, { root: publicDir, prefix: "/" });

  return app;
}

// Only listen when run directly (tests import buildServer without binding a port).
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  app
    .listen({ port: config.port, host: "0.0.0.0" })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import authRoutes from "./auth/routes.js";
import { registerAuthGuard } from "./auth/guard.js";
import settingsRoutes from "./settings/routes.js";
import spacesRoutes from "./spaces/routes.js";
import connectorsRoutes from "./connectors/routes.js";
import chatRoutes from "./chat/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// public/ holds the rewired prototype frontend; in dist builds it sits two levels up.
const publicDir = join(__dirname, "..", "public");

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyRateLimit, { global: false });

  // Health check (used by docker-compose and U1 verification).
  app.get("/api/health", async () => ({ status: "ok" }));

  // Public auth routes — register/login/logout/me handle their own session checks.
  await app.register(authRoutes, { prefix: "/api/auth" });

  // Protected scope: everything registered here requires a valid session (U3 guard).
  // Future units register their plugins inside this scope: spaces (U6),
  // connectors (U7), chat (U10).
  await app.register(async (protectedScope) => {
    registerAuthGuard(protectedScope);
    await protectedScope.register(settingsRoutes); // U5 (absolute /api/settings paths)
    await protectedScope.register(spacesRoutes); // U6 (absolute /api/spaces paths)
    await protectedScope.register(connectorsRoutes); // U7
    await protectedScope.register(chatRoutes); // U10
  });

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

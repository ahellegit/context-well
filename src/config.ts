// Loads and validates app configuration from the environment (.env in dev,
// real env vars in production / docker-compose). See .env.example (KTD5).

// In local dev, hydrate process.env from a .env file if one is present.
// In Docker/production the env is already populated, so a missing file is fine.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file — rely on the ambient environment
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export interface Config {
  port: number;
  sessionSecret: string;
  cookieSecure: boolean;
  allowRegistration: boolean;
  databaseUrl: string;
  cyborgdbUrl: string;
  ollamaDefaultUrl: string;
}

export function loadConfig(): Config {
  return {
    port: Number(optional("PORT", "3000")),
    sessionSecret: required("SESSION_SECRET"),
    cookieSecure: optional("COOKIE_SECURE", "false") === "true",
    allowRegistration: optional("ALLOW_REGISTRATION", "false") === "true",
    databaseUrl: optional("DATABASE_URL", "file:./prisma/dev.db"),
    cyborgdbUrl: required("CYBORGDB_URL"),
    ollamaDefaultUrl: optional("OLLAMA_DEFAULT_URL", ""),
  };
}

export const config = loadConfig();

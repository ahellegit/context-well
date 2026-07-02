FROM node:22-slim AS build
WORKDIR /app
# Prisma needs libssl/openssl to detect the right query engine (the slim image
# ships without it, otherwise it warns and falls back to openssl-1.1.x).
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Same openssl requirement at runtime for `prisma migrate deploy` + the client.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# Carry the full build node_modules: it has the generated Prisma client, the
# prisma CLI (needed for `migrate deploy` at startup), and the arch-correct
# argon2 native binding. Avoids a runtime `npx` fetch that would fail offline.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY public ./public
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]

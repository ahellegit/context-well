// Upload API plugin. Accepts a multipart POST of one or more text/markdown/code
// files into a space, validates each against an extension allowlist + size cap,
// decodes utf-8, and hands the batch to the ingest pipeline (chunk → CyborgDB →
// queryable). Like the spaces/connectors plugins it uses full `/api/*` paths and
// is mounted inside the authenticated scope by the orchestrator.
//
// @fastify/multipart is registered at the app level (server.ts) with the global
// fileSize/files limits; this plugin owns the per-file type/size policy.

import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { requireSpaceRole, spaceFromParam } from "../auth/space-guard.js";
import { getSpace } from "../spaces/service.js";
import { SyncInProgressError } from "../connectors/sync.js";
import { ingestFiles, type UploadFile } from "./service.js";

// Per-file size cap (~5 MB). Matches the multipart limit in server.ts so a file
// is rejected with a clear message rather than silently truncated.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Allowed extensions (text-only — no PDF/DOCX). Extension-less files are also
// accepted (treated as plain text). Lowercased, leading dot included.
const ALLOWED_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".log", ".yaml", ".yml",
  ".html", ".css",
  // common code extensions
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".rs",
  ".c", ".cpp", ".h", ".sh",
]);

/** Whether a filename's extension is allowed (extension-less → allowed). */
function isAllowedFilename(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  // No dot (or leading-dot dotfile like ".env") → extension-less text: allow.
  if (dot <= 0) return true;
  return ALLOWED_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

export default async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  // Upload one or more text files into a space (multipart, field name "files").
  // Editor+ on the space (ingest is a write).
  app.post("/api/spaces/:id/upload", { preHandler: requireSpaceRole("editor", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) return reply.code(404).send({ error: "Space not found." });

    const files: UploadFile[] = [];
    const rejected: string[] = [];

    // Iterate every part; only `file` parts carry content. Non-file fields are
    // ignored. Each file is validated, then read to a Buffer and decoded utf-8.
    for await (const part of request.parts()) {
      if (part.type !== "file") continue;
      const file = part as MultipartFile;
      const filename = file.filename || "";

      if (!filename || !isAllowedFilename(filename)) {
        rejected.push(filename || "(unnamed)");
        // Drain the stream so busboy can advance to the next part.
        await file.toBuffer().catch(() => undefined);
        continue;
      }

      const buffer = await file.toBuffer();
      // `file.truncated` is set when the multipart fileSize limit cut the stream
      // short; also guard the decoded length defensively.
      if (file.file.truncated || buffer.length > MAX_FILE_BYTES) {
        rejected.push(filename);
        continue;
      }

      files.push({ filename, text: buffer.toString("utf-8") });
    }

    if (files.length === 0) {
      return reply.code(400).send({
        error: rejected.length
          ? `No valid files. Rejected (unsupported type or too large): ${rejected.join(", ")}.`
          : "No files in the request.",
      });
    }

    try {
      const result = await ingestFiles(id, files);
      return { files: result.files, totalChunks: result.totalChunks };
    } catch (error) {
      if (error instanceof SyncInProgressError) {
        return reply
          .code(409)
          .send({ error: "A sync is already in progress for this space." });
      }
      throw error;
    }
  });
}

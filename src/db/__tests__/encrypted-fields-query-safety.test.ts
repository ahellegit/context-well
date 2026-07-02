// Encrypted fields use a random IV, so they can never be
// query predicates. A `where` equality on one silently never matches; an
// `orderBy` silently doesn't sort (the extension warns at runtime). This audit
// scans the source for either construct referencing an encrypted field and fails
// closed, so a future query on an encrypted column is caught in CI, not prod.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Keep in sync with the `/// @encrypted` annotations in prisma/schema.prisma.
const ENCRYPTED_FIELDS = [
  "indexKey",
  "customPrompt",
  "credentials",
  "text",
  "sources",
  "title",
  "metadata",
];

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(rel));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

// Extract the balanced `{...}` or `[...]` body that follows `keyword:`.
function clauseBodies(src: string, keyword: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(`\\b${keyword}\\s*:\\s*`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const open = src[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      if (src[j] === open) depth++;
      else if (src[j] === close && --depth === 0) {
        j++;
        break;
      }
    }
    bodies.push(src.slice(i, j));
  }
  return bodies;
}

describe("encrypted fields are never query predicates", () => {
  const files = [...sourceFiles("src"), ...sourceFiles("scripts")];

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  function scan(src: string): string[] {
    const violations: string[] = [];
    for (const keyword of ["where", "orderBy"]) {
      for (const body of clauseBodies(src, keyword)) {
        for (const field of ENCRYPTED_FIELDS) {
          if (new RegExp(`\\b${field}\\s*:`).test(body)) {
            violations.push(`${keyword} references encrypted field '${field}'`);
          }
        }
      }
    }
    return violations;
  }

  it("uses no encrypted field inside a where or orderBy clause", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const v of scan(readFileSync(join(ROOT, file), "utf8"))) {
        violations.push(`${file}: ${v}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("detects a violation fixture (guards against a vacuous pass)", () => {
    const bad = `prisma.connector.findFirst({ where: { credentials: token } });`;
    const alsoBad = `prisma.document.findMany({ orderBy: { title: "asc" } });`;
    expect(scan(bad)).toContain("where references encrypted field 'credentials'");
    expect(scan(alsoBad)).toContain("orderBy references encrypted field 'title'");
    // A safe query on a non-encrypted field is not flagged.
    expect(scan(`prisma.space.findMany({ orderBy: { createdAt: "desc" } });`)).toEqual([]);
  });
});

// SPIKE smoke test: build the similarity graph for every space against real
// data (a copy of the app DB + the live cyborgdb-service), bypassing HTTP/auth.
// Run inside the compose network so cyborgdb-service resolves. Read-only.
import { prisma } from "../src/db/client.js";
import { buildSpaceGraph, buildDocGraph, getDocGraph } from "../src/spaces/graph.js";

const CAP = Number(process.env.SMOKE_NODES ?? "10");
const MODE = process.env.SMOKE_MODE ?? "chunk";
const spaces = await prisma.space.findMany();
console.log(`spaces: ${spaces.length} (mode ${MODE}, node cap ${CAP})`);

if (MODE === "document") {
  for (const s of spaces) {
    const tag = `${s.name} (${s.slug})`;
    if (!s.indexKey) {
      console.log(`- ${tag}: no index key — skipped`);
      continue;
    }
    try {
      const t0 = Date.now();
      const g = await getDocGraph(s, { maxDocs: CAP, samplesPerDoc: 3, neighbors: 12, threshold: 0.5 });
      const ms = Date.now() - t0;
      const t1 = Date.now();
      const g2 = await getDocGraph(s, { maxDocs: CAP, samplesPerDoc: 3, neighbors: 12, threshold: 0.5 });
      const ms2 = Date.now() - t1;
      console.log(
        `- ${tag}: ${g.meta.rendered}/${g.meta.total} docs, ${g.edges.length} edges ` +
          `(cached=${g.meta.cached}) in ${ms}ms · 2nd call cached=${g2.meta.cached} in ${ms2}ms`,
      );
      console.log(`    sample docs: ${g.nodes.slice(0, 4).map((n) => `[${n.connector} ${n.chunks}ch] ${n.label}`).join(" | ")}`);
      const top = g.edges.slice().sort((a, b) => b.weight - a.weight).slice(0, 4);
      console.log(`    top edge weights: ${top.map((e) => e.weight).join(", ")}`);
    } catch (e) {
      console.log(`- ${tag}: ERROR ${(e as Error).message}`);
    }
  }
  await prisma.$disconnect();
  process.exit(0);
}

for (const s of spaces) {
  const tag = `${s.name} (${s.slug})`;
  if (!s.indexKey) {
    console.log(`- ${tag}: no index key — skipped`);
    continue;
  }
  try {
    const t0 = Date.now();
    const g = await buildSpaceGraph(s, { maxNodes: CAP, neighbors: 6, threshold: 0.5 });
    const ms = Date.now() - t0;
    console.log(
      `- ${tag}: ${g.meta.rendered}/${g.meta.total} nodes, ${g.edges.length} edges ` +
        `(k=${g.meta.k} thr=${g.meta.threshold} trunc=${g.meta.truncated}) in ${ms}ms`,
    );
    console.log(`    sample nodes: ${g.nodes.slice(0, 3).map((n) => `[${n.connector}] ${n.label}`).join(" | ")}`);
    const top = g.edges.slice().sort((a, b) => b.weight - a.weight).slice(0, 3);
    console.log(`    top edges: ${top.map((e) => e.weight).join(", ")}`);
  } catch (e) {
    console.log(`- ${tag}: ERROR ${(e as Error).message}`);
  }
}
await prisma.$disconnect();

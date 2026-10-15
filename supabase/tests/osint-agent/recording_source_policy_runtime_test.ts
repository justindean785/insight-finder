import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";

type Row = Record<string, unknown>;

function makeRuntime() {
  const inserted: Row[] = [];
  const builder: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  };
  for (
    const method of ["select", "eq", "or", "order", "limit", "is", "update"]
  ) {
    builder[method] = () => builder;
  }

  const supabase = {
    from(_table: string) {
      return {
        insert(rows: Row | Row[]) {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          return Promise.resolve({ error: null });
        },
        select: () => builder,
        update: () => builder,
      };
    },
    rpc() {
      return Promise.resolve({
        data: [{ id: "evidence", seq: 1, chain_hash: "hash" }],
        error: null,
      });
    },
  };

  const ctx = {
    supabase,
    supabaseAdmin: supabase,
    userId: "source-policy-user",
    threadId: "source-policy-thread",
    archiveEnabled: false,
    detectedSeedType: "email",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;

  return { inserted, tools: buildTools(ctx).tools };
}

function executable(tools: unknown, name: string) {
  return (tools as Record<
    string,
    { execute: (input: unknown, options: unknown) => Promise<unknown> }
  >)[name];
}

const LOW_LEVEL_CAP_NAMES = [
  "applyEvidenceCapsLegacyOccurrenceBaseline",
  "applyEvidenceCapsWithDistinctBreachIdentities",
] as const;
const LOW_LEVEL_CAP_CALL_RE = new RegExp(
  `\\b(?:${LOW_LEVEL_CAP_NAMES.join("|")})\\s*\\(`,
);
const LOW_LEVEL_CAP_SYMBOL_RE = new RegExp(
  `\\b(?:${LOW_LEVEL_CAP_NAMES.join("|")})\\b`,
);
const GENERIC_CAP_EXPORT_RE =
  /\bexport\s+(?:async\s+)?function\s+applyEvidenceCaps\s*\(/;

function stripTypeScriptComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

async function productionEdgeTypeScriptFiles(
  directory: URL,
): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const url = new URL(
      `${encodeURIComponent(entry.name)}${entry.isDirectory ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory) {
      files.push(...await productionEdgeTypeScriptFiles(url));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(url);
    }
  }
  return files;
}

Deno.test("record_artifacts runtime keeps metadata out of the authority channel", async () => {
  const runtime = makeRuntime();
  await executable(runtime.tools, "record_artifacts").execute({
    artifacts: [{
      kind: "weak_lead",
      value: "runtime batch provenance boundary",
      confidence: 95,
      source: "minimax_web_search",
      metadata: { sources: ["Placer County Recorder"] },
    }],
  }, {});

  assertEquals(runtime.inserted.length, 1);
  assertEquals(runtime.inserted[0].confidence, 55);
  const metadata = runtime.inserted[0].metadata as Row;
  assertEquals(metadata.source_category, ["ai_summary"]);
  assertEquals(metadata.confidence_cap_applied, 55);
  assertEquals(
    metadata.reason_for_confidence,
    "single source class: ai_summary",
  );
  assertEquals(
    metadata.reason_not_confirmed,
    "needs second independent class of evidence",
  );
  assertEquals(metadata.status, "observed");
});

Deno.test("record_artifact compatibility runtime keeps metadata out of the authority channel", async () => {
  const runtime = makeRuntime();
  await executable(runtime.tools, "record_artifact").execute({
    kind: "weak_lead",
    value: "runtime compatibility provenance boundary",
    confidence: 95,
    source: "minimax_web_search",
    metadata: { sources: ["Placer County Recorder"] },
  }, {});

  assertEquals(runtime.inserted.length, 1);
  assertEquals(runtime.inserted[0].confidence, 55);
  const metadata = runtime.inserted[0].metadata as Row;
  assertEquals(metadata.source_category, ["ai_summary"]);
  assertEquals(metadata.confidence_cap_applied, 55);
  assertEquals(
    metadata.reason_for_confidence,
    "single source class: ai_summary",
  );
  assertEquals(
    metadata.reason_not_confirmed,
    "needs second independent class of evidence",
  );
  assertEquals(metadata.status, "observed");
});

Deno.test("record_artifacts dedup identity ignores model metadata labels", async () => {
  const runtime = makeRuntime();
  const result = await executable(runtime.tools, "record_artifacts").execute({
    artifacts: [
      {
        kind: "weak_lead",
        value: "same authoritative observation",
        confidence: 95,
        source: "minimax_web_search",
        metadata: { source: "Placer County Recorder" },
      },
      {
        kind: "weak_lead",
        value: "same authoritative observation",
        confidence: 95,
        source: "minimax_web_search",
        metadata: { source: "Reuters" },
      },
    ],
  }, {}) as { count: number; rejected: Array<{ reason: string }> };

  assertEquals(runtime.inserted.length, 1);
  assertEquals(result.count, 1);
  assertEquals(result.rejected.length, 1);
  assert(result.rejected[0].reason.includes("authoritative source"));
});

Deno.test("record_artifacts keeps genuinely different top-level sources distinct", async () => {
  const runtime = makeRuntime();
  const result = await executable(runtime.tools, "record_artifacts").execute({
    artifacts: [
      {
        kind: "weak_lead",
        value: "two authoritative observations",
        confidence: 55,
        source: "minimax_web_search",
        metadata: { source: "same disclosed label" },
      },
      {
        kind: "weak_lead",
        value: "two authoritative observations",
        confidence: 55,
        source: "exa_search",
        metadata: { source: "same disclosed label" },
      },
    ],
  }, {}) as { count: number };

  assertEquals(runtime.inserted.length, 2);
  assertEquals(result.count, 2);
});

for (const toolName of ["record_artifacts", "record_artifact"] as const) {
  Deno.test(`${toolName} runtime gives metadata-only breach no authority`, async () => {
    const runtime = makeRuntime();
    const item = {
      kind: "breach_exposure",
      value: `${toolName}-metadata-only@example.com`,
      confidence: 95,
      metadata: { sources: ["breach_check"] },
    };
    await executable(runtime.tools, toolName).execute(
      toolName === "record_artifacts" ? { artifacts: [item] } : item,
      {},
    );
    assertEquals(runtime.inserted.length, 1);
    assertEquals(runtime.inserted[0].confidence, 50);
    assertEquals(
      (runtime.inserted[0].metadata as Row).source_category,
      [],
    );
  });

  Deno.test(`${toolName} runtime counts a cross-field breach duplicate once`, async () => {
    const runtime = makeRuntime();
    const item = {
      kind: "breach_exposure",
      value: `${toolName}-duplicate@example.com`,
      confidence: 95,
      source: "breach_check",
      metadata: { sources: ["breach_check"] },
    };
    await executable(runtime.tools, toolName).execute(
      toolName === "record_artifacts" ? { artifacts: [item] } : item,
      {},
    );
    assertEquals(runtime.inserted.length, 1);
    assertEquals(runtime.inserted[0].confidence, 60);
  });
}

for (
  const [toolName, corpus] of [
    ["record_artifacts", "Twitter scraping 2022"],
    ["record_artifact", "Foodora 2016"],
  ] as const
) {
  Deno.test(`${toolName} runtime preserves metadata-only ${corpus} demotion`, async () => {
    const runtime = makeRuntime();
    const item = {
      kind: "breach_exposure",
      value: `${toolName}-demotion@example.com`,
      confidence: 95,
      source: "breach_check+oathnet_lookup",
      metadata: { sources: [corpus] },
    };
    await executable(runtime.tools, toolName).execute(
      toolName === "record_artifacts" ? { artifacts: [item] } : item,
      {},
    );
    assertEquals(runtime.inserted.length, 1);
    assertEquals(runtime.inserted[0].confidence, 60);
  });
}

Deno.test("recording mirror wires both paths through the channel policy", async () => {
  const mirror = await Deno.readTextFile(
    new URL("../../functions/osint-agent/tools/recording.ts", import.meta.url),
  );
  const code = stripTypeScriptComments(mirror);
  const policyCalls =
    code.match(/applyRecordingSourcePolicy\(\{[\s\S]*?\n\s*\}\)/g) ?? [];
  assertEquals(policyCalls.length, 2);
  const batchCall = policyCalls[0] ?? "";
  const shimCall = policyCalls[1] ?? "";
  assert(
    /rawConfidence:\s*a\.confidence\s*\?\?\s*50,[\s\S]*source:\s*a\.source,[\s\S]*kind:\s*a\.kind,[\s\S]*metadata:\s*aMeta/
      .test(
        batchCall,
      ),
    "batch mirror call must pass only its exact surface and metadata channels",
  );
  assert(
    /rawConfidence:\s*confidence\s*\?\?\s*50,[\s\S]*source,[\s\S]*kind:\s*inferred\.kind,[\s\S]*metadata:\s*inMeta/
      .test(
        shimCall,
      ),
    "shim mirror call must pass only its exact surface and metadata channels",
  );
  for (const call of policyCalls) {
    assert(!/\bsources\s*:/.test(call), "mirror must not pass a source array");
  }
  assertEquals((code.match(/disclosedSourceLabels\(/g) ?? []).length, 2);
  assertEquals((code.match(/resolveRecordingStatus\(/g) ?? []).length, 2);
  assert(
    !code.includes("effSources"),
    "mirror must not pre-union metadata into an effective source list",
  );
  assert(
    !/\[\s*source\s*\?\?\s*""[\s\S]{0,160}metadata[^\n]*sources/.test(code),
    "mirror must not construct a source array from metadata",
  );
  assert(
    !LOW_LEVEL_CAP_CALL_RE.test(code),
    "mirror recording paths must use the channel policy",
  );
});

Deno.test("production edge modules cannot bypass the recording source policy", async () => {
  const root = new URL("../../functions/osint-agent/", import.meta.url);
  const confidenceUrl = new URL("./confidence.ts", root);
  const allowed = new Set([
    confidenceUrl.href,
    new URL("./recording-source-policy.ts", root).href,
  ]);
  const violations: string[] = [];

  assert(
    !GENERIC_CAP_EXPORT_RE.test(
      stripTypeScriptComments(await Deno.readTextFile(confidenceUrl)),
    ),
    "confidence.ts must not re-export an ambiguously safe applyEvidenceCaps entry",
  );

  for (const file of await productionEdgeTypeScriptFiles(root)) {
    if (allowed.has(file.href) || file.pathname.endsWith("_test.ts")) continue;
    const code = stripTypeScriptComments(await Deno.readTextFile(file));
    if (LOW_LEVEL_CAP_SYMBOL_RE.test(code)) {
      violations.push(
        decodeURIComponent(file.pathname.slice(root.pathname.length)),
      );
    }
  }

  assertEquals(
    violations.sort(),
    [],
    "production edge modules must call applyRecordingSourcePolicy, never a low-level cap entry",
  );
});

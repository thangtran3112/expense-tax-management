import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { StrategySpecV1Schema } from "../src/strategy-spec-v1.ts";

export const FILE_NAME = "strategy-spec-v1.schema.json";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export function renderJsonSchema(): string {
  const schema = z.toJSONSchema(StrategySpecV1Schema, {
    target: "draft-2020-12",
    io: "input",
  });
  return `${JSON.stringify(sortJson(schema), null, 2)}\n`;
}

export async function writeJsonSchema(outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, FILE_NAME);
  await writeFile(outputPath, renderJsonSchema(), "utf8");
  return outputPath;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  await writeJsonSchema(fileURLToPath(new URL("../generated", import.meta.url)));
}

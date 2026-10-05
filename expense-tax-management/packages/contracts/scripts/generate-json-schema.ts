import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { z } from "zod";
import {
  JobReferenceV1Schema,
  JobResultSubmitRequestV1Schema,
  JobStatusUpdateRequestV1Schema,
  OcrExtractionResultV1Schema,
  OcrJobInputV1Schema,
  ExpenseEnrichmentInputV1Schema,
  ExpenseEnrichmentResultV1Schema,
} from "../src/index.js";

interface InternalMessageSchema {
  readonly schema: z.ZodType;
  readonly title: string;
  readonly fileName: string;
}

const INTERNAL_MESSAGE_SCHEMAS: readonly InternalMessageSchema[] = [
  {
    schema: JobReferenceV1Schema,
    title: "JobReferenceV1",
    fileName: "internal-messages.schema.json",
  },
  {
    schema: JobStatusUpdateRequestV1Schema,
    title: "JobStatusUpdateRequestV1",
    fileName: "job-status-update-v1.schema.json",
  },
  {
    schema: JobResultSubmitRequestV1Schema,
    title: "JobResultSubmitRequestV1",
    fileName: "job-result-submit-v1.schema.json",
  },
  {
    schema: OcrExtractionResultV1Schema,
    title: "OcrExtractionResultV1",
    fileName: "ocr-extraction-result-v1.schema.json",
  },
  {
    schema: OcrJobInputV1Schema,
    title: "OcrJobInputV1",
    fileName: "ocr-job-input-v1.schema.json",
  },
  {
    schema: ExpenseEnrichmentInputV1Schema,
    title: "ExpenseEnrichmentInputV1",
    fileName: "expense-enrichment-input-v1.schema.json",
  },
  {
    schema: ExpenseEnrichmentResultV1Schema,
    title: "ExpenseEnrichmentResultV1",
    fileName: "expense-enrichment-result-v1.schema.json",
  },
];

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function generatedRoot(): string {
  return process.env.CONTRACTS_GENERATED_ROOT
    ? path.resolve(process.env.CONTRACTS_GENERATED_ROOT)
    : fileURLToPath(new URL("../generated", import.meta.url));
}

export async function generateJsonSchema(outputRoot = generatedRoot()): Promise<void> {
  const jsonSchemaDir = path.join(outputRoot, "json-schema");
  await mkdir(jsonSchemaDir, { recursive: true });

  for (const entry of INTERNAL_MESSAGE_SCHEMAS) {
    const schema = {
      ...entry.schema.toJSONSchema({
        target: "draft-2020-12",
        io: "input",
      }),
      title: entry.title,
    };
    const outputPath = path.join(jsonSchemaDir, entry.fileName);
    await writeFile(
      outputPath,
      `${JSON.stringify(sortJson(schema), null, 2)}\n`,
      "utf8",
    );
  }
}

async function main(): Promise<void> {
  await generateJsonSchema();
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error("JSON Schema generation failed", error);
    process.exitCode = 1;
  });
}

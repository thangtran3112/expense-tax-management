import { ApplicationFailure } from "@temporalio/activity";
import type { OcrExtractionResultV1 } from "@expense-tax/contracts";

import type { ReceiptRoute } from "./openai-ocr.js";

export type ReceiptExtractor = (
  data: Uint8Array,
  route: ReceiptRoute,
) => OcrExtractionResultV1 | Promise<OcrExtractionResultV1>;

export interface ReceiptExtractorProviders {
  readonly openai: ReceiptExtractor;
  readonly fake: (data: Uint8Array) => OcrExtractionResultV1;
  readonly warn?: (message: string) => void;
}

export function createReceiptExtractor({
  openai,
  fake,
  warn = (message) => console.warn(message),
}: ReceiptExtractorProviders): ReceiptExtractor {
  return (data, route) => {
    switch (route.providerKind) {
      case "openai":
        return openai(data, route);
      case "fake":
        warn("receipt OCR is using the fake provider");
        return fake(data);
      default:
        throw ApplicationFailure.nonRetryable(
          `Unsupported OCR provider "${route.providerKind}"`,
          "OcrUnsupportedProvider",
        );
    }
  };
}

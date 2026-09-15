import { expect, test } from "bun:test";
import { guideDocumentationUrl } from "../public/guide-link.js";

test("Guide link uses the selected locale and fixed Launchpad attribution", () => {
  expect(guideDocumentationUrl("cs")).toBe(
    "https://documentation.lazurio.ai/cs/guide/?utm_source=launchpad&utm_medium=product&utm_campaign=guide",
  );
  expect(guideDocumentationUrl("en")).toBe(
    "https://documentation.lazurio.ai/en/guide/?utm_source=launchpad&utm_medium=product&utm_campaign=guide",
  );
  expect(guideDocumentationUrl("de")).toBe(guideDocumentationUrl("cs"));
});

import { test, expect } from "bun:test";
import { isRetiredKnowledgeEditorPath } from "./retired-knowledge-editor.mjs";
test("document editor retirement preserves content and CMS editors", () => {
  for (const module of ["knowledgebase", "wiki", "wiki-rozjedemeai", "documentation"]) {
    expect(isRetiredKnowledgeEditorPath(`organizations/Example/workspace/${module}/editor/v2/package.json`)).toBe(true);
    expect(isRetiredKnowledgeEditorPath(`${module}/app/v2/package.json`)).toBe(false);
  }
  for (const path of ["content/editor/v2/package.json", "content-rozjedemeai/editor/v1/package.json", "launchpad/components/editor/v1/package.json"])
    expect(isRetiredKnowledgeEditorPath(path)).toBe(false);
});

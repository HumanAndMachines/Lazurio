// Retirement applies to document editors only; content/CMS editors remain supported.
export function isRetiredKnowledgeEditorPath(path) {
  return /(?:^|\/)(?:knowledgebase|wiki(?:-[^/]+)?|documentation)\/editor(?:\/v\d+)?\/package\.json$/.test(String(path).replaceAll("\\", "/"));
}

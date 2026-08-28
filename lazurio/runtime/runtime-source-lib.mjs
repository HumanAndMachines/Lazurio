const canonicalWorktreeSlugPattern = /^(?!.*\.\.)[A-Za-z0-9._-]{1,200}$/;

export function normalizeRuntimeSource(source) {
  if (!source || source.type === "main") {
    if (source && Object.keys(source).some((key) => key !== "type")) {
      throw new Error("Main runtime source must not contain additional properties.");
    }
    return { type: "main" };
  }
  if (
    source.type !== "worktree"
    || typeof source.slug !== "string"
    || source.slug !== source.slug.trim()
    || !canonicalWorktreeSlugPattern.test(source.slug)
    || Object.keys(source).some((key) => !["type", "slug"].includes(key))
  ) {
    throw new Error("Runtime source must be main or a canonical worktree slug using 1-200 letters, digits, dot, underscore or hyphen characters without '..'.");
  }
  return { type: "worktree", slug: source.slug };
}

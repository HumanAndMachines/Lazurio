# Shared Knowledgebase editor v2

Root-owned, Organization-neutral editor for Knowledgebase modules. The component
provides a local Draft surface only: it never commits, pushes, opens a pull
request, or publishes content.

## Consumer contract

A Knowledgebase module resolves this component from its enclosing Lazurio root
and dynamically imports:

- `lib/astro-integration.ts` for the dev-only editor button and owned process
  lifecycle;
- `lib/create-server.ts` from its module-owned editor entrypoint.

`createEditorServer(config)` starts synchronously and returns the Bun server.
The consumer supplies its exact module listener lease, repository root,
application root, preview URL, project identity, and authoring paths. Its
`publicDir` must resolve to this component's own `public/` directory.
`editorButton(config)` receives the same `projectKey` as `createEditorServer`;
the integration reuses an existing healthy listener only when that exact
project identity matches.

Authoring paths are portable repository-relative paths. Existing files may be
configured directly; new files can be created only below a configured directory
and only with an allowlisted text extension (`.md`, `.mdx`, `.ts`, `.json`).

## Security and publication boundary

- Both listeners are loopback-only and use exact Host checks.
- Editor reads require a process-local HttpOnly session cookie; writes also
  require the exact editor Origin.
- Linked path components, traversal, unsupported file types, oversized content,
  and stale revisions fail closed.
- Saves use a same-directory temporary file plus atomic rename.
- The Astro control endpoints accept mutations only from a loopback Host with
  its matching Origin and stop only the child process they started.
- The UI labels every save as a local Draft. Git review and publication stay in
  the standard Lazurio workflow.

`component.json` is the readiness manifest consumed by Launchpad diagnostics.
Launchpad reports the editor as ready only when the exact entrypoints and static
assets declared by the v2 contract are present as real files.

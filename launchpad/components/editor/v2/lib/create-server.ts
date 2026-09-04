import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const AUTHORING_EXTENSIONS = new Set(['.md', '.mdx', '.ts', '.json'])
const MAX_DOCUMENT_BYTES = 1024 * 1024
const SESSION_COOKIE = 'lazurio_editor_session'
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60
const COMPONENT_PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export type EditorConfig = {
  host: string
  port: number
  previewBaseUrl: string
  projectTitle: string
  projectKey: string
  repoRoot: string
  appRoot: string
  authoringPaths: string[]
  publicDir: string
}

type AuthoringRoot = {
  relativePath: string
  absolutePath: string
  kind: 'directory' | 'file'
}

export function createEditorServer(config: EditorConfig) {
  const resolved = resolveEditorConfig(config)
  const sessionToken = randomBytes(32).toString('base64url')
  let writeQueue = Promise.resolve()
  const withWriteLock = <T>(write: () => Promise<T>) => {
    const pending = writeQueue.then(write, write)
    writeQueue = pending.then(() => undefined, () => undefined)
    return pending
  }
  const server = Bun.serve({
    hostname: resolved.host,
    port: resolved.port,
    async fetch(request) {
      try {
        const url = new URL(request.url)
        if (url.host !== resolved.authority) return response('Invalid Host.', 421)

        if (request.method === 'GET' && url.pathname === '/api/health') {
          return json({
            schema_version: 'lazurio.knowledgebase.editor.health.v2',
            status: 'ok',
            project_key: resolved.projectKey,
          })
        }

        if (request.method === 'GET' && url.pathname === '/') {
          const html = await readPublicFile(resolved.publicDir, 'index.html')
          return response(html.bytes, 200, {
            'content-type': html.contentType,
            'set-cookie': sessionCookie(sessionToken),
          })
        }

        if (request.method === 'GET' && (url.pathname === '/app.js' || url.pathname === '/styles.css')) {
          const asset = await readPublicFile(resolved.publicDir, url.pathname.slice(1))
          return response(asset.bytes, 200, { 'content-type': asset.contentType })
        }

        if (!hasSession(request, sessionToken)) return jsonError('Editor session is missing.', 401)

        if (request.method === 'GET' && url.pathname === '/api/state') {
          return json({
            ok: true,
            data: {
              projectTitle: resolved.projectTitle,
              projectKey: resolved.projectKey,
              previewBaseUrl: resolved.previewBaseUrl,
              files: await listAuthoringFiles(resolved.repoRoot, resolved.authoringRoots),
            },
          })
        }

        if (request.method === 'GET' && url.pathname === '/api/file') {
          const requestedPath = url.searchParams.get('path')
          const file = await readAuthoringFile(resolved.repoRoot, resolved.authoringRoots, requestedPath)
          return json({ ok: true, data: file })
        }

        if (request.method === 'POST' && url.pathname === '/api/file') {
          if (request.headers.get('origin') !== resolved.origin) {
            return jsonError('Editor Origin does not match this listener.', 403)
          }
          const payload = await readJsonBody(request)
          const saved = await withWriteLock(() => saveAuthoringFile({
            repoRoot: resolved.repoRoot,
            authoringRoots: resolved.authoringRoots,
            requestedPath: payload.path,
            content: payload.content,
            baseRevision: payload.baseRevision,
          }))
          return json({ ok: true, data: saved })
        }

        return jsonError('Unknown editor endpoint.', 404)
      } catch (error) {
        const known = error instanceof EditorBoundaryError ? error : null
        return jsonError(known?.message ?? 'Editor request failed.', known?.status ?? 500)
      }
    },
  })

  console.log(`${resolved.projectTitle} editor is running at ${resolved.origin}`)
  return server
}

class EditorBoundaryError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'EditorBoundaryError'
    this.status = status
  }
}

function resolveEditorConfig(config: EditorConfig) {
  if (!config || typeof config !== 'object') throw new EditorBoundaryError('Editor config is required.')
  const host = requiredString(config.host, 'host')
  if (!LOOPBACK_HOSTS.has(host)) throw new EditorBoundaryError('Editor host must be loopback.')
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new EditorBoundaryError('Editor port must be an explicit listener lease.')
  }
  const repoRoot = realDirectorySync(config.repoRoot, 'repoRoot')
  const appRoot = realDirectorySync(config.appRoot, 'appRoot')
  if (!inside(repoRoot, appRoot, true)) throw new EditorBoundaryError('appRoot must stay inside repoRoot.')
  const publicDir = realDirectorySync(config.publicDir, 'publicDir')
  const componentPublicDir = realDirectorySync(COMPONENT_PUBLIC_DIR, 'component publicDir')
  if (pathKey(publicDir) !== pathKey(componentPublicDir)) {
    throw new EditorBoundaryError('publicDir must be the canonical shared editor asset directory.')
  }
  const previewBaseUrl = exactHttpUrl(config.previewBaseUrl, 'previewBaseUrl')
  const projectTitle = requiredString(config.projectTitle, 'projectTitle')
  const projectKey = requiredString(config.projectKey, 'projectKey')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(projectKey)) {
    throw new EditorBoundaryError('projectKey must be a portable identifier.')
  }
  const authoringRoots = resolveAuthoringRootsSync(repoRoot, config.authoringPaths)
  const authority = authorityFor(host, config.port)
  return {
    host,
    port: config.port,
    origin: `http://${authority}`,
    authority,
    repoRoot,
    appRoot,
    publicDir,
    previewBaseUrl,
    projectTitle,
    projectKey,
    authoringRoots,
  }
}

function resolveAuthoringRootsSync(repoRoot: string, authoringPaths: string[]) {
  if (!Array.isArray(authoringPaths) || authoringPaths.length === 0) {
    throw new EditorBoundaryError('At least one authoringPath is required.')
  }
  const roots: AuthoringRoot[] = []
  const seen = new Set<string>()
  for (const value of authoringPaths) {
    const relativePath = portableRelativePath(value, 'authoringPath')
    if (seen.has(relativePath)) throw new EditorBoundaryError(`Duplicate authoringPath: ${relativePath}`)
    seen.add(relativePath)
    const absolutePath = path.resolve(repoRoot, ...relativePath.split('/'))
    if (!inside(repoRoot, absolutePath, false)) {
      throw new EditorBoundaryError(`authoringPath escapes repoRoot: ${relativePath}`)
    }
    assertNoLinkedSegmentsSync(repoRoot, absolutePath)
    const stat = lstatSync(absolutePath)
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new EditorBoundaryError(`authoringPath is not a regular file or directory: ${relativePath}`)
    }
    roots.push({
      relativePath,
      absolutePath,
      kind: stat.isDirectory() ? 'directory' : 'file',
    })
  }
  return roots
}

async function listAuthoringFiles(repoRoot: string, roots: AuthoringRoot[]) {
  const files: string[] = []
  for (const root of roots) {
    if (root.kind === 'file') {
      assertAuthoringExtension(root.relativePath)
      files.push(root.relativePath)
      continue
    }
    await walkAuthoringDirectory(repoRoot, root.absolutePath, files)
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}

async function walkAuthoringDirectory(repoRoot: string, directory: string, files: string[]) {
  await assertNoLinkedSegments(repoRoot, directory, false)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new EditorBoundaryError('Linked paths are not valid editor content.')
    if (entry.isDirectory()) {
      await walkAuthoringDirectory(repoRoot, absolutePath, files)
      continue
    }
    if (!entry.isFile()) throw new EditorBoundaryError('Only regular files are valid editor content.')
    const relativePath = portableFromNative(path.relative(repoRoot, absolutePath))
    if (AUTHORING_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) files.push(relativePath)
  }
}

async function readAuthoringFile(repoRoot: string, roots: AuthoringRoot[], requestedPath: unknown) {
  const target = await resolveAuthoringFile(repoRoot, roots, requestedPath, false)
  const bytes = await readFile(target.absolutePath)
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new EditorBoundaryError('Editor file is too large.', 413)
  const content = decodeUtf8(bytes)
  return { path: target.relativePath, content, revision: revision(content) }
}

async function saveAuthoringFile({
  repoRoot,
  authoringRoots,
  requestedPath,
  content,
  baseRevision,
}: {
  repoRoot: string
  authoringRoots: AuthoringRoot[]
  requestedPath: unknown
  content: unknown
  baseRevision: unknown
}) {
  if (typeof content !== 'string') throw new EditorBoundaryError('content must be a string.')
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new EditorBoundaryError('Editor file is too large.', 413)
  }
  if (baseRevision !== null && typeof baseRevision !== 'string') {
    throw new EditorBoundaryError('baseRevision must be a string or null.')
  }
  const target = await resolveAuthoringFile(repoRoot, authoringRoots, requestedPath, true)
  let currentRevision: string | null = null
  try {
    const current = await readFile(target.absolutePath, 'utf8')
    currentRevision = revision(current)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!secureEqual(currentRevision, baseRevision)) {
    throw new EditorBoundaryError('File changed after it was opened; reload before saving.', 409)
  }

  const parent = path.dirname(target.absolutePath)
  await assertNoLinkedSegments(repoRoot, parent, false)
  const temporaryPath = path.join(parent, `.lazurio-editor-${randomUUID()}.tmp`)
  let temporaryCreated = false
  try {
    const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    temporaryCreated = true
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertNoLinkedSegments(repoRoot, parent, false)
    if (currentRevision === null) {
      try {
        await link(temporaryPath, target.absolutePath)
      } catch (error: any) {
        if (error?.code === 'EEXIST') {
          throw new EditorBoundaryError('File changed after it was opened; reload before saving.', 409)
        }
        throw error
      }
      await rm(temporaryPath)
      temporaryCreated = false
    } else {
      const latest = decodeUtf8(await readFile(target.absolutePath))
      if (!secureEqual(revision(latest), baseRevision)) {
        throw new EditorBoundaryError('File changed after it was opened; reload before saving.', 409)
      }
      await rename(temporaryPath, target.absolutePath)
      temporaryCreated = false
    }
  } finally {
    if (temporaryCreated) await rm(temporaryPath, { force: true })
  }
  return { path: target.relativePath, revision: revision(content) }
}

async function resolveAuthoringFile(
  repoRoot: string,
  roots: AuthoringRoot[],
  requestedPath: unknown,
  allowMissing: boolean,
) {
  const relativePath = portableRelativePath(requestedPath, 'path')
  assertAuthoringExtension(relativePath)
  const absolutePath = path.resolve(repoRoot, ...relativePath.split('/'))
  const owningRoot = roots.find((root) => (
    root.kind === 'file'
      ? pathKey(root.absolutePath) === pathKey(absolutePath)
      : inside(root.absolutePath, absolutePath, false)
  ))
  if (!owningRoot) throw new EditorBoundaryError('Requested file is outside authoringPaths.', 403)
  await assertNoLinkedSegments(repoRoot, absolutePath, allowMissing)
  if (!allowMissing) {
    const stat = await lstat(absolutePath)
    if (!stat.isFile()) throw new EditorBoundaryError('Requested editor path is not a regular file.')
  } else {
    try {
      const stat = await lstat(absolutePath)
      if (!stat.isFile()) throw new EditorBoundaryError('Requested editor path is not a regular file.')
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      if (owningRoot.kind !== 'directory') throw new EditorBoundaryError('Configured file does not exist.', 404)
      await access(path.dirname(absolutePath), constants.W_OK)
    }
  }
  return { relativePath, absolutePath }
}

async function assertNoLinkedSegments(repoRoot: string, targetPath: string, allowMissingLeaf: boolean) {
  const relativePath = path.relative(repoRoot, targetPath)
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new EditorBoundaryError('Editor path escapes repoRoot.')
  }
  let cursor = repoRoot
  const segments = relativePath.split(path.sep).filter(Boolean)
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment)
    try {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink()) throw new EditorBoundaryError('Linked editor paths are forbidden.')
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new EditorBoundaryError('Editor path parent is not a directory.')
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT' && allowMissingLeaf && index === segments.length - 1) return
      throw error
    }
  }
  const canonical = await realpath(targetPath)
  if (!inside(repoRoot, canonical, false)) throw new EditorBoundaryError('Canonical editor path escapes repoRoot.')
}

function assertNoLinkedSegmentsSync(repoRoot: string, targetPath: string) {
  const relativePath = path.relative(repoRoot, targetPath)
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new EditorBoundaryError('Editor path escapes repoRoot.')
  }
  let cursor = repoRoot
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) throw new EditorBoundaryError('Linked editor paths are forbidden.')
  }
  const canonical = realpathSync(targetPath)
  if (!inside(repoRoot, canonical, false)) throw new EditorBoundaryError('Canonical editor path escapes repoRoot.')
}

function realDirectorySync(value: unknown, label: string) {
  const absolutePath = path.resolve(requiredString(value, label))
  const stat = lstatSync(absolutePath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new EditorBoundaryError(`${label} must be a real directory.`)
  }
  return realpathSync(absolutePath)
}

async function readPublicFile(publicDir: string, relativePath: string) {
  const absolutePath = path.resolve(publicDir, relativePath)
  if (!inside(publicDir, absolutePath, false)) throw new EditorBoundaryError('Public asset path escapes its root.')
  await assertNoLinkedSegments(publicDir, absolutePath, false)
  const bytes = await readFile(absolutePath)
  const contentType = relativePath.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : relativePath.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/css; charset=utf-8'
  return { bytes, contentType }
}

function portableRelativePath(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim() === '') throw new EditorBoundaryError(`${label} is required.`)
  const candidate = value.trim()
  if (
    candidate.includes('\0')
    || candidate.includes('\\')
    || candidate.startsWith('/')
    || /^[A-Za-z]:/.test(candidate)
  ) throw new EditorBoundaryError(`${label} must be a portable relative path.`)
  const normalized = path.posix.normalize(candidate.replace(/^\.\//, ''))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new EditorBoundaryError(`${label} escapes its root.`)
  }
  return normalized
}

function assertAuthoringExtension(relativePath: string) {
  if (!AUTHORING_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) {
    throw new EditorBoundaryError('Requested file type is not authorable.', 415)
  }
}

function portableFromNative(value: string) {
  return value.split(path.sep).join('/')
}

function inside(root: string, candidate: string, allowRoot: boolean) {
  const relativePath = path.relative(root, candidate)
  return (allowRoot && relativePath === '')
    || (relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function pathKey(value: string) {
  const normalized = path.resolve(value).split(path.sep).join('/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function exactHttpUrl(value: unknown, label: string) {
  const raw = requiredString(value, label)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new EditorBoundaryError(`${label} must be an absolute HTTP URL.`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new EditorBoundaryError(`${label} must be a credential-free HTTP URL.`)
  }
  return url.toString().replace(/\/$/, '')
}

function authorityFor(host: string, port: number) {
  const browserHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${browserHost}:${port}`
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim() === '') throw new EditorBoundaryError(`${label} is required.`)
  return value.trim()
}

async function readJsonBody(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new EditorBoundaryError('Editor mutations require application/json.', 415)
  }
  try {
    return await request.json() as Record<string, unknown>
  } catch {
    throw new EditorBoundaryError('Request body is not valid JSON.')
  }
}

function revision(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new EditorBoundaryError('Editor file is not valid UTF-8 text.', 415)
  }
}

function secureEqual(left: string | null, right: unknown) {
  if (left === null || right === null) return left === right
  if (typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function hasSession(request: Request, expectedToken: string) {
  const cookie = request.headers.get('cookie') ?? ''
  const token = cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
  return typeof token === 'string' && secureEqual(expectedToken, token)
}

function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`
}

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }
}

function response(body: BodyInit | null, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { ...securityHeaders(), ...headers } })
}

function json(payload: unknown, status = 200) {
  return response(JSON.stringify(payload), status, { 'content-type': 'application/json; charset=utf-8' })
}

function jsonError(message: string, status: number) {
  return json({ ok: false, error: message }, status)
}

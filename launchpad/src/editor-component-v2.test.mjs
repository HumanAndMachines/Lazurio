import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createEditorServer,
} from '../components/editor/v2/lib/create-server.ts'
import {
  buildClientScript,
  editorButton,
} from '../components/editor/v2/lib/astro-integration.ts'

const cleanup = []
const componentPublicDir = fileURLToPath(new URL('../components/editor/v2/public', import.meta.url))

function deferred() {
  let resolve
  const promise = new Promise((next) => { resolve = next })
  return { promise, resolve }
}

function browserResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload
    },
  }
}

async function flushBrowserTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map(async (value) => {
    if (typeof value === 'function') return value()
    return rm(value, { recursive: true, force: true })
  }))
})

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : null
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function fixture() {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lazurio-editor-v2-'))
  cleanup.push(repoRoot)
  await mkdir(path.join(repoRoot, 'app', 'v2'), { recursive: true })
  await mkdir(path.join(repoRoot, 'data', 'v2', 'docs', 'cs'), { recursive: true })
  await writeFile(path.join(repoRoot, 'data', 'v2', 'docs', 'cs', 'page.md'), '# Page\n', 'utf8')
  await writeFile(path.join(repoRoot, 'data', 'v2', 'sidebar.ts'), 'export const sidebar = []\n', 'utf8')
  return {
    host: '127.0.0.1',
    port: await freePort(),
    previewBaseUrl: 'http://127.0.0.1:49000/cs/',
    projectTitle: 'Fixture Knowledgebase',
    projectKey: 'fixture-kb',
    repoRoot,
    appRoot: path.join(repoRoot, 'app', 'v2'),
    authoringPaths: ['data/v2/docs', 'data/v2/sidebar.ts'],
    publicDir: componentPublicDir,
  }
}

function sessionCookie(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0]
}

describe('shared Knowledgebase editor v2', () => {
  test('serves a loopback session and saves only an exact non-stale authoring draft', async () => {
    const config = await fixture()
    const server = createEditorServer(config)
    cleanup.push(() => server.stop(true))
    const origin = `http://${config.host}:${config.port}`

    const health = await fetch(`${origin}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      schema_version: 'lazurio.knowledgebase.editor.health.v2',
      status: 'ok',
      project_key: 'fixture-kb',
    })

    const page = await fetch(`${origin}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    const cookie = sessionCookie(page)
    expect(cookie).toStartWith('lazurio_editor_session=')

    const state = await fetch(`${origin}/api/state`, { headers: { cookie } })
    expect(await state.json()).toMatchObject({
      ok: true,
      data: {
        projectTitle: 'Fixture Knowledgebase',
        files: ['data/v2/docs/cs/page.md', 'data/v2/sidebar.ts'],
      },
    })

    const opened = await fetch(`${origin}/api/file?path=${encodeURIComponent('data/v2/docs/cs/page.md')}`, {
      headers: { cookie },
    })
    const openedPayload = await opened.json()
    expect(openedPayload).toMatchObject({ ok: true, data: { content: '# Page\n' } })

    const missingOrigin = await fetch(`${origin}/api/file`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'data/v2/docs/cs/page.md',
        content: '# Updated\n',
        baseRevision: openedPayload.data.revision,
      }),
    })
    expect(missingOrigin.status).toBe(403)

    const saved = await fetch(`${origin}/api/file`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'data/v2/docs/cs/page.md',
        content: '# Updated\n',
        baseRevision: openedPayload.data.revision,
      }),
    })
    expect(saved.status).toBe(200)
    expect(await readFile(path.join(config.repoRoot, 'data/v2/docs/cs/page.md'), 'utf8')).toBe('# Updated\n')

    const stale = await fetch(`${origin}/api/file`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'data/v2/docs/cs/page.md',
        content: '# Lost update\n',
        baseRevision: openedPayload.data.revision,
      }),
    })
    expect(stale.status).toBe(409)
    expect(await readFile(path.join(config.repoRoot, 'data/v2/docs/cs/page.md'), 'utf8')).toBe('# Updated\n')

    const concurrentOpened = await fetch(
      `${origin}/api/file?path=${encodeURIComponent('data/v2/docs/cs/page.md')}`,
      { headers: { cookie } },
    ).then((response) => response.json())
    const concurrentWrites = await Promise.all([
      '# Concurrent A\n',
      '# Concurrent B\n',
    ].map((nextContent) => fetch(`${origin}/api/file`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'data/v2/docs/cs/page.md',
        content: nextContent,
        baseRevision: concurrentOpened.data.revision,
      }),
    })))
    expect(concurrentWrites.map((response) => response.status).sort()).toEqual([200, 409])
    expect(['# Concurrent A\n', '# Concurrent B\n']).toContain(
      await readFile(path.join(config.repoRoot, 'data/v2/docs/cs/page.md'), 'utf8'),
    )

    const created = await fetch(`${origin}/api/file`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'data/v2/docs/cs/new-page.md',
        content: '# New page\n',
        baseRevision: null,
      }),
    })
    expect(created.status).toBe(200)
    expect(await readFile(path.join(config.repoRoot, 'data/v2/docs/cs/new-page.md'), 'utf8')).toBe('# New page\n')
  }, 15_000)

  test('rejects traversal, linked parents, non-authoring files and a foreign Host', async () => {
    const config = await fixture()
    const outside = await mkdtemp(path.join(tmpdir(), 'lazurio-editor-outside-'))
    cleanup.push(outside)
    await writeFile(path.join(outside, 'secret.md'), 'secret\n', 'utf8')
    await writeFile(
      path.join(config.repoRoot, 'data/v2/docs/cs/invalid.md'),
      Uint8Array.from([0xff, 0xfe]),
    )
    await symlink(
      outside,
      path.join(config.repoRoot, 'data/v2/docs/escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const server = createEditorServer(config)
    cleanup.push(() => server.stop(true))
    const origin = `http://${config.host}:${config.port}`
    const page = await fetch(`${origin}/`)
    const cookie = sessionCookie(page)

    const traversal = await fetch(`${origin}/api/file?path=${encodeURIComponent('../outside.md')}`, {
      headers: { cookie },
    })
    expect(traversal.status).toBe(400)

    const linked = await fetch(`${origin}/api/file?path=${encodeURIComponent('data/v2/docs/escape/secret.md')}`, {
      headers: { cookie },
    })
    expect(linked.status).toBe(400)

    const unsupported = await fetch(`${origin}/api/file?path=${encodeURIComponent('data/v2/docs/image.svg')}`, {
      headers: { cookie },
    })
    expect(unsupported.status).toBe(415)

    const invalidUtf8 = await fetch(`${origin}/api/file?path=${encodeURIComponent('data/v2/docs/cs/invalid.md')}`, {
      headers: { cookie },
    })
    expect(invalidUtf8.status).toBe(415)

    const foreignHost = await fetch(`${origin}/api/health`, { headers: { host: 'attacker.invalid' } })
    expect(foreignHost.status).toBe(421)
  }, 15_000)

  test('refuses a non-loopback listener before bind', async () => {
    const config = await fixture()
    expect(() => createEditorServer({ ...config, host: '0.0.0.0' })).toThrow('loopback')
  })

  test('refuses consumer-selected public assets before bind', async () => {
    const config = await fixture()
    const foreignPublicDir = await mkdtemp(path.join(tmpdir(), 'lazurio-editor-public-'))
    cleanup.push(foreignPublicDir)
    expect(() => createEditorServer({ ...config, publicDir: foreignPublicDir })).toThrow(
      'canonical shared editor asset directory',
    )
  })

  test('supports the existing consumer dynamic-import and synchronous start contract', async () => {
    const config = await fixture()
    const moduleUrl = pathToFileURL(
      fileURLToPath(new URL('../components/editor/v2/lib/create-server.ts', import.meta.url)),
    ).href
    const consumerModule = await import(moduleUrl)
    const server = consumerModule.createEditorServer(config)
    expect(server).not.toBeInstanceOf(Promise)
    cleanup.push(() => server.stop(true))

    const health = await fetch(`http://${config.host}:${config.port}/api/health`)
    expect(health.status).toBe(200)
  })

  test('Astro integration is neutral, dev-only and starts the exact Bun executable', async () => {
    const integration = editorButton({
      editorServerPath: '/fixture/editor/server.ts',
      editorPort: 45123,
      projectKey: 'fixture-kb',
    })
    expect(integration.name).toBe('lazurio-knowledgebase-editor-v2')
    const script = buildClientScript('http://127.0.0.1:45123')
    expect(script).toContain('Upravit Knowledgebase')
    expect(script).not.toContain('rozjedeme')
    expect(script).not.toContain('LightWorks')
    const clickHandler = script.slice(script.indexOf("button.addEventListener('click'"))
    expect(clickHandler.indexOf("window.open('about:blank'")).toBeLessThan(
      clickHandler.indexOf('const current = await status()'),
    )
    expect(script).toContain('window.location.assign(editorOrigin)')

    let middleware
    await integration.hooks['astro:server:setup']({
      server: {
        middlewares: {
          use(handler) {
            middleware = handler
          },
        },
      },
    })
    const response = {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(body) {
        this.body = body
      },
    }
    await middleware({
      method: 'POST',
      url: '/__editor/start',
      headers: {
        host: 'attacker.invalid:4321',
        origin: 'http://attacker.invalid:4321',
      },
    }, response, () => {})
    expect(response.statusCode).toBe(403)
  })

  test('Astro integration reuses a healthy listener only for the configured project', async () => {
    const port = await freePort()
    const listener = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch() {
        return Response.json({
          schema_version: 'lazurio.knowledgebase.editor.health.v2',
          status: 'ok',
          project_key: 'foreign-kb',
        })
      },
    })
    cleanup.push(() => listener.stop(true))

    async function statusFor(projectKey) {
      const integration = editorButton({
        editorServerPath: '/fixture/editor/server.ts',
        editorPort: port,
        projectKey,
      })
      let middleware
      await integration.hooks['astro:server:setup']({
        server: {
          middlewares: {
            use(handler) {
              middleware = handler
            },
          },
        },
      })
      const response = {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) {
          this.headers[name] = value
        },
        end(body) {
          this.body = body
        },
      }
      await middleware({
        method: 'GET',
        url: '/__editor/status',
        headers: { host: '127.0.0.1:4321' },
      }, response, () => {})
      return JSON.parse(response.body)
    }

    expect(await statusFor('fixture-kb')).toMatchObject({ ok: true, running: false })
    expect(await statusFor('foreign-kb')).toMatchObject({ ok: true, running: true })
  })

  test('browser ignores an older file response after a newer selection', async () => {
    const clientSource = await readFile(
      path.join(componentPublicDir, 'app.js'),
      'utf8',
    )
    const handlers = new Map()
    const elements = new Map()
    const element = (id, initial = {}) => {
      const value = {
        textContent: '',
        value: '',
        disabled: false,
        dataset: {},
        options: [],
        addEventListener(event, handler) {
          handlers.set(`${id}:${event}`, handler)
        },
        appendChild(child) {
          this.options.push(child)
        },
        ...initial,
      }
      elements.set(`#${id}`, value)
      return value
    }
    element('project-title')
    element('preview-link')
    const fileList = element('file-list')
    element('new-file-form')
    element('new-file')
    const currentPath = element('current-path')
    const content = element('content', { disabled: true })
    const save = element('save', { disabled: true })
    const status = element('status')
    const document = {
      title: '',
      querySelector(selector) {
        return elements.get(selector)
      },
      createElement() {
        return { value: '', textContent: '' }
      },
    }
    const fileRequests = new Map()
    const fetch = (url) => {
      if (url === '/api/state') {
        return Promise.resolve(browserResponse({
          ok: true,
          data: {
            projectTitle: 'Fixture Knowledgebase',
            previewBaseUrl: 'http://127.0.0.1:49000/cs/',
            files: ['data/v2/docs/cs/a.md', 'data/v2/docs/cs/b.md'],
          },
        }))
      }
      const pending = deferred()
      fileRequests.set(url, pending)
      return pending.promise
    }
    Function('document', 'fetch', clientSource)(document, fetch)
    await flushBrowserTasks()

    const pathA = 'data/v2/docs/cs/a.md'
    const pathB = 'data/v2/docs/cs/b.md'
    fileList.value = pathA
    handlers.get('file-list:change')()
    fileList.value = pathB
    handlers.get('file-list:change')()

    fileRequests.get(`/api/file?path=${encodeURIComponent(pathB)}`).resolve(browserResponse({
      ok: true,
      data: { path: pathB, revision: 'revision-b', content: '# B\n' },
    }))
    await flushBrowserTasks()
    expect(currentPath.textContent).toBe(pathB)
    expect(content.value).toBe('# B\n')
    expect(content.disabled).toBe(false)
    expect(save.disabled).toBe(false)
    expect(status.textContent).toBe('Načteno')

    fileRequests.get(`/api/file?path=${encodeURIComponent(pathA)}`).resolve(browserResponse({
      ok: true,
      data: { path: pathA, revision: 'revision-a', content: '# A\n' },
    }))
    await flushBrowserTasks()
    expect(fileList.value).toBe(pathB)
    expect(currentPath.textContent).toBe(pathB)
    expect(content.value).toBe('# B\n')
  })
})

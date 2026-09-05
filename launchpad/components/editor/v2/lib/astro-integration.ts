import { spawn, type ChildProcess } from 'node:child_process'
import type { AstroIntegration } from 'astro'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export type EditorButtonConfig = {
  editorServerPath: string
  editorHost?: string
  editorPort: number
  projectKey: string
}

export function editorButton(config: EditorButtonConfig): AstroIntegration {
  const editorHost = config.editorHost ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(editorHost)) throw new Error('Editor integration requires a loopback host.')
  if (!Number.isInteger(config.editorPort) || config.editorPort < 1 || config.editorPort > 65535) {
    throw new Error('Editor integration requires an explicit valid port lease.')
  }
  if (typeof config.editorServerPath !== 'string' || config.editorServerPath.trim() === '') {
    throw new Error('Editor integration requires an editor server path.')
  }
  if (typeof config.projectKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(config.projectKey)) {
    throw new Error('Editor integration requires a portable project key.')
  }

  const editorOrigin = `http://${authorityFor(editorHost, config.editorPort)}`
  const projectKey = config.projectKey
  let editorProcess: ChildProcess | null = null

  async function health() {
    try {
      const response = await fetch(`${editorOrigin}/api/health`, { signal: AbortSignal.timeout(700) })
      if (!response.ok) return false
      const payload = await response.json() as Record<string, unknown>
      return payload.schema_version === 'lazurio.knowledgebase.editor.health.v2'
        && payload.status === 'ok'
        && payload.project_key === projectKey
    } catch {
      return false
    }
  }

  function startEditor() {
    if (editorProcess) return false
    editorProcess = spawn(process.execPath, [config.editorServerPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        HOST: editorHost,
        PORT: String(config.editorPort),
        LAZURIO_RUNTIME_LISTENER_EDITOR_HOST: editorHost,
        LAZURIO_RUNTIME_LISTENER_EDITOR_PORT: String(config.editorPort),
      },
      windowsHide: true,
    })
    editorProcess.once('error', (error) => {
      console.error(`[editor] Failed to start: ${error.message}`)
      editorProcess = null
    })
    editorProcess.once('exit', (code) => {
      if (code !== null && code !== 0) console.error(`[editor] Exited with code ${code}`)
      editorProcess = null
    })
    return true
  }

  function stopOwnedEditor() {
    if (!editorProcess) return false
    const child = editorProcess
    editorProcess = null
    try {
      return child.kill()
    } catch {
      return false
    }
  }

  return {
    name: 'lazurio-knowledgebase-editor-v2',
    hooks: {
      'astro:config:setup': ({ command, injectScript }) => {
        if (command === 'dev') injectScript('page', buildClientScript(editorOrigin))
      },
      'astro:server:setup': ({ server }) => {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/__editor')) return next()
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          const origin = req.headers.origin
          const expectedOrigin = loopbackRequestOrigin(req.headers.host)
          if (req.method === 'POST' && (!expectedOrigin || origin !== expectedOrigin)) {
            res.statusCode = 403
            res.end(JSON.stringify({ ok: false, error: 'Origin mismatch.' }))
            return
          }
          if (req.method === 'GET' && req.url === '/__editor/status') {
            res.end(JSON.stringify({ ok: true, running: await health(), url: editorOrigin }))
            return
          }
          if (req.method === 'POST' && req.url === '/__editor/start') {
            if (await health()) {
              res.end(JSON.stringify({ ok: true, started: false, url: editorOrigin }))
              return
            }
            const started = startEditor()
            res.statusCode = started ? 202 : 409
            res.end(JSON.stringify({ ok: started, started, url: editorOrigin }))
            return
          }
          if (req.method === 'POST' && req.url === '/__editor/stop') {
            const stopped = stopOwnedEditor()
            res.statusCode = stopped ? 200 : 409
            res.end(JSON.stringify({ ok: stopped }))
            return
          }
          res.statusCode = 404
          res.end(JSON.stringify({ ok: false, error: 'Unknown editor endpoint.' }))
        })
      },
      'astro:server:done': () => {
        stopOwnedEditor()
      },
    },
  }
}

export function buildClientScript(editorOrigin: string) {
  return `
(() => {
  if (document.getElementById('__lazurio-editor-v2')) return;
  const editorOrigin = ${JSON.stringify(editorOrigin)};
  const button = document.createElement('button');
  button.id = '__lazurio-editor-v2';
  button.type = 'button';
  button.textContent = 'Upravit Knowledgebase';
  button.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;border:0;border-radius:999px;padding:10px 16px;background:#111827;color:white;font:600 13px system-ui;box-shadow:0 8px 24px rgba(15,23,42,.22);cursor:pointer';
  async function status() {
    const response = await fetch('/__editor/status', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Editor status failed');
    return response.json();
  }
  async function waitUntilReady() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const current = await status();
      if (current.running) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }
  button.addEventListener('click', async () => {
    const editorWindow = window.open('about:blank', 'lazurio-knowledgebase-editor-v2');
    if (editorWindow) editorWindow.opener = null;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Spouštím editor…';
    try {
      const current = await status();
      if (!current.running) {
        const response = await fetch('/__editor/start', { method: 'POST', credentials: 'same-origin' });
        if (!response.ok) throw new Error('Editor start failed');
        if (!(await waitUntilReady())) throw new Error('Editor health timeout');
      }
      if (editorWindow) editorWindow.location.replace(editorOrigin);
      else window.location.assign(editorOrigin);
    } catch (error) {
      if (editorWindow) editorWindow.close();
      console.error('[editor]', error);
      button.textContent = 'Editor se nepodařilo spustit';
      setTimeout(() => { button.textContent = original; }, 2500);
    } finally {
      button.disabled = false;
      if (button.textContent === 'Spouštím editor…') button.textContent = original;
    }
  });
  document.body.appendChild(button);
})();
`
}

function authorityFor(host: string, port: number) {
  const browserHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${browserHost}:${port}`
}

function loopbackRequestOrigin(authority: string | undefined) {
  if (!authority) return null
  try {
    const parsed = new URL(`http://${authority}`)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    const port = Number(parsed.port)
    if (!LOOPBACK_HOSTS.has(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

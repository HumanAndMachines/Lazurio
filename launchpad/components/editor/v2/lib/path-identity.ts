import path from 'node:path'

export function comparablePath(value: string, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  let normalized = pathApi.resolve(value)

  if (platform === 'win32') {
    if (normalized.toLowerCase().startsWith('\\\\?\\unc\\')) {
      normalized = `\\\\${normalized.slice(8)}`
    } else if (normalized.startsWith('\\\\?\\')) {
      normalized = normalized.slice(4)
    }
    return pathApi
      .normalize(normalized)
      .replace(/[\\/]+$/u, '')
      .replaceAll('\\', '/')
      .toLowerCase()
  }

  return pathApi.normalize(normalized).replace(/\/+$/u, '') || '/'
}

export function pathIsInside(
  root: string,
  candidate: string,
  allowRoot: boolean,
  platform = process.platform,
) {
  const rootKey = comparablePath(root, platform)
  const candidateKey = comparablePath(candidate, platform)
  if (candidateKey === rootKey) return allowRoot
  return candidateKey.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`)
}

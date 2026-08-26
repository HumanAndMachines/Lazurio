import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSET_ROOT = path.join(APP_ROOT, 'public', 'assets', 'mattycus')
const RECEIPT_PATH = path.join(ASSET_ROOT, 'pet.json')
const STYLE_PATH = path.join(APP_ROOT, 'src', 'styles', 'global.css')
const COMPONENT_PATH = path.join(APP_ROOT, 'src', 'components', 'GuidePet.astro')
const PUBLIC_ASSET_URL = '/assets/mattycus/spritesheet.webp'

const EXPECTED = Object.freeze({
  id: 'mattycus',
  displayName: 'Mattyčus',
  role: 'default_buddy_mascot',
  allowedSurfaces: ['buddy', 'guide'],
  emptyState: 'neutral_placeholder',
  semanticAuthority: 'presentation_only',
  repository: 'Rozjedeme-ai/design-system-lazurio',
  manifestPath: 'content/brand/buddy/assets.json',
  assetKey: 'spritesheet',
  spritesheetPath: 'spritesheet.webp',
  mediaType: 'image/webp',
  width: 1536,
  height: 1872,
  bytes: 1_959_990,
  sha256: '7bbe0d629ea1e3e65cf24955372b4295f0b25d79afa51242d4cdd5b931e01f0a',
  grid: {
    columns: 8,
    rows: 9,
    frameWidth: 192,
    frameHeight: 208,
  },
})

function fail(message) {
  throw new Error(`Mattycus Guide asset check blocked: ${message}`)
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Prove that the component actually renders the class and that its single base
 * rule owns the canonical background image. This is deliberately stricter than
 * a global substring search: comments, unused rules and later exact-selector
 * overrides cannot satisfy the gate.
 */
export function assertGuideCssContract(styles, component) {
  const activeStyles = stripComments(styles)
  const baseRulePattern = /(?:^|(?<=\}))\s*\.guide-pet-sprite\s*\{([^{}]*)\}/g
  const baseRules = [...activeStyles.matchAll(baseRulePattern)].map((match) => match[1])
  if (baseRules.length !== 1) {
    fail(`Guide CSS must define exactly one base .guide-pet-sprite rule, found ${baseRules.length}`)
  }

  const imageDeclarations = [
    ...baseRules[0].matchAll(/(?:^|;)\s*background-image\s*:\s*([^;]+)(?=;|$)/g),
  ].map((match) => match[1].trim())
  const expectedDeclaration = `url("${PUBLIC_ASSET_URL}")`
  if (imageDeclarations.length !== 1 || imageDeclarations[0] !== expectedDeclaration) {
    fail(`the base .guide-pet-sprite rule must own background-image: ${expectedDeclaration}`)
  }

  const rulesWithSpriteImage = [...activeStyles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].includes('.guide-pet-sprite'))
    .filter((match) => /(?:^|;)\s*background-image\s*:/m.test(match[2]))
  if (rulesWithSpriteImage.length !== 1) {
    fail('no other .guide-pet-sprite selector may override its background image')
  }

  const activeComponent = stripComments(component)
  if (!/<span\b[^>]*\bclass=(['"])[^'"]*\bguide-pet-sprite\b[^'"]*\1[^>]*>/m.test(activeComponent)) {
    fail('GuidePet.astro must render the .guide-pet-sprite element')
  }
}

function main() {
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'))
  assertEqual(receipt.id, EXPECTED.id, 'identity id')
  assertEqual(receipt.displayName, EXPECTED.displayName, 'identity displayName')
  assertEqual(receipt.spritesheetPath, EXPECTED.spritesheetPath, 'spritesheet path')
  assertEqual(receipt.identityContract?.role, EXPECTED.role, 'identity role')
  assertEqual(receipt.identityContract?.allowedSurfaces, EXPECTED.allowedSurfaces, 'allowed surfaces')
  assertEqual(receipt.identityContract?.emptyState, EXPECTED.emptyState, 'empty state')
  assertEqual(
    receipt.identityContract?.semanticAuthority,
    EXPECTED.semanticAuthority,
    'semantic authority',
  )
  assertEqual(receipt.canonicalSource?.repository, EXPECTED.repository, 'canonical repository')
  assertEqual(receipt.canonicalSource?.manifestPath, EXPECTED.manifestPath, 'canonical manifest path')
  assertEqual(receipt.canonicalSource?.assetKey, EXPECTED.assetKey, 'canonical asset key')
  assertEqual(receipt.spritesheet?.mediaType, EXPECTED.mediaType, 'spritesheet media type')
  assertEqual(receipt.spritesheet?.width, EXPECTED.width, 'spritesheet width')
  assertEqual(receipt.spritesheet?.height, EXPECTED.height, 'spritesheet height')
  assertEqual(receipt.spritesheet?.bytes, EXPECTED.bytes, 'spritesheet byte budget')
  assertEqual(receipt.spritesheet?.sha256, EXPECTED.sha256, 'spritesheet receipt digest')
  assertEqual(receipt.spritesheet?.grid, EXPECTED.grid, 'spritesheet frame grid')

  if (path.basename(receipt.spritesheetPath) !== receipt.spritesheetPath) {
    fail('spritesheetPath must be one local filename without traversal')
  }

  const assetPath = path.join(ASSET_ROOT, receipt.spritesheetPath)
  const assetBytes = readFileSync(assetPath)
  assertEqual(statSync(assetPath).size, EXPECTED.bytes, 'vendored spritesheet bytes')
  assertEqual(createHash('sha256').update(assetBytes).digest('hex'), EXPECTED.sha256, 'vendored digest')

  const styles = readFileSync(STYLE_PATH, 'utf8')
  const component = readFileSync(COMPONENT_PATH, 'utf8')
  assertGuideCssContract(styles, component)

  console.log(JSON.stringify({
    status: 'PASS',
    identity: EXPECTED.id,
    asset: PUBLIC_ASSET_URL,
    bytes: EXPECTED.bytes,
    sha256: EXPECTED.sha256,
    canonical_source: `${EXPECTED.repository}:${EXPECTED.manifestPath}#${EXPECTED.assetKey}`,
  }, null, 2))
}

if (import.meta.main) {
  main()
}

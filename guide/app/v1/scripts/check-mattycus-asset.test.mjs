import { describe, expect, test } from 'bun:test'
import { assertGuideCssContract } from './check-mattycus-asset.mjs'

const ASSET = '/assets/mattycus/spritesheet.webp'
const component = '<span class="guide-pet-sprite" aria-hidden="true"></span>'

describe('Mattyčus Guide CSS consumer contract', () => {
  test('accepts the rendered class with one canonical base declaration', () => {
    expect(() => assertGuideCssContract(
      `.guide-pet-sprite { display: block; background-image: url("${ASSET}"); }`,
      component,
    )).not.toThrow()
  })

  test('rejects a URL that appears only in a comment or an unused rule', () => {
    expect(() => assertGuideCssContract(
      `/* .guide-pet-sprite { background-image: url("${ASSET}"); } */
       .unused { background-image: url("${ASSET}"); }
       .guide-pet-sprite { display: block; }`,
      component,
    )).toThrow(/base .guide-pet-sprite rule must own/)
  })

  test('rejects a later exact-selector override', () => {
    expect(() => assertGuideCssContract(
      `.guide-pet-sprite { background-image: url("${ASSET}"); }
       .guide-pet-sprite { background-image: url("/assets/wrong.webp"); }`,
      component,
    )).toThrow(/exactly one base/)
  })

  test('rejects an unused CSS contract when GuidePet does not render the class', () => {
    expect(() => assertGuideCssContract(
      `.guide-pet-sprite { background-image: url("${ASSET}"); }`,
      '<span class="guide-pet"></span>',
    )).toThrow(/must render/)
  })
})

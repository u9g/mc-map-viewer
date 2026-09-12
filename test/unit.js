'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { Reader } = require('../src/reader')
const versions = require('../src/versions')
const { dataAllowList } = require('../src/bundle')

const VIEWER = path.dirname(require.resolve('prismarine-viewer/package.json'))

/** A chunk tag shaped like prismarine-nbt produces, with the bits under test. */
function chunkTag (sections) {
  return {
    type: 'compound',
    name: '',
    value: {
      sections: {
        type: 'list',
        value: { type: 'compound', value: sections }
      }
    }
  }
}

function section (names, extra = {}) {
  return {
    Y: { type: 'byte', value: 0 },
    block_states: {
      type: 'compound',
      value: {
        palette: {
          type: 'list',
          value: {
            type: 'compound',
            value: names.map(name => ({
              Name: { type: 'string', value: name },
              Properties: {
                type: 'compound',
                value: { axis: { type: 'string', value: 'y' } }
              }
            }))
          }
        }
      }
    },
    ...extra
  }
}

const reader = () => new Reader(__dirname, '1.21.4')
const palette = tag =>
  tag.value.sections.value.value[0].block_states.value.palette.value.value
    .map(e => e.Name.value)

test('a block this version knows is left alone', () => {
  const tag = chunkTag([section(['minecraft:stone', 'minecraft:oak_log'])])
  const r = reader()
  r.prepare(tag)
  assert.deepStrictEqual(palette(tag), ['minecraft:stone', 'minecraft:oak_log'])
  assert.strictEqual(r.report().length, 0)
})

test('a renamed block falls back to its older equivalent', () => {
  const tag = chunkTag([section(['minecraft:iron_chain'])])
  const r = reader()
  r.prepare(tag)
  assert.deepStrictEqual(palette(tag), ['minecraft:chain'])
  assert.deepStrictEqual(r.report(), [
    { name: 'minecraft:iron_chain', chunks: 1, replacedWith: 'minecraft:chain' }
  ])
})

test('an unknown block becomes air, and loses properties that would not resolve', () => {
  const tag = chunkTag([section(['minecraft:sculk_flanged_widget'])])
  const r = reader()
  r.prepare(tag)
  assert.deepStrictEqual(palette(tag), ['minecraft:air'])
  assert.strictEqual(
    tag.value.sections.value.value[0].block_states.value.palette.value.value[0]
      .Properties, undefined)
  assert.strictEqual(r.report()[0].replacedWith, 'minecraft:air')
})

test('a caller can override what an unknown block turns into', () => {
  const tag = chunkTag([section(['minecraft:iron_chain'])])
  const r = new Reader(__dirname, '1.21.4',
    { aliases: { 'minecraft:iron_chain': ['minecraft:iron_bars'] } })
  r.prepare(tag)
  assert.deepStrictEqual(palette(tag), ['minecraft:iron_bars'])
})

test('a light-only section is dropped rather than crashing the column', () => {
  const lightOnly = { Y: { type: 'byte', value: 5 }, SkyLight: { type: 'byteArray', value: [] } }
  const tag = chunkTag([section(['minecraft:stone']), lightOnly])
  const r = reader()
  r.prepare(tag)
  assert.strictEqual(tag.value.sections.value.value.length, 1)
  assert.strictEqual(r.lightOnlySections, 1)
})

test('a section with blocks but no biomes keeps its blocks', () => {
  const tag = chunkTag([section(['minecraft:stone'])])
  reader().prepare(tag)
  const only = tag.value.sections.value.value[0]
  assert.strictEqual(only.biomes.value.palette.value.value[0], 'minecraft:plains')
})

test('the fields the provider assumes exist are filled in', () => {
  const tag = chunkTag([section(['minecraft:stone'])])
  reader().prepare(tag)
  assert.ok(tag.value.block_entities)
  assert.strictEqual(tag.value.LastUpdate.value, 0)
})

test('a save newer than the viewer renders as the newest version available', () => {
  const { version, note } = versions.resolve(VIEWER, 4786, null) // 26.1
  assert.strictEqual(version, '1.21.4')
  assert.match(note, /newest version the viewer can render/)
})

test('a save the viewer covers exactly renders as itself, with nothing to report', () => {
  const { version, note } = versions.resolve(VIEWER, versions.dataVersion('1.21.4'), null)
  assert.strictEqual(version, '1.21.4')
  assert.strictEqual(note, null)
})

test('an older save renders as a version no newer than itself', () => {
  const { version } = versions.resolve(VIEWER, versions.dataVersion('1.17.1'), null)
  assert.strictEqual(version, '1.17.1')
})

test('asking for a version the viewer cannot draw says so', () => {
  assert.throws(() => versions.resolve(VIEWER, 4786, '26.1'), /cannot render as 26\.1/)
})

test('worlds below y=0 are only claimed for versions that have them', () => {
  assert.deepStrictEqual(versions.worldBounds('1.21.4'), { minY: -64, worldHeight: 384 })
  assert.deepStrictEqual(versions.worldBounds('1.16.4'), { minY: 0, worldHeight: 256 })
})

test('the data allow list names files, not whole version directories', () => {
  const allow = dataAllowList('1.21.4')
  assert.ok(allow.includes('/data/pc/1.21.4/blocks.json'))
  // 1.21.4 inherits only two loot tables from 1.20; taking the whole directory
  // would drag in another copy of blocks.json and blockCollisionShapes.json.
  assert.ok(allow.includes('/data/pc/1.20/blockLoot.json'))
  assert.ok(!allow.includes('/data/pc/1.20/'))
  assert.ok(allow.includes('/data/pc/1.16.2/tints.json'))
})

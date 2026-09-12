'use strict'

/**
 * Cutting areas out of a world save and writing them as schematics.
 *
 * The site never reads region files: a browser would have to pull whole chunk
 * columns (and a save layout prismarine-provider-anvil cannot always find) to
 * show one building. A Sponge schematic of just the area is a few kilobytes,
 * loads with one fetch, and prismarine-schematic already knows how to paste it
 * into an all-air world for the renderer.
 *
 * prismarine-schematic ships `Schematic.copy`, which does the same job — but it
 * awaits `world.getBlockStateId` once per block, so a 200k-block area takes
 * minutes. Reading the columns directly and building the palette with a Map
 * does the same area in about a tenth of a second, which is the only reason
 * this walks the blocks itself.
 */

const fs = require('fs')
const path = require('path')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
const { Reader } = require('./reader')

/** How many blocks one area may span before this is the wrong tool. */
const DEFAULT_MAX_BLOCKS = 8_000_000

/** Chunks `auto` will open looking for content before giving up. */
const DEFAULT_SCAN_LIMIT = 4096

/** Sorts a pair of corners into inclusive min/max, and clamps y to the world. */
function normalise (from, to, reader) {
  const min = [0, 1, 2].map(i => Math.min(from[i], to[i]))
  const max = [0, 1, 2].map(i => Math.max(from[i], to[i]))
  if (reader.minY !== null) {
    const floor = reader.minY
    const ceiling = reader.minY + reader.worldHeight - 1
    min[1] = Math.max(min[1], floor)
    max[1] = Math.min(max[1], ceiling)
    if (min[1] > max[1]) {
      throw new Error(`that area's y range falls outside the world ` +
        `(${floor} to ${ceiling})`)
    }
  }
  return { min, max }
}

/** Shrinks a box to the blocks that are actually there, then pads it back out. */
async function trimToContent (reader, min, max, pad) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let y = min[1]; y <= max[1]; y++) {
    for (let z = min[2]; z <= max[2]; z++) {
      for (let x = min[0]; x <= max[0]; x++) {
        if (reader.isAir(await reader.stateId(x, y, z))) continue
        if (x < lo[0]) lo[0] = x
        if (y < lo[1]) lo[1] = y
        if (z < lo[2]) lo[2] = z
        if (x > hi[0]) hi[0] = x
        if (y > hi[1]) hi[1] = y
        if (z > hi[2]) hi[2] = z
      }
    }
  }
  if (lo[0] === Infinity) return null // nothing but air in there
  return {
    min: lo.map((v, i) => Math.max(min[i], v - pad)),
    max: hi.map((v, i) => Math.min(max[i], v + pad))
  }
}

/**
 * Writes one area to `<outDir>/<id>.schem`.
 *
 * Returns the manifest entry the site needs: where the area sits in the world
 * and how big it is, so the page can centre a camera on it without parsing the
 * schematic first.
 */
async function extractArea (reader, area, opts) {
  const { pad = 1, trim = true, maxBlocks = DEFAULT_MAX_BLOCKS, outDir } = opts

  // A first block read settles the world's y bounds before the box is clamped.
  await reader.stateId(area.from[0], area.from[1], area.from[2])
  let box = normalise(area.from, area.to, reader)

  const span = (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) *
    (box.max[2] - box.min[2] + 1)
  if (span > maxBlocks) {
    throw new Error(`area "${area.id}" spans ${span.toLocaleString()} blocks, ` +
      `over the ${maxBlocks.toLocaleString()} limit. Narrow it, or raise ` +
      '--max-blocks if you are sure the browser can hold it.')
  }

  if (trim) {
    const trimmed = await trimToContent(reader, box.min, box.max, pad)
    if (!trimmed) return null
    box = trimmed
  }

  const [w, h, l] = [0, 1, 2].map(i => box.max[i] - box.min[i] + 1)
  const palette = []
  const index = new Map()
  const blocks = new Array(w * h * l)
  let solid = 0
  let at = 0

  // Sponge stores blocks in YZX order; matching it here keeps the write cheap.
  for (let y = box.min[1]; y <= box.max[1]; y++) {
    for (let z = box.min[2]; z <= box.max[2]; z++) {
      for (let x = box.min[0]; x <= box.max[0]; x++) {
        const stateId = await reader.stateId(x, y, z)
        if (!reader.isAir(stateId)) solid++
        let id = index.get(stateId)
        if (id === undefined) {
          id = palette.length
          palette.push(stateId)
          index.set(stateId, id)
        }
        blocks[at++] = id
      }
    }
  }

  const schem = new Schematic(reader.version, new Vec3(w, h, l),
    new Vec3(0, 0, 0), palette, blocks)
  const file = path.join(outDir, `${area.id}.schem`)
  fs.writeFileSync(file, await schem.write())

  return {
    id: area.id,
    label: area.label || titleCase(area.id),
    blurb: area.blurb || '',
    origin: box.min,
    size: [w, h, l],
    solid,
    palette: palette.length,
    bytes: fs.statSync(file).size
  }
}

/**
 * Finds where the world's content is, for when no areas were configured.
 *
 * Chunk sections carry a solid block count, so whole 16-block slabs of sky and
 * stone-free void are ruled out without looking at a single block. Only the
 * sections that survive get scanned properly.
 */
async function autoArea (reader, save, dimension, opts = {}) {
  const scanLimit = opts.scanLimit || DEFAULT_SCAN_LIMIT
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let scanned = 0

  for (const region of save.regions(dimension)) {
    for (let lz = 0; lz < 32; lz++) {
      for (let lx = 0; lx < 32; lx++) {
        if (scanned >= scanLimit) {
          throw new Error(`gave up after opening ${scanLimit} chunks looking ` +
            'for content. This world is too big to guess at — name the areas ' +
            'you want with --area, or point --radius at a spot worth showing.')
        }
        const cx = region.rx * 32 + lx
        const cz = region.rz * 32 + lz
        const column = await reader.column(cx, cz)
        if (!column) continue
        scanned++

        const sections = column.sections || []
        for (let i = 0; i < sections.length; i++) {
          const section = sections[i]
          if (!section || !section.solidBlockCount) continue
          const y0 = (column.minY === undefined ? 0 : column.minY) + i * 16
          if (cx * 16 < lo[0]) lo[0] = cx * 16
          if (cz * 16 < lo[2]) lo[2] = cz * 16
          if (y0 < lo[1]) lo[1] = y0
          if (cx * 16 + 15 > hi[0]) hi[0] = cx * 16 + 15
          if (cz * 16 + 15 > hi[2]) hi[2] = cz * 16 + 15
          if (y0 + 15 > hi[1]) hi[1] = y0 + 15
        }
      }
    }
  }

  if (lo[0] === Infinity) throw new Error('this world has no blocks in it')
  return { id: 'world', from: lo, to: hi }
}

function titleCase (id) {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Extracts every area into `outDir`, returning the manifest entries in order.
 * Areas that turn out to be empty are dropped with a note rather than shipped
 * as an empty viewer tab.
 */
async function extractAll (save, opts) {
  const { dimension = 'overworld', version, areas, outDir, log = () => {} } = opts
  fs.mkdirSync(outDir, { recursive: true })
  const reader = new Reader(save.regionDir(dimension), version,
    { aliases: opts.aliases })

  let wanted = areas
  if (!wanted || wanted.length === 0) {
    log('no areas given; looking for where the world has content…')
    wanted = [await autoArea(reader, save, dimension, opts)]
    const [f, t] = [wanted[0].from, wanted[0].to]
    log(`  found content from ${f.join(', ')} to ${t.join(', ')}`)
    reader.forget()
  }

  const manifest = []
  for (const area of wanted) {
    const entry = await extractArea(reader, area, { ...opts, outDir })
    reader.forget()
    if (!entry) {
      log(`  ${area.id}: nothing but air, skipped`)
      continue
    }
    log(`  ${entry.id.padEnd(12)} ${entry.size.join('x').padEnd(14)} ` +
      `${entry.solid.toLocaleString().padStart(9)} blocks  ` +
      `${(entry.bytes / 1024).toFixed(1)} KB`)
    manifest.push(entry)
  }
  if (manifest.length === 0) throw new Error('every area came out empty')

  const substitutions = reader.report()
  await reader.close()
  return { areas: manifest, substitutions }
}

module.exports = { extractAll, extractArea, autoArea, DEFAULT_MAX_BLOCKS }

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

/** How many blocks one area may be searched through before that is absurd. */
const DEFAULT_MAX_SCAN = 60_000_000

/** Chunks the area search will open before giving up. */
const DEFAULT_SCAN_LIMIT = 20000

/** Region files the area search will look through before giving up. */
const DEFAULT_MAX_REGIONS = 16

/** Blocks in a box, inclusive of both corners. */
const volume = box =>
  (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) *
  (box.max[2] - box.min[2] + 1)

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
  const {
    pad = 1, trim = true, outDir,
    maxBlocks = DEFAULT_MAX_BLOCKS, maxScan = DEFAULT_MAX_SCAN
  } = opts

  // A first block read settles the world's y bounds before the box is clamped.
  await reader.stateId(area.from[0], area.from[1], area.from[2])
  let box = normalise(area.from, area.to, reader)

  // Two different limits. Searching a box costs time, and a generous box is
  // the point — you bracket a build roughly and let the trim find its edges.
  // Shipping one costs the browser memory, and that is judged on what is left
  // after trimming, not on how wide you cast the net.
  if (volume(box) > maxScan) {
    throw new Error(`area "${area.id}" is ${volume(box).toLocaleString()} ` +
      `blocks to search through, over the ${maxScan.toLocaleString()} limit. ` +
      'Give it tighter corners.')
  }

  if (trim) {
    const trimmed = await trimToContent(reader, box.min, box.max, pad)
    if (!trimmed) return null
    box = trimmed
  }

  if (volume(box) > maxBlocks) {
    throw new Error(`area "${area.id}" holds ${volume(box).toLocaleString()} ` +
      `blocks, over the ${maxBlocks.toLocaleString()} limit. Narrow it, or ` +
      'raise --max-blocks if you are sure the browser can hold it.')
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
 * Finds what is worth showing, for when no areas were configured.
 *
 * A single box around everything is nearly useless on the sort of map this
 * tool is for: separate set-pieces hundreds of blocks apart would come out as
 * one area that is mostly empty sky. So populated chunks are grouped into
 * clusters — anything within `gap` chunks of another populated chunk joins it —
 * and each cluster becomes its own area, biggest first.
 *
 * Chunk sections carry a solid block count, so this never looks at a block:
 * the y range and the "is this worth keeping" judgement both come from the
 * section headers.
 */
async function findAreas (reader, save, dimension, opts = {}) {
  const scanLimit = opts.scanLimit || DEFAULT_SCAN_LIMIT
  const maxRegions = opts.maxRegions || DEFAULT_MAX_REGIONS
  const gap = opts.gap === undefined ? 4 : opts.gap
  const maxAreas = opts.maxAreas || 12
  const minBlocks = opts.minBlocks === undefined ? 200 : opts.minBlocks

  const regions = save.regions(dimension)
  if (regions.length > maxRegions) {
    throw new Error(`this world has ${regions.length} region files, too much ` +
      'to search through for interesting bits. Name the areas you want with ' +
      '--area, or point --radius at a spot worth showing.')
  }

  /** Populated chunks, as "cx,cz" -> { cx, cz, minY, maxY, solid }. */
  const populated = new Map()
  let scanned = 0

  for (const region of regions) {
    for (let lz = 0; lz < 32; lz++) {
      for (let lx = 0; lx < 32; lx++) {
        if (scanned >= scanLimit) {
          throw new Error(`gave up after opening ${scanLimit} chunks looking ` +
            'for content. Name the areas you want with --area, or point ' +
            '--radius at a spot worth showing.')
        }
        const cx = region.rx * 32 + lx
        const cz = region.rz * 32 + lz
        const column = await reader.column(cx, cz)
        if (!column) continue
        scanned++

        const floor = column.minY === undefined ? 0 : column.minY
        let minY = Infinity
        let maxY = -Infinity
        let solid = 0
        const sections = column.sections || []
        for (let i = 0; i < sections.length; i++) {
          const section = sections[i]
          if (!section || !section.solidBlockCount) continue
          solid += section.solidBlockCount
          minY = Math.min(minY, floor + i * 16)
          maxY = Math.max(maxY, floor + i * 16 + 15)
        }
        if (solid > 0) populated.set(`${cx},${cz}`, { cx, cz, minY, maxY, solid })
      }
    }
    // Columns are held to answer the scan; the extraction that follows will
    // read them again, and holding a whole world of them is what runs a
    // machine out of memory.
    reader.forget()
  }

  if (populated.size === 0) throw new Error('this world has no blocks in it')

  const clusters = cluster(populated, gap)
    .filter(c => c.solid >= minBlocks)
    .sort((a, b) => b.solid - a.solid)
    .slice(0, maxAreas)

  if (clusters.length === 0) {
    throw new Error(`nothing in this world is bigger than ${minBlocks} blocks; ` +
      'name an area with --area if there is something small worth seeing')
  }

  const single = clusters.length === 1
  return clusters.map((c, i) => ({
    id: single ? 'world' : `area-${i + 1}`,
    from: [c.minX * 16, c.minY, c.minZ * 16],
    to: [c.maxX * 16 + 15, c.maxY, c.maxZ * 16 + 15]
  }))
}

/** Flood-fills populated chunks into groups, joining any within `gap` chunks. */
function cluster (populated, gap) {
  const seen = new Set()
  const groups = []

  for (const key of populated.keys()) {
    if (seen.has(key)) continue
    seen.add(key)

    const group = {
      minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
      minY: Infinity, maxY: -Infinity, solid: 0
    }
    const queue = [key]
    while (queue.length) {
      const chunk = populated.get(queue.pop())
      group.minX = Math.min(group.minX, chunk.cx)
      group.maxX = Math.max(group.maxX, chunk.cx)
      group.minZ = Math.min(group.minZ, chunk.cz)
      group.maxZ = Math.max(group.maxZ, chunk.cz)
      group.minY = Math.min(group.minY, chunk.minY)
      group.maxY = Math.max(group.maxY, chunk.maxY)
      group.solid += chunk.solid

      for (let dx = -gap; dx <= gap; dx++) {
        for (let dz = -gap; dz <= gap; dz++) {
          const near = `${chunk.cx + dx},${chunk.cz + dz}`
          if (!populated.has(near) || seen.has(near)) continue
          seen.add(near)
          queue.push(near)
        }
      }
    }
    groups.push(group)
  }
  return groups
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
    log('no areas given; looking for what this world has in it…')
    wanted = await findAreas(reader, save, dimension, opts)
    log(`  found ${wanted.length} area${wanted.length === 1 ? '' : 's'}; ` +
      'put them in mcmap.json to name and describe them')
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

module.exports = { extractAll, extractArea, findAreas, cluster, DEFAULT_MAX_BLOCKS }

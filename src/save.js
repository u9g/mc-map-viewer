'use strict'

/**
 * Finding your way around a world save.
 *
 * prismarine-provider-anvil reads region files given a region directory, and
 * that is all it wants to know — so the job here is turning "a map" as a person
 * means it (a save folder, or the zip they downloaded) into that directory,
 * plus the odds and ends from level.dat that make for sensible defaults.
 *
 * Two save layouts are in play. Up to 1.21 the overworld's regions sit in
 * `region/` at the top of the save; newer versions moved them to
 * `dimensions/minecraft/overworld/region/`. Both are checked.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const nbt = require('prismarine-nbt')
const AdmZip = require('adm-zip')

/** Region directories per dimension, oldest layout first. */
const DIMENSIONS = {
  overworld: ['region', 'dimensions/minecraft/overworld/region'],
  nether: ['DIM-1/region', 'dimensions/minecraft/the_nether/region'],
  end: ['DIM1/region', 'dimensions/minecraft/the_end/region']
}

class Save {
  constructor (root, level) {
    this.root = root
    this.level = level
  }

  get dataVersion () {
    return this.level && this.level.DataVersion !== undefined
      ? this.level.DataVersion
      : null
  }

  get name () {
    return (this.level && this.level.LevelName) || path.basename(this.root)
  }

  /** World spawn, the default place to point a camera when nothing else says. */
  get spawn () {
    if (!this.level || this.level.SpawnX === undefined) return null
    return {
      x: this.level.SpawnX,
      y: this.level.SpawnY === undefined ? 64 : this.level.SpawnY,
      z: this.level.SpawnZ === undefined ? 0 : this.level.SpawnZ
    }
  }

  /** Directory holding `r.x.z.mca` for a dimension. Throws if there is none. */
  regionDir (dimension = 'overworld') {
    const candidates = DIMENSIONS[dimension]
    if (!candidates) {
      throw new Error(`unknown dimension "${dimension}" ` +
        `(expected one of ${Object.keys(DIMENSIONS).join(', ')})`)
    }

    const found = candidates
      .map(rel => path.join(this.root, rel))
      .find(dir => fs.existsSync(dir) && fs.readdirSync(dir).some(isRegion))
    if (!found) {
      throw new Error(`found no ${dimension} region files in ${this.root} ` +
        `(looked for ${candidates.join(' and ')})`)
    }
    return found
  }

  /** Which chunks exist, as region coordinates, for an early bounds estimate. */
  regions (dimension = 'overworld') {
    const dir = this.regionDir(dimension)
    return fs.readdirSync(dir)
      .map(name => /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name))
      .filter(Boolean)
      .map(m => ({ rx: +m[1], rz: +m[2], file: path.join(dir, m[0]) }))
  }
}

const isRegion = name => /^r\.-?\d+\.-?\d+\.mca$/.test(name)

/**
 * Opens a save from a directory or a `.zip` of one. Zips are unpacked into a
 * temp directory, whose path is returned as `tempDir` so a caller that cares
 * can clean it up.
 */
async function open (input) {
  if (!fs.existsSync(input)) throw new Error(`no such path: ${input}`)

  let root = input
  let tempDir = null
  if (fs.statSync(input).isFile()) {
    if (!input.toLowerCase().endsWith('.zip')) {
      throw new Error(`${input} is a file but not a .zip; point this at a ` +
        'world save folder or a zip of one')
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcmap-'))
    new AdmZip(input).extractAllTo(tempDir, true)
    root = tempDir
  }

  root = descend(root)
  const save = new Save(root, await readLevel(root))
  save.tempDir = tempDir
  return save
}

/**
 * A save folder has level.dat at its root, but a zip of one usually wraps it in
 * a directory named after the world. Walk down through single-child folders
 * until the save itself turns up.
 */
function descend (dir, depth = 0) {
  if (looksLikeSave(dir)) return dir
  if (depth >= 3) {
    throw new Error(`${dir} has no level.dat or region files; is it a world save?`)
  }
  const children = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(dir, e.name))
  const hit = children.find(looksLikeSave)
  if (hit) return hit
  if (children.length === 1) return descend(children[0], depth + 1)
  throw new Error(`${dir} has no level.dat or region files; is it a world save?`)
}

function looksLikeSave (dir) {
  if (fs.existsSync(path.join(dir, 'level.dat'))) return true
  return Object.values(DIMENSIONS).flat().some(rel => {
    const p = path.join(dir, rel)
    return fs.existsSync(p) && fs.readdirSync(p).some(isRegion)
  })
}

/**
 * level.dat's `Data` compound, or null if it is missing or unreadable.
 *
 * nbt.parse rather than parseUncompressed even though level.dat is gzipped:
 * parseUncompressed wants the NBT flavour named up front and rejects recent
 * level.dat files outright, while parse sniffs both the compression and the
 * flavour. Everything read here is a default, so a save that will not parse
 * costs the caller a spawn point, not the build.
 */
async function readLevel (root) {
  const file = path.join(root, 'level.dat')
  if (!fs.existsSync(file)) return null
  try {
    const { parsed } = await nbt.parse(fs.readFileSync(file))
    const simple = nbt.simplify(parsed)
    return simple.Data === undefined ? simple : simple.Data
  } catch {
    return null
  }
}

module.exports = { open, Save, DIMENSIONS }

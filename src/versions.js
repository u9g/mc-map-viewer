'use strict'

/**
 * Picking a Minecraft version to render as.
 *
 * A save records the version that wrote it (`DataVersion` in level.dat), but
 * prismarine-viewer only ships block models and a texture atlas for a handful
 * of versions. Those two facts rarely line up: a save from a version newer than
 * anything the viewer knows about is the normal case for anyone building on a
 * current server.
 *
 * Reading is more forgiving than rendering. The chunk format has changed twice
 * in ten years, so a recent save parses fine as the newest version the
 * libraries do support — the blocks that differ are the handful added since,
 * which the renderer could not draw anyway. So: pick the newest renderable
 * version that is no newer than the save, and say so when that means rendering
 * a save as something older than it is.
 */

const fs = require('fs')
const path = require('path')
const md = require('minecraft-data')

/** Versions the viewer has render assets for, newest last. */
function renderable (viewerDir) {
  const dir = path.join(viewerDir, 'public', 'blocksStates')
  if (!fs.existsSync(dir)) {
    throw new Error(`no blocksStates/ under ${viewerDir}; that does not look ` +
      'like a prismarine-viewer checkout')
  }
  const versions = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .filter(v => dataVersion(v) !== null)
  return versions.sort((a, b) => dataVersion(a) - dataVersion(b))
}

/** The DataVersion of a Minecraft version string, or null if unknown here. */
function dataVersion (version) {
  const entry = md.versions.pc.find(v => v.minecraftVersion === version)
  return entry && entry.dataVersion !== undefined ? entry.dataVersion : null
}

/** Can prismarine-chunk actually parse chunks as this version? */
function readable (version) {
  try {
    require('prismarine-chunk')(version)
    return true
  } catch {
    return false
  }
}

/**
 * Chooses the version to extract and render at.
 *
 * Returns `{ version, note }`, where `note` is a sentence worth printing when
 * the choice is not the save's own version.
 */
function resolve (viewerDir, saveDataVersion, requested) {
  const available = renderable(viewerDir).filter(readable)
  if (available.length === 0) {
    throw new Error('the viewer ships render assets, but prismarine-chunk can ' +
      'parse none of those versions; check your dependency versions')
  }

  if (requested) {
    if (!available.includes(requested)) {
      throw new Error(`cannot render as ${requested}; this viewer supports ` +
        available.join(', '))
    }
    return { version: requested, note: null }
  }

  if (saveDataVersion === null) {
    const version = available[available.length - 1]
    return {
      version,
      note: `level.dat gave no DataVersion, so rendering as ${version}; ` +
        'pass --version if that is wrong'
    }
  }

  const fits = available.filter(v => dataVersion(v) <= saveDataVersion)
  if (fits.length === 0) {
    const version = available[0]
    return {
      version,
      note: `this save predates every version the viewer can render, so it is ` +
        `being rendered as ${version}`
    }
  }

  const version = fits[fits.length - 1]
  const exact = dataVersion(version) === saveDataVersion
  return {
    version,
    note: exact
      ? null
      : `the save is DataVersion ${saveDataVersion}; the newest version the ` +
        `viewer can render is ${version}, so blocks added since will be ` +
        'missing or drawn wrong'
  }
}

/** Chunk-shape options for a version, or null where the version predates them. */
function worldBounds (version) {
  const dv = dataVersion(version)
  // 1.18 (DataVersion 2825) is where the world grew below y=0.
  return dv !== null && dv >= 2825
    ? { minY: -64, worldHeight: 384 }
    : { minY: 0, worldHeight: 256 }
}

module.exports = { renderable, readable, dataVersion, resolve, worldBounds }

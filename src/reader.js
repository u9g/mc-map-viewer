'use strict'

/**
 * Reading chunks as a version that is not quite the save's own.
 *
 * prismarine-provider-anvil does the actual work; this is the layer that makes
 * it survive a save newer than the renderer. prismarine-block throws on the
 * first block name it does not recognise, and because a chunk is parsed whole,
 * one unknown name loses all 98,304 blocks in that column — a 26.x world with
 * `minecraft:iron_chain` in it reads back as empty sky rather than as a build
 * with some chains missing.
 *
 * So the chunk's palette is checked against the target registry before
 * prismarine-chunk sees it. Names that version knows pass straight through;
 * names it does not are swapped for a stand-in, and every substitution is
 * counted so the build can say plainly what it dropped.
 */

const { Anvil } = require('prismarine-provider-anvil')
const { Vec3 } = require('vec3')
const registryFor = require('prismarine-registry')

/**
 * Blocks added or renamed after the versions prismarine-viewer can draw,
 * pointed at the nearest older block that looks like them.
 *
 * Kept deliberately short: a wrong guess here is a lie about what is in
 * someone's world. Everything not listed becomes air and is reported.
 * 26.x renamed `chain` to `iron_chain` when it added the copper variants.
 */
const ALIASES = {
  'minecraft:iron_chain': ['minecraft:chain'],
  'minecraft:copper_chain': ['minecraft:chain'],
  'minecraft:exposed_copper_chain': ['minecraft:chain'],
  'minecraft:weathered_copper_chain': ['minecraft:chain'],
  'minecraft:oxidized_copper_chain': ['minecraft:chain'],
  'minecraft:waxed_copper_chain': ['minecraft:chain'],
  'minecraft:waxed_exposed_copper_chain': ['minecraft:chain'],
  'minecraft:waxed_weathered_copper_chain': ['minecraft:chain'],
  'minecraft:waxed_oxidized_copper_chain': ['minecraft:chain']
}

const AIR = 'minecraft:air'
const bare = name => name.replace(/^minecraft:/, '')

/**
 * A one-entry biome palette, for sections that have blocks but no biomes.
 * Nothing here renders biome tints from the save, so which biome it claims
 * only has to be a name the registry knows.
 */
const plainsBiome = () => ({
  type: 'compound',
  value: {
    palette: {
      type: 'list',
      value: { type: 'string', value: ['minecraft:plains'] }
    }
  }
})

/** An empty tag of a given type, for the fields the provider assumes exist. */
const emptyList = () => ({ type: 'list', value: { type: 'end', value: [] } })
const long = value => ({ type: 'long', value })

class Reader {
  /**
   * @param {string} regionDir directory holding r.x.z.mca
   * @param {string} version Minecraft version to read (and render) as
   * @param {object} [opts] `aliases` adds to the built-in substitutions
   */
  constructor (regionDir, version, opts = {}) {
    this.version = version
    this.provider = new (Anvil(version))(regionDir)
    this.toChunk = require('prismarine-provider-anvil/src/chunk')(version)
      .nbtChunkToPrismarineChunk
    this.registry = registryFor(version)
    this.aliases = { ...ALIASES, ...(opts.aliases || {}) }

    /** name -> how many chunk palettes it was substituted out of. */
    this.substituted = new Map()
    /** name -> what it was replaced with, for reporting. */
    this.replacements = new Map()
    /** Light-only sections dropped so the provider does not trip over them. */
    this.lightOnlySections = 0

    this.air = new Set([0])
    for (const name of ['air', 'cave_air', 'void_air']) {
      const block = this.registry.blocksByName[name]
      if (block) this.air.add(block.defaultState)
    }

    this.columns = new Map()
    this.cursor = new Vec3(0, 0, 0)
    this.minY = null
    this.worldHeight = null
  }

  known (name) {
    return this.registry.blocksByName[bare(name)] !== undefined
  }

  /** What to draw in place of a block this version does not have. */
  substitute (name) {
    for (const candidate of this.aliases[name] || []) {
      if (this.known(candidate)) return candidate
    }
    return AIR
  }

  /**
   * Makes a raw chunk tag safe for prismarine-provider-anvil to parse.
   *
   * Two things are fixed, both in place:
   *
   * 1. Sections carrying only light data. A vanilla save writes a `SkyLight`
   *    section with no `block_states` for the lit air above a build, and the
   *    provider's 1.18 reader walks straight into it. They hold no blocks, so
   *    they are dropped; a section missing only its biome palette gets a
   *    stand-in instead, since dropping that one would lose real blocks.
   * 2. Block names this version does not have, which make prismarine-block
   *    throw and take all 98,304 blocks of the column with it.
   */
  prepare (raw) {
    const root = raw.value
    const list = root.sections?.value ?? root.Level?.value?.Sections?.value
    const sections = list?.value ?? []

    // The 1.18 reader reads these unconditionally; a save trimmed by a tool
    // that dropped them should not cost the whole column.
    if (root.sections !== undefined) {
      if (root.block_entities === undefined) root.block_entities = emptyList()
      if (root.LastUpdate === undefined) root.LastUpdate = long(0)
      if (root.InhabitedTime === undefined) root.InhabitedTime = long(0)
    }

    const keep = sections.filter(section =>
      section.block_states !== undefined || section.Palette !== undefined)
    if (keep.length !== sections.length && list) {
      this.lightOnlySections += sections.length - keep.length
      list.value = keep
    }

    for (const section of keep) {
      if (section.block_states !== undefined && section.biomes === undefined) {
        section.biomes = plainsBiome()
      }
      const palette = section.block_states?.value?.palette?.value?.value ??
        section.Palette?.value?.value ?? []
      for (const entry of palette) {
        const node = entry.Name
        if (!node || typeof node.value !== 'string') continue
        if (this.known(node.value)) continue

        const original = node.value
        const stand = this.substitute(original)
        node.value = stand
        // A substitute with different properties would not resolve either.
        if (stand === AIR && entry.Properties) delete entry.Properties
        this.substituted.set(original, (this.substituted.get(original) || 0) + 1)
        this.replacements.set(original, stand)
      }
    }
    return raw
  }

  async column (cx, cz) {
    const key = cx + ',' + cz
    if (!this.columns.has(key)) {
      const raw = await this.provider.loadRaw(cx, cz)
      const column = raw === null ? null : this.toChunk(this.prepare(raw))
      if (column && this.minY === null) {
        this.minY = column.minY === undefined ? 0 : column.minY
        this.worldHeight = column.worldHeight === undefined ? 256 : column.worldHeight
      }
      this.columns.set(key, column)
    }
    return this.columns.get(key)
  }

  /** Ungenerated chunks read as air, so an area may hang over the world's edge. */
  async stateId (x, y, z) {
    const column = await this.column(x >> 4, z >> 4)
    if (!column) return 0
    this.cursor.set(x & 15, y, z & 15)
    return column.getBlockStateId(this.cursor)
  }

  isAir (stateId) {
    return this.air.has(stateId)
  }

  /** Columns are the memory hog; drop them between areas. */
  forget () {
    this.columns.clear()
  }

  async close () {
    this.forget()
    await this.provider.close().catch(() => {})
  }

  /** What had to be faked, worst offenders first, for the build to report. */
  report () {
    return [...this.substituted.entries()]
      .map(([name, chunks]) => ({
        name, chunks, replacedWith: this.replacements.get(name)
      }))
      .sort((a, b) => b.chunks - a.chunks)
  }
}

module.exports = { Reader, ALIASES }

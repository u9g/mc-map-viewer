'use strict'

/**
 * One build: a world save in, a folder you can publish out.
 *
 * The steps are deliberately separate on disk. `schems/` and `config.json` are
 * the map; everything else in the output is the viewer, identical for every
 * map. That means a rebuild after moving an area only rewrites a few kilobytes,
 * and someone poking at the output can tell their data from the machinery.
 */

const fs = require('fs')
const path = require('path')
const save = require('./save')
const versions = require('./versions')
const { extractAll } = require('./extract')
const { bundle, resolveViewer } = require('./bundle')

const WORKFLOW = path.resolve(__dirname, '..', 'templates', 'pages.yml')

const DEFAULTS = {
  dimension: 'overworld',
  out: 'docs',
  pad: 1,
  trim: true,
  workflow: true,
  theme: { background: '#11131a', accent: '#4bc4a8' }
}

/**
 * Builds the site described by `config` (see README for the fields).
 * `log` is called with progress lines; `root` is what relative paths in the
 * config are relative to.
 */
async function build (config, { root = process.cwd(), log = () => {} } = {}) {
  const opts = { ...DEFAULTS, ...config, theme: { ...DEFAULTS.theme, ...config.theme } }
  if (!opts.world) throw new Error('no world given; set "world" or pass --world')

  const outDir = path.resolve(root, opts.out)
  const worldPath = path.resolve(root, opts.world)
  const viewerDir = resolveViewer(opts.viewer)

  const world = await save.open(worldPath)
  log(`world:   ${world.name}` +
    (world.dataVersion ? ` (DataVersion ${world.dataVersion})` : ''))

  const { version, note } = versions.resolve(viewerDir, world.dataVersion, opts.version)
  log(`version: rendering as ${version}`)
  if (note) log(`         note: ${note}`)

  // An area named by radius is the quickest way to point at one build.
  let areas = opts.areas
  if ((!areas || areas.length === 0) && opts.radius) {
    const centre = opts.centre || world.spawn
    if (!centre) {
      throw new Error('--radius needs a centre, and this save has no spawn ' +
        'point recorded; pass --centre x,y,z')
    }
    const r = opts.radius
    areas = [{
      id: 'spawn',
      from: [centre.x - r, -2032, centre.z - r],
      to: [centre.x + r, 2032, centre.z + r]
    }]
  }

  fs.mkdirSync(outDir, { recursive: true })
  log('areas:')
  const { areas: manifest, substitutions } = await extractAll(world, {
    dimension: opts.dimension,
    version,
    areas,
    aliases: opts.aliases,
    pad: opts.pad,
    trim: opts.trim,
    maxBlocks: opts.maxBlocks,
    maxScan: opts.maxScan,
    scanLimit: opts.scanLimit,
    outDir: path.join(outDir, 'schems'),
    log
  })

  if (substitutions.length) {
    log('blocks this version does not have:')
    for (const s of substitutions) {
      log(`  ${s.name} -> ${s.replacedWith} (${s.chunks} chunk` +
        `${s.chunks === 1 ? '' : 's'})`)
    }
  }

  const siteConfig = {
    title: opts.title || world.name,
    subtitle: opts.subtitle || '',
    description: opts.description || '',
    version,
    worldBounds: versions.worldBounds(version),
    theme: opts.theme,
    areas: manifest.map(a => ({
      id: a.id,
      label: a.label,
      blurb: a.blurb,
      origin: a.origin,
      size: a.size
    }))
  }
  fs.writeFileSync(path.join(outDir, 'config.json'),
    JSON.stringify(siteConfig, null, 2))

  log('bundling the viewer…')
  const built = await bundle({ version, outDir, viewerDir, config: siteConfig })
  log(`site:    ${(built.total / 1e6).toFixed(1)} MB in ${outDir}`)
  for (const f of built.files.slice(0, 3)) {
    log(`         ${f.file} ${(f.bytes / 1e6).toFixed(1)} MB`)
  }

  if (opts.workflow) writeWorkflow(root, opts.out, log)
  if (world.tempDir) fs.rmSync(world.tempDir, { recursive: true, force: true })

  return { outDir, version, areas: manifest, substitutions, size: built.total }
}

/**
 * Drops in a Pages workflow, so pushing the built folder publishes it.
 *
 * Never overwritten: by the time someone has a workflow of their own, it is
 * more likely to be right than this one.
 */
function writeWorkflow (root, outDir, log) {
  const dest = path.join(root, '.github', 'workflows', 'pages.yml')
  if (fs.existsSync(dest)) return
  const body = fs.readFileSync(WORKFLOW, 'utf8').replace(/{{OUT}}/g, outDir)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, body)
  log(`wrote    .github/workflows/pages.yml (publishes ${outDir}/ on push)`)
}

module.exports = { build, DEFAULTS }

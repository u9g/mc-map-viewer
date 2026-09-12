'use strict'

/**
 * Building the viewer bundle.
 *
 * A naive webpack build of prismarine-viewer is about 165 MB, which is not a
 * thing to put on GitHub Pages. Two things cause it, and both are fixed here:
 *
 *  - `minecraft-data`'s data.js has a static `require()` for every dataset of
 *    every Minecraft version, so webpack bundles all of them. Only the files
 *    the target version actually resolves to are kept. Which those are is not
 *    guesswork: minecraft-data ships `dataPaths.json` saying exactly which
 *    version each dataset is inherited from.
 *  - prismarine-viewer ships a prebuilt mesher worker covering every version,
 *    ~115 MB of it. Building the worker from source with the same filter
 *    replaces it.
 *
 * The result is a few MB, most of it one blockstates JSON that Pages gzips.
 */

const fs = require('fs')
const path = require('path')
const webpack = require('webpack')
const CopyPlugin = require('copy-webpack-plugin')

const SITE = path.resolve(__dirname, '..', 'site')

/**
 * The minecraft-data files a version resolves to, as path fragments.
 *
 * Every dataset a version uses is listed in dataPaths.json against the version
 * it is inherited from, so following it keeps exactly what will be asked for at
 * runtime and nothing else. Each entry names a dataset and a directory, and the
 * file is the dataset's own name — `blocks -> pc/1.21.4` means
 * `pc/1.21.4/blocks.json`.
 *
 * Allowing the whole directory instead would be simpler and roughly triples the
 * bundle: 1.21.4 inherits from seven older versions, and taking all of each one
 * drags in seven more copies of blocks.json and blockCollisionShapes.json for
 * the sake of two loot tables.
 */
function dataAllowList (version) {
  const paths = require('minecraft-data/minecraft-data/data/dataPaths.json')
  const entry = paths.pc[version]
  if (!entry) {
    throw new Error(`minecraft-data has no data paths for ${version}`)
  }

  const allow = new Set([
    '/data/pc/common/',
    '/data/bedrock/common/',
    '/data/dataPaths.json',
    // Not an inheritance path: prismarine-viewer's models.js hardcodes
    // require('minecraft-data')('1.16.2').tints at module load. Drop it and the
    // mesher worker dies on Object.keys(undefined), rendering nothing at all.
    '/data/pc/1.16.2/tints.json'
  ])
  for (const [dataset, dir] of Object.entries(entry)) {
    allow.add(`/data/${dir}/${dataset}.json`)
  }
  return [...allow]
}

/** Keeps minecraft-data JSON that this version can actually ask for. */
function trimMinecraftData (allow) {
  return ({ context, request }, cb) => {
    if (context && context.includes('minecraft-data') &&
        request && request.endsWith('.json')) {
      const normalised = request.replace(/\\/g, '/')
      if (!allow.some(a => normalised.includes(a))) return cb(null, [])
    }
    cb()
  }
}

/** index.html is a template so a shared link unfurls with the map's own name. */
function writeHtml (outDir, config) {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
    .replace(/{{TITLE}}/g, escapeHtml(config.title))
    .replace(/{{DESCRIPTION}}/g, escapeHtml(config.description || ''))
  fs.writeFileSync(path.join(outDir, 'index.html'), html)
}

const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/**
 * Where prismarine-viewer lives. An override lets a fork stand in — rendering
 * for a version newer than any published release only exists on a branch, and
 * that is exactly the case this tool is most useful for.
 */
function resolveViewer (override) {
  if (!override) {
    return path.dirname(require.resolve('prismarine-viewer/package.json'))
  }
  const dir = path.resolve(override)
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`--viewer ${override} has no package.json in it`)
  }
  return dir
}

function configFor (opts) {
  const { version, outDir, viewerDir } = opts
  const allow = dataAllowList(version)
  const externals = [trimMinecraftData(allow)]

  const shared = {
    mode: 'production',
    performance: { hints: false },
    externals,
    plugins: [
      new webpack.ProvidePlugin({ process: 'process/browser' }),
      new webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'] })
    ]
  }

  // A fork is resolved by path, so its own `require('prismarine-viewer/...')`
  // and the site's have to be pointed at the same copy.
  const alias = { 'prismarine-viewer': viewerDir }

  const assets = [
    { from: path.join(viewerDir, 'public/blocksStates', `${version}.json`),
      to: `blocksStates/${version}.json` },
    { from: path.join(viewerDir, 'public/textures', `${version}.png`),
      to: `textures/${version}.png` }
  ]
  // Some viewer builds fetch this at runtime for minY / worldHeight; published
  // releases do not ship it, so it is copied only when it is there.
  const bounds = path.join(viewerDir, 'public/worldBounds.json')
  if (fs.existsSync(bounds)) assets.push({ from: bounds, to: 'worldBounds.json' })

  const main = {
    ...shared,
    name: 'main',
    entry: path.join(SITE, 'index.js'),
    output: { path: outDir, filename: 'index.js' },
    resolve: {
      alias,
      fallback: {
        zlib: require.resolve('browserify-zlib'),
        stream: require.resolve('stream-browserify'),
        buffer: require.resolve('buffer/'),
        events: require.resolve('events/'),
        assert: require.resolve('assert/'),
        fs: false, path: false, net: false, tls: false, crypto: false,
        // node-canvas is pulled in at module load by entities.js (nametags) and
        // atlas.js (runtime atlas building). Neither runs here — the scene has
        // no entities and the atlas is prebuilt — so stub them rather than ship
        // a native module that could not work in a browser anyway.
        canvas: false,
        'node-canvas-webgl/lib': false
      }
    },
    plugins: [
      ...shared.plugins,
      new webpack.NormalModuleReplacementPlugin(
        /prismarine-viewer[/|\\]viewer[/|\\]lib[/|\\]utils/, './utils.web.js'
      ),
      new CopyPlugin({ patterns: assets })
    ]
  }

  // The mesher runs in a worker that worldrenderer.js loads from './worker.js'
  // at the site root. Building it here rather than copying the prebuilt
  // all-versions one is what takes the bundle from 115 MB to a few.
  const worker = {
    ...shared,
    name: 'worker',
    dependencies: ['main'],
    entry: path.join(viewerDir, 'viewer/lib/worker.js'),
    output: { path: outDir, filename: 'worker.js' },
    resolve: { alias, fallback: { zlib: false, fs: false, path: false, canvas: false } }
  }

  return [main, worker]
}

/** Runs webpack, resolving to a one-line size summary. */
function bundle (opts) {
  return new Promise((resolve, reject) => {
    webpack(configFor(opts), (err, stats) => {
      if (err) return reject(err)
      if (stats.hasErrors()) {
        return reject(new Error(stats.toString({ all: false, errors: true })))
      }
      writeHtml(opts.outDir, opts.config)
      // Pages runs Jekyll by default, which skips files starting with _.
      fs.writeFileSync(path.join(opts.outDir, '.nojekyll'), '')
      resolve(sizes(opts.outDir))
    })
  })
}

/** Total bytes written, and the largest few files, for the build to report. */
function sizes (dir) {
  const files = []
  const walk = at => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push({ file: path.relative(dir, full), bytes: fs.statSync(full).size })
    }
  }
  walk(dir)
  files.sort((a, b) => b.bytes - a.bytes)
  return { total: files.reduce((n, f) => n + f.bytes, 0), files }
}

module.exports = { bundle, configFor, resolveViewer, dataAllowList, sizes }

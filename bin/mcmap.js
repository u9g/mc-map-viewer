#!/usr/bin/env node
'use strict'

/**
 * mcmap — turn a Minecraft world save into a static map viewer.
 *
 * Everything is flags or a config file; the config file is just the flags
 * written down, so `mcmap init` produces one from what you passed and a
 * rebuild later needs no arguments at all.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')

const USAGE = `
mcmap — build a shareable, GitHub Pages ready viewer from a Minecraft world

  mcmap build [options]        extract the areas and build the site
  mcmap init  [options]        write an mcmap.json you can edit and re-run
  mcmap serve [options]        serve the built site locally

Options
  -c, --config <file>     config file to read (default: mcmap.json if present)
  -w, --world <path>      world save folder, or a .zip of one
  -o, --out <dir>         where to write the site (default: docs)
      --title <text>      page title (default: the world's name)
      --subtitle <text>   shown next to the title
      --description <text>  one line under the title, and in link previews
      --area <spec>       id=x1,y1,z1:x2,y2,z2 — repeatable
      --radius <n>        instead of --area: a box of this radius at the spawn
      --centre <x,y,z>    centre for --radius, if the save records no spawn
      --dimension <name>  overworld (default), nether or end
      --version <ver>     Minecraft version to render as (default: the newest
                          the viewer supports that is not newer than the save)
      --viewer <path>     a prismarine-viewer checkout to build against, for
                          rendering versions no published release covers
      --pad <n>           air blocks kept around a trimmed area (default: 1)
      --no-trim           keep the area exactly as given, air and all
      --max-blocks <n>    refuse an area larger than this (default: 8,000,000)
      --no-workflow       do not write .github/workflows/pages.yml
      --port <n>          port for serve (default: 8080)
  -h, --help              this

Examples
  mcmap build --world ./world --radius 128 --title "My Spawn"
  mcmap build --world save.zip --area spawn=-41,62,-41:41,92,41 \\
                               --area koth=287,63,-33:353,77,33
  mcmap serve
`.trim()

/** Flags that take no value. */
const BOOLEAN = new Set(['--no-trim', '--no-workflow', '-h', '--help'])

function parseArgs (argv) {
  const opts = { areas: [] }
  let command = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('-') && command === null) { command = arg; continue }

    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }

    switch (arg) {
      case '-h': case '--help': opts.help = true; break
      case '-c': case '--config': opts.config = value(); break
      case '-w': case '--world': opts.world = value(); break
      case '-o': case '--out': opts.out = value(); break
      case '--title': opts.title = value(); break
      case '--subtitle': opts.subtitle = value(); break
      case '--description': opts.description = value(); break
      case '--dimension': opts.dimension = value(); break
      case '--version': opts.version = value(); break
      case '--viewer': opts.viewer = value(); break
      case '--pad': opts.pad = Number(value()); break
      case '--max-blocks': opts.maxBlocks = Number(value()); break
      case '--radius': opts.radius = Number(value()); break
      case '--centre': case '--center': opts.centre = parsePoint(value()); break
      case '--port': opts.port = Number(value()); break
      case '--no-trim': opts.trim = false; break
      case '--no-workflow': opts.workflow = false; break
      case '--area': opts.areas.push(parseArea(value())); break
      default:
        if (BOOLEAN.has(arg) || arg.startsWith('-')) {
          throw new Error(`unknown option ${arg}`)
        }
        throw new Error(`unexpected argument ${arg}`)
    }
  }
  return { command: command || 'build', opts }
}

function parsePoint (text) {
  const parts = text.split(',').map(Number)
  if (parts.length !== 3 || parts.some(n => !isFinite(n))) {
    throw new Error(`expected x,y,z but got "${text}"`)
  }
  return { x: parts[0], y: parts[1], z: parts[2] }
}

/** `id=x1,y1,z1:x2,y2,z2`, or `id=x1,y1,z1:x2,y2,z2:Label` */
function parseArea (spec) {
  const eq = spec.indexOf('=')
  if (eq < 1) {
    throw new Error(`--area wants id=x1,y1,z1:x2,y2,z2 but got "${spec}"`)
  }
  const id = spec.slice(0, eq)
  const rest = spec.slice(eq + 1).split(':')
  if (rest.length < 2) {
    throw new Error(`--area ${id} needs two corners, separated by ":"`)
  }
  const from = parsePoint(rest[0])
  const to = parsePoint(rest[1])
  const area = { id, from: [from.x, from.y, from.z], to: [to.x, to.y, to.z] }
  if (rest[2]) area.label = rest[2]
  return area
}

/** CLI flags win over the config file, but an empty --area list defers to it. */
function merge (fileConfig, opts) {
  const merged = { ...fileConfig }
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) continue
    if (key === 'areas' && value.length === 0) continue
    if (key === 'config' || key === 'help' || key === 'port') continue
    merged[key] = value
  }
  // --radius asks for one box somewhere, which the config's own areas would
  // otherwise quietly win over — leaving the flag doing nothing at all.
  if (opts.radius !== undefined && opts.areas.length === 0) delete merged.areas
  return merged
}

function loadConfig (root, file) {
  const candidate = file ? path.resolve(root, file) : path.join(root, 'mcmap.json')
  if (!fs.existsSync(candidate)) {
    if (file) throw new Error(`no config file at ${candidate}`)
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(candidate, 'utf8'))
  } catch (e) {
    throw new Error(`${candidate} is not valid JSON: ${e.message}`)
  }
}

async function cmdBuild (root, config) {
  const { build } = require('../src/build')
  const started = Date.now()
  const result = await build(config, { root, log: line => console.log(line) })
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`\nPreview it with:  mcmap serve --out ${path.relative(root, result.outDir)}`)
  return result
}

/** Writes the config that a build would have used, for editing by hand. */
async function cmdInit (root, config, opts) {
  const dest = path.join(root, opts.config || 'mcmap.json')
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`)

  const starter = {
    title: config.title || 'My Minecraft map',
    description: config.description || '',
    world: config.world || './world',
    out: config.out || 'docs',
    areas: config.areas && config.areas.length
      ? config.areas
      : [{
          id: 'spawn',
          label: 'Spawn',
          blurb: 'What this area is.',
          from: [-64, -64, -64],
          to: [64, 320, 64]
        }]
  }
  fs.writeFileSync(dest, JSON.stringify(starter, null, 2) + '\n')
  console.log(`wrote ${path.relative(root, dest)} — edit the areas, then run: mcmap build`)
}

/** A static file server, only so the built site can be looked at before pushing. */
async function cmdServe (root, config, opts) {
  const dir = path.resolve(root, config.out || 'docs')
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error(`${dir} has no index.html in it; run mcmap build first`)
  }
  const port = opts.port || 8080
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.png': 'image/png', '.schem': 'application/octet-stream'
  }

  http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
    const file = path.join(dir, rel || 'index.html')
    // Without this, "/../../etc/passwd" would be served quite happily.
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('not found'); return }
      res.writeHead(200, {
        'content-type': types[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store'
      })
      res.end(body)
    })
  }).listen(port, () => {
    console.log(`serving ${dir} at http://localhost:${port}`)
  })
}

async function main () {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`mcmap: ${e.message}\n`)
    console.error(USAGE)
    process.exit(2)
  }

  const { command, opts } = parsed
  if (opts.help || command === 'help') { console.log(USAGE); return }

  const root = process.cwd()
  const config = merge(loadConfig(root, opts.config), opts)

  switch (command) {
    case 'build': await cmdBuild(root, config); break
    case 'init': await cmdInit(root, config, opts); break
    case 'serve': await cmdServe(root, config, opts); break
    default:
      console.error(`mcmap: no command called "${command}"\n`)
      console.error(USAGE)
      process.exit(2)
  }
}

main().catch(e => {
  console.error(`mcmap: ${e.message}`)
  if (process.env.MCMAP_DEBUG) console.error(e.stack)
  process.exit(1)
})

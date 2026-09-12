/* global fetch, location, history, navigator */

/**
 * The viewer page.
 *
 * Everything specific to a particular map lives in `config.json`, which the
 * build writes: the title, the areas, the version to render as. This file only
 * knows how to turn that into a page, so the same bundle serves any world.
 *
 * Areas are pasted into an otherwise empty world rather than streamed from the
 * save, which is what keeps a shareable link to a build a few kilobytes instead
 * of a chunk server.
 */

const { WorldView, Viewer, MapControls } = require('prismarine-viewer/viewer')
const { Vec3 } = require('vec3')
const { Schematic } = require('prismarine-schematic')
const { FlyControls } = require('./flycontrols')
global.THREE = require('three')
const THREE = global.THREE

const el = id => document.getElementById(id)

let config, renderer, viewer, controls, fly, worldView
let loadedColumns = []
let current = null
let mode = 'fly'
let lastFrame = 0
let restoring = null

function setStatus (text, busy) {
  const status = el('status')
  status.textContent = text
  status.classList.toggle('busy', !!busy)
}

function area (id) {
  return config.areas.find(a => a.id === id)
}

function hint () {
  if (mode === 'orbit') return 'drag to pan · scroll to zoom · right-drag to orbit'
  return fly && fly.locked
    ? 'WASD move · space/shift up-down · ctrl sprint · scroll speed · esc to release'
    : 'click the view to look around · WASD move · space/shift up-down'
}

function refreshHint () {
  if (current) setStatus(area(current).label + ' — ' + hint(), false)
}

function setMode (next) {
  mode = next
  controls.enabled = (mode === 'orbit')
  fly.setEnabled(mode === 'fly')
  if (mode === 'orbit') {
    // MapControls derives its position from a stored spherical around `target`,
    // so without re-anchoring, its first update() teleports the camera back to
    // wherever orbit was last used.
    const forward = viewer.camera.getWorldDirection(new THREE.Vector3())
    controls.target.copy(viewer.camera.position).addScaledVector(forward, 40)
    controls.update()
  }
  el('mode').textContent = mode === 'fly' ? 'Fly (WASD)' : 'Orbit'
  el('mode').classList.toggle('on', mode === 'fly')
  refreshHint()
}

/** A world of pure air, so only the pasted area is visible. */
function makeVoidWorld () {
  const World = require('prismarine-world')(config.version)
  const Chunk = require('prismarine-chunk')(config.version)
  const bounds = config.worldBounds
  return new World(() => new Chunk(bounds ? { ...bounds } : undefined))
}

/** Drop every column currently meshed, so areas don't stack up on switch. */
function clearWorld () {
  for (const [x, z] of loadedColumns) viewer.removeColumn(x, z)
  loadedColumns = []
}

async function loadArea (id, camera) {
  if (current === id && !camera) return
  const meta = area(id)
  if (!meta) throw new Error(`no area called "${id}"`)

  if (current !== id) {
    current = id
    for (const button of document.querySelectorAll('.area-btn')) {
      button.classList.toggle('active', button.dataset.area === id)
    }
    el('blurb').textContent = meta.blurb || config.description || ''
    setStatus('loading ' + meta.label + '…', true)

    const buffer = await fetch('schems/' + id + '.schem').then(r => r.arrayBuffer())
    const schem = await Schematic.read(Buffer.from(buffer), config.version)

    const [ox, oy, oz] = meta.origin
    const [w, h, l] = meta.size
    const world = makeVoidWorld()
    await schem.paste(world, new Vec3(ox, oy, oz))

    const centre = new Vec3(ox + w / 2, oy + h / 2, oz + l / 2)
    // Enough chunks to hold the whole area, plus a margin. Empty columns are
    // cheap to mesh, so erring large costs little.
    const viewDistance = Math.ceil(Math.max(w, l) / 32) + 2

    clearWorld()
    worldView = new WorldView(world, viewDistance, centre)
    worldView.on('loadChunk', ({ x, z }) => loadedColumns.push([x, z]))
    viewer.listen(worldView)
    await worldView.init(centre)
  }

  if (camera) placeCamera(camera)
  else frameArea(meta)
  await viewer.waitForChunksToRender()
  refreshHint()
  writeHash()
}

/** Park the camera so the whole area fits in view, facing its centre. */
function frameArea (meta) {
  const [ox, oy, oz] = meta.origin
  const [w, h, l] = meta.size
  const centre = new Vec3(ox + w / 2, oy + h / 2, oz + l / 2)
  const span = Math.max(w, h, l)
  const d = span * 0.62 + 16
  viewer.camera.position.set(centre.x + d * 0.7, centre.y + d * 0.6, centre.z + d * 0.7)
  controls.target.set(centre.x, centre.y, centre.z)
  controls.update()
  // Orbit just moved the camera; make the fly camera adopt the same heading so
  // switching modes (or resetting the view) never snaps the direction.
  fly.lookAt(centre)
  fly.speed = Math.max(12, Math.min(60, span * 0.35))
}

function placeCamera ({ pos, yaw, pitch }) {
  viewer.camera.position.set(pos[0], pos[1], pos[2])
  fly.yaw = yaw
  fly.pitch = pitch
  fly._apply()
  controls.target.copy(viewer.camera.position)
    .addScaledVector(viewer.camera.getWorldDirection(new THREE.Vector3()), 40)
  controls.update()
}

// ---------------------------------------------------------------- share links

const round = n => Math.round(n * 10) / 10

/**
 * The URL carries the area and the camera, so a link shows what the person who
 * sent it was looking at rather than dropping you at the default view.
 */
function writeHash () {
  if (!current) return
  const p = viewer.camera.position
  const hash = `#${current}@${round(p.x)},${round(p.y)},${round(p.z)}` +
    `,${round(fly.yaw)},${round(fly.pitch)}`
  history.replaceState(null, '', hash)
}

function readHash () {
  const raw = location.hash.replace(/^#/, '')
  if (!raw) return null
  const [id, camera] = raw.split('@')
  if (!camera) return { id }
  const parts = camera.split(',').map(Number)
  if (parts.length < 5 || parts.some(n => !isFinite(n))) return { id }
  return { id, camera: { pos: parts.slice(0, 3), yaw: parts[3], pitch: parts[4] } }
}

async function share () {
  writeHash()
  const button = el('share')
  try {
    await navigator.clipboard.writeText(location.href)
    button.textContent = 'Link copied'
  } catch {
    // Clipboard needs a secure context; the URL bar already holds the link.
    button.textContent = 'Link is in the URL bar'
  }
  setTimeout(() => { button.textContent = 'Copy link' }, 1800)
}

// ---------------------------------------------------------------------- setup

async function main () {
  config = await fetch('config.json').then(r => r.json())
  document.title = config.title
  el('title').textContent = config.title
  if (config.subtitle) el('subtitle').textContent = ' — ' + config.subtitle
  el('blurb').textContent = config.description || ''
  if (config.theme) {
    const root = document.documentElement.style
    if (config.theme.background) root.setProperty('--bg', config.theme.background)
    if (config.theme.accent) root.setProperty('--accent', config.theme.accent)
  }

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setSize(window.innerWidth, window.innerHeight)
  el('canvas-host').appendChild(renderer.domElement)

  viewer = new Viewer(renderer)
  if (!viewer.setVersion(config.version)) {
    setStatus('this viewer build cannot render ' + config.version, false)
    return
  }
  viewer.scene.background = new THREE.Color(
    (config.theme && config.theme.background) || '#11131a')

  controls = new MapControls(viewer.camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.1
  controls.maxDistance = 900

  fly = new FlyControls(viewer.camera, renderer.domElement)
  fly.onSpeedChange = () => refreshHint()
  document.addEventListener('pointerlockchange', refreshHint)
  el('mode').onclick = () => setMode(mode === 'fly' ? 'orbit' : 'fly')
  setMode('fly')

  const bar = el('areas')
  // One area needs no switcher; the buttons would just be a label.
  if (config.areas.length > 1) {
    for (const meta of config.areas) {
      const button = document.createElement('button')
      button.className = 'area-btn'
      button.dataset.area = meta.id
      button.textContent = meta.label
      button.onclick = () => loadArea(meta.id)
        .catch(e => setStatus('error: ' + e.message, false))
      bar.appendChild(button)
    }
  }

  el('fit').onclick = () => { frameArea(area(current)); writeHash() }
  el('share').onclick = () => share()

  window.addEventListener('resize', () => {
    viewer.camera.aspect = window.innerWidth / window.innerHeight
    viewer.camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  // Following the hash lets browser back/forward move between shared views.
  window.addEventListener('hashchange', () => {
    const wanted = readHash()
    if (!wanted || !area(wanted.id)) return
    if (wanted.id === current && !wanted.camera) return
    loadArea(wanted.id, wanted.camera).catch(() => {})
  })

  let sinceWrite = 0
  const animate = now => {
    window.requestAnimationFrame(animate)
    // Clamped so a backgrounded tab doesn't resume with one enormous step.
    const dt = Math.min((now - lastFrame) / 1000 || 0, 0.1)
    lastFrame = now
    if (mode === 'orbit') controls.update()
    else fly.update(dt)
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)

    // Keeping the URL current means copying it never needs a button press
    // first, but rewriting it every frame is wasted work.
    sinceWrite += dt
    if (sinceWrite > 0.5) { sinceWrite = 0; writeHash() }
  }
  window.requestAnimationFrame(animate)

  restoring = readHash()
  const start = restoring && area(restoring.id) ? restoring : { id: config.areas[0].id }
  await loadArea(start.id, start.camera)
}

// A hook for the headless checks, so they can assert on real camera state
// rather than guessing from pixels.
window.__mcmap = {
  ready: () => !!current,
  area: () => current,
  pos: () => viewer.camera.position.clone(),
  dir: () => viewer.camera.getWorldDirection(new THREE.Vector3()),
  mode: () => mode,
  speed: () => fly.speed,
  load: (id, camera) => loadArea(id, camera)
}

main().catch(e => {
  setStatus('failed: ' + e.message, false)
  console.error(e)
})

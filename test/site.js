'use strict'

/**
 * Loads a built site in headless Chrome and checks that it really draws.
 *
 * A viewer that throws in a worker still paints a clean background, so "the
 * page loaded" proves nothing. Each area is loaded, screenshotted, and judged
 * on how much of the frame differs from the background colour: too little means
 * nothing rendered, too much means a crash painted the whole canvas. Console
 * errors fail the run outright.
 *
 * Usage: node test/site.js <built-dir> [screenshot-dir]
 */

const fs = require('fs')
const http = require('http')
const path = require('path')

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png'
}

function serve (dir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
    const file = path.join(dir, rel || 'index.html')
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('not found'); return }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream'
      })
      res.end(body)
    })
  })
  return new Promise(resolve => {
    server.listen(0, () => resolve({ server, port: server.address().port }))
  })
}

/** Share of the frame that is not the page background. */
async function geometryFraction (page, background) {
  // Buffer.from first: recent puppeteer hands back a Uint8Array, whose own
  // toString is a list of decimal byte values rather than base64.
  const shot = Buffer.from(await page.screenshot({ encoding: 'binary' }))
  // Compare in the page itself; decoding a PNG here would mean another dep.
  const data = 'data:image/png;base64,' + shot.toString('base64')
  return page.evaluate(async (src, bg) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    // Ignore the UI strips at top and bottom.
    const top = Math.floor(img.height * 0.12)
    const height = Math.floor(img.height * 0.76)
    const px = ctx.getImageData(0, top, img.width, height).data
    let differing = 0
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - bg[0]) > 10 || Math.abs(px[i + 1] - bg[1]) > 10 ||
          Math.abs(px[i + 2] - bg[2]) > 10) differing++
    }
    return differing / (px.length / 4)
  }, data, background)
}

const hexToRgb = hex => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

async function main () {
  const dir = path.resolve(process.argv[2] || 'docs')
  const shotDir = process.argv[3] ? path.resolve(process.argv[3]) : null
  if (!fs.existsSync(path.join(dir, 'config.json'))) {
    throw new Error(`${dir} has no config.json; build a site there first`)
  }
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  const background = hexToRgb((config.theme && config.theme.background) || '#11131a')
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true })

  const puppeteer = require('puppeteer')
  const { server, port } = await serve(dir)
  const browser = await puppeteer.launch({
    headless: 'new',
    // The software rasteriser is what makes WebGL work on a headless box.
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  })

  const failures = []
  const errors = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', e => errors.push(String(e.message)))

    await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' })
    await page.waitForFunction('window.__mcmap && window.__mcmap.ready()',
      { timeout: 60000 })

    for (const area of config.areas) {
      await page.evaluate(id => window.__mcmap.load(id), area.id)
      await page.waitForFunction(id => window.__mcmap.area() === id,
        { timeout: 60000 }, area.id)
      // A couple of frames after the chunks report ready, so the first paint
      // with the new geometry has definitely happened.
      await new Promise(r => setTimeout(r, 600))

      if (shotDir) {
        await page.screenshot({ path: path.join(shotDir, `${area.id}.png`) })
      }
      const fraction = await geometryFraction(page, background)
      const ok = fraction >= 0.02 && fraction <= 0.9
      if (!ok) failures.push(`${area.id}: ${(fraction * 100).toFixed(1)}% of frame`)
      console.log(`${area.id.padEnd(12)} ${(fraction * 100).toFixed(1)}% geometry` +
        `   ${ok ? 'OK' : 'FAIL'}`)
    }

    // A shared link has to come back to the same place it was copied from.
    const shared = await page.evaluate(async () => {
      const id = window.__mcmap.area()
      await window.__mcmap.load(id, { pos: [12, 80, 12], yaw: 1, pitch: -0.2 })
      const p = window.__mcmap.pos()
      return { hash: window.location.hash, x: p.x, y: p.y, z: p.z }
    })
    const placed = Math.abs(shared.x - 12) < 0.001 && Math.abs(shared.y - 80) < 0.001
    console.log(`deep link   ${shared.hash}   ${placed ? 'OK' : 'FAIL'}`)
    if (!placed) failures.push('camera did not move to the position in the link')
    if (!/#.+@/.test(shared.hash)) failures.push('no shareable hash in the URL')
  } finally {
    await browser.close()
    server.close()
  }

  if (errors.length) {
    console.log('\nconsole errors:')
    for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e)
    failures.push(`${errors.length} console error(s)`)
  }

  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
  console.log('\nall areas rendered')
}

main().catch(e => { console.error(e); process.exit(1) })

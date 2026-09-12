# mc-map-viewer

Point it at a Minecraft world save and it builds a static site — a fly-through
viewer of the parts of the map you care about, ready to publish on GitHub Pages
and share with a link.

```bash
npx mc-map-viewer build --world ./world --radius 128 --title "My Spawn"
```

That writes `docs/`: an `index.html`, a viewer bundle, and a few kilobytes of
schematic per area. Commit it, turn on Pages, done. No server, no Node at
runtime, nothing to keep running.

## What it does

Minecraft world saves are not something a browser can open. `prismarine-viewer`
can draw chunks, but it needs the blocks handed to it, and a save is region
files in a format that changes between versions — plus, usually, far more world
than anyone wants to look at.

So the build cuts out only the areas you name, writes each as a Sponge
schematic, and ships those with a page that pastes them into an empty world and
renders it. A six-zone map comes to about 20 KB of map data on top of the
viewer.

```
docs/
  index.html          the page, titled and captioned from your config
  index.js            the viewer bundle (~4.7 MB)
  worker.js           the mesher, in a worker (~3.5 MB)
  blocksStates/       block models for the render version (~12 MB, gzips to ~0.3)
  textures/           the texture atlas
  config.json         your title, areas and camera targets
  schems/             one .schem per area — the only part specific to your map
```

## Usage

```
mcmap build [options]        extract the areas and build the site
mcmap init  [options]        write an mcmap.json you can edit and re-run
mcmap serve [options]        serve the built site locally
```

Areas are boxes, given as two corners:

```bash
mcmap build --world ./world \
  --area spawn=-41,62,-41:41,92,41 \
  --area koth=287,63,-33:353,77,33
```

Or skip them. `--radius 128` takes a box that size around the world spawn, and
with neither, the build goes looking: populated chunks are grouped into
clusters, and each cluster that holds anything substantial becomes its own
area. On a map of separate set-pieces that finds them one by one, and prints
what it found so you can paste it into `mcmap.json` and give each one a name.

Boxes are generous on purpose — each one is trimmed to what is actually in it
before it is written, so you can bracket a build roughly and let the tool find
its edges.

For anything you will rebuild, keep it in `mcmap.json`:

```json
{
  "title": "CosmicSky",
  "subtitle": "rebuilt in Minecraft 26.1",
  "description": "Six warp zones rebuilt from the reference footage.",
  "world": "./world",
  "out": "docs",
  "theme": { "background": "#11131a", "accent": "#4bc4a8" },
  "areas": [
    {
      "id": "spawn",
      "label": "Spawn",
      "blurb": "Prismarine temple plaza, colonnade and central spire.",
      "from": [-41, 62, -41],
      "to": [41, 92, 41]
    }
  ]
}
```

Then `mcmap build` with no arguments. Flags override the file, so
`mcmap build --area test=0,60,0:64,90,64` is a quick one-off without editing it.

`.zip` works anywhere a save folder does, including a zip with the save nested
inside a folder.

### Options

| Option | What it does |
| --- | --- |
| `--world <path>` | Save folder or `.zip` of one |
| `--out <dir>` | Where to write the site (default `docs`) |
| `--area id=x1,y1,z1:x2,y2,z2` | An area to show; repeatable |
| `--radius <n>` | Instead of `--area`: a box that size at the world spawn |
| `--centre x,y,z` | Centre for `--radius`, if the save records no spawn |
| `--dimension <name>` | `overworld` (default), `nether` or `end` |
| `--version <ver>` | Render as this Minecraft version |
| `--viewer <path>` | A `prismarine-viewer` checkout to build against |
| `--pad <n>` | Air kept around a trimmed area (default 1) |
| `--no-trim` | Keep areas exactly as given |
| `--max-blocks <n>` | Refuse an area bigger than this (default 8,000,000) |
| `--no-workflow` | Do not write the Pages workflow |

## Publishing

The build writes `.github/workflows/pages.yml` unless told not to, and never
overwrites one you already have. Commit the output, then in **Settings → Pages**
set the source to **GitHub Actions**. Pushing anything under `docs/` publishes.

Prefer no Actions at all? Pages will serve a `/docs` folder directly: set the
source to **Deploy from a branch**, branch `main`, folder `/docs`. A `.nojekyll`
file is written for you, without which Pages would skip the `_`-prefixed files.

Links carry what you are looking at — area, camera position and heading — so a
link drops someone exactly where you were, not at the default view. **Copy
link** puts the current one on the clipboard.

## Versions

A save records the version that wrote it; prismarine-viewer ships block models
for a fixed list (1.8.8 through 1.21.4 at the time of writing). Those rarely
match, so the build renders as the newest version it can draw that is no newer
than the save, and says so:

```
world:   cosmicsky (DataVersion 4786)
version: rendering as 1.21.4
         note: the save is DataVersion 4786; the newest version the viewer can
               render is 1.21.4, so blocks added since will be missing or drawn wrong
```

Blocks that version has never heard of would otherwise make the chunk parser
throw and lose the whole 16×384×16 column. Instead they are substituted, and
the build tells you what it had to fake:

```
blocks this version does not have:
  minecraft:iron_chain -> minecraft:chain (34 chunks)
```

The substitution table is deliberately tiny — a wrong guess is a lie about
what is in your world — so anything not in it becomes air. Add your own in the
config:

```json
"aliases": { "minecraft:pale_oak_planks": ["minecraft:birch_planks"] }
```

To render newer versions properly, point `--viewer` at a `prismarine-viewer`
checkout with support for them and the build will use its models, atlas and
mesher instead of the published package's.

## Limits

- **Areas, not worlds.** Everything in an area is pasted into the browser at
  once. Eight million blocks is the default ceiling and generous; a survival
  world is not what this is for.
- **Blocks only.** No entities, no block entity contents (chests render as
  chests, not as their loot), and the save's baked lighting is ignored — the
  viewer lights the scene itself.
- **The render version caps what can be drawn**, as above.

## Development

```bash
npm test                                  # unit tests
node test/site.js <built-dir> [shots/]    # load a built site in headless
                                          # Chrome, screenshot every area and
                                          # fail on a blank frame or any
                                          # console error
```

The site check is the one that matters: a viewer that throws inside its worker
still paints a clean background, so "the page loaded" proves nothing. It judges
each area on how much of the frame differs from the background colour, and
checks that a shared link puts the camera back where it was.

## Built on

[prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) for
rendering, [prismarine-provider-anvil](https://github.com/PrismarineJS/prismarine-provider-anvil)
for reading saves, [prismarine-schematic](https://github.com/PrismarineJS/prismarine-schematic)
for the area format, and [minecraft-data](https://github.com/PrismarineJS/minecraft-data)
for everything version-shaped.

MIT.

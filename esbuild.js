const path = require('path')
const fs = require('fs')
const exists = fs.existsSync
const esbuild = require('esbuild')
const exec = require('child_process').exec
const glob = require('glob-promise')
const crypto = require('crypto')
const branch = require('git-branch')

const loader = require('./setup/loaders')
const shims = require('./setup/shims')

function execShellCommand(cmd) {
  console.log(cmd)
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.warn(error)
      }
      resolve(stdout? stdout : stderr)
    })
  })
}

class Gradient {
  constructor(start, end, min, max) {
    this.min = min
    this.max = max
    this.start = this.hexToRgb(start)
    this.end = this.hexToRgb(end)
    this.diff = {
      r: this.end.r - this.start.r,
      g: this.end.g - this.start.g,
      b: this.end.b - this.start.b,
    }
  }

  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null
  }

  fade(value) {
    return (value - this.min) / (this.max - this.min)
  }

  getColor(value) {
    if (value < this.min) throw new Error(`${value} < ${this.min}`)
    if (value > this.max) throw new Error(`${value} > ${this.max}`)
    const fade = this.fade(value)

    const r = (this.diff.r * fade) + this.start.r
    const g = (this.diff.g * fade) + this.start.g
    const b = (this.diff.b * fade) + this.start.b

    return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
  }
}

function humansize(v) {
  const units = ['b', 'k', 'M', 'G']
  while (units.length > 1 && v > 1024) {
    units.shift()
    v = v / 1024
  }
  return `${Math.round(v)}${units[0]}`
}
function dependencyGraph(metafile) {
  const graph = { nodes: '', edges: '' }
  const node = {}
  function nodeid(module) {
    if (typeof node[module] !== 'number') node[module] = Object.keys(node).length
    return node[module]
  }
  const Wrap = 5000
  let X = 0
  let Y = 0
  let H = 0
  const size = { }
  for (const [module, data] of Object.entries(metafile.inputs)) {
    if (typeof size.min === 'undefined' || data.bytes < size.min) size.min = data.bytes
    if (typeof size.max === 'undefined' || data.bytes > size.max) size.max = data.bytes
  }
  const gradient = new Gradient('#00FF00', '#FF0000', 0, size.max)
  for (const [module, data] of Object.entries(metafile.inputs)) {
    let label = `${module.replace(/^node_modules\//, ':')} (${humansize(data.bytes)})`
    label = JSON.stringify(label)
    const w = 60
    const h = 30
    graph.nodes += `
      node [
        id ${nodeid(module)}
        label ${label}
        graphics [
          x ${X}
          y ${Y}
          w ${w}
          h ${h}
          fill "${gradient.getColor(data.bytes)}"
          outline "#000000"
        ]
      ]
    `
    X += w
    H = h > H ? h : H
    if (X > Wrap) {
      Y += H
      X = 0
      H = 0
    }

    for (const dep of data.imports) {
      graph.edges += `
        edge [
          source ${nodeid(module)}
          target ${nodeid(dep.path)}
        ]
      `
    }
  }
  return `
    graph [
	    hierarchic	1
	    directed	1
      ${graph.nodes}
      ${graph.edges}
    ]
  `
}

function js(src) {
  return src.replace(/[.]ts$/, '.js')
}

async function bundle(config) {
  config = {
    bundle: true,
    format: 'iife',
    // define: { BigInt: 'Number' },
    target: ['firefox60'],
    inject: [],
    treeShaking: true,
    keepNames: true,
    ...config,
  }

  let target
  if (config.outfile) {
    target = config.outfile
  }
  else if (config.entryPoints.length === 1 && config.outdir) {
    target = path.join(config.outdir, js(path.basename(config.entryPoints[0])))
  }
  else {
    target = `${config.outdir} [${config.entryPoints.map(js).join(', ')}]`
  }

  const exportGlobals = config.exportGlobals
  delete config.exportGlobals
  if (exportGlobals) {
    const esm = await esbuild.build({ ...config, logLevel: 'silent', format: 'esm', metafile: true, write: false })
    if (process.env.GML) {
      console.log('  generating dependency graph', target + '.gml')
      fs.writeFileSync(target + '.gml', dependencyGraph(esm.metafile))
    }
    for (const output of Object.values(esm.metafile.outputs)) {
      if (output.entryPoint) {
        const sep = '$$'
        config.globalName = escape(`{ ${output.exports.sort().join(', ')} }`).replace(/%/g, '$')
        // make these var, not const, so they get hoisted and are available in the global scope.
      }
    }
  }

  const metafile = config.metafile
  config.metafile = true

  console.log('* bundling', target)
  // console.log('  aliasing BigInt to Number for https://github.com/benjamn/ast-types/issues/750')
  const meta = (await esbuild.build(config)).metafile
  if (typeof metafile === 'string') await fs.promises.writeFile(metafile, JSON.stringify(meta, null, 2))
  if (exportGlobals) {
    await fs.promises.writeFile(
      target,
      (await fs.promises.readFile(target, 'utf-8')).replace(config.globalName, unescape(config.globalName.replace(/[$]/g, '%')))
    )
  }
}

async function rebuild() {
  // plugin code
  await bundle({
    entryPoints: [ 'content/better-bibtex.ts' ],
    plugins: [
      loader.trace('plugin'),
      loader.patcher('setup/patches'),
      loader.bib,
      loader.peggy,
      loader.__dirname,
      shims
    ],
    inject: ['./setup/loaders/globals.js'],
    outdir: 'build/content',
    banner: { js: 'if (!Zotero.BetterBibTeX) {\n' },
    footer: { js: '\n}' },
    metafile: 'gen/plugin.json',
    external: [
      'zotero/itemTree',
    ]
  })

  // worker code
  await bundle({
    entryPoints: [ 'content/worker/zotero.ts' ],
    plugins: [
      loader.trace('worker'),
      loader.patcher('setup/patches'),
      loader.bib,
      // loader.peggy,
      loader.__dirname,
      shims
    ],
    inject: ['./setup/loaders/globals.js'],
    outdir: 'build/content/worker',
    exportGlobals: true,
    metafile: 'gen/worker.json',
    external: [ 'jsdom' ],
    banner: { js: '\ndump("\\nloading BBT chromeworker\\n")\ntry {\n' },
    footer: { js: '} catch ($$err$$) { dump("\\nerror: failed loading BBT chromeworker: " + $$err$$.message  + "\\n" + $$err$$.stack + "\\n") }\ndump("\\nloaded BBT chromeworker\\n")\n' },
  })

  // translators
  for (const translator of (await glob('translators/*.json')).map(tr => path.parse(tr))) {
    const header = require('./' + path.join(translator.dir, translator.name + '.json'))
    const outfile = path.join('build/resource', translator.name + '.js')

    // https://esbuild.github.io/api/#write
    // https://esbuild.github.io/api/#outbase
    // https://esbuild.github.io/api/#working-directory
    await bundle({
      entryPoints: [path.join(translator.dir, translator.name + '.ts')],
      plugins: [
        // loader.trace('translators'),
        // loader.peggy,
        loader.__dirname,
        shims
      ],
      inject: ['./setup/loaders/globals.js'],
      outfile,
      banner: { js: `
        if (typeof ZOTERO_TRANSLATOR_INFO === 'undefined') var ZOTERO_TRANSLATOR_INFO = {}; // declare if not declared
        Object.assign(ZOTERO_TRANSLATOR_INFO, ${JSON.stringify(header)}); // assign new data
      `},
      exportGlobals: true,
      metafile: `gen/${translator.name}.json`,
    })

    const source = await fs.promises.readFile(outfile, 'utf-8')
    const checksum = crypto.createHash('sha256')
    checksum.update(source)
    if (!header.configOptions) header.configOptions = {}
    header.configOptions.hash = checksum.digest('hex')
    header.lastUpdated = (new Date).toISOString().replace(/T.*/, '')
    await fs.promises.writeFile(path.join('build/resource', translator.name + '.json'), JSON.stringify(header, null, 2))
  }

  if (await branch() === 'headless') {
    let node_modules = loader.node_modules('setup/patches')
    await bundle({
      platform: 'node',
      // target: ['node12'],
      // inject: [ './headless/inject.js' ],
      plugins: [node_modules.plugin, loader.patcher('setup/patches'), loader.peggy ],
      inject: ['./setup/loaders/globals.js'],
      bundle: true,
      globalName: 'Headless',
      entryPoints: [ 'headless/zotero.ts' ],
      outfile: 'gen/headless/zotero.js',
      banner: {
        js: 'var ZOTERO_CONFIG = { GUID: "zotero@" };\n',
      },
      exportGlobals: true,
      metafile: 'gen/headless/zotero.json',
    })
    let external = node_modules.external

    node_modules = loader.node_modules('setup/patches')
    await bundle({
      platform: 'node',
      // target: ['node12'],
      // inject: [ './headless/inject.js' ],
      plugins: [node_modules.plugin, loader.patcher('setup/patches'), loader.peggy ],
      bundle: true,
      globalName: 'Headless',
      entryPoints: [ 'headless/index.ts' ],
      outfile: 'gen/headless/index.js',
      metafile: 'gen/headless/index.json',
      banner: {
        js: await fs.promises.readFile('gen/headless/zotero.js', 'utf-8')
      }
    })
    external = [...new Set(external.concat(node_modules.external))].sort()

    const package_json = JSON.parse(await fs.promises.readFile('package.json', 'utf-8'))
    const move = Object.keys(package_json.dependencies).filter(pkg => !external.includes(pkg))
    if (move.length) {
      console.log('  the following packages should be moved to devDependencies')
      for (const pkg of move.sort()) {
        console.log('  *', pkg)
      }
    }
  }
}

rebuild().catch(err => {
  console.log(err)
  process.exit(1)
})

#!/usr/bin/env npx ts-node

/* eslint-disable prefer-arrow/prefer-arrow-functions, @typescript-eslint/no-unsafe-return, no-magic-numbers, no-console, @typescript-eslint/no-shadow, no-eval, @typescript-eslint/no-empty-function, id-blacklist */

import * as pug from 'pug'
import * as fs from 'fs'
import { ASTWalker } from './pug-ast-walker'

const pugs = [
  'content/Preferences.pug',
  'content/zotero-preferences.pug',
  'content/ErrorReport.pug',
  'content/FirstRun.pug',
  'content/ServerURL.pug',
  'content/ZoteroPane.pug',
]

const corrections: Set<string> = new Set
class L10NDetector extends ASTWalker {
  cleanup(id) {
    if (id === 'better-bibtex.BetterBibTeX') return '-better-bibtex_brand-name'

    id = id
      .replace(/[.]([A-Z]+)/g, (m, c) => `_${c.toLowerCase()}`)
      .replace(/([a-z])([A-Z]+)/g, (m, pre, post) => `${pre}-${post.toLowerCase()}`)
      .replace(/[.]/g, '_')
    if (!id.startsWith('better-bibtex_')) id = `better-bibtex_${id}`
    return id
  }

  Tag(node, history) {
    for (const attr of node.attrs) {
      attr.val.replace(/&(.+?);/, (m, id) => {
        let c = this.cleanup(id)
        const postfix = `_${attr.name}`
        if (!c.endsWith(postfix)) c += postfix
        if (id !== c) corrections.add(`${id} => ${c} (attr)`)
      })
    }
    this.walk(node.block, history)
    return node
  }

  Text(node, history) {
    // console.log(history)
    node.val.replace(/&(.+?);/, (m, id) => {
      const c = this.cleanup(id)
      if (id !== c) corrections.add(`${id} => ${c}`)
    })
    return node
  }
}

class WizardDetector extends ASTWalker {
  public foundWizard = false

  Tag(node) {
    if (node.name === 'wizard') this.foundWizard = true
    return node
  }
}

class Z7Wizard extends ASTWalker {
  Tag(node) {
    if (node.name === 'wizard') {
      return {
        type: 'Tag',
        name: 'window',
        attrs: node.attrs.filter(a => a.name.startsWith('xmlns')),
        attributeBlocks: [],
        block: {
          type: 'Block',
          nodes: [
            {
              type: 'Tag',
              name: 'script',
              selfClosing: true,
              block: { type: 'Block', nodes: [] },
              attrs: [ { name: 'src', val: '"chrome://global/content/customElements.js"', mustEscape: true } ],
              attributeBlocks: []
            },
            { ...node, attrs: node.attrs.filter(a => !a.name.startsWith('xmlns')) },
          ],
        }
      }
    }

    return node
  }
}

function render(src, options) {
  return pug.renderFile(src, options).replace(/&amp;/g, '&').trim()
}

for (let src of pugs) {
  console.log(' ', src)
  const tgt = `build/${src.replace(/pug$/, 'xul')}`

  const wizardDetector = new WizardDetector
  fs.writeFileSync(tgt, render(src, {
    pretty: true,
    plugins: [{
      preCodeGen(ast) {
        (new L10NDetector).walk(ast, [])
        return wizardDetector.walk(ast)
      }
    }],
  }))

  if (wizardDetector.foundWizard) {
    fs.writeFileSync(
      tgt.replace('.', '-7.'),
      render(src, {
        pretty: true,
        plugins: [{
          preCodeGen(ast) {
            return (new Z7Wizard).walk(ast)
          },
        }],
      })
    )
  }
}

for (const line of [...corrections].sort()) {
  console.log(line.replace(/[.]/g, '[.]'))
}

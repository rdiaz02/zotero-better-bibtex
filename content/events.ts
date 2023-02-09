/* eslint-disable prefer-rest-params */

import Emittery from 'emittery'

import { log } from './logger'

const events: string[] = [
  'collections-changed',
  'collections-removed',
  // 'error',
  'export-progress',
  // 'item-tag',
  'items-changed',
  'items-removed',
  'libraries-changed',
  'libraries-removed',
  'loaded',
  'preference-changed',
  'window-loaded',
]

export const Events = new Emittery<{
  'collections-changed': number[]
  'collections-removed': number[]
  'export-progress': { pct: number, message: string, ae?: number }
  'items-changed': number[]
  'items-removed': number[]
  'libraries-changed': number[]
  'libraries-removed': number[]
  'loaded': undefined
  'preference-changed': string
  'window-loaded': { win: Window, href: string }
}>({
  debug: {
    name: 'better-bibtex event',
    enabled: Zotero.Prefs.get('translators.better-bibtex.log-events'),
    logger: (type, debugName, eventName, eventData) => {
      if (typeof eventName === 'symbol') return
      log.debug(debugName, type, eventName, eventData)
      if (typeof eventName !== 'string' || !events.includes(eventName)) throw new Error(`unsupported event ${type}.${eventName}`)
    },
  },
})

export function itemsChanged(items: ZoteroItem[]): void {
  if (!items.length) return

  const changed = {
    collections: new Set,
    libraries: new Set,
  }

  for (const item of items) {
    changed.libraries.add(item.libraryID)

    for (let collectionID of item.getCollections()) {
      if (changed.collections.has(collectionID)) continue

      while (collectionID) {
        changed.collections.add(collectionID)
        collectionID = Zotero.Collections.get(collectionID).parentID
      }
    }
  }

  log.debug('itemsChanged:', { collections: Array.from(changed.collections), libraries: Array.from(changed.libraries) })
  if (changed.collections.size) this.emit('collections-changed', [...changed.collections])
  if (changed.libraries.size) this.emit('libraries-changed', [...changed.libraries])
}

const windowListener = {
  onOpenWindow: xulWindow => {
    const win = xulWindow.QueryInterface(Components.interfaces.nsIInterfaceRequestor).getInterface(Components.interfaces.nsIDOMWindow)
    win.addEventListener('load', function listener() { // eslint-disable-line prefer-arrow/prefer-arrow-functions
      win.removeEventListener('load', listener, false)
      Events.emit('window-loaded', { win, href: win.location.href }) // eslint-disable-line @typescript-eslint/no-floating-promises
    }, false)
  },
  // onCloseWindow: () => { },
  // onWindowTitleChange: _xulWindow => { },
}
Services.wm.addListener(windowListener)

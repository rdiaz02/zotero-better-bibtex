declare const Zotero: any

const OK = 200
const SERVER_ERROR = 500
const NOT_FOUND = 404
const BAD_REQUEST = 400

import { Translators } from './translators'
import { get as getCollection } from './collection'
import { get as getLibrary } from './library'
import { getItemsAsync } from './get-items-async'
import { KeyManager } from './key-manager'

function displayOptions(request) {
  const isTrue = new Set([ 'y', 'yes', 'true' ])
  const query = request.query || {}

  return {
    exportCharset: query.exportCharset || 'utf8',
    exportNotes: isTrue.has(query.exportNotes),
    useJournalAbbreviation: isTrue.has(query.useJournalAbbreviation),
  }
}

Zotero.Server.Endpoints['/better-bibtex/export/collection'] = Zotero.Server.Endpoints['/better-bibtex/collection'] = class {
  public supportedMethods = ['GET']

  public async init(request) {
    if (!request.query || !request.query['']) return [NOT_FOUND, 'text/plain', 'Could not export bibliography: no path']

    try {
      const [ , lib, path, translator ] = request.query[''].match(/^\/(?:([0-9]+)\/)?(.*)\.([-0-9a-z]+)$/i)

      const libID = parseInt(lib || 0) || Zotero.Libraries.userLibraryID

      const collection = Zotero.Collections.getByLibraryAndKey(libID, path) || (await getCollection(`/${libID}/${path}`))
      if (!collection) return [NOT_FOUND, 'text/plain', `Could not export bibliography: path '${path}' not found`]

      return [ OK, 'text/plain', await Translators.exportItems(Translators.getTranslatorId(translator), displayOptions(request), { type: 'collection', collection }) ]

    } catch (err) {
      return [SERVER_ERROR, 'text/plain', '' + err]
    }
  }
}

Zotero.Server.Endpoints['/better-bibtex/export/library'] = Zotero.Server.Endpoints['/better-bibtex/library'] = class {
  public supportedMethods = ['GET']

  public async init(request) {
    if (!request.query || !request.query['']) return [NOT_FOUND, 'text/plain', 'Could not export library: no path']

    try {
      const [ , lib, translator ] = request.query[''].match(/\/?(?:([0-9]+)\/)?library\.([-0-9a-z]+)$/i)
      const libID = parseInt(lib || 0) || Zotero.Libraries.userLibraryID

      if (!Zotero.Libraries.exists(libID)) {
        return [NOT_FOUND, 'text/plain', `Could not export bibliography: library '${request.query['']}' does not exist`]
      }

      return [OK, 'text/plain', await Translators.exportItems(Translators.getTranslatorId(translator), displayOptions(request), { type: 'library', id: libID }) ]

    } catch (err) {
      return [SERVER_ERROR, 'text/plain', '' + err]
    }
  }
}

Zotero.Server.Endpoints['/better-bibtex/export/selected'] = Zotero.Server.Endpoints['/better-bibtex/select'] = class {
  public supportedMethods = ['GET']

  public async init(request) {
    const translator = request.query ? request.query[''] : null

    if (!translator) return [NOT_FOUND, 'text/plain', 'Could not export bibliography: no format' ]

    try {
      const items = Zotero.getActiveZoteroPane().getSelectedItems()
      if (!items.length) return [NOT_FOUND, 'text/plain', 'Could not export bibliography: no selection' ]

      return [OK, 'text/plain', await Translators.exportItems(Translators.getTranslatorId(translator), displayOptions(request), { type: 'items', items }) ]
    } catch (err) {
      return [SERVER_ERROR, 'text/plain', '' + err]
    }
  }
}

Zotero.Server.Endpoints['/better-bibtex/export/item'] = class {
  public supportedMethods = ['GET']

  public async init(request) {
    await Zotero.BetterBibTeX.ready

    try {
      let { translator, citationKeys, libraryID, library, pandocFilterData } = request.query
      if (typeof libraryID !== 'undefined' && library) return [BAD_REQUEST, 'text/plain', 'specify one of library or libraryID' ]
      if (typeof library === 'undefined' && library) libraryID = getLibrary(library)
      if (typeof library === 'undefined') libraryID = Zotero.Libraries.userLibraryID

      citationKeys = Array.from(new Set(citationKeys.split(',').filter(k => k)))
      if (!citationKeys.length) return [ SERVER_ERROR, 'text/plain', 'no citation keys provided' ]

      const translatorID = Translators.getTranslatorId(translator)
      if (!translator || !translatorID) return [ SERVER_ERROR, 'text/plain', 'no translator selected' ]

      const response: { items: Record<string, any>, zotero: Record<string, { itemID: number, uri: string }>, errors: Record<string, string> } = { items: {}, zotero: {}, errors: {} }

      const itemIDs: Record<string, number> = {}
      for (const citekey of citationKeys) {
        const key = KeyManager.keys.find({ libraryID, citekey })
        switch (key.length) {
          case 0:
            response.errors[citekey] = 'not found'
            break
          case 1:
            itemIDs[citekey] = key[0].itemID
            break
          default:
            response.errors[citekey] = `${key.length} items found with key "${citekey}"`
            break
        }
      }

      if (!Object.keys(itemIDs).length) return [ SERVER_ERROR, 'text/plain', 'no items found' ]
      // itemID => zotero item
      const items = (await getItemsAsync(Object.values(itemIDs))).reduce((acc, item) => { acc[item.itemID] = item; return acc }, {})
      let contents = await Translators.exportItems(translatorID, displayOptions(request), { type: 'items', items: Object.values(items) })

      if (pandocFilterData) {
        let _items
        switch (Translators.byId[translatorID]?.label) {
          case 'Better CSL JSON':
            _items = JSON.parse(contents)
            break
          case 'BetterBibTeX JSON':
            _items = JSON.parse(contents).items
            break
          default:
            throw new Error(`Unexpected translator ${translatorID}`)
        }

        for (const item of _items) {
          // jzon gives citationKey, CSL gives id
          const citekey = item.citationKey || item.id
          response.items[citekey] = item
          response.zotero[citekey] = {
            itemID: itemIDs[citekey],
            uri: Zotero.URI.getItemURI(items[itemIDs[citekey]]),
          }
        }

        contents = JSON.stringify(response)
      }

      return [OK, 'text/plain', contents ]
    } catch (err) {
      return [SERVER_ERROR, 'text/plain', '' + err]
    }
  }
}
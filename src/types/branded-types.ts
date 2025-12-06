declare const brandSymbol: unique symbol

export type JSONData = string & { readonly [brandSymbol]: 'jsonData' }

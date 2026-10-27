/**
 * `render` patches the live tree with `morph` instead of swapping a new one in.
 * Run here against a small fake DOM, from the same source slice `marketsView.test.ts` evaluates.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const helpers = source.slice(source.indexOf('/* ---- tiny element helper'), source.indexOf('/* ---- api ---'))

class FakeNode {
  parentNode: FakeElement | null = null
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
  ) {}
  remove(): void {
    const siblings = this.parentNode?.childNodes
    if (siblings) siblings.splice(siblings.indexOf(this as never), 1)
    this.parentNode = null
  }
  replaceWith(next: FakeNode): void {
    const parent = this.parentNode!
    next.remove()
    parent.childNodes.splice(parent.childNodes.indexOf(this as never), 1, next as never)
    next.parentNode = parent
    this.parentNode = null
  }
}

class FakeText extends FakeNode {
  constructor(public nodeValue: string) {
    super(3, '#text')
  }
}

class FakeElement extends FakeNode {
  childNodes: FakeNode[] = []
  attributes: { name: string; value: string }[] = []
  listeners: Record<string, ((event: unknown) => void)[]> = {}
  value = ''
  checked = false
  scrollTop = 0
  constructor(tag: string) {
    super(1, tag.toUpperCase())
  }
  get firstChild(): FakeNode | undefined {
    return this.childNodes[0]
  }
  get lastChild(): FakeNode | undefined {
    return this.childNodes[this.childNodes.length - 1]
  }
  set className(value: string) {
    this.setAttribute('class', value)
  }
  get className(): string {
    return this.getAttribute('class') ?? ''
  }
  getAttribute(name: string): string | null {
    return this.attributes.find((a) => a.name === name)?.value ?? null
  }
  hasAttribute(name: string): boolean {
    return this.attributes.some((a) => a.name === name)
  }
  setAttribute(name: string, value: string): void {
    const found = this.attributes.find((a) => a.name === name)
    if (found) found.value = value
    else this.attributes.push({ name, value })
    if (name === 'value') this.value = value
    if (name === 'checked') this.checked = true
  }
  removeAttribute(name: string): void {
    this.attributes = this.attributes.filter((a) => a.name !== name)
  }
  appendChild(child: FakeNode): FakeNode {
    child.remove()
    this.childNodes.push(child)
    child.parentNode = this
    return child
  }
  removeChild(child: FakeNode): FakeNode {
    child.remove()
    return child
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  fire(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn({ type, target: this })
  }
}

const load = () => {
  const document = {
    activeElement: null as FakeElement | null,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
  }
  const built = new Function('document', 'Node', `${helpers}\nreturn { h, morph, morphChildren, clear }`)(
    document,
    FakeNode,
  )
  return { document, ...built } as {
    document: typeof document
    h: (spec: string, ...rest: unknown[]) => FakeElement
    morph: (live: FakeElement, next: FakeElement) => void
    morphChildren: (live: FakeElement, next: FakeElement) => void
    clear: (node: FakeElement) => void
  }
}

const text = (node: FakeNode): string =>
  node instanceof FakeText ? node.nodeValue : (node as FakeElement).childNodes.map(text).join('')

describe('morph', () => {
  it('keeps every node that still matches and rewrites only what changed', () => {
    const { h, morphChildren } = load()
    const root = h('div')
    morphChildren(root, h('div', h('section.pane', h('p', 'paying'), h('pre', '{}'))))
    const pane = root.childNodes[0] as FakeElement
    pane.scrollTop = 1040
    morphChildren(root, h('div', h('section.pane', h('p', 'paid'), h('pre', '{}'))))
    expect(root.childNodes[0]).toBe(pane)
    expect(pane.scrollTop).toBe(1040)
    expect(text(pane)).toBe('paid{}')
  })

  it('leaves the value of the focused field alone and resets the others', () => {
    const { h, morphChildren, document } = load()
    const root = h('div')
    morphChildren(root, h('div', h('input', { value: 'a' }), h('input', { value: 'b' })))
    const [typing, idle] = root.childNodes as FakeElement[]
    typing!.value = 'half-typed txid'
    idle!.value = 'stale'
    document.activeElement = typing!
    morphChildren(root, h('div', h('input', { value: 'a' }), h('input', { value: 'b' })))
    expect(typing!.value).toBe('half-typed txid')
    expect(idle!.value).toBe('b')
  })

  it('hands a kept node the handlers of its replacement', () => {
    const { h, morphChildren } = load()
    const root = h('div')
    const calls: string[] = []
    morphChildren(root, h('div', h('button', { onclick: () => calls.push('old') }, 'go')))
    const button = root.childNodes[0] as FakeElement
    morphChildren(root, h('div', h('button', { onclick: () => calls.push('new') }, 'go')))
    expect(root.childNodes[0]).toBe(button)
    button.fire('click')
    expect(calls).toEqual(['new'])
    morphChildren(root, h('div', h('button', 'go')))
    button.fire('click')
    expect(calls).toEqual(['new'])
  })

  it('adopts a node painted through a held reference instead of patching its twin', () => {
    const { h, morphChildren, clear } = load()
    const root = h('div')
    morphChildren(root, h('div', h('section', 'pricing…')))
    const held = h('section')
    clear(held)
    morphChildren(root, h('div', held))
    expect(root.childNodes[0]).toBe(held)
  })

  it('keeps a details element the way the operator left it', () => {
    const { h, morphChildren } = load()
    const root = h('div')
    morphChildren(root, h('div', h('details', { open: true }, h('summary', 'result')), h('details', 'raw')))
    const [result, raw] = root.childNodes as FakeElement[]
    result!.removeAttribute('open')
    raw!.setAttribute('open', '')
    morphChildren(root, h('div', h('details', { open: true }, h('summary', 'result')), h('details', 'raw')))
    expect(result!.hasAttribute('open')).toBe(false)
    expect(raw!.hasAttribute('open')).toBe(true)
  })

  it('follows state into an unfocused checkbox and keeps a style the browser wrote', () => {
    const { h, morphChildren } = load()
    const root = h('div')
    morphChildren(root, h('div', h('input', { type: 'checkbox', checked: true }), h('textarea', 'relays')))
    const [box, area] = root.childNodes as FakeElement[]
    area!.setAttribute('style', 'height: 240px')
    morphChildren(root, h('div', h('input', { type: 'checkbox' }), h('textarea', 'relays')))
    expect(box!.checked).toBe(false)
    expect(area!.getAttribute('style')).toBe('height: 240px')
  })

  it('replaces a node whose tag changed and trims what the new tree dropped', () => {
    const { h, morphChildren } = load()
    const root = h('div')
    morphChildren(root, h('div', h('p', 'a'), h('p', 'b'), h('p', 'c')))
    const first = root.childNodes[0]
    morphChildren(root, h('div', h('table'), h('p', 'b')))
    expect(root.childNodes).toHaveLength(2)
    expect(root.childNodes[0]).not.toBe(first)
    expect(root.childNodes[0]!.nodeName).toBe('TABLE')
  })
})

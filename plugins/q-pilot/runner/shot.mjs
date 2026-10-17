// Screenshot with the numbered element overlay, like the jev-ultrafast viewer. The `hot` element is highlighted.
import { elementIndex } from './snapshot.mjs'

export async function shot(page, snap, file, caption, hotNode) {
  const index = elementIndex(snap.actions)
  const boxes = []
  for (const a of snap.actions) {
    if (a.rect && index.has(a.node) && !boxes.some(b => b.node === a.node)) boxes.push({ node: a.node, i: index.get(a.node), rect: a.rect, fill: a.kind === 'fill', hot: a.node === hotNode })
  }
  await page.evaluate(({ boxes, caption }) => {
    const layer = document.createElement('div')
    layer.id = '__pilot'
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;font:600 12px ui-monospace,Menlo,monospace'
    for (const b of boxes) {
      const c = b.hot ? '#c2410c' : '#2563eb'
      const box = document.createElement('div')
      box.style.cssText = `position:absolute;left:${b.rect.x - 3}px;top:${b.rect.y - 3}px;width:${b.rect.w + 6}px;height:${b.rect.h + 6}px;border:2px solid ${c};border-radius:4px;background:${b.hot ? 'rgba(194,65,12,.12)' : 'rgba(37,99,235,.06)'}`
      const tag = document.createElement('span')
      tag.textContent = b.i + (b.fill ? ' ✎' : '')
      tag.style.cssText = `position:absolute;left:-2px;top:-20px;padding:1px 5px;border-radius:3px;color:#fff;background:${c}`
      box.append(tag)
      layer.append(box)
    }
    const cap = document.createElement('div')
    cap.textContent = caption
    cap.style.cssText = 'position:absolute;left:12px;right:12px;bottom:12px;padding:8px 12px;border-radius:6px;background:#111827;color:#f9fafb;font:500 13px ui-monospace,Menlo,monospace'
    layer.append(cap)
    document.body.append(layer)
  }, { boxes, caption })
  try {
    await page.screenshot({ path: file })
  } finally {
    await page.evaluate(() => document.getElementById('__pilot')?.remove())
  }
}

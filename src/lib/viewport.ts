// With `interactive-widget=resizes-content` the layout viewport shrinks above
// the soft keyboard, so fixed bottom bars sit on top of it. For browsers that
// ignore that hint, expose the keyboard's overlap as --kb so bars can lift.

export function trackKeyboard(): void {
  const vv = window.visualViewport
  if (!vv) return
  const update = () => {
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    document.documentElement.style.setProperty('--kb', `${Math.round(overlap)}px`)
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  update()
}

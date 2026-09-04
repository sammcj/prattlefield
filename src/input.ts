/**
 * Keyboard/mouse state with edge detection. Pointer lock is requested by the
 * game when it enters play; mouse deltas accumulate between frames.
 */
export class Input {
  private readonly down = new Set<string>()
  private readonly pressed = new Set<string>()
  private readonly buttons = new Set<number>()
  private readonly clicked = new Set<number>()
  mouseDX = 0
  mouseDY = 0
  wheel = 0
  locked = false
  private readonly target: HTMLElement

  constructor(target: HTMLElement) {
    this.target = target
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.down.add(e.code)
      this.pressed.add(e.code)
      if (this.locked && (e.code === 'Tab' || e.code === 'Space')) e.preventDefault()
    })
    window.addEventListener('keyup', (e) => this.down.delete(e.code))
    window.addEventListener('blur', () => {
      this.down.clear()
      this.buttons.clear()
    })
    target.addEventListener('mousedown', (e) => {
      if (!this.locked) return
      this.buttons.add(e.button)
      this.clicked.add(e.button)
    })
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button))
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return
      this.mouseDX += e.movementX
      this.mouseDY += e.movementY
    })
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY)
    })
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === target
      if (!this.locked) {
        this.down.clear()
        this.buttons.clear()
      }
    })
    target.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  requestLock(): void {
    if (this.locked) return
    // Plain lock only. The unadjustedMovement (raw input) option stops mousemove events on macOS Chrome unless a button is held.
    const result = this.target.requestPointerLock() as unknown
    if (result instanceof Promise) result.catch(() => undefined)
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock()
  }

  isDown(code: string): boolean {
    return this.down.has(code)
  }

  /** True once per key press; consumed on read. */
  wasPressed(code: string): boolean {
    const p = this.pressed.has(code)
    if (p) this.pressed.delete(code)
    return p
  }

  buttonDown(b: number): boolean {
    return this.buttons.has(b)
  }

  buttonClicked(b: number): boolean {
    const c = this.clicked.has(b)
    if (c) this.clicked.delete(b)
    return c
  }

  /** Call at end of frame to clear edge triggers and mouse deltas. */
  endFrame(): void {
    this.pressed.clear()
    this.clicked.clear()
    this.mouseDX = 0
    this.mouseDY = 0
    this.wheel = 0
  }
}

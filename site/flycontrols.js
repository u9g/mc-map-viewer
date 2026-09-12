/* global document */
const THREE = require('three')

const HALF_PI = Math.PI / 2 - 1e-3

/**
 * Creative-mode style free-fly camera.
 *
 * WASD moves along the look direction, space/shift go up and down, holding
 * control sprints, and the scroll wheel trims the speed. Mouse look needs
 * pointer lock (click the canvas), but the keys work without it so the camera
 * is useful the moment the page loads.
 */
class FlyControls {
  constructor (camera, dom) {
    this.camera = camera
    this.dom = dom
    this.enabled = false
    this.keys = new Set()
    this.yaw = 0
    this.pitch = 0
    this.speed = 22        // blocks/second
    this.sensitivity = 0.0022
    this.onSpeedChange = null

    camera.rotation.order = 'YXZ'

    this._forward = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    this._target = new THREE.Vector3()

    this._onKeyDown = e => {
      if (!this.enabled) return
      // Space scrolls the page by default, and repeat events would spam the set.
      if (e.code === 'Space') e.preventDefault()
      this.keys.add(e.code)
    }
    this._onKeyUp = e => this.keys.delete(e.code)
    // Losing focus mid-key would otherwise leave the camera drifting forever.
    this._onBlur = () => this.keys.clear()

    this._onClick = () => {
      if (this.enabled && document.pointerLockElement !== this.dom) {
        this.dom.requestPointerLock()
      }
    }
    this._onMouseMove = e => {
      if (!this.enabled || document.pointerLockElement !== this.dom) return
      this.yaw -= e.movementX * this.sensitivity
      this.pitch -= e.movementY * this.sensitivity
      this.pitch = Math.max(-HALF_PI, Math.min(HALF_PI, this.pitch))
      this._apply()
    }
    this._onWheel = e => {
      if (!this.enabled) return
      e.preventDefault()
      this.speed = Math.max(2, Math.min(300, this.speed * (e.deltaY > 0 ? 0.88 : 1.14)))
      if (this.onSpeedChange) this.onSpeedChange(this.speed)
    }

    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)
    window.addEventListener('blur', this._onBlur)
    dom.addEventListener('click', this._onClick)
    document.addEventListener('mousemove', this._onMouseMove)
    dom.addEventListener('wheel', this._onWheel, { passive: false })
  }

  get locked () {
    return document.pointerLockElement === this.dom
  }

  setEnabled (on) {
    this.enabled = on
    this.keys.clear()
    if (!on && this.locked) document.exitPointerLock()
    if (on) this.syncFromCamera()
  }

  /** Adopt whatever direction the camera is currently facing. */
  syncFromCamera () {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ')
    this.yaw = e.y
    this.pitch = Math.max(-HALF_PI, Math.min(HALF_PI, e.x))
    this._apply()
  }

  /**
   * Point the camera at a target given as anything with x/y/z.
   *
   * Copying the components matters: callers pass prismarine `Vec3`s, and
   * three's lookAt only recognises its own Vector3. Handed a foreign object it
   * silently takes the (x, y, z) overload with y and z undefined, which makes
   * the camera matrix NaN and freezes all movement.
   */
  lookAt (target) {
    this._target.set(target.x, target.y, target.z)
    this.camera.lookAt(this._target)
    this.syncFromCamera()
  }

  _apply () {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
  }

  update (dt) {
    if (!this.enabled || this.keys.size === 0) return
    const k = this.keys
    let f = 0
    let r = 0
    let u = 0
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1
    if (k.has('KeyD') || k.has('ArrowRight')) r += 1
    if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1
    if (k.has('Space')) u += 1
    if (k.has('ShiftLeft') || k.has('ShiftRight')) u -= 1
    if (f === 0 && r === 0 && u === 0) return

    const sprint = (k.has('ControlLeft') || k.has('ControlRight')) ? 3 : 1
    const dist = this.speed * sprint * dt

    // Forward follows pitch, so W flies the way you are looking, like creative.
    this.camera.getWorldDirection(this._forward)
    this._right.crossVectors(this._forward, this._up).normalize()

    const move = new THREE.Vector3()
    move.addScaledVector(this._forward, f)
    move.addScaledVector(this._right, r)
    move.addScaledVector(this._up, u)
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(dist)
      this.camera.position.add(move)
    }
  }

  dispose () {
    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('keyup', this._onKeyUp)
    window.removeEventListener('blur', this._onBlur)
    this.dom.removeEventListener('click', this._onClick)
    document.removeEventListener('mousemove', this._onMouseMove)
    this.dom.removeEventListener('wheel', this._onWheel)
  }
}

module.exports = { FlyControls }

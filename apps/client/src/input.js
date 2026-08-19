import { INPUT_BUTTON_INTERACT, INPUT_BUTTON_JUMP, INPUT_BUTTON_SPRINT } from '@keydate/protocol';

/**
 * Gathers keyboard, mouse and touch into one device-independent intent.
 *
 * The rest of the client only ever reads `moveX/moveZ/yaw/pitch/buttons`, so
 * adding a gamepad or a phone's touch stick is a change confined to this file —
 * which is what "cross-platform" has to mean in practice.
 */

const LOOK_SENSITIVITY = 0.0022;
const TOUCH_LOOK_SENSITIVITY = 0.005;
const MAX_PITCH = Math.PI / 2 - 0.01;

export class InputController {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;

    this.moveX = 0;
    this.moveZ = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.buttons = 0;

    /** Set true for one frame when interact is pressed, then consumed. */
    this.interactPressed = false;
    /** True while a text field has focus, so WASD types instead of walking. */
    this.textEntryActive = false;

    this._keys = new Set();
    this._touchLook = null;
    this._touchMove = null;

    this._bindKeyboard();
    this._bindPointer();
    this._bindTouch();
  }

  get isTouchDevice() {
    return window.matchMedia('(pointer: coarse)').matches;
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (this.textEntryActive) return;
      this._keys.add(event.code);
      if (event.code === 'KeyE') this.interactPressed = true;
      // Space scrolls the page by default, which is disastrous mid-jump.
      if (event.code === 'Space') event.preventDefault();
    });

    window.addEventListener('keyup', (event) => {
      this._keys.delete(event.code);
    });

    // A tab-out must not leave a key stuck down, or the avatar walks into a
    // wall until the player comes back and presses it again.
    window.addEventListener('blur', () => this._keys.clear());
  }

  _bindPointer() {
    this.canvas.addEventListener('click', () => {
      if (this.textEntryActive || this.isTouchDevice) return;
      this.canvas.requestPointerLock?.();
    });

    document.addEventListener('mousemove', (event) => {
      if (document.pointerLockElement !== this.canvas) return;
      // Move the mouse right, turn right. Increasing yaw rotates the facing
      // toward the camera's right axis, so this must add, not subtract.
      this.yaw += event.movementX * LOOK_SENSITIVITY;
      // Pitch subtracts because screen Y grows downward: pushing the mouse
      // forward gives a negative movementY and should look up.
      this.pitch -= event.movementY * LOOK_SENSITIVITY;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    });
  }

  _bindTouch() {
    // Left half of the screen drives movement, right half drives the camera —
    // the standard mobile layout, and it means no on-screen buttons are needed
    // for looking around.
    this.canvas.addEventListener(
      'touchstart',
      (event) => {
        for (const touch of event.changedTouches) {
          const isLeftHalf = touch.clientX < window.innerWidth / 2;
          const record = { id: touch.identifier, startX: touch.clientX, startY: touch.clientY };
          if (isLeftHalf && this._touchMove === null) this._touchMove = record;
          else if (!isLeftHalf && this._touchLook === null) {
            this._touchLook = { ...record, lastX: touch.clientX, lastY: touch.clientY };
          }
        }
        event.preventDefault();
      },
      { passive: false },
    );

    this.canvas.addEventListener(
      'touchmove',
      (event) => {
        for (const touch of event.changedTouches) {
          if (this._touchMove?.id === touch.identifier) {
            const dx = touch.clientX - this._touchMove.startX;
            const dy = touch.clientY - this._touchMove.startY;
            // 60px of travel reaches full tilt; beyond that it clamps.
            this.moveX = Math.max(-1, Math.min(1, dx / 60));
            this.moveZ = Math.max(-1, Math.min(1, -dy / 60));
          } else if (this._touchLook?.id === touch.identifier) {
            // Same convention as the mouse: drag right, look right.
            this.yaw += (touch.clientX - this._touchLook.lastX) * TOUCH_LOOK_SENSITIVITY;
            this.pitch -= (touch.clientY - this._touchLook.lastY) * TOUCH_LOOK_SENSITIVITY;
            this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
            this._touchLook.lastX = touch.clientX;
            this._touchLook.lastY = touch.clientY;
          }
        }
        event.preventDefault();
      },
      { passive: false },
    );

    const endTouch = (event) => {
      for (const touch of event.changedTouches) {
        if (this._touchMove?.id === touch.identifier) {
          this._touchMove = null;
          this.moveX = 0;
          this.moveZ = 0;
        }
        if (this._touchLook?.id === touch.identifier) this._touchLook = null;
      }
    };
    this.canvas.addEventListener('touchend', endTouch);
    this.canvas.addEventListener('touchcancel', endTouch);
  }

  /** Called by the touch HUD buttons. */
  pressJump(down) {
    if (down) this._keys.add('Space');
    else this._keys.delete('Space');
  }

  pressInteract() {
    this.interactPressed = true;
  }

  /**
   * Samples the current intent into an input frame for one simulation tick.
   *
   * Called exactly once per tick — never per rendered frame — so the frame the
   * server replays is the frame that was predicted locally.
   */
  sample() {
    if (!this.isTouchDevice && !this.textEntryActive) {
      const forward = (this._keys.has('KeyW') ? 1 : 0) - (this._keys.has('KeyS') ? 1 : 0);
      const strafe = (this._keys.has('KeyD') ? 1 : 0) - (this._keys.has('KeyA') ? 1 : 0);
      this.moveZ = forward;
      this.moveX = strafe;
    }

    let buttons = 0;
    if (this._keys.has('Space')) buttons |= INPUT_BUTTON_JUMP;
    // Shift or Ctrl, either side. Which one a player reaches for is muscle
    // memory from whatever else they play, so both are accepted rather than
    // asking anybody to relearn it.
    if (
      this._keys.has('ShiftLeft') ||
      this._keys.has('ShiftRight') ||
      this._keys.has('ControlLeft') ||
      this._keys.has('ControlRight')
    ) {
      buttons |= INPUT_BUTTON_SPRINT;
    }
    if (this.interactPressed) buttons |= INPUT_BUTTON_INTERACT;
    this.buttons = buttons;

    return {
      moveX: this.moveX,
      moveZ: this.moveZ,
      yaw: this.yaw,
      pitch: this.pitch,
      buttons,
    };
  }

  /** Reads and clears the one-shot interact flag. */
  consumeInteract() {
    const pressed = this.interactPressed;
    this.interactPressed = false;
    return pressed;
  }
}

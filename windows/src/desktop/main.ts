// The desktop Mochi's own window (mochi.html): draws him, and turns clicks and
// drags on him into pokes, flights home, the wardrobe and a new spot. Port of
// DesktopBotView + the mouse half of DesktopMochiController (DesktopMochi.swift).
//
// What he shows comes from the island (DESKTOP_EVENTS.state), where he is from
// Rust. The page draws only while the window is on screen, at 30 fps awake
// like the Mac, and a few frames a second asleep — with no cursor polling at
// all while he sleeps.

import { Bridge, emitToWindow, onEvent, type DesktopMode } from "../core/bridge";
import type { BotEmoteName } from "../core/layout";
import { Sound } from "../core/sound";
import { BotEngine } from "../mochi/engine";
import {
  DESKTOP_EVENTS, DOUBLE_CLICK_MS, DRAG_THRESHOLD, PANEL_SIZE, agentActive, gaze, isOverBody,
  layerDragTopLeft, lookOrigin, pointerDistance, shouldSleep, windowDragTopLeft,
  type DesktopSnapshot, type Point, type DesktopBubble,
} from "../mochi/desktop-logic";

const ISLAND = "island";

/**
 * Width Mochi is drawn at. The engine's body radius is 0.3 × width, so this
 * gives the 28.8 px body the hit test uses, and leaves room around him for
 * hats, hands and hearts inside the 120 px window.
 */
const DRAW_W = PANEL_SIZE * 0.8;
const SIDE = (PANEL_SIZE - DRAW_W) / 2;
/** Frame pacing: TimelineView(minimumInterval: 1/30) awake; asleep, barely. */
const AWAKE_FRAME_MS = 1000 / 30;
const ASLEEP_FRAME_MS = 250;

class DesktopMochi {
  private engine = new BotEngine();
  private canvas: HTMLCanvasElement;
  private mode: DesktopMode = "off";

  private snap: DesktopSnapshot = {
    state: "idle", outfit: "none", soundEnabled: true, soundVolume: 0.12, paused: false,
  };

  private visible = false;
  private asleep = false;
  /** Whether the island has told us anything yet. */
  private informed = false;
  private lastAgentActive = performance.now();
  /** Pointer in window coordinates, and when the page last heard of it. */
  private cursor: Point | null = null;
  private lastPointer = -Infinity;

  private timer: number | null = null;
  private lastDraw = 0;

  /** Canvas offset inside the window: non-zero only in a layer-shell drag. */
  private offset: Point = { x: 0, y: 0 };
  private press: { client: Point; screen: Point } | null = null;
  private dragging = false;
  /** Window's top-left corner when the drag began (mode's space). */
  private dragOrigin: Point | null = null;
  private dragTopLeft: Point | null = null;
  private moveFrame = false;
  private pokeTimer: number | null = null;

  private canvasOffset: Point = { x: 0, y: 0 };
  private bubbleContainer = document.getElementById("bubble-container");
  private bubbleCard = document.getElementById("bubble-card");
  private bubbleTitle = document.getElementById("bubble-title");
  private bubbleClose = document.getElementById("bubble-close");
  private bubbleSubtitle = document.getElementById("bubble-subtitle");
  private bubbleActions = document.getElementById("bubble-actions");
  private currentBubble: DesktopBubble | null = null;
  private bubbleTimer: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const dpr = this.dpr();
    canvas.width = Math.round(PANEL_SIZE * dpr);
    canvas.height = Math.round(PANEL_SIZE * dpr);
    this.engine.particleOverhang = 0;
    this.engine.setState("idle", true);
    // Three pokes: dizzy, and the island shows the confused view (as on macOS).
    this.engine.onDizzy = () => void emitToWindow(ISLAND, DESKTOP_EVENTS.dizzy);
    this.wireInput();
  }

  async start() {
    void Sound.preload();
    const info = await Bridge.desktopInfo();
    if (info) this.mode = info.mode;

    await onEvent<DesktopSnapshot>(DESKTOP_EVENTS.state, (s) => this.onSnapshot(s));
    await onEvent<{ emote: BotEmoteName; duration: number }>(DESKTOP_EVENTS.emote, (e) => {
      this.lastAgentActive = performance.now();
      this.wake();
      this.engine.triggerEmote(e.emote, e.duration);
      this.schedule();
    });
    await onEvent<DesktopBubble>(DESKTOP_EVENTS.bubble, (b) => void this.showBubble(b));
    await onEvent<void>(DESKTOP_EVENTS.bubbleDismiss, () => this.hideBubble());
    await onEvent<Point>(DESKTOP_EVENTS.cursor, (p) => this.notePointer(p));
    await onEvent<boolean>(DESKTOP_EVENTS.visible, (on) => this.setVisible(on));
    await onEvent<string>(DESKTOP_EVENTS.flight, (kind) => {
      // He fades in on the way out of the island (alphaValue 0 → 1 on macOS).
      if (kind !== "out") return;
      this.canvas.style.transition = "none";
      this.canvas.style.opacity = "0";
      void this.canvas.offsetWidth;
      this.canvas.style.transition = "";
      this.canvas.style.opacity = "1";
    });
    await emitToWindow(ISLAND, DESKTOP_EVENTS.ready);
  }

  // ── State ───────────────────────────────────────────────────────────────────

  private onSnapshot(s: DesktopSnapshot) {
    this.snap = s;
    this.informed = true;
    Sound.setEnabled(s.soundEnabled);
    Sound.setVolume(s.soundVolume);
    if (agentActive(s.state)) this.lastAgentActive = performance.now();
    if (!this.asleep) this.engine.setState(s.state);
    this.updateSleep(performance.now());
    this.schedule();
  }

  private setVisible(on: boolean) {
    this.visible = on;
    if (on) {
      // The two pages may have started in either order: ask again if needed.
      if (!this.informed) void emitToWindow(ISLAND, DESKTOP_EVENTS.ready);
      // Landing counts as something going on: he looks around for a while.
      this.lastAgentActive = performance.now();
      this.asleep = false;
      this.engine.setState(this.snap.state, true);
      this.engine.setOutfit(this.snap.outfit, false);
      this.schedule();
      return;
    }
    this.hideBubble();
    this.cancelPoke();
    this.press = null;
    this.dragging = false;
    this.setOffset({ x: 0, y: 0 });
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    Sound.idle();
  }

  private updateSleep(now: number) {
    if (!this.visible) return;
    const distance = pointerDistance(this.mode === "poll", this.cursor, now - this.lastPointer);
    const sleep =
      !this.dragging &&
      (this.snap.paused || shouldSleep((now - this.lastAgentActive) / 1000, distance));
    if (sleep === this.asleep) return;
    this.asleep = sleep;
    this.engine.setState(sleep ? "sleeping" : this.snap.state);
    // Asleep, Rust stops the cursor poll; his whole little window then listens
    // for the pointer, and the first move over it wakes him.
    void Bridge.desktopSetAsleep(sleep);
    if (sleep) Sound.idle();
    this.schedule();
  }

  private wake() {
    if (!this.asleep) return;
    this.updateSleep(performance.now());
  }

  /** Pointer in window coordinates: his eyes, and waking up. */
  private notePointer(p: Point) {
    this.cursor = p;
    this.lastPointer = performance.now();
    if (this.asleep) this.wake();
    this.schedule();
  }

  // ── Frames ──────────────────────────────────────────────────────────────────

  private schedule() {
    if (this.timer != null || !this.visible) return;
    const wait = this.asleep ? ASLEEP_FRAME_MS : AWAKE_FRAME_MS;
    const due = Math.max(0, this.lastDraw + wait - performance.now());
    this.timer = window.setTimeout(() => {
      // Awake, frames line up with the display; asleep, a timer is enough.
      if (this.asleep) {
        this.timer = null;
        this.frame(performance.now());
      } else {
        requestAnimationFrame((t) => {
          this.timer = null;
          this.frame(t);
        });
      }
    }, due);
  }

  private frame(now: number) {
    if (!this.visible) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastDraw) / 1000));
    this.lastDraw = now;
    this.updateSleep(now);
    this.draw(dt, now);
    this.schedule();
  }

  private draw(dt: number, now: number) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const engine = this.engine;
    engine.setOutfit(this.snap.outfit, true);
    if (!this.asleep) {
      // Windows: the global cursor. Linux: only while the pointer is over him.
      const fresh = this.mode === "poll" || now - this.lastPointer < 1500;
      const g = this.cursor && fresh ? gaze(lookOrigin(0, 0), this.cursor) : { lookX: 0, lookY: 0 };
      engine.lookX = g.lookX;
      engine.lookY = g.lookY;
    }
    // No dancing: the Windows and Linux app has no music signal to dance to.
    engine.update(dt);
    const dpr = this.dpr();
    ctx.setTransform(dpr, 0, 0, dpr, SIDE * dpr, 0);
    ctx.clearRect(-SIDE, 0, PANEL_SIZE, PANEL_SIZE);
    engine.draw(ctx, DRAW_W, PANEL_SIZE);
  }

  private dpr(): number {
    return Math.min(2, window.devicePixelRatio || 1);
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private local(e: MouseEvent): Point {
    return {
      x: e.clientX - this.offset.x - this.canvasOffset.x,
      y: e.clientY - this.offset.y - this.canvasOffset.y,
    };
  }

  private wireInput() {
    this.bubbleClose?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hideBubble();
    });

    this.bubbleCard?.addEventListener("click", () => {
      if (this.currentBubble?.type === "finish") {
        void Bridge.openSession(this.currentBubble.sessionId ?? null, this.currentBubble.cwd ?? null);
        this.hideBubble();
      }
    });

    document.addEventListener("pointerdown", (e) => {
      Sound.resume();
      if (e.button !== 0 || !isOverBody(this.local(e))) return;
      this.press = { client: this.local(e), screen: { x: e.screenX, y: e.screenY } };
      this.dragging = false;
      try {
        document.documentElement.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
    });

    document.addEventListener("pointermove", (e) => {
      if (!this.dragging) this.notePointer(this.local(e));
      const press = this.press;
      if (!press) return;
      if (!this.dragging) {
        const l = this.local(e);
        if (Math.hypot(l.x - press.client.x, l.y - press.client.y) <= DRAG_THRESHOLD) return;
        this.beginDrag();
      }
      this.dragTo(e);
    });

    document.addEventListener("pointerup", (e) => {
      const press = this.press;
      this.press = null;
      if (!press) return;
      if (this.dragging) {
        this.endDrag(e);
        return;
      }
      // Single click → poke, once it is clear it isn't a double click.
      this.cancelPoke();
      this.pokeTimer = window.setTimeout(() => {
        this.pokeTimer = null;
        this.lastAgentActive = performance.now();
        this.wake();
        this.engine.slap();
        this.schedule();
      }, DOUBLE_CLICK_MS);
    });

    document.addEventListener("dblclick", (e) => {
      if (!isOverBody(this.local(e))) return;
      this.cancelPoke();
      void emitToWindow(ISLAND, DESKTOP_EVENTS.home);
    });

    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (isOverBody(this.local(e))) void emitToWindow(ISLAND, DESKTOP_EVENTS.wardrobe);
    });

    document.addEventListener("pointerleave", () => {
      if (this.mode !== "poll" && !this.dragging) this.cursor = null;
    });

    // A layer-shell drag stretches the window over the display; once it is
    // back to its own size, so is the canvas.
    window.addEventListener("resize", () => {
      if (!this.dragging && window.innerWidth <= PANEL_SIZE + 20) this.setOffset({ x: 0, y: 0 });
    });
  }

  private cancelPoke() {
    if (this.pokeTimer != null) window.clearTimeout(this.pokeTimer);
    this.pokeTimer = null;
  }

  private beginDrag() {
    this.hideBubble();
    this.dragging = true;
    this.cancelPoke();
    this.dragOrigin = null;
    this.dragTopLeft = null;
    void Bridge.desktopDragBegin().then((pos) => {
      if (!pos) {
        this.dragging = false;
        this.press = null;
        return;
      }
      this.dragOrigin = { x: pos[0], y: pos[1] };
    });
  }

  /** Linux: the page drives the drag. Windows: the cursor poll carries him. */
  private dragTo(e: PointerEvent) {
    const origin = this.dragOrigin;
    const press = this.press;
    if (!origin || !press || this.mode === "poll") return;
    if (this.mode === "layer") {
      const applied = window.innerWidth > PANEL_SIZE + 20;
      const topLeft = layerDragTopLeft(origin, { x: e.clientX, y: e.clientY }, press.client, applied);
      this.dragTopLeft = topLeft;
      this.setOffset(applied ? topLeft : { x: topLeft.x - origin.x, y: topLeft.y - origin.y });
      return;
    }
    if (this.mode === "window") {
      const topLeft = windowDragTopLeft(origin, { x: e.screenX, y: e.screenY }, press.screen, this.dpr());
      this.dragTopLeft = topLeft;
      if (this.moveFrame) return;
      this.moveFrame = true;
      requestAnimationFrame(() => {
        this.moveFrame = false;
        const p = this.dragTopLeft;
        if (p && this.dragging) void Bridge.desktopDragMove(p.x, p.y);
      });
    }
  }

  private endDrag(e: PointerEvent) {
    this.dragTo(e);
    this.dragging = false;
    const topLeft = this.dragTopLeft;
    this.dragOrigin = null;
    this.dragTopLeft = null;
    if (this.mode === "poll" || !topLeft) return;
    void Bridge.desktopDragEnd(Math.round(topLeft.x), Math.round(topLeft.y));
  }

  private setOffset(p: Point) {
    this.offset = p;
    this.canvas.style.left = `${p.x + this.canvasOffset.x}px`;
    this.canvas.style.top = `${p.y + this.canvasOffset.y}px`;
  }

  // ── Speech Bubble ──────────────────────────────────────────────────────────

  async showBubble(bubble: DesktopBubble) {
    if (!this.bubbleContainer || !this.bubbleCard || !this.bubbleTitle || !this.bubbleSubtitle) return;
    this.clearBubbleTimer();
    this.currentBubble = bubble;

    this.wake();
    this.lastAgentActive = performance.now();

    // Trigger state emote
    if (bubble.type === "finish") {
      this.engine.triggerEmote("happy", 1.8);
    } else if (bubble.type === "question") {
      this.engine.triggerEmote("surprised", 1.8);
    } else if (bubble.type === "approval") {
      this.engine.triggerEmote("surprised", 1.8);
    }

    this.bubbleTitle.textContent = bubble.title;
    this.bubbleSubtitle.textContent = bubble.text;

    // Action buttons
    if (this.bubbleActions) {
      this.bubbleActions.innerHTML = "";
      if (bubble.type === "question" && bubble.options && bubble.options.length > 0) {
        this.bubbleActions.classList.remove("hidden");
        for (const opt of bubble.options) {
          const btn = document.createElement("button");
          btn.className = "bubble-btn";
          btn.textContent = opt.label;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (bubble.requestId) {
              const qKey = bubble.fullText || bubble.text;
              void Bridge.approvalAnswer(bubble.requestId, { [qKey]: opt.value });
            }
            void emitToWindow(ISLAND, DESKTOP_EVENTS.bubbleAction, {
              type: "question",
              requestId: bubble.requestId,
              value: opt.value,
            });
            this.hideBubble();
          });
          this.bubbleActions.appendChild(btn);
        }
      } else if (bubble.type === "approval") {
        this.bubbleActions.classList.remove("hidden");
        const actions = [
          { label: "Allow", cls: "bubble-btn-allow", decision: "allow" as const },
          { label: "Always", cls: "bubble-btn-always", decision: "allow" as const },
          { label: "Deny", cls: "bubble-btn-deny", decision: "deny" as const },
        ];
        for (const act of actions) {
          const btn = document.createElement("button");
          btn.className = `bubble-btn ${act.cls}`;
          btn.textContent = act.label;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (bubble.requestId) {
              void Bridge.approvalDecision(bubble.requestId, act.decision);
            }
            void emitToWindow(ISLAND, DESKTOP_EVENTS.bubbleAction, {
              type: "approval",
              requestId: bubble.requestId,
              decision: act.decision,
            });
            this.hideBubble();
          });
          this.bubbleActions.appendChild(btn);
        }
      } else {
        this.bubbleActions.classList.add("hidden");
      }
    }

    // Auto-dismiss timer
    const dismissMs = bubble.autoDismissMs ?? (bubble.type === "finish" ? 7000 : 0);
    if (dismissMs > 0) {
      this.bubbleTimer = window.setTimeout(() => this.hideBubble(), dismissMs);
    }

    // Measure bubble width and height
    const bubbleWidth = 280;
    this.bubbleContainer.style.width = `${bubbleWidth}px`;
    this.bubbleContainer.classList.remove("hidden");
    const bubbleHeight = Math.max(70, this.bubbleContainer.offsetHeight || 90);

    const layout = await Bridge.desktopShowBubble(bubbleWidth, bubbleHeight);
    if (!layout) return;

    if (layout.flipped) {
      this.bubbleContainer.classList.add("flipped");
    } else {
      this.bubbleContainer.classList.remove("flipped");
    }

    this.bubbleContainer.style.left = `${layout.bubbleRect[0]}px`;
    this.bubbleContainer.style.top = `${layout.bubbleRect[1]}px`;
    this.bubbleContainer.style.width = `${layout.bubbleRect[2]}px`;

    this.canvasOffset = { x: layout.mochiOffset[0], y: layout.mochiOffset[1] };
    this.setOffset(this.offset);
    this.schedule();
  }

  hideBubble() {
    this.clearBubbleTimer();
    this.currentBubble = null;
    if (this.bubbleContainer) {
      this.bubbleContainer.classList.add("hidden");
    }
    this.canvasOffset = { x: 0, y: 0 };
    this.setOffset(this.offset);
    void Bridge.desktopHideBubble();
    this.schedule();
  }

  private clearBubbleTimer() {
    if (this.bubbleTimer != null) {
      window.clearTimeout(this.bubbleTimer);
      this.bubbleTimer = null;
    }
  }
}

const canvas = document.getElementById("mochi");
if (canvas instanceof HTMLCanvasElement) void new DesktopMochi(canvas).start();

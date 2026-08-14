# Architecture

This document explains how the system is structured, why it's split
the way it is, and how data flows through it end to end — from a
mouse move in one browser to a rendered dot in another.

---

## 1. High-Level Data Flow

### Server side

    Browser
       |
       | WebSocket
       v
    Connection Layer  (server.ts)
       |
       v
    Protocol Layer    (protocol.ts)
       |
       v
    Room Manager       (roomManager.ts)
       |
       +-- Room (room.ts)
             |
             +-- Client A
             +-- Client B
             +-- Client C

### Client side

    WebSocket           (connection.ts)
       |
       v
    Protocol validation  (protocol.ts)
       |
       v
    Remote state         (interpolation.ts)
       |
       v
    Interpolation         (interpolation.ts)
       |
       v
    Renderer              (render.ts)
       |
       v
    Canvas                (App.tsx)

Each arrow is a real module boundary, not just a conceptual one — the
sections below explain why each layer exists and what it is (and is
not) responsible for.

---

## 2. Server-Side Layers

### 2.1 Connection Layer — `server.ts`

Owns the raw `WebSocketServer` and the connection lifecycle:
`connection`, `message`, `pong`, `close`, `error`. This is the only
file that touches the `ws` library directly.

Responsibilities:
- Accept incoming TCP/WebSocket connections
- Parse raw JSON off the wire (`JSON.parse`), catching malformed JSON
  before it reaches anything else
- Hand validated messages to the Protocol Layer, then route the
  result to the correct Room via the Room Manager
- Run the heartbeat sweep timer (ping every client, detect dead ones)

What it deliberately does **not** do: it has no idea what a "cursor"
or "reaction" *means*. It just routes `{type, ...}` objects to the
room layer. This keeps the transport code stable even if new action
types are added later — see §5.

### 2.2 Protocol Layer — `protocol.ts`

Defines every message shape (`ClientMessage`, `ServerMessage` unions)
and the single validation entrypoint, `parseClientMessage()`. This is
the **only** place in the codebase that decides whether a message is
well-formed.

Responsibilities:
- Type-level contract between client and server (shared file, see §6)
- Runtime validation: correct `type`, correct field types, *and* sane
  value ranges (bounded coordinates, capped reaction string length) —
  not just "is this technically a `number`"
- Returns `null` for anything invalid; callers are expected to
  silently drop `null` results rather than crash or forward them

Kept deliberately dumb: no side effects, no state, no knowledge of
rooms or sockets. Just data in, validated data (or `null`) out. This
makes it trivially testable in isolation and impossible to
accidentally couple to connection-handling bugs.

### 2.3 Room Manager — `roomManager.ts`

A thin registry: `Map<roomId, Room>`. Creates a `Room` on first
`join` to a given `roomId`, and removes it once it becomes empty.

This layer exists specifically to keep `room.ts` from having to know
about *other* rooms. Splitting "which room does this socket belong
to" from "what happens inside one room" means `Room` can be reasoned
about, and tested, as if only one room ever existed — genuinely
simpler code, not just an abstraction for its own sake.

### 2.4 Room — `room.ts`

Owns all state for **one** room: `Map<clientId, ClientState>`
(socket reference, last known position, last accepted `seq`, alive
flag).

Responsibilities:
- `join()` — register a client, send it a `welcome` snapshot of
  current participants, broadcast `presence: join` to everyone else
- `leave()` — deregister, broadcast `presence: leave`
- `handleAction()` — apply the ordering guard (discard stale `seq`),
  update stored position, broadcast to everyone except the sender
- `sweepDeadClients()` — heartbeat-driven cleanup of unresponsive
  connections
- `markAlive()` — called on `pong`, resets the dead-client timer

This is the only place that implements the **broadcast-to-others,
not-to-self** policy, and the only place that tracks per-client
`lastSeq`/`lastX`/`lastY` server-side.

---

## 3. Client-Side Layers

### 3.1 Connection Layer — `connection.ts`

Mirrors the server's connection layer: owns the raw `WebSocket`
object, exposes `send()` / `onMessage()` / `close()`. Handles
reconnect-with-backoff on unexpected close, and re-sends `join`
automatically on every (re)connect.

Framework-agnostic on purpose — no React import here. This is what
lets the transport logic be reused unchanged if the UI layer were
ever swapped (e.g. to a non-React renderer), and it's what the
assignment's FAQ specifically calls out ("WebSocket handling, protocol,
and interpolation must be your own, framework-agnostic code").

### 3.2 Protocol Layer — `protocol.ts` (client copy)

Identical contract to the server's version — same `ClientMessage` /
`ServerMessage` types. `connection.ts` uses `isServerMessage()` as a
cheap guard on incoming data (full validation already happened
server-side; this just protects the client from acting on garbage if
the server ever sent something unexpected).

### 3.3 Remote State + Interpolation — `interpolation.ts`

Owns a `Map<clientId, RemoteCursorState>`, where each entry holds
only the **last two** known positions (`prev`, `target`) plus
timestamps and the last accepted `seq`.

Responsibilities:
- `updateTarget()` — called whenever a `cursor` message arrives;
  shifts `target` into `prev`, stores the new point as `target`;
  discards the update if its `seq` doesn't exceed what's already
  been accepted for that client (ordering guard, client-side mirror
  of the server's own check)
- `getInterpolatedPositions()` — called every animation frame; computes
  a linearly-interpolated position for `now - 100ms` between `prev`
  and `target` for every tracked client

This is intentionally the *only* stateful piece on the client besides
the participant list — it owns "what should currently be drawn,"
decoupled from both "what arrived over the wire" (connection layer)
and "how it gets drawn" (render layer).

### 3.4 Renderer — `render.ts`

Pure functions: given a canvas context and a list of `{clientId, x,
y, color}` plus active reaction bursts, draws them. No WebSocket
knowledge, no interpolation math — just drawing.

`colorForClientId()` also lives here since it's a rendering concern
(deterministic hash → HSL color), reused identically by the canvas
dots and the presence sidebar list in `App.tsx`, so a given client's
color is visually consistent everywhere.

### 3.5 App.tsx — Composition Root

Doesn't implement transport, protocol, interpolation, or rendering
itself — it *wires them together*:
- Owns the `createRoom()` instance and forwards incoming messages to
  `interpolation.ts`
- Runs a fixed-rate `setInterval` loop that reads the latest mouse
  position and calls `send()` (see README §7 for the throttling
  rationale)
- Runs a `requestAnimationFrame` loop that reads interpolated
  positions and calls `renderFrame()`
- Renders the presence UI (user count, colored user list) from
  `participants` state, updated by `welcome`/`presence` messages

---

## 4. Why This Separation

Each layer can be reasoned about — and modified — independently:

- Want to add a new action type (e.g. a second emoji, a "typing"
  indicator)? Extend the `protocol.ts` union, add a `case` in
  `App.tsx`'s message switch, and (if it needs custom rendering) a
  branch in `render.ts`. **No changes needed** to `connection.ts` or
  `server.ts` — they're already generic over "any validated message."
- Want to change the interpolation algorithm (e.g. add extrapolation)?
  Only `interpolation.ts` changes. `render.ts` and `connection.ts` are
  untouched, since they only see the *output* (a position) or the
  *input* (a validated message), never the interpolation math itself.
- Want to swap the transport (e.g. add a fallback for browsers
  without WebSocket support)? Only `connection.ts` changes, as long as
  it preserves the same `send()`/`onMessage()`/`close()` interface —
  nothing above it needs to know.

This is the same reasoning the assignment's own evaluation criteria
call out directly: "Would this be extensible to a new action type
without touching transport code?" — yes, by construction, because
transport (`connection.ts`/`server.ts`) never inspects message
contents beyond routing them; only the protocol and application layers
know what a `cursor` or `reaction` actually *is*.

---

## 5. Extensibility Example (Concrete Walkthrough)

To add a new discrete action, e.g. a "wave" emoji distinct from the
fire reaction:

1. `protocol.ts` (both copies): add `"wave"` as an allowed value for
   the `reaction` field, or add a new message `type` entirely if it
   needs different fields — either way, this is the *only* place that
   defines what's valid.
2. `App.tsx`: the existing `case "reaction":` handler already pushes
   any incoming reaction to `bursts.current` regardless of which
   emoji string it carries — likely **no change needed** here at all,
   since the emoji is just data, not a new code path.
3. `render.ts`: no change needed — `renderFrame()` already draws
   whatever `emoji` string is in each burst.

In other words: for this specific case, adding a new emoji requires a
one-line change in `protocol.ts`'s validation and nothing else — a
direct consequence of the reaction payload being generic ("some
emoji string at some point") rather than hardcoded per action type.

---

## 6. Cross-Cutting Design Decisions

### Shared protocol types, duplicated not imported

`client/src/protocol.ts` is a manually-copied duplicate of
`server/src/protocol.ts`, not a shared package or symlink. This is a
known limitation (documented in README §12) — in a longer-lived
project, this would move to a shared workspace package so both sides
import the same source of truth and can never drift silently out of
sync.

### Server-authoritative ordering, client-side mirrored

Both `room.ts` and `interpolation.ts` independently track and enforce
`seq` ordering. This is deliberate redundancy, not duplication for its
own sake: the server's check protects what gets *broadcast and stored
server-side*; the client's check protects what gets *rendered*, in
case a future change (multiple transports, message replay, etc.)
ever allows reordering between "left the server" and "arrived at a
given client."

### In-memory-only state

Neither `room.ts` nor `roomManager.ts` persists anything to disk or an
external store. This was a deliberate scope decision — the assignment
explicitly lists "no persistence across server restart" as an
acceptable limitation, and adding real persistence would have taken
time away from getting the core sync/interpolation loop correct.
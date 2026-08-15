# Architecture

This document explains how the system is structured, why it's split
the way it is, and how data flows through it end to end — from a
mouse move in one browser to a rendered dot in another, including the
five bonus features layered on top of the core sync engine.

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
    Remote state          (interpolation.ts)
       |
       v
    Interpolation /        (interpolation.ts)
    Extrapolation
       |
       v
    Renderer               (render.ts)
       |
       v
    Canvas                 (App.tsx)

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
- Parse raw JSON off the wire, catching malformed JSON before it
  reaches anything else
- Reply to `ping` messages immediately with `pong`, bypassing room
  logic entirely — this is a pure latency probe, not a room action,
  so it doesn't require the socket to have joined anything yet
- Hand all other validated messages to the Protocol Layer's result
  down to the correct Room via the Room Manager
- Run the heartbeat sweep timer (ping every client, detect dead ones)

What it deliberately does **not** do: it has no idea what a "cursor,"
"reaction," or "latency" report *means* beyond routing. This keeps the
transport code stable even as new message types (like `ping`/`latency`,
added for the bonus features) are introduced — see §6.

### 2.2 Protocol Layer — `protocol.ts`

Defines every message shape (`ClientMessage`, `ServerMessage` unions)
and the single validation entrypoint, `parseClientMessage()`. This is
the **only** place in the codebase that decides whether a message is
well-formed.

Responsibilities:
- Type-level contract between client and server (shared file, see §7)
- Runtime validation: correct `type`, correct field types, *and* sane
  value ranges — not just "is this technically a `number`"
- Returns `null` for anything invalid; callers silently drop `null`
  results rather than crash or forward them

The bonus features added new variants here rather than new files:
`ping`/`pong` (latency probing), `latency` (self-reported RTT/jitter
relay), and two optional fields on `reaction` — `conflictId` and
`conflictRank` — used by the reconciliation feature (§2.4). Extending
a union type and adding one validation `case` was the entire integration
surface for each of these; no other file's *shape* needed to change,
only their *logic* did.

### 2.3 Room Manager — `roomManager.ts`

A thin registry: `Map<roomId, Room>`. Creates a `Room` on first
`join` to a given `roomId`, and removes it once it becomes empty.

This layer exists specifically to keep `room.ts` from having to know
about *other* rooms — splitting "which room does this socket belong
to" from "what happens inside one room" keeps `Room` reasoned about,
and tested, as if only one room ever existed.

### 2.4 Room — `room.ts`

Owns all state for **one** room: `Map<clientId, ClientState>`
(socket reference, last known position, last accepted `seq`, alive
flag), plus a small bounded buffer of recent reactions used for
conflict detection.

Responsibilities:
- `join()` / `leave()` — presence management, `welcome` snapshot,
  `presence` broadcasts
- `handleAction()` — for `cursor`: ordering guard, position update,
  broadcast. For `reaction`: ordering guard, **conflict detection**
  (see below), broadcast. For `latency`: pure relay, no state update.
- `sweepDeadClients()` / `markAlive()` — heartbeat-driven cleanup

**Conflict reconciliation (bonus), added to `handleAction`:** before
broadcasting a `reaction`, the room checks its `recentReactions` buffer
(pruned by age on every call) for any entry within 50px and 300ms of
the incoming one. If found, both reactions share a `conflictId`, and
the incoming one is tagged with a `conflictRank` equal to how many
reactions already share that id. This makes reconciliation entirely a
**server-side, single-room concern** — it doesn't touch the Room
Manager, the Connection Layer, or the client's transport at all. The
buffer is capped at 20 entries (`RECENT_BUFFER_MAX`), so this doesn't
introduce unbounded memory growth even under sustained reaction spam.

This is the only place that implements the **broadcast-to-others,
not-to-self** policy, and the only place that owns per-client
`lastSeq`/`lastX`/`lastY` and the conflict buffer.

---

## 3. Client-Side Layers

### 3.1 Connection Layer — `connection.ts`

Mirrors the server's connection layer: owns the raw `WebSocket`
object, exposes `send()` / `onMessage()` / `close()` / `getRTT()`.
Handles reconnect-with-backoff on unexpected close, and re-sends
`join` automatically on every (re)connect.

**RTT/jitter measurement (bonus), added here:** on every `open`
(including reconnects), a recurring `ping` fires every 3 seconds. The
`pong` handler computes RTT from the echoed timestamp, maintains a
rolling window of the last 5 samples, and computes jitter as their
mean absolute deviation. Two things happen with this data: (1) it's
sent to the server as a `latency` message so *other* clients learn
this client's numbers, and (2) it's applied directly to this client's
*own* local UI state immediately, since the server never echoes a
sender's own messages back to them.

This module stays framework-agnostic on purpose — no React import
here — matching the assignment's explicit requirement that transport,
protocol, and interpolation logic be hand-built and UI-framework-independent.

### 3.2 Protocol Layer — `protocol.ts` (client copy)

Identical contract to the server's version, including the bonus
message types. `connection.ts` uses a lightweight `isServerMessage()`
guard on incoming data; full validation already happened server-side.

### 3.3 Remote State + Interpolation/Extrapolation — `interpolation.ts`

Owns a `Map<clientId, RemoteCursorState>`. Each entry holds the last
two known positions (`prev`, `target`) with timestamps, the last
accepted `seq`, and a computed velocity (`vx`, `vy`).

Responsibilities:
- `updateTarget()` — shifts `target` into `prev`, stores the new
  point as `target`, computes velocity from the two most recent real
  points, and discards the update if its `seq` doesn't exceed what's
  already been accepted (ordering guard, mirrors the server's own
  check).
- `getInterpolatedPositions()` — called every animation frame. If the
  render time falls between two known real points, linearly
  interpolates. **If it falls past the last known point** (no fresh
  update has arrived in time), it extrapolates forward using the
  stored velocity, capped at 250ms (`MAX_EXTRAPOLATION_MS`) to prevent
  unbounded drift. The moment a real update arrives, `updateTarget()`
  resets `prev`/`target` unconditionally, so the very next frame
  automatically falls back into the interpolation branch — no
  separate "exit extrapolation mode" logic needed.

This remains the *only* stateful piece on the client besides the
participant/latency lists — owning "what should currently be drawn,"
decoupled from both "what arrived over the wire" and "how it gets
drawn."

### 3.4 Renderer — `render.ts`

Pure functions: given a canvas context, a list of cursor positions,
and active reaction bursts, draws them. No WebSocket or interpolation
math here — just drawing.

**Conflict-aware rendering (bonus):** `ReactionBurst` gained an
optional `conflictRank` field. When present, the burst is drawn with
a small horizontal offset (`rank * 14px`) and a slight size increase,
so multiple conflicting reactions at the same spot are visibly
distinguishable rather than perfectly overlapping. Since every client
receives the identical `conflictRank` for the same reaction from the
server, this offset is deterministic and identical across all
clients — no client-side randomness or guessing involved.

### 3.5 App.tsx — Composition Root

Wires every layer together and owns UI-only state that doesn't belong
in any lower layer:
- `participants: string[]` — who's in the room (from `welcome`/`presence`)
- `latencies: Record<clientId, {rtt, jitter}>` — **(bonus)** populated
  from incoming `latency` messages, rendered next to each name in the
  Users list
- The adaptive send-rate loop **(bonus)**: a `restart()`/`tick()` pair
  that re-reads `roomRef.current?.getRTT()` once a second and only
  tears down/rebuilds the send `setInterval` if the target rate
  (computed by `intervalForRTT()`) actually changed — avoiding
  needless timer churn while still reacting to changing network
  conditions
- The `requestAnimationFrame` render loop, reading interpolated (or
  extrapolated) positions and calling `renderFrame()`

---

## 4. Why This Separation

Each layer can be reasoned about — and modified — independently, and
the bonus features are the clearest evidence of this in practice:

- **Extrapolation** was added entirely inside `interpolation.ts`.
  `render.ts`, `connection.ts`, and the server were untouched.
- **Adaptive throttling** touched `connection.ts` (RTT measurement)
  and `App.tsx` (using that RTT to pick a send interval) — but never
  `protocol.ts`'s `cursor` message shape, `room.ts`'s broadcast logic,
  or `interpolation.ts`. The receiving side has no idea the sending
  side's rate is variable; it just processes whatever arrives.
- **Reconciliation** lives almost entirely in `room.ts` (detection)
  plus two optional fields threaded through `protocol.ts` and
  rendered in `render.ts`. `connection.ts` and the heartbeat/presence
  system were completely unaffected.
- **Latency visualization** required one new message type
  (`protocol.ts`), one relay branch (`room.ts`), one measurement loop
  (`connection.ts`), and one UI list update (`App.tsx`) — no existing
  logic in any of those files needed to change, only additions.

This is the same reasoning the assignment's own evaluation criteria
call out: "Would this be extensible to a new action type without
touching transport code?" — every bonus feature above answers yes in
practice, not just in theory, because transport (`connection.ts`/
`server.ts`) never inspects message contents beyond routing them.

---

## 5. Extensibility Example (Concrete Walkthrough)

To add a new discrete reaction, e.g. a "wave" emoji distinct from fire:

1. `protocol.ts` (both copies): allow `"wave"` as a value for the
   `reaction` field — the only place that defines what's valid.
2. `App.tsx`: the existing `case "reaction":` handler already pushes
   any incoming reaction (including its `conflictRank`, if present) to
   `bursts.current` regardless of which emoji string it carries — no
   change needed.
3. `render.ts`: no change needed — `renderFrame()` already draws
   whatever `emoji` string is in each burst, offset correctly if it
   conflicted with another.

Adding a new emoji requires a one-line validation change and nothing
else — a direct consequence of the reaction payload being generic
data rather than hardcoded per action type, and of the conflict logic
being emoji-agnostic (it keys on position/time, not on which reaction
string was sent).

---

## 6. Cross-Cutting Design Decisions

### Message-type growth via union extension, not new files

All five bonus features were integrated by extending the existing
`ClientMessage`/`ServerMessage` unions in `protocol.ts`, rather than
introducing parallel message-handling paths. This keeps validation,
type safety, and the "reject unknown/malformed" guarantee uniform
across every message type, old or new — a new `case` in one `switch`
statement, not a new subsystem.

### Server-authoritative timing for both ordering and conflicts

Both the ordering guard (§11 in README) and the conflict-detection
window use **server-observed** timing (`Date.now()` on arrival, or
strict per-connection message order), never client-reported
timestamps. Client clocks can't be trusted to agree with each other,
so any cross-client comparison (like "did these two reactions happen
close together") has to be anchored to a single, shared clock — the
server's.

### Shared protocol types, duplicated not imported

`client/src/protocol.ts` is a manually-copied duplicate of
`server/src/protocol.ts`. Documented as a known limitation — in a
longer-lived project this would move to a shared workspace package.

### In-memory-only state

Neither `room.ts` nor `roomManager.ts` persists anything to disk or an
external store, including the new conflict-detection buffer. A
deliberate scope decision — the assignment explicitly lists
persistence and horizontal scaling as acceptable limitations, and
adding either would have taken time away from getting the core sync
loop, and then the bonus features, correct.
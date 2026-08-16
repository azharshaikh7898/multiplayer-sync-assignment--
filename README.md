# Real-Time Multiplayer Cursor/State Sync

A raw-WebSocket, framework-free real-time sync engine. Multiple browser
clients share a live cursor canvas with smooth interpolated (and
extrapolated) movement, plus a tap-to-react emoji burst. No Socket.IO,
Yjs, PartyKit, or any other real-time sync library. The transport,
protocol, and interpolation logic are all hand-built.

**Live demo:** https://multiplayer-sync-assignment-1.onrender.com/
**Server (WebSocket endpoint):** https://multiplayer-sync-assignment.onrender.com/
**Repository:** https://github.com/azharshaikh7898/multiplayer-sync-assignment--

## Summary

- Raw WebSocket sync engine with a custom protocol, server, and client. No sync libraries used.
- Live shared cursor canvas plus a tap-to-react emoji, tested with up to 5 tabs and 3 real devices.
- Buffered interpolation and velocity-based extrapolation keep remote cursors smooth, verified under throttled networks.
- Handles disconnects and reconnects, orders messages via sequence numbers, and validates every message.
- All 5 optional bonus features are implemented: extrapolation, RTT-based adaptive throttling, simultaneous-reaction reconciliation, live latency/jitter display, and a written horizontal-scaling discussion.
- Deployed live on Render, both server and client. Links above.

---

## Setup & How to Run

**Requirements:** Node.js 22+, npm

**Install:**

    cd server && npm install
    cd client && npm install

**Run it (two terminals):**

    # Terminal 1
    cd server && npm run dev
    # -> WebSocket server listening on ws://localhost:8080

    # Terminal 2
    cd client && npm run dev
    # -> opens on http://localhost:5173

**To test multi-client sync**, open `localhost:5173` in 3-5 separate
browser tabs. Move your mouse in one tab and watch cursors update live
in the others. Click the canvas to send a fire-emoji reaction, visible
to everyone connected. Each row in the Users list also shows that
client's live round-trip latency and jitter.

**Production build:**

    cd server && npm run build && npm start
    cd client && npm run build   # outputs to client/dist

---

## Architecture

`ARCHITECTURE.md` has the full breakdown of layers, data flow, and how
extensible the design actually is. Short version:

- `server/src/server.ts` handles the WebSocket connection lifecycle, heartbeat, and ping/pong.
- `server/src/roomManager.ts` does multi-room bookkeeping.
- `server/src/room.ts` owns presence, broadcast, ordering, and conflict reconciliation.
- `server/src/protocol.ts` defines message types and runtime validation, shared with the client.
- `client/src/connection.ts` is the WebSocket transport: connect, reconnect with backoff, RTT/jitter measurement.
- `client/src/interpolation.ts` does buffered interpolation plus velocity-based extrapolation.
- `client/src/render.ts` draws to canvas: cursors, reaction bursts, conflict offsets.
- `client/src/App.tsx` wires transport, interpolation, render, and the adaptive send-rate loop together.

Transport, protocol, and rendering are kept cleanly separate. Adding a
new action type just means extending `protocol.ts`'s message union and
adding a `case` in `App.tsx`. No need to touch `connection.ts` at all.

---

## Protocol Design

Every message carries `clientId`, so neither side has to guess who
sent something based on connection context alone. `cursor` and
`reaction` messages also carry a monotonically increasing per-client
`seq` number, used for ordering (more on that below).

**Client to Server**

| Type       | Fields                                        | Purpose                                |
|------------|------------------------------------------------|-----------------------------------------|
| `join`     | `clientId`, `roomId`                            | Announce self, join a room             |
| `cursor`   | `clientId`, `seq`, `x`, `y`                     | Continuous position update             |
| `reaction` | `clientId`, `seq`, `x`, `y`, `reaction`         | Discrete tap/emoji event               |
| `leave`    | `clientId`                                      | Explicit leave, on top of a plain close |
| `ping`     | `clientId`, `sentAt`                            | Latency probe                          |
| `latency`  | `clientId`, `rtt`, `jitter`                     | Self-reported RTT/jitter, for others   |

**Server to Client**

| Type       | Fields                                                                  | Purpose                                |
|------------|--------------------------------------------------------------------------|-------------------------------------------|
| `welcome`  | `clientId`, `participants[]`                                              | New joiner's id plus a snapshot of room state |
| `presence` | `clientId`, `status` (`join`\|`leave`)                                    | Someone joined or left                    |
| `cursor`   | `clientId`, `seq`, `x`, `y`                                               | Relayed cursor update                  |
| `reaction` | `clientId`, `seq`, `x`, `y`, `reaction`, `conflictId?`, `conflictRank?`   | Relayed reaction, tagged if it conflicted with another |
| `pong`     | `sentAt`                                                                  | Reply to `ping`, echoing the original timestamp |
| `latency`  | `clientId`, `rtt`, `jitter`                                              | Relayed latency info for display        |

**Validation.** Every incoming message goes through
`parseClientMessage()` in `protocol.ts`, which checks not just JS type
correctness but sane value ranges too (coordinates bounded to
+/-100,000, reaction strings capped at 8 characters). Anything
malformed or of an unknown type gets silently dropped. It never
crashes the connection and never gets broadcast. I verified this
manually with `wscat`, sending malformed JSON, missing fields, and
unknown message types.

**New clients joining mid-session.** On `join`, the server immediately
sends the new client a `welcome` message with a full snapshot of every
currently connected participant's last known position (`Room.join()`
in `room.ts`). I went with this over a replay-log approach because
it's simpler: a new joiner sees where everyone currently is, not the
history of how they got there. Verified with multi-terminal `wscat`
tests.

---

## Throttling

Raw `mousemove` fires at 60-120Hz, so sending every event would be
wasteful. `handleMouseMove` only updates a locally stored "latest
position" ref, no network call happens there. A separate timer is the
only thing that actually sends a `cursor` message, and it skips the
send entirely if the position hasn't changed since the last tick.

**Adaptive rate (bonus).** The send interval isn't fixed, it adapts to
measured round-trip latency. Every 3 seconds the client pings the
server (which replies immediately with `pong`) to measure RTT:

    RTT < 100ms   -> 25Hz  (40ms interval)
    RTT 100-300ms -> 15Hz  (67ms interval)
    RTT > 300ms   -> 8Hz   (125ms interval)

A watcher re-checks the target interval once a second and only rebuilds
the send timer if it actually changed, so it's not churning constantly.
This keeps a slow connection from getting flooded with updates it
can't usefully deliver in time, while staying maximally responsive on
a fast one. The measured RTT also gets broadcast to other clients and
shown live in the Users list (see Bonus Features below). I verified
this by watching the displayed number climb under Chrome DevTools
"Slow 3G."

---

## Interpolation & Extrapolation

**Interpolation.** This uses buffered linear interpolation, sometimes
called "entity interpolation" or a playout-delay buffer, the standard
technique from multiplayer game netcode. Each incoming `cursor` update
becomes the new `target`, and the previous `target` becomes `prev`.
Every animation frame renders the position for `now - 100ms`,
interpolated between `prev` and `target`. Rendering slightly in the
past means there are always two real, confirmed points to interpolate
between, instead of guessing where a cursor is heading. The cost is a
small, fixed visual lag.

**Extrapolation (bonus).** When no fresh update has arrived by the
time a frame needs to render, the interpolator extrapolates forward
from the last known point using its velocity, computed from the two
most recent real positions. This is capped at 250ms so it doesn't
drift indefinitely. The moment a real update arrives, `prev` and
`target` reset unconditionally, so the very next frame falls right
back into normal interpolation without any special handling needed.

**The tradeoff.** A higher delay or extrapolation cap gives smoother
motion under jitter, but at the cost of more lag, or a more visible
correction when a real update finally disagrees with the guess. Lower
values feel more "live" but stutter more easily. I settled on 100ms
for the interpolation delay and 250ms for the extrapolation cap as a
middle ground.

**Verified** under Chrome DevTools "Slow 3G" and "Slow 4G" throttling.
Remote cursor motion stayed visibly smooth and continuous, no
teleporting or snapping, whether or not a fresh update happened to
arrive in time.

**Memory.** Only 2 points and a velocity vector are stored per client,
never a full position history, so memory use stays flat no matter how
long a session runs.

---

## Disconnect & Reconnection

**Normal close.** The browser sends a clean WebSocket close frame, and
the server removes the client and broadcasts `presence: leave`. I
tested this by closing one of several open tabs and confirming the
online count dropped within a couple seconds on the rest.

**Network failure.** This is caught by a 15-second heartbeat. The
server pings every client and marks it as unresponsive if no pong
comes back before the next sweep, which bounds how long a zombie
cursor can linger to roughly one heartbeat interval (worst case around
30 seconds). I verified this by killing the server process outright.
There was a real bug here during development, a multi-sweep issue,
which I've documented in `ARCHITECTURE.md`.

**Reconnect.** The client auto-reconnects on an unexpected close using
exponential backoff (1s, then 2s, 4s, and so on up to a 10s cap), and
re-sends `join` automatically. On the server side, `join()` guards
against duplicates: if a `clientId` that's already present tries to
rejoin, the old socket gets replaced instead of creating a second
entry.

**On identity.** Within a single session, `clientId` stays the same
across automatic reconnects. A full page refresh generates a brand new
`clientId`, since that's a fresh page load rather than a resumed
session. The old identity just gets cleaned up through the normal
close/heartbeat path. More on this in Known Limitations.

---

## Ordering

Every `cursor` and `reaction` message carries a monotonically
increasing per-client `seq`. Both the server (`room.ts`) and the
client (`interpolation.ts`) independently track the highest `seq`
they've accepted per client, and discard anything that doesn't exceed
it. This is really defense-in-depth: WebSocket over TCP already
guarantees in-order delivery on a single connection, so this rarely
actually triggers, but it protects against future changes (multiple
transports, message replay) that could reorder things.

---

## Bonus Features

All five optional bonus items are implemented.

| Feature | What it does |
|---|---|
| **Extrapolation** | Covered above under Interpolation & Extrapolation. |
| **Adaptive throttling** | Covered above under Throttling. |
| **Simultaneous-action reconciliation** | Two reactions landing within 50px and 300ms of each other, by server-observed arrival time, get tagged with a shared `conflictId` and a `conflictRank` (0, 1, 2... by arrival order). Every client renders the identical result, offset and slightly enlarged, since those tags come straight from the server rather than being guessed client-side. A small bounded buffer (20 entries) handles the comparison window. I tested this via direct `wscat` message injection at identical coordinates. I never got a fully clean recording of two real, simultaneous browser clicks triggering the offset rendering, despite several attempts, see Known Limitations. |
| **Latency/jitter visualization** | Every 3 seconds, each client measures its own RTT via ping/pong and computes jitter as the mean absolute deviation of its last 5 samples. This gets broadcast to the room and shown live next to each name, like `alice (you)  12ms +-4ms`. Verified live: the values update continuously and climb visibly under DevTools throttling. |
| **Horizontal scaling (written)** | A single server process currently holds all room state in memory. Running multiple instances would need a shared broadcast layer, Redis pub/sub for example, so a message received by instance A can still reach clients connected to instance B. You'd also need either sticky-routing so each room lives on one instance, or move presence state into that shared layer too. Not implemented, just discussed here. |

---

## Known Limitations

- No persistence across a server restart. All room and presence state lives in memory only.
- No horizontal scaling implemented (see the Bonus Features table above).
- No authentication. Any client can join any room with a self-declared `clientId`, which is explicitly fine per the assignment's own FAQ.
- A page refresh creates a new `clientId` rather than resuming a session. Reconnects within a session correctly keep the same identity, refreshes don't.
- The client and server protocol types are manually kept in sync, not shared through a package.
- Deployed on Render's free tier, which spins down after about 15 minutes idle. The first connection after that can take 30-60 seconds to wake up.
- Only one reaction type (the fire emoji) is implemented, in line with the assignment's own advice not to over-build.
- Reconnect and duplicate-cursor testing was mostly verified by restarting the server, since neither OS-level network toggling nor Chrome DevTools' "Offline" mode reliably affects an already-established WebSocket connection in this setup. I attempted a fully isolated recording of same-session auto-reconnect without a page refresh but never got a clean capture.
- The visual proof for reconciliation (see Bonus Features) was inconclusive despite several attempts. The logic itself was verified through direct protocol-level message injection instead.

---

## Time Spent

Roughly 14-16 hours total, spread across 3 days:

- Project setup and the server (protocol, room, room manager, heartbeat): ~2 hrs
- Client transport, interpolation, throttled cursor sync, and getting the first working multi-tab demo up: ~2.5 hrs
- Debugging (a React StrictMode double-connect issue, the heartbeat multi-sweep bug, a presence UI layout bug): ~2 hrs
- Reactions, presence UI, ordering/sequence numbers: ~1.5 hrs
- Disconnect/reconnect handling and testing: ~1.5 hrs
- Deployment to Render, server and client, WebSocket URL and PORT config: ~1.5 hrs
- CI pipeline (GitHub Actions, type-check plus build): ~0.5 hrs
- Bonus features, extrapolation, adaptive throttling, reconciliation, latency UI: ~3.5 hrs
- Documentation (README, ARCHITECTURE): ~1.5 hrs

---

## AI Tools Used

I used Claude (Anthropic) as a coding and debugging assistant during the project. I used it to discuss implementation approaches, generate suggestions when I was stuck, and help investigate issues such as the heartbeat multi-sweep bug, React StrictMode double-connection issue, and Render deployment configuration. I reviewed, modified, and tested the resulting code myself across multi-tab, multi-device, network throttling, malformed-message, and reconnect scenarios. I understand and can explain the implementation and design decisions in the repository.
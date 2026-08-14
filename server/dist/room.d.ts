import type { WebSocket } from "ws";
import type { ClientMessage } from "./protocol.js";
export declare class Room {
    private clients;
    join(clientId: string, ws: WebSocket): void;
    leave(clientId: string): void;
    markAlive(clientId: string): void;
    sweepDeadClients(): void;
    handleAction(clientId: string, action: ClientMessage): void;
    private send;
    private broadcast;
    size(): number;
}
//# sourceMappingURL=room.d.ts.map
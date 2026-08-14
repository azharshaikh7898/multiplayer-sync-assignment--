export type ClientMessage = {
    type: "join";
    clientId: string;
    roomId: string;
} | {
    type: "cursor";
    clientId: string;
    seq: number;
    x: number;
    y: number;
} | {
    type: "reaction";
    clientId: string;
    seq: number;
    x: number;
    y: number;
    reaction: string;
} | {
    type: "leave";
    clientId: string;
};
export type ServerMessage = {
    type: "welcome";
    clientId: string;
    participants: Presence[];
} | {
    type: "presence";
    clientId: string;
    status: "join" | "leave";
} | {
    type: "cursor";
    clientId: string;
    seq: number;
    x: number;
    y: number;
} | {
    type: "reaction";
    clientId: string;
    seq: number;
    x: number;
    y: number;
    reaction: string;
} | {
    type: "error";
    message: string;
};
export interface Presence {
    clientId: string;
    x: number;
    y: number;
}
export declare function parseClientMessage(raw: unknown): ClientMessage | null;
//# sourceMappingURL=protocol.d.ts.map
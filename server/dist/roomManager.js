import { Room } from "./room.js";
export class RoomManager {
    rooms = new Map();
    getOrCreate(roomId) {
        let room = this.rooms.get(roomId);
        if (!room) {
            room = new Room();
            this.rooms.set(roomId, room);
        }
        return room;
    }
    // Called after a client leaves — clean up empty rooms so they don't leak memory.
    removeIfEmpty(roomId) {
        const room = this.rooms.get(roomId);
        if (room && room.size() === 0) {
            this.rooms.delete(roomId);
        }
    }
}
//# sourceMappingURL=roomManager.js.map
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Store all rooms
const rooms = {};

// Generate a random 4-letter room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Broadcast to all players in a room except the sender
function broadcastToRoom(roomCode, message, excludeWs = null) {
    const room = rooms[roomCode];
    if (!room) return;
    const msg = JSON.stringify(message);
    for (const player of Object.values(room.players)) {
        if (player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(msg);
        }
    }
}

// Send to all players in a room including sender
function sendToRoom(roomCode, message) {
    broadcastToRoom(roomCode, message);
}

// Send to a specific player
function sendTo(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

wss.on('connection', (ws) => {
    let playerRoomCode = null;
    let playerId = null;

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            return;
        }

        switch (msg.type) {
            case 'create_room': {
                // Generate unique room code
                let code;
                do {
                    code = generateRoomCode();
                } while (rooms[code]);

                playerId = msg.player_name || 'Player1';
                playerRoomCode = code;

                rooms[code] = {
                    host: playerId,
                    players: {},
                    started: false,
                    current_level: 1,
                    level_wins: {},
                    ready_players: new Set(),
                    finished_players: new Set(),
                    death_placeholders: {}
                };

                rooms[code].players[playerId] = {
                    ws: ws,
                    name: playerId,
                    ready: false,
                    alive: true,
                    position: { x: 360, y: 400 },
                    color: msg.color || '#4dff7c'
                };

                sendTo(ws, {
                    type: 'room_created',
                    room_code: code,
                    player_id: playerId,
                    is_host: true
                });

                console.log(`Room ${code} created by ${playerId}`);
                break;
            }

            case 'join_room': {
                const code = (msg.room_code || '').toUpperCase();
                playerId = msg.player_name || 'Player' + Math.floor(Math.random() * 999);
                
                if (!rooms[code]) {
                    sendTo(ws, { type: 'error', message: 'Room not found' });
                    return;
                }

                if (rooms[code].started) {
                    sendTo(ws, { type: 'error', message: 'Game already started' });
                    return;
                }

                if (Object.keys(rooms[code].players).length >= 10) {
                    sendTo(ws, { type: 'error', message: 'Room is full' });
                    return;
                }

                // Ensure unique name
                let baseName = playerId;
                let counter = 1;
                while (rooms[code].players[playerId]) {
                    playerId = baseName + counter;
                    counter++;
                }

                playerRoomCode = code;

                rooms[code].players[playerId] = {
                    ws: ws,
                    name: playerId,
                    ready: false,
                    alive: true,
                    position: { x: 360, y: 400 },
                    color: msg.color || '#ff6b6b'
                };

                // Send room info to the joining player
                const existingPlayers = {};
                for (const [id, p] of Object.entries(rooms[code].players)) {
                    existingPlayers[id] = {
                        name: p.name,
                        ready: p.ready,
                        color: p.color
                    };
                }

                sendTo(ws, {
                    type: 'room_joined',
                    room_code: code,
                    player_id: playerId,
                    is_host: false,
                    players: existingPlayers,
                    host: rooms[code].host
                });

                // Notify others
                broadcastToRoom(code, {
                    type: 'player_joined',
                    player_id: playerId,
                    player_name: playerId,
                    color: rooms[code].players[playerId].color
                }, ws);

                console.log(`${playerId} joined room ${code}`);
                break;
            }

            case 'player_ready': {
                if (!playerRoomCode || !rooms[playerRoomCode]) return;
                const room = rooms[playerRoomCode];
                
                room.players[playerId].ready = msg.ready;
                
                if (msg.ready) {
                    room.ready_players.add(playerId);
                } else {
                    room.ready_players.delete(playerId);
                }

                broadcastToRoom(playerRoomCode, {
                    type: 'player_ready_update',
                    player_id: playerId,
                    ready: msg.ready,
                    ready_count: room.ready_players.size,
                    total_count: Object.keys(room.players).length
                });
                break;
            }

            case 'start_game': {
                if (!playerRoomCode || !rooms[playerRoomCode]) return;
                const room = rooms[playerRoomCode];
                
                // Only host can start
                if (playerId !== room.host) return;
                
                // Check all players ready
                if (room.ready_players.size < Object.keys(room.players).length) {
                    sendTo(ws, { type: 'error', message: 'Not all players are ready' });
                    return;
                }

                room.started = true;
                room.current_level = 1;
                room.finished_players = new Set();
                room.death_placeholders = {};

                // Reset all players alive
                for (const p of Object.values(room.players)) {
                    p.alive = true;
                }

                // Initialize level wins tracking
                for (const id of Object.keys(room.players)) {
                    if (!room.level_wins[id]) {
                        room.level_wins[id] = 0;
                    }
                }

                // Send start to all players
                const playerList = {};
                for (const [id, p] of Object.entries(room.players)) {
                    playerList[id] = { name: p.name, color: p.color };
                }

                for (const [id, p] of Object.entries(room.players)) {
                    sendTo(p.ws, {
                        type: 'game_start',
                        level: 1,
                        players: playerList,
                        your_id: id
                    });
                }

                console.log(`Game started in room ${playerRoomCode}`);
                break;
            }

            case 'player_position': {
                if (!playerRoomCode || !rooms[playerRoomCode]) return;
                
                broadcastToRoom(playerRoomCode, {
                    type: 'player_moved',
                    player_id: playerId,
                    x: msg.x,
                    y: msg.y
                }, ws);
                break;
            }

            case 'player_died': {
                if (!playerRoomCode || !rooms[playerRoomCode]) return;
                const room = rooms[playerRoomCode];
                
                room.players[playerId].alive = false;
                room.death_placeholders[playerId] = { x: msg.x, y: msg.y };

                broadcastToRoom(playerRoomCode, {
                    type: 'player_died',
                    player_id: playerId,
                    x: msg.x,
                    y: msg.y
                }, ws);

                // Also confirm to the dying player
                sendTo(ws, {
                    type: 'you_died',
                    x: msg.x,
                    y: msg.y
                });
                break;
            }

            case 'revive_player': {
                if (!playerRoomCode || !rooms[playerRoomCode]) return;
                const room = rooms[playerRoomCode];
                const targetId = msg.target_id;

                if (room.death_placeholders[targetId]) {
                    room.players[targetId].alive = true;
                    const pos = room.death_placeholders[targetId];
                    delete room.death_placeholders[targetId];

                    // Notify everyone including the revived player
                    for (const [id, p] of Object.entries(room.players)) {
                        sendTo(p.ws, {
                            type: 'player_revived',
                            revived_id: targetId,
                            reviver_id: playerId,
                            x: pos.x,
                            y: pos.y
                        });
                    }

                    console.log(`${playerId} revived ${targetId} in room ${playerRoomCode}`);
                }
                break;
            }

            case 'player_finished': {
                if (!playerRoomCode || !rooms[playerRoomCode]) return;
                const room = rooms[playerRoomCode];
                
                room.finished_players.add(playerId);

                // First player to finish wins this level
                if (room.finished_players.size === 1) {
                    room.level_wins[playerId] = (room.level_wins[playerId] || 0) + 1;
                }

                // Notify everyone
                for (const [id, p] of Object.entries(room.players)) {
                    sendTo(p.ws, {
                        type: 'player_finished',
                        player_id: playerId,
                        is_first: room.finished_players.size === 1,
                        finished_count: room.finished_players.size,
                        total_count: Object.keys(room.players).length,
                        level_wins: room.level_wins
                    });
                }

                // If first player finished, start countdown for next level
                if (room.finished_players.size === 1) {
                    setTimeout(() => {
                        if (!rooms[playerRoomCode]) return;
                        advanceLevel(playerRoomCode);
                    }, 3000); // 3 second delay before next level
                }
                break;
            }

            case 'lobby_position': {
                if (!playerRoomCode || !rooms[playerRoomCode]) return;
                
                broadcastToRoom(playerRoomCode, {
                    type: 'lobby_player_moved',
                    player_id: playerId,
                    x: msg.x,
                    y: msg.y
                }, ws);
                break;
            }
        }
    });

    ws.on('close', () => {
        if (playerRoomCode && rooms[playerRoomCode]) {
            const room = rooms[playerRoomCode];
            
            delete room.players[playerId];
            room.ready_players.delete(playerId);
            room.finished_players.delete(playerId);
            delete room.death_placeholders[playerId];

            broadcastToRoom(playerRoomCode, {
                type: 'player_left',
                player_id: playerId
            });

            console.log(`${playerId} left room ${playerRoomCode}`);

            // If room is empty, delete it
            if (Object.keys(room.players).length === 0) {
                delete rooms[playerRoomCode];
                console.log(`Room ${playerRoomCode} deleted (empty)`);
            }
            // If host left, assign new host
            else if (room.host === playerId) {
                const newHost = Object.keys(room.players)[0];
                room.host = newHost;
                
                for (const [id, p] of Object.entries(room.players)) {
                    sendTo(p.ws, {
                        type: 'new_host',
                        host_id: newHost
                    });
                }
                console.log(`New host in ${playerRoomCode}: ${newHost}`);
            }
        }
    });
});

function advanceLevel(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.current_level++;
    room.finished_players = new Set();
    room.death_placeholders = {};

    // Reset all players alive
    for (const p of Object.values(room.players)) {
        p.alive = true;
    }

    // Check if game is over (after level 20)
    if (room.current_level > 20) {
        for (const [id, p] of Object.entries(room.players)) {
            sendTo(p.ws, {
                type: 'game_over',
                level_wins: room.level_wins
            });
        }
        room.started = false;
        console.log(`Game over in room ${roomCode}`);
        return;
    }

    // Send next level to all players
    for (const [id, p] of Object.entries(room.players)) {
        sendTo(p.ws, {
            type: 'next_level',
            level: room.current_level,
            level_wins: room.level_wins
        });
    }

    console.log(`Room ${roomCode} advancing to level ${room.current_level}`);
}

console.log(`Dodge Server running on port ${PORT}`);
console.log(`Waiting for connections...`);

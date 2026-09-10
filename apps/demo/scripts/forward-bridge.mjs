import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

const bridgePort = Number.parseInt(process.env.FORWARD_BRIDGE_PORT ?? "3002", 10);
const listeners = new Map();
const connections = new Map();
let browser;
let nextConnectionId = 1;

function frame(opcode, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const header = [];
    header.push(0x80 | opcode);
    if (body.length < 126) {
        header.push(body.length);
    } else if (body.length <= 0xffff) {
        header.push(126, body.length >> 8, body.length & 0xff);
    } else {
        header.push(127, 0, 0, 0, 0, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff);
    }
    return Buffer.concat([Buffer.from(header), body]);
}

function sendJson(message) {
    browser?.write(frame(1, JSON.stringify(message)));
}

function sendData(connectionId, data) {
    const id = Buffer.allocUnsafe(4);
    id.writeUInt32BE(connectionId);
    browser?.write(frame(2, Buffer.concat([id, data])));
}

function closeConnection(connectionId) {
    const socket = connections.get(connectionId);
    if (socket) {
        connections.delete(connectionId);
        socket.destroy();
    }
}

function startListener(port) {
    if (listeners.has(port)) {
        sendJson({ type: "listening", port });
        return;
    }

    const server = createTcpServer((socket) => {
        if (!browser) {
            socket.destroy();
            return;
        }

        const connectionId = nextConnectionId++;
        connections.set(connectionId, socket);
        sendJson({ type: "connection", connectionId, port });
        socket.on("data", (data) => sendData(connectionId, data));
        socket.on("close", () => {
            connections.delete(connectionId);
            sendJson({ type: "closed", connectionId });
        });
        socket.on("error", () => socket.destroy());
    });

    server.on("error", (error) => sendJson({ type: "error", message: error.message }));
    server.listen(port, "127.0.0.1", () => {
        listeners.set(port, server);
        sendJson({ type: "listening", port });
    });
}

function receiveMessage(message) {
    if (message.type === "listen" && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) {
        startListener(message.port);
    } else if (message.type === "close") {
        closeConnection(message.connectionId);
    }
}

function receiveFrame(socket, state, chunk) {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (state.buffer.length >= 2) {
        const first = state.buffer[0];
        const second = state.buffer[1];
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (state.buffer.length < 4) return;
            length = state.buffer.readUInt16BE(offset);
            offset += 2;
        } else if (length === 127) {
            if (state.buffer.length < 10) return;
            length = state.buffer.readUInt32BE(6);
            offset += 8;
        }
        if (!masked || state.buffer.length < offset + 4 + length) return;
        const mask = state.buffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        state.buffer = state.buffer.subarray(offset + length);

        const opcode = first & 0x0f;
        if (opcode === 8) {
            socket.end();
        } else if (opcode === 1) {
            try { receiveMessage(JSON.parse(payload.toString())); } catch {}
        } else if (opcode === 2 && payload.length >= 4) {
            const connectionId = payload.readUInt32BE();
            connections.get(connectionId)?.write(payload.subarray(4));
        }
    }
}

const server = createServer((request, response) => {
    response.writeHead(404);
    response.end();
});

server.on("upgrade", (request, socket) => {
    if (request.url !== "/forward" || !request.headers["sec-websocket-key"]) {
        socket.destroy();
        return;
    }

    browser?.destroy();
    const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    browser = socket;
    const state = { buffer: Buffer.alloc(0) };
    socket.on("data", (chunk) => receiveFrame(socket, state, chunk));
    socket.on("close", () => {
        if (browser === socket) browser = undefined;
        for (const connectionId of connections.keys()) closeConnection(connectionId);
    });
    sendJson({ type: "ready" });
});

server.listen(bridgePort, "127.0.0.1", () => {
    console.log(`Forward bridge listening on ws://127.0.0.1:${bridgePort}/forward`);
});
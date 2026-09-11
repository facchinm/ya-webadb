import { DefaultButton, MessageBar, PrimaryButton, Stack, StackItem, Text, TextField } from "@fluentui/react";
import { encodeUtf8 } from "@yume-chan/adb";
import { Consumable, WritableStream } from "@yume-chan/stream-extra";
import { observer } from "mobx-react-lite";
import { NextPage } from "next";
import dynamic from "next/dynamic";
import Head from "next/head";
import { useEffect, useRef, useState } from "react";
import { GLOBAL_STATE } from "../state";
import { RouteStackProps } from "../utils";

interface BridgeMessage {
    type: string;
    port?: number;
    connectionId?: number;
    message?: string;
}

interface SocketEvent {
    connectionId: number;
    direction: "Local -> device" | "Device -> local";
    preview: string;
}

function formatData(data: Uint8Array) {
    const preview = data.slice(0, 48);
    const hex = Array.from(preview, (value) => value.toString(16).padStart(2, "0")).join(" ");
    const text = new TextDecoder().decode(preview).replace(/[^\x20-\x7e]/g, ".");
    const suffix = data.length > preview.length ? " ..." : "";
    return `${data.length} bytes | ${hex}${suffix} | ${text}${suffix}`;
}

const ForwardClient: NextPage = () => {
    const [port, setPort] = useState("");
    const [status, setStatus] = useState("Starting local bridge connection...");
    const [listeningPorts, setListeningPorts] = useState<number[]>([]);
    const [socketEvents, setSocketEvents] = useState<SocketEvent[]>([]);
    const [requesting, setRequesting] = useState(false);
    const socketRef = useRef<WebSocket>();
    const writers = useRef(new Map<number, WritableStreamDefaultWriter<Consumable<Uint8Array>>>());

    const appendSocketEvent = (connectionId: number, direction: SocketEvent["direction"], data: Uint8Array) => {
        const event = { connectionId, direction, preview: formatData(data) };
        setSocketEvents((events) => [...events, event].slice(-100));
    };

    useEffect(() => {
        const socket = new WebSocket(`ws://${location.hostname}:3002/forward`);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;
        socket.onopen = () => setStatus("Bridge connected. Add a local port to forward.");
        socket.onerror = () => setStatus("Bridge unavailable. Start scripts/forward-bridge.mjs on this computer.");
        socket.onclose = () => setStatus("Bridge disconnected.");
        socket.onmessage = async (event) => {
            if (typeof event.data !== "string") {
                const data = new Uint8Array(event.data);
                const connectionId = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
                appendSocketEvent(connectionId, "Local -> device", data.slice(4));
                await writers.current.get(connectionId)?.write(new Consumable(data.slice(4)));
                return;
            }

            const message = JSON.parse(event.data) as BridgeMessage;
            if (message.type === "ready") return;
            if (message.type === "listening" && message.port) {
                setListeningPorts((ports) => ports.includes(message.port!) ? ports : [...ports, message.port!]);
                setStatus(`Listening on 127.0.0.1:${message.port}`);
            } else if (message.type === "error") {
                setStatus(message.message ?? "Bridge error");
            } else if (message.type === "closed" && message.connectionId) {
                await writers.current.get(message.connectionId)?.close();
                writers.current.delete(message.connectionId);
            } else if (message.type === "connection" && message.connectionId && message.port) {
                setStatus(`Connecting 127.0.0.1:${message.port} to tcp:${message.port} on the device...`);
                const connectionId = message.connectionId;
                const adb = GLOBAL_STATE.adb;
                if (!adb) {
                    socket.send(JSON.stringify({ type: "close", connectionId }));
                    return;
                }
                try {
                    const remote = await adb.createSocket(`tcp:${message.port}`);
                    writers.current.set(connectionId, remote.writable.getWriter());
                    socket.send(JSON.stringify({ type: "open", connectionId }));
                    setStatus(`Forwarding 127.0.0.1:${message.port} to tcp:${message.port} on the device.`);
                    remote.readable.pipeTo(new WritableStream({
                        write(chunk) {
                            appendSocketEvent(connectionId, "Device -> local", chunk);
                            const header = new Uint8Array(4 + chunk.length);
                            new DataView(header.buffer).setUint32(0, connectionId);
                            header.set(chunk, 4);
                            socket.send(header);
                        },
                    })).finally(() => socket.send(JSON.stringify({ type: "close", connectionId })));
                } catch (error) {
                    setStatus(error instanceof Error ? error.message : "Unable to connect to the remote port.");
                    socket.send(JSON.stringify({ type: "close", connectionId }));
                }
            }
        };
        return () => socket.close();
    }, []);

    const startForward = () => {
        const parsedPort = Number.parseInt(port, 10);
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            setStatus("Enter a TCP port from 1 to 65535.");
            return;
        }
        socketRef.current?.send(JSON.stringify({ type: "listen", port: parsedPort }));
    };

    const sendGetRequest = async () => {
        const parsedPort = Number.parseInt(port, 10);
        const adb = GLOBAL_STATE.adb;
        if (!adb || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            setStatus("Connect a device and enter a TCP port from 1 to 65535.");
            return;
        }

        const connectionId = 0;
        setRequesting(true);
        setStatus(`Sending HTTP GET to tcp:${parsedPort} on the device...`);
        let remote: Awaited<ReturnType<typeof adb.createSocket>> | undefined;
        try {
            remote = await adb.createSocket(`tcp:${parsedPort}`);
            const writer = remote.writable.getWriter();
            const request = encodeUtf8("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
            appendSocketEvent(connectionId, "Local -> device", request);
            await writer.write(new Consumable(request));
            writer.releaseLock();

            await remote.readable.pipeTo(new WritableStream({
                write(chunk) {
                    appendSocketEvent(connectionId, "Device -> local", chunk);
                },
            }));
            setStatus(`HTTP response received from tcp:${parsedPort}.`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Unable to send the HTTP request.");
        } finally {
            try {
                await remote?.close();
            } catch {
                // The HTTP server may already have closed the device socket.
            }
            setRequesting(false);
        }
    };

    return (
        <Stack {...RouteStackProps} tokens={{ childrenGap: 12 }}>
            <Head><title>Forward - Tango</title></Head>
            <StackItem><MessageBar>{status}</MessageBar></StackItem>
            <Stack horizontal tokens={{ childrenGap: 8 }} verticalAlign="end">
                <TextField label="TCP port" value={port} onChange={(_, value) => setPort(value ?? "")} styles={{ root: { width: 220 } }} />
                <DefaultButton text="Forward" disabled={!GLOBAL_STATE.adb} onClick={startForward} />
                <PrimaryButton text="Send HTTP GET" disabled={!GLOBAL_STATE.adb || requesting} onClick={sendGetRequest} />
            </Stack>
            <StackItem><Text>Each listener forwards 127.0.0.1:PORT to tcp:PORT on the connected device.</Text></StackItem>
            {listeningPorts.map((listeningPort) => <StackItem key={listeningPort}><Text>127.0.0.1:{listeningPort} to tcp:{listeningPort}</Text></StackItem>)}
            {socketEvents.length > 0 && (
                <StackItem>
                    <Text variant="mediumPlus">Socket traffic</Text>
                    {socketEvents.map((event, index) => (
                        <pre key={`${event.connectionId}-${index}`} style={{ margin: "6px 0", overflowX: "auto", whiteSpace: "pre-wrap" }}>
                            #{event.connectionId} {event.direction}: {event.preview}
                        </pre>
                    ))}
                </StackItem>
            )}
        </Stack>
    );
};

const Forward = dynamic(() => Promise.resolve(observer(ForwardClient)), {
    ssr: false,
});

export default Forward;
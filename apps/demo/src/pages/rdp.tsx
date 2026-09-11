import { MessageBar, Stack, StackItem, Text } from "@fluentui/react";
import { makeStyles, shorthands } from "@griffel/react";
import { Consumable, WritableStream } from "@yume-chan/stream-extra";
import { observer } from "mobx-react-lite";
import { NextPage } from "next";
import dynamic from "next/dynamic";
import Head from "next/head";
import { SyntheticEvent, useCallback, useState } from "react";
import { GLOBAL_STATE } from "../state";
import { RouteStackProps } from "../utils";

const useClasses = makeStyles({
    viewer: {
        width: "100%",
        height: "calc(100vh - 180px)",
        minHeight: "520px",
        ...shorthands.border("1px", "solid", "rgb(138, 136, 134)"),
    },
});

function parseTarget(url: string) {
    const match = /[?&]target=([^&]+)/.exec(url);
    if (!match) {
        return undefined;
    }

    const target = decodeURIComponent(match[1]);
    const separator = target.lastIndexOf(":");
    const port = Number.parseInt(target.slice(separator + 1), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return undefined;
    }

    const raw = separator > 0 ? target.slice(0, separator) : "";
    const host = (raw === "" ? "localhost" : raw).replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1") {
        return { service: `tcp:${port}`, host, port };
    }

    // A bare `tcp:<port>` only reaches the device's IPv4 loopback, so an IPv6
    // service needs a bracketed literal such as tcp:[::1]:3389.
    return { service: `tcp:${host.includes(":") ? `[${host}]` : host}:${port}`, host, port };
}

// Some adbd builds accept only a bare `tcp:<port>`, which cannot reach an
// IPv6-only service, so fall back to piping through a tool on the device.
async function buildRelayCommand(
    adb: NonNullable<typeof GLOBAL_STATE.adb>,
    host: string,
    port: number
) {
    const probe = await adb.subprocess.spawnAndWaitLegacy([
        "sh",
        "-c",
        "command -v socat || command -v nc || command -v ncat",
    ]);
    const tool = probe
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("/"));
    if (!tool) {
        return undefined;
    }

    const ipv6 = host.includes(":");
    return tool.endsWith("socat")
        ? `${tool} - TCP:${ipv6 ? `[${host}]` : host}:${port}`
        : `${tool}${ipv6 ? " -6" : ""} ${host} ${port}`;
}

// grdpwasm speaks RDP over a WebSocket to its Go proxy. This stand-in keeps the
// same interface but carries the bytes over the device's ADB socket instead.
function createAdbWebSocketClass(report: (message: string) => void) {
    return class AdbWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        url: string;
        binaryType = "arraybuffer";
        readyState = 0;
        onopen: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        onmessage: ((event: unknown) => void) | null = null;
        onclose: ((event: unknown) => void) | null = null;

        private socket: { close(): unknown } | undefined;
        private writer: { write(chunk: Consumable<Uint8Array>): Promise<void> } | undefined;
        private queue: Promise<unknown> = Promise.resolve();
        private closeFired = false;
        private bytesReceived = 0;
        private bytesSent = 0;
        private label = "";
        private trafficTimer: ReturnType<typeof setTimeout> | undefined;

        constructor(url: string) {
            this.url = url;
            void this.open(url);
        }

        private async open(url: string) {
            const adb = GLOBAL_STATE.adb;
            if (!adb) {
                this.fail("No device is connected in this tab. Connect the board above, then press Connect.");
                return;
            }

            const target = parseTarget(url);
            if (!target) {
                this.fail(`Could not read a target host and port from "${url}".`);
                return;
            }

            const { service, host, port } = target;
            let socket;
            let label = service;
            try {
                report(`Opening ${service} on the device...`);
                socket = await adb.createSocket(service);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                report(`${service} was refused (${reason}). Looking for a relay on the device...`);
                try {
                    const relay = await buildRelayCommand(adb, host, port);
                    if (!relay) {
                        this.fail(
                            `The device refused ${service} and has no socat or nc to relay through. Install one on the device, or make the service listen on IPv4.`
                        );
                        return;
                    }

                    label = relay;
                    report(`Relaying through "${relay}"...`);
                    socket = await adb.createSocket(`exec:${relay}`);
                } catch (relayError) {
                    const relayReason =
                        relayError instanceof Error ? relayError.message : String(relayError);
                    this.fail(`Could not reach ${host}:${port} on the device: ${relayReason}`);
                    return;
                }
            }

            this.socket = socket;
            this.writer = socket.writable.getWriter();
            this.readyState = AdbWebSocket.OPEN;
            this.label = label;
            report(`${label} is open. Negotiating RDP...`);
            this.onopen?.({ type: "open" });

            socket.readable
                .pipeTo(
                    new WritableStream<Uint8Array>({
                        write: (chunk) => {
                            this.bytesReceived += chunk.length;
                            this.reportTraffic();
                            const copy = new Uint8Array(chunk);
                            this.onmessage?.({ type: "message", data: copy.buffer });
                        },
                    })
                )
                .catch(() => undefined)
                .then(() => {
                    report(
                        `${label} closed after sending ${this.bytesSent} bytes and receiving ${this.bytesReceived} bytes.`
                    );
                    this.fireClose();
                });
        }

        private reportTraffic() {
            if (this.trafficTimer) {
                return;
            }

            this.trafficTimer = setTimeout(() => {
                this.trafficTimer = undefined;
                report(`${this.label}: sent ${this.bytesSent} bytes, received ${this.bytesReceived} bytes.`);
            }, 400);
        }

        send(data: ArrayBuffer | ArrayBufferView) {
            if (this.readyState !== AdbWebSocket.OPEN) {
                return;
            }

            // The buffer comes from the iframe realm, so `instanceof` would not match.
            const view = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            const payload = new Uint8Array(view);
            this.bytesSent += payload.length;
            this.reportTraffic();
            this.queue = this.queue
                .then(() => this.writer?.write(new Consumable(payload)))
                .catch(() => undefined);
        }

        close() {
            if (this.readyState === AdbWebSocket.CLOSED) {
                return;
            }

            this.readyState = AdbWebSocket.CLOSING;
            this.queue = this.queue
                .then(() => this.socket?.close())
                .catch(() => undefined)
                .then(() => this.fireClose());
        }

        private fail(message: string) {
            report(message);
            // Callers attach their handlers after the constructor returns, so a
            // synchronous failure would be dropped and leave grdpwasm waiting forever.
            setTimeout(() => {
                this.onerror?.({ type: "error" });
                this.fireClose();
            }, 0);
        }

        // grdpwasm closes a Go channel from its close handler, so it must run once.
        private fireClose() {
            if (this.closeFired) {
                return;
            }

            this.closeFired = true;
            this.readyState = AdbWebSocket.CLOSED;
            clearTimeout(this.trafficTimer);
            this.onclose?.({ type: "close", code: 1000, reason: "", wasClean: true });
        }
    };
}

const RdpClient: NextPage = () => {
    const classes = useClasses();
    const [transportStatus, setTransportStatus] = useState<string | undefined>();

    const handleLoad = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
        const frameWindow = event.currentTarget.contentWindow as
            | (Window & { WebSocket: unknown; __adbWebSocketInstalled?: boolean })
            | null;
        if (!frameWindow || frameWindow.__adbWebSocketInstalled) {
            return;
        }

        const NativeWebSocket = frameWindow.WebSocket as typeof WebSocket;
        const AdbWebSocket = createAdbWebSocketClass(setTransportStatus);
        frameWindow.WebSocket = function (url: string, protocols?: string | string[]) {
            return typeof url === "string" && url.includes("target=")
                ? new AdbWebSocket(url)
                : new NativeWebSocket(url, protocols);
        };
        frameWindow.__adbWebSocketInstalled = true;
    }, []);

    return (
        <Stack {...RouteStackProps} tokens={{ childrenGap: 12 }}>
            <Head><title>RDP Desktop - Tango</title></Head>
            <StackItem>
                <MessageBar>
                    {GLOBAL_STATE.adb
                        ? "Device connected. Set Port to 3389, enter the credentials, then press Connect."
                        : "Connect a device first, then set Port to 3389 and press Connect."}
                </MessageBar>
            </StackItem>
            {transportStatus && (
                <StackItem>
                    <Text>ADB transport: {transportStatus}</Text>
                </StackItem>
            )}
            <StackItem>
                <Text>
                    grdpwasm decodes RDP in the browser. Its WebSocket transport is replaced with the
                    device&apos;s ADB socket, so the desktop is fed straight from the device with no local
                    proxy. Host accepts localhost, an IPv4 address, or an IPv6 literal such as ::1.
                </Text>
            </StackItem>
            <iframe
                className={classes.viewer}
                src="/grdpwasm/index.html"
                title="RDP desktop"
                onLoad={handleLoad}
            />
        </Stack>
    );
};

export default dynamic(() => Promise.resolve(observer(RdpClient)), { ssr: false });
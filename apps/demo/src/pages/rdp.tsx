import { DefaultButton, MessageBar, Stack, StackItem, Text } from "@fluentui/react";
import { makeStyles, shorthands } from "@griffel/react";
import { NextPage } from "next";
import dynamic from "next/dynamic";
import Head from "next/head";
import { useState } from "react";
import { RouteStackProps } from "../utils";

const useClasses = makeStyles({
    viewer: {
        width: "100%",
        height: "calc(100vh - 190px)",
        minHeight: "480px",
        ...shorthands.border("1px", "solid", "rgb(138, 136, 134)"),
    },
});

const RdpClient: NextPage = () => {
    const classes = useClasses();
    const [viewerStarted, setViewerStarted] = useState(false);

    return (
        <Stack {...RouteStackProps} tokens={{ childrenGap: 12 }}>
            <Head><title>RDP Desktop - Tango</title></Head>
            <StackItem>
                <MessageBar>
                    Start the local RDP viewer, create Forward port 3389, then open the desktop.
                </MessageBar>
            </StackItem>
            <Stack horizontal tokens={{ childrenGap: 8 }}>
                <DefaultButton text="Open RDP Desktop" onClick={() => setViewerStarted(true)} />
                <DefaultButton text="Open in new tab" href="http://localhost:8080/guacamole/" target="_blank" />
            </Stack>
            <StackItem>
                <Text>Viewer endpoint: localhost:8080. It connects through 127.0.0.1:3389 to tcp:3389 on the connected board.</Text>
            </StackItem>
            {viewerStarted && <iframe className={classes.viewer} src="http://localhost:8080/guacamole/" title="Forwarded RDP desktop" />}
        </Stack>
    );
};

export default dynamic(() => Promise.resolve(RdpClient), { ssr: false });
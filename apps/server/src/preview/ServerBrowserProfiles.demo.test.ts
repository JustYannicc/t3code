import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as PreviewBrowser from "./PreviewBrowser.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const runDemo = process.env.T3_RUN_SERVER_BROWSER_PROFILE_DEMO === "1";
const nodeServices = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch);

if (runDemo) {
  it.live(
    "keeps a real browser profile cookie after the browser context restarts",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-browser-profile-demo-",
        });
        const browser = yield* PreviewBrowser.makePreviewBrowser({
          baseDir: home,
          wait: "5 minutes",
        });
        const executable = yield* browser.executable;
        const profilesDir = path.join(home, "userdata", "server-browser", "profiles");
        const options = { profilesDir, executable: () => Promise.resolve(executable) };
        const firstServer = yield* Effect.acquireRelease(
          Effect.sync(() => new ServerBrowserContexts(options)),
          (server) => Effect.promise(() => server.close()),
        );
        const firstContext = yield* Effect.promise(() => firstServer.contextFor("profile-work"));
        const expires = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 60 * 60;
        yield* Effect.promise(() =>
          firstContext.addCookies([
            {
              name: "t3repro",
              value: "1",
              url: "https://example.com",
              expires,
            },
          ]),
        );
        yield* Effect.promise(() => firstServer.close());

        const restartedServer = yield* Effect.acquireRelease(
          Effect.sync(() => new ServerBrowserContexts(options)),
          (server) => Effect.promise(() => server.close()),
        );
        const restartedContext = yield* Effect.promise(() =>
          restartedServer.contextFor("profile-work"),
        );
        const cookie = yield* Effect.promise(() => restartedContext.cookies("https://example.com"));

        expect(cookie.find((candidate) => candidate.name === "t3repro")?.value).toBe("1");
      }).pipe(Effect.scoped, Effect.provide(nodeServices)),
    { timeout: 6 * 60_000 },
  );
} else {
  it.skip("keeps a real browser profile cookie after the browser context restarts (opt in)", () => {});
}

// Copied to packages/provider-muse/src/server/ in a stripped upstream checkout and run there
// (rules provider/muse-updates-minimum-age, provider/muse-updates-first-seen-file,
// provider/release-age-file): Muse's automatic version check, an accepted exception, reports its
// channel's version only after this server has seen it there for 3 days (APP3-04); the channel
// publishes no release dates.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { settledSinceFirstSeen } from "@t3tools/provider-core/server/blackoutReleaseAge";
import { latestMuseVersion } from "./maintenance.ts";

const DAY = 86_400_000;

it.layer(NodeServices.layer)("blackout Muse release age", (it) => {
  it.effect("reports the channel's version once this server has seen it there for 3 days", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-muse-age-" });
      const file = `${dir}/first-seen.json`;
      const channel = { version: "1.4.3-R5018.1" };
      const requests: Array<string> = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(channel)));
      });
      const latest = (firstSeenFile?: string) =>
        latestMuseVersion({ MUSE_CHANNEL: "muse-stable" }, { fresh: true }, firstSeenFile).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(ProviderLatestVersions.layer),
        );

      expect(yield* latest(file)).toBeNull();
      const record = JSON.parse(yield* fs.readFileString(file));
      expect(record["muse-stable"].version).toBe("1.4.3-R5018.1");
      yield* TestClock.adjust(3 * DAY - 1);
      expect(yield* latest(file)).toBeNull();
      yield* TestClock.adjust(1);
      expect(yield* latest(file)).toBe("1.4.3-R5018.1");

      // The channel moves on: the new version starts its own wait.
      channel.version = "1.4.4-R5100.1";
      expect(yield* latest(file)).toBeNull();
      yield* TestClock.adjust(2 * DAY);
      expect(yield* latest(file)).toBeNull();
      yield* TestClock.adjust(DAY);
      expect(yield* latest(file)).toBe("1.4.4-R5100.1");

      // Without a record to keep, nothing is reported or looked up.
      const before = requests.length;
      expect(yield* latest()).toBeNull();
      expect(requests.length).toBe(before);
    }).pipe(Effect.scoped),
  );

  it.effect("a record it can't read, or dated ahead of the clock, starts the wait over", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-muse-age-" });
      const file = `${dir}/first-seen.json`;
      const settled = (version: string | null) => settledSinceFirstSeen({ file, channel: "muse-stable", version });
      yield* TestClock.adjust(10 * DAY);

      yield* fs.writeFileString(file, "{not json");
      expect(yield* settled("1.0.0-R1")).toBeNull();
      yield* TestClock.adjust(3 * DAY);
      expect(yield* settled("1.0.0-R1")).toBe("1.0.0-R1");

      yield* fs.writeFileString(file, JSON.stringify({ "muse-stable": { version: "1.0.0-R1", firstSeen: 100 * DAY } }));
      expect(yield* settled("1.0.0-R1")).toBeNull();
      yield* fs.writeFileString(file, JSON.stringify({ "muse-stable": { version: "1.0.0-R1", firstSeen: "0" } }));
      expect(yield* settled("1.0.0-R1")).toBeNull();

      expect(yield* settled(null)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("a record it can't write keeps every version back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-muse-age-" });
      const file = `${dir}/missing/first-seen.json`;
      expect(yield* settledSinceFirstSeen({ file, channel: "muse-stable", version: "1.0.0-R1" })).toBeNull();
      yield* TestClock.adjust(30 * DAY);
      expect(yield* settledSinceFirstSeen({ file, channel: "muse-stable", version: "1.0.0-R1" })).toBeNull();
    }).pipe(Effect.scoped),
  );
});

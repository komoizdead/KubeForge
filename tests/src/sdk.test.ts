import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  AuthManager,
  ConfigStore,
  EventBus,
  PermissionManager,
  SdkEvent,
  createSdk,
  type KubeforgePlugin,
} from "@kubeforge/core";

describe("configuration", () => {
  test("merges defaults with environment overrides", () => {
    const config = new ConfigStore({
      defaults: { log: { level: "info" }, region: "us-east" },
      envPrefix: "KUBEFORGE",
      env: {
        KUBEFORGE_LOG_LEVEL: "debug",
        KUBEFORGE_FEATURES_ENABLED: "true",
        KUBEFORGE_MAX_RETRIES: "3",
        KUBEFORGE_TAGS: '["a","b"]',
      },
    });

    assert.equal(config.get("log.level"), "debug");
    assert.equal(config.get("region"), "us-east");
    assert.equal(config.get("features.enabled"), true);
    assert.equal(config.get("max.retries"), 3);
    assert.deepEqual(config.get("tags"), ["a", "b"]);
  });

  test("tracks changes and returns isolated snapshots", () => {
    const changes: Array<[string, unknown]> = [];
    const config = new ConfigStore({
      defaults: { a: { b: 1 } },
      onChange: (key, value) => changes.push([key, value]),
    });

    config.set("a.c", 2);

    assert.equal(config.has("a.b"), true);
    assert.equal(config.has("a.missing"), false);
    assert.deepEqual(config.section("a"), { b: 1, c: 2 });
    assert.deepEqual(changes, [["a.c", 2]]);

    const snapshot = config.toObject() as { a: { b: number } };
    snapshot.a.b = 99;
    assert.equal(config.get("a.b"), 1);
    assert.throws(() => config.set("", 1), /must not be empty/);
  });
});

describe("events", () => {
  test("supports on, off, and once", () => {
    const bus = new EventBus();
    const seen: unknown[] = [];

    const unsubscribe = bus.on("task", (payload) => seen.push(payload));
    bus.emit("task", 1);
    unsubscribe();
    bus.emit("task", 2);

    bus.once("done", (payload) => seen.push(payload));
    bus.emit("done", 3);
    bus.emit("done", 4);

    assert.deepEqual(seen, [1, 3]);
    assert.equal(bus.listenerCount("task"), 0);
  });
});

describe("authentication", () => {
  test("authenticates and stamps the provider name", async () => {
    const auth = new AuthManager().register({
      name: "static",
      authenticate: (credentials) => ({ subject: String(credentials?.subject ?? "anonymous") }),
    });

    const identity = await auth.authenticate({ credentials: { subject: "alice" } });

    assert.equal(identity.subject, "alice");
    assert.equal(identity.provider, "static");
    assert.equal(auth.authenticated, true);
    assert.equal(auth.identity, identity);

    auth.clear();
    assert.equal(auth.authenticated, false);
  });

  test("requires a provider name when several are registered", async () => {
    const auth = new AuthManager()
      .register({ name: "one", authenticate: () => ({ subject: "a" }) })
      .register({ name: "two", authenticate: () => ({ subject: "b" }) });

    await assert.rejects(auth.authenticate(), /specify which one/);
    await assert.rejects(auth.authenticate({ provider: "missing" }), /is not registered/);
    assert.equal((await auth.authenticate({ provider: "two" })).subject, "b");
  });

  test("rejects invalid and expired identities", async () => {
    const auth = new AuthManager()
      .register({ name: "empty", authenticate: () => ({ subject: "" }) })
      .register({ name: "expired", authenticate: () => ({ subject: "a", expiresAt: new Date(Date.now() - 1000) }) });

    await assert.rejects(auth.authenticate({ provider: "empty" }), /without a subject/);
    await assert.rejects(auth.authenticate({ provider: "expired" }), /expired or invalid/);
    assert.throws(
      () => auth.register({ name: "empty", authenticate: () => ({ subject: "x" }) }),
      /already registered/,
    );
  });
});

describe("permissions", () => {
  test("grants actions through roles and wildcards", () => {
    const permissions = new PermissionManager({
      roles: { viewer: ["cluster.read"], operator: ["cluster.*"], admin: ["*"] },
    });

    assert.equal(permissions.can("cluster.read"), false);

    permissions.grant("viewer");
    assert.equal(permissions.can("cluster.read"), true);
    assert.equal(permissions.can("cluster.write"), false);
    assert.throws(() => permissions.require("cluster.write"), /Permission denied/);

    permissions.grant("operator");
    assert.equal(permissions.can("cluster.nodes.list"), true);

    permissions.grant("admin");
    assert.equal(permissions.can("anything.at.all"), true);
    assert.deepEqual(permissions.roles, ["viewer", "operator", "admin"]);

    permissions.revoke("admin");
    assert.equal(permissions.can("anything.at.all"), false);
  });

  test("rejects unknown roles", () => {
    const permissions = new PermissionManager();
    assert.throws(() => permissions.grant("missing"), /is not defined/);
  });
});

describe("plugins", () => {
  test("sets up, loads, and connects plugins in order", async () => {
    const events = new EventBus();
    const sdk = createSdk({ config: { log: { level: "error" } }, events });
    const order: string[] = [];
    const seen: unknown[] = [];

    const plugin: KubeforgePlugin = {
      name: "demo",
      version: "1.0.0",
      setup(context) {
        order.push(`setup:${context.config.get("log.level")}`);
        context.events.emit("plugin.setup", "demo");
      },
      connect() {
        order.push("connect");
      },
    };

    events.on(SdkEvent.PluginLoaded, (payload) => seen.push(payload));
    events.on("plugin.setup", (payload) => seen.push(payload));

    const loaded = await sdk.loadPlugin(plugin);
    assert.equal(loaded.name, "demo");
    assert.equal(sdk.state, "idle");
    assert.deepEqual(seen, ["demo", { name: "demo", version: "1.0.0" }]);

    const connected: unknown[] = [];
    events.on(SdkEvent.Connected, (payload) => connected.push(payload));

    await sdk.connect();
    await sdk.connect();

    assert.deepEqual(order, ["setup:error", "connect"]);
    assert.equal(sdk.state, "connected");
    assert.deepEqual(connected, [{ name: "kubeforge" }]);

    await assert.rejects(() => sdk.loadPlugin({ name: "demo" }), /already loaded/);
  });

  test("loads plugins from a module path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kubeforge-plugin-"));

    try {
      const pluginPath = join(dir, "plugin.mjs");
      await writeFile(
        pluginPath,
        'export default { name: "file-plugin", state: "idle", setup() { this.state = "ready"; } };\n',
        "utf8",
      );

      const sdk = createSdk({ config: { log: { level: "error" } } });
      const loaded = (await sdk.loadPlugin(pluginPath)) as KubeforgePlugin & { state?: string };

      assert.equal(loaded.name, "file-plugin");
      assert.equal(loaded.state, "ready");
      assert.deepEqual(sdk.plugins.list(), ["file-plugin"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sdk", () => {
  test("wires authentication, permissions, config, and emit together", async () => {
    const sdk = createSdk({
      name: "test-sdk",
      config: {
        log: { level: "error" },
        permissions: { roles: { viewer: ["cluster.read"] }, granted: ["viewer"] },
      },
    });

    sdk.auth.register({ name: "static", authenticate: () => ({ subject: "service-account" }) });

    const authenticated: unknown[] = [];
    const configChanged: unknown[] = [];
    sdk.events.on(SdkEvent.Authenticated, (payload) => authenticated.push(payload));
    sdk.events.on(SdkEvent.ConfigChanged, (payload) => configChanged.push(payload));

    const identity = await sdk.authenticate({ provider: "static" });

    assert.equal(identity.subject, "service-account");
    assert.deepEqual(authenticated, [identity]);
    assert.equal(sdk.permissions.can("cluster.read"), true);
    assert.equal(sdk.permissions.can("cluster.write"), false);

    sdk.config.set("log.level", "debug");
    assert.deepEqual(configChanged, [{ key: "log.level", value: "debug" }]);

    const custom: unknown[] = [];
    sdk.events.on("custom", (payload) => custom.push(payload));
    sdk.emit("custom", { ok: true });
    assert.deepEqual(custom, [{ ok: true }]);
  });
});

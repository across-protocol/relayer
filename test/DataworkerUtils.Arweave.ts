import { caching } from "@across-protocol/sdk";
import { persistDataToArweave, parseWinston } from "../src/dataworker/DataworkerUtils";
import { assertPromiseError, createSpyLogger, expect, sinon } from "./utils";

describe("persistDataToArweave topic cache seeding", () => {
  const tag = "bundles-123";
  const payload = { test: "value" };

  afterEach(() => {
    sinon.restore();
  });

  it("should seed the topic cache after a successful Arweave write", async () => {
    const { spyLogger } = createSpyLogger();
    const topicCache = new caching.MemoryCacheClient();
    const client = {
      getByTopic: sinon.stub().resolves([]),
      getAddress: sinon.stub().resolves("arweave-address"),
      getBalance: sinon.stub().resolves(parseWinston("2")),
      set: sinon.stub().resolves("tx-1"),
    } as unknown as caching.ArweaveClient;

    await persistDataToArweave(client, payload, spyLogger, tag, topicCache);

    const cachedPayload = await topicCache.get<string>(`arweave-topic:${tag}`);
    expect(JSON.parse(cachedPayload!)).to.deep.equal(payload);
  });

  it("should seed the topic cache even when the topic already exists on Arweave", async () => {
    const { spyLogger } = createSpyLogger();
    const topicCache = new caching.MemoryCacheClient();
    const set = sinon.stub().resolves("tx-2");
    const existingPayload = { ...payload };
    const client = {
      getByTopic: sinon.stub().resolves([{ data: existingPayload, hash: "tx-existing" }]),
      getAddress: sinon.stub().resolves("arweave-address"),
      getBalance: sinon.stub().resolves(parseWinston("2")),
      set,
    } as unknown as caching.ArweaveClient;

    await persistDataToArweave(client, payload, spyLogger, tag, topicCache);

    const cachedPayload = await topicCache.get<string>(`arweave-topic:${tag}`);
    expect(JSON.parse(cachedPayload!)).to.deep.equal(existingPayload);
    expect(set.called).to.be.false;
  });

  it("should not overwrite an existing topic cache entry", async () => {
    const { spyLogger } = createSpyLogger();
    const topicCache = new caching.MemoryCacheClient();
    const set = sinon.stub().resolves("tx-2");
    await topicCache.set(`arweave-topic:${tag}`, JSON.stringify({ stale: true }), 60);
    const client = {
      getByTopic: sinon.stub().resolves([{ data: { ...payload }, hash: "tx-existing" }]),
      getAddress: sinon.stub().resolves("arweave-address"),
      getBalance: sinon.stub().resolves(parseWinston("2")),
      set,
    } as unknown as caching.ArweaveClient;

    await persistDataToArweave(client, payload, spyLogger, tag, topicCache);

    const cachedPayload = await topicCache.get<string>(`arweave-topic:${tag}`);
    expect(JSON.parse(cachedPayload!)).to.deep.equal({ stale: true });
    expect(set.called).to.be.false;
  });

  it("should seed the topic cache when the Arweave write fails", async () => {
    const { spyLogger } = createSpyLogger();
    const topicCache = new caching.MemoryCacheClient();
    const client = {
      getByTopic: sinon.stub().resolves([]),
      getAddress: sinon.stub().resolves("arweave-address"),
      getBalance: sinon.stub().resolves(parseWinston("2")),
      set: sinon.stub().rejects(new Error("gateway write failed")),
    } as unknown as caching.ArweaveClient;

    await assertPromiseError(persistDataToArweave(client, payload, spyLogger, tag, topicCache), "gateway write failed");

    const cachedPayload = await topicCache.get<string>(`arweave-topic:${tag}`);
    expect(JSON.parse(cachedPayload!)).to.deep.equal(payload);
  });

  it("should fail fast when the Arweave tag is empty", async () => {
    const { spyLogger } = createSpyLogger();
    const topicCache = new caching.MemoryCacheClient();
    const getByTopic = sinon.stub().resolves([]);
    const client = {
      getByTopic,
      getAddress: sinon.stub().resolves("arweave-address"),
      getBalance: sinon.stub().resolves(parseWinston("2")),
      set: sinon.stub().resolves("tx-1"),
    } as unknown as caching.ArweaveClient;

    await assertPromiseError(
      persistDataToArweave(client, payload, spyLogger, "", topicCache),
      "Arweave tag is required"
    );

    expect(getByTopic.called).to.be.false;
  });
});

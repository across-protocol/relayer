import { CHAIN_IDs } from "@across-protocol/constants";
import { EventListener } from "../src/clients/EventListener";
import { createSpyLogger, expect } from "./utils";

describe("EventListener: provider resolution", function () {
  const chainId = CHAIN_IDs.MAINNET;
  const envKeys = [
    `RPC_PROVIDERS_${chainId}`,
    `RPC_PROVIDERS_TRANSPORT_${chainId}`,
    `RPC_PROVIDER_FOO_${chainId}`,
    `RPC_PROVIDER_BAR_${chainId}`,
    `RPC_PROVIDER_FOO_${chainId}_HEADERS`,
    `RPC_PROVIDER_FOO_${chainId}_HEADER_X-API-KEY`,
  ];
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  afterEach(function () {
    envKeys.forEach((key) => {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  it("preserves provider names when resolving HTTPS transports", function () {
    process.env[`RPC_PROVIDERS_${chainId}`] = "FOO,BAR";
    process.env[`RPC_PROVIDERS_TRANSPORT_${chainId}`] = "https";
    process.env[`RPC_PROVIDER_FOO_${chainId}`] = "https://foo.example";
    process.env[`RPC_PROVIDER_BAR_${chainId}`] = "https://bar.example";
    process.env[`RPC_PROVIDER_FOO_${chainId}_HEADERS`] = "x-api-key";
    process.env[`RPC_PROVIDER_FOO_${chainId}_HEADER_X-API-KEY`] = "secret";

    const listener = new EventListener(chainId, createSpyLogger().spyLogger, 1);
    const [foo] = (listener as unknown as { providers: { transport: { value: unknown } }[] }).providers;
    const headers = (foo.transport.value as { fetchOptions?: { headers?: unknown } }).fetchOptions?.headers;

    expect(headers).to.deep.equal({ "x-api-key": "secret" });
  });
});

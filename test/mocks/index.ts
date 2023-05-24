import { clients } from "@across-protocol/sdk-v2";

export class MockConfigStoreClient extends clients.mocks.MockConfigStoreClient {};
export class MockHubPoolClient extends clients.mocks.MockHubPoolClient {};
export class MockSpokePoolClient extends clients.mocks.MockSpokePoolClient {};

export * from "./MockBundleDataClient";
export * from "./MockProfitClient";
export * from "./MockAdapterManager";
export * from "./MockMultiCallerClient";
export * from "./MockTokenClient";
export * from "./MockTransactionClient";
export * from "./MockInventoryClient";

import { clients } from "@across-protocol/sdk-v2";

export class MockSpokePoolClient extends clients.mocks.MockSpokePoolClient {}

export * from "./MockConfigStoreClient";
export * from "./MockHubPoolClient";
export * from "./MockBundleDataClient";
export * from "./MockProfitClient";
export * from "./MockAdapterManager";
export * from "./MockMultiCallerClient";
export * from "./MockTokenClient";
export * from "./MockTransactionClient";
export * from "./MockInventoryClient";

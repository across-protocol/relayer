import { CHAIN_IDs } from "@across-protocol/constants";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { ethers, expect, sinon, toBNWei } from "./utils";
import { EvmAddress } from "../src/utils";

describe("Rebalancer bridge adapters", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("tracks OFT routes involving the hub chain", async function () {
    const [signer] = await ethers.getSigners();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new OftAdapter(TEST_LOGGER, {} as any, signer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).initialized = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._redisGetPendingBridgesPreDeposit = async () => ["tx-hash"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._getOftStatus = async () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._redisGetOrderDetails = async () => ({
      sourceChain: CHAIN_IDs.MAINNET,
      destinationChain: CHAIN_IDs.ARBITRUM,
      amountToTransfer: toBNWei("1", 6),
    });

    const pendingRebalances = await adapter.getPendingRebalances(EvmAddress.from(await signer.getAddress()));
    expect(pendingRebalances[CHAIN_IDs.ARBITRUM].USDT).to.equal(toBNWei("1", 6));
  });

  it("tracks CCTP routes involving the hub chain", async function () {
    const [signer] = await ethers.getSigners();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new CctpAdapter(TEST_LOGGER, {} as any, signer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).initialized = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._redisGetPendingBridgesPreDeposit = async () => ["1-tx-hash"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._getCctpAttestation = async () => ({ status: "pending", attestation: undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any)._redisGetOrderDetails = async () => ({
      sourceChain: CHAIN_IDs.MAINNET,
      destinationChain: CHAIN_IDs.BASE,
      amountToTransfer: toBNWei("2", 6),
    });

    const pendingRebalances = await adapter.getPendingRebalances(EvmAddress.from(await signer.getAddress()));
    expect(pendingRebalances[CHAIN_IDs.BASE].USDC).to.equal(toBNWei("2", 6));
  });
});

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

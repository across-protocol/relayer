import { CHAIN_IDs } from "@across-protocol/constants";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { ethers, expect, sinon, toBNWei } from "./utils";

describe("Rebalancer bridge adapters", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("tracks OFT routes involving the hub chain", async function () {
    const [signer] = await ethers.getSigners();
    const adapter = new OftAdapter(TEST_LOGGER, {} as any, signer);
    (adapter as any).initialized = true;
    (adapter as any)._redisGetPendingBridgesPreDeposit = async () => ["tx-hash"];
    (adapter as any)._getOftStatus = async () => undefined;
    (adapter as any)._redisGetOrderDetails = async () => ({
      sourceChain: CHAIN_IDs.MAINNET,
      destinationChain: CHAIN_IDs.ARBITRUM,
      amountToTransfer: toBNWei("1", 6),
    });

    const pendingRebalances = await adapter.getPendingRebalances();
    expect(pendingRebalances[CHAIN_IDs.ARBITRUM].USDT).to.equal(toBNWei("1", 6));
  });

  it("tracks CCTP routes involving the hub chain", async function () {
    const [signer] = await ethers.getSigners();
    const adapter = new CctpAdapter(TEST_LOGGER, {} as any, signer);
    (adapter as any).initialized = true;
    (adapter as any)._redisGetPendingBridgesPreDeposit = async () => ["1-tx-hash"];
    (adapter as any)._getCctpAttestation = async () => ({ status: "pending", attestation: undefined });
    (adapter as any)._redisGetOrderDetails = async () => ({
      sourceChain: CHAIN_IDs.MAINNET,
      destinationChain: CHAIN_IDs.BASE,
      amountToTransfer: toBNWei("2", 6),
    });

    const pendingRebalances = await adapter.getPendingRebalances();
    expect(pendingRebalances[CHAIN_IDs.BASE].USDC).to.equal(toBNWei("2", 6));
  });
});

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as any;

import { CHAIN_IDs } from "@across-protocol/constants";
import winston from "winston";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { ethers, expect, sinon, toBNWei } from "./utils";
import { EvmAddress } from "../src/utils";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { OrderDetails } from "../src/rebalancer/utils/interfaces";

type OftAdapterInternals = OftAdapter & {
  initialized: boolean;
  _redisGetPendingBridgesPreDeposit: (account: EvmAddress) => Promise<string[]>;
  _getOftStatus: (txHash: string) => Promise<string | undefined>;
  _redisGetOrderDetails: (cloid: string, account: EvmAddress) => Promise<OrderDetails>;
};

type CctpAdapterInternals = CctpAdapter & {
  initialized: boolean;
  _redisGetPendingBridgesPreDeposit: (account: EvmAddress) => Promise<string[]>;
  _getCctpAttestation: (txHash: string) => Promise<{ status: string; attestation?: string }>;
  _redisGetOrderDetails: (cloid: string, account: EvmAddress) => Promise<OrderDetails>;
};

function withOftInternals(adapter: OftAdapter): OftAdapterInternals {
  return adapter as unknown as OftAdapterInternals;
}

function withCctpInternals(adapter: CctpAdapter): CctpAdapterInternals {
  return adapter as unknown as CctpAdapterInternals;
}

describe("Rebalancer bridge adapters", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("tracks OFT routes involving the hub chain", async function () {
    const [signer] = await ethers.getSigners();
    const adapter = new OftAdapter(TEST_LOGGER, {} as RebalancerConfig, signer);
    const internals = withOftInternals(adapter);
    internals.initialized = true;
    internals._redisGetPendingBridgesPreDeposit = async () => ["tx-hash"];
    internals._getOftStatus = async () => undefined;
    internals._redisGetOrderDetails = async () => ({
      sourceChain: CHAIN_IDs.MAINNET,
      sourceToken: "USDT",
      destinationChain: CHAIN_IDs.ARBITRUM,
      destinationToken: "USDT",
      amountToTransfer: toBNWei("1", 6),
    });

    const pendingRebalances = await adapter.getPendingRebalances(EvmAddress.from(await signer.getAddress()));
    expect(pendingRebalances[CHAIN_IDs.ARBITRUM].USDT).to.equal(toBNWei("1", 6));
  });

  it("tracks CCTP routes involving the hub chain", async function () {
    const [signer] = await ethers.getSigners();
    const adapter = new CctpAdapter(TEST_LOGGER, {} as RebalancerConfig, signer);
    const internals = withCctpInternals(adapter);
    internals.initialized = true;
    internals._redisGetPendingBridgesPreDeposit = async () => ["1-tx-hash"];
    internals._getCctpAttestation = async () => ({ status: "pending", attestation: undefined });
    internals._redisGetOrderDetails = async () => ({
      sourceChain: CHAIN_IDs.MAINNET,
      sourceToken: "USDC",
      destinationChain: CHAIN_IDs.BASE,
      destinationToken: "USDC",
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
} as unknown as winston.Logger;

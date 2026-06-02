import sinon from "sinon";
import { expect } from "chai";
import { EvmAddress, Signer, winston } from "../src/utils";
import { DepositAddressMessage } from "../src/interfaces/DepositAddress";
import { DepositAddressHandler } from "../src/deposit-address/DepositAddressHandler";
import { DepositAddressHandlerConfig } from "../src/deposit-address/DepositAddressHandlerConfig";

const SIGNER = "0x000000000000000000000000000000000000BEEF";
const DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000C0DE";
const REFUND_ADDRESS = "0x0000000000000000000000000000000000002222";
const TOKEN = "0x000000000000000000000000000000000000DEAD";
const OUTPUT_TOKEN = "0x0000000000000000000000000000000000005678";
const RECIPIENT = "0x0000000000000000000000000000000000001111";
const IMPL = "0x000000000000000000000000000000000000A4A4";

// The 12 params the deposit-execute quote sent before executionFee support — the legacy request shape.
const BASE_PARAM_KEYS = [
  "originChainId",
  "destinationChainId",
  "inputToken",
  "outputToken",
  "tradeType",
  "amount",
  "depositor",
  "recipient",
  "refundAddress",
  "depositAddress",
  "executionFeeRecipient",
  "shouldSponsorAccountCreation",
];

/** EVM-origin correct_transfer message; `materials` overrides the counterfactualMaterials leaves. */
function depositMessage(materials: DepositAddressMessage["counterfactualMaterials"]): DepositAddressMessage {
  return {
    depositAddress: DEPOSIT_ADDRESS,
    paramsHash: "0x" + "0".repeat(64),
    salt: "0x" + "0".repeat(64),
    counterfactualDepositContractAddress: "0x000000000000000000000000000000000000A1A1",
    counterfactualFactoryContractAddress: "0x000000000000000000000000000000000000A2A2",
    adminWithdrawManagerContractAddress: "0x000000000000000000000000000000000000A3A3",
    shouldSponsorAccountCreation: false,
    counterfactualMaterials: materials,
    routeParams: {
      inputToken: TOKEN,
      outputToken: OUTPUT_TOKEN,
      originChainId: "1",
      destinationChainId: "10",
      recipient: RECIPIENT,
      refundAddress: REFUND_ADDRESS,
    },
    erc20Transfer: {
      chainId: "1",
      blockNumber: 1_000_000,
      logIndex: 4,
      from: REFUND_ADDRESS,
      to: DEPOSIT_ADDRESS,
      amount: "5000",
      contractAddress: TOKEN,
      transactionHash: "0x" + "1".repeat(64),
      transferClassification: "correct_transfer",
    },
  };
}

const withdrawLeaf = {
  leafHash: "0x" + "0".repeat(64),
  merkleProof: [],
  encodedParams: "0x",
  implementationAddress: IMPL,
};

describe("DepositAddressHandler._getSwapApiQuote execution-fee params", function () {
  let handler: DepositAddressHandler;
  let getStub: sinon.SinonStub;

  beforeEach(function () {
    const config = { apiEndpoint: "swap/approval" } as unknown as DepositAddressHandlerConfig;
    handler = new DepositAddressHandler(undefined as unknown as winston.Logger, config, {} as unknown as Signer, []);
    // _signerAddress is normally set by initialize(); set it directly for this unit test.
    (handler as unknown as { _signerAddress: EvmAddress })._signerAddress = EvmAddress.from(SIGNER);
    // Replace the swap API client with a stub that captures the params and returns a successful quote.
    getStub = sinon.stub().resolves({ swapTx: { simulationSuccess: true, to: TOKEN, data: "0x", value: "0" } });
    (handler as unknown as { api: { get: sinon.SinonStub } }).api = { get: getStub };
  });

  afterEach(() => sinon.restore());

  async function capturedParams(message: DepositAddressMessage): Promise<Record<string, unknown>> {
    await (handler as unknown as { _getSwapApiQuote: (m: DepositAddressMessage) => Promise<unknown> })._getSwapApiQuote(
      message
    );
    expect(getStub.calledOnce).to.equal(true);
    return getStub.firstCall.args[1] as Record<string, unknown>;
  }

  it("forwards both committed fees verbatim when both leaves carry params", async function () {
    const params = await capturedParams(
      depositMessage({
        withdrawLeaf,
        cctpLeaf: { ...withdrawLeaf, params: { executionFee: "777" } },
        spokePoolLeaf: { ...withdrawLeaf, params: { executionFee: "12345" } },
      })
    );
    expect(params.cctpExecutionFee).to.equal("777");
    expect(params.spokePoolExecutionFee).to.equal("12345");
  });

  it("leaves the fee param undefined for the leaves whose params are absent", async function () {
    const params = await capturedParams(
      depositMessage({ withdrawLeaf, spokePoolLeaf: { ...withdrawLeaf, params: { executionFee: "12345" } } })
    );
    // Undefined values are dropped at query-string serialization, so the absent leaf contributes no fee.
    expect(params.cctpExecutionFee).to.equal(undefined);
    expect(params.spokePoolExecutionFee).to.equal("12345");
  });

  it("leaves both fee params undefined when no fee leaves are present", async function () {
    const params = await capturedParams(depositMessage({ withdrawLeaf }));
    // No fee leaves => both fees undefined and dropped at serialization, yielding the legacy request shape.
    expect(params.cctpExecutionFee).to.equal(undefined);
    expect(params.spokePoolExecutionFee).to.equal(undefined);
    expect(BASE_PARAM_KEYS.every((key) => key in params)).to.equal(true);
  });
});

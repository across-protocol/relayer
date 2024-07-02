// Mainnet
import CCTP_MESSAGE_TRANSMITTER_ABI from "./abi/CctpMessageTransmitter.json";
import CCTP_TOKEN_MESSENGER_ABI from "./abi/CctpTokenMessenger.json";
import ATOMIC_DEPOSITOR_ABI from "./abi/AtomicDepositor.json";
import WETH_ABI from "./abi/Weth.json";
import HUB_POOL_ABI from "./abi/HubPool.json";
import VOTING_V2_ABI from "./abi/VotingV2.json";
// OpStack
import OVM_L2_STANDARD_BRIDGE_ABI from "./abi/OpStackStandardBridgeL2.json";
import OVM_L1_STANDARD_BRIDGE_ABI from "./abi/OpStackStandardBridgeL1.json";
import DAI_OPTIMISM_BRIDGE_L1_ABI from "./abi/DaiOptimismBridgeL1.json";
import DAI_OPTIMISM_BRIDGE_L2_ABI from "./abi/DaiOptimismBridgeL2.json";
import SNX_OPTIMISM_BRIDGE_L1_ABI from "./abi/SnxOptimismBridgeL1.json";
import SNX_OPTIMISM_BRIDGE_L2_ABI from "./abi/SnxOptimismBridgeL2.json";
// Polygon
import POLYGON_BRIDGE_ABI from "./abi/PolygonBridge.json";
import POLYGON_ROOT_CHAIN_MANAGER_ABI from "./abi/PolygonRootChainManager.json";
import POLYGON_WITHDRAWABLE_ERC20_ABI from "./abi/PolygonWithdrawableErc20.json";
// ZkSync
import ZK_SYNC_DEFAULT_ERC20_BRIDGE_L1_ABI from "./abi/ZkSyncDefaultErc20BridgeL1.json";
import ZK_SYNC_DEFAULT_ERC20_BRIDGE_L2_ABI from "./abi/ZkSyncDefaultErc20BridgeL2.json";
import ZK_SYNC_MAILBOX_ABI from "./abi/ZkSyncMailbox.json";
// Arbitrum
import ARBITRUM_ERC20_GATEWAY_ROUTER_L1_ABI from "./abi/ArbitrumErc20GatewayRouterL1.json";
import ARBITRUM_ERC20_GATEWAY_L2_ABI from "./abi/ArbitrumErc20GatewayL2.json";
import ARBITRUM_OUTBOX_ABI from "./abi/ArbitrumOutbox.json";
// Linea
import LINEA_MESSAGE_SERVICE_ABI from "./abi/LineaMessageService.json";
import LINEA_TOKEN_BRIDGE_ABI from "./abi/LineaTokenBridge.json";
import LINEA_USDC_BRIDGE_ABI from "./abi/LineaUsdcBridge.json";
// Scroll
import SCROLL_RELAY_MESSENGER_ABI from "./abi/ScrollRelayMessenger.json";

// Constants file exporting hardcoded contract addresses per chain.
export const CONTRACT_ADDRESSES: {
  [chainId: number]: {
    [contractName: string]: {
      address?: string;
      abi?: unknown[];
    };
  };
} = {
  1: {
    lineaMessageService: {
      address: "0xd19d4B5d358258f05D7B411E21A1460D11B0876F",
      abi: LINEA_MESSAGE_SERVICE_ABI,
    },
    lineaL1TokenBridge: {
      address: "0x051F1D88f0aF5763fB888eC4378b4D8B29ea3319",
      abi: LINEA_TOKEN_BRIDGE_ABI,
    },
    lineaL1UsdcBridge: {
      address: "0x504A330327A089d8364C4ab3811Ee26976d388ce",
      abi: LINEA_USDC_BRIDGE_ABI,
    },
    zkSyncMailbox: {
      address: "0x32400084C286CF3E17e7B677ea9583e60a000324",
      abi: ZK_SYNC_MAILBOX_ABI,
    },
    zkSyncDefaultErc20Bridge: {
      address: "0x57891966931Eb4Bb6FB81430E6cE0A03AAbDe063",
      abi: ZK_SYNC_DEFAULT_ERC20_BRIDGE_L1_ABI,
    },
    daiOptimismBridge: {
      address: "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f",
      abi: DAI_OPTIMISM_BRIDGE_L1_ABI,
    },
    snxOptimismBridge: {
      address: "0x39Ea01a0298C315d149a490E34B59Dbf2EC7e48F",
      abi: SNX_OPTIMISM_BRIDGE_L1_ABI,
    },
    // OVM, ZkSync, Linea, and Polygon cant deposit WETH directly so we use an atomic depositor contract that unwraps WETH and
    // bridges ETH other the canonical bridge.
    atomicDepositor: {
      address: "0x24d8b91aB9c461d7c0D6fB9F5a294CEA61D11710",
      abi: ATOMIC_DEPOSITOR_ABI,
    },
    // Since there are multiple ovmStandardBridges on mainnet for different OP Stack chains, we append the chain id of the Op
    // Stack chain to the name to differentiate. This one is for Optimism.
    ovmStandardBridge_10: {
      address: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_1135: {
      address: "0x2658723Bf70c7667De6B25F99fcce13A16D25d08",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_8453: {
      address: "0x3154Cf16ccdb4C6d922629664174b904d80F2C35",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_34443: {
      address: "0x735aDBbE72226BD52e818E7181953f42E3b0FF21",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    polygonRootChainManager: {
      address: "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77",
      abi: POLYGON_ROOT_CHAIN_MANAGER_ABI,
    },
    polygonBridge: {
      abi: POLYGON_BRIDGE_ABI,
    },
    arbitrumErc20GatewayRouter: {
      address: "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef",
      abi: ARBITRUM_ERC20_GATEWAY_ROUTER_L1_ABI,
    },
    weth: {
      abi: WETH_ABI,
    },
    VotingV2: {
      address: "0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac",
      abi: VOTING_V2_ABI,
    },
    cctpMessageTransmitter: {
      address: "0x0a992d191deec32afe36203ad87d7d289a738f81",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0xbd3fa81b58ba92a82136038b25adec7066af3155",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
    scrollRelayMessenger: {
      address: "0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367",
      abi: SCROLL_RELAY_MESSENGER_ABI,
    },
    hubPool: {
      address: "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
      abi: HUB_POOL_ABI,
    },
  },
  10: {
    daiOptimismBridge: {
      address: "0x467194771dae2967aef3ecbedd3bf9a310c76c65",
      abi: DAI_OPTIMISM_BRIDGE_L2_ABI,
    },
    snxOptimismBridge: {
      address: "0x136b1EC699c62b0606854056f02dC7Bb80482d63",
      abi: SNX_OPTIMISM_BRIDGE_L2_ABI,
    },
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      abi: WETH_ABI,
    },
    eth: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
    cctpMessageTransmitter: {
      address: "0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x2B4069517957735bE00ceE0fadAE88a26365528f",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
  },
  137: {
    withdrawableErc20: {
      abi: POLYGON_WITHDRAWABLE_ERC20_ABI,
    },
    cctpMessageTransmitter: {
      address: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
  },
  324: {
    zkSyncDefaultErc20Bridge: {
      address: "0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102",
      abi: ZK_SYNC_DEFAULT_ERC20_BRIDGE_L2_ABI,
    },
    eth: {
      address: "0x000000000000000000000000000000000000800A",
      abi: WETH_ABI,
    },
    weth: {
      address: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
      abi: WETH_ABI,
    },
  },
  1135: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      abi: WETH_ABI,
    },
    eth: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  8453: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      abi: WETH_ABI,
    },
    eth: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
    cctpMessageTransmitter: {
      address: "0xAD09780d193884d503182aD4588450C416D6F9D4",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
  },
  34443: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    weth: {
      address: "0x4200000000000000000000000000000000000006",
      abi: WETH_ABI,
    },
    eth: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  42161: {
    erc20Gateway: {
      abi: ARBITRUM_ERC20_GATEWAY_L2_ABI,
    },
    weth: {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      abi: WETH_ABI,
    },
    outbox: {
      address: "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840",
      abi: ARBITRUM_OUTBOX_ABI,
    },
    cctpMessageTransmitter: {
      address: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x19330d10D9Cc8751218eaf51E8885D058642E08A",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
  },
  59144: {
    l2MessageService: {
      address: "0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec",
      abi: LINEA_MESSAGE_SERVICE_ABI,
    },
    lineaL2UsdcBridge: {
      address: "0xA2Ee6Fce4ACB62D95448729cDb781e3BEb62504A",
      abi: LINEA_USDC_BRIDGE_ABI,
    },
    lineaL2TokenBridge: {
      address: "0x353012dc4a9A6cF55c941bADC267f82004A8ceB9",
      abi: LINEA_TOKEN_BRIDGE_ABI,
    },
    weth: {
      address: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
      abi: WETH_ABI,
    },
    eth: {
      address: "0x0000000000000000000000000000000000000000",
    },
  },
  // Testnets
  11155111: {
    cctpMessageTransmitter: {
      address: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
  },
  84532: {
    cctpMessageTransmitter: {
      address: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
  },
  59140: {
    l2MessageService: {
      address: "0xC499a572640B64eA1C8c194c43Bc3E19940719dC",
      abi: LINEA_MESSAGE_SERVICE_ABI,
    },
  },
};

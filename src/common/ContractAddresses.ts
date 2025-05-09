import { CHAIN_IDs } from "../utils";
import CCTP_MESSAGE_TRANSMITTER_ABI from "./abi/CctpMessageTransmitter.json";
import CCTP_TOKEN_MESSENGER_ABI from "./abi/CctpTokenMessenger.json";
import CCTP_V2_TOKEN_MESSENGER_ABI from "./abi/CctpV2TokenMessenger.json";
import ATOMIC_DEPOSITOR_ABI from "./abi/AtomicDepositor.json";
import WETH_ABI from "./abi/Weth.json";
import ATOMIC_DEPOSITOR_TRANSFER_PROXY_ABI from "./abi/AtomicDepositorTransferProxy.json";
import HUB_POOL_ABI from "./abi/HubPool.json";
import VOTING_V2_ABI from "./abi/VotingV2.json";
import OP_USDC_BRIDGE_ABI from "./abi/OpStackUSDCBridge.json";
import OVM_L1_STANDARD_BRIDGE_ABI from "./abi/OpStackStandardBridgeL1.json";
import OVM_L2_STANDARD_BRIDGE_ABI from "./abi/OpStackStandardBridgeL2.json";
import SNX_OPTIMISM_BRIDGE_L1_ABI from "./abi/SnxOptimismBridgeL1.json";
import SNX_OPTIMISM_BRIDGE_L2_ABI from "./abi/SnxOptimismBridgeL2.json";
import DAI_OPTIMISM_BRIDGE_L1_ABI from "./abi/DaiOptimismBridgeL1.json";
import DAI_OPTIMISM_BRIDGE_L2_ABI from "./abi/DaiOptimismBridgeL2.json";
import POLYGON_BRIDGE_ABI from "./abi/PolygonBridge.json";
import POLYGON_ROOT_CHAIN_MANAGER_ABI from "./abi/PolygonRootChainManager.json";
import POLYGON_WITHDRAWABLE_ERC20_ABI from "./abi/PolygonWithdrawableErc20.json";
import ZKSTACK_NATIVE_TOKEN_VAULT_ABI from "./abi/ZkStackNativeTokenVault.json";
import ZKSTACK_BRIDGE_HUB_ABI from "./abi/ZkStackBridgeHub.json";
import ZKSTACK_SHARED_BRIDGE_ABI from "./abi/ZkStackSharedBridge.json";
import ZKSTACK_USDC_BRIDGE_ABI from "./abi/ZkStackUSDCBridge.json";
import ARBITRUM_ERC20_GATEWAY_ROUTER_L1_ABI from "./abi/ArbitrumErc20GatewayRouterL1.json";
import ARBITRUM_ERC20_GATEWAY_ROUTER_L2_ABI from "./abi/ArbitrumErc20GatewayRouterL2.json";
import ARBITRUM_ERC20_GATEWAY_L1_ABI from "./abi/ArbitrumErc20GatewayL1.json";
import ARBITRUM_OUTBOX_ABI from "./abi/ArbitrumOutbox.json";
import ARBSYS_L2_ABI from "./abi/ArbSysL2.json";
import LINEA_MESSAGE_SERVICE_ABI from "./abi/LineaMessageService.json";
import LINEA_TOKEN_BRIDGE_ABI from "./abi/LineaTokenBridge.json";
import SCROLL_RELAY_MESSENGER_ABI from "./abi/ScrollRelayMessenger.json";
import BLAST_BRIDGE_ABI from "./abi/BlastBridge.json";
import BLAST_YIELD_MANAGER_ABI from "./abi/BlastYieldManager.json";
import BLAST_DAI_RETRIEVER_ABI from "./abi/BlastDaiRetriever.json";
import BLAST_OPTIMISM_PORTAL_ABI from "./abi/BlastOptimismPortal.json";
import SCROLL_GATEWAY_ROUTER_L1_ABI from "./abi/ScrollGatewayRouterL1.json";
import SCROLL_GATEWAY_ROUTER_L2_ABI from "./abi/ScrollGatewayRouterL2.json";
import SCROLL_GAS_PRICE_ORACLE_ABI from "./abi/ScrollGasPriceOracle.json";
import HUB_POOL_STORE_ABI from "./abi/HubPoolStore.json";
import SP1_HELIOS_ABI from "./abi/SP1Helios.json";

// Constants file exporting hardcoded contract addresses per chain.
export const CONTRACT_ADDRESSES: {
  [chainId: number]: {
    [contractName: string]: {
      address?: string;
      abi?: unknown[];
    };
  };
} = {
  [CHAIN_IDs.MAINNET]: {
    lineaMessageService: {
      address: "0xd19d4B5d358258f05D7B411E21A1460D11B0876F",
      abi: LINEA_MESSAGE_SERVICE_ABI,
    },
    lineaL1TokenBridge: {
      address: "0x051F1D88f0aF5763fB888eC4378b4D8B29ea3319",
      abi: LINEA_TOKEN_BRIDGE_ABI,
    },
    zkStackSharedBridge: {
      address: "0x8829AD80E425C646DAB305381ff105169FeEcE56",
      abi: ZKSTACK_SHARED_BRIDGE_ABI,
    },
    zkStackBridgeHub: {
      address: "0x303a465B659cBB0ab36eE643eA362c509EEb5213",
      abi: ZKSTACK_BRIDGE_HUB_ABI,
    },
    zkStackNativeTokenVault: {
      address: "0xbeD1EB542f9a5aA6419Ff3deb921A372681111f6",
      abi: ZKSTACK_NATIVE_TOKEN_VAULT_ABI,
    },
    zkStackUSDCBridge_232: {
      address: "0xf553E6D903AA43420ED7e3bc2313bE9286A8F987",
      abi: ZKSTACK_USDC_BRIDGE_ABI,
    },
    daiOptimismBridge: {
      address: "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f",
      abi: DAI_OPTIMISM_BRIDGE_L1_ABI,
    },
    snxOptimismBridge: {
      address: "0x39Ea01a0298C315d149a490E34B59Dbf2EC7e48F",
      abi: SNX_OPTIMISM_BRIDGE_L1_ABI,
    },
    // OVM, ZkSync, Linea, and Polygon can't deposit WETH directly so we use an atomic depositor contract that unwraps WETH and
    // bridges ETH other the canonical bridge.
    atomicDepositor: {
      address: "0x64668fbD18b967b46DD22dc8675134D91efeDd8d",
      abi: ATOMIC_DEPOSITOR_ABI,
    },
    opUSDCBridge_480: {
      address: "0x153A69e4bb6fEDBbAaF463CB982416316c84B2dB",
      abi: OP_USDC_BRIDGE_ABI,
    },
    opUSDCBridge_1868: {
      address: "0xC67A8c5f22b40274Ca7C4A56Db89569Ee2AD3FAb",
      abi: OP_USDC_BRIDGE_ABI,
    },
    // Since there are multiple ovmStandardBridges on mainnet for different OP Stack chains, we append the chain id of the Op
    // Stack chain to the name to differentiate. This one is for Optimism.
    ovmStandardBridge_10: {
      address: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_480: {
      address: "0x470458C91978D2d929704489Ad730DC3E3001113",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_690: {
      address: "0xc473ca7E02af24c129c2eEf51F2aDf0411c1Df69",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_130: {
      address: "0x81014F44b0a345033bB2b3B21C7a1A308B35fEeA",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_1135: {
      address: "0x2658723Bf70c7667De6B25F99fcce13A16D25d08",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_1868: {
      address: "0xeb9bf100225c214Efc3E7C651ebbaDcF85177607",
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
    ovmStandardBridge_57073: {
      address: "0x88FF1e5b602916615391F55854588EFcBB7663f0",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_81457: {
      address: "0x697402166Fbf2F22E970df8a6486Ef171dbfc524",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_7777777: {
      address: "0x3e2Ea9B92B7E48A52296fD261dc26fd995284631",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    polygonRootChainManager: {
      address: "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77",
      abi: POLYGON_ROOT_CHAIN_MANAGER_ABI,
    },
    polygonBridge: {
      address: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
      abi: POLYGON_BRIDGE_ABI,
    },
    polygonWethBridge: {
      address: "0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30",
      abi: POLYGON_BRIDGE_ABI,
    },
    orbitOutbox_42161: {
      address: "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840",
      abi: ARBITRUM_OUTBOX_ABI,
    },
    orbitOutbox_41455: {
      address: "0x73bb50c32a3BD6A1032aa5cFeA048fBDA3D6aF6e",
      abi: ARBITRUM_OUTBOX_ABI,
    },
    orbitErc20GatewayRouter_42161: {
      address: "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef",
      abi: ARBITRUM_ERC20_GATEWAY_ROUTER_L1_ABI,
    },
    orbitErc20Gateway_42161: {
      abi: ARBITRUM_ERC20_GATEWAY_L1_ABI,
    },
    orbitErc20GatewayRouter_41455: {
      address: "0xeBb17f398ed30d02F2e8733e7c1e5cf566e17812",
      abi: ARBITRUM_ERC20_GATEWAY_ROUTER_L1_ABI,
    },
    orbitErc20Gateway_41455: {
      abi: ARBITRUM_ERC20_GATEWAY_L1_ABI,
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
    cctpV2MessageTransmitter: {
      address: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI, // Same ABI as V1 as far as functions we care about, so overload for now.
    },
    cctpV2TokenMessenger: {
      address: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
    },
    scrollRelayMessenger: {
      address: "0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367",
      abi: SCROLL_RELAY_MESSENGER_ABI,
    },
    scrollGatewayRouter: {
      address: "0xF8B1378579659D8F7EE5f3C929c2f3E332E41Fd6",
      abi: SCROLL_GATEWAY_ROUTER_L1_ABI,
    },
    hubPool: {
      address: "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
      abi: HUB_POOL_ABI,
    },
    hubPoolStore: {
      address: "0x1Ace3BbD69b63063F859514Eca29C9BDd8310E61",
      abi: HUB_POOL_STORE_ABI,
    },
    blastBridge: {
      address: "0x3a05E5d33d7Ab3864D53aaEc93c8301C1Fa49115",
      abi: BLAST_BRIDGE_ABI,
    },
    blastEthYieldManager: {
      address: "0x98078db053902644191f93988341E31289E1C8FE",
      abi: BLAST_YIELD_MANAGER_ABI,
    },
    blastUsdYieldManager: {
      address: "0xa230285d5683C74935aD14c446e137c8c8828438",
      abi: BLAST_YIELD_MANAGER_ABI,
    },
    blastDaiRetriever: {
      address: "0x98Dd57048d7d5337e92D9102743528ea4Fea64aB",
      abi: BLAST_DAI_RETRIEVER_ABI,
    },
    blastOptimismPortal: {
      address: "0x0Ec68c5B10F21EFFb74f2A5C61DFe6b08C0Db6Cb",
      abi: BLAST_OPTIMISM_PORTAL_ABI,
    },
    scrollGasPriceOracle: {
      address: "0x0d7E906BD9cAFa154b048cFa766Cc1E54E39AF9B",
      abi: SCROLL_GAS_PRICE_ORACLE_ABI,
    },
    atomicDepositorTransferProxy: {
      address: "0xd8938466fE02dA664b806583edE9c77dCD968692",
      abi: ATOMIC_DEPOSITOR_TRANSFER_PROXY_ABI,
    },
  },
  [CHAIN_IDs.OPTIMISM]: {
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
    nativeToken: {
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
  [CHAIN_IDs.BSC]: {
    sp1Helios: {
      address: "0xCdb25d0A6FfFE639BC591a565F2D99507837f2b7",
      abi: SP1_HELIOS_ABI,
    },
  },
  [CHAIN_IDs.POLYGON]: {
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
    nativeToken: {
      address: "0x0000000000000000000000000000000000001010",
    },
  },
  [CHAIN_IDs.ZK_SYNC]: {
    nativeTokenVault: {
      address: "0x0000000000000000000000000000000000010004",
      abi: ZKSTACK_NATIVE_TOKEN_VAULT_ABI,
    },
    nativeToken: {
      address: "0x000000000000000000000000000000000000800A",
      abi: WETH_ABI,
    },
    weth: {
      address: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
      abi: WETH_ABI,
    },
  },
  [CHAIN_IDs.UNICHAIN]: {
    cctpMessageTransmitter: {
      address: "0x353bE9E2E38AB1D19104534e4edC21c643Df86f4",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x4e744b28E787c3aD0e810eD65A24461D4ac5a762",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  [CHAIN_IDs.SONEIUM]: {
    opUSDCBridge: {
      address: "0x8be79275FCfD08A931087ECf70Ba8a99aee3AC59",
      abi: OP_USDC_BRIDGE_ABI,
    },
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  [CHAIN_IDs.WORLD_CHAIN]: {
    opUSDCBridge: {
      address: "0xbD80b06d3dbD0801132c6689429aC09Ca6D27f82",
      abi: OP_USDC_BRIDGE_ABI,
    },
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  [CHAIN_IDs.REDSTONE]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  [CHAIN_IDs.LISK]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  [CHAIN_IDs.BASE]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
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
  [CHAIN_IDs.MODE]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  [CHAIN_IDs.INK]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  [CHAIN_IDs.BLAST]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
    blastBridge: {
      address: "0x4300000000000000000000000000000000000005",
      abi: BLAST_BRIDGE_ABI,
    },
  },
  [CHAIN_IDs.ARBITRUM]: {
    cctpMessageTransmitter: {
      address: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x19330d10D9Cc8751218eaf51E8885D058642E08A",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
    arbSys: {
      address: "0x0000000000000000000000000000000000000064",
      abi: ARBSYS_L2_ABI,
    },
    erc20GatewayRouter: {
      address: "0x5288c571Fd7aD117beA99bF60FE0846C4E84F933",
      abi: ARBITRUM_ERC20_GATEWAY_ROUTER_L2_ABI,
    },
  },
  [CHAIN_IDs.ALEPH_ZERO]: {
    erc20GatewayRouter: {
      address: "0xD296d45171B97720D3aBdb68B0232be01F1A9216",
      abi: ARBITRUM_ERC20_GATEWAY_ROUTER_L2_ABI,
    },
    arbSys: {
      address: "0x0000000000000000000000000000000000000064",
      abi: ARBSYS_L2_ABI,
    },
  },
  [CHAIN_IDs.LENS]: {
    nativeTokenVault: {
      address: "0x0000000000000000000000000000000000010004",
      abi: ZKSTACK_NATIVE_TOKEN_VAULT_ABI,
    },
    // The native token for Lens is GHO, not ETH.
    nativeToken: {
      address: "0x000000000000000000000000000000000000800A",
      abi: WETH_ABI,
    },
    // This is Lens wrapped GHO, NOT WETH.
    wrappedNativeToken: {
      address: "0x6bDc36E20D267Ff0dd6097799f82e78907105e2F",
      abi: WETH_ABI,
    },
    // The weth address on Lens is treated like an ERC20, meaning that mint events
    // are initiated by the L2 bridge and come from the zero address.
    weth: {
      address: "0xE5ecd226b3032910CEaa43ba92EE8232f8237553",
      abi: WETH_ABI,
    },
    usdcBridge: {
      address: "0x7188B6975EeC82ae914b6eC7AC32b3c9a18b2c81",
      abi: ZKSTACK_USDC_BRIDGE_ABI,
    },
  },
  [CHAIN_IDs.LINEA]: {
    cctpV2MessageTransmitter: {
      address: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpV2TokenMessenger: {
      address: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
    },
    l2MessageService: {
      address: "0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec",
      abi: LINEA_MESSAGE_SERVICE_ABI,
    },
    lineaL2TokenBridge: {
      address: "0x353012dc4a9A6cF55c941bADC267f82004A8ceB9",
      abi: LINEA_TOKEN_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0x0000000000000000000000000000000000000000",
    },
  },
  [CHAIN_IDs.SCROLL]: {
    scrollGatewayRouter: {
      address: "0x4C0926FF5252A435FD19e10ED15e5a249Ba19d79",
      abi: SCROLL_GATEWAY_ROUTER_L2_ABI,
    },
    // The Scroll canonical bridge will send WETH on a WETH deposit,
    // so the dataworker will never use this address to wrap eth in
    // the spoke pool. However, the relayer may need to wrap eth on
    // the L2; therefore, we need to define an address here so the
    // dataworker won't error.
    nativeToken: {
      address: "0x0000000000000000000000000000000000000000",
    },
  },
  [CHAIN_IDs.ZORA]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    nativeToken: {
      address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    },
  },
  // Testnets
  [CHAIN_IDs.SEPOLIA]: {
    ovmStandardBridge_4202: {
      address: "0x1Fb30e446eA791cd1f011675E5F3f5311b70faF5",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_84532: {
      address: "0xfd0Bf71F60660E2f608ed56e1659C450eB113120",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_11155420: {
      address: "0xFBb0621E0B23b5478B630BD55a5f21f67730B0F1",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_919: {
      address: "0xbC5C679879B2965296756CD959C3C739769995E2",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_168587773: {
      address: "0xDeDa8D3CCf044fE2A16217846B6e1f1cfD8e122f",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    ovmStandardBridge_1301: {
      address: "0xea58fcA6849d79EAd1f26608855c2D6407d54Ce2",
      abi: OVM_L1_STANDARD_BRIDGE_ABI,
    },
    cctpMessageTransmitter: {
      address: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
    atomicDepositor: {
      address: "0xdf87d6eFd856D6145Fcd387252cefD12868AC593",
      abi: ATOMIC_DEPOSITOR_ABI,
    },
    polygonRootChainManager: {
      address: "0x34F5A25B627f50Bb3f5cAb72807c4D4F405a9232",
      abi: POLYGON_ROOT_CHAIN_MANAGER_ABI,
    },
    polygonBridge: {
      address: "0x4258C75b752c812B7Fa586bdeb259f2d4bd17f4F",
      abi: POLYGON_BRIDGE_ABI,
    },
    polygonWethBridge: {
      address: "0x930C824C1e423a4b4949C665c4e92BD8f6ccF04e",
      abi: POLYGON_BRIDGE_ABI,
    },
    orbitErc20GatewayRouter_421614: {
      address: "0xcE18836b233C83325Cc8848CA4487e94C6288264",
      abi: ARBITRUM_ERC20_GATEWAY_ROUTER_L1_ABI,
    },
    orbitErc20Gateway_421614: {
      abi: ARBITRUM_ERC20_GATEWAY_L1_ABI,
    },
    zkStackBridgeHub: {
      address: "0x236D1c3Ff32Bd0Ca26b72Af287E895627c0478cE",
      abi: ZKSTACK_BRIDGE_HUB_ABI,
    },
    // The shared bridge is the "spender" of the token we wish to bridge, so we only
    // need its contract address so that we may approve it.
    zkStackSharedBridge: {
      address: "0xfD3130Ea0e8B7Dd61Ac3663328a66d97eb02f84b",
      abi: ZKSTACK_SHARED_BRIDGE_ABI,
    },
    zkStackNativeTokenVault: {
      address: "0x257CE1e946c9C6531E2C9deBF7fcf821F9467f73",
      abi: ZKSTACK_NATIVE_TOKEN_VAULT_ABI,
    },
    hubPool: {
      address: "0x14224e63716afAcE30C9a417E0542281869f7d9e",
      abi: HUB_POOL_ABI,
    },
  },
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: {
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
    cctpMessageTransmitter: {
      address: "0xaCF1ceeF35caAc005e15888dDb8A3515C41B4872",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
  },
  [CHAIN_IDs.BASE_SEPOLIA]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    cctpMessageTransmitter: {
      address: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
  },
  [CHAIN_IDs.BLAST_SEPOLIA]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
  },
  [CHAIN_IDs.LENS_SEPOLIA]: {
    nativeTokenVault: {
      address: "0x0000000000000000000000000000000000010004",
      abi: ZKSTACK_NATIVE_TOKEN_VAULT_ABI,
    },
    nativeToken: {
      address: "0x000000000000000000000000000000000000800A",
      abi: WETH_ABI,
    },
    wrappedNativeToken: {
      address: "0xeee5a340Cdc9c179Db25dea45AcfD5FE8d4d3eB8",
      abi: WETH_ABI,
    },
    weth: {
      address: "0xaA91D645D7a6C1aeaa5988e0547267B77d33fe16",
      abi: WETH_ABI,
    },
  },
  [CHAIN_IDs.LISK_SEPOLIA]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
  },
  [CHAIN_IDs.MODE_SEPOLIA]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
  },
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: {
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
    cctpMessageTransmitter: {
      address: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
  },
  [CHAIN_IDs.POLYGON_AMOY]: {
    withdrawableErc20: {
      abi: POLYGON_WITHDRAWABLE_ERC20_ABI,
    },
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
    cctpMessageTransmitter: {
      address: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
  },
  [CHAIN_IDs.SCROLL_SEPOLIA]: {
    scrollGatewayRouter: {
      address: "0x9aD3c5617eCAa556d6E166787A97081907171230",
      abi: SCROLL_GATEWAY_ROUTER_L2_ABI,
    },
  },
  [CHAIN_IDs.TATARA]: {
    withdrawableErc20: {
      abi: POLYGON_WITHDRAWABLE_ERC20_ABI,
    },
  },
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: {
    cctpTokenMessenger: {
      address: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      abi: CCTP_TOKEN_MESSENGER_ABI,
    },
    cctpMessageTransmitter: {
      address: "0x1F622c406DedB82119EAfADB09E64e7e36A6844b",
      abi: CCTP_MESSAGE_TRANSMITTER_ABI,
    },
    ovmStandardBridge: {
      address: "0x4200000000000000000000000000000000000010",
      abi: OVM_L2_STANDARD_BRIDGE_ABI,
    },
  },
};

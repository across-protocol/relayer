import { Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { getContractFactory, utf8ToHex, identifier, refundProposalLiveness } from "@across-protocol/sdk/test-utils";

export async function setupUmaEcosystem(owner: SignerWithAddress): Promise<{
  timer: Contract;
  finder: Contract;
  collateralWhitelist: Contract;
  store: Contract;
}> {
  // Setup minimum UMA ecosystem contracts. Note that we don't use the umaEcosystemFixture because Hardhat Fixture's
  // seem to produce non-deterministic behavior between tests.
  const timer = await (await getContractFactory("Timer", owner)).deploy();
  const finder = await (await getContractFactory("Finder", owner)).deploy();
  const identifierWhitelist = await (await getContractFactory("IdentifierWhitelist", owner)).deploy();
  const mockOracle = await (
    await getContractFactory("MockOracleAncillary", owner)
  ).deploy(finder.address, timer.address);
  const optimisticOracle = await (
    await getContractFactory("SkinnyOptimisticOracle", owner)
  ).deploy(refundProposalLiveness, finder.address, timer.address);
  const collateralWhitelist = await (await getContractFactory("AddressWhitelist", owner)).deploy();
  const store = await (
    await getContractFactory("Store", owner)
  ).deploy({ rawValue: "0" }, { rawValue: "0" }, timer.address);
  await finder.changeImplementationAddress(utf8ToHex("CollateralWhitelist"), collateralWhitelist.address);
  await finder.changeImplementationAddress(utf8ToHex("IdentifierWhitelist"), identifierWhitelist.address);
  await finder.changeImplementationAddress(utf8ToHex("SkinnyOptimisticOracle"), optimisticOracle.address);
  await finder.changeImplementationAddress(utf8ToHex("Store"), store.address);
  await finder.changeImplementationAddress(utf8ToHex("Oracle"), mockOracle.address);
  await identifierWhitelist.addSupportedIdentifier(identifier);
  return {
    timer,
    finder,
    collateralWhitelist,
    store,
  };
}

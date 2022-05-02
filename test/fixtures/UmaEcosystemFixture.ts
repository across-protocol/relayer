import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
import { Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { utf8ToHex } from "@across-protocol/contracts-v2/dist/test-utils";
import { interfaceName } from "@uma/common";

export async function setupUmaEcosystem(owner: SignerWithAddress): Promise<{
  timer: Contract;
  finder: Contract;
  collateralWhitelist: Contract;
  store: Contract;
}> {
  // Setup minimum UMA ecosystem contracts. Note that we don't use the umaEcosystemFixture because Hardhat Fixture's
  // seem to produce non-deterministic behavior between tests.
  const timer = await (await utils.getContractFactory("Timer", owner)).deploy();
  const finder = await (await utils.getContractFactory("Finder", owner)).deploy();
  const collateralWhitelist = await (await utils.getContractFactory("AddressWhitelist", owner)).deploy();
  const store = await (
    await utils.getContractFactory("Store", owner)
  ).deploy({ rawValue: "0" }, { rawValue: "0" }, timer.address);
  await finder.changeImplementationAddress(utf8ToHex(interfaceName.CollateralWhitelist), collateralWhitelist.address);
  await finder.changeImplementationAddress(utf8ToHex(interfaceName.Store), store.address);

  return {
    timer,
    finder,
    collateralWhitelist,
    store,
  };
}

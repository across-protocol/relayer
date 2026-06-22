import assert from "assert";
import { Contract } from "ethers";
import { ethers } from "hardhat";
import { getContractFactory, utf8ToHex, identifier, refundProposalLiveness } from "@across-protocol/sdk/test-utils";
import { isDefined } from "../../src/utils";

type UmaEcosystem = {
  timer: Contract;
  finder: Contract;
  collateralWhitelist: Contract;
  store: Contract;
};

// UMA ecosystem contracts are never mutated by tests. Deploy once via root-level before() hook.
let fixture: UmaEcosystem;

before(async function () {
  const [owner] = await ethers.getSigners();
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
  fixture = { timer, finder, collateralWhitelist, store };
});

// Sync the singleton timer to the current block timestamp before each test,
// preventing cross-test leakage when a prior test advanced time.
beforeEach(async function () {
  const { timestamp } = await ethers.provider.getBlock("latest");
  await fixture.timer.setCurrentTime(timestamp);
});

export function getUmaFixture(): UmaEcosystem {
  assert(isDefined(fixture), "UMA fixture not deployed");
  return fixture;
}

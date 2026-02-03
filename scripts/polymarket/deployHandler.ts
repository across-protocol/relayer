import hre from "hardhat";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const spokePool = getArg("spokePool") ?? "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096"; // Across Polygon SpokePool
  const paymentToken = getArg("paymentToken") ?? "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
  const owner = getArg("owner");

  const [deployer] = await hre.ethers.getSigners();
  const ownerAddr = owner ?? deployer.address;

  const Factory = await hre.ethers.getContractFactory("PolymarketHandler");
  const handler = await Factory.deploy(spokePool, paymentToken, ownerAddr);
  await handler.deployed();

  // eslint-disable-next-line no-console
  console.log("PolymarketHandler deployed:", handler.address);
  // eslint-disable-next-line no-console
  console.log("spokePool:", spokePool);
  // eslint-disable-next-line no-console
  console.log("paymentToken:", paymentToken);
  // eslint-disable-next-line no-console
  console.log("owner:", ownerAddr);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


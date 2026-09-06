import { ethers, network } from "hardhat";

import { D15_PROFILE_ID, loadD15Profile } from "./d15-profile";

async function main() {
  if (process.env.D15_PROFILE !== D15_PROFILE_ID) {
    throw new Error(`D15_PROFILE=${D15_PROFILE_ID} zorunludur`);
  }

  const profile = loadD15Profile();
  const chain = await ethers.provider.getNetwork();
  if (network.name !== profile.network || chain.chainId !== BigInt(profile.chainId)) {
    throw new Error(
      `yanlis ag: ${network.name}/${chain.chainId}; ` +
        `${profile.network}/${profile.chainId} bekleniyordu`,
    );
  }
  if ((await ethers.getSigners()).length !== 0) {
    throw new Error("readiness salt-okunur olmali; signer yuklenmemeli");
  }

  const block = await ethers.provider.getBlockNumber();
  console.log(`D15 profile : ${profile.profile}`);
  console.log(`Ag          : ${network.name} (chainId ${chain.chainId}, blok ${block})`);
  console.log(`Sorgu       : ML (${profile.queryType}), gerekli onay 2/2`);
  console.log(`Katilimci   : test-only minimum ${profile.minParticipants}`);

  const accounts = [
    ["deployer", profile.deployer, profile.minimumDeployerBalanceWei],
    ["node-1", profile.authorizedNodes[0], profile.nodeBaseStakeWei],
    ["node-2", profile.authorizedNodes[1], profile.nodeBaseStakeWei],
  ] as const;

  const states = await Promise.all(
    accounts.map(async ([role, address, minimum]) => ({
      role,
      address,
      minimum,
      balance: await ethers.provider.getBalance(address),
      code: await ethers.provider.getCode(address),
    })),
  );

  for (const state of states) {
    if (state.code !== "0x") {
      throw new Error(`${state.role} EOA degil; adreste contract kodu var`);
    }
    console.log(
      `${state.role.padEnd(11)}: ${state.address} | ` +
        `${ethers.formatEther(state.balance)} Sepolia ETH`,
    );
    if (state.balance <= state.minimum) {
      throw new Error(
        `${state.role} bakiyesi alt siniri karsilamiyor: ` +
          `${ethers.formatEther(state.minimum)} ETH + gas gerekir`,
      );
    }
  }

  console.log("Readiness tamamlandi; private key yuklenmedi ve transaction gonderilmedi.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`D15 readiness BASARISIZ: ${detail}`);
    process.exit(1);
  });

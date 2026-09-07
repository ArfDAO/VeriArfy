import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ethers } from "hardhat";
import { buildRedeployPlan, hashPlan, reviewOf, REVIEW_PATH } from "./d15-redeploy-plan";

async function main() {
  if ((await ethers.getSigners()).length) throw new Error("plan preparation must not load a signer");
  const plan = await buildRedeployPlan();
  const review = { planHash: hashPlan(plan), ...reviewOf(plan) };
  if (existsSync(REVIEW_PATH)) {
    if (JSON.stringify(JSON.parse(readFileSync(REVIEW_PATH, "utf8"))) !== JSON.stringify(review)) {
      throw new Error("existing reviewed plan differs; archive/review it explicitly before replacing");
    }
  } else {
    writeFileSync(REVIEW_PATH, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx" });
  }
  console.log(`Plan: ${review.planHash}`);
  console.log(`Nonces: ${plan.startNonce}..${plan.endNonce - 1}; ${plan.steps.length} transactions`);
  console.log(`Maximum gas cost: ${ethers.formatEther(plan.maxCostWei)} Sepolia ETH`);
  console.log(`Review written: ${REVIEW_PATH}; no transactions sent`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

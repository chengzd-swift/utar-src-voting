// scripts/deploy.js — v2 Multi-Election
const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

async function main() {
  console.log("🚀 Deploying UTAR SRC Voting Contract v4 (Multi-Election)...\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log(`📋 Deploying with account: ${deployer.address}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`💰 Account balance: ${hre.ethers.formatEther(balance)} ETH\n`);

  const SRCVoting = await hre.ethers.getContractFactory("SRCVoting");
  const voting    = await SRCVoting.deploy();
  await voting.waitForDeployment();

  const address  = await voting.getAddress();
  console.log(`✅ SRCVoting v4 deployed to: ${address}`);

  const artifact   = await hre.artifacts.readArtifact("SRCVoting");
  const deployInfo = { address, abi: artifact.abi, network: hre.network.name, deployedAt: new Date().toISOString() };

  const backendPath  = path.join(__dirname, "../backend/contract.json");
  const frontendPath = path.join(__dirname, "../frontend/contract.json");
  fs.mkdirSync(path.dirname(backendPath),  { recursive: true });
  fs.mkdirSync(path.dirname(frontendPath), { recursive: true });
  fs.writeFileSync(backendPath,  JSON.stringify(deployInfo, null, 2));
  fs.writeFileSync(frontendPath, JSON.stringify(deployInfo, null, 2));

  console.log(`📁 Contract info saved to backend/contract.json and frontend/contract.json`);
  console.log("\n🎉 Deployment complete!");
  console.log("👉 Next steps:");
  console.log("   1. node backend/server.js");
  console.log("   2. Log in as Election Committee → Default Password: EC123");
}

main().catch(err => { console.error(err); process.exitCode = 1; });

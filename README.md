# btclottery.io — Contracts

Smart contracts for the btclottery.io platform (Hardhat 3, `node:test` +
`viem`). The on-chain layer is a **payload-driven game model**: an admin portal
pushes a game + scheme JSON payload to our API, which deploys a fresh, immutable
game contract carrying that entire payload on-chain.

**Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first** — it is the source of
truth for the design, the two contracts, the live Sepolia deployment, and
locked decisions.

## Contracts

- **`contracts/GameFactory.sol`** — UUPS-upgradeable factory. `createGame(...)`
  deploys a game and indexes it by id / address / gameCode. Proxy address is
  permanent.
- **`contracts/GameCore.sol`** — one immutable instance per game. Holds its own
  funds; runs buying, the Chainlink VRF draw, batched winner finalization, and
  claims.
- **`contracts/test/MockUSDT.sol`** — ERC20 test double for the token path.

(`Counter.sol` is leftover Hardhat scaffold and not part of the platform.)

## Common commands

```shell
npx hardhat test                       # all tests (Solidity + node:test)
npx hardhat test nodejs                # GameCore + GameFactory suites
npx hardhat compile

# Deploy the factory (UUPS proxy) to Sepolia
npx hardhat ignition deploy --network sepolia ignition/modules/GameFactory.ts \
  --parameters ignition/parameters/sepolia.json

# Verify immediately after deploying (--network is REQUIRED)
npx hardhat ignition verify chain-11155111 --network sepolia
```

## Environment

`contracts/.env` (gitignored; not committed) provides `SEPOLIA_RPC_URL`,
`SEPOLIA_PRIVATE_KEY`, and `ETHERSCAN_API_KEY`. Deployment parameters (admin +
VRF config) live in `ignition/parameters/sepolia.json`.

## Guardrails

- **Never delete `ignition/deployments/`** — it is the deployment journal and
  is required for Etherscan verification.
- `.gitattributes` pins `*.sol` / `*.ts` / `*.json` to **LF** — do not remove
  it; line-ending drift changes the solc metadata hash and breaks verification.
- Any `GameCore` change applies to **new games only** (via a factory upgrade);
  deployed games are immutable by design.
- After contract changes, re-copy fresh ABIs to both
  `packages/shared/src/abis/` and `backend/src/abis/`.

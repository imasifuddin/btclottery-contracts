import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys the GameFactory behind a UUPS proxy on the target network.
 *
 * Required parameters (pass via ignition/parameters/sepolia.json):
 *  - admin: operator wallet address (gets all roles)
 *  - vrfCoordinator: Chainlink VRF V2.5 coordinator for the network
 *  - vrfSubscriptionId: your funded subscription ID from vrf.chain.link
 *  - vrfKeyHash: gas lane key hash for the network
 */
const GameFactoryModule = buildModule("GameFactoryModule", (m) => {
  const admin = m.getParameter<string>("admin");
  const vrfCoordinator = m.getParameter<string>("vrfCoordinator");
  const vrfSubscriptionId = m.getParameter<bigint>("vrfSubscriptionId");
  const vrfKeyHash = m.getParameter<string>("vrfKeyHash");

  // 1. Deploy the implementation
  const implementation = m.contract("GameFactory", [], { id: "GameFactoryImpl" });

  // 2. Encode initialize(InitParams) call for the proxy
  const initData = m.encodeFunctionCall(implementation, "initialize", [
    {
      admin,
      vrfCoordinator,
      vrfSubscriptionId,
      vrfKeyHash,
      vrfCallbackGasLimit: 2_000_000,
      vrfRequestConfirmations: 3,
    },
  ]);

  // 3. Deploy ERC1967 proxy pointing at the implementation
  const proxy = m.contract("ERC1967Proxy", [implementation, initData], {
    id: "GameFactoryProxy",
  });

  return { implementation, proxy };
});

export default GameFactoryModule;

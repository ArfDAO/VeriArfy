// Frontend'in ihtiyac duydugu minimal ABI parcalari.

export const REGISTRY_ABI = [
  "function isRegistered(address) view returns (bool)",
  "function researcherCount() view returns (uint256)",
  "function currentRoot() view returns (uint256)",
  "function register(uint256 root, uint256 nullifierHash, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)",
  "event ResearcherRegistered(address indexed account, uint256 indexed nullifierHash)",
] as const;

export const STUDY_ABI = [
  "function participantCount() view returns (uint32)",
  "function hasSubmitted(address) view returns (bool)",
  "function submit(bytes32 encGroup, bytes32 encAnxiety, bytes32 encPanic, bytes inputProof)",
  "function anxietyAggregate(uint8 group) view returns (bytes32 n, bytes32 sum, bytes32 sumSq)",
  "function panicAggregate(uint8 group) view returns (bytes32 n, bytes32 sum, bytes32 sumSq)",
  "event ResponseSubmitted(address indexed participant, uint32 participantIndex)",
] as const;

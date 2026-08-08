import { parseAbi } from 'viem';

export const repoEventsAbi = parseAbi([
  'event OfferCreated(uint256 indexed repoId,address indexed seller,address indexed asset,address permittedBuyer,uint256 collateralAmount,uint256 principalAmount,uint256 annualRateBps,uint256 duration,uint256 offerExpiry,bytes32 valuationHash)',
  'event OfferCancelled(uint256 indexed repoId,address indexed seller)',
  'event OfferExpired(uint256 indexed repoId)',
  'event OfferAccepted(uint256 indexed repoId,address indexed seller,address indexed buyer,uint256 maturity,uint256 repaymentDeadline,uint256 repurchaseAmount)',
  'event ProtocolFeePaid(uint256 indexed repoId,address indexed treasury,uint256 amount)',
  'event RepoRepaid(uint256 indexed repoId,address indexed seller,address indexed buyer,uint256 repurchaseAmount)',
  'event RepoDefaulted(uint256 indexed repoId,address indexed seller,address indexed buyer)',
  'event EntryPauseChanged(bool paused)',
  'event FeeTreasuryChanged(address indexed previousTreasury,address indexed newTreasury)',
]);

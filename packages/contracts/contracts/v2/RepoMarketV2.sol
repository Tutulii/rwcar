// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IComplianceValidator} from "../interfaces/IComplianceValidator.sol";
import {ICvaAssetRegistry} from "../interfaces/ICvaAssetRegistry.sol";
import {CollateralVaultV2} from "./CollateralVaultV2.sol";
import {SettlementEscrowV2} from "./SettlementEscrowV2.sol";
import {SignedValuationOracle} from "./SignedValuationOracle.sol";
import {RiskManagerV2} from "./RiskManagerV2.sol";
import {DutchAuctionV2} from "./DutchAuctionV2.sol";
import {ProtocolModuleFactoryV2} from "./ProtocolModuleFactoryV2.sol";

/// @notice Prefunded, partially-fillable institutional repo market. Every fill is an isolated
/// position with its own maturity; CVA collateral remains in the tri-party vault until closeout.
contract RepoMarketV2 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_OFFER_LIFETIME = 30 days;
    uint256 public constant MAX_REPO_DURATION = 365 days;
    uint256 public constant MAX_GRACE_PERIOD = 30 days;
    uint32 public constant MAX_ANNUAL_RATE_BPS = 100_000;
    uint8 private constant AUCTION_KIND_ISOLATED_REPO = 1;

    enum OfferStatus {
        NONE,
        OPEN,
        PARTIALLY_FILLED,
        FILLED,
        CANCELLED,
        EXPIRED
    }

    enum PositionStatus {
        NONE,
        ACTIVE,
        REPAID,
        AUCTION,
        LIQUIDATED,
        AUCTION_FAILED,
        COLLATERAL_CLAIMED
    }

    struct AssetConfig {
        CollateralVaultV2 vault;
        uint8 decimals;
        bool cleanverseReady;
    }

    struct CreateOfferParams {
        address asset;
        uint128 collateralAmount;
        uint128 targetPrincipal;
        uint128 minimumFill;
        uint32 annualRateBps;
        uint64 duration;
        uint64 offerExpiry;
        address permittedBuyer;
        bool earlyRepurchaseEnabled;
    }

    struct Offer {
        address seller;
        address permittedBuyer;
        address asset;
        address vault;
        uint128 totalCollateral;
        uint128 targetPrincipal;
        uint128 filledPrincipal;
        uint128 allocatedCollateral;
        uint128 feeCharged;
        uint128 minimumFill;
        uint32 annualRateBps;
        uint32 defaultAnnualRateBps;
        uint64 duration;
        uint64 offerExpiry;
        uint16 earlyMinHoldBps;
        uint16 earlyBreakFeeBps;
        bool earlyRepurchaseEnabled;
        OfferStatus status;
        bytes32 valuationDigest;
    }

    struct Position {
        uint256 offerId;
        uint256 auctionId;
        address seller;
        address buyer;
        address asset;
        address vault;
        uint128 collateralAmount;
        uint128 principalAmount;
        uint256 frozenDebt;
        uint32 annualRateBps;
        uint32 defaultAnnualRateBps;
        uint64 duration;
        uint64 acceptedAt;
        uint64 maturity;
        uint64 repaymentDeadline;
        uint16 earlyMinHoldBps;
        uint16 earlyBreakFeeBps;
        uint16 liquidationFeeBps;
        uint16 auctionStartBps;
        uint16 auctionFloorBps;
        uint64 auctionDuration;
        uint64 maxOracleAge;
        uint64 staleOracleFallbackDelay;
        bool earlyRepurchaseEnabled;
        PositionStatus status;
        bytes32 closeoutValuationDigest;
    }

    error EntryPaused();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidRate();
    error InvalidDuration();
    error InvalidExpiry();
    error InvalidStatus();
    error AssetNotEnabled();
    error AssetAlreadyConfigured();
    error CleanverseVaultNotReady(address asset);
    error ComplianceFailed(address user);
    error UnauthorizedSeller();
    error UnauthorizedBuyer();
    error SelfTrade();
    error SlippageExceeded(uint256 actual, uint256 limit);
    error InsufficientCollateralValue(uint256 debt, uint256 collateralValue, uint256 maxLtvBps);
    error EarlyRepaymentDisabled();
    error DefaultWindowNotOpen();
    error AuctionNotFailed();
    error OnlyPauseGuardian();
    error OracleFallbackNotOpen();
    error OracleStillLive();
    error NonExactSettlementTransfer(uint256 expected, uint256 received);

    IERC20 public immutable settlementToken;
    IComplianceValidator public immutable validator;
    ICvaAssetRegistry public immutable assetRegistry;
    SignedValuationOracle public immutable valuationOracle;
    RiskManagerV2 public immutable riskManager;
    ProtocolModuleFactoryV2 public immutable moduleFactory;
    DutchAuctionV2 public immutable auctionHouse;
    SettlementEscrowV2 public immutable settlementEscrow;
    uint16 public immutable protocolFeeBps;
    uint64 public immutable gracePeriod;
    uint8 public immutable settlementDecimals;

    address public feeTreasury;
    address public pauseGuardian;
    bool public entryPaused;
    uint256 public nextOfferId = 1;
    uint256 public nextPositionId = 1;

    mapping(address asset => AssetConfig config) private _assets;
    mapping(uint64 duration => bool allowed) public allowedDurations;
    mapping(uint256 offerId => Offer offer) private _offers;
    mapping(uint256 positionId => Position position) private _positions;
    mapping(uint256 auctionId => uint256 positionId) public positionForAuction;

    event AssetVaultConfigured(address indexed asset, address indexed vault, uint8 decimals);
    event AssetVaultReadinessChanged(address indexed asset, bool cleanverseReady);
    event CollateralDeposited(address indexed seller, address indexed asset, uint256 amount);
    event CollateralWithdrawn(address indexed seller, address indexed asset, address indexed recipient, uint256 amount);
    event OfferCreated(
        uint256 indexed offerId,
        address indexed seller,
        address indexed asset,
        uint256 collateralAmount,
        uint256 targetPrincipal,
        uint256 minimumFill,
        uint256 annualRateBps,
        uint256 defaultAnnualRateBps,
        uint256 duration,
        uint256 gracePeriod,
        uint256 offerExpiry,
        address permittedBuyer,
        bool earlyRepurchaseEnabled,
        uint256 earlyMinHoldBps,
        uint256 earlyBreakFeeBps,
        bytes32 valuationDigest
    );
    event OfferFilled(
        uint256 indexed offerId,
        uint256 indexed positionId,
        address indexed buyer,
        uint256 principal,
        uint256 collateral,
        uint256 fee,
        uint256 maturity,
        uint256 repaymentDeadline,
        uint256 defaultAnnualRateBps,
        uint256 liquidationFeeBps,
        uint256 auctionStartBps,
        uint256 auctionFloorBps,
        uint256 auctionDuration,
        uint256 maxOracleAge,
        uint256 staleOracleFallbackDelay,
        bytes32 openingValuationDigest
    );
    event OfferCancelled(uint256 indexed offerId, uint256 collateralReleased);
    event OfferExpired(uint256 indexed offerId, uint256 collateralReleased);
    event PositionRepaid(
        uint256 indexed positionId,
        address indexed seller,
        address indexed buyer,
        uint256 payoff,
        bool escrowed
    );
    event PositionDefaulted(
        uint256 indexed positionId,
        uint256 frozenDebt,
        uint256 indexed auctionId,
        bytes32 indexed valuationDigest
    );
    event PositionLiquidated(
        uint256 indexed positionId,
        uint256 indexed auctionId,
        address indexed buyer,
        uint256 salePrice,
        uint256 lenderPaid,
        uint256 feePaid,
        uint256 sellerSurplus,
        uint256 shortfall
    );
    event AuctionFailed(uint256 indexed positionId, uint256 indexed auctionId);
    event DefaultCollateralClaimed(uint256 indexed positionId, address indexed lender, address indexed recipient);
    event StaleOracleCollateralClaimed(uint256 indexed positionId, address indexed lender, address indexed recipient);
    event SettlementEscrowed(
        address indexed beneficiary, uint256 indexed claimId, uint256 amount, bytes32 indexed claimReference
    );
    event EntryPauseChanged(bool paused);
    event FeeTreasuryChanged(address indexed previousTreasury, address indexed newTreasury);
    event PauseGuardianChanged(address indexed previousGuardian, address indexed newGuardian);

    modifier whenEntryOpen() {
        if (entryPaused) revert EntryPaused();
        _;
    }

    constructor(
        address initialOwner,
        address settlementToken_,
        address validator_,
        address assetRegistry_,
        address valuationOracle_,
        address riskManager_,
        address moduleFactory_,
        address feeTreasury_,
        uint16 protocolFeeBps_,
        uint64 gracePeriod_,
        uint64[] memory allowedDurations_
    ) Ownable(initialOwner) {
        if (
            initialOwner == address(0) || settlementToken_ == address(0) || validator_ == address(0)
                || assetRegistry_ == address(0) || valuationOracle_ == address(0) || riskManager_ == address(0)
                || moduleFactory_ == address(0) || feeTreasury_ == address(0)
        ) revert InvalidAddress();
        if (protocolFeeBps_ >= BPS_DENOMINATOR) revert InvalidAmount();
        if (gracePeriod_ == 0 || gracePeriod_ > MAX_GRACE_PERIOD || allowedDurations_.length == 0) {
            revert InvalidDuration();
        }

        settlementToken = IERC20(settlementToken_);
        validator = IComplianceValidator(validator_);
        assetRegistry = ICvaAssetRegistry(assetRegistry_);
        valuationOracle = SignedValuationOracle(valuationOracle_);
        riskManager = RiskManagerV2(riskManager_);
        moduleFactory = ProtocolModuleFactoryV2(moduleFactory_);
        feeTreasury = feeTreasury_;
        pauseGuardian = initialOwner;
        protocolFeeBps = protocolFeeBps_;
        gracePeriod = gracePeriod_;
        settlementDecimals = IERC20Metadata(settlementToken_).decimals();
        if (settlementDecimals > 18) revert InvalidAmount();
        auctionHouse = DutchAuctionV2(moduleFactory.deployAuction());
        settlementEscrow = SettlementEscrowV2(moduleFactory.deploySettlementEscrow(settlementToken_, validator_));

        for (uint256 i; i < allowedDurations_.length; ++i) {
            uint64 duration = allowedDurations_[i];
            if (duration == 0 || duration > MAX_REPO_DURATION) revert InvalidDuration();
            allowedDurations[duration] = true;
        }
    }

    function configureAsset(address asset) external onlyOwner returns (address vault) {
        if (asset == address(0) || asset.code.length == 0 || !assetRegistry.isAssetEnabled(asset)) {
            revert AssetNotEnabled();
        }
        if (address(_assets[asset].vault) != address(0)) revert AssetAlreadyConfigured();
        uint8 decimals = IERC20Metadata(asset).decimals();
        if (decimals > 18) revert InvalidAmount();
        CollateralVaultV2 deployed = CollateralVaultV2(moduleFactory.deployVault(asset));
        _assets[asset] = AssetConfig(deployed, decimals, false);
        emit AssetVaultConfigured(asset, address(deployed), decimals);
        return address(deployed);
    }

    /// @notice Operational attestation only. Set true after Cleanverse `registerApass` and a real
    /// deposit/withdraw smoke test for this exact vault address have succeeded.
    function setAssetVaultReady(address asset, bool ready) external onlyOwner {
        if (address(_assets[asset].vault) == address(0)) revert AssetNotEnabled();
        _assets[asset].cleanverseReady = ready;
        emit AssetVaultReadinessChanged(asset, ready);
    }

    function depositCollateral(address asset, uint256 amount) external nonReentrant whenEntryOpen {
        AssetConfig storage config = _requireEntryAsset(asset);
        _requireCompliant(msg.sender);
        config.vault.depositFor(msg.sender, amount);
        emit CollateralDeposited(msg.sender, asset, amount);
    }

    function withdrawCollateral(address asset, uint256 amount, address recipient) external nonReentrant {
        AssetConfig storage config = _configuredAsset(asset);
        _requireCompliant(msg.sender);
        _requireCompliant(recipient);
        config.vault.withdrawTo(msg.sender, recipient, amount);
        emit CollateralWithdrawn(msg.sender, asset, recipient, amount);
    }

    function createOffer(CreateOfferParams calldata params)
        external
        nonReentrant
        whenEntryOpen
        returns (uint256 offerId)
    {
        AssetConfig storage assetConfig = _requireEntryAsset(params.asset);
        if (params.collateralAmount == 0 || params.targetPrincipal == 0 || params.minimumFill == 0) {
            revert InvalidAmount();
        }
        if (params.minimumFill > params.targetPrincipal) revert InvalidAmount();
        if (params.annualRateBps > MAX_ANNUAL_RATE_BPS) revert InvalidRate();
        if (!allowedDurations[params.duration]) revert InvalidDuration();
        if (
            params.offerExpiry <= block.timestamp || params.offerExpiry > block.timestamp + MAX_OFFER_LIFETIME
        ) revert InvalidExpiry();

        _requireCompliant(msg.sender);
        RiskManagerV2.RiskConfig memory risk = riskManager.getConfig(params.asset);
        (uint256 price,, bytes32 valuationDigest) =
            valuationOracle.freshPrice(params.asset, address(settlementToken), risk.maxOracleAge);
        uint256 value = riskManager.collateralValue(
            params.collateralAmount, assetConfig.decimals, settlementDecimals, price
        );
        _requireLtv(params.targetPrincipal, value, risk.initialLtvBps);

        offerId = nextOfferId++;
        uint256 defaultRate = uint256(params.annualRateBps) + risk.defaultSpreadBps;
        if (params.annualRateBps > risk.maxDefaultRateBps) revert InvalidRate();
        if (defaultRate > risk.maxDefaultRateBps) defaultRate = risk.maxDefaultRateBps;

        _offers[offerId] = Offer({
            seller: msg.sender,
            permittedBuyer: params.permittedBuyer,
            asset: params.asset,
            vault: address(assetConfig.vault),
            totalCollateral: params.collateralAmount,
            targetPrincipal: params.targetPrincipal,
            filledPrincipal: 0,
            allocatedCollateral: 0,
            feeCharged: 0,
            minimumFill: params.minimumFill,
            annualRateBps: params.annualRateBps,
            defaultAnnualRateBps: uint32(defaultRate),
            duration: params.duration,
            offerExpiry: params.offerExpiry,
            earlyMinHoldBps: risk.earlyMinHoldBps,
            earlyBreakFeeBps: risk.earlyBreakFeeBps,
            earlyRepurchaseEnabled: params.earlyRepurchaseEnabled,
            status: OfferStatus.OPEN,
            valuationDigest: valuationDigest
        });
        assetConfig.vault.reserveOffer(msg.sender, offerId, params.collateralAmount);
        emit OfferCreated(
            offerId,
            msg.sender,
            params.asset,
            params.collateralAmount,
            params.targetPrincipal,
            params.minimumFill,
            params.annualRateBps,
            defaultRate,
            params.duration,
            gracePeriod,
            params.offerExpiry,
            params.permittedBuyer,
            params.earlyRepurchaseEnabled,
            risk.earlyMinHoldBps,
            risk.earlyBreakFeeBps,
            valuationDigest
        );
    }

    function fillOffer(uint256 offerId, uint256 fillPrincipal, uint256 maxFee)
        external
        nonReentrant
        whenEntryOpen
        returns (uint256 positionId)
    {
        Offer storage offer = _offers[offerId];
        if (offer.status != OfferStatus.OPEN && offer.status != OfferStatus.PARTIALLY_FILLED) revert InvalidStatus();
        if (block.timestamp > offer.offerExpiry) revert InvalidExpiry();
        if (msg.sender == offer.seller) revert SelfTrade();
        if (offer.permittedBuyer != address(0) && offer.permittedBuyer != msg.sender) revert UnauthorizedBuyer();

        uint256 remaining = uint256(offer.targetPrincipal) - offer.filledPrincipal;
        if (fillPrincipal == 0 || fillPrincipal > remaining) revert InvalidAmount();
        if (fillPrincipal < offer.minimumFill && fillPrincipal != remaining) revert InvalidAmount();
        _requireCompliant(offer.seller);
        _requireCompliant(msg.sender);

        AssetConfig storage assetConfig = _requireEntryAsset(offer.asset);
        RiskManagerV2.RiskConfig memory risk = riskManager.getConfig(offer.asset);
        (uint256 price,,) = valuationOracle.freshPrice(offer.asset, address(settlementToken), risk.maxOracleAge);

        uint256 newFilled = uint256(offer.filledPrincipal) + fillPrincipal;
        uint256 newAllocated = Math.mulDiv(offer.totalCollateral, newFilled, offer.targetPrincipal);
        uint256 fillCollateral = newAllocated - offer.allocatedCollateral;
        uint256 fillValue = riskManager.collateralValue(
            fillCollateral, assetConfig.decimals, settlementDecimals, price
        );
        _requireLtv(fillPrincipal, fillValue, risk.initialLtvBps);

        uint256 cumulativeFee = Math.mulDiv(newFilled, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        uint256 fee = cumulativeFee - offer.feeCharged;
        if (fee > maxFee || fee >= fillPrincipal) revert SlippageExceeded(fee, maxFee);

        positionId = nextPositionId++;
        uint64 acceptedAt = uint64(block.timestamp);
        uint64 maturity = acceptedAt + offer.duration;
        _positions[positionId] = Position({
            offerId: offerId,
            auctionId: 0,
            seller: offer.seller,
            buyer: msg.sender,
            asset: offer.asset,
            vault: offer.vault,
            collateralAmount: uint128(fillCollateral),
            principalAmount: uint128(fillPrincipal),
            frozenDebt: 0,
            annualRateBps: offer.annualRateBps,
            defaultAnnualRateBps: offer.defaultAnnualRateBps,
            duration: offer.duration,
            acceptedAt: acceptedAt,
            maturity: maturity,
            repaymentDeadline: maturity + gracePeriod,
            earlyMinHoldBps: offer.earlyMinHoldBps,
            earlyBreakFeeBps: offer.earlyBreakFeeBps,
            liquidationFeeBps: risk.liquidationFeeBps,
            auctionStartBps: risk.auctionStartBps,
            auctionFloorBps: risk.auctionFloorBps,
            auctionDuration: risk.auctionDuration,
            maxOracleAge: risk.maxOracleAge,
            staleOracleFallbackDelay: risk.staleOracleFallbackDelay,
            earlyRepurchaseEnabled: offer.earlyRepurchaseEnabled,
            status: PositionStatus.ACTIVE,
            closeoutValuationDigest: bytes32(0)
        });

        offer.filledPrincipal = uint128(newFilled);
        offer.allocatedCollateral = uint128(newAllocated);
        offer.feeCharged = uint128(cumulativeFee);
        offer.status = newFilled == offer.targetPrincipal ? OfferStatus.FILLED : OfferStatus.PARTIALLY_FILLED;

        CollateralVaultV2(offer.vault).allocatePosition(offer.seller, offerId, positionId, fillCollateral);
        _transferSettlementExact(msg.sender, offer.seller, fillPrincipal - fee);
        if (fee > 0) _payOrEscrow(msg.sender, feeTreasury, fee, _reference("OPEN_FEE", positionId));

        emit OfferFilled(
            offerId,
            positionId,
            msg.sender,
            fillPrincipal,
            fillCollateral,
            fee,
            maturity,
            maturity + gracePeriod,
            offer.defaultAnnualRateBps,
            risk.liquidationFeeBps,
            risk.auctionStartBps,
            risk.auctionFloorBps,
            risk.auctionDuration,
            risk.maxOracleAge,
            risk.staleOracleFallbackDelay,
            offer.valuationDigest
        );
    }

    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = _offers[offerId];
        if (offer.status != OfferStatus.OPEN && offer.status != OfferStatus.PARTIALLY_FILLED) revert InvalidStatus();
        if (msg.sender != offer.seller) revert UnauthorizedSeller();
        offer.status = OfferStatus.CANCELLED;
        uint256 released = uint256(offer.totalCollateral) - offer.allocatedCollateral;
        if (released > 0) CollateralVaultV2(offer.vault).releaseOffer(offer.seller, offerId, released);
        emit OfferCancelled(offerId, released);
    }

    function finalizeOfferExpiry(uint256 offerId) external nonReentrant {
        Offer storage offer = _offers[offerId];
        if (offer.status != OfferStatus.OPEN && offer.status != OfferStatus.PARTIALLY_FILLED) revert InvalidStatus();
        if (block.timestamp <= offer.offerExpiry) revert InvalidExpiry();
        offer.status = OfferStatus.EXPIRED;
        uint256 released = uint256(offer.totalCollateral) - offer.allocatedCollateral;
        if (released > 0) CollateralVaultV2(offer.vault).releaseOffer(offer.seller, offerId, released);
        emit OfferExpired(offerId, released);
    }

    function previewPayoff(uint256 positionId, uint256 atTimestamp) public view returns (uint256 payoff) {
        Position storage position = _positions[positionId];
        if (position.status != PositionStatus.ACTIVE) revert InvalidStatus();
        if (atTimestamp < position.acceptedAt) revert InvalidAmount();

        uint256 scheduledInterest = _interest(
            position.principalAmount, position.annualRateBps, position.duration
        );
        uint256 interestDue;
        if (atTimestamp < position.maturity) {
            if (!position.earlyRepurchaseEnabled) revert EarlyRepaymentDisabled();
            uint256 minimumHold = Math.mulDiv(
                position.duration, position.earlyMinHoldBps, BPS_DENOMINATOR, Math.Rounding.Ceil
            );
            uint256 elapsed = atTimestamp - position.acceptedAt;
            if (elapsed < minimumHold) elapsed = minimumHold;
            uint256 accrued = _interest(position.principalAmount, position.annualRateBps, elapsed);
            uint256 breakFee = Math.mulDiv(
                position.principalAmount,
                position.earlyBreakFeeBps,
                BPS_DENOMINATOR,
                Math.Rounding.Ceil
            );
            interestDue = Math.min(scheduledInterest, accrued + breakFee);
        } else {
            interestDue = scheduledInterest;
            uint256 overdue = atTimestamp - position.maturity;
            if (overdue > 0) {
                interestDue += _interest(position.principalAmount, position.defaultAnnualRateBps, overdue);
            }
        }
        payoff = uint256(position.principalAmount) + interestDue;
    }

    function repurchase(uint256 positionId, uint256 maxPayoff, bool useEscrow) external nonReentrant {
        Position storage position = _positions[positionId];
        if (position.status != PositionStatus.ACTIVE) revert InvalidStatus();
        if (msg.sender != position.seller) revert UnauthorizedSeller();
        _requireCompliant(position.seller);
        uint256 payoff = previewPayoff(positionId, block.timestamp);
        if (payoff > maxPayoff) revert SlippageExceeded(payoff, maxPayoff);

        position.status = PositionStatus.REPAID;
        if (useEscrow) {
            _transferSettlementExact(position.seller, address(settlementEscrow), payoff);
            bytes32 claimReference = _reference("REPAY", positionId);
            uint256 claimId = settlementEscrow.recordClaim(position.buyer, payoff, claimReference);
            emit SettlementEscrowed(position.buyer, claimId, payoff, claimReference);
        } else {
            _requireCompliant(position.buyer);
            _transferSettlementExact(position.seller, position.buyer, payoff);
        }
        CollateralVaultV2(position.vault).releasePosition(position.seller, positionId);
        emit PositionRepaid(positionId, position.seller, position.buyer, payoff, useEscrow);
    }

    function startAuction(uint256 positionId) external nonReentrant returns (uint256 auctionId) {
        Position storage position = _positions[positionId];
        if (position.status != PositionStatus.ACTIVE) revert InvalidStatus();
        if (block.timestamp <= position.repaymentDeadline) revert DefaultWindowNotOpen();

        AssetConfig storage assetConfig = _configuredAsset(position.asset);
        (uint256 price,, bytes32 closeoutDigest) =
            valuationOracle.freshPrice(position.asset, address(settlementToken), position.maxOracleAge);
        uint256 frozenDebt = previewPayoff(positionId, block.timestamp);
        uint256 value = riskManager.collateralValue(
            position.collateralAmount, assetConfig.decimals, settlementDecimals, price
        );
        uint256 startPrice = Math.mulDiv(value, position.auctionStartBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        uint256 floorPrice = Math.mulDiv(value, position.auctionFloorBps, BPS_DENOMINATOR);
        // Keep closeout live even when a severe price move rounds the CVA value
        // below one settlement-token atomic unit.
        if (floorPrice == 0) floorPrice = 1;
        if (startPrice < frozenDebt) startPrice = frozenDebt;
        if (startPrice < floorPrice) startPrice = floorPrice;

        auctionId = auctionHouse.create(
            AUCTION_KIND_ISOLATED_REPO,
            positionId,
            position.collateralAmount,
            startPrice,
            floorPrice,
            position.auctionDuration
        );
        position.status = PositionStatus.AUCTION;
        position.auctionId = auctionId;
        position.frozenDebt = frozenDebt;
        position.closeoutValuationDigest = closeoutDigest;
        positionForAuction[auctionId] = positionId;
        CollateralVaultV2(position.vault).allocateAuction(position.seller, positionId, auctionId);
        emit PositionDefaulted(positionId, frozenDebt, auctionId, closeoutDigest);
    }

    function buyAuction(uint256 auctionId, uint256 maxPrice) external nonReentrant {
        uint256 positionId = positionForAuction[auctionId];
        Position storage position = _positions[positionId];
        if (position.status != PositionStatus.AUCTION || position.auctionId != auctionId) revert InvalidStatus();
        if (msg.sender == position.seller) revert SelfTrade();
        _requireCompliant(msg.sender);

        uint256 price = auctionHouse.markSold(auctionId, msg.sender, maxPrice);
        uint256 lenderPaid = Math.min(price, position.frozenDebt);
        uint256 remaining = price - lenderPaid;
        uint256 feeTarget = Math.mulDiv(price, position.liquidationFeeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        uint256 feePaid = Math.min(remaining, feeTarget);
        uint256 sellerSurplus = remaining - feePaid;
        uint256 shortfall = uint256(position.frozenDebt) - lenderPaid;

        position.status = PositionStatus.LIQUIDATED;
        // Settle once into the Cleanverse-registered proceeds escrow. Beneficiary compliance
        // changes cannot block auction liveness, and every waterfall leg remains independently auditable.
        _transferSettlementExact(msg.sender, address(settlementEscrow), price);
        if (lenderPaid > 0) {
            _recordEscrowClaim(position.buyer, lenderPaid, _reference("LIQUIDATION_LENDER", positionId));
        }
        if (feePaid > 0) {
            _recordEscrowClaim(feeTreasury, feePaid, _reference("LIQUIDATION_FEE", positionId));
        }
        if (sellerSurplus > 0) {
            _recordEscrowClaim(position.seller, sellerSurplus, _reference("LIQUIDATION_SURPLUS", positionId));
        }
        CollateralVaultV2(position.vault).releaseAuction(auctionId, msg.sender);
        emit PositionLiquidated(
            positionId, auctionId, msg.sender, price, lenderPaid, feePaid, sellerSurplus, shortfall
        );
    }

    function finalizeFailedAuction(uint256 auctionId) external nonReentrant {
        uint256 positionId = positionForAuction[auctionId];
        Position storage position = _positions[positionId];
        if (position.status != PositionStatus.AUCTION || position.auctionId != auctionId) revert InvalidStatus();
        auctionHouse.markFailed(auctionId);
        position.status = PositionStatus.AUCTION_FAILED;
        emit AuctionFailed(positionId, auctionId);
    }

    function claimDefaultCollateral(uint256 positionId, address recipient) external nonReentrant {
        Position storage position = _positions[positionId];
        if (position.status != PositionStatus.AUCTION_FAILED) revert AuctionNotFailed();
        if (msg.sender != position.buyer) revert UnauthorizedBuyer();
        _requireCompliant(msg.sender);
        _requireCompliant(recipient);
        position.status = PositionStatus.COLLATERAL_CLAIMED;
        CollateralVaultV2(position.vault).releaseAuction(position.auctionId, recipient);
        emit DefaultCollateralClaimed(positionId, msg.sender, recipient);
    }

    /// @notice Bounded lender escape if the signed oracle remains unavailable after default.
    /// A live price always routes closeout through the auction instead.
    function claimCollateralOnOracleFailure(uint256 positionId, address recipient) external nonReentrant {
        Position storage position = _positions[positionId];
        if (position.status != PositionStatus.ACTIVE) revert InvalidStatus();
        if (msg.sender != position.buyer) revert UnauthorizedBuyer();
        if (block.timestamp <= uint256(position.repaymentDeadline) + position.staleOracleFallbackDelay) {
            revert OracleFallbackNotOpen();
        }
        _requireCompliant(msg.sender);
        _requireCompliant(recipient);
        try valuationOracle.freshPrice(position.asset, address(settlementToken), position.maxOracleAge) returns (
            uint256,
            uint64,
            bytes32
        ) {
            revert OracleStillLive();
        } catch {
            position.status = PositionStatus.COLLATERAL_CLAIMED;
            CollateralVaultV2(position.vault).seizePosition(positionId, recipient);
            emit StaleOracleCollateralClaimed(positionId, msg.sender, recipient);
        }
    }

    function getOffer(uint256 offerId) external view returns (Offer memory) {
        return _offers[offerId];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    function getAssetConfig(address asset) external view returns (AssetConfig memory) {
        return _assets[asset];
    }

    function previewFill(uint256 offerId, uint256 fillPrincipal)
        external
        view
        returns (uint256 collateralForFill, uint256 fee, uint256 sellerProceeds)
    {
        Offer storage offer = _offers[offerId];
        uint256 newFilled = uint256(offer.filledPrincipal) + fillPrincipal;
        if (fillPrincipal == 0 || newFilled > offer.targetPrincipal) revert InvalidAmount();
        uint256 newAllocated = Math.mulDiv(offer.totalCollateral, newFilled, offer.targetPrincipal);
        collateralForFill = newAllocated - offer.allocatedCollateral;
        uint256 cumulativeFee = Math.mulDiv(newFilled, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        fee = cumulativeFee - offer.feeCharged;
        sellerProceeds = fillPrincipal - fee;
    }

    function setEntryPaused(bool paused) external onlyOwner {
        entryPaused = paused;
        emit EntryPauseChanged(paused);
    }

    function guardianPauseEntry() external {
        if (msg.sender != pauseGuardian) revert OnlyPauseGuardian();
        if (!entryPaused) {
            entryPaused = true;
            emit EntryPauseChanged(true);
        }
    }

    function setPauseGuardian(address guardian) external onlyOwner {
        if (guardian == address(0)) revert InvalidAddress();
        address previous = pauseGuardian;
        pauseGuardian = guardian;
        emit PauseGuardianChanged(previous, guardian);
    }

    function setFeeTreasury(address treasury) external onlyOwner {
        if (treasury == address(0)) revert InvalidAddress();
        address previous = feeTreasury;
        feeTreasury = treasury;
        emit FeeTreasuryChanged(previous, treasury);
    }

    function rescueVaultExcess(address asset, IERC20 token, address recipient, uint256 amount) external onlyOwner {
        AssetConfig storage config = _configuredAsset(asset);
        config.vault.rescueExcessToken(token, recipient, amount);
    }

    function _configuredAsset(address asset) private view returns (AssetConfig storage config) {
        config = _assets[asset];
        if (address(config.vault) == address(0)) revert AssetNotEnabled();
    }

    function _requireEntryAsset(address asset) private view returns (AssetConfig storage config) {
        config = _configuredAsset(asset);
        if (!assetRegistry.isAssetEnabled(asset)) revert AssetNotEnabled();
        if (!config.cleanverseReady) revert CleanverseVaultNotReady(asset);
    }

    function _requireCompliant(address user) private view {
        if (user == address(0) || !validator.complianceVerify(address(this), user)) revert ComplianceFailed(user);
    }

    function _requireLtv(uint256 debt, uint256 value, uint256 maximumBps) private pure {
        if (value == 0 || Math.mulDiv(debt, BPS_DENOMINATOR, value, Math.Rounding.Ceil) > maximumBps) {
            revert InsufficientCollateralValue(debt, value, maximumBps);
        }
    }

    function _interest(uint256 principal, uint256 annualRateBps, uint256 elapsed)
        private
        pure
        returns (uint256)
    {
        if (annualRateBps == 0 || elapsed == 0) return 0;
        return Math.mulDiv(
            principal,
            annualRateBps * elapsed,
            BPS_DENOMINATOR * SECONDS_PER_YEAR,
            Math.Rounding.Ceil
        );
    }

    function _payOrEscrow(address payer, address beneficiary, uint256 amount, bytes32 claimReference) private {
        if (validator.complianceVerify(address(this), beneficiary)) {
            _transferSettlementExact(payer, beneficiary, amount);
        } else {
            _transferSettlementExact(payer, address(settlementEscrow), amount);
            uint256 claimId = settlementEscrow.recordClaim(beneficiary, amount, claimReference);
            emit SettlementEscrowed(beneficiary, claimId, amount, claimReference);
        }
    }

    function _recordEscrowClaim(address beneficiary, uint256 amount, bytes32 claimReference) private {
        uint256 claimId = settlementEscrow.recordClaim(beneficiary, amount, claimReference);
        emit SettlementEscrowed(beneficiary, claimId, amount, claimReference);
    }

    function _transferSettlementExact(address payer, address recipient, uint256 amount) private {
        if (amount == 0 || payer == recipient) return;
        uint256 payerBefore = settlementToken.balanceOf(payer);
        uint256 beforeBalance = settlementToken.balanceOf(recipient);
        settlementToken.safeTransferFrom(payer, recipient, amount);
        uint256 payerAfter = settlementToken.balanceOf(payer);
        uint256 afterBalance = settlementToken.balanceOf(recipient);
        uint256 debited = payerBefore >= payerAfter ? payerBefore - payerAfter : 0;
        uint256 received = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (debited != amount || received != amount) revert NonExactSettlementTransfer(amount, received);
    }

    function _reference(string memory kind, uint256 id) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, id));
    }
}

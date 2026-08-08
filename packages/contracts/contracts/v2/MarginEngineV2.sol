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

/// @notice Opt-in same-CVA master netting set. Debt is fixed face debt per exposure, which makes
/// health, cross-default, and pari-passu liquidation O(1) without iterating over lenders.
/// This engine deploys and controls its own vault; it never shares RepoMarketV2 custody.
contract MarginEngineV2 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant RAY = 1e27;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_FUNDING_WINDOW = 30 days;
    uint8 private constant AUCTION_KIND_MARGIN_ACCOUNT = 2;
    uint256 private constant IN_KIND_AUCTION_OFFSET = 1 << 255;

    enum AccountStatus {
        NONE,
        OPEN,
        MARGIN_CALL,
        LIQUIDATING,
        LIQUIDATED,
        AUCTION_FAILED,
        CLOSED
    }

    enum ExposureStatus {
        NONE,
        ACTIVE,
        REPAID,
        PROCEEDS_CLAIMED,
        COLLATERAL_CLAIMED
    }

    struct Account {
        address seller;
        address permittedLender;
        uint128 collateralAmount;
        uint128 fundingTarget;
        uint128 minimumFunding;
        uint128 totalFunded;
        uint128 totalFaceDebt;
        uint128 feeCharged;
        uint128 frozenDebt;
        uint128 liquidationProceeds;
        uint128 remainingProceeds;
        uint128 remainingCollateral;
        uint64 marginCallDeadline;
        uint64 defaultDeclaredAt;
        uint64 fundingDuration;
        uint64 fundingExpiry;
        uint64 maxOracleAge;
        uint64 auctionDuration;
        uint64 marginCallPeriod;
        uint64 staleOracleFallbackDelay;
        uint32 activeExposureCount;
        uint32 unclaimedExposureCount;
        uint32 maxAnnualRateBps;
        uint16 initialLtvBps;
        uint16 maintenanceLtvBps;
        uint16 liquidationLtvBps;
        uint16 auctionStartBps;
        uint16 auctionFloorBps;
        uint16 liquidationFeeBps;
        bool paymentDefaultDeclared;
        bool inKindCloseout;
        bool fundingClosed;
        AccountStatus status;
        uint256 auctionId;
        uint256 claimPoolId;
        bytes32 closeoutValuationDigest;
    }

    /// @notice Seller-authored, non-revolving funding mandate for one master netting set.
    /// Lenders may improve the rate, but cannot change its size, duration, expiry, or access policy.
    struct OpenAccountParams {
        uint128 collateralAmount;
        uint128 fundingTarget;
        uint128 minimumFunding;
        uint32 maxAnnualRateBps;
        uint64 duration;
        uint64 fundingExpiry;
        address permittedLender;
    }

    struct Exposure {
        uint256 accountId;
        address lender;
        uint128 principal;
        uint128 faceDebt;
        uint64 openedAt;
        uint64 maturity;
        ExposureStatus status;
    }

    error EntryPaused();
    error OnlyPauseGuardian();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDuration();
    error InvalidRate();
    error InvalidStatus();
    error UnauthorizedSeller();
    error UnauthorizedLender();
    error SelfTrade();
    error ComplianceFailed(address user);
    error CleanverseCustodyNotReady();
    error AssetNotEnabled();
    error HealthCheckFailed(uint256 ltvBps, uint256 limitBps);
    error MarginCallNotOpen();
    error LiquidationNotOpen();
    error SlippageExceeded(uint256 actual, uint256 limit);
    error OracleStillLive();
    error OracleFallbackNotOpen();
    error NonExactSettlementTransfer(uint256 expected, uint256 received);

    IERC20 public immutable settlementToken;
    IERC20 public immutable asset;
    IComplianceValidator public immutable validator;
    ICvaAssetRegistry public immutable assetRegistry;
    SignedValuationOracle public immutable valuationOracle;
    RiskManagerV2 public immutable riskManager;
    CollateralVaultV2 public immutable vault;
    DutchAuctionV2 public immutable auctionHouse;
    SettlementEscrowV2 public immutable settlementEscrow;
    uint8 public immutable assetDecimals;
    uint8 public immutable settlementDecimals;
    uint16 public immutable protocolFeeBps;
    uint64 public immutable gracePeriod;

    address public feeTreasury;
    address public pauseGuardian;
    bool public entryPaused;
    bool public cleanverseCustodyReady;
    uint256 public nextAccountId = 1;
    uint256 public nextExposureId = 1;

    mapping(uint64 duration => bool allowed) public allowedDurations;
    mapping(uint256 accountId => Account account) private _accounts;
    mapping(uint256 exposureId => Exposure exposure) private _exposures;
    mapping(uint256 auctionId => uint256 accountId) public accountForAuction;

    event CleanverseCustodyReadinessChanged(bool ready);
    event MarginCollateralDeposited(address indexed seller, uint256 amount);
    event MarginCollateralWithdrawn(address indexed seller, address indexed recipient, uint256 amount);
    event MarginAccountOpened(
        uint256 indexed accountId,
        address indexed seller,
        uint256 collateralAmount,
        uint256 fundingTarget,
        uint256 minimumFunding,
        uint256 maxAnnualRateBps,
        uint256 duration,
        uint256 fundingExpiry,
        address permittedLender
    );
    event MarginCollateralAdded(uint256 indexed accountId, uint256 amount, uint256 collateralAfter);
    event MarginCollateralReleased(uint256 indexed accountId, uint256 amount, uint256 collateralAfter);
    event FundingMandateClosed(uint256 indexed accountId, uint256 fundedPrincipal, uint256 unfilledPrincipal);
    event ExposureFunded(
        uint256 indexed accountId,
        uint256 indexed exposureId,
        address indexed lender,
        uint256 principal,
        uint256 faceDebt,
        uint256 fee,
        uint256 annualRateBps,
        uint256 duration,
        uint256 openedAt,
        uint256 maturity
    );
    event ExposureRepaid(
        uint256 indexed accountId,
        uint256 indexed exposureId,
        address indexed lender,
        uint256 faceDebt,
        bool escrowed,
        uint256 claimId
    );
    event PaymentDefaultDeclared(uint256 indexed accountId, uint256 indexed exposureId, uint64 declaredAt);
    event MarginCallOpened(uint256 indexed accountId, uint256 ltvBps, uint64 cureDeadline);
    event MarginCallCured(uint256 indexed accountId, uint256 ltvBps);
    event MarginLiquidationStarted(
        uint256 indexed accountId,
        uint256 indexed auctionId,
        uint256 frozenDebt,
        uint256 collateral,
        bytes32 indexed valuationDigest
    );
    event MarginLiquidated(
        uint256 indexed accountId,
        uint256 indexed auctionId,
        address indexed buyer,
        uint256 price,
        uint256 lenderPool,
        uint256 fee,
        uint256 sellerSurplus,
        uint256 shortfall
    );
    event MarginAuctionFailed(uint256 indexed accountId, uint256 indexed auctionId);
    event MarginInKindCloseoutStarted(uint256 indexed accountId, uint256 indexed claimPoolId);
    event LiquidationProceedsMaterialized(
        uint256 indexed accountId,
        uint256 indexed exposureId,
        address indexed lender,
        uint256 claimId,
        uint256 amount
    );
    event LiquidationCollateralClaimed(
        uint256 indexed accountId,
        uint256 indexed exposureId,
        address indexed lender,
        address recipient,
        uint256 amount
    );
    event MarginAccountClosed(uint256 indexed accountId, uint256 collateralReleased);
    event SettlementEscrowed(
        address indexed beneficiary, uint256 indexed claimId, uint256 amount, bytes32 indexed claimReference
    );
    event EntryPauseChanged(bool paused);
    event PauseGuardianChanged(address indexed previousGuardian, address indexed newGuardian);

    modifier whenEntryOpen() {
        if (entryPaused) revert EntryPaused();
        _;
    }

    modifier whenCustodyReady() {
        if (!cleanverseCustodyReady) revert CleanverseCustodyNotReady();
        _;
    }

    constructor(
        address initialOwner,
        address settlementToken_,
        address asset_,
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
            initialOwner == address(0) || settlementToken_ == address(0) || asset_ == address(0)
                || validator_ == address(0) || assetRegistry_ == address(0) || valuationOracle_ == address(0)
                || riskManager_ == address(0) || moduleFactory_ == address(0) || feeTreasury_ == address(0)
        ) revert InvalidAddress();
        if (protocolFeeBps_ >= BPS_DENOMINATOR || gracePeriod_ == 0 || gracePeriod_ > 30 days) revert InvalidAmount();
        if (!ICvaAssetRegistry(assetRegistry_).isAssetEnabled(asset_)) revert AssetNotEnabled();
        if (allowedDurations_.length == 0) revert InvalidDuration();

        settlementToken = IERC20(settlementToken_);
        asset = IERC20(asset_);
        validator = IComplianceValidator(validator_);
        assetRegistry = ICvaAssetRegistry(assetRegistry_);
        valuationOracle = SignedValuationOracle(valuationOracle_);
        riskManager = RiskManagerV2(riskManager_);
        feeTreasury = feeTreasury_;
        pauseGuardian = initialOwner;
        protocolFeeBps = protocolFeeBps_;
        gracePeriod = gracePeriod_;
        assetDecimals = IERC20Metadata(asset_).decimals();
        settlementDecimals = IERC20Metadata(settlementToken_).decimals();
        if (assetDecimals > 18 || settlementDecimals > 18) revert InvalidAmount();

        ProtocolModuleFactoryV2 factory = ProtocolModuleFactoryV2(moduleFactory_);
        vault = CollateralVaultV2(factory.deployVault(asset_));
        auctionHouse = DutchAuctionV2(factory.deployAuction());
        settlementEscrow = SettlementEscrowV2(factory.deploySettlementEscrow(settlementToken_, validator_));
        for (uint256 i; i < allowedDurations_.length; ++i) {
            uint64 duration = allowedDurations_[i];
            if (duration == 0 || duration > MAX_DURATION) revert InvalidDuration();
            allowedDurations[duration] = true;
        }
    }

    function setCleanverseCustodyReady(bool ready) external onlyOwner {
        cleanverseCustodyReady = ready;
        emit CleanverseCustodyReadinessChanged(ready);
    }

    /// @notice Risk-reducing deposits remain available while new exposure is paused.
    function depositCollateral(uint256 amount) external nonReentrant whenCustodyReady {
        if (!assetRegistry.isAssetEnabled(address(asset))) revert AssetNotEnabled();
        _requireCompliant(msg.sender);
        vault.depositFor(msg.sender, amount);
        emit MarginCollateralDeposited(msg.sender, amount);
    }

    function withdrawAvailable(uint256 amount, address recipient) external nonReentrant {
        _requireCompliant(msg.sender);
        _requireCompliant(recipient);
        vault.withdrawTo(msg.sender, recipient, amount);
        emit MarginCollateralWithdrawn(msg.sender, recipient, amount);
    }

    function openMarginAccount(OpenAccountParams calldata params)
        external
        nonReentrant
        whenEntryOpen
        whenCustodyReady
        returns (uint256 accountId)
    {
        if (!assetRegistry.isAssetEnabled(address(asset))) revert AssetNotEnabled();
        if (
            params.collateralAmount == 0 || params.fundingTarget == 0 || params.minimumFunding == 0
                || params.minimumFunding > params.fundingTarget
        ) revert InvalidAmount();
        if (params.maxAnnualRateBps > 100_000) revert InvalidRate();
        if (!allowedDurations[params.duration]) revert InvalidDuration();
        if (
            params.fundingExpiry <= block.timestamp
                || params.fundingExpiry > block.timestamp + MAX_FUNDING_WINDOW
        ) revert InvalidDuration();
        if (params.permittedLender == msg.sender) revert SelfTrade();
        _requireCompliant(msg.sender);
        RiskManagerV2.RiskConfig memory config = riskManager.getConfig(address(asset));
        accountId = nextAccountId++;
        _accounts[accountId] = Account({
            seller: msg.sender,
            permittedLender: params.permittedLender,
            collateralAmount: params.collateralAmount,
            fundingTarget: params.fundingTarget,
            minimumFunding: params.minimumFunding,
            totalFunded: 0,
            totalFaceDebt: 0,
            feeCharged: 0,
            frozenDebt: 0,
            liquidationProceeds: 0,
            remainingProceeds: 0,
            remainingCollateral: 0,
            marginCallDeadline: 0,
            defaultDeclaredAt: 0,
            fundingDuration: params.duration,
            fundingExpiry: params.fundingExpiry,
            maxOracleAge: config.maxOracleAge,
            auctionDuration: config.auctionDuration,
            marginCallPeriod: config.marginCallPeriod,
            staleOracleFallbackDelay: config.staleOracleFallbackDelay,
            activeExposureCount: 0,
            unclaimedExposureCount: 0,
            maxAnnualRateBps: params.maxAnnualRateBps,
            initialLtvBps: config.initialLtvBps,
            maintenanceLtvBps: config.maintenanceLtvBps,
            liquidationLtvBps: config.liquidationLtvBps,
            auctionStartBps: config.auctionStartBps,
            auctionFloorBps: config.auctionFloorBps,
            liquidationFeeBps: config.liquidationFeeBps,
            paymentDefaultDeclared: false,
            inKindCloseout: false,
            fundingClosed: false,
            status: AccountStatus.OPEN,
            auctionId: 0,
            claimPoolId: 0,
            closeoutValuationDigest: bytes32(0)
        });
        vault.reserveMargin(msg.sender, accountId, params.collateralAmount);
        emit MarginAccountOpened(
            accountId,
            msg.sender,
            params.collateralAmount,
            params.fundingTarget,
            params.minimumFunding,
            params.maxAnnualRateBps,
            params.duration,
            params.fundingExpiry,
            params.permittedLender
        );
    }

    function addMarginCollateral(uint256 accountId, uint128 amount) external nonReentrant {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.OPEN && account.status != AccountStatus.MARGIN_CALL) revert InvalidStatus();
        if (msg.sender != account.seller) revert UnauthorizedSeller();
        if (amount == 0 || uint256(account.collateralAmount) + amount > type(uint128).max) revert InvalidAmount();
        vault.addMargin(account.seller, accountId, amount);
        account.collateralAmount += amount;
        emit MarginCollateralAdded(accountId, amount, account.collateralAmount);
    }

    function withdrawExcessCollateral(uint256 accountId, uint128 amount, address recipient) external nonReentrant {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.OPEN || msg.sender != account.seller) revert UnauthorizedSeller();
        if (amount == 0 || amount > account.collateralAmount) revert InvalidAmount();
        _requireCompliant(msg.sender);
        _requireCompliant(recipient);
        uint256 remaining = uint256(account.collateralAmount) - amount;
        if (account.totalFaceDebt > 0) {
            (uint256 value,) = _collateralValue(account, remaining);
            uint256 ltv = riskManager.ltvBps(account.totalFaceDebt, value);
            if (ltv > account.initialLtvBps) revert HealthCheckFailed(ltv, account.initialLtvBps);
        }
        account.collateralAmount = uint128(remaining);
        vault.releaseMargin(account.seller, accountId, amount);
        vault.withdrawTo(account.seller, recipient, amount);
        emit MarginCollateralReleased(accountId, amount, remaining);
    }

    /// @notice Seller can permanently cancel the unfilled portion without affecting live exposures.
    function closeFunding(uint256 accountId) external {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.OPEN && account.status != AccountStatus.MARGIN_CALL) revert InvalidStatus();
        if (msg.sender != account.seller) revert UnauthorizedSeller();
        if (account.fundingClosed) revert InvalidStatus();
        account.fundingClosed = true;
        emit FundingMandateClosed(
            accountId,
            account.totalFunded,
            uint256(account.fundingTarget) - account.totalFunded
        );
    }

    function fundMarginAccount(uint256 accountId, uint128 principal, uint32 annualRateBps, uint256 maxFee)
        external
        nonReentrant
        whenEntryOpen
        whenCustodyReady
        returns (uint256 exposureId)
    {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.OPEN) revert InvalidStatus();
        if (account.fundingClosed) revert InvalidStatus();
        if (msg.sender == account.seller) revert SelfTrade();
        if (!assetRegistry.isAssetEnabled(address(asset))) revert AssetNotEnabled();
        RiskManagerV2.RiskConfig memory liveRisk = riskManager.getConfig(address(asset));
        if (block.timestamp > account.fundingExpiry) revert InvalidDuration();
        if (account.permittedLender != address(0) && msg.sender != account.permittedLender) {
            revert UnauthorizedLender();
        }
        uint256 remainingFunding = uint256(account.fundingTarget) - account.totalFunded;
        if (principal == 0 || principal > remainingFunding) revert InvalidAmount();
        if (principal < account.minimumFunding && principal != remainingFunding) revert InvalidAmount();
        if (annualRateBps > account.maxAnnualRateBps) revert InvalidRate();
        _requireCompliant(msg.sender);
        _requireCompliant(account.seller);

        uint256 interest = annualRateBps == 0
            ? 0
            : Math.mulDiv(
                principal,
                uint256(annualRateBps) * account.fundingDuration,
                BPS_DENOMINATOR * SECONDS_PER_YEAR,
                Math.Rounding.Ceil
            );
        uint256 faceDebt = uint256(principal) + interest;
        uint256 debtAfter = uint256(account.totalFaceDebt) + faceDebt;
        if (debtAfter > type(uint128).max) revert InvalidAmount();
        uint64 fundingMaxOracleAge = account.maxOracleAge < liveRisk.maxOracleAge
            ? account.maxOracleAge
            : liveRisk.maxOracleAge;
        (uint256 price,,) = valuationOracle.freshPrice(
            address(asset), address(settlementToken), fundingMaxOracleAge
        );
        uint256 value = riskManager.collateralValue(
            account.collateralAmount, assetDecimals, settlementDecimals, price
        );
        uint256 ltv = riskManager.ltvBps(debtAfter, value);
        uint256 fundingLtvLimit = account.initialLtvBps < liveRisk.initialLtvBps
            ? account.initialLtvBps
            : liveRisk.initialLtvBps;
        if (ltv > fundingLtvLimit) revert HealthCheckFailed(ltv, fundingLtvLimit);

        uint256 fundedAfter = uint256(account.totalFunded) + principal;
        uint256 cumulativeFee = Math.mulDiv(fundedAfter, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        uint256 fee = cumulativeFee - account.feeCharged;
        if (fee > maxFee || fee >= principal || fundedAfter > type(uint128).max) {
            revert SlippageExceeded(fee, maxFee);
        }

        exposureId = nextExposureId++;
        uint64 openedAt = uint64(block.timestamp);
        _exposures[exposureId] = Exposure({
            accountId: accountId,
            lender: msg.sender,
            principal: principal,
            faceDebt: uint128(faceDebt),
            openedAt: openedAt,
            maturity: openedAt + account.fundingDuration,
            status: ExposureStatus.ACTIVE
        });
        account.totalFunded = uint128(fundedAfter);
        account.totalFaceDebt = uint128(debtAfter);
        account.feeCharged = uint128(cumulativeFee);
        account.activeExposureCount += 1;
        if (fundedAfter == account.fundingTarget) account.fundingClosed = true;

        _transferSettlementExact(msg.sender, account.seller, uint256(principal) - fee);
        if (fee > 0) _payOrEscrow(msg.sender, feeTreasury, fee, _reference("MARGIN_OPEN_FEE", exposureId));
        emit ExposureFunded(
            accountId,
            exposureId,
            msg.sender,
            principal,
            faceDebt,
            fee,
            annualRateBps,
            account.fundingDuration,
            openedAt,
            openedAt + account.fundingDuration
        );
    }

    function repayExposure(uint256 exposureId, uint256 maxFaceDebt, bool useEscrow) external nonReentrant {
        Exposure storage exposure = _exposures[exposureId];
        Account storage account = _accounts[exposure.accountId];
        if (exposure.status != ExposureStatus.ACTIVE) revert InvalidStatus();
        // Once closeout snapshots the account, individual repayment would corrupt
        // the frozen pro-rata denominator and can strand escrow/collateral dust.
        if (account.status != AccountStatus.OPEN && account.status != AccountStatus.MARGIN_CALL) {
            revert InvalidStatus();
        }
        if (msg.sender != account.seller) revert UnauthorizedSeller();
        if (exposure.faceDebt > maxFaceDebt) revert SlippageExceeded(exposure.faceDebt, maxFaceDebt);
        _requireCompliant(msg.sender);

        exposure.status = ExposureStatus.REPAID;
        account.totalFaceDebt -= exposure.faceDebt;
        account.activeExposureCount -= 1;
        if (account.totalFaceDebt == 0) {
            account.paymentDefaultDeclared = false;
            account.defaultDeclaredAt = 0;
        }
        uint256 claimId;
        if (useEscrow) {
            _transferSettlementExact(msg.sender, address(settlementEscrow), exposure.faceDebt);
            claimId = settlementEscrow.recordClaim(
                exposure.lender, exposure.faceDebt, _reference("MARGIN_REPAY", exposureId)
            );
            emit SettlementEscrowed(
                exposure.lender, claimId, exposure.faceDebt, _reference("MARGIN_REPAY", exposureId)
            );
        } else {
            _requireCompliant(exposure.lender);
            _transferSettlementExact(msg.sender, exposure.lender, exposure.faceDebt);
        }
        emit ExposureRepaid(
            exposure.accountId, exposureId, exposure.lender, exposure.faceDebt, useEscrow, claimId
        );
    }

    function declarePaymentDefault(uint256 exposureId) external {
        Exposure storage exposure = _exposures[exposureId];
        Account storage account = _accounts[exposure.accountId];
        if (exposure.status != ExposureStatus.ACTIVE) revert InvalidStatus();
        if (block.timestamp <= uint256(exposure.maturity) + gracePeriod) revert LiquidationNotOpen();
        if (account.status != AccountStatus.OPEN && account.status != AccountStatus.MARGIN_CALL) revert InvalidStatus();
        if (account.totalFaceDebt == 0) revert LiquidationNotOpen();
        if (account.paymentDefaultDeclared) revert InvalidStatus();
        account.paymentDefaultDeclared = true;
        account.defaultDeclaredAt = uint64(block.timestamp);
        emit PaymentDefaultDeclared(exposure.accountId, exposureId, uint64(block.timestamp));
    }

    function openMarginCall(uint256 accountId) external {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.OPEN) revert InvalidStatus();
        uint256 ltv = accountLtv(accountId);
        if (ltv <= account.maintenanceLtvBps) revert MarginCallNotOpen();
        account.status = AccountStatus.MARGIN_CALL;
        account.marginCallDeadline = uint64(block.timestamp) + account.marginCallPeriod;
        emit MarginCallOpened(accountId, ltv, account.marginCallDeadline);
    }

    function cureMarginCall(uint256 accountId) external {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.MARGIN_CALL) revert InvalidStatus();
        uint256 ltv = accountLtv(accountId);
        if (ltv > account.maintenanceLtvBps || account.paymentDefaultDeclared) revert HealthCheckFailed(ltv, account.maintenanceLtvBps);
        account.status = AccountStatus.OPEN;
        account.marginCallDeadline = 0;
        emit MarginCallCured(accountId, ltv);
    }

    function startMarginLiquidation(uint256 accountId) external nonReentrant returns (uint256 auctionId) {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.OPEN && account.status != AccountStatus.MARGIN_CALL) revert InvalidStatus();
        if (account.totalFaceDebt == 0) revert LiquidationNotOpen();
        uint256 ltv = accountLtv(accountId);
        bool uncuredCall = account.status == AccountStatus.MARGIN_CALL
            && block.timestamp > account.marginCallDeadline && ltv > account.maintenanceLtvBps;
        if (!account.paymentDefaultDeclared && ltv <= account.liquidationLtvBps && !uncuredCall) {
            revert LiquidationNotOpen();
        }
        (uint256 value, bytes32 valuationDigest) = _collateralValue(account, account.collateralAmount);
        uint256 startPrice = Math.mulDiv(value, account.auctionStartBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        uint256 floorPrice = Math.mulDiv(value, account.auctionFloorBps, BPS_DENOMINATOR);
        if (floorPrice == 0) floorPrice = 1;
        if (startPrice < account.totalFaceDebt) startPrice = account.totalFaceDebt;
        if (startPrice < floorPrice) startPrice = floorPrice;

        auctionId = auctionHouse.create(
            AUCTION_KIND_MARGIN_ACCOUNT,
            accountId,
            account.collateralAmount,
            startPrice,
            floorPrice,
            account.auctionDuration
        );
        account.status = AccountStatus.LIQUIDATING;
        account.auctionId = auctionId;
        account.claimPoolId = auctionId;
        account.inKindCloseout = false;
        account.frozenDebt = account.totalFaceDebt;
        account.unclaimedExposureCount = account.activeExposureCount;
        account.closeoutValuationDigest = valuationDigest;
        accountForAuction[auctionId] = accountId;
        vault.allocateMarginAuction(account.seller, accountId, auctionId);
        emit MarginLiquidationStarted(
            accountId, auctionId, account.frozenDebt, account.collateralAmount, valuationDigest
        );
    }

    function buyMarginAuction(uint256 auctionId, uint256 maxPrice) external nonReentrant {
        uint256 accountId = accountForAuction[auctionId];
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.LIQUIDATING || account.auctionId != auctionId) revert InvalidStatus();
        if (msg.sender == account.seller) revert SelfTrade();
        _requireCompliant(msg.sender);
        uint256 price = auctionHouse.markSold(auctionId, msg.sender, maxPrice);
        uint256 lenderPool = Math.min(price, account.frozenDebt);
        uint256 remaining = price - lenderPool;
        uint256 fee = Math.min(
            remaining,
            Math.mulDiv(price, account.liquidationFeeBps, BPS_DENOMINATOR, Math.Rounding.Ceil)
        );
        uint256 surplus = remaining - fee;
        uint256 shortfall = uint256(account.frozenDebt) - lenderPool;

        // The Engine never custodies settlement assets. The complete purchase price lands in the
        // Cleanverse-registered escrow once; all waterfall legs are then materialized as pull claims.
        _transferSettlementExact(msg.sender, address(settlementEscrow), price);
        account.status = AccountStatus.LIQUIDATED;
        account.liquidationProceeds = uint128(lenderPool);
        account.remainingProceeds = uint128(lenderPool);
        if (fee > 0) _recordEscrowClaim(feeTreasury, fee, _reference("MARGIN_LIQUIDATION_FEE", accountId));
        if (surplus > 0) _recordEscrowClaim(account.seller, surplus, _reference("MARGIN_LIQUIDATION_SURPLUS", accountId));
        vault.releaseAuction(auctionId, msg.sender);
        emit MarginLiquidated(accountId, auctionId, msg.sender, price, lenderPool, fee, surplus, shortfall);
    }

    function finalizeFailedMarginAuction(uint256 auctionId) external nonReentrant {
        uint256 accountId = accountForAuction[auctionId];
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.LIQUIDATING || account.auctionId != auctionId) revert InvalidStatus();
        auctionHouse.markFailed(auctionId);
        account.status = AccountStatus.AUCTION_FAILED;
        account.remainingCollateral = account.collateralAmount;
        emit MarginAuctionFailed(accountId, auctionId);
    }

    function startInKindOracleFallback(uint256 accountId) external nonReentrant {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.OPEN && account.status != AccountStatus.MARGIN_CALL) revert InvalidStatus();
        if (
            !account.paymentDefaultDeclared
                || block.timestamp <= uint256(account.defaultDeclaredAt) + account.staleOracleFallbackDelay
        ) revert OracleFallbackNotOpen();
        try valuationOracle.freshPrice(address(asset), address(settlementToken), account.maxOracleAge) returns (
            uint256,
            uint64,
            bytes32
        ) {
            revert OracleStillLive();
        } catch {
            uint256 claimPoolId = IN_KIND_AUCTION_OFFSET | accountId;
            account.status = AccountStatus.AUCTION_FAILED;
            account.auctionId = 0;
            account.claimPoolId = claimPoolId;
            account.inKindCloseout = true;
            account.frozenDebt = account.totalFaceDebt;
            account.unclaimedExposureCount = account.activeExposureCount;
            account.remainingCollateral = account.collateralAmount;
            vault.allocateMarginAuction(account.seller, accountId, claimPoolId);
            emit MarginInKindCloseoutStarted(accountId, claimPoolId);
        }
    }

    function materializeLiquidationClaim(uint256 exposureId) external nonReentrant returns (uint256 claimId) {
        Exposure storage exposure = _exposures[exposureId];
        Account storage account = _accounts[exposure.accountId];
        if (account.status != AccountStatus.LIQUIDATED || exposure.status != ExposureStatus.ACTIVE) revert InvalidStatus();
        uint256 amount = account.unclaimedExposureCount == 1
            ? account.remainingProceeds
            : Math.mulDiv(account.liquidationProceeds, exposure.faceDebt, account.frozenDebt);
        if (amount > account.remainingProceeds) revert InvalidAmount();
        exposure.status = ExposureStatus.PROCEEDS_CLAIMED;
        account.unclaimedExposureCount -= 1;
        account.remainingProceeds -= uint128(amount);
        // A very small exposure can round to zero in a shortfall. It must still
        // be materializable so another claimant can become the final dust owner.
        if (amount > 0) {
            claimId = settlementEscrow.recordClaim(
                exposure.lender, amount, _reference("MARGIN_LIQUIDATION_LENDER", exposureId)
            );
            emit SettlementEscrowed(
                exposure.lender, claimId, amount, _reference("MARGIN_LIQUIDATION_LENDER", exposureId)
            );
        }
        emit LiquidationProceedsMaterialized(exposure.accountId, exposureId, exposure.lender, claimId, amount);
    }

    function claimFailedCollateral(uint256 exposureId, address recipient) external nonReentrant {
        Exposure storage exposure = _exposures[exposureId];
        Account storage account = _accounts[exposure.accountId];
        if (account.status != AccountStatus.AUCTION_FAILED || exposure.status != ExposureStatus.ACTIVE) revert InvalidStatus();
        if (msg.sender != exposure.lender) revert UnauthorizedLender();
        _requireCompliant(msg.sender);
        _requireCompliant(recipient);
        uint256 amount = account.unclaimedExposureCount == 1
            ? account.remainingCollateral
            : Math.mulDiv(account.collateralAmount, exposure.faceDebt, account.frozenDebt);
        if (amount > account.remainingCollateral) revert InvalidAmount();
        exposure.status = ExposureStatus.COLLATERAL_CLAIMED;
        account.unclaimedExposureCount -= 1;
        account.remainingCollateral -= uint128(amount);
        // Zero-rounded claims are closed without a token transfer so closeout
        // cannot deadlock before the final claimant receives all remaining dust.
        if (amount > 0) vault.releaseAuctionPartial(account.claimPoolId, recipient, amount);
        emit LiquidationCollateralClaimed(exposure.accountId, exposureId, msg.sender, recipient, amount);
    }

    function closeMarginAccount(uint256 accountId) external nonReentrant {
        Account storage account = _accounts[accountId];
        if (account.status != AccountStatus.OPEN || msg.sender != account.seller) revert UnauthorizedSeller();
        if (account.totalFaceDebt != 0) revert InvalidAmount();
        account.status = AccountStatus.CLOSED;
        uint256 released = account.collateralAmount;
        account.collateralAmount = 0;
        if (released > 0) vault.releaseMargin(account.seller, accountId, released);
        emit MarginAccountClosed(accountId, released);
    }

    function accountLtv(uint256 accountId) public view returns (uint256) {
        Account storage account = _accounts[accountId];
        if (account.status == AccountStatus.NONE) revert InvalidStatus();
        if (account.totalFaceDebt == 0) return 0;
        (uint256 value,) = _collateralValue(account, account.collateralAmount);
        return riskManager.ltvBps(account.totalFaceDebt, value);
    }

    function getAccount(uint256 accountId) external view returns (Account memory) {
        return _accounts[accountId];
    }

    function getExposure(uint256 exposureId) external view returns (Exposure memory) {
        return _exposures[exposureId];
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

    function _collateralValue(Account storage account, uint256 collateral)
        private
        view
        returns (uint256 value, bytes32 digest)
    {
        (uint256 price,, bytes32 valuationDigest) =
            valuationOracle.freshPrice(address(asset), address(settlementToken), account.maxOracleAge);
        value = riskManager.collateralValue(collateral, assetDecimals, settlementDecimals, price);
        return (value, valuationDigest);
    }

    function _requireCompliant(address user) private view {
        if (user == address(0) || !validator.complianceVerify(address(this), user)) revert ComplianceFailed(user);
    }

    function _payOrEscrow(address payer, address beneficiary, uint256 amount, bytes32 claimReference) private {
        if (validator.complianceVerify(address(this), beneficiary)) {
            _transferSettlementExact(payer, beneficiary, amount);
        } else {
            _transferSettlementExact(payer, address(settlementEscrow), amount);
            _recordEscrowClaim(beneficiary, amount, claimReference);
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

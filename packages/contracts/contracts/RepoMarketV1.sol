// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IComplianceValidator} from "./interfaces/IComplianceValidator.sol";
import {ICvaAssetRegistry} from "./interfaces/ICvaAssetRegistry.sol";

contract RepoMarketV1 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_OFFER_LIFETIME = 30 days;
    uint32 public constant MAX_ANNUAL_RATE_BPS = 100_000;

    enum RepoStatus {
        NONE,
        OPEN,
        ACTIVE,
        REPAID,
        CANCELLED,
        EXPIRED,
        DEFAULTED
    }

    struct Repo {
        address seller;
        address buyer;
        address permittedBuyer;
        address asset;
        uint128 collateralAmount;
        uint128 principalAmount;
        uint128 repurchaseAmount;
        uint32 annualRateBps;
        uint64 duration;
        uint64 offerExpiry;
        uint64 acceptedAt;
        uint64 maturity;
        uint64 repaymentDeadline;
        bytes32 valuationHash;
        RepoStatus status;
    }

    error EntryPaused();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidRate();
    error InvalidDuration();
    error InvalidExpiry();
    error InvalidValuationHash();
    error AssetNotEnabled();
    error ComplianceFailed(address user);
    error InvalidStatus(RepoStatus expected, RepoStatus actual);
    error UnauthorizedBuyer();
    error UnauthorizedSeller();
    error SelfTrade();
    error InsufficientBalance(address token, address account, uint256 required, uint256 available);
    error InsufficientAllowance(address token, address account, uint256 required, uint256 available);
    error BeforeMaturity();
    error RepaymentWindowClosed();
    error DefaultWindowNotOpen();
    error FeeExceedsPrincipal();

    IERC20 public immutable settlementToken;
    IComplianceValidator public immutable validator;
    ICvaAssetRegistry public immutable assetRegistry;
    uint16 public immutable protocolFeeBps;
    uint64 public immutable gracePeriod;

    address public feeTreasury;
    bool public entryPaused;
    uint256 public nextRepoId = 1;

    mapping(uint64 duration => bool allowed) public allowedDurations;
    mapping(uint256 repoId => Repo repo) private _repos;

    event OfferCreated(
        uint256 indexed repoId,
        address indexed seller,
        address indexed asset,
        address permittedBuyer,
        uint256 collateralAmount,
        uint256 principalAmount,
        uint256 annualRateBps,
        uint256 duration,
        uint256 offerExpiry,
        bytes32 valuationHash
    );
    event OfferCancelled(uint256 indexed repoId, address indexed seller);
    event OfferExpired(uint256 indexed repoId);
    event OfferAccepted(
        uint256 indexed repoId,
        address indexed seller,
        address indexed buyer,
        uint256 maturity,
        uint256 repaymentDeadline,
        uint256 repurchaseAmount
    );
    event ProtocolFeePaid(uint256 indexed repoId, address indexed treasury, uint256 amount);
    event RepoRepaid(uint256 indexed repoId, address indexed seller, address indexed buyer, uint256 repurchaseAmount);
    event RepoDefaulted(uint256 indexed repoId, address indexed seller, address indexed buyer);
    event EntryPauseChanged(bool paused);
    event FeeTreasuryChanged(address indexed previousTreasury, address indexed newTreasury);

    modifier whenEntryOpen() {
        if (entryPaused) revert EntryPaused();
        _;
    }

    constructor(
        address initialOwner,
        address settlementToken_,
        address validator_,
        address assetRegistry_,
        address feeTreasury_,
        uint16 protocolFeeBps_,
        uint64 gracePeriod_,
        uint64[] memory allowedDurations_
    ) Ownable(initialOwner) {
        if (
            initialOwner == address(0) || settlementToken_ == address(0) || validator_ == address(0)
                || assetRegistry_ == address(0) || feeTreasury_ == address(0)
        ) revert InvalidAddress();
        if (protocolFeeBps_ >= BPS_DENOMINATOR) revert FeeExceedsPrincipal();
        if (gracePeriod_ == 0 || allowedDurations_.length == 0) revert InvalidDuration();

        settlementToken = IERC20(settlementToken_);
        validator = IComplianceValidator(validator_);
        assetRegistry = ICvaAssetRegistry(assetRegistry_);
        feeTreasury = feeTreasury_;
        protocolFeeBps = protocolFeeBps_;
        gracePeriod = gracePeriod_;

        for (uint256 i = 0; i < allowedDurations_.length; ++i) {
            uint64 duration = allowedDurations_[i];
            if (duration == 0) revert InvalidDuration();
            allowedDurations[duration] = true;
        }
    }

    function createOffer(
        address asset,
        uint128 collateralAmount,
        uint128 principalAmount,
        uint32 annualRateBps,
        uint64 duration,
        uint64 offerExpiry,
        address permittedBuyer,
        bytes32 valuationHash
    ) external whenEntryOpen returns (uint256 repoId) {
        if (!assetRegistry.isAssetEnabled(asset)) revert AssetNotEnabled();
        if (collateralAmount == 0 || principalAmount == 0) revert InvalidAmount();
        if (annualRateBps > MAX_ANNUAL_RATE_BPS) revert InvalidRate();
        if (!allowedDurations[duration]) revert InvalidDuration();
        if (offerExpiry <= block.timestamp || offerExpiry > block.timestamp + MAX_OFFER_LIFETIME) {
            revert InvalidExpiry();
        }
        if (valuationHash == bytes32(0)) revert InvalidValuationHash();

        _requireCompliant(msg.sender);
        _requireBalanceAndAllowance(IERC20(asset), msg.sender, collateralAmount);

        repoId = nextRepoId++;
        _repos[repoId] = Repo({
            seller: msg.sender,
            buyer: address(0),
            permittedBuyer: permittedBuyer,
            asset: asset,
            collateralAmount: collateralAmount,
            principalAmount: principalAmount,
            repurchaseAmount: 0,
            annualRateBps: annualRateBps,
            duration: duration,
            offerExpiry: offerExpiry,
            acceptedAt: 0,
            maturity: 0,
            repaymentDeadline: 0,
            valuationHash: valuationHash,
            status: RepoStatus.OPEN
        });

        emit OfferCreated(
            repoId,
            msg.sender,
            asset,
            permittedBuyer,
            collateralAmount,
            principalAmount,
            annualRateBps,
            duration,
            offerExpiry,
            valuationHash
        );
    }

    function cancelOffer(uint256 repoId) external {
        Repo storage repo = _repos[repoId];
        _requireStatus(repo, RepoStatus.OPEN);
        if (msg.sender != repo.seller) revert UnauthorizedSeller();
        repo.status = RepoStatus.CANCELLED;
        emit OfferCancelled(repoId, msg.sender);
    }

    function expireOffer(uint256 repoId) external {
        Repo storage repo = _repos[repoId];
        _requireStatus(repo, RepoStatus.OPEN);
        if (block.timestamp <= repo.offerExpiry) revert InvalidExpiry();
        repo.status = RepoStatus.EXPIRED;
        emit OfferExpired(repoId);
    }

    function acceptOffer(uint256 repoId) external nonReentrant whenEntryOpen {
        Repo storage repo = _repos[repoId];
        _requireStatus(repo, RepoStatus.OPEN);
        if (block.timestamp > repo.offerExpiry) revert InvalidExpiry();
        if (msg.sender == repo.seller) revert SelfTrade();
        if (repo.permittedBuyer != address(0) && repo.permittedBuyer != msg.sender) revert UnauthorizedBuyer();
        if (!assetRegistry.isAssetEnabled(repo.asset)) revert AssetNotEnabled();

        _requireCompliant(repo.seller);
        _requireCompliant(msg.sender);
        _requireCompliant(feeTreasury);

        IERC20 asset = IERC20(repo.asset);
        _requireBalanceAndAllowance(asset, repo.seller, repo.collateralAmount);
        _requireBalanceAndAllowance(settlementToken, msg.sender, repo.principalAmount);
        _requireAllowance(asset, msg.sender, repo.collateralAmount);

        (uint256 fee, uint256 interest, uint256 repurchaseAmount) = previewEconomics(
            repo.principalAmount, repo.annualRateBps, repo.duration
        );
        uint256 sellerProceeds = uint256(repo.principalAmount) - fee;
        if (sellerProceeds == 0 || repurchaseAmount > type(uint128).max) revert FeeExceedsPrincipal();

        uint64 acceptedAt = uint64(block.timestamp);
        uint64 maturity = acceptedAt + repo.duration;

        repo.buyer = msg.sender;
        repo.acceptedAt = acceptedAt;
        repo.maturity = maturity;
        repo.repaymentDeadline = maturity + gracePeriod;
        repo.repurchaseAmount = uint128(repurchaseAmount);
        repo.status = RepoStatus.ACTIVE;

        settlementToken.safeTransferFrom(msg.sender, repo.seller, sellerProceeds);
        if (fee > 0) settlementToken.safeTransferFrom(msg.sender, feeTreasury, fee);
        asset.safeTransferFrom(repo.seller, msg.sender, repo.collateralAmount);

        emit ProtocolFeePaid(repoId, feeTreasury, fee);
        emit OfferAccepted(repoId, repo.seller, msg.sender, maturity, repo.repaymentDeadline, repurchaseAmount);

        // Silence the compiler if a zero-rate repo is configured.
        interest;
    }

    function repurchase(uint256 repoId) external nonReentrant {
        Repo storage repo = _repos[repoId];
        _requireStatus(repo, RepoStatus.ACTIVE);
        if (msg.sender != repo.seller) revert UnauthorizedSeller();
        if (block.timestamp < repo.maturity) revert BeforeMaturity();
        if (block.timestamp > repo.repaymentDeadline) revert RepaymentWindowClosed();

        _requireCompliant(repo.seller);
        _requireCompliant(repo.buyer);

        IERC20 asset = IERC20(repo.asset);
        _requireBalanceAndAllowance(settlementToken, repo.seller, repo.repurchaseAmount);
        _requireBalanceAndAllowance(asset, repo.buyer, repo.collateralAmount);

        repo.status = RepoStatus.REPAID;
        settlementToken.safeTransferFrom(repo.seller, repo.buyer, repo.repurchaseAmount);
        asset.safeTransferFrom(repo.buyer, repo.seller, repo.collateralAmount);

        emit RepoRepaid(repoId, repo.seller, repo.buyer, repo.repurchaseAmount);
    }

    function markDefault(uint256 repoId) external {
        Repo storage repo = _repos[repoId];
        _requireStatus(repo, RepoStatus.ACTIVE);
        if (block.timestamp <= repo.repaymentDeadline) revert DefaultWindowNotOpen();
        repo.status = RepoStatus.DEFAULTED;
        emit RepoDefaulted(repoId, repo.seller, repo.buyer);
    }

    function previewEconomics(uint256 principalAmount, uint32 annualRateBps, uint64 duration)
        public
        view
        returns (uint256 fee, uint256 interest, uint256 repurchaseAmount)
    {
        fee = Math.mulDiv(principalAmount, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        if (annualRateBps > 0) {
            interest = Math.mulDiv(
                principalAmount,
                uint256(annualRateBps) * duration,
                BPS_DENOMINATOR * SECONDS_PER_YEAR,
                Math.Rounding.Ceil
            );
        }
        repurchaseAmount = principalAmount + interest;
    }

    function getRepo(uint256 repoId) external view returns (Repo memory) {
        return _repos[repoId];
    }

    function setEntryPaused(bool paused) external onlyOwner {
        entryPaused = paused;
        emit EntryPauseChanged(paused);
    }

    function setFeeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        address previousTreasury = feeTreasury;
        feeTreasury = newTreasury;
        emit FeeTreasuryChanged(previousTreasury, newTreasury);
    }

    function _requireCompliant(address user) private view {
        if (!validator.complianceVerify(address(this), user)) revert ComplianceFailed(user);
    }

    function _requireBalanceAndAllowance(IERC20 token, address account, uint256 required) private view {
        uint256 balance = token.balanceOf(account);
        if (balance < required) revert InsufficientBalance(address(token), account, required, balance);
        _requireAllowance(token, account, required);
    }

    function _requireAllowance(IERC20 token, address account, uint256 required) private view {
        uint256 allowance = token.allowance(account, address(this));
        if (allowance < required) revert InsufficientAllowance(address(token), account, required, allowance);
    }

    function _requireStatus(Repo storage repo, RepoStatus expected) private view {
        if (repo.status != expected) revert InvalidStatus(expected, repo.status);
    }
}

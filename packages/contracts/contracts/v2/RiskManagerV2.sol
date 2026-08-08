// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Delayed, per-CVA risk parameters shared by isolated repo and cross-margin engines.
contract RiskManagerV2 is Ownable2Step {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_RATE_BPS = 100_000;

    struct RiskConfig {
        bool enabled;
        uint16 initialLtvBps;
        uint16 maintenanceLtvBps;
        uint16 liquidationLtvBps;
        uint16 auctionStartBps;
        uint16 auctionFloorBps;
        uint16 liquidationFeeBps;
        uint16 earlyMinHoldBps;
        uint16 earlyBreakFeeBps;
        uint32 defaultSpreadBps;
        uint32 maxDefaultRateBps;
        uint64 maxOracleAge;
        uint64 auctionDuration;
        uint64 marginCallPeriod;
        uint64 staleOracleFallbackDelay;
    }

    struct PendingConfig {
        bytes32 configHash;
        uint64 executeAfter;
    }

    error InvalidAddress();
    error InvalidConfig();
    error ConfigNotEnabled(address asset);
    error ConfigNotReady();
    error ConfigHashMismatch();

    uint64 public immutable configDelay;
    mapping(address asset => RiskConfig config) private _configs;
    mapping(address asset => PendingConfig pending) public pendingConfigs;

    event ConfigScheduled(address indexed asset, bytes32 indexed configHash, uint64 executeAfter);
    event ConfigCancelled(address indexed asset);
    event ConfigApplied(address indexed asset, bytes32 indexed configHash, RiskConfig config);

    constructor(address initialOwner, uint64 configDelay_) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
        configDelay = configDelay_;
    }

    function scheduleConfig(address asset, RiskConfig calldata config) external onlyOwner {
        if (asset == address(0)) revert InvalidAddress();
        _validate(config);
        bytes32 configHash = keccak256(abi.encode(config));
        uint64 executeAfter = uint64(block.timestamp) + configDelay;
        pendingConfigs[asset] = PendingConfig(configHash, executeAfter);
        emit ConfigScheduled(asset, configHash, executeAfter);
    }

    function applyConfig(address asset, RiskConfig calldata config) external onlyOwner {
        PendingConfig memory pending = pendingConfigs[asset];
        if (pending.configHash == bytes32(0) || block.timestamp < pending.executeAfter) revert ConfigNotReady();
        bytes32 configHash = keccak256(abi.encode(config));
        if (configHash != pending.configHash) revert ConfigHashMismatch();
        _validate(config);
        _configs[asset] = config;
        delete pendingConfigs[asset];
        emit ConfigApplied(asset, configHash, config);
    }

    function cancelConfig(address asset) external onlyOwner {
        delete pendingConfigs[asset];
        emit ConfigCancelled(asset);
    }

    function getConfig(address asset) external view returns (RiskConfig memory config) {
        config = _configs[asset];
        if (!config.enabled) revert ConfigNotEnabled(asset);
    }

    function rawConfig(address asset) external view returns (RiskConfig memory) {
        return _configs[asset];
    }

    /// @param priceE18 Human settlement-token value per whole asset, scaled by 1e18.
    /// @return value Settlement-token atomic units (for example 1e6 for one 6-decimal USDC).
    function collateralValue(
        uint256 collateralAmount,
        uint8 assetDecimals,
        uint8 settlementDecimals,
        uint256 priceE18
    )
        public
        pure
        returns (uint256)
    {
        if (assetDecimals > 18 || settlementDecimals > 18) revert InvalidConfig();
        uint256 valueE18 = Math.mulDiv(collateralAmount, priceE18, 10 ** assetDecimals);
        return Math.mulDiv(valueE18, 10 ** settlementDecimals, 1e18);
    }

    function ltvBps(uint256 debt, uint256 collateralValue_) public pure returns (uint256) {
        if (collateralValue_ == 0) return type(uint256).max;
        return Math.mulDiv(debt, BPS_DENOMINATOR, collateralValue_, Math.Rounding.Ceil);
    }

    function _validate(RiskConfig calldata config) private pure {
        if (
            config.initialLtvBps == 0 || config.initialLtvBps >= config.maintenanceLtvBps
                || config.maintenanceLtvBps >= config.liquidationLtvBps
                || config.liquidationLtvBps > BPS_DENOMINATOR || config.auctionStartBps < BPS_DENOMINATOR
                || config.auctionFloorBps == 0 || config.auctionFloorBps > config.auctionStartBps
                || config.liquidationFeeBps >= BPS_DENOMINATOR || config.earlyMinHoldBps > BPS_DENOMINATOR
                || config.earlyBreakFeeBps >= BPS_DENOMINATOR || config.maxDefaultRateBps < config.defaultSpreadBps
                || config.defaultSpreadBps > MAX_RATE_BPS || config.maxDefaultRateBps > MAX_RATE_BPS
                || config.maxOracleAge == 0 || config.auctionDuration == 0 || config.marginCallPeriod == 0
                || config.staleOracleFallbackDelay == 0 || config.maxOracleAge > 30 days
                || config.auctionDuration > 30 days || config.marginCallPeriod > 30 days
                || config.staleOracleFallbackDelay > 30 days
        ) revert InvalidConfig();
    }
}

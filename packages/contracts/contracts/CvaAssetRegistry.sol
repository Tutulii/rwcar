// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

contract CvaAssetRegistry is Ownable2Step {
    struct AssetConfig {
        bool enabled;
        uint8 decimals;
        bytes32 cleanverseReferenceHash;
    }

    error InvalidAsset();
    error InvalidDecimals();

    mapping(address asset => AssetConfig config) private _assets;

    event AssetConfigured(
        address indexed asset,
        bool enabled,
        uint8 decimals,
        bytes32 indexed cleanverseReferenceHash
    );

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert OwnableInvalidOwner(address(0));
    }

    function setAsset(
        address asset,
        bool enabled,
        uint8 decimals_,
        bytes32 cleanverseReferenceHash
    ) external onlyOwner {
        if (asset == address(0) || asset.code.length == 0) revert InvalidAsset();
        if (decimals_ > 18) revert InvalidDecimals();

        _assets[asset] = AssetConfig({
            enabled: enabled,
            decimals: decimals_,
            cleanverseReferenceHash: cleanverseReferenceHash
        });

        emit AssetConfigured(asset, enabled, decimals_, cleanverseReferenceHash);
    }

    function isAssetEnabled(address asset) external view returns (bool) {
        return _assets[asset].enabled;
    }

    function getAsset(address asset) external view returns (AssetConfig memory) {
        return _assets[asset];
    }
}

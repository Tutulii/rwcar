// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICvaAssetRegistry {
    function isAssetEnabled(address asset) external view returns (bool);
}

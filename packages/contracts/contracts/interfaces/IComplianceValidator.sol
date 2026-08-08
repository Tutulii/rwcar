// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IComplianceValidator {
    function complianceVerify(address poolAddress, address userAddress) external view returns (bool);

    /// @notice Confirmed Cleanverse Validator overload used by an authorized
    /// Factory (`REGISTER_ROLE`) to issue contract CVI for a pool and custody/fee address.
    function registerApass(address poolAddress, address aTokenAddress, address feeAddress) external;
}

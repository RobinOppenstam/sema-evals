// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Heldout unchecked-call fixture: tip forward without success check.
contract TipJar {
    uint256 public jarBalance;

    function loadJar() external payable {
        jarBalance += msg.value;
    }

    function dropTip(address payable artist, uint256 amount) external {
        require(jarBalance >= amount, "jar");
        jarBalance -= amount;
        /* VULN: no-ok-check */
        artist.call{value: amount}("");
    }
}

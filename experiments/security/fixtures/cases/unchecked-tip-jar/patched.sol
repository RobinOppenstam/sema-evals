// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Patched tip jar: requires dropTip's low-level call to succeed.
contract TipJar {
    uint256 public jarBalance;

    function loadJar() external payable {
        jarBalance += msg.value;
    }

    function dropTip(address payable artist, uint256 amount) external {
        require(jarBalance >= amount, "jar");
        jarBalance -= amount;
        /* PATCH: ok-checked */
        (bool ok, ) = artist.call{value: amount}("");
        require(ok, "tip failed");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Tip jar that forwards ETH from its balance to an artist.
contract TipJar {
    uint256 public jarBalance;

    function loadJar() external payable {
        jarBalance += msg.value;
    }

    function dropTip(address payable artist, uint256 amount) external {
        require(jarBalance >= amount, "jar");
        jarBalance -= amount;
        artist.call{value: amount}("");
    }
}

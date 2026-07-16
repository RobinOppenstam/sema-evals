// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Fee oracle with an updatable basis-point fee.
contract FeeOracle {
    address public governor;
    uint256 public feeBps;

    constructor(uint256 initialFeeBps) {
        governor = msg.sender;
        feeBps = initialFeeBps;
    }

    function updateFee(uint256 nextBps) external {
        require(nextBps <= 10_000, "bps");
        feeBps = nextBps;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Patched fee oracle: only governor may updateFee.
contract FeeOracle {
    address public governor;
    uint256 public feeBps;

    constructor(uint256 initialFeeBps) {
        governor = msg.sender;
        feeBps = initialFeeBps;
    }

    function updateFee(uint256 nextBps) external {
        require(nextBps <= 10_000, "bps");
        /* PATCH: gated-updateFee */
        require(msg.sender == governor, "not governor");
        feeBps = nextBps;
    }
}

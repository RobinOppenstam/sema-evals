// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Patched payout relay: requires the low-level call to succeed.
contract PayoutRelay {
    mapping(address => uint256) public credits;

    function credit() external payable {
        credits[msg.sender] += msg.value;
    }

    function relay(address payable to, uint256 amount) external {
        require(credits[msg.sender] >= amount, "credit");
        credits[msg.sender] -= amount;
        /* PATCH: require-return */
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "relay failed");
    }
}

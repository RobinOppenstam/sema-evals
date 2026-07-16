// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Posts ETH bounties and pays them out to claimants.
contract BountyBoard {
    mapping(uint256 => uint256) public openBounties;
    mapping(address => uint256) public hunterPaid;
    uint256 public nextId;

    function postBounty() external payable returns (uint256 id) {
        require(msg.value > 0, "empty");
        id = nextId++;
        openBounties[id] = msg.value;
    }

    function bountyOf(uint256 id) external view returns (uint256) {
        return openBounties[id];
    }

    function claimBounty(uint256 id) external {
        uint256 reward = openBounties[id];
        require(reward > 0, "gone");
        openBounties[id] = 0;
        hunterPaid[msg.sender] += reward;
        (bool ok, ) = msg.sender.call{value: reward}("");
        require(ok, "pay");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Heldout unchecked-call fixture: discarded refund success flag.
contract RefundDesk {
    mapping(address => uint256) public owed;
    uint256 public deskBalance;

    function fundDesk() external payable {
        deskBalance += msg.value;
    }

    function owedOf(address account) external view returns (uint256) {
        return owed[account];
    }

    function issueRefund(address payable recipient, uint256 amount) external {
        require(owed[recipient] >= amount, "owed");
        require(deskBalance >= amount, "desk");
        owed[recipient] -= amount;
        deskBalance -= amount;
        /* VULN: drop-success */
        recipient.call{value: amount}("");
    }
}

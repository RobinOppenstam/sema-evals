// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice On/off pause switch for a dependent module.
contract PauseSwitch {
    address public curator;
    bool public paused;

    constructor() {
        curator = msg.sender;
    }

    function isPaused() external view returns (bool) {
        return paused;
    }

    function flipPause() external {
        require(msg.sender == curator, "not curator");
        paused = !paused;
    }
}

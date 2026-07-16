// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Patched pause switch: only curator may flipPause.
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
        /* PATCH: curator-flipPause */
        require(msg.sender == curator, "not curator");
        paused = !paused;
    }
}

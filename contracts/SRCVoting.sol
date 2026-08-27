// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title UTAR SRC Voting System — Multi-Election Smart Contract
/// @author Cheng Zheng De
/// @notice Supports multiple independent SRC election events

contract SRCVoting {

    // ─────────────────────────────────────────────────────────────
    //  State Variables
    // ─────────────────────────────────────────────────────────────
    address public admin;
    uint public electionCount;

    // ─────────────────────────────────────────────────────────────
    //  Structs
    // ─────────────────────────────────────────────────────────────
    struct Candidate {
        uint id;
        string name;
        string faculty;
        string position;
        uint voteCount;
        bool exists;
    }

    struct Voter {
        bool isRegistered;
        bool hasVoted;
        uint votedCandidateId;
        uint votedAt;
    }

    struct Election {
        uint id;
        string title;           // e.g. "SRC 2025/2026"
        bool exists;
        bool votingOpen;
        uint startTime;
        uint endTime;
        uint candidateCount;
        uint totalVotesCast;
    }

    // ─────────────────────────────────────────────────────────────
    //  Mappings
    // ─────────────────────────────────────────────────────────────

    // electionId => Election
    mapping(uint => Election) public elections;

    // electionId => candidateId => Candidate
    mapping(uint => mapping(uint => Candidate)) public candidates;

    // electionId => voterAddress => Voter
    mapping(uint => mapping(address => Voter)) public voters;

    // ─────────────────────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────────────────────
    event ElectionCreated(uint indexed electionId, string title);
    event CandidateAdded(uint indexed electionId, uint indexed candidateId, string name);
    event VoterRegistered(uint indexed electionId, address indexed voter);
    event VoteCast(uint indexed electionId, address indexed voter, uint indexed candidateId, uint timestamp);
    event VotingStarted(uint indexed electionId, uint startTime, uint endTime);
    event VotingEnded(uint indexed electionId, uint totalVotes);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ─────────────────────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────────────────────
    modifier onlyAdmin() {
        require(msg.sender == admin, "SRCVoting: caller is not the admin");
        _;
    }

    modifier electionExists(uint _electionId) {
        require(elections[_electionId].exists, "SRCVoting: election does not exist");
        _;
    }

    modifier whenVotingOpen(uint _electionId) {
        require(elections[_electionId].votingOpen, "SRCVoting: voting is not open");
        require(block.timestamp >= elections[_electionId].startTime, "SRCVoting: election not started");
        require(block.timestamp <= elections[_electionId].endTime, "SRCVoting: election period ended");
        _;
    }

    // ─────────────────────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────────────────────
    constructor() {
        admin = msg.sender;
        electionCount = 0;
    }

    // ─────────────────────────────────────────────────────────────
    //  Admin — Election Management
    // ─────────────────────────────────────────────────────────────

    /// @notice Create a new election event
    /// @param _title e.g. "SRC 2025/2026"
    function createElection(string memory _title) external onlyAdmin {
        require(bytes(_title).length > 0, "SRCVoting: title cannot be empty");
        electionCount++;
        elections[electionCount] = Election({
            id: electionCount,
            title: _title,
            exists: true,
            votingOpen: false,
            startTime: 0,
            endTime: 0,
            candidateCount: 0,
            totalVotesCast: 0
        });
        emit ElectionCreated(electionCount, _title);
    }

    /// @notice Add a candidate to a specific election
    function addCandidate(
        uint _electionId,
        string memory _name,
        string memory _faculty,
        string memory _position
    ) external onlyAdmin electionExists(_electionId) {
        require(!elections[_electionId].votingOpen, "SRCVoting: voting is open");
        require(bytes(_name).length > 0, "SRCVoting: name cannot be empty");

        elections[_electionId].candidateCount++;
        uint cId = elections[_electionId].candidateCount;

        candidates[_electionId][cId] = Candidate({
            id: cId,
            name: _name,
            faculty: _faculty,
            position: _position,
            voteCount: 0,
            exists: true
        });

        emit CandidateAdded(_electionId, cId, _name);
    }

    /// @notice Register a voter for a specific election
    function registerVoter(uint _electionId, address _voter)
        external onlyAdmin electionExists(_electionId)
    {
        require(_voter != address(0), "SRCVoting: invalid address");
        require(!voters[_electionId][_voter].isRegistered, "SRCVoting: already registered");

        voters[_electionId][_voter] = Voter({
            isRegistered: true,
            hasVoted: false,
            votedCandidateId: 0,
            votedAt: 0
        });

        emit VoterRegistered(_electionId, _voter);
    }

    /// @notice Batch register voters for a specific election
    function registerVotersBatch(uint _electionId, address[] calldata _voters)
        external onlyAdmin electionExists(_electionId)
    {
        for (uint i = 0; i < _voters.length; i++) {
            address v = _voters[i];
            if (v != address(0) && !voters[_electionId][v].isRegistered) {
                voters[_electionId][v] = Voter({
                    isRegistered: true,
                    hasVoted: false,
                    votedCandidateId: 0,
                    votedAt: 0
                });
                emit VoterRegistered(_electionId, v);
            }
        }
    }

    /// @notice Open voting for a specific election
    /// @param _durationInMinutes Voting window duration
    function startVoting(uint _electionId, uint _durationInMinutes)
        external onlyAdmin electionExists(_electionId)
    {
        Election storage e = elections[_electionId];
        require(!e.votingOpen, "SRCVoting: voting already open");
        require(e.candidateCount >= 2, "SRCVoting: need at least 2 candidates");
        require(_durationInMinutes > 0, "SRCVoting: duration must be > 0");

        e.votingOpen = true;
        e.startTime  = block.timestamp;
        e.endTime    = block.timestamp + (_durationInMinutes * 1 minutes);

        emit VotingStarted(_electionId, e.startTime, e.endTime);
    }

    /// @notice Manually close voting for a specific election
    function endVoting(uint _electionId)
        external onlyAdmin electionExists(_electionId)
    {
        require(elections[_electionId].votingOpen, "SRCVoting: voting not open");
        elections[_electionId].votingOpen = false;
        emit VotingEnded(_electionId, elections[_electionId].totalVotesCast);
    }

    /// @notice Transfer admin role
    function transferAdmin(address _newAdmin) external onlyAdmin {
        require(_newAdmin != address(0), "SRCVoting: invalid address");
        emit AdminTransferred(admin, _newAdmin);
        admin = _newAdmin;
    }

    // ─────────────────────────────────────────────────────────────
    //  Voter Functions
    // ─────────────────────────────────────────────────────────────

    /// @notice Cast a vote in a specific election
    function vote(uint _electionId, uint _candidateId)
        external
        electionExists(_electionId)
        whenVotingOpen(_electionId)
    {
        Voter storage voter = voters[_electionId][msg.sender];
        Election storage e  = elections[_electionId];

        require(voter.isRegistered, "SRCVoting: voter not registered for this election");
        require(!voter.hasVoted, "SRCVoting: already voted");
        require(_candidateId > 0 && _candidateId <= e.candidateCount, "SRCVoting: invalid candidate");
        require(candidates[_electionId][_candidateId].exists, "SRCVoting: candidate not found");

        voter.hasVoted        = true;
        voter.votedCandidateId = _candidateId;
        voter.votedAt         = block.timestamp;

        candidates[_electionId][_candidateId].voteCount++;
        e.totalVotesCast++;

        emit VoteCast(_electionId, msg.sender, _candidateId, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────
    //  View Functions
    // ─────────────────────────────────────────────────────────────

    /// @notice Get all elections
    function getAllElections()
        external view
        returns (uint[] memory ids, string[] memory titles, bool[] memory openFlags, uint[] memory voteCounts)
    {
        ids        = new uint[](electionCount);
        titles     = new string[](electionCount);
        openFlags  = new bool[](electionCount);
        voteCounts = new uint[](electionCount);

        for (uint i = 1; i <= electionCount; i++) {
            ids[i-1]        = elections[i].id;
            titles[i-1]     = elections[i].title;
            openFlags[i-1]  = elections[i].votingOpen;
            voteCounts[i-1] = elections[i].totalVotesCast;
        }
    }

    /// @notice Get status of a specific election
    function getElectionStatus(uint _electionId)
        external view electionExists(_electionId)
        returns (bool isOpen, uint startTime, uint endTime, uint numCandidates, uint totalVotesCast, string memory title)
    {
        Election storage e = elections[_electionId];
        return (e.votingOpen, e.startTime, e.endTime, e.candidateCount, e.totalVotesCast, e.title);
    }

    /// @notice Get all candidates and vote counts for a specific election
    function getResults(uint _electionId)
        external view electionExists(_electionId)
        returns (uint[] memory ids, string[] memory names, string[] memory faculties, string[] memory positions, uint[] memory voteCounts)
    {
        uint count = elections[_electionId].candidateCount;
        ids        = new uint[](count);
        names      = new string[](count);
        faculties  = new string[](count);
        positions  = new string[](count);
        voteCounts = new uint[](count);

        for (uint i = 1; i <= count; i++) {
            Candidate storage c = candidates[_electionId][i];
            ids[i-1]        = c.id;
            names[i-1]      = c.name;
            faculties[i-1]  = c.faculty;
            positions[i-1]  = c.position;
            voteCounts[i-1] = c.voteCount;
        }
    }

    /// @notice Get voter status for a specific election
    function getVoterStatus(uint _electionId, address _voter)
        external view
        returns (bool isRegistered, bool hasVoted, uint votedCandidateId, uint votedAt)
    {
        Voter storage v = voters[_electionId][_voter];
        return (v.isRegistered, v.hasVoted, v.votedCandidateId, v.votedAt);
    }

    /// @notice Get winner(s) of a specific election
    function getWinner(uint _electionId)
        external view electionExists(_electionId)
        returns (uint[] memory winnerIds, string[] memory winnerNames, uint highestVotes)
    {
        require(!elections[_electionId].votingOpen, "SRCVoting: election still ongoing");
        uint count = elections[_electionId].candidateCount;
        require(count > 0, "SRCVoting: no candidates");

        for (uint i = 1; i <= count; i++) {
            if (candidates[_electionId][i].voteCount > highestVotes)
                highestVotes = candidates[_electionId][i].voteCount;
        }

        uint w = 0;
        for (uint i = 1; i <= count; i++)
            if (candidates[_electionId][i].voteCount == highestVotes) w++;

        winnerIds   = new uint[](w);
        winnerNames = new string[](w);
        uint idx = 0;
        for (uint i = 1; i <= count; i++) {
            if (candidates[_electionId][i].voteCount == highestVotes) {
                winnerIds[idx]   = candidates[_electionId][i].id;
                winnerNames[idx] = candidates[_electionId][i].name;
                idx++;
            }
        }
    }
}

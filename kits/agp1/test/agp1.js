const getBlockNumber = require('@aragon/test-helpers/blockNumber')(web3)
const getBlock = require('@aragon/test-helpers/block')(web3)
const getBalance = require('@aragon/test-helpers/balance')(web3)
const timeTravel = require('@aragon/test-helpers/timeTravel')(web3)
const { assertRevert } = require('@aragon/test-helpers/assertThrow')
const namehash = require('eth-ens-namehash').hash
const keccak256 = require('js-sha3').keccak_256

const { encodeCallScript, EMPTY_SCRIPT } = require('@aragon/test-helpers/evmScript')
const deployAgp1 = require('../scripts/deploy_agp1.js')

const Finance = artifacts.require('Finance')
const Vault = artifacts.require('Vault')
const Voting = artifacts.require('Voting')

const getContract = name => artifacts.require(name)

const pct16 = x => new web3.BigNumber(x).times(new web3.BigNumber(10).toPower(16))
const getEventResult = (receipt, event, param) => receipt.logs.filter(l => l.event == event)[0].args[param]
const createdVoteId = receipt => getEventResult(receipt, 'StartVote', 'voteId')
const networks = require("@aragon/os/truffle-config").networks
const getNetwork = require('../../../helpers/networks.js')

contract('AGP-1 Kit', accounts => {
    const ETH = '0x0'
    const NO_ADDRESS = '0x0000000000000000000000000000000000000000'
    const NEEDED_SUPPORT = pct16(50)
    //const NEEDED_SUPPORT_META_TRACK = new web3.BigNumber(666666666666666667)
    const MINIMUM_ACCEPTANCE_QUORUM = 0
    const VOTING_TIME = 48 * 3600 // 48h
    let daoAddress, tokenAddress, finance, vault, voting, metaTrackVoting

    const owner = accounts[0]
    const holder16 = accounts[1]
    const holder33 = accounts[2]
    const holder51 = accounts[3]
    const nonHolder = accounts[4]

    before(async () => {
        const networkName = (await getNetwork(networks)).name
        if (networkName == 'devnet' || networkName == 'rpc') {
            // transfer some ETH to other accounts
            await web3.eth.sendTransaction({ from: owner, to: holder16, value: web3.toWei(1, 'ether') })
            await web3.eth.sendTransaction({ from: owner, to: holder33, value: web3.toWei(1, 'ether') })
            await web3.eth.sendTransaction({ from: owner, to: holder51, value: web3.toWei(1, 'ether') })
            await web3.eth.sendTransaction({ from: owner, to: nonHolder, value: web3.toWei(1, 'ether') })
        }

        // create AGP-1 Kit
        const {
            agp1Address,
            minimeTokenAddress,
            financeAddress,
            vaultAddress,
            votingAddress,
            metaTrackVotingAddress
        } = await deployAgp1(null, {artifacts, web3, owner})

        daoAddress = agp1Address
        tokenAddress = minimeTokenAddress

        finance = await Finance.at(financeAddress)
        vault = await Vault.at(vaultAddress)
        voting = Voting.at(votingAddress)
        metaTrackVoting = Voting.at(metaTrackVotingAddress)

        // mint tokens
        const token = artifacts.require('MiniMeToken').at(minimeTokenAddress)
        await token.generateTokens(holder16, new web3.BigNumber(16e18))
        await token.generateTokens(holder33, new web3.BigNumber(33e18))
        await token.generateTokens(holder51, new web3.BigNumber(51e18))
    })

    context('Creating a DAO and votes', () => {

        it('creates and initializes a DAO', async() => {
            assert.notEqual(daoAddress, '0x0', 'Instance not generated')
            assert.equal((await voting.supportRequiredPct()).toString(), NEEDED_SUPPORT.toString())
            assert.equal((await voting.minAcceptQuorumPct()).toString(), MINIMUM_ACCEPTANCE_QUORUM.toString())
            assert.equal((await voting.voteTime()).toString(), VOTING_TIME.toString())
            //assert.equal((await metaTrackVoting.supportRequiredPct()).toString(), NEEDED_SUPPORT_META_TRACK.toString())
            assert.equal((await metaTrackVoting.minAcceptQuorumPct()).toString(), MINIMUM_ACCEPTANCE_QUORUM.toString())
            assert.equal((await metaTrackVoting.voteTime()).toString(), VOTING_TIME.toString())
        })

        it('has correct permissions', async () =>{
            const dao = await getContract('Kernel').at(daoAddress)
            const acl = await getContract('ACL').at(await dao.acl())

            const checkRole = async (appAddress, permission, managerAddress, appName='', roleName='', granteeAddress=managerAddress) => {
                assert.equal(await acl.getPermissionManager(appAddress, permission), managerAddress, `${appName} ${roleName} Manager should match`)
                assert.isTrue(await acl.hasPermission(granteeAddress, appAddress, permission), `Grantee should have ${appName} role ${roleName}`)
            }

            // app manager role
            await checkRole(daoAddress, await dao.APP_MANAGER_ROLE(), metaTrackVoting.address, 'Kernel', 'APP_MANAGER')

            // create permissions role
            await checkRole(acl.address, await acl.CREATE_PERMISSIONS_ROLE(), metaTrackVoting.address, 'ACL', 'CREATE_PERMISSION')

            // evm script registry
            const regConstants = await getContract('EVMScriptRegistryConstants').new()
            const reg = await getContract('EVMScriptRegistry').at(await acl.getEVMScriptRegistry())
            assert.equal(await acl.getPermissionManager(reg.address, await reg.REGISTRY_ADD_EXECUTOR_ROLE()), NO_ADDRESS, 'EVMScriptRegistry ADD_EXECUTOR Manager should match')
            assert.equal(await acl.getPermissionManager(reg.address, await reg.REGISTRY_MANAGER_ROLE()), NO_ADDRESS, 'EVMScriptRegistry REGISTRY_MANAGER Manager should match')

            // voting
            await checkRole(voting.address, await voting.CREATE_VOTES_ROLE(), owner, 'Voting', 'CREATE_VOTES', owner)
            await checkRole(voting.address, await voting.MODIFY_QUORUM_ROLE(), metaTrackVoting.address, 'Voting', 'MODIFY_QUORUM')
            await checkRole(voting.address, await voting.MODIFY_SUPPORT_ROLE(), metaTrackVoting.address, 'Voting', 'MODIFY_SUPPORT')

            // voting meta track
            await checkRole(metaTrackVoting.address, await metaTrackVoting.CREATE_VOTES_ROLE(), owner, 'MetaTrackVoting', 'CREATE_VOTES', owner)
            await checkRole(metaTrackVoting.address, await metaTrackVoting.MODIFY_QUORUM_ROLE(), metaTrackVoting.address, 'MetaTrackVoting', 'MODIFY_QUORUM')
            await checkRole(metaTrackVoting.address, await metaTrackVoting.MODIFY_SUPPORT_ROLE(), metaTrackVoting.address, 'MetaTrackVoting', 'MODIFY_SUPPORT')

            // vault
            await checkRole(vault.address, await vault.TRANSFER_ROLE(), metaTrackVoting.address, 'Vault', 'TRANSFER', finance.address)

            // finance
            await checkRole(finance.address, await finance.CREATE_PAYMENTS_ROLE(), metaTrackVoting.address, 'Finance', 'CREATE_PAYMENTS', voting.address)
            await checkRole(finance.address, await finance.EXECUTE_PAYMENTS_ROLE(), metaTrackVoting.address, 'Finance', 'EXECUTE_PAYMENTS', voting.address)
            await checkRole(finance.address, await finance.MANAGE_PAYMENTS_ROLE(), metaTrackVoting.address, 'Finance', 'MANAGE_PAYMENTS', voting.address)
        })

        context('creating vote', () => {
            let voteId = {}
            let executionTarget = {}, script

            beforeEach(async () => {
                executionTarget = await getContract('ExecutionTarget').new()
                const action = { to: executionTarget.address, calldata: executionTarget.contract.execute.getData() }
                script = encodeCallScript([action, action])
                voteId = createdVoteId(await voting.newVote(script, 'metadata', { from: owner }))
            })

            it('has correct state', async() => {
                const [isOpen, isExecuted, startDate, snapshotBlock, requiredSupport, minQuorum, y, n, totalVoters, execScript] = await voting.getVote(voteId)

                assert.isTrue(isOpen, 'vote should be open')
                assert.isFalse(isExecuted, 'vote should be executed')
                assert.equal(snapshotBlock.toString(), await getBlockNumber() - 1, 'snapshot block should be correct')
                assert.equal(requiredSupport.toString(), NEEDED_SUPPORT.toString(), 'min quorum should be app min quorum')
                assert.equal(minQuorum.toString(), MINIMUM_ACCEPTANCE_QUORUM.toString(), 'min quorum should be app min quorum')
                assert.equal(y, 0, 'initial yea should be 0')
                assert.equal(n, 0, 'initial nay should be 0')
                assert.equal(totalVoters.toString(), new web3.BigNumber(100e18).toString(), 'total voters should be 100')
                assert.equal(execScript, script, 'script should be correct')
            })

            it('holder can vote', async () => {
                await voting.vote(voteId, false, true, { from: holder33 })
                const state = await voting.getVote(voteId)

                assert.equal(state[7].toString(), new web3.BigNumber(33e18).toString(), 'nay vote should have been counted')
            })

            it('holder can modify vote', async () => {
                await voting.vote(voteId, true, true, { from: holder33 })
                await voting.vote(voteId, false, true, { from: holder33 })
                await voting.vote(voteId, true, true, { from: holder33 })
                const state = await voting.getVote(voteId)

                assert.equal(state[6].toString(), new web3.BigNumber(33e18).toString(), 'yea vote should have been counted')
                assert.equal(state[7], 0, 'nay vote should have been removed')
            })

            it('throws when non-holder votes', async () => {
                return assertRevert(async () => {
                    await voting.vote(voteId, true, true, { from: nonHolder })
                })
            })

            it('throws when voting after voting closes', async () => {
                await timeTravel(VOTING_TIME + 1)
                //await sleep(VOTING_TIME+1)
                return assertRevert(async () => {
                    await voting.vote(voteId, true, true, { from: holder33 })
                })
            })

            it('can execute if vote is approved with support and quorum', async () => {
                await voting.vote(voteId, true, true, { from: holder33 })
                await voting.vote(voteId, false, true, { from: holder16 })
                await timeTravel(VOTING_TIME + 1)
                //console.log("Time: + " + (await getBlock(await getBlockNumber())).timestamp)
                //await sleep(VOTING_TIME+1)
                //console.log("Time: + " + (await getBlock(await getBlockNumber())).timestamp)
                await voting.executeVote(voteId, {from: owner})
                assert.equal((await executionTarget.counter()).toString(), 2, 'should have executed result')
            })

            it('cannot execute vote if not enough quorum met', async () => {
                await timeTravel(VOTING_TIME + 1)
                //await sleep(VOTING_TIME+1)
                return assertRevert(async () => {
                    await voting.executeVote(voteId, {from: owner})
                })
            })

            it('cannot execute vote if not support met', async () => {
                await voting.vote(voteId, false, true, { from: holder33 })
                await voting.vote(voteId, false, true, { from: holder16 })
                await timeTravel(VOTING_TIME + 1)
                //await sleep(VOTING_TIME+1)
                return assertRevert(async () => {
                    await voting.executeVote(voteId, {from: owner})
                })
            })
        })
    })

    context('finance access', () => {
        let voteId = {}, script
        const payment = new web3.BigNumber(2e16)
        beforeEach(async () => {
            // Fund Finance
            await finance.sendTransaction({ value: payment, from: owner })
            const action = { to: finance.address, calldata: finance.contract.newPayment.getData(ETH, nonHolder, payment, 0, 0, 1, "voting payment") }
            script = encodeCallScript([action])
            voteId = createdVoteId(await voting.newVote(script, 'metadata', { from: owner }))
        })

        it('finance can not be accessed directly (without a vote)', async () => {
            return assertRevert(async () => {
                await finance.newPayment(ETH, nonHolder, 2e16, 0, 0, 1, "voting payment")
            })
        })

        it('transfers funds if vote is approved', async () => {
            const receiverInitialBalance = await getBalance(nonHolder)
            //await logBalances(finance.address, vault.address)
            await voting.vote(voteId, true, true, { from: holder33 })
            await voting.vote(voteId, false, true, { from: holder16 })
            await timeTravel(VOTING_TIME + 1)
            //await sleep(VOTING_TIME+1)
            await voting.executeVote(voteId, {from: owner})
            //await logBalances(finance.address, vault.address)
            assert.equal((await getBalance(nonHolder)).toString(), receiverInitialBalance.plus(payment).toString(), 'Receiver didn\'t get the payment')
        })
    })

    const logBalances = async(financeProxyAddress, vaultProxyAddress) => {
        console.log('Owner ETH: ' + await getBalance(owner))
        console.log('Finance ETH: ' + await getBalance(financeProxyAddress))
        console.log('Vault ETH: ' + await getBalance(vaultProxyAddress))
        console.log('Receiver ETH: ' + await getBalance(nonHolder))
        console.log('-----------------')
    }

    /*
    const sleep = function(s) {
        return new Promise(resolve => setTimeout(resolve, s*1000));
    }
     */
})

const { assert, expect } = require("chai");
const { getNamedAccounts, deployments, ethers, network } = require("hardhat");
const {
  developmentChains,
  networkConfig,
} = require("../../helper-hardhat-config");

!developmentChains.includes(network.name)
  ? describe.skip
  : describe("Raffle", async () => {
      let raffle,
        raffleContract,
        vrfCoordinatorV2Mock,
        raffleEntranceFee,
        deployer,
        interval;
      const chainId = network.config.chainId;

      beforeEach(async () => {
        accounts = await ethers.getSigners();
        deployer = (await getNamedAccounts()).deployer;
        await deployments.fixture(["all"]);
        raffle = await ethers.getContract("Raffle", deployer);
        raffleContract = await ethers.getContract("Raffle");
        vrfCoordinatorV2Mock = await ethers.getContract(
          "VRFCoordinatorV2Mock",
          deployer
        );

        raffleEntranceFee = await raffle.getEntranceFee();
        interval = await raffle.getInterval();
      });

      describe("constructor", () => {
        it("inits the raffle correctly", async () => {
          const raffleState = await raffle.getRaffleState();
          const interval = await raffle.getInterval();
          assert.equal(raffleState.toString(), "0");
          assert.equal(
            interval.toString(),
            networkConfig[chainId]["keepersUpdateInterval"]
          );
        });
      });

      describe("enterRaffle", () => {
        it("reverts when you don't pay enough", async () => {
          await expect(raffle.enterRaffle()).to.be.revertedWith(
            "Raffle__NotEnoughETHEntered"
          );
        });

        it("records players when they enter", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          const playerFromContract = await raffle.getPlayer(0);
          assert.equal(playerFromContract, deployer);
        });

        it("emits event on enter", async () => {
          await expect(
            raffle.enterRaffle({ value: raffleEntranceFee })
          ).to.emit(raffle, "RaffleEnter");
        });

        it("doesnt allow entrance when raffle is calculating", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []);
          await raffle.performUpkeep([]);
          await expect(
            raffle.enterRaffle({ value: raffleEntranceFee })
          ).to.be.revertedWith("Raffle__NotOpen");
        });
      });

      describe("checkUpkeep", () => {
        it("returns false if people haven't sent any Eth", async () => {
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []);
          const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([]);
          assert(!upkeepNeeded);
        });

        it("returns false if raffle isn't open", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []);
          await raffle.performUpkeep([]);
          const raffleState = await raffle.getRaffleState();
          const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([]);
          assert.equal(raffleState.toString(), "1");
          assert.equal(upkeepNeeded, false);
        });

        it("returns false if enough time hasn't passed", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() - 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x");
          assert(!upkeepNeeded);
        });

        it("returns true if enough time has passed, has players, eth, and is open", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.request({ method: "evm_mine", params: [] });
          const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x");
          assert(upkeepNeeded);
        });
      });

      describe("performUpkeep", () => {
        it("it can only run if checkUpkeep is true", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []);
          const tx = await raffle.performUpkeep([]);
          assert(tx);
        });

        it("reverts when checkupkeep is false", async () => {
          await expect(raffle.performUpkeep([])).to.be.revertedWith(
            "Raffle__UpkeepNotNeeded"
          );
        });

        it("updates the raffle state, emits an event, and calls the vrf coordinator", async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []);
          const txResponse = await raffle.performUpkeep([]);
          const txReceipt = await txResponse.wait(1);
          const requestId = txReceipt.events[1].args.requestId;
          const raffleState = await raffle.getRaffleState();
          assert(requestId.toNumber() > 0);
          assert(raffleState.toString() == "1");
        });
      });

      describe("fullfillRandomWords", () => {
        beforeEach(async () => {
          await raffle.enterRaffle({ value: raffleEntranceFee });
          await network.provider.send("evm_increaseTime", [
            interval.toNumber() + 1,
          ]);
          await network.provider.send("evm_mine", []);
        });

        it("can only be called after performUpkeep", async () => {
          await expect(
            vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)
          ).to.be.revertedWith("nonexistent request");
          await expect(
            vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)
          ).to.be.revertedWith("nonexistent request");
        });

        it("picks a winner, resets, and sends money", async () => {
          const additionalEntrances = 3;
          const startingIndex = 2;
          for (
            let i = startingIndex;
            i < startingIndex + additionalEntrances;
            i++
          ) {
            raffle = raffleContract.connect(accounts[i]);
            await raffle.enterRaffle({ value: raffleEntranceFee });
          }
          const startingTimeStamp = await raffle.getLatestTimeStamp();

          // This will be more important for our staging tests...
          await new Promise(async (resolve, reject) => {
            raffle.once("WinnerPicked", async () => {
              console.log("WinnerPicked event fired!");
              // assert throws an error if it fails, so we need to wrap
              // it in a try/catch so that the promise returns event
              // if it fails.
              try {
                // Now lets get the ending values...
                const recentWinner = await raffle.getRecentWinner();
                const raffleState = await raffle.getRaffleState();
                const winnerBalance = await accounts[2].getBalance();
                const endingTimeStamp = await raffle.getLatestTimeStamp();
                await expect(raffle.getPlayer(0)).to.be.reverted;
                assert.equal(recentWinner.toString(), accounts[2].address);
                assert.equal(raffleState, 0);
                assert.equal(
                  winnerBalance.toString(),
                  startingBalance
                    .add(
                      raffleEntranceFee
                        .mul(additionalEntrances)
                        .add(raffleEntranceFee)
                    )
                    .toString()
                );
                assert(endingTimeStamp > startingTimeStamp);
                resolve();
              } catch (e) {
                reject(e);
              }
            });

            const tx = await raffle.performUpkeep("0x");
            const txReceipt = await tx.wait(1);
            const startingBalance = await accounts[2].getBalance();
            await vrfCoordinatorV2Mock.fulfillRandomWords(
              txReceipt.events[1].args.requestId,
              raffle.address
            );
          });
        });
      });
    });

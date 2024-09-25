const { expect, use } = require("chai");
const { solidity } = require("ethereum-waffle");
const {
  expandDecimals,
  getBlockTime,
  increaseTime,
  mineBlock,
  reportGasUsed,
  newWallet,
} = require("./shared/utilities");
const { toChainlinkPrice } = require("./shared/chainlink");
const { toUsd, toNormalizedPrice } = require("./shared/units");
const {
  initVault,
  getBnbConfig,
  getBtcConfig,
  getDaiConfig,
  getEthConfig,
} = require("./helpers");
const {
  getFrameSigner,
  deployContract,
  contractAt,
  sendTxn,
  writeTmpAddresses,
} = require("./shared/helpers");
const { errors } = require("../test/core/Vault/helpers");
const { network } = require("hardhat");

const partnerContracts = [
  "0xD5EF9737EE199236ce963F1217C6a763D5f2C2d6", // nj
  "0x18f24A8E9f92BdaFfE295cBa748959c9dD73E96D", // rs
  "0x2d8797927D03C05ceB8a7D2bF3030c6c436E1df3", // rs
  "0x1b138b570Ef5ba2ca09eeB5FC365f5f51a0E031a", // ke
  "0xf408FE17097b05ca8ebB02c905DDECc94ABADb0A", // ke
  "0x0615c535626563420B0b38bEe09F0b96a26349Ae", // ll
  "0xe1Dfbc492AC7bB1596dbcC44fbC5fc08d784cBE6", // ll
];
const minter = [
  "0xD5EF9737EE199236ce963F1217C6a763D5f2C2d6", // nj
];

let signers = [
  "0xD5EF9737EE199236ce963F1217C6a763D5f2C2d6", // nj
  "0x18f24A8E9f92BdaFfE295cBa748959c9dD73E96D", // rs
  "0x2d8797927D03C05ceB8a7D2bF3030c6c436E1df3", // rs
  "0x1b138b570Ef5ba2ca09eeB5FC365f5f51a0E031a", // ke
  "0xf408FE17097b05ca8ebB02c905DDECc94ABADb0A", // ke
  "0x0615c535626563420B0b38bEe09F0b96a26349Ae", // ll
  "0xe1Dfbc492AC7bB1596dbcC44fbC5fc08d784cBE6", // ll
];

const updaters = [
  "0xD5EF9737EE199236ce963F1217C6a763D5f2C2d6", // nj
  "0x18f24A8E9f92BdaFfE295cBa748959c9dD73E96D", // rs
  "0x2d8797927D03C05ceB8a7D2bF3030c6c436E1df3", // rs
  "0x1b138b570Ef5ba2ca09eeB5FC365f5f51a0E031a", // ke
  "0xf408FE17097b05ca8ebB02c905DDECc94ABADb0A", // ke
  "0x0615c535626563420B0b38bEe09F0b96a26349Ae", // ll
  "0xe1Dfbc492AC7bB1596dbcC44fbC5fc08d784cBE6", // ll
];

const maxTokenSupply = expandDecimals("100000000", 18);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployTokenManager() {
  const tokenManager = await deployContract(
    "TokenManager",
    [1],
    "TokenManager"
  );

  if (network.name == "localhost") {
    const signer = await getFrameSigner();
    signers = [signer.address];
  }

  await sendTxn(tokenManager.initialize(signers), "tokenManager.initialize");
  return tokenManager;
}

async function deployOrderBook(tokens, router, vault, usdg) {
  const { wbnb } = tokens;

  const orderBook = await deployContract("OrderBook", []);

  // Arbitrum mainnet addresses
  await sendTxn(
    orderBook.initialize(
      router.address, // router
      vault.address, // vault
      wbnb.address, // weth
      usdg.address, // usdg
      "2000000000000000", // 0.002 BNB
      expandDecimals(10, 30) // min purchase token amount usd
    ),
    "orderBook.initialize"
  );

  writeTmpAddresses({
    orderBook: orderBook.address,
  });
  return orderBook;
}

async function deployOrderExecutor(vault, orderBook) {
  return await deployContract("OrderExecutor", [
    vault.address,
    orderBook.address,
  ]);
}

async function deployPositionManager(vault, router, wbnb, orderBook) {
  const depositFee = 50;
  const positionManager = await deployContract("PositionManager", [
    vault.address,
    router.address,
    wbnb.address,
    depositFee,
    orderBook.address,
  ]);
  const signer = await getFrameSigner();
  await sendTxn(
    positionManager.setOrderKeeper(signer.address, true),
    "positionManager.setOrderKeeper(signer)"
  );
  await sendTxn(
    positionManager.setLiquidator(signer.address, true),
    "positionManager.setLiquidator(liquidator)"
  );
  await sendTxn(
    router.addPlugin(positionManager.address),
    "router.addPlugin(positionManager)"
  );

  for (let i = 0; i < partnerContracts.length; i++) {
    const partnerContract = partnerContracts[i];
    await sendTxn(
      positionManager.setPartner(partnerContract, true),
      "positionManager.setPartner(partnerContract)"
    );
  }
  return positionManager;
}

async function deployPositionRouter(vault, router, wbnb) {
  const depositFee = 30; // 0.3%
  const minExecutionFee = 1600000000000000; // 0.0016 BNB
  const positionRouter = await deployContract("PositionRouter", [
    vault.address,
    router.address,
    wbnb.address,
    depositFee,
    minExecutionFee,
  ]);
  const referralStorage = await deployContract("ReferralStorage", []);

  await sendTxn(
    positionRouter.setReferralStorage(referralStorage.address),
    "positionRouter.setReferralStorage"
  );
  await sendTxn(
    referralStorage.setHandler(positionRouter.address, true),
    "referralStorage.setHandler(positionRouter)"
  );

  await sendTxn(router.addPlugin(positionRouter.address), "router.addPlugin");

  await sendTxn(
    positionRouter.setDelayValues(1, 180, 30 * 60),
    "positionRouter.setDelayValues"
  );
  // await sendTxn(
  //   timelock.setContractHandler(positionRouter.address, true),
  //   "timelock.setContractHandler(positionRouter)"
  // );
  return [referralStorage, positionRouter];
}

async function setVaultTokenConfig(
  vault,
  vaultPriceFeed,
  tokens,
  ethPriceFeed,
  btcPriceFeed,
  bnbPriceFeed,
  busdPriceFeed,
  usdtPriceFeed
) {
  // const provider = ethers.provider;
  await vaultPriceFeed.setTokenConfig(
    tokens.usdt.address, // _token
    usdtPriceFeed.address, // _priceFeed
    8, // _priceDecimals
    true // _isStrictStable
  );
  await vaultPriceFeed.setTokenConfig(
    tokens.busd.address, // _token
    busdPriceFeed.address, // _priceFeed
    8, // _priceDecimals
    true // _isStrictStable
  );
  await vaultPriceFeed.setTokenConfig(
    tokens.eth.address, // _token
    ethPriceFeed.address, // _priceFeed
    8, // _priceDecimals
    false // _isStrictStable
  );
  await vaultPriceFeed.setTokenConfig(
    tokens.btc.address, // _token
    btcPriceFeed.address, // _priceFeed
    8, // _priceDecimals
    false // _isStrictStable
  );
  await vaultPriceFeed.setTokenConfig(
    tokens.bnb.address, // _token
    bnbPriceFeed.address, // _priceFeed
    8, // _priceDecimals
    false // _isStrictStable
  );
  await vault.setIsSwapEnabled(true);
  console.log("start to update price");
  await ethPriceFeed.setLatestAnswer(toChainlinkPrice(1500));
  await btcPriceFeed.setLatestAnswer(toChainlinkPrice(20000));
  await bnbPriceFeed.setLatestAnswer(toChainlinkPrice(300));
  await busdPriceFeed.setLatestAnswer(toChainlinkPrice(1));
  await usdtPriceFeed.setLatestAnswer(toChainlinkPrice(1));
  console.log("start to setTokenConfig");
  await sleep(5000);
  let tokenArr = [tokens.usdt, tokens.busd, tokens.eth, tokens.bnb, tokens.btc];
  for (i = 0; i < tokenArr.length; i++) {
    await sleep(5000);
    await sendTxn(
      vault.setTokenConfig(
        tokenArr[i].address,
        tokenArr[i].decimals,
        tokenArr[i].tokenWeight,
        tokenArr[i].minProfitBps,
        expandDecimals(tokenArr[i].maxUsdgAmount, 18),
        tokenArr[i].isStable,
        tokenArr[i].isShortable
      ),
      "vault.setTokenConfig"
    );
  }
  // await vault.setTokenConfig(...getEthConfig(eth, ethPriceFeed));
  // await vault.setTokenConfig(...getBtcConfig(btc, btcPriceFeed));
  // await vault.setTokenConfig(...getBnbConfig(bnb, bnbPriceFeed));
  // await vault.setTokenConfig(...getDaiConfig(busd, busdPriceFeed));
}

// TODO: fix price feed
async function deployPriceFeed(
  vault,
  tokens,
  timelock,
  tokenManager,
  positionRouter,
  vaultPriceFeed,
  positionManager
) {
  const { btc, eth, bnb, busd, usdt } = tokens;
  const tokenArr = [btc, eth, bnb, busd, usdt];
  const fastPriceTokens = [btc, eth, bnb, busd, usdt];
  if (fastPriceTokens.find((t) => !t.fastPricePrecision)) {
    throw new Error("Invalid price precision");
  }

  if (fastPriceTokens.find((t) => !t.maxCumulativeDeltaDiff)) {
    throw new Error("Invalid price maxCumulativeDeltaDiff");
  }

  const signer = await getFrameSigner();

  const fastPriceEvents = await deployContract("FastPriceEvents", []);

  const secondaryPriceFeed = await deployContract("FastPriceFeed", [
    5 * 60, // _priceDuration
    // 60 * 60, // _maxPriceUpdateDelay
    0, // _minBlockInterval
    750, // _maxDeviationBasisPoints
    fastPriceEvents.address, // _fastPriceEvents
    tokenManager.address, // _tokenManager
    positionRouter.address,
  ]);

  await sendTxn(
    secondaryPriceFeed.initialize(1, signers, updaters),
    "secondaryPriceFeed.initialize"
  );
  await sendTxn(
    secondaryPriceFeed.setMaxTimeDeviation(60 * 60),
    "secondaryPriceFeed.setMaxTimeDeviation"
  );

  await sendTxn(
    positionRouter.setPositionKeeper(secondaryPriceFeed.address, true),
    "positionRouter.setPositionKeeper(secondaryPriceFeed)"
  );

  await sendTxn(
    fastPriceEvents.setIsPriceFeed(secondaryPriceFeed.address, true),
    "fastPriceEvents.setIsPriceFeed"
  );

  await sendTxn(
    vaultPriceFeed.setMaxStrictPriceDeviation(expandDecimals(1, 28)),
    "vaultPriceFeed.setMaxStrictPriceDeviation"
  ); // 0.05 USD
  await sendTxn(
    vaultPriceFeed.setPriceSampleSpace(1),
    "vaultPriceFeed.setPriceSampleSpace"
  );
  await sendTxn(
    vaultPriceFeed.setSecondaryPriceFeed(secondaryPriceFeed.address),
    "vaultPriceFeed.setSecondaryPriceFeed"
  );
  await sendTxn(
    vaultPriceFeed.setIsAmmEnabled(false),
    "vaultPriceFeed.setIsAmmEnabled"
  );
  // await sendTxn(
  //   priceFeedTimelock.setChainlinkFlags(chainlinkFlags.address),
  //   "vaultPriceFeed.setChainlinkFlags"
  // );
  for (const token of tokenArr) {
    await sendTxn(
      vaultPriceFeed.setTokenConfig(
        token.address, // _token
        token.priceFeed, // _priceFeed
        token.priceDecimals, // _priceDecimals
        token.isStrictStable // _isStrictStable
      ),
      `vaultPriceFeed.setTokenConfig(${token.name}) ${token.address} ${token.priceFeed}`
    );
  }

  await sendTxn(
    secondaryPriceFeed.setTokens(
      fastPriceTokens.map((t) => t.address),
      fastPriceTokens.map((t) => t.fastPricePrecision)
    ),
    "secondaryPriceFeed.setTokens"
  );
  await sendTxn(
    secondaryPriceFeed.setMaxTimeDeviation(60 * 60),
    "secondaryPriceFeed.setMaxTimeDeviation"
  );
  await sendTxn(
    vault.setPriceFeed(vaultPriceFeed.address),
    "vault.setPriceFeed"
  );
  await sendTxn(
    vault.setIsLeverageEnabled(true),
    "vault.setIsLeverageEnabled(true)"
  );
  await sendTxn(secondaryPriceFeed.setUpdater(signer.address, true));

  await sendTxn(
    vault.setLiquidator(positionManager.address, true),
    "vault.setLiquidator(positionManager.address, true)"
  );
  return [fastPriceEvents, secondaryPriceFeed];
}

async function deployVault(tokens) {
  const { bnb, btc, eth, busd, usdt, wbnb } = tokens;
  const tokenArr = [btc, eth, bnb, busd, usdt];
  const vault = await deployContract("Vault", []);
  await vault.deployed();
  const usdg = await deployContract("USDG", [vault.address]);
  await usdg.deployed();
  const router = await deployContract("Router", [
    vault.address,
    usdg.address,
    wbnb.address,
  ]);
  await router.deployed();
  // const router = await contractAt("Router", "0xaBBc5F99639c9B6bCb58544ddf04EFA6802F4064")
  // const vaultPriceFeed = await contractAt("VaultPriceFeed", "0x30333ce00ac3025276927672aaefd80f22e89e54")
  // const secondaryPriceFeed = await deployContract("FastPriceFeed", [5 * 60])

  const vaultPriceFeed = await deployContract("VaultPriceFeed", []);
  await vaultPriceFeed.deployed();

  await sendTxn(
    vaultPriceFeed.setMaxStrictPriceDeviation(expandDecimals(1, 28)),
    "vaultPriceFeed.setMaxStrictPriceDeviation"
  ); // 0.05 USD
  await sendTxn(
    vaultPriceFeed.setPriceSampleSpace(1),
    "vaultPriceFeed.setPriceSampleSpace"
  );
  await sendTxn(
    vaultPriceFeed.setIsAmmEnabled(false),
    "vaultPriceFeed.setIsAmmEnabled"
  );
  await sendTxn(
    vaultPriceFeed.setIsSecondaryPriceEnabled(true),
    "vaultPriceFeed.setIsSecondaryPriceEnabled"
  );
  await sendTxn(
    vaultPriceFeed.setUseV2Pricing(true),
    "vaultPriceFeed.setUseV2Pricing(true)"
  );
  for (let i = 0; i < tokenArr.length; i++) {
    await vaultPriceFeed.setSpreadBasisPoints(tokenArr[i].address, 0);
  }
  const glp = await deployContract("GLP", []);
  await sendTxn(
    glp.setInPrivateTransferMode(true),
    "glp.setInPrivateTransferMode"
  );
  // const glp = await contractAt("GLP", "0x4277f8F2c384827B5273592FF7CeBd9f2C1ac258")
  const shortsTracker = await deployShortsTracker(vault);

  const glpManager = await deployContract("GlpManager", [
    vault.address,
    usdg.address,
    glp.address,
    shortsTracker.address,
    15 * 60,
  ]);
  await sendTxn(
    glpManager.setInPrivateMode(true),
    "glpManager.setInPrivateMode"
  );

  await sendTxn(
    glpManager.setShortsTrackerAveragePriceWeight(10000),
    "glpManager.setShortsTrackerAveragePriceWeight(10000)"
  );

  await sendTxn(glp.setMinter(glpManager.address, true), "glp.setMinter");
  await sendTxn(usdg.addVault(glpManager.address), "usdg.addVault(glpManager)");

  await sendTxn(
    vault.initialize(
      router.address, // router
      usdg.address, // usdg
      vaultPriceFeed.address, // priceFeed
      toUsd(2), // liquidationFeeUsd
      100000, // fundingRateFactor
      100000 // stableFundingRateFactor
    ),
    "vault.initialize"
  );

  await sendTxn(vault.setFundingRate(36, 1000, 1000), "vault.setFundingRate");

  await sendTxn(vault.setInManagerMode(true), "vault.setInManagerMode");
  await sendTxn(vault.setManager(glpManager.address, true), "vault.setManager");

  await sendTxn(
    vault.setFees(
      10, // _taxBasisPoints
      5, // _stableTaxBasisPoints
      20, // _mintBurnFeeBasisPoints
      20, // _swapFeeBasisPoints
      1, // _stableSwapFeeBasisPoints
      10, // _marginFeeBasisPoints
      toUsd(2), // _liquidationFeeUsd
      24 * 60 * 60, // _minProfitTime
      true // _hasDynamicFees
    ),
    "vault.setFees"
  );

  const vaultErrorController = await deployContract("VaultErrorController", []);
  await sendTxn(
    vault.setErrorController(vaultErrorController.address),
    "vault.setErrorController"
  );
  await sendTxn(
    vaultErrorController.setErrors(vault.address, errors),
    "vaultErrorController.setErrors"
  );

  const vaultUtils = await deployContract("VaultUtils", [vault.address]);
  await sendTxn(vault.setVaultUtils(vaultUtils.address), "vault.setVaultUtils");

  return [
    vault,
    usdg,
    router,
    vaultPriceFeed,
    glp,
    glpManager,
    vaultUtils,
    shortsTracker,
  ];
}

async function deployShortsTracker(vault) {
  const shortsTracker = await deployContract(
    "ShortsTracker",
    [vault.address],
    "ShortsTracker"
  );

  return shortsTracker;
}

async function deployGmx() {
  const gmx = await deployContract("GMX", []);
  for (let i = 0; i < minter.length; i++) {
    await sendTxn(
      gmx.setMinter(minter[i], true),
      `gmx.setMinter: ${minter[i]}`
    );
  }
  const esGmx = await deployContract("EsGMX", []);
  const bnGmx = await deployContract("MintableBaseToken", [
    "Bonus GMX",
    "bnGMX",
    0,
  ]);
  return [gmx, esGmx, bnGmx];
}

async function deployBalanceUpdater() {
  const balanceUpdater = await deployContract("BalanceUpdater", []);
  return balanceUpdater;
}

async function deployBatchSender() {
  const batchSender = await deployContract("BatchSender", []);
  return batchSender;
}

async function deployEsGmxBatchSender(esGmx) {
  const esGmxBatchSender = await deployContract("EsGmxBatchSender", [
    esGmx.address,
  ]);

  return esGmxBatchSender;
}

async function deployGmxTimelock(tokenManager, rewardManager) {
  const buffer = 24 * 60 * 60;
  // const buffer = 5;
  const longBuffer = 7 * 24 * 60 * 60;
  // const longBuffer = 10;
  const mintReceiver = tokenManager;
  // const mintReceiver = { address: AddressZero };
  const signer = await getFrameSigner();
  const gmxTimelock = await deployContract(
    "GmxTimelock",
    [
      signer.address,
      buffer,
      longBuffer,
      rewardManager.address,
      tokenManager.address,
      mintReceiver.address,
      maxTokenSupply,
    ],
    "GmxTimelock"
    // { gasLimit: 100000000 }
  );
  return gmxTimelock;
}

async function deployOrderBookReader() {
  const orderBookReader = await deployContract("OrderBookReader", []);

  writeTmpAddresses({
    orderBookReader: orderBookReader.address,
  });
  return orderBookReader;
}

async function deployReader() {
  const reader = await deployContract("Reader", [], "Reader");

  writeTmpAddresses({
    reader: reader.address,
  });
  return reader;
}

async function deployRewardReader() {
  const rewardReader = await deployContract("RewardReader", [], "RewardReader");
  return rewardReader;
}

async function deployTimeLock(
  tokenManager,
  glpManager,
  rewardRouter,
  positionRouter,
  positionManager,
  rewardManager
) {
  const signer = await getFrameSigner();

  // const buffer = 5;
  const buffer = 24 * 60 * 60;

  const mintReceiver = tokenManager;

  const timelock = await deployContract(
    "Timelock",
    [
      signer.address,
      buffer,
      tokenManager.address,
      mintReceiver.address,
      glpManager.address,
      rewardRouter.address,
      rewardManager.address,
      maxTokenSupply,
      10, // marginFeeBasisPoints 0.1%
      100, // maxMarginFeeBasisPoints 1%
    ],
    "Timelock"
  );
  await timelock.deployed();
  const deployedTimelock = await contractAt(
    "Timelock",
    timelock.address,
    signer
  );

  await sendTxn(
    deployedTimelock.setContractHandler(positionRouter.address, true),
    "deployedTimelock.setContractHandler(positionRouter)"
  );
  await sendTxn(
    deployedTimelock.setShouldToggleIsLeverageEnabled(true),
    "deployedTimelock.setShouldToggleIsLeverageEnabled(true)"
  );
  await sendTxn(
    deployedTimelock.setContractHandler(positionManager.address, true),
    "deployedTimelock.setContractHandler(positionManager)"
  );

  // // update gov of vault
  // const vaultGov = await contractAt("Timelock", await vault.gov(), signer);

  // await sendTxn(
  //   vaultGov.signalSetGov(vault.address, deployedTimelock.address),
  //   "vaultGov.signalSetGov"
  // );
  // await sendTxn(
  //   deployedTimelock.signalSetGov(vault.address, vaultGov.address),
  //   "deployedTimelock.signalSetGov(vault)"
  // );
  // await sendTxn(
  //   timelock.setVaultUtils(vault.address, vaultUtils.address),
  //   "timelock.setVaultUtils"
  // );

  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i];
    await sendTxn(
      deployedTimelock.setContractHandler(signer, true),
      `deployedTimelock.setContractHandler(${signer})`
    );
  }

  // const keepers = [
  //   "0x46a208f987F2002899bA37b2A32a394D34F30a88", // nj
  //   "0xc0271BDA95f78EF80728152eE9B6c5A915E91DA5", // rs
  //   "0xc0271BDA95f78EF80728152eE9B6c5A915E91DA5", // ke
  // ];

  // for (let i = 0; i < keepers.length; i++) {
  //   const keeper = keepers[i];
  //   await sendTxn(
  //     deployedTimelock.setKeeper(keeper, true),
  //     `deployedTimelock.setKeeper(${keeper})`
  //   );
  // }

  await sendTxn(
    deployedTimelock.setContractHandler(positionManager.address, true),
    "deployedTimelock.setContractHandler(positionManager)"
  );

  return timelock;
}

async function deployVaultReader() {
  const vaultReader = await deployContract("VaultReader", [], "VaultReader");

  writeTmpAddresses({
    reader: vaultReader.address,
  });

  return vaultReader;
}

async function deployStakedGlp(
  glp,
  glpManager,
  stakedGlpTracker,
  feeGlpTracker
) {
  const stakedGlp = await deployContract("StakedGlp", [
    glp.address,
    glpManager.address,
    stakedGlpTracker.address,
    feeGlpTracker.address,
  ]);

  const glpBalance = await deployContract("GlpBalance", [
    glpManager.address,
    stakedGlpTracker.address,
  ]);

  return [stakedGlp, glpBalance];
}

async function deployRewardRouter(
  tokens,
  glpManager,
  glp,
  gmx,
  esGmx,
  bnGmx,
  timelock
) {
  const { wbnb } = tokens;

  const vestingDuration = 365 * 24 * 60 * 60;
  await sendTxn(
    esGmx.setInPrivateTransferMode(true),
    "esGmx.setInPrivateTransferMode"
  );
  await sendTxn(
    glp.setInPrivateTransferMode(true),
    "glp.setInPrivateTransferMode"
  );

  const stakedGmxTracker = await deployContract("RewardTracker", [
    "Staked GMX",
    "sGMX",
  ]);
  const stakedGmxDistributor = await deployContract("RewardDistributor", [
    esGmx.address,
    stakedGmxTracker.address,
  ]);
  await sendTxn(
    stakedGmxTracker.initialize(
      [gmx.address, esGmx.address],
      stakedGmxDistributor.address
    ),
    "stakedGmxTracker.initialize"
  );
  await sendTxn(
    stakedGmxDistributor.updateLastDistributionTime(),
    "stakedGmxDistributor.updateLastDistributionTime"
  );

  const bonusGmxTracker = await deployContract("RewardTracker", [
    "Staked + Bonus GMX",
    "sbGMX",
  ]);
  const bonusGmxDistributor = await deployContract("BonusDistributor", [
    bnGmx.address,
    bonusGmxTracker.address,
  ]);
  await sendTxn(
    bonusGmxTracker.initialize(
      [stakedGmxTracker.address],
      bonusGmxDistributor.address
    ),
    "bonusGmxTracker.initialize"
  );
  await sendTxn(
    bonusGmxDistributor.updateLastDistributionTime(),
    "bonusGmxDistributor.updateLastDistributionTime"
  );

  const feeGmxTracker = await deployContract("RewardTracker", [
    "Staked + Bonus + Fee GMX",
    "sbfGMX",
  ]);
  const feeGmxDistributor = await deployContract("RewardDistributor", [
    wbnb.address,
    feeGmxTracker.address,
  ]);
  await sendTxn(
    feeGmxTracker.initialize(
      [bonusGmxTracker.address, bnGmx.address],
      feeGmxDistributor.address
    ),
    "feeGmxTracker.initialize"
  );
  await sendTxn(
    feeGmxDistributor.updateLastDistributionTime(),
    "feeGmxDistributor.updateLastDistributionTime"
  );

  const feeGlpTracker = await deployContract("RewardTracker", [
    "Fee GLP",
    "fGLP",
  ]);
  const feeGlpDistributor = await deployContract("RewardDistributor", [
    wbnb.address,
    feeGlpTracker.address,
  ]);
  await sendTxn(
    feeGlpTracker.initialize([glp.address], feeGlpDistributor.address),
    "feeGlpTracker.initialize"
  );
  await sendTxn(
    feeGlpDistributor.updateLastDistributionTime(),
    "feeGlpDistributor.updateLastDistributionTime"
  );

  const stakedGlpTracker = await deployContract("RewardTracker", [
    "Fee + Staked GLP",
    "fsGLP",
  ]);
  const stakedGlpDistributor = await deployContract("RewardDistributor", [
    esGmx.address,
    stakedGlpTracker.address,
  ]);
  await sendTxn(
    stakedGlpTracker.initialize(
      [feeGlpTracker.address],
      stakedGlpDistributor.address
    ),
    "stakedGlpTracker.initialize"
  );
  await sendTxn(
    stakedGlpDistributor.updateLastDistributionTime(),
    "stakedGlpDistributor.updateLastDistributionTime"
  );

  await sendTxn(
    stakedGmxTracker.setInPrivateTransferMode(true),
    "stakedGmxTracker.setInPrivateTransferMode"
  );
  await sendTxn(
    stakedGmxTracker.setInPrivateStakingMode(true),
    "stakedGmxTracker.setInPrivateStakingMode"
  );
  await sendTxn(
    bonusGmxTracker.setInPrivateTransferMode(true),
    "bonusGmxTracker.setInPrivateTransferMode"
  );
  await sendTxn(
    bonusGmxTracker.setInPrivateStakingMode(true),
    "bonusGmxTracker.setInPrivateStakingMode"
  );
  await sendTxn(
    bonusGmxTracker.setInPrivateClaimingMode(true),
    "bonusGmxTracker.setInPrivateClaimingMode"
  );
  await sendTxn(
    feeGmxTracker.setInPrivateTransferMode(true),
    "feeGmxTracker.setInPrivateTransferMode"
  );
  await sendTxn(
    feeGmxTracker.setInPrivateStakingMode(true),
    "feeGmxTracker.setInPrivateStakingMode"
  );

  await sendTxn(
    feeGlpTracker.setInPrivateTransferMode(true),
    "feeGlpTracker.setInPrivateTransferMode"
  );
  await sendTxn(
    feeGlpTracker.setInPrivateStakingMode(true),
    "feeGlpTracker.setInPrivateStakingMode"
  );
  await sendTxn(
    stakedGlpTracker.setInPrivateTransferMode(true),
    "stakedGlpTracker.setInPrivateTransferMode"
  );
  await sendTxn(
    stakedGlpTracker.setInPrivateStakingMode(true),
    "stakedGlpTracker.setInPrivateStakingMode"
  );

  const gmxVester = await deployContract("Vester", [
    "Vested GMX", // _name
    "vGMX", // _symbol
    vestingDuration, // _vestingDuration
    esGmx.address, // _esToken
    feeGmxTracker.address, // _pairToken
    gmx.address, // _claimableToken
    stakedGmxTracker.address, // _rewardTracker
  ]);

  const glpVester = await deployContract("Vester", [
    "Vested GLP", // _name
    "vGLP", // _symbol
    vestingDuration, // _vestingDuration
    esGmx.address, // _esToken
    stakedGlpTracker.address, // _pairToken
    gmx.address, // _claimableToken
    stakedGlpTracker.address, // _rewardTracker
  ]);

  const rewardRouter = await deployContract("RewardRouter", []);
  await sendTxn(
    rewardRouter.initialize(
      wbnb.address,
      gmx.address,
      esGmx.address,
      bnGmx.address,
      glp.address,
      stakedGmxTracker.address,
      bonusGmxTracker.address,
      feeGmxTracker.address,
      feeGlpTracker.address,
      stakedGlpTracker.address,
      glpManager.address,
      gmxVester.address,
      glpVester.address
    ),
    "rewardRouter.initialize"
  );

  await sendTxn(
    glpManager.setHandler(rewardRouter.address, true),
    "glpManager.setHandler(rewardRouter)"
  );

  // allow rewardRouter to stake in stakedGmxTracker
  await sendTxn(
    stakedGmxTracker.setHandler(rewardRouter.address, true),
    "stakedGmxTracker.setHandler(rewardRouter)"
  );
  // allow bonusGmxTracker to stake stakedGmxTracker
  await sendTxn(
    stakedGmxTracker.setHandler(bonusGmxTracker.address, true),
    "stakedGmxTracker.setHandler(bonusGmxTracker)"
  );
  // allow rewardRouter to stake in bonusGmxTracker
  await sendTxn(
    bonusGmxTracker.setHandler(rewardRouter.address, true),
    "bonusGmxTracker.setHandler(rewardRouter)"
  );
  // allow bonusGmxTracker to stake feeGmxTracker
  await sendTxn(
    bonusGmxTracker.setHandler(feeGmxTracker.address, true),
    "bonusGmxTracker.setHandler(feeGmxTracker)"
  );
  // bonus multiplier basis: 10000, so 5000 is 50% per year.
  await sendTxn(
    bonusGmxDistributor.setBonusMultiplier(5000),
    "bonusGmxDistributor.setBonusMultiplier"
  );
  // allow rewardRouter to stake in feeGmxTracker
  await sendTxn(
    feeGmxTracker.setHandler(rewardRouter.address, true),
    "feeGmxTracker.setHandler(rewardRouter)"
  );
  // allow stakedGmxTracker to stake esGmx
  await sendTxn(
    esGmx.setHandler(stakedGmxTracker.address, true),
    "esGmx.setHandler(stakedGmxTracker)"
  );
  // allow feeGmxTracker to stake bnGmx
  await sendTxn(
    bnGmx.setHandler(feeGmxTracker.address, true),
    "bnGmx.setHandler(feeGmxTracker"
  );
  // allow rewardRouter to burn bnGmx
  await sendTxn(
    bnGmx.setMinter(rewardRouter.address, true),
    "bnGmx.setMinter(rewardRouter"
  );
  for (let i = 0; i < minter.length; i++) {
    await sendTxn(
      bnGmx.setMinter(minter[i], true),
      `bnGmx.setMinter: ${minter[i]}`
    );
  }

  // allow stakedGlpTracker to stake feeGlpTracker
  await sendTxn(
    feeGlpTracker.setHandler(stakedGlpTracker.address, true),
    "feeGlpTracker.setHandler(stakedGlpTracker)"
  );
  // allow feeGlpTracker to stake glp
  await sendTxn(
    glp.setHandler(feeGlpTracker.address, true),
    "glp.setHandler(feeGlpTracker)"
  );

  // allow rewardRouter to stake in feeGlpTracker
  await sendTxn(
    feeGlpTracker.setHandler(rewardRouter.address, true),
    "feeGlpTracker.setHandler(rewardRouter)"
  );
  // allow rewardRouter to stake in stakedGlpTracker
  await sendTxn(
    stakedGlpTracker.setHandler(rewardRouter.address, true),
    "stakedGlpTracker.setHandler(rewardRouter)"
  );

  await sendTxn(
    esGmx.setHandler(rewardRouter.address, true),
    "esGmx.setHandler(rewardRouter)"
  );
  await sendTxn(
    esGmx.setHandler(stakedGmxDistributor.address, true),
    "esGmx.setHandler(stakedGmxDistributor)"
  );
  await sendTxn(
    esGmx.setHandler(stakedGlpDistributor.address, true),
    "esGmx.setHandler(stakedGlpDistributor)"
  );
  await sendTxn(
    esGmx.setHandler(stakedGlpTracker.address, true),
    "esGmx.setHandler(stakedGlpTracker)"
  );
  await sendTxn(
    esGmx.setHandler(gmxVester.address, true),
    "esGmx.setHandler(gmxVester)"
  );
  await sendTxn(
    esGmx.setHandler(glpVester.address, true),
    "esGmx.setHandler(glpVester)"
  );

  await sendTxn(
    esGmx.setMinter(gmxVester.address, true),
    "esGmx.setMinter(gmxVester)"
  );
  await sendTxn(
    esGmx.setMinter(glpVester.address, true),
    "esGmx.setMinter(glpVester)"
  );
  for (let i = 0; i < minter.length; i++) {
    await sendTxn(
      esGmx.setMinter(minter[i], true),
      `esGmx.setMinter: ${minter[i]}`
    );
  }

  await sendTxn(
    gmxVester.setHandler(rewardRouter.address, true),
    "gmxVester.setHandler(rewardRouter)"
  );
  await sendTxn(
    glpVester.setHandler(rewardRouter.address, true),
    "glpVester.setHandler(rewardRouter)"
  );

  await sendTxn(
    feeGmxTracker.setHandler(gmxVester.address, true),
    "feeGmxTracker.setHandler(gmxVester)"
  );
  await sendTxn(
    stakedGlpTracker.setHandler(glpVester.address, true),
    "stakedGlpTracker.setHandler(glpVester)"
  );

  return [
    stakedGmxTracker,
    stakedGmxDistributor,
    bonusGmxTracker,
    bonusGmxDistributor,
    feeGmxTracker,
    feeGmxDistributor,
    feeGlpTracker,
    feeGlpDistributor,
    stakedGlpTracker,
    stakedGlpDistributor,
    gmxVester,
    glpVester,
    rewardRouter,
  ];
}
async function deployStakeManager() {
  const stakeManager = await deployContract("StakeManager", []);
  return stakeManager;
}

async function main() {
  const provider = ethers.provider;
  const signer = await getFrameSigner();

  let bnb, btc, eth, busd, usdt;
  if (network.name == "localhost") {
    bnb = await deployContract("Token", []);
    await bnb.deployed();

    btc = await deployContract("Token", []);
    await btc.deployed();

    eth = await deployContract("Token", []);
    await eth.deployed();

    busd = await deployContract("Token", []);
    await busd.deployed();

    usdt = await deployContract("Token", []);
    await usdt.deployed();
  } else {
    bnb = await contractAt(
      "Token",
      "0x600Bf57Df5269b28b74362FA25456B964a1C4ca8"
    );
    btc = await contractAt(
      "Token",
      "0xcE10Ca7fE13dAAAFFEF7a4E796a48bB4a22A8b5d"
    );
    eth = await contractAt(
      "Token",
      "0xe9C5F21b5ba297e84c555f0eC2161A07CFba9915"
    );
    busd = await contractAt(
      "Token",
      "0x6c3DEf62765044a565a972EAc39e836650B80Ab2"
    );
    usdt = await contractAt(
      "Token",
      "0x0f4174Ead22225c006d595105B8e9Ae5Fd3dfA08"
    );
  }

  const bnbPriceFeed = await deployContract("PriceFeed", []);
  await bnbPriceFeed.deployed();
  console.log("bnbPriceFeed address:", bnbPriceFeed.address);

  const btcPriceFeed = await deployContract("PriceFeed", []);
  await btcPriceFeed.deployed();
  console.log("btcPriceFeed address:", btcPriceFeed.address);

  const ethPriceFeed = await deployContract("PriceFeed", []);
  await ethPriceFeed.deployed();
  console.log("ethPriceFeed address:", ethPriceFeed.address);

  const busdPriceFeed = await deployContract("PriceFeed", []);
  await busdPriceFeed.deployed();
  console.log("busdPriceFeed address:", busdPriceFeed.address);

  const usdtPriceFeed = await deployContract("PriceFeed", []);
  await usdtPriceFeed.deployed();
  console.log("usdtPriceFeed address:", usdtPriceFeed.address);

  const tokens = {
    btc: {
      name: "btc",
      address: btc.address,
      priceFeed: btcPriceFeed.address,
      decimals: 8,
      priceDecimals: 8,
      fastPricePrecision: 1000,
      maxCumulativeDeltaDiff: 10 * 1000 * 1000,
      isStrictStable: false,
      tokenWeight: 19000,
      minProfitBps: 0,
      maxUsdgAmount: 200 * 1000 * 1000,
      bufferAmount: 1500,
      isStable: false,
      isShortable: true,
      maxGlobalShortSize: 20 * 1000 * 1000,
    },
    eth: {
      name: "eth",
      address: eth.address,
      priceFeed: ethPriceFeed.address,
      decimals: 18,
      priceDecimals: 8,
      fastPricePrecision: 1000,
      maxCumulativeDeltaDiff: 10 * 1000 * 1000,
      isStrictStable: false,
      tokenWeight: 30000,
      minProfitBps: 0,
      maxUsdgAmount: 400 * 1000 * 1000,
      bufferAmount: 42000,
      isStable: false,
      isShortable: true,
      maxGlobalShortSize: 35 * 1000 * 1000,
    },
    bnb: {
      name: "bnb",
      address: bnb.address,
      priceFeed: bnbPriceFeed.address,
      decimals: 18,
      priceDecimals: 8,
      fastPricePrecision: 1000,
      maxCumulativeDeltaDiff: 10 * 1000 * 1000,
      isStrictStable: false,
      tokenWeight: 1000,
      minProfitBps: 0,
      maxUsdgAmount: 200 * 1000 * 1000,
      bufferAmount: 42000,
      isStable: false,
      isShortable: true,
      maxGlobalShortSize: 35 * 1000 * 1000,
    },
    busd: {
      name: "busd",
      address: busd.address,
      priceFeed: busdPriceFeed.address,
      decimals: 18,
      priceDecimals: 8,
      fastPricePrecision: 1000,
      maxCumulativeDeltaDiff: 10 * 1000 * 1000,
      isStrictStable: true,
      tokenWeight: 25000,
      minProfitBps: 0,
      maxUsdgAmount: 800 * 1000 * 1000,
      bufferAmount: 95 * 1000 * 1000,
      isStable: true,
      isShortable: false,
    },
    usdt: {
      name: "usdt",
      address: usdt.address,
      priceFeed: usdtPriceFeed.address,
      decimals: 18,
      priceDecimals: 8,
      fastPricePrecision: 1000,
      maxCumulativeDeltaDiff: 10 * 1000 * 1000,
      isStrictStable: true,
      tokenWeight: 25000,
      minProfitBps: 0,
      maxUsdgAmount: 800 * 1000 * 1000,
      bufferAmount: 95 * 1000 * 1000,
      isStable: true,
      isShortable: false,
    },
    wbnb: {
      name: "bnb",
      address: bnb.address,
      priceFeed: bnbPriceFeed.address,
      decimals: 18,
      priceDecimals: 8,
      isStrictStable: false,
      fastPricePrecision: 1000,
      maxCumulativeDeltaDiff: 10 * 1000 * 1000,
    },
  };
  const [gmx, esGmx, bnGmx] = await deployGmx();

  const [
    vault,
    usdg,
    router,
    vaultPriceFeed,
    glp,
    glpManager,
    vaultUtils,
    shortsTracker,
  ] = await deployVault(tokens);

  const tokenManager = await deployTokenManager();
  console.log("TokenManager address:", tokenManager.address);

  // const glpManager = await deployGlpManager(vault, usdg, glp);
  // console.log("GlpManager address:", glpManager.address);

  const orderBook = await deployOrderBook(tokens, router, vault, usdg);
  console.log("OrderBook address:", orderBook.address);

  // const orderExecutor = await deployOrderExecutor(vault, orderBook);
  // console.log("OrderExecutor address:", orderExecutor.address);

  const [referralStorage, positionRouter] = await deployPositionRouter(
    vault,
    router,
    tokens.wbnb
  );
  console.log("PositionRouter address:", positionRouter.address);

  const positionManager = await deployPositionManager(
    vault,
    router,
    tokens.wbnb,
    orderBook
  );
  console.log("PositionManager address:", positionManager.address);

  const [
    stakedGmxTracker,
    stakedGmxDistributor,
    bonusGmxTracker,
    bonusGmxDistributor,
    feeGmxTracker,
    feeGmxDistributor,
    feeGlpTracker,
    feeGlpDistributor,
    stakedGlpTracker,
    stakedGlpDistributor,
    gmxVester,
    glpVester,
    rewardRouter,
  ] = await deployRewardRouter(tokens, glpManager, glp, gmx, esGmx, bnGmx);
  const rewardManager = await deployContract(
    "RewardManager",
    [],
    "RewardManager"
  );

  const timelock = await deployTimeLock(
    tokenManager,
    glpManager,
    rewardRouter,
    positionRouter,
    positionManager,
    rewardManager
  );

  // const vaultUnils = await deployVaultUtiles(vault, timelock);
  // console.log("VaultUnils address:", vaultUnils.address);

  await sendTxn(esGmx.setGov(timelock.address), "set gov");
  await sendTxn(bnGmx.setGov(timelock.address), "set gov");
  await sendTxn(gmxVester.setGov(timelock.address), "set gov");
  await sendTxn(glpVester.setGov(timelock.address), "set gov");
  await sendTxn(shortsTracker.setGov(timelock.address), "set gov");
  await sendTxn(glpManager.setGov(timelock.address), "set gov");
  await sendTxn(stakedGmxTracker.setGov(timelock.address), "set gov");
  await sendTxn(bonusGmxTracker.setGov(timelock.address), "set gov");
  await sendTxn(feeGmxTracker.setGov(timelock.address), "set gov");
  await sendTxn(feeGlpTracker.setGov(timelock.address), "set gov");
  await sendTxn(stakedGlpTracker.setGov(timelock.address), "set gov");
  await sendTxn(stakedGmxDistributor.setGov(timelock.address), "set gov");
  await sendTxn(stakedGlpDistributor.setGov(timelock.address), "set gov");

  await sendTxn(
    rewardManager.initialize(
      timelock.address,
      rewardRouter.address,
      glpManager.address,
      stakedGmxTracker.address,
      bonusGmxTracker.address,
      feeGmxTracker.address,
      feeGlpTracker.address,
      stakedGlpTracker.address,
      stakedGmxDistributor.address,
      stakedGlpDistributor.address,
      esGmx.address,
      bnGmx.address,
      gmxVester.address,
      glpVester.address
    ),
    "rewardManager.initialize"
  );

  await sendTxn(
    rewardManager.updateEsGmxHandlers(),
    "rewardManager.updateEsGmxHandlers"
  );
  await sendTxn(
    rewardManager.enableRewardRouter(),
    "rewardManager.enableRewardRouter"
  );

  // const priceFeedTimelock = await deployPriceFeedTimelock(
  //   router,
  //   vaultPriceFeed,
  //   tokenManager
  // );

  const [fastPriceEvents, secondaryPriceFeed] = await deployPriceFeed(
    vault,
    tokens,
    timelock,
    tokenManager,
    positionRouter,
    vaultPriceFeed,
    positionManager
  );

  await setVaultTokenConfig(
    vault,
    vaultPriceFeed,
    tokens,
    ethPriceFeed,
    btcPriceFeed,
    bnbPriceFeed,
    busdPriceFeed,
    usdtPriceFeed
  );

  await sendTxn(
    vault.setGov(timelock.address),
    "vault.setGov(timelock.address)"
  );
  await sendTxn(
    vaultPriceFeed.setGov(timelock.address),
    "vaultPriceFeed.setGov"
  );

  const balanceUpdater = await deployBalanceUpdater();
  const batchSender = await deployBatchSender();
  const esGmxBatchSender = await deployEsGmxBatchSender(esGmx);
  const gmxTimelock = await deployGmxTimelock(tokenManager, rewardManager);
  const orderBookReader = await deployOrderBookReader();
  const reader = await deployReader();
  const rewardReader = await deployRewardReader();
  const vaultReader = await deployVaultReader();
  const [stakedGlp, glpBalance] = await deployStakedGlp(
    glp,
    glpManager,
    stakedGlpTracker,
    feeGlpTracker
  );
  const stakeManager = await deployStakeManager();
  // const bridge = await deployBridge(gmx, wGmx);
  // const snapshotToken = await deploySnapshotToken();

  // const addresses = await deployFaucetToken();
  await router.addPlugin(orderBook.address);
  await router.approvePlugin(orderBook.address);
  await router.approvePlugin(positionRouter.address);
  await router.approvePlugin(positionManager.address);
  await positionRouter.setPositionKeeper(signer.address, true);

  const minExecutionFee = "0.0016";
  await positionRouter.setMinExecutionFee(
    ethers.utils.parseEther(minExecutionFee)
  );
  await orderBook.setMinExecutionFee(ethers.utils.parseEther(minExecutionFee));
  await orderBook.setMinPurchaseTokenAmountUsd(100);

  await sendTxn(
    referralStorage.setTier(0, 1000, 5000),
    "referralStorage.setTier 0"
  );
  await sendTxn(
    referralStorage.setTier(1, 2000, 5000),
    "referralStorage.setTier 1"
  );
  await sendTxn(
    referralStorage.setTier(2, 2500, 4000),
    "referralStorage.setTier 2"
  );

  console.log('NATIVE_TOKEN: "%s",', tokens.wbnb.address);
  console.log('btc: "%s",', btc.address);
  console.log('btcPriceFeed: "%s",', btcPriceFeed.address);
  console.log('eth: "%s",', eth.address);
  console.log('ethPriceFeed: "%s",', ethPriceFeed.address);
  console.log('bnb: "%s",', bnb.address);
  console.log('bnbPriceFeed: "%s",', bnbPriceFeed.address);
  console.log('busd: "%s",', busd.address);
  console.log('busdPriceFeed: "%s",', busdPriceFeed.address);
  console.log('usdt: "%s",', usdt.address);
  console.log('usdtPriceFeed: "%s",', usdtPriceFeed.address);
  console.log('VaultReader: "%s",', vaultReader.address);
  console.log('Reader: "%s",', reader.address);
  console.log('OrderBook: "%s",', orderBook.address);
  console.log('OrderBookReader: "%s",', orderBookReader.address);
  console.log('Router: "%s",', router.address);
  console.log('USDG: "%s",', usdg.address);
  console.log('Vault: "%s",', vault.address);
  console.log('PositionRouter: "%s",', positionRouter.address);
  console.log('PositionManager: "%s",', positionManager.address);
  console.log('GlpManager: "%s",', glpManager.address);
  console.log('GMX: "%s",', gmx.address);
  console.log('ES_GMX: "%s",', esGmx.address);
  console.log('BN_GMX: "%s",', bnGmx.address);
  console.log('GLP: "%s",', glp.address);
  console.log('RewardRouter: "%s",', rewardRouter.address);
  console.log('RewardReader: "%s",', rewardReader.address);
  console.log('StakedGmxTracker: "%s",', stakedGmxTracker.address);
  console.log('BonusGmxTracker: "%s",', bonusGmxTracker.address);
  console.log('FeeGmxTracker: "%s",', feeGmxTracker.address);
  console.log('StakedGlpTracker: "%s",', stakedGlpTracker.address);
  console.log('FeeGlpTracker: "%s",', feeGlpTracker.address);
  console.log('StakedGmxDistributor: "%s",', stakedGmxDistributor.address);
  console.log('StakedGlpDistributor: "%s",', stakedGlpDistributor.address);
  console.log('FeeGlpDistributor: "%s",', feeGlpDistributor.address);
  console.log('FeeGmxDistributor: "%s",', feeGmxDistributor.address);
  console.log('GmxVester: "%s",', gmxVester.address);
  console.log('GlpVester: "%s",', glpVester.address);
  console.log('ReferralStorage: "%s",', referralStorage.address);
  console.log('VaultPriceFeed: "%s",', vaultPriceFeed.address);
  console.log('GmxTimelock: "%s",', gmxTimelock.address);
  console.log('Timelock: "%s",', timelock.address);
  console.log('FeeGmxRewardDistributor: "%s",', feeGmxDistributor.address);
  console.log('EsgmxGmxRewardDistributor: "%s",', stakedGmxDistributor.address);
  console.log('FeeGlpRewardDistributor: "%s",', feeGlpDistributor.address);
  console.log('EsgmxGlpRewardDistributor: "%s",', stakedGlpDistributor.address);
  console.log('SecondaryPriceFeed: "%s",', secondaryPriceFeed.address);
  console.log('BonusGmxDistributor: "%s",', bonusGmxDistributor.address);
  console.log('BatchSender: "%s",', batchSender.address);
  console.log('ShortsTracker: "%s",', shortsTracker.address);
  console.log('RewardManager: "%s",', rewardManager.address);
  console.log('FastPriceEvents: "%s"', fastPriceEvents.address);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
